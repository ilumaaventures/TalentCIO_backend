const nodemailer = require('nodemailer');
const axios = require('axios');
const Company = require('../modules/company/company.model');
const { decrypt } = require('../common/utils/encryption');
const {
    getCompanyBranding,
    sendEmail,
    wrapEmailHtmlWithBranding
} = require('./emailService');

const EMAIL_CONFIG_CACHE_TTL_MS = 5 * 60 * 1000;
const PLATFORM_EMAIL_ACCOUNT_ID = 'platform';
const LEGACY_EMAIL_ACCOUNT_ID = 'legacy-default';
const emailConfigCache = new Map();

const getCacheKey = (companyId) => String(companyId || '');

const clearCompanyEmailConfigCache = (companyId) => {
    if (!companyId) return;
    emailConfigCache.delete(getCacheKey(companyId));
};

const getCompanyTransporter = (emailCfg = {}) => {
    const smtp = emailCfg.smtp || {};
    return nodemailer.createTransport({
        host: smtp.host,
        port: smtp.port || 587,
        secure: smtp.secure || smtp.port === 465,
        auth: {
            user: smtp.user,
            pass: decrypt(smtp.pass)
        },
        pool: true,          // reuse TCP connections across emails
        maxConnections: 1,   // 1 connection avoids parallel connection-burst rate limits on Hostinger/Titan
        maxMessages: 100,
        connectionTimeout: 10000,
        greetingTimeout: 10000,
        socketTimeout: 30000
    });
};

const isRateLimitError = (error) => {
    const msg = String(error?.response?.data?.message || error?.message || '').toLowerCase();
    const status = error?.status || error?.response?.status || error?.responseCode;
    return (
        status === 429 ||
        status === 451 ||
        msg.includes('ratelimit') ||
        msg.includes('rate limit') ||
        msg.includes('too many requests') ||
        msg.includes('exceeded') ||
        msg.includes('451 4.7.1')
    );
};


const buildLegacyEmailAccount = (emailSettings = {}, companyName = '') => {
    if (emailSettings?.provider === 'brevo' && emailSettings?.brevoApiKey && emailSettings?.fromAddress) {
        return {
            _id: LEGACY_EMAIL_ACCOUNT_ID,
            name: emailSettings.fromName || emailSettings.fromAddress || `${companyName || 'Company'} Brevo`,
            provider: 'brevo',
            fromName: emailSettings.fromName || companyName || 'TalentCIO',
            fromAddress: emailSettings.fromAddress,
            brevoApiKey: emailSettings.brevoApiKey,
            smtp: {
                host: '',
                port: 587,
                secure: false,
                user: '',
                pass: ''
            },
            verified: Boolean(emailSettings.verified),
            verifiedAt: emailSettings.verifiedAt || null,
            testSentAt: emailSettings.testSentAt || null
        };
    }

    if (
        emailSettings?.provider === 'smtp' &&
        emailSettings?.smtp?.host &&
        emailSettings?.smtp?.user &&
        emailSettings?.smtp?.pass &&
        emailSettings?.fromAddress
    ) {
        return {
            _id: LEGACY_EMAIL_ACCOUNT_ID,
            name: emailSettings.fromName || emailSettings.fromAddress || `${companyName || 'Company'} SMTP`,
            provider: 'smtp',
            fromName: emailSettings.fromName || companyName || 'TalentCIO',
            fromAddress: emailSettings.fromAddress,
            brevoApiKey: '',
            smtp: {
                host: emailSettings.smtp.host,
                port: emailSettings.smtp.port || 587,
                secure: Boolean(emailSettings.smtp.secure || emailSettings.smtp.port === 465),
                user: emailSettings.smtp.user,
                pass: emailSettings.smtp.pass
            },
            verified: Boolean(emailSettings.verified),
            verifiedAt: emailSettings.verifiedAt || null,
            testSentAt: emailSettings.testSentAt || null
        };
    }

    return null;
};

const normalizeStoredEmailAccounts = (emailSettings = {}, companyName = '') => {
    const accounts = Array.isArray(emailSettings?.accounts)
        ? emailSettings.accounts
            .filter(Boolean)
            .map((account) => ({
                _id: String(account._id || ''),
                name: account.name || '',
                provider: account.provider || 'brevo',
                fromName: account.fromName || '',
                fromAddress: account.fromAddress || '',
                brevoApiKey: account.brevoApiKey || '',
                smtp: {
                    host: account.smtp?.host || '',
                    port: account.smtp?.port || 587,
                    secure: Boolean(account.smtp?.secure),
                    user: account.smtp?.user || '',
                    pass: account.smtp?.pass || ''
                },
                verified: Boolean(account.verified),
                verifiedAt: account.verifiedAt || null,
                testSentAt: account.testSentAt || null
            }))
        : [];

    if (accounts.length > 0) {
        return accounts;
    }

    const legacyAccount = buildLegacyEmailAccount(emailSettings, companyName);
    return legacyAccount ? [legacyAccount] : [];
};

const resolveStoredAccountConfig = (account = {}, companyName = '') => {
    if (!account?.provider) return null;

    if (account.provider === 'brevo') {
        if (!account.brevoApiKey || !account.fromAddress) return null;
        return {
            _id: String(account._id || ''),
            name: account.name || account.fromAddress || 'Brevo Sender',
            provider: 'brevo',
            fromName: account.fromName || companyName || 'TalentCIO',
            fromAddress: account.fromAddress,
            brevoApiKey: decrypt(account.brevoApiKey),
            verified: Boolean(account.verified),
            verifiedAt: account.verifiedAt || null,
            testSentAt: account.testSentAt || null
        };
    }

    if (account.provider === 'smtp') {
        if (!account.smtp?.host || !account.smtp?.user || !account.smtp?.pass || !account.fromAddress) return null;
        return {
            _id: String(account._id || ''),
            name: account.name || account.fromAddress || 'SMTP Sender',
            provider: 'smtp',
            fromName: account.fromName || companyName || 'TalentCIO',
            fromAddress: account.fromAddress,
            smtp: {
                host: account.smtp.host,
                port: account.smtp.port || 587,
                secure: Boolean(account.smtp.secure || account.smtp.port === 465),
                user: account.smtp.user,
                pass: account.smtp.pass
            },
            verified: Boolean(account.verified),
            verifiedAt: account.verifiedAt || null,
            testSentAt: account.testSentAt || null
        };
    }

    return null;
};

const getCompanyEmailSettings = async (companyId) => {
    if (!companyId) return null;

    const cacheKey = getCacheKey(companyId);
    const cachedEntry = emailConfigCache.get(cacheKey);

    if (cachedEntry && cachedEntry.expiresAt > Date.now()) {
        return cachedEntry.value;
    }

    const company = await Company.findById(companyId)
        .select('name settings.email')
        .lean();

    if (!company) {
        emailConfigCache.set(cacheKey, {
            value: null,
            expiresAt: Date.now() + EMAIL_CONFIG_CACHE_TTL_MS
        });
        return null;
    }

    const emailSettings = company?.settings?.email || {};
    const normalized = {
        companyName: company.name || 'TalentCIO',
        defaultAccountId: String(emailSettings.defaultAccountId || PLATFORM_EMAIL_ACCOUNT_ID),
        accounts: normalizeStoredEmailAccounts(emailSettings, company.name || 'TalentCIO')
    };

    emailConfigCache.set(cacheKey, {
        value: normalized,
        expiresAt: Date.now() + EMAIL_CONFIG_CACHE_TTL_MS
    });

    return normalized;
};

const pickEmailAccount = (settings, emailAccountId) => {
    if (!settings) {
        return { mode: 'platform' };
    }

    const requestedAccountId = emailAccountId ? String(emailAccountId) : '';
    const accountIdToUse = requestedAccountId || String(settings.defaultAccountId || PLATFORM_EMAIL_ACCOUNT_ID);

    if (accountIdToUse === PLATFORM_EMAIL_ACCOUNT_ID) {
        return { mode: 'platform' };
    }

    const selectedAccount = (settings.accounts || []).find((account) => String(account._id) === accountIdToUse);
    if (!selectedAccount) {
        return { mode: requestedAccountId ? 'missing' : 'platform', accountId: accountIdToUse };
    }

    const resolvedAccount = resolveStoredAccountConfig(selectedAccount, settings.companyName);
    if (!resolvedAccount) {
        return { mode: 'invalid', accountId: accountIdToUse, account: selectedAccount };
    }

    return { mode: 'account', account: resolvedAccount };
};

const resolveEmailConfig = async (companyId, emailAccountId = null) => {
    const settings = await getCompanyEmailSettings(companyId);
    const selection = pickEmailAccount(settings, emailAccountId);
    return selection.mode === 'account' ? selection.account : null;
};

const mapBrevoAttachments = (attachments = []) => (
    attachments.map((attachment) => {
        let contentBase64 = undefined;
        if (attachment.content) {
            contentBase64 = Buffer.isBuffer(attachment.content)
                ? attachment.content.toString('base64')
                : String(attachment.content);
        }
        const url = (typeof attachment.path === 'string' && attachment.path.startsWith('http'))
            ? attachment.path
            : (typeof attachment.url === 'string' && attachment.url.startsWith('http') ? attachment.url : undefined);

        return {
            name: attachment.filename || attachment.name,
            content: contentBase64,
            url
        };
    }).filter((attachment) => attachment.name && (attachment.content || attachment.url))
);

const parseEmailListForBrevo = (emails) => {
    if (!emails) return undefined;
    if (Array.isArray(emails)) {
        return emails
            .flatMap(e => (typeof e === 'string' ? e.split(/[,;\s]+/) : [(e && (e.email || e.value)) || '']))
            .map(e => (typeof e === 'string' ? e.trim() : ''))
            .filter(e => e && e.includes('@'))
            .map(email => ({ email }));
    }
    if (typeof emails === 'string') {
        return emails
            .split(/[,;\s]+/)
            .map(e => e.trim())
            .filter(e => e && e.includes('@'))
            .map(email => ({ email }));
    }
    return undefined;
};

const sendViaBrevoApi = async ({
    to,
    cc,
    bcc,
    subject,
    htmlContent,
    textContent,
    fromName,
    fromAddress,
    brevoApiKey,
    attachments = [],
    replyTo
}) => {
    const payload = {
        sender: { name: fromName, email: fromAddress },
        to: Array.isArray(to) ? to.map(e => typeof e === 'object' ? e : { email: e }) : [{ email: to }],
        subject,
        htmlContent,
        textContent
    };

    const parsedCc = parseEmailListForBrevo(cc);
    if (parsedCc && parsedCc.length > 0) payload.cc = parsedCc;

    const parsedBcc = parseEmailListForBrevo(bcc);
    if (parsedBcc && parsedBcc.length > 0) payload.bcc = parsedBcc;

    if (replyTo) {
        payload.replyTo = { email: replyTo };
    }

    const formattedAttachments = mapBrevoAttachments(attachments);
    if (formattedAttachments.length > 0) {
        payload.attachment = formattedAttachments;
    }

    const response = await axios.post('https://api.brevo.com/v3/smtp/email', payload, {
        headers: {
            'api-key': brevoApiKey,
            'Content-Type': 'application/json'
        },
        timeout: 15000
    });

    return response.data?.messageId || null;
};

const formatFromHeader = (fromName, fromAddress) => {
    const safeName = String(fromName || '').replace(/"/g, '\\"').trim();
    return safeName ? `"${safeName}" <${fromAddress}>` : fromAddress;
};

const sendViaSmtp = async ({
    to,
    cc,
    bcc,
    subject,
    html,
    text,
    fromName,
    fromAddress,
    smtpConfig,
    attachments = [],
    replyTo
}) => {
    const transporter = getCompanyTransporter({ smtp: smtpConfig });
    const info = await transporter.sendMail({
        from: formatFromHeader(fromName, fromAddress),
        to,
        ...(cc ? { cc } : {}),
        ...(bcc ? { bcc } : {}),
        subject,
        html,
        text,
        attachments,
        ...(replyTo ? { replyTo } : {})
    });

    return info.messageId || null;
};

const sendEmailForCompany = async ({
    companyId,
    emailAccountId,
    to,
    cc,
    bcc,
    subject,
    html,
    text,
    attachments = [],
    brandEmail = true,
    logoUrl,
    logoLink,
    logoAlt,
    replyTo,
    throwOnError = false
}) => {
    const settings = await getCompanyEmailSettings(companyId);
    const selection = pickEmailAccount(settings, emailAccountId);
    const companyBranding = companyId && brandEmail
        ? await getCompanyBranding(companyId)
        : {};
    const resolvedBranding = { ...companyBranding };

    if (logoUrl !== undefined) resolvedBranding.logoUrl = logoUrl;
    if (logoLink !== undefined) resolvedBranding.logoLink = logoLink;
    if (logoAlt !== undefined) resolvedBranding.logoAlt = logoAlt;
    if (replyTo !== undefined) resolvedBranding.replyTo = replyTo;

    const brandedHtml = brandEmail
        ? wrapEmailHtmlWithBranding(html, resolvedBranding)
        : html;
    const resolvedReplyTo = resolvedBranding.replyTo || undefined;

    if (selection.mode === 'missing') {
        console.error(`[EMAIL] Selected account ${selection.accountId} not found for company ${companyId}`);
        if (throwOnError) throw new Error(`Selected account ${selection.accountId} not found`);
        return false;
    }

    if (selection.mode === 'invalid') {
        console.error(`[EMAIL] Selected account ${selection.accountId} is not fully configured for company ${companyId}`);
        if (throwOnError) throw new Error(`Selected account ${selection.accountId} is not configured`);
        return false;
    }

    if (selection.mode === 'account' && selection.account?.provider === 'brevo') {
        try {
            const messageId = await sendViaBrevoApi({
                to,
                cc,
                bcc,
                subject,
                htmlContent: brandedHtml,
                textContent: text,
                fromName: selection.account.fromName || companyBranding.displayName || settings?.companyName || 'TalentCIO',
                fromAddress: selection.account.fromAddress,
                brevoApiKey: selection.account.brevoApiKey,
                attachments,
                replyTo: resolvedReplyTo
            });
            console.log(`[EMAIL:brevo-company] Success: ${messageId || 'ok'} -> ${to}`);
            return true;
        } catch (error) {
            console.error(
                `[EMAIL:brevo-company] Failed for company ${companyId}:`,
                error.response?.data || error.message
            );
            if (throwOnError) {
                error.isRateLimit = isRateLimitError(error);
                throw error;
            }
            return false;
        }
    }

    if (selection.mode === 'account' && selection.account?.provider === 'smtp') {
        try {
            const messageId = await sendViaSmtp({
                to,
                cc,
                bcc,
                subject,
                html: brandedHtml,
                text,
                fromName: selection.account.fromName || companyBranding.displayName || settings?.companyName || 'TalentCIO',
                fromAddress: selection.account.fromAddress,
                smtpConfig: selection.account.smtp,
                attachments,
                replyTo: resolvedReplyTo
            });
            console.log(`[EMAIL:smtp-company] Success: ${messageId || 'ok'} -> ${to}`);
            return true;
        } catch (error) {
            console.error(`[EMAIL:smtp-company] Failed for company ${companyId}:`, error.message);
            if (throwOnError) {
                error.isRateLimit = isRateLimitError(error);
                throw error;
            }
            return false;
        }
    }

    return sendEmail({
        companyId,
        to,
        cc,
        bcc,
        subject,
        html: brandedHtml,
        text,
        attachments,
        brandEmail: false,
        replyTo: resolvedReplyTo
    });
};

module.exports = {
    clearCompanyEmailConfigCache,
    PLATFORM_EMAIL_ACCOUNT_ID,
    LEGACY_EMAIL_ACCOUNT_ID,
    getCompanyTransporter,
    getCompanyEmailSettings,
    normalizeStoredEmailAccounts,
    resolveStoredAccountConfig,
    resolveEmailConfig,
    sendViaBrevoApi,
    sendViaSmtp,
    sendEmailForCompany,
    isRateLimitError
};

