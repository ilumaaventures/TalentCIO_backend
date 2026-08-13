const Candidate = require('../../model/candidate.model');
const { HiringRequest } = require('../../model/hiringRequest.model');
const mongoose = require('mongoose');

const isRoundScheduledStatus = (status) => {
    const s = String(status || '').trim().toLowerCase();
    if (!s || s === 'pending' || s === 'scheduled') return true;
    const closed = ['passed', 'pass', 'shortlisted', 'failed', 'fail', 'rejected', 'did not turn up', 'did not turnup', 'dntu', 'skipped', 'no show', 'left in between', 'lib'];
    return !closed.includes(s);
};
const isRoundPassedStatus = (status) => {
    const s = String(status || '').trim().toLowerCase();
    return s === 'passed' || s === 'pass' || s === 'shortlisted';
};
const {
    TA_CAPABILITIES,
    buildAccessibleCandidateQuery,
    applyDateRangeFilterToCandidateQuery,
    parseStringArrayQuery,
    parseBooleanQueryValue,
    getCandidateUploadedByName,
    getCandidateUploadType,
    isProfileSharedCandidate,
    getLegacyRoundsForPhase,
    hasLegacyPhase2InterviewActivity,
    getLegacyAverageRatingForPhase,
    canAccessHiringRequest
} = require('../../utils/candidateAccess');

exports.getCandidateCardFilters = async (req, res) => {
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
            .select('_id candidateName status decision profileShared uploadedAt interviewRounds profilePulledBy totalExperience relevantExperience preference isTransferred uploadedBy resumeUrl phase2Decision phase2InterviewStatus phase2InterviewerFeedback phase3Decision')
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
                shortlisted: structuralPhase2Candidates.filter((candidate) =>
                    candidate?.phase2Decision === 'Shortlisted'
                ).length,
                totalScreened: structuralPhase2Candidates.filter((candidate) =>
                    candidate?.phase2Decision === 'Shortlisted'
                ).length,
                selected: structuralPhase2Candidates.filter((candidate) =>
                    candidate?.phase2Decision === 'Selected'
                ).length,
                rejected: structuralPhase2Candidates.filter((candidate) =>
                    candidate?.phase2Decision === 'Rejected'
                ).length,
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

exports.getCandidateInterviewDetails = async (req, res) => {
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
                    } else if (filterDecision === 'Shortlisted') {
                        if (c?.phase2Decision !== 'Shortlisted') return false;
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

            if (filterInterviewStatus && filterInterviewStatus !== 'All') {
                if (targetPhase === 2) {
                    if (filterInterviewStatus === 'Scheduled') {
                        const hasActivity = (c?.phase2InterviewStatus && c?.phase2InterviewStatus !== 'None') ||
                            (Array.isArray(c?.interviewRounds) && c.interviewRounds.some(r => Number(r.phase || 1) === 2));
                        if (!hasActivity) return false;
                    } else if ((c?.phase2InterviewStatus || 'None') !== filterInterviewStatus) {
                        return false;
                    }
                } else {
                    if (filterInterviewStatus === 'Scheduled') {
                        if (!Array.isArray(c?.interviewRounds) || c.interviewRounds.length === 0) return false;
                    }
                }
            }

            const isNotScheduledFilter = filterDynamicStage && filterDynamicStage.startsWith('NotScheduled_');

            if (filterInterviewRound && !isNotScheduledFilter) {
                const targetRound = String(filterInterviewRound).trim().toLowerCase();
                const rounds = Array.isArray(c?.interviewRounds)
                    ? c.interviewRounds.filter(r => Number(r.phase || 1) === targetPhase)
                    : [];
                const hasRound = rounds.some((r) =>
                    String(r?.levelName || '').trim().toLowerCase() === targetRound
                );
                if (!hasRound) return false;
            }

            if (filterDynamicStage && filterDynamicStage !== 'All') {
                const parts = filterDynamicStage.split('_');
                const statusType = parts[0];
                const targetRoundName = parts.slice(1).join('_').trim().toLowerCase();
                const rounds = Array.isArray(c?.interviewRounds)
                    ? c.interviewRounds.filter(r => Number(r.phase || 1) === targetPhase)
                    : [];

                if (statusType === 'NotScheduled' || statusType === 'Unscheduled') {
                    const hasTargetRound = rounds.some(r => String(r.levelName || '').trim().toLowerCase() === targetRoundName);
                    if (hasTargetRound) return false;
                } else {
                    const targetRoundObj = rounds.find(r => String(r.levelName || '').trim().toLowerCase() === targetRoundName);
                    if (!targetRoundObj) return false;
                    const s = String(targetRoundObj.status || 'Pending').trim();
                    if (statusType === 'Cleared' && !['Passed', 'Pass', 'Shortlisted'].includes(s)) return false;
                    if (statusType === 'Failed' && !['Failed', 'Fail', 'Rejected'].includes(s)) return false;
                    if (statusType === 'DNTU' && !['Did Not Turn Up', 'Did Not Turnup', 'Skipped', 'No Show', 'DNTU'].includes(s)) return false;
                    if (statusType === 'LIB' && !['Left in between', 'Left In Between', 'LIB'].includes(s)) return false;
                    if (statusType === 'Pending' && !['Pending', 'Scheduled'].includes(s)) return false;
                }
            }

            return true;
        });

        res.status(200).json(filtered);
    } catch (error) {
        console.error('Error fetching candidate interview details:', error);
        res.status(500).json({ message: 'Server error', error: error.message });
    }
};

exports.getCandidateRoundSummary = async (req, res) => {
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
        const isProfileSharedCandidate = (c) => Boolean(
            c?.profileShared === true ||
            c?.decision === 'Shortlisted' ||
            c?.decision === 'Profile Shared' ||
            (c?.phase2Decision && c?.phase2Decision !== 'None') ||
            (c?.phase2InterviewStatus && c?.phase2InterviewStatus !== 'None') ||
            Boolean(c?.phase2InterviewerFeedback)
        );

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
