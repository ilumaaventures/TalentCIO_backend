/**
 * Middleware to enforce plan-level restrictions and trial periods.
 * Checks if the company is active, suspended, or if their trial has expired.
 */
const planGuard = (req, res, next) => {
    const { company } = req;

    // 1. Skip if no company context (root domain or superadmin)
    if (!company) {
        return next();
    }

    // 2. Check for Suspended status
    if (company.status === 'Suspended') {
        return res.status(403).json({
            message: 'Your workspace has been suspended. Please contact support to restore access.'
        });
    }

    // 3. Check for Inactive status
    if (company.status === 'Inactive') {
        return res.status(403).json({
            message: 'Your workspace is currently inactive.'
        });
    }

    // 4. Check for Trial Expiry
    if (company.status === 'Trial' && company.trialEndsAt) {
        const now = new Date();
        const expiryDate = new Date(company.trialEndsAt);

        if (now > expiryDate) {
            // Block all operations except GET (viewing) could be a choice, 
            // but usually we block everything or redirect to billing.
            // For now, let's block POST/PUT/DELETE to prevent data changes.
            if (['POST', 'PUT', 'DELETE', 'PATCH'].includes(req.method)) {
                return res.status(403).json({
                    message: 'Your trial period has expired. Please upgrade to a paid plan to continue using this workspace.'
                });
            }

            // Optionally, we could let them VIEW their data for a few more days
            // but the user said "Trial period auto-expiry" so we enforce it.
        }
    }

    next();
};

module.exports = planGuard;
