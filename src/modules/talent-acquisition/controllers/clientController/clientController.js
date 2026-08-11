const { HiringRequest } = require('../../model/hiringRequest.model');
const ClientModel = require('../../../client/client.model');

exports.getTAClients = async (req, res) => {
    try {
        const companyId = req.companyId;

        // Aggregate hiring request counts grouped by client name
        const hrStats = await HiringRequest.aggregate([
            {
                $match: {
                    companyId: companyId,
                    client: { $ne: null, $exists: true, $regex: /\S/ }
                }
            },
            {
                $group: {
                    _id: '$client',
                    activePositions: {
                        $sum: {
                            $cond: [{ $eq: ['$status', 'Approved'] }, 1, 0]
                        }
                    },
                    pendingPositions: {
                        $sum: {
                            $cond: [
                                {
                                    $in: ['$status', ['Pending_Approval', 'Pending_L1', 'Pending_Final', 'Submitted']]
                                },
                                1,
                                0
                            ]
                        }
                    },
                    closedPositions: {
                        $sum: {
                            $cond: [{ $eq: ['$status', 'Closed'] }, 1, 0]
                        }
                    },
                    rejectedPositions: {
                        $sum: {
                            $cond: [{ $eq: ['$status', 'Rejected'] }, 1, 0]
                        }
                    },
                    totalPositions: { $sum: 1 }
                }
            }
        ]);

        const clientStatsMap = new Map();
        hrStats.forEach(item => {
            if (item._id && typeof item._id === 'string' && item._id.trim()) {
                const name = item._id.trim();
                clientStatsMap.set(name.toLowerCase(), {
                    id: name,
                    name: name,
                    activePositions: item.activePositions || 0,
                    pendingPositions: item.pendingPositions || 0,
                    closedPositions: item.closedPositions || 0,
                    rejectedPositions: item.rejectedPositions || 0,
                    totalPositions: item.totalPositions || 0
                });
            }
        });

        // Also fetch active clients from Client model if any
        const registeredClients = await ClientModel.find({
            companyId: companyId,
            status: 'Active'
        }).select('_id name companyName').lean();

        registeredClients.forEach(client => {
            const name = (client.name || client.companyName || '').trim();
            if (name) {
                const key = name.toLowerCase();
                if (!clientStatsMap.has(key)) {
                    clientStatsMap.set(key, {
                        id: String(client._id),
                        name: name,
                        activePositions: 0,
                        pendingPositions: 0,
                        closedPositions: 0,
                        rejectedPositions: 0,
                        totalPositions: 0
                    });
                } else {
                    const existing = clientStatsMap.get(key);
                    existing.id = String(client._id);
                }
            }
        });

        const result = Array.from(clientStatsMap.values()).sort((a, b) => a.name.localeCompare(b.name));

        res.json(result);
    } catch (error) {
        console.error('Error fetching TA clients:', error);
        res.status(500).json({ message: 'Failed to fetch clients', error: error.message });
    }
};
