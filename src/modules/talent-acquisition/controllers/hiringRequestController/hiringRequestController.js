const path = require('path');
const fs = require('fs');
const mongoose = require('mongoose');
const { HiringRequest } = require('../../model/hiringRequest.model');
const ApprovalWorkflow = require('../../../workflow/approvalWorkflow.model');
const User = require('../../../user/user.model');
const Candidate = require('../../model/candidate.model');
const Company = require('../../../company/company.model');
const SequenceCounter = require('../../../workflow/sequenceCounter.model');
const NotificationService = require('../../../../services/notificationService');
const { copyTemplatePhasesForHiringRequest } = require('../../utils/phaseTemplateUtils');
const {
    buildAccessibleHiringRequestQuery,
    canAccessHiringRequest,
    evaluateHiringRequestRejectionAction
} = require('../../utils/hiringRequestAccess');
const {
    getClientAssignedUserIds,
    mergeAssignedUsersWithClientAssignments
} = require('../../../client/clientAssignmentSync');

const HIRING_REQUEST_SEQUENCE_KEY = 'hiring_request';

const parseBooleanQueryValue = (val) => {
    if (val === true || val === 'true' || val === 1 || val === '1') return true;
    if (val === false || val === 'false' || val === 0 || val === '0') return false;
    return undefined;
};

const formatHiringRequestId = (counter) => {
    return `REQ-${String(counter).padStart(4, '0')}`;
};

const getNextHiringRequestId = async (companyId, session = null) => {
    const counter = await SequenceCounter.getNextSequence(
        companyId,
        HIRING_REQUEST_SEQUENCE_KEY,
        1,
        session
    );
    return formatHiringRequestId(counter);
};

const populateFullHiringRequestDoc = (query) => {
    return query
        .populate('requestor', 'firstName lastName email employeeCode profilePicture')
        .populate('createdBy', 'firstName lastName email employeeCode profilePicture')
        .populate('ownership.hiringManager', 'firstName lastName email employeeCode profilePicture')
        .populate('recruitmentTeam.hiringManager', 'firstName lastName email employeeCode profilePicture')
        .populate('recruitmentTeam.assignedRecruiters', 'firstName lastName email employeeCode profilePicture')
        .populate('approvalChain.specificApprover', 'firstName lastName email employeeCode profilePicture')
        .populate('approvalChain.actionBy', 'firstName lastName email employeeCode profilePicture')
        .populate('approvalChain.approvedBy', 'firstName lastName email employeeCode profilePicture')
        .populate('approvalChain.approvers', 'firstName lastName email employeeCode profilePicture')
        .populate('assignedUsers', 'firstName lastName email employeeCode profilePicture')
        .populate('analyticsViewers', 'firstName lastName email employeeCode profilePicture')
        .populate('previousRequestId', 'requestId roleDetails status isPublic isJobVisible isResourceGatewayPublic wasEverPublished createdAt')
        .populate('reopenedToId', 'requestId roleDetails status isPublic isJobVisible isResourceGatewayPublic wasEverPublished createdAt');
};

exports.createHiringRequest = async (req, res) => {
    try {
        const {
            roleDetails,
            employmentDetails,
            hiringDetails,
            requirements,
            recruitmentTeam,
            approvalChain,
            jdFileUrl,
            jdPublicId,
            jdText,
            remarks,
            client
        } = req.body;

        const requestingUserId = req.user._id;
        const isDraft = req.query.submit === 'false' || req.body.submit === false;

        let jobTitle = (roleDetails?.title || roleDetails?.jobTitle || req.body.jobTitle || '').trim();
        let numberOfPositions = hiringDetails?.openPositions ?? hiringDetails?.numberOfOpenings ?? employmentDetails?.numberOfPositions ?? req.body.openPositions ?? req.body.numberOfPositions;
        let workLocation = (requirements?.location || requirements?.workLocation || employmentDetails?.workLocation || req.body.location || '').trim();

        if (isDraft) {
            if (!jobTitle) jobTitle = 'Untitled Position';
            if (numberOfPositions === undefined || numberOfPositions === null || isNaN(Number(numberOfPositions))) numberOfPositions = 1;
            if (!workLocation) workLocation = 'Not Specified';
        }

        if (!jobTitle || numberOfPositions === undefined || numberOfPositions === null || isNaN(Number(numberOfPositions)) || !workLocation) {
            return res.status(400).json({ message: 'Job title, number of positions, and work location are required' });
        }

        const normalizedClientName = client ? client.trim() : 'General';

        const assignedRecruiters = await mergeAssignedUsersWithClientAssignments({
            companyId: req.companyId,
            clientName: normalizedClientName,
            assignedUsers: recruitmentTeam?.assignedRecruiters || []
        });

        const rawWorkflowId = req.body.workflowId;
        const rawInterviewWorkflowId = req.body.interviewWorkflowId;

        const validWorkflowId = (rawWorkflowId && mongoose.Types.ObjectId.isValid(rawWorkflowId))
            ? new mongoose.Types.ObjectId(rawWorkflowId)
            : null;

        const validInterviewWorkflowId = (rawInterviewWorkflowId && mongoose.Types.ObjectId.isValid(rawInterviewWorkflowId))
            ? new mongoose.Types.ObjectId(rawInterviewWorkflowId)
            : null;

        let workflow = null;
        if (validWorkflowId) {
            workflow = await ApprovalWorkflow.findOne({
                _id: validWorkflowId,
                companyId: req.companyId,
                isActive: true
            });
        }
        if (!workflow) {
            workflow = await ApprovalWorkflow.findOne({
                companyId: req.companyId,
                module: { $in: ['TA', 'talent_acquisition'] },
                isActive: true
            });
        }

        let previousReq = null;
        if (req.body.previousRequestId && mongoose.Types.ObjectId.isValid(req.body.previousRequestId)) {
            previousReq = await HiringRequest.findOne({
                _id: req.body.previousRequestId,
                companyId: req.companyId
            });
        }

        let hiringRequestData = {
            ...req.body,
            companyId: req.companyId,
            requestor: requestingUserId,
            createdBy: requestingUserId,
            client: normalizedClientName,
            workflowId: validWorkflowId || (workflow ? workflow._id : null),
            interviewWorkflowId: validInterviewWorkflowId,
            previousRequestId: previousReq ? previousReq._id : undefined,
            isPublic: req.body.isPublic !== undefined ? Boolean(req.body.isPublic) : (previousReq ? Boolean(previousReq.isPublic) : false),
            isJobVisible: req.body.isJobVisible !== undefined ? Boolean(req.body.isJobVisible) : (previousReq ? Boolean(previousReq.isJobVisible ?? previousReq.isPublic) : false),
            isResourceGatewayPublic: req.body.isResourceGatewayPublic !== undefined ? Boolean(req.body.isResourceGatewayPublic) : (previousReq ? Boolean(previousReq.isResourceGatewayPublic) : false),
            wasEverPublished: req.body.wasEverPublished !== undefined ? Boolean(req.body.wasEverPublished) : (previousReq ? Boolean(previousReq.wasEverPublished || previousReq.isPublic) : false),
            roleDetails: {
                department: 'General',
                employmentType: 'Full-time',
                ...roleDetails,
                title: jobTitle
            },
            purpose: req.body.purpose || 'New Position',
            requirements: {
                ...requirements,
                location: workLocation
            },
            hiringDetails: {
                openPositions: Number(numberOfPositions),
                originalOpenPositions: Number(numberOfPositions),
                ...hiringDetails
            },
            ownership: {
                hiringManager: req.body.ownership?.hiringManager || requestingUserId,
                interviewPanel: req.body.ownership?.interviewPanel || []
            },
            recruitmentTeam: {
                ...recruitmentTeam,
                assignedRecruiters
            },
            jdFileUrl,
            jdPublicId,
            jdText,
            remarks
        };

        const isSubmit = parseBooleanQueryValue(req.query.submit) ?? true;

        if (!isSubmit) {
            hiringRequestData.status = 'Draft';
            hiringRequestData.currentApprovalLevel = 1;
        } else if (workflow && Array.isArray(workflow.levels) && workflow.levels.length > 0) {
            hiringRequestData.status = 'Pending Approval';
            hiringRequestData.currentApprovalLevel = 1;
            hiringRequestData.workflowId = workflow._id;

            hiringRequestData.approvalChain = workflow.levels.map((lvl, index) => {
                const approverList = (Array.isArray(lvl.approvers) && lvl.approvers.length > 0)
                    ? lvl.approvers
                    : (lvl.specificUser ? [lvl.specificUser] : []);
                return {
                    level: lvl.levelCheck || (index + 1),
                    role: lvl.role,
                    approvers: approverList,
                    specificApprover: approverList[0] || lvl.specificUser || null,
                    status: 'Pending'
                };
            });
        } else if (approvalChain && Array.isArray(approvalChain) && approvalChain.length > 0) {
            hiringRequestData.status = 'Pending Approval';
            hiringRequestData.currentApprovalLevel = 1;
            hiringRequestData.approvalChain = approvalChain.map((approver, index) => {
                const specApp = approver.userId || approver.specificApprover || null;
                const approverList = (Array.isArray(approver.approvers) && approver.approvers.length > 0)
                    ? approver.approvers
                    : (specApp ? [specApp] : []);
                return {
                    level: approver.level || (index + 1),
                    specificApprover: specApp,
                    approvers: approverList,
                    status: 'Pending'
                };
            });
        } else {
            const defaultApprover = req.body.ownership?.hiringManager || requestingUserId;
            hiringRequestData.status = 'Pending Approval';
            hiringRequestData.currentApprovalLevel = 1;
            hiringRequestData.approvalChain = [{
                level: 1,
                specificApprover: defaultApprover,
                approvers: [defaultApprover],
                status: 'Pending'
            }];
        }

        let savedRequest = null;
        let retryCount = 0;
        const maxRetries = 3;

        while (!savedRequest && retryCount < maxRetries) {
            try {
                const requestId = await getNextHiringRequestId(req.companyId);
                const hiringRequest = new HiringRequest({
                    ...hiringRequestData,
                    requestId
                });
                savedRequest = await hiringRequest.save();
            } catch (err) {
                if (err.code === 11000 && err.keyPattern?.requestId) {
                    retryCount++;
                    if (retryCount >= maxRetries) {
                        throw new Error('Failed to generate unique Hiring Request ID. Please try again.');
                    }
                } else {
                    throw err;
                }
            }
        }

        if (previousReq) {
            await HiringRequest.findByIdAndUpdate(previousReq._id, {
                reopenedToId: savedRequest._id
            });
        }

        try {
            await copyTemplatePhasesForHiringRequest(savedRequest, req.companyId, req.user._id);
        } catch (copyErr) {
            console.error('Failed to copy default phase templates:', copyErr);
        }

        if (savedRequest.status === 'Pending Approval') {
            const io = req.app.get('io');
            const firstLevel = savedRequest.approvalChain.find(item => item.level === 1);
            let approverUserIds = [];

            if (firstLevel?.specificApprover) {
                approverUserIds.push(firstLevel.specificApprover);
            } else if (firstLevel?.approverRole) {
                const usersWithRole = await User.find({
                    companyId: req.companyId,
                    roles: firstLevel.approverRole,
                    isActive: true
                }).select('_id');
                approverUserIds = usersWithRole.map(u => u._id);
            }

            for (const userId of approverUserIds) {
                await NotificationService.createNotification(io, {
                    user: userId,
                    companyId: req.companyId,
                    preferenceKey: 'ta_hiring_request_pending',
                    title: 'Hiring Request Approval Needed',
                    message: `A new Hiring Request (${savedRequest.requestId} - ${savedRequest.roleDetails.jobTitle}) requires your approval.`,
                    type: 'Approval',
                    link: `/talent-acquisition/hiring-requests/${savedRequest._id}`,
                    origin: req.headers.origin
                });
            }
        }

        res.status(201).json({
            message: savedRequest.status === 'Approved'
                ? 'Hiring request created and auto-approved successfully'
                : 'Hiring request created and submitted for approval',
            hiringRequest: savedRequest
        });

    } catch (error) {
        console.error('Error creating hiring request:', error);
        res.status(500).json({ message: 'Failed to create hiring request', error: error.message });
    }
};

exports.getHiringRequests = async (req, res) => {
    try {
        res.set('Cache-Control', 'private, max-age=30, stale-while-revalidate=30');
        const accessibleQuery = await buildAccessibleHiringRequestQuery(req.companyId, req.user);

        const { search, status, client, page, limit } = req.query;

        const filterQuery = { ...accessibleQuery };

        if (status && status !== 'All') {
            filterQuery.status = status;
        }

        if (client && client.trim()) {
            filterQuery.client = client.trim();
        }

        if (search && search.trim()) {
            const searchRegex = new RegExp(search.trim(), 'i');
            filterQuery.$or = [
                { requestId: searchRegex },
                { client: searchRegex },
                { 'roleDetails.title': searchRegex },
                { 'roleDetails.jobTitle': searchRegex },
                { 'roleDetails.department': searchRegex }
            ];
        }

        const totalRequests = await HiringRequest.countDocuments(filterQuery);

        const pageNum = parseInt(page, 10) || 1;
        const limitNum = parseInt(limit, 10) || (limit === 'all' ? Math.max(1, totalRequests) : 50);
        const totalPages = Math.ceil(totalRequests / limitNum) || 1;
        const skip = (pageNum - 1) * limitNum;

        const requests = await populateFullHiringRequestDoc(
            HiringRequest.find(filterQuery)
        )
            .sort({ createdAt: -1 })
            .skip(skip)
            .limit(limitNum)
            .lean();

        res.json({
            requests,
            totalPages,
            totalRequests,
            page: pageNum,
            limit: limitNum
        });
    } catch (error) {
        console.error('Error fetching hiring requests:', error);
        res.status(500).json({ message: 'Failed to fetch hiring requests', error: error.message });
    }
};

exports.getHiringRequestPhases = async (req, res) => {
    try {
        const hiringRequest = await HiringRequest.findOne({
            _id: req.params.id,
            companyId: req.companyId
        }).select('recruitmentPhases');

        if (!hiringRequest) {
            return res.status(404).json({ message: 'Hiring request not found' });
        }

        res.json(hiringRequest.recruitmentPhases || []);
    } catch (error) {
        console.error('Error fetching hiring request phases:', error);
        res.status(500).json({ message: 'Failed to fetch hiring request phases', error: error.message });
    }
};

exports.getHiringRequestById = async (req, res) => {
    try {
        const hiringRequest = await populateFullHiringRequestDoc(
            HiringRequest.findOne({
                _id: req.params.id,
                companyId: req.companyId
            })
        );

        if (!hiringRequest) {
            return res.status(404).json({ message: 'Hiring request not found' });
        }

        const hasAccess = await canAccessHiringRequest(hiringRequest, req.companyId, req.user);
        if (!hasAccess) {
            return res.status(403).json({ message: 'Forbidden: You do not have permission to view this hiring request' });
        }

        res.json(hiringRequest);
    } catch (error) {
        console.error('Error fetching hiring request:', error);
        res.status(500).json({ message: 'Failed to fetch hiring request', error: error.message });
    }
};

exports.updateHiringRequest = async (req, res) => {
    try {
        const hiringRequest = await HiringRequest.findOne({
            _id: req.params.id,
            companyId: req.companyId
        });

        if (!hiringRequest) {
            return res.status(404).json({ message: 'Hiring request not found' });
        }

        const hasAccess = await canAccessHiringRequest(hiringRequest, req.companyId, req.user);
        if (!hasAccess) {
            return res.status(403).json({ message: 'Forbidden: You do not have permission to update this hiring request' });
        }

        const {
            roleDetails,
            employmentDetails,
            recruitmentTeam,
            jdFileUrl,
            jdPublicId,
            jdText,
            remarks,
            recruitmentPhases,
            status,
            client
        } = req.body;

        if (roleDetails) hiringRequest.roleDetails = { ...(hiringRequest.roleDetails?.toObject?.() || hiringRequest.roleDetails || {}), ...roleDetails };
        if (employmentDetails) hiringRequest.employmentDetails = { ...(hiringRequest.employmentDetails?.toObject?.() || hiringRequest.employmentDetails || {}), ...employmentDetails };
        if (req.body.hiringDetails) hiringRequest.hiringDetails = { ...(hiringRequest.hiringDetails?.toObject?.() || hiringRequest.hiringDetails || {}), ...req.body.hiringDetails };
        if (req.body.requirements) hiringRequest.requirements = { ...(hiringRequest.requirements?.toObject?.() || hiringRequest.requirements || {}), ...req.body.requirements };

        if (req.body.workflowId !== undefined) {
            hiringRequest.workflowId = (req.body.workflowId && mongoose.Types.ObjectId.isValid(req.body.workflowId))
                ? req.body.workflowId
                : null;
        }
        if (req.body.interviewWorkflowId !== undefined) {
            hiringRequest.interviewWorkflowId = (req.body.interviewWorkflowId && mongoose.Types.ObjectId.isValid(req.body.interviewWorkflowId))
                ? req.body.interviewWorkflowId
                : null;
        }

        if (client !== undefined) {
            hiringRequest.client = client ? client.trim() : null;
        }

        if (recruitmentTeam) {
            const assignedRecruiters = await mergeAssignedUsersWithClientAssignments({
                companyId: req.companyId,
                clientName: hiringRequest.client,
                assignedUsers: recruitmentTeam.assignedRecruiters || []
            });

            hiringRequest.recruitmentTeam = {
                ...recruitmentTeam,
                assignedRecruiters
            };
        } else if (client !== undefined && hiringRequest.client) {
            const assignedRecruiters = await mergeAssignedUsersWithClientAssignments({
                companyId: req.companyId,
                clientName: hiringRequest.client,
                assignedUsers: hiringRequest.recruitmentTeam?.assignedRecruiters || []
            });

            hiringRequest.recruitmentTeam = {
                ...(hiringRequest.recruitmentTeam || {}),
                assignedRecruiters
            };
        }

        if (jdFileUrl !== undefined) hiringRequest.jdFileUrl = jdFileUrl;
        if (jdPublicId !== undefined) hiringRequest.jdPublicId = jdPublicId;
        if (jdText !== undefined) hiringRequest.jdText = jdText;
        if (remarks !== undefined) hiringRequest.remarks = remarks;

        if (recruitmentPhases && Array.isArray(recruitmentPhases)) {
            const existingPhasesMap = new Map();
            (hiringRequest.recruitmentPhases || []).forEach(phase => {
                if (phase && phase.phaseId) {
                    existingPhasesMap.set(phase.phaseId, phase);
                }
            });

            hiringRequest.recruitmentPhases = recruitmentPhases.map((phase, index) => {
                const phaseId = phase.phaseId || `phase_${Date.now()}_${index}`;
                const existingPhase = existingPhasesMap.get(phaseId);
                const isCustomPhase = phase.isCustomPhase !== undefined ? Boolean(phase.isCustomPhase) : Boolean(existingPhase?.isCustomPhase);

                return {
                    ...phase,
                    phaseId,
                    order: phase.order !== undefined ? Number(phase.order) : index + 1,
                    isCustomPhase,
                    isSystemDefault: isCustomPhase ? false : (phase.isSystemDefault !== undefined ? Boolean(phase.isSystemDefault) : (existingPhase?.isSystemDefault ?? true)),
                    subPhases: (phase.subPhases || []).map((subPhase, subIndex) => {
                        const subPhaseId = subPhase.subPhaseId || `sub_${Date.now()}_${subIndex}`;
                        const existingSubPhase = existingPhase?.subPhases?.find(sp => sp.subPhaseId === subPhaseId);
                        const isCustomSubPhase = subPhase.isCustomSubPhase !== undefined ? Boolean(subPhase.isCustomSubPhase) : Boolean(existingSubPhase?.isCustomSubPhase);

                        return {
                            ...subPhase,
                            subPhaseId,
                            order: subPhase.order !== undefined ? Number(subPhase.order) : subIndex + 1,
                            isCustomSubPhase,
                            isSystemDefault: isCustomSubPhase ? false : (subPhase.isSystemDefault !== undefined ? Boolean(subPhase.isSystemDefault) : (existingSubPhase?.isSystemDefault ?? true))
                        };
                    })
                };
            });
        }

        const isSubmit = parseBooleanQueryValue(req.query.submit);

        if (isSubmit === false || status === 'Draft') {
            hiringRequest.status = 'Draft';
        } else if (isSubmit === true || (hiringRequest.status === 'Draft' && !status)) {
            const rawWorkflowId = req.body.workflowId || hiringRequest.workflowId;
            let workflow = null;
            if (rawWorkflowId && mongoose.Types.ObjectId.isValid(rawWorkflowId)) {
                workflow = await ApprovalWorkflow.findOne({
                    _id: rawWorkflowId,
                    companyId: req.companyId,
                    isActive: true
                });
            }
            if (!workflow) {
                workflow = await ApprovalWorkflow.findOne({
                    companyId: req.companyId,
                    module: { $in: ['TA', 'talent_acquisition'] },
                    isActive: true
                });
            }

            hiringRequest.status = 'Pending Approval';
            hiringRequest.currentApprovalLevel = 1;

            if (workflow && Array.isArray(workflow.levels) && workflow.levels.length > 0) {
                hiringRequest.workflowId = workflow._id;
                hiringRequest.approvalChain = workflow.levels.map((lvl, index) => {
                    const approverList = (Array.isArray(lvl.approvers) && lvl.approvers.length > 0)
                        ? lvl.approvers
                        : (lvl.specificUser ? [lvl.specificUser] : []);
                    return {
                        level: lvl.levelCheck || (index + 1),
                        role: lvl.role,
                        approvers: approverList,
                        specificApprover: approverList[0] || lvl.specificUser || null,
                        status: 'Pending'
                    };
                });
            } else if (req.body.approvalChain && Array.isArray(req.body.approvalChain) && req.body.approvalChain.length > 0) {
                hiringRequest.approvalChain = req.body.approvalChain.map((approver, index) => {
                    const specApp = approver.userId || approver.specificApprover || null;
                    const approverList = (Array.isArray(approver.approvers) && approver.approvers.length > 0)
                        ? approver.approvers
                        : (specApp ? [specApp] : []);
                    return {
                        level: approver.level || (index + 1),
                        specificApprover: specApp,
                        approvers: approverList,
                        status: 'Pending'
                    };
                });
            } else {
                const defaultApprover = hiringRequest.ownership?.hiringManager || req.user._id;
                hiringRequest.approvalChain = [{
                    level: 1,
                    specificApprover: defaultApprover,
                    approvers: [defaultApprover],
                    status: 'Pending'
                }];
            }
        } else if (status && ['Pending Approval', 'Approved', 'Rejected', 'Closed', 'On_Hold'].includes(status)) {
            hiringRequest.status = status;
        }

        await hiringRequest.save();

        const populatedRequest = await populateFullHiringRequestDoc(
            HiringRequest.findOne({ _id: hiringRequest._id, companyId: req.companyId })
        );

        res.json({
            message: 'Hiring request updated successfully',
            hiringRequest: populatedRequest || hiringRequest
        });
    } catch (error) {
        console.error('Error updating hiring request:', error);
        res.status(500).json({ message: 'Failed to update hiring request', error: error.message });
    }
};

exports.deleteHiringRequest = async (req, res) => {
    try {
        const hiringRequest = await HiringRequest.findOne({
            _id: req.params.id,
            companyId: req.companyId
        });

        if (!hiringRequest) {
            return res.status(404).json({ message: 'Hiring request not found' });
        }

        const hasAccess = await canAccessHiringRequest(hiringRequest, req.companyId, req.user);
        if (!hasAccess) {
            return res.status(403).json({ message: 'Forbidden: You do not have permission to delete this hiring request' });
        }

        await HiringRequest.deleteOne({ _id: req.params.id });

        res.json({ message: 'Hiring request deleted successfully' });
    } catch (error) {
        console.error('Error deleting hiring request:', error);
        res.status(500).json({ message: 'Failed to delete hiring request', error: error.message });
    }
};

exports.approveHiringRequest = async (req, res) => {
    try {
        const { remarks } = req.body;
        const userId = req.user._id;

        const hiringRequest = await HiringRequest.findOne({
            _id: req.params.id,
            companyId: req.companyId
        });

        if (!hiringRequest) {
            return res.status(404).json({ message: 'Hiring request not found' });
        }

        if (hiringRequest.status !== 'Pending Approval') {
            return res.status(400).json({ message: 'Hiring request is not pending approval' });
        }

        const currentLevel = hiringRequest.currentApprovalLevel;
        const currentLevelObj = hiringRequest.approvalChain.find(item => item.level === currentLevel);

        if (!currentLevelObj) {
            return res.status(400).json({ message: 'Invalid approval level' });
        }

        currentLevelObj.status = 'Approved';
        currentLevelObj.actionBy = userId;
        currentLevelObj.actionDate = new Date();
        currentLevelObj.remarks = remarks || '';

        const hasNextLevel = hiringRequest.approvalChain.some(item => item.level === currentLevel + 1);

        const io = req.app.get('io');

        if (hasNextLevel) {
            hiringRequest.currentApprovalLevel = currentLevel + 1;

            const nextLevel = hiringRequest.approvalChain.find(item => item.level === currentLevel + 1);
            let nextApproverUserIds = [];

            if (nextLevel?.specificApprover) {
                nextApproverUserIds.push(nextLevel.specificApprover);
            } else if (nextLevel?.approverRole) {
                const usersWithRole = await User.find({
                    companyId: req.companyId,
                    roles: nextLevel.approverRole,
                    isActive: true
                }).select('_id');
                nextApproverUserIds = usersWithRole.map(u => u._id);
            }

            const reqTitle = hiringRequest.roleDetails?.title || hiringRequest.roleDetails?.jobTitle || 'Requisition';

            for (const nextUserId of nextApproverUserIds) {
                await NotificationService.createNotification(io, {
                    user: nextUserId,
                    companyId: req.companyId,
                    preferenceKey: 'ta_hiring_request_pending',
                    title: 'Hiring Request Approval Needed',
                    message: `Hiring Request (${hiringRequest.requestId} - ${reqTitle}) requires your level ${nextLevel.level} approval.`,
                    type: 'Approval',
                    link: `/talent-acquisition/hiring-requests/${hiringRequest._id}`,
                    origin: req.headers.origin
                });
            }
        } else {
            hiringRequest.status = 'Approved';
            if (hiringRequest.isPublic && hiringRequest.previousRequestId) {
                const prevId = hiringRequest.previousRequestId._id || hiringRequest.previousRequestId;
                await HiringRequest.findByIdAndUpdate(prevId, {
                    isPublic: false,
                    isJobVisible: false,
                    isResourceGatewayPublic: false
                });
            }
            const reqTitle = hiringRequest.roleDetails?.title || hiringRequest.roleDetails?.jobTitle || 'Requisition';

            await NotificationService.createNotification(io, {
                user: hiringRequest.requestor || hiringRequest.createdBy,
                companyId: req.companyId,
                preferenceKey: 'ta_hiring_request_approved',
                title: 'Hiring Request Approved!',
                message: `Your Hiring Request (${hiringRequest.requestId} - ${reqTitle}) has been fully approved.`,
                type: 'Success',
                link: `/talent-acquisition/hiring-requests/${hiringRequest._id}`,
                origin: req.headers.origin
            });
        }

        await hiringRequest.save();

        const populatedRequest = await populateFullHiringRequestDoc(
            HiringRequest.findOne({ _id: hiringRequest._id, companyId: req.companyId })
        );

        res.json({
            message: hasNextLevel ? 'Approved level. Moved to next level.' : 'Hiring request fully approved.',
            hiringRequest: populatedRequest || hiringRequest
        });

    } catch (error) {
        console.error('Error approving hiring request:', error);
        res.status(500).json({ message: 'Failed to approve hiring request', error: error.message });
    }
};

exports.rejectHiringRequest = async (req, res) => {
    try {
        const { remarks } = req.body;
        const userId = req.user._id;

        const hiringRequest = await HiringRequest.findOne({
            _id: req.params.id,
            companyId: req.companyId
        });

        if (!hiringRequest) {
            return res.status(404).json({ message: 'Hiring request not found' });
        }

        if (hiringRequest.status !== 'Pending Approval') {
            return res.status(400).json({ message: 'Hiring request is not pending approval' });
        }

        const evaluation = await evaluateHiringRequestRejectionAction({
            companyId: req.companyId,
            user: req.user,
            hiringRequest
        });

        if (!evaluation.canReject) {
            return res.status(403).json({
                message: evaluation.reason || 'Forbidden: You do not have permission to reject this hiring request'
            });
        }

        const activeLevel = evaluation.activeLevel;

        const targetLevelObj = activeLevel
            ? hiringRequest.approvalChain.find(item => item.level === activeLevel)
            : null;

        if (targetLevelObj) {
            targetLevelObj.status = 'Rejected';
            targetLevelObj.actionBy = userId;
            targetLevelObj.actionDate = new Date();
            targetLevelObj.remarks = remarks || '';
        }

        hiringRequest.status = 'Rejected';
        await hiringRequest.save();

        const io = req.app.get('io');
        await NotificationService.createNotification(io, {
            user: hiringRequest.requestor,
            companyId: req.companyId,
            preferenceKey: 'ta_hiring_request_rejected',
            title: 'Hiring Request Rejected',
            message: `Your Hiring Request (${hiringRequest.requestId} - ${hiringRequest.roleDetails.jobTitle}) was rejected. Remarks: ${remarks || 'None'}`,
            type: 'Warning',
            link: `/talent-acquisition/hiring-requests/${hiringRequest._id}`,
            origin: req.headers.origin
        });

        res.json({
            message: 'Hiring request rejected successfully',
            hiringRequest
        });

    } catch (error) {
        console.error('Error rejecting hiring request:', error);
        res.status(500).json({ message: 'Failed to reject hiring request', error: error.message });
    }
};

exports.closeHiringRequest = async (req, res) => {
    try {
        const hiringRequest = await HiringRequest.findOne({
            _id: req.params.id,
            companyId: req.companyId
        });

        if (!hiringRequest) {
            return res.status(404).json({ message: 'Hiring request not found' });
        }

        const hasAccess = await canAccessHiringRequest(hiringRequest, req.companyId, req.user);
        if (!hasAccess) {
            return res.status(403).json({ message: 'Forbidden: You do not have permission to close this hiring request' });
        }

        const { mode, closeCount, unpublishFromJobBoard } = req.body;

        if (unpublishFromJobBoard) {
            hiringRequest.isPublic = false;
            hiringRequest.isJobVisible = false;
            hiringRequest.isResourceGatewayPublic = false;
        }

        if (!hiringRequest.hiringDetails) {
            hiringRequest.hiringDetails = {};
        }

        const openPositions = Math.max(Number(hiringRequest.hiringDetails.openPositions) || 0, 0);
        const closedPositions = Math.max(Number(hiringRequest.hiringDetails.closedPositions) || 0, 0);
        const originalPositions = Math.max(Number(hiringRequest.hiringDetails.originalOpenPositions) || 0, openPositions + closedPositions, 1);

        if (mode === 'partial') {
            const countToClose = Math.min(Math.max(Number(closeCount) || 1, 1), openPositions);
            const newOpenPositions = Math.max(openPositions - countToClose, 0);
            const newClosedPositions = closedPositions + countToClose;

            hiringRequest.hiringDetails.openPositions = newOpenPositions;
            hiringRequest.hiringDetails.closedPositions = newClosedPositions;
            hiringRequest.hiringDetails.originalOpenPositions = originalPositions;

            if (newOpenPositions === 0) {
                hiringRequest.status = 'Closed';
            }
        } else {
            hiringRequest.hiringDetails.openPositions = 0;
            hiringRequest.hiringDetails.closedPositions = originalPositions;
            hiringRequest.hiringDetails.originalOpenPositions = originalPositions;
            hiringRequest.status = 'Closed';
        }

        await hiringRequest.save();

        const populatedRequest = await populateFullHiringRequestDoc(
            HiringRequest.findOne({ _id: hiringRequest._id, companyId: req.companyId })
        );

        res.json({ message: 'Hiring request closed successfully', hiringRequest: populatedRequest || hiringRequest });
    } catch (error) {
        console.error('Error closing hiring request:', error);
        res.status(500).json({ message: 'Failed to close hiring request', error: error.message });
    }
};

exports.toggleJobVisibility = async (req, res) => {
    try {
        const rawVal = req.body.isJobVisible !== undefined
            ? req.body.isJobVisible
            : (req.body.isPublic !== undefined ? req.body.isPublic : req.body.isResourceGatewayPublic);

        const isJobVisible = parseBooleanQueryValue(rawVal) ?? (typeof rawVal === 'boolean' ? rawVal : Boolean(rawVal));

        const hiringRequest = await HiringRequest.findOne({
            _id: req.params.id,
            companyId: req.companyId
        });

        if (!hiringRequest) {
            return res.status(404).json({ message: 'Hiring request not found' });
        }

        const hasAccess = await canAccessHiringRequest(hiringRequest, req.companyId, req.user);
        if (!hasAccess) {
            return res.status(403).json({ message: 'Forbidden: You do not have permission to update this hiring request' });
        }

        if (req.body.isPublic !== undefined || req.body.isJobVisible !== undefined) {
            hiringRequest.isPublic = isJobVisible;
            hiringRequest.isJobVisible = isJobVisible;
            if (isJobVisible) {
                hiringRequest.wasEverPublished = true;
                if (hiringRequest.previousRequestId) {
                    const prevId = hiringRequest.previousRequestId._id || hiringRequest.previousRequestId;
                    await HiringRequest.findByIdAndUpdate(prevId, { isPublic: false, isJobVisible: false });
                }
            } else {
                if (hiringRequest.previousRequestId) {
                    const prevId = hiringRequest.previousRequestId._id || hiringRequest.previousRequestId;
                    await HiringRequest.findByIdAndUpdate(prevId, { isPublic: false, isJobVisible: false });
                }
                if (hiringRequest.reopenedToId) {
                    const reopenedId = hiringRequest.reopenedToId._id || hiringRequest.reopenedToId;
                    await HiringRequest.findByIdAndUpdate(reopenedId, { isPublic: false, isJobVisible: false });
                }
            }
        }

        if (req.body.isResourceGatewayPublic !== undefined) {
            const isRgPublic = parseBooleanQueryValue(req.body.isResourceGatewayPublic) ?? Boolean(req.body.isResourceGatewayPublic);
            hiringRequest.isResourceGatewayPublic = isRgPublic;
            if (isRgPublic) {
                hiringRequest.wasEverPublished = true;
                if (hiringRequest.previousRequestId) {
                    const prevId = hiringRequest.previousRequestId._id || hiringRequest.previousRequestId;
                    await HiringRequest.findByIdAndUpdate(prevId, { isResourceGatewayPublic: false });
                }
            } else {
                if (hiringRequest.previousRequestId) {
                    const prevId = hiringRequest.previousRequestId._id || hiringRequest.previousRequestId;
                    await HiringRequest.findByIdAndUpdate(prevId, { isResourceGatewayPublic: false });
                }
                if (hiringRequest.reopenedToId) {
                    const reopenedId = hiringRequest.reopenedToId._id || hiringRequest.reopenedToId;
                    await HiringRequest.findByIdAndUpdate(reopenedId, { isResourceGatewayPublic: false });
                }
            }
        }

        await hiringRequest.save();

        const populatedRequest = await populateFullHiringRequestDoc(
            HiringRequest.findOne({ _id: hiringRequest._id, companyId: req.companyId })
        );

        res.json({
            message: `Job visibility ${isJobVisible ? 'enabled' : 'disabled'} successfully`,
            hiringRequest: populatedRequest || hiringRequest,
            job: populatedRequest || hiringRequest
        });
    } catch (error) {
        console.error('Error toggling job visibility:', error);
        res.status(500).json({ message: 'Failed to toggle job visibility', error: error.message });
    }
};

exports.uploadJDFile = async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ message: 'No file uploaded' });
        }

        res.status(200).json({
            message: 'JD file uploaded successfully',
            url: req.file.path,
            publicId: req.file.filename
        });
    } catch (error) {
        console.error('Error uploading JD file:', error);
        res.status(500).json({ message: 'Failed to upload JD file', error: error.message });
    }
};
