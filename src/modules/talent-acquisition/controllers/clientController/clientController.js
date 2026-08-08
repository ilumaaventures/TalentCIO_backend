const { HiringRequest } = require('../../model/hiringRequest.model');
const { getClientAssignedUserIds } = require('../../../client/clientAssignmentSync');

exports.getTAClients = async (req, res) => {
    try {
        const clients = await HiringRequest.distinct('client', {
            companyId: req.companyId,
            client: { $ne: null, $exists: true }
        });

        const activeClients = clients.filter(c => typeof c === 'string' && c.trim().length > 0);

        res.json(activeClients);
    } catch (error) {
        console.error('Error fetching TA clients:', error);
        res.status(500).json({ message: 'Failed to fetch clients', error: error.message });
    }
};
