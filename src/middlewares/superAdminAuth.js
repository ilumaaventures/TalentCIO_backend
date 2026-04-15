const jwt = require('jsonwebtoken');
const SuperAdminUser = require('../models/SuperAdminUser');

const protectSuperAdmin = async (req, res, next) => {
    let token;
    if (req.headers.authorization && req.headers.authorization.startsWith('Bearer')) {
        token = req.headers.authorization.split(' ')[1];
    }
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
