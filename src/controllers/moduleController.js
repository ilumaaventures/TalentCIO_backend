const Company = require('../models/Company');
const ActivityLog = require('../models/ActivityLog');
const { ALL_COMPANY_MODULES, hasEnabledModule, normalizeEnabledModules } = require('../utils/enabledModules');
const { invalidateTenantCache } = require('../middlewares/tenantMiddleware');

// GET /api/superadmin/companies/:id/modules
const getModules = async (req, res) => {
    try {
        const company = await Company.findById(req.params.id).select('enabledModules name');
        if (!company) return res.status(404).json({ message: 'Company not found' });
        const enabledModules = normalizeEnabledModules(company.enabledModules);
        const modules = ALL_COMPANY_MODULES.map(m => ({
            ...m,
            enabled: hasEnabledModule(enabledModules, m.id)
        }));
        res.json({ companyName: company.name, modules });
    } catch (err) {
        res.status(500).json({ message: err.message });
    }
};

// PUT /api/superadmin/companies/:id/modules
const updateModules = async (req, res) => {
    try {
        const enabledModules = normalizeEnabledModules(req.body?.enabledModules);
        
        // Find current state first for logging
        const existing = await Company.findById(req.params.id).select('enabledModules');
        if (!existing) return res.status(404).json({ message: 'Company not found' });

        const previous = normalizeEnabledModules(existing.enabledModules || []);

        // Use findByIdAndUpdate to perform a partial update and avoid validation errors on unrelated required fields
        const company = await Company.findByIdAndUpdate(
            req.params.id,
            { $set: { enabledModules: enabledModules || [] } },
            { new: true, runValidators: true }
        );

        invalidateTenantCache(company.subdomain);

        // Safety check for req.superAdmin
        const adminInfo = req.superAdmin ? {
            id: req.superAdmin._id,
            name: req.superAdmin.name,
            email: req.superAdmin.email
        } : null;

        await ActivityLog.create({
            action: 'MODULES_UPDATED',
            entity: 'Company',
            entityId: company._id,
            performedBy: adminInfo,
            companyId: company._id,
            details: { previous, updated: enabledModules },
        });

        res.json({ enabledModules: normalizeEnabledModules(company.enabledModules || []), message: 'Modules updated' });
    } catch (err) {
        console.error('Update Modules Error:', err);
        res.status(500).json({ message: err.message });
    }
};

// GET /api/superadmin/modules  — all available modules list
const listAllModules = async (req, res) => {
    res.json(ALL_COMPANY_MODULES);
};

module.exports = { getModules, updateModules, listAllModules };
