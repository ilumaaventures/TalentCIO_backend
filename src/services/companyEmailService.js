const nodemailer = require('nodemailer');
const axios = require('axios');
const Company = require('../models/Company');
const { decrypt } = require('../utils/encryption');
const { sendEmail, wrapEmailHtmlWithBranding } = require('./emailService');

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
        connectionTimeout: 10000,
        greetingTimeout: 10000,
        socketTimeout: 10000
    });
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
    attachments.map((attachment) => ({
        name: attachment.filename || attachment.name,
        content: attachment.content ? Buffer.from(attachment.content).toString('base64') : undefined,
        url: typeof attachment.path === 'string' && attachment.path.startsWith('http')
            ? attachment.path
            : undefined
    })).filter((attachment) => attachment.name && (attachment.content || attachment.url))
);

const sendViaBrevoApi = async ({
    to,
    subject,
    htmlContent,
    textContent,
    fromName,
    fromAddress,
    brevoApiKey,
    attachments = []
}) => {
    const payload = {
        sender: { name: fromName, email: fromAddress },
        to: [{ email: to }],
        subject,
        htmlContent,
        textContent
    };

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
    subject,
    html,
    text,
    fromName,
    fromAddress,
    smtpConfig,
    attachments = []
}) => {
    const transporter = getCompanyTransporter({ smtp: smtpConfig });
    const info = await transporter.sendMail({
        from: formatFromHeader(fromName, fromAddress),
        to,
        subject,
        html,
        text,
        attachments
    });

    return info.messageId || null;
};

const sendEmailForCompany = async ({
    companyId,
    emailAccountId,
    to,
    subject,
    html,
    text,
    attachments = [],
    brandEmail = true,
    logoUrl,
    logoLink,
    logoAlt
}) => {
    const settings = await getCompanyEmailSettings(companyId);
    const selection = pickEmailAccount(settings, emailAccountId);
    const brandedHtml = brandEmail
        ? wrapEmailHtmlWithBranding(html, { logoUrl, logoLink, logoAlt })
        : html;

    if (selection.mode === 'missing') {
        console.error(`[EMAIL] Selected account ${selection.accountId} not found for company ${companyId}`);
        return false;
    }

    if (selection.mode === 'invalid') {
        console.error(`[EMAIL] Selected account ${selection.accountId} is not fully configured for company ${companyId}`);
        return false;
    }

    if (selection.mode === 'account' && selection.account?.provider === 'brevo') {
        try {
            const messageId = await sendViaBrevoApi({
                to,
                subject,
                htmlContent: brandedHtml,
                textContent: text,
                fromName: selection.account.fromName,
                fromAddress: selection.account.fromAddress,
                brevoApiKey: selection.account.brevoApiKey,
                attachments
            });
            console.log(`[EMAIL:brevo-company] Success: ${messageId || 'ok'} -> ${to}`);
            return true;
        } catch (error) {
            console.error(
                `[EMAIL:brevo-company] Failed for company ${companyId}:`,
                error.response?.data || error.message
            );
            return false;
        }
    }

    if (selection.mode === 'account' && selection.account?.provider === 'smtp') {
        try {
            const messageId = await sendViaSmtp({
                to,
                subject,
                html: brandedHtml,
                text,
                fromName: selection.account.fromName,
                fromAddress: selection.account.fromAddress,
                smtpConfig: selection.account.smtp,
                attachments
            });
            console.log(`[EMAIL:smtp-company] Success: ${messageId || 'ok'} -> ${to}`);
            return true;
        } catch (error) {
            console.error(`[EMAIL:smtp-company] Failed for company ${companyId}:`, error.message);
            return false;
        }
    }

    return sendEmail({
        to,
        subject,
        html: brandedHtml,
        text,
        attachments,
        brandEmail: false
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
    sendEmailForCompany
};
