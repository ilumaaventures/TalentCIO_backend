const express = require('express');
const { requireModule } = require('../middlewares/moduleGuard');
const router = express.Router();
const { protect } = require('../middlewares/authMiddleware');
const { authorize } = require('../middlewares/authorize');
const {
    getTodayStatus,
    clockIn,
    clockOut,
    getMyAttendance,
    getAttendanceByMonth,
    approveAttendance,
    getPendingRequests,

    updateAttendance,
    createAttendance,
    getTeamAttendanceReport,
    exportTeamAttendanceExcel,
    requestRegularization,
    getRegularizationRequests,
    processRegularizationRequest
} = require('../controllers/attendanceController');
const { getAttendanceBootstrap } = require('../controllers/pageBootstrapController');

router.use(protect); // All routes protected
router.use(requireModule('attendance'));

router.get('/bootstrap', getAttendanceBootstrap);
router.get('/today', getTodayStatus);
router.post('/clock-in', authorize('attendance.clock_in'), clockIn);
router.post('/clock-out', authorize('attendance.clock_in'), clockOut);
router.get('/me', getMyAttendance);
router.get('/history', getAttendanceByMonth);
router.get('/team-report', getTeamAttendanceReport);
router.get('/export-excel', authorize('attendance.export|attendance.view_others'), exportTeamAttendanceExcel);
router.get('/approvals', getPendingRequests);

// Regularization
router.post('/regularize', requestRegularization);
router.get('/regularizations', getRegularizationRequests);
router.patch('/regularize/:id', processRegularizationRequest);

router.put('/:id/approve', approveAttendance);
router.post('/', createAttendance);
router.put('/:id', updateAttendance);

module.exports = router;
