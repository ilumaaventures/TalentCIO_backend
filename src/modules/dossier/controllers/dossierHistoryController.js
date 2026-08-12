const mongoose = require('mongoose');
const AuditLog = require('../../system/auditLog.model');

const trimDossierHistory = async (userId, companyId) => {
    try {
        const userIds = [userId];
        const companyIds = [companyId];
        try {
            userIds.push(new mongoose.Types.ObjectId(userId));
        } catch (e) { }
        try {
            companyIds.push(new mongoose.Types.ObjectId(companyId));
        } catch (e) { }

        const query = {
            module: 'EmployeeDossier',
            $and: [
                {
                    $or: [
                        { companyId: { $in: companyIds } },
                        { company: { $in: companyIds } },
                        { 'details.companyId': { $in: companyIds } },
                        { 'details.company': { $in: companyIds } },
                        {
                            $and: [
                                { companyId: { $exists: false } },
                                { company: { $exists: false } },
                                { 'details.companyId': { $exists: false } },
                                { 'details.company': { $exists: false } }
                            ]
                        }
                    ]
                },
                {
                    $or: [
                        { 'details.targetUser': { $in: userIds } },
                        { 'details.targetuser': { $in: userIds } }
                    ]
                }
            ]
        };

        const logs = await AuditLog.find(query)
            .select('_id')
            .sort({ createdAt: -1 });

        if (logs.length > 30) {
            const idsToDelete = logs.slice(30).map(log => log._id);
            await AuditLog.deleteMany({ _id: { $in: idsToDelete } });
            console.log(`[DossierHistory] Trimmed ${idsToDelete.length} logs for user ${userId}`);
        }
    } catch (err) {
        console.error('[DossierHistory] Trim error:', err);
    }
};

const logDossierActivity = async ({ action, performedBy, companyId, details, ipAddress }) => {
    try {
        const newLog = await AuditLog.create({
            action,
            module: 'EmployeeDossier',
            performedBy,
            companyId,
            details,
            ipAddress
        });

        const targetUserId = details?.targetUser || details?.targetuser;
        if (targetUserId && companyId) {
            trimDossierHistory(targetUserId, companyId).catch(err =>
                console.error('[DossierHistory] Background trim error:', err)
            );
        }
        return newLog;
    } catch (err) {
        console.error('[DossierHistory] Failed to log activity:', err);
    }
};

exports.getDossierHistory = async (req, res) => {
    try {
        const { userId } = req.params;

        const userIds = [userId];
        const companyIds = [req.companyId];
        try {
            userIds.push(new mongoose.Types.ObjectId(userId));
        } catch (e) { }
        try {
            companyIds.push(new mongoose.Types.ObjectId(req.companyId));
        } catch (e) { }

        const logs = await AuditLog.find({
            module: 'EmployeeDossier',
            $and: [
                {
                    $or: [
                        { companyId: { $in: companyIds } },
                        { company: { $in: companyIds } },
                        { 'details.companyId': { $in: companyIds } },
                        { 'details.company': { $in: companyIds } },
                        {
                            $and: [
                                { companyId: { $exists: false } },
                                { company: { $exists: false } },
                                { 'details.companyId': { $exists: false } },
                                { 'details.company': { $exists: false } }
                            ]
                        }
                    ]
                },
                {
                    $or: [
                        { 'details.targetUser': { $in: userIds } },
                        { 'details.targetuser': { $in: userIds } }
                    ]
                }
            ]
        })
            .populate('performedBy', 'firstName lastName')
            .sort({ createdAt: -1 })
            .limit(30);

        res.status(200).json(logs);
    } catch (error) {
        console.error('Fetch History Error:', error);
        res.status(500).json({ message: 'Server Error' });
    }
};

exports.logDossierActivity = logDossierActivity;
exports.trimDossierHistory = trimDossierHistory;
