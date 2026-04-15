const express = require('express');
const router = express.Router();
const { protectSuperAdmin } = require('../middlewares/superAdminAuth');
const { getAllUsers, deactivateUser, resetPassword, changeRole } = require('../controllers/globalUserController');

router.use(protectSuperAdmin);

router.get('/', getAllUsers);
router.patch('/:id/deactivate', deactivateUser);
router.post('/:id/reset-password', resetPassword);
router.patch('/:id/role', changeRole);

module.exports = router;
