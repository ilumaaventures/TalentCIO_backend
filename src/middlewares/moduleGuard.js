const Company = require('../models/Company');

/**
 * Middleware factory that checks if a specific module is enabled for the requesting tenant.
 * Prevents API-level access to disabled modules even if someone bypasses the frontend.
 * 
 * Usage: router.use(requireModule('attendance'))
 * 
 * @param {string} moduleId - The module ID to check (must match what's stored in Company.enabledModules)
 */
const requireModule = (moduleIds) => async (req, res, next) => {
    try {
        const idsToCheck = Array.isArray(moduleIds) ? moduleIds : [moduleIds];
        // We need the company to check enabled modules.
        // req.company is set by tenantMiddleware when subdomain is detected.
        // On localhost without subdomain, we fall back to the authenticated user's companyId.
        let company = req.company;

        if (!company) {
            const companyId = req.companyId || req.user?.companyId;
            if (!companyId) {
                // No company context at all - this should not happen for tenant routes.
                return res.status(403).json({ message: 'No tenant context found. Please access via your workspace URL.' });
            }
            company = await Company.findById(companyId).select('enabledModules status').lean();
        }

        if (!company) {
            return res.status(404).json({ message: 'Company not found.' });
        }

        if (company.status === 'Suspended') {
            return res.status(403).json({ message: 'This workspace is suspended.' });
        }

        const enabledModules = company.enabledModules || [];
        const isEnabled = idsToCheck.some(id => enabledModules.includes(id));

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
