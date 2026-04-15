const Notification = require('../models/Notification');

/**
 * Service to handle notification creation and real-time delivery via WebSockets
 */
class NotificationService {
    /**
     * Create a notification and emit via socket
     * @param {Object} io - Socket.io instance
     * @param {Object} data - Notification data (user, title, message, type, link, metadata)
     */
    static async createNotification(io, data) {
        try {
            const notification = new Notification(data);
            await notification.save();

            if (this.verifySocket(io)) {
                // Emit a plain object (not raw Mongoose doc) to avoid serialization issues
                io.to(data.user.toString()).emit('notification', notification.toObject());
            }

            return notification;
        } catch (error) {
            console.error('Error in NotificationService.createNotification:', error);
            throw error;
        }
    }

    /**
     * Create multiple notifications and emit via socket
     * @param {Object} io - Socket.io instance
     * @param {Array} notificationsData - Array of notification data objects
     */
    static async createManyNotifications(io, notificationsData) {
        try {
            const notifications = await Notification.insertMany(notificationsData);

            if (this.verifySocket(io)) {
                notifications.forEach(notification => {
                    // Emit a plain object (not raw Mongoose doc) to avoid serialization issues
                    io.to(notification.user.toString()).emit('notification', notification.toObject());
                });
            }

            return notifications;
        } catch (error) {
            console.error('Error in NotificationService.createManyNotifications:', error);
            throw error;
        }
    }

    /**
     * Internal helper to verify socket availability
     */
    static verifySocket(io) {
        if (!io) {
            console.warn('[NOTIF WARNING] Attempted to send notification but Socket.io (io) is undefined. Ensure app.set("io", io) is called in server setup.');
            return false;
        }
        return true;
    }

    /**
     * Emit a generic update event (e.g., for interview list refresh)
     * @param {Object} io - Socket.io instance
     * @param {String} userId - User ID to notify
     * @param {String} eventName - Name of the event (e.g., 'interview_update')
     * @param {Object} payload - Data to send
     */
    static emitToUser(io, userId, eventName, payload) {
        if (io && userId) {
            io.to(userId.toString()).emit(eventName, payload);
        }
    }
}

module.exports = NotificationService;
