const { HiringRequest, HRRAuditLog } = require('../models/HiringRequest');
const ApprovalWorkflow = require('../models/ApprovalWorkflow');
const User = require('../models/User');
const Candidate = require('../models/Candidate');
const Company = require('../models/Company');
const EmailTemplate = require('../models/EmailTemplate');
const PublicApplication = require('../models/PublicApplication');
const PhaseTemplate = require('../models/PhaseTemplate');
const mongoose = require('mongoose');
const SequenceCounter = require('../models/SequenceCounter');
const NotificationService = require('../services/notificationService');
const { sendEmailForCompany } = require('../services/companyEmailService');
const {
    TEMPLATE_PLACEHOLDERS,
    hasHtmlMarkup,
    renderTemplateBody,
    resolveTemplate,
    validateTemplateSyntax
} = require('../utils/templateResolver');
const { copyTemplatePhasesForHiringRequest } = require('../utils/phaseTemplateUtils');
const {
    buildAccessibleHiringRequestQuery,
    canAccessHiringRequest,
    getUserPermissionKeys,
    isHiringRequestAdmin
} = require('../utils/hiringRequestAccess');
const {
    buildAccessibleCandidateQuery,
    canAccessCandidate,
    TA_CAPABILITIES
} = require('../utils/candidateAccess');
const {
    buildAnalyticsHiringRequestQuery,
    hasGlobalTAAnalyticsAccess
} = require('../utils/taAnalyticsAccess');
const { buildAuditMeta, logTAAuditEvent } = require('../utils/taAudit');
const { serializeHiringRequestForViewer } = require('../utils/taVisibility');
const { canUseDelegatedPermission } = require('../utils/permissionDelegation');
const {
    getClientAssignedUserIds,
    mergeAssignedUsersWithClientAssignments
} = require('../utils/clientAssignmentSync');


const HIRING_REQUEST_SEQUENCE_KEY = 'hiring_request';

const getHiringRequestPrefix = (year) => `HRR-${year}-`;

const extractSequenceNumber = (requestId, year) => {
    const prefix = getHiringRequestPrefix(year);
    if (typeof requestId !== 'string' || !requestId.startsWith(prefix)) {
        return 0;
    }

    const suffix = requestId.slice(prefix.length);
    return Number.parseInt(suffix, 10) || 0;
};

const seedHiringRequestSequenceCounter = async (companyId, year) => {
    const existingCounter = await SequenceCounter.findOne({
        companyId,
        key: HIRING_REQUEST_SEQUENCE_KEY,
        year
    }).lean();

    if (existingCounter) {
        return existingCounter;
    }

    const prefix = getHiringRequestPrefix(year);
    const latestRequest = await HiringRequest.findOne({
        companyId,
        requestId: { $regex: `^${prefix}` }
    })
        .sort({ requestId: -1 })
        .select('requestId')
        .lean();

    const lastSequence = extractSequenceNumber(latestRequest?.requestId, year);

    try {
        return await SequenceCounter.create({
            companyId,
            key: HIRING_REQUEST_SEQUENCE_KEY,
            year,
            seq: lastSequence
        });
    } catch (error) {
        if (error?.code !== 11000) {
            throw error;
        }

        return SequenceCounter.findOne({
            companyId,
            key: HIRING_REQUEST_SEQUENCE_KEY,
            year
        }).lean();
    }
};

// Helper to generate Request ID (e.g., HRR-2026-001) using an atomic per-company counter.
const generateRequestId = async (companyId) => {
    const year = new Date().getFullYear();
    await seedHiringRequestSequenceCounter(companyId, year);

    const counter = await SequenceCounter.findOneAndUpdate(
        {
            companyId,
            key: HIRING_REQUEST_SEQUENCE_KEY,
            year
        },
        { $inc: { seq: 1 } },
        { new: true }
    ).lean();

    return `${getHiringRequestPrefix(year)}${String(counter.seq).padStart(3, '0')}`;
};

const setNoCache = (res) => {
    res.set('Cache-Control', 'no-cache');
    res.set('Pragma', 'no-cache');
    res.set('Expires', '0');
};

const parseNonNegativeInteger = (value, fallback = 0) => {
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
};

const resolveHiringPositionState = (hiringDetails = {}, status = '') => {
    let openPositions = parseNonNegativeInteger(hiringDetails?.openPositions, 1);
    let closedPositions = parseNonNegativeInteger(hiringDetails?.closedPositions, 0);
    let originalOpenPositions = parseNonNegativeInteger(hiringDetails?.originalOpenPositions, 0);

    if (originalOpenPositions <= 0) {
        originalOpenPositions = Math.max(openPositions + closedPositions, openPositions, 1);
    }

    if (status === 'Closed') {
        closedPositions = Math.max(closedPositions, originalOpenPositions, openPositions);
        originalOpenPositions = Math.max(originalOpenPositions, closedPositions);
        openPositions = 0;
    } else {
        originalOpenPositions = Math.max(originalOpenPositions, openPositions + closedPositions, 1);
    }

    return {
        openPositions,
        closedPositions,
        originalOpenPositions
    };
};

const normalizeHiringRequestResponse = (request) => {
    if (!request || !request.hiringDetails) return request;
    return {
        ...request,
        hiringDetails: {
            ...request.hiringDetails,
            ...resolveHiringPositionState(request.hiringDetails, request.status)
        }
    };
};

const serializeHiringRequestResponse = (request, user) => (
    serializeHiringRequestForViewer(normalizeHiringRequestResponse(request), user)
);

const getCurrentApprovalStepApproverIds = (request) => {
    const currentLevelIndex = Number(request?.currentApprovalLevel || 1) - 1;
    const currentStep = Array.isArray(request?.approvalChain) ? request.approvalChain[currentLevelIndex] : null;
    const approverIds = Array.isArray(currentStep?.approvers)
        ? currentStep.approvers.map((approver) => String(approver?._id || approver)).filter(Boolean)
        : [];

    return {
        currentLevelIndex,
        currentStep,
        approverIds
    };
};

const resolveApprovalDelegation = async ({ request, req }) => {
    const { approverIds } = getCurrentApprovalStepApproverIds(request);
    if (!approverIds.length) {
        return { allowed: false, delegation: null };
    }

    return canUseDelegatedPermission({
        companyId: req.companyId,
        delegateUserId: req.user._id,
        delegatorUserIds: approverIds,
        permissionKeys: ['ta.manage', 'ta.hiring_request.manage', 'ta.super_approve'],
        resourceType: 'hiringRequest',
        resourceId: request._id
    });
};

const buildHiringRequestDetailsQuery = (companyId, requestId) => (
    HiringRequest.findOne({ _id: requestId, companyId })
        .populate('ownership.hiringManager', 'firstName lastName email')
        .populate('assignedUsers', 'firstName lastName email employeeCode')
        .populate('analyticsViewers', 'firstName lastName email employeeCode')
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
        .populate('phaseTemplateId', 'name description isDefault')
);

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const stripHtml = (html = '') => String(html || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

const normalizeEmailAddress = (value) => String(value || '').trim().toLowerCase();

const buildCandidateFilterQuery = (filters = {}) => {
    const query = {};
    ['status', 'decision', 'phase2Decision', 'phase3Decision'].forEach((field) => {
        const value = filters?.[field];
        if (Array.isArray(value) && value.length) {
            query[field] = { $in: value };
        } else if (typeof value === 'string' && value.trim()) {
            query[field] = value.trim();
        }
    });
    return query;
};

const buildCandidateDataMap = (candidate, hiringRequest, companyName, extras = {}) => {
    const fullName = candidate.candidateName || '';
    const [firstName = '', ...lastNameParts] = fullName.trim().split(/\s+/).filter(Boolean);
    const lastName = lastNameParts.join(' ');
    const taOwner = hiringRequest?.ownership?.hiringManager;
    const taOwnerName = taOwner
        ? `${taOwner.firstName || ''} ${taOwner.lastName || ''}`.trim()
        : '';

    return {
        candidateName: fullName,
        firstName,
        lastName,
        fullName,
        email: candidate.email || '',
        workEmail: candidate.email || '',
        mobile: candidate.mobile || '',
        phoneNumber: candidate.mobile || '',
        jobTitle: hiringRequest?.roleDetails?.title || '',
        designation: hiringRequest?.roleDetails?.title || '',
        client: hiringRequest?.client || '',
        department: hiringRequest?.roleDetails?.department || '',
        location: hiringRequest?.location || '',
        managerName: '',
        managerEmail: '',
        recruiterName: candidate.profilePulledBy || taOwnerName || 'Talent Acquisition Team',
        companyName: companyName || '',
        requestId: hiringRequest?.requestId || '',
        currentStatus: candidate.status || '',
        interviewDate: extras.interviewDate || '',
        interviewLink: extras.interviewLink || '',
        customNote: extras.customNote || ''
    };
};

const applyDateRangeFilterToCandidateQuery = (query, rawDateField, rawStartDate, rawEndDate) => {
    const allowedDateFields = new Set(['createdAt', 'updatedAt']);
    const dateField = allowedDateFields.has(String(rawDateField || '')) ? String(rawDateField) : '';

    if (!dateField) {
        return query;
    }

    const dateFilter = {};

    if (rawStartDate) {
        const startDate = new Date(rawStartDate);
        if (!Number.isNaN(startDate.getTime())) {
            startDate.setHours(0, 0, 0, 0);
            dateFilter.$gte = startDate;
        }
    }

    if (rawEndDate) {
        const endDate = new Date(rawEndDate);
        if (!Number.isNaN(endDate.getTime())) {
            endDate.setHours(23, 59, 59, 999);
            dateFilter.$lte = endDate;
        }
    }

    if (Object.keys(dateFilter).length > 0) {
        query[dateField] = dateFilter;
    }

    return query;
};

const createTransferredCandidateClone = async ({ candidate, targetHiringRequestId, performedBy, resetRemark }) => {
    const newCandidateData = candidate.toObject ? candidate.toObject() : { ...candidate };
    delete newCandidateData._id;
    delete newCandidateData.createdAt;
    delete newCandidateData.updatedAt;
    delete newCandidateData.__v;

    newCandidateData.hiringRequestId = targetHiringRequestId;
    newCandidateData.isTransferred = true;
    newCandidateData.transferredFrom = candidate.hiringRequestId;
    newCandidateData.status = 'Interested';
    newCandidateData.statusHistory = [{
        status: 'Interested',
        changedBy: performedBy,
        changedAt: new Date(),
        remark: resetRemark || 'Transferred from previous requisition'
    }];
    newCandidateData.decision = 'None';
    newCandidateData.phase2Decision = 'None';
    newCandidateData.phase3Decision = 'None';
    newCandidateData.interviewRounds = [];

    const clonedCandidate = new Candidate(newCandidateData);
    await clonedCandidate.save();
    return clonedCandidate;
};

const transferCandidateToTargetRequisition = async ({ candidateId, targetRequisitionId, companyId, user }) => {
    if (!mongoose.Types.ObjectId.isValid(candidateId) || !mongoose.Types.ObjectId.isValid(targetRequisitionId)) {
        const error = new Error('Invalid candidate or target requisition ID.');
        error.statusCode = 400;
        throw error;
    }

    const candidate = await Candidate.findOne({ _id: candidateId, companyId });
    if (!candidate) {
        const error = new Error('Candidate not found.');
        error.statusCode = 404;
        throw error;
    }

    if (!(await canAccessCandidate(candidate, user, { companyId, capability: TA_CAPABILITIES.TRANSFER }))) {
        const error = new Error('Forbidden: You do not have permission to transfer this candidate.');
        error.statusCode = 403;
        throw error;
    }

    const sourceRequestId = candidate.hiringRequestId?.toString();
    if (sourceRequestId === String(targetRequisitionId)) {
        const error = new Error('Candidate is already in the selected requisition.');
        error.statusCode = 400;
        throw error;
    }

    const targetRequest = await HiringRequest.findOne({
        _id: targetRequisitionId,
        companyId,
        status: 'Approved'
    });

    if (!targetRequest) {
        const error = new Error('Target requisition not found or not active.');
        error.statusCode = 404;
        throw error;
    }

    const existingTransfer = await Candidate.findOne({
        companyId,
        hiringRequestId: targetRequisitionId,
        email: normalizeEmailAddress(candidate.email)
    });

    if (existingTransfer) {
        const error = new Error('Candidate exists in the target requisition.');
        error.statusCode = 409;
        throw error;
    }

    const newCandidate = await createTransferredCandidateClone({
        candidate,
        targetHiringRequestId: targetRequest._id,
        performedBy: user._id,
        resetRemark: 'Transferred from another requisition'
    });

    await HRRAuditLog.create({
        hiringRequestId: targetRequest._id,
        companyId,
        action: 'CANDIDATE_TRANSFERRED',
        performedBy: user._id,
        details: {
            candidateId: candidate._id,
            candidateEmail: candidate.email,
            from: candidate.hiringRequestId,
            to: targetRequest._id
        }
    });

    return { candidate, newCandidate, targetRequest };
};

const resolveMassMailTemplate = async ({ companyId, templateId, customSubject, customHtmlBody }) => {
    if (templateId) {
        const template = await EmailTemplate.findOne({
            _id: templateId,
            companyId,
            $or: [{ scope: 'ta' }, { scope: { $exists: false } }],
            isActive: true
        }).lean();

        if (!template) {
            const error = new Error('Email template not found.');
            error.statusCode = 404;
            throw error;
        }

        const subjectToUse = String(customSubject || '').trim() ? customSubject : template.subject;
        const bodyToUse = String(customHtmlBody || '').trim() ? customHtmlBody : template.htmlBody;

        const subjectValidation = validateTemplateSyntax(subjectToUse, TEMPLATE_PLACEHOLDERS);
        if (!subjectValidation.valid) {
            const error = new Error(`Saved template subject is invalid. ${subjectValidation.message}`);
            error.statusCode = 400;
            throw error;
        }

        const bodyValidation = validateTemplateSyntax(bodyToUse, TEMPLATE_PLACEHOLDERS);
        if (!bodyValidation.valid) {
            const error = new Error(`Saved template HTML body is invalid. ${bodyValidation.message}`);
            error.statusCode = 400;
            throw error;
        }

        return {
            template,
            subject: subjectToUse,
            htmlBody: bodyToUse
        };
    }

    if (!String(customSubject || '').trim() || !String(customHtmlBody || '').trim()) {
        const error = new Error('Provide a template or custom subject and HTML body.');
        error.statusCode = 400;
        throw error;
    }

    const subjectValidation = validateTemplateSyntax(customSubject, TEMPLATE_PLACEHOLDERS);
    if (!subjectValidation.valid) {
        const error = new Error(`Custom subject is invalid. ${subjectValidation.message}`);
        error.statusCode = 400;
        throw error;
    }

    const bodyValidation = validateTemplateSyntax(customHtmlBody, TEMPLATE_PLACEHOLDERS);
    if (!bodyValidation.valid) {
        const error = new Error(`Custom HTML body is invalid. ${bodyValidation.message}`);
        error.statusCode = 400;
        throw error;
    }

    return {
        template: null,
        subject: customSubject,
        htmlBody: customHtmlBody
    };
};

const sendMassMailForHiringRequest = async ({
    companyId,
    user,
    hiringRequestId,
    emailAccountId,
    templateId,
    customSubject,
    customHtmlBody,
    candidateIds = [],
    filters = {},
    customNote = ''
}) => {
    if (!mongoose.Types.ObjectId.isValid(hiringRequestId)) {
        const error = new Error('Invalid hiring request ID.');
        error.statusCode = 400;
        throw error;
    }

    const hiringRequest = await HiringRequest.findOne({ _id: hiringRequestId, companyId })
        .populate('ownership.hiringManager', 'firstName lastName email')
        .lean();

    if (!hiringRequest) {
        const error = new Error('Hiring request not found.');
        error.statusCode = 404;
        throw error;
    }

    const query = await buildAccessibleCandidateQuery(companyId, user, {
        hiringRequestId,
        ...buildCandidateFilterQuery(filters)
    }, { capability: TA_CAPABILITIES.VIEW });

    if (Array.isArray(candidateIds) && candidateIds.length) {
        query._id = {
            $in: candidateIds.filter((id) => mongoose.Types.ObjectId.isValid(id))
        };
    }

    const candidates = await Candidate.find(query).lean();
    const company = await Company.findById(companyId).select('name settings.logo').lean();
    const { template, subject, htmlBody } = await resolveMassMailTemplate({
        companyId,
        templateId,
        customSubject,
        customHtmlBody
    });

    let sent = 0;
    let failed = 0;
    const failedEmails = [];
    const delivery = await NotificationService.getEmailPreferenceForEvent(
        companyId,
        'ta_mass_mail_sent',
        emailAccountId
    );

    for (const [index, candidate] of candidates.entries()) {
        const dataMap = buildCandidateDataMap(
            candidate,
            hiringRequest,
            company?.name,
            { customNote }
        );

        const resolvedSubject = resolveTemplate(subject, dataMap);
        const resolvedBody = resolveTemplate(htmlBody, dataMap);
        const resolvedHtml = renderTemplateBody(htmlBody, dataMap);
        const resolvedText = hasHtmlMarkup(resolvedBody) ? stripHtml(resolvedHtml) : resolvedBody;

        const delivered = await sendEmailForCompany({
            companyId,
            emailAccountId: delivery.emailAccountId,
            to: candidate.email,
            subject: resolvedSubject,
            html: resolvedHtml,
            text: resolvedText
        });

        if (delivered) {
            sent += 1;
        } else {
            failed += 1;
            failedEmails.push({
                candidateId: candidate._id,
                email: candidate.email
            });
        }

        if (candidates.length > 20 && index < candidates.length - 1) {
            await wait(150);
        }
    }

    await HRRAuditLog.create({
        hiringRequestId: hiringRequest._id,
        companyId,
        action: 'MASS_MAIL_SENT',
        performedBy: user._id,
        details: {
            templateId: template?._id || templateId || null,
            recipientCount: sent,
            failedCount: failed,
            filters,
            candidateIds: Array.isArray(candidateIds) ? candidateIds : []
        }
    });

    return {
        hiringRequestId: hiringRequest._id,
        requestId: hiringRequest.requestId,
        sent,
        failed,
        failedEmails
    };
};

// --- createHiringRequest ---
exports.createHiringRequest = async (req, res) => {
    try {
        const {
            client,
            clientConfidential,
            roleDetails,
            purpose,
            requirements,
            hiringDetails,
            ownership,
            replacementDetails,
            interviewWorkflowId,
            previousRequestId,
            jobDescription,
            jobDescriptionFile,
            phaseTemplateId,
            assignedUsers,
            analyticsViewers
        } = req.body;
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

        let templateReference;
        let copiedPhases = [];
        const normalizedHiringDetails = {
            ...hiringDetails,
            ...resolveHiringPositionState(hiringDetails)
        };

        if (phaseTemplateId) {
            templateReference = await PhaseTemplate.findOne({
                _id: phaseTemplateId,
                companyId: req.companyId,
                isActive: true
            }).lean();

            if (!templateReference) {
                return res.status(404).json({ message: 'Selected phase template not found' });
            }

            copiedPhases = copyTemplatePhasesForHiringRequest(templateReference.phases || []);
        }

        const normalizedAssignedUsers = await mergeAssignedUsersWithClientAssignments({
            companyId: req.companyId,
            clientName: client,
            assignedUsers: Array.isArray(assignedUsers)
                ? [...new Set(assignedUsers.map((userId) => String(userId)).filter(Boolean))]
                : []
        });

        const newRequest = new HiringRequest({
            requestId,
            client,
            clientConfidential: Boolean(clientConfidential),
            roleDetails,
            purpose,
            requirements,
            hiringDetails: normalizedHiringDetails,
            replacementDetails,
            ownership: {
                ...ownership,
                hiringManager: req.user._id // Assumption: The logged in user is the HM or creating on behalf.
            },
            assignedUsers: normalizedAssignedUsers,
            analyticsViewers: Array.isArray(analyticsViewers)
                ? [...new Set(analyticsViewers.map((userId) => String(userId)).filter(Boolean))]
                : [],
            approvalChain: approvals,
            workflowId: workflow?._id, // Save the workflow ID
            interviewWorkflowId: interviewWorkflowId || undefined,
            currentApprovalLevel: approvals.length > 0 ? 1 : 0,
            status: submitNow ? 'Submitted' : 'Draft',
            createdBy: req.user._id,
            companyId: req.companyId,
            previousRequestId: previousRequestId || undefined,
            jobDescription,
            jobDescriptionFile,
            phaseTemplateId: templateReference?._id,
            phases: copiedPhases,
            useDynamicPhases: copiedPhases.length > 0
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
                        preferenceKey: 'hiring_request_approval_requested',
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
            companyId: req.companyId,
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

        res.status(201).json(normalizeHiringRequestResponse(newRequest.toObject()));
    } catch (error) {
        console.error(error);
        res.status(500).json({ message: 'Server Error', error: error.message });
    }
};

exports.getHiringRequestPhases = async (req, res) => {
    try {
        if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
            return res.status(400).json({ message: 'Invalid Hiring Request ID format' });
        }

        const hiringRequest = await HiringRequest.findOne({
            _id: req.params.id,
            companyId: req.companyId
        }).select('phases useDynamicPhases phaseTemplateId requestId roleDetails.title createdBy ownership approvalChain assignedUsers');

        if (!hiringRequest) {
            return res.status(404).json({ message: 'Hiring request not found' });
        }

        const hasAccess = await canAccessHiringRequest(hiringRequest, req.companyId, req.user, { action: 'view' });
        if (!hasAccess) {
            return res.status(403).json({ message: 'Forbidden: You do not have permission to view this request' });
        }

        res.status(200).json({
            success: true,
            useDynamicPhases: Boolean(hiringRequest.useDynamicPhases && hiringRequest.phases?.length),
            phaseTemplateId: hiringRequest.phaseTemplateId || null,
            phases: hiringRequest.phases || []
        });
    } catch (error) {
        console.error('getHiringRequestPhases error:', error);
        res.status(500).json({ success: false, message: 'Failed to fetch hiring request phases', error: error.message });
    }
};

// --- getHiringRequests ---
exports.getHiringRequests = async (req, res) => {
    try {
        setNoCache(res);
        const { status, page = 1, limit = 10, client } = req.query;
        const query = await buildAccessibleHiringRequestQuery(req.companyId, req.user, { action: 'view' });

        if (status) query.status = status;
        if (client) query.client = client;

        const pageNumber = parseInt(page);
        const limitNumber = parseInt(limit);
        const skip = (pageNumber - 1) * limitNumber;

        const totalRequests = await HiringRequest.countDocuments(query);
        const totalPages = Math.ceil(totalRequests / limitNumber);

        const requests = await HiringRequest.find(query)
            .populate('ownership.hiringManager', 'firstName lastName')
            .populate('assignedUsers', 'firstName lastName email employeeCode')
            .populate('analyticsViewers', 'firstName lastName email employeeCode')
            .sort({ createdAt: -1 })
            .skip(skip)
            .limit(limitNumber)
            .lean();

        res.status(200).json({
            requests: requests.map((request) => serializeHiringRequestResponse(request, req.user)),
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

        const hasAccess = await canAccessHiringRequest(request, req.companyId, req.user, { action: 'view' });
        if (!hasAccess) {
            return res.status(403).json({ message: 'Forbidden: You do not have permission to view this request' });
        }

        res.status(200).json(serializeHiringRequestResponse(request, req.user));
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

        const hasAccess = await canAccessHiringRequest(request, req.companyId, req.user, { action: 'edit' });
        if (!hasAccess) {
            return res.status(403).json({ message: 'Forbidden: You do not have permission to edit this request' });
        }

        if (request.status === 'Closed') {
            return res.status(400).json({ message: 'Cannot edit a closed request' });
        }

        const previousClientName = request.client;

        // Apply updates to request securely (prevent mass assignment)
        const allowedUpdates = [
            'client', 'clientConfidential', 'roleDetails', 'purpose', 'requirements',
            'hiringDetails', 'replacementDetails', 'ownership', 'interviewWorkflowId',
            'jobDescription', 'jobDescriptionFile', 'candidateCardVisibility', 'candidateDropdownVisibility',
            'assignedUsers', 'analyticsViewers'
        ];

        allowedUpdates.forEach(field => {
            if (updates[field] !== undefined) {
                if (field === 'assignedUsers' || field === 'analyticsViewers') {
                    request[field] = Array.isArray(updates[field])
                        ? [...new Set(updates[field].map((userId) => String(userId)).filter(Boolean))]
                        : [];
                } else if (field === 'hiringDetails') {
                    const mergedHiringDetails = {
                        ...(request.hiringDetails?.toObject ? request.hiringDetails.toObject() : request.hiringDetails),
                        ...updates.hiringDetails
                    };
                    request.hiringDetails = {
                        ...mergedHiringDetails,
                        ...resolveHiringPositionState(mergedHiringDetails, request.status)
                    };
                } else {
                    request[field] = updates[field];
                }
            }
        });

        if (updates.client !== undefined && previousClientName !== request.client) {
            const previousClientAssignedUserIds = await getClientAssignedUserIds(req.companyId, previousClientName);
            if (previousClientAssignedUserIds.length > 0) {
                request.assignedUsers = (Array.isArray(request.assignedUsers) ? request.assignedUsers : [])
                    .map((userId) => String(userId))
                    .filter((userId) => !previousClientAssignedUserIds.includes(userId));
            }
        }

        request.assignedUsers = await mergeAssignedUsersWithClientAssignments({
            companyId: req.companyId,
            clientName: request.client,
            assignedUsers: request.assignedUsers
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

        request.hiringDetails = {
            ...(request.hiringDetails?.toObject ? request.hiringDetails.toObject() : request.hiringDetails),
            ...resolveHiringPositionState(request.hiringDetails, request.status)
        };

        await request.save();

        const auditMeta = buildAuditMeta(req);
        await logTAAuditEvent({
            hiringRequestId: request._id,
            companyId: auditMeta.companyId,
            action: req.query.submit === 'true' ? 'UPDATED_AND_SUBMITTED' : 'UPDATED',
            performedBy: auditMeta.performedBy,
            permissionKey: 'ta.requisition.update',
            scope: 'resource',
            before: null,
            after: {
                status: request.status,
                workflowId: request.workflowId || null
            },
            details: { updates, workflowId: request.workflowId, workflowChanged },
            ipAddress: auditMeta.ipAddress,
            correlationId: auditMeta.correlationId
        });

        const updatedRequest = await buildHiringRequestDetailsQuery(req.companyId, request._id).lean();

        res.status(200).json(serializeHiringRequestResponse(updatedRequest || request.toObject(), req.user));
    } catch (error) {
        console.error('Error updating hiring request:', error);
        res.status(500).json({ message: 'Server Error', error: error.message });
    }
};

// --- deleteHiringRequest ---
exports.deleteHiringRequest = async (req, res) => {
    try {
        const { id } = req.params;

        const request = await HiringRequest.findOne({ _id: id, companyId: req.companyId });
        if (!request) {
            return res.status(404).json({ message: 'Not found' });
        }

        const hasAccess = await canAccessHiringRequest(request, req.companyId, req.user, { action: 'delete' });
        if (!hasAccess) {
            return res.status(403).json({ message: 'Forbidden: You do not have permission to delete this request' });
        }

        await request.softDelete(req.user._id);

        res.status(200).json({ message: 'Hiring request moved to bin' });
    } catch (error) {
        console.error('Error deleting hiring request:', error);
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
        let approvalDelegation = null;

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

            const userPermissions = getUserPermissionKeys(req.user);
            const hasManageOverride = userPermissions.includes('ta.manage')
                || userPermissions.includes('ta.hiring_request.manage')
                || userPermissions.includes('ta.super_approve')
                || userPermissions.includes('*');
            const delegatedApproval = !isAuthorized && !hasManageOverride
                ? await resolveApprovalDelegation({ request, req })
                : { allowed: false, delegation: null };
            approvalDelegation = delegatedApproval.delegation || null;

            if (!isAuthorized && !hasManageOverride && !delegatedApproval.allowed) {
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
                        preferenceKey: 'hiring_request_approval_requested',
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
                        preferenceKey: 'hiring_request_approved',
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
                        preferenceKey: 'hiring_request_approved',
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

        const approvalAuditMeta = buildAuditMeta(req);
        await logTAAuditEvent({
            hiringRequestId: request._id,
            companyId: approvalAuditMeta.companyId,
            action: `APPROVED_LEVEL_${request.currentApprovalLevel || level}`,
            performedBy: approvalAuditMeta.performedBy,
            permissionKey: approvalDelegation
                ? 'ta.hiring_request.manage (delegated)'
                : (getUserPermissionKeys(req.user).includes('ta.manage') ? 'ta.manage' : 'ta.hiring_request.manage'),
            scope: approvalDelegation ? 'delegated-resource' : 'resource',
            after: {
                status: request.status,
                currentApprovalLevel: request.currentApprovalLevel
            },
            details: { comments, previousLevel: currentLevelIndex !== undefined ? currentLevelIndex + 1 : level },
            ipAddress: approvalAuditMeta.ipAddress,
            correlationId: approvalAuditMeta.correlationId,
            delegation: approvalDelegation ? {
                delegationId: approvalDelegation._id,
                delegatorUserId: approvalDelegation.delegatorUserId,
                delegateUserId: approvalDelegation.delegateUserId
            } : null
        });

        const updatedRequest = await buildHiringRequestDetailsQuery(req.companyId, request._id).lean();

        res.status(200).json(serializeHiringRequestResponse(updatedRequest || request.toObject(), req.user));

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
        let rejectionDelegation = null;

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

                const userPermissions = getUserPermissionKeys(req.user);
                const hasManageOverride = userPermissions.includes('ta.manage')
                    || userPermissions.includes('ta.hiring_request.manage')
                    || userPermissions.includes('ta.super_approve')
                    || userPermissions.includes('*');
                const delegatedApproval = !isAuthorized && !hasManageOverride
                    ? await resolveApprovalDelegation({ request, req })
                    : { allowed: false, delegation: null };
                rejectionDelegation = delegatedApproval.delegation || null;

                if (!isAuthorized && !hasManageOverride && !delegatedApproval.allowed) {
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

        const rejectionAuditMeta = buildAuditMeta(req);
        await logTAAuditEvent({
            hiringRequestId: request._id,
            companyId: rejectionAuditMeta.companyId,
            action: 'REJECTED',
            performedBy: rejectionAuditMeta.performedBy,
            permissionKey: rejectionDelegation
                ? 'ta.hiring_request.manage (delegated)'
                : (getUserPermissionKeys(req.user).includes('ta.manage') ? 'ta.manage' : 'ta.hiring_request.manage'),
            scope: rejectionDelegation ? 'delegated-resource' : 'resource',
            after: {
                status: request.status,
                currentApprovalLevel: request.currentApprovalLevel
            },
            details: { comments, level: request.currentApprovalLevel || level },
            ipAddress: rejectionAuditMeta.ipAddress,
            correlationId: rejectionAuditMeta.correlationId,
            delegation: rejectionDelegation ? {
                delegationId: rejectionDelegation._id,
                delegatorUserId: rejectionDelegation.delegatorUserId,
                delegateUserId: rejectionDelegation.delegateUserId
            } : null
        });

        const updatedRequest = await buildHiringRequestDetailsQuery(req.companyId, request._id).lean();

        res.status(200).json(serializeHiringRequestResponse(updatedRequest || request.toObject(), req.user));
    } catch (error) {
        console.error('Error rejecting hiring request:', error);
        res.status(500).json({ message: 'Server Error', error: error.message });
    }
};

// --- closeHiringRequest ---
exports.closeHiringRequest = async (req, res) => {
    try {
        const { id } = req.params;
        const mode = req.body?.mode === 'partial' ? 'partial' : 'all';

        const existingRequest = await HiringRequest.findOne({ _id: id, companyId: req.companyId });
        if (!existingRequest) return res.status(404).json({ message: 'Not found' });

        const hasAccess = await canAccessHiringRequest(existingRequest, req.companyId, req.user, { action: 'manage' });
        if (!hasAccess) {
            return res.status(403).json({ message: 'Forbidden: You do not have permission to close this request' });
        }

        const currentPositionState = resolveHiringPositionState(existingRequest.hiringDetails, existingRequest.status);
        const currentOpenPositions = currentPositionState.openPositions;

        if (currentOpenPositions <= 0 && existingRequest.status === 'Closed') {
            return res.status(400).json({ message: 'This request is already fully closed.' });
        }

        if (currentOpenPositions <= 0) {
            return res.status(400).json({ message: 'There are no open positions left to close.' });
        }

        let closeCount = currentOpenPositions;
        if (mode === 'partial') {
            closeCount = Number.parseInt(req.body?.closeCount, 10);
            if (!Number.isFinite(closeCount) || closeCount <= 0) {
                return res.status(400).json({ message: 'Provide a valid number of positions to close.' });
            }
            if (closeCount > currentOpenPositions) {
                return res.status(400).json({ message: `You can close at most ${currentOpenPositions} open positions.` });
            }
        }

        const nextOpenPositions = Math.max(currentOpenPositions - closeCount, 0);
        const nextClosedPositions = currentPositionState.closedPositions + closeCount;
        const shouldFullyClose = nextOpenPositions === 0;

        existingRequest.hiringDetails = {
            ...(existingRequest.hiringDetails?.toObject ? existingRequest.hiringDetails.toObject() : existingRequest.hiringDetails),
            openPositions: nextOpenPositions,
            closedPositions: nextClosedPositions,
            originalOpenPositions: Math.max(
                currentPositionState.originalOpenPositions,
                nextOpenPositions + nextClosedPositions
            )
        };

        existingRequest.status = shouldFullyClose ? 'Closed' : existingRequest.status;
        existingRequest.closedAt = shouldFullyClose ? new Date() : undefined;

        await existingRequest.save();

        if (shouldFullyClose) {
            // Update candidates with "None" or empty decisions to "Rejected" only when the requisition is fully closed.
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
        }

        const closeAuditMeta = buildAuditMeta(req);
        await logTAAuditEvent({
            hiringRequestId: existingRequest._id,
            companyId: closeAuditMeta.companyId,
            action: shouldFullyClose ? 'CLOSED' : 'POSITIONS_PARTIALLY_CLOSED',
            performedBy: closeAuditMeta.performedBy,
            permissionKey: getUserPermissionKeys(req.user).includes('ta.manage') ? 'ta.manage' : 'ta.hiring_request.manage',
            scope: 'resource',
            after: {
                status: existingRequest.status,
                openPositions: nextOpenPositions,
                closedPositions: nextClosedPositions
            },
            details: {
                mode,
                closeCount,
                remainingOpenPositions: nextOpenPositions,
                closedPositions: nextClosedPositions
            },
            ipAddress: closeAuditMeta.ipAddress,
            correlationId: closeAuditMeta.correlationId
        });

        const updatedRequest = await buildHiringRequestDetailsQuery(req.companyId, existingRequest._id).lean();

        res.status(200).json(serializeHiringRequestResponse(updatedRequest || existingRequest.toObject(), req.user));

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

        const userPermissions = getUserPermissionKeys(req.user);
        const hasAccess = await canAccessHiringRequest(request, req.companyId, req.user, { action: 'manage' });
        const canManageVisibility = hasAccess
            || userPermissions.includes('ta.manage')
            || userPermissions.includes('ta.config.edit')
            || userPermissions.includes('*');

        if (!canManageVisibility) {
            return res.status(403).json({ message: 'Forbidden: You do not have permission to update this request' });
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
            const visibilityAuditMeta = buildAuditMeta(req);
            await HRRAuditLog.insertMany(auditEvents.map((event) => ({
                hiringRequestId: request._id,
                companyId: visibilityAuditMeta.companyId,
                action: event.action,
                performedBy: visibilityAuditMeta.performedBy,
                resourceType: 'HiringRequest',
                resourceId: request._id,
                permissionKey: userPermissions.includes('ta.manage')
                    ? 'ta.manage'
                    : (userPermissions.includes('ta.config.edit') ? 'ta.config.edit' : 'ta.requisition.update'),
                scope: 'resource',
                ipAddress: visibilityAuditMeta.ipAddress,
                correlationId: visibilityAuditMeta.correlationId,
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
            job: serializeHiringRequestResponse(updatedRequest || request.toObject(), req.user),
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
        const { dateField, startDate, endDate } = req.query;
        const currentReq = await HiringRequest.findOne({ _id: id, companyId: req.companyId })
            .select('previousRequestId createdBy ownership approvalChain assignedUsers');
        if (!currentReq) {
            return res.status(404).json({ message: 'Hiring request not found' });
        }

        const hasAccess = await canAccessHiringRequest(currentReq, req.companyId, req.user, { action: 'edit' });
        if (!hasAccess) {
            return res.status(403).json({ message: 'Forbidden: You do not have permission to view this request' });
        }

        if (!currentReq.previousRequestId) {
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
            legacyRequisitions.map(async (legacyRequisition) => {
                const candidateQuery = await buildAccessibleCandidateQuery(req.companyId, req.user, {
                    hiringRequestId: legacyRequisition._id
                }, { capability: TA_CAPABILITIES.VIEW });

                applyDateRangeFilterToCandidateQuery(candidateQuery, dateField, startDate, endDate);

                const candidates = await Candidate.find(candidateQuery)
                    .populate('uploadedBy', 'firstName lastName email')
                    .populate('hiringRequestId', 'requestId roleDetails')
                    .populate('interviewRounds.assignedTo', 'firstName lastName email')
                    .populate('interviewRounds.evaluatedBy', 'firstName lastName')
                    .lean();
                return {
                    requisition: {
                        _id: legacyRequisition._id,
                        requestId: legacyRequisition.requestId,
                        status: legacyRequisition.status,
                        createdAt: legacyRequisition.createdAt,
                        closedAt: legacyRequisition.closedAt,
                        title: legacyRequisition.roleDetails?.title
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
        const candidate = await Candidate.findOne({ _id: candidateId, companyId: req.companyId });

        if (!candidate) return res.status(404).json({ message: 'Candidate not found' });

        if (!(await canAccessCandidate(candidate, req.user, { companyId: req.companyId, capability: TA_CAPABILITIES.TRANSFER }))) {
            return res.status(403).json({ message: 'Forbidden: You do not have permission to transfer this candidate' });
        }

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
            hiringRequestId: newestReqId,
            companyId: req.companyId
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

exports.transferCandidateToRequisition = async (req, res) => {
    try {
        const result = await transferCandidateToTargetRequisition({
            candidateId: req.params.candidateId,
            targetRequisitionId: req.params.targetRequisitionId,
            companyId: req.companyId,
            user: req.user
        });

        res.status(201).json({
            message: 'Candidate transferred successfully',
            candidate: result.newCandidate,
            from: result.candidate.hiringRequestId,
            to: result.targetRequest._id
        });
    } catch (error) {
        console.error('transferCandidateToRequisition error:', error);
        res.status(error.statusCode || 500).json({ message: error.message || 'Failed to transfer candidate' });
    }
};

exports.transferCandidatesBulk = async (req, res) => {
    try {
        const transfers = Array.isArray(req.body?.transfers) ? req.body.transfers : [];
        if (!transfers.length) {
            return res.status(400).json({ message: 'At least one transfer item is required.' });
        }

        let transferred = 0;
        let skipped = 0;
        const errors = [];

        for (const item of transfers) {
            try {
                const candidate = await Candidate.findOne({ _id: item.candidateId, companyId: req.companyId }).lean();
                if (!candidate) {
                    throw Object.assign(new Error('Candidate not found.'), { statusCode: 404 });
                }

                if (item.fromRequisitionId && candidate.hiringRequestId?.toString() !== String(item.fromRequisitionId)) {
                    throw Object.assign(new Error('Candidate does not belong to the provided source requisition.'), { statusCode: 400 });
                }

                await transferCandidateToTargetRequisition({
                    candidateId: item.candidateId,
                    targetRequisitionId: item.toRequisitionId,
                    companyId: req.companyId,
                    user: req.user
                });
                transferred += 1;
            } catch (error) {
                skipped += 1;
                errors.push({
                    candidateId: item.candidateId,
                    reason: error.message || 'Transfer failed'
                });
            }
        }

        res.status(200).json({ transferred, skipped, errors });
    } catch (error) {
        console.error('transferCandidatesBulk error:', error);
        res.status(500).json({ message: 'Failed to bulk transfer candidates', error: error.message });
    }
};

exports.sendMassMail = async (req, res) => {
    try {
        const result = await sendMassMailForHiringRequest({
            companyId: req.companyId,
            user: req.user,
            hiringRequestId: req.params.id,
            emailAccountId: req.body?.emailAccountId,
            templateId: req.body?.templateId,
            customSubject: req.body?.customSubject,
            customHtmlBody: req.body?.customHtmlBody,
            candidateIds: req.body?.candidateIds,
            filters: req.body?.filters,
            customNote: req.body?.customNote
        });

        res.status(200).json(result);
    } catch (error) {
        console.error('sendMassMail error:', error);
        res.status(error.statusCode || 500).json({ message: error.message || 'Failed to send mass mail' });
    }
};

exports.sendMassMailBulk = async (req, res) => {
    try {
        const hiringRequestIds = Array.isArray(req.body?.hiringRequestIds) ? req.body.hiringRequestIds : [];
        if (!hiringRequestIds.length) {
            return res.status(400).json({ message: 'At least one hiring request is required.' });
        }

        const selectionMap = new Map(
            (Array.isArray(req.body?.candidateSelections) ? req.body.candidateSelections : [])
                .map((item) => [String(item.hiringRequestId), Array.isArray(item.candidateIds) ? item.candidateIds : []])
        );

        const results = [];
        let sent = 0;
        let failed = 0;
        const failedEmails = [];

        for (const hiringRequestId of hiringRequestIds) {
            try {
                const result = await sendMassMailForHiringRequest({
                    companyId: req.companyId,
                    user: req.user,
                    hiringRequestId,
                    emailAccountId: req.body?.emailAccountId,
                    templateId: req.body?.templateId,
                    customSubject: req.body?.customSubject,
                    customHtmlBody: req.body?.customHtmlBody,
                    candidateIds: selectionMap.get(String(hiringRequestId)) || [],
                    filters: req.body?.filters,
                    customNote: req.body?.customNote
                });

                results.push(result);
                sent += result.sent;
                failed += result.failed;
                failedEmails.push(...result.failedEmails);
            } catch (error) {
                results.push({
                    hiringRequestId,
                    sent: 0,
                    failed: 0,
                    failedEmails: [],
                    error: error.message || 'Failed to send mail for this requisition'
                });
            }
        }

        res.status(200).json({ sent, failed, failedEmails, results });
    } catch (error) {
        console.error('sendMassMailBulk error:', error);
        res.status(500).json({ message: 'Failed to send bulk mass mail', error: error.message });
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

        const accessibleHiringRequestQuery = await buildAnalyticsHiringRequestQuery(req.companyId, req.user);

        // Fetch all hiring requests for this client mainly to build the dropdown list
        const allClientReqs = await HiringRequest.find({
            ...accessibleHiringRequestQuery,
            client: clientName
        }).select('_id roleDetails.title status createdAt closedAt client').lean();

        const hrQuery = {
            ...accessibleHiringRequestQuery,
            client: clientName
        };
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
        const candidates = await Candidate.find({
            companyId: req.companyId,
            hiringRequestId: { $in: hrIds }
        }).lean();

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
            const isProfileShared = c.profileShared === true || (c.profileShared == null && c.decision === 'Shortlisted');
            // Drop-offs first
            if (
                c.decision === 'Rejected' ||
                c.decision === 'Did Not Turn Up' ||
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

            if (isProfileShared) {
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
        const {
            client,
            department,
            position,
            pulledBy,
            uploadedBy,
            calledBy,
            startDate,
            endDate,
            phase,
            requisitionId
        } = req.query;
        const pulledByFilter = String(pulledBy || '').trim();
        const uploadedByFilter = String(uploadedBy || '').trim();
        const calledByFilter = String(calledBy || '').trim();
        const hasCandidateOwnerFilter = Boolean(pulledByFilter || uploadedByFilter || calledByFilter);

        const accessibleHiringRequestQuery = await buildAnalyticsHiringRequestQuery(req.companyId, req.user);
        const filteredHiringRequestQuery = { ...accessibleHiringRequestQuery };

        if (client) filteredHiringRequestQuery.client = new RegExp(client, 'i');
        if (department) filteredHiringRequestQuery['roleDetails.department'] = new RegExp(department, 'i');
        if (position) filteredHiringRequestQuery['roleDetails.title'] = new RegExp(position, 'i');

        const [accessibleHiringRequests, allHiringRequests] = await Promise.all([
            HiringRequest.find(accessibleHiringRequestQuery)
                .select('_id roleDetails.department roleDetails.title client hiringDetails status createdAt closedAt')
                .lean(),
            HiringRequest.find(filteredHiringRequestQuery)
                .select('_id roleDetails.department roleDetails.title client hiringDetails status createdAt closedAt')
                .lean()
        ]);

        const requisitionsList = accessibleHiringRequests.map(hr => ({
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
        const hiringRequestMap = new Map(hiringRequests.map((hr) => [hr._id.toString(), hr]));

        let candidateQuery = {
            companyId: req.companyId,
            hiringRequestId: { $in: hrIds }
        };
        if (startDate || endDate) {
            candidateQuery.createdAt = {};
            if (startDate) candidateQuery.createdAt.$gte = new Date(startDate);
            if (endDate) candidateQuery.createdAt.$lte = new Date(endDate);
        }
        const candidates = await Candidate.find(candidateQuery)
            .populate('hiringRequestId', 'client roleDetails.title roleDetails.department status createdAt closedAt hiringDetails')
            .populate('uploadedBy', 'firstName lastName')
            .lean();

        const canViewSharedCandidateData = hasGlobalTAAnalyticsAccess(req.user) || Boolean(req.user?._id);

        const publicApplications = hasCandidateOwnerFilter || !canViewSharedCandidateData ? [] : await (async () => {
            const publicApplicationQuery = {
                companyId: req.companyId,
                hiringRequestId: { $in: hrIds },
                reviewStatus: { $ne: 'Transferred' }
            };

            if (startDate || endDate) {
                publicApplicationQuery.createdAt = {};
                if (startDate) publicApplicationQuery.createdAt.$gte = new Date(startDate);
                if (endDate) publicApplicationQuery.createdAt.$lte = new Date(endDate);
            }

            return PublicApplication.find(publicApplicationQuery)
                .select('hiringRequestId createdAt source')
                .lean();
        })();

        // Process candidate sourcing owner names correctly for filtering and display
        const getCandidatePulledByName = (c) => {
            if (c.profilePulledBy) return c.profilePulledBy;
            if (c.uploadedBy) return `${c.uploadedBy.firstName || ''} ${c.uploadedBy.lastName || ''}`.trim();
            return 'Self/Other';
        };

        const getCandidateUploadedByName = (c) => (
            c.uploadedBy
                ? `${c.uploadedBy.firstName || ''} ${c.uploadedBy.lastName || ''}`.trim()
                : ''
        );

        const normalizeAnalyticsValue = (value) => String(value || '').trim().toLowerCase();

        let filteredCandidates = candidates.filter((candidateDoc) => {
            const pulledByName = normalizeAnalyticsValue(getCandidatePulledByName(candidateDoc));
            const uploadedByName = normalizeAnalyticsValue(getCandidateUploadedByName(candidateDoc));
            const calledByName = normalizeAnalyticsValue(candidateDoc.calledBy);

            const matchesPulledBy = !pulledByFilter || pulledByName === normalizeAnalyticsValue(pulledByFilter);
            const matchesUploadedBy = !uploadedByFilter || uploadedByName === normalizeAnalyticsValue(uploadedByFilter);
            const matchesCalledBy = !calledByFilter || calledByName === normalizeAnalyticsValue(calledByFilter);

            return matchesPulledBy && matchesUploadedBy && matchesCalledBy;
        });

        const activeCandidates = filteredCandidates;

        // Identify active hiring requests after filtering candidates
        // This ensures stats like "Total Requisitions" match the filtered candidate activity
        const activeHrIds = [...new Set([
            ...activeCandidates.map(c => c.hiringRequestId?._id?.toString()).filter(Boolean),
            ...publicApplications.map(app => app.hiringRequestId?.toString()).filter(Boolean)
        ])];
        const activeHrSet = new Set(activeHrIds);

        const filteredHiringRequests = (startDate || endDate || hasCandidateOwnerFilter)
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
        const sourcingPerf = {};
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
        const metricTrendBuckets = {};

        const getMonthKey = (value) => {
            if (!value) return '';
            const date = new Date(value);
            if (Number.isNaN(date.getTime())) return '';
            return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
        };

        const ensureMetricTrendBucket = (month) => {
            if (!month) return null;

            if (!metricTrendBuckets[month]) {
                metricTrendBuckets[month] = {
                    sourced: 0,
                    offersReleased: 0,
                    joined: 0,
                    hiresWithTime: 0,
                    totalTimeToHire: 0,
                    closedReqsCount: 0,
                    totalTimeToFill: 0
                };
            }

            return metricTrendBuckets[month];
        };

        activeCandidates.forEach(c => {
            const hrInfo = c.hiringRequestId || {};
            const dept = hrInfo.roleDetails?.department || 'General';
            const clientName = hrInfo.client || 'General';
            const reqId = hrInfo._id?.toString() || 'Unknown';
            const recName = getCandidatePulledByName(c);
            const src = c.source || 'Direct';

            const monthObj = new Date(c.createdAt || new Date());
            const month = `${monthObj.getFullYear()}-${String(monthObj.getMonth() + 1).padStart(2, '0')}`;
            if (!monthlyTrend[month]) monthlyTrend[month] = { sourced: 0, interviews: 0, offers: 0, joined: 0 };
            monthlyTrend[month].sourced++;
            const sourcedTrendBucket = ensureMetricTrendBucket(month);
            if (sourcedTrendBucket) {
                sourcedTrendBucket.sourced++;
            }

            if (!deptAnalysis[dept]) deptAnalysis[dept] = { sourced: 0, interviewed: 0, offered: 0, joined: 0 };
            if (!clientAnalysis[clientName]) clientAnalysis[clientName] = { sourced: 0, interviewed: 0, offered: 0, joined: 0 };
            if (!sourcingPerf[recName]) sourcingPerf[recName] = { sourced: 0, interviews: 0, offers: 0, joined: 0 };
            if (!sourceAnalysis[src]) sourceAnalysis[src] = { sourced: 0, joined: 0 };
            if (!positionPerf[reqId]) positionPerf[reqId] = { title: hrInfo.roleDetails?.title || 'Unknown', client: clientName, open: hrInfo.hiringDetails?.openPositions || 1, sourced: 0, interviewed: 0, offered: 0, joined: 0 };

            deptAnalysis[dept].sourced++;
            clientAnalysis[clientName].sourced++;
            sourcingPerf[recName].sourced++;
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
                sourcingPerf[recName].interviews++;
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
            else if (c.profileShared === true || (c.profileShared == null && c.decision === 'Shortlisted')) pipeline['Ph 2 Shortlisted']++;
            else if (c.decision === 'Shortlisted') pipeline['Ph 1 Shortlisted']++;
            else pipeline['Sourced']++;

            if (['Offer Sent', 'Offer Accepted', 'Joined'].includes(c.phase3Decision) && c.phase2Decision === 'Selected') {
                funnel.offer++;
                offersReleased++;
                deptAnalysis[dept].offered++;
                clientAnalysis[clientName].offered++;
                sourcingPerf[recName].offers++;
                positionPerf[reqId].offered++;
                monthlyTrend[month].offers++;

                const offerDate = c.statusHistory?.find(h => h.status === 'Offer Released')?.changedAt || c.updatedAt;
                const offerTrendBucket = ensureMetricTrendBucket(getMonthKey(offerDate));
                if (offerTrendBucket) {
                    offerTrendBucket.offersReleased++;
                }
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
                sourcingPerf[recName].joined++;
                sourceAnalysis[src].joined++;
                positionPerf[reqId].joined++;
                monthlyTrend[month].joined++;

                const joinDate = c.statusHistory?.find(h => h.status === 'Joined')?.changedAt || c.updatedAt;
                const offerDate = c.statusHistory?.find(h => h.status === 'Offer Released')?.changedAt;
                const joinedTrendBucket = ensureMetricTrendBucket(getMonthKey(joinDate));
                if (joinedTrendBucket) {
                    joinedTrendBucket.joined++;
                }
                if (joinDate && offerDate) {
                    offerToJoinTime += (new Date(joinDate) - new Date(offerDate)) / (1000 * 60 * 60 * 24);
                    joinedAfterOfferCount++;
                }

                if (joinDate && c.createdAt) {
                    const timeToHireDays = (new Date(joinDate) - new Date(c.createdAt)) / (1000 * 60 * 60 * 24);
                    sumTimeToHireDays += timeToHireDays;
                    hiresWithTime++;
                    const trendBucket = ensureMetricTrendBucket(getMonthKey(joinDate));
                    if (trendBucket) {
                        trendBucket.totalTimeToHire += timeToHireDays;
                        trendBucket.hiresWithTime++;
                    }
                }
            }
        });

        publicApplications.forEach((application) => {
            const hrInfo = hiringRequestMap.get(application.hiringRequestId?.toString()) || {};
            const dept = hrInfo.roleDetails?.department || 'General';
            const clientName = hrInfo.client || 'General';
            const reqId = hrInfo._id?.toString() || 'Unknown';
            const src = application.source || 'Public Applications';

            const monthObj = new Date(application.createdAt || new Date());
            const month = `${monthObj.getFullYear()}-${String(monthObj.getMonth() + 1).padStart(2, '0')}`;

            if (!monthlyTrend[month]) monthlyTrend[month] = { sourced: 0, interviews: 0, offers: 0, joined: 0 };
            if (!deptAnalysis[dept]) deptAnalysis[dept] = { sourced: 0, interviewed: 0, offered: 0, joined: 0 };
            if (!clientAnalysis[clientName]) clientAnalysis[clientName] = { sourced: 0, interviewed: 0, offered: 0, joined: 0 };
            if (!sourceAnalysis[src]) sourceAnalysis[src] = { sourced: 0, joined: 0 };
            if (!positionPerf[reqId]) {
                positionPerf[reqId] = {
                    title: hrInfo.roleDetails?.title || 'Unknown',
                    client: clientName,
                    open: hrInfo.hiringDetails?.openPositions || 1,
                    sourced: 0,
                    interviewed: 0,
                    offered: 0,
                    joined: 0
                };
            }

            monthlyTrend[month].sourced++;
            const applicationTrendBucket = ensureMetricTrendBucket(month);
            if (applicationTrendBucket) {
                applicationTrendBucket.sourced++;
            }
            deptAnalysis[dept].sourced++;
            clientAnalysis[clientName].sourced++;
            sourceAnalysis[src].sourced++;
            positionPerf[reqId].sourced++;
        });

        // Time to fill (req based)
        filteredHiringRequests.forEach(hr => {
            if (hr.status === 'Closed' && hr.closedAt && hr.createdAt) {
                const timeToFillDays = (new Date(hr.closedAt) - new Date(hr.createdAt)) / (1000 * 60 * 60 * 24);
                totalTimeToFill += timeToFillDays;
                closedReqsCount++;
                const trendBucket = ensureMetricTrendBucket(getMonthKey(hr.closedAt));
                if (trendBucket) {
                    trendBucket.totalTimeToFill += timeToFillDays;
                    trendBucket.closedReqsCount++;
                }
            }
        });

        // Phase-specific metric overrides
        let displayMetrics = {
            totalReqs: filteredHiringRequests.length,
            totalOpenPositions,
            totalSourced: activeCandidates.length + publicApplications.length,
            interviewsScheduled,
            offersReleased,
            totalJoined,
            offerAcceptanceRate: offersReleased > 0 ? ((totalJoined / offersReleased) * 100).toFixed(1) : 0,
            joiningConversionRate: (activeCandidates.length + publicApplications.length) > 0 ? ((totalJoined / (activeCandidates.length + publicApplications.length)) * 100).toFixed(1) : 0,
            avgTimeToHire: hiresWithTime > 0 ? Math.round(sumTimeToHireDays / hiresWithTime) : 0,
            avgTimeToFill: closedReqsCount > 0 ? Math.round(totalTimeToFill / closedReqsCount) : 0
        };

        if (phase === '1') {
            const ph1Shortlisted = activeCandidates.filter(c => c.decision === 'Shortlisted').length;
            displayMetrics = {
                ...displayMetrics,
                totalSourced: activeCandidates.length + publicApplications.length,
                interviewsScheduled: activeCandidates.filter(c => c.interviewRounds?.some(r => r.phase === 1 && ['Scheduled', 'Passed', 'Failed'].includes(r.status))).length,
                ph1Shortlisted,
                conversionRate: (activeCandidates.length + publicApplications.length) > 0 ? ((ph1Shortlisted / (activeCandidates.length + publicApplications.length)) * 100).toFixed(1) : 0
            };
        } else if (phase === '2') {
            const ph1Selected = activeCandidates.filter(c => c.profileShared === true || (c.profileShared == null && c.decision === 'Shortlisted')).length;
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
        const metricTrendMonths = Object.keys(metricTrendBuckets).sort();
        const latestMetricTrendMonth = metricTrendMonths[metricTrendMonths.length - 1];
        const previousMetricTrendMonth = metricTrendMonths[metricTrendMonths.length - 2];
        const latestMetricTrendBucket = latestMetricTrendMonth ? metricTrendBuckets[latestMetricTrendMonth] : null;
        const previousMetricTrendBucket = previousMetricTrendMonth ? metricTrendBuckets[previousMetricTrendMonth] : null;

        const getBucketMetricValue = (bucket, metricName) => {
            if (!bucket) return 0;

            switch (metricName) {
                case 'offerAcceptanceRate':
                    return bucket.offersReleased > 0 ? (bucket.joined / bucket.offersReleased) * 100 : 0;
                case 'joiningConversionRate':
                    return bucket.sourced > 0 ? (bucket.joined / bucket.sourced) * 100 : 0;
                case 'avgTimeToHire':
                    return bucket.hiresWithTime > 0 ? bucket.totalTimeToHire / bucket.hiresWithTime : 0;
                case 'avgTimeToFill':
                    return bucket.closedReqsCount > 0 ? bucket.totalTimeToFill / bucket.closedReqsCount : 0;
                default:
                    return 0;
            }
        };

        const buildMetricTrend = (metricName, { lowerIsBetter = false } = {}) => {
            const currentValue = getBucketMetricValue(latestMetricTrendBucket, metricName);
            const previousValue = getBucketMetricValue(previousMetricTrendBucket, metricName);
            const delta = previousValue === 0
                ? (currentValue === 0 ? 0 : 100)
                : ((currentValue - previousValue) / Math.abs(previousValue)) * 100;
            const roundedDelta = Number(Math.abs(delta).toFixed(1));
            const direction = delta > 0 ? 'up' : delta < 0 ? 'down' : 'flat';
            const improved = direction === 'flat' ? null : (lowerIsBetter ? direction === 'down' : direction === 'up');

            return {
                delta: roundedDelta,
                direction,
                improved,
                current: Number(currentValue.toFixed(1)),
                previous: Number(previousValue.toFixed(1))
            };
        };

        const metricTrends = {
            offerAcceptanceRate: buildMetricTrend('offerAcceptanceRate'),
            joiningConversionRate: buildMetricTrend('joiningConversionRate'),
            avgTimeToHire: buildMetricTrend('avgTimeToHire', { lowerIsBetter: true }),
            avgTimeToFill: buildMetricTrend('avgTimeToFill', { lowerIsBetter: true })
        };

        const filterOptions = {
            clients: [...new Set(accessibleHiringRequests.map(hr => hr.client).filter(Boolean))].sort(),
            departments: [...new Set(accessibleHiringRequests.map(hr => hr.roleDetails?.department).filter(Boolean))].sort(),
            positions: [...new Set(accessibleHiringRequests.map(hr => hr.roleDetails?.title).filter(Boolean))].sort(),
            pulledBys: [...new Set(candidates.map(c => getCandidatePulledByName(c)).filter(Boolean))].sort(),
            uploadedBys: [...new Set(candidates.map(c => getCandidateUploadedByName(c)).filter(Boolean))].sort(),
            calledBys: [...new Set(candidates.map(c => String(c.calledBy || '').trim()).filter(Boolean))].sort(),
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
                sourcingPerformance: Object.keys(sourcingPerf)
                    .map(r => ({
                        name: r,
                        ...sourcingPerf[r],
                        conversion: sourcingPerf[r].sourced > 0 ? ((sourcingPerf[r].joined / sourcingPerf[r].sourced) * 100).toFixed(1) : 0
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
                metricTrends,
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
        const query = await buildAccessibleHiringRequestQuery(req.companyId, req.user, { action: 'view' });
        
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
