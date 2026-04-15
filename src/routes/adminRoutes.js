const express = require('express');
const router = express.Router();
const { protect } = require('../middlewares/authMiddleware');
const { authorize } = require('../middlewares/authorize');
const {
    getUsers,
    createUser,
    updateUserRole,
    updateUser,
    getMyTeam,
    getUserById,
    toggleUserStatus
} = require('../controllers/userController');
const {
    getRoles,
    createRole,
    updateRole,
    getPermissions
} = require('../controllers/roleController');
const { backfillTimesheets } = require('../controllers/migrationController');
const { getRoleBootstrap } = require('../controllers/pageBootstrapController');

router.use(protect);

// User Routes
router.get('/users/team', getMyTeam); // All authenticated users can see their own team
router.get('/users', authorize('user.read'), getUsers);
router.post('/users', authorize('user.create'), createUser);
// Add route for getting single user by ID
router.get('/users/:id', authorize(['user.read', 'attendance.view']), getUserById);
router.put('/users/:id', authorize('user.update'), updateUser);
router.put('/users/:id/role', authorize('user.update'), updateUserRole);
router.patch('/users/:id/status', authorize('user.update'), toggleUserStatus);

// Role Routes
router.get('/roles/bootstrap', authorize('role.read'), getRoleBootstrap);
router.get('/roles', authorize('role.read'), getRoles);
router.post('/roles', authorize('role.create'), createRole);
router.put('/roles/:id', authorize('role.update'), updateRole); // Assuming role.update permission exists or re-using role.create
router.get('/permissions', getPermissions); // Assuming basic auth is enough to view permissions structure

// Migration Routes (Temporary)
router.post('/migrate-timesheets', authorize('user.update'), backfillTimesheets);

module.exports = router;
