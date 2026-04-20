const Company = require('../models/Company');
const User = require('../models/User');
const Role = require('../models/Role');
const Permission = require('../models/Permission');
const ActivityLog = require('../models/ActivityLog');
const Attendance = require('../models/Attendance');
const LeaveRequest = require('../models/LeaveRequest');

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

// PUT /api/superadmin/companies/:id
const updateCompany = async (req, res) => {
    try {
        console.log(`[updateCompany] Updating company ${req.params.id} with body:`, JSON.stringify(req.body, null, 2));

        const company = await Company.findById(req.params.id);

        if (!company) {
            console.warn(`[updateCompany] Company ${req.params.id} not found`);
            return res.status(404).json({ message: 'Company not found' });
        }

        // Basic Info Update
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

        // Deep Settings Update
        if (req.body.settings) {
            const flattened = flattenObject(req.body.settings, 'settings');
            console.log('[updateCompany] Applying flattened settings:', JSON.stringify(flattened, null, 2));
            
            Object.entries(flattened).forEach(([path, value]) => {
                company.set(path, value);
            });
            
            company.markModified('settings');
        }

        await company.save();

        console.log(`[updateCompany] Successfully updated company ${req.params.id}. Final requireAttachment:`, company.settings?.timesheet?.requireAttachment);

        await logActivity('COMPANY_UPDATED', 'Company', company._id, req.superAdmin, company._id, req.body);
        res.json(company);
    } catch (err) {
        console.error('[updateCompany] Error:', err);
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

module.exports = { getAllCompanies, getCompanyById, createCompany, updateCompany, toggleCompanyStatus, deleteCompany, getCompanyAnalytics };
