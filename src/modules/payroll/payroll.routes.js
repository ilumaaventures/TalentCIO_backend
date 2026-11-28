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

// ── Native Process Payroll Routes (Full My Bills Procedure in TalentCIO) ─────
router.get('/active-employees', authorize(['payroll.calculator.view', 'payroll.salary.view', 'payroll.salary.manage', '*']), payrollController.getActivePayrollEmployees);
router.post('/process', authorize(['payroll.salary.manage', 'payroll.config.manage', '*']), payrollController.processPayroll);
router.post('/preview', authorize(['payroll.calculator.view', 'payroll.salary.view', 'payroll.salary.manage', '*']), payrollController.previewPayroll);
router.put('/bulk-approve', authorize(['payroll.salary.manage', 'payroll.config.manage', '*']), payrollController.bulkApprovePayroll);
router.post('/bulk-delete', authorize(['payroll.salary.manage', 'payroll.config.manage', '*']), payrollController.bulkDeletePayroll);
router.post('/full-and-final', authorize(['payroll.salary.manage', 'payroll.config.manage', '*']), payrollController.processFullAndFinalSettlement);
router.get('/compensation-types', authorize(['payroll.calculator.view', 'payroll.salary.view', 'payroll.salary.manage', '*']), payrollController.getCompensationTypes);
router.get('/export', authorize(['payroll.calculator.view', 'payroll.salary.view', 'payroll.salary.manage', '*']), payrollController.exportPayrollExcel);
router.get('/export-inputs', authorize(['payroll.calculator.view', 'payroll.salary.view', 'payroll.salary.manage', '*']), payrollController.exportPayrollInputsExcel);

// Employee Self-Service payslip routes
router.get('/my-payslips', authorize(['payroll.payslip.view', 'payroll.calculator.view', 'payroll.salary.view', 'payroll.salary.manage', '*']), payrollController.getMyPayslips);
router.get('/my-payslips/:id/generate-payslip', authorize(['payroll.payslip.view', 'payroll.calculator.view', 'payroll.salary.view', 'payroll.salary.manage', '*']), payrollController.generateMyPayslip);

// Record-level operations
router.get('/records', authorize(['payroll.calculator.view', 'payroll.salary.view', 'payroll.salary.manage', '*']), payrollController.getPayrolls);
router.get('/records/:id', authorize(['payroll.calculator.view', 'payroll.salary.view', 'payroll.salary.manage', '*']), payrollController.getPayrollById);
router.get('/records/:id/generate-payslip', authorize(['payroll.calculator.view', 'payroll.salary.view', 'payroll.salary.manage', '*']), payrollController.generatePayslip);
router.put('/records/:id', authorize(['payroll.salary.manage', 'payroll.config.manage', '*']), payrollController.updatePayroll);
router.delete('/records/:id', authorize(['payroll.salary.manage', 'payroll.config.manage', '*']), payrollController.deletePayroll);
router.post('/records/:id/mark-paid', authorize(['payroll.salary.manage', 'payroll.config.manage', '*']), payrollController.markPayrollAsPaid);
router.post('/records/:id/reopen', authorize(['payroll.salary.manage', 'payroll.config.manage', '*']), payrollController.reopenPayroll);

// Direct aliases
router.get('/', authorize(['payroll.calculator.view', 'payroll.salary.view', 'payroll.salary.manage', '*']), payrollController.getPayrolls);
router.get('/:id/generate-payslip', authorize(['payroll.calculator.view', 'payroll.salary.view', 'payroll.salary.manage', '*']), payrollController.generatePayslip);
router.post('/:id/mark-paid', authorize(['payroll.salary.manage', 'payroll.config.manage', '*']), payrollController.markPayrollAsPaid);
router.post('/:id/reopen', authorize(['payroll.salary.manage', 'payroll.config.manage', '*']), payrollController.reopenPayroll);
router.delete('/:id', authorize(['payroll.salary.manage', 'payroll.config.manage', '*']), payrollController.deletePayroll);

module.exports = router;
