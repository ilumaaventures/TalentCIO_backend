const express = require('express');
const router = express.Router();
const { protect } = require('../../common/middleware/authMiddleware');
const { authorize } = require('../../common/middleware/authorize');
const { requireModule } = require('../../common/middleware/moduleGuard');

// Legacy project performance controllers
const {
  getProjectPerformance,
  getProjectMemberPerformance,
  getEmployeePerformance,
} = require('./performance.controller');

// PMS Controllers
const {
  listCycles,
  getCycle,
  createCycle,
  updateCycle,
  deleteCycle,
  changeCycleStatus,
  reopenCycle,
  syncCycleParticipants,
} = require('./pmsCycle.controller');

const {
  listKras,
  createKra,
  updateKra,
  deleteKra,
  listKpis,
  createKpi,
  updateKpi,
  submitKpiEvidence,
  verifyKpi,
} = require('./pmsKraKpi.controller');

// Department-wise KPI Templates & Assignment Controllers
const {
  listKpiTemplates,
  getKpiTemplateById,
  createKpiTemplate,
  updateKpiTemplate,
  changeKpiTemplateStatus,
  deleteKpiTemplate,
  getKpisByKra,
  assignKpisToEmployees,
  listAssignedKpis,
  evaluateAssignedKpi,
  getPmsMetadata,
} = require('./pmsKpiTemplate.controller');

const {
  listGoals,
  getGoalTree,
  createGoal,
  updateGoal,
  checkInGoal,
  approveOrRejectGoal,
} = require('./pmsGoal.controller');

const {
  listCompetencies,
  createCompetency,
  updateCompetency,
  deleteCompetency,
} = require('./pmsCompetency.controller');

const {
  listAppraisals,
  getAppraisalDetails,
  saveSelfAppraisal,
  saveManagerAppraisal,
  nominate360Reviewers,
  submit360Feedback,
  calibrateRating,
  saveDepartmentHeadReview,
  saveHrEvaluation,
  saveFinalApproval,
  requestAppraisalRevision,
  publishAppraisals,
  acknowledgeAppraisal,
  delegateReview,
  reassignReviewer,
  reopenAppraisal,
} = require('./pmsAppraisal.controller');

const {
  listFeedbacks,
  giveFeedback,
  create1on1Meeting,
  toggleActionItem,
} = require('./pmsContinuousFeedback.controller');

const {
  listPips,
  createPip,
  addPipCheckpoint,
  updatePipStatus,
  listDevPlans,
  createDevPlan,
  updateDevPlanObjective,
} = require('./pmsPipDev.controller');

const {
  getDashboardMetrics,
  getPmsReportData,
  triggerManualReminders,
} = require('./pmsAnalytics.controller');

const {
  getPmsSettings,
  updatePmsSettings,
} = require('./pmsConfig.controller');

// All performance routes require authenticated session
router.use(protect);

// ─── Legacy Project Performance Endpoints ─────────────────────────────────────
const projectGuard = requireModule(['projects', 'timesheet', 'attendance']);
router.get('/projects/:id', projectGuard, getProjectPerformance);
router.get('/projects/:id/:userId', projectGuard, getProjectMemberPerformance);
router.get('/users/:id', projectGuard, getEmployeePerformance);

// ─── PMS Module Tenant Guard ──────────────────────────────────────────────────
// Ensures company has performance / pms module enabled by SuperAdmin
const pmsGuard = requireModule(['performance', 'pms']);
router.use((req, res, next) => {
  if (req.path.startsWith('/projects/') || req.path.startsWith('/users/')) {
    return next();
  }
  return pmsGuard(req, res, next);
});

// ─── Performance Cycles ───────────────────────────────────────────────────────
router.get('/cycles', listCycles);
router.get('/cycles/:id', getCycle);
router.post('/cycles', authorize('pms.cycle.manage', 'pms.admin', 'pms.can.edit.all'), createCycle);
router.put('/cycles/:id', authorize('pms.cycle.manage', 'pms.admin', 'pms.can.edit.all'), updateCycle);
router.delete('/cycles/:id', authorize('pms.cycle.manage', 'pms.admin', 'pms.can.edit.all'), deleteCycle);
router.patch('/cycles/:id/status', authorize('pms.cycle.manage', 'pms.admin', 'pms.can.edit.all'), changeCycleStatus);
router.post('/cycles/:id/reopen', authorize('pms.cycle.manage', 'pms.admin', 'pms.can.edit.all'), reopenCycle);
router.post('/cycles/:id/sync-participants', authorize('pms.cycle.manage', 'pms.admin', 'pms.can.edit.all'), syncCycleParticipants);

// ─── KRAs & KPIs ──────────────────────────────────────────────────────────────
router.get('/kras', listKras);
router.post('/kras', authorize('pms.kra.manage', 'pms.admin', 'pms.can.edit.all'), createKra);
router.put('/kras/:id', authorize('pms.kra.manage', 'pms.admin', 'pms.can.edit.all'), updateKra);
router.delete('/kras/:id', authorize('pms.kra.manage', 'pms.admin', 'pms.can.edit.all'), deleteKra);

router.get('/kpis', listKpis);
router.post('/kpis', authorize('pms.kpi.manage', 'pms.admin', 'pms.can.edit.all'), createKpi);
router.put('/kpis/:id', authorize('pms.kpi.manage', 'pms.admin', 'pms.can.edit.all'), updateKpi);
router.post('/kpis/:id/evidence', submitKpiEvidence);
router.post('/kpis/:id/verify', authorize('pms.kpi.manage', 'pms.admin', 'pms.can.edit.all'), verifyKpi);

// ─── Department-wise KPI Templates & Assignment ─────────────────────────────
router.get('/kpi-templates', listKpiTemplates);
router.post('/kpi-templates', authorize('pms.kpi.manage', 'pms.kra.manage', 'pms.admin', 'pms.can.edit.all'), createKpiTemplate);
router.get('/kpi-templates/:id', getKpiTemplateById);
router.put('/kpi-templates/:id', authorize('pms.kpi.manage', 'pms.kra.manage', 'pms.admin', 'pms.can.edit.all'), updateKpiTemplate);
router.delete('/kpi-templates/:id', authorize('pms.kpi.manage', 'pms.kra.manage', 'pms.admin', 'pms.can.edit.all'), deleteKpiTemplate);
router.patch('/kpi-templates/:id/status', authorize('pms.kpi.manage', 'pms.kra.manage', 'pms.admin', 'pms.can.edit.all'), changeKpiTemplateStatus);

// Linked KPIs under a specific KRA with weightage summary
router.get('/kras/:id/kpis', getKpisByKra);

// Employee KPI Assignments & Evaluation
router.post('/kpis/assign', authorize('pms.kpi.manage', 'pms.kra.manage', 'pms.admin', 'pms.can.edit.all'), assignKpisToEmployees);
router.get('/kpis/assignments', listAssignedKpis);
router.put('/kpis/assignments/:id/evaluation', evaluateAssignedKpi);

// Performance Management Metadata (departments, designations, KRAs, cycles, users)
router.get('/meta/options', getPmsMetadata);

// ─── Goals & OKRs ─────────────────────────────────────────────────────────────
router.get('/goals', listGoals);
router.get('/goals/tree', getGoalTree);
router.post('/goals', createGoal);
router.put('/goals/:id', updateGoal);
router.post('/goals/:id/check-in', checkInGoal);
router.post('/goals/:id/approve', approveOrRejectGoal);

// ─── Competency Framework ─────────────────────────────────────────────────────
router.get('/competencies', listCompetencies);
router.post('/competencies', authorize('pms.admin', 'pms.can.edit.all'), createCompetency);
router.put('/competencies/:id', authorize('pms.admin', 'pms.can.edit.all'), updateCompetency);
router.delete('/competencies/:id', authorize('pms.admin', 'pms.can.edit.all'), deleteCompetency);

// ─── Appraisals & Reviews ─────────────────────────────────────────────────────
router.get('/appraisals', listAppraisals);
router.get('/appraisals/:id', getAppraisalDetails);
router.post('/appraisals/:id/self', saveSelfAppraisal);
router.post('/appraisals/:id/manager', saveManagerAppraisal);
router.post('/appraisals/:id/department-head', saveDepartmentHeadReview);
router.post('/appraisals/:id/hr-evaluation', saveHrEvaluation);
router.post('/appraisals/:id/final-approval', saveFinalApproval);
router.post('/appraisals/:id/request-revision', requestAppraisalRevision);
router.post('/appraisals/:id/delegate', delegateReview);
router.post('/appraisals/:id/reassign', reassignReviewer);
router.post('/appraisals/:id/reopen', authorize('pms.cycle.manage', 'pms.admin', 'pms.can.edit.all'), reopenAppraisal);
router.post('/appraisals/:id/nominate-360', nominate360Reviewers);
router.post('/appraisals/:id/submit-360', submit360Feedback);
router.post('/appraisals/:id/calibrate', authorize('pms.calibration.manage', 'pms.admin', 'pms.can.edit.all'), calibrateRating);
router.post('/appraisals/publish', authorize('pms.ratings.publish', 'pms.admin', 'pms.can.edit.all'), publishAppraisals);
router.post('/appraisals/:id/acknowledge', acknowledgeAppraisal);

// ─── Continuous Feedback & 1-on-1s ───────────────────────────────────────────
router.get('/feedback', listFeedbacks);
router.post('/feedback', giveFeedback);
router.post('/feedback/1on1', create1on1Meeting);
router.patch('/feedback/:id/action-item', toggleActionItem);

// ─── PIP & Individual Development Plans ───────────────────────────────────────
router.get('/pips', listPips);
router.post('/pips', authorize('pms.pip.manage', 'pms.admin', 'pms.can.edit.all'), createPip);
router.post('/pips/:id/checkpoint', addPipCheckpoint);
router.patch('/pips/:id/status', authorize('pms.pip.manage', 'pms.admin', 'pms.can.edit.all'), updatePipStatus);

router.get('/dev-plans', listDevPlans);
router.post('/dev-plans', authorize('pms.dev_plan.manage', 'pms.admin', 'pms.can.edit.all'), createDevPlan);
router.patch('/dev-plans/:id/objective', updateDevPlanObjective);

// ─── Analytics, Reports & Automated Reminders ─────────────────────────────────
router.get('/analytics/dashboard', authorize('pms.reports.view', 'pms.analytics.view', 'pms.admin', 'pms.view.all', 'pms.view'), getDashboardMetrics);
router.get('/analytics/reports/:reportType', authorize('pms.reports.view', 'pms.analytics.view', 'pms.admin', 'pms.view.all'), getPmsReportData);
router.get('/analytics/export', authorize('pms.reports.view', 'pms.analytics.view', 'pms.admin', 'pms.view.all'), (req, res) => {
  req.params.reportType = 'employee-performance';
  req.query.format = 'xlsx';
  return getPmsReportData(req, res);
});
router.post('/analytics/reminders/trigger', authorize('pms.cycle.manage', 'pms.admin', 'pms.can.edit.all'), triggerManualReminders);

// ─── Simplified Evaluations & Direct Team Ratings ─────────────────────────────
const {
  getEvaluations,
  submitReview,
  getMyScorecard,
} = require('./pmsSimpleEvaluation.controller');

router.get('/evaluations', getEvaluations);
router.get('/evaluations/my-scorecard', getMyScorecard);
router.post('/evaluations/:targetUserId/submit-review', submitReview);

// ─── PMS Settings & Workflow Configuration ────────────────────────────────────
router.get('/settings', getPmsSettings);
router.put('/settings', authorize('pms.admin', 'pms.can.edit.all'), updatePmsSettings);

module.exports = router;
