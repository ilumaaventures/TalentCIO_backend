const jwt = require('jsonwebtoken');
const SuperAdminUser = require('../models/SuperAdminUser');
const ActivityLog = require('../models/ActivityLog');

const generateToken = (id) => jwt.sign(
    { id, type: 'superadmin' },
    process.env.JWT_SECRET,
    { expiresIn: '7d' }
);

// POST /api/superadmin/auth/login
const login = async (req, res) => {
    try {
        const { email, password } = req.body;
        const admin = await SuperAdminUser.findOne({ email });
        if (!admin || !(await admin.matchPassword(password))) {
            return res.status(401).json({ message: 'Invalid email or password' });
        }
        if (!admin.isActive) return res.status(403).json({ message: 'Account is deactivated' });

        admin.lastLogin = new Date();
        await admin.save({ validateBeforeSave: false });

        res.json({
            token: generateToken(admin._id),
            admin: {
                _id: admin._id,
                name: admin.name,
                email: admin.email,
                role: admin.role,
                permissions: admin.permissions,
                avatar: admin.avatar,
            }
        });
    } catch (err) {
        res.status(500).json({ message: err.message });
    }
};

// GET /api/superadmin/auth/me
const getMe = async (req, res) => {
    res.json(req.superAdmin);
};

// POST /api/superadmin/auth/seed  (dev utility — create first super admin)
const seedSuperAdmin = async (req, res) => {
    try {
        const existing = await SuperAdminUser.findOne({ role: 'Super Admin' });
        if (existing) return res.status(400).json({ message: 'Super Admin already exists. Email: ' + existing.email });

        const admin = await SuperAdminUser.create({
            name: 'Super Admin',
            email: 'superadmin@talentcio.com',
            password: 'SuperAdmin@123',
            role: 'Super Admin',
        });
        res.status(201).json({ message: 'Super Admin seeded', email: admin.email, password: 'SuperAdmin@123' });
    } catch (err) {
        res.status(500).json({ message: err.message });
    }
};

// PUT /api/superadmin/auth/profile
const updateProfile = async (req, res) => {
    try {
        const { name, email } = req.body;
        const admin = await SuperAdminUser.findById(req.superAdmin._id);

        if (!admin) return res.status(404).json({ message: 'Admin not found' });

        if (name) admin.name = name;
        if (email) admin.email = email;

        await admin.save();

        res.json({
            message: 'Profile updated successfully',
            admin: {
                _id: admin._id,
                name: admin.name,
                email: admin.email,
                role: admin.role,
                permissions: admin.permissions,
                avatar: admin.avatar,
            }
        });
    } catch (err) {
        res.status(500).json({ message: err.message });
    }
};

// PUT /api/superadmin/auth/password
const updatePassword = async (req, res) => {
    try {
        const { currentPassword, newPassword } = req.body;
        const admin = await SuperAdminUser.findById(req.superAdmin._id);

        if (!admin) return res.status(404).json({ message: 'Admin not found' });

        if (!(await admin.matchPassword(currentPassword))) {
            return res.status(401).json({ message: 'Invalid current password' });
        }

        admin.password = newPassword;
        await admin.save();

        res.json({ message: 'Password updated successfully' });
    } catch (err) {
        res.status(500).json({ message: err.message });
    }
};

module.exports = { login, getMe, seedSuperAdmin, updateProfile, updatePassword };
