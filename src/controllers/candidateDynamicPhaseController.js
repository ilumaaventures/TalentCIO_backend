const mongoose = require('mongoose');
const Candidate = require('../models/Candidate');
const { HiringRequest } = require('../models/HiringRequest');
const ActivityLog = require('../models/ActivityLog');
const NotificationService = require('../services/notificationService');
const {
    buildInitialDynamicPhaseState,
    calculateDaysSpent,
    findPhaseById,
    findPhaseByOrder,
    getCurrentPhaseEntry,
    getDefaultStatusOption,
    getPhaseDecisionOption,
    getPhaseStatusOption,
    isDynamicHiringRequest
} = require('../utils/phaseTemplateUtils');
const { canAccessCandidate, TA_CAPABILITIES } = require('../utils/candidateAccess');

const isAdminUser = (req) => (
    (req.user?.roles || []).some((role) =>
        role?.isSystem ||
        ['Admin', 'Super Admin', 'System Admin'].includes(role?.name)
    ) || (req.user?.permissions || []).includes('*')
);

const buildActor = (req) => ({
    id: req.user?._id,
    name: [req.user?.firstName, req.user?.lastName].filter(Boolean).join(' ').trim(),
    email: req.user?.email || ''
});

const getInitialDynamicPhaseAssignees = (hiringRequest) => (
    Array.isArray(hiringRequest?.assignedUsers) && hiringRequest.assignedUsers.length > 0
        ? hiringRequest.assignedUsers
        : []
);

const createDynamicPhaseActivity = async (req, candidate, action, details = {}) => {
    await ActivityLog.create({
        action,
        entity: 'CandidateDynamicPhase',
        entityId: candidate._id,
        performedBy: buildActor(req),
        companyId: req.companyId,
        details: {
            candidateId: candidate._id,
            candidateName: candidate.candidateName,
            hiringRequestId: candidate.hiringRequestId,
            ...details
        }
    });
};

const notifyDynamicPhaseStakeholders = async (req, hiringRequest, title, message, metadata = {}) => {
    const recipientIds = new Set([
        hiringRequest?.createdBy,
        hiringRequest?.ownership?.hiringManager
    ].filter(Boolean).map((value) => String(value)));

    (hiringRequest?.assignedUsers || []).forEach((userId) => {
        const normalizedUserId = String(userId || '');
        if (normalizedUserId) {
            recipientIds.add(normalizedUserId);
        }
    });

    recipientIds.delete(String(req.user?._id || ''));

    if (!recipientIds.size) {
        return;
    }

    const io = req.app.get('io');
    await NotificationService.createManyNotifications(io, [...recipientIds].map((userId) => ({
        user: userId,
        companyId: req.companyId,
        title,
        message,
        type: 'Talent Acquisition',
        link: `/ta/view/${hiringRequest._id}?tab=applications`,
        metadata
    })));
};

const getCandidateContext = async (candidateId, companyId, user, capability = TA_CAPABILITIES.VIEW) => {
    const candidate = await Candidate.findOne({ _id: candidateId, companyId });
    if (!candidate) {
        const error = new Error('Candidate not found');
        error.statusCode = 404;
        throw error;
    }

    const hiringRequest = await HiringRequest.findOne({
        _id: candidate.hiringRequestId,
        companyId
    }).select('requestId roleDetails.title useDynamicPhases phases ownership createdBy assignedUsers');

    if (!hiringRequest) {
        const error = new Error('Hiring request not found');
        error.statusCode = 404;
        throw error;
    }

    if (!isDynamicHiringRequest(hiringRequest)) {
        const error = new Error('This hiring request does not use dynamic phases');
        error.statusCode = 400;
        throw error;
    }

    if (!(await canAccessCandidate(candidate, user, { companyId, hiringRequest, capability }))) {
        const error = new Error('Forbidden: You do not have permission to access this candidate');
        error.statusCode = 403;
        throw error;
    }

    if (!candidate.phaseHistory?.length) {
        const fallbackState = buildInitialDynamicPhaseState(
            hiringRequest,
            getInitialDynamicPhaseAssignees(hiringRequest)
        );

        if (fallbackState.phaseHistory?.length) {
            candidate.phaseHistory = fallbackState.phaseHistory;
            candidate.currentPhaseId = fallbackState.currentPhaseId;
            candidate.currentPhaseOrder = fallbackState.currentPhaseOrder;
            candidate.currentPhaseStatus = fallbackState.currentPhaseStatus;
            candidate.currentPhaseName = fallbackState.currentPhaseName;
            await candidate.save();
        }
    }

    return { candidate, hiringRequest };
};

const buildCandidateResponse = async (candidateId, companyId) => (
    Candidate.findOne({ _id: candidateId, companyId })
        .populate('uploadedBy', 'firstName lastName email')
        .populate('hiringRequestId', 'requestId roleDetails')
        .lean()
);

exports.updatePhaseStatus = async (req, res) => {
    try {
        const { candidateId } = req.params;
        const { phaseId, status, notes } = req.body;

        if (!mongoose.Types.ObjectId.isValid(candidateId) || !mongoose.Types.ObjectId.isValid(phaseId)) {
            return res.status(400).json({ message: 'Invalid candidate or phase ID format' });
        }

        if (!phaseId) {
            return res.status(400).json({ message: 'Phase ID is required' });
        }

        const { candidate, hiringRequest } = await getCandidateContext(candidateId, req.companyId, req.user, TA_CAPABILITIES.EDIT);
        const phase = findPhaseById(hiringRequest.phases, phaseId);
        if (!phase) {
            return res.status(404).json({ message: 'Phase not found for this hiring request' });
        }

        const normalizedStatus = typeof status === 'string' ? status : '';

        if (normalizedStatus && !getPhaseStatusOption(phase, normalizedStatus)) {
            return res.status(400).json({ message: 'Invalid status for the selected phase' });
        }

        const currentPhaseEntry = candidate.phaseHistory.find((entry) => String(entry.phaseId) === String(phaseId) && !entry.exitedAt);
        if (!currentPhaseEntry) {
            return res.status(400).json({ message: 'Candidate is not currently in the selected phase' });
        }

        currentPhaseEntry.status = normalizedStatus;
        if (notes !== undefined) {
            currentPhaseEntry.notes = String(notes || '');
        }

        candidate.currentPhaseStatus = normalizedStatus;
        await candidate.save();

        await createDynamicPhaseActivity(req, candidate, 'CANDIDATE_DYNAMIC_PHASE_STATUS_UPDATED', {
            phaseId,
            phaseName: currentPhaseEntry.phaseName,
            status: normalizedStatus,
            notes: notes || ''
        });

        const updatedCandidate = await buildCandidateResponse(candidate._id, req.companyId);

        res.status(200).json({
            message: 'Dynamic phase status updated successfully',
            candidate: updatedCandidate
        });
    } catch (error) {
        console.error('updatePhaseStatus error:', error);
        res.status(error.statusCode || 500).json({
            message: error.statusCode ? error.message : 'Failed to update dynamic phase status',
            error: error.message
        });
    }
};

exports.recordDecision = async (req, res) => {
    try {
        const { candidateId } = req.params;
        const { phaseId, decision, notes, autoAdvance } = req.body;

        if (!mongoose.Types.ObjectId.isValid(candidateId) || !mongoose.Types.ObjectId.isValid(phaseId)) {
            return res.status(400).json({ message: 'Invalid candidate or phase ID format' });
        }

        if (!phaseId || !decision) {
            return res.status(400).json({ message: 'Phase ID and decision are required' });
        }

        const { candidate, hiringRequest } = await getCandidateContext(candidateId, req.companyId, req.user, TA_CAPABILITIES.MAKE_DECISION);
        const phase = findPhaseById(hiringRequest.phases, phaseId);
        if (!phase) {
            return res.status(404).json({ message: 'Phase not found for this hiring request' });
        }

        const decisionOption = getPhaseDecisionOption(phase, decision);
        if (!decisionOption) {
            return res.status(400).json({ message: 'Invalid decision for the selected phase' });
        }

        const currentPhaseEntry = candidate.phaseHistory.find((entry) => String(entry.phaseId) === String(phaseId) && !entry.exitedAt);
        if (!currentPhaseEntry) {
            return res.status(400).json({ message: 'Candidate is not currently in the selected phase' });
        }

        currentPhaseEntry.decision = decision;
        if (notes !== undefined) {
            currentPhaseEntry.notes = String(notes || '');
        }

        let advanced = false;
        let newPhase = null;

        if (decisionOption.type === 'advance' && autoAdvance !== false && decisionOption.nextPhaseOrder !== undefined) {
            const targetPhase = findPhaseByOrder(hiringRequest.phases, decisionOption.nextPhaseOrder);

            if (!targetPhase) {
                return res.status(400).json({ message: 'The selected decision points to an unavailable next phase' });
            }

            currentPhaseEntry.exitedAt = new Date();

            const defaultStatus = getDefaultStatusOption(targetPhase);
            const nextPhaseEntry = {
                phaseId: targetPhase.phaseId || targetPhase._id,
                phaseName: targetPhase.name,
                phaseOrder: targetPhase.order,
                status: defaultStatus?.value || '',
                decision: 'None',
                enteredAt: new Date(),
                exitedAt: null,
                assignedTo: currentPhaseEntry.assignedTo || [],
                notes: '',
                metadata: {}
            };

            candidate.phaseHistory.push(nextPhaseEntry);
            candidate.currentPhaseId = nextPhaseEntry.phaseId;
            candidate.currentPhaseOrder = nextPhaseEntry.phaseOrder;
            candidate.currentPhaseStatus = nextPhaseEntry.status;
            candidate.currentPhaseName = nextPhaseEntry.phaseName;

            advanced = true;
            newPhase = {
                phaseId: nextPhaseEntry.phaseId,
                phaseName: nextPhaseEntry.phaseName,
                phaseOrder: nextPhaseEntry.phaseOrder,
                status: nextPhaseEntry.status
            };
        }

        await candidate.save();

        await createDynamicPhaseActivity(req, candidate, 'CANDIDATE_DYNAMIC_PHASE_DECISION_RECORDED', {
            phaseId,
            phaseName: currentPhaseEntry.phaseName,
            decision,
            notes: notes || '',
            advanced,
            newPhase
        });

        if (advanced && newPhase) {
            await createDynamicPhaseActivity(req, candidate, 'CANDIDATE_DYNAMIC_PHASE_ADVANCED', {
                fromPhase: currentPhaseEntry.phaseName,
                toPhase: newPhase.phaseName
            });

            await notifyDynamicPhaseStakeholders(
                req,
                hiringRequest,
                'Candidate Advanced',
                `${candidate.candidateName} moved to ${newPhase.phaseName} for ${hiringRequest.roleDetails?.title || 'this requisition'}.`,
                {
                    candidateId: candidate._id,
                    fromPhase: currentPhaseEntry.phaseName,
                    toPhase: newPhase.phaseName
                }
            );
        }

        const updatedCandidate = await buildCandidateResponse(candidate._id, req.companyId);

        res.status(200).json({
            success: true,
            candidate: updatedCandidate,
            advanced,
            newPhase
        });
    } catch (error) {
        console.error('recordDecision error:', error);
        res.status(error.statusCode || 500).json({
            message: error.statusCode ? error.message : 'Failed to record dynamic phase decision',
            error: error.message
        });
    }
};

exports.manualAdvance = async (req, res) => {
    try {
        if (!isAdminUser(req)) {
            return res.status(403).json({ message: 'Forbidden: Only admins can manually move candidates between phases' });
        }

        const { candidateId } = req.params;
        const { targetPhaseOrder, notes } = req.body;

        if (!mongoose.Types.ObjectId.isValid(candidateId)) {
            return res.status(400).json({ message: 'Invalid candidate ID format' });
        }

        if (!targetPhaseOrder) {
            return res.status(400).json({ message: 'Target phase order is required' });
        }

        const { candidate, hiringRequest } = await getCandidateContext(candidateId, req.companyId, req.user, TA_CAPABILITIES.EDIT);
        const currentPhaseEntry = getCurrentPhaseEntry(candidate);
        if (!currentPhaseEntry) {
            return res.status(400).json({ message: 'Candidate does not have an active phase entry' });
        }

        const targetPhase = findPhaseByOrder(hiringRequest.phases, targetPhaseOrder);
        if (!targetPhase) {
            return res.status(404).json({ message: 'Target phase not found' });
        }

        if (Number(currentPhaseEntry.phaseOrder) === Number(targetPhase.order)) {
            return res.status(400).json({ message: 'Candidate is already in the selected phase' });
        }

        currentPhaseEntry.exitedAt = new Date();
        if (notes !== undefined) {
            currentPhaseEntry.notes = String(notes || '');
        }

        const defaultStatus = getDefaultStatusOption(targetPhase);
        const nextPhaseEntry = {
            phaseId: targetPhase.phaseId || targetPhase._id,
            phaseName: targetPhase.name,
            phaseOrder: targetPhase.order,
            status: defaultStatus?.value || '',
            decision: 'None',
            enteredAt: new Date(),
            exitedAt: null,
            assignedTo: currentPhaseEntry.assignedTo || [],
            notes: '',
            metadata: { manualAdvance: true }
        };

        candidate.phaseHistory.push(nextPhaseEntry);
        candidate.currentPhaseId = nextPhaseEntry.phaseId;
        candidate.currentPhaseOrder = nextPhaseEntry.phaseOrder;
        candidate.currentPhaseStatus = nextPhaseEntry.status;
        candidate.currentPhaseName = nextPhaseEntry.phaseName;
        await candidate.save();

        await createDynamicPhaseActivity(req, candidate, 'CANDIDATE_DYNAMIC_PHASE_MANUAL_ADVANCE', {
            fromPhase: currentPhaseEntry.phaseName,
            toPhase: nextPhaseEntry.phaseName,
            notes: notes || ''
        });

        await notifyDynamicPhaseStakeholders(
            req,
            hiringRequest,
            'Candidate Phase Updated',
            `${candidate.candidateName} was moved manually to ${nextPhaseEntry.phaseName}.`,
            {
                candidateId: candidate._id,
                fromPhase: currentPhaseEntry.phaseName,
                toPhase: nextPhaseEntry.phaseName,
                manualAdvance: true
            }
        );

        const updatedCandidate = await buildCandidateResponse(candidate._id, req.companyId);

        res.status(200).json({
            message: 'Candidate moved to the selected phase successfully',
            candidate: updatedCandidate,
            newPhase: {
                phaseId: nextPhaseEntry.phaseId,
                phaseName: nextPhaseEntry.phaseName,
                phaseOrder: nextPhaseEntry.phaseOrder,
                status: nextPhaseEntry.status
            }
        });
    } catch (error) {
        console.error('manualAdvance error:', error);
        res.status(error.statusCode || 500).json({
            message: error.statusCode ? error.message : 'Failed to move candidate to the selected phase',
            error: error.message
        });
    }
};

exports.getPhaseHistory = async (req, res) => {
    try {
        const { candidateId } = req.params;
        if (!mongoose.Types.ObjectId.isValid(candidateId)) {
            return res.status(400).json({ message: 'Invalid candidate ID format' });
        }

        const { candidate } = await getCandidateContext(candidateId, req.companyId, req.user, TA_CAPABILITIES.VIEW);

        const phaseHistory = [...(candidate.phaseHistory || [])]
            .sort((left, right) => {
                if ((left.phaseOrder || 0) !== (right.phaseOrder || 0)) {
                    return (left.phaseOrder || 0) - (right.phaseOrder || 0);
                }

                return new Date(left.enteredAt || 0) - new Date(right.enteredAt || 0);
            })
            .map((entry) => ({
                ...entry.toObject(),
                daysSpent: calculateDaysSpent(entry.enteredAt, entry.exitedAt)
            }));

        res.status(200).json({
            success: true,
            phaseHistory
        });
    } catch (error) {
        console.error('getPhaseHistory error:', error);
        res.status(error.statusCode || 500).json({
            message: error.statusCode ? error.message : 'Failed to fetch phase history',
            error: error.message
        });
    }
};

exports.bulkUpdateStatus = async (req, res) => {
    try {
        const { candidateIds, phaseId, status } = req.body;

        if (!mongoose.Types.ObjectId.isValid(phaseId)) {
            return res.status(400).json({ message: 'Invalid phase ID format' });
        }

        if (!Array.isArray(candidateIds) || candidateIds.length === 0 || !phaseId || !status) {
            return res.status(400).json({ message: 'Candidate IDs, phase ID, and status are required' });
        }

        let success = 0;
        let failed = 0;

        for (const candidateId of candidateIds) {
            try {
                const { candidate, hiringRequest } = await getCandidateContext(candidateId, req.companyId, req.user, TA_CAPABILITIES.EDIT);
                const phase = findPhaseById(hiringRequest.phases, phaseId);
                if (!phase || !getPhaseStatusOption(phase, status)) {
                    failed += 1;
                    continue;
                }

                const currentPhaseEntry = candidate.phaseHistory.find((entry) => String(entry.phaseId) === String(phaseId) && !entry.exitedAt);
                if (!currentPhaseEntry) {
                    failed += 1;
                    continue;
                }

                currentPhaseEntry.status = status;
                candidate.currentPhaseStatus = status;
                await candidate.save();
                success += 1;
            } catch (error) {
                failed += 1;
            }
        }

        res.status(200).json({
            success,
            failed
        });
    } catch (error) {
        console.error('bulkUpdateStatus error:', error);
        res.status(500).json({ message: 'Failed to bulk update dynamic phase statuses', error: error.message });
    }
};
