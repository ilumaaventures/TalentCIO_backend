const express = require('express');
const { requireModule } = require('../../common/middleware/moduleGuard');
const router = express.Router();
const { protect } = require('../../common/middleware/authMiddleware');
const { authorize } = require('../../common/middleware/authorize');
const { dossierGate } = require('../../common/middleware/dossierGate');
const clockController = require('./controllers/attendanceClockController');
const crudController = require('./controllers/attendanceCrudController');
const regularizationController = require('./controllers/attendanceRegularizationController');
const reportController = require('./controllers/attendanceReportController');

const {
    clockIn,
    clockOut,
    getTodayStatus
} = clockController;

const {
    approveAttendance,
    createAttendance,
    deleteAttendance,
    getAttendanceByMonth,
    getMyAttendance,
    getPendingRequests,
    updateAttendance
} = crudController;

const {
    getRegularizationRequests,
    processRegularizationRequest,
    requestRegularization
} = regularizationController;

const {
    exportTeamAttendanceExcel,
    getTeamAttendanceReport,
    updateCustomFlexibleOffDays
} = reportController;
const { getAttendanceBootstrap } = require('../system/pageBootstrap.controller');

router.use(protect); // All routes protected
router.use(requireModule('attendance'));

router.get('/bootstrap', getAttendanceBootstrap);
router.get('/today', getTodayStatus);
router.post('/clock-in', authorize('attendance.clock_in'), dossierGate, clockIn);
router.post('/clock-out', authorize('attendance.clock_in'), dossierGate, clockOut);
router.get('/me', getMyAttendance);
router.get('/history', getAttendanceByMonth);
router.get('/team-report', getTeamAttendanceReport);
router.get('/export-excel', authorize('attendance.export|attendance.view_others|user.read'), exportTeamAttendanceExcel);
router.get('/approvals', getPendingRequests);
router.put('/flexible-off', updateCustomFlexibleOffDays);

// Regularization
router.post('/regularize', dossierGate, requestRegularization);
router.get('/regularizations', getRegularizationRequests);
router.patch('/regularize/:id', processRegularizationRequest);

router.put('/:id/approve', approveAttendance);
router.post('/', dossierGate, createAttendance);
router.put('/:id', dossierGate, updateAttendance);
router.delete('/:id', dossierGate, deleteAttendance);

module.exports = router;
