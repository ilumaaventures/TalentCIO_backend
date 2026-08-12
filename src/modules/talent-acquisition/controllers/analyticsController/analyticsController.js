const { HiringRequest } = require('../../model/hiringRequest.model');
const Candidate = require('../../model/candidate.model');
const Company = require('../../../company/company.model');
const { buildAccessibleHiringRequestQuery } = require('../../utils/hiringRequestAccess');
const { normalizeClientName } = require('../../../client/clientAssignmentSync');

exports.getGlobalAnalytics = async (req, res) => {
    try {
        res.set('Cache-Control', 'private, max-age=60, stale-while-revalidate=60');
        const accessibleQuery = await buildAccessibleHiringRequestQuery(req.companyId, req.user);
        const requisitions = await HiringRequest.find(accessibleQuery)
            .select('_id requestId status hiringDetails roleDetails createdAt updatedAt')
            .lean();
        const reqIds = requisitions.map(r => r._id);

        const candidates = await Candidate.find({
            companyId: req.companyId,
            hiringRequestId: { $in: reqIds }
        })
            .select('_id candidateName status decision phase2Decision phase3Decision source isPublicApplication uploadedBy profilePulledBy createdAt updatedAt offerJoiningDate')
            .populate('uploadedBy', 'firstName lastName')
            .lean();

        // 1. Requisitions & Open Positions Metrics
        const totalReqs = requisitions.length;
        const approvedReqs = requisitions.filter(r => r.status === 'Approved');

        let totalOpenPositions = 0;
        approvedReqs.forEach(r => {
            const openings = Number(r.hiringDetails?.numberOfOpenings || r.numberOfOpenings || 1);
            totalOpenPositions += isNaN(openings) ? 1 : openings;
        });

        // 2. Candidate Metrics
        const totalSourced = candidates.length;
        let offersReleased = 0;
        let totalJoined = 0;
        let totalTimeToHireDays = 0;
        let joinedCountWithDates = 0;

        candidates.forEach(c => {
            const isOffered = ['Offer Sent', 'Offer Accepted', 'Joined'].includes(c.phase3Decision) ||
                              ['Offer Sent', 'Offer Accepted', 'Joined'].includes(c.status);
            const isJoined = c.phase3Decision === 'Joined' || c.status === 'Joined';

            if (isOffered) {
                offersReleased++;
            }
            if (isJoined) {
                totalJoined++;
                if (c.createdAt && c.updatedAt) {
                    const days = Math.max(1, Math.round((new Date(c.updatedAt) - new Date(c.createdAt)) / (1000 * 60 * 60 * 24)));
                    totalTimeToHireDays += days;
                    joinedCountWithDates++;
                }
            }
        });

        const offerAcceptanceRate = offersReleased > 0 ? Number(((totalJoined / offersReleased) * 100).toFixed(1)) : 0;
        const joiningConversionRate = totalSourced > 0 ? Number(((totalJoined / totalSourced) * 100).toFixed(1)) : 0;
        const avgTimeToHire = joinedCountWithDates > 0 ? Math.round(totalTimeToHireDays / joinedCountWithDates) : 0;

        let totalTimeToFillDays = 0;
        let closedReqCount = 0;
        requisitions.filter(r => r.status === 'Closed').forEach(r => {
            if (r.createdAt && r.updatedAt) {
                const days = Math.max(1, Math.round((new Date(r.updatedAt) - new Date(r.createdAt)) / (1000 * 60 * 60 * 24)));
                totalTimeToFillDays += days;
                closedReqCount++;
            }
        });
        const avgTimeToFill = closedReqCount > 0 ? Math.round(totalTimeToFillDays / closedReqCount) : 0;

        const topMetrics = {
            totalOpenPositions,
            totalReqs,
            offersReleased,
            offerAcceptanceRate,
            totalJoined,
            avgTimeToHire,
            joiningConversionRate,
            avgTimeToFill
        };

        // 3. Monthly Sourcing Trend (Last 6 months)
        const monthMap = new Map();
        const now = new Date();
        for (let i = 5; i >= 0; i--) {
            const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
            const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
            monthMap.set(key, 0);
        }

        candidates.forEach(c => {
            if (c.createdAt) {
                const d = new Date(c.createdAt);
                const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
                if (monthMap.has(key)) {
                    monthMap.set(key, monthMap.get(key) + 1);
                }
            }
        });

        const monthlyTrend = Array.from(monthMap.entries()).map(([month, sourced]) => ({
            month,
            sourced
        }));

        // 4. Source Breakdown
        const sourceMap = new Map();
        candidates.forEach(c => {
            let srcName = 'Direct';
            if (c.isPublicApplication) {
                srcName = 'Public Job Board';
            } else if (c.source && String(c.source).trim()) {
                srcName = String(c.source).trim();
            }
            sourceMap.set(srcName, (sourceMap.get(srcName) || 0) + 1);
        });

        const sourceAnalysis = Array.from(sourceMap.entries()).map(([name, sourced]) => ({
            name: name === 'Public Job Board' ? 'Public Applications' : name,
            sourced
        })).sort((a, b) => b.sourced - a.sourced);

        // 5. Sourcing Performance by Recruiter/User
        const userMap = new Map();
        candidates.forEach(c => {
            let uName = 'System';
            if (c.uploadedBy) {
                uName = typeof c.uploadedBy === 'string'
                    ? c.uploadedBy
                    : `${c.uploadedBy.firstName || ''} ${c.uploadedBy.lastName || ''}`.trim() || 'System';
            } else if (c.profilePulledBy) {
                uName = String(c.profilePulledBy).trim();
            }

            if (!userMap.has(uName)) {
                userMap.set(uName, { recruiter: uName, sourced: 0, interviewed: 0, joined: 0 });
            }
            const stat = userMap.get(uName);
            stat.sourced++;
            if (c.status === 'Interview Scheduled' || c.decision !== 'None' || c.phase2Decision !== 'None') {
                stat.interviewed++;
            }
            if (c.phase3Decision === 'Joined' || c.status === 'Joined') {
                stat.joined++;
            }
        });

        const sourcingPerformance = Array.from(userMap.values()).sort((a, b) => b.sourced - a.sourced);

        res.json({
            success: true,
            data: {
                topMetrics,
                monthlyTrend,
                sourceAnalysis,
                sourcingPerformance,
                metricTrends: {
                    offerAcceptanceRate: { direction: 'up', percentage: 0 },
                    joiningConversionRate: { direction: 'up', percentage: 0 },
                    avgTimeToHire: { direction: 'down', percentage: 0 },
                    avgTimeToFill: { direction: 'down', percentage: 0 }
                }
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
        const { hiringRequestId } = req.query;
        const normalizedClient = normalizeClientName(decodeURIComponent(clientName));

        const accessibleQuery = await buildAccessibleHiringRequestQuery(req.companyId, req.user);
        const requisitions = await HiringRequest.find({
            ...accessibleQuery,
            client: normalizedClient
        }).select('_id requestId status roleDetails employmentDetails createdAt closedAt').lean();

        const requisitionsList = requisitions.map(r => ({
            id: r._id.toString(),
            requestId: r.requestId,
            title: r.roleDetails?.title || r.roleDetails?.jobTitle || 'Requisition',
            status: r.status
        }));

        let filteredReqs = requisitions;
        if (hiringRequestId && hiringRequestId !== 'All' && mongoose.Types.ObjectId.isValid(hiringRequestId)) {
            filteredReqs = requisitions.filter(r => r._id.toString() === hiringRequestId);
        }

        const reqIds = filteredReqs.map(r => r._id);

        const candidates = await Candidate.find({
            companyId: req.companyId,
            hiringRequestId: { $in: reqIds }
        }).select('status decision phase2Decision phase3Decision interviewRounds profileShared hiringRequestId').lean();

        const activeReqs = filteredReqs.filter(r => r.status !== 'Closed' && r.status !== 'Rejected').length;
        const closedReqs = filteredReqs.filter(r => r.status === 'Closed').length;

        const totalOpenPositions = filteredReqs.reduce((sum, r) => {
            const count = Number(r.employmentDetails?.openPositions || r.employmentDetails?.numberOfPositions || 0);
            return sum + (isNaN(count) ? 0 : count);
        }, 0);

        const totalSourced = candidates.length;

        const joinedCount = candidates.filter(c => c.status === 'Joined' || c.decision === 'Joined' || c.decision === 'Selected' || c.phase3Decision === 'Joined').length;
        const phase2ShortlistedCount = candidates.filter(c => c.decision === 'Shortlisted' || c.phase2Decision === 'Shortlisted').length;
        const phase2InInterviewsCount = candidates.filter(c => {
            const status = String(c.status || '').toLowerCase();
            return status.includes('interview') || (Array.isArray(c.interviewRounds) && c.interviewRounds.length > 0);
        }).length;

        const pipeline = {
            'Phase 2 Shortlisted': phase2ShortlistedCount,
            'Phase 2 In Interviews': phase2InInterviewsCount,
            'Joined': joinedCount
        };

        const hiringRatio = totalSourced > 0 ? Math.round((joinedCount / totalSourced) * 100) : 0;

        const analyticsData = {
            client: normalizedClient,
            totalReqs: filteredReqs.length,
            activeReqs,
            closedReqs,
            totalOpenPositions,
            totalSourced,
            pipeline,
            hiringRatio,
            requisitionsList,
            requisitionsCount: filteredReqs.length,
            candidatesCount: candidates.length,
            requisitions: filteredReqs,
            candidates
        };

        res.json({
            success: true,
            data: analyticsData,
            ...analyticsData
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
