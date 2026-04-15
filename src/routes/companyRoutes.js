const express = require('express');
const router = express.Router();
const { protectSuperAdmin } = require('../middlewares/superAdminAuth');
const {
    getAllCompanies, getCompanyById, createCompany,
    updateCompany, toggleCompanyStatus, deleteCompany, getCompanyAnalytics
} = require('../controllers/companyController');
const { getModules, updateModules } = require('../controllers/moduleController');

router.use(protectSuperAdmin);

router.get('/', getAllCompanies);
router.post('/', createCompany);
router.get('/:id', getCompanyById);
router.put('/:id', updateCompany);
router.patch('/:id/status', toggleCompanyStatus);
router.delete('/:id', deleteCompany);
router.get('/:id/analytics', getCompanyAnalytics);
router.get('/:id/modules', getModules);
router.put('/:id/modules', updateModules);

module.exports = router;
