const CrmFollowUp = require('../models/crmFollowUp.model');
const CrmLead = require('../models/crmLead.model');
const CrmDeal = require('../models/crmDeal.model');
const CrmActivity = require('../models/crmActivity.model');

const getTenantId = (req) => req.companyId || req.user?.companyId;

const getUserDisplayName = (user) => {
  if (!user) return 'System';
  if (user.firstName) return `${user.firstName} ${user.lastName || ''}`.trim();
  return user.name || user.email || 'User';
};

// @desc Get follow-ups with smart temporal views
// @route GET /api/crm/follow-ups
const getFollowUps = async (req, res, next) => {
  try {
    const companyId = getTenantId(req);
    const { view = 'today', type, assignedTo } = req.query;
    const query = { companyId };

    if (type && type !== 'all') query.type = type;
    if (assignedTo && assignedTo !== 'all') query.assignedTo = assignedTo;

    const now = new Date();
    const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const endOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999);
    const startOfTomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
    const endOfTomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 23, 59, 59, 999);

    if (view === 'today') {
      query.scheduledDate = { $gte: startOfToday, $lte: endOfToday };
      query.status = { $in: ['scheduled', 'rescheduled'] };
    } else if (view === 'tomorrow') {
      query.scheduledDate = { $gte: startOfTomorrow, $lte: endOfTomorrow };
      query.status = { $in: ['scheduled', 'rescheduled'] };
    } else if (view === 'upcoming') {
      query.scheduledDate = { $gt: endOfTomorrow };
      query.status = { $in: ['scheduled', 'rescheduled'] };
    } else if (view === 'overdue') {
      query.scheduledDate = { $lt: startOfToday };
      query.status = { $in: ['scheduled', 'rescheduled'] };
    } else if (view === 'completed') {
      query.status = 'completed';
    } else if (view === 'missed') {
      query.status = 'missed';
    }

    const followUps = await CrmFollowUp.find(query)
      .populate('assignedTo', 'firstName lastName email profilePicture')
      .populate('leadId', 'firstName lastName companyName phone email status')
      .populate('dealId', 'title value stage accountId')
      .populate('contactId', 'firstName lastName phone email')
      .populate('accountId', 'name')
      .sort({ scheduledDate: 1 });

    const baseQuery = { companyId };
    const [todayCount, tomorrowCount, overdueCount, upcomingCount, completedCount] = await Promise.all([
      CrmFollowUp.countDocuments({ ...baseQuery, scheduledDate: { $gte: startOfToday, $lte: endOfToday }, status: { $in: ['scheduled', 'rescheduled'] } }),
      CrmFollowUp.countDocuments({ ...baseQuery, scheduledDate: { $gte: startOfTomorrow, $lte: endOfTomorrow }, status: { $in: ['scheduled', 'rescheduled'] } }),
      CrmFollowUp.countDocuments({ ...baseQuery, scheduledDate: { $lt: startOfToday }, status: { $in: ['scheduled', 'rescheduled'] } }),
      CrmFollowUp.countDocuments({ ...baseQuery, scheduledDate: { $gt: endOfTomorrow }, status: { $in: ['scheduled', 'rescheduled'] } }),
      CrmFollowUp.countDocuments({ ...baseQuery, status: 'completed' }),
    ]);

    res.json({
      success: true,
      data: followUps,
      counts: {
        today: todayCount,
        tomorrow: tomorrowCount,
        overdue: overdueCount,
        upcoming: upcomingCount,
        completed: completedCount,
      },
    });
  } catch (error) {
    next(error);
  }
};

// @desc Create follow-up
// @route POST /api/crm/follow-ups
const createFollowUp = async (req, res, next) => {
  try {
    const companyId = getTenantId(req);
    const followUp = await CrmFollowUp.create({
      ...req.body,
      companyId,
      assignedTo: req.body.assignedTo || req.user?._id,
      accountId: req.body.accountId || req.body.companyId,
    });

    // Update nextFollowUpAt on Lead/Deal
    if (followUp.leadId) {
      await CrmLead.findByIdAndUpdate(followUp.leadId, { nextFollowUpAt: followUp.scheduledDate });
    }
    if (followUp.dealId) {
      await CrmDeal.findByIdAndUpdate(followUp.dealId, { nextFollowUpAt: followUp.scheduledDate });
    }

    res.status(201).json({ success: true, message: 'Follow-up scheduled successfully', data: followUp });
  } catch (error) {
    next(error);
  }
};

// @desc Mark follow-up as completed
// @route PATCH /api/crm/follow-ups/:id/complete
const completeFollowUp = async (req, res, next) => {
  try {
    const companyId = getTenantId(req);
    const { outcomeNotes } = req.body;
    const followUp = await CrmFollowUp.findOneAndUpdate(
      { _id: req.params.id, companyId },
      {
        status: 'completed',
        completedAt: new Date(),
        outcomeNotes: outcomeNotes || '',
      },
      { new: true }
    );

    if (!followUp) return res.status(404).json({ success: false, message: 'Follow-up not found' });

    await CrmActivity.create({
      companyId,
      type: followUp.type === 'call' ? 'call' : 'meeting',
      subject: `Completed follow-up: ${followUp.title}`,
      description: outcomeNotes || 'Follow-up completed successfully.',
      performedBy: req.user?._id,
      performedByName: getUserDisplayName(req.user),
      leadId: followUp.leadId,
      dealId: followUp.dealId,
      accountId: followUp.accountId,
      contactId: followUp.contactId,
    });

    res.json({ success: true, message: 'Follow-up marked as completed', data: followUp });
  } catch (error) {
    next(error);
  }
};

// @desc Reschedule follow-up
// @route PATCH /api/crm/follow-ups/:id/reschedule
const rescheduleFollowUp = async (req, res, next) => {
  try {
    const companyId = getTenantId(req);
    const { newDate, notes } = req.body;
    if (!newDate) return res.status(400).json({ success: false, message: 'New date is required' });

    const followUp = await CrmFollowUp.findOneAndUpdate(
      { _id: req.params.id, companyId },
      {
        scheduledDate: new Date(newDate),
        status: 'rescheduled',
        notes: notes ? `${notes} (Rescheduled)` : undefined,
      },
      { new: true }
    );

    if (!followUp) return res.status(404).json({ success: false, message: 'Follow-up not found' });

    res.json({ success: true, message: 'Follow-up rescheduled', data: followUp });
  } catch (error) {
    next(error);
  }
};

// @desc Delete follow-up
// @route DELETE /api/crm/follow-ups/:id
const deleteFollowUp = async (req, res, next) => {
  try {
    const companyId = getTenantId(req);
    const followUp = await CrmFollowUp.findOneAndDelete({ _id: req.params.id, companyId });
    if (!followUp) return res.status(404).json({ success: false, message: 'Follow-up not found' });
    res.json({ success: true, message: 'Follow-up deleted' });
  } catch (error) {
    next(error);
  }
};

module.exports = {
  getFollowUps,
  createFollowUp,
  completeFollowUp,
  rescheduleFollowUp,
  deleteFollowUp,
};
