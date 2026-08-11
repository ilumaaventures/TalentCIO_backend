const Candidate = require('../model/candidate.model');
const { HiringRequest } = require('../model/hiringRequest.model');
const OnboardingEmployee = require('../../onboarding/model/onboardingEmployee.model');
const mongoose = require('mongoose');
const { isDynamicHiringRequest } = require('../utils/phaseTemplateUtils');
const {
    TA_CAPABILITIES,
    buildAccessibleCandidateQuery,
    canAccessHiringRequestForCapability,
    isInterviewerOnlyView,
    sanitizeCandidateForInterviewer
} = require('../utils/candidateAccess');
const {
    DUPLICATE_CANDIDATE_MESSAGE,
    normalizeSkillList,
    normalizePhase2InterviewStatus,
    hasMeaningfulOfferValue,
    isCandidateOwnedByUser,
    canOverrideDuplicateCandidateOwnership,
    buildDuplicateCandidateMessage,
    getUserDisplayName,
    ensureCandidateCapability,
    hasMeaningfulStatus,
    toLegacySafeStatus,
    DEFAULT_LEGACY_CANDIDATE_STATUS,
    hasCandidateMovedToPhase2,
    hasRealResume,
    applyDynamicImportedStatus,
    isProfileSharedCandidate,
    canAccessHiringRequest,
    enrichCandidatesWithPublicProfiles,
    serializeCandidateForViewer,
    applyDateRangeFilterToCandidateQuery,
    parseBooleanQueryValue,
    buildLegacyCandidateListResponse,
    APPLICANT_REVIEW_SELECT,
    getCandidateHiringRequestForAccess,
    canViewCandidateDetailsPage
} = require('../utils/candidateAccess');
const { handleCandidateShortlist, sendAutoScheduleNotifications } = require('./candidateDecisionController');

// Create new candidate or update existing if allowed
const createCandidate = async (req, res) => {
    try {
        const {
            hiringRequestId,
            resumeUrl,
            resumePublicId,
            candidateName,
            email,
            mobile,
            source,
            referralName,
            profilePulledBy,
            calledBy,
            rate,
            currentCTC,
            expectedCTC,
            profileShared,
            phase2Decision,
            phase2InterviewerFeedback,
            phase2InterviewStatus,
            inHandOffer,
            offerCompany,
            offerCTC,
            offerJoiningDate,
            preference,
            totalExperience,
            qualification,
            currentCompany,
            pastExperience,
            currentLocation,
            preferredLocation,
            tatToJoin,
            noticePeriod,
            lastWorkingDay,
            status,
            remark,
            mustHaveSkills,
            niceToHaveSkills,
            interviewRounds
        } = req.body;
        const normalizedMustHaveSkills = normalizeSkillList(mustHaveSkills);
        const normalizedNiceToHaveSkills = normalizeSkillList(niceToHaveSkills);

        const normalizedSource = String(source || '').trim();
        const normalizedReferralName = normalizedSource === 'Referral'
            ? String(referralName || '').trim()
            : '';
        const normalizedPhase2InterviewStatus = phase2InterviewStatus === undefined
            ? undefined
            : normalizePhase2InterviewStatus(phase2InterviewStatus);
        const shouldMarkProfileSharedForPhase2 = normalizedPhase2InterviewStatus && normalizedPhase2InterviewStatus !== 'None';
        const normalizedInHandOffer = Boolean(inHandOffer) ||
            hasMeaningfulOfferValue(offerCompany) ||
            hasMeaningfulOfferValue(offerCTC) ||
            hasMeaningfulOfferValue(offerJoiningDate);
        const allowOwnedDuplicateUpdate = Boolean(req.body.allowOwnedDuplicateUpdate);

        if (phase2InterviewStatus !== undefined && normalizedPhase2InterviewStatus === null) {
            return res.status(400).json({ message: 'Phase 2 Interview Status must be Scheduled, Rejected, Shortlisted, or Did not Turn up' });
        }

        // Verify hiring request exists
        const hiringRequest = await HiringRequest.findOne({ _id: hiringRequestId, companyId: req.companyId });
        if (!hiringRequest) {
            return res.status(404).json({ message: 'Hiring request not found' });
        }

        let candidate = null;
        if (req.body._id && mongoose.Types.ObjectId.isValid(req.body._id)) {
            candidate = await Candidate.findOne({
                _id: req.body._id,
                hiringRequestId,
                companyId: req.companyId
            }).populate('uploadedBy', 'firstName lastName email');
        }

        if (!candidate) {
            const orConditions = [];
            if (email && typeof email === 'string') {
                orConditions.push({ email: email.toLowerCase().trim() });
            }
            if (mobile && typeof mobile === 'string') {
                orConditions.push({ mobile: mobile.trim() });
            }

            if (orConditions.length > 0) {
                candidate = await Candidate.findOne({
                    hiringRequestId,
                    $or: orConditions,
                    companyId: req.companyId
                }).populate('uploadedBy', 'firstName lastName email');
            }
        }

        const { isCandidateRoundAssignee } = require('../utils/taAccess');
        const isInterviewerForCandidate = candidate ? isCandidateRoundAssignee(candidate, req.user) : false;

        const canManageHiringRequest = await canAccessHiringRequestForCapability(hiringRequest, req.user, TA_CAPABILITIES.EDIT, req.companyId);
        if (!canManageHiringRequest && !isInterviewerForCandidate) {
            return res.status(403).json({ message: 'Forbidden: You do not have permission to add candidates to this requisition' });
        }

        const isDynamicRequest = isDynamicHiringRequest(hiringRequest);
        const normalizedLegacyStatus = isDynamicRequest
            ? ''
            : toLegacySafeStatus(hasMeaningfulStatus(status) ? status : DEFAULT_LEGACY_CANDIDATE_STATUS);

        if (candidate) {
            const ownedByCurrentUser = isCandidateOwnedByUser(candidate, req.user?._id);
            const hasDuplicateOverrideAccess = canOverrideDuplicateCandidateOwnership(req.user);
            const canAutoUpdateExistingCandidate = allowOwnedDuplicateUpdate && (ownedByCurrentUser || hasDuplicateOverrideAccess || isInterviewerForCandidate);

            if (!canAutoUpdateExistingCandidate) {
                return res.status(409).json({
                    message: buildDuplicateCandidateMessage(candidate, req.user?._id, canAutoUpdateExistingCandidate),
                    ownedByCurrentUser,
                    canAutoUpdate: canAutoUpdateExistingCandidate,
                    uploadedByName: getUserDisplayName(candidate.uploadedBy)
                });
            }

            const { hasAccess } = await ensureCandidateCapability(
                candidate,
                req.companyId,
                req.user,
                TA_CAPABILITIES.EDIT,
                { hiringRequest }
            );
            if (!hasAccess) {
                return res.status(403).json({ message: 'Forbidden: You do not have permission to update this candidate' });
            }
            // Update mode
            console.log('🔄 Existing candidate found, updating fields...');

            const updatedFields = [];
            const compareAndUpdate = (field, newValue, label) => {
                if (newValue !== undefined && newValue !== null && newValue !== '' && candidate[field] !== newValue) {
                    candidate[field] = newValue;
                    updatedFields.push(label || field);
                }
            };
            const forceUpdateField = (field, newValue, label) => {
                if (candidate[field] !== newValue) {
                    candidate[field] = newValue;
                    updatedFields.push(label || field);
                }
            };

            if (canManageHiringRequest) {
                compareAndUpdate('candidateName', candidateName, 'Name');
                compareAndUpdate('source', normalizedSource, 'Source');
                if (candidate.referralName !== normalizedReferralName) {
                    candidate.referralName = normalizedReferralName;
                    updatedFields.push('Referral Name');
                }
                compareAndUpdate('profilePulledBy', profilePulledBy, 'Pulled By');
                compareAndUpdate('calledBy', calledBy, 'Called By');
                compareAndUpdate('rate', rate, 'Rate');
                compareAndUpdate('currentCTC', currentCTC, 'Current CTC');
                compareAndUpdate('expectedCTC', expectedCTC, 'Expected CTC');
                compareAndUpdate('inHandOffer', normalizedInHandOffer, 'Offer in Hand');
                compareAndUpdate('offerCompany', offerCompany, 'Offer Company');
                compareAndUpdate('offerCTC', offerCTC, 'Offer CTC');
                compareAndUpdate('offerJoiningDate', offerJoiningDate, 'Offer Joining Date');
                compareAndUpdate('totalExperience', totalExperience, 'Experience');
                compareAndUpdate('qualification', qualification, 'Qualification');
                compareAndUpdate('currentCompany', currentCompany, 'Company');
                compareAndUpdate('currentLocation', currentLocation, 'Location');
                compareAndUpdate('preferredLocation', preferredLocation, 'Preferred Location');
                compareAndUpdate('tatToJoin', tatToJoin, 'TAT Join');
                compareAndUpdate('noticePeriod', noticePeriod, 'Notice Period');
                compareAndUpdate('lastWorkingDay', lastWorkingDay, 'DOJ/LWD');
                if (isDynamicRequest) {
                    const previousDynamicStatus = candidate.currentPhaseStatus || '';
                    const dynamicStatusApplied = applyDynamicImportedStatus(candidate, hiringRequest, status);
                    if (hasMeaningfulStatus(status) && !dynamicStatusApplied) {
                        return res.status(400).json({
                            message: `Status "${status}" is not valid for the current dynamic phase`
                        });
                    }
                    if (dynamicStatusApplied && previousDynamicStatus !== candidate.currentPhaseStatus) {
                        updatedFields.push('Status');
                    }
                } else {
                    compareAndUpdate('status', normalizedLegacyStatus, 'Status');
                }
                if (allowOwnedDuplicateUpdate) {
                    const importedDecision = String(req.body.decision || '').trim() || 'None';
                    forceUpdateField('decision', importedDecision, 'Decision');
                    forceUpdateField('profileShared', Boolean(profileShared), 'Profile Shared');
                } else {
                    const phase1Locked = hasCandidateMovedToPhase2(candidate);
                    if (!phase1Locked) {
                        compareAndUpdate('decision', req.body.decision, 'Decision');
                    }
                    if (!phase1Locked || profileShared !== false) {
                        compareAndUpdate('profileShared', profileShared, 'Profile Shared');
                    }
                }
                compareAndUpdate('phase2Decision', phase2Decision, 'Phase 2 Decision');
                compareAndUpdate('remark', remark, 'Remark');
                if (phase2InterviewerFeedback !== undefined) {
                    compareAndUpdate('phase2InterviewerFeedback', phase2InterviewerFeedback, 'Phase 2 Interviewer Feedback');
                }
                if (normalizedPhase2InterviewStatus !== undefined) {
                    compareAndUpdate('phase2InterviewStatus', normalizedPhase2InterviewStatus, 'Phase 2 Interview Status');
                }
                if ((shouldMarkProfileSharedForPhase2 || Boolean(String(phase2InterviewerFeedback || '').trim())) && !candidate.profileShared) {
                    candidate.profileShared = true;
                    updatedFields.push('Profile Shared');
                }

                if (hasRealResume(resumeUrl) && !hasRealResume(candidate.resumeUrl)) {
                    candidate.resumeUrl = resumeUrl;
                    if (resumePublicId) candidate.resumePublicId = resumePublicId;
                    updatedFields.push('Resume');
                }

                if (normalizedMustHaveSkills.length > 0) {
                    candidate.mustHaveSkills = normalizedMustHaveSkills;
                    updatedFields.push('Must-Have Skills');
                }
                if (normalizedNiceToHaveSkills.length > 0) {
                    candidate.niceToHaveSkills = normalizedNiceToHaveSkills;
                    updatedFields.push('Nice-To-Have Skills');
                }
            } else if (isInterviewerForCandidate) {
                if (phase2InterviewerFeedback !== undefined) {
                    candidate.phase2InterviewerFeedback = phase2InterviewerFeedback;
                }
                if (normalizedPhase2InterviewStatus !== undefined) {
                    candidate.phase2InterviewStatus = normalizedPhase2InterviewStatus;
                }
            }

            let shortlistResult = null;
            if (['Shortlisted', 'Rejected', 'Did Not Turn Up'].includes(candidate.decision)) {
                shortlistResult = await handleCandidateShortlist(candidate, req);
            }

            await candidate.save();

            if (shortlistResult && shortlistResult.hasNewRounds) {
                await sendAutoScheduleNotifications(candidate, shortlistResult.roundsToAdd, req);
            }

            const updatedCandidate = await Candidate.findOne({ _id: candidate._id, companyId: req.companyId })
                .populate('uploadedBy', 'firstName lastName email')
                .populate('hiringRequestId', 'requestId roleDetails')
                .populate('interviewRounds.assignedTo', 'firstName lastName email')
                .populate('interviewRounds.evaluatedBy', 'firstName lastName');

            return res.status(200).json({
                message: 'Candidate updated successfully',
                candidate: updatedCandidate,
                isUpdate: true,
                updatedFields
            });
        }

        // New candidate creation mode
        const legacySafeStatus = isDynamicRequest
            ? ''
            : toLegacySafeStatus(hasMeaningfulStatus(status) ? status : DEFAULT_LEGACY_CANDIDATE_STATUS);

        candidate = new Candidate({
            companyId: req.companyId,
            hiringRequestId,
            uploadedBy: req.user._id,
            resumeUrl,
            resumePublicId,
            candidateName,
            email,
            mobile,
            source: normalizedSource,
            referralName: normalizedReferralName,
            profilePulledBy,
            calledBy,
            rate,
            currentCTC,
            expectedCTC,
            profileShared: shouldMarkProfileSharedForPhase2 ? true : Boolean(profileShared),
            phase2Decision,
            phase2InterviewerFeedback,
            phase2InterviewStatus: normalizedPhase2InterviewStatus,
            inHandOffer: normalizedInHandOffer,
            offerCompany,
            offerCTC,
            offerJoiningDate,
            preference,
            totalExperience,
            qualification,
            currentCompany,
            pastExperience,
            currentLocation,
            preferredLocation,
            tatToJoin,
            noticePeriod,
            lastWorkingDay,
            decision: req.body.decision || 'None',
            status: legacySafeStatus,
            remark,
            mustHaveSkills: normalizedMustHaveSkills,
            niceToHaveSkills: normalizedNiceToHaveSkills,
            interviewRounds: interviewRounds || [],
            statusHistory: legacySafeStatus ? [{
                status: legacySafeStatus,
                changedBy: req.user._id,
                changedAt: new Date(),
                remark
            }] : []
        });

        if (isDynamicRequest) {
            const dynamicStatusApplied = applyDynamicImportedStatus(candidate, hiringRequest, status);
            if (hasMeaningfulStatus(status) && !dynamicStatusApplied) {
                return res.status(400).json({
                    message: `Status "${status}" is not valid for the current dynamic phase`
                });
            }
        }

        let shortlistResult = null;
        if (['Shortlisted', 'Rejected', 'Did Not Turn Up'].includes(candidate.decision)) {
            shortlistResult = await handleCandidateShortlist(candidate, req);
        }

        await candidate.save();

        if (shortlistResult && shortlistResult.hasNewRounds) {
            await sendAutoScheduleNotifications(candidate, shortlistResult.roundsToAdd, req);
        }

        const populatedCandidate = await Candidate.findOne({ _id: candidate._id, companyId: req.companyId })
            .populate('uploadedBy', 'firstName lastName email')
            .populate('hiringRequestId', 'requestId roleDetails')
            .populate('interviewRounds.assignedTo', 'firstName lastName email')
            .populate('interviewRounds.evaluatedBy', 'firstName lastName');

        res.status(201).json({
            message: 'Candidate created successfully',
            candidate: populatedCandidate,
            isUpdate: false
        });

    } catch (error) {
        console.error('Error creating candidate:', error);
        if (error.code === 11000) {
            return res.status(409).json({ message: DUPLICATE_CANDIDATE_MESSAGE });
        }
        res.status(500).json({ message: 'Server error', error: error.message });
    }
};

// Get all candidates for a hiring request
const getCandidatesByHiringRequest = async (req, res) => {
    try {
        const { hiringRequestId } = req.params;
        const {
            dateField,
            startDate,
            endDate,
            paginate,
            page = 1,
            limit = 15
        } = req.query;

        if (!mongoose.Types.ObjectId.isValid(hiringRequestId)) {
            return res.status(400).json({ message: 'Invalid Hiring Request ID format' });
        }

        const hiringRequest = await HiringRequest.findOne({ _id: hiringRequestId, companyId: req.companyId });
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
            .populate('uploadedBy', 'firstName lastName email')
            .populate('hiringRequestId', 'requestId roleDetails')
            .populate('applicantId', APPLICANT_REVIEW_SELECT)
            .populate('interviewRounds.assignedTo', 'firstName lastName email')
            .populate('interviewRounds.evaluatedBy', 'firstName lastName')
            .sort({ uploadedAt: -1 })
            .lean();

        const enrichedCandidates = await enrichCandidatesWithPublicProfiles(candidates, req.companyId);
        let serializedCandidates = enrichedCandidates.map((candidate) => serializeCandidateForViewer({
            candidate,
            user: req.user,
            hiringRequest
        }));

        const targetPhase = Number(req.query.activePhase) || 1;
        if (targetPhase === 2) {
            serializedCandidates = serializedCandidates.filter(isProfileSharedCandidate);
        } else if (targetPhase === 3) {
            serializedCandidates = serializedCandidates.filter(c => c.phase2Decision === 'Selected');
        }

        const filterStatus = String(req.query.filterStatus || 'All').trim();
        if (filterStatus !== 'All') {
            const mainStatuses = ['Interested', 'Not Interested', 'Not Relevant', 'Not Picking', 'High expectation', 'Long Notice period', 'Location Not suitable'];
            if (['Other', 'None', 'OTH'].includes(filterStatus)) {
                serializedCandidates = serializedCandidates.filter(c => !mainStatuses.includes(c.status));
            } else {
                serializedCandidates = serializedCandidates.filter(c => c.status === filterStatus);
            }
        }

        const filterDecision = String(req.query.filterDecision || 'All').trim();
        if (filterDecision !== 'All') {
            serializedCandidates = serializedCandidates.filter(c => (c.decision || 'None') === filterDecision);
        }

        const search = String(req.query.search || '').trim().toLowerCase();
        if (search) {
            serializedCandidates = serializedCandidates.filter(c => String(c.candidateName || '').toLowerCase().includes(search));
        }

        if (parseBooleanQueryValue(paginate)) {
            const paginatedResponse = buildLegacyCandidateListResponse({
                candidates: serializedCandidates,
                filters: {
                    activePhase: req.query.activePhase,
                    search: req.query.search,
                    filterPreference: req.query.filterPreference,
                    filterStatus: req.query.filterStatus,
                    filterDecision: req.query.filterDecision,
                    filterExperience: req.query.filterExperience,
                    filterInterviewStatus: req.query.filterInterviewStatus,
                    filterRating: req.query.filterRating,
                    filterPulledBy: req.query.filterPulledBy,
                    filterUploadedBy: req.query.filterUploadedBy,
                    filterUploadType: req.query.filterUploadType,
                    filterTransferred: req.query.filterTransferred,
                    filterProfileShared: parseBooleanQueryValue(req.query.filterProfileShared),
                    filterInterviewRound: req.query.filterInterviewRound || req.query.interviewRound,
                    filterDynamicStage: req.query.filterDynamicStage
                },
                page,
                limit
            });

            return res.status(200).json(paginatedResponse);
        }

        res.status(200).json({
            count: serializedCandidates.length,
            candidates: serializedCandidates
        });

    } catch (error) {
        console.error('Error fetching candidates:', error);
        res.status(500).json({ message: 'Server error', error: error.message });
    }
};

// Get shortlisted candidates for a hiring request with pagination
const getShortlistedCandidates = async (req, res) => {
    try {
        const { hiringRequestId } = req.params;

        if (!mongoose.Types.ObjectId.isValid(hiringRequestId)) {
            return res.status(400).json({ message: 'Invalid Hiring Request ID format' });
        }

        const page = parseInt(req.query.page, 10) || 1;
        const limit = parseInt(req.query.limit, 10) || 10;
        const skip = (page - 1) * limit;

        const hiringRequest = await HiringRequest.findOne({ _id: hiringRequestId, companyId: req.companyId });
        if (!hiringRequest) {
            return res.status(404).json({ message: 'Hiring request not found' });
        }

        const hasHiringRequestAccess = await canAccessHiringRequest(hiringRequest, req.companyId, req.user, { action: 'view' });

        if (!hasHiringRequestAccess) {
            return res.status(403).json({ message: 'Forbidden: You do not have permission to view this request' });
        }

        const query = await buildAccessibleCandidateQuery(req.companyId, req.user, {
            hiringRequestId,
            $or: [
                { profileShared: true },
                { profileShared: { $exists: false }, decision: 'Shortlisted' }
            ]
        }, { capability: TA_CAPABILITIES.VIEW });

        const totalOptions = await Candidate.countDocuments(query);
        const candidates = await Candidate.find(query)
            .populate('uploadedBy', 'firstName lastName')
            .populate('hiringRequestId', 'requestId roleDetails')
            .populate('interviewRounds.assignedTo', 'firstName lastName')
            .populate('interviewRounds.evaluatedBy', 'firstName lastName')
            .select('candidateName email mobile status decision profileShared uploadedAt interviewRounds profilePulledBy calledBy rate totalExperience currentCTC expectedCTC pastExperience currentCompany offerCompany offerJoiningDate lastWorkingDay currentLocation preferredLocation noticePeriod tatToJoin qualification remark customRemark mustHaveSkills skillRatings phase2Decision phase2InterviewerFeedback phase2InterviewStatus')
            .sort({ uploadedAt: -1 })
            .skip(skip)
            .limit(limit)
            .lean();

        const serializedCandidates = candidates.map((candidate) => serializeCandidateForViewer({
            candidate,
            user: req.user,
            hiringRequest
        }));

        res.status(200).json({
            count: totalOptions,
            totalPages: Math.ceil(totalOptions / limit),
            currentPage: page,
            candidates: serializedCandidates
        });

    } catch (error) {
        console.error('Error fetching shortlisted candidates:', error);
        res.status(500).json({ message: 'Server error', error: error.message });
    }
};

const getCandidateByIdPayload = async (req) => {
    const { id } = req.params;

    let candidateData = await Candidate.findOne({ _id: id, companyId: req.companyId })
        .populate('uploadedBy', 'firstName lastName email')
        .populate('hiringRequestId', 'requestId roleDetails requirements client clientConfidential')
        .populate('applicantId', APPLICANT_REVIEW_SELECT)
        .populate('statusHistory.changedBy', 'firstName lastName')
        .populate('interviewRounds.assignedTo', 'firstName lastName email')
        .populate('interviewRounds.evaluatedBy', 'firstName lastName')
        .lean();

    if (!candidateData) {
        return { status: 404, body: { message: 'Candidate not found' } };
    }

    const hiringRequest = await getCandidateHiringRequestForAccess(candidateData, req.companyId);
    const { hasAccess } = await ensureCandidateCapability(
        candidateData,
        req.companyId,
        req.user,
        TA_CAPABILITIES.VIEW,
        { hiringRequest }
    );
    if (!hasAccess) {
        return { status: 403, body: { message: 'Forbidden: You do not have permission to view this candidate' } };
    }

    if (candidateData.hiringRequestId?.requirements) {
        const hrr = candidateData.hiringRequestId.requirements;
        const currentRatings = candidateData.skillRatings || [];
        let hasChanges = false;

        const syncSkills = (skills, category) => {
            if (!skills || !Array.isArray(skills)) return;
            skills.forEach((skill) => {
                const exists = currentRatings.some((rating) => rating.skill.toLowerCase() === skill.toLowerCase());
                if (!exists) {
                    currentRatings.push({ skill, rating: 0, category });
                    hasChanges = true;
                }
            });
        };

        const mustHaveSkillList = Array.isArray(hrr.mustHaveSkills)
            ? hrr.mustHaveSkills
            : [
                ...(Array.isArray(hrr.mustHaveSkills?.technical) ? hrr.mustHaveSkills.technical : []),
                ...(Array.isArray(hrr.mustHaveSkills?.softSkills) ? hrr.mustHaveSkills.softSkills : [])
            ];

        syncSkills(mustHaveSkillList, 'Must-Have');
        syncSkills(hrr.niceToHaveSkills, 'Nice-To-Have');

        if (hasChanges) {
            await Candidate.findOneAndUpdate({ _id: id, companyId: req.companyId }, { $set: { skillRatings: currentRatings } });
            candidateData.skillRatings = currentRatings;
        }
    }

    let candidate = await enrichCandidatesWithPublicProfiles(candidateData, req.companyId);
    const hasHiringRequestAccess = await canAccessHiringRequest(hiringRequest, req.companyId, req.user, { action: 'view' });

    if (!hasHiringRequestAccess) {
        const interviewerOnly = await isInterviewerOnlyView({
            candidate,
            hiringRequest,
            companyId: req.companyId,
            user: req.user
        });

        if (!interviewerOnly) {
            return { status: 403, body: { message: 'Forbidden: You do not have permission to view this candidate' } };
        }

        candidate = sanitizeCandidateForInterviewer(candidate);
    }

    return {
        status: 200,
        body: serializeCandidateForViewer({
            candidate,
            user: req.user,
            hiringRequest,
            interviewerOnly: !hasHiringRequestAccess
        })
    };
};

// Get single candidate by ID
const getCandidateById = async (req, res) => {
    try {
        const response = await getCandidateByIdPayload(req);
        res.status(response.status).json(response.body);
    } catch (error) {
        console.error('Error fetching candidate:', error);
        res.status(500).json({ message: 'Server error', error: error.message });
    }
};

const getCandidateDetailsById = async (req, res) => {
    try {
        const { id } = req.params;
        const candidate = await Candidate.findOne({ _id: id, companyId: req.companyId });
        if (!candidate) {
            return res.status(404).json({ message: 'Candidate not found' });
        }

        const { isCandidateRoundAssignee } = require('../utils/taAccess');
        const isInterviewer = isCandidateRoundAssignee(candidate, req.user);

        if (!canViewCandidateDetailsPage(req.user) && !isInterviewer) {
            return res.status(403).json({
                message: 'Forbidden: Candidate details page requires ta.candidate.manage.all or ta.candidate.manage.assigned'
            });
        }

        const { hasAccess } = await ensureCandidateCapability(candidate, req.companyId, req.user, TA_CAPABILITIES.EDIT);
        if (!hasAccess) {
            return res.status(403).json({
                message: 'Forbidden: You do not have permission to open this candidate details page'
            });
        }

        const response = await getCandidateByIdPayload(req);
        res.status(response.status).json(response.body);
    } catch (error) {
        console.error('Error fetching candidate details:', error);
        res.status(500).json({ message: 'Server error', error: error.message });
    }
};

// Update candidate
const updateCandidate = async (req, res) => {
    try {
        const { id } = req.params;

        const candidate = await Candidate.findOne({ _id: id, companyId: req.companyId });
        if (!candidate) {
            return res.status(404).json({ message: 'Candidate not found' });
        }

        const { hasAccess } = await ensureCandidateCapability(candidate, req.companyId, req.user, TA_CAPABILITIES.EDIT);
        if (!hasAccess) {
            return res.status(403).json({ message: 'Forbidden: You do not have permission to update this candidate' });
        }

        const {
            candidateName,
            name,
            email,
            mobile,
            source,
            referralName,
            profilePulledBy,
            calledBy,
            rate,
            currentCTC,
            expectedCTC,
            inHandOffer,
            offerCompany,
            offerCTC,
            offerJoiningDate,
            preference,
            totalExperience,
            qualification,
            currentCompany,
            pastExperience,
            currentLocation,
            preferredLocation,
            tatToJoin,
            noticePeriod,
            lastWorkingDay,
            status,
            decision,
            profileShared,
            phase2Decision,
            remark,
            phase2InterviewerFeedback,
            phase2InterviewStatus,
            mustHaveSkills,
            niceToHaveSkills,
            resumeUrl,
            resumePublicId
        } = req.body || {};

        // Handle status updates for dynamic vs legacy hiring requests
        if (hasMeaningfulStatus(status)) {
            const hiringRequest = await HiringRequest.findOne({ _id: candidate.hiringRequestId, companyId: req.companyId });
            if (isDynamicHiringRequest(hiringRequest)) {
                const dynamicStatusApplied = applyDynamicImportedStatus(candidate, hiringRequest, status);
                if (!dynamicStatusApplied) {
                    return res.status(400).json({
                        message: `Status "${status}" is not valid for the current dynamic phase`
                    });
                }
            } else if (status !== candidate.status) {
                candidate.statusHistory.push({
                    status,
                    changedBy: req.user._id,
                    changedAt: new Date(),
                    remark: remark || ''
                });
                candidate.status = status;
            }
        }

        const nameToSet = candidateName !== undefined ? candidateName : name;
        if (nameToSet !== undefined) candidate.candidateName = nameToSet;
        if (email !== undefined) candidate.email = email;
        if (mobile !== undefined) candidate.mobile = mobile;

        if (source !== undefined) {
            candidate.source = String(source || '').trim();
            if (candidate.source === 'Referral' && referralName !== undefined) {
                candidate.referralName = String(referralName || '').trim();
            } else if (candidate.source !== 'Referral') {
                candidate.referralName = '';
            }
        } else if (referralName !== undefined) {
            candidate.referralName = String(referralName || '').trim();
        }

        if (profilePulledBy !== undefined) candidate.profilePulledBy = profilePulledBy;
        if (calledBy !== undefined) candidate.calledBy = calledBy;
        if (rate !== undefined) candidate.rate = rate;
        if (currentCTC !== undefined) candidate.currentCTC = currentCTC;
        if (expectedCTC !== undefined) candidate.expectedCTC = expectedCTC;
        if (inHandOffer !== undefined) candidate.inHandOffer = inHandOffer;
        if (offerCompany !== undefined) candidate.offerCompany = offerCompany;
        if (offerCTC !== undefined) candidate.offerCTC = offerCTC;
        if (offerJoiningDate !== undefined) candidate.offerJoiningDate = offerJoiningDate;
        if (preference !== undefined) candidate.preference = preference;
        if (totalExperience !== undefined) candidate.totalExperience = totalExperience;
        if (qualification !== undefined) candidate.qualification = qualification;
        if (currentCompany !== undefined) candidate.currentCompany = currentCompany;
        if (pastExperience !== undefined) candidate.pastExperience = pastExperience;
        if (currentLocation !== undefined) candidate.currentLocation = currentLocation;
        if (preferredLocation !== undefined) candidate.preferredLocation = preferredLocation;
        if (tatToJoin !== undefined) candidate.tatToJoin = tatToJoin;
        if (noticePeriod !== undefined) candidate.noticePeriod = noticePeriod;
        if (lastWorkingDay !== undefined) candidate.lastWorkingDay = lastWorkingDay;
        if (decision !== undefined) candidate.decision = decision;
        if (profileShared !== undefined) candidate.profileShared = profileShared;
        if (phase2Decision !== undefined) candidate.phase2Decision = phase2Decision;
        if (remark !== undefined) candidate.remark = remark;
        if (phase2InterviewerFeedback !== undefined) candidate.phase2InterviewerFeedback = phase2InterviewerFeedback;
        if (phase2InterviewStatus !== undefined) {
            candidate.phase2InterviewStatus = normalizePhase2InterviewStatus(phase2InterviewStatus);
        }
        if (mustHaveSkills !== undefined) candidate.mustHaveSkills = normalizeSkillList(mustHaveSkills);
        if (niceToHaveSkills !== undefined) candidate.niceToHaveSkills = normalizeSkillList(niceToHaveSkills);
        if (resumeUrl !== undefined) candidate.resumeUrl = resumeUrl;
        if (resumePublicId !== undefined) candidate.resumePublicId = resumePublicId;

        await candidate.save();

        const updatedCandidate = await Candidate.findOne({ _id: id, companyId: req.companyId })
            .populate('uploadedBy', 'firstName lastName email')
            .populate('hiringRequestId', 'requestId roleDetails')
            .populate('statusHistory.changedBy', 'firstName lastName');

        res.status(200).json({
            message: 'Candidate updated successfully',
            candidate: updatedCandidate
        });

    } catch (error) {
        console.error('Error updating candidate:', error);
        res.status(500).json({ message: 'Server error', error: error.message });
    }
};

// Delete candidate
const deleteCandidate = async (req, res) => {
    try {
        const { id } = req.params;

        const candidate = await Candidate.findOne({ _id: id, companyId: req.companyId });
        if (!candidate) {
            return res.status(404).json({ message: 'Candidate not found' });
        }

        const { hasAccess } = await ensureCandidateCapability(candidate, req.companyId, req.user, TA_CAPABILITIES.EDIT);
        if (!hasAccess) {
            return res.status(403).json({ message: 'Forbidden: You do not have permission to delete this candidate' });
        }

        if (candidate.isTransferredToOnboarding) {
            candidate.isTransferredToOnboarding = false;
            await candidate.save();
            await OnboardingEmployee.deleteOne({ candidateId: id, companyId: req.companyId });
        }

        await candidate.softDelete(req.user._id);

        res.status(200).json({ message: 'Candidate moved to bin' });

    } catch (error) {
        console.error('Error deleting candidate:', error);
        res.status(500).json({ message: 'Server error', error: error.message });
    }
};

module.exports = {
    createCandidate,
    getCandidatesByHiringRequest,
    getShortlistedCandidates,
    getCandidateByIdPayload,
    getCandidateById,
    getCandidateDetailsById,
    updateCandidate,
    deleteCandidate
};
