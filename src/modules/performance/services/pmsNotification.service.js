const NotificationService = require('../../../services/notificationService');

/**
 * Sends a PMS notification to a user with optional socket emission & email
 * @param {Object} req Express request object (contains app, companyId, io)
 * @param {Object} options
 */
const sendPmsNotification = async (req, options = {}) => {
  try {
    const io = req?.app?.get('io') || null;
    const companyId = req?.companyId || options.companyId;

    if (!companyId || !options.userId) return;

    await NotificationService.createNotification(io, {
      user: options.userId,
      companyId,
      title: options.title || 'PMS Update',
      message: options.message || '',
      type: options.type || 'Action',
      link: options.link || '/performance',
      metadata: options.metadata || {},
      preferenceKey: options.preferenceKey || 'pms_update',
    });
  } catch (err) {
    console.error('[PMS Notification Error]:', err.message);
  }
};

module.exports = { sendPmsNotification };
