const jwt = require('jsonwebtoken');
const SuperAdminUser = require('../models/SuperAdminUser');
const { getTokenFromRequest } = require('../utils/sessionCookies');

const SUPER_ADMIN_SESSION_COOKIE_NAME = 'talentcio_superadmin_session';

const protectSuperAdmin = async (req, res, next) => {
    const token = getTokenFromRequest(req, SUPER_ADMIN_SESSION_COOKIE_NAME);
    if (!token) return res.status(401).json({ message: 'Not authorized, no token' });

    try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        if (decoded.type !== 'superadmin') {
            return res.status(403).json({ message: 'Access denied. Super admin token required.' });
        }
        const admin = await SuperAdminUser.findById(decoded.id).select('-password');
        if (!admin || !admin.isActive) {
            return res.status(401).json({ message: 'Account not found or inactive.' });
        }
        if ((decoded.tokenVersion || 0) !== (admin.tokenVersion || 0)) {
            return res.status(401).json({ message: 'Token invalid or expired' });
        }
        req.superAdmin = admin;
        next();
    } catch (err) {
        return res.status(401).json({ message: 'Token invalid or expired' });
    }
};

const requirePermission = (permission) => (req, res, next) => {
    if (!req.superAdmin) return res.status(401).json({ message: 'Not authorized' });
    if (!req.superAdmin.permissions[permission]) {
        return res.status(403).json({ message: `Permission denied: ${permission}` });
    }
    next();
};

module.exports = { protectSuperAdmin, requirePermission };
