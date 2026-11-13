const express = require('express');
const router = express.Router();
const { protect } = require('../../common/middleware/authMiddleware');
const { authorize } = require('../../common/middleware/authorize');
const { requireModule } = require('../../common/middleware/moduleGuard');
const payrollController = require('./payroll.controller');

router.use(protect);

router.get('/config', requireModule(['payroll', 'onboarding', 'employeeDossier', 'userManagement']), authorize([
    'payroll.calculator.view',
    'payroll.config.manage',
    'payroll.payslip.view',
    'payroll.salary.view',
    'payroll.salary.manage',
    'payroll.salary.view.self',
    'user.read',
    'user.create',
    'user.update',
    'dossier.view',
    'dossier.edit',
    'onboarding.view',
    'onboarding.manage',
    'employee.revision.view.self',
    'employee.revision.view.others',
    'employee.revision.create',
    'employee.revision.update',
    'employee.revision.manage'
]), payrollController.getConfig);

// All subsequent payroll operations strictly require the 'payroll' module to be enabled for the workspace
router.use(requireModule('payroll'));

router.put('/config', authorize('payroll.config.manage'), payrollController.updateConfig);
router.post('/calculate-salary', authorize(['payroll.calculator.view', 'payroll.salary.view', 'payroll.salary.manage']), payrollController.calculateSalary);

router.get('/sync-settings', authorize(['payroll.config.manage', 'payroll.calculator.view', '*']), payrollController.getSyncSettings);
router.put('/sync-settings', authorize(['payroll.config.manage', '*']), payrollController.updateSyncSettings);

router.get('/monthly-roll', authorize(['payroll.calculator.view', 'payroll.salary.view', 'payroll.salary.manage', '*']), payrollController.getMonthlyRoll);
router.post('/reset-monthly-roll', authorize(['payroll.salary.manage', 'payroll.config.manage', '*']), payrollController.resetMonthlyRoll);

module.exports = router;
