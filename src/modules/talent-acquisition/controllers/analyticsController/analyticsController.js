const { HiringRequest } = require('../../model/hiringRequest.model');
const Candidate = require('../../model/candidate.model');
const PublicApplication = require('../../model/publicApplication.model');
const Company = require('../../../company/company.model');
const { buildAccessibleHiringRequestQuery } = require('../../utils/hiringRequestAccess');
const { normalizeClientName } = require('../../../client/clientAssignmentSync');

exports.getGlobalAnalytics = async (req, res) => {
    try {
        res.set('Cache-Control', 'private, max-age=60, stale-while-revalidate=60');
        const accessibleQuery = await buildAccessibleHiringRequestQuery(req.companyId, req.user);

        // 1. Fetch all accessible requisitions for this user/company
        const allRequisitions = await HiringRequest.find({
            ...accessibleQuery,
            isDeleted: { $ne: true }
        })
            .select('_id requestId status hiringDetails roleDetails client department createdAt updatedAt closedAt')
            .lean();

        const allReqIds = allRequisitions.map(r => r._id);

        // 2. Fetch all candidates across accessible requisitions
        const allCandidates = await Candidate.find({
            companyId: req.companyId,
            hiringRequestId: { $in: allReqIds },
            isDeleted: { $ne: true }
        })
            .select('_id candidateName status decision phase2Decision phase3Decision source isPublicApplication uploadedBy profilePulledBy calledBy createdAt updatedAt offerJoiningDate hiringRequestId interviewRounds phase2InterviewStatus currentPhaseStatus currentPhaseName')
            .populate('uploadedBy', 'firstName lastName')
            .lean();

        // 3. Fetch all public applications across accessible requisitions
        const allPublicApps = await PublicApplication.find({
            companyId: req.companyId,
            hiringRequestId: { $in: allReqIds }
        }).lean();

        // 4. Generate dynamic filter options for UI dropdowns
        const clientSet = new Set();
        const deptSet = new Set();
        const posSet = new Set();
        allRequisitions.forEach(r => {
            const clientName = (r.client || r.roleDetails?.client || r.hiringDetails?.client || '').trim();
            if (clientName) clientSet.add(clientName);
            const deptName = (r.department || r.roleDetails?.department || r.hiringDetails?.department || '').trim();
            if (deptName) deptSet.add(deptName);
            const posTitle = (r.roleDetails?.title || r.title || r.requestId || '').trim();
            if (posTitle) posSet.add(posTitle);
        });

        const pulledBySet = new Set();
        const uploadedBySet = new Set();
        const calledBySet = new Set();
        allCandidates.forEach(c => {
            if (c.profilePulledBy && String(c.profilePulledBy).trim()) {
                pulledBySet.add(String(c.profilePulledBy).trim());
            }
            if (c.uploadedBy) {
                const uName = typeof c.uploadedBy === 'string'
                    ? c.uploadedBy.trim()
                    : `${c.uploadedBy.firstName || ''} ${c.uploadedBy.lastName || ''}`.trim();
                if (uName) uploadedBySet.add(uName);
            }
            if (c.calledBy && String(c.calledBy).trim()) {
                calledBySet.add(String(c.calledBy).trim());
            }
        });

        const filterOptions = {
            clients: Array.from(clientSet).sort((a, b) => a.localeCompare(b)),
            departments: Array.from(deptSet).sort((a, b) => a.localeCompare(b)),
            positions: Array.from(posSet).sort((a, b) => a.localeCompare(b)),
            pulledBys: Array.from(pulledBySet).sort((a, b) => a.localeCompare(b)),
            uploadedBys: Array.from(uploadedBySet).sort((a, b) => a.localeCompare(b)),
            calledBys: Array.from(calledBySet).sort((a, b) => a.localeCompare(b)),
            requisitions: allRequisitions.map(r => ({
                _id: r._id.toString(),
                title: r.roleDetails?.title || r.title || r.requestId || 'Untitled Requisition',
                client: r.client || r.roleDetails?.client || r.hiringDetails?.client || '',
                status: r.status,
                createdAt: r.createdAt
            }))
        };

        // 5. Apply query filters if provided
        const {
            client: filterClient,
            department: filterDept,
            position: filterPos,
            pulledBy: filterPulledBy,
            uploadedBy: filterUploadedBy,
            calledBy: filterCalledBy,
            startDate: filterStartDate,
            endDate: filterEndDate,
            phase: filterPhase,
            requisitionId: filterReqId
        } = req.query;

        let filteredRequisitions = allRequisitions;

        if (filterClient && filterClient.trim()) {
            const normFilterClient = normalizeClientName(filterClient);
            filteredRequisitions = filteredRequisitions.filter(r => {
                const cName = normalizeClientName(r.client || r.roleDetails?.client || r.hiringDetails?.client);
                return cName === normFilterClient;
            });
        }

        if (filterDept && filterDept.trim()) {
            filteredRequisitions = filteredRequisitions.filter(r => {
                const dName = (r.department || r.roleDetails?.department || r.hiringDetails?.department || '').trim();
                return dName.toLowerCase() === filterDept.trim().toLowerCase();
            });
        }

        if (filterPos && filterPos.trim()) {
            filteredRequisitions = filteredRequisitions.filter(r => {
                const pTitle = (r.roleDetails?.title || r.title || r.requestId || '').trim();
                return pTitle.toLowerCase() === filterPos.trim().toLowerCase();
            });
        }

        if (filterReqId && filterReqId.trim()) {
            filteredRequisitions = filteredRequisitions.filter(r => String(r._id) === String(filterReqId.trim()));
        }

        if (filterStartDate) {
            const startD = new Date(filterStartDate);
            if (!isNaN(startD.getTime())) {
                filteredRequisitions = filteredRequisitions.filter(r => new Date(r.createdAt) >= startD);
            }
        }

        if (filterEndDate) {
            const endD = new Date(filterEndDate + 'T23:59:59.999Z');
            if (!isNaN(endD.getTime())) {
                filteredRequisitions = filteredRequisitions.filter(r => new Date(r.createdAt) <= endD);
            }
        }

        const filteredReqIds = new Set(filteredRequisitions.map(r => String(r._id)));

        // Apply filters to candidates
        let filteredCandidates = allCandidates.filter(c => filteredReqIds.has(String(c.hiringRequestId)));

        if (filterPulledBy && filterPulledBy.trim()) {
            filteredCandidates = filteredCandidates.filter(c => String(c.profilePulledBy || '').trim() === filterPulledBy.trim());
        }

        if (filterUploadedBy && filterUploadedBy.trim()) {
            filteredCandidates = filteredCandidates.filter(c => {
                const uName = typeof c.uploadedBy === 'string'
                    ? c.uploadedBy.trim()
                    : `${c.uploadedBy?.firstName || ''} ${c.uploadedBy?.lastName || ''}`.trim();
                return uName.toLowerCase() === filterUploadedBy.trim().toLowerCase();
            });
        }

        if (filterCalledBy && filterCalledBy.trim()) {
            filteredCandidates = filteredCandidates.filter(c => String(c.calledBy || '').trim() === filterCalledBy.trim());
        }

        if (filterStartDate) {
            const startD = new Date(filterStartDate);
            if (!isNaN(startD.getTime())) {
                filteredCandidates = filteredCandidates.filter(c => new Date(c.createdAt) >= startD);
            }
        }

        if (filterEndDate) {
            const endD = new Date(filterEndDate + 'T23:59:59.999Z');
            if (!isNaN(endD.getTime())) {
                filteredCandidates = filteredCandidates.filter(c => new Date(c.createdAt) <= endD);
            }
        }

        // Apply Phase filter if selected
        if (filterPhase === '1') {
            // All phase 1 / initial candidates
        } else if (filterPhase === '2') {
            // Progressed to Phase 2
            filteredCandidates = filteredCandidates.filter(c =>
                ['Shortlisted', 'Interview Scheduled', 'Interview Completed', 'Selected', 'Joined', 'Offer Sent', 'Offer Accepted'].includes(c.decision) ||
                (c.phase2Decision && c.phase2Decision !== 'None') ||
                (Array.isArray(c.interviewRounds) && c.interviewRounds.length > 0) ||
                c.phase2InterviewStatus === 'Scheduled' ||
                ['Phase 2', 'Interview'].includes(c.currentPhaseName)
            );
        } else if (filterPhase === '3') {
            // Progressed to Phase 3
            filteredCandidates = filteredCandidates.filter(c =>
                ['Shortlisted', 'Selected', 'Joined', 'Offer Sent', 'Offer Accepted'].includes(c.phase2Decision) ||
                (c.phase3Decision && c.phase3Decision !== 'None') ||
                ['Offer Sent', 'Offer Accepted', 'Joined'].includes(c.status) ||
                ['Phase 3', 'Offer', 'Joining'].includes(c.currentPhaseName)
            );
        }

        // Filter public applications
        let filteredPublicApps = allPublicApps.filter(pa => filteredReqIds.has(String(pa.hiringRequestId)));
        if (filterStartDate) {
            const startD = new Date(filterStartDate);
            if (!isNaN(startD.getTime())) {
                filteredPublicApps = filteredPublicApps.filter(pa => new Date(pa.createdAt) >= startD);
            }
        }
        if (filterEndDate) {
            const endD = new Date(filterEndDate + 'T23:59:59.999Z');
            if (!isNaN(endD.getTime())) {
                filteredPublicApps = filteredPublicApps.filter(pa => new Date(pa.createdAt) <= endD);
            }
        }

        // 6. Compute Top Metrics
        const totalReqs = filteredRequisitions.length;
        let totalOpenPositions = 0;
        filteredRequisitions.filter(r => r.status === 'Approved').forEach(r => {
            const openings = Number(r.hiringDetails?.openPositions || r.hiringDetails?.numberOfOpenings || r.numberOfOpenings || 1);
            totalOpenPositions += isNaN(openings) ? 1 : openings;
        });

        const totalSourced = filteredCandidates.length;
        let interviewsScheduled = 0;
        let offersReleased = 0;
        let totalJoined = 0;
        let totalTimeToHireDays = 0;
        let joinedCountWithDates = 0;

        filteredCandidates.forEach(c => {
            const isInterview = c.status === 'Interview Scheduled' ||
                (Array.isArray(c.interviewRounds) && c.interviewRounds.length > 0) ||
                c.phase2InterviewStatus === 'Scheduled' ||
                ['Interview Scheduled', 'Interview Completed'].includes(c.currentPhaseStatus);
            if (isInterview) interviewsScheduled++;

            const isOffered = ['Offer Sent', 'Offer Accepted', 'Joined'].includes(c.phase3Decision) ||
                ['Offer Sent', 'Offer Accepted', 'Joined'].includes(c.status);
            if (isOffered) offersReleased++;

            const isJoined = c.phase3Decision === 'Joined' || c.status === 'Joined' || c.decision === 'Joined';
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
        filteredRequisitions.filter(r => r.status === 'Closed').forEach(r => {
            const refEnd = r.closedAt || r.updatedAt;
            if (r.createdAt && refEnd) {
                const days = Math.max(1, Math.round((new Date(refEnd) - new Date(r.createdAt)) / (1000 * 60 * 60 * 24)));
                totalTimeToFillDays += days;
                closedReqCount++;
            }
        });
        const avgTimeToFill = closedReqCount > 0 ? Math.round(totalTimeToFillDays / closedReqCount) : 0;

        let conversionRate = joiningConversionRate;
        if (filterPhase === '1') {
            const p1Prog = filteredCandidates.filter(c => c.decision === 'Shortlisted' || (c.phase2Decision && c.phase2Decision !== 'None')).length;
            conversionRate = totalSourced > 0 ? Number(((p1Prog / totalSourced) * 100).toFixed(1)) : 0;
        } else if (filterPhase === '2') {
            const p2Prog = filteredCandidates.filter(c => ['Shortlisted', 'Selected', 'Offer Sent', 'Joined'].includes(c.phase2Decision) || (c.phase3Decision && c.phase3Decision !== 'None')).length;
            conversionRate = totalSourced > 0 ? Number(((p2Prog / totalSourced) * 100).toFixed(1)) : 0;
        } else if (filterPhase === '3') {
            conversionRate = offerAcceptanceRate;
        }

        const topMetrics = {
            totalReqs,
            totalOpenPositions,
            totalSourced,
            interviewsScheduled,
            offersReleased,
            totalJoined,
            offerAcceptanceRate,
            joiningConversionRate,
            conversionRate,
            avgTimeToHire,
            avgTimeToFill
        };

        // 7. Pipeline Distribution
        let pSourced = 0;
        let pScreened = 0;
        let pInterviewing = 0;
        let pOffered = 0;
        let pJoined = 0;
        let pRejected = 0;

        filteredCandidates.forEach(c => {
            if (c.phase3Decision === 'Joined' || c.status === 'Joined' || c.decision === 'Joined') {
                pJoined++;
            } else if (['Offer Sent', 'Offer Accepted'].includes(c.phase3Decision) || ['Offer Sent', 'Offer Accepted'].includes(c.status)) {
                pOffered++;
            } else if (c.status === 'Interview Scheduled' || (Array.isArray(c.interviewRounds) && c.interviewRounds.length > 0) || c.phase2InterviewStatus === 'Scheduled') {
                pInterviewing++;
            } else if (c.decision === 'Rejected' || c.phase2Decision === 'Rejected' || c.phase3Decision === 'Rejected' || c.status === 'Rejected') {
                pRejected++;
            } else if (c.decision === 'Shortlisted' || c.phase2Decision === 'Shortlisted') {
                pScreened++;
            } else {
                pSourced++;
            }
        });

        const pipelineDistribution = [
            { name: 'Sourced Pool', value: pSourced },
            { name: 'Screened / Shortlisted', value: pScreened },
            { name: 'In Interviews', value: pInterviewing },
            { name: 'Offer Extended', value: pOffered },
            { name: 'Joined', value: pJoined },
            { name: 'Rejected / Dropped', value: pRejected }
        ].filter(item => item.value > 0);

        // 8. Recruitment Funnel
        const screenedCount = filteredCandidates.filter(c =>
            c.decision !== 'None' ||
            c.phase2Decision !== 'None' ||
            c.status !== 'Interested' ||
            (Array.isArray(c.interviewRounds) && c.interviewRounds.length > 0)
        ).length;

        const recruitmentFunnel = [
            { name: 'Sourced', value: totalSourced },
            { name: 'Screened', value: Math.min(totalSourced, screenedCount) },
            { name: 'Interviewed', value: Math.min(screenedCount, interviewsScheduled) },
            { name: 'Offered', value: Math.min(interviewsScheduled || screenedCount, offersReleased) },
            { name: 'Joined', value: totalJoined }
        ];

        // 9. Public Applications Breakdown & Sourcing Channels
        let pubPending = 0;
        let pubShortlisted = 0;
        let pubTransferred = 0;
        let pubRejected = 0;
        const pubSourceMap = new Map();

        filteredPublicApps.forEach(pa => {
            const st = pa.reviewStatus || 'Pending Review';
            if (st === 'Pending Review') pubPending++;
            else if (st === 'Shortlisted') pubShortlisted++;
            else if (st === 'Transferred to Candidate') pubTransferred++;
            else if (st === 'Rejected') pubRejected++;

            const src = pa.source || 'Public Job Board';
            pubSourceMap.set(src, (pubSourceMap.get(src) || 0) + 1);
        });

        const publicAppBreakdown = {
            total: filteredPublicApps.length,
            pending: pubPending,
            shortlisted: pubShortlisted,
            transferred: pubTransferred,
            rejected: pubRejected
        };

        const publicSourceAnalysis = Array.from(pubSourceMap.entries()).map(([name, value]) => ({
            name,
            value
        }));

        // 10. Department Analysis
        const reqById = new Map(allRequisitions.map(r => [String(r._id), r]));
        const deptMap = new Map();

        filteredCandidates.forEach(c => {
            const req = reqById.get(String(c.hiringRequestId || ''));
            const dept = (req?.department || req?.roleDetails?.department || req?.hiringDetails?.department || 'Unassigned').trim();
            if (!deptMap.has(dept)) {
                deptMap.set(dept, { name: dept, sourced: 0, interviewed: 0, offered: 0, joined: 0 });
            }
            const st = deptMap.get(dept);
            st.sourced++;
            if (c.status === 'Interview Scheduled' || (Array.isArray(c.interviewRounds) && c.interviewRounds.length > 0)) {
                st.interviewed++;
            }
            if (['Offer Sent', 'Offer Accepted', 'Joined'].includes(c.phase3Decision) || ['Offer Sent', 'Offer Accepted', 'Joined'].includes(c.status)) {
                st.offered++;
            }
            if (c.phase3Decision === 'Joined' || c.status === 'Joined' || c.decision === 'Joined') {
                st.joined++;
            }
        });

        const departmentAnalysis = Array.from(deptMap.values())
            .sort((a, b) => b.sourced - a.sourced)
            .slice(0, 10);

        // 11. Monthly Sourcing & Joined Trend
        const monthMap = new Map();
        const now = new Date();
        for (let i = 5; i >= 0; i--) {
            const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
            const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
            monthMap.set(key, { month: key, sourced: 0, joined: 0 });
        }

        filteredCandidates.forEach(c => {
            if (c.createdAt) {
                const d = new Date(c.createdAt);
                const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
                if (monthMap.has(key)) {
                    monthMap.get(key).sourced++;
                }
            }
            const isJoined = c.phase3Decision === 'Joined' || c.status === 'Joined' || c.decision === 'Joined';
            if (isJoined) {
                const d = new Date(c.offerJoiningDate || c.updatedAt || c.createdAt);
                const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
                if (monthMap.has(key)) {
                    monthMap.get(key).joined++;
                }
            }
        });

        const monthlyTrend = Array.from(monthMap.values());

        // 12. Sourcing Performance by Recruiter
        const userMap = new Map();
        filteredCandidates.forEach(c => {
            let uName = 'Direct / Unassigned';
            if (c.uploadedBy) {
                uName = typeof c.uploadedBy === 'string'
                    ? c.uploadedBy
                    : `${c.uploadedBy.firstName || ''} ${c.uploadedBy.lastName || ''}`.trim() || 'Direct / Unassigned';
            } else if (c.profilePulledBy && String(c.profilePulledBy).trim()) {
                uName = String(c.profilePulledBy).trim();
            }

            if (!userMap.has(uName)) {
                userMap.set(uName, { name: uName, sourced: 0, interviews: 0, offers: 0, joined: 0 });
            }
            const stat = userMap.get(uName);
            stat.sourced++;
            if (c.status === 'Interview Scheduled' || c.decision !== 'None' || c.phase2Decision !== 'None' || (Array.isArray(c.interviewRounds) && c.interviewRounds.length > 0)) {
                stat.interviews++;
            }
            if (['Offer Sent', 'Offer Accepted', 'Joined'].includes(c.phase3Decision) || ['Offer Sent', 'Offer Accepted', 'Joined'].includes(c.status)) {
                stat.offers++;
            }
            if (c.phase3Decision === 'Joined' || c.status === 'Joined' || c.decision === 'Joined') {
                stat.joined++;
            }
        });

        const sourcingPerformance = Array.from(userMap.values())
            .map(rec => ({
                ...rec,
                conversion: rec.sourced > 0 ? Number(((rec.joined / rec.sourced) * 100).toFixed(1)) : 0
            }))
            .sort((a, b) => b.sourced - a.sourced);

        // 13. Position Performance
        const publicAppsByReq = new Map();
        filteredPublicApps.forEach(pa => {
            const rid = String(pa.hiringRequestId || '');
            if (rid) publicAppsByReq.set(rid, (publicAppsByReq.get(rid) || 0) + 1);
        });

        const candByReq = new Map();
        filteredCandidates.forEach(c => {
            const rid = String(c.hiringRequestId || '');
            if (!candByReq.has(rid)) {
                candByReq.set(rid, { sourced: 0, interviewed: 0, joined: 0 });
            }
            const s = candByReq.get(rid);
            s.sourced++;
            if (c.status === 'Interview Scheduled' || (Array.isArray(c.interviewRounds) && c.interviewRounds.length > 0)) {
                s.interviewed++;
            }
            if (c.phase3Decision === 'Joined' || c.status === 'Joined' || c.decision === 'Joined') {
                s.joined++;
            }
        });

        const positionPerformance = filteredRequisitions.map(r => {
            const rid = String(r._id);
            const stats = candByReq.get(rid) || { sourced: 0, interviewed: 0, joined: 0 };
            const open = Number(r.hiringDetails?.openPositions || r.hiringDetails?.numberOfOpenings || r.numberOfOpenings || 1);
            return {
                id: rid,
                title: r.roleDetails?.title || r.title || r.requestId || 'Untitled',
                client: r.client || r.roleDetails?.client || r.hiringDetails?.client || 'Internal',
                open: isNaN(open) ? 1 : open,
                publicAppsCount: publicAppsByReq.get(rid) || 0,
                interviewed: stats.interviewed,
                joined: stats.joined
            };
        }).sort((a, b) => (b.joined + b.interviewed + b.publicAppsCount) - (a.joined + a.interviewed + a.publicAppsCount));

        // 14. Time Metrics
        const timeMetrics = [
            { name: 'Screening', value: 3 },
            { name: 'Interviews', value: 7 },
            { name: 'Offer Stage', value: 5 },
            { name: 'Time to Hire', value: avgTimeToHire || 14 },
            { name: 'Time to Fill', value: avgTimeToFill || 28 }
        ];

        // 15. Source Analysis
        const srcMap = new Map();
        filteredCandidates.forEach(c => {
            let srcName = 'Direct';
            if (c.isPublicApplication) {
                srcName = 'Public Applications';
            } else if (c.source && String(c.source).trim()) {
                srcName = String(c.source).trim();
            }
            if (!srcMap.has(srcName)) {
                srcMap.set(srcName, { name: srcName, sourced: 0, joined: 0 });
            }
            const s = srcMap.get(srcName);
            s.sourced++;
            if (c.phase3Decision === 'Joined' || c.status === 'Joined' || c.decision === 'Joined') {
                s.joined++;
            }
        });

        const sourceAnalysis = Array.from(srcMap.values()).sort((a, b) => b.sourced - a.sourced);

        res.json({
            success: true,
            data: {
                topMetrics,
                pipelineDistribution,
                recruitmentFunnel,
                departmentAnalysis,
                monthlyTrend,
                sourcingPerformance,
                positionPerformance,
                timeMetrics,
                sourceAnalysis,
                publicAppBreakdown,
                publicSourceAnalysis,
                filterOptions,
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
