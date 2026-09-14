const { maskEmail, maskPhone, omitFields } = require('./taVisibility');

/**
 * Checks if a candidate is visible to the client based on requisition clientVisibility settings.
 *
 * EVALUATION PRECEDENCE:
 * 1. Hard Overrides:
 *    a. candidate.hiddenFromClient === true -> ALWAYS HIDDEN (recruiter manual suppress)
 *    b. visibility.enabled === false -> ALWAYS HIDDEN (portal disabled on requisition)
 * 2. Exclusion Guardrails:
 *    a. visibility.hideRejected -> Drop if candidate status/decision is Rejected
 *    b. visibility.hideOnHold -> Drop if candidate status/decision is Hold
 * 3. Candidate Qualification Filters:
 *    - 'explicitOnly' / visibleFromCondition: 'profileShared': Must have profileShared === true
 *    - 'shortlistedOnly' / onlyShortlisted: Must be Shortlisted or Selected
 *    - 'interviewScheduled' / requireClientInterview: Must have client interview scheduled
 * 4. Direct Assignment Bypass:
 *    - If logged-in client user is in candidate.interviewRounds.assignedClientUsers -> VISIBLE
 * 5. Phase-Gating Threshold:
 *    - Gated by minPhaseOrder (defaults to 1 = Phase 2 if unspecified).
 *    - Candidate must meet or exceed minPhaseOrder (or have progressed past Phase 1).
 */
const isCandidateVisibleToClient = (candidate, hiringRequest, clientUser) => {
    if (!candidate || !hiringRequest) return false;

    // 1. Explicitly hidden from client override (recruiter manually unshared this candidate)
    if (candidate.hiddenFromClient === true) return false;

    // 2. Direct client assignment check: If client interviewer is directly assigned to any round on this candidate
    if (clientUser && Array.isArray(candidate.interviewRounds)) {
        const isAssigned = candidate.interviewRounds.some(round =>
            Array.isArray(round.assignedClientUsers) &&
            round.assignedClientUsers.some(uid => String(uid?._id || uid) === String(clientUser._id))
        );
        if (isAssigned) return true;
    }

    const visibility = hiringRequest.clientVisibility || {};
    // 3. If client portal visibility is explicitly disabled on the requisition, hide completely
    if (visibility.enabled === false) return false;

    // Status / decision normalization
    const status = String(candidate.status || '').trim();
    const decision = String(candidate.decision || '').trim();
    const p2Decision = String(candidate.phase2Decision || '').trim();
    const p3Decision = String(candidate.phase3Decision || '').trim();

    const isRejected = status === 'Rejected' || status === 'Drop' ||
                       decision === 'Rejected' || p2Decision === 'Rejected' || p3Decision === 'Rejected';

    const isOnHold = status === 'Hold' || status === 'On Hold' ||
                     decision === 'Hold' || p2Decision === 'Hold' || p3Decision === 'Hold';

    // 4. Drop/Rejected guardrail: If hideRejected is true, drop immediately
    if (visibility.hideRejected && isRejected) {
        return false;
    }

    // 5. On-Hold guardrail: If hideOnHold is true, drop immediately
    if (visibility.hideOnHold && isOnHold) {
        return false;
    }

    const isShortlisted = p2Decision === 'Shortlisted' || p2Decision === 'Selected' ||
                          decision === 'Shortlisted' || decision === 'Selected' ||
                          status === 'Shortlisted' || status === 'Selected';

    const hasInterview = (Array.isArray(candidate.interviewRounds) && candidate.interviewRounds.length > 0) ||
                         (candidate.phase2InterviewStatus && candidate.phase2InterviewStatus !== 'None') ||
                         status === 'Interview Scheduled' || status === 'In Interview';

    const isExplicitlyShared = candidate.profileShared === true;

    // 6. Candidate Qualification Filter (e.g. Phase 2 Shortlisted Only)
    const filter = visibility.candidateFilter || (visibility.onlyShortlisted ? 'shortlistedOnly' : 'all');

    if (filter === 'explicitOnly' || visibility.visibleFromCondition === 'profileShared') {
        return isExplicitlyShared;
    }

    if (filter === 'shortlistedOnly' || visibility.onlyShortlisted) {
        if (!isShortlisted) return false;
    }

    if (filter === 'interviewScheduled' || visibility.requireClientInterview) {
        const hasClientRound = Array.isArray(candidate.interviewRounds) && candidate.interviewRounds.some(round =>
            round.isClientInterview === true ||
            (Array.isArray(round.assignedClientUsers) && round.assignedClientUsers.length > 0)
        );
        if (!hasInterview && !hasClientRound) return false;
    }

    // 7. Explicit profile share override: Recruiter manually marked this profile as shared with the client
    if (isExplicitlyShared) {
        return true;
    }

    // 8. Phase-Gated Access Check
    // Secure by default: If not explicitly specified, default to 1 (Phase 2), preventing raw Phase 1 leads from leaking.
    const rawOrder = visibility.visibleFromPhaseOrder ?? visibility.visibleFromPhaseIndex;
    const minPhaseOrder = (rawOrder !== undefined && rawOrder !== null) ? Number(rawOrder) : 1;

    // If Phase 1 (index 0) was explicitly configured
    if (minPhaseOrder <= 0) {
        return true;
    }

    // If minPhaseOrder >= 1 (e.g. Phase 2 or beyond):
    const candidatePhaseOrder = candidate.currentPhaseOrder !== undefined && candidate.currentPhaseOrder !== null
        ? Number(candidate.currentPhaseOrder)
        : null;

    if (candidatePhaseOrder !== null) {
        return candidatePhaseOrder >= minPhaseOrder;
    }

    // Fallback if currentPhaseOrder not set on candidate:
    const hasProgressedPastPhase1 = (p2Decision && p2Decision !== 'None') ||
                                   hasInterview ||
                                   isShortlisted ||
                                   isExplicitlyShared;

    if (minPhaseOrder === 1) { // Phase 2
        return Boolean(hasProgressedPastPhase1);
    }

    if (minPhaseOrder >= 2) { // Phase 3 (Offer / Hired)
        const isOfferOrHired = (p3Decision && p3Decision !== 'None') ||
                               status === 'Selected' || status === 'Offer Released' || status === 'Hired' ||
                               p2Decision === 'Selected';
        return Boolean(isOfferOrHired);
    }

    return false;
};

/**
 * Sanitizes candidate object for client portal display based on client visibility rules.
 */
const sanitizeCandidateForClient = (candidateDoc, hiringRequest, clientUser) => {
    if (!candidateDoc) return null;

    const candidate = candidateDoc.toObject ? candidateDoc.toObject() : { ...candidateDoc };
    const visibility = hiringRequest?.clientVisibility || {};

    // 1. Contact masking (masked unless explicitly configured to allow full PII)
    const allowPII = visibility.canViewCandidatePII === true || visibility.maskCandidateContact === false;
    if (!allowPII) {
        if (candidate.email) candidate.email = maskEmail(candidate.email);
        if (candidate.mobile) candidate.mobile = maskPhone(candidate.mobile);
    }

    // 2. Compensation masking
    const allowCompensation = visibility.canViewCompensation === true || visibility.maskCompensation === false;
    if (!allowCompensation) {
        delete candidate.currentCTC;
        delete candidate.expectedCTC;
        delete candidate.compensation;
    }

    // 3. Internal remarks & notes
    if (!visibility.showInternalNotes && !visibility.canViewInternalNotes) {
        delete candidate.internalRemark;
    }

    // 4. Resume download gating (protected against disintermediation)
    if (visibility.allowResumeDownload === false) {
        delete candidate.resumeUrl;
        delete candidate.resumeFile;
        delete candidate.resumePublicId;
    }

    // 5. Clean interview rounds — do not leak internal recruiter/interviewer emails & PII
    if (Array.isArray(candidate.interviewRounds)) {
        candidate.interviewRounds = candidate.interviewRounds.map((round) => {
            const isAssigned = Array.isArray(round.assignedClientUsers) &&
                round.assignedClientUsers.some(id => String(id?._id || id) === String(clientUser?._id));

            return {
                _id: round._id,
                levelName: round.levelName,
                phase: round.phase,
                status: round.status,
                scheduledDate: round.scheduledDate,
                meetingLink: round.meetingLink || '',
                meetingProvider: round.meetingProvider || 'Manual',
                isClientInterview: Boolean(round.isClientInterview || isAssigned),
                isAssignedToMe: isAssigned,
                clientFeedback: round.clientFeedback,
                clientRating: round.clientRating,
                clientEvaluatedAt: round.clientEvaluatedAt,
                // General feedback from internal panel only if visible
                feedback: visibility.showInternalNotes ? round.feedback : undefined,
                rating: visibility.showInternalNotes ? round.rating : undefined,
                skillRatings: round.skillRatings || []
            };
        });
    }

    // 6. Omit internal-only administrative metadata
    const internalFields = [
        'uploadedBy',
        'profilePulledBy',
        'calledBy',
        'rate',
        'isDeleted',
        'deletedAt',
        'deletedBy',
        'transferredFrom',
        'isTransferredToOnboarding',
        'applicantId',
        'publicApplicationId'
    ];

    return omitFields(candidate, internalFields);
};

/**
 * Sanitizes requisition object for client portal display.
 */
const sanitizeRequisitionForClient = (hiringRequestDoc) => {
    if (!hiringRequestDoc) return null;

    const req = hiringRequestDoc.toObject ? hiringRequestDoc.toObject() : { ...hiringRequestDoc };

    const internalFields = [
        'approvalChain',
        'workflowId',
        'interviewWorkflowId',
        'assignedUsers',
        'analyticsViewers',
        'ownership',
        'isDeleted',
        'deletedAt',
        'deletedBy',
        'reopenedToId',
        'previousRequestId'
    ];

    const sanitized = omitFields(req, internalFields);

    // Preserve client interview panel while keeping internal panel redacted
    if (req.ownership?.clientInterviewPanel) {
        sanitized.clientInterviewPanel = req.ownership.clientInterviewPanel;
    }

    // Redact internal recruiters from recruitmentTeam
    if (sanitized.recruitmentTeam) {
        sanitized.recruitmentTeam = {
            hiringManager: sanitized.recruitmentTeam.hiringManager
        };
    }

    return sanitized;
};

module.exports = {
    isCandidateVisibleToClient,
    sanitizeCandidateForClient,
    sanitizeRequisitionForClient
};
