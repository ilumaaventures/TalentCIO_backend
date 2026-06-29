const Company = require('../models/Company');
const { hasEnabledModule, normalizeEnabledModules } = require('../utils/enabledModules');

/**
 * Middleware factory that checks if a specific module is enabled for the requesting tenant.
 * Prevents API-level access to disabled modules even if someone bypasses the frontend.
 *
 * Usage: router.use(requireModule('attendance'))
 *
 * HIGH-4 Performance: tenantMiddleware now selects enabledModules, so req.company.enabledModules
 * is always available without an extra DB query. The fallback DB call only fires on routes
 * that bypass tenantMiddleware (superadmin routes, /api/v1, etc.).
 *
 * @param {string|string[]} moduleIds - The module ID(s) to check
 */
const requireModule = (moduleIds) => async (req, res, next) => {
    try {
        const idsToCheck = Array.isArray(moduleIds) ? moduleIds : [moduleIds];

        let company = req.company;

        if (!company) {
            const companyId = req.companyId || req.user?.companyId;
            if (!companyId) {
                return res.status(403).json({ message: 'No tenant context found. Please access via your workspace URL.' });
            }
            // Fallback DB query — only hits on routes that bypass tenantMiddleware
            company = await Company.findById(companyId).select('enabledModules status').lean();
        }

        if (!company) {
            return res.status(404).json({ message: 'Company not found.' });
        }

        if (company.status === 'Suspended') {
            return res.status(403).json({ message: 'This workspace is suspended.' });
        }

        const enabledModules = normalizeEnabledModules(company.enabledModules || []);
        const isEnabled = idsToCheck.some(id => hasEnabledModule(enabledModules, id));

        if (!isEnabled) {
            return res.status(403).json({
                message: `Required module(s) [${idsToCheck.join(', ')}] are not enabled for your workspace. Please contact your administrator.`
            });
        }

        next();
    } catch (err) {
        console.error(`[ModuleGuard] Error checking module '${moduleIds}':`, err);
        res.status(500).json({ message: 'Error verifying module access.' });
    }
};

module.exports = { requireModule };
