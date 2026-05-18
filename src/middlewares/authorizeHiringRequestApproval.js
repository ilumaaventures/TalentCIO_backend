const { getUserPermissionKeys } = require('../utils/hiringRequestAccess');
const { canUseDelegatedPermission } = require('../utils/permissionDelegation');

const authorizeHiringRequestApproval = async (req, res, next) => {
    try {
        if (!req.user) {
            return res.status(401).json({ message: 'User not authenticated' });
        }

        const permissions = getUserPermissionKeys(req.user);
        if (
            permissions.includes('*')
            || permissions.includes('ta.hiring_request.manage')
            || permissions.includes('ta.super_approve')
        ) {
            return next();
        }

        const { allowed } = await canUseDelegatedPermission({
            companyId: req.companyId,
            delegateUserId: req.user._id,
            permissionKeys: ['ta.hiring_request.manage', 'ta.super_approve'],
            resourceType: 'hiringRequest',
            resourceId: req.params.id
        });

        if (allowed) {
            return next();
        }

        return res.status(403).json({
            message: 'Forbidden: You do not have approval permission for this hiring request'
        });
    } catch (error) {
        return res.status(500).json({
            message: 'Failed to validate approval permissions'
        });
    }
};

module.exports = {
    authorizeHiringRequestApproval
};
