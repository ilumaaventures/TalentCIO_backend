const express = require('express');
const router = express.Router();
const { protect } = require('../../common/middleware/authMiddleware');
const { authorize, authorizeAny } = require('../../common/middleware/authorize');
const { requireModule } = require('../../common/middleware/moduleGuard');

const {
    listDepartments,
    getDepartmentTree,
    getDepartmentById,
    createDepartment,
    updateDepartment,
    deleteDepartment,
    restoreDepartment
} = require('./controllers/departmentController');

const {
    listDesignations,
    getDesignationById,
    createDesignation,
    updateDesignation,
    deleteDesignation,
    restoreDesignation
} = require('./controllers/designationController');

const {
    getOrgChart,
    getEmployeeReportingLine,
    updateReportingManager,
    getOrgStats
} = require('./controllers/orgChartController');

const {
    getBusinessUnits,
    getBusinessUnit,
    createBusinessUnit,
    updateBusinessUnit,
    deleteBusinessUnit,
    restoreBusinessUnit
} = require('./controllers/businessUnitController');

router.use(protect);

// --- DEPARTMENTS ---
router.get('/departments', authorizeAny(['department.read', 'user.create', 'user.update', 'dossier.edit']), requireModule('organization'), listDepartments);
router.get('/departments/tree', authorize('department.read'), requireModule('organization'), getDepartmentTree);
router.get('/departments/:id', authorize('department.read'), requireModule('organization'), getDepartmentById);
router.post('/departments', authorize('department.create'), requireModule('organization'), createDepartment);
router.put('/departments/:id', authorize('department.update'), requireModule('organization'), updateDepartment);
router.delete('/departments/:id', authorize('department.delete'), requireModule('organization'), deleteDepartment);
router.post('/departments/:id/restore', authorize('department.delete'), requireModule('organization'), restoreDepartment);

// --- DESIGNATIONS ---
router.get('/designations', authorizeAny(['designation.read', 'user.create', 'user.update', 'dossier.edit']), requireModule('organization'), listDesignations);
router.get('/designations/:id', authorize('designation.read'), requireModule('organization'), getDesignationById);
router.post('/designations', authorize('designation.create'), requireModule('organization'), createDesignation);
router.put('/designations/:id', authorize('designation.update'), requireModule('organization'), updateDesignation);
router.delete('/designations/:id', authorize('designation.delete'), requireModule('organization'), deleteDesignation);
router.post('/designations/:id/restore', authorize('designation.delete'), requireModule('organization'), restoreDesignation);

// --- ORG CHART ---
router.get('/org-chart', requireModule('organization'), getOrgChart);
router.get('/org-chart/stats', requireModule('organization'), getOrgStats);
router.get('/org-chart/:userId/reporting-line', requireModule('organization'), getEmployeeReportingLine);
router.put('/org-chart/:userId/manager', authorize('org_chart.manage'), requireModule('organization'), updateReportingManager);

// --- BUSINESS UNITS ---
router.get('/business-units', authorizeAny(['business_unit.read', 'department.read', 'department.create', 'department.update', 'designation.read', 'user.create', 'user.update', 'dossier.edit', 'org_chart.view', 'project.read', 'client.read', 'client.create']), requireModule(['organization', 'businessUnits']), getBusinessUnits);
router.get('/business-units/:id', authorizeAny(['business_unit.read', 'department.read', 'org_chart.view']), requireModule(['organization', 'businessUnits']), getBusinessUnit);
router.post('/business-units', authorizeAny(['business_unit.create', 'department.create']), requireModule(['organization', 'businessUnits']), createBusinessUnit);
router.put('/business-units/:id', authorizeAny(['business_unit.update', 'department.update']), requireModule(['organization', 'businessUnits']), updateBusinessUnit);
router.delete('/business-units/:id', authorizeAny(['business_unit.delete', 'department.delete']), requireModule(['organization', 'businessUnits']), deleteBusinessUnit);
router.post('/business-units/:id/restore', authorizeAny(['business_unit.delete', 'department.delete']), requireModule(['organization', 'businessUnits']), restoreBusinessUnit);

module.exports = router;
