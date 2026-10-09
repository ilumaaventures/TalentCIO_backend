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
router.get('/departments', authorizeAny(['department.read', 'user.create', 'user.update', 'dossier.edit']), listDepartments);
router.get('/departments/tree', authorize('department.read'), getDepartmentTree);
router.get('/departments/:id', authorize('department.read'), getDepartmentById);
router.post('/departments', authorize('department.create'), createDepartment);
router.put('/departments/:id', authorize('department.update'), updateDepartment);
router.delete('/departments/:id', authorize('department.delete'), deleteDepartment);
router.post('/departments/:id/restore', authorize('department.delete'), restoreDepartment);

// --- DESIGNATIONS ---
router.get('/designations', authorizeAny(['designation.read', 'user.create', 'user.update', 'dossier.edit']), listDesignations);
router.get('/designations/:id', authorize('designation.read'), getDesignationById);
router.post('/designations', authorize('designation.create'), createDesignation);
router.put('/designations/:id', authorize('designation.update'), updateDesignation);
router.delete('/designations/:id', authorize('designation.delete'), deleteDesignation);
router.post('/designations/:id/restore', authorize('designation.delete'), restoreDesignation);

// --- ORG CHART ---
router.get('/org-chart', requireModule('organization'), getOrgChart);
router.get('/org-chart/stats', authorizeAny(['org_chart.view', 'org.chart.view', 'org_chart.manage', 'org.chart.manage']), requireModule('organization'), getOrgStats);
router.get('/org-chart/:userId/reporting-line', requireModule('organization'), getEmployeeReportingLine);
router.put('/org-chart/:userId/manager', authorizeAny(['org_chart.manage', 'org.chart.manage']), requireModule('organization'), updateReportingManager);

// --- BUSINESS UNITS ---
router.get('/business-units', authorizeAny(['business_unit.read', 'business_unit.create', 'business_unit.update', 'department.create', 'department.update', 'user.create', 'user.update', 'project.read', 'client.read', 'client.create']), requireModule('businessUnits'), getBusinessUnits);
router.get('/business-units/:id', authorizeAny(['business_unit.read', 'business_unit.create', 'business_unit.update']), requireModule('businessUnits'), getBusinessUnit);
router.post('/business-units', authorizeAny(['business_unit.create', 'department.create']), requireModule('businessUnits'), createBusinessUnit);
router.put('/business-units/:id', authorizeAny(['business_unit.update', 'department.update']), requireModule('businessUnits'), updateBusinessUnit);
router.delete('/business-units/:id', authorizeAny(['business_unit.delete', 'department.delete']), requireModule('businessUnits'), deleteBusinessUnit);
router.post('/business-units/:id/restore', authorizeAny(['business_unit.delete', 'department.delete']), requireModule('businessUnits'), restoreBusinessUnit);

module.exports = router;
