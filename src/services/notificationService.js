const Company = require('../models/Company');
const Notification = require('../models/Notification');
const User = require('../models/User');
const { normalizeNotificationSettings, NOTIFICATION_EVENT_MAP } = require('../constants/notificationSettings');
const { sendEmailForCompany } = require('./companyEmailService');

const NOTIFICATION_SETTINGS_CACHE_TTL_MS = 5 * 60 * 1000;
const notificationSettingsCache = new Map();

const getCacheKey = (companyId) => String(companyId || '');

const clearCompanyNotificationSettingsCache = (companyId) => {
    if (!companyId) return;
    notificationSettingsCache.delete(getCacheKey(companyId));
};

const resolveRelativeAppLink = (link = '') => {
    const normalizedLink = String(link || '').trim();
    if (!normalizedLink) {
        return '';
    }

    if (/^https?:\/\//i.test(normalizedLink)) {
        return normalizedLink;
    }

    const appBaseUrl = String(process.env.FRONTEND_URL || 'http://localhost:5173').replace(/\/+$/, '');
    const path = normalizedLink.startsWith('/') ? normalizedLink : `/${normalizedLink}`;
    return `${appBaseUrl}${path}`;
};

const escapeHtml = (value = '') => String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

/**
 * Service to handle notification creation, optional email delivery, and real-time delivery via WebSockets.
 */
class NotificationService {
    static async createNotification(io, data) {
        const notifications = await this.dispatchNotifications(io, [data]);
        return notifications[0] || null;
    }

    static async createManyNotifications(io, notificationsData) {
        return this.dispatchNotifications(io, notificationsData);
    }

    static async dispatchNotifications(io, notificationsData = []) {
        const items = Array.isArray(notificationsData)
            ? notificationsData.filter(Boolean)
            : [];

        if (!items.length) {
            return [];
        }

        const persistedNotificationsByIndex = new Array(items.length).fill(null);
        const groupedByCompany = items.reduce((accumulator, item, index) => {
            const key = String(item?.companyId || 'no-company');
            if (!accumulator.has(key)) {
                accumulator.set(key, []);
            }
            accumulator.get(key).push({ item, index });
            return accumulator;
        }, new Map());

        for (const [companyKey, groupedItems] of groupedByCompany.entries()) {
            const companyId = companyKey === 'no-company' ? null : companyKey;
            const settings = companyId
                ? await this.getCompanyNotificationSettings(companyId)
                : null;
            const userIds = [...new Set(
                groupedItems
                    .map(({ item }) => String(item?.user || '').trim())
                    .filter(Boolean)
            )];
            const users = userIds.length > 0
                ? await User.find({ _id: { $in: userIds } })
                    .select('_id firstName lastName email isActive')
                    .lean()
                : [];
            const usersById = new Map(users.map((user) => [String(user._id), user]));
            const recordsToInsert = [];
            const insertIndexes = [];
            const emailJobs = [];

            groupedItems.forEach(({ item, index }) => {
                const channel = this.resolveNotificationChannel(settings, item?.preferenceKey);
                const user = usersById.get(String(item?.user || ''));

                if (this.channelIncludesSystem(channel)) {
                    const persistedPayload = { ...item };
                    delete persistedPayload.preferenceKey;
                    delete persistedPayload.emailSubject;
                    delete persistedPayload.emailText;
                    delete persistedPayload.emailHtml;
                    recordsToInsert.push(persistedPayload);
                    insertIndexes.push(index);
                }

                if (companyId && this.channelIncludesEmail(channel) && user?.email && user?.isActive !== false) {
                    emailJobs.push(this.sendNotificationEmail({
                        companyId,
                        user,
                        data: item,
                        settings
                    }));
                }
            });

            if (recordsToInsert.length > 0) {
                const insertedNotifications = await Notification.insertMany(recordsToInsert);

                insertedNotifications.forEach((notification, position) => {
                    const originalIndex = insertIndexes[position];
                    persistedNotificationsByIndex[originalIndex] = notification;

                    if (this.verifySocket(io)) {
                        io.to(notification.user.toString()).emit('notification', notification.toObject());
                    }
                });
            }

            if (emailJobs.length > 0) {
                await Promise.allSettled(emailJobs);
            }
        }

        return persistedNotificationsByIndex.filter(Boolean);
    }

    static async getCompanyNotificationSettings(companyId) {
        const cacheKey = getCacheKey(companyId);
        const cachedEntry = notificationSettingsCache.get(cacheKey);

        if (cachedEntry && cachedEntry.expiresAt > Date.now()) {
            return cachedEntry.value;
        }

        const company = await Company.findById(companyId)
            .select('settings.notifications')
            .lean();
        const normalized = normalizeNotificationSettings(company?.settings?.notifications || {});

        notificationSettingsCache.set(cacheKey, {
            value: normalized,
            expiresAt: Date.now() + NOTIFICATION_SETTINGS_CACHE_TTL_MS
        });

        return normalized;
    }

    static resolveNotificationChannel(settings, preferenceKey) {
        const normalizedKey = String(preferenceKey || '').trim();
        if (!normalizedKey) {
            return 'system';
        }

        return settings?.events?.[normalizedKey] || NOTIFICATION_EVENT_MAP[normalizedKey]?.defaultChannel || 'system';
    }

    static async getEmailPreferenceForEvent(companyId, preferenceKey, fallbackEmailAccountId = '') {
        const settings = companyId
            ? await this.getCompanyNotificationSettings(companyId)
            : null;
        const channel = this.resolveNotificationChannel(settings, preferenceKey);

        return {
            channel,
            shouldSendEmail: this.channelIncludesEmail(channel),
            emailAccountId: String(fallbackEmailAccountId || settings?.emailSenderAccountId || '').trim() || undefined
        };
    }

    static channelIncludesSystem(channel = '') {
        return channel === 'system' || channel === 'both';
    }

    static channelIncludesEmail(channel = '') {
        return channel === 'email' || channel === 'both';
    }

    static buildEmailPayload({ user, data }) {
        const title = String(data?.emailSubject || data?.title || 'Notification').trim();
        const message = String(data?.message || '').trim();
        const linkUrl = resolveRelativeAppLink(data?.link);
        const recipientName = [user?.firstName, user?.lastName].filter(Boolean).join(' ').trim() || 'there';

        const html = data?.emailHtml || `
            <div style="font-family:Arial,sans-serif;color:#0f172a;">
                <p style="margin:0 0 16px;">Hi ${escapeHtml(recipientName)},</p>
                <h2 style="margin:0 0 12px;font-size:20px;color:#0f172a;">${escapeHtml(title)}</h2>
                <p style="margin:0 0 20px;line-height:1.6;color:#334155;">${escapeHtml(message)}</p>
                ${linkUrl ? `
                    <p style="margin:24px 0 0;">
                        <a href="${escapeHtml(linkUrl)}" style="display:inline-block;padding:12px 20px;background:#2563eb;color:#ffffff;text-decoration:none;border-radius:8px;font-weight:700;">
                            Open in TalentCIO
                        </a>
                    </p>
                ` : ''}
            </div>
        `;
        const text = data?.emailText || `${title}\n\n${message}${linkUrl ? `\n\nOpen: ${linkUrl}` : ''}`;

        return { subject: title, html, text };
    }

    static async sendNotificationEmail({ companyId, user, data, settings }) {
        try {
            const { subject, html, text } = this.buildEmailPayload({ user, data });
            return await sendEmailForCompany({
                companyId,
                emailAccountId: settings?.emailSenderAccountId || undefined,
                to: user.email,
                subject,
                html,
                text,
                brandEmail: true
            });
        } catch (error) {
            console.error('Notification email delivery failed:', error.message || error);
            return false;
        }
    }

    static verifySocket(io) {
        if (!io) {
            console.warn('[NOTIF WARNING] Attempted to send notification but Socket.io (io) is undefined. Ensure app.set("io", io) is called in server setup.');
            return false;
        }
        return true;
    }

    static emitToUser(io, userId, eventName, payload) {
        if (io && userId) {
            io.to(userId.toString()).emit(eventName, payload);
        }
    }
}

module.exports = NotificationService;
module.exports.clearCompanyNotificationSettingsCache = clearCompanyNotificationSettingsCache;
