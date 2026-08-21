const express = require('express');
const { requireModule } = require('../../common/middleware/moduleGuard');
const router = express.Router();
const { protect } = require('../../common/middleware/authMiddleware');
const { authorize, authorizeAny } = require('../../common/middleware/authorize');
const {
    getBusinessUnits, createBusinessUnit, updateBusinessUnit,
    getClients, createClient, updateClient,
    getProjects, createProject, updateProject, deleteProject, getProjectHierarchy,
    getModules, createModule, updateModule, deleteModule,
    getTasks, createTask, updateTask, deleteTask,
    getEmployees
} = require('./project.controller');
const { getProjectBootstrap } = require('../system/pageBootstrap.controller');

router.use(protect);

// Helpers
router.get('/bootstrap', requireModule('projects'), getProjectBootstrap);
router.get('/employees', requireModule('projects'), getEmployees);

// Business Units
router.get('/business-units', authorizeAny(['business_unit.read', 'department.read', 'user.create', 'user.update', 'project.read', 'client.read', 'client.create']), requireModule(['businessUnits', 'organization', 'projects']), getBusinessUnits);
router.post('/business-units', authorize('business_unit.create'), requireModule('businessUnits'), createBusinessUnit);
router.put('/business-units/:id', authorize('business_unit.update'), requireModule('businessUnits'), updateBusinessUnit);

// Clients
router.get('/clients', authorizeAny(['client.read', 'client.create', 'client.update']), requireModule(['clients', 'projects', 'timesheet', 'attendance']), getClients);
router.post('/clients', authorize('client.create'), requireModule('clients'), createClient);
router.put('/clients/:id', authorize('client.update'), requireModule('clients'), updateClient);

// Projects
router.get('/:id/hierarchy', requireModule(['projects', 'timesheet', 'attendance']), getProjectHierarchy);
router.get('/', requireModule(['projects', 'timesheet', 'attendance']), getProjects);
router.post('/', authorize('project.create'), requireModule('projects'), createProject);
router.put('/:id', authorize('project.update'), requireModule('projects'), updateProject);
router.delete('/:id', authorize('project.delete'), requireModule('projects'), deleteProject);

// Modules
router.get('/:projectId/modules', requireModule(['projects', 'timesheet', 'attendance']), getModules);
router.post('/modules', authorize('project.create'), requireModule('projects'), createModule);
router.put('/modules/:id', authorize('project.update'), requireModule('projects'), updateModule);
router.delete('/modules/:id', authorize('module.delete'), requireModule('projects'), deleteModule);

// Tasks
router.get('/tasks', requireModule(['projects', 'timesheet', 'attendance']), getTasks); // /api/projects/tasks?moduleId=...
router.post('/tasks', authorize('task.create'), requireModule('projects'), createTask);
router.put('/tasks/:id', authorize('task.update'), requireModule('projects'), updateTask);
router.delete('/tasks/:id', authorize('task.delete'), requireModule('projects'), deleteTask);

// Work Logs
const { logWork, getWorkLogs, updateWorkLog, deleteWorkLog } = require('../timesheet/workLog.controller');
router.post('/tasks/:taskId/log', requireModule(['projects', 'timesheet', 'attendance']), logWork);
router.get('/worklogs', requireModule(['projects', 'timesheet', 'attendance']), getWorkLogs);
router.put('/worklogs/:id', requireModule(['projects', 'timesheet', 'attendance']), updateWorkLog);
router.delete('/worklogs/:id', requireModule(['projects', 'timesheet', 'attendance']), deleteWorkLog);

module.exports = router;
