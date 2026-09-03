const Candidate = require('../../model/candidate.model');
const { HiringRequest } = require('../../model/hiringRequest.model');
const PublicApplication = require('../../model/publicApplication.model');
const {
    TA_CAPABILITIES,
    buildAccessibleCandidateQuery,
    parseStringArrayQuery,
    serializeCandidateForViewer,
    applyDateRangeFilterToCandidateQuery
} = require('../../utils/candidateAccess');

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

exports.globalSearchCandidates = async (req, res) => {
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

        const { startDate, endDate, dateField, dateFrom, dateTo } = req.query;
        const effectiveStartDate = startDate || dateFrom;
        const effectiveEndDate = endDate || dateTo;
        if (effectiveStartDate || effectiveEndDate) {
            applyDateRangeFilterToCandidateQuery(filterQuery, dateField, effectiveStartDate, effectiveEndDate);
            applyDateRangeFilterToCandidateQuery(publicAppFilterQuery, dateField, effectiveStartDate, effectiveEndDate);
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

exports.getDistinctCandidateSkills = async (req, res) => {
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
