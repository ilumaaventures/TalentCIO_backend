const User = require('../models/User');
const ActivityLog = require('../models/ActivityLog');
const bcrypt = require('bcrypt');

// GET /api/superadmin/users
const getAllUsers = async (req, res) => {
    try {
        const { page = 1, limit = 25, search = '', companyId = '', isActive = '' } = req.query;
        const filter = {};
        if (search) filter.$or = [
            { firstName: { $regex: search, $options: 'i' } },
            { lastName: { $regex: search, $options: 'i' } },
            { email: { $regex: search, $options: 'i' } },
        ];
        if (companyId) filter.companyId = companyId;
        if (isActive !== '') filter.isActive = isActive === 'true';

        const total = await User.countDocuments(filter);
        const users = await User.find(filter)
            .populate('companyId', 'name subdomain')
            .populate('roles', 'name')
            .select('-password')
            .sort({ createdAt: -1 })
            .skip((page - 1) * limit)
            .limit(Number(limit));

        res.json({ users, total, page: Number(page), totalPages: Math.ceil(total / limit) });
    } catch (err) {
        res.status(500).json({ message: err.message });
    }
};

// PATCH /api/superadmin/users/:id/deactivate
const deactivateUser = async (req, res) => {
    try {
        const user = await User.findById(req.params.id);
        if (!user) return res.status(404).json({ message: 'User not found' });
        user.isActive = !user.isActive;
        user.tokenVersion = (user.tokenVersion || 0) + 1; // Invalidate existing tokens
        await user.save();
        await ActivityLog.create({
            action: user.isActive ? 'USER_ACTIVATED' : 'USER_DEACTIVATED',
            entity: 'User',
            entityId: user._id,
            performedBy: { id: req.superAdmin._id, name: req.superAdmin.name, email: req.superAdmin.email },
            companyId: user.companyId,
            details: { email: user.email, isActive: user.isActive },
        });
        res.json({ isActive: user.isActive, message: `User ${user.isActive ? 'activated' : 'deactivated'}` });
    } catch (err) {
        res.status(500).json({ message: err.message });
    }
};

// POST /api/superadmin/users/:id/reset-password
const resetPassword = async (req, res) => {
    try {
        const user = await User.findById(req.params.id);
        if (!user) return res.status(404).json({ message: 'User not found' });
        const tempPassword = 'Temp@' + Math.random().toString(36).slice(2, 8).toUpperCase();
        user.password = tempPassword;
        user.tokenVersion = (user.tokenVersion || 0) + 1;
        await user.save();
        await ActivityLog.create({
            action: 'USER_PASSWORD_RESET',
            entity: 'User',
            entityId: user._id,
            performedBy: { id: req.superAdmin._id, name: req.superAdmin.name, email: req.superAdmin.email },
            companyId: user.companyId,
        });
        res.json({ message: 'Password reset', tempPassword });
    } catch (err) {
        res.status(500).json({ message: err.message });
    }
};

// PATCH /api/superadmin/users/:id/role
const changeRole = async (req, res) => {
    try {
        const { roles } = req.body;
        const user = await User.findByIdAndUpdate(req.params.id, { roles }, { new: true }).select('-password');
        if (!user) return res.status(404).json({ message: 'User not found' });
        await ActivityLog.create({
            action: 'USER_ROLE_CHANGED',
            entity: 'User',
            entityId: user._id,
            performedBy: { id: req.superAdmin._id, name: req.superAdmin.name, email: req.superAdmin.email },
            companyId: user.companyId,
            details: { roles },
        });
        res.json(user);
    } catch (err) {
        res.status(500).json({ message: err.message });
    }
};

module.exports = { getAllUsers, deactivateUser, resetPassword, changeRole };
