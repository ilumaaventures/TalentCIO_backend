const mongoose = require('mongoose');
const User = require('../user/user.model');
const PmsCycle = require('./models/pmsCycle.model');
const PmsAppraisal = require('./models/pmsAppraisal.model');
const PmsKra = require('./models/pmsKra.model');
const PmsKpi = require('./models/pmsKpi.model');
const PmsSetting = require('./models/pmsSetting.model');
const PmsContinuousFeedback = require('./models/pmsContinuousFeedback.model');
const { logPmsAudit } = require('./services/pmsAudit.service');
const { isUserAdminOrSuper, isUserHr } = require('./services/pmsWorkflow.service');

/**
 * Ensures a company has an active appraisal cycle, default KRAs, and participant appraisals
 */
const ensureDefaultCycleAndParticipants = async (companyId, adminUserId) => {
  if (!companyId) return null;

  // 1. Ensure Active Performance Cycle
  let activeCycle = await PmsCycle.findOne({
    companyId,
    status: { $in: ['in_progress', 'scheduled', 'draft'] },
  }).sort({ createdAt: -1 });

  if (!activeCycle) {
    const currentYear = new Date().getFullYear();
    activeCycle = await PmsCycle.create({
      companyId,
      name: `Performance Appraisal Cycle ${currentYear}`,
      cycleType: 'annual',
      startDate: new Date(currentYear, 0, 1),
      endDate: new Date(currentYear, 11, 31),
      status: 'in_progress',
      description: 'Continuous company evaluation cycle for direct team reviews, HR calibration, and leadership approvals.',
      isContinuous: true,
      createdBy: adminUserId || null,
    });
  }

  // 2. Ensure Foundational KRAs exist so KRAs tab is never empty
  // 2. Ensure Foundational KRAs exist so KRAs tab is never empty
  try {
    const kraCount = await PmsKra.countDocuments({ companyId });
    if (kraCount === 0) {
      const defaultKras = [
        {
          name: 'Work Quality & Project Delivery',
          description: 'Delivering assigned tasks, tickets, and deliverables on schedule with high standards of execution.',
          weightage: 30,
          category: 'Productivity & Delivery',
          isTemplate: true,
        },
        {
          name: 'Technical Competence & Innovation',
          description: 'Demonstrating domain expertise, proposing process improvements, and solving complex problems.',
          weightage: 25,
          category: 'Quality of Work',
          isTemplate: true,
        },
        {
          name: 'Collaboration & Communication',
          description: 'Effective cross-functional communication, teamwork, reliability, and positive peer engagement.',
          weightage: 25,
          category: 'Team Collaboration',
          isTemplate: true,
        },
        {
          name: 'Initiative & Accountability',
          description: 'Ownership of responsibilities, meeting deadlines, adherence to company values, and professional growth.',
          weightage: 20,
          category: 'Operational Efficiency',
          isTemplate: true,
        },
      ];

      for (const item of defaultKras) {
        await PmsKra.create({
          companyId,
          cycleId: activeCycle._id,
          ...item,
          createdBy: adminUserId || null,
        });
      }
    }
  } catch (kraErr) {
    console.error('[PMS Default KRA Seeding Notice]:', kraErr.message);
  }

  // 3. Ensure every active employee has an appraisal record in the active cycle
  const activeUsers = await User.find({
    companyId,
    isActive: true,
    isDeleted: { $ne: true },
    status: { $nin: ['deleted', 'inactive', 'terminated', 'Inactive', 'Terminated'] },
  }).select('_id reportingManagers').lean();

  const existingAppraisals = await PmsAppraisal.find({
    companyId,
    cycleId: activeCycle._id,
  }).select('employeeId').lean();

  const existingEmployeeIds = new Set(existingAppraisals.map((a) => String(a.employeeId)));

  const missingUsers = activeUsers.filter((u) => !existingEmployeeIds.has(String(u._id)));

  if (missingUsers.length > 0) {
    // Find a fallback manager (admin or first user)
    const fallbackManager = activeUsers[0]?._id;

    const appraisalsToInsert = missingUsers.map((u) => {
      const assignedManager = u.reportingManagers?.[0] || fallbackManager || u._id;
      return {
        companyId,
        cycleId: activeCycle._id,
        employeeId: u._id,
        managerId: assignedManager,
        status: 'manager_review_pending',
        currentStageKey: 'manager_review',
        scores: { calculatedFinalScore: 0, ratingBand: 'Pending Review' },
      };
    });

    try {
      await PmsAppraisal.insertMany(appraisalsToInsert, { ordered: false });
    } catch (e) {
      // Ignore duplicates if concurrent
    }
  }

  return activeCycle;
};

/**
 * @desc Get simple evaluation list based on user role and permissions
 * @route GET /api/performance/evaluations
 */
const getEvaluations = async (req, res) => {
  try {
    const companyId = req.companyId || req.user?.companyId;
    const userId = req.user._id;
    const userRoles = Array.isArray(req.user?.roles) ? req.user.roles : [];
    const roleNames = userRoles.map((r) => (typeof r === 'string' ? r : r?.name || '')).filter(Boolean);

    const isAdmin = isUserAdminOrSuper(req.user) || req.user?.permissions?.includes('pms.can.edit.all');
    const isHr = isUserHr(req.user) || req.user?.permissions?.includes('pms.view.all');
    const hasTeamPerm = req.user?.permissions?.includes('pms.manage.team') || roleNames.some((r) => /manager/i.test(r));

    // Ensure cycle and participants are populated
    const cycle = await ensureDefaultCycleAndParticipants(companyId, userId);
    if (!cycle) {
      return res.status(200).json({ success: true, data: [], meta: { isAdmin, isHr, hasTeamPerm } });
    }

    const { scope = 'default', search = '', department = '', status = '' } = req.query;

    // Build user filter - strictly active non-deleted users
    let userMatch = {
      companyId,
      isActive: true,
      isDeleted: { $ne: true },
      status: { $nin: ['deleted', 'inactive', 'terminated', 'Inactive', 'Terminated'] },
    };

    // Find who reports to this user (strictly active direct reports)
    const directReports = await User.find({
      companyId,
      $or: [
        { reportingManagers: userId },
        { reportingManagers: new mongoose.Types.ObjectId(userId) },
      ],
      isActive: true,
      isDeleted: { $ne: true },
      status: { $nin: ['deleted', 'inactive', 'terminated', 'Inactive', 'Terminated'] },
    }).select('_id').lean();

    const directReportIds = directReports.map((d) => String(d._id));
    const isReportingManager = directReportIds.length > 0 || hasTeamPerm;

    // Scope resolution:
    // If scope === 'team': filter to direct reports
    // If scope === 'self': only current user
    // If scope === 'managers': all users who are managers (reporting managers evaluated by HR/Admin)
    // If scope === 'all': all company employees (admin/HR)
    if (scope === 'self' || (!isAdmin && !isHr && !isReportingManager)) {
      userMatch._id = userId;
    } else if (scope === 'team' || (!isAdmin && !isHr && isReportingManager)) {
      userMatch._id = { $in: directReportIds };
    } else if (scope === 'managers') {
      // Find all users who are reporting managers to someone
      const allReportingManagers = await User.distinct('reportingManagers', {
        companyId,
        isActive: true,
        isDeleted: { $ne: true },
        status: { $nin: ['deleted', 'inactive', 'terminated', 'Inactive', 'Terminated'] },
      });
      userMatch._id = { $in: allReportingManagers.filter(Boolean) };
    } else if (scope === 'all') {
      if (!isAdmin && !isHr) {
        userMatch._id = { $in: directReportIds.length > 0 ? directReportIds : [userId] };
      }
    }

    if (search.trim()) {
      const searchRegex = new RegExp(search.trim(), 'i');
      userMatch.$or = [
        { firstName: searchRegex },
        { lastName: searchRegex },
        { email: searchRegex },
        { employeeId: searchRegex },
      ];
    }

    const users = await User.find(userMatch)
      .populate('departmentRef', 'name')
      .populate('designationRef', 'name')
      .populate('reportingManagers', 'firstName lastName email profilePicture')
      .select('firstName lastName name email employeeId profilePicture department departmentRef designation designationRef reportingManagers roles')
      .lean();

    const userIds = users.map((u) => u._id);

    // Fetch appraisals for these users in active cycle
    const appraisals = await PmsAppraisal.find({
      companyId,
      cycleId: cycle._id,
      employeeId: { $in: userIds },
    })
      .populate('managerAppraisal.kraRatings.kraId', 'name weightage')
      .populate('hrEvaluation.evaluatedBy', 'firstName lastName')
      .populate('finalApproval.approvedBy', 'firstName lastName')
      .lean();

    const appraisalMap = new Map(appraisals.map((a) => [String(a.employeeId), a]));

    // Fetch kudos counts
    const kudosCounts = await PmsContinuousFeedback.aggregate([
      { $match: { companyId, toUser: { $in: userIds } } },
      { $group: { _id: '$toUser', count: { $sum: 1 } } },
    ]);
    const kudosMap = new Map(kudosCounts.map((k) => [String(k._id), k.count]));

    // Fetch KRAs
    const kras = await PmsKra.find({ companyId }).select('name weightage category').lean();

    // Map into clean evaluation cards
    const evaluations = users.map((u) => {
      const appraisal = appraisalMap.get(String(u._id)) || {};
      const mgr = u.reportingManagers?.[0] || null;

      const isUserAManager = users.some((other) =>
        other.reportingManagers?.some((rm) => String(rm._id || rm) === String(u._id))
      );

      return {
        _id: appraisal._id || `temp-${u._id}`,
        employeeId: u._id,
        user: {
          _id: u._id,
          name: u.firstName && u.lastName ? `${u.firstName} ${u.lastName}` : (u.name || u.email),
          email: u.email,
          employeeCode: u.employeeId || 'EMP',
          department: u.departmentRef?.name || (typeof u.department === 'string' ? u.department : 'General'),
          designation: u.designationRef?.name || (typeof u.designation === 'string' ? u.designation : 'Employee'),
          profilePicture: u.profilePicture || null,
          isManager: isUserAManager,
        },
        reportingManager: mgr
          ? {
              _id: mgr._id,
              name: mgr.firstName && mgr.lastName ? `${mgr.firstName} ${mgr.lastName}` : mgr.email,
              email: mgr.email,
            }
          : null,
        currentStage: appraisal.currentStageKey || 'manager_review',
        status: appraisal.status || 'manager_review_pending',
        ratings: {
          managerRating: appraisal.managerAppraisal?.managerRating || null,
          managerComments: appraisal.managerAppraisal?.managerComments || appraisal.managerAppraisal?.overallComments || '',
          managerStrengths: appraisal.managerAppraisal?.strengths || '',
          managerImprovements: appraisal.managerAppraisal?.areasOfImprovement || '',
          managerSubmittedAt: appraisal.managerAppraisal?.submittedAt || null,
          hrRating: appraisal.hrEvaluation?.hrRating || null,
          hrComments: appraisal.hrEvaluation?.hrComments || '',
          hrSubmittedAt: appraisal.hrEvaluation?.evaluatedAt || null,
          hrEvaluator: appraisal.hrEvaluation?.evaluatedBy
            ? `${appraisal.hrEvaluation.evaluatedBy.firstName || ''} ${appraisal.hrEvaluation.evaluatedBy.lastName || ''}`.trim()
            : null,
          adminRating: appraisal.finalApproval?.finalRating || null,
          adminComments: appraisal.finalApproval?.comments || '',
          adminSubmittedAt: appraisal.finalApproval?.approvedAt || null,
          adminEvaluator: appraisal.finalApproval?.approvedBy
            ? `${appraisal.finalApproval.approvedBy.firstName || ''} ${appraisal.finalApproval.approvedBy.lastName || ''}`.trim()
            : null,
          finalScore: appraisal.scores?.calculatedFinalScore || appraisal.finalApproval?.finalRating || appraisal.managerAppraisal?.managerRating || 0,
          ratingBand: appraisal.scores?.ratingBand || (appraisal.managerAppraisal?.managerRating ? 'Evaluated' : 'Pending Review'),
        },
        kras: kras.map((k) => {
          const rated = (appraisal.managerAppraisal?.kraRatings || []).find(
            (r) => String(r.kraId?._id || r.kraId) === String(k._id)
          );
          return {
            _id: k._id,
            name: k.name,
            weightage: k.weightage,
            category: k.category,
            score: rated?.managerRating || null,
            comments: rated?.managerComments || '',
          };
        }),
        kudosCount: kudosMap.get(String(u._id)) || 0,
      };
    });

    return res.status(200).json({
      success: true,
      data: evaluations,
      meta: {
        cycle: {
          _id: cycle._id,
          name: cycle.name,
          status: cycle.status,
        },
        userContext: {
          isAdmin,
          isHr,
          isReportingManager,
          directReportsCount: directReportIds.length,
        },
      },
    });
  } catch (err) {
    console.error('[PMS getEvaluations Error]:', err);
    return res.status(500).json({ success: false, message: 'Failed to fetch team evaluations', error: err.message });
  }
};

/**
 * @desc Submit feedback & rating for any employee (Manager -> HR -> Admin)
 * @route POST /api/performance/evaluations/:targetUserId/submit-review
 */
const submitReview = async (req, res) => {
  try {
    const companyId = req.companyId || req.user?.companyId;
    const reviewerId = req.user._id;
    const { targetUserId } = req.params;
    const { rating, feedback, strengths, improvements, kraRatings = [], level = 'auto' } = req.body;

    if (!rating || Number(rating) < 1 || Number(rating) > 5) {
      return res.status(400).json({ success: false, message: 'Please provide a valid rating score between 1 and 5' });
    }

    const isAdmin = isUserAdminOrSuper(req.user) || req.user?.permissions?.includes('pms.can.edit.all');
    const isHr = isUserHr(req.user) || req.user?.permissions?.includes('pms.view.all');

    // Verify reporting manager relationship and employee active status
    const targetUser = await User.findOne({
      _id: targetUserId,
      isActive: true,
      isDeleted: { $ne: true },
      status: { $nin: ['deleted', 'inactive', 'terminated', 'Inactive', 'Terminated'] },
    }).select('reportingManagers firstName lastName email').lean();
    if (!targetUser) {
      return res.status(404).json({ success: false, message: 'Target active employee not found or is inactive' });
    }

    const isDirectManager = (targetUser.reportingManagers || []).some(
      (m) => String(m) === String(reviewerId)
    );

    // Authorization check
    if (!isAdmin && !isHr && !isDirectManager) {
      return res.status(403).json({
        success: false,
        message: 'Unauthorized: You can only evaluate direct reports assigned to your team.',
      });
    }

    // Fetch company settings for approval levels
    const pmsSettings = await PmsSetting.findOne({ companyId }).lean();
    const workflowConfig = pmsSettings?.approvalWorkflow || {
      requireManagerReview: true,
      requireHrEvaluation: true,
      requireAdminApproval: true,
    };

    // Find active cycle
    const cycle = await ensureDefaultCycleAndParticipants(companyId, reviewerId);

    // Find or create appraisal record
    let appraisal = await PmsAppraisal.findOne({
      companyId,
      cycleId: cycle._id,
      employeeId: targetUserId,
    });

    if (!appraisal) {
      appraisal = new PmsAppraisal({
        companyId,
        cycleId: cycle._id,
        employeeId: targetUserId,
        managerId: isDirectManager ? reviewerId : (targetUser.reportingManagers?.[0] || reviewerId),
      });
    }

    const numericScore = parseFloat(Number(rating).toFixed(1));

    // Determine evaluation level
    let actualLevel = level;
    if (actualLevel === 'auto') {
      if (isAdmin) {
        // If reviewing a manager, or if HR already evaluated, admin gives final approval
        actualLevel = appraisal.hrEvaluation?.hrRating ? 'admin' : (isDirectManager ? 'manager' : 'admin');
      } else if (isHr) {
        actualLevel = isDirectManager ? 'manager' : 'hr';
      } else {
        actualLevel = 'manager';
      }
    }

    const ratingBandLabels = {
      5: 'Exceptional Performance',
      4: 'Exceeds Expectations',
      3: 'Meets Expectations',
      2: 'Needs Improvement',
      1: 'Unsatisfactory',
    };
    const bandLabel = ratingBandLabels[Math.round(numericScore)] || 'Meets Expectations';

    if (actualLevel === 'manager') {
      appraisal.managerAppraisal = {
        managerRating: numericScore,
        managerComments: feedback || '',
        overallComments: feedback || '',
        strengths: strengths || '',
        areasOfImprovement: improvements || '',
        kraRatings: kraRatings.map((k) => ({
          kraId: k.kraId,
          name: k.name,
          weightage: k.weightage || 25,
          managerRating: Number(k.score) || numericScore,
          managerComments: k.comments || '',
        })),
        submittedAt: new Date(),
        isDraft: false,
      };

      if (workflowConfig.requireHrEvaluation !== false) {
        appraisal.currentStageKey = 'hr_evaluation';
        appraisal.status = 'hr_evaluation_pending';
      } else if (workflowConfig.requireAdminApproval !== false) {
        appraisal.currentStageKey = 'final_approval';
        appraisal.status = 'final_approval_pending';
      } else {
        appraisal.currentStageKey = 'published';
        appraisal.status = 'published';
      }
    } else if (actualLevel === 'hr') {
      appraisal.hrEvaluation = {
        hrRating: numericScore,
        hrComments: feedback || '',
        evaluatedBy: reviewerId,
        evaluatedAt: new Date(),
      };

      if (workflowConfig.requireAdminApproval !== false) {
        appraisal.currentStageKey = 'final_approval';
        appraisal.status = 'final_approval_pending';
      } else {
        appraisal.currentStageKey = 'published';
        appraisal.status = 'published';
      }
    } else if (actualLevel === 'admin') {
      appraisal.finalApproval = {
        finalRating: numericScore,
        comments: feedback || '',
        approvedBy: reviewerId,
        approvedAt: new Date(),
      };
      appraisal.currentStageKey = 'published';
      appraisal.status = 'published';
    }

    appraisal.scores = {
      managerOverallScore: appraisal.managerAppraisal?.managerRating || numericScore,
      calculatedFinalScore: numericScore,
      ratingBand: bandLabel,
    };

    await appraisal.save();

    // Also record continuous feedback entry so it appears in Kudos/Feedback
    if (feedback) {
      await PmsContinuousFeedback.create({
        companyId,
        fromUser: reviewerId,
        toUser: targetUserId,
        feedbackType: 'appreciation',
        title: `Performance Review (${actualLevel.toUpperCase()})`,
        content: feedback,
        category: 'Delivery',
        visibility: 'manager_only',
      });
    }

    await logPmsAudit({
      companyId,
      userId: reviewerId,
      action: 'APPRAISAL_EVALUATION_SUBMITTED',
      entityId: appraisal._id,
      entityType: 'PmsAppraisal',
      changes: { level: actualLevel, rating: numericScore, feedback },
    });

    return res.status(200).json({
      success: true,
      message: `Evaluation submitted successfully at ${actualLevel.toUpperCase()} stage.`,
      data: appraisal,
    });
  } catch (err) {
    console.error('[PMS submitReview Error]:', err);
    return res.status(500).json({ success: false, message: 'Failed to submit evaluation', error: err.message });
  }
};

/**
 * @desc Get personal employee scorecard (ratings, feedback, KRAs, kudos)
 * @route GET /api/performance/evaluations/my-scorecard
 */
const getMyScorecard = async (req, res) => {
  try {
    const companyId = req.companyId || req.user?.companyId;
    const userId = req.user._id;

    const cycle = await ensureDefaultCycleAndParticipants(companyId, userId);

    const [appraisal, kudosList, kras] = await Promise.all([
      PmsAppraisal.findOne({ companyId, employeeId: userId, cycleId: cycle._id })
        .populate('managerId', 'firstName lastName email profilePicture')
        .populate('hrEvaluation.evaluatedBy', 'firstName lastName')
        .populate('finalApproval.approvedBy', 'firstName lastName')
        .lean(),
      PmsContinuousFeedback.find({ companyId, toUser: userId })
        .populate('fromUser', 'firstName lastName email profilePicture')
        .sort({ createdAt: -1 })
        .limit(10)
        .lean(),
      PmsKra.find({ companyId }).select('name weightage category description').lean(),
    ]);

    const mgr = req.user.reportingManagers?.[0];

    return res.status(200).json({
      success: true,
      data: {
        user: {
          _id: req.user._id,
          name: `${req.user.firstName || ''} ${req.user.lastName || ''}`.trim() || req.user.name,
          email: req.user.email,
          employeeId: req.user.employeeId,
          reportingManager: appraisal?.managerId || mgr || null,
        },
        ratings: {
          finalScore: appraisal?.scores?.calculatedFinalScore || 0,
          ratingBand: appraisal?.scores?.ratingBand || 'Pending Review',
          managerRating: appraisal?.managerAppraisal?.managerRating || null,
          managerComments: appraisal?.managerAppraisal?.managerComments || '',
          managerStrengths: appraisal?.managerAppraisal?.strengths || '',
          managerImprovements: appraisal?.managerAppraisal?.areasOfImprovement || '',
          hrRating: appraisal?.hrEvaluation?.hrRating || null,
          hrComments: appraisal?.hrEvaluation?.hrComments || '',
          adminRating: appraisal?.finalApproval?.finalRating || null,
          adminComments: appraisal?.finalApproval?.comments || '',
        },
        kras: kras.map((k) => {
          const rated = (appraisal?.managerAppraisal?.kraRatings || []).find(
            (r) => String(r.kraId?._id || r.kraId) === String(k._id)
          );
          return {
            ...k,
            score: rated?.managerRating || null,
            comments: rated?.managerComments || '',
          };
        }),
        kudos: kudosList,
        approvalStage: appraisal?.currentStageKey || 'manager_review',
        status: appraisal?.status || 'manager_review_pending',
      },
    });
  } catch (err) {
    console.error('[PMS getMyScorecard Error]:', err);
    return res.status(500).json({ success: false, message: 'Failed to fetch personal scorecard' });
  }
};

module.exports = {
  getEvaluations,
  submitReview,
  getMyScorecard,
  ensureDefaultCycleAndParticipants,
};
