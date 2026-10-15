const mongoose = require('mongoose');
const PmsCycle = require('./models/pmsCycle.model');
const PmsAppraisal = require('./models/pmsAppraisal.model');
const User = require('../user/user.model');
const { logPmsAudit } = require('./services/pmsAudit.service');
const { sendPmsNotification } = require('./services/pmsNotification.service');

// Valid status lifecycle order
const LIFECYCLE_ORDER = [
  'draft',
  'scheduled',
  'goal_setting',
  'in_progress',
  'self_review',
  'manager_review',
  'peer_feedback',
  'calibration',
  'approval',
  'published',
  'closed',
];

/**
 * @desc Get all cycles with pagination & filtering
 * @route GET /api/performance/cycles
 */
const listCycles = async (req, res) => {
  try {
    const companyId = req.companyId;
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 10));
    const skip = (page - 1) * limit;

    const filter = { companyId };
    if (req.query.status) filter.status = req.query.status;
    if (req.query.cycleType) filter.cycleType = req.query.cycleType;
    if (req.query.search) {
      filter.name = { $regex: req.query.search.trim(), $options: 'i' };
    }

    let [cycles, total] = await Promise.all([
      PmsCycle.find(filter)
        .populate('createdBy', 'firstName lastName email')
        .sort({ startDate: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      PmsCycle.countDocuments(filter),
    ]);

    if (total === 0 && !req.query.search && !req.query.status) {
      const { ensureDefaultCycleAndParticipants } = require('./pmsSimpleEvaluation.controller');
      await ensureDefaultCycleAndParticipants(companyId, req.user._id);
      cycles = await PmsCycle.find(filter)
        .populate('createdBy', 'firstName lastName email')
        .sort({ startDate: -1 })
        .skip(skip)
        .limit(limit)
        .lean();
      total = await PmsCycle.countDocuments(filter);
    }

    // Attach brief summary counts (strictly for active employees)
    const cycleIds = cycles.map((c) => c._id);
    const activeEmployees = await User.find({
      companyId,
      isActive: true,
      isDeleted: { $ne: true },
      status: { $nin: ['deleted', 'inactive', 'terminated', 'Inactive', 'Terminated'] },
    }).select('_id').lean();
    const activeEmployeeIds = activeEmployees.map((e) => e._id);

    const appraisalCounts = await PmsAppraisal.aggregate([
      { $match: { cycleId: { $in: cycleIds }, employeeId: { $in: activeEmployeeIds } } },
      { $group: { _id: '$cycleId', totalAppraisals: { $sum: 1 }, published: { $sum: { $cond: [{ $eq: ['$status', 'published'] }, 1, 0] } } } },
    ]);
    const countsMap = new Map(appraisalCounts.map((a) => [String(a._id), a]));

    const populatedCycles = cycles.map((c) => ({
      ...c,
      stats: countsMap.get(String(c._id)) || { totalAppraisals: 0, published: 0 },
    }));

    return res.status(200).json({
      success: true,
      data: populatedCycles,
      pagination: {
        page,
        limit,
        total,
        pages: Math.ceil(total / limit),
      },
    });
  } catch (err) {
    console.error('[PMS listCycles Error]:', err);
    return res.status(500).json({ success: false, message: 'Failed to fetch performance cycles' });
  }
};

/**
 * @desc Get single cycle by ID with progress metrics
 * @route GET /api/performance/cycles/:id
 */
const getCycle = async (req, res) => {
  try {
    const { id } = req.params;
    const cycle = await PmsCycle.findOne({ _id: id, companyId: req.companyId })
      .populate('createdBy', 'firstName lastName email')
      .populate({
        path: 'applicableEmployees',
        match: {
          isActive: true,
          isDeleted: { $ne: true },
          status: { $nin: ['deleted', 'inactive', 'terminated', 'Inactive', 'Terminated'] },
        },
        select: 'firstName lastName email department designationRef profilePicture',
      })
      .lean();

    if (!cycle) {
      return res.status(404).json({ success: false, message: 'Performance cycle not found' });
    }

    if (Array.isArray(cycle.applicableEmployees)) {
      cycle.applicableEmployees = cycle.applicableEmployees.filter(Boolean);
    }

    // Aggregate progress (strictly for active employees)
    const activeEmployeesForCycle = await User.find({
      companyId: req.companyId,
      isActive: true,
      isDeleted: { $ne: true },
      status: { $nin: ['deleted', 'inactive', 'terminated', 'Inactive', 'Terminated'] },
    }).select('_id').lean();
    const activeCycleEmpIds = activeEmployeesForCycle.map((e) => e._id);

    const statusAgg = await PmsAppraisal.aggregate([
      { $match: { cycleId: new mongoose.Types.ObjectId(id), employeeId: { $in: activeCycleEmpIds } } },
      { $group: { _id: '$status', count: { $sum: 1 } } },
    ]);

    const stats = {
      total: 0,
      selfReviewPending: 0,
      managerReviewPending: 0,
      peerPending: 0,
      calibrationPending: 0,
      underApproval: 0,
      published: 0,
    };

    statusAgg.forEach((s) => {
      stats.total += s.count;
      if (s._id === 'self_review_pending') stats.selfReviewPending += s.count;
      if (s._id === 'manager_review_pending') stats.managerReviewPending += s.count;
      if (s._id === 'peer_feedback_pending') stats.peerPending += s.count;
      if (s._id === 'calibration_pending') stats.calibrationPending += s.count;
      if (s._id === 'under_approval') stats.underApproval += s.count;
      if (s._id === 'published' || s._id === 'acknowledged') stats.published += s.count;
    });

    stats.completionPercentage = stats.total > 0 ? Math.round((stats.published / stats.total) * 100) : 0;

    return res.status(200).json({ success: true, data: { ...cycle, progress: stats } });
  } catch (err) {
    console.error('[PMS getCycle Error]:', err);
    return res.status(500).json({ success: false, message: 'Failed to fetch cycle details' });
  }
};

/**
 * @desc Create new appraisal cycle & generate participant appraisals
 * @route POST /api/performance/cycles
 */
const createCycle = async (req, res) => {
  try {
    const {
      name,
      code,
      description,
      cycleType,
      startDate,
      endDate,
      timeline,
      applicableDepartments,
      applicableDesignations,
      applicableEmployees,
      excludedEmployees,
      settings,
    } = req.body;

    if (!name || !startDate || !endDate) {
      return res.status(400).json({ success: false, message: 'Name, start date, and end date are required' });
    }

    if (new Date(startDate) > new Date(endDate)) {
      return res.status(400).json({ success: false, message: 'Start date cannot be after end date' });
    }

    let normalizedCycleType = 'annual';
    if (cycleType) {
      const lower = String(cycleType).toLowerCase().replace(/-/g, '_').replace(/\s+/g, '_');
      if (['annual', 'half_yearly', 'quarterly', 'monthly', 'probationary', 'custom'].includes(lower)) {
        normalizedCycleType = lower;
      }
    }

    const cycle = await PmsCycle.create({
      companyId: req.companyId,
      name: name.trim(),
      code: code || `CYC-${Date.now().toString().slice(-4)}`,
      description: description || '',
      cycleType: normalizedCycleType,
      status: req.body.status || 'in_progress',
      startDate: new Date(startDate),
      endDate: new Date(endDate),
      timeline: timeline || {},
      applicableDepartments: applicableDepartments || [],
      applicableDesignations: applicableDesignations || [],
      applicableEmployees: applicableEmployees || [],
      excludedEmployees: excludedEmployees || [],
      settings: settings || {},
      createdBy: req.user._id,
    });

    // Auto-generate participant appraisals for eligible active employees
    try {
      const query = {
        companyId: req.companyId,
        isActive: true,
        isDeleted: { $ne: true },
        status: { $nin: ['deleted', 'inactive', 'terminated', 'Inactive', 'Terminated'] },
      };
      if (cycle.applicableEmployees && cycle.applicableEmployees.length > 0) {
        query._id = { $in: cycle.applicableEmployees };
      } else if (cycle.applicableDepartments && cycle.applicableDepartments.length > 0) {
        query.department = { $in: cycle.applicableDepartments };
      }
      if (cycle.excludedEmployees && cycle.excludedEmployees.length > 0) {
        query._id = { ...(query._id || {}), $nin: cycle.excludedEmployees };
      }

      const eligibleEmployees = await User.find(query).select('_id reportingManagers').lean();
      for (const emp of eligibleEmployees) {
        const primaryManager = (emp.reportingManagers && emp.reportingManagers[0]) || req.user._id;
        await PmsAppraisal.findOneAndUpdate(
          { companyId: req.companyId, cycleId: cycle._id, employeeId: emp._id },
          {
            $setOnInsert: {
              companyId: req.companyId,
              cycleId: cycle._id,
              employeeId: emp._id,
              managerId: primaryManager,
              status: 'manager_review_pending',
            },
          },
          { upsert: true, new: true }
        );
      }
    } catch (enrollErr) {
      console.warn('[PMS createCycle participant enroll warning]:', enrollErr);
    }

    await logPmsAudit({
      companyId: req.companyId,
      userId: req.user._id,
      action: 'CYCLE_CREATED',
      entityType: 'PmsCycle',
      entityId: cycle._id,
      entityName: cycle.name,
      changes: req.body,
    });

    return res.status(201).json({ success: true, message: 'Performance cycle created successfully', data: cycle });
  } catch (err) {
    console.error('[PMS createCycle Error]:', err);
    return res.status(500).json({
      success: false,
      message: err.message || 'Failed to create performance cycle',
    });
  }
};

/**
 * @desc Update cycle settings or dates
 * @route PUT /api/performance/cycles/:id
 */
const updateCycle = async (req, res) => {
  try {
    const { id } = req.params;
    const cycle = await PmsCycle.findOne({ _id: id, companyId: req.companyId });
    if (!cycle) {
      return res.status(404).json({ success: false, message: 'Performance cycle not found' });
    }

    if (cycle.status === 'closed') {
      return res.status(400).json({ success: false, message: 'Cannot edit a closed performance cycle' });
    }

    const updatableFields = [
      'name',
      'code',
      'description',
      'cycleType',
      'status',
      'startDate',
      'endDate',
      'timeline',
      'applicableDepartments',
      'applicableDesignations',
      'applicableEmployees',
      'excludedEmployees',
      'settings',
    ];

    updatableFields.forEach((field) => {
      if (req.body[field] !== undefined) cycle[field] = req.body[field];
    });

    cycle.updatedBy = req.user._id;
    await cycle.save();

    await logPmsAudit({
      companyId: req.companyId,
      userId: req.user._id,
      action: 'CYCLE_UPDATED',
      entityType: 'PmsCycle',
      entityId: cycle._id,
      entityName: cycle.name,
      changes: req.body,
    });

    return res.status(200).json({ success: true, message: 'Cycle updated successfully', data: cycle });
  } catch (err) {
    console.error('[PMS updateCycle Error]:', err);
    return res.status(500).json({ success: false, message: 'Failed to update cycle' });
  }
};

/**
 * @desc Delete performance cycle
 * @route DELETE /api/performance/cycles/:id
 */
const deleteCycle = async (req, res) => {
  try {
    const { id } = req.params;
    const cycle = await PmsCycle.findOneAndDelete({ _id: id, companyId: req.companyId });
    if (!cycle) {
      return res.status(404).json({ success: false, message: 'Performance cycle not found' });
    }

    // Clean up associated cycle appraisals
    await PmsAppraisal.deleteMany({ cycleId: id, companyId: req.companyId });

    await logPmsAudit({
      companyId: req.companyId,
      userId: req.user._id,
      action: 'CYCLE_DELETED',
      entityType: 'PmsCycle',
      entityId: cycle._id,
      entityName: cycle.name,
    });

    return res.status(200).json({ success: true, message: 'Performance cycle deleted successfully' });
  } catch (err) {
    console.error('[PMS deleteCycle Error]:', err);
    return res.status(500).json({ success: false, message: 'Failed to delete performance cycle' });
  }
};

/**
 * @desc Advance or change cycle status with auto-generation of appraisals when launched
 * @route PATCH /api/performance/cycles/:id/status
 */
const changeCycleStatus = async (req, res) => {
  try {
    const { id } = req.params;
    const { status } = req.body;

    if (!LIFECYCLE_ORDER.includes(status)) {
      return res.status(400).json({ success: false, message: `Invalid cycle status: ${status}` });
    }

    const cycle = await PmsCycle.findOne({ _id: id, companyId: req.companyId });
    if (!cycle) {
      return res.status(404).json({ success: false, message: 'Performance cycle not found' });
    }

    const oldStatus = cycle.status;
    cycle.status = status;
    cycle.updatedBy = req.user._id;

    // Snapshot rating scales when cycle enters active evaluation
    if (['in_progress', 'self_review'].includes(status) && !cycle.snapshots?.weightsSnapshot) {
      cycle.snapshots = {
        weightsSnapshot: cycle.settings?.weightageModel,
        ratingScaleSnapshot: cycle.settings?.ratingScale,
      };
    }

    await cycle.save();

    // Auto-generate appraisals for applicable employees if transitioning into self_review or in_progress
    if (['in_progress', 'self_review', 'goal_setting'].includes(status)) {
      let query = {
        companyId: req.companyId,
        isActive: true,
        isDeleted: { $ne: true },
        status: { $nin: ['deleted', 'inactive', 'terminated', 'Inactive', 'Terminated'] },
      };
      if (cycle.applicableEmployees && cycle.applicableEmployees.length > 0) {
        query._id = { $in: cycle.applicableEmployees };
      } else if (cycle.applicableDepartments && cycle.applicableDepartments.length > 0) {
        query.department = { $in: cycle.applicableDepartments };
      }
      if (cycle.excludedEmployees && cycle.excludedEmployees.length > 0) {
        query._id = { ...(query._id || {}), $nin: cycle.excludedEmployees };
      }

      const eligibleEmployees = await User.find(query).select('_id reportingManagers').lean();

      for (const emp of eligibleEmployees) {
        const primaryManager = (emp.reportingManagers && emp.reportingManagers[0]) || req.user._id;
        await PmsAppraisal.findOneAndUpdate(
          { companyId: req.companyId, cycleId: cycle._id, employeeId: emp._id },
          {
            $setOnInsert: {
              companyId: req.companyId,
              cycleId: cycle._id,
              employeeId: emp._id,
              managerId: primaryManager,
              status: 'self_review_pending',
            },
          },
          { upsert: true, new: true }
        );

        // Notify participant
        sendPmsNotification(req, {
          userId: emp._id,
          title: `Performance Cycle Launched: ${cycle.name}`,
          message: `The evaluation cycle is now in ${status.replace('_', ' ')} phase. Please complete your tasks.`,
          link: '/performance',
          preferenceKey: 'pms_cycle_launch',
        });
      }
    }

    await logPmsAudit({
      companyId: req.companyId,
      userId: req.user._id,
      action: 'CYCLE_STATUS_CHANGED',
      entityType: 'PmsCycle',
      entityId: cycle._id,
      entityName: cycle.name,
      changes: { from: oldStatus, to: status },
    });

    return res.status(200).json({ success: true, message: `Cycle transitioned to ${status}`, data: cycle });
  } catch (err) {
    console.error('[PMS changeCycleStatus Error]:', err);
    return res.status(500).json({ success: false, message: 'Failed to update cycle status' });
  }
};

/**
 * @desc Controlled reopening of a cycle with mandatory reason
 * @route POST /api/performance/cycles/:id/reopen
 */
const reopenCycle = async (req, res) => {
  try {
    const { id } = req.params;
    const { reason, targetStatus } = req.body;

    if (!reason || reason.trim().length < 5) {
      return res.status(400).json({ success: false, message: 'A valid reason (minimum 5 characters) is required to reopen a cycle' });
    }

    const cycle = await PmsCycle.findOne({ _id: id, companyId: req.companyId });
    if (!cycle) {
      return res.status(404).json({ success: false, message: 'Performance cycle not found' });
    }

    const newStatus = targetStatus && LIFECYCLE_ORDER.includes(targetStatus) ? targetStatus : 'manager_review';
    cycle.reopenHistory.push({
      reopenedBy: req.user._id,
      reopenedAt: new Date(),
      reason: reason.trim(),
    });
    cycle.status = newStatus;
    cycle.updatedBy = req.user._id;
    await cycle.save();

    await logPmsAudit({
      companyId: req.companyId,
      userId: req.user._id,
      action: 'CYCLE_REOPENED',
      entityType: 'PmsCycle',
      entityId: cycle._id,
      entityName: cycle.name,
      reason: reason.trim(),
      changes: { status: newStatus },
    });

    return res.status(200).json({ success: true, message: 'Cycle reopened successfully', data: cycle });
  } catch (err) {
    console.error('[PMS reopenCycle Error]:', err);
    return res.status(500).json({ success: false, message: 'Failed to reopen cycle' });
  }
};

/**
 * @desc Sync participants for an active cycle (enroll new joiners & update manager changes)
 * @route POST /api/performance/cycles/:id/sync-participants
 */
const syncCycleParticipants = async (req, res) => {
  try {
    const { id } = req.params;
    const cycle = await PmsCycle.findOne({ _id: id, companyId: req.companyId });
    if (!cycle) {
      return res.status(404).json({ success: false, message: 'Performance cycle not found' });
    }

    if (cycle.status === 'closed') {
      return res.status(400).json({ success: false, message: 'Cannot sync participants on a closed cycle' });
    }

    let query = {
      companyId: req.companyId,
      isActive: true,
      isDeleted: { $ne: true },
      status: { $nin: ['deleted', 'inactive', 'terminated', 'Inactive', 'Terminated'] },
    };
    if (cycle.applicableEmployees && cycle.applicableEmployees.length > 0) {
      query._id = { $in: cycle.applicableEmployees };
    } else if (cycle.applicableDepartments && cycle.applicableDepartments.length > 0) {
      query.department = { $in: cycle.applicableDepartments };
    }
    if (cycle.excludedEmployees && cycle.excludedEmployees.length > 0) {
      query._id = { ...(query._id || {}), $nin: cycle.excludedEmployees };
    }

    const eligibleEmployees = await User.find(query).select('_id reportingManagers').lean();
    const existingAppraisals = await PmsAppraisal.find({ cycleId: cycle._id, companyId: req.companyId }).select('employeeId managerId status').lean();

    const existingMap = new Map(existingAppraisals.map((a) => [String(a.employeeId), a]));

    let addedCount = 0;
    let managerUpdatedCount = 0;

    for (const emp of eligibleEmployees) {
      const empIdStr = String(emp._id);
      const primaryManager = (emp.reportingManagers && emp.reportingManagers[0]) || req.user._id;

      if (!existingMap.has(empIdStr)) {
        // Enrolling new joiner or newly transferred employee
        await PmsAppraisal.create({
          companyId: req.companyId,
          cycleId: cycle._id,
          employeeId: emp._id,
          managerId: primaryManager,
          currentStageKey: 'self_review',
          status: 'self_review_pending',
        });
        addedCount++;

        sendPmsNotification(req, {
          userId: emp._id,
          title: `Enrolled in Performance Cycle: ${cycle.name}`,
          message: `You have been added to the active evaluation cycle. Please complete your tasks.`,
          link: '/performance',
          preferenceKey: 'pms_cycle_launch',
        });
      } else {
        // Check if manager changed in HRMS for an appraisal that is still in review
        const app = existingMap.get(empIdStr);
        if (app.status === 'self_review_pending' || app.status === 'manager_review_pending') {
          if (String(app.managerId) !== String(primaryManager)) {
            await PmsAppraisal.updateOne(
              { _id: app._id },
              { $set: { managerId: primaryManager } }
            );
            managerUpdatedCount++;
          }
        }
      }
    }

    await logPmsAudit({
      companyId: req.companyId,
      userId: req.user._id,
      action: 'CYCLE_PARTICIPANTS_SYNCED',
      entityType: 'PmsCycle',
      entityId: cycle._id,
      entityName: cycle.name,
      changes: { addedCount, managerUpdatedCount, totalEligible: eligibleEmployees.length },
    });

    return res.status(200).json({
      success: true,
      message: `Sync complete: enrolled ${addedCount} new participant(s), updated ${managerUpdatedCount} manager assignment(s).`,
      data: {
        addedCount,
        managerUpdatedCount,
        totalEligible: eligibleEmployees.length,
      },
    });
  } catch (err) {
    console.error('[PMS syncCycleParticipants Error]:', err);
    return res.status(500).json({ success: false, message: 'Failed to sync cycle participants' });
  }
};

module.exports = {
  listCycles,
  getCycle,
  createCycle,
  updateCycle,
  deleteCycle,
  changeCycleStatus,
  reopenCycle,
  syncCycleParticipants,
};
