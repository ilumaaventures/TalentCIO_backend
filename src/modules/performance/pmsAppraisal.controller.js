const mongoose = require('mongoose');
const PmsAppraisal = require('./models/pmsAppraisal.model');
const PmsCycle = require('./models/pmsCycle.model');
const PmsSetting = require('./models/pmsSetting.model');
const PmsKpi = require('./models/pmsKpi.model');
const PmsKra = require('./models/pmsKra.model');
const User = require('../user/user.model');
const Department = require('../organization/models/department.model');
const { computeConsolidatedAppraisalScore, calculateKpiAchievement } = require('./services/pmsScoring.service');
const { logPmsAudit } = require('./services/pmsAudit.service');
const { sendPmsNotification } = require('./services/pmsNotification.service');
const {
  getCompanyWorkflow,
  getNextWorkflowStage,
  isUserAdminOrSuper,
  isUserHr,
  isUserAuthorizedForStage,
  sanitizeAppraisalForUser,
} = require('./services/pmsWorkflow.service');

/**
 * Validates evidence URL protocol to prevent dangerous URI schemes
 */
const isValidEvidenceUrl = (url) => {
  if (!url || typeof url !== 'string') return true;
  const trimmed = url.trim();
  if (!trimmed) return true;
  if (/^(?:javascript|data|vbscript):/i.test(trimmed)) {
    return false;
  }
  return trimmed.startsWith('/') || /^https?:\/\//i.test(trimmed);
};

/**
 * @desc List appraisals with scope authorization, role filtering & pagination
 * @route GET /api/performance/appraisals
 */
const listAppraisals = async (req, res) => {
  try {
    const companyId = req.companyId;
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 10));
    const skip = (page - 1) * limit;

    const filter = { companyId };
    if (req.query.cycleId) filter.cycleId = req.query.cycleId;
    if (req.query.status) filter.status = req.query.status;
    if (req.query.stageKey) filter.currentStageKey = req.query.stageKey;

    const isAdmin = isUserAdminOrSuper(req.user);
    const isHr = isUserHr(req.user);
    const requestedScope = req.query.scope || (isHr ? 'all' : 'self');

    // ─── Scope Filtering (Server-Side Isolation) ──────────────────────────
    if (requestedScope === 'self' || (!isAdmin && !isHr && !req.query.scope)) {
      filter.employeeId = req.user._id;
    } else if (requestedScope === 'my_team') {
      const userObjId = mongoose.Types.ObjectId.isValid(req.user._id) ? new mongoose.Types.ObjectId(req.user._id) : req.user._id;
      // Find employees reporting to this user (strictly active)
      const directReports = await User.find({
        $or: [
          { reportingManagers: req.user._id },
          { reportingManagers: userObjId },
        ],
        companyId,
        isActive: true,
        isDeleted: { $ne: true },
        status: { $nin: ['deleted', 'inactive', 'terminated', 'Inactive', 'Terminated'] },
      }).select('_id').lean();
      const reportIds = directReports.map((d) => d._id);
      filter.$or = [
        { managerId: req.user._id },
        { managerId: userObjId },
        { employeeId: { $in: reportIds } },
        { 'delegation.isDelegated': true, 'delegation.delegatedTo': req.user._id },
        { 'delegation.isDelegated': true, 'delegation.delegatedTo': userObjId },
      ];
    } else if (requestedScope === 'department') {
      // Find employees in the department where the user is head (strictly active)
      const dept = await Department.findOne({ head: req.user._id, companyId }).select('_id').lean();
      if (dept) {
        const deptEmployees = await User.find({
          departmentRef: dept._id,
          companyId,
          isActive: true,
          isDeleted: { $ne: true },
          status: { $nin: ['deleted', 'inactive', 'terminated', 'Inactive', 'Terminated'] },
        }).select('_id').lean();
        filter.employeeId = { $in: deptEmployees.map((e) => e._id) };
      } else if (!isHr) {
        // Not a dept head, fall back to own records
        filter.employeeId = req.user._id;
      }
    } else if (requestedScope === 'hr_queue') {
      if (!isHr) {
        return res.status(403).json({ success: false, message: 'Unauthorized: HR queue requires HR permissions.' });
      }
      filter.currentStageKey = { $in: ['hr_evaluation', 'calibration_pending'] };
    } else if (requestedScope === 'final_approval_queue') {
      if (!req.user?.permissions?.includes('pms.approval.final') && !isAdmin) {
        return res.status(403).json({ success: false, message: 'Unauthorized: Final approval queue requires approval permissions.' });
      }
      filter.currentStageKey = 'final_approval';
    } else if (requestedScope === 'all') {
      if (!isHr && !isAdmin) {
        // Enforce employee isolation: ordinary user cannot access 'all' scope
        filter.employeeId = req.user._id;
      }
    }

    if (req.query.employeeId && (isHr || isAdmin)) {
      filter.employeeId = req.query.employeeId;
    }

    // Ensure all appraisal listings strictly match active, non-deleted employees
    const activeCompanyEmps = await User.find({
      companyId,
      isActive: true,
      isDeleted: { $ne: true },
      status: { $nin: ['deleted', 'inactive', 'terminated', 'Inactive', 'Terminated'] },
    }).select('_id').lean();
    const activeCompEmpIds = activeCompanyEmps.map((e) => e._id);

    if (filter.employeeId) {
      if (filter.employeeId.$in) {
        const allowedSet = new Set(activeCompEmpIds.map(String));
        filter.employeeId.$in = filter.employeeId.$in.filter((id) => allowedSet.has(String(id)));
      }
    } else {
      filter.employeeId = { $in: activeCompEmpIds };
    }

    const [appraisals, total] = await Promise.all([
      PmsAppraisal.find(filter)
        .populate('cycleId', 'name cycleType startDate endDate status settings')
        .populate({
          path: 'employeeId',
          match: {
            isActive: true,
            isDeleted: { $ne: true },
            status: { $nin: ['deleted', 'inactive', 'terminated', 'Inactive', 'Terminated'] },
          },
          select: 'firstName lastName email department departmentRef profilePicture employeeCode',
        })
        .populate('managerId', 'firstName lastName email profilePicture')
        .populate('departmentHeadEvaluation.evaluatedBy', 'firstName lastName')
        .populate('hrEvaluation.evaluatedBy', 'firstName lastName')
        .populate('finalApproval.approvedBy', 'firstName lastName')
        .sort({ updatedAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      PmsAppraisal.countDocuments(filter),
    ]);

    // Fetch company setting for anonymity minimum threshold
    const setting = await PmsSetting.findOne({ companyId }).lean();
    const minResponses = setting?.continuousFeedbackSettings?.minResponsesForDisclosure || 3;

    // Filter out appraisals belonging to inactive / deleted users
    const activeAppraisals = appraisals.filter((app) => app.employeeId != null);

    // Sanitize records (masking unpublished final ratings & anonymous reviewers)
    const sanitized = activeAppraisals.map((app) =>
      sanitizeAppraisalForUser({
        appraisal: app,
        user: req.user,
        minResponsesForDisclosure: minResponses,
      })
    );

    return res.status(200).json({
      success: true,
      data: sanitized,
      pagination: {
        page,
        limit,
        total: activeAppraisals.length,
        pages: Math.ceil(total / limit),
      },
    });
  } catch (err) {
    console.error('[PMS listAppraisals Error]:', err);
    return res.status(500).json({ success: false, message: 'Failed to fetch appraisals' });
  }
};

/**
 * @desc Get appraisal details by ID with object-level authorization & field-level confidentiality
 * @route GET /api/performance/appraisals/:id
 */
const getAppraisalDetails = async (req, res) => {
  try {
    const { id } = req.params;
    const companyId = req.companyId || req.user?.companyId;
    const appraisal = await PmsAppraisal.findOne({ _id: id, companyId })
      .populate('cycleId')
      .populate('employeeId', 'firstName lastName email department departmentRef profilePicture employeeCode workLocation joiningDate')
      .populate('managerId', 'firstName lastName email profilePicture')
      .populate('peerReviews.reviewerId', 'firstName lastName email profilePicture')
      .populate('departmentHeadEvaluation.evaluatedBy', 'firstName lastName email')
      .populate('hrEvaluation.evaluatedBy', 'firstName lastName email')
      .populate('finalApproval.approvedBy', 'firstName lastName email')
      .populate('workflowHistory.actedBy', 'firstName lastName')
      .lean();

    if (!appraisal) {
      return res.status(404).json({ success: false, message: 'Appraisal record not found' });
    }

    const employeeIdStr = String(appraisal.employeeId?._id || appraisal.employeeId);
    const userIdStr = String(req.user._id);

    const isOwner = employeeIdStr === userIdStr;
    const isDirectManager = String(appraisal.managerId?._id || appraisal.managerId) === userIdStr;
    const isPeerReviewer = (appraisal.peerReviews || []).some((p) => String(p.reviewerId?._id || p.reviewerId) === userIdStr);
    const isHr = isUserHr(req.user);
    const isAdmin = isUserAdminOrSuper(req.user);

    // Check reporting manager list if not direct manager
    let isReportingManager = isDirectManager;
    if (!isReportingManager) {
      const empUser = await User.findById(employeeIdStr).select('reportingManagers departmentRef').lean();
      isReportingManager = (empUser?.reportingManagers || []).some((m) => String(m) === userIdStr);
    }

    // Check if user is department head
    let isDeptHead = false;
    if (appraisal.employeeId?.departmentRef) {
      const dept = await Department.findById(appraisal.employeeId.departmentRef).select('head').lean();
      if (dept?.head && String(dept.head) === userIdStr) {
        isDeptHead = true;
      }
    }

    if (!isOwner && !isReportingManager && !isDeptHead && !isPeerReviewer && !isHr && !isAdmin) {
      return res.status(403).json({ success: false, message: 'Unauthorized: You do not have access to view this appraisal.' });
    }

    const setting = await PmsSetting.findOne({ companyId: req.companyId }).lean();
    const minResponses = setting?.continuousFeedbackSettings?.minResponsesForDisclosure || 3;

    const cycleId = appraisal.cycleId?._id || appraisal.cycleId;
    const employeeId = appraisal.employeeId?._id || appraisal.employeeId;

    // Fetch assigned KRAs & KPIs for this employee and cycle
    const assignedKpis = await PmsKpi.find({
      companyId: req.companyId,
      cycleId,
      employeeId,
      status: { $nin: ['deleted', 'inactive'] },
    })
      .populate('kraId', 'name code description category weightage')
      .sort({ createdAt: 1 })
      .lean();

    const kraMap = new Map();
    assignedKpis.forEach((k) => {
      if (k.kraId && typeof k.kraId === 'object') {
        kraMap.set(String(k.kraId._id), k.kraId);
      }
    });
    const assignedKras = Array.from(kraMap.values());

    // Mask confidential unpublished ratings & anonymous peer review identities
    const sanitized = sanitizeAppraisalForUser({
      appraisal,
      user: req.user,
      minResponsesForDisclosure: minResponses,
    });

    sanitized.assignedKpis = assignedKpis;
    sanitized.assignedKras = assignedKras;

    return res.status(200).json({ success: true, data: sanitized });
  } catch (err) {
    console.error('[PMS getAppraisalDetails Error]:', err);
    return res.status(500).json({ success: false, message: 'Failed to fetch appraisal details' });
  }
};

/**
 * @desc Save or submit employee self-appraisal
 * @route POST /api/performance/appraisals/:id/self
 */
const saveSelfAppraisal = async (req, res) => {
  try {
    const { id } = req.params;
    const {
      kraRatings,
      kpiRatings,
      goalRatings,
      competencyRatings,
      accomplishments,
      challenges,
      careerAspirations,
      isSubmit,
    } = req.body;

    const companyId = req.companyId || req.user?.companyId;
    const appraisal = await PmsAppraisal.findOne({ _id: id, companyId });
    if (!appraisal) {
      return res.status(404).json({ success: false, message: 'Appraisal not found' });
    }

    const isOwner = String(appraisal.employeeId) === String(req.user._id);
    if (!isOwner && !isUserAdminOrSuper(req.user)) {
      return res.status(403).json({ success: false, message: 'Only the assigned employee can complete self-appraisal.' });
    }

    if (isSubmit && appraisal.currentStageKey !== 'self_review' && appraisal.status !== 'revision_requested') {
      return res.status(400).json({
        success: false,
        message: `Self-appraisal is not currently in review stage (current: ${appraisal.currentStageKey}).`,
      });
    }

    // Fetch assigned KPIs for authoritative validation & snapshot preservation
    const assignedKpis = await PmsKpi.find({
      companyId,
      cycleId: appraisal.cycleId,
      employeeId: appraisal.employeeId,
      status: { $nin: ['deleted', 'inactive'] },
    }).lean();
    const kpiMap = new Map(assignedKpis.map((k) => [String(k._id), k]));

    const processedKpiRatings = [];
    if (Array.isArray(kpiRatings) && kpiRatings.length > 0) {
      for (const item of kpiRatings) {
        const kId = String(item.kpiId?._id || item.kpiId);
        const assignedKpi = kpiMap.get(kId);

        const targetValue = assignedKpi ? assignedKpi.targetValue : Number(item.targetValue || 0);
        const weightage = assignedKpi ? assignedKpi.weightage : Number(item.weightage || 0);
        const unit = assignedKpi ? (assignedKpi.unit || '%') : (item.unit || '%');
        const measurementType = assignedKpi ? (assignedKpi.measurementType || 'number') : (item.measurementType || 'number');
        const measurementDirection = assignedKpi ? (assignedKpi.measurementDirection || 'higher_is_better') : (item.measurementDirection || 'higher_is_better');
        const name = assignedKpi ? assignedKpi.name : (item.name || '');
        const code = assignedKpi ? assignedKpi.code : (item.code || '');
        const kraId = assignedKpi ? assignedKpi.kraId : (item.kraId || null);

        let actualValue = item.actualValue !== undefined && item.actualValue !== null && item.actualValue !== '' ? Number(item.actualValue) : null;
        let selfRating = item.selfRating !== undefined && item.selfRating !== null && item.selfRating !== '' ? Number(item.selfRating) : null;

        // Authoritative achievement calculation
        let achievementPercent = null;
        if (actualValue !== null && !isNaN(actualValue)) {
          const achCalc = calculateKpiAchievement({
            targetValue,
            actualValue,
            measurementType,
            measurementDirection,
          });
          achievementPercent = achCalc.isValid && achCalc.achievementPercent !== null ? achCalc.achievementPercent : null;
        }

        if (item.evidenceUrl && !isValidEvidenceUrl(item.evidenceUrl)) {
          return res.status(400).json({
            success: false,
            message: `Invalid evidence URL for KPI "${name}". Disallowed URI protocol (e.g. javascript:, data:).`,
          });
        }

        processedKpiRatings.push({
          kpiId: kId,
          kraId,
          name,
          code,
          targetValue,
          actualValue,
          weightage,
          unit,
          measurementType,
          measurementDirection,
          achievementPercent,
          selfRating,
          selfComments: item.selfComments || '',
          evidenceUrl: item.evidenceUrl || '',
          evidenceNote: item.evidenceNote || '',
        });

        // Sync actual value to PmsKpi record
        if (actualValue !== null && !isNaN(actualValue)) {
          await PmsKpi.updateOne(
            { _id: kId, companyId: req.companyId, employeeId: appraisal.employeeId },
            { $set: { actualValue, updatedBy: req.user._id } }
          );
        }
      }
    }

    // Required KPI validation on submission
    if (isSubmit && assignedKpis.length > 0) {
      const missingRatings = assignedKpis.filter((ak) => {
        const rated = processedKpiRatings.find((pk) => String(pk.kpiId) === String(ak._id));
        return !rated || rated.actualValue === null || rated.actualValue === undefined || !rated.selfRating || rated.selfRating < 1;
      });
      if (missingRatings.length > 0) {
        return res.status(400).json({
          success: false,
          message: `Please provide actual achievements and self-ratings (1-5) for all assigned KPIs before submitting. Pending items: ${missingRatings.map((m) => m.name).join(', ')}`,
        });
      }
    }

    if (!appraisal.selfAppraisal) {
      appraisal.selfAppraisal = {};
    }
    appraisal.selfAppraisal.kraRatings = kraRatings || appraisal.selfAppraisal.kraRatings || [];
    appraisal.selfAppraisal.kpiRatings = processedKpiRatings.length > 0 ? processedKpiRatings : (appraisal.selfAppraisal.kpiRatings || []);
    appraisal.selfAppraisal.goalRatings = goalRatings || appraisal.selfAppraisal.goalRatings || [];
    appraisal.selfAppraisal.competencyRatings = competencyRatings || appraisal.selfAppraisal.competencyRatings || [];
    if (accomplishments !== undefined) appraisal.selfAppraisal.accomplishments = accomplishments;
    if (challenges !== undefined) appraisal.selfAppraisal.challenges = challenges;
    if (careerAspirations !== undefined) appraisal.selfAppraisal.careerAspirations = careerAspirations;
    appraisal.selfAppraisal.isDraft = !isSubmit;
    appraisal.selfAppraisal.isSubmitted = Boolean(isSubmit);
    if (isSubmit) appraisal.selfAppraisal.submittedAt = new Date();

    // Calculate self overall score preview
    const settings = await PmsSetting.findOne({ companyId: req.companyId }).lean();
    const customBands = settings?.ratingScales?.[0]?.bands || null;
    appraisal.scores = computeConsolidatedAppraisalScore({
      appraisal,
      cycleSettings: appraisal.cycleId?.settings,
      customBands,
    });

    if (isSubmit) {
      const workflow = await getCompanyWorkflow(req.companyId);
      const nextStage = getNextWorkflowStage('self_review', workflow.stages);

      appraisal.currentStageKey = nextStage.key;
      appraisal.status = `${nextStage.key}_pending`;
      appraisal.workflowHistory.push({
        stageKey: 'self_review',
        stageLabel: 'Self-Appraisal',
        action: 'submitted',
        actedBy: req.user._id,
        actedByRole: 'Employee',
        comments: accomplishments || 'Self-appraisal submitted',
        actionDate: new Date(),
      });

      sendPmsNotification(req, {
        userId: appraisal.managerId,
        title: 'Self-Appraisal Submitted',
        message: `${req.user.firstName || 'An employee'} has submitted their self-appraisal for review.`,
        link: `/performance?tab=reviews&appraisalId=${appraisal._id}`,
        preferenceKey: 'pms_self_review_submitted',
      });
    }

    await appraisal.save();

    return res.status(200).json({
      success: true,
      message: isSubmit ? 'Self-appraisal submitted successfully' : 'Draft saved successfully',
      data: appraisal,
    });
  } catch (err) {
    console.error('[PMS saveSelfAppraisal Error]:', err);
    return res.status(500).json({ success: false, message: 'Failed to save self-appraisal' });
  }
};

/**
 * @desc Save or submit manager review and advance to next configured workflow stage
 * @route POST /api/performance/appraisals/:id/manager
 */
const saveManagerAppraisal = async (req, res) => {
  try {
    const { id } = req.params;
    const {
      kraRatings,
      kpiRatings,
      goalRatings,
      competencyRatings,
      strengths,
      areasOfImprovement,
      promotionRecommendation,
      trainingNeeds,
      overallComments,
      isSubmit,
    } = req.body;

    const companyId = req.companyId || req.user?.companyId;
    const appraisal = await PmsAppraisal.findOne({ _id: id, companyId }).populate('cycleId');
    if (!appraisal) {
      return res.status(404).json({ success: false, message: 'Appraisal not found' });
    }

    // Separation of Duties check
    const employeeIdStr = String(appraisal.employeeId);
    const userIdStr = String(req.user._id);
    if (employeeIdStr === userIdStr) {
      return res.status(403).json({
        success: false,
        message: 'Separation of duties: You cannot evaluate your own appraisal as manager.',
      });
    }

    const authCheck = await isUserAuthorizedForStage({
      user: req.user,
      appraisal,
      stageKey: 'manager_review',
      companyId: req.companyId,
    });

    if (!authCheck.authorized) {
      return res.status(403).json({ success: false, message: authCheck.reason });
    }

    if (isSubmit && appraisal.currentStageKey !== 'manager_review') {
      return res.status(409).json({
        success: false,
        message: `Appraisal is not currently in manager review stage (current: ${appraisal.currentStageKey}). Duplicate or out-of-order submission prevented.`,
      });
    }

    const assignedKpis = await PmsKpi.find({
      companyId: req.companyId,
      cycleId: appraisal.cycleId,
      employeeId: appraisal.employeeId,
      status: { $nin: ['deleted', 'inactive'] },
    }).lean();
    const kpiMap = new Map(assignedKpis.map((k) => [String(k._id), k]));

    const processedManagerKpis = [];
    if (Array.isArray(kpiRatings) && kpiRatings.length > 0) {
      for (const item of kpiRatings) {
        const kId = String(item.kpiId?._id || item.kpiId);
        const assignedKpi = kpiMap.get(kId);

        const name = assignedKpi ? assignedKpi.name : (item.name || '');
        const code = assignedKpi ? assignedKpi.code : (item.code || '');
        const targetValue = assignedKpi ? assignedKpi.targetValue : Number(item.targetValue || 0);
        const weightage = assignedKpi ? assignedKpi.weightage : Number(item.weightage || 0);
        const unit = assignedKpi ? (assignedKpi.unit || '%') : (item.unit || '%');
        const measurementType = assignedKpi ? (assignedKpi.measurementType || 'number') : (item.measurementType || 'number');
        const measurementDirection = assignedKpi ? (assignedKpi.measurementDirection || 'higher_is_better') : (item.measurementDirection || 'higher_is_better');
        const kraId = assignedKpi ? assignedKpi.kraId : (item.kraId || null);

        let managerRating = item.managerRating !== undefined && item.managerRating !== null && item.managerRating !== '' ? Number(item.managerRating) : null;
        let verifiedActual = item.verifiedActualValue !== undefined && item.verifiedActualValue !== null && item.verifiedActualValue !== '' ? Number(item.verifiedActualValue) : null;

        processedManagerKpis.push({
          kpiId: kId,
          kraId,
          name,
          code,
          targetValue,
          actualValue: assignedKpi?.actualValue || 0,
          verifiedActualValue: verifiedActual,
          weightage,
          unit,
          measurementType,
          measurementDirection,
          managerRating,
          managerComments: item.managerComments || '',
          evidenceVerified: item.evidenceVerified !== undefined ? Boolean(item.evidenceVerified) : null,
          evidenceComments: item.evidenceComments || '',
        });
      }
    }

    if (isSubmit && assignedKpis.length > 0) {
      const missingMgrRatings = assignedKpis.filter((ak) => {
        const rated = processedManagerKpis.find((pk) => String(pk.kpiId) === String(ak._id));
        return !rated || !rated.managerRating || rated.managerRating < 1;
      });
      if (missingMgrRatings.length > 0) {
        return res.status(400).json({
          success: false,
          message: `Please provide manager ratings (1-5) for all assigned KPIs before submitting. Pending items: ${missingMgrRatings.map((m) => m.name).join(', ')}`,
        });
      }
    }

    if (!appraisal.managerAppraisal) {
      appraisal.managerAppraisal = {};
    }
    appraisal.managerAppraisal.kraRatings = kraRatings || appraisal.managerAppraisal.kraRatings || [];
    appraisal.managerAppraisal.kpiRatings = processedManagerKpis.length > 0 ? processedManagerKpis : (appraisal.managerAppraisal.kpiRatings || []);
    appraisal.managerAppraisal.goalRatings = goalRatings || appraisal.managerAppraisal.goalRatings || [];
    appraisal.managerAppraisal.competencyRatings = competencyRatings || appraisal.managerAppraisal.competencyRatings || [];
    if (strengths !== undefined) appraisal.managerAppraisal.strengths = strengths;
    if (areasOfImprovement !== undefined) appraisal.managerAppraisal.areasOfImprovement = areasOfImprovement;
    if (promotionRecommendation && typeof promotionRecommendation === 'object') {
      appraisal.managerAppraisal.promotionRecommendation = {
        recommended: Boolean(promotionRecommendation.recommended),
        proposedDesignation: promotionRecommendation.proposedDesignation || '',
        notes: promotionRecommendation.notes || '',
      };
    }
    if (trainingNeeds) appraisal.managerAppraisal.trainingNeeds = trainingNeeds;
    if (overallComments !== undefined) appraisal.managerAppraisal.overallComments = overallComments;
    appraisal.managerAppraisal.isDraft = !isSubmit;
    appraisal.managerAppraisal.isSubmitted = Boolean(isSubmit);
    if (isSubmit) appraisal.managerAppraisal.submittedAt = new Date();

    // Calculate authoritative scores via scoring service
    const settings = await PmsSetting.findOne({ companyId: req.companyId }).lean();
    const customBands = settings?.ratingScales?.[0]?.bands || null;

    const calculatedScores = computeConsolidatedAppraisalScore({
      appraisal,
      cycleSettings: appraisal.cycleId?.settings,
      customBands,
    });
    appraisal.scores = calculatedScores;

    if (isSubmit && calculatedScores.isIncomplete) {
      return res.status(400).json({
        success: false,
        message: `Cannot submit manager evaluation: ${calculatedScores.incompleteReason}`,
        details: calculatedScores.scoreBreakdown?.sections,
      });
    }

    if (isSubmit) {
      const workflow = await getCompanyWorkflow(req.companyId);
      const nextStage = getNextWorkflowStage('manager_review', workflow.stages);

      appraisal.currentStageKey = nextStage.key;
      appraisal.status = `${nextStage.key}_pending`;
      appraisal.workflowHistory.push({
        stageKey: 'manager_review',
        stageLabel: 'Reporting Manager Review',
        action: 'submitted',
        actedBy: req.user._id,
        actedByRole: 'Reporting Manager',
        comments: overallComments || 'Manager evaluation submitted',
        ratingsSnapshot: {
          calculatedFinalScore: calculatedScores.calculatedFinalScore,
          ratingBand: calculatedScores.ratingBand,
        },
        actionDate: new Date(),
      });

      await logPmsAudit({
        companyId: req.companyId,
        userId: req.user._id,
        action: 'MANAGER_REVIEW_SUBMITTED',
        entityType: 'PmsAppraisal',
        entityId: appraisal._id,
        changes: { finalScore: calculatedScores.calculatedFinalScore, nextStage: nextStage.key },
      });
    }

    await appraisal.save();

    return res.status(200).json({
      success: true,
      message: isSubmit ? 'Manager appraisal submitted successfully' : 'Manager review draft saved',
      data: appraisal,
    });
  } catch (err) {
    console.error('[PMS saveManagerAppraisal Error]:', err);
    return res.status(500).json({ success: false, message: 'Failed to save manager appraisal' });
  }
};

/**
 * @desc Department Head review and sign-off
 * @route POST /api/performance/appraisals/:id/department-head
 */
const saveDepartmentHeadReview = async (req, res) => {
  try {
    const { id } = req.params;
    const { deptHeadRating, deptHeadComments } = req.body;
    const companyId = req.companyId || req.user?.companyId;

    const appraisal = await PmsAppraisal.findOne({ _id: id, companyId });
    if (!appraisal) {
      return res.status(404).json({ success: false, message: 'Appraisal not found' });
    }

    // Separation of duties
    if (String(appraisal.employeeId) === String(req.user._id)) {
      return res.status(403).json({ success: false, message: 'Separation of duties: You cannot review your own appraisal as department head.' });
    }

    const authCheck = await isUserAuthorizedForStage({
      user: req.user,
      appraisal,
      stageKey: 'department_head_review',
      companyId,
    });

    if (!authCheck.authorized) {
      return res.status(403).json({ success: false, message: authCheck.reason });
    }

    if (appraisal.currentStageKey !== 'department_head_review') {
      return res.status(409).json({
        success: false,
        message: `Appraisal is not currently in department head review stage (current: ${appraisal.currentStageKey}). Duplicate or out-of-order submission prevented.`,
      });
    }

    appraisal.departmentHeadEvaluation = {
      deptHeadRating: Number(deptHeadRating) || null,
      deptHeadComments: deptHeadComments || '',
      evaluatedBy: req.user._id,
      evaluatedAt: new Date(),
    };

    const workflow = await getCompanyWorkflow(companyId);
    const nextStage = getNextWorkflowStage('department_head_review', workflow.stages);

    appraisal.currentStageKey = nextStage.key;
    appraisal.status = `${nextStage.key}_pending`;
    appraisal.workflowHistory.push({
      stageKey: 'department_head_review',
      stageLabel: 'Department Head Review',
      action: 'approved',
      actedBy: req.user._id,
      actedByRole: 'Department Head',
      comments: deptHeadComments || 'Department Head approved',
      actionDate: new Date(),
    });

    await appraisal.save();

    await logPmsAudit({
      companyId,
      userId: req.user._id,
      action: 'DEPARTMENT_HEAD_REVIEW_SUBMITTED',
      entityType: 'PmsAppraisal',
      entityId: appraisal._id,
      changes: { deptHeadRating, nextStage: nextStage.key },
    });

    return res.status(200).json({
      success: true,
      message: 'Department Head review submitted successfully',
      data: appraisal,
    });
  } catch (err) {
    console.error('[PMS saveDepartmentHeadReview Error]:', err);
    return res.status(500).json({ success: false, message: 'Failed to submit Department Head review' });
  }
};

/**
 * @desc HR Evaluation and sign-off
 * @route POST /api/performance/appraisals/:id/hr-evaluation
 */
const saveHrEvaluation = async (req, res) => {
  try {
    const { id } = req.params;
    const { hrRating, hrComments } = req.body;
    const companyId = req.companyId || req.user?.companyId;

    const appraisal = await PmsAppraisal.findOne({ _id: id, companyId });
    if (!appraisal) {
      return res.status(404).json({ success: false, message: 'Appraisal not found' });
    }

    // Separation of duties
    if (String(appraisal.employeeId) === String(req.user._id)) {
      return res.status(403).json({ success: false, message: 'Separation of duties: You cannot complete HR evaluation on your own appraisal.' });
    }

    const authCheck = await isUserAuthorizedForStage({
      user: req.user,
      appraisal,
      stageKey: 'hr_evaluation',
      companyId,
    });

    if (!authCheck.authorized) {
      return res.status(403).json({ success: false, message: authCheck.reason });
    }

    if (appraisal.currentStageKey !== 'hr_evaluation') {
      return res.status(409).json({
        success: false,
        message: `Appraisal is not currently in HR evaluation stage (current: ${appraisal.currentStageKey}). Duplicate or out-of-order submission prevented.`,
      });
    }

    appraisal.hrEvaluation = {
      hrRating: Number(hrRating) || null,
      hrComments: hrComments || '',
      evaluatedBy: req.user._id,
      evaluatedAt: new Date(),
    };

    const workflow = await getCompanyWorkflow(companyId);
    const nextStage = getNextWorkflowStage('hr_evaluation', workflow.stages);

    appraisal.currentStageKey = nextStage.key;
    appraisal.status = `${nextStage.key}_pending`;
    appraisal.workflowHistory.push({
      stageKey: 'hr_evaluation',
      stageLabel: 'HR Evaluation & Calibration',
      action: 'approved',
      actedBy: req.user._id,
      actedByRole: 'HR Evaluator',
      comments: hrComments || 'HR evaluation completed',
      actionDate: new Date(),
    });

    await appraisal.save();

    await logPmsAudit({
      companyId,
      userId: req.user._id,
      action: 'HR_EVALUATION_SUBMITTED',
      entityType: 'PmsAppraisal',
      entityId: appraisal._id,
      changes: { hrRating, nextStage: nextStage.key },
    });

    return res.status(200).json({
      success: true,
      message: 'HR evaluation submitted successfully',
      data: appraisal,
    });
  } catch (err) {
    console.error('[PMS saveHrEvaluation Error]:', err);
    return res.status(500).json({ success: false, message: 'Failed to submit HR evaluation' });
  }
};

/**
 * @desc Final Leadership Approval
 * @route POST /api/performance/appraisals/:id/final-approval
 */
const saveFinalApproval = async (req, res) => {
  try {
    const { id } = req.params;
    const { comments, publishImmediately } = req.body;
    const companyId = req.companyId || req.user?.companyId;

    const appraisal = await PmsAppraisal.findOne({ _id: id, companyId });
    if (!appraisal) {
      return res.status(404).json({ success: false, message: 'Appraisal not found' });
    }

    // Separation of duties
    if (String(appraisal.employeeId) === String(req.user._id)) {
      return res.status(403).json({ success: false, message: 'Separation of duties: You cannot approve your own appraisal.' });
    }

    const authCheck = await isUserAuthorizedForStage({
      user: req.user,
      appraisal,
      stageKey: 'final_approval',
      companyId,
    });

    if (!authCheck.authorized) {
      return res.status(403).json({ success: false, message: authCheck.reason });
    }

    if (appraisal.currentStageKey !== 'final_approval') {
      return res.status(409).json({
        success: false,
        message: `Appraisal is not currently in final approval stage (current: ${appraisal.currentStageKey}). Duplicate or out-of-order submission prevented.`,
      });
    }

    appraisal.finalApproval = {
      approvedBy: req.user._id,
      approvedAt: new Date(),
      comments: comments || '',
    };

    if (publishImmediately) {
      const isAdmin = isUserAdminOrSuper(req.user);
      const hasPublishPerm = req.user?.permissions?.includes('pms.ratings.publish');
      if (isAdmin || hasPublishPerm) {
        appraisal.currentStageKey = 'published';
        appraisal.status = 'published';
        appraisal.isPublished = true;
        appraisal.publishedAt = new Date();
        appraisal.publishedBy = req.user._id;

        sendPmsNotification(req, {
          userId: appraisal.employeeId,
          title: 'Performance Appraisal Published',
          message: 'Your performance evaluation has been finalized and published. Please review and acknowledge.',
          link: `/performance?tab=reviews&appraisalId=${appraisal._id}`,
          preferenceKey: 'pms_final_published',
        });
      } else {
        appraisal.status = 'approved';
      }
    } else {
      appraisal.status = 'approved';
    }

    appraisal.workflowHistory.push({
      stageKey: 'final_approval',
      stageLabel: 'Final Leadership Approval',
      action: 'approved',
      actedBy: req.user._id,
      actedByRole: 'Leadership Approver',
      comments: comments || 'Final approval granted',
      actionDate: new Date(),
    });

    await appraisal.save();

    await logPmsAudit({
      companyId,
      userId: req.user._id,
      action: 'FINAL_APPROVAL_RECORDED',
      entityType: 'PmsAppraisal',
      entityId: appraisal._id,
      changes: { comments, isPublished: appraisal.isPublished, status: appraisal.status },
    });

    return res.status(200).json({
      success: true,
      message: 'Final approval recorded successfully',
      data: appraisal,
    });
  } catch (err) {
    console.error('[PMS saveFinalApproval Error]:', err);
    return res.status(500).json({ success: false, message: 'Failed to record final approval' });
  }
};

/**
 * @desc Request revision on an appraisal and return to a previous stage
 * @route POST /api/performance/appraisals/:id/request-revision
 */
const requestAppraisalRevision = async (req, res) => {
  try {
    const { id } = req.params;
    const { targetStage, reason } = req.body; // targetStage: 'self_review' or 'manager_review'

    if (!reason || reason.trim().length < 5) {
      return res.status(400).json({ success: false, message: 'A specific revision reason (minimum 5 characters) is required.' });
    }

    const appraisal = await PmsAppraisal.findOne({ _id: id, companyId: req.companyId });
    if (!appraisal) {
      return res.status(404).json({ success: false, message: 'Appraisal not found' });
    }

    // Requester must be manager, dept head, HR, or admin
    const isMgr = String(appraisal.managerId) === String(req.user._id);
    const isHr = isUserHr(req.user);
    if (!isMgr && !isHr) {
      return res.status(403).json({ success: false, message: 'Only authorized managers or HR can request revisions.' });
    }

    const validTarget = targetStage === 'manager_review' ? 'manager_review' : 'self_review';
    appraisal.currentStageKey = validTarget;
    appraisal.status = 'revision_requested';
    appraisal.revisionRequest = {
      requestedBy: req.user._id,
      requestedAt: new Date(),
      targetStage: validTarget,
      reason: reason.trim(),
    };

    appraisal.workflowHistory.push({
      stageKey: validTarget,
      stageLabel: validTarget === 'manager_review' ? 'Manager Review' : 'Self-Appraisal',
      action: 'revision_requested',
      actedBy: req.user._id,
      actedByRole: isHr ? 'HR Administrator' : 'Reporting Manager',
      comments: reason.trim(),
      actionDate: new Date(),
    });

    await appraisal.save();

    // Notify recipient
    const recipientId = validTarget === 'self_review' ? appraisal.employeeId : appraisal.managerId;
    sendPmsNotification(req, {
      userId: recipientId,
      title: 'Revision Requested on Appraisal',
      message: `A revision has been requested: "${reason.trim()}". Please review and resubmit.`,
      link: `/performance?tab=reviews&appraisalId=${appraisal._id}`,
      preferenceKey: 'pms_revision_requested',
    });

    return res.status(200).json({
      success: true,
      message: `Appraisal returned to ${validTarget} for revisions.`,
      data: appraisal,
    });
  } catch (err) {
    console.error('[PMS requestAppraisalRevision Error]:', err);
    return res.status(500).json({ success: false, message: 'Failed to request revision' });
  }
};

/**
 * @desc Nominate 360 peer reviewers
 * @route POST /api/performance/appraisals/:id/nominate-360
 */
const nominate360Reviewers = async (req, res) => {
  try {
    const { id } = req.params;
    const { reviewerIds, relationship, isAnonymous } = req.body;

    if (!Array.isArray(reviewerIds) || reviewerIds.length === 0) {
      return res.status(400).json({ success: false, message: 'At least one reviewer ID is required' });
    }

    const appraisal = await PmsAppraisal.findOne({ _id: id, companyId: req.companyId });
    if (!appraisal) {
      return res.status(404).json({ success: false, message: 'Appraisal not found' });
    }

    reviewerIds.forEach((revId) => {
      const exists = appraisal.peerReviews.some((p) => String(p.reviewerId) === String(revId));
      if (!exists && String(revId) !== String(appraisal.employeeId)) {
        appraisal.peerReviews.push({
          reviewerId: revId,
          relationship: relationship || 'peer',
          status: 'nominated',
          isAnonymous: isAnonymous !== undefined ? Boolean(isAnonymous) : true,
          ratings: [],
        });

        sendPmsNotification(req, {
          userId: revId,
          title: '360 Feedback Request',
          message: 'You have been invited to provide 360-degree performance feedback for a colleague.',
          link: `/performance?tab=peer&appraisalId=${appraisal._id}`,
          preferenceKey: 'pms_360_request',
        });
      }
    });

    await appraisal.save();

    return res.status(200).json({ success: true, message: '360 reviewers nominated successfully', data: appraisal });
  } catch (err) {
    console.error('[PMS nominate360Reviewers Error]:', err);
    return res.status(500).json({ success: false, message: 'Failed to nominate reviewers' });
  }
};

/**
 * @desc Submit 360 feedback by a nominated reviewer
 * @route POST /api/performance/appraisals/:id/submit-360
 */
const submit360Feedback = async (req, res) => {
  try {
    const { id } = req.params;
    const { ratings, strengthsFeedback, developmentFeedback } = req.body;

    const appraisal = await PmsAppraisal.findOne({ _id: id, companyId: req.companyId });
    if (!appraisal) {
      return res.status(404).json({ success: false, message: 'Appraisal not found' });
    }

    const reviewerEntry = appraisal.peerReviews.find((p) => String(p.reviewerId) === String(req.user._id));
    if (!reviewerEntry) {
      return res.status(403).json({ success: false, message: 'You are not a nominated reviewer for this appraisal' });
    }

    reviewerEntry.ratings = ratings || [];
    reviewerEntry.strengthsFeedback = strengthsFeedback || '';
    reviewerEntry.developmentFeedback = developmentFeedback || '';
    reviewerEntry.status = 'submitted';
    reviewerEntry.submittedAt = new Date();

    await appraisal.save();

    return res.status(200).json({ success: true, message: '360 feedback submitted successfully' });
  } catch (err) {
    console.error('[PMS submit360Feedback Error]:', err);
    return res.status(500).json({ success: false, message: 'Failed to submit 360 feedback' });
  }
};

/**
 * @desc HR / Leadership moderation & rating calibration with mandatory reason
 * @route POST /api/performance/appraisals/:id/calibrate
 */
const calibrateRating = async (req, res) => {
  try {
    const { id } = req.params;
    const { calibratedScore, calibratedRatingBand, reason } = req.body;
    const companyId = req.companyId || req.user?.companyId;

    if (calibratedScore === undefined || !reason || reason.trim().length < 5) {
      return res.status(400).json({ success: false, message: 'Calibrated score and a documented reason (min 5 chars) are required' });
    }

    const numScore = Number(calibratedScore);
    if (isNaN(numScore) || numScore < 0 || numScore > 100) {
      return res.status(400).json({ success: false, message: 'Calibrated score must be a valid number between 0 and 100' });
    }

    const appraisal = await PmsAppraisal.findOne({ _id: id, companyId });
    if (!appraisal) {
      return res.status(404).json({ success: false, message: 'Appraisal not found' });
    }

    // Separation of duties: Evaluator CANNOT calibrate their own appraisal
    if (String(appraisal.employeeId) === String(req.user._id)) {
      return res.status(403).json({ success: false, message: 'Separation of duties: You cannot calibrate your own appraisal.' });
    }

    const isHr = isUserHr(req.user);
    if (!isHr) {
      return res.status(403).json({ success: false, message: 'Calibration moderation requires HR or Admin permissions.' });
    }

    if (appraisal.isPublished) {
      return res.status(400).json({ success: false, message: 'Cannot calibrate an already published appraisal. Reopen first.' });
    }

    if (appraisal.currentStageKey === 'self_review') {
      return res.status(400).json({ success: false, message: 'Cannot calibrate an appraisal that is still in self-review.' });
    }

    const originalScore = appraisal.scores?.calculatedFinalScore || 0;

    appraisal.calibration = {
      originalScore,
      calibratedScore: numScore,
      calibratedRatingBand: calibratedRatingBand || appraisal.scores?.ratingBand,
      calibratedBy: req.user._id,
      calibratedAt: new Date(),
      reason: reason.trim(),
      isAdjusted: true,
    };

    if (!appraisal.scores) appraisal.scores = {};
    appraisal.scores.calibratedScore = numScore;
    if (calibratedRatingBand) {
      appraisal.scores.ratingBand = calibratedRatingBand;
    }

    appraisal.workflowHistory.push({
      stageKey: appraisal.currentStageKey || 'calibration',
      stageLabel: 'Rating Calibration',
      action: 'calibrated',
      actedBy: req.user._id,
      actedByRole: 'HR Calibration Officer',
      comments: reason.trim(),
      ratingsSnapshot: { originalScore, calibratedScore: numScore },
      actionDate: new Date(),
    });

    await appraisal.save();

    await logPmsAudit({
      companyId,
      userId: req.user._id,
      action: 'CALIBRATION_ADJUSTMENT',
      entityType: 'PmsAppraisal',
      entityId: appraisal._id,
      reason: reason.trim(),
      changes: { originalScore, calibratedScore: numScore },
    });

    return res.status(200).json({ success: true, message: 'Rating calibrated successfully', data: appraisal });
  } catch (err) {
    console.error('[PMS calibrateRating Error]:', err);
    return res.status(500).json({ success: false, message: 'Failed to calibrate rating' });
  }
};

/**
 * @desc Publish final appraisal results to employees
 * @route POST /api/performance/appraisals/publish
 */
const publishAppraisals = async (req, res) => {
  try {
    const { appraisalIds, cycleId } = req.body;
    const companyId = req.companyId || req.user?.companyId;

    const isAdmin = isUserAdminOrSuper(req.user);
    const hasPublishPerm = req.user?.permissions?.includes('pms.ratings.publish');
    if (!isAdmin && !hasPublishPerm) {
      return res.status(403).json({ success: false, message: 'Only authorized administrators can publish performance ratings.' });
    }

    let filter = { companyId };
    if (Array.isArray(appraisalIds) && appraisalIds.length > 0) {
      const candidates = await PmsAppraisal.find({ _id: { $in: appraisalIds }, companyId });
      if (candidates.length === 0) {
        return res.status(404).json({ success: false, message: 'No matching appraisals found to publish.' });
      }
      for (const app of candidates) {
        const isApproved = Boolean(app.finalApproval?.approvedAt) || app.status === 'approved' || app.status === 'final_approval_approved';
        if (!isApproved && app.status !== 'published') {
          return res.status(400).json({
            success: false,
            message: `Cannot publish appraisal: Required reviews and final approval must be completed first (Appraisal ID: ${app._id}, Stage: ${app.currentStageKey || app.status}).`,
          });
        }
      }
      filter._id = { $in: candidates.map((c) => c._id) };
    } else if (cycleId) {
      filter.cycleId = cycleId;
      filter.$or = [
        { 'finalApproval.approvedAt': { $exists: true, $ne: null } },
        { status: 'approved' },
        { status: 'final_approval_approved' },
      ];
      filter.isPublished = { $ne: true };
    } else {
      return res.status(400).json({ success: false, message: 'Provide appraisalIds or cycleId to publish' });
    }

    const toPublish = await PmsAppraisal.find(filter).select('_id employeeId scores calibration').lean();
    if (toPublish.length === 0) {
      return res.status(400).json({ success: false, message: 'No un-published, approved appraisals ready for publication.' });
    }

    await PmsAppraisal.updateMany(
      { _id: { $in: toPublish.map((p) => p._id) }, companyId },
      {
        $set: {
          isPublished: true,
          publishedAt: new Date(),
          publishedBy: req.user._id,
          currentStageKey: 'published',
          status: 'published',
        },
      }
    );

    for (const app of toPublish) {
      sendPmsNotification(req, {
        userId: app.employeeId,
        title: 'Performance Appraisal Published',
        message: 'Your performance evaluation has been finalized and published. Please review and acknowledge.',
        link: `/performance?tab=reviews&appraisalId=${app._id}`,
        preferenceKey: 'pms_final_published',
      });
    }

    await logPmsAudit({
      companyId,
      userId: req.user._id,
      action: 'APPRAISALS_PUBLISHED',
      entityType: 'PmsAppraisal',
      changes: { count: toPublish.length, appraisalIds: toPublish.map((p) => p._id) },
    });

    return res.status(200).json({
      success: true,
      message: `Successfully published ${toPublish.length} appraisals`,
      data: { publishedCount: toPublish.length },
    });
  } catch (err) {
    console.error('[PMS publishAppraisals Error]:', err);
    return res.status(500).json({ success: false, message: 'Failed to publish appraisals' });
  }
};

/**
 * @desc Employee signs off or disputes published appraisal
 * @route POST /api/performance/appraisals/:id/acknowledge
 */
const acknowledgeAppraisal = async (req, res) => {
  try {
    const { id } = req.params;
    const { isDisputed, disputeReason, comments } = req.body;
    const companyId = req.companyId || req.user?.companyId;

    const appraisal = await PmsAppraisal.findOne({ _id: id, companyId });
    if (!appraisal) {
      return res.status(404).json({ success: false, message: 'Appraisal not found' });
    }

    if (String(appraisal.employeeId) !== String(req.user._id)) {
      return res.status(403).json({ success: false, message: 'Only the assigned employee can acknowledge this appraisal' });
    }

    if (!appraisal.isPublished && appraisal.status !== 'published') {
      return res.status(400).json({ success: false, message: 'Only published appraisals can be acknowledged or disputed.' });
    }

    if (isDisputed && (!disputeReason || disputeReason.trim().length < 5)) {
      return res.status(400).json({ success: false, message: 'A specific reason (minimum 5 characters) is required when submitting a dispute.' });
    }

    appraisal.acknowledgement = {
      isAcknowledged: true,
      acknowledgedAt: new Date(),
      isDisputed: Boolean(isDisputed),
      disputeReason: disputeReason ? disputeReason.trim() : '',
      employeeComments: comments ? comments.trim() : '',
    };
    appraisal.status = isDisputed ? 'disputed' : 'acknowledged';

    appraisal.workflowHistory.push({
      stageKey: 'published',
      stageLabel: 'Rating Published',
      action: isDisputed ? 'disputed' : 'acknowledged',
      actedBy: req.user._id,
      actedByRole: 'Employee',
      comments: isDisputed ? disputeReason.trim() : (comments || 'Employee acknowledged appraisal'),
      actionDate: new Date(),
    });

    await appraisal.save();

    await logPmsAudit({
      companyId,
      userId: req.user._id,
      action: isDisputed ? 'APPRAISAL_DISPUTED' : 'APPRAISAL_ACKNOWLEDGED',
      entityType: 'PmsAppraisal',
      entityId: appraisal._id,
      changes: { isDisputed, comments },
    });

    // Notify reporting manager
    if (appraisal.managerId) {
      sendPmsNotification(req, {
        userId: appraisal.managerId,
        title: isDisputed ? 'Appraisal Disputed by Employee' : 'Appraisal Acknowledged',
        message: isDisputed
          ? `Employee has raised a dispute on their published appraisal: "${disputeReason.trim()}".`
          : `Employee has formally signed off and acknowledged their appraisal.`,
        link: `/performance?tab=reviews&appraisalId=${appraisal._id}`,
        preferenceKey: isDisputed ? 'pms_appraisal_disputed' : 'pms_appraisal_acknowledged',
      });
    }

    return res.status(200).json({
      success: true,
      message: isDisputed ? 'Dispute submitted successfully' : 'Appraisal acknowledged successfully',
      data: appraisal,
    });
  } catch (err) {
    console.error('[PMS acknowledgeAppraisal Error]:', err);
    return res.status(500).json({ success: false, message: 'Failed to acknowledge appraisal' });
  }
};

/**
 * @desc Delegate manager review to another evaluator
 * @route POST /api/performance/appraisals/:id/delegate
 */
const delegateReview = async (req, res) => {
  try {
    const { id } = req.params;
    const { delegateTo, validUntil, reason } = req.body;

    if (!delegateTo) {
      return res.status(400).json({ success: false, message: 'delegateTo user ID is required.' });
    }

    const appraisal = await PmsAppraisal.findOne({ _id: id, companyId: req.companyId });
    if (!appraisal) {
      return res.status(404).json({ success: false, message: 'Appraisal not found.' });
    }

    const isDirectManager = String(appraisal.managerId) === String(req.user._id);
    const isHr = isUserHr(req.user);
    const isAdmin = isUserAdminOrSuper(req.user);

    if (!isDirectManager && !isHr && !isAdmin) {
      return res.status(403).json({ success: false, message: 'Unauthorized: Only the assigned manager or HR can delegate review.' });
    }

    const targetUser = await User.findOne({ _id: delegateTo, companyId: req.companyId, isActive: true }).select('_id firstName lastName email').lean();
    if (!targetUser) {
      return res.status(404).json({ success: false, message: 'Delegated user not found or inactive in this company.' });
    }

    // Separation of duties
    if (String(targetUser._id) === String(appraisal.employeeId)) {
      return res.status(400).json({ success: false, message: 'Separation of duties: Cannot delegate review to the employee being evaluated.' });
    }

    appraisal.delegation = {
      isDelegated: true,
      delegatedTo: targetUser._id,
      delegatedBy: req.user._id,
      delegatedAt: new Date(),
      validUntil: validUntil ? new Date(validUntil) : null,
      reason: reason || 'Review delegated by manager/HR',
    };

    appraisal.workflowHistory.push({
      stageKey: appraisal.currentStageKey || 'manager_review',
      stageLabel: 'Manager Review Delegation',
      action: 'delegated',
      actedBy: req.user._id,
      actedByRole: isHr ? 'HR Administrator' : 'Reporting Manager',
      comments: `Review delegated to ${targetUser.firstName} ${targetUser.lastName}. Reason: ${reason || 'N/A'}`,
      actionDate: new Date(),
    });

    await appraisal.save();

    await logPmsAudit({
      companyId: req.companyId,
      userId: req.user._id,
      action: 'APPRAISAL_REVIEW_DELEGATED',
      entityType: 'PmsAppraisal',
      entityId: appraisal._id,
      changes: { delegatedTo: targetUser._id, reason },
    });

    sendPmsNotification(req, {
      userId: targetUser._id,
      title: 'Appraisal Review Delegated to You',
      message: `You have been delegated as reviewer for an appraisal.`,
      link: `/performance?tab=reviews&appraisalId=${appraisal._id}`,
      preferenceKey: 'pms_review_delegated',
    });

    return res.status(200).json({
      success: true,
      message: `Review successfully delegated to ${targetUser.firstName} ${targetUser.lastName}`,
      data: appraisal,
    });
  } catch (err) {
    console.error('[PMS delegateReview Error]:', err);
    return res.status(500).json({ success: false, message: 'Failed to delegate review' });
  }
};

/**
 * @desc Reassign primary manager reviewer
 * @route POST /api/performance/appraisals/:id/reassign
 */
const reassignReviewer = async (req, res) => {
  try {
    const { id } = req.params;
    const { newManagerId, reason } = req.body;

    if (!newManagerId) {
      return res.status(400).json({ success: false, message: 'newManagerId is required.' });
    }

    const appraisal = await PmsAppraisal.findOne({ _id: id, companyId: req.companyId });
    if (!appraisal) {
      return res.status(404).json({ success: false, message: 'Appraisal not found.' });
    }

    const isHr = isUserHr(req.user);
    const isAdmin = isUserAdminOrSuper(req.user);
    if (!isHr && !isAdmin) {
      return res.status(403).json({ success: false, message: 'Unauthorized: Only HR or Admins can reassign reviewers.' });
    }

    const newMgr = await User.findOne({ _id: newManagerId, companyId: req.companyId, isActive: true }).select('_id firstName lastName email').lean();
    if (!newMgr) {
      return res.status(404).json({ success: false, message: 'New manager not found or inactive in this company.' });
    }

    if (String(newMgr._id) === String(appraisal.employeeId)) {
      return res.status(400).json({ success: false, message: 'Separation of duties: New manager cannot be the employee.' });
    }

    const oldManagerId = appraisal.managerId;
    appraisal.managerId = newMgr._id;
    if (appraisal.delegation?.isDelegated) {
      appraisal.delegation.isDelegated = false;
    }

    appraisal.workflowHistory.push({
      stageKey: appraisal.currentStageKey || 'manager_review',
      stageLabel: 'Reviewer Reassignment',
      action: 'reassigned',
      actedBy: req.user._id,
      actedByRole: isHr ? 'HR Administrator' : 'Administrator',
      comments: `Reassigned from ${oldManagerId} to ${newMgr.firstName} ${newMgr.lastName}. Reason: ${reason || 'Manager change / reassignment'}`,
      actionDate: new Date(),
    });

    await appraisal.save();

    await logPmsAudit({
      companyId: req.companyId,
      userId: req.user._id,
      action: 'APPRAISAL_REVIEWER_REASSIGNED',
      entityType: 'PmsAppraisal',
      entityId: appraisal._id,
      changes: { fromManager: oldManagerId, toManager: newMgr._id, reason },
    });

    sendPmsNotification(req, {
      userId: newMgr._id,
      title: 'Appraisal Reassigned to You',
      message: `You have been assigned as reporting manager evaluator for an employee appraisal.`,
      link: `/performance?tab=reviews&appraisalId=${appraisal._id}`,
      preferenceKey: 'pms_reviewer_reassigned',
    });

    return res.status(200).json({
      success: true,
      message: `Reviewer successfully reassigned to ${newMgr.firstName} ${newMgr.lastName}`,
      data: appraisal,
    });
  } catch (err) {
    console.error('[PMS reassignReviewer Error]:', err);
    return res.status(500).json({ success: false, message: 'Failed to reassign reviewer' });
  }
};

/**
 * @desc Reopen an individual appraisal
 * @route POST /api/performance/appraisals/:id/reopen
 */
const reopenAppraisal = async (req, res) => {
  try {
    const { id } = req.params;
    const { targetStage, reason } = req.body;

    if (!reason || reason.trim().length < 5) {
      return res.status(400).json({ success: false, message: 'A specific reopening reason (min 5 chars) is required.' });
    }

    const appraisal = await PmsAppraisal.findOne({ _id: id, companyId: req.companyId });
    if (!appraisal) {
      return res.status(404).json({ success: false, message: 'Appraisal not found.' });
    }

    const isHr = isUserHr(req.user);
    const isAdmin = isUserAdminOrSuper(req.user);
    if (!isHr && !isAdmin) {
      return res.status(403).json({ success: false, message: 'Unauthorized: Only HR or Admins can reopen an appraisal.' });
    }

    const validTargetStage = ['self_review', 'manager_review', 'hr_evaluation'].includes(targetStage)
      ? targetStage
      : 'manager_review';

    appraisal.isPublished = false;
    appraisal.publishedAt = null;
    appraisal.publishedBy = null;
    appraisal.currentStageKey = validTargetStage;
    appraisal.status = `${validTargetStage}_pending`;

    appraisal.workflowHistory.push({
      stageKey: validTargetStage,
      stageLabel: 'Appraisal Reopened',
      action: 'reopened',
      actedBy: req.user._id,
      actedByRole: isHr ? 'HR Administrator' : 'Administrator',
      comments: reason.trim(),
      actionDate: new Date(),
    });

    await appraisal.save();

    await logPmsAudit({
      companyId: req.companyId,
      userId: req.user._id,
      action: 'APPRAISAL_REOPENED',
      entityType: 'PmsAppraisal',
      entityId: appraisal._id,
      reason: reason.trim(),
      changes: { currentStageKey: validTargetStage, isPublished: false },
    });

    return res.status(200).json({
      success: true,
      message: `Appraisal successfully reopened and returned to ${validTargetStage}.`,
      data: appraisal,
    });
  } catch (err) {
    console.error('[PMS reopenAppraisal Error]:', err);
    return res.status(500).json({ success: false, message: 'Failed to reopen appraisal' });
  }
};

module.exports = {
  listAppraisals,
  getAppraisalDetails,
  saveSelfAppraisal,
  saveManagerAppraisal,
  saveDepartmentHeadReview,
  saveHrEvaluation,
  saveFinalApproval,
  requestAppraisalRevision,
  nominate360Reviewers,
  submit360Feedback,
  calibrateRating,
  publishAppraisals,
  acknowledgeAppraisal,
  delegateReview,
  reassignReviewer,
  reopenAppraisal,
};
