const mongoose = require('mongoose');
const PmsGoal = require('./models/pmsGoal.model');
const User = require('../user/user.model');
const { logPmsAudit } = require('./services/pmsAudit.service');
const { sendPmsNotification } = require('./services/pmsNotification.service');
const { isUserAdminOrSuper, isUserHr } = require('./services/pmsWorkflow.service');

/**
 * @desc List goals with filters & pagination
 * @route GET /api/performance/goals
 */
const listGoals = async (req, res) => {
  try {
    const companyId = req.companyId;
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 20));
    const skip = (page - 1) * limit;

    const filter = { companyId };
    if (req.query.cycleId) filter.cycleId = req.query.cycleId;
    const isHrOrAdmin = isUserAdminOrSuper(req.user) || isUserHr(req.user);
    if (req.query.scope === 'company' || req.query.scope === 'company_goals') {
      filter.scope = { $in: ['company', 'strategic'] };
    } else if (req.query.scope === 'my_team' || req.query.scope === 'team' || req.query.scope === 'team_goals') {
      if (!isHrOrAdmin) {
        const directReports = await User.find({
          reportingManagers: req.user._id,
          companyId,
          isActive: true,
          isDeleted: { $ne: true },
          status: { $nin: ['deleted', 'inactive', 'terminated', 'Inactive', 'Terminated'] },
        }).select('_id').lean();
        const reportIds = directReports.map((d) => d._id);
        filter.$or = [
          { employeeId: { $in: reportIds } },
          { scope: 'team' },
        ];
      } else {
        filter.scope = 'team';
      }
    } else if (req.query.scope === 'self' || req.query.scope === 'my_goals' || req.query.scope === 'individual') {
      filter.employeeId = req.user._id;
      filter.scope = { $nin: ['team', 'company', 'strategic'] };
    } else if (!isHrOrAdmin) {
      if (!req.query.scope || req.query.employeeId === String(req.user._id)) {
        filter.employeeId = req.user._id;
      } else {
        const directReports = await User.find({
          reportingManagers: req.user._id,
          companyId,
          isActive: true,
          isDeleted: { $ne: true },
          status: { $nin: ['deleted', 'inactive', 'terminated', 'Inactive', 'Terminated'] },
        }).select('_id').lean();
        const isReport = directReports.some((d) => String(d._id) === String(req.query.employeeId));
        filter.employeeId = isReport ? req.query.employeeId : req.user._id;
      }
    } else if (req.query.employeeId) {
      filter.employeeId = req.query.employeeId;
    } else if (req.query.scope) {
      filter.scope = req.query.scope;
    }
    if (req.query.status) filter.status = req.query.status;
    if (req.query.parentGoalId) filter.parentGoalId = req.query.parentGoalId;
    if (req.query.search) {
      filter.title = { $regex: req.query.search.trim(), $options: 'i' };
    }

    const [rawGoals, total] = await Promise.all([
      PmsGoal.find(filter)
        .populate({
          path: 'employeeId',
          match: {
            isActive: true,
            isDeleted: { $ne: true },
            status: { $nin: ['deleted', 'inactive', 'terminated', 'Inactive', 'Terminated'] },
          },
          select: 'firstName lastName email profilePicture department',
        })
        .populate('parentGoalId', 'title scope')
        .populate('linkedKraId', 'name category')
        .populate('linkedKpiId', 'name targetValue actualValue')
        .sort({ priority: -1, createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      PmsGoal.countDocuments(filter),
    ]);

    // Exclude individual goals whose owners are inactive/deleted
    const goals = rawGoals.filter((g) => g.scope !== 'individual' || g.employeeId != null);

    return res.status(200).json({
      success: true,
      data: goals,
      pagination: {
        page,
        limit,
        total: goals.length,
        total,
        pages: Math.ceil(total / limit),
      },
    });
  } catch (err) {
    console.error('[PMS listGoals Error]:', err);
    return res.status(500).json({ success: false, message: 'Failed to fetch goals' });
  }
};

/**
 * @desc Get hierarchical goal alignment tree for a cycle
 * @route GET /api/performance/goals/tree
 */
const getGoalTree = async (req, res) => {
  try {
    const { cycleId } = req.query;
    const filter = { companyId: req.companyId };
    if (cycleId) filter.cycleId = cycleId;

    const rawGoals = await PmsGoal.find(filter)
      .populate({
        path: 'employeeId',
        match: {
          isActive: true,
          isDeleted: { $ne: true },
          status: { $nin: ['deleted', 'inactive', 'terminated', 'Inactive', 'Terminated'] },
        },
        select: 'firstName lastName profilePicture department',
      })
      .populate('linkedKraId', 'name')
      .lean();

    const allGoals = rawGoals.filter((g) => g.scope !== 'individual' || g.employeeId != null);

    // Map parent-child hierarchy
    const goalMap = new Map();
    const roots = [];

    allGoals.forEach((g) => {
      goalMap.set(String(g._id), { ...g, children: [] });
    });

    allGoals.forEach((g) => {
      const parentId = g.parentGoalId ? String(g.parentGoalId) : null;
      if (parentId && goalMap.has(parentId)) {
        goalMap.get(parentId).children.push(goalMap.get(String(g._id)));
      } else {
        roots.push(goalMap.get(String(g._id)));
      }
    });

    return res.status(200).json({ success: true, data: roots });
  } catch (err) {
    console.error('[PMS getGoalTree Error]:', err);
    return res.status(500).json({ success: false, message: 'Failed to build goal hierarchy' });
  }
};

/**
 * @desc Create new goal or OKR
 * @route POST /api/performance/goals
 */
const createGoal = async (req, res) => {
  try {
    const {
      cycleId,
      employeeId,
      title,
      description,
      scope,
      parentGoalId,
      linkedKraId,
      linkedKpiId,
      weightage,
      priority,
      startDate,
      dueDate,
      keyResults,
    } = req.body;

    if (!cycleId || !title) {
      return res.status(400).json({ success: false, message: 'Cycle and Title are required' });
    }

    const assignedEmployee = employeeId || req.user._id;

    const goal = await PmsGoal.create({
      companyId: req.companyId,
      cycleId,
      employeeId: assignedEmployee,
      title: title.trim(),
      description,
      scope: scope || 'individual',
      parentGoalId: parentGoalId || null,
      linkedKraId: linkedKraId || null,
      linkedKpiId: linkedKpiId || null,
      weightage: Number(weightage) || 20,
      priority: priority || 'medium',
      startDate: startDate || new Date(),
      dueDate,
      keyResults: keyResults || [],
      status: 'pending_approval',
      createdBy: req.user._id,
    });

    await logPmsAudit({
      companyId: req.companyId,
      userId: req.user._id,
      action: 'GOAL_CREATED',
      entityType: 'PmsGoal',
      entityId: goal._id,
      entityName: goal.title,
      changes: req.body,
    });

    return res.status(201).json({ success: true, message: 'Goal created and sent for approval', data: goal });
  } catch (err) {
    console.error('[PMS createGoal Error]:', err);
    return res.status(500).json({ success: false, message: 'Failed to create goal' });
  }
};

/**
 * @desc Update goal details
 * @route PUT /api/performance/goals/:id
 */
const updateGoal = async (req, res) => {
  try {
    const { id } = req.params;
    const goal = await PmsGoal.findOne({ _id: id, companyId: req.companyId });
    if (!goal) {
      return res.status(404).json({ success: false, message: 'Goal not found' });
    }

    const fields = [
      'title',
      'description',
      'scope',
      'parentGoalId',
      'linkedKraId',
      'linkedKpiId',
      'weightage',
      'priority',
      'startDate',
      'dueDate',
      'keyResults',
      'status',
    ];

    fields.forEach((f) => {
      if (req.body[f] !== undefined) goal[f] = req.body[f];
    });

    // Auto-calculate progress if key results are present
    if (goal.keyResults && goal.keyResults.length > 0) {
      let sumPct = 0;
      goal.keyResults.forEach((kr) => {
        const target = kr.target || 1;
        const curr = kr.current || 0;
        const pct = Math.min(100, Math.max(0, (curr / target) * 100));
        sumPct += pct;
      });
      goal.progress = Math.round(sumPct / goal.keyResults.length);
    }

    goal.updatedBy = req.user._id;
    await goal.save();

    return res.status(200).json({ success: true, message: 'Goal updated successfully', data: goal });
  } catch (err) {
    console.error('[PMS updateGoal Error]:', err);
    return res.status(500).json({ success: false, message: 'Failed to update goal' });
  }
};

/**
 * @desc Record a check-in on goal progress
 * @route POST /api/performance/goals/:id/check-in
 */
const checkInGoal = async (req, res) => {
  try {
    const { id } = req.params;
    const { progress, notes, blockers, keyResultsUpdates } = req.body;

    const goal = await PmsGoal.findOne({ _id: id, companyId: req.companyId });
    if (!goal) {
      return res.status(404).json({ success: false, message: 'Goal not found' });
    }

    // Update key results if provided
    if (Array.isArray(keyResultsUpdates)) {
      keyResultsUpdates.forEach((upd, idx) => {
        if (goal.keyResults[idx]) {
          if (upd.current !== undefined) goal.keyResults[idx].current = Number(upd.current);
          if (upd.completed !== undefined) goal.keyResults[idx].completed = Boolean(upd.completed);
        }
      });
    }

    let calculatedProgress = Number(progress);
    if (isNaN(calculatedProgress) && goal.keyResults && goal.keyResults.length > 0) {
      const sum = goal.keyResults.reduce((acc, kr) => acc + (kr.current / (kr.target || 1)) * 100, 0);
      calculatedProgress = Math.round(sum / goal.keyResults.length);
    }

    goal.progress = Math.max(0, Math.min(100, calculatedProgress || goal.progress));
    if (goal.progress >= 100) goal.status = 'achieved';
    else if (goal.progress > 0 && goal.status === 'pending_approval') goal.status = 'in_progress';

    goal.checkIns.push({
      progress: goal.progress,
      notes: notes || '',
      blockers: blockers || '',
      updatedBy: req.user._id,
      createdAt: new Date(),
    });

    goal.updatedBy = req.user._id;
    await goal.save();

    return res.status(200).json({ success: true, message: 'Goal check-in recorded', data: goal });
  } catch (err) {
    console.error('[PMS checkInGoal Error]:', err);
    return res.status(500).json({ success: false, message: 'Failed to record check-in' });
  }
};

/**
 * @desc Manager approves or rejects goal
 * @route POST /api/performance/goals/:id/approve
 */
const approveOrRejectGoal = async (req, res) => {
  try {
    const { id } = req.params;
    const { action, comment } = req.body; // 'approve' or 'reject'

    const goal = await PmsGoal.findOne({ _id: id, companyId: req.companyId });
    if (!goal) {
      return res.status(404).json({ success: false, message: 'Goal not found' });
    }

    // Separation of duties: cannot approve own goal
    if (String(goal.employeeId) === String(req.user._id)) {
      return res.status(403).json({ success: false, message: 'Separation of duties: You cannot approve your own goal.' });
    }

    const isApprove = action === 'approve';
    goal.approvalStatus = {
      status: isApprove ? 'approved' : 'rejected',
      reviewedBy: req.user._id,
      reviewedAt: new Date(),
      reviewComment: comment || '',
    };
    goal.status = isApprove ? 'approved' : 'draft';
    await goal.save();

    // Notify goal owner
    sendPmsNotification(req, {
      userId: goal.employeeId,
      title: `Goal ${isApprove ? 'Approved' : 'Rejected'}: ${goal.title}`,
      message: comment || `Your goal has been marked as ${goal.approvalStatus.status}`,
      link: '/performance',
      preferenceKey: 'pms_goal_approval',
    });

    return res.status(200).json({ success: true, message: `Goal ${action}d successfully`, data: goal });
  } catch (err) {
    console.error('[PMS approveOrRejectGoal Error]:', err);
    return res.status(500).json({ success: false, message: 'Failed to review goal' });
  }
};

module.exports = {
  listGoals,
  getGoalTree,
  createGoal,
  updateGoal,
  checkInGoal,
  approveOrRejectGoal,
};
