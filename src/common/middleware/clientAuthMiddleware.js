const jwt = require('jsonwebtoken');
const ClientUser = require('../../modules/client-portal/clientUser.model');
const Client = require('../../modules/client/client.model');

exports.protectClient = async (req, res, next) => {
    if (!req.headers.authorization?.startsWith('Bearer ')) {
        return res.status(401).json({ message: 'Not authorized, no token' });
    }

    try {
        const token = req.headers.authorization.split(' ')[1];
        const decoded = jwt.verify(token, process.env.JWT_SECRET);

        if (decoded.type !== 'client') {
            return res.status(401).json({ message: 'Invalid token type' });
        }

        const clientUser = await ClientUser.findById(decoded.id)
            .select('-password')
            .lean();

        if (!clientUser || clientUser.isDeleted) {
            return res.status(401).json({ message: 'Client account not found' });
        }

        if (clientUser.status !== 'Active') {
            return res.status(403).json({ message: `Account is ${clientUser.status.toLowerCase()}` });
        }

        if ((decoded.tokenVersion || 0) !== (clientUser.tokenVersion || 0)) {
            return res.status(401).json({ message: 'Session expired' });
        }

        // If tenant context was resolved, verify matching company
        if (req.companyId && String(req.companyId) !== String(clientUser.companyId)) {
            return res.status(403).json({ message: 'Workspace mismatch' });
        }

        // Verify client entity is active
        const client = await Client.findById(clientUser.clientId).select('_id name companyName nickname status taStatus isDeleted').lean();
        if (!client || client.isDeleted || client.status === 'Inactive' || client.taStatus === 'Inactive') {
            return res.status(403).json({ message: 'Client organization is inactive' });
        }

        req.clientUser = clientUser;
        req.clientId = clientUser.clientId;
        req.companyId = clientUser.companyId;
        req.client = client;

        return next();
    } catch (error) {
        return res.status(401).json({ message: 'Not authorized' });
    }
};

exports.requireClientRole = (...roles) => {
    return (req, res, next) => {
        if (!req.clientUser || !roles.includes(req.clientUser.role)) {
            return res.status(403).json({ message: 'Forbidden: Insufficient client portal permissions' });
        }
        next();
    };
};
