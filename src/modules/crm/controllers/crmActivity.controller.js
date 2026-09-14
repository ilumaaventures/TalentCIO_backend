const CrmActivity = require('../models/crmActivity.model');
const CrmLead = require('../models/crmLead.model');
const CrmDeal = require('../models/crmDeal.model');
const CrmAccount = require('../models/crmAccount.model');
const CrmContact = require('../models/crmContact.model');

const getTenantId = (req) => req.companyId || req.user?.companyId;

const getUserDisplayName = (user) => {
  if (!user) return 'System';
  if (user.firstName) return `${user.firstName} ${user.lastName || ''}`.trim();
  return user.name || user.email || 'User';
};

// @desc Get activities timeline
// @route GET /api/crm/activities
const getActivities = async (req, res, next) => {
  try {
    const companyId = getTenantId(req);
    const { leadId, dealId, accountId, companyId: queryAccId, contactId, type, limit = 50, page = 1 } = req.query;
    const query = { companyId };

    if (leadId) query.leadId = leadId;
    if (dealId) query.dealId = dealId;
    const effectiveAccountId = accountId || queryAccId;
    if (effectiveAccountId) query.accountId = effectiveAccountId;
    if (contactId) query.contactId = contactId;
    if (type && type !== 'all') query.type = type;

    const total = await CrmActivity.countDocuments(query);
    const activities = await CrmActivity.find(query)
      .populate('performedBy', 'firstName lastName email profilePicture')
      .populate('leadId', 'firstName lastName companyName')
      .populate('dealId', 'title value')
      .populate('contactId', 'firstName lastName')
      .populate('accountId', 'name')
      .sort({ performedAt: -1 })
      .skip((page - 1) * limit)
      .limit(Number(limit));

    res.json({
      success: true,
      data: activities,
      pagination: {
        total,
        page: Number(page),
        limit: Number(limit),
        totalPages: Math.ceil(total / limit),
      },
    });
  } catch (error) {
    next(error);
  }
};

// @desc Log an activity (call, meeting, note, email, whatsapp)
// @route POST /api/crm/activities
const logActivity = async (req, res, next) => {
  try {
    const companyId = getTenantId(req);
    const activityData = {
      ...req.body,
      companyId,
      performedBy: req.user?._id,
      performedByName: getUserDisplayName(req.user),
      performedAt: req.body.performedAt || new Date(),
      accountId: req.body.accountId || req.body.companyId,
    };

    const activity = await CrmActivity.create(activityData);

    // Touch lastActivityAt on parent entities
    const now = new Date();
    if (activity.leadId) await CrmLead.findByIdAndUpdate(activity.leadId, { lastActivityAt: now });
    if (activity.dealId) await CrmDeal.findByIdAndUpdate(activity.dealId, { lastActivityAt: now });
    if (activity.accountId) await CrmAccount.findByIdAndUpdate(activity.accountId, { lastActivityAt: now });
    if (activity.contactId) await CrmContact.findByIdAndUpdate(activity.contactId, { lastActivityAt: now });

    res.status(201).json({
      success: true,
      message: 'Activity logged successfully',
      data: activity,
    });
  } catch (error) {
    next(error);
  }
};

module.exports = {
  getActivities,
  logActivity,
};
