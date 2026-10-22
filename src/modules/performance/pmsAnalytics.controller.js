const mongoose = require('mongoose');
const ExcelJS = require('exceljs');
const PmsCycle = require('./models/pmsCycle.model');
const PmsAppraisal = require('./models/pmsAppraisal.model');
const PmsGoal = require('./models/pmsGoal.model');
const PmsKra = require('./models/pmsKra.model');
const PmsSetting = require('./models/pmsSetting.model');
const User = require('../user/user.model');
const { isUserAdminOrSuper, isUserHr } = require('./services/pmsWorkflow.service');

/**
 * @desc Get comprehensive PMS dashboard analytics
 * @route GET /api/performance/analytics/dashboard
 */
const getDashboardMetrics = async (req, res) => {
  try {
    const companyId = req.companyId;
    const { cycleId } = req.query;

    const cyclesList = await PmsCycle.find({ companyId }).select('_id name status cycleType startDate endDate').sort({ startDate: -1 }).lean();

    let activeCycle = null;
    let effectiveCycleId = null;

    if (cycleId === 'all') {
      // Company-wide aggregated overview across all cycles
      effectiveCycleId = null;
      activeCycle = null;
    } else if (cycleId && mongoose.Types.ObjectId.isValid(cycleId)) {
      activeCycle = await PmsCycle.findOne({ _id: new mongoose.Types.ObjectId(cycleId), companyId }).lean();
      effectiveCycleId = activeCycle?._id || null;
    } else {
      // Find currently active evaluation cycle
      activeCycle = await PmsCycle.findOne({
        companyId,
        status: { $in: ['in_progress', 'self_review', 'manager_review', 'goal_setting', 'peer_feedback', 'calibration', 'published'] },
      }).sort({ startDate: -1 }).lean();

      // If no active cycle in evaluation, fall back to the most recent cycle
      if (!activeCycle) {
        activeCycle = await PmsCycle.findOne({ companyId }).sort({ createdAt: -1 }).lean();
      }
      effectiveCycleId = activeCycle?._id || null;
    }

    // Fetch strictly active, non-deleted employees for the company
    const activeCompanyEmployees = await User.find({
      companyId,
      isActive: true,
      isDeleted: { $ne: true },
      status: { $nin: ['deleted', 'inactive', 'terminated', 'Inactive', 'Terminated'] },
    }).select('_id').lean();
    const activeEmployeeIds = activeCompanyEmployees.map((e) => e._id);

    const appraisalMatch = {
      companyId: new mongoose.Types.ObjectId(companyId),
      employeeId: { $in: activeEmployeeIds },
    };
    if (effectiveCycleId) appraisalMatch.cycleId = new mongoose.Types.ObjectId(effectiveCycleId);

    const isAdmin = isUserAdminOrSuper(req.user);
    const isHr = isUserHr(req.user) || req.user?.permissions?.includes('pms.view.all');
    const hasAnalyticsPerm = req.user?.permissions?.includes('pms.analytics.view');
    const isPrivileged = isAdmin || isHr || hasAnalyticsPerm;

    let scopedEmployeeCount = 1;

    // Server-side scope isolation: non-admin/HR users only see their direct reports or self
    if (!isPrivileged) {
      const directReports = await User.find({
        reportingManagers: req.user._id,
        companyId,
        isActive: true,
        isDeleted: { $ne: true },
        status: { $nin: ['deleted', 'inactive', 'terminated', 'Inactive', 'Terminated'] },
      }).select('_id').lean();
      const reportIds = directReports.map((d) => d._id);
      if (reportIds.length > 0) {
        appraisalMatch.employeeId = { $in: reportIds };
        scopedEmployeeCount = reportIds.length;
      } else {
        appraisalMatch.employeeId = new mongoose.Types.ObjectId(req.user._id);
        scopedEmployeeCount = 1;
      }
    } else {
      scopedEmployeeCount = activeCompanyEmployees.length;
    }

    // 1. Appraisal status counts (only for active employees in scope)
    const statusCounts = await PmsAppraisal.aggregate([
      { $match: appraisalMatch },
      { $group: { _id: '$status', count: { $sum: 1 } } },
    ]);

    let totalReviews = 0;
    let published = 0;
    let selfPending = 0;
    let managerPending = 0;
    let calibrationPending = 0;

    statusCounts.forEach((s) => {
      totalReviews += s.count;
      if (s._id === 'published' || s._id === 'acknowledged') published += s.count;
      if (s._id === 'self_review_pending') selfPending += s.count;
      if (s._id === 'manager_review_pending') managerPending += s.count;
      if (s._id === 'calibration_pending') calibrationPending += s.count;
    });

    const totalEmployeesInScope = isPrivileged ? activeCompanyEmployees.length : (scopedEmployeeCount || totalReviews || 1);

    const completionRate = totalReviews > 0 ? Math.round((published / totalReviews) * 100) : 0;

    // Real average rating across all scored appraisals
    const avgRatingAgg = await PmsAppraisal.aggregate([
      { $match: { ...appraisalMatch, 'scores.calculatedFinalScore': { $gt: 0 } } },
      { $group: { _id: null, avg: { $avg: '$scores.calculatedFinalScore' } } },
    ]);
    const averageRating = avgRatingAgg[0]?.avg ? Number(avgRatingAgg[0].avg.toFixed(1)) : 0;

    // 2. Rating distribution (1 to 5 Stars) from real appraisals
    const scoreAgg = await PmsAppraisal.aggregate([
      { $match: { ...appraisalMatch, 'scores.calculatedFinalScore': { $gt: 0 } } },
      { $group: { _id: { $round: ['$scores.calculatedFinalScore', 0] }, count: { $sum: 1 } } },
    ]);
    const scoreMap = new Map(scoreAgg.map((s) => [Number(s._id), s.count]));

    const ratingDistribution = [1, 2, 3, 4, 5].map((star) => ({
      rating: String(star),
      count: scoreMap.get(star) || 0,
    }));

    // 3. Department performance averages from real users
    const deptPerformance = await PmsAppraisal.aggregate([
      { $match: { ...appraisalMatch, 'scores.calculatedFinalScore': { $gt: 0 } } },
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
          totalEmployees: { $sum: 1 },
        },
      },
      { $sort: { averageScore: -1 } },
      { $limit: 10 },
    ]);

    // 4. Goal progress distribution from real goals
    const goalMatch = { companyId: new mongoose.Types.ObjectId(companyId) };
    if (effectiveCycleId) goalMatch.cycleId = effectiveCycleId;

    const [totalGoals, achievedGoals, onTrackGoals, atRiskGoals] = await Promise.all([
      PmsGoal.countDocuments(goalMatch),
      PmsGoal.countDocuments({ ...goalMatch, status: { $in: ['completed', 'achieved'] } }),
      PmsGoal.countDocuments({ ...goalMatch, status: { $in: ['in_progress', 'on_track'] } }),
      PmsGoal.countDocuments({ ...goalMatch, status: { $in: ['at_risk', 'blocked'] } }),
    ]);

    const notStartedGoals = Math.max(0, totalGoals - (achievedGoals + onTrackGoals + atRiskGoals));
    const goalAchievedPercent = totalGoals > 0 ? Math.round((achievedGoals / totalGoals) * 100) : 0;

    // 5. Top performers from real appraisals (strictly active employees)
    let topPerformers = await PmsAppraisal.find({
      ...appraisalMatch,
      'scores.calculatedFinalScore': { $gt: 0 },
    })
      .populate({
        path: 'employeeId',
        match: {
          isActive: true,
          isDeleted: { $ne: true },
          status: { $nin: ['deleted', 'inactive', 'terminated', 'Inactive', 'Terminated'] },
        },
        select: 'firstName lastName name department designation profilePicture email employeeId',
      })
      .sort({ 'scores.calculatedFinalScore': -1 })
      .limit(10)
      .lean();

    topPerformers = topPerformers.filter((p) => p.employeeId != null).slice(0, 5);

    if (topPerformers.length === 0) {
      const sampleUsers = await User.find({
        companyId,
        isActive: true,
        isDeleted: { $ne: true },
        status: { $nin: ['deleted', 'inactive', 'terminated', 'Inactive', 'Terminated'] },
      })
        .select('firstName lastName name department designation profilePicture email employeeId')
        .limit(4)
        .lean();

      topPerformers = sampleUsers.map((u) => ({
        _id: u._id,
        employeeId: u,
        scores: { calculatedFinalScore: 0, ratingBand: 'Pending Review' },
      }));
    }

    // 6. 360 Feedback metrics from real PmsContinuousFeedback
    const PmsContinuousFeedback = require('./models/pmsContinuousFeedback.model');
    const [totalFeedbacks, appreciationCount, constructiveCount, meetingCount] = await Promise.all([
      PmsContinuousFeedback.countDocuments({ companyId }),
      PmsContinuousFeedback.countDocuments({ companyId, feedbackType: 'appreciation' }),
      PmsContinuousFeedback.countDocuments({ companyId, feedbackType: 'constructive' }),
      PmsContinuousFeedback.countDocuments({ companyId, feedbackType: '1on1_meeting' }),
    ]);

    // 7. Talent performance bands from real appraisals
    const [highPerformersCount, meetsCount, needsImpCount, lowPerfCount] = await Promise.all([
      PmsAppraisal.countDocuments({ ...appraisalMatch, 'scores.calculatedFinalScore': { $gte: 4.5 } }),
      PmsAppraisal.countDocuments({ ...appraisalMatch, 'scores.calculatedFinalScore': { $gte: 3.0, $lt: 4.5 } }),
      PmsAppraisal.countDocuments({ ...appraisalMatch, 'scores.calculatedFinalScore': { $gte: 2.0, $lt: 3.0 } }),
      PmsAppraisal.countDocuments({ ...appraisalMatch, 'scores.calculatedFinalScore': { $gt: 0, $lt: 2.0 } }),
    ]);

    return res.status(200).json({
      success: true,
      data: {
        activeCycle: activeCycle ? { _id: activeCycle._id, name: activeCycle.name, status: activeCycle.status } : null,
        cycles: cyclesList,
        summary: {
          totalEmployees: totalEmployeesInScope,
          totalReviews,
          published,
          pendingReviews: Math.max(0, totalReviews - published),
          selfPending,
          managerPending,
          calibrationPending,
          completionRate,
          averageRating,
        },
        ratingDistribution,
        departmentPerformance: deptPerformance.map((d) => ({
          department: d._id,
          averageScore: Math.round((d.averageScore || 0) * 10) / 10,
          totalEmployees: d.totalEmployees,
        })),
        goalSummary: {
          total: totalGoals,
          achieved: achievedGoals,
          onTrack: onTrackGoals,
          atRisk: atRiskGoals,
          notStarted: notStartedGoals,
          achievedPercent: goalAchievedPercent,
        },
        topPerformers: topPerformers.map((tp) => {
          const emp = tp.employeeId || {};
          const name = emp.firstName && emp.lastName ? `${emp.firstName} ${emp.lastName}` : (emp.name || emp.email || 'Employee');
          return {
            _id: tp._id,
            name,
            role: emp.designation || emp.department || 'Team Member',
            score: tp.scores?.calculatedFinalScore || 0,
            band: tp.scores?.ratingBand || 'Pending Review',
          };
        }),
        feedbackStats: {
          total: totalFeedbacks,
          appreciation: appreciationCount,
          constructive: constructiveCount,
          meetings: meetingCount,
        },
        talentBands: {
          high: highPerformersCount,
          meets: meetsCount,
          needsImp: needsImpCount,
          low: lowPerfCount,
          totalScored: highPerformersCount + meetsCount + needsImpCount + lowPerfCount,
        },
      },
    });
  } catch (err) {
    console.error('[PMS getDashboardMetrics Error]:', err);
    return res.status(500).json({ success: false, message: 'Failed to fetch analytics metrics' });
  }
};

/**
 * @desc Export appraisals to Excel workbook
 * @route GET /api/performance/analytics/export
 */
const exportAppraisalsExcel = async (req, res) => {
  try {
    const companyId = req.companyId;
    const { cycleId } = req.query;

    const filter = { companyId };
    if (cycleId) filter.cycleId = cycleId;

    const isAdmin = isUserAdminOrSuper(req.user);
    const isHr = isUserHr(req.user);
    const hasReportsPerm = req.user?.permissions?.includes('pms.reports.view');

    // Scope check: If not admin/HR, user can only export their direct reports
    if (!isAdmin && !isHr && !hasReportsPerm) {
      const directReports = await User.find({
        reportingManagers: req.user._id,
        companyId,
        isActive: true,
        isDeleted: { $ne: true },
        status: { $nin: ['deleted', 'inactive', 'terminated', 'Inactive', 'Terminated'] },
      }).select('_id').lean();
      const reportIds = directReports.map((d) => d._id);
      if (reportIds.length === 0) {
        return res.status(403).json({ success: false, message: 'Unauthorized: You do not have permission to export organizational appraisal records.' });
      }
      filter.employeeId = { $in: reportIds };
    }

    const rawAppraisals = await PmsAppraisal.find(filter)
      .populate('cycleId', 'name')
      .populate({
        path: 'employeeId',
        match: {
          isActive: true,
          isDeleted: { $ne: true },
          status: { $nin: ['deleted', 'inactive', 'terminated', 'Inactive', 'Terminated'] },
        },
        select: 'firstName lastName email department employeeCode',
      })
      .populate('managerId', 'firstName lastName')
      .sort({ createdAt: -1 })
      .lean();

    const appraisals = rawAppraisals.filter((a) => a.employeeId != null);

    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'TalentCIO PMS';
    workbook.created = new Date();

    const sheet = workbook.addWorksheet('Appraisal Summary');
    sheet.columns = [
      { header: 'Employee Code', key: 'code', width: 15 },
      { header: 'Employee Name', key: 'name', width: 25 },
      { header: 'Email', key: 'email', width: 28 },
      { header: 'Department', key: 'department', width: 20 },
      { header: 'Manager', key: 'manager', width: 22 },
      { header: 'Cycle Name', key: 'cycle', width: 22 },
      { header: 'Status', key: 'status', width: 20 },
      { header: 'Self Score', key: 'selfScore', width: 12 },
      { header: 'Manager Score', key: 'managerScore', width: 14 },
      { header: 'Calibrated Score', key: 'calibratedScore', width: 16 },
      { header: 'Final Score', key: 'finalScore', width: 12 },
      { header: 'Rating Band', key: 'band', width: 25 },
      { header: 'Published', key: 'published', width: 12 },
    ];

    sheet.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
    sheet.getRow(1).fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'FF1E293B' },
    };

    const canSeeUnpublished = isAdmin || isHr || req.user?.permissions?.includes('pms.approval.final');

    appraisals.forEach((app) => {
      const isVisible = app.isPublished || canSeeUnpublished;
      sheet.addRow({
        code: app.employeeId?.employeeCode || '—',
        name: `${app.employeeId?.firstName || ''} ${app.employeeId?.lastName || ''}`.trim() || '—',
        email: app.employeeId?.email || '—',
        department: app.employeeId?.department || '—',
        manager: `${app.managerId?.firstName || ''} ${app.managerId?.lastName || ''}`.trim() || '—',
        cycle: app.cycleId?.name || '—',
        status: app.status.replace(/_/g, ' '),
        selfScore: app.scores?.selfOverallScore || 0,
        managerScore: app.scores?.managerOverallScore || 0,
        calibratedScore: isVisible ? (app.calibration?.calibratedScore ?? '—') : 'Confidential',
        finalScore: isVisible ? (app.scores?.calculatedFinalScore || 0) : 'Pending Publication',
        band: isVisible ? (app.scores?.ratingBand || '—') : 'Pending Publication',
        published: app.isPublished ? 'Yes' : 'No',
      });
    });

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename=PMS_Appraisals_${Date.now()}.xlsx`);

    await workbook.xlsx.write(res);
    res.end();
  } catch (err) {
    console.error('[PMS exportAppraisalsExcel Error]:', err);
    return res.status(500).json({ success: false, message: 'Failed to generate Excel export' });
  }
};

module.exports = {
  getDashboardMetrics,
  exportAppraisalsExcel,
};
