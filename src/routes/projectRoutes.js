const express = require('express');
const { requireModule } = require('../middlewares/moduleGuard');
const router = express.Router();
const { protect } = require('../middlewares/authMiddleware');
const { authorize } = require('../middlewares/authorize');
const {
    getBusinessUnits, createBusinessUnit, updateBusinessUnit,
    getClients, createClient, updateClient,
    getProjects, createProject, updateProject, deleteProject, getProjectHierarchy,
    getModules, createModule, updateModule, deleteModule,
    getTasks, createTask, updateTask, deleteTask,
    getEmployees
} = require('../controllers/projectController');
const { getProjectBootstrap } = require('../controllers/pageBootstrapController');

router.use(protect);

// Helpers
router.get('/bootstrap', requireModule('projectManagement'), getProjectBootstrap);
router.get('/employees', requireModule('projectManagement'), getEmployees);

// Business Units
router.get('/business-units', authorize('business_unit.read'), requireModule('projectManagement'), getBusinessUnits);
router.post('/business-units', authorize('business_unit.create'), requireModule('projectManagement'), createBusinessUnit);
router.put('/business-units/:id', authorize('business_unit.update'), requireModule('projectManagement'), updateBusinessUnit);

// Clients
router.get('/clients', requireModule(['projectManagement', 'timesheet', 'attendance']), getClients);
router.post('/clients', authorize('client.create'), requireModule('projectManagement'), createClient);
router.put('/clients/:id', authorize('client.update'), requireModule('projectManagement'), updateClient);

// Projects
router.get('/:id/hierarchy', requireModule(['projectManagement', 'timesheet', 'attendance']), getProjectHierarchy);
router.get('/', requireModule(['projectManagement', 'timesheet', 'attendance']), getProjects);
router.post('/', authorize('project.create'), requireModule('projectManagement'), createProject);
router.put('/:id', authorize('project.update'), requireModule('projectManagement'), updateProject);
router.delete('/:id', authorize('project.delete'), requireModule('projectManagement'), deleteProject);

// Modules
router.get('/:projectId/modules', requireModule(['projectManagement', 'timesheet', 'attendance']), getModules);
router.post('/modules', authorize('project.create'), requireModule('projectManagement'), createModule);
router.put('/modules/:id', authorize('project.update'), requireModule('projectManagement'), updateModule);
router.delete('/modules/:id', authorize('module.delete'), requireModule('projectManagement'), deleteModule);

// Tasks
router.get('/tasks', requireModule(['projectManagement', 'timesheet', 'attendance']), getTasks); // /api/projects/tasks?moduleId=...
router.post('/tasks', authorize('task.create'), requireModule('projectManagement'), createTask);
router.put('/tasks/:id', authorize('task.update'), requireModule('projectManagement'), updateTask);
router.delete('/tasks/:id', authorize('task.delete'), requireModule('projectManagement'), deleteTask);

// Work Logs
const { logWork, getWorkLogs, updateWorkLog, deleteWorkLog } = require('../controllers/workLogController');
router.post('/tasks/:taskId/log', requireModule(['projectManagement', 'timesheet', 'attendance']), logWork);
router.get('/worklogs', requireModule(['projectManagement', 'timesheet', 'attendance']), getWorkLogs);
router.put('/worklogs/:id', requireModule(['projectManagement', 'timesheet', 'attendance']), updateWorkLog);
router.delete('/worklogs/:id', requireModule(['projectManagement', 'timesheet', 'attendance']), deleteWorkLog);

module.exports = router;
