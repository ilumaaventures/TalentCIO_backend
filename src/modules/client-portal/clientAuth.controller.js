const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const ClientUser = require('./clientUser.model');
const Client = require('../client/client.model');

const generateClientToken = (user) => {
    return jwt.sign(
        {
            id: user._id,
            clientId: user.clientId,
            companyId: user.companyId,
            tokenVersion: user.tokenVersion || 0,
            type: 'client'
        },
        process.env.JWT_SECRET,
        { expiresIn: '7d' }
    );
};

exports.login = async (req, res) => {
    try {
        const { email, password } = req.body;
        if (!email || !password) {
            return res.status(400).json({ message: 'Email and password are required' });
        }

        const query = {
            email: String(email).trim().toLowerCase(),
            isDeleted: false
        };
        if (req.companyId) {
            query.companyId = req.companyId;
        }

        const user = await ClientUser.findOne(query);
        if (!user) {
            return res.status(401).json({ message: 'Invalid credentials' });
        }

        const isMatch = await user.matchPassword(password);
        if (!isMatch) {
            return res.status(401).json({ message: 'Invalid credentials' });
        }

        if (user.status !== 'Active') {
            return res.status(403).json({ message: `Account is ${user.status.toLowerCase()}` });
        }

        const client = await Client.findById(user.clientId)
            .select('_id name companyName status taStatus')
            .lean();

        if (!client || client.isDeleted || client.status === 'Inactive' || client.taStatus === 'Inactive') {
            return res.status(403).json({ message: 'Client organization is currently inactive' });
        }

        user.lastLoginAt = new Date();
        await user.save();

        const token = generateClientToken(user);
        const userObj = user.toObject();
        delete userObj.password;

        return res.json({
            token,
            user: userObj,
            client: {
                _id: client._id,
                name: client.name || client.companyName
            }
        });
    } catch (error) {
        console.error('Client login error:', error);
        return res.status(500).json({ message: 'Login failed', error: error.message });
    }
};

exports.acceptInvite = async (req, res) => {
    try {
        const { token, password, firstName, lastName, phone } = req.body;
        if (!token || !password) {
            return res.status(400).json({ message: 'Invite token and password are required' });
        }

        const user = await ClientUser.findOne({
            inviteToken: token,
            inviteExpires: { $gt: new Date() },
            isDeleted: false
        });

        if (!user) {
            return res.status(400).json({ message: 'Invalid or expired invitation token' });
        }

        if (firstName) user.firstName = firstName.trim();
        if (lastName !== undefined) user.lastName = lastName.trim();
        if (phone !== undefined) user.phone = phone.trim();

        user.password = password;
        user.status = 'Active';
        user.inviteToken = null;
        user.inviteExpires = null;
        user.lastLoginAt = new Date();

        await user.save();

        const authToken = generateClientToken(user);
        const userObj = user.toObject();
        delete userObj.password;

        const client = await Client.findById(user.clientId).select('_id name companyName').lean();

        return res.json({
            message: 'Invitation accepted successfully',
            token: authToken,
            user: userObj,
            client: client ? { _id: client._id, name: client.name || client.companyName } : null
        });
    } catch (error) {
        console.error('Accept invite error:', error);
        return res.status(500).json({ message: 'Failed to accept invitation', error: error.message });
    }
};

exports.getMe = async (req, res) => {
    return res.json({
        user: req.clientUser,
        client: req.client ? {
            _id: req.client._id,
            name: req.client.name || req.client.companyName
        } : null
    });
};

exports.forgotPassword = async (req, res) => {
    try {
        const { email } = req.body;
        if (!email) {
            return res.status(400).json({ message: 'Email is required' });
        }

        const query = {
            email: String(email).trim().toLowerCase(),
            isDeleted: false
        };
        if (req.companyId) {
            query.companyId = req.companyId;
        }

        const user = await ClientUser.findOne(query);
        if (!user || user.status !== 'Active') {
            // Return 200 to prevent user enumeration
            return res.json({ message: 'If an account exists with this email, password reset instructions have been generated.' });
        }

        const resetToken = crypto.randomBytes(32).toString('hex');
        user.resetPasswordToken = resetToken;
        user.resetPasswordExpires = new Date(Date.now() + 3600 * 1000); // 1 hour
        await user.save();

        console.log(`[CLIENT_AUTH] Password reset token generated for ${user.email}: ${resetToken}`);

        return res.json({
            message: 'If an account exists with this email, password reset instructions have been generated.',
            resetToken // Included for development/testing convenience
        });
    } catch (error) {
        console.error('Client forgot password error:', error);
        return res.status(500).json({ message: 'Failed to process password reset request', error: error.message });
    }
};

exports.resetPassword = async (req, res) => {
    try {
        const { token, password } = req.body;
        if (!token || !password) {
            return res.status(400).json({ message: 'Reset token and new password are required' });
        }

        const user = await ClientUser.findOne({
            resetPasswordToken: token,
            resetPasswordExpires: { $gt: new Date() },
            isDeleted: false
        });

        if (!user) {
            return res.status(400).json({ message: 'Invalid or expired password reset token' });
        }

        user.password = password;
        user.resetPasswordToken = null;
        user.resetPasswordExpires = null;
        user.tokenVersion = (user.tokenVersion || 0) + 1;
        await user.save();

        return res.json({ message: 'Password reset successfully. You may now log in with your new password.' });
    } catch (error) {
        console.error('Client reset password error:', error);
        return res.status(500).json({ message: 'Failed to reset password', error: error.message });
    }
};

exports.logout = async (req, res) => {
    try {
        if (req.clientUser?._id) {
            await ClientUser.findByIdAndUpdate(req.clientUser._id, { $inc: { tokenVersion: 1 } });
        }
        return res.json({ message: 'Logged out successfully' });
    } catch (error) {
        return res.status(500).json({ message: 'Logout failed', error: error.message });
    }
};
