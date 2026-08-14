const mongoose = require('mongoose');
const { HiringRequest } = require('../../model/hiringRequest.model');
const ClientModel = require('../../../client/client.model');

const escapeRegex = (string) => (string || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

exports.getTAClients = async (req, res) => {
    try {
        const companyId = req.companyId;

        // Fetch all registered clients for companyId from ClientModel (Active & Inactive)
        const registeredClients = await ClientModel.find({
            companyId: companyId
        }).select('_id name companyName status taStatus').lean();

        const clientStatsMap = new Map();

        registeredClients.forEach(client => {
            const name = (client.name || client.companyName || '').trim();
            if (name) {
                const key = name.toLowerCase();
                const effectiveTAStatus = (client.status === 'Inactive' || client.taStatus === 'Inactive') ? 'Inactive' : 'Active';
                clientStatsMap.set(key, {
                    id: String(client._id),
                    name: name,
                    status: effectiveTAStatus,
                    activePositions: 0,
                    pendingPositions: 0,
                    closedPositions: 0,
                    rejectedPositions: 0,
                    totalPositions: 0
                });
            }
        });

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
                                    $in: ['$status', ['Pending', 'Pending Approval', 'Pending_Approval', 'Pending_L1', 'Pending_Final', 'Submitted']]
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

        hrStats.forEach(item => {
            if (item._id && typeof item._id === 'string' && item._id.trim()) {
                const name = item._id.trim();
                const key = name.toLowerCase();
                if (clientStatsMap.has(key)) {
                    const existing = clientStatsMap.get(key);
                    existing.activePositions = item.activePositions || 0;
                    existing.pendingPositions = item.pendingPositions || 0;
                    existing.closedPositions = item.closedPositions || 0;
                    existing.rejectedPositions = item.rejectedPositions || 0;
                    existing.totalPositions = item.totalPositions || 0;
                } else {
                    clientStatsMap.set(key, {
                        id: name,
                        name: name,
                        status: 'Active',
                        activePositions: item.activePositions || 0,
                        pendingPositions: item.pendingPositions || 0,
                        closedPositions: item.closedPositions || 0,
                        rejectedPositions: item.rejectedPositions || 0,
                        totalPositions: item.totalPositions || 0
                    });
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

exports.updateClientStatus = async (req, res) => {
    try {
        const { clientName, clientId, status } = req.body;
        const companyId = req.companyId;

        if (!status || !['Active', 'Inactive'].includes(status)) {
            return res.status(400).json({ message: 'Invalid status value. Must be Active or Inactive.' });
        }

        let targetName = clientName ? clientName.trim() : '';
        let clientDoc = null;

        if (clientId && mongoose.Types.ObjectId.isValid(clientId)) {
            clientDoc = await ClientModel.findOne({ _id: clientId, companyId });
        }

        if (!clientDoc && targetName) {
            clientDoc = await ClientModel.findOne({
                companyId,
                name: { $regex: new RegExp('^' + escapeRegex(targetName) + '$', 'i') }
            });
        }

        if (clientDoc) {
            clientDoc.taStatus = status;
            await clientDoc.save();
            targetName = clientDoc.name || targetName;
        } else if (targetName) {
            clientDoc = await ClientModel.create({
                name: targetName,
                companyId,
                status: 'Active',
                taStatus: status
            });
        } else {
            return res.status(400).json({ message: 'Client name or ID is required.' });
        }

        // When client is set to Inactive, move all associated requisitions to Closed and unpublish from job boards
        if (status === 'Inactive' && targetName) {
            const escapedName = escapeRegex(targetName);
            const matchingReqs = await HiringRequest.find({
                companyId,
                client: { $regex: new RegExp('^' + escapedName + '$', 'i') }
            }).select('_id hiringDetails').lean();

            for (const reqDoc of matchingReqs) {
                const hiringDetails = reqDoc.hiringDetails || {};
                const openPos = Math.max(Number(hiringDetails.openPositions) || 0, 0);
                const closedPos = Math.max(Number(hiringDetails.closedPositions) || 0, 0);
                const origPos = Math.max(Number(hiringDetails.originalOpenPositions) || 0, openPos + closedPos, 1);

                await HiringRequest.findByIdAndUpdate(
                    reqDoc._id,
                    {
                        $set: {
                            status: 'Closed',
                            closedAt: new Date(),
                            isPublic: false,
                            isJobVisible: false,
                            isResourceGatewayPublic: false,
                            'hiringDetails.openPositions': 0,
                            'hiringDetails.closedPositions': origPos,
                            'hiringDetails.originalOpenPositions': origPos
                        }
                    }
                );
            }
        }

        return res.json({
            message: `Client status updated to ${status} successfully.`,
            client: clientDoc
        });
    } catch (error) {
        console.error('Error updating client status:', error);
        return res.status(500).json({ message: 'Failed to update client status', error: error.message });
    }
};

