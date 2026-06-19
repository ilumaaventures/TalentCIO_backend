const express = require('express');
const router = express.Router();
const { register, loginUser, logoutUser, uploadProfilePicture, verifyOtpAndResetPassword, verifyOtp, resendOtp, getBirthdayStatus, changePassword } = require('../controllers/authController');
const { authLimiter } = require('../middlewares/rateLimitMiddleware');
const { getMyself } = require('../controllers/userController');
const { protect } = require('../middlewares/authMiddleware');

const { uploadProfilePicture: uploadProfilePictureMiddleware } = require('../config/cloudinary');

const handleProfilePictureUpload = (req, res, next) => {
    uploadProfilePictureMiddleware.single('image')(req, res, (err) => {
        if (!err) return next();

        if (err.code === 'LIMIT_FILE_SIZE') {
            return res.status(413).json({ message: 'Profile picture must be 2 MB or smaller.' });
        }

        return res.status(400).json({ message: err.message || 'Invalid profile picture upload.' });
    });
};

router.post('/register', authLimiter, register);
router.post('/login', authLimiter, loginUser);
router.post('/logout', protect, logoutUser);
router.post('/verify-otp-reset', authLimiter, verifyOtpAndResetPassword);
router.post('/verify-otp', authLimiter, verifyOtp);
router.post('/resend-otp', authLimiter, resendOtp);
router.post('/upload-profile-picture', protect, handleProfilePictureUpload, uploadProfilePicture);
router.get('/birthday-status', protect, getBirthdayStatus);
router.get('/profile', protect, getMyself);
router.put('/change-password', protect, changePassword);

router.get('/verify-workspace', (req, res) => {
    // If req.company exists, it's a valid tenant.
    // If not, but it reached here, it's the root domain (bypassed in tenantMiddleware).
    if (req.company) {
        res.status(200).json({
            valid: true,
            id: req.company._id,
            name: req.company.name,
            subdomain: req.company.subdomain,
            type: 'tenant'
        });
    } else {
        // Root domain access - allow the frontend to proceed to landing/login
        res.status(200).json({
            valid: true,
            name: 'HRCODE',
            type: 'root'
        });
    }
});

module.exports = router;
