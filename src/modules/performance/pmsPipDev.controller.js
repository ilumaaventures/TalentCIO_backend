const PmsPip = require('./models/pmsPip.model');
const PmsDevelopmentPlan = require('./models/pmsDevelopmentPlan.model');
const User = require('../user/user.model');
const { logPmsAudit } = require('./services/pmsAudit.service');
const { sendPmsNotification } = require('./services/pmsNotification.service');
const { isUserAdminOrSuper, isUserHr } = require('./services/pmsWorkflow.service');

// ─── Performance Improvement Plans (PIP) ───────────────────────────────────

const listPips = async (req, res) => {
  try {
    const companyId = req.companyId;
    const filter = { companyId };
    const isHrOrAdmin = isUserAdminOrSuper(req.user) || isUserHr(req.user);

    if (!isHrOrAdmin) {
      if (req.query.scope === 'my_team') {
        const directReports = await User.find({ reportingManagers: req.user._id, companyId }).select('_id').lean();
        const reportIds = directReports.map((d) => d._id);
        filter.$or = [{ managerId: req.user._id }, { employeeId: { $in: reportIds } }];
      } else {
        filter.employeeId = req.user._id;
      }
    } else if (req.query.employeeId) {
      filter.employeeId = req.query.employeeId;
    }
    if (req.query.status) filter.status = req.query.status;

    const pips = await PmsPip.find(filter)
      .populate('employeeId', 'firstName lastName email department profilePicture')
      .populate('managerId', 'firstName lastName')
      .populate('initiatedBy', 'firstName lastName')
      .sort({ createdAt: -1 })
      .lean();

    return res.status(200).json({ success: true, data: pips });
  } catch (err) {
    console.error('[PMS listPips Error]:', err);
    return res.status(500).json({ success: false, message: 'Failed to fetch PIP records' });
  }
};

const createPip = async (req, res) => {
  try {
    const { employeeId, managerId, cycleId, title, reason, startDate, endDate, objectives, supportActions } = req.body;

    if (!employeeId || !title || !reason || !startDate || !endDate) {
      return res.status(400).json({ success: false, message: 'Employee, title, reason, start date, and end date are required' });
    }

    const pip = await PmsPip.create({
      companyId: req.companyId,
      employeeId,
      managerId: managerId || req.user._id,
      initiatedBy: req.user._id,
      cycleId,
      title: title.trim(),
      reason: reason.trim(),
      startDate,
      endDate,
      objectives: Array.isArray(objectives) ? objectives : [],
      supportActions: Array.isArray(supportActions) ? supportActions : [],
      status: 'active',
    });

    await logPmsAudit({
      companyId: req.companyId,
      userId: req.user._id,
      action: 'PIP_INITIATED',
      entityType: 'PmsPip',
      entityId: pip._id,
      entityName: pip.title,
      changes: req.body,
    });

    sendPmsNotification(req, {
      userId: employeeId,
      title: 'Performance Improvement Plan Initiated',
      message: `A structured improvement plan has been scheduled: ${title}`,
      link: '/performance?tab=pip',
      preferenceKey: 'pms_pip_initiated',
    });

    return res.status(201).json({ success: true, message: 'PIP created and activated', data: pip });
  } catch (err) {
    console.error('[PMS createPip Error]:', err);
    return res.status(500).json({ success: false, message: 'Failed to create PIP' });
  }
};

const addPipCheckpoint = async (req, res) => {
  try {
    const { id } = req.params;
    const { checkpointDate, notes, employeeFeedback, isSatisfactory } = req.body;

    const pip = await PmsPip.findOne({ _id: id, companyId: req.companyId });
    if (!pip) {
      return res.status(404).json({ success: false, message: 'PIP record not found' });
    }

    pip.checkpoints.push({
      checkpointDate: checkpointDate || new Date(),
      notes: notes || '',
      conductedBy: req.user._id,
      employeeFeedback: employeeFeedback || '',
      isSatisfactory: Boolean(isSatisfactory),
    });

    await pip.save();

    return res.status(200).json({ success: true, message: 'Checkpoint recorded', data: pip });
  } catch (err) {
    console.error('[PMS addPipCheckpoint Error]:', err);
    return res.status(500).json({ success: false, message: 'Failed to record checkpoint' });
  }
};

const updatePipStatus = async (req, res) => {
  try {
    const { id } = req.params;
    const { status, finalOutcomeSummary, extendedUntil } = req.body;

    const pip = await PmsPip.findOne({ _id: id, companyId: req.companyId });
    if (!pip) {
      return res.status(404).json({ success: false, message: 'PIP record not found' });
    }

    pip.status = status;
    if (finalOutcomeSummary) pip.finalOutcomeSummary = finalOutcomeSummary;
    if (extendedUntil) pip.extendedUntil = extendedUntil;

    pip.decisionHistory.push({
      action: `Status changed to ${status}`,
      date: new Date(),
      actor: req.user._id,
      notes: finalOutcomeSummary || '',
    });

    await pip.save();

    await logPmsAudit({
      companyId: req.companyId,
      userId: req.user._id,
      action: 'PIP_STATUS_UPDATED',
      entityType: 'PmsPip',
      entityId: pip._id,
      changes: { status, finalOutcomeSummary },
    });

    return res.status(200).json({ success: true, message: 'PIP status updated', data: pip });
  } catch (err) {
    console.error('[PMS updatePipStatus Error]:', err);
    return res.status(500).json({ success: false, message: 'Failed to update PIP status' });
  }
};

// ─── Individual Development Plans (IDP) ─────────────────────────────────────

const listDevPlans = async (req, res) => {
  try {
    const companyId = req.companyId;
    const filter = { companyId };
    const isHrOrAdmin = isUserAdminOrSuper(req.user) || isUserHr(req.user);

    if (!isHrOrAdmin) {
      if (req.query.scope === 'my_team') {
        const directReports = await User.find({ reportingManagers: req.user._id, companyId }).select('_id').lean();
        const reportIds = directReports.map((d) => d._id);
        filter.$or = [{ managerId: req.user._id }, { employeeId: { $in: reportIds } }];
      } else {
        filter.employeeId = req.user._id;
      }
    } else if (req.query.employeeId) {
      filter.employeeId = req.query.employeeId;
    }

    const plans = await PmsDevelopmentPlan.find(filter)
      .populate('employeeId', 'firstName lastName email department profilePicture')
      .populate('managerId', 'firstName lastName')
      .sort({ createdAt: -1 })
      .lean();

    return res.status(200).json({ success: true, data: plans });
  } catch (err) {
    console.error('[PMS listDevPlans Error]:', err);
    return res.status(500).json({ success: false, message: 'Failed to fetch development plans' });
  }
};

const createDevPlan = async (req, res) => {
  try {
    const { employeeId, managerId, cycleId, appraisalId, objectives, notes } = req.body;

    const targetEmployee = employeeId || req.user._id;

    const plan = await PmsDevelopmentPlan.create({
      companyId: req.companyId,
      employeeId: targetEmployee,
      managerId: managerId || req.user._id,
      cycleId,
      appraisalId,
      objectives: Array.isArray(objectives) ? objectives : [],
      notes: notes || '',
    });

    return res.status(201).json({ success: true, message: 'Development plan created', data: plan });
  } catch (err) {
    console.error('[PMS createDevPlan Error]:', err);
    return res.status(500).json({ success: false, message: 'Failed to create development plan' });
  }
};

const updateDevPlanObjective = async (req, res) => {
  try {
    const { id } = req.params;
    const { objectiveIndex, status, evidenceUrl, managerFeedback } = req.body;

    const plan = await PmsDevelopmentPlan.findOne({ _id: id, companyId: req.companyId });
    if (!plan || !plan.objectives[objectiveIndex]) {
      return res.status(404).json({ success: false, message: 'Objective not found' });
    }

    if (status !== undefined) plan.objectives[objectiveIndex].status = status;
    if (evidenceUrl !== undefined) plan.objectives[objectiveIndex].evidenceUrl = evidenceUrl;
    if (managerFeedback !== undefined) plan.objectives[objectiveIndex].managerFeedback = managerFeedback;

    await plan.save();

    return res.status(200).json({ success: true, message: 'Objective updated successfully', data: plan });
  } catch (err) {
    console.error('[PMS updateDevPlanObjective Error]:', err);
    return res.status(500).json({ success: false, message: 'Failed to update objective' });
  }
};

module.exports = {
  listPips,
  createPip,
  addPipCheckpoint,
  updatePipStatus,
  listDevPlans,
  createDevPlan,
  updateDevPlanObjective,
};
