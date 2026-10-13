const express = require('express');
const router = express.Router();
const { protect } = require('../../common/middleware/authMiddleware');
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
  exportAppraisalsExcel,
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
router.post('/cycles', createCycle);
router.put('/cycles/:id', updateCycle);
router.patch('/cycles/:id/status', changeCycleStatus);
router.post('/cycles/:id/reopen', reopenCycle);
router.post('/cycles/:id/sync-participants', syncCycleParticipants);

// ─── KRAs & KPIs ──────────────────────────────────────────────────────────────
router.get('/kras', listKras);
router.post('/kras', createKra);
router.put('/kras/:id', updateKra);
router.delete('/kras/:id', deleteKra);

router.get('/kpis', listKpis);
router.post('/kpis', createKpi);
router.put('/kpis/:id', updateKpi);
router.post('/kpis/:id/evidence', submitKpiEvidence);
router.post('/kpis/:id/verify', verifyKpi);

// ─── Goals & OKRs ─────────────────────────────────────────────────────────────
router.get('/goals', listGoals);
router.get('/goals/tree', getGoalTree);
router.post('/goals', createGoal);
router.put('/goals/:id', updateGoal);
router.post('/goals/:id/check-in', checkInGoal);
router.post('/goals/:id/approve', approveOrRejectGoal);

// ─── Competency Framework ─────────────────────────────────────────────────────
router.get('/competencies', listCompetencies);
router.post('/competencies', createCompetency);
router.put('/competencies/:id', updateCompetency);
router.delete('/competencies/:id', deleteCompetency);

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
router.post('/appraisals/:id/reopen', reopenAppraisal);
router.post('/appraisals/:id/nominate-360', nominate360Reviewers);
router.post('/appraisals/:id/submit-360', submit360Feedback);
router.post('/appraisals/:id/calibrate', calibrateRating);
router.post('/appraisals/publish', publishAppraisals);
router.post('/appraisals/:id/acknowledge', acknowledgeAppraisal);

// ─── Continuous Feedback & 1-on-1s ───────────────────────────────────────────
router.get('/feedback', listFeedbacks);
router.post('/feedback', giveFeedback);
router.post('/feedback/1on1', create1on1Meeting);
router.patch('/feedback/:id/action-item', toggleActionItem);

// ─── PIP & Individual Development Plans ───────────────────────────────────────
router.get('/pips', listPips);
router.post('/pips', createPip);
router.post('/pips/:id/checkpoint', addPipCheckpoint);
router.patch('/pips/:id/status', updatePipStatus);

router.get('/dev-plans', listDevPlans);
router.post('/dev-plans', createDevPlan);
router.patch('/dev-plans/:id/objective', updateDevPlanObjective);

// ─── Analytics & Excel Export ─────────────────────────────────────────────────
router.get('/analytics/dashboard', getDashboardMetrics);
router.get('/analytics/export', exportAppraisalsExcel);

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
router.put('/settings', updatePmsSettings);

module.exports = router;
