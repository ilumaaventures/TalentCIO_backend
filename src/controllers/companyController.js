const Company = require('../models/Company');
const User = require('../models/User');
const Role = require('../models/Role');
const Permission = require('../models/Permission');
const ActivityLog = require('../models/ActivityLog');
const Attendance = require('../models/Attendance');
const LeaveRequest = require('../models/LeaveRequest');
const {
    normalizeShiftList,
    DEFAULT_SHIFT_CODE,
    DEFAULT_ATTENDANCE_MODE
} = require('../utils/attendancePolicy');

const logActivity = async (action, entity, entityId, admin, companyId = null, details = {}) => {
    try {
        await ActivityLog.create({
            action, entity, entityId,
            performedBy: { id: admin._id, name: admin.name, email: admin.email },
            companyId,
            details,
        });
    } catch (e) { /* non-blocking */ }
};

// GET /api/superadmin/companies
const getAllCompanies = async (req, res) => {
    try {
        const { page = 1, limit = 20, search = '', status = '' } = req.query;
        const filter = {};
        if (search) filter.$or = [
            { name: { $regex: search, $options: 'i' } },
            { subdomain: { $regex: search, $options: 'i' } },
            { email: { $regex: search, $options: 'i' } },
        ];
        if (status) filter.status = status;

        const total = await Company.countDocuments(filter);
        const companies = await Company.find(filter)
            .populate('planId', 'name price billingCycle')
            .sort({ createdAt: -1 })
            .skip((page - 1) * limit)
            .limit(Number(limit));

        res.json({ companies, total, page: Number(page), totalPages: Math.ceil(total / limit) });
    } catch (err) {
        res.status(500).json({ message: err.message });
    }
};

// GET /api/superadmin/companies/:id
const getCompanyById = async (req, res) => {
    try {
        const company = await Company.findById(req.params.id).populate('planId', 'name price billingCycle');
        if (!company) return res.status(404).json({ message: 'Company not found' });
        const userCount = await User.countDocuments({ companyId: company._id });
        const activeUserCount = await User.countDocuments({ companyId: company._id, isActive: true });
        res.json({ ...company.toObject(), userCount, activeUserCount });
    } catch (err) {
        res.status(500).json({ message: err.message });
    }
};

// POST /api/superadmin/companies
const createCompany = async (req, res) => {
    try {
        const { adminUser, ...companyData } = req.body;

        if (!adminUser || !adminUser.email || !adminUser.password || !adminUser.firstName || !adminUser.lastName) {
            return res.status(400).json({ message: 'Admin user details are mandatory for creating a company.' });
        }

        // Validate allowedDomains if provided
        if (companyData.allowedDomains && Array.isArray(companyData.allowedDomains) && companyData.allowedDomains.length > 0) {
            const adminEmailDomain = adminUser.email.split('@')[1];
            if (!companyData.allowedDomains.includes(adminEmailDomain)) {
                return res.status(400).json({ message: `Admin email domain '@${adminEmailDomain}' is not in the allowed domains list: ${companyData.allowedDomains.join(', ')}` });
            }
        }

        // 1. Pre-flight Validation
        const existingSubdomain = await Company.findOne({ subdomain: companyData.subdomain.toLowerCase() });
        if (existingSubdomain) {
            return res.status(400).json({ message: `Subdomain '${companyData.subdomain}' is already taken. Please choose another one.` });
        }

        // 2. Creation Process
        if (companyData.status === 'Trial' && !companyData.trialEndsAt) {
            const plan = await require('../models/Plan').findById(companyData.planId);
            const trialDays = plan ? plan.trialDays : 14;
            companyData.trialEndsAt = new Date(Date.now() + trialDays * 24 * 60 * 60 * 1000);
        }

        const company = await Company.create(companyData);
        let adminRole = null;
        let createdUser = null;

        try {
            // Create Admin role for the company with all permissions
            const allPermissions = await Permission.find({});
            const permissionIds = allPermissions.map(p => p._id);

            adminRole = await Role.create({
                name: 'Admin',
                companyId: company._id,
                permissions: permissionIds,
                isSystem: true
            });

            // Create initial admin user
            createdUser = await User.create({
                firstName: adminUser.firstName,
                lastName: adminUser.lastName,
                email: adminUser.email,
                password: adminUser.password,
                companyId: company._id,
                roles: [adminRole._id],
                isActive: true,
                isPasswordResetRequired: false
            });

            await logActivity('COMPANY_CREATED', 'Company', company._id, req.superAdmin, company._id, { name: company.name, subdomain: company.subdomain });
            res.status(201).json(company);

        } catch (innerErr) {
            // Manual Rollback on failure
            if (createdUser) await User.findByIdAndDelete(createdUser._id);
            if (adminRole) await Role.findByIdAndDelete(adminRole._id);
            if (company) await Company.findByIdAndDelete(company._id);

            throw innerErr; // re-throw to be caught by outer catch
        }

    } catch (err) {
        if (err.code === 11000) {
            console.error('Duplicate Key Error details:', err);
            return res.status(400).json({ message: 'Subdomain or Email already exists', details: err.message });
        }
        res.status(500).json({ message: err.message });
    }
};

// Helper to flatten nested objects for Mongoose $set updates
const flattenObject = (obj, prefix = '') => {
    return Object.keys(obj).reduce((acc, k) => {
        const pre = prefix.length ? prefix + '.' : '';
        if (typeof obj[k] === 'object' && obj[k] !== null && !Array.isArray(obj[k])) {
            Object.assign(acc, flattenObject(obj[k], pre + k));
        } else {
            acc[pre + k] = obj[k];
        }
        return acc;
    }, {});
};

const normalizeStringArray = (value) => (
    Array.isArray(value)
        ? [...new Set(value.map((item) => String(item || '').trim()).filter(Boolean))]
        : []
);

const toBoolean = (value, fallback = false) => {
    if (value === undefined) return fallback;
    return value === true || value === 'true' || value === 'True' || value === 1 || value === '1';
};

const sanitizeAttendanceSelfService = (incoming = {}, current = {}) => ({
    weeklyOff: toBoolean(incoming?.weeklyOff, current?.weeklyOff ?? true),
    workingHours: toBoolean(incoming?.workingHours, current?.workingHours ?? true),
    defaultAttendanceMode: toBoolean(incoming?.defaultAttendanceMode, current?.defaultAttendanceMode ?? true),
    attendanceShifts: toBoolean(incoming?.attendanceShifts, current?.attendanceShifts ?? true),
    exportFormat: toBoolean(incoming?.exportFormat, current?.exportFormat ?? true),
    locationRules: toBoolean(incoming?.locationRules, current?.locationRules ?? true),
    ipRules: toBoolean(incoming?.ipRules, current?.ipRules ?? true)
});

const sanitizeAttendanceSettings = (incoming = {}, current = {}) => {
    const base = {
        ...(current || {}),
        ...(incoming || {})
    };

    const workingHours = Math.max(Number(base.workingHours) || Number(current?.workingHours) || 8, 1);
    const attendanceShifts = normalizeShiftList({
        attendanceShifts: incoming.attendanceShifts !== undefined
            ? incoming.attendanceShifts
            : current?.attendanceShifts,
        workingHours
    });
    const requestedShiftCode = String(
        base.defaultShiftCode || current?.defaultShiftCode || DEFAULT_SHIFT_CODE
    ).trim().toLowerCase();
    const defaultShiftCode = attendanceShifts.some((shift) => shift.code === requestedShiftCode)
        ? requestedShiftCode
        : (attendanceShifts[0]?.code || DEFAULT_SHIFT_CODE);
    const latitude = base.coordinates?.lat !== undefined && base.coordinates?.lat !== ''
        ? Number(base.coordinates.lat)
        : undefined;
    const longitude = base.coordinates?.lng !== undefined && base.coordinates?.lng !== ''
        ? Number(base.coordinates.lng)
        : undefined;

    return {
        ...(current || {}),
        ...(incoming || {}),
        weeklyOff: normalizeStringArray(base.weeklyOff).length > 0
            ? normalizeStringArray(base.weeklyOff)
            : ['Saturday', 'Sunday'],
        workingHours,
        selfService: sanitizeAttendanceSelfService(base.selfService, current?.selfService),
        defaultShiftCode,
        defaultAttendanceMode: base.defaultAttendanceMode === 'present_only'
            ? 'present_only'
            : DEFAULT_ATTENDANCE_MODE,
        attendanceShifts,
        exportFormat: String(base.exportFormat || current?.exportFormat || 'Standard'),
        halfDayAllowed: toBoolean(base.halfDayAllowed, current?.halfDayAllowed ?? true),
        requireLocationCheckIn: toBoolean(base.requireLocationCheckIn, current?.requireLocationCheckIn ?? false),
        requireLocationCheckOut: toBoolean(base.requireLocationCheckOut, current?.requireLocationCheckOut ?? false),
        locationCheck: toBoolean(base.locationCheck, current?.locationCheck ?? false),
        ipCheck: toBoolean(base.ipCheck, current?.ipCheck ?? false),
        allowedRadius: Math.max(Number(base.allowedRadius) || Number(current?.allowedRadius) || 200, 1),
        coordinates: {
            ...(current?.coordinates || {}),
            ...(Number.isFinite(latitude) ? { lat: latitude } : {}),
            ...(Number.isFinite(longitude) ? { lng: longitude } : {})
        },
        allowedIps: normalizeStringArray(base.allowedIps)
    };
};

const buildCompanyEditableAttendanceInput = (incoming = {}, current = {}) => {
    const controls = sanitizeAttendanceSelfService(current?.selfService, current?.selfService);
    const editable = {};

    if (controls.weeklyOff && incoming.weeklyOff !== undefined) {
        editable.weeklyOff = incoming.weeklyOff;
    }
    if (controls.workingHours && incoming.workingHours !== undefined) {
        editable.workingHours = incoming.workingHours;
    }
    if (controls.defaultAttendanceMode) {
        if (incoming.defaultAttendanceMode !== undefined) {
            editable.defaultAttendanceMode = incoming.defaultAttendanceMode;
        }
        if (incoming.defaultShiftCode !== undefined) {
            editable.defaultShiftCode = incoming.defaultShiftCode;
        }
    }
    if (controls.attendanceShifts) {
        if (incoming.attendanceShifts !== undefined) {
            editable.attendanceShifts = incoming.attendanceShifts;
        }
        if (incoming.defaultShiftCode !== undefined) {
            editable.defaultShiftCode = incoming.defaultShiftCode;
        }
    }
    if (controls.exportFormat && incoming.exportFormat !== undefined) {
        editable.exportFormat = incoming.exportFormat;
    }
    if (controls.locationRules) {
        ['requireLocationCheckIn', 'requireLocationCheckOut', 'locationCheck', 'allowedRadius', 'coordinates']
            .forEach((key) => {
                if (incoming[key] !== undefined) {
                    editable[key] = incoming[key];
                }
            });
    }
    if (controls.ipRules) {
        ['ipCheck', 'allowedIps'].forEach((key) => {
            if (incoming[key] !== undefined) {
                editable[key] = incoming[key];
            }
        });
    }

    return editable;
};

// PUT /api/superadmin/companies/:id
const updateCompany = async (req, res) => {
    try {
        const rawRequireAttachmentValue =
            req.body.settings?.timesheet?.requireAttachment ??
            req.body.timesheet?.requireAttachment ??
            req.body.settings?.requireAttachment ??
            req.body.requireAttachment;
        const requireAttachmentSource =
            req.body.settings?.timesheet?.requireAttachment !== undefined ? 'settings.timesheet.requireAttachment' :
            req.body.timesheet?.requireAttachment !== undefined ? 'timesheet.requireAttachment' :
            req.body.settings?.requireAttachment !== undefined ? 'settings.requireAttachment' :
            req.body.requireAttachment !== undefined ? 'requireAttachment' :
            'not_provided';
        const incomingTimesheetSettings = req.body.settings?.timesheet || req.body.timesheet || null;

        console.log('[updateCompany] Request received', {
            companyId: req.params.id,
            updatedBy: req.superAdmin?.email || req.superAdmin?._id || 'unknown',
            topLevelKeys: Object.keys(req.body || {}),
            settingsKeys: Object.keys(req.body.settings || {}),
            incomingRequireAttachment: rawRequireAttachmentValue,
            requireAttachmentSource
        });
        console.log('[FULL BODY]', JSON.stringify(req.body, null, 2));
        console.log('[DEBUG] requireAttachment raw value:', rawRequireAttachmentValue);
        console.log(`[updateCompany] Payload for company ${req.params.id}:`, JSON.stringify(req.body, null, 2));

        const company = await Company.findById(req.params.id);
        if (!company) {
            console.warn(`[updateCompany] Company ${req.params.id} not found`);
            return res.status(404).json({ message: 'Company not found' });
        }
        const existingRequireAttachment = company.settings?.timesheet?.requireAttachment;

        console.log('[updateCompany] Current DB snapshot before update', {
            companyId: company._id.toString(),
            currentRequireAttachment: company.settings?.timesheet?.requireAttachment,
            currentTimesheet: company.settings?.timesheet || {}
        });

        // --- Handle basic fields ---
        const fieldsToUpdate = ['name', 'subdomain', 'email', 'contactPerson', 'contactPhone', 'industry', 'country', 'timezone', 'status', 'planId', 'allowedDomains', 'enabledModules'];
        fieldsToUpdate.forEach(field => {
            if (req.body[field] !== undefined) {
                if (field === 'planId' && req.body[field] === "") {
                    company[field] = null;
                } else {
                    company[field] = req.body[field];
                }
            }
        });

        // --- EXPLICITLY handle requireAttachment from multiple possible payload shapes ---
        if (rawRequireAttachmentValue !== undefined) {
            // Ensure the timesheet object exists
            if (!company.settings) company.settings = {};
            if (!company.settings.timesheet) company.settings.timesheet = {};

            company.settings.timesheet.requireAttachment =
                rawRequireAttachmentValue === true ||
                rawRequireAttachmentValue === 'true' ||
                rawRequireAttachmentValue === 'True' ||
                rawRequireAttachmentValue === 1 ||
                rawRequireAttachmentValue === '1';
            company.markModified('settings.timesheet');
            console.log('[updateCompany] Explicitly set requireAttachment', {
                incomingValue: rawRequireAttachmentValue,
                source: requireAttachmentSource,
                normalizedValue: company.settings.timesheet.requireAttachment
            });
        }

        // --- Handle all other settings via flattening ---
        if (req.body.settings) {
            const { timesheet, attendance, ...otherSettings } = req.body.settings;

            if (attendance) {
                const currentAttendance = company.settings?.attendance?.toObject
                    ? company.settings.attendance.toObject()
                    : (company.settings?.attendance || {});
                company.settings.attendance = sanitizeAttendanceSettings(attendance, currentAttendance);
                company.markModified('settings.attendance');
            }

            // Flatten and apply the rest (themeColor, etc.)
            const flattened = flattenObject(otherSettings, 'settings');
            console.log('[updateCompany] Flattened non-timesheet settings', flattened);
            Object.entries(flattened).forEach(([path, value]) => {
                company.set(path, value);
            });

            company.markModified('settings'); // Fallback
        }

        // Handle timesheet settings whether they arrive inside settings or at root level
        if (incomingTimesheetSettings) {
            console.log('[updateCompany] Incoming timesheet settings', incomingTimesheetSettings);
            Object.keys(incomingTimesheetSettings).forEach(key => {
                if (key !== 'requireAttachment') {
                    if (!company.settings) company.settings = {};
                    if (!company.settings.timesheet) company.settings.timesheet = {};
                    company.settings.timesheet[key] = incomingTimesheetSettings[key];
                }
            });
            company.markModified('settings.timesheet');
        }

        if (
            company.settings?.timesheet &&
            company.settings.timesheet.requireAttachment === undefined &&
            existingRequireAttachment !== undefined
        ) {
            company.settings.timesheet.requireAttachment = existingRequireAttachment;
            company.markModified('settings.timesheet');
            console.log('[FIX] Restored missing requireAttachment to', existingRequireAttachment);
        }

        console.log('[updateCompany] Snapshot before save', {
            companyId: company._id.toString(),
            requireAttachmentBeforeSave: company.settings?.timesheet?.requireAttachment,
            timesheetBeforeSave: company.settings?.timesheet || {}
        });

        await company.save();
        console.log('[updateCompany] Save completed', {
            companyId: company._id.toString(),
            requireAttachmentAfterSave: company.settings?.timesheet?.requireAttachment
        });

        // Verify persistence with a fresh lean fetch
        const updated = await Company.findById(company._id).lean();
        console.log('[updateCompany] Fresh DB read after save', {
            companyId: company._id.toString(),
            finalRequireAttachmentInDb: updated.settings?.timesheet?.requireAttachment,
            finalTimesheetInDb: updated.settings?.timesheet || {}
        });

        await logActivity('COMPANY_UPDATED', 'Company', company._id, req.superAdmin, company._id, req.body);
        res.json(company);
    } catch (err) {
        console.error('[updateCompany] ERROR:', err);
        res.status(500).json({ message: err.message });
    }
};

// GET /api/admin/company-settings/attendance
const getOwnAttendanceSettings = async (req, res) => {
    try {
        const company = req.company || await Company.findById(req.companyId).select('name settings.attendance').lean();
        if (!company) {
            return res.status(404).json({ message: 'Company not found' });
        }

        const attendance = sanitizeAttendanceSettings(
            company?.settings?.attendance || {},
            company?.settings?.attendance || {}
        );

        res.json({
            companyId: req.companyId,
            companyName: company.name,
            attendance
        });
    } catch (err) {
        res.status(500).json({ message: err.message });
    }
};

// PUT /api/admin/company-settings/attendance
const updateOwnAttendanceSettings = async (req, res) => {
    try {
        const company = await Company.findById(req.companyId);
        if (!company) {
            return res.status(404).json({ message: 'Company not found' });
        }

        const incomingAttendance =
            req.body?.attendance ||
            req.body?.settings?.attendance ||
            req.body ||
            {};

        if (!company.settings) {
            company.settings = {};
        }

        const currentAttendance = company.settings.attendance?.toObject
            ? company.settings.attendance.toObject()
            : (company.settings.attendance || {});
        const editableAttendanceInput = buildCompanyEditableAttendanceInput(incomingAttendance, currentAttendance);
        company.settings.attendance = sanitizeAttendanceSettings(editableAttendanceInput, currentAttendance);
        company.markModified('settings.attendance');
        await company.save();

        const actor = {
            _id: req.user?._id,
            name: `${req.user?.firstName || ''} ${req.user?.lastName || ''}`.trim() || req.user?.email || 'Company Admin',
            email: req.user?.email
        };
        await logActivity(
            'COMPANY_ATTENDANCE_SETTINGS_UPDATED',
            'Company',
            company._id,
            actor,
            company._id,
            { updatedKeys: Object.keys(editableAttendanceInput || {}) }
        );

        res.json({
            message: 'Attendance settings updated successfully',
            attendance: company.settings.attendance
        });
    } catch (err) {
        res.status(500).json({ message: err.message });
    }
};

// PATCH /api/superadmin/companies/:id/status
const toggleCompanyStatus = async (req, res) => {
    try {
        const company = await Company.findById(req.params.id);
        if (!company) return res.status(404).json({ message: 'Company not found' });
        const { status } = req.body;
        company.status = status || (company.status === 'Active' ? 'Suspended' : 'Active');
        await company.save();
        await logActivity('COMPANY_STATUS_CHANGED', 'Company', company._id, req.superAdmin, company._id, { status: company.status });
        res.json({ status: company.status, message: `Company ${company.status === 'Active' ? 'enabled' : 'suspended'}` });
    } catch (err) {
        res.status(500).json({ message: err.message });
    }
};

// DELETE /api/superadmin/companies/:id
const deleteCompany = async (req, res) => {
    try {
        const company = await Company.findByIdAndDelete(req.params.id);
        if (!company) return res.status(404).json({ message: 'Company not found' });
        await logActivity('COMPANY_DELETED', 'Company', company._id, req.superAdmin, null, { name: company.name });
        res.json({ message: 'Company deleted' });
    } catch (err) {
        res.status(500).json({ message: err.message });
    }
};

// GET /api/superadmin/companies/:id/analytics
const getCompanyAnalytics = async (req, res) => {
    try {
        const { id } = req.params;
        const company = await Company.findById(id);
        if (!company) return res.status(404).json({ message: 'Company not found' });

        const totalEmployees = await User.countDocuments({ companyId: id });
        const activeUsers = await User.countDocuments({ companyId: id, isActive: true });

        // Employee growth last 12 months
        const now = new Date();
        const months = [];
        for (let i = 11; i >= 0; i--) {
            const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
            months.push({ year: d.getFullYear(), month: d.getMonth() + 1, label: d.toLocaleString('default', { month: 'short' }) });
        }
        const growthData = await Promise.all(months.map(async ({ year, month, label }) => {
            const start = new Date(year, month - 1, 1);
            const end = new Date(year, month, 1);
            const count = await User.countDocuments({ companyId: id, createdAt: { $lt: end } });
            return { month: label, employees: count };
        }));

        const leaveStats = await LeaveRequest.aggregate([
            { $match: { companyId: require('mongoose').Types.ObjectId.createFromHexString(id) } },
            { $group: { _id: '$status', count: { $sum: 1 } } }
        ]);

        res.json({ company, totalEmployees, activeUsers, growthData, leaveStats });
    } catch (err) {
        res.status(500).json({ message: err.message });
    }
};

module.exports = {
    getAllCompanies,
    getCompanyById,
    createCompany,
    updateCompany,
    toggleCompanyStatus,
    deleteCompany,
    getCompanyAnalytics,
    getOwnAttendanceSettings,
    updateOwnAttendanceSettings
};
