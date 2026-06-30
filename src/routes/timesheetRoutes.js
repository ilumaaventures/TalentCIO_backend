const express = require('express');
const { requireModule } = require('../middlewares/moduleGuard');
const router = express.Router();
const { protect } = require('../middlewares/authMiddleware');
const { authorize } = require('../middlewares/authorize');
const { dossierGate } = require('../middlewares/dossierGate');
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
router.post('/entry', dossierGate, addEntry);
router.put('/entry/:entryId', dossierGate, updateEntry);
router.post('/submit', authorize('timesheet.submit'), dossierGate, submitTimesheet);
router.get('/projects', getProjects);
router.post('/projects', authorize('project.create'), createProject);
router.get('/approvals', getPendingTimesheets);
router.put('/:id/approve', approveTimesheet);

module.exports = router;
