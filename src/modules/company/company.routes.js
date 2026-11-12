const express = require('express');
const router = express.Router();
const { protectSuperAdmin, requirePermission } = require('../../common/middleware/superAdminAuth');
const {
    getAllCompanies, getCompanyById, createCompany,
    updateCompany, toggleCompanyStatus, deleteCompany, getCompanyAnalytics
} = require('./company.controller');
const { getModules, updateModules } = require('../company/module.controller');

router.use(protectSuperAdmin);

router.get('/', getAllCompanies);
router.post('/', requirePermission('manageCompanies'), createCompany);
router.get('/:id', getCompanyById);
router.put('/:id', requirePermission('manageCompanies'), updateCompany);
router.patch('/:id/status', requirePermission('manageCompanies'), toggleCompanyStatus);
router.delete('/:id', requirePermission('manageCompanies'), deleteCompany);
router.get('/:id/analytics', requirePermission('viewAnalytics'), getCompanyAnalytics);
router.get('/:id/modules', getModules);
router.put('/:id/modules', requirePermission('manageCompanies'), updateModules);

module.exports = router;
