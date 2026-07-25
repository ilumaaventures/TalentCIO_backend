const express = require('express');
const { requireModule } = require('../middlewares/moduleGuard');
const router = express.Router();
const { protect } = require('../middlewares/authMiddleware');
const { authorize } = require('../middlewares/authorize');
const { dossierGate } = require('../middlewares/dossierGate');
const {
    getTodayStatus,
    clockIn,
    clockOut,
    getMyAttendance,
    getAttendanceByMonth,
    approveAttendance,
    getPendingRequests,

    updateAttendance,
    deleteAttendance,
    createAttendance,
    getTeamAttendanceReport,
    exportTeamAttendanceExcel,
    requestRegularization,
    getRegularizationRequests,
    processRegularizationRequest,
    updateCustomFlexibleOffDays
} = require('../controllers/attendanceController');
const { getAttendanceBootstrap } = require('../controllers/pageBootstrapController');

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
