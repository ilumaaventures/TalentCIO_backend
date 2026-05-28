const Company = require('../models/Company');
const {
    NOTIFICATION_CHANNELS,
    NOTIFICATION_EVENT_DEFINITIONS,
    normalizeNotificationSettings
} = require('../constants/notificationSettings');
const {
    PLATFORM_EMAIL_ACCOUNT_ID,
    getCompanyEmailSettings,
    resolveStoredAccountConfig
} = require('../services/companyEmailService');
const { clearCompanyNotificationSettingsCache } = require('../services/notificationService');

const buildNotificationSettingsResponse = async (companyId) => {
    const company = await Company.findById(companyId)
        .select('settings.notifications')
        .lean();

    if (!company) {
        return null;
    }

    return {
        settings: normalizeNotificationSettings(company?.settings?.notifications || {}),
        definitions: NOTIFICATION_EVENT_DEFINITIONS,
        channels: NOTIFICATION_CHANNELS
    };
};

exports.getNotificationSettings = async (req, res) => {
    try {
        const payload = await buildNotificationSettingsResponse(req.companyId);

        if (!payload) {
            return res.status(404).json({ message: 'Company not found.' });
        }

        return res.json(payload);
    } catch (error) {
        console.error('getNotificationSettings error:', error);
        return res.status(500).json({
            message: 'Failed to fetch notification settings.',
            error: error.message
        });
    }
};

exports.updateNotificationSettings = async (req, res) => {
    try {
        const normalizedSettings = normalizeNotificationSettings(req.body || {});
        const requestedSenderId = String(normalizedSettings.emailSenderAccountId || '').trim();
        const requestedEventSenderIds = Object.values(normalizedSettings.eventEmailSenderAccountIds || {})
            .map((value) => String(value || '').trim())
            .filter(Boolean);

        if (requestedSenderId || requestedEventSenderIds.length > 0) {
            const emailSettings = await getCompanyEmailSettings(req.companyId);
            const allRequestedSenderIds = [...new Set([requestedSenderId, ...requestedEventSenderIds].filter(Boolean))];

            for (const senderId of allRequestedSenderIds) {
                if (senderId === PLATFORM_EMAIL_ACCOUNT_ID) {
                    continue;
                }

                const selectedAccount = (emailSettings?.accounts || []).find(
                    (account) => String(account?._id || '') === senderId
                );

                if (!selectedAccount || !resolveStoredAccountConfig(selectedAccount, emailSettings?.companyName || 'TalentCIO')) {
                    return res.status(400).json({
                        message: 'Selected sender email is unavailable or not fully configured.'
                    });
                }
            }
        }

        const company = await Company.findByIdAndUpdate(
            req.companyId,
            {
                $set: {
                    'settings.notifications.emailSenderAccountId': requestedSenderId,
                    'settings.notifications.events': normalizedSettings.events,
                    'settings.notifications.eventEmailSenderSources': normalizedSettings.eventEmailSenderSources,
                    'settings.notifications.eventEmailSenderAccountIds': normalizedSettings.eventEmailSenderAccountIds
                }
            },
            { new: true }
        ).select('settings.notifications');

        if (!company) {
            return res.status(404).json({ message: 'Company not found.' });
        }

        clearCompanyNotificationSettingsCache(req.companyId);

        return res.json({
            message: 'Notification settings saved successfully.',
            settings: normalizeNotificationSettings(company?.settings?.notifications || {})
        });
    } catch (error) {
        console.error('updateNotificationSettings error:', error);
        return res.status(500).json({
            message: 'Failed to save notification settings.',
            error: error.message
        });
    }
};
