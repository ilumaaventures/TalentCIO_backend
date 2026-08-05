const Candidate = require('../../models/Candidate');
const { HiringRequest } = require('../../models/HiringRequest');
const PublicApplication = require('../../models/PublicApplication');
const mongoose = require('mongoose');
const { attachLastApplicationData } = require('../../utils/applicationHistoryUtils');
const {
    TA_CAPABILITIES,
    buildAccessibleCandidateQuery,
    canAccessHiringRequestForCapability
} = require('../../utils/candidateAccess');

const {
    findDuplicateCandidateInCompany,
    isCandidateOwnedByUser,
    canOverrideDuplicateCandidateOwnership,
    buildDuplicateCandidateMessage,
    getUserDisplayName,
    applyDateRangeFilterToCandidateQuery,
    parseStringArrayQuery,
    parseBooleanQueryValue,
    getCandidateUploadedByName,
    getCandidateUploadType,
    isProfileSharedCandidate,
    getLegacyRoundsForPhase,
    hasLegacyPhase2InterviewActivity,
    getLegacyAverageRatingForPhase,
    canAccessHiringRequest,
    serializeCandidateForViewer
} = require('./utils/candidateHelpers');

const checkDuplicateCandidate = async (req, res) => {
    try {
        const { hiringRequestId, email, mobile, allowOwnedDuplicateUpdate } = req.query;

        if (!mongoose.Types.ObjectId.isValid(hiringRequestId)) {
            return res.status(400).json({ message: 'Invalid Hiring Request ID format' });
        }

        const hiringRequest = await HiringRequest.findOne({ _id: hiringRequestId, companyId: req.companyId });
        if (!hiringRequest) {
            return res.status(404).json({ message: 'Hiring request not found' });
        }

        const canManageHiringRequest = await canAccessHiringRequestForCapability(
            hiringRequest,
            req.user,
            TA_CAPABILITIES.EDIT,
            req.companyId
        );

        if (!canManageHiringRequest) {
            return res.status(403).json({ message: 'Forbidden: You do not have permission to add candidates to this requisition' });
        }

        const duplicateCandidate = await findDuplicateCandidateInCompany({
            companyId: req.companyId,
            hiringRequestId,
            email,
            mobile
        });

        const ownedByCurrentUser = duplicateCandidate
            ? isCandidateOwnedByUser(duplicateCandidate, req.user?._id)
            : false;
        const hasDuplicateOverrideAccess = duplicateCandidate
            ? await canOverrideDuplicateCandidateOwnership({
                user: req.user,
                companyId: req.companyId,
                hiringRequest
            })
            : false;
        const canAutoUpdate = Boolean(allowOwnedDuplicateUpdate) && (ownedByCurrentUser || hasDuplicateOverrideAccess);

        return res.status(200).json({
            exists: Boolean(duplicateCandidate),
            canAutoUpdate,
            ownedByCurrentUser,
            uploadedByName: getUserDisplayName(duplicateCandidate?.uploadedBy),
            message: duplicateCandidate
                ? buildDuplicateCandidateMessage(duplicateCandidate, req.user?._id, canAutoUpdate)
                : ''
        });
    } catch (error) {
        console.error('Error checking duplicate candidate:', error);
        return res.status(500).json({ message: 'Server error', error: error.message });
    }
};

const getCandidatesByPulledBy = async (req, res) => {
    try {
        const { userName } = req.params;
        const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
        const limit = Math.max(parseInt(req.query.limit, 10) || 10, 1);
        const skip = (page - 1) * limit;

        const query = await buildAccessibleCandidateQuery(req.companyId, req.user, {
            profilePulledBy: { $regex: new RegExp(`^${userName}$`, 'i') }
        }, { capability: TA_CAPABILITIES.VIEW });

        const [totalCandidates, summaryRows, candidates] = await Promise.all([
            Candidate.countDocuments(query),
            Candidate.aggregate([
                { $match: query },
                {
                    $project: {
                        status: 1,
                        decision: 1,
                        interviewRounds: { $ifNull: ['$interviewRounds', []] }
                    }
                },
                {
                    $addFields: {
                        interviewRoundsCount: { $size: '$interviewRounds' },
                        failedRoundsCount: {
                            $size: {
                                $filter: {
                                    input: '$interviewRounds',
                                    as: 'round',
                                    cond: { $eq: ['$$round.status', 'Failed'] }
                                }
                            }
                        }
                    }
                },
                {
                    $group: {
                        _id: null,
                        total: { $sum: 1 },
                        interested: {
                            $sum: {
                                $cond: [
                                    {
                                        $and: [
                                            { $eq: ['$status', 'Interested'] },
                                            { $not: [{ $in: ['$decision', ['Rejected', 'On Hold', 'Did Not Turn Up']] }] },
                                            { $eq: ['$interviewRoundsCount', 0] }
                                        ]
                                    },
                                    1,
                                    0
                                ]
                            }
                        },
                        inInterviews: {
                            $sum: {
                                $cond: [
                                    {
                                        $and: [
                                            { $gt: ['$interviewRoundsCount', 0] },
                                            { $not: [{ $in: ['$decision', ['Rejected', 'On Hold', 'Did Not Turn Up']] }] },
                                            { $eq: ['$failedRoundsCount', 0] }
                                        ]
                                    },
                                    1,
                                    0
                                ]
                            }
                        },
                        rejected: {
                            $sum: {
                                $cond: [{ $in: ['$decision', ['Rejected', 'Did Not Turn Up']] }, 1, 0]
                            }
                        },
                        onHold: {
                            $sum: {
                                $cond: [{ $eq: ['$decision', 'On Hold'] }, 1, 0]
                            }
                        }
                    }
                }
            ]),
            Candidate.find(query)
                .populate('hiringRequestId', 'requestId roleDetails')
                .populate('uploadedBy', 'firstName lastName email')
                .sort({ uploadedAt: -1 })
                .skip(skip)
                .limit(limit)
                .lean()
        ]);

        const summary = summaryRows[0] || {
            total: totalCandidates,
            interested: 0,
            inInterviews: 0,
            rejected: 0,
            onHold: 0
        };

        res.status(200).json({
            count: totalCandidates,
            currentPage: page,
            limit,
            totalPages: Math.ceil(totalCandidates / limit) || 1,
            summary,
            candidates
        });

    } catch (error) {
        console.error('Error fetching candidates by pulled by:', error);
        res.status(500).json({ message: 'Server error fetching candidates', error: error.message });
    }
};

const calculateCandidateMatchScore = (candidate, query) => {
    let totalActiveWeight = 0;
    let earnedWeight = 0;

    // 1. Search Query
    if (query.search && String(query.search).trim() !== '') {
        const term = String(query.search).trim().toLowerCase();
        const weight = 30;
        totalActiveWeight += weight;

        let scorePercent = 0;

        const name = String(candidate.candidateName || '').toLowerCase();
        const email = String(candidate.email || '').toLowerCase();
        const mobile = String(candidate.mobile || '');
        const currentCompany = String(candidate.currentCompany || '').toLowerCase();
        const currentLocation = String(candidate.currentLocation || '').toLowerCase();
        const qualification = String(candidate.qualification || '').toLowerCase();
        const remark = String(candidate.remark || '').toLowerCase();

        const candidateSkills = [
            ...(candidate.mustHaveSkills || []).map(s => (typeof s?.skill === 'object' ? s.skill?.name : s?.skill) || s),
            ...(candidate.niceToHaveSkills || []).map(s => (typeof s?.skill === 'object' ? s.skill?.name : s?.skill) || s),
            ...(candidate.skillRatings || []).map(s => s?.skill)
        ].filter(Boolean).map(s => String(s).toLowerCase());

        if (name === term || email === term || mobile === term) {
            scorePercent = 1.0;
        } else if (name.includes(term) || email.includes(term) || mobile.includes(term)) {
            scorePercent = 0.95;
        } else if (candidateSkills.some(cs => cs.includes(term) || term.includes(cs))) {
            scorePercent = 0.85;
        } else if (currentCompany.includes(term) || qualification.includes(term)) {
            scorePercent = 0.75;
        } else if (currentLocation.includes(term) || remark.includes(term)) {
            scorePercent = 0.70;
        }

        earnedWeight += scorePercent * weight;
    }

    // 2. Skills
    if (query.skills) {
        const querySkills = parseStringArrayQuery(query.skills);
        if (querySkills.length > 0) {
            const weight = 35;
            totalActiveWeight += weight;

            const candidateSkills = [];
            if (Array.isArray(candidate.mustHaveSkills)) {
                candidate.mustHaveSkills.forEach(s => { if (s && s.skill) candidateSkills.push(s.skill.toLowerCase()); });
            }
            if (Array.isArray(candidate.niceToHaveSkills)) {
                candidate.niceToHaveSkills.forEach(s => { if (s && s.skill) candidateSkills.push(s.skill.toLowerCase()); });
            }
            if (Array.isArray(candidate.skillRatings)) {
                candidate.skillRatings.forEach(s => { if (s && s.skill) candidateSkills.push(s.skill.toLowerCase()); });
            }

            let matchedCount = 0;
            querySkills.forEach(qs => {
                const qSkillLower = qs.toLowerCase();
                if (candidateSkills.some(cs => cs.includes(qSkillLower) || qSkillLower.includes(cs))) {
                    matchedCount++;
                }
            });

            const matchRatio = matchedCount / querySkills.length;
            earnedWeight += matchRatio * weight;
        }
    }

    // 3. Experience Range
    const hasMinExp = query.minExperience !== undefined && query.minExperience !== '';
    const hasMaxExp = query.maxExperience !== undefined && query.maxExperience !== '';
    if (hasMinExp || hasMaxExp) {
        const weight = 15;
        totalActiveWeight += weight;

        const candidateExp = Number(candidate.totalExperience) || 0;
        let isWithinRange = true;

        if (hasMinExp) {
            const min = Number(query.minExperience);
            if (Number.isFinite(min) && candidateExp < min) {
                isWithinRange = false;
            }
        }
        if (hasMaxExp) {
            const max = Number(query.maxExperience);
            if (Number.isFinite(max) && candidateExp > max) {
                isWithinRange = false;
            }
        }

        if (isWithinRange) {
            earnedWeight += weight;
        }
    }

    // 4. Location
    if (query.location && String(query.location).trim() !== '') {
        const weight = 10;
        totalActiveWeight += weight;

        const qLoc = String(query.location).trim().toLowerCase();
        const curLoc = String(candidate.currentLocation || '').toLowerCase();
        const prefLoc = String(candidate.preferredLocation || '').toLowerCase();

        if (curLoc.includes(qLoc) || prefLoc.includes(qLoc)) {
            earnedWeight += weight;
        }
    }

    // 5. Notice Period
    if (query.maxNoticePeriod !== undefined && query.maxNoticePeriod !== '') {
        const weight = 10;
        totalActiveWeight += weight;

        const maxNP = Number(query.maxNoticePeriod);
        const candidateNP = Number(candidate.noticePeriod) || 0;

        if (Number.isFinite(maxNP)) {
            if (candidateNP <= maxNP) {
                earnedWeight += weight;
            } else if (candidateNP <= maxNP + 15) {
                earnedWeight += weight * 0.5;
            }
        }
    }

    // 5b. Current CTC Range
    const hasMinCCTC = query.minCurrentCTC !== undefined && query.minCurrentCTC !== '';
    const hasMaxCCTC = query.maxCurrentCTC !== undefined && query.maxCurrentCTC !== '';
    if (hasMinCCTC || hasMaxCCTC) {
        const weight = 10;
        totalActiveWeight += weight;

        const candidateCCTC = Number(candidate.currentCTC) || 0;
        let isWithinRange = true;

        if (hasMinCCTC) {
            const min = Number(query.minCurrentCTC);
            if (Number.isFinite(min) && candidateCCTC < min) {
                isWithinRange = false;
            }
        }
        if (hasMaxCCTC) {
            const max = Number(query.maxCurrentCTC);
            if (Number.isFinite(max) && candidateCCTC > max) {
                isWithinRange = false;
            }
        }

        if (isWithinRange) {
            earnedWeight += weight;
        }
    }

    // 6. Expected CTC Range
    const hasMinECTC = query.minExpectedCTC !== undefined && query.minExpectedCTC !== '';
    const hasMaxECTC = query.maxExpectedCTC !== undefined && query.maxExpectedCTC !== '';
    if (hasMinECTC || hasMaxECTC) {
        const weight = 10;
        totalActiveWeight += weight;

        const candidateECTC = Number(candidate.expectedCTC) || 0;
        let isWithinRange = true;

        if (hasMinECTC) {
            const min = Number(query.minExpectedCTC);
            if (Number.isFinite(min) && candidateECTC < min) {
                isWithinRange = false;
            }
        }
        if (hasMaxECTC) {
            const max = Number(query.maxExpectedCTC);
            if (Number.isFinite(max) && candidateECTC > max) {
                isWithinRange = false;
            }
        }

        if (isWithinRange) {
            earnedWeight += weight;
        }
    }

    // 7. Source
    if (query.source) {
        const querySources = parseStringArrayQuery(query.source);
        if (querySources.length > 0) {
            const weight = 10;
            totalActiveWeight += weight;

            const candSource = String(candidate.source || '').trim().toLowerCase();
            const isMatched = querySources.some(qs => qs.trim().toLowerCase() === candSource);

            if (isMatched) {
                earnedWeight += weight;
            }
        }
    }

    // 8. In Hand Offer
    if (query.inHandOffer !== undefined && query.inHandOffer !== '') {
        const weight = 10;
        totalActiveWeight += weight;

        const qInHand = query.inHandOffer === 'true';
        const candInHand = !!candidate.inHandOffer;

        if (qInHand === candInHand) {
            earnedWeight += weight;
        }
    }

    // 9. Client
    if (query.client && String(query.client).trim() !== '') {
        const weight = 10;
        totalActiveWeight += weight;

        const qClient = String(query.client).trim().toLowerCase();
        const hrClient = String(candidate.hiringRequestId?.client || '').toLowerCase();

        if (hrClient.includes(qClient)) {
            earnedWeight += weight;
        }
    }

    // 10. Decision
    if (query.decision && String(query.decision).trim() !== '') {
        const weight = 10;
        totalActiveWeight += weight;

        const qDec = String(query.decision).trim().toLowerCase();
        const candDec = String(candidate.decision || '').toLowerCase();
        const candP2Dec = String(candidate.phase2Decision || '').toLowerCase();
        const candP3Dec = String(candidate.phase3Decision || '').toLowerCase();

        if (candDec === qDec || candP2Dec === qDec || candP3Dec === qDec) {
            earnedWeight += weight;
        }
    }

    // Fallback: profile completeness score if no filters/keywords are active
    if (totalActiveWeight === 0) {
        let completeness = 0;
        let totalCompWeight = 0;

        totalCompWeight += 30;
        if (candidate.candidateName) completeness += 10;
        if (candidate.email) completeness += 10;
        if (candidate.mobile) completeness += 10;

        totalCompWeight += 20;
        const hasSkills = (candidate.mustHaveSkills?.length > 0 || candidate.niceToHaveSkills?.length > 0 || candidate.skillRatings?.length > 0);
        if (hasSkills) completeness += 20;

        totalCompWeight += 15;
        if (candidate.totalExperience !== undefined && candidate.totalExperience !== null) completeness += 15;

        totalCompWeight += 15;
        if (candidate.resumeUrl) completeness += 15;

        totalCompWeight += 10;
        if (candidate.noticePeriod !== undefined && candidate.noticePeriod !== null) completeness += 10;

        totalCompWeight += 10;
        if (candidate.currentLocation || candidate.preferredLocation) completeness += 10;

        return Math.round((completeness / totalCompWeight) * 100);
    }

    return Math.round((earnedWeight / totalActiveWeight) * 100);
};

const globalSearchCandidates = async (req, res) => {
    try {
        const filterQuery = { isDeleted: { $ne: true } };

        let includeCandidates = true;
        let includePublicApps = true;
        let candidateSources = [];

        if (req.query.source) {
            const sources = parseStringArrayQuery(req.query.source);
            includePublicApps = sources.some(s => new RegExp('^public application$', 'i').test(s));
            
            sources.forEach(s => {
                if (new RegExp('^public application$', 'i').test(s)) {
                    candidateSources.push('Public Job Board');
                    candidateSources.push('Public Application');
                } else {
                    candidateSources.push(s);
                }
            });
            includeCandidates = candidateSources.length > 0;
        }

        if (req.query.search) {
            const searchRegex = new RegExp(req.query.search.trim(), 'i');
            filterQuery.$or = [
                { candidateName: searchRegex },
                { email: searchRegex },
                { mobile: searchRegex },
                { currentLocation: searchRegex },
                { preferredLocation: searchRegex },
                { currentCompany: searchRegex },
                { qualification: searchRegex },
                { remark: searchRegex },
                { internalRemark: searchRegex },
                { 'mustHaveSkills.skill': searchRegex },
                { 'niceToHaveSkills.skill': searchRegex },
                { 'skillRatings.skill': searchRegex },
                { 'pastExperience.role': searchRegex },
                { 'pastExperience.companyName': searchRegex }
            ];
        }

        const buildNumericRange = (minVal, maxVal) => {
            const range = {};
            if (minVal !== undefined && minVal !== '') {
                const min = Number(minVal);
                if (Number.isFinite(min)) range.$gte = min;
            }
            if (maxVal !== undefined && maxVal !== '') {
                const max = Number(maxVal);
                if (Number.isFinite(max)) range.$lte = max;
            }
            return Object.keys(range).length > 0 ? range : null;
        };

        const totalExpRange = buildNumericRange(req.query.minExperience, req.query.maxExperience);
        if (totalExpRange) filterQuery.totalExperience = totalExpRange;

        if (req.query.skills) {
            const skillsList = parseStringArrayQuery(req.query.skills);
            if (skillsList.length > 0) {
                const skillsRegexList = skillsList.map(s => new RegExp(s.trim(), 'i'));
                filterQuery.$and = filterQuery.$and || [];
                filterQuery.$and.push({
                    $or: [
                        { 'mustHaveSkills.skill': { $in: skillsRegexList } },
                        { 'niceToHaveSkills.skill': { $in: skillsRegexList } },
                        { 'skillRatings.skill': { $in: skillsRegexList } }
                    ]
                });
            }
        }

        if (req.query.client) {
            const clientHiringRequests = await HiringRequest.find({
                companyId: req.companyId,
                client: new RegExp(req.query.client.trim(), 'i')
            }).select('_id').lean();
            
            const hiringRequestIds = clientHiringRequests.map(hr => hr._id);
            filterQuery.hiringRequestId = { $in: hiringRequestIds };
        }

        if (req.query.location) {
            const locRegex = new RegExp(req.query.location.trim(), 'i');
            filterQuery.$and = filterQuery.$and || [];
            filterQuery.$and.push({
                $or: [
                    { currentLocation: locRegex },
                    { preferredLocation: locRegex }
                ]
            });
        }

        if (req.query.maxNoticePeriod !== undefined && req.query.maxNoticePeriod !== '') {
            const noticeVal = Number(req.query.maxNoticePeriod);
            if (Number.isFinite(noticeVal)) {
                filterQuery.noticePeriod = { $lte: noticeVal };
            }
        }

        const currentCTCRange = buildNumericRange(req.query.minCurrentCTC, req.query.maxCurrentCTC);
        if (currentCTCRange) filterQuery.currentCTC = currentCTCRange;

        const expectedCTCRange = buildNumericRange(req.query.minExpectedCTC, req.query.maxExpectedCTC);
        if (expectedCTCRange) filterQuery.expectedCTC = expectedCTCRange;

        if (req.query.inHandOffer !== undefined && req.query.inHandOffer !== '') {
            filterQuery.inHandOffer = req.query.inHandOffer === 'true';
        }

        if (req.query.decision) {
            const decVal = req.query.decision.trim();
            filterQuery.$and = filterQuery.$and || [];
            filterQuery.$and.push({
                $or: [
                    { decision: decVal },
                    { phase2Decision: decVal },
                    { phase3Decision: decVal }
                ]
            });
        }

        // Build Public Application Filter Query
        const publicAppFilterQuery = { companyId: req.companyId };

        if (req.query.search) {
            const searchRegex = new RegExp(req.query.search.trim(), 'i');
            publicAppFilterQuery.$or = [
                { candidateName: searchRegex },
                { email: searchRegex },
                { mobile: searchRegex },
                { coverNote: searchRegex },
                { reviewNote: searchRegex }
            ];
        }

        if (req.query.client) {
            const clientHiringRequests = await HiringRequest.find({
                companyId: req.companyId,
                client: new RegExp(req.query.client.trim(), 'i')
            }).select('_id').lean();
            publicAppFilterQuery.hiringRequestId = { $in: clientHiringRequests.map(hr => hr._id) };
        }

        if (req.query.maxNoticePeriod !== undefined && req.query.maxNoticePeriod !== '') {
            const noticeVal = Number(req.query.maxNoticePeriod);
            if (Number.isFinite(noticeVal)) {
                publicAppFilterQuery.noticePeriod = { $lte: noticeVal };
            }
        }

        if (currentCTCRange) publicAppFilterQuery.currentCTC = currentCTCRange;
        if (expectedCTCRange) publicAppFilterQuery.expectedCTC = expectedCTCRange;

        if (req.query.decision) {
            publicAppFilterQuery.reviewStatus = req.query.decision.trim();
        }

        // Fetch matched candidate records (only IDs and creation dates)
        let candidateItems = [];
        if (includeCandidates) {
            if (candidateSources.length > 0) {
                filterQuery.source = { $in: candidateSources.map(s => new RegExp(`^${s.trim()}$`, 'i')) };
            }
            const query = await buildAccessibleCandidateQuery(
                req.companyId,
                req.user,
                filterQuery,
                { capability: TA_CAPABILITIES.VIEW }
            );
            const candidates = await Candidate.find(query)
                .select('_id createdAt')
                .lean();
            candidateItems = candidates.map(c => ({
                _id: c._id,
                createdAt: c.createdAt,
                type: 'candidate'
            }));
        }

        // Fetch matched public application records
        let publicAppItems = [];
        if (includePublicApps) {
            const apps = await PublicApplication.find(publicAppFilterQuery)
                .select('_id createdAt profileSnapshot')
                .lean();

            let filteredApps = apps;
            if (req.query.minExperience !== undefined && req.query.minExperience !== '' ||
                req.query.maxExperience !== undefined && req.query.maxExperience !== '') {
                const minExp = req.query.minExperience !== '' ? Number(req.query.minExperience) : null;
                const maxExp = req.query.maxExperience !== '' ? Number(req.query.maxExperience) : null;
                filteredApps = filteredApps.filter(app => {
                    const expYears = app.profileSnapshot?.totalExperience ?? app.profileSnapshot?.experienceYears ?? null;
                    if (expYears === null || expYears === undefined) return true;
                    if (minExp !== null && Number.isFinite(minExp) && expYears < minExp) return false;
                    if (maxExp !== null && Number.isFinite(maxExp) && expYears > maxExp) return false;
                    return true;
                });
            }
            publicAppItems = filteredApps.map(app => ({
                _id: app._id,
                createdAt: app.createdAt,
                type: 'publicApp'
            }));
        }

        const mergedItems = [...candidateItems, ...publicAppItems];
        mergedItems.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

        const total = mergedItems.length;
        const page = Math.max(Number(req.query.page) || 1, 1);
        const limit = Math.max(Number(req.query.limit) || 15, 1);
        const skip = (page - 1) * limit;

        const pageItems = mergedItems.slice(skip, skip + limit);

        const pageCandidateIds = pageItems.filter(i => i.type === 'candidate').map(i => i._id);
        const pagePublicAppIds = pageItems.filter(i => i.type === 'publicApp').map(i => i._id);

        let candidatesFetched = [];
        if (pageCandidateIds.length > 0) {
            candidatesFetched = await Candidate.find({ _id: { $in: pageCandidateIds } })
                .populate({
                    path: 'hiringRequestId',
                    select: 'requestId roleDetails client clientConfidential'
                })
                .populate('uploadedBy', 'firstName lastName email')
                .lean();
        }

        let publicAppsFetched = [];
        if (pagePublicAppIds.length > 0) {
            publicAppsFetched = await PublicApplication.find({ _id: { $in: pagePublicAppIds } })
                .populate('hiringRequestId', 'requestId roleDetails client clientConfidential')
                .populate('reviewedBy', 'firstName lastName')
                .lean();
        }

        const serializedCandidates = pageItems.map(item => {
            if (item.type === 'candidate') {
                const candidate = candidatesFetched.find(c => String(c._id) === String(item._id));
                if (!candidate) return null;
                const serialized = serializeCandidateForViewer({
                    candidate,
                    user: req.user,
                    hiringRequest: candidate.hiringRequestId
                });
                serialized.confidenceRating = calculateCandidateMatchScore(candidate, req.query);
                return serialized;
            } else {
                const app = publicAppsFetched.find(a => String(a._id) === String(item._id));
                if (!app) return null;
                const serialized = {
                    _id: app._id,
                    candidateName: app.candidateName,
                    email: app.email,
                    mobile: app.mobile,
                    totalExperience: app.profileSnapshot?.totalExperience ?? app.profileSnapshot?.experienceYears ?? 0,
                    source: 'Public Application',
                    mustHaveSkills: (app.profileSnapshot?.skills || []).map(s => ({ skill: s })),
                    niceToHaveSkills: [],
                    hiringRequestId: app.hiringRequestId ? {
                        _id: app.hiringRequestId._id,
                        requestId: app.hiringRequestId.requestId,
                        roleDetails: app.hiringRequestId.roleDetails,
                        client: app.hiringRequestId.client,
                        clientConfidential: app.hiringRequestId.clientConfidential
                    } : null,
                    uploadedBy: app.reviewedBy ? {
                        _id: app.reviewedBy._id,
                        firstName: app.reviewedBy.firstName,
                        lastName: app.reviewedBy.lastName,
                        email: app.reviewedBy.email
                    } : null,
                    createdAt: app.createdAt,
                    isPublicApplication: true,
                    resumeUrl: app.resumeUrl
                };
                serialized.confidenceRating = calculateCandidateMatchScore(serialized, req.query);
                return serialized;
            }
        }).filter(Boolean);

        const hasActiveFilters = !!(
            req.query.search ||
            req.query.skills ||
            req.query.minExperience ||
            req.query.maxExperience ||
            req.query.location ||
            req.query.maxNoticePeriod ||
            req.query.minCurrentCTC ||
            req.query.maxCurrentCTC ||
            req.query.minExpectedCTC ||
            req.query.maxExpectedCTC ||
            req.query.source ||
            req.query.inHandOffer ||
            req.query.client ||
            req.query.decision
        );

        if (hasActiveFilters) {
            serializedCandidates.sort((a, b) => b.confidenceRating - a.confidenceRating);
        }

        res.status(200).json({
            currentPage: page,
            totalPages: Math.max(Math.ceil(total / limit), 1),
            count: total,
            limit,
            candidates: serializedCandidates
        });
    } catch (error) {
        console.error('Error in global search candidates:', error);
        res.status(500).json({ message: 'Server error', error: error.message });
    }
};

const getDistinctCandidateSkills = async (req, res) => {
    try {
        const skills = await Candidate.aggregate([
            { $match: { companyId: req.companyId, isDeleted: { $ne: true } } },
            {
                $project: {
                    allSkills: {
                        $concatArrays: [
                            { $ifNull: ["$mustHaveSkills.skill", []] },
                            { $ifNull: ["$niceToHaveSkills.skill", []] },
                            { $ifNull: ["$skillRatings.skill", []] }
                        ]
                    }
                }
            },
            { $unwind: "$allSkills" },
            { $group: { _id: null, uniqueSkills: { $addToSet: "$allSkills" } } }
        ]);

        const uniqueSkillsList = skills.length > 0 ? skills[0].uniqueSkills : [];
        
        const formattedSkills = uniqueSkillsList
            .map(s => String(s || '').trim())
            .filter(Boolean)
            .sort((a, b) => a.localeCompare(b));

        const uniqueSet = new Set();
        const finalSkills = [];
        formattedSkills.forEach(s => {
            const lower = s.toLowerCase();
            if (!uniqueSet.has(lower)) {
                uniqueSet.add(lower);
                finalSkills.push(s);
            }
        });

        res.status(200).json(finalSkills);
    } catch (error) {
        console.error('Error fetching distinct candidate skills:', error);
        res.status(500).json({ message: 'Server error', error: error.message });
    }
};

const getCandidateCardFilters = async (req, res) => {
    try {
        const { hiringRequestId } = req.params;
        const {
            dateField,
            startDate,
            endDate,
            search = '',
            filterPreference = 'All',
            filterExperience = '',
            filterRating = 'All',
            filterPulledBy,
            filterUploadedBy,
            filterUploadType = 'All',
            filterTransferred = 'All'
        } = req.query;

        if (!mongoose.Types.ObjectId.isValid(hiringRequestId)) {
            return res.status(400).json({ message: 'Invalid Hiring Request ID format' });
        }

        const hiringRequest = await HiringRequest.findOne({ _id: hiringRequestId, companyId: req.companyId }).lean();
        if (!hiringRequest) {
            return res.status(404).json({ message: 'Hiring request not found' });
        }

        const hasHiringRequestAccess = await canAccessHiringRequest(hiringRequest, req.companyId, req.user, { action: 'view' });

        if (!hasHiringRequestAccess) {
            return res.status(403).json({ message: 'Forbidden: You do not have permission to view this request' });
        }

        const candidateQuery = await buildAccessibleCandidateQuery(
            req.companyId,
            req.user,
            { hiringRequestId },
            { capability: TA_CAPABILITIES.VIEW }
        );

        applyDateRangeFilterToCandidateQuery(candidateQuery, dateField, startDate, endDate);

        const candidates = await Candidate.find(candidateQuery)
            .select('_id candidateName status decision profileShared uploadedAt interviewRounds profilePulledBy totalExperience preference isTransferred uploadedBy resumeUrl phase2Decision phase2InterviewStatus phase2InterviewerFeedback phase3Decision')
            .populate('uploadedBy', 'firstName lastName')
            .lean();

        const normalizedSearch = String(search || '').trim().toLowerCase();
        const normalizedPulledBy = parseStringArrayQuery(filterPulledBy);
        const normalizedUploadedBy = parseStringArrayQuery(filterUploadedBy);
        const minExperience = filterExperience === '' ? null : Number(filterExperience);
        const minRating = filterRating === 'All' ? null : Number(filterRating);

        const matchesSearch = (candidate) => (
            !normalizedSearch || String(candidate?.candidateName || '').toLowerCase().includes(normalizedSearch)
        );

        const matchesCommonStructuralFilters = (candidate) => {
            const matchesPulledBy = !normalizedPulledBy.length || normalizedPulledBy.includes(String(candidate?.profilePulledBy || '').trim());
            const matchesUploadedBy = !normalizedUploadedBy.length || normalizedUploadedBy.includes(getCandidateUploadedByName(candidate));
            const matchesUploadType = filterUploadType === 'All' || getCandidateUploadType(candidate) === filterUploadType;
            const matchesTransferred = filterTransferred === 'All'
                ? true
                : filterTransferred === 'Transferred'
                    ? candidate?.isTransferred === true
                    : candidate?.isTransferred !== true;

            return matchesSearch(candidate) && matchesPulledBy && matchesUploadedBy && matchesUploadType && matchesTransferred;
        };

        const matchesBaseFiltersForPhase = (candidate, phase) => {
            const matchesPreference = filterPreference === 'All' || candidate?.preference === filterPreference;
            const matchesExperience = minExperience === null
                || (candidate?.totalExperience !== undefined && candidate?.totalExperience !== null && Number(candidate.totalExperience) >= minExperience);

            let matchesRating = true;
            if (minRating !== null && Number.isFinite(minRating)) {
                const averageRating = getLegacyAverageRatingForPhase(candidate, phase);
                matchesRating = averageRating !== null && averageRating >= minRating;
            }

            return matchesPreference && matchesExperience && matchesRating;
        };

        const structuralPhase1Candidates = candidates.filter((candidate) => matchesCommonStructuralFilters(candidate));
        const basePhase1Candidates = structuralPhase1Candidates.filter((candidate) => matchesBaseFiltersForPhase(candidate, 1));

        const structuralPhase2Candidates = candidates.filter((candidate) => (
            isProfileSharedCandidate(candidate) && matchesCommonStructuralFilters(candidate)
        ));
        const basePhase2Candidates = structuralPhase2Candidates.filter((candidate) => matchesBaseFiltersForPhase(candidate, 2));

        const structuralPhase3Candidates = candidates.filter((candidate) => (
            candidate?.phase2Decision === 'Selected' && matchesCommonStructuralFilters(candidate)
        ));
        const basePhase3Candidates = structuralPhase3Candidates.filter((candidate) => matchesBaseFiltersForPhase(candidate, 3));

        const roundMap = new Map();
        for (const candidate of structuralPhase1Candidates) {
            const seenRounds = new Set();
            for (const round of (candidate?.interviewRounds || [])) {
                if (Number(round?.phase || 1) !== 1) continue;
                const name = String(round?.levelName || 'Round 1').trim() || 'Round 1';
                let anchor = String(round?.assignAfterStage || 'Interested').trim() || 'Interested';
                if (anchor === 'Interview Scheduled' || !['Total Sourced', 'Interested', 'Shortlisted', 'Profile Shared'].includes(anchor)) {
                    anchor = 'Interested';
                }
                if (!roundMap.has(name)) {
                    roundMap.set(name, { levelName: name, assignAfterStage: anchor, count: 0 });
                }
                if (!seenRounds.has(name)) {
                    seenRounds.add(name);
                    roundMap.get(name).count += 1;
                }
            }
        }
        const interviewRoundsSummary = Array.from(roundMap.values());

        const roundMapPhase2 = new Map();
        for (const candidate of structuralPhase2Candidates) {
            const seenRounds = new Set();
            const phase2Rounds = getLegacyRoundsForPhase(candidate, 2);
            if (phase2Rounds.length > 0) {
                for (const round of phase2Rounds) {
                    const name = String(round?.levelName || 'Round 1').trim() || 'Round 1';
                    let anchor = String(round?.assignAfterStage || 'Shortlisted').trim() || 'Shortlisted';
                    if (anchor === 'Interview Scheduled' || !['Profile Shared', 'Shortlisted', 'Selected', 'Rejected'].includes(anchor)) {
                        anchor = 'Shortlisted';
                    }
                    if (!roundMapPhase2.has(name)) {
                        roundMapPhase2.set(name, { levelName: name, assignAfterStage: anchor, count: 0 });
                    }
                    if (!seenRounds.has(name)) {
                        seenRounds.add(name);
                        roundMapPhase2.get(name).count += 1;
                    }
                }
            } else if (hasLegacyPhase2InterviewActivity(candidate)) {
                const name = 'Round 1';
                const anchor = 'Shortlisted';
                if (!roundMapPhase2.has(name)) {
                    roundMapPhase2.set(name, { levelName: name, assignAfterStage: anchor, count: 0 });
                }
                if (!seenRounds.has(name)) {
                    seenRounds.add(name);
                    roundMapPhase2.get(name).count += 1;
                }
            }
        }
        const interviewRoundsSummaryPhase2 = Array.from(roundMapPhase2.values());

        const summary = {
            phase1Metrics: {
                total: structuralPhase1Candidates.length,
                interested: structuralPhase1Candidates.filter((candidate) => candidate?.status === 'Interested').length,
                notPicking: structuralPhase1Candidates.filter((candidate) => candidate?.status === 'Not Picking').length,
                notRelevant: structuralPhase1Candidates.filter((candidate) => candidate?.status === 'Not Relevant').length,
                notInterested: structuralPhase1Candidates.filter((candidate) => candidate?.status === 'Not Interested').length,
                highExpectation: structuralPhase1Candidates.filter((candidate) => candidate?.status === 'High expectation').length,
                longNoticePeriod: structuralPhase1Candidates.filter((candidate) => candidate?.status === 'Long Notice period').length,
                locationNotSuitable: structuralPhase1Candidates.filter((candidate) => candidate?.status === 'Location Not suitable').length,
                otherStatus: structuralPhase1Candidates.filter((candidate) => !['Interested', 'Not Interested', 'Not Relevant', 'Not Picking', 'High expectation', 'Long Notice period', 'Location Not suitable'].includes(candidate?.status)).length,
                interviewScheduled: structuralPhase1Candidates.filter((candidate) => getLegacyRoundsForPhase(candidate, 1).length > 0).length,
                shortlisted: structuralPhase1Candidates.filter((candidate) => candidate?.decision === 'Shortlisted').length,
                rejected: structuralPhase1Candidates.filter((candidate) => candidate?.decision === 'Rejected').length,
                didNotTurnUp: structuralPhase1Candidates.filter((candidate) => candidate?.decision === 'Did Not Turn Up').length,
                onHold: structuralPhase1Candidates.filter((candidate) => candidate?.decision === 'On Hold').length,
                profileShared: structuralPhase1Candidates.filter((candidate) => isProfileSharedCandidate(candidate)).length,
                transferred: structuralPhase1Candidates.filter((candidate) => candidate?.isTransferred === true).length,
                interviewRoundsSummary
            },
            phase2Metrics: {
                totalShortlisted: structuralPhase2Candidates.length,
                totalScreened: structuralPhase2Candidates.filter((candidate) => candidate?.phase2Decision === 'Shortlisted' || candidate?.phase2Decision === 'Selected').length,
                selected: structuralPhase2Candidates.filter((candidate) => candidate?.phase2Decision === 'Selected').length,
                rejected: structuralPhase2Candidates.filter((candidate) => candidate?.phase2Decision === 'Rejected').length,
                interviewScheduled: structuralPhase2Candidates.filter((candidate) => hasLegacyPhase2InterviewActivity(candidate)).length,
                interviewRoundsSummary: interviewRoundsSummaryPhase2
            },
            phase3Metrics: {
                total: structuralPhase3Candidates.length,
                offerSent: structuralPhase3Candidates.filter((candidate) => ['Offer Sent', 'Offer Accepted', 'Joined'].includes(candidate?.phase3Decision)).length,
                offerAccepted: structuralPhase3Candidates.filter((candidate) => ['Offer Accepted', 'Joined'].includes(candidate?.phase3Decision)).length,
                joined: structuralPhase3Candidates.filter((candidate) => candidate?.phase3Decision === 'Joined').length,
                noShow: structuralPhase3Candidates.filter((candidate) => candidate?.phase3Decision === 'No Show' || candidate?.phase3Decision === 'Offer Declined').length
            },
            phaseBaseCounts: {
                phase1: basePhase1Candidates.length,
                phase2: basePhase2Candidates.length,
                phase3: basePhase3Candidates.length
            }
        };

        res.status(200).json({ summary });

    } catch (error) {
        console.error('Error fetching candidate card filters:', error);
        res.status(500).json({ message: 'Server error', error: error.message });
    }
};

const globalSearchPublicApplications = async (req, res) => {
    try {
        const filterQuery = { companyId: req.companyId };

        if (req.query.search) {
            const searchRegex = new RegExp(req.query.search.trim(), 'i');
            filterQuery.$or = [
                { candidateName: searchRegex },
                { email: searchRegex },
                { mobile: searchRegex },
                { coverNote: searchRegex },
                { reviewNote: searchRegex }
            ];
        }

        if (req.query.reviewStatus && req.query.reviewStatus !== '') {
            filterQuery.reviewStatus = req.query.reviewStatus.trim();
        }

        if (req.query.maxNoticePeriod !== undefined && req.query.maxNoticePeriod !== '') {
            const noticeVal = Number(req.query.maxNoticePeriod);
            if (Number.isFinite(noticeVal)) {
                filterQuery.noticePeriod = { $lte: noticeVal };
            }
        }

        if (req.query.minCurrentCTC !== undefined || req.query.maxCurrentCTC !== undefined) {
            filterQuery.currentCTC = {};
            if (req.query.minCurrentCTC !== undefined && req.query.minCurrentCTC !== '') {
                const minCTC = Number(req.query.minCurrentCTC);
                if (Number.isFinite(minCTC)) filterQuery.currentCTC.$gte = minCTC;
            }
            if (req.query.maxCurrentCTC !== undefined && req.query.maxCurrentCTC !== '') {
                const maxCTC = Number(req.query.maxCurrentCTC);
                if (Number.isFinite(maxCTC)) filterQuery.currentCTC.$lte = maxCTC;
            }
            if (Object.keys(filterQuery.currentCTC).length === 0) delete filterQuery.currentCTC;
        }

        if (req.query.minExpectedCTC !== undefined || req.query.maxExpectedCTC !== undefined) {
            filterQuery.expectedCTC = {};
            if (req.query.minExpectedCTC !== undefined && req.query.minExpectedCTC !== '') {
                const minCTC = Number(req.query.minExpectedCTC);
                if (Number.isFinite(minCTC)) filterQuery.expectedCTC.$gte = minCTC;
            }
            if (req.query.maxExpectedCTC !== undefined && req.query.maxExpectedCTC !== '') {
                const maxCTC = Number(req.query.maxExpectedCTC);
                if (Number.isFinite(maxCTC)) filterQuery.expectedCTC.$lte = maxCTC;
            }
            if (Object.keys(filterQuery.expectedCTC).length === 0) delete filterQuery.expectedCTC;
        }

        if (req.query.client) {
            const clientHiringRequests = await HiringRequest.find({
                companyId: req.companyId,
                client: new RegExp(req.query.client.trim(), 'i')
            }).select('_id').lean();
            filterQuery.hiringRequestId = { $in: clientHiringRequests.map(hr => hr._id) };
        }

        const page = Math.max(Number(req.query.page) || 1, 1);
        const limit = Math.max(Number(req.query.limit) || 15, 1);
        const skip = (page - 1) * limit;

        const [total, applications] = await Promise.all([
            PublicApplication.countDocuments(filterQuery),
            PublicApplication.find(filterQuery)
                .populate('applicantId', 'firstName lastName email mobile currentCity currentState')
                .populate('hiringRequestId', 'requestId roleDetails client clientConfidential')
                .populate('reviewedBy', 'firstName lastName')
                .sort({ createdAt: -1 })
                .skip(skip)
                .limit(limit)
                .lean()
        ]);

        let filteredApps = applications;

        if (req.query.minExperience !== undefined && req.query.minExperience !== '' ||
            req.query.maxExperience !== undefined && req.query.maxExperience !== '') {
            const minExp = req.query.minExperience !== '' ? Number(req.query.minExperience) : null;
            const maxExp = req.query.maxExperience !== '' ? Number(req.query.maxExperience) : null;
            filteredApps = filteredApps.filter(app => {
                const expYears = app.profileSnapshot?.totalExperience ?? app.profileSnapshot?.experienceYears ?? null;
                if (expYears === null || expYears === undefined) return true;
                if (minExp !== null && Number.isFinite(minExp) && expYears < minExp) return false;
                if (maxExp !== null && Number.isFinite(maxExp) && expYears > maxExp) return false;
                return true;
            });
        }

        const applicationsWithHistory = await attachLastApplicationData(filteredApps);

        res.status(200).json({
            currentPage: page,
            totalPages: Math.max(Math.ceil(total / limit), 1),
            count: total,
            limit,
            applications: applicationsWithHistory
        });
    } catch (error) {
        console.error('Error in global search public applications:', error);
        res.status(500).json({ message: 'Server error', error: error.message });
    }
};

const getCandidateInterviewDetails = async (req, res) => {
    try {
        const { hiringRequestId } = req.params;
        const {
            activePhase = 1,
            search = '',
            filterPreference = 'All',
            filterStatus = 'All',
            filterDecision = 'All',
            filterExperience = '',
            filterInterviewStatus = 'All',
            filterRating = 'All',
            filterPulledBy,
            filterUploadedBy,
            filterUploadType = 'All',
            filterTransferred = 'All',
            filterProfileShared = 'false',
            filterInterviewRound = '',
            dateField,
            startDate,
            endDate
        } = req.query;

        if (!mongoose.Types.ObjectId.isValid(hiringRequestId)) {
            return res.status(400).json({ message: 'Invalid Hiring Request ID format' });
        }

        const hiringRequest = await HiringRequest.findOne({ _id: hiringRequestId, companyId: req.companyId }).lean();
        if (!hiringRequest) {
            return res.status(404).json({ message: 'Hiring request not found' });
        }

        const hasAccess = await canAccessHiringRequest(hiringRequest, req.companyId, req.user, { action: 'view' });
        if (!hasAccess) {
            return res.status(403).json({ message: 'Forbidden' });
        }

        const candidateQuery = await buildAccessibleCandidateQuery(
            req.companyId,
            req.user,
            { hiringRequestId },
            { capability: TA_CAPABILITIES.VIEW }
        );

        applyDateRangeFilterToCandidateQuery(candidateQuery, dateField, startDate, endDate);

        const candidates = await Candidate.find(candidateQuery)
            .select('_id candidateName email mobile status decision phase2Decision phase3Decision phase2InterviewStatus phase2InterviewerFeedback profileShared isTransferred interviewRounds preference totalExperience uploadedAt profilePulledBy uploadedBy resumeUrl')
            .populate('uploadedBy', 'firstName lastName')
            .populate('interviewRounds.assignedTo', 'firstName lastName email')
            .populate('interviewRounds.evaluatedBy', 'firstName lastName')
            .sort({ uploadedAt: -1 })
            .lean();

        const normalizedSearch = String(search || '').trim().toLowerCase();
        const normalizedPulledBy = parseStringArrayQuery(filterPulledBy);
        const normalizedUploadedBy = parseStringArrayQuery(filterUploadedBy);
        const minExp = filterExperience === '' ? null : Number(filterExperience);
        const targetPhase = Number(activePhase) || 1;

        const getCandidateUploadedByName = (c) =>
            `${c?.uploadedBy?.firstName || ''} ${c?.uploadedBy?.lastName || ''}`.trim();
        const getCandidateUploadType = (c) =>
            (typeof c?.resumeUrl === 'string' && /^https?:\/\//i.test(c.resumeUrl.trim())) ? 'CV' : 'Excel';
        const isProfileSharedCandidate = (c) =>
            c?.profileShared === true || (c?.profileShared == null && c?.decision === 'Shortlisted');

        const filtered = candidates.filter((c) => {
            if (normalizedSearch && !String(c?.candidateName || '').toLowerCase().includes(normalizedSearch)) return false;
            if (normalizedPulledBy.length && !normalizedPulledBy.includes(String(c?.profilePulledBy || '').trim())) return false;
            if (normalizedUploadedBy.length && !normalizedUploadedBy.includes(getCandidateUploadedByName(c))) return false;
            if (filterUploadType !== 'All' && getCandidateUploadType(c) !== filterUploadType) return false;
            if (filterTransferred !== 'All') {
                if (filterTransferred === 'Transferred' && c?.isTransferred !== true) return false;
                if (filterTransferred !== 'Transferred' && c?.isTransferred === true) return false;
            }
            if (filterPreference !== 'All' && c?.preference !== filterPreference) return false;
            if (minExp !== null && (c?.totalExperience === undefined || c?.totalExperience === null || Number(c.totalExperience) < minExp)) return false;

            if (targetPhase === 1) {
                if (filterStatus !== 'All') {
                    const mainStatuses = ['Interested', 'Not Interested', 'Not Relevant', 'Not Picking', 'High expectation', 'Long Notice period', 'Location Not suitable'];
                    if (['Other', 'None', 'OTH'].includes(filterStatus)) {
                        if (mainStatuses.includes(c?.status)) return false;
                    } else if (c?.status !== filterStatus) {
                        return false;
                    }
                }
                if (filterDecision !== 'All' && (c?.decision || 'None') !== filterDecision) return false;
                if (parseBooleanQueryValue(filterProfileShared) && !isProfileSharedCandidate(c)) return false;
            } else if (targetPhase === 2) {
                if (!isProfileSharedCandidate(c)) return false;
                if (filterDecision !== 'All') {
                    if (filterDecision === 'Shortlisted_Selected') {
                        if (c?.phase2Decision !== 'Shortlisted' && c?.phase2Decision !== 'Selected') return false;
                    } else if ((c?.phase2Decision || 'None') !== filterDecision) return false;
                }
            } else if (targetPhase === 3) {
                if (c?.phase2Decision !== 'Selected') return false;
                if (filterDecision !== 'All') {
                    if (filterDecision === 'No Show_Offer Declined') {
                        if (c?.phase3Decision !== 'No Show' && c?.phase3Decision !== 'Offer Declined') return false;
                    } else if (filterDecision === 'Offer Sent') {
                        if (!['Offer Sent', 'Offer Accepted', 'Joined'].includes(c?.phase3Decision)) return false;
                    } else if (filterDecision === 'Offer Accepted') {
                        if (!['Offer Accepted', 'Joined'].includes(c?.phase3Decision)) return false;
                    } else if ((c?.phase3Decision || 'None') !== filterDecision) return false;
                }
            }

            if (filterInterviewRound) {
                const targetRound = String(filterInterviewRound).trim().toLowerCase();
                const rounds = Array.isArray(c?.interviewRounds) ? c.interviewRounds : [];
                const hasRound = rounds.some((r) =>
                    String(r?.levelName || '').trim().toLowerCase() === targetRound
                );
                if (!hasRound) return false;
            }

            return true;
        });

        res.status(200).json(filtered);
    } catch (error) {
        console.error('Error fetching candidate interview details:', error);
        res.status(500).json({ message: 'Server error', error: error.message });
    }
};

const getCandidateRoundSummary = async (req, res) => {
    try {
        const { hiringRequestId } = req.params;
        const {
            dateField,
            startDate,
            endDate,
            search = '',
            filterPulledBy,
            filterUploadedBy,
            filterUploadType = 'All',
            filterTransferred = 'All'
        } = req.query;

        if (!mongoose.Types.ObjectId.isValid(hiringRequestId)) {
            return res.status(400).json({ message: 'Invalid Hiring Request ID format' });
        }

        const hiringRequest = await HiringRequest.findOne({ _id: hiringRequestId, companyId: req.companyId }).lean();
        if (!hiringRequest) {
            return res.status(404).json({ message: 'Hiring request not found' });
        }

        const hasAccess = await canAccessHiringRequest(hiringRequest, req.companyId, req.user, { action: 'view' });
        if (!hasAccess) {
            return res.status(403).json({ message: 'Forbidden' });
        }

        const candidateQuery = await buildAccessibleCandidateQuery(
            req.companyId,
            req.user,
            { hiringRequestId },
            { capability: TA_CAPABILITIES.VIEW }
        );

        applyDateRangeFilterToCandidateQuery(candidateQuery, dateField, startDate, endDate);

        const candidates = await Candidate.find(candidateQuery)
            .select('candidateName interviewRounds profileShared decision profilePulledBy uploadedBy resumeUrl isTransferred phase2Decision phase2InterviewStatus phase2InterviewerFeedback')
            .populate('uploadedBy', 'firstName lastName')
            .lean();

        const normalizedSearch = String(search || '').trim().toLowerCase();
        const normalizedPulledBy = parseStringArrayQuery(filterPulledBy);
        const normalizedUploadedBy = parseStringArrayQuery(filterUploadedBy);

        const getCandidateUploadedByName = (c) =>
            `${c?.uploadedBy?.firstName || ''} ${c?.uploadedBy?.lastName || ''}`.trim();
        const getCandidateUploadType = (c) =>
            (typeof c?.resumeUrl === 'string' && /^https?:\/\//i.test(c.resumeUrl.trim())) ? 'CV' : 'Excel';
        const isProfileSharedCandidate = (c) =>
            c?.profileShared === true || (c?.profileShared == null && c?.decision === 'Shortlisted');

        const matchesStructural = (c) => {
            if (normalizedSearch && !String(c?.candidateName || '').toLowerCase().includes(normalizedSearch)) return false;
            if (normalizedPulledBy.length && !normalizedPulledBy.includes(String(c?.profilePulledBy || '').trim())) return false;
            if (normalizedUploadedBy.length && !normalizedUploadedBy.includes(getCandidateUploadedByName(c))) return false;
            if (filterUploadType !== 'All' && getCandidateUploadType(c) !== filterUploadType) return false;
            if (filterTransferred !== 'All') {
                if (filterTransferred === 'Transferred' && c?.isTransferred !== true) return false;
                if (filterTransferred !== 'Transferred' && c?.isTransferred === true) return false;
            }
            return true;
        };

        const phase1Map = new Map();
        const phase2Map = new Map();

        for (const candidate of candidates) {
            if (!matchesStructural(candidate)) continue;

            const seenPhase1 = new Set();
            const seenPhase2 = new Set();

            const normalizeRoundTitle = (str) => {
                if (!str) return 'Round 1';
                const trimmed = String(str).trim();
                return trimmed.replace(/\b\w/g, (char) => char.toUpperCase());
            };

            for (const round of (candidate.interviewRounds || [])) {
                const rPhase = Number(round?.phase || 1);
                const rawName = String(round.levelName || 'Round 1').trim() || 'Round 1';
                const name = normalizeRoundTitle(rawName);
                const key = name.toLowerCase();

                if (rPhase === 1) {
                    let anchor = String(round.assignAfterStage || 'Interested').trim() || 'Interested';
                    if (anchor === 'Interview Scheduled' || !['Total Sourced', 'Interested', 'Shortlisted', 'Profile Shared'].includes(anchor)) {
                        anchor = 'Interested';
                    }
                    if (!phase1Map.has(key)) phase1Map.set(key, { levelName: name, assignAfterStage: anchor, count: 0, shortlisted: 0, rejected: 0, didNotTurnUp: 0, leftInBetween: 0, pending: 0 });
                    const entry = phase1Map.get(key);
                    if (!seenPhase1.has(key)) {
                        seenPhase1.add(key);
                        entry.count += 1;
                    }
                    const s1 = String(round.status || '').trim();
                    if (s1 === 'Passed' || s1 === 'Pass' || s1 === 'Shortlisted') entry.shortlisted += 1;
                    else if (s1 === 'Failed' || s1 === 'Fail' || s1 === 'Rejected') entry.rejected += 1;
                    else if (s1 === 'Did Not Turn Up' || s1 === 'Did Not Turnup' || s1 === 'Did Not Turn up' || s1 === 'Skipped' || s1 === 'No Show' || s1 === 'DNTU') entry.didNotTurnUp += 1;
                    else if (s1 === 'Left in between' || s1 === 'Left In Between' || s1 === 'LIB') entry.leftInBetween += 1;
                    else entry.pending += 1;
                } else if (rPhase === 2 && isProfileSharedCandidate(candidate)) {
                    let anchor = String(round.assignAfterStage || 'Shortlisted').trim() || 'Shortlisted';
                    if (anchor === 'Interview Scheduled' || !['Profile Shared', 'Shortlisted', 'Selected', 'Rejected'].includes(anchor)) {
                        anchor = 'Shortlisted';
                    }
                    if (!phase2Map.has(key)) phase2Map.set(key, { levelName: name, assignAfterStage: anchor, count: 0, shortlisted: 0, rejected: 0, didNotTurnUp: 0, leftInBetween: 0, pending: 0 });
                    const entry = phase2Map.get(key);
                    if (!seenPhase2.has(key)) {
                        seenPhase2.add(key);
                        entry.count += 1;
                    }
                    const s2 = String(round.status || '').trim();
                    if (s2 === 'Passed' || s2 === 'Pass' || s2 === 'Shortlisted') entry.shortlisted += 1;
                    else if (s2 === 'Failed' || s2 === 'Fail' || s2 === 'Rejected') entry.rejected += 1;
                    else if (s2 === 'Did Not Turn Up' || s2 === 'Did Not Turnup' || s2 === 'Did Not Turn up' || s2 === 'Skipped' || s2 === 'No Show' || s2 === 'DNTU') entry.didNotTurnUp += 1;
                    else if (s2 === 'Left in between' || s2 === 'Left In Between' || s2 === 'LIB') entry.leftInBetween += 1;
                    else entry.pending += 1;
                }
            }

            if (isProfileSharedCandidate(candidate) && hasLegacyPhase2InterviewActivity(candidate) && seenPhase2.size === 0) {
                const name = 'Round 1';
                const anchor = 'Shortlisted';
                if (!phase2Map.has(name)) phase2Map.set(name, { levelName: name, assignAfterStage: anchor, count: 0 });
                if (!seenPhase2.has(name)) {
                    seenPhase2.add(name);
                    phase2Map.get(name).count += 1;
                }
            }
        }

        return res.status(200).json({
            phase1: Array.from(phase1Map.values()),
            phase2: Array.from(phase2Map.values())
        });
    } catch (error) {
        console.error('Error fetching candidate round summary:', error);
        res.status(500).json({ message: 'Server error', error: error.message });
    }
};

module.exports = {
    checkDuplicateCandidate,
    getCandidatesByPulledBy,
    globalSearchCandidates,
    getDistinctCandidateSkills,
    getCandidateCardFilters,
    globalSearchPublicApplications,
    getCandidateInterviewDetails,
    getCandidateRoundSummary
};
