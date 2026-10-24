const mongoose = require('mongoose');
const ExcelJS = require('exceljs');
const PmsCycle = require('./models/pmsCycle.model');
const PmsAppraisal = require('./models/pmsAppraisal.model');
const PmsGoal = require('./models/pmsGoal.model');
const PmsKra = require('./models/pmsKra.model');
const PmsKpi = require('./models/pmsKpi.model');
const PmsSetting = require('./models/pmsSetting.model');
const User = require('../user/user.model');
const Department = require('../organization/models/department.model');
const { isUserAdminOrSuper, isUserHr } = require('./services/pmsWorkflow.service');
const { logPmsAudit } = require('./services/pmsAudit.service');
const { runPmsRemindersJob } = require('./services/pmsReminders.service');

/**
 * Formula Injection Protection:
 * Sanitizes cell values to prevent command injection in Excel / CSV viewers
 * (prefixes cells starting with '=', '+', '-', '@', '\t', '\r' with a single quote)
 */
const sanitizeCellValue = (val) => {
  if (val === null || val === undefined) return '';
  if (typeof val === 'number' || typeof val === 'boolean' || val instanceof Date) return val;
  const str = String(val).trim();
  if (/^[\=\+\-\@\t\r]/.test(str)) {
    return `'${str}`;
  }
  return str;
};

/**
 * Helper to determine user role and scope
 */
const resolveUserScope = async (req) => {
  const companyId = req.companyId;
  const isAdmin = isUserAdminOrSuper(req.user);
  const isHr = isUserHr(req.user) || req.user?.permissions?.includes('pms.view.all');
  const hasAnalyticsPerm = req.user?.permissions?.includes('pms.analytics.view');
  const hasReportsPerm = req.user?.permissions?.includes('pms.reports.view');
  const isPrivileged = isAdmin || isHr || hasAnalyticsPerm || hasReportsPerm;

  if (isPrivileged) {
    return { scope: 'all', filterUserIds: null, isPrivileged: true };
  }

  // Check if user is a Reporting Manager with direct reports
  const directReports = await User.find({
    reportingManagers: req.user._id,
    companyId,
    isActive: true,
    isDeleted: { $ne: true },
    status: { $nin: ['deleted', 'inactive', 'terminated', 'Inactive', 'Terminated'] },
  }).select('_id').lean();

  if (directReports.length > 0) {
    const reportIds = directReports.map((d) => d._id);
    return { scope: 'manager_team', filterUserIds: reportIds, isPrivileged: false };
  }

  // Check if user is a Department Head
  const managedDept = await Department.findOne({ companyId, departmentHead: req.user._id }).lean();
  if (managedDept) {
    const deptUsers = await User.find({
      department: managedDept.name,
      companyId,
      isActive: true,
      isDeleted: { $ne: true },
    }).select('_id').lean();
    return { scope: 'department', filterUserIds: deptUsers.map((u) => u._id), departmentName: managedDept.name, isPrivileged: false };
  }

  // Standard employee: self only
  return { scope: 'self', filterUserIds: [req.user._id], isPrivileged: false };
};

/**
 * @desc Get comprehensive PMS dashboard analytics with live aggregations & role scoping
 * @route GET /api/performance/analytics/dashboard
 */
const getDashboardMetrics = async (req, res) => {
  try {
    const companyId = req.companyId;
    const { cycleId, department, designation, status, dateFrom, dateTo } = req.query;

    const cyclesList = await PmsCycle.find({ companyId })
      .select('_id name status cycleType startDate endDate')
      .sort({ startDate: -1 })
      .lean();

    let activeCycle = null;
    let effectiveCycleId = null;

    if (cycleId === 'all') {
      effectiveCycleId = null;
      activeCycle = null;
    } else if (cycleId && mongoose.Types.ObjectId.isValid(cycleId)) {
      activeCycle = await PmsCycle.findOne({ _id: new mongoose.Types.ObjectId(cycleId), companyId }).lean();
      effectiveCycleId = activeCycle?._id || null;
    } else {
      activeCycle = await PmsCycle.findOne({
        companyId,
        status: { $in: ['in_progress', 'self_review', 'manager_review', 'goal_setting', 'peer_feedback', 'calibration', 'published'] },
      }).sort({ startDate: -1 }).lean();

      if (!activeCycle) {
        activeCycle = await PmsCycle.findOne({ companyId }).sort({ createdAt: -1 }).lean();
      }
      effectiveCycleId = activeCycle?._id || null;
    }

    const userScope = await resolveUserScope(req);

    // Active employee filter
    const employeeUserFilter = {
      companyId,
      isActive: true,
      isDeleted: { $ne: true },
      status: { $nin: ['deleted', 'inactive', 'terminated', 'Inactive', 'Terminated'] },
    };

    if (userScope.filterUserIds) {
      employeeUserFilter._id = { $in: userScope.filterUserIds };
    }
    if (department && department !== 'all') {
      employeeUserFilter.department = department;
    }
    if (designation && designation !== 'all') {
      employeeUserFilter.designation = designation;
    }

    const activeCompanyEmployees = await User.find(employeeUserFilter).select('_id department designation').lean();
    const activeEmployeeIds = activeCompanyEmployees.map((e) => e._id);

    // Base match for appraisals
    const appraisalMatch = {
      companyId: new mongoose.Types.ObjectId(companyId),
      employeeId: { $in: activeEmployeeIds },
    };

    if (effectiveCycleId) {
      appraisalMatch.cycleId = new mongoose.Types.ObjectId(effectiveCycleId);
    }
    if (status && status !== 'all') {
      appraisalMatch.status = status;
    }
    if (dateFrom || dateTo) {
      appraisalMatch.updatedAt = {};
      if (dateFrom) appraisalMatch.updatedAt.$gte = new Date(dateFrom);
      if (dateTo) appraisalMatch.updatedAt.$lte = new Date(dateTo);
    }

    // 1. Comprehensive Appraisal Status Counts
    const statusCountsAgg = await PmsAppraisal.aggregate([
      { $match: appraisalMatch },
      { $group: { _id: '$status', count: { $sum: 1 } } },
    ]);

    const statusMap = {};
    let totalReviews = 0;
    statusCountsAgg.forEach((s) => {
      statusMap[s._id] = s.count;
      totalReviews += s.count;
    });

    const publishedCount = (statusMap['published'] || 0) + (statusMap['acknowledged'] || 0) + (statusMap['disputed'] || 0);
    const selfPendingCount = statusMap['self_review_pending'] || 0;
    const managerPendingCount = statusMap['manager_review_pending'] || 0;
    const deptHeadPendingCount = (statusMap['department_head_review_pending'] || 0) + (statusMap['dept_head_review_pending'] || 0);
    const hrPendingCount = statusMap['hr_evaluation_pending'] || 0;
    const calibrationPendingCount = statusMap['calibration_pending'] || 0;
    const finalApprovalPendingCount = statusMap['final_approval_pending'] || 0;
    const approvedCount = statusMap['approved'] || 0;
    const acknowledgedCount = statusMap['acknowledged'] || 0;
    const disputedCount = statusMap['disputed'] || 0;
    const revisionCount = statusMap['revision_requested'] || 0;

    const completionRate = totalReviews > 0 ? Math.round((publishedCount / totalReviews) * 100) : 0;

    // 2. Average Final Performance Score
    // Only published ratings are included for non-privileged users; privileged users see scored appraisals
    const scoreFilter = { ...appraisalMatch, 'scores.calculatedFinalScore': { $gt: 0 } };
    if (!userScope.isPrivileged) {
      scoreFilter.isPublished = true;
    }

    const avgScoreAgg = await PmsAppraisal.aggregate([
      { $match: scoreFilter },
      { $group: { _id: null, avgScore: { $avg: '$scores.calculatedFinalScore' } } },
    ]);
    const averageRating = avgScoreAgg[0]?.avgScore ? Number(avgScoreAgg[0].avgScore.toFixed(2)) : 0;

    // 3. Rating Band & Star Distribution
    const scoreAgg = await PmsAppraisal.aggregate([
      { $match: scoreFilter },
      { $group: { _id: { $round: ['$scores.calculatedFinalScore', 0] }, count: { $sum: 1 } } },
    ]);
    const starMap = new Map(scoreAgg.map((s) => [Number(s._id), s.count]));
    const ratingDistribution = [1, 2, 3, 4, 5].map((star) => ({
      rating: String(star),
      count: starMap.get(star) || 0,
    }));

    // Rating Band Categories
    const bandAgg = await PmsAppraisal.aggregate([
      { $match: scoreFilter },
      { $group: { _id: { $ifNull: ['$scores.ratingBand', 'Unassigned'] }, count: { $sum: 1 } } },
    ]);
    const ratingBands = bandAgg.map((b) => ({ band: b._id, count: b.count }));

    // 4. Department Performance Comparison
    const deptPerformance = await PmsAppraisal.aggregate([
      { $match: scoreFilter },
      {
        $lookup: {
          from: 'users',
          localField: 'employeeId',
          foreignField: '_id',
          as: 'employee',
        },
      },
      { $unwind: '$employee' },
      {
        $group: {
          _id: { $ifNull: ['$employee.department', 'General'] },
          averageScore: { $avg: '$scores.calculatedFinalScore' },
          totalEvaluated: { $sum: 1 },
        },
      },
      { $sort: { averageScore: -1 } },
      { $limit: 15 },
    ]);

    // 5. KPI Target Achievement Rate
    const kpiMatch = { companyId: new mongoose.Types.ObjectId(companyId) };
    if (effectiveCycleId) kpiMatch.cycleId = new mongoose.Types.ObjectId(effectiveCycleId);
    if (activeEmployeeIds.length > 0) kpiMatch.employeeId = { $in: activeEmployeeIds };

    const kpiAgg = await PmsKpi.aggregate([
      { $match: kpiMatch },
      {
        $project: {
          targetValue: 1,
          actualValue: { $ifNull: ['$actualValue', 0] },
          achievement: {
            $cond: [
              { $gt: ['$targetValue', 0] },
              { $multiply: [{ $divide: [{ $ifNull: ['$actualValue', 0] }, '$targetValue'] }, 100] },
              0,
            ],
          },
        },
      },
      {
        $group: {
          _id: null,
          avgAchievement: { $avg: '$achievement' },
          totalKpis: { $sum: 1 },
        },
      },
    ]);
    const kpiAchievementRate = kpiAgg[0]?.avgAchievement ? Math.min(150, Math.round(kpiAgg[0].avgAchievement)) : 0;

    // 6. High Performers & Employees Requiring Support
    let highPerformers = [];
    let employeesRequiringSupport = [];

    if (userScope.isPrivileged || userScope.scope === 'manager_team' || userScope.scope === 'department') {
      const scoredAppraisals = await PmsAppraisal.find(scoreFilter)
        .populate({
          path: 'employeeId',
          select: 'firstName lastName email department designation employeeCode',
        })
        .sort({ 'scores.calculatedFinalScore': -1 })
        .limit(20)
        .lean();

      highPerformers = scoredAppraisals
        .filter((a) => (a.scores?.calculatedFinalScore || 0) >= 4.0 && a.employeeId != null)
        .slice(0, 5)
        .map((a) => ({
          _id: a._id,
          name: `${a.employeeId?.firstName || ''} ${a.employeeId?.lastName || ''}`.trim() || 'Employee',
          department: a.employeeId?.department || '—',
          designation: a.employeeId?.designation || '—',
          score: a.scores?.calculatedFinalScore || 0,
          band: a.scores?.ratingBand || 'High Performer',
        }));

      employeesRequiringSupport = scoredAppraisals
        .filter((a) => (a.scores?.calculatedFinalScore || 0) < 2.5 && (a.scores?.calculatedFinalScore || 0) > 0 && a.employeeId != null)
        .slice(0, 5)
        .map((a) => ({
          _id: a._id,
          name: `${a.employeeId?.firstName || ''} ${a.employeeId?.lastName || ''}`.trim() || 'Employee',
          department: a.employeeId?.department || '—',
          designation: a.employeeId?.designation || '—',
          score: a.scores?.calculatedFinalScore || 0,
          band: a.scores?.ratingBand || 'Needs Improvement',
        }));
    }

    // 7. Overdue Reviews (> 14 days in current pending status)
    const fourteenDaysAgo = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000);
    const overdueCount = await PmsAppraisal.countDocuments({
      ...appraisalMatch,
      status: {
        $in: [
          'self_review_pending',
          'manager_review_pending',
          'department_head_review_pending',
          'dept_head_review_pending',
          'hr_evaluation_pending',
          'final_approval_pending',
        ],
      },
      updatedAt: { $lt: fourteenDaysAgo },
    });

    // 8. Historical Performance Trends across completed cycles
    const completedCycles = await PmsCycle.find({ companyId, status: { $in: ['closed', 'published', 'completed'] } })
      .select('_id name startDate endDate')
      .sort({ startDate: 1 })
      .limit(6)
      .lean();

    const historicalTrends = [];
    for (const hc of completedCycles) {
      const hcAgg = await PmsAppraisal.aggregate([
        { $match: { companyId: new mongoose.Types.ObjectId(companyId), cycleId: hc._id } },
        {
          $group: {
            _id: null,
            total: { $sum: 1 },
            published: { $sum: { $cond: [{ $in: ['$status', ['published', 'acknowledged', 'disputed']] }, 1, 0] } },
            avgScore: { $avg: '$scores.calculatedFinalScore' },
          },
        },
      ]);
      const hcData = hcAgg[0] || { total: 0, published: 0, avgScore: 0 };
      historicalTrends.push({
        cycleId: hc._id,
        name: hc.name,
        totalParticipants: hcData.total,
        completionRate: hcData.total > 0 ? Math.round((hcData.published / hcData.total) * 100) : 0,
        averageScore: hcData.avgScore ? Number(hcData.avgScore.toFixed(2)) : 0,
      });
    }

    // 9. Goals & Feedback summaries
    const goalMatch = { companyId: new mongoose.Types.ObjectId(companyId) };
    if (effectiveCycleId) goalMatch.cycleId = effectiveCycleId;
    if (activeEmployeeIds.length > 0) goalMatch.employeeId = { $in: activeEmployeeIds };

    const [totalGoals, achievedGoals, onTrackGoals, atRiskGoals] = await Promise.all([
      PmsGoal.countDocuments(goalMatch),
      PmsGoal.countDocuments({ ...goalMatch, status: { $in: ['completed', 'achieved'] } }),
      PmsGoal.countDocuments({ ...goalMatch, status: { $in: ['in_progress', 'on_track'] } }),
      PmsGoal.countDocuments({ ...goalMatch, status: { $in: ['at_risk', 'blocked'] } }),
    ]);

    return res.status(200).json({
      success: true,
      data: {
        activeCycle: activeCycle ? { _id: activeCycle._id, name: activeCycle.name, status: activeCycle.status } : null,
        cycles: cyclesList,
        userScope: {
          scope: userScope.scope,
          isPrivileged: userScope.isPrivileged,
        },
        summary: {
          totalEligibleEmployees: activeCompanyEmployees.length,
          totalReviews,
          published: publishedCount,
          pendingReviews: Math.max(0, totalReviews - publishedCount),
          selfPending: selfPendingCount,
          managerPending: managerPendingCount,
          deptHeadPending: deptHeadPendingCount,
          hrPending: hrPendingCount,
          calibrationPending: calibrationPendingCount,
          finalApprovalPending: finalApprovalPendingCount,
          approved: approvedCount,
          acknowledged: acknowledgedCount,
          disputed: disputedCount,
          revisionsRequested: revisionCount,
          completionRate,
          averageRating,
          kpiAchievementRate,
          overdueReviews: overdueCount,
        },
        statusCounts: statusMap,
        ratingDistribution,
        ratingBands,
        departmentPerformance: deptPerformance.map((d) => ({
          department: d._id,
          averageScore: Math.round((d.averageScore || 0) * 10) / 10,
          totalEmployees: d.totalEvaluated,
        })),
        highPerformers,
        employeesRequiringSupport,
        goalSummary: {
          total: totalGoals,
          achieved: achievedGoals,
          onTrack: onTrackGoals,
          atRisk: atRiskGoals,
          achievedPercent: totalGoals > 0 ? Math.round((achievedGoals / totalGoals) * 100) : 0,
        },
        historicalTrends,
      },
    });
  } catch (err) {
    console.error('[PMS getDashboardMetrics Error]:', err);
    return res.status(500).json({ success: false, message: 'Failed to fetch analytics metrics' });
  }
};

/**
 * @desc Get Actionable PMS Reports with JSON, CSV, or Excel output
 * @route GET /api/performance/analytics/reports/:reportType
 */
const getPmsReportData = async (req, res) => {
  try {
    const { reportType } = req.params;
    const { cycleId, department, status, format = 'json', page = 1, limit = 50, search } = req.query;
    const companyId = req.companyId;

    const userScope = await resolveUserScope(req);

    // Build appraisal query with tenant isolation & scoping
    const filter = { companyId: new mongoose.Types.ObjectId(companyId) };
    if (cycleId && mongoose.Types.ObjectId.isValid(cycleId)) {
      filter.cycleId = new mongoose.Types.ObjectId(cycleId);
    }
    if (status && status !== 'all') {
      filter.status = status;
    }

    if (userScope.filterUserIds) {
      filter.employeeId = { $in: userScope.filterUserIds };
    }

    // Confidentiality control: non-privileged users cannot view unpublished scores in reports
    const canSeeUnpublished = userScope.isPrivileged || req.user?.permissions?.includes('pms.approval.final');

    let reportRows = [];
    let reportHeaders = [];
    let reportTitle = 'PMS Report';

    switch (reportType) {
      // 1. Appraisal Cycle Completion Report
      case 'cycle-completion': {
        reportTitle = 'Appraisal Cycle Completion Report';
        reportHeaders = [
          { header: 'Employee Code', key: 'code', width: 16 },
          { header: 'Employee Name', key: 'name', width: 25 },
          { header: 'Department', key: 'department', width: 20 },
          { header: 'Cycle Name', key: 'cycle', width: 25 },
          { header: 'Current Stage', key: 'stage', width: 22 },
          { header: 'Status', key: 'status', width: 22 },
          { header: 'Is Overdue (>14d)', key: 'isOverdue', width: 16 },
          { header: 'Last Action Date', key: 'lastActionDate', width: 20 },
        ];

        const appraisals = await PmsAppraisal.find(filter)
          .populate('cycleId', 'name')
          .populate('employeeId', 'firstName lastName email department employeeCode')
          .sort({ updatedAt: -1 })
          .lean();

        const fourteenDaysAgo = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000);

        reportRows = appraisals.map((a) => {
          const emp = a.employeeId || {};
          const isOverdue =
            ['self_review_pending', 'manager_review_pending', 'department_head_review_pending', 'hr_evaluation_pending', 'final_approval_pending'].includes(a.status) &&
            new Date(a.updatedAt) < fourteenDaysAgo;

          return {
            code: sanitizeCellValue(emp.employeeCode || '—'),
            name: sanitizeCellValue(`${emp.firstName || ''} ${emp.lastName || ''}`.trim() || '—'),
            department: sanitizeCellValue(emp.department || '—'),
            cycle: sanitizeCellValue(a.cycleId?.name || '—'),
            stage: sanitizeCellValue(a.currentStageKey?.replace(/_/g, ' ') || '—'),
            status: sanitizeCellValue(a.status?.replace(/_/g, ' ') || '—'),
            isOverdue: isOverdue ? 'Yes (Overdue)' : 'No',
            lastActionDate: a.updatedAt ? new Date(a.updatedAt).toISOString().slice(0, 10) : '—',
          };
        });
        break;
      }

      // 2. Employee Performance Report
      case 'employee-performance': {
        reportTitle = 'Employee Performance Summary Report';
        reportHeaders = [
          { header: 'Employee Code', key: 'code', width: 16 },
          { header: 'Employee Name', key: 'name', width: 25 },
          { header: 'Department', key: 'department', width: 20 },
          { header: 'Reporting Manager', key: 'manager', width: 25 },
          { header: 'Self Score', key: 'selfScore', width: 14 },
          { header: 'Manager Score', key: 'managerScore', width: 16 },
          { header: 'Calibrated Score', key: 'calibratedScore', width: 16 },
          { header: 'Final Score', key: 'finalScore', width: 14 },
          { header: 'Rating Band', key: 'band', width: 24 },
          { header: 'Status', key: 'status', width: 18 },
          { header: 'Published', key: 'published', width: 12 },
        ];

        const appraisals = await PmsAppraisal.find(filter)
          .populate('employeeId', 'firstName lastName department employeeCode')
          .populate('managerId', 'firstName lastName')
          .sort({ 'scores.calculatedFinalScore': -1 })
          .lean();

        reportRows = appraisals.map((a) => {
          const emp = a.employeeId || {};
          const mgr = a.managerId || {};
          const isVisible = a.isPublished || canSeeUnpublished;

          return {
            code: sanitizeCellValue(emp.employeeCode || '—'),
            name: sanitizeCellValue(`${emp.firstName || ''} ${emp.lastName || ''}`.trim() || '—'),
            department: sanitizeCellValue(emp.department || '—'),
            manager: sanitizeCellValue(`${mgr.firstName || ''} ${mgr.lastName || ''}`.trim() || '—'),
            selfScore: a.scores?.selfOverallScore || 0,
            managerScore: a.scores?.managerOverallScore || 0,
            calibratedScore: isVisible ? (a.calibration?.calibratedScore ?? '—') : 'Confidential',
            finalScore: isVisible ? (a.scores?.calculatedFinalScore || 0) : 'Pending Publication',
            band: isVisible ? sanitizeCellValue(a.scores?.ratingBand || '—') : 'Pending Publication',
            status: sanitizeCellValue(a.status?.replace(/_/g, ' ') || '—'),
            published: a.isPublished ? 'Yes' : 'No',
          };
        });
        break;
      }

      // 3. Department Performance Summary
      case 'department-summary': {
        reportTitle = 'Department Performance Summary Report';
        reportHeaders = [
          { header: 'Department', key: 'department', width: 25 },
          { header: 'Total Enrolled', key: 'total', width: 16 },
          { header: 'Published / Complete', key: 'published', width: 22 },
          { header: 'Pending Reviews', key: 'pending', width: 18 },
          { header: 'Completion %', key: 'completionRate', width: 16 },
          { header: 'Average Final Score', key: 'avgScore', width: 20 },
        ];

        const deptAgg = await PmsAppraisal.aggregate([
          { $match: filter },
          {
            $lookup: {
              from: 'users',
              localField: 'employeeId',
              foreignField: '_id',
              as: 'employee',
            },
          },
          { $unwind: '$employee' },
          {
            $group: {
              _id: { $ifNull: ['$employee.department', 'General'] },
              total: { $sum: 1 },
              published: { $sum: { $cond: [{ $in: ['$status', ['published', 'acknowledged', 'disputed']] }, 1, 0] } },
              avgScore: {
                $avg: {
                  $cond: [
                    canSeeUnpublished
                      ? { $gt: ['$scores.calculatedFinalScore', 0] }
                      : { $and: [{ $eq: ['$isPublished', true] }, { $gt: ['$scores.calculatedFinalScore', 0] }] },
                    '$scores.calculatedFinalScore',
                    null,
                  ],
                },
              },
            },
          },
          { $sort: { avgScore: -1 } },
        ]);

        reportRows = deptAgg.map((d) => ({
          department: sanitizeCellValue(d._id),
          total: d.total,
          published: d.published,
          pending: Math.max(0, d.total - d.published),
          completionRate: d.total > 0 ? `${Math.round((d.published / d.total) * 100)}%` : '0%',
          avgScore: d.avgScore ? Number(d.avgScore.toFixed(2)) : '—',
        }));
        break;
      }

      // 4. KRA/KPI Achievement Report
      case 'kpi-achievement': {
        reportTitle = 'KRA & KPI Target Achievement Report';
        reportHeaders = [
          { header: 'Employee Name', key: 'employee', width: 25 },
          { header: 'Department', key: 'department', width: 20 },
          { header: 'KRA Category', key: 'kra', width: 22 },
          { header: 'KPI Code', key: 'code', width: 16 },
          { header: 'KPI Name', key: 'kpiName', width: 28 },
          { header: 'Target Value', key: 'target', width: 14 },
          { header: 'Actual Value', key: 'actual', width: 14 },
          { header: 'Achievement %', key: 'achievement', width: 16 },
          { header: 'Manager Rating', key: 'managerRating', width: 16 },
        ];

        const kpiQuery = { companyId: new mongoose.Types.ObjectId(companyId) };
        if (filter.cycleId) kpiQuery.cycleId = filter.cycleId;
        if (filter.employeeId) kpiQuery.employeeId = filter.employeeId;

        const kpis = await PmsKpi.find(kpiQuery)
          .populate('employeeId', 'firstName lastName department')
          .populate('kraId', 'name category')
          .limit(500)
          .lean();

        reportRows = kpis.map((k) => {
          const emp = k.employeeId || {};
          const target = k.targetValue || 0;
          const actual = k.actualValue || 0;
          let ach = 0;
          if (target > 0) {
            ach = Math.round((actual / target) * 100);
          } else if (k.measurementDirection === 'lower_is_better') {
            ach = actual <= 0 ? 100 : 0;
          }

          return {
            employee: sanitizeCellValue(`${emp.firstName || ''} ${emp.lastName || ''}`.trim() || '—'),
            department: sanitizeCellValue(emp.department || '—'),
            kra: sanitizeCellValue(k.kraId?.name || k.kraId?.category || 'General'),
            code: sanitizeCellValue(k.code || '—'),
            kpiName: sanitizeCellValue(k.title || k.name || '—'),
            target,
            actual,
            achievement: `${ach}%`,
            managerRating: k.managerRating || '—',
          };
        });
        break;
      }

      // 5. Rating Distribution Report
      case 'rating-distribution': {
        reportTitle = 'Workforce Rating Distribution Report';
        reportHeaders = [
          { header: 'Rating Band / Grade', key: 'band', width: 25 },
          { header: 'Score Range', key: 'scoreRange', width: 18 },
          { header: 'Employee Count', key: 'count', width: 16 },
          { header: 'Percentage of Workforce', key: 'percentage', width: 24 },
        ];

        const bandCounts = await PmsAppraisal.aggregate([
          { $match: { ...filter, 'scores.calculatedFinalScore': { $gt: 0 }, ...(canSeeUnpublished ? {} : { isPublished: true }) } },
          {
            $project: {
              band: {
                $switch: {
                  branches: [
                    { case: { $gte: ['$scores.calculatedFinalScore', 4.5] }, then: 'Outstanding (Grade A)' },
                    { case: { $gte: ['$scores.calculatedFinalScore', 3.8] }, then: 'Exceeds Expectations (Grade B)' },
                    { case: { $gte: ['$scores.calculatedFinalScore', 3.0] }, then: 'Meets Expectations (Grade C)' },
                    { case: { $gte: ['$scores.calculatedFinalScore', 2.0] }, then: 'Needs Improvement (Grade D)' },
                  ],
                  default: 'Unsatisfactory (Grade E)',
                },
              },
            },
          },
          { $group: { _id: '$band', count: { $sum: 1 } } },
          { $sort: { count: -1 } },
        ]);

        const totalScored = bandCounts.reduce((acc, curr) => acc + curr.count, 0) || 1;
        reportRows = bandCounts.map((b) => ({
          band: sanitizeCellValue(b._id),
          scoreRange: b._id.includes('Grade A') ? '4.50 - 5.00' : b._id.includes('Grade B') ? '3.80 - 4.49' : b._id.includes('Grade C') ? '3.00 - 3.79' : b._id.includes('Grade D') ? '2.00 - 2.99' : '< 2.00',
          count: b.count,
          percentage: `${Math.round((b.count / totalScored) * 100)}%`,
        }));
        break;
      }

      // 6. Pending Reviews and Overdue Actions Report
      case 'pending-reviews': {
        reportTitle = 'Pending Reviews & Overdue Actions Report';
        reportHeaders = [
          { header: 'Employee Name', key: 'employee', width: 25 },
          { header: 'Department', key: 'department', width: 20 },
          { header: 'Pending Stage', key: 'stage', width: 24 },
          { header: 'Assigned Action Role', key: 'role', width: 24 },
          { header: 'Days In Stage', key: 'daysInStage', width: 16 },
          { header: 'Overdue Status', key: 'isOverdue', width: 18 },
        ];

        const pendingAppraisals = await PmsAppraisal.find({
          ...filter,
          status: {
            $in: [
              'self_review_pending',
              'manager_review_pending',
              'department_head_review_pending',
              'dept_head_review_pending',
              'hr_evaluation_pending',
              'final_approval_pending',
            ],
          },
        })
          .populate('employeeId', 'firstName lastName department')
          .sort({ updatedAt: 1 })
          .lean();

        reportRows = pendingAppraisals.map((a) => {
          const emp = a.employeeId || {};
          const daysInStage = Math.max(0, Math.floor((Date.now() - new Date(a.updatedAt).getTime()) / (1000 * 60 * 60 * 24)));
          const roleMap = {
            self_review_pending: 'Employee',
            manager_review_pending: 'Reporting Manager',
            department_head_review_pending: 'Department Head',
            dept_head_review_pending: 'Department Head',
            hr_evaluation_pending: 'HR Evaluator',
            final_approval_pending: 'Leadership Approver',
          };

          return {
            employee: sanitizeCellValue(`${emp.firstName || ''} ${emp.lastName || ''}`.trim() || '—'),
            department: sanitizeCellValue(emp.department || '—'),
            stage: sanitizeCellValue(a.currentStageKey?.replace(/_/g, ' ') || '—'),
            role: roleMap[a.status] || 'Reviewer',
            daysInStage: `${daysInStage} days`,
            isOverdue: daysInStage > 14 ? 'YES (OVERDUE)' : 'Normal',
          };
        });
        break;
      }

      // 7. Appraisal Acknowledgment & Dispute Report
      case 'acknowledgment-dispute': {
        reportTitle = 'Appraisal Acknowledgment & Dispute Report';
        reportHeaders = [
          { header: 'Employee Name', key: 'employee', width: 25 },
          { header: 'Department', key: 'department', width: 20 },
          { header: 'Final Score', key: 'score', width: 14 },
          { header: 'Rating Band', key: 'band', width: 22 },
          { header: 'Status', key: 'status', width: 18 },
          { header: 'Acknowledged Date', key: 'ackDate', width: 20 },
          { header: 'Dispute Reason', key: 'disputeReason', width: 35 },
          { header: 'Employee Feedback', key: 'comments', width: 35 },
        ];

        const publishedAppraisals = await PmsAppraisal.find({
          ...filter,
          isPublished: true,
        })
          .populate('employeeId', 'firstName lastName department')
          .sort({ updatedAt: -1 })
          .lean();

        reportRows = publishedAppraisals.map((a) => {
          const emp = a.employeeId || {};
          return {
            employee: sanitizeCellValue(`${emp.firstName || ''} ${emp.lastName || ''}`.trim() || '—'),
            department: sanitizeCellValue(emp.department || '—'),
            score: a.scores?.calculatedFinalScore || 0,
            band: sanitizeCellValue(a.scores?.ratingBand || '—'),
            status: sanitizeCellValue(a.status?.replace(/_/g, ' ') || '—'),
            ackDate: a.acknowledgement?.acknowledgedAt ? new Date(a.acknowledgement.acknowledgedAt).toISOString().slice(0, 10) : 'Pending',
            disputeReason: sanitizeCellValue(a.acknowledgement?.disputeReason || '—'),
            comments: sanitizeCellValue(a.acknowledgement?.employeeComments || '—'),
          };
        });
        break;
      }

      // 8. Historical Performance Comparison Report
      case 'historical-comparison': {
        reportTitle = 'Multi-Cycle Historical Performance Comparison';
        reportHeaders = [
          { header: 'Employee Name', key: 'employee', width: 25 },
          { header: 'Department', key: 'department', width: 20 },
          { header: 'Cycle Name', key: 'cycle', width: 24 },
          { header: 'Final Score', key: 'score', width: 14 },
          { header: 'Rating Band', key: 'band', width: 22 },
          { header: 'Published Date', key: 'publishedDate', width: 18 },
        ];

        const historicalAppraisals = await PmsAppraisal.find({
          companyId,
          ...(userScope.filterUserIds ? { employeeId: { $in: userScope.filterUserIds } } : {}),
          isPublished: true,
        })
          .populate('cycleId', 'name startDate')
          .populate('employeeId', 'firstName lastName department')
          .sort({ 'cycleId.startDate': -1 })
          .limit(500)
          .lean();

        reportRows = historicalAppraisals.map((a) => {
          const emp = a.employeeId || {};
          return {
            employee: sanitizeCellValue(`${emp.firstName || ''} ${emp.lastName || ''}`.trim() || '—'),
            department: sanitizeCellValue(emp.department || '—'),
            cycle: sanitizeCellValue(a.cycleId?.name || '—'),
            score: a.scores?.calculatedFinalScore || 0,
            band: sanitizeCellValue(a.scores?.ratingBand || '—'),
            publishedDate: a.publishedAt ? new Date(a.publishedAt).toISOString().slice(0, 10) : '—',
          };
        });
        break;
      }

      default:
        return res.status(400).json({ success: false, message: `Unknown report type "${reportType}".` });
    }

    // Filter by search term if provided
    if (search && search.trim()) {
      const q = search.trim().toLowerCase();
      reportRows = reportRows.filter((r) => {
        return Object.values(r).some((v) => String(v).toLowerCase().includes(q));
      });
    }

    // Export formats
    if (format === 'csv') {
      await logPmsAudit({
        companyId,
        userId: req.user._id,
        action: 'PMS_REPORT_EXPORTED',
        entityType: 'PmsReport',
        changes: { reportType, format: 'csv', count: reportRows.length },
      });

      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename=PMS_${reportType}_${Date.now()}.csv`);

      const csvHeader = reportHeaders.map((h) => `"${h.header}"`).join(',');
      const csvLines = reportRows.map((row) => {
        return reportHeaders.map((h) => `"${String(row[h.key] ?? '').replace(/"/g, '""')}"`).join(',');
      });

      return res.status(200).send([csvHeader, ...csvLines].join('\r\n'));
    }

    if (format === 'xlsx') {
      await logPmsAudit({
        companyId,
        userId: req.user._id,
        action: 'PMS_REPORT_EXPORTED',
        entityType: 'PmsReport',
        changes: { reportType, format: 'xlsx', count: reportRows.length },
      });

      const workbook = new ExcelJS.Workbook();
      workbook.creator = 'TalentCIO PMS';
      workbook.created = new Date();

      const sheet = workbook.addWorksheet(reportTitle.slice(0, 31));
      sheet.columns = reportHeaders;

      // Header row styling
      sheet.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
      sheet.getRow(1).fill = {
        type: 'pattern',
        pattern: 'solid',
        fgColor: { argb: 'FF1E293B' },
      };

      reportRows.forEach((r) => sheet.addRow(r));

      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition', `attachment; filename=PMS_${reportType}_${Date.now()}.xlsx`);

      await workbook.xlsx.write(res);
      return res.end();
    }

    // JSON response for UI viewing
    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const limitNum = Math.min(200, Math.max(1, parseInt(limit, 10) || 50));
    const paginatedRows = reportRows.slice((pageNum - 1) * limitNum, pageNum * limitNum);

    return res.status(200).json({
      success: true,
      data: {
        reportType,
        reportTitle,
        headers: reportHeaders,
        records: paginatedRows,
        totalRecords: reportRows.length,
        page: pageNum,
        totalPages: Math.ceil(reportRows.length / limitNum) || 1,
      },
    });
  } catch (err) {
    console.error('[PMS getPmsReportData Error]:', err);
    return res.status(500).json({ success: false, message: 'Failed to generate performance report' });
  }
};

/**
 * @desc Trigger automated appraisal reminders on-demand (admin/HR or test runner)
 * @route POST /api/performance/analytics/reminders/trigger
 */
const triggerManualReminders = async (req, res) => {
  try {
    const isAdmin = isUserAdminOrSuper(req.user);
    const isHr = isUserHr(req.user);
    if (!isAdmin && !isHr) {
      return res.status(403).json({ success: false, message: 'Only HR or Administrators can trigger automated reminders.' });
    }

    const { dryRun } = req.body;
    const result = await runPmsRemindersJob({
      companyId: req.companyId,
      io: req.app?.get('io'),
      dryRun: Boolean(dryRun),
    });

    await logPmsAudit({
      companyId: req.companyId,
      userId: req.user._id,
      action: 'PMS_REMINDERS_TRIGGERED',
      entityType: 'PmsNotification',
      changes: result,
    });

    return res.status(200).json({
      success: true,
      message: `Automated reminders job executed: ${result.dispatchedReminders} dispatched, ${result.skippedDeduplicated} deduplicated.`,
      data: result,
    });
  } catch (err) {
    console.error('[PMS triggerManualReminders Error]:', err);
    return res.status(500).json({ success: false, message: 'Failed to trigger reminders' });
  }
};

module.exports = {
  getDashboardMetrics,
  getPmsReportData,
  triggerManualReminders,
  sanitizeCellValue,
};
