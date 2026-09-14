const CrmActivity = require('../models/crmActivity.model');

const getTenantId = (req) => req.companyId || req.user?.companyId;

const getUserDisplayName = (user) => {
  if (!user) return 'System';
  if (user.firstName) return `${user.firstName} ${user.lastName || ''}`.trim();
  return user.name || user.email || 'User';
};

// In-memory preview log queues
const emailThreads = [];
const whatsAppMessages = [];

// @desc Get email threads & activities
// @route GET /api/crm/communication/emails
const getEmails = async (req, res, next) => {
  try {
    const companyId = getTenantId(req);
    const emailActivities = await CrmActivity.find({
      companyId,
      type: 'email',
    })
      .populate('performedBy', 'firstName lastName email profilePicture')
      .populate('leadId', 'firstName lastName email companyName')
      .sort({ performedAt: -1 })
      .limit(30);

    res.json({
      success: true,
      data: {
        threads: emailThreads,
        activities: emailActivities,
      },
    });
  } catch (error) {
    next(error);
  }
};

// @desc Send email
// @route POST /api/crm/communication/emails
const sendEmail = async (req, res, next) => {
  try {
    const companyId = getTenantId(req);
    const { to, recipientName, subject, body, leadId, dealId, contactId } = req.body;

    const newEmail = {
      id: `em-${Date.now()}`,
      to,
      recipientName: recipientName || to,
      subject,
      body,
      status: 'Sent',
      opened: false,
      sentAt: new Date(),
    };
    emailThreads.unshift(newEmail);

    await CrmActivity.create({
      companyId,
      type: 'email',
      subject: `Sent Email: ${subject}`,
      description: `To: ${to}\n\n${(body || '').substring(0, 200)}...`,
      outcome: 'Sent',
      performedBy: req.user?._id,
      performedByName: getUserDisplayName(req.user),
      leadId,
      dealId,
      contactId,
    });

    res.status(201).json({
      success: true,
      message: 'Email dispatched successfully',
      data: newEmail,
    });
  } catch (error) {
    next(error);
  }
};

// @desc Get WhatsApp messages
// @route GET /api/crm/communication/whatsapp
const getWhatsAppMessages = async (req, res, next) => {
  try {
    const companyId = getTenantId(req);
    const waActivities = await CrmActivity.find({
      companyId,
      type: 'whatsapp',
    })
      .populate('performedBy', 'firstName lastName')
      .sort({ performedAt: -1 })
      .limit(30);

    res.json({
      success: true,
      data: {
        messages: whatsAppMessages,
        activities: waActivities,
      },
    });
  } catch (error) {
    next(error);
  }
};

// @desc Send WhatsApp message
// @route POST /api/crm/communication/whatsapp
const sendWhatsAppMessage = async (req, res, next) => {
  try {
    const companyId = getTenantId(req);
    const { phone, recipientPhone, recipientName, message, leadId, dealId, contactId } = req.body;
    const targetPhone = phone || recipientPhone || '';

    const newMsg = {
      id: `wa-${Date.now()}`,
      phone: targetPhone,
      recipientPhone: targetPhone,
      recipientName: recipientName || targetPhone,
      message,
      status: 'Delivered',
      sentAt: new Date(),
    };
    whatsAppMessages.unshift(newMsg);

    await CrmActivity.create({
      companyId,
      type: 'whatsapp',
      subject: `WhatsApp to ${recipientName || targetPhone}`,
      description: message,
      outcome: 'Sent',
      performedBy: req.user?._id,
      performedByName: getUserDisplayName(req.user),
      leadId,
      dealId,
      contactId,
    });

    res.status(201).json({
      success: true,
      message: 'WhatsApp message sent',
      data: newMsg,
    });
  } catch (error) {
    next(error);
  }
};

// @desc Get Call logs
// @route GET /api/crm/communication/calls
const getCalls = async (req, res, next) => {
  try {
    const companyId = getTenantId(req);
    const calls = await CrmActivity.find({
      companyId,
      type: 'call',
    })
      .populate('performedBy', 'firstName lastName email profilePicture')
      .populate('leadId', 'firstName lastName phone companyName')
      .populate('dealId', 'title')
      .sort({ performedAt: -1 })
      .limit(50);

    res.json({ success: true, data: calls });
  } catch (error) {
    next(error);
  }
};

// @desc Log a completed or missed call
// @route POST /api/crm/communication/calls
const logCall = async (req, res, next) => {
  try {
    const companyId = getTenantId(req);
    const {
      phone,
      contactName,
      outcome = 'Connected',
      durationMinutes = 5,
      notes,
      leadId,
      dealId,
      contactId,
    } = req.body;

    const callActivity = await CrmActivity.create({
      companyId,
      type: 'call',
      subject: `Call with ${contactName || phone} (${outcome})`,
      description: notes || `Phone call (${durationMinutes} min)`,
      outcome,
      durationMinutes: Number(durationMinutes) || 0,
      performedBy: req.user?._id,
      performedByName: getUserDisplayName(req.user),
      leadId,
      dealId,
      contactId,
    });

    res.status(201).json({
      success: true,
      message: 'Call logged successfully',
      data: callActivity,
    });
  } catch (error) {
    next(error);
  }
};

module.exports = {
  getEmails,
  sendEmail,
  getWhatsAppMessages,
  sendWhatsAppMessage,
  getCalls,
  logCall,
};
