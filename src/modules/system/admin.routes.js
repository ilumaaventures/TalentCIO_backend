const express = require('express');
const multer = require('multer');
const router = express.Router();
const { protect, admin, blockDuringImpersonation } = require('../../common/middleware/authMiddleware');
const { authorize } = require('../../common/middleware/authorize');
const {
    getUsers,
    createUser,
    updateUserRole,
    updateUser,
    getMyTeam,
    getUserById,
    toggleUserStatus,
    deleteUser
} = require('../user/user.controller');
const {
    getRoles,
    createRole,
    updateRole,
    getPermissions
} = require('../user/role.controller');
const { backfillTimesheets } = require('./migration.controller');
const { getRoleBootstrap } = require('./pageBootstrap.controller');
const {
    getOwnAttendanceSettings,
    updateOwnAttendanceSettings,
    getOwnBrandingSettings,
    updateOwnBrandingSettings,
    uploadOwnCompanyLogo,
    removeOwnCompanyLogo,
    getCustomEmploymentTypes,
    addCustomEmploymentType,
    deleteCustomEmploymentType
} = require('../company/company.controller');

const companyLogoUpload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 3 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
        const allowedMimeTypes = [
            'image/jpeg',
            'image/jpg',
            'image/png',
            'image/svg+xml',
            'image/webp'
        ];

        if (allowedMimeTypes.includes(file.mimetype)) {
            return cb(null, true);
        }

        return cb(new Error('Only JPG, PNG, SVG, WEBP images are allowed.'));
    }
});

router.use(protect);

// User Routes
router.get('/users/team', getMyTeam); // All authenticated users can see their own team
router.get('/users', authorize('user.read'), getUsers);
router.post('/users', blockDuringImpersonation, authorize('user.create'), createUser);
// Add route for getting single user by ID
router.get('/users/:id', authorize(['user.read', 'attendance.view']), getUserById);
router.put('/users/:id', blockDuringImpersonation, authorize('user.update'), updateUser);
router.put('/users/:id/role', blockDuringImpersonation, authorize('user.update'), updateUserRole);
router.patch('/users/:id/status', blockDuringImpersonation, authorize('user.update'), toggleUserStatus);
router.delete('/users/:id', blockDuringImpersonation, authorize('user.delete'), deleteUser);

// Role Routes
router.get('/roles/bootstrap', authorize('role.read'), getRoleBootstrap);
router.get('/roles', authorize('role.read'), getRoles);
router.post('/roles', authorize('role.create'), createRole);
router.put('/roles/:id', authorize('role.update'), updateRole); // Assuming role.update permission exists or re-using role.create
router.get('/permissions', getPermissions); // Assuming basic auth is enough to view permissions structure

// Migration Routes (Temporary)
router.post('/migrate-timesheets', authorize('user.update'), backfillTimesheets);

// Company Attendance Settings
router.get('/company-settings/attendance', admin, getOwnAttendanceSettings);
router.put('/company-settings/attendance', admin, updateOwnAttendanceSettings);
router.get('/company-settings/branding', admin, getOwnBrandingSettings);
router.put('/company-settings/branding', admin, updateOwnBrandingSettings);
router.post('/company-settings/branding/logo', admin, companyLogoUpload.single('logo'), uploadOwnCompanyLogo);
router.delete('/company-settings/branding/logo', admin, removeOwnCompanyLogo);

// Custom Employment Types
router.get('/employment-types', getCustomEmploymentTypes);
router.post('/employment-types', addCustomEmploymentType);
router.delete('/employment-types/:name', deleteCustomEmploymentType);

module.exports = router;
