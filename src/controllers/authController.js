const User = require('../models/User');
const { HiringRequest } = require('../models/HiringRequest');
const Candidate = require('../models/Candidate');
const jwt = require('jsonwebtoken');
const emailService = require('../services/emailService');
const { sendEmailForCompany } = require('../services/companyEmailService');
const NotificationService = require('../services/notificationService');
const crypto = require('crypto');
const { normalizeEnabledModules } = require('../utils/enabledModules');
const { augmentPermissionKeysForRoles } = require('../utils/permissionResolver');
const { invalidateAuthUserCache } = require('../middlewares/authMiddleware');
const { clearSessionCookie, setSessionCookie } = require('../utils/sessionCookies');
const Company = require('../models/Company');

//adding comment to check the CI/CD pipeline
const normalizeEmail = (value) => String(value || '').trim().toLowerCase();
const getAssignedClientNames = (user) => (
    [...new Set(
        (Array.isArray(user?.taAssignedClients) ? user.taAssignedClients : [])
            .map((client) => String(client || '').trim())
            .filter(Boolean)
    )]
);

const hasDirectTAPermission = (permissions = []) => (
    Array.isArray(permissions)
    && permissions.some((permission) => permission === '*' || String(permission || '').startsWith('ta.'))
);

const getCompanyEmailBranding = async (companyId, company = null) => {
    const branding = await emailService.getCompanyBranding(companyId);

    return {
        companyId,
        ...branding,
        logoAlt: branding.logoAlt || company?.name || 'TalentCIO'
    };
};

const buildOtpEmailContent = (firstName, otpCode) => ({
    subject: 'Your Password Reset OTP - TalentCIO',
    html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: auto; padding: 20px; border: 1px solid #e0e0e0; border-radius: 10px;">
            <h2 style="color: #4a90e2; text-align: center;">Welcome to TalentCIO!</h2>
            <p>Hello ${firstName},</p>
            <p>To ensure the security of your account, we require a mandatory password reset for your first login.</p>
            <p>Please use the following One-Time Password (OTP) to verify your identity and set your new password:</p>
            <div style="text-align: center; margin: 30px 0;">
                <span style="font-size: 32px; font-weight: bold; letter-spacing: 5px; color: #333; background: #f4f4f4; padding: 10px 20px; border-radius: 5px; border: 1px solid #ccc;">${otpCode}</span>
            </div>
            <p style="color: #666; font-size: 14px;">This OTP is valid for 10 minutes. If you did not expect this email, please ignore it.</p>
            <hr style="border: none; border-top: 1px solid #eee; margin: 20px 0;">
            <p style="text-align: center; color: #999; font-size: 12px;">&copy; 2026 TalentCIO. All rights reserved.</p>
        </div>
    `,
    text: [
        'Welcome to TalentCIO!',
        `Hello ${firstName},`,
        'Use this OTP to reset your password on first login.',
        `OTP: ${otpCode}`,
        'This OTP is valid for 10 minutes.'
    ].join('\n')
});

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
            const jwtToken = generateToken(user._id, user.tokenVersion);
            setSessionCookie(res, req, jwtToken);
            res.status(201).json({
                _id: user._id,
                firstName: user.firstName,
                email: user.email,
                token: jwtToken
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
        if (!req.companyId && req.body.companyId) {
            req.companyId = req.body.companyId;
        }

        if (!req.companyId) {
            const matchedUsers = await User.find({
                email: normalizedEmail,
                isActive: { $ne: false }
            })
                .select('_id companyId')
                .limit(2)
                .lean();

            if (matchedUsers.length === 1 && matchedUsers[0]?.companyId) {
                req.companyId = matchedUsers[0].companyId;
                req.company = await Company.findById(req.companyId).lean();
            } else if (matchedUsers.length > 1) {
                return res.status(400).json({
                    message: 'Multiple workspaces found for this email. Please use your workspace login link.'
                });
            }
        }

        if (!req.companyId) {
            return res.status(401).json({ message: 'Invalid email or password' });
        }

        const company = req.company || await Company.findById(req.companyId).lean();

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
            const branding = await getCompanyEmailBranding(user.companyId, req.company);
            const delivery = await NotificationService.getEmailPreferenceForEvent(
                user.companyId,
                'employee_first_login_otp'
            );
            const otpEmail = buildOtpEmailContent(user.firstName, otpCode);

            sendEmailForCompany({
                companyId: user.companyId,
                emailAccountId: delivery.emailAccountId,
                to: user.email,
                subject: otpEmail.subject,
                html: otpEmail.html,
                text: otpEmail.text,
                ...branding
            }).catch(err => {
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
        permissions = augmentPermissionKeysForRoles({ roles: user.roles, permissionKeys: permissions });

        // Wildcard Expansion: If user has '*', provide ALL permissions
        let hasAllPermissions = false;
        const Permission = require('../models/Permission');
        let totalPerms = 0, directReportsCount = 0, taCount = 0, analyticsViewerCount = 0;

        const enabledModules = company?.enabledModules || [];
        const { filterPermissionsByEnabledModules } = require('../utils/enabledModules');

        if (permissions.includes('*')) {
            hasAllPermissions = true;
            const allPermissions = await Permission.find({});
            const filteredAll = filterPermissionsByEnabledModules(allPermissions, enabledModules);

            // Add all permission keys
            const allKeys = filteredAll.map(p => p.key);
            permissions = [...new Set([...permissions, ...allKeys])];

            // Run auth queries in parallel
            const assignedClientNames = getAssignedClientNames(user);
            [directReportsCount, taCount, analyticsViewerCount] = await Promise.all([
                User.countDocuments({ reportingManagers: user._id }),
                HiringRequest.countDocuments({
                    companyId: user.companyId,
                    $or: [
                        { createdBy: user._id },
                        { 'ownership.hiringManager': user._id },
                        { assignedUsers: user._id },
                        { 'ownership.interviewPanel': user._id },
                        ...(assignedClientNames.length > 0 ? [{ client: { $in: assignedClientNames } }] : [])
                    ]
                }),
                HiringRequest.countDocuments({
                    companyId: user.companyId,
                    analyticsViewers: user._id
                })
            ]);
        } else {
            // Run auth queries in parallel
            const assignedClientNames = getAssignedClientNames(user);
            [totalPerms, directReportsCount, taCount, analyticsViewerCount] = await Promise.all([
                Permission.countDocuments({ key: { $ne: '*' } }),
                User.countDocuments({ reportingManagers: user._id }),
                HiringRequest.countDocuments({
                    companyId: user.companyId,
                    $or: [
                        { createdBy: user._id },
                        { 'ownership.hiringManager': user._id },
                        { assignedUsers: user._id },
                        { 'ownership.interviewPanel': user._id },
                        ...(assignedClientNames.length > 0 ? [{ client: { $in: assignedClientNames } }] : [])
                    ]
                }),
                HiringRequest.countDocuments({
                    companyId: user.companyId,
                    analyticsViewers: user._id
                })
            ]);

            if (totalPerms > 0 && permissions.length >= totalPerms) {
                hasAllPermissions = true;
            }
        }

        // Filter permissions based on enabled modules
        permissions = filterPermissionsByEnabledModules(permissions.map(p => ({ key: p })), enabledModules).map(p => p.key);

        // Check if they are an interviewer via per-candidate round assignment (precise check)
        let isInterviewer = false;
        const hasTAAccessByPermission = hasDirectTAPermission(permissions);

        if (taCount === 0 && !hasTAAccessByPermission) {
            const interviewCount = await Candidate.countDocuments({
                'interviewRounds.assignedTo': user._id,
                companyId: user.companyId
            });
            isInterviewer = interviewCount > 0;
        }

        const normalizedCompany = company
            ? { ...company, enabledModules: normalizeEnabledModules(company.enabledModules || []) }
            : null;

        const jwtToken = generateToken(user._id, user.tokenVersion);
        setSessionCookie(res, req, jwtToken);

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
            isTAParticipant: hasTAAccessByPermission || taCount > 0 || isInterviewer,
            isTAAnalyticsViewer: analyticsViewerCount > 0 || permissions.includes('ta.analytics.assigned') || permissions.includes('ta.analytics.global') || permissions.includes('ta.manage') || permissions.includes('*'),
            company: normalizedCompany, // Full configuration for the frontend
            token: jwtToken
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

// @desc    Verify OTP
// @route   POST /api/auth/verify-otp
// @access  Public
const verifyOtp = async (req, res) => {
    if (!req.companyId) {
        req.companyId = req.headers['xtenent'] || req.headers['x-tenant'] || req.headers['x-tenant-id'] || req.body.companyId || req.body.tenant;
    }

    const { email, otp } = req.body;
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

        res.json({ message: 'OTP verified successfully', success: true });
    } catch (error) {
        console.error('VERIFY OTP ERROR:', error);
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

        const branding = await getCompanyEmailBranding(user.companyId, req.company);
        const delivery = await NotificationService.getEmailPreferenceForEvent(
            user.companyId,
            'employee_first_login_otp'
        );
        const otpEmail = buildOtpEmailContent(user.firstName, otpCode);
        const emailSent = await sendEmailForCompany({
            companyId: user.companyId,
            emailAccountId: delivery.emailAccountId,
            to: user.email,
            subject: otpEmail.subject,
            html: otpEmail.html,
            text: otpEmail.text,
            ...branding
        });

        res.json({
            message: 'A new OTP has been sent to your email.',
            emailSent: emailSent
        });
    } catch (error) {
        console.error('RESEND OTP ERROR:', error);
        res.status(500).json({ message: 'Server Error', error: error.message });
    }
};

// @desc    Logout current user and invalidate active JWTs
// @route   POST /api/auth/logout
// @access  Private
const logoutUser = async (req, res) => {
    try {
        await User.findByIdAndUpdate(req.user._id, {
            $inc: { tokenVersion: 1 }
        });
        invalidateAuthUserCache(req.user._id);
        clearSessionCookie(res, req);

        return res.json({ message: 'Logged out successfully' });
    } catch (error) {
        console.error('LOGOUT ERROR:', error);
        return res.status(500).json({ message: 'Server Error', error: error.message });
    }
};

// @desc    Check birthday status for the logged-in employee
// @route   GET /api/auth/birthday-status
// @access  Private
const getBirthdayStatus = async (req, res) => {
    try {
        const EmployeeProfile = require('../models/EmployeeProfile');
        const OnboardingEmployee = require('../models/OnboardingEmployee');

        const userId = req.user._id;
        const companyId = req.companyId;

        // 1. Check EmployeeProfile
        const profile = await EmployeeProfile.findOne({ user: userId, companyId }).select('personal.dob');
        let dob = profile?.personal?.dob;

        // 2. Fallback to OnboardingEmployee
        if (!dob) {
            const onboardingRecord = await OnboardingEmployee.findOne({ 
                transferredToUserId: userId, 
                companyId 
            }).select('personalDetails.dateOfBirth');
            dob = onboardingRecord?.personalDetails?.dateOfBirth;
        }

        let isBirthday = false;
        if (dob) {
            const dobDate = new Date(dob);
            const today = new Date();

            // Compare day and month only
            if (dobDate.getDate() === today.getDate() && dobDate.getMonth() === today.getMonth()) {
                isBirthday = true;
            }
        }

        return res.json({
            isBirthday,
            employeeName: `${req.user.firstName || ''} ${req.user.lastName || ''}`.trim()
        });
    } catch (error) {
        console.error('getBirthdayStatus error:', error);
        return res.status(500).json({ message: 'Server Error', error: error.message });
    }
};

// @desc    Change Password (for logged-in user in profile)
// @route   PUT /api/auth/change-password
// @access  Private
const changePassword = async (req, res) => {
    const { currentPassword, newPassword } = req.body;

    try {
        const user = await User.findById(req.user._id);

        if (!user) {
            return res.status(404).json({ message: 'User not found' });
        }

        // Check if current password is correct
        const isMatch = await user.matchPassword(currentPassword);
        if (!isMatch) {
            return res.status(400).json({ message: 'Incorrect current password' });
        }

        // Validate new password strength
        const passwordRegex = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[!@#$%^&*(),.?":{}|<>])[A-Za-z\d!@#$%^&*(),.?":{}|<>]{8,}$/;
        if (!passwordRegex.test(newPassword)) {
            return res.status(400).json({ 
                message: 'Password must be at least 8 characters long and contain at least one capital letter, one number, and one special character.' 
            });
        }

        // Update password and save
        user.password = newPassword;
        await user.save();

        res.json({ message: 'Password updated successfully', success: true });
    } catch (error) {
        console.error('CHANGE PASSWORD ERROR:', error);
        res.status(500).json({ message: 'Server Error', error: error.message });
    }
};

module.exports = {
    register,
    loginUser,
    logoutUser,
    uploadProfilePicture,
    verifyOtpAndResetPassword,
    verifyOtp,
    resendOtp,
    getBirthdayStatus,
    changePassword
};

