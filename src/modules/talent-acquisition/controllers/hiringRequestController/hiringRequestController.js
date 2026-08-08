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

exports.createHiringRequest = async (req, res) => {
    try {
        const {
            roleDetails,
            employmentDetails,
            recruitmentTeam,
            approvalChain,
            jdFileUrl,
            jdPublicId,
            jdText,
            remarks,
            client
        } = req.body;

        const requestingUserId = req.user._id;

        if (!roleDetails?.jobTitle || !employmentDetails?.numberOfPositions || !employmentDetails?.workLocation) {
            return res.status(400).json({ message: 'Job title, number of positions, and work location are required' });
        }

        const normalizedClientName = client ? client.trim() : null;

        const defaultAssignedRecruiters = recruitmentTeam?.assignedRecruiters || [];
        const clientAssignedRecruiterIds = normalizedClientName
            ? await getClientAssignedUserIds(req.companyId, normalizedClientName)
            : [];
        const assignedRecruiters = mergeAssignedUsersWithClientAssignments(
            defaultAssignedRecruiters,
            clientAssignedRecruiterIds
        );

        const workflow = await ApprovalWorkflow.findOne({
            companyId: req.companyId,
            module: 'talent_acquisition',
            isActive: true
        });

        let hiringRequestData = {
            companyId: req.companyId,
            requestor: requestingUserId,
            client: normalizedClientName,
            roleDetails,
            employmentDetails,
            recruitmentTeam: {
                ...recruitmentTeam,
                assignedRecruiters
            },
            jdFileUrl,
            jdPublicId,
            jdText,
            remarks
        };

        if (workflow && workflow.levels && workflow.levels.length > 0) {
            hiringRequestData.status = 'Pending Approval';
            hiringRequestData.currentApprovalLevel = 1;

            hiringRequestData.approvalChain = workflow.levels.map(level => ({
                level: level.level,
                approverRole: level.role,
                specificApprover: level.specificUser || null,
                status: 'Pending'
            }));
        } else if (approvalChain && Array.isArray(approvalChain) && approvalChain.length > 0) {
            hiringRequestData.status = 'Pending Approval';
            hiringRequestData.currentApprovalLevel = 1;
            hiringRequestData.approvalChain = approvalChain.map((approver, index) => ({
                level: index + 1,
                specificApprover: approver.userId,
                status: 'Pending'
            }));
        } else {
            hiringRequestData.status = 'Approved';
            hiringRequestData.approvalChain = [];
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
        const requests = await HiringRequest.find(accessibleQuery)
            .populate('requestor', 'firstName lastName email')
            .populate('recruitmentTeam.hiringManager', 'firstName lastName email')
            .populate('recruitmentTeam.assignedRecruiters', 'firstName lastName email')

            .populate('approvalChain.specificApprover', 'firstName lastName email')

            .populate('approvalChain.actionBy', 'firstName lastName email')
            .sort({ createdAt: -1 })
            .lean();

        res.json(requests);
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
        const hiringRequest = await HiringRequest.findOne({
            _id: req.params.id,
            companyId: req.companyId
        })
            .populate('requestor', 'firstName lastName email')
            .populate('recruitmentTeam.hiringManager', 'firstName lastName email')
            .populate('recruitmentTeam.assignedRecruiters', 'firstName lastName email')
            .populate('approvalChain.specificApprover', 'firstName lastName email')
            .populate('approvalChain.actionBy', 'firstName lastName email');

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

        if (roleDetails) hiringRequest.roleDetails = { ...hiringRequest.roleDetails, ...roleDetails };
        if (employmentDetails) hiringRequest.employmentDetails = { ...hiringRequest.employmentDetails, ...employmentDetails };

        if (client !== undefined) {
            hiringRequest.client = client ? client.trim() : null;
        }

        if (recruitmentTeam) {
            const defaultAssignedRecruiters = recruitmentTeam.assignedRecruiters || [];
            const clientAssignedRecruiterIds = hiringRequest.client
                ? await getClientAssignedUserIds(req.companyId, hiringRequest.client)
                : [];

            const assignedRecruiters = mergeAssignedUsersWithClientAssignments(
                defaultAssignedRecruiters,
                clientAssignedRecruiterIds
            );

            hiringRequest.recruitmentTeam = {
                ...recruitmentTeam,
                assignedRecruiters
            };
        } else if (client !== undefined && hiringRequest.client) {
            const clientAssignedRecruiterIds = await getClientAssignedUserIds(req.companyId, hiringRequest.client);
            hiringRequest.recruitmentTeam.assignedRecruiters = mergeAssignedUsersWithClientAssignments(
                hiringRequest.recruitmentTeam?.assignedRecruiters || [],
                clientAssignedRecruiterIds
            );
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

        if (status && ['Draft', 'Pending Approval', 'Approved', 'Rejected', 'Closed'].includes(status)) {
            hiringRequest.status = status;
        }

        await hiringRequest.save();

        res.json({
            message: 'Hiring request updated successfully',
            hiringRequest
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

            for (const nextUserId of nextApproverUserIds) {
                await NotificationService.createNotification(io, {
                    user: nextUserId,
                    companyId: req.companyId,
                    preferenceKey: 'ta_hiring_request_pending',
                    title: 'Hiring Request Approval Needed',
                    message: `Hiring Request (${hiringRequest.requestId} - ${hiringRequest.roleDetails.jobTitle}) requires your level ${nextLevel.level} approval.`,
                    type: 'Approval',
                    link: `/talent-acquisition/hiring-requests/${hiringRequest._id}`,
                    origin: req.headers.origin
                });
            }
        } else {
            hiringRequest.status = 'Approved';

            await NotificationService.createNotification(io, {
                user: hiringRequest.requestor,
                companyId: req.companyId,
                preferenceKey: 'ta_hiring_request_approved',
                title: 'Hiring Request Approved!',
                message: `Your Hiring Request (${hiringRequest.requestId} - ${hiringRequest.roleDetails.jobTitle}) has been fully approved.`,
                type: 'Success',
                link: `/talent-acquisition/hiring-requests/${hiringRequest._id}`,
                origin: req.headers.origin
            });
        }

        await hiringRequest.save();

        res.json({
            message: hasNextLevel ? 'Approved level. Moved to next level.' : 'Hiring request fully approved.',
            hiringRequest
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

        hiringRequest.status = 'Closed';
        await hiringRequest.save();

        res.json({ message: 'Hiring request closed successfully', hiringRequest });
    } catch (error) {
        console.error('Error closing hiring request:', error);
        res.status(500).json({ message: 'Failed to close hiring request', error: error.message });
    }
};

exports.toggleJobVisibility = async (req, res) => {
    try {
        const { isJobVisible } = req.body;

        if (typeof isJobVisible !== 'boolean') {
            return res.status(400).json({ message: 'isJobVisible must be a boolean value' });
        }

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

        hiringRequest.isJobVisible = isJobVisible;
        await hiringRequest.save();

        res.json({
            message: `Job visibility ${isJobVisible ? 'enabled' : 'disabled'} successfully`,
            hiringRequest
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
