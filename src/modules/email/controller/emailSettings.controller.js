const mongoose = require('mongoose');
const Company = require('../../company/company.model');
const AuditLog = require('../../system/auditLog.model');
const {
    encrypt,
    decrypt,
    encryptIfNeeded,
    isEncryptionConfigured
} = require('../../../common/utils/encryption');
const {
    clearCompanyEmailConfigCache,
    LEGACY_EMAIL_ACCOUNT_ID,
    PLATFORM_EMAIL_ACCOUNT_ID,
    normalizeStoredEmailAccounts,
    resolveStoredAccountConfig,
    sendEmailForCompany
} = require('../../../services/companyEmailService');

const BREVO_MASK = '••••••••';
const SMTP_MASK = '••••••••';

const getMaskedBrevoKey = (value) => {
    if (!value) return '';
    const decryptedValue = decrypt(value);
    const suffix = String(decryptedValue || '').slice(-4);
    return suffix ? `${BREVO_MASK}${suffix}` : BREVO_MASK;
};

const buildAccountResponse = (account = {}, companyName = '') => {
    const ready = Boolean(resolveStoredAccountConfig(account, companyName));

    return {
        _id: String(account._id || ''),
        name: account.name || '',
        provider: account.provider || 'brevo',
        fromName: account.fromName || '',
        fromAddress: account.fromAddress || '',
        verified: Boolean(account.verified),
        verifiedAt: account.verifiedAt || null,
        testSentAt: account.testSentAt || null,
        ready,
        brevoApiKey: account.provider === 'brevo' ? getMaskedBrevoKey(account.brevoApiKey) : '',
        smtp: {
            host: account.smtp?.host || '',
            port: account.smtp?.port || 587,
            secure: Boolean(account.smtp?.secure),
            user: account.smtp?.user || '',
            pass: account.provider === 'smtp' && account.smtp?.pass ? SMTP_MASK : ''
        }
    };
};

const buildEmailSettingsResponse = (company) => {
    const emailSettings = company?.settings?.email || {};
    const accounts = normalizeStoredEmailAccounts(emailSettings, company?.name || 'TalentCIO');

    return {
        defaultAccountId: String(emailSettings.defaultAccountId || PLATFORM_EMAIL_ACCOUNT_ID),
        platformOption: {
            _id: PLATFORM_EMAIL_ACCOUNT_ID,
            name: 'TalentCIO Platform',
            provider: 'platform',
            fromName: 'TalentCIO',
            fromAddress: process.env.EMAIL_FROM || 'no-reply@talentcio.in',
            verified: true,
            verifiedAt: null,
            testSentAt: null,
            ready: true
        },
        accounts: accounts.map((account) => buildAccountResponse(account, company?.name || 'TalentCIO'))
    };
};

const isMaskedSecret = (value = '') => String(value || '').startsWith('•');

const compareMeaningfulAccountFields = (left = {}, right = {}) => (
    String(left.name || '').trim() === String(right.name || '').trim() &&
    String(left.provider || '') === String(right.provider || '') &&
    String(left.fromName || '').trim() === String(right.fromName || '').trim() &&
    String(left.fromAddress || '').trim() === String(right.fromAddress || '').trim() &&
    String(left.brevoApiKey || '') === String(right.brevoApiKey || '') &&
    String(left.smtp?.host || '').trim() === String(right.smtp?.host || '').trim() &&
    Number(left.smtp?.port || 587) === Number(right.smtp?.port || 587) &&
    Boolean(left.smtp?.secure) === Boolean(right.smtp?.secure) &&
    String(left.smtp?.user || '').trim() === String(right.smtp?.user || '').trim() &&
    String(left.smtp?.pass || '') === String(right.smtp?.pass || '')
);

const resolveValidDefaultAccountId = (defaultAccountId, emailSettings = {}, companyName = '') => {
    const requestedDefaultAccountId = String(defaultAccountId || PLATFORM_EMAIL_ACCOUNT_ID).trim() || PLATFORM_EMAIL_ACCOUNT_ID;

    if (requestedDefaultAccountId === PLATFORM_EMAIL_ACCOUNT_ID) {
        return PLATFORM_EMAIL_ACCOUNT_ID;
    }

    const accounts = normalizeStoredEmailAccounts(emailSettings, companyName);
    const selectedAccount = accounts.find((account) => String(account?._id || '') === requestedDefaultAccountId);

    if (!selectedAccount || !resolveStoredAccountConfig(selectedAccount, companyName || 'TalentCIO')) {
        return '';
    }

    return requestedDefaultAccountId;
};

exports.getEmailSettings = async (req, res) => {
    try {
        const company = await Company.findById(req.companyId)
            .select('name settings.email')
            .lean();

        if (!company) {
            return res.status(404).json({ message: 'Company not found.' });
        }

        return res.json(buildEmailSettingsResponse(company));
    } catch (error) {
        console.error('getEmailSettings error:', error);
        return res.status(500).json({
            message: 'Failed to fetch email settings.',
            error: error.message
        });
    }
};

exports.getAvailableEmailSenders = async (req, res) => {
    try {
        const company = await Company.findById(req.companyId)
            .select('name settings.email')
            .lean();

        if (!company) {
            return res.status(404).json({ message: 'Company not found.' });
        }

        const payload = buildEmailSettingsResponse(company);
        return res.json({
            defaultAccountId: payload.defaultAccountId,
            platformOption: payload.platformOption,
            accounts: (payload.accounts || []).filter((account) => account.ready)
        });
    } catch (error) {
        console.error('getAvailableEmailSenders error:', error);
        return res.status(500).json({
            message: 'Failed to fetch available email senders.',
            error: error.message
        });
    }
};

exports.updateDefaultEmailSender = async (req, res) => {
    try {
        const company = await Company.findById(req.companyId)
            .select('name settings.email')
            .lean();

        if (!company) {
            return res.status(404).json({ message: 'Company not found.' });
        }

        const nextDefaultAccountId = resolveValidDefaultAccountId(
            req.body?.defaultAccountId,
            company?.settings?.email || {},
            company?.name || 'TalentCIO'
        );

        if (!nextDefaultAccountId) {
            return res.status(400).json({
                message: 'Selected default sender is unavailable or not fully configured.'
            });
        }

        await Company.findByIdAndUpdate(req.companyId, {
            $set: {
                'settings.email.defaultAccountId': nextDefaultAccountId
            }
        });

        clearCompanyEmailConfigCache(req.companyId);

        await AuditLog.create({
            companyId: req.companyId,
            performedBy: req.user?._id,
            action: 'EMAIL_DEFAULT_SENDER_UPDATED',
            module: 'SETTINGS',
            details: {
                defaultAccountId: nextDefaultAccountId
            }
        });

        return res.json({
            message: 'Default sender updated successfully.',
            defaultAccountId: nextDefaultAccountId
        });
    } catch (error) {
        console.error('updateDefaultEmailSender error:', error);
        return res.status(500).json({
            message: 'Failed to update default sender.',
            error: error.message
        });
    }
};

exports.updateEmailSettings = async (req, res) => {
    try {
        const defaultAccountId = String(req.body?.defaultAccountId || PLATFORM_EMAIL_ACCOUNT_ID);
        const accounts = Array.isArray(req.body?.accounts) ? req.body.accounts : [];

        if (accounts.length > 20) {
            return res.status(400).json({ message: 'You can save up to 20 sender accounts.' });
        }

        if (accounts.length > 0 && !isEncryptionConfigured()) {
            return res.status(500).json({
                message: 'EMAIL_ENCRYPTION_KEY is not configured. Email credentials cannot be saved securely.'
            });
        }

        const company = await Company.findById(req.companyId).select('settings.email');
        if (!company) {
            return res.status(404).json({ message: 'Company not found.' });
        }

        const existingEmailSettings = company.settings?.email || {};
        const existingAccounts = normalizeStoredEmailAccounts(existingEmailSettings, '');
        const existingAccountMap = new Map(existingAccounts.map((account) => [String(account._id), account]));
        const savedAccounts = [];
        const incomingIdToPersistedId = new Map();

        for (const incomingAccount of accounts) {
            const incomingAccountId = String(incomingAccount._id || '');
            if (!['brevo', 'smtp'].includes(incomingAccount?.provider)) {
                return res.status(400).json({ message: 'Each sender account must use Brevo or SMTP.' });
            }

            const existingAccount = existingAccountMap.get(incomingAccountId);
            const provider = String(incomingAccount.provider || '');
            const name = String(incomingAccount.name || '').trim();
            const fromName = String(incomingAccount.fromName || '').trim();
            const fromAddress = String(incomingAccount.fromAddress || '').trim();
            const smtp = incomingAccount.smtp || {};
            const persistedObjectId = existingAccount && String(existingAccount._id) !== LEGACY_EMAIL_ACCOUNT_ID
                ? new mongoose.Types.ObjectId(String(existingAccount._id))
                : new mongoose.Types.ObjectId();

            if (!name) {
                return res.status(400).json({ message: 'Each sender account needs a display name.' });
            }

            if (!fromAddress) {
                return res.status(400).json({ message: 'Each sender account needs a from address.' });
            }

            const baseAccount = {
                _id: persistedObjectId,
                name,
                provider,
                fromName,
                fromAddress,
                brevoApiKey: '',
                smtp: {
                    host: '',
                    port: 587,
                    secure: false,
                    user: '',
                    pass: ''
                },
                verified: false,
                verifiedAt: null,
                testSentAt: existingAccount?.testSentAt || null
            };

            if (provider === 'brevo') {
                const providedKey = String(incomingAccount.brevoApiKey || '').trim();
                const finalBrevoKey = providedKey && !isMaskedSecret(providedKey)
                    ? encrypt(providedKey)
                    : encryptIfNeeded(existingAccount?.brevoApiKey || '');

                if (!finalBrevoKey) {
                    return res.status(400).json({ message: `Brevo API key is required for ${name}.` });
                }

                baseAccount.brevoApiKey = finalBrevoKey;
            }

            if (provider === 'smtp') {
                const port = Number.parseInt(smtp.port, 10);
                const providedPass = String(smtp.pass || '').trim();
                const finalSmtpPass = providedPass && !isMaskedSecret(providedPass)
                    ? encrypt(providedPass)
                    : encryptIfNeeded(existingAccount?.smtp?.pass || '');

                if (!String(smtp.host || '').trim()) {
                    return res.status(400).json({ message: `SMTP host is required for ${name}.` });
                }

                if (!String(smtp.user || '').trim()) {
                    return res.status(400).json({ message: `SMTP username is required for ${name}.` });
                }

                if (!finalSmtpPass) {
                    return res.status(400).json({ message: `SMTP password is required for ${name}.` });
                }

                baseAccount.smtp = {
                    host: String(smtp.host || '').trim(),
                    port: Number.isFinite(port) ? port : 587,
                    secure: Boolean(smtp.secure),
                    user: String(smtp.user || '').trim(),
                    pass: finalSmtpPass
                };
            }

            const configUnchanged = existingAccount && compareMeaningfulAccountFields(
                {
                    ...existingAccount,
                    name: existingAccount.name || '',
                    fromName: existingAccount.fromName || '',
                    fromAddress: existingAccount.fromAddress || ''
                },
                {
                    ...baseAccount,
                    brevoApiKey: baseAccount.brevoApiKey || '',
                    smtp: baseAccount.smtp
                }
            );

            if (existingAccount && configUnchanged) {
                baseAccount.verified = Boolean(existingAccount.verified);
                baseAccount.verifiedAt = existingAccount.verifiedAt || null;
                baseAccount.testSentAt = existingAccount.testSentAt || null;
            }

            incomingIdToPersistedId.set(
                incomingAccountId || String(persistedObjectId),
                String(persistedObjectId)
            );
            savedAccounts.push(baseAccount);
        }

        const resolvedDefaultAccountId = incomingIdToPersistedId.get(defaultAccountId) || defaultAccountId;
        const persistedDefaultAccountId = resolvedDefaultAccountId === PLATFORM_EMAIL_ACCOUNT_ID
            ? PLATFORM_EMAIL_ACCOUNT_ID
            : (savedAccounts.some((account) => String(account._id) === resolvedDefaultAccountId)
                ? resolvedDefaultAccountId
                : (savedAccounts[0] ? String(savedAccounts[0]._id) : PLATFORM_EMAIL_ACCOUNT_ID));

        await Company.findByIdAndUpdate(req.companyId, {
            $set: {
                'settings.email.defaultAccountId': persistedDefaultAccountId,
                'settings.email.accounts': savedAccounts,
                'settings.email.provider': 'platform',
                'settings.email.fromName': '',
                'settings.email.fromAddress': '',
                'settings.email.brevoApiKey': '',
                'settings.email.smtp': {
                    host: '',
                    port: 587,
                    secure: false,
                    user: '',
                    pass: ''
                },
                'settings.email.verified': false,
                'settings.email.verifiedAt': null,
                'settings.email.testSentAt': null
            }
        }, { new: true });
        clearCompanyEmailConfigCache(req.companyId);

        await AuditLog.create({
            companyId: req.companyId,
            performedBy: req.user?._id,
            action: 'EMAIL_SETTINGS_UPDATED',
            module: 'SETTINGS',
            details: {
                defaultAccountId: persistedDefaultAccountId,
                accountCount: savedAccounts.length,
                senders: savedAccounts.map((account) => ({
                    id: String(account._id),
                    name: account.name,
                    provider: account.provider,
                    fromAddress: account.fromAddress
                }))
            }
        });

        return res.json({ message: 'Email settings saved successfully.' });
    } catch (error) {
        console.error('updateEmailSettings error:', error);
        return res.status(500).json({
            message: 'Failed to save email settings.',
            error: error.message
        });
    }
};

exports.sendTestEmail = async (req, res) => {
    try {
        const { recipientEmail, emailAccountId } = req.body || {};
        const testTo = String(recipientEmail || req.user?.email || '').trim();

        if (!testTo) {
            return res.status(400).json({ message: 'A recipient email is required.' });
        }

        const company = await Company.findById(req.companyId)
            .select('name settings.email settings.logo')
            .lean();

        if (!company) {
            return res.status(404).json({ message: 'Company not found.' });
        }

        const settingsResponse = buildEmailSettingsResponse(company);
        const selectedAccountId = String(emailAccountId || settingsResponse.defaultAccountId || PLATFORM_EMAIL_ACCOUNT_ID);
        const selectedAccount = settingsResponse.accounts.find((account) => String(account._id) === selectedAccountId);
        const selectedProvider = selectedAccountId === PLATFORM_EMAIL_ACCOUNT_ID
            ? 'platform'
            : (selectedAccount?.provider || 'unknown');
        const selectedFromAddress = selectedAccountId === PLATFORM_EMAIL_ACCOUNT_ID
            ? settingsResponse.platformOption.fromAddress
            : (selectedAccount?.fromAddress || 'Not set');

        const html = `
            <div style="font-family: Arial, sans-serif; max-width: 600px; margin: auto; padding: 24px; border: 1px solid #e0e0e0; border-radius: 10px;">
                <h2 style="color: #4a90e2;">Email Configuration Test</h2>
                <p>This is a test email from <strong>${company.name}</strong> on TalentCIO.</p>
                <p>If you received this, your custom email sender is working correctly.</p>
                <hr style="border: none; border-top: 1px solid #eee; margin: 20px 0;">
                <p style="color: #999; font-size: 12px;">Provider: ${selectedProvider} | From: ${selectedFromAddress}</p>
            </div>
        `;

        const sent = await sendEmailForCompany({
            companyId: req.companyId,
            emailAccountId: selectedAccountId,
            to: testTo,
            subject: `[Test] Email Configuration - ${company.name}`,
            html,
            text: `Test email from ${company.name}. Your custom email sender is working correctly.`,
            brandEmail: true
        });

        if (!sent) {
            return res.status(400).json({
                message: 'Test email failed to send. Check the sender credentials and provider settings.'
            });
        }

        if (selectedAccountId !== PLATFORM_EMAIL_ACCOUNT_ID) {
            await Company.updateOne(
                { _id: req.companyId, 'settings.email.accounts._id': selectedAccountId },
                {
                    $set: { 'settings.email.accounts.$.testSentAt': new Date() }
                }
            );
        }
        clearCompanyEmailConfigCache(req.companyId);

        return res.json({
            message: `Test email sent to ${testTo}.`,
            success: true
        });
    } catch (error) {
        console.error('sendTestEmail error:', error);
        return res.status(500).json({
            message: 'Failed to send test email.',
            error: error.message
        });
    }
};

exports.verifySenderAddress = async (req, res) => {
    try {
        const emailAccountId = String(req.body?.emailAccountId || '');
        if (!emailAccountId || emailAccountId === PLATFORM_EMAIL_ACCOUNT_ID) {
            return res.status(400).json({ message: 'Choose a custom sender account to verify.' });
        }

        const result = await Company.updateOne(
            { _id: req.companyId, 'settings.email.accounts._id': emailAccountId },
            {
                $set: {
                    'settings.email.accounts.$.verified': true,
                    'settings.email.accounts.$.verifiedAt': new Date()
                }
            }
        );

        if (!result.matchedCount) {
            return res.status(404).json({ message: 'Sender account not found.' });
        }

        clearCompanyEmailConfigCache(req.companyId);

        return res.json({
            message: 'Sender address marked as verified.',
            verified: true
        });
    } catch (error) {
        console.error('verifySenderAddress error:', error);
        return res.status(500).json({
            message: 'Failed to verify sender.',
            error: error.message
        });
    }
};
