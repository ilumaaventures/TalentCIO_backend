const express = require('express');
const { requireModule } = require('../../common/middleware/moduleGuard');
const router = express.Router();
const { protect } = require('../../common/middleware/authMiddleware');
const { authorize } = require('../../common/middleware/authorize');
const { dossierGate } = require('../../common/middleware/dossierGate');
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
} = require('./timesheet.controller');
const { getTimesheetBootstrap } = require('../system/pageBootstrap.controller');
const { upload } = require('../../config/cloudinary');

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
