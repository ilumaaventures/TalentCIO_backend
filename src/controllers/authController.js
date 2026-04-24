const User = require('../models/User');
const { HiringRequest } = require('../models/HiringRequest');
const Candidate = require('../models/Candidate');
const jwt = require('jsonwebtoken');
const emailService = require('../services/emailService');
const crypto = require('crypto');

//adding comment to check the CI/CD pipeline
const normalizeEmail = (value) => String(value || '').trim().toLowerCase();

// Generate JWT Helper
const generateToken = (id, tokenVersion) => {
    return jwt.sign({ id, tokenVersion }, process.env.JWT_SECRET, {
        expiresIn: '7d'
    });
};

// @desc    Register a new user
// @route   POST /api/auth/register
// @access  Public
const register = async (req, res) => {


    const { email, password, firstName, lastName } = req.body;
    const normalizedEmail = normalizeEmail(email);

    try {
        const company = await require('../models/Company').findById(req.companyId);
        if (company && company.allowedDomains && company.allowedDomains.length > 0) {
            const userEmailDomain = normalizedEmail.split('@')[1];
            if (!company.allowedDomains.includes(userEmailDomain)) {
                return res.status(400).json({ message: `Registration Denied: Email domain '@${userEmailDomain}' is not allowed for this workspace. Allowed domains: ${company.allowedDomains.join(', ')}` });
            }
        }

        const userExists = await User.findOne({ email: normalizedEmail, companyId: req.companyId });
        if (userExists) {
            return res.status(400).json({ message: 'User already exists in this workspace.' });
        }

        const user = await User.create({
            companyId: req.companyId,
            firstName,
            lastName,
            email: normalizedEmail,
            password
        });

        if (user) {
            res.status(201).json({
                _id: user._id,
                firstName: user.firstName,
                email: user.email,
                token: generateToken(user._id, user.tokenVersion)
            });
        } else {
            res.status(400).json({ message: 'Invalid user data' });
        }
    } catch (error) {
        console.error(error);
        res.status(500).json({ message: 'Server Error' });
    }
};

// @desc    Auth user & get token
// @route   POST /api/auth/login
// @access  Public
const loginUser = async (req, res) => {


    const { email, password } = req.body;
    const normalizedEmail = normalizeEmail(email);

    try {
        if (!req.companyId) {
            return res.status(401).json({ message: 'Invalid email or password' });
        }

        const user = await User.findOne({ email: normalizedEmail, companyId: req.companyId }).populate({
            path: 'roles',
            populate: {
                path: 'permissions'
            }
        }).populate('reportingManagers', 'firstName lastName');

        // Check if user exists and password is correct
        if (!user || !(await user.matchPassword(password))) {
            return res.status(401).json({ message: 'Invalid email or password' });
        }

        // Check if user account is active
        if (user.isActive === false) {
            return res.status(403).json({ message: 'Your account has been deactivated. Please contact your administrator.' });
        }

        // Check if password reset is required (First Login)
        if (user.isPasswordResetRequired) {
            // Generate 6-digit OTP
            const otpSize = 6;
            const otpCode = Math.floor(100000 + Math.random() * 900000).toString();
            console.log(`[AUTH] OTP for ${user.email} (Login): ${otpCode}`);

            // Set OTP and expiry (10 minutes)
            user.otp = otpCode;
            user.otpExpires = Date.now() + 10 * 60 * 1000;
            await user.save();

            // Send OTP via Email (Non-blocking)
            emailService.sendOTPEmail(user.email, otpCode, user.firstName).catch(err => {
                console.error('[AUTH] Background Email Send Error:', err.message);
            });

            return res.status(200).json({
                message: 'Password reset required on first login. An OTP has been sent to your email.',
                passwordResetRequired: true,
                email: user.email,
                userId: user._id
            });
        }

        // Multi-tenant check: If a tenant is identified by middleware, user must belong to it
        if (req.companyId && user.companyId && user.companyId.toString() !== req.companyId.toString()) {
            return res.status(401).json({ message: `Your account does not belong to the '${req.company?.name || 'requested'}' workspace.` });
        }
        let permissions = [...new Set(
            user.roles.flatMap(role => (role.permissions || []).filter(p => p).map(p => p.key))
        )];

        // Wildcard Expansion: If user has '*', provide ALL permissions
        let hasAllPermissions = false;
        const Permission = require('../models/Permission');
        let totalPerms = 0, directReportsCount = 0, taCount = 0;

        if (permissions.includes('*')) {
            hasAllPermissions = true;
            const allPermissions = await Permission.find({});

            // Add all permission keys
            const allKeys = allPermissions.map(p => p.key);
            permissions = [...new Set([...permissions, ...allKeys])];

            // Run auth queries in parallel
            [directReportsCount, taCount] = await Promise.all([
                User.countDocuments({ reportingManagers: user._id }),
                HiringRequest.countDocuments({
                    $or: [
                        { createdBy: user._id },
                        { 'ownership.hiringManager': user._id },
                        { 'ownership.recruiter': user._id }
                    ]
                })
            ]);
        } else {
            // Run auth queries in parallel
            [totalPerms, directReportsCount, taCount] = await Promise.all([
                Permission.countDocuments({ key: { $ne: '*' } }),
                User.countDocuments({ reportingManagers: user._id }),
                HiringRequest.countDocuments({
                    $or: [
                        { createdBy: user._id },
                        { 'ownership.hiringManager': user._id },
                        { 'ownership.recruiter': user._id }
                    ]
                })
            ]);

            if (totalPerms > 0 && permissions.length >= totalPerms) {
                hasAllPermissions = true;
            }
        }

        // Check if they are an interviewer via per-candidate round assignment (precise check)
        let isInterviewer = false;
        if (taCount === 0 && !permissions.includes('ta.view') && !permissions.includes('*')) {
            const interviewCount = await Candidate.countDocuments({
                'interviewRounds.assignedTo': user._id
            });
            isInterviewer = interviewCount > 0;
        }

        const company = await require('../models/Company').findById(user.companyId);

        res.json({
            _id: user._id,
            firstName: user.firstName,
            lastName: user.lastName,
            email: user.email,
            joiningDate: user.joiningDate,
            reportingManagers: user.reportingManagers,
            roles: user.roles.map(r => r.name),
            permissions: permissions,
            hasAllPermissions: hasAllPermissions,
            directReportsCount: directReportsCount,
            isTAParticipant: taCount > 0 || isInterviewer,
            company: company, // Full configuration for the frontend
            token: generateToken(user._id, user.tokenVersion)
        });
    } catch (error) {
        console.error('LOGIN ERROR:', error);
        res.status(500).json({ message: 'Server Error', error: error.message });
    }
};

// @desc    Upload Profile Picture
// @route   POST /api/auth/upload-profile-picture
// @access  Private
const uploadProfilePicture = async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ message: 'No file uploaded' });
        }

        const user = await User.findById(req.user._id);

        if (!user) {
            return res.status(404).json({ message: 'User not found' });
        }

        user.profilePicture = req.file.path;
        await user.save();

        res.json({
            message: 'Profile picture uploaded successfully',
            profilePicture: user.profilePicture
        });
    } catch (error) {
        console.error('UPLOAD ERROR:', error);
        res.status(500).json({ message: 'Server Error', error: error.message });
    }
};

// @desc    Verify OTP and Reset Password
// @route   POST /api/auth/verify-otp-reset
// @access  Public
const verifyOtpAndResetPassword = async (req, res) => {
    // Ensure companyId is identified from header/body if not in req.companyId (from middleware)
    if (!req.companyId) {
        req.companyId = req.headers['xtenent'] || req.headers['x-tenant'] || req.headers['x-tenant-id'] || req.body.companyId || req.body.tenant;
    }

    const { email, otp, newPassword } = req.body;
    const normalizedEmail = normalizeEmail(email);

    try {
        const user = await User.findOne({
            email: normalizedEmail,
            companyId: req.companyId,
            otp,
            otpExpires: { $gt: Date.now() }
        });

        if (!user) {
            return res.status(400).json({ message: 'Invalid or expired OTP' });
        }

        // Update password and clear OTP
        user.password = newPassword;
        user.isPasswordResetRequired = false;
        user.otp = null;
        user.otpExpires = null;

        await user.save();

        res.json({
            message: 'Password reset successfully. You can now login with your new password.',
            success: true
        });
    } catch (error) {
        console.error('OTP VERIFY ERROR:', error);
        res.status(500).json({ message: 'Server Error', error: error.message });
    }
};

// @desc    Resend OTP
// @route   POST /api/auth/resend-otp
// @access  Public
const resendOtp = async (req, res) => {
    // Ensure companyId is identified from header if not in req.companyId (from middleware)
    if (!req.companyId) {
        req.companyId = req.headers['xtenent'] || req.headers['x-tenant'] || req.headers['x-tenant-id'];
    }

    const { email } = req.body;
    const normalizedEmail = normalizeEmail(email);

    try {
        const user = await User.findOne({ email: normalizedEmail, companyId: req.companyId });

        if (!user) {
            return res.status(404).json({ message: 'User not found' });
        }

        // Generate new 6-digit OTP
        const otpCode = Math.floor(100000 + Math.random() * 900000).toString();
        console.log(`[AUTH] OTP for ${user.email} (Resend): ${otpCode}`);

        user.otp = otpCode;
        user.otpExpires = Date.now() + 10 * 60 * 1000;
        await user.save();

        const emailSent = await emailService.sendOTPEmail(user.email, otpCode, user.firstName);

        res.json({
            message: 'A new OTP has been sent to your email.',
            emailSent: emailSent
        });
    } catch (error) {
        console.error('RESEND OTP ERROR:', error);
        res.status(500).json({ message: 'Server Error', error: error.message });
    }
};

module.exports = {
    register,
    loginUser,
    uploadProfilePicture,
    verifyOtpAndResetPassword,
    resendOtp
};
