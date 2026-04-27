const { HiringRequest, HRRAuditLog } = require('../models/HiringRequest');
const ApprovalWorkflow = require('../models/ApprovalWorkflow');
const User = require('../models/User');
const Candidate = require('../models/Candidate');
const Company = require('../models/Company');
const mongoose = require('mongoose');
const NotificationService = require('../services/notificationService');


// Helper to generate Request ID (e.g., HRR-2023-001)
const generateRequestId = async (companyId) => {
    const count = await HiringRequest.countDocuments({ companyId });
    const year = new Date().getFullYear();
    return `HRR-${year}-${String(count + 1).padStart(3, '0')}`;
};

const setNoCache = (res) => {
    res.set('Cache-Control', 'no-cache');
    res.set('Pragma', 'no-cache');
    res.set('Expires', '0');
};

const buildHiringRequestDetailsQuery = (companyId, requestId) => (
    HiringRequest.findOne({ _id: requestId, companyId })
        .populate('ownership.hiringManager', 'firstName lastName email')
        .populate('ownership.recruiter', 'firstName lastName email')
        .populate('roleDetails.reportingManager', 'firstName lastName')
        .populate('createdBy', 'firstName lastName')
        .populate('workflowId', 'name description')
        .populate({
            path: 'approvalChain.role',
            select: 'name'
        })
        .populate({
            path: 'approvalChain.approvers',
            select: 'firstName lastName email'
        })
        .populate({
            path: 'approvalChain.approvedBy',
            select: 'firstName lastName email'
        })
        .populate('approvals.l1.approver', 'firstName lastName')
        .populate('approvals.final.approver', 'firstName lastName')
        .populate('interviewWorkflowId', 'name description rounds')
);

// --- createHiringRequest ---
exports.createHiringRequest = async (req, res) => {
    try {
        const { client, clientConfidential, roleDetails, purpose, requirements, hiringDetails, ownership, replacementDetails, interviewWorkflowId, previousRequestId, jobDescription, jobDescriptionFile } = req.body;
        const submitNow = req.query.submit === 'true';

        // validations...

        const requestId = await generateRequestId(req.companyId);

        let workflow;
        if (req.body.workflowId) {
            workflow = await ApprovalWorkflow.findOne({ _id: req.body.workflowId, companyId: req.companyId }).populate('levels.role', 'name');
        }

        if (!workflow) {
            workflow = await ApprovalWorkflow.findOne({ isActive: true, companyId: req.companyId })
                .populate('levels.role', 'name');
        }

        const approvals = workflow ? workflow.levels.map(l => ({
            level: l.levelCheck,
            role: l.role._id,
            roleName: l.role.name,
            status: 'Pending',
            approvers: l.approvers || []
        })).sort((a, b) => a.level - b.level) : [];

        const newRequest = new HiringRequest({
            requestId,
            client,
            clientConfidential: Boolean(clientConfidential),
            roleDetails,
            purpose,
            requirements,
            hiringDetails,
            replacementDetails,
            ownership: {
                ...ownership,
                hiringManager: req.user._id // Assumption: The logged in user is the HM or creating on behalf.
            },
            approvalChain: approvals,
            workflowId: workflow?._id, // Save the workflow ID
            interviewWorkflowId: interviewWorkflowId || undefined,
            currentApprovalLevel: approvals.length > 0 ? 1 : 0,
            status: submitNow ? 'Submitted' : 'Draft',
            createdBy: req.user._id,
            companyId: req.companyId,
            previousRequestId: previousRequestId || undefined,
            jobDescription,
            jobDescriptionFile
        });

        if (submitNow) {
            // Set status based on workflow type
            if (approvals.length > 0) {
                newRequest.status = 'Pending_Approval'; // Dynamic workflow

                // Notify first level approvers
                const currentStep = approvals[0];
                if (currentStep && currentStep.approvers && currentStep.approvers.length > 0) {
                    const io = req.app.get('io');
                    const notifications = currentStep.approvers.map(approverId => ({
                        user: approverId,
                        companyId: req.companyId,
                        title: 'New Hiring Request Approval',
                        message: `Hiring Request ${requestId} for ${roleDetails.title} has been submitted and requires your approval.`,
                        type: 'Approval',
                        link: `/ta/view/${newRequest._id}`
                    }));
                    await NotificationService.createManyNotifications(io, notifications);
                }
            } else {
                newRequest.status = 'Pending_L1'; // Legacy workflow
            }
        }

        await newRequest.save();

        await HRRAuditLog.create({
            hiringRequestId: newRequest._id,
            action: submitNow ? 'CREATED_AND_SUBMITTED' : 'CREATED_DRAFT',
            performedBy: req.user._id,
            details: { status: newRequest.status, workflowId: workflow?._id, previousRequestId }
        });

        // Update the previous request to point to this new one
        if (previousRequestId) {
            await HiringRequest.findByIdAndUpdate(previousRequestId, {
                reopenedToId: newRequest._id
            });
        }

        res.status(201).json(newRequest);
    } catch (error) {
        console.error(error);
        res.status(500).json({ message: 'Server Error', error: error.message });
    }
};

// --- getHiringRequests ---
exports.getHiringRequests = async (req, res) => {
    try {
        setNoCache(res);
        const { status, page = 1, limit = 10, client } = req.query;
        let query = { companyId: req.companyId };

        if (status) query.status = status;
        if (client) query.client = client;

        // Use permissions to filter what they see
        // Admin/HR sees all. ta.view sees all. Manager sees own.
        const isAdmin = req.user.roles.some(r => r.name === 'Admin' || r.name === 'HR' || r.name === 'Super Admin');
        const userPermissions = req.user.roles.flatMap(role => (role.permissions || []).map(p => p.key));
        const hasTaView = userPermissions.includes('ta.view') || userPermissions.includes('*');

        if (!isAdmin && !hasTaView) {
            // Find HRRs where the user is assigned to a candidate's interview round (granular)
            const candidatesWithUserAsInterviewer = await Candidate.find({
                'interviewRounds.assignedTo': req.user._id
            }).select('hiringRequestId').lean();

            const interviewHiringRequestIds = candidatesWithUserAsInterviewer.map(c => c.hiringRequestId);

            query['$or'] = [
                { createdBy: req.user._id },
                { 'ownership.hiringManager': req.user._id },
                { 'ownership.recruiter': req.user._id },
                { _id: { $in: interviewHiringRequestIds } } // Only HRRs where they have a specific candidate interview assignment
            ];
        }

        const pageNumber = parseInt(page);
        const limitNumber = parseInt(limit);
        const skip = (pageNumber - 1) * limitNumber;

        const totalRequests = await HiringRequest.countDocuments(query);
        const totalPages = Math.ceil(totalRequests / limitNumber);

        const requests = await HiringRequest.find(query)
            .populate('ownership.hiringManager', 'firstName lastName')
            .populate('ownership.recruiter', 'firstName lastName')
            .sort({ createdAt: -1 })
            .skip(skip)
            .limit(limitNumber)
            .lean();

        res.status(200).json({
            requests,
            totalPages,
            currentPage: pageNumber,
            totalRequests
        });
    } catch (error) {
        console.error(error);
        res.status(500).json({ message: 'Server Error' });
    }
};

// --- getHiringRequestById ---
exports.getHiringRequestById = async (req, res) => {
    try {
        setNoCache(res);
        if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
            return res.status(400).json({ message: 'Invalid Hiring Request ID format' });
        }
        const request = await buildHiringRequestDetailsQuery(req.companyId, req.params.id).lean();

        if (!request) return res.status(404).json({ message: 'Not found' });

        // Authorization check
        const isAdmin = req.user.roles.some(r => r.name === 'Admin' || r.name === 'HR' || r.name === 'Super Admin');
        const userPermissions = req.user.roles.flatMap(role => (role.permissions || []).map(p => p.key));
        const hasTaView = userPermissions.includes('ta.view') || userPermissions.includes('*');

        if (!isAdmin && !hasTaView) {
            const isCreator = request.createdBy?._id?.toString() === req.user._id.toString();
            const isHiringManager = request.ownership?.hiringManager?._id?.toString() === req.user._id.toString();
            const isRecruiter = request.ownership?.recruiter?._id?.toString() === req.user._id.toString();

            // Check if user is an assigned interviewer for any candidate in this request (granular check)
            const isInterviewer = await Candidate.exists({
                hiringRequestId: request._id,
                'interviewRounds.assignedTo': req.user._id
            });

            if (!isCreator && !isHiringManager && !isRecruiter && !isInterviewer) {
                return res.status(403).json({ message: 'Forbidden: You do not have permission to view this request' });
            }
        }

        res.status(200).json(request);
    } catch (error) {
        console.error('Error fetching hiring request:', error);
        res.status(500).json({ message: 'Server Error', error: error.message });
    }
};

// --- updateHiringRequest (Edit Draft) ---
exports.updateHiringRequest = async (req, res) => {
    try {
        const { id } = req.params;
        const updates = req.body;

        const request = await HiringRequest.findOne({ _id: id, companyId: req.companyId });
        if (!request) return res.status(404).json({ message: 'Not found' });

        if (request.status === 'Closed') {
            return res.status(400).json({ message: 'Cannot edit a closed request' });
        }

        // Apply updates to request securely (prevent mass assignment)
        const allowedUpdates = [
            'client', 'clientConfidential', 'roleDetails', 'purpose', 'requirements',
            'hiringDetails', 'replacementDetails', 'ownership', 'interviewWorkflowId',
            'jobDescription', 'jobDescriptionFile'
        ];

        allowedUpdates.forEach(field => {
            if (updates[field] !== undefined) {
                request[field] = updates[field];
            }
        });

        // Handle workflow changes or initialization
        let workflowChanged = false;
        if (req.body.workflowId && req.body.workflowId !== request.workflowId?.toString()) {
            workflowChanged = true;
        }

        // If workflow is specified (either new or existing), rebuild approval chain
        const workflowId = req.body.workflowId || request.workflowId;
        if (workflowId) {
            const workflow = await ApprovalWorkflow.findOne({ _id: workflowId, companyId: req.companyId }).populate('levels.role', 'name');

            if (workflow) {
                request.workflowId = workflow._id;
                request.approvalChain = workflow.levels.map(l => ({
                    level: l.levelCheck,
                    role: l.role._id,
                    roleName: l.role.name,
                    status: 'Pending',
                    approvers: l.approvers || []
                })).sort((a, b) => a.level - b.level);
                request.currentApprovalLevel = 1;
            }
        }

        // If submitting (not just saving as draft)
        if (req.query.submit === 'true') {
            // ALWAYS reset approval chain when re-submitting
            if (request.approvalChain && request.approvalChain.length > 0) {
                // Reset all approval steps to Pending
                request.approvalChain.forEach(step => {
                    step.status = 'Pending';
                    step.approvedBy = undefined;
                    step.date = undefined;
                    step.comments = undefined;
                });
                request.currentApprovalLevel = 1;
                request.status = 'Pending_Approval';
            } else {
                // Legacy mode or no workflow
                request.status = 'Pending_L1';
            }

            // Reset legacy approvals if they exist
            if (request.approvals) {
                if (request.approvals.l1) {
                    request.approvals.l1.status = 'Pending';
                    request.approvals.l1.approver = undefined;
                    request.approvals.l1.date = undefined;
                    request.approvals.l1.comments = undefined;
                }
                if (request.approvals.final) {
                    request.approvals.final.status = 'Pending';
                    request.approvals.final.approver = undefined;
                    request.approvals.final.date = undefined;
                    request.approvals.final.comments = undefined;
                }
            }
        }

        await request.save();

        await HRRAuditLog.create({
            hiringRequestId: request._id,
            action: req.query.submit === 'true' ? 'UPDATED_AND_SUBMITTED' : 'UPDATED',
            performedBy: req.user._id,
            details: { updates, workflowId: request.workflowId, workflowChanged }
        });

        const updatedRequest = await buildHiringRequestDetailsQuery(req.companyId, request._id).lean();

        res.status(200).json(updatedRequest || request);
    } catch (error) {
        console.error('Error updating hiring request:', error);
        res.status(500).json({ message: 'Server Error', error: error.message });
    }
};

// --- approveHiringRequest ---
exports.approveHiringRequest = async (req, res) => {
    try {
        const { id } = req.params;
        const { level, comments } = req.body; // 'L1' or 'Final' for old flow

        // Fetch request with populated approvers for authorization check
        const request = await HiringRequest.findOne({ _id: id, companyId: req.companyId })
            .populate('approvalChain.approvers', '_id firstName lastName email');

        if (!request) return res.status(404).json({ message: 'Not found' });

        let currentLevelIndex; // Declare at function scope for audit log

        // --- Dynamic Workflow Logic ---
        if (request.approvalChain && request.approvalChain.length > 0) {
            currentLevelIndex = request.currentApprovalLevel - 1;
            const currentStep = request.approvalChain[currentLevelIndex];

            if (!currentStep) {
                return res.status(400).json({
                    message: 'Current approval level not found',
                    currentLevel: request.currentApprovalLevel,
                    totalLevels: request.approvalChain.length
                });
            }

            if (currentStep.status !== 'Pending') {
                return res.status(400).json({
                    message: `Current level is already ${currentStep.status}`,
                    currentLevel: request.currentApprovalLevel,
                    levelStatus: currentStep.status
                });
            }

            // Check if user is an authorized approver for this step
            const isAuthorized = currentStep.approvers && currentStep.approvers.some(approver => {
                const approverId = approver._id ? approver._id.toString() : approver.toString();
                return approverId === req.user._id.toString();
            });

            const userPermissions = req.user.roles.flatMap(role => (role.permissions || []).map(p => p.key));
            const hasSuperApprove = userPermissions.includes('ta.super_approve') || userPermissions.includes('*');

            if (!isAuthorized && !hasSuperApprove) {
                return res.status(403).json({
                    message: 'You are not authorized to approve this level',
                    currentLevel: request.currentApprovalLevel,
                    yourId: req.user._id,
                    authorizedApprovers: currentStep.approvers.map(a => a._id || a)
                });
            }

            // Update current step
            currentStep.status = 'Approved';
            currentStep.approvedBy = req.user._id;
            currentStep.date = new Date();
            currentStep.comments = comments;

            // Check if there is a next level
            if (currentLevelIndex + 1 < request.approvalChain.length) {
                request.currentApprovalLevel += 1;
                request.status = 'Pending_Approval';

                // Notify next level approvers
                const nextStep = request.approvalChain[request.currentApprovalLevel - 1];
                if (nextStep && nextStep.approvers && nextStep.approvers.length > 0) {
                    const io = req.app.get('io');
                    const notifications = nextStep.approvers.map(approverId => ({
                        user: approverId,
                        companyId: req.companyId,
                        title: 'Hiring Request Approval Pending',
                        message: `Hiring Request ${request.requestId} for ${request.roleDetails.title} has reached your approval level.`,
                        type: 'Approval',
                        link: `/ta/view/${request._id}`
                    }));
                    await NotificationService.createManyNotifications(io, notifications);
                }
            } else {
                // All levels approved
                request.status = 'Approved';

                // Notify creator that it is fully approved
                if (request.createdBy) {
                    const io = req.app.get('io');
                    await NotificationService.createNotification(io, {
                        user: request.createdBy,
                        companyId: req.companyId,
                        title: 'Hiring Request Approved',
                        message: `Your Hiring Request ${request.requestId} for ${request.roleDetails.title} has been fully approved.`,
                        type: 'Info',
                        link: `/ta/view/${request._id}`
                    });
                }
            }
        }
        // --- Legacy Logic (L1/Final) ---
        else {
            if (level === 'L1') {
                if (request.status !== 'Pending_L1') {
                    return res.status(400).json({ message: 'Invalid status for L1 Approval' });
                }
                request.approvals.l1 = { status: 'Approved', approver: req.user._id, date: new Date(), comments };
                request.status = 'Pending_Final';
            } else if (level === 'Final') {
                if (request.status !== 'Pending_Final') {
                    return res.status(400).json({ message: 'Invalid status for Final Approval' });
                }
                request.approvals.final = { status: 'Approved', approver: req.user._id, date: new Date(), comments };
                request.status = 'Approved';

                // Notify creator
                if (request.createdBy) {
                    const io = req.app.get('io');
                    await NotificationService.createNotification(io, {
                        user: request.createdBy,
                        companyId: req.companyId,
                        title: 'Hiring Request Approved',
                        message: `Your Hiring Request ${request.requestId} has been fully approved.`,
                        type: 'Info',
                        link: `/ta/view/${request._id}`
                    });
                }
            } else {
                return res.status(400).json({ message: 'Invalid approval level' });
            }
        }

        await request.save();

        await HRRAuditLog.create({
            hiringRequestId: request._id,
            action: `APPROVED_LEVEL_${request.currentApprovalLevel || level}`,
            performedBy: req.user._id,
            details: { comments, previousLevel: currentLevelIndex !== undefined ? currentLevelIndex + 1 : level }
        });

        const updatedRequest = await buildHiringRequestDetailsQuery(req.companyId, request._id).lean();

        res.status(200).json(updatedRequest || request);

    } catch (error) {
        console.error('Error approving hiring request:', error);
        res.status(500).json({ message: 'Server Error', error: error.message });
    }
};

// --- rejectHiringRequest ---
exports.rejectHiringRequest = async (req, res) => {
    try {
        const { id } = req.params;
        const { comments, level } = req.body;

        // Fetch request with populated approvers for authorization check
        const request = await HiringRequest.findOne({ _id: id, companyId: req.companyId })
            .populate('approvalChain.approvers', '_id firstName lastName email');

        if (!request) return res.status(404).json({ message: 'Not found' });

        request.status = 'Rejected';

        // --- Dynamic Workflow Logic ---
        if (request.approvalChain && request.approvalChain.length > 0) {
            const currentLevelIndex = request.currentApprovalLevel - 1;
            const currentStep = request.approvalChain[currentLevelIndex];

            if (currentStep) {
                // Check authorization
                const isAuthorized = currentStep.approvers && currentStep.approvers.some(approver => {
                    const approverId = approver._id ? approver._id.toString() : approver.toString();
                    return approverId === req.user._id.toString();
                });

                const userPermissions = req.user.roles.flatMap(role => (role.permissions || []).map(p => p.key));
                const hasSuperApprove = userPermissions.includes('ta.super_approve') || userPermissions.includes('*');

                if (!isAuthorized && !hasSuperApprove) {
                    return res.status(403).json({
                        message: 'You are not authorized to reject this level',
                        currentLevel: request.currentApprovalLevel,
                        yourId: req.user._id
                    });
                }

                currentStep.status = 'Rejected';
                currentStep.approvedBy = req.user._id;
                currentStep.date = new Date();
                currentStep.comments = comments;
            }
        }
        // --- Legacy Logic ---
        else {
            // Log rejection in the appropriate approval slot if applicable, or just general log
            if (level === 'L1') {
                request.approvals.l1 = { status: 'Rejected', approver: req.user._id, date: new Date(), comments };
            } else if (level === 'Final') {
                request.approvals.final = { status: 'Rejected', approver: req.user._id, date: new Date(), comments };
            }
        }

        await request.save();

        await HRRAuditLog.create({
            hiringRequestId: request._id,
            action: 'REJECTED',
            performedBy: req.user._id,
            details: { comments, level: request.currentApprovalLevel || level }
        });

        const updatedRequest = await buildHiringRequestDetailsQuery(req.companyId, request._id).lean();

        res.status(200).json(updatedRequest || request);
    } catch (error) {
        console.error('Error rejecting hiring request:', error);
        res.status(500).json({ message: 'Server Error', error: error.message });
    }
};

// --- closeHiringRequest ---
exports.closeHiringRequest = async (req, res) => {
    try {
        const { id } = req.params;

        const request = await HiringRequest.findOneAndUpdate(
            { _id: id, companyId: req.companyId },
            { status: 'Closed', closedAt: new Date() },
            { new: true }
        );

        if (!request) return res.status(404).json({ message: 'Not found' });

        // Update candidates with "None" or empty decisions to "Rejected"
        await Candidate.updateMany(
            { hiringRequestId: id, decision: { $in: ['None', null, ''] } },
            { $set: { decision: 'Rejected' } }
        );
        await Candidate.updateMany(
            { hiringRequestId: id, phase2Decision: { $in: ['None', null, ''] } },
            { $set: { phase2Decision: 'Rejected' } }
        );
        await Candidate.updateMany(
            { hiringRequestId: id, phase3Decision: { $in: ['None', null, ''] } },
            { $set: { phase3Decision: 'Rejected' } }
        );

        await HRRAuditLog.create({
            hiringRequestId: request._id,
            action: 'CLOSED',
            performedBy: req.user._id,
            details: {}
        });

        const updatedRequest = await buildHiringRequestDetailsQuery(req.companyId, request._id).lean();

        res.status(200).json(updatedRequest || request);

    } catch (error) {
        console.error(error);
        res.status(500).json({ message: 'Server Error', error: error.message });
    }
};

exports.toggleJobVisibility = async (req, res) => {
    try {
        const { id } = req.params;
        const hasJobBoardToggle = typeof req.body?.isPublic === 'boolean';
        const hasResourceGatewayToggle = typeof req.body?.isResourceGatewayPublic === 'boolean';

        if (!hasJobBoardToggle && !hasResourceGatewayToggle) {
            return res.status(400).json({ message: 'Provide isPublic or isResourceGatewayPublic as a boolean value' });
        }

        const request = await HiringRequest.findOne({ _id: id, companyId: req.companyId });

        if (!request) {
            return res.status(404).json({ message: 'Job not found' });
        }

        if (request.status !== 'Approved') {
            return res.status(400).json({ message: 'Only approved jobs can be published to external job boards.' });
        }

        const company = req.company || await Company.findById(req.companyId).select('settings.careers').lean();
        const resourceGatewayEnabledForCompany = Boolean(company?.settings?.careers?.enableResourceGatewayPublishing);
        const auditEvents = [];

        if (hasJobBoardToggle) {
            request.isPublic = req.body.isPublic;
            auditEvents.push({
                action: req.body.isPublic ? 'PUBLISHED_TO_JOB_BOARD' : 'REMOVED_FROM_JOB_BOARD',
                details: { isPublic: req.body.isPublic }
            });

            if (!req.body.isPublic && request.isResourceGatewayPublic) {
                request.isResourceGatewayPublic = false;
                auditEvents.push({
                    action: 'REMOVED_FROM_RESOURCE_GATEWAY',
                    details: { isResourceGatewayPublic: false, reason: 'JOB_BOARD_UNPUBLISHED' }
                });
            }
        }

        if (hasResourceGatewayToggle) {
            if (!resourceGatewayEnabledForCompany) {
                return res.status(403).json({
                    message: 'This company is not enabled for publishing on Resource Gateway. Ask Super Admin to enable it in Company Settings.'
                });
            }

            const targetJobBoardVisibility = hasJobBoardToggle ? req.body.isPublic : request.isPublic;
            if (req.body.isResourceGatewayPublic && !targetJobBoardVisibility) {
                return res.status(400).json({
                    message: 'Publish this job to the main job board first before publishing it to Resource Gateway.'
                });
            }

            request.isResourceGatewayPublic = req.body.isResourceGatewayPublic;
            auditEvents.push({
                action: req.body.isResourceGatewayPublic ? 'PUBLISHED_TO_RESOURCE_GATEWAY' : 'REMOVED_FROM_RESOURCE_GATEWAY',
                details: { isResourceGatewayPublic: req.body.isResourceGatewayPublic }
            });
        }

        if (req.body.publicJobTitle !== undefined) {
            request.publicJobTitle = req.body.publicJobTitle;
        }

        if (req.body.publicJobDescription !== undefined) {
            request.publicJobDescription = req.body.publicJobDescription;
        }

        await request.save();

        if (auditEvents.length) {
            await HRRAuditLog.insertMany(auditEvents.map((event) => ({
                hiringRequestId: request._id,
                action: event.action,
                performedBy: req.user._id,
                details: event.details
            })));
        }

        const updatedRequest = await buildHiringRequestDetailsQuery(req.companyId, request._id).lean();
        const messageParts = [];

        if (hasJobBoardToggle) {
            messageParts.push(`job board ${req.body.isPublic ? 'enabled' : 'disabled'}`);
        }

        if (hasResourceGatewayToggle) {
            messageParts.push(`Resource Gateway ${req.body.isResourceGatewayPublic ? 'enabled' : 'disabled'}`);
        }

        res.status(200).json({
            job: updatedRequest || request,
            capabilities: {
                resourceGatewayEnabledForCompany
            },
            message: messageParts.length
                ? `Updated ${messageParts.join(' and ')}.`
                : 'Job visibility updated.'
        });
    } catch (error) {
        console.error('Error toggling job visibility:', error);
        res.status(500).json({ message: 'Failed to update job visibility', error: error.message });
    }
};

// --- getPreviousCandidates ---
// Returns candidates grouped by each previous opening, in newest-first order
exports.getPreviousCandidates = async (req, res) => {
    try {
        const { id } = req.params;
        const currentReq = await HiringRequest.findOne({ _id: id, companyId: req.companyId }).select('previousRequestId');
        if (!currentReq || !currentReq.previousRequestId) {
            return res.status(200).json([]);
        }

        // Trace back all previous requisitions (oldest last in chain)
        let pId = currentReq.previousRequestId;
        const legacyRequisitions = []; // ordered: pId is most recent previous

        while (pId) {
            const r = await HiringRequest.findOne({ _id: pId, companyId: req.companyId })
                .select('requestId status createdAt closedAt previousRequestId roleDetails')
                .lean();
            if (!r) break;
            legacyRequisitions.push(r);
            pId = r.previousRequestId || null;
        }

        // Fetch candidates for each requisition and group them
        const groups = await Promise.all(
            legacyRequisitions.map(async (req) => {
                const candidates = await Candidate.find({ hiringRequestId: req._id }).lean();
                return {
                    requisition: {
                        _id: req._id,
                        requestId: req.requestId,
                        status: req.status,
                        createdAt: req.createdAt,
                        closedAt: req.closedAt,
                        title: req.roleDetails?.title
                    },
                    candidates
                };
            })
        );

        // Return newest previous opening first
        res.status(200).json(groups);
    } catch (error) {
        console.error(error);
        res.status(500).json({ message: 'Server Error' });
    }
};

// --- uploadJDFile ---
exports.uploadJDFile = async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ success: false, message: 'No file uploaded' });
        }

        // Return the secure URL from Cloudinary
        res.status(200).json({
            success: true,
            message: 'File uploaded successfully',
            fileUrl: req.file.path // This will be the Cloudinary secure_url created by multer-storage-cloudinary
        });
    } catch (error) {
        console.error('Error uploading JD file:', error);
        res.status(500).json({ success: false, message: 'Server Error during file upload', error: error.message });
    }
};


// --- transferCandidate ---
exports.transferCandidate = async (req, res) => {
    try {
        const { candidateId } = req.params;
        const candidate = await Candidate.findById(candidateId);

        if (!candidate) return res.status(404).json({ message: 'Candidate not found' });

        // Find the most recent requisition in the chain
        let currentReq = await HiringRequest.findOne({ _id: candidate.hiringRequestId, companyId: req.companyId }).select('reopenedToId');
        let newestReqId = currentReq ? currentReq._id : null;

        while (currentReq && currentReq.reopenedToId) {
            newestReqId = currentReq.reopenedToId;
            currentReq = await HiringRequest.findOne({ _id: currentReq.reopenedToId, companyId: req.companyId }).select('reopenedToId hover');
        }

        if (!newestReqId || newestReqId.toString() === candidate.hiringRequestId.toString()) {
            return res.status(400).json({ message: 'No active newer requisition found to transfer to' });
        }

        // Check if candidate is already transferred
        const existingTransfer = await Candidate.findOne({
            email: candidate.email,
            hiringRequestId: newestReqId
        });

        if (existingTransfer) {
            return res.status(400).json({ message: 'Candidate exists in the target requisition' });
        }

        // Clone Candidate
        const newCandidateData = candidate.toObject();
        delete newCandidateData._id;
        delete newCandidateData.createdAt;
        delete newCandidateData.updatedAt;
        delete newCandidateData.__v;

        newCandidateData.hiringRequestId = newestReqId;
        newCandidateData.isTransferred = true;
        newCandidateData.transferredFrom = candidate.hiringRequestId;

        // Reset process statuses
        newCandidateData.status = 'Interested';
        newCandidateData.statusHistory = [{
            status: 'Interested',
            changedBy: req.user._id,
            changedAt: new Date(),
            remark: 'Transferred from previous requisition'
        }];
        newCandidateData.decision = 'None';
        newCandidateData.phase2Decision = 'None';
        newCandidateData.phase3Decision = 'None';
        newCandidateData.interviewRounds = [];

        const newCandidate = new Candidate(newCandidateData);
        await newCandidate.save();

        res.status(201).json({ message: 'Candidate transferred successfully', candidate: newCandidate });
    } catch (error) {
        console.error(error);
        res.status(500).json({ message: 'Server Error', error: error.message });
    }
};

// --- Analytics ---
exports.getClientAnalytics = async (req, res) => {
    try {
        let { clientName } = req.params;
        const { hiringRequestId } = req.query; // Optional filter

        if (!clientName) {
            return res.status(400).json({ success: false, message: 'Client name is required' });
        }

        clientName = decodeURIComponent(clientName);

        // Fetch all hiring requests for this client mainly to build the dropdown list
        const allClientReqs = await HiringRequest.find({ client: clientName, companyId: req.companyId }).select('_id roleDetails.title status').lean();

        let hrQuery = { client: clientName, companyId: req.companyId };
        if (hiringRequestId) {
            hrQuery._id = hiringRequestId;
        }

        const hiringRequests = await HiringRequest.find(hrQuery).lean();

        const requisitionsList = allClientReqs.map(hr => ({ 
            _id: hr._id, 
            title: hr.roleDetails?.title, 
            status: hr.status,
            createdAt: hr.createdAt,
            closedAt: hr.closedAt,
            client: hr.client
        }));

        if (!hiringRequests || hiringRequests.length === 0) {
            return res.status(200).json({
                success: true,
                data: {
                    totalReqs: 0,
                    activeReqs: 0,
                    closedReqs: 0,
                    totalOpenPositions: 0,
                    pipeline: {
                        'Sourced': 0,
                        'In Interviews': 0,
                        'Hired': 0,
                        'Rejected': 0,
                        'On Hold': 0
                    },
                    hiringRatio: 0,
                    requisitionsList
                }
            });
        }

        const hrIds = hiringRequests.map(hr => hr._id);

        let activeReqs = 0;
        let closedReqs = 0;
        let totalOpenPositions = 0;

        hiringRequests.forEach(hr => {
            if (hr.status === 'Closed') {
                closedReqs++;
            } else {
                activeReqs++;
                totalOpenPositions += (hr.hiringDetails?.openPositions || 1);
            }
        });

        // Track candidate pipeline
        const candidates = await Candidate.find({ hiringRequestId: { $in: hrIds } }).lean();

        const pipelineStages = {
            'Sourced': 0,
            'Phase 1 Shortlisted': 0,
            'Phase 2 Shortlisted': 0,
            'Phase 2 Selected': 0,
            'Phase 2 In Interviews': 0,
            'Phase 3 Offer Stage': 0,
            'Joined': 0,
            'Rejected / Drop-off': 0,
            'On Hold': 0
        };

        // Deduplicate and process candidates (keep highest achieved status)
        // Note: For "Total Sourced", we now count all unique candidate-requisition pairs
        // reflecting the total volume of sourcing work.
        const activeCandidates = candidates;
        const uniqueCandidates = [...new Map(activeCandidates.map(c => [c.email, c])).values()];
        let totalHired = 0;

        activeCandidates.forEach(c => {
            // Drop-offs first
            if (
                c.decision === 'Rejected' ||
                c.phase2Decision === 'Rejected' ||
                c.phase3Decision === 'No Show' ||
                c.phase3Decision === 'Offer Declined' ||
                c.status === 'Not Interested' ||
                c.status === 'Not Picking'
            ) {
                pipelineStages['Rejected / Drop-off']++;
                return;
            }

            if (c.decision === 'On Hold' || c.phase2Decision === 'On Hold') {
                pipelineStages['On Hold']++;
                return;
            }

            // Phase 3 (Strict gate: must be Selected in Phase 2)
            if (['Offer Sent', 'Offer Accepted', 'Joined'].includes(c.phase3Decision) && c.phase2Decision === 'Selected') {
                if (c.phase3Decision === 'Joined') {
                    pipelineStages['Joined']++;
                    totalHired++;
                } else {
                    pipelineStages['Phase 3 Offer Stage']++;
                }
                pipelineStages['Phase 2 Selected']++;
                pipelineStages['Phase 2 Shortlisted']++;
                return;
            }

            // Phase 2
            if (c.phase2Decision === 'Selected') {
                pipelineStages['Phase 2 Selected']++;
                pipelineStages['Phase 2 Shortlisted']++;
                return;
            }

            if (c.phase2Decision === 'Shortlisted') {
                pipelineStages['Phase 2 Shortlisted']++;
                return;
            }

            if (c.interviewRounds?.length > 0) {
                pipelineStages['Phase 2 In Interviews']++;
                return;
            }

            // Phase 1
            if (c.decision === 'Shortlisted') {
                pipelineStages['Phase 1 Shortlisted']++;
                return;
            }

            pipelineStages['Sourced']++;
        });

        const hiringRatio = uniqueCandidates.length > 0 ? ((totalHired / uniqueCandidates.length) * 100).toFixed(1) : 0;

        res.status(200).json({
            success: true,
            data: {
                totalReqs: hiringRequests.length,
                activeReqs,
                closedReqs,
                totalOpenPositions,
                totalSourced: activeCandidates.length,
                pipeline: pipelineStages,
                hiringRatio: Number(hiringRatio),
                requisitionsList
            }
        });


    } catch (error) {
        console.error('Error fetching client analytics:', error);
        res.status(500).json({ success: false, message: 'Server Error', error: error.message });
    }
};

// --- Global Analytics ---
// --- Global Analytics ---
exports.getGlobalAnalytics = async (req, res) => {
    try {
        const { client, department, position, recruiter, startDate, endDate, phase, requisitionId } = req.query;

        // Visibility permissions
        const isAdmin = req.user.roles.some(r => r.name === 'Admin' || r.name === 'HR' || r.name === 'Super Admin');
        const userPermissions = req.user.roles.flatMap(role => (role.permissions || []).map(p => p.key));
        const hasTaView = userPermissions.includes('ta.view') || userPermissions.includes('*');

        let hrQuery = { companyId: req.companyId };
        if (!isAdmin && !hasTaView) {
            const candidatesWithUserAsInterviewer = await Candidate.find({
                'interviewRounds.assignedTo': req.user._id
            }).select('hiringRequestId').lean();

            const interviewHiringRequestIds = candidatesWithUserAsInterviewer.map(c => c.hiringRequestId);

            hrQuery['$or'] = [
                { createdBy: req.user._id },
                { 'ownership.hiringManager': req.user._id },
                { 'ownership.recruiter': req.user._id },
                { _id: { $in: interviewHiringRequestIds } }
            ];
        }

        if (client) hrQuery.client = new RegExp(client, 'i');
        if (department) hrQuery['roleDetails.department'] = new RegExp(department, 'i');
        if (position) hrQuery['roleDetails.title'] = new RegExp(position, 'i');

        const allHiringRequests = await HiringRequest.find(hrQuery).select('_id roleDetails.department roleDetails.title client hiringDetails status createdAt closedAt').lean();
        
        const requisitionsList = allHiringRequests.map(hr => ({
            _id: hr._id,
            title: hr.roleDetails?.title,
            status: hr.status,
            createdAt: hr.createdAt,
            closedAt: hr.closedAt,
            client: hr.client
        }));

        const hiringRequests = requisitionId 
            ? allHiringRequests.filter(hr => hr._id.toString() === requisitionId)
            : allHiringRequests;

        const hrIds = hiringRequests.map(hr => hr._id);

        let candidateQuery = { hiringRequestId: { $in: hrIds } };
        if (startDate || endDate) {
            candidateQuery.createdAt = {};
            if (startDate) candidateQuery.createdAt.$gte = new Date(startDate);
            if (endDate) candidateQuery.createdAt.$lte = new Date(endDate);
        }
        if (recruiter) {
            candidateQuery.profilePulledBy = new RegExp(recruiter, 'i');
        }

        const candidates = await Candidate.find(candidateQuery)
            .populate('hiringRequestId', 'client roleDetails.title roleDetails.department status createdAt closedAt hiringDetails')
            .populate('uploadedBy', 'firstName lastName')
            .lean();

        // Process Recruiter names correctly for filtering and display
        const getCandidateRecruiterName = (c) => {
            if (c.profilePulledBy) return c.profilePulledBy;
            if (c.uploadedBy) return `${c.uploadedBy.firstName || ''} ${c.uploadedBy.lastName || ''}`.trim();
            return 'Self/Other';
        };

        // If recruiter filter is manually passed, we need to filter the candidate list precisely
        let filteredCandidates = candidates;
        if (recruiter) {
            filteredCandidates = candidates.filter(c => {
                const name = getCandidateRecruiterName(c);
                return name.toLowerCase().includes(recruiter.toLowerCase());
            });
        }

        const activeCandidates = filteredCandidates;

        // Identify active hiring requests after filtering candidates
        // This ensures stats like "Total Requisitions" match the filtered candidate activity
        const activeHrIds = [...new Set(activeCandidates.map(c => c.hiringRequestId?._id?.toString()).filter(Boolean))];
        const activeHrSet = new Set(activeHrIds);

        const filteredHiringRequests = (startDate || endDate || recruiter)
            ? hiringRequests.filter(hr => activeHrSet.has(hr._id.toString()))
            : hiringRequests;

        // Metrics containers
        let totalOpenPositions = 0;
        filteredHiringRequests.forEach(hr => {
            if (hr.status !== 'Closed') {
                totalOpenPositions += (hr.hiringDetails?.openPositions || 1);
            }
        });

        const pipeline = { 'Sourced': 0, 'Ph 1 Shortlisted': 0, 'Ph 2 Shortlisted': 0, 'Final Selection': 0, 'Offer Released': 0, 'Joined': 0 };
        const funnel = { interested: 0, interview: 0, offer: 0 };
        const deptAnalysis = {};
        const clientAnalysis = {};
        const recruiterPerf = {};
        const positionPerf = {};
        const sourceAnalysis = {};
        const monthlyTrend = {};

        let interviewsScheduled = 0;
        let offersReleased = 0;
        let totalJoined = 0;
        let hiresWithTime = 0;
        let sumTimeToHireDays = 0;
        let closedReqsCount = 0;
        let totalTimeToFill = 0;

        // For time metrics averages
        let interviewCount = 0;
        let offerReleaseCount = 0;
        let joinedAfterOfferCount = 0;
        let sourceToInterviewTime = 0;
        let interviewToOfferTime = 0;
        let offerToJoinTime = 0;

        activeCandidates.forEach(c => {
            const hrInfo = c.hiringRequestId || {};
            const dept = hrInfo.roleDetails?.department || 'General';
            const clientName = hrInfo.client || 'General';
            const reqId = hrInfo._id?.toString() || 'Unknown';
            const recName = getCandidateRecruiterName(c);
            const src = c.source || 'Direct';

            const monthObj = new Date(c.createdAt || new Date());
            const month = `${monthObj.getFullYear()}-${String(monthObj.getMonth() + 1).padStart(2, '0')}`;
            if (!monthlyTrend[month]) monthlyTrend[month] = { sourced: 0, interviews: 0, offers: 0, joined: 0 };
            monthlyTrend[month].sourced++;

            if (!deptAnalysis[dept]) deptAnalysis[dept] = { sourced: 0, interviewed: 0, offered: 0, joined: 0 };
            if (!clientAnalysis[clientName]) clientAnalysis[clientName] = { sourced: 0, interviewed: 0, offered: 0, joined: 0 };
            if (!recruiterPerf[recName]) recruiterPerf[recName] = { sourced: 0, interviews: 0, offers: 0, joined: 0 };
            if (!sourceAnalysis[src]) sourceAnalysis[src] = { sourced: 0, joined: 0 };
            if (!positionPerf[reqId]) positionPerf[reqId] = { title: hrInfo.roleDetails?.title || 'Unknown', client: clientName, open: hrInfo.hiringDetails?.openPositions || 1, sourced: 0, interviewed: 0, offered: 0, joined: 0 };

            deptAnalysis[dept].sourced++;
            clientAnalysis[clientName].sourced++;
            recruiterPerf[recName].sourced++;
            sourceAnalysis[src].sourced++;
            positionPerf[reqId].sourced++;

            // Ongoing/Completed Interview Count (Scheduled, Passed, Failed)
            const interviewStatuses = ['Scheduled', 'Passed', 'Failed'];
            const relevantRounds = c.interviewRounds?.filter(r => interviewStatuses.includes(r.status));
            if (relevantRounds?.length > 0) {
                if (phase && phase !== 'all') {
                    if (relevantRounds.some(r => r.phase === parseInt(phase))) {
                        interviewsScheduled++;
                    }
                } else {
                    interviewsScheduled++;
                }
            }

            // Interested Stage: Anyone who entered the process and isn't explicitly disqualified/not interested
            if (!['Not Interested', 'Not Relevant', 'Not Picking'].includes(c.status)) {
                funnel.interested++;
            }

            if (c.interviewRounds?.length > 0) {
                funnel.interview++;
                deptAnalysis[dept].interviewed++;
                clientAnalysis[clientName].interviewed++;
                recruiterPerf[recName].interviews++;
                positionPerf[reqId].interviewed++;
                monthlyTrend[month].interviews++;

                const firstInterview = c.interviewRounds[0].scheduledDate || c.interviewRounds[0].evaluatedAt;
                if (firstInterview) {
                    sourceToInterviewTime += (new Date(firstInterview) - new Date(c.createdAt)) / (1000 * 60 * 60 * 24);
                    interviewCount++;
                }
            }

            // Pipeline snapshots
            if (c.phase3Decision === 'Joined') pipeline['Joined']++;
            else if (['Offer Sent', 'Offer Accepted'].includes(c.phase3Decision)) pipeline['Offer Released']++;
            else if (c.phase2Decision === 'Selected') pipeline['Final Selection']++;
            else if (c.phase2Decision === 'Shortlisted') pipeline['Ph 2 Shortlisted']++;
            else if (c.decision === 'Shortlisted') pipeline['Ph 1 Shortlisted']++;
            else pipeline['Sourced']++;

            if (['Offer Sent', 'Offer Accepted', 'Joined'].includes(c.phase3Decision) && c.phase2Decision === 'Selected') {
                funnel.offer++;
                offersReleased++;
                deptAnalysis[dept].offered++;
                clientAnalysis[clientName].offered++;
                recruiterPerf[recName].offers++;
                positionPerf[reqId].offered++;
                monthlyTrend[month].offers++;

                const offerDate = c.statusHistory?.find(h => h.status === 'Offer Released')?.changedAt || c.updatedAt;
                const lastIntv = [...c.interviewRounds].reverse().find(r => r.evaluatedAt)?.evaluatedAt;
                if (offerDate && lastIntv) {
                    interviewToOfferTime += (new Date(offerDate) - new Date(lastIntv)) / (1000 * 60 * 60 * 24);
                    offerReleaseCount++;
                }
            }

            if (c.phase3Decision === 'Joined' && c.phase2Decision === 'Selected') {
                totalJoined++;
                deptAnalysis[dept].joined++;
                clientAnalysis[clientName].joined++;
                recruiterPerf[recName].joined++;
                sourceAnalysis[src].joined++;
                positionPerf[reqId].joined++;
                monthlyTrend[month].joined++;

                const joinDate = c.statusHistory?.find(h => h.status === 'Joined')?.changedAt || c.updatedAt;
                const offerDate = c.statusHistory?.find(h => h.status === 'Offer Released')?.changedAt;
                if (joinDate && offerDate) {
                    offerToJoinTime += (new Date(joinDate) - new Date(offerDate)) / (1000 * 60 * 60 * 24);
                    joinedAfterOfferCount++;
                }

                if (joinDate && c.createdAt) {
                    sumTimeToHireDays += (new Date(joinDate) - new Date(c.createdAt)) / (1000 * 60 * 60 * 24);
                    hiresWithTime++;
                }
            }
        });

        // Time to fill (req based)
        filteredHiringRequests.forEach(hr => {
            if (hr.status === 'Closed' && hr.closedAt && hr.createdAt) {
                totalTimeToFill += (new Date(hr.closedAt) - new Date(hr.createdAt)) / (1000 * 60 * 60 * 24);
                closedReqsCount++;
            }
        });

        // Phase-specific metric overrides
        let displayMetrics = {
            totalReqs: filteredHiringRequests.length,
            totalOpenPositions,
            totalSourced: activeCandidates.length,
            interviewsScheduled,
            offersReleased,
            totalJoined,
            offerAcceptanceRate: offersReleased > 0 ? ((totalJoined / offersReleased) * 100).toFixed(1) : 0,
            joiningConversionRate: activeCandidates.length > 0 ? ((totalJoined / activeCandidates.length) * 100).toFixed(1) : 0,
            avgTimeToHire: hiresWithTime > 0 ? Math.round(sumTimeToHireDays / hiresWithTime) : 0,
            avgTimeToFill: closedReqsCount > 0 ? Math.round(totalTimeToFill / closedReqsCount) : 0
        };

        if (phase === '1') {
            const ph1Shortlisted = activeCandidates.filter(c => c.decision === 'Shortlisted').length;
            displayMetrics = {
                ...displayMetrics,
                totalSourced: activeCandidates.length,
                interviewsScheduled: activeCandidates.filter(c => c.interviewRounds?.some(r => r.phase === 1 && ['Scheduled', 'Passed', 'Failed'].includes(r.status))).length,
                ph1Shortlisted,
                conversionRate: activeCandidates.length > 0 ? ((ph1Shortlisted / activeCandidates.length) * 100).toFixed(1) : 0
            };
        } else if (phase === '2') {
            const ph1Selected = activeCandidates.filter(c => c.decision === 'Shortlisted').length;
            const ph2Selected = activeCandidates.filter(c => c.phase2Decision === 'Selected').length;
            displayMetrics = {
                ...displayMetrics,
                totalSourced: ph1Selected,
                interviewsScheduled: activeCandidates.filter(c => c.interviewRounds?.some(r => r.phase === 2 && ['Scheduled', 'Passed', 'Failed'].includes(r.status))).length,
                ph2Selected,
                conversionRate: ph1Selected > 0 ? ((ph2Selected / ph1Selected) * 100).toFixed(1) : 0
            };
        } else if (phase === '3') {
            const ph2Selected = activeCandidates.filter(c => c.phase2Decision === 'Selected').length;
            displayMetrics = {
                ...displayMetrics,
                totalSourced: ph2Selected,
                interviewsScheduled: 0,
                offersReleased,
                totalJoined,
                conversionRate: ph2Selected > 0 ? ((totalJoined / ph2Selected) * 100).toFixed(1) : 0
            };
        }

        // Monthly Trend
        const monthlyTrendArray = Object.keys(monthlyTrend).sort().map(m => ({
            month: m,
            ...monthlyTrend[m]
        }));

        const filterOptions = {
            clients: [...new Set(allHiringRequests.map(hr => hr.client).filter(Boolean))].sort(),
            departments: [...new Set(allHiringRequests.map(hr => hr.roleDetails?.department).filter(Boolean))].sort(),
            positions: [...new Set(allHiringRequests.map(hr => hr.roleDetails?.title).filter(Boolean))].sort(),
            recruiters: [...new Set(candidates.map(c => getCandidateRecruiterName(c)).filter(Boolean))].sort(),
            requisitions: requisitionsList
        };

        res.status(200).json({
            success: true,
            data: {
                topMetrics: displayMetrics,
                pipelineDistribution: Object.keys(pipeline).map(key => ({
                    name: key,
                    value: pipeline[key]
                })).filter(d => d.value > 0),
                recruitmentFunnel: [
                    { name: 'Sourced', value: activeCandidates.length },
                    { name: 'Interested', value: funnel.interested },
                    { name: 'Interview', value: funnel.interview },
                    { name: 'Offer', value: funnel.offer },
                    { name: 'Joined', value: totalJoined }
                ],
                departmentAnalysis: Object.keys(deptAnalysis).map(d => ({ name: d, ...deptAnalysis[d] })),
                clientAnalysis: Object.keys(clientAnalysis).map(c => ({ name: c, ...clientAnalysis[c] })),
                recruiterPerformance: Object.keys(recruiterPerf)
                    .map(r => ({
                        name: r,
                        ...recruiterPerf[r],
                        conversion: recruiterPerf[r].sourced > 0 ? ((recruiterPerf[r].joined / recruiterPerf[r].sourced) * 100).toFixed(1) : 0
                    }))
                    .sort((a, b) => b.joined - a.joined),
                positionPerformance: Object.keys(positionPerf).map(id => ({ id, ...positionPerf[id] })),
                timeMetrics: [
                    { name: 'Source to Interview', value: interviewCount > 0 ? Math.round(sourceToInterviewTime / interviewCount) : 0 },
                    { name: 'Interview to Offer', value: offerReleaseCount > 0 ? Math.round(interviewToOfferTime / offerReleaseCount) : 0 },
                    { name: 'Offer to Joining', value: joinedAfterOfferCount > 0 ? Math.round(offerToJoinTime / joinedAfterOfferCount) : 0 }
                ],
                sourceAnalysis: Object.keys(sourceAnalysis).map(s => ({ name: s, ...sourceAnalysis[s] })),
                monthlyTrend: monthlyTrendArray,
                filterOptions
            }
        });
    } catch (error) {
        console.error('getGlobalAnalytics error:', error);
        res.status(500).json({ success: false, message: 'Internal Server Error', error: error.message });
    }
};

// --- uploadJDFile ---
exports.uploadJDFile = async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ message: 'No file uploaded' });
        }

        // The file is already uploaded to Cloudinary by the multer middleware
        // defined in the routes (config/cloudinary)
        const fileUrl = req.file.path; // Cloudinary URL

        res.status(200).json({
            message: 'JD file uploaded successfully',
            url: fileUrl
        });
    } catch (error) {
        console.error('Error uploading JD file:', error);
        res.status(500).json({ message: 'Server error', error: error.message });
    }
};

// --- getTAClients ---
exports.getTAClients = async (req, res) => {
    try {
        setNoCache(res);
        const query = { companyId: req.companyId };
        
        // Find all unique client names that have hiring requests
        const clients = await HiringRequest.distinct('client', query);
        
        const clientStats = await Promise.all(clients.map(async (clientName) => {
            const runningCount = await HiringRequest.countDocuments({ 
                companyId: req.companyId, 
                client: clientName, 
                status: 'Approved'
            });
            const pendingCount = await HiringRequest.countDocuments({ 
                companyId: req.companyId, 
                client: clientName, 
                status: { $in: ['Pending_Approval', 'Pending_L1', 'Pending_Final', 'Submitted'] } 
            });
            const closedCount = await HiringRequest.countDocuments({ 
                companyId: req.companyId, 
                client: clientName, 
                status: 'Closed' 
            });
            const rejectedCount = await HiringRequest.countDocuments({ 
                companyId: req.companyId, 
                client: clientName, 
                status: 'Rejected' 
            });
            const totalCount = await HiringRequest.countDocuments({
                companyId: req.companyId,
                client: clientName
            });

            return {
                name: clientName,
                activePositions: runningCount,
                pendingPositions: pendingCount,
                closedPositions: closedCount,
                rejectedPositions: rejectedCount,
                totalPositions: totalCount
            };
        }));

        // Sort by active positions descending
        clientStats.sort((a, b) => b.activePositions - a.activePositions);

        res.status(200).json(clientStats);
    } catch (error) {
        console.error('getTAClients error:', error);
        res.status(500).json({ message: 'Server Error', error: error.message });
    }
};
