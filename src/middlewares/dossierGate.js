/**
 * dossierGate.js
 * Express middleware that blocks employees from performing key actions
 * (attendance clock-in, timesheet submit, leave apply) until their mandatory
 * Employee Dossier fields are fully filled.
 *
 * Bypass conditions (either one is sufficient):
 *   - User holds an admin role (Admin / Super Admin / System Admin)
 *   - User has the `dossier.bypass_completeness_gate` permission
 *   - User has wildcard `*` permissions
 */

const EmployeeProfile = require('../models/EmployeeProfile');
const { checkDossierCompleteness } = require('../utils/dossierCompleteness');

const ADMIN_ROLE_NAMES = new Set(['Admin', 'Super Admin', 'System Admin']);

const getRoleName = (role) => (typeof role === 'string' ? role : role?.name);

const dossierGate = async (req, res, next) => {
    try {
        const user = req.user;
        if (!user) return res.status(401).json({ message: 'Not authorized' });

        // --- Bypass: admin role ---
        const roles = Array.isArray(user.roles) ? user.roles : [];
        const isAdmin = roles.some((r) => ADMIN_ROLE_NAMES.has(getRoleName(r)));
        if (isAdmin) return next();

        // --- Bypass: bypass permission or wildcard ---
        const permissions = Array.isArray(user.permissions) ? user.permissions : [];
        const hasBypass =
            permissions.includes('*') ||
            permissions.includes('dossier.bypass_completeness_gate');
        if (hasBypass) return next();

        // --- Fetch dossier ---
        const profile = await EmployeeProfile.findOne({ user: user._id })
            .select('personal contact employment hris documentSubmissionStatus documents +identity.aadhaarNumber +identity.panNumber')
            .lean();

        // If no dossier exists at all, treat as incomplete
        const { isComplete, missingSections, missingFields } = checkDossierCompleteness(profile || {});

        if (isComplete) return next();

        return res.status(403).json({
            code: 'DOSSIER_INCOMPLETE',
            message: 'Your employee profile is incomplete. Please fill in all required fields before performing this action.',
            missingSections,
            missingFields
        });
    } catch (err) {
        console.error('[dossierGate] Error:', err);
        return res.status(500).json({ message: 'Server error while checking profile completeness.' });
    }
};

module.exports = { dossierGate };
