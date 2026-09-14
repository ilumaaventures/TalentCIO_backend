const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const ClientUser = require('./clientUser.model');
const Client = require('../client/client.model');
const Company = require('../company/company.model');
const { sendEmailForCompany } = require('../../services/companyEmailService');

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

        const company = await Company.findById(user.companyId)
            .select('name settings.logo settings.themeColor')
            .lean();

        return res.json({
            token,
            user: userObj,
            client: {
                _id: client._id,
                name: client.name || client.companyName
            },
            agency: company ? {
                _id: company._id,
                name: company.name,
                logo: company.settings?.logo || null,
                themeColor: company.settings?.themeColor || '#4f46e5'
            } : null
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
        const company = await Company.findById(user.companyId).select('name settings.logo settings.themeColor').lean();

        return res.json({
            message: 'Invitation accepted successfully',
            token: authToken,
            user: userObj,
            client: client ? { _id: client._id, name: client.name || client.companyName } : null,
            agency: company ? {
                _id: company._id,
                name: company.name,
                logo: company.settings?.logo || null,
                themeColor: company.settings?.themeColor || '#4f46e5'
            } : null
        });
    } catch (error) {
        console.error('Accept invite error:', error);
        return res.status(500).json({ message: 'Failed to accept invitation', error: error.message });
    }
};

exports.getMe = async (req, res) => {
    let agency = null;
    if (req.companyId) {
        const company = await Company.findById(req.companyId).select('name settings.logo settings.themeColor').lean();
        if (company) {
            agency = {
                _id: company._id,
                name: company.name,
                logo: company.settings?.logo || null,
                themeColor: company.settings?.themeColor || '#4f46e5'
            };
        }
    }

    return res.json({
        user: req.clientUser,
        client: req.client ? {
            _id: req.client._id,
            name: req.client.name || req.client.companyName
        } : null,
        agency
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

        const origin = req.headers.origin || process.env.FRONTEND_URL || 'http://localhost:5174';
        const resetLink = `${origin}/client-portal/reset-password?token=${resetToken}`;

        try {
            await sendEmailForCompany({
                companyId: user.companyId,
                to: user.email,
                subject: 'Reset Your Client Portal Password',
                html: `
                    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; border: 1px solid #e2e8f0; border-radius: 8px;">
                        <h2 style="color: #4f46e5; margin-bottom: 16px;">Password Reset Request</h2>
                        <p style="color: #475569; font-size: 14px; line-height: 1.5;">Hello ${user.firstName || 'there'},</p>
                        <p style="color: #475569; font-size: 14px; line-height: 1.5;">We received a request to reset the password for your Client Portal account. Click the button below to choose a new password:</p>
                        <div style="margin: 24px 0; text-align: center;">
                            <a href="${resetLink}" style="display: inline-block; background-color: #4f46e5; color: #ffffff; padding: 12px 24px; font-size: 14px; font-weight: bold; text-decoration: none; border-radius: 6px;">Reset Password</a>
                        </div>
                        <p style="color: #64748b; font-size: 12px; line-height: 1.5;">This link will expire in 1 hour. If you did not request a password reset, you can safely ignore this email.</p>
                    </div>
                `,
                tags: ['CLIENT_PASSWORD_RESET']
            });
        } catch (mailErr) {
            console.error('Failed to dispatch client password reset email:', mailErr);
        }

        return res.json({
            message: 'If an account exists with this email, password reset instructions have been generated.'
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
