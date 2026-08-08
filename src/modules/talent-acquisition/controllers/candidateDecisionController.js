const Candidate = require('../candidate.model');
const { HiringRequest } = require('../hiringRequest.model');
const OnboardingEmployee = require('../../onboarding/onboardingEmployee.model');
const mongoose = require('mongoose');
const NotificationService = require('../../../services/notificationService');
const { isDynamicHiringRequest } = require('../utils/phaseTemplateUtils');
const { TA_CAPABILITIES, canAccessHiringRequestForCapability } = require('../utils/candidateAccess');
const {
    ensureCandidateCapability,
    hasCandidateMovedToPhase2
} = require('../utils/candidateAccess');

const handleCandidateShortlist = async (candidate, req) => {
    const companyId = req.companyId;
    const userId = req.user._id;

    // 1. Auto Interested:
    if (candidate.status !== 'Interested') {
        candidate.status = 'Interested';
        candidate.statusHistory.push({
            status: 'Interested',
            changedBy: userId,
            changedAt: new Date(),
            remark: `Auto-updated to Interested on ${candidate.decision}`
        });
    }

    // 2. Schedule interview
    const phase1Rounds = (candidate.interviewRounds || []).filter(round => Number(round.phase || 1) === 1);
    
    if (phase1Rounds.length === 0) {
        // Find hiring request to see if it has an interview workflow
        const hiringRequest = await HiringRequest.findOne({ _id: candidate.hiringRequestId, companyId }).populate('interviewWorkflowId');
        
        let roundsToAdd = [];
        if (hiringRequest && hiringRequest.interviewWorkflowId && hiringRequest.interviewWorkflowId.rounds && hiringRequest.interviewWorkflowId.rounds.length > 0) {
            roundsToAdd = hiringRequest.interviewWorkflowId.rounds.map((r, index) => ({
                levelName: `Round ${index + 1}`,
                assignedTo: [], // Evaluator is always unassigned on shortlist; assigned manually later
                status: 'Scheduled',
                phase: 1
            }));
        } else {
            roundsToAdd = [{
                levelName: 'Round 1',
                assignedTo: [],
                status: 'Scheduled',
                phase: 1
            }];
        }
        
        if (!candidate.interviewRounds) {
            candidate.interviewRounds = [];
        }
        candidate.interviewRounds.push(...roundsToAdd);
        return { hasNewRounds: true, roundsToAdd };
    }
    return { hasNewRounds: false };
};

const sendAutoScheduleNotifications = async (candidate, roundsToAdd, req) => {
    const app = req.app;
    const io = app ? app.get('io') : null;
    if (!io) return;

    const origin = req.headers ? req.headers.origin : undefined;
    
    const notifications = [];
    candidate.interviewRounds.forEach(savedRound => {
        const matchedInput = roundsToAdd.find(r => r.levelName === savedRound.levelName && Number(savedRound.phase || 1) === 1);
        if (matchedInput && savedRound.assignedTo && savedRound.assignedTo.length > 0) {
            const roundPhase = Number(savedRound.phase || 1);
            savedRound.assignedTo.forEach(userId => {
                notifications.push({
                    user: userId,
                    companyId: req.companyId,
                    preferenceKey: 'interview_assigned',
                    title: 'New Interview Assigned',
                    message: `You have been assigned to evaluate ${candidate.candidateName} for the ${savedRound.levelName} round.`,
                    type: 'Interview',
                    link: `/ta/hiring-request/${candidate.hiringRequestId._id || candidate.hiringRequestId}/candidate/${candidate._id}/view?phase=${roundPhase}`,
                    origin: origin,
                    metadata: {
                        candidateId: candidate._id,
                        roundId: savedRound._id,
                        hiringRequestId: candidate.hiringRequestId._id || candidate.hiringRequestId,
                        phase: roundPhase
                    }
                });
            });
        }
    });

    if (notifications.length > 0) {
        await NotificationService.createManyNotifications(io, notifications);

        notifications.forEach(notif => {
            NotificationService.emitToUser(io, notif.user, 'interview_update', {
                candidateId: candidate._id,
                candidateName: candidate.candidateName,
                roundId: notif.metadata.roundId
            });
        });
    }
};

// Update candidate decision
const updateCandidateDecision = async (req, res) => {
    try {
        const { id } = req.params;
        const { decision, profileShared } = req.body;

        if (!decision) {
            return res.status(400).json({ message: 'Decision is required' });
        }

        const candidate = await Candidate.findOne({ _id: id, companyId: req.companyId });
        if (!candidate) {
            return res.status(404).json({ message: 'Candidate not found' });
        }

        const { hasAccess } = await ensureCandidateCapability(candidate, req.companyId, req.user, TA_CAPABILITIES.MAKE_DECISION);
        if (!hasAccess) {
            return res.status(403).json({ message: 'Forbidden: You do not have permission to update this candidate' });
        }

        if (hasCandidateMovedToPhase2(candidate)) {
            return res.status(400).json({ message: 'Phase 1 decision cannot be changed after the candidate has moved to Phase 2' });
        }

        candidate.decision = decision;
        if (['Shortlisted', 'Profile Shared'].includes(decision)) {
            candidate.profileShared = true;
        }
        if (profileShared !== undefined) {
            candidate.profileShared = Boolean(profileShared);
        }

        let shortlistResult = null;
        if (['Shortlisted', 'Rejected', 'Did Not Turn Up', 'Left in between'].includes(decision)) {
            shortlistResult = await handleCandidateShortlist(candidate, req);
        }

        await candidate.save();

        if (shortlistResult && shortlistResult.hasNewRounds) {
            await sendAutoScheduleNotifications(candidate, shortlistResult.roundsToAdd, req);
        }

        const updatedCandidate = await Candidate.findOne({ _id: id, companyId: req.companyId })
            .populate('uploadedBy', 'firstName lastName email')
            .populate('hiringRequestId', 'requestId roleDetails');

        res.status(200).json({
            message: 'Decision updated successfully',
            candidate: updatedCandidate
        });

    } catch (error) {
        console.error('Error updating decision:', error);
        res.status(500).json({ message: 'Server error', error: error.message });
    }
};

// Bulk update candidate decision
const bulkUpdateDecision = async (req, res) => {
    try {
        const { candidateIds, decision, phaseId, phase } = req.body;

        if (!decision) {
            return res.status(400).json({ message: 'Decision is required' });
        }

        if (!Array.isArray(candidateIds) || candidateIds.length === 0) {
            return res.status(400).json({ message: 'At least one candidate must be selected' });
        }

        const validCandidateIds = candidateIds.filter((id) => mongoose.Types.ObjectId.isValid(id));
        if (validCandidateIds.length === 0) {
            return res.status(400).json({ message: 'No valid candidate IDs provided' });
        }

        const candidates = await Candidate.find({
            _id: { $in: validCandidateIds },
            companyId: req.companyId
        });

        let updatedCount = 0;
        for (const candidate of candidates) {
            try {
                const { hasAccess } = await ensureCandidateCapability(candidate, req.companyId, req.user, TA_CAPABILITIES.MAKE_DECISION);
                if (!hasAccess) continue;

                if (phaseId && candidate.currentPhaseId && String(candidate.currentPhaseId) === String(phaseId)) {
                    const targetPhaseIdStr = String(phaseId);
                    let phaseEntryIndex = (candidate.phaseHistory || []).findIndex(
                        entry => entry.phaseId && String(entry.phaseId) === targetPhaseIdStr
                    );

                    if (phaseEntryIndex >= 0) {
                        candidate.phaseHistory[phaseEntryIndex].decision = decision;
                        candidate.phaseHistory[phaseEntryIndex].updatedAt = new Date();
                    } else {
                        candidate.phaseHistory.push({
                            phaseId,
                            phaseName: 'Dynamic Phase',
                            phaseOrder: candidate.currentPhaseOrder || 1,
                            status: '',
                            decision,
                            enteredAt: new Date()
                        });
                    }

                    if (['Shortlisted', 'Selected', 'Rejected', 'On Hold', 'Did Not Turn Up', 'Left in between'].includes(decision)) {
                        candidate.decision = decision;
                    }
                    await candidate.save();
                    updatedCount++;
                } else if (Number(phase) === 2) {
                    candidate.phase2Decision = decision;
                    if (decision === 'Selected') {
                        candidate.profileShared = true;
                        candidate.phase2InterviewStatus = 'Shortlisted';
                    } else if (decision === 'Shortlisted') {
                        candidate.profileShared = true;
                        candidate.phase2InterviewStatus = 'None';
                    } else if (decision === 'Rejected') {
                        candidate.phase2InterviewStatus = 'Rejected';
                    }
                    await candidate.save();
                    updatedCount++;
                } else if (Number(phase) === 3) {
                    candidate.phase3Decision = decision;
                    await candidate.save();
                    updatedCount++;
                } else {
                    candidate.decision = decision;
                    if (['Shortlisted', 'Rejected', 'Did Not Turn Up', 'Left in between'].includes(decision)) {
                        await handleCandidateShortlist(candidate, req);
                    }
                    await candidate.save();
                    updatedCount++;
                }
            } catch (err) {
                console.error(`Error updating decision for candidate ${candidate._id}:`, err);
            }
        }

        res.status(200).json({
            message: `Updated decision to "${decision}" for ${updatedCount} candidate(s)`,
            updatedCount
        });
    } catch (error) {
        console.error('Error in bulk decision update:', error);
        res.status(500).json({ message: 'Server error during bulk decision update', error: error.message });
    }
};

// Update candidate Phase 2 decision
const updatePhase2Decision = async (req, res) => {
    try {
        const { id } = req.params;
        const { phase2Decision } = req.body;

        if (!phase2Decision) {
            return res.status(400).json({ message: 'Phase 2 Decision is required' });
        }

        const candidate = await Candidate.findOne({ _id: id, companyId: req.companyId });
        if (!candidate) {
            return res.status(404).json({ message: 'Candidate not found' });
        }

        const { hasAccess } = await ensureCandidateCapability(candidate, req.companyId, req.user, TA_CAPABILITIES.MAKE_DECISION);
        if (!hasAccess) {
            return res.status(403).json({ message: 'Forbidden: You do not have permission to update this candidate' });
        }

        candidate.phase2Decision = phase2Decision;
        if (phase2Decision === 'Selected') {
            candidate.profileShared = true;
            candidate.phase2InterviewStatus = 'Shortlisted';
        } else if (phase2Decision === 'Shortlisted') {
            candidate.profileShared = true;
            candidate.phase2InterviewStatus = 'None';
        } else if (phase2Decision === 'Rejected') {
            candidate.phase2InterviewStatus = 'Rejected';
        } else if (!phase2Decision || phase2Decision === 'None') {
            candidate.phase2InterviewStatus = 'None';
        }
        await candidate.save();

        const updatedCandidate = await Candidate.findOne({ _id: id, companyId: req.companyId })
            .populate('uploadedBy', 'firstName lastName email')
            .populate('hiringRequestId', 'requestId roleDetails');

        res.status(200).json({
            message: 'Phase 2 Decision updated successfully',
            candidate: updatedCandidate
        });

    } catch (error) {
        console.error('Error updating Phase 2 decision:', error);
        res.status(500).json({ message: 'Server error', error: error.message });
    }
};

// Move candidate back from Phase 2 to Phase 1
const moveCandidateToPreviousPhase = async (req, res) => {
    try {
        const { id } = req.params;

        const candidate = await Candidate.findOne({ _id: id, companyId: req.companyId });
        if (!candidate) {
            return res.status(404).json({ message: 'Candidate not found' });
        }

        const { hasAccess } = await ensureCandidateCapability(candidate, req.companyId, req.user, TA_CAPABILITIES.SCHEDULE_INTERVIEW);
        if (!hasAccess) {
            return res.status(403).json({ message: 'Forbidden: You do not have permission to update this candidate' });
        }

        const hiringRequest = await HiringRequest.findOne({ _id: candidate.hiringRequestId, companyId: req.companyId });
        if (!hiringRequest) {
            return res.status(404).json({ message: 'Hiring request not found' });
        }

        if (isDynamicHiringRequest(hiringRequest)) {
            return res.status(400).json({ message: 'Move back to previous phase is only available for the legacy phase flow' });
        }

        if (!hasCandidateMovedToPhase2(candidate)) {
            return res.status(400).json({ message: 'Candidate is not currently in Phase 2' });
        }

        if (candidate.phase3Decision && candidate.phase3Decision !== 'None') {
            return res.status(400).json({ message: 'Candidate cannot be moved back after progressing to Phase 3' });
        }

        if (candidate.isTransferredToOnboarding) {
            return res.status(400).json({ message: 'Candidate cannot be moved back after being transferred to onboarding' });
        }

        candidate.profileShared = false;
        candidate.phase2Decision = 'None';
        candidate.phase2InterviewerFeedback = '';
        candidate.phase2InterviewStatus = 'None';
        candidate.interviewRounds = (candidate.interviewRounds || []).filter((round) => Number(round?.phase || 1) !== 2);

        await candidate.save();

        const updatedCandidate = await Candidate.findOne({ _id: id, companyId: req.companyId })
            .populate('uploadedBy', 'firstName lastName email')
            .populate('hiringRequestId', 'requestId roleDetails')
            .populate('interviewRounds.assignedTo', 'firstName lastName email')
            .populate('interviewRounds.evaluatedBy', 'firstName lastName');

        res.status(200).json({
            message: 'Candidate moved back to Phase 1 successfully',
            candidate: updatedCandidate
        });
    } catch (error) {
        console.error('Error moving candidate back to previous phase:', error);
        res.status(500).json({ message: 'Server error', error: error.message });
    }
};

// Update candidate Phase 3 decision (Offer & Onboarding)
const updatePhase3Decision = async (req, res) => {
    try {
        const { id } = req.params;
        const { phase3Decision } = req.body;

        if (!phase3Decision) {
            return res.status(400).json({ message: 'Phase 3 Decision is required' });
        }

        const candidate = await Candidate.findOne({ _id: id, companyId: req.companyId });
        if (!candidate) {
            return res.status(404).json({ message: 'Candidate not found' });
        }

        const { hasAccess: hasDecisionAccess } = await ensureCandidateCapability(
            candidate,
            req.companyId,
            req.user,
            TA_CAPABILITIES.MAKE_DECISION
        );

        if (!hasDecisionAccess) {
            return res.status(403).json({
                message: 'Forbidden: You do not have permission to update this candidate'
            });
        }

        candidate.phase3Decision = phase3Decision;
        await candidate.save();

        const updatedCandidate = await Candidate.findOne({ _id: id, companyId: req.companyId })
            .populate('uploadedBy', 'firstName lastName email')
            .populate('hiringRequestId', 'requestId roleDetails');

        res.status(200).json({
            message: 'Phase 3 Decision updated successfully',
            candidate: updatedCandidate
        });

    } catch (error) {
        console.error('Error updating Phase 3 decision:', error);
        res.status(500).json({ message: 'Server error', error: error.message });
    }
};

// Transfer candidate to Onboarding
const transferToOnboarding = async (req, res) => {
    try {
        const { id } = req.params;

        const candidate = await Candidate.findOne({ _id: id, companyId: req.companyId })
            .populate('hiringRequestId');

        if (!candidate) {
            return res.status(404).json({ message: 'Candidate not found' });
        }

        const { hasAccess } = await ensureCandidateCapability(candidate, req.companyId, req.user, TA_CAPABILITIES.TRANSFER);
        if (!hasAccess) {
            return res.status(403).json({ message: 'Forbidden: You do not have permission to update this candidate' });
        }

        // Validation: Ensure a valid decision is set (Phase 3 decision or Phase 2 Selected)
        const hasPhase3Decision = candidate.phase3Decision && candidate.phase3Decision !== 'None';
        const hasPhase2Selected = candidate.phase2Decision === 'Selected';

        if (!hasPhase3Decision && !hasPhase2Selected) {
            return res.status(400).json({ message: 'A valid decision (Selected in Phase 2 or any Phase 3 decision) must be set before transferring to onboarding' });
        }

        if (candidate.isTransferredToOnboarding) {
            return res.status(400).json({ message: 'Candidate is already transferred to onboarding' });
        }

        // Check if employee with same email already exists in onboarding
        const existingOnboarding = await OnboardingEmployee.findOne({ email: candidate.email, companyId: req.companyId });
        if (existingOnboarding) {
            candidate.isTransferredToOnboarding = true; // Mark as transferred since they exist
            await candidate.save();
            return res.status(400).json({ message: 'An onboarding record with this email already exists' });
        }

        // Split name into first and last
        const nameParts = candidate.candidateName.trim().split(/\s+/);
        const firstName = nameParts[0];
        const lastName = nameParts.length > 1 ? nameParts.slice(1).join(' ') : '';

        // Generate credentials
        const tempEmployeeId = await OnboardingEmployee.generateTempId(req.companyId);
        const tempPassword = Math.random().toString(36).slice(-8); // Random 8 char password

        // Default document slots
        const defaultDocuments = [
            { type: 'resume', label: 'Updated Resume' },
            { type: 'aadhaar_front', label: 'Aadhaar Card (Front)' },
            { type: 'aadhaar_back', label: 'Aadhaar Card (Back)' },
            { type: 'pan', label: 'PAN Card' },
            { type: 'salary_slip', label: 'Salary Slip' },
            { type: 'passport', label: 'Passport (Optional)' },
            { type: '10th_marksheet', label: '10th Marksheet / Certificate' },
            { type: '12th_marksheet', label: '12th Marksheet / Certificate' },
            { type: 'graduation', label: 'Graduation Marksheet / Certificate' },
            { type: 'relieving_letter', label: 'Previous Employer Relieving Letter' },
            { type: 'experience_certificate', label: 'Experience Certificate' },
            { type: 'passport_photo', label: 'Recent Passport-Size Photograph' },
            { type: 'live_photo', label: 'Live Photograph', requireLivePhoto: true },
            { type: 'character_certificate', label: 'Character Certificate' }
        ];

        console.log('📄 Initializing onboarding documents:', defaultDocuments.length);

        // Create onboarding employee
        const onboardingEmployee = new OnboardingEmployee({
            companyId: req.companyId,
            createdBy: req.user._id,
            sourcedFromTA: true,
            candidateId: candidate._id,
            tempEmployeeId,
            tempPassword, // hashed in pre-save
            firstName,
            lastName,
            email: candidate.email,
            phone: candidate.mobile,
            designation: candidate.hiringRequestId?.roleDetails?.title || '',
            joiningDate: candidate.lastWorkingDay || null,
            workLocation: candidate.preferredLocation || candidate.currentLocation || '',
            salary: {
                annualCTC: candidate.currentCTC?.toString() || ''
            },
            personalDetails: {
                fullName: candidate.candidateName,
                personalEmail: candidate.email,
                personalMobile: candidate.mobile,
                currentAddress: {
                    line1: candidate.currentLocation || '',
                    city: candidate.currentLocation || ''
                }
            },
            status: 'Pending',
            documents: defaultDocuments,
            requestedSections: [],
            requestedDocuments: []
        });

        console.log('💾 Saving onboarding employee with documents:', onboardingEmployee.documents.length);
        await onboardingEmployee.save();
        console.log('✅ Onboarding employee saved successfully:', onboardingEmployee._id);

        // Mark candidate as transferred
        candidate.isTransferredToOnboarding = true;
        await candidate.save();

        // Add audit log to onboarding employee
        try {
            await OnboardingEmployee.findByIdAndUpdate(onboardingEmployee._id, {
                $push: {
                    auditLog: {
                        action: 'TRANSFERRED_FROM_TA',
                        details: 'Candidate successfully transferred from Talent Acquisition'
                    }
                }
            });
        } catch (logError) {
            console.error('Failed to log transfer audit:', logError);
        }

        res.status(200).json({
            message: 'Candidate successfully transferred to onboarding',
            onboardingEmployeeId: onboardingEmployee._id
        });

    } catch (error) {
        console.error('Error transferring to onboarding:', error);
        res.status(500).json({ message: 'Server error during transfer', error: error.message });
    }
};

module.exports = {
    handleCandidateShortlist,
    sendAutoScheduleNotifications,
    updateCandidateDecision,
    bulkUpdateDecision,
    updatePhase2Decision,
    moveCandidateToPreviousPhase,
    updatePhase3Decision,
    transferToOnboarding
};
