const { HiringRequest } = require('../../hiringRequest.model');
const Candidate = require('../../candidate.model');
const Company = require('../../../company/company.model');
const { buildAccessibleHiringRequestQuery } = require('../../utils/hiringRequestAccess');
const { normalizeClientName } = require('../../../client/clientAssignmentSync');

exports.getGlobalAnalytics = async (req, res) => {
    try {
        res.set('Cache-Control', 'private, max-age=60, stale-while-revalidate=60');
        const accessibleQuery = await buildAccessibleHiringRequestQuery(req.companyId, req.user);
        const requisitions = await HiringRequest.find(accessibleQuery).select('_id status recruitmentTeam').lean();
        const reqIds = requisitions.map(r => r._id);

        const candidates = await Candidate.find({
            companyId: req.companyId,
            hiringRequestId: { $in: reqIds }
        }).select('status decision phase2Decision phase3Decision isTransferred transferredFrom hiringRequestId').lean();

        let totalSourced = 0;
        let totalInterviewed = 0;
        let totalOffered = 0;
        let totalJoined = 0;

        candidates.forEach(c => {
            totalSourced++;
            if (c.status === 'Interview Scheduled' || c.status === 'Interview Completed' || c.decision !== 'None' || c.phase2Decision !== 'None') {
                totalInterviewed++;
            }
            if (c.phase3Decision === 'Offer Sent' || c.phase3Decision === 'Offer Accepted') {
                totalOffered++;
            }
            if (c.phase3Decision === 'Joined') {
                totalJoined++;
            }
        });

        res.json({
            summary: {
                totalRequisitions: requisitions.length,
                activeRequisitions: requisitions.filter(r => r.status === 'Approved').length,
                totalSourced,
                totalInterviewed,
                totalOffered,
                totalJoined
            }
        });
    } catch (error) {
        console.error('Error fetching global analytics:', error);
        res.status(500).json({ message: 'Failed to fetch analytics', error: error.message });
    }
};

exports.getClientAnalytics = async (req, res) => {
    try {
        const { clientName } = req.params;
        const normalizedClient = normalizeClientName(decodeURIComponent(clientName));

        const accessibleQuery = await buildAccessibleHiringRequestQuery(req.companyId, req.user);
        const requisitions = await HiringRequest.find({
            ...accessibleQuery,
            client: normalizedClient
        }).select('_id status roleDetails employmentDetails').lean();

        const reqIds = requisitions.map(r => r._id);

        const candidates = await Candidate.find({
            companyId: req.companyId,
            hiringRequestId: { $in: reqIds }
        }).select('status decision phase2Decision phase3Decision hiringRequestId').lean();

        res.json({
            client: normalizedClient,
            requisitionsCount: requisitions.length,
            candidatesCount: candidates.length,
            requisitions,
            candidates
        });
    } catch (error) {
        console.error('Error fetching client analytics:', error);
        res.status(500).json({ message: 'Failed to fetch client analytics', error: error.message });
    }
};

exports.getInterviewAnalytics = async (req, res) => {
    try {
        const accessibleQuery = await buildAccessibleHiringRequestQuery(req.companyId, req.user);
        const requisitions = await HiringRequest.find(accessibleQuery).select('_id').lean();
        const reqIds = requisitions.map(r => r._id);

        const candidates = await Candidate.find({
            companyId: req.companyId,
            hiringRequestId: { $in: reqIds },
            $or: [
                { status: { $in: ['Interview Scheduled', 'Interview Completed'] } },
                { decision: { $ne: 'None' } }
            ]
        }).select('candidateName email mobile status decision phase2Decision hiringRequestId').lean();

        res.json(candidates);
    } catch (error) {
        console.error('Error fetching interview analytics:', error);
        res.status(500).json({ message: 'Failed to fetch interview analytics', error: error.message });
    }
};
