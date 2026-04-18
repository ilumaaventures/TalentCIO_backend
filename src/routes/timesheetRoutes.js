const express = require('express');
const { requireModule } = require('../middlewares/moduleGuard');
const router = express.Router();
const { protect } = require('../middlewares/authMiddleware');
const { authorize } = require('../middlewares/authorize');
const { 
    getCurrentTimesheet, 
    getUserTimesheet,
    addEntry, 

    submitTimesheet,
    getProjects,
    createProject,
    getPendingTimesheets,

    approveTimesheet,
    updateEntry
} = require('../controllers/timesheetController');
const { getTimesheetBootstrap } = require('../controllers/pageBootstrapController');
const { upload } = require('../config/cloudinary');

router.use(protect); 
router.use(requireModule(['timesheet', 'attendance']));

router.get('/bootstrap', getTimesheetBootstrap);
router.get('/current', getCurrentTimesheet);
router.get('/user/:userId', getUserTimesheet);
router.post('/entry', addEntry);
router.put('/entry/:entryId', updateEntry);
router.post('/submit', submitTimesheet);
router.get('/projects', getProjects);
router.post('/projects', createProject); 
router.get('/approvals', getPendingTimesheets);
router.put('/:id/approve', approveTimesheet);

module.exports = router;
