const express = require('express');
const { requireModule } = require('../../../common/middleware/moduleGuard');
const router = express.Router();
const hiringRequestController = require('../controllers/hiringRequestController/hiringRequestController');
const candidateController = require('../controllers/candidateController/candidateController');
const analyticsController = require('../controllers/analyticsController/analyticsController');
const taMailController = require('../controllers/taMailController/taMailController');
const clientController = require('../controllers/clientController/clientController');
const agencyClientController = require('../../client-portal/agencyClient.controller');
const taAccessSettingsController = require('../controllers/taAccessSettingsController/taAccessSettings.controller');

const taController = {
    createHiringRequest: hiringRequestController.createHiringRequest,
    getHiringRequests: hiringRequestController.getHiringRequests,
    getHiringRequestPhases: hiringRequestController.getHiringRequestPhases,
    getHiringRequestById: hiringRequestController.getHiringRequestById,
    updateHiringRequest: hiringRequestController.updateHiringRequest,
    deleteHiringRequest: hiringRequestController.deleteHiringRequest,
    approveHiringRequest: hiringRequestController.approveHiringRequest,
    rejectHiringRequest: hiringRequestController.rejectHiringRequest,
    closeHiringRequest: hiringRequestController.closeHiringRequest,
    toggleJobVisibility: hiringRequestController.toggleJobVisibility,
    uploadJDFile: hiringRequestController.uploadJDFile,
    shareHiringRequest: hiringRequestController.shareHiringRequest,
    getHiringRequestShares: hiringRequestController.getHiringRequestShares,
    removeHiringRequestShare: hiringRequestController.removeHiringRequestShare,
    updateHiringRequestShare: hiringRequestController.updateHiringRequestShare,

    getPreviousCandidates: candidateController.getPreviousCandidates,
    transferCandidate: candidateController.transferCandidate,
    transferCandidateToRequisition: candidateController.transferCandidateToRequisition,
    transferCandidatesBulk: candidateController.transferCandidatesBulk,

    getGlobalAnalytics: analyticsController.getGlobalAnalytics,
    getClientAnalytics: analyticsController.getClientAnalytics,
    getInterviewAnalytics: analyticsController.getInterviewAnalytics,

    sendMassMail: taMailController.sendMassMail,
    sendMassMailBulk: taMailController.sendMassMailBulk,
    getTAEmailHistory: taMailController.getTAEmailHistory,
    getTAEmailHistoryById: taMailController.getTAEmailHistoryById,
    downloadTAEmailAttachment: taMailController.downloadTAEmailAttachment,
    resendTAEmail: taMailController.resendTAEmail,
    resendTAEmailBulk: taMailController.resendTAEmailBulk,

    getTAClients: clientController.getTAClients,
    updateClientStatus: clientController.updateClientStatus
};
const { protect } = require('../../../common/middleware/authMiddleware');
const { authorizeAny } = require('../../../common/middleware/authorize');
const { upload, uploadMassMailAttachments } = require('../../../config/cloudinary');
const PublicApplication = require('../model/publicApplication.model');
const { attachLastApplicationData } = require('../utils/applicationHistoryUtils');
const Candidate = require('../model/candidate.model');
const { HiringRequest: HiringRequestModel } = require('../model/hiringRequest.model');
const Company = require('../../company/company.model');
const { canAccessHiringRequest } = require('../utils/hiringRequestAccess');
const { hasAssignedTAAnalyticsAccess, hasGlobalTAAnalyticsAccess } = require('../utils/taAnalyticsAccess');
const { authorizeHiringRequestApproval } = require('../../../common/middleware/authorizeHiringRequestApproval');

const getCanViewUnlistedApplications = async (req) => {
    let careers = req.company?.settings?.careers;
    if (!careers && req.companyId) {
        const comp = await Company.findById(req.companyId).select('settings.careers').lean();
        careers = comp?.settings?.careers;
    }
    return Boolean(careers?.enableUnlistedApplications);
};

const attachTransferredHiringRequestData = async (apps) => {
    if (!Array.isArray(apps) || apps.length === 0) return apps;

    const appsNeedingTransferReq = [];
    apps.forEach(a => {
        if (a.reviewStatus === 'Transferred') {
            if (a.transferredHiringRequestId && typeof a.transferredHiringRequestId === 'object' && (a.transferredHiringRequestId.roleDetails || a.transferredHiringRequestId.requestId)) {
                a.transferredHiringRequest = a.transferredHiringRequestId;
            } else if (a.transferredCandidateId?.hiringRequestId && typeof a.transferredCandidateId.hiringRequestId === 'object') {
                a.transferredHiringRequest = a.transferredCandidateId.hiringRequestId;
                a.transferredHiringRequestId = a.transferredCandidateId.hiringRequestId;
            } else {
                appsNeedingTransferReq.push(a);
            }
        }
    });

    if (appsNeedingTransferReq.length > 0) {
        const appIds = appsNeedingTransferReq.map(a => a._id);
        const candIds = appsNeedingTransferReq.map(a => a.transferredCandidateId).filter(Boolean);
        const candidates = await Candidate.find({
            $or: [
                { publicApplicationId: { $in: appIds } },
                ...(candIds.length > 0 ? [{ _id: { $in: candIds } }] : [])
            ]
        })
            .select('publicApplicationId hiringRequestId')
            .populate('hiringRequestId', 'requestId roleDetails client')
            .lean();

        const hrByAppId = {};
        const hrByCandId = {};
        candidates.forEach(c => {
            if (c.hiringRequestId && typeof c.hiringRequestId === 'object') {
                if (c.publicApplicationId) {
                    hrByAppId[String(c.publicApplicationId)] = c.hiringRequestId;
                }
                hrByCandId[String(c._id)] = c.hiringRequestId;
            }
        });

        appsNeedingTransferReq.forEach(a => {
            const hr = hrByAppId[String(a._id)] || (a.transferredCandidateId ? hrByCandId[String(a.transferredCandidateId)] : null);
            if (hr) {
                a.transferredHiringRequest = hr;
                a.transferredHiringRequestId = hr;
            }
        });
    }

    return apps;
};

const APPLICANT_REVIEW_SELECT = [
    'firstName',
    'lastName',
    'email',
    'mobile',
    'headline',
    'summary',
    'currentCity',
    'currentState',
    'currentCountry',
    'willingToRelocate',
    'preferredLocations',
    'preferredJobTypes',
    'preferredDepartments',
    'jobSearchStatus',
    'currentCTC',
    'expectedCTC',
    'noticePeriod',
    'totalExperienceYears',
    'workExperience',
    'education',
    'skills',
    'certifications',
    'languages',
    'linkedinUrl',
    'githubUrl',
    'portfolioUrl',
    'otherLinks',
    'resumeUrl',
    'resumeFileName',
    'resumeUpdatedAt',
    'profilePhotoUrl',
    'profileCompletionScore',
    'createdAt',
    'updatedAt'
].join(' ');

const taAccessSettingsViewPermissions = ['ta.manage', 'ta.config.view', 'ta.config.edit'];
const taAccessSettingsEditPermissions = ['ta.manage', 'ta.config.edit'];
const taClientManagePermissions = ['ta.client.manage', 'ta.manage', 'ta.config.edit'];
const taClientViewPermissions = ['ta.client.manage', 'ta.client.view', 'ta.view', 'ta.manage', 'ta.config.view', 'ta.config.edit'];
const requireTAAnalyticsAccess = async (req, res, next) => {
    try {
        if (hasAssignedTAAnalyticsAccess(req.user)) {
            return next();
        }

        const hasAssignedAnalyticsAccess = await HiringRequestModel.exists({
            companyId: req.companyId,
            analyticsViewers: req.user._id
        });

        if (hasAssignedAnalyticsAccess) {
            return next();
        }

        return res.status(403).json({
            message: 'Forbidden: You do not have permission to access TA analytics'
        });
    } catch (error) {
        return res.status(500).json({
            message: 'Failed to validate TA analytics access'
        });
    }
};

router.use(protect);
router.use(requireModule('talentAcquisition'));

// Hiring Requests
router.post('/hiring-request', protect, authorizeAny(['ta.requisition.create', 'ta.requisition.manage.assigned', 'ta.requisition.manage.all', 'ta.create']), taController.createHiringRequest);
router.get('/hiring-request', protect, taController.getHiringRequests);
router.get('/hiring-requests/:id/phases', protect, taController.getHiringRequestPhases);
router.get('/hiring-request/:id', protect, taController.getHiringRequestById);
router.put('/hiring-request/:id', protect, authorizeAny(['ta.requisition.update', 'ta.requisition.manage.assigned', 'ta.requisition.manage.all', 'ta.edit']), taController.updateHiringRequest);
router.patch('/hiring-request/:id/client-visibility', protect, authorizeAny(['ta.manage', 'ta.client.visibility.configure', 'ta.requisition.update', 'ta.requisition.manage.all']), taController.updateHiringRequest);
router.delete('/hiring-request/:id', protect, authorizeAny(['ta.requisition.delete', 'ta.requisition.manage.assigned', 'ta.requisition.manage.all', 'ta.delete']), taController.deleteHiringRequest);
router.patch('/hiring-request/:id/approve', protect, authorizeHiringRequestApproval, taController.approveHiringRequest);
router.patch('/hiring-request/:id/reject', protect, authorizeHiringRequestApproval, taController.rejectHiringRequest);
router.patch('/hiring-request/:id/close', protect, authorizeAny(['ta.manage', 'ta.hiring_request.manage']), taController.closeHiringRequest);
router.post('/hiring-request/:id/share', protect, authorizeAny(['ta.requisition.update', 'ta.requisition.manage.assigned', 'ta.requisition.manage.all', 'ta.edit', 'ta.manage']), taController.shareHiringRequest);
router.get('/hiring-request/:id/shares', protect, taController.getHiringRequestShares);
router.delete('/hiring-request/:id/share/:targetCompanyId', protect, authorizeAny(['ta.requisition.update', 'ta.requisition.manage.assigned', 'ta.requisition.manage.all', 'ta.edit', 'ta.manage']), taController.removeHiringRequestShare);
router.put('/hiring-request/:id/share/:targetCompanyId', protect, authorizeAny(['ta.requisition.update', 'ta.requisition.manage.assigned', 'ta.requisition.manage.all', 'ta.edit', 'ta.manage']), taController.updateHiringRequestShare);
router.get('/hiring-request/:id/previous-candidates', protect, taController.getPreviousCandidates);
router.post('/hiring-request/transfer-candidate/:candidateId', protect, authorizeAny(['ta.candidate.manage.assigned', 'ta.candidate.manage.all', 'ta.candidate.transfer', 'ta.bulk_transfer', 'ta.edit']), taController.transferCandidate);
router.patch('/hiring-request/:targetRequisitionId/transfer-candidate/:candidateId', protect, authorizeAny(['ta.candidate.manage.assigned', 'ta.candidate.manage.all', 'ta.candidate.transfer', 'ta.bulk_transfer', 'ta.edit']), taController.transferCandidateToRequisition);
router.post('/transfer-candidates-bulk', protect, authorizeAny(['ta.candidate.manage.assigned', 'ta.candidate.manage.all', 'ta.candidate.transfer', 'ta.bulk_transfer', 'ta.edit']), taController.transferCandidatesBulk);
router.post('/hiring-request/:id/send-mass-mail', protect, authorizeAny(['ta.candidate.manage.assigned', 'ta.candidate.manage.all', 'ta.mass_mail', 'ta.edit']), uploadMassMailAttachments.array('attachments', 10), taController.sendMassMail);
router.post('/send-mass-mail-bulk', protect, authorizeAny(['ta.candidate.manage.assigned', 'ta.candidate.manage.all', 'ta.mass_mail', 'ta.edit']), uploadMassMailAttachments.array('attachments', 10), taController.sendMassMailBulk);
router.get('/email-history', protect, authorizeAny(['ta.view', 'ta.manage', 'ta.candidate.manage.all', 'ta.candidate.manage.assigned', 'ta.mass_mail', 'ta.edit']), taController.getTAEmailHistory);
router.get('/email-history/:id', protect, authorizeAny(['ta.view', 'ta.manage', 'ta.candidate.manage.all', 'ta.candidate.manage.assigned', 'ta.mass_mail', 'ta.edit']), taController.getTAEmailHistoryById);
router.get('/email-history/:id/attachment/:attachmentIndex', protect, authorizeAny(['ta.view', 'ta.manage', 'ta.candidate.manage.all', 'ta.candidate.manage.assigned', 'ta.mass_mail', 'ta.edit']), taController.downloadTAEmailAttachment);
router.post('/email-history/bulk-resend', protect, authorizeAny(['ta.view', 'ta.manage', 'ta.candidate.manage.all', 'ta.candidate.manage.assigned', 'ta.mass_mail', 'ta.edit']), taController.resendTAEmailBulk);
router.post('/email-history/:id/resend', protect, authorizeAny(['ta.view', 'ta.manage', 'ta.candidate.manage.all', 'ta.candidate.manage.assigned', 'ta.mass_mail', 'ta.edit']), taController.resendTAEmail);

// Analytics
router.get('/analytics/global', protect, requireTAAnalyticsAccess, taController.getGlobalAnalytics);
router.get('/analytics/client/:clientName', protect, requireTAAnalyticsAccess, taController.getClientAnalytics);
router.get('/analytics/interviews', protect, taController.getInterviewAnalytics);

// Clients list for TA
router.get('/clients', protect, taController.getTAClients);
router.put('/clients/status', protect, taController.updateClientStatus);

// Client portal user management for TA clients
router.get('/clients/:clientId/users', protect, authorizeAny(taClientViewPermissions), agencyClientController.getClientUsers);
router.get('/clients/:clientId/shared-summary', protect, authorizeAny(taClientViewPermissions), agencyClientController.getClientSharedAccessSummary);
router.post('/clients/:clientId/users/invite', protect, authorizeAny(taClientManagePermissions), agencyClientController.inviteClientUser);
router.post('/clients/:clientId/invite-user', protect, authorizeAny(taClientManagePermissions), agencyClientController.inviteClientUser);
router.put('/clients/:clientId/users/:userId', protect, authorizeAny(taClientManagePermissions), agencyClientController.updateClientUser);
router.patch('/clients/:clientId/users/:userId', protect, authorizeAny(taClientManagePermissions), agencyClientController.updateClientUser);
router.delete('/clients/:clientId/users/:userId', protect, authorizeAny(taClientManagePermissions), agencyClientController.deleteClientUser);
router.post('/clients/:clientId/users/:userId/resend-invite', protect, authorizeAny(taClientManagePermissions), agencyClientController.resendInvite);

// TA access settings
router.get('/settings/access/overview', protect, authorizeAny(taAccessSettingsViewPermissions), taAccessSettingsController.getOverview);
router.put('/settings/access/roles/:roleId', protect, authorizeAny(taAccessSettingsEditPermissions), taAccessSettingsController.updateRolePermissions);
router.put('/settings/access/requisitions/:id', protect, authorizeAny(taAccessSettingsEditPermissions), taAccessSettingsController.updateRequisitionAccess);
router.put('/settings/access/users/:userId/clients', protect, authorizeAny(taAccessSettingsEditPermissions), taAccessSettingsController.updateUserClientAssignments);
router.put('/settings/access/clients/assignments', protect, authorizeAny(taAccessSettingsEditPermissions), taAccessSettingsController.updateClientUserAssignments);

// File Uploads
router.post('/hiring-request/upload-jd', protect, upload.single('jdFile'), taController.uploadJDFile);

router.get('/public-applications', protect, async (req, res) => {
    try {
        const canViewUnlisted = await getCanViewUnlistedApplications(req);

        if (req.query.type === 'unlisted' || req.query.unlistedOnly === 'true') {
            if (!canViewUnlisted) {
                return res.json([]);
            }
        }

        const query = canViewUnlisted ? {
            $or: [
                { companyId: req.companyId },
                { companyId: { $exists: false } },
                { companyId: null }
            ]
        } : {
            companyId: req.companyId
        };

        if (req.query.type === 'unlisted' || req.query.unlistedOnly === 'true') {
            query.$and = [
                {
                    $or: [
                        { hiringRequestId: { $exists: false } },
                        { hiringRequestId: null },
                        { desiredPosition: { $exists: true, $ne: '' } },
                        { source: /General Application/i }
                    ]
                }
            ];
        }

        if (req.query.status && req.query.status !== 'All') {
            query.reviewStatus = req.query.status;
        }

        const apps = await PublicApplication.find(query)
            .populate('applicantId', APPLICANT_REVIEW_SELECT)
            .populate('hiringRequestId', 'requestId roleDetails client isPublic isResourceGatewayPublic')
            .populate('transferredHiringRequestId', 'requestId roleDetails client isPublic isResourceGatewayPublic')
            .populate({
                path: 'transferredCandidateId',
                select: 'hiringRequestId candidateName',
                populate: {
                    path: 'hiringRequestId',
                    select: 'requestId roleDetails client'
                }
            })
            .sort({ createdAt: -1 })
            .lean();

        const hiringRequestIds = apps
            .map(a => a.hiringRequestId?._id || a.hiringRequestId)
            .filter(Boolean);

        if (hiringRequestIds.length > 0) {
            const candidateCounts = await Candidate.aggregate([
                {
                    $match: {
                        companyId: req.companyId,
                        isDeleted: { $ne: true },
                        hiringRequestId: { $in: hiringRequestIds }
                    }
                },
                {
                    $group: {
                        _id: '$hiringRequestId',
                        count: { $sum: 1 }
                    }
                }
            ]);

            const countMap = {};
            candidateCounts.forEach(c => {
                countMap[String(c._id)] = c.count;
            });

            apps.forEach(a => {
                const hId = a.hiringRequestId?._id || a.hiringRequestId;
                const count = hId ? (countMap[String(hId)] || 0) : 0;
                a.sourcedCandidatesCount = count;
                if (a.hiringRequestId && typeof a.hiringRequestId === 'object') {
                    a.hiringRequestId.totalSourcedCandidates = count;
                }
            });
        }

        await attachTransferredHiringRequestData(apps);
        const appsWithHistory = await attachLastApplicationData(apps);
        res.json(appsWithHistory);
    } catch (err) {
        console.error('Failed to fetch public applications:', err);
        res.status(500).json({ message: 'Failed to fetch public applications' });
    }
});

router.patch('/public-applications/:appId/review', protect, authorizeAny(['ta.candidate.manage.assigned', 'ta.candidate.manage.all', 'ta.candidate.make_decision', 'ta.candidate.edit', 'ta.edit']), async (req, res) => {
    try {
        const { reviewStatus, reviewNote } = req.body;
        const validStatuses = ['Pending Review', 'Shortlisted', 'Rejected'];

        if (!validStatuses.includes(reviewStatus)) {
            return res.status(400).json({ message: 'Invalid review status' });
        }

        const canViewUnlisted = await getCanViewUnlistedApplications(req);
        const appQuery = {
            _id: req.params.appId,
            ...(canViewUnlisted ? {
                $or: [
                    { companyId: req.companyId },
                    { companyId: { $exists: false } },
                    { companyId: null }
                ]
            } : {
                companyId: req.companyId
            })
        };

        const app = await PublicApplication.findOneAndUpdate(
            appQuery,
            {
                reviewStatus,
                reviewNote: reviewNote || '',
                reviewedBy: req.user._id,
                reviewedAt: new Date()
            },
            { new: true }
        );

        if (!app) {
            return res.status(404).json({ message: 'Application not found' });
        }

        res.json(app);
    } catch (err) {
        console.error('Failed to update review status:', err);
        res.status(500).json({ message: 'Failed to update review status' });
    }
});

router.post('/public-applications/:appId/transfer', protect, authorizeAny(['ta.candidate.manage.assigned', 'ta.candidate.manage.all', 'ta.candidate.transfer', 'ta.bulk_transfer', 'ta.edit']), async (req, res) => {
    try {
        const canViewUnlisted = await getCanViewUnlistedApplications(req);
        const appQuery = {
            _id: req.params.appId,
            ...(canViewUnlisted ? {
                $or: [
                    { companyId: req.companyId },
                    { companyId: { $exists: false } },
                    { companyId: null }
                ]
            } : {
                companyId: req.companyId
            })
        };

        const app = await PublicApplication.findOne(appQuery);

        if (!app) {
            return res.status(404).json({ message: 'Application not found' });
        }

        if (app.reviewStatus === 'Transferred') {
            return res.status(409).json({ message: 'This applicant has already been transferred.' });
        }

        const { targetHiringRequestId } = req.body;
        const targetRequestId = targetHiringRequestId || app.hiringRequestId;

        if (!targetRequestId) {
            return res.status(400).json({ message: 'Target hiring request is required for transfer.' });
        }

        const targetRequest = await HiringRequestModel.findOne({
            _id: targetRequestId,
            companyId: req.companyId,
            status: { $in: ['Approved', 'active'] }
        });

        if (!targetRequest) {
            return res.status(404).json({ message: 'Target hiring request not found or not active' });
        }

        const duplicateCandidateConditions = [];
        if (app.email) {
            duplicateCandidateConditions.push({ email: String(app.email).trim().toLowerCase() });
        }
        if (app.mobile) {
            duplicateCandidateConditions.push({ mobile: String(app.mobile).trim() });
        }

        const existing = duplicateCandidateConditions.length
            ? await Candidate.findOne({
                companyId: req.companyId,
                hiringRequestId: targetRequestId,
                $or: duplicateCandidateConditions
            })
            : null;

        if (existing) {
            return res.status(409).json({ message: 'This candidate already exists in the target requisition.' });
        }

        const candidate = new Candidate({
            hiringRequestId: targetRequestId,
            companyId: req.companyId,
            applicantId: app.applicantId || undefined,
            publicApplicationId: app._id,
            profileSnapshot: app.profileSnapshot || undefined,
            resumeUrl: app.resumeUrl,
            resumePublicId: app.resumePublicId,
            uploadedBy: req.user._id,
            candidateName: app.candidateName,
            email: String(app.email || '').trim().toLowerCase(),
            mobile: String(app.mobile || '').trim(),
            source: app.source || 'Public Job Board',
            profilePulledBy: `${req.user.firstName || ''} ${req.user.lastName || ''}`.trim(),
            currentCTC: app.currentCTC,
            expectedCTC: app.expectedCTC,
            noticePeriod: app.noticePeriod,
            remark: app.coverNote || '',
            totalExperience: app.totalExperienceYears || 0,
            currentCompany: app.currentCompany || '',
            status: 'Total Sourced',
            profileShared: false,
            decision: 'None',
            phase2Decision: 'None',
            phase3Decision: 'None',
            isTransferred: true,
            transferredFrom: app.hiringRequestId || undefined,
        });

        await candidate.save();

        app.reviewStatus = 'Transferred';
        app.transferredCandidateId = candidate._id;
        app.transferredHiringRequestId = targetRequestId;
        app.transferredAt = new Date();
        app.transferredBy = req.user._id;
        if (!app.companyId) {
            app.companyId = req.companyId;
        }
        await app.save();

        res.json({
            message: 'Applicant transferred to active request successfully.',
            candidateId: candidate._id
        });
    } catch (err) {
        if (err.code === 11000) {
            return res.status(409).json({ message: 'This candidate already exists in the system.' });
        }

        console.error('Failed to transfer application:', err);
        res.status(500).json({ message: 'Failed to transfer applicant' });
    }
});

router.get('/hiring-request/:id/public-applications', protect, async (req, res) => {
    try {
        const hiringRequest = await HiringRequestModel.findOne({
            _id: req.params.id,
            $or: [
                { companyId: req.companyId },
                { 'sharedTenants.companyId': req.companyId }
            ]
        });

        if (!hiringRequest) {
            return res.status(404).json({ message: 'Hiring request not found' });
        }

        const hasAccess = await canAccessHiringRequest(hiringRequest, req.companyId, req.user);
        if (!hasAccess) {
            return res.status(403).json({ message: 'Forbidden: You do not have permission to view this request' });
        }

        const isOwner = String(hiringRequest.companyId) === String(req.companyId);
        if (!isOwner) {
            const shareItem = (hiringRequest.sharedTenants || []).find(st => String(st.companyId) === String(req.companyId));
            if (!shareItem || (shareItem.shareType !== 'all' && shareItem.shareType !== 'public_applications')) {
                return res.json([]);
            }
        }

        const apps = await PublicApplication.find({
            hiringRequestId: req.params.id
        })
            .populate('applicantId', APPLICANT_REVIEW_SELECT)
            .populate('hiringRequestId', 'requestId roleDetails client isPublic isResourceGatewayPublic')
            .populate('transferredHiringRequestId', 'requestId roleDetails client isPublic isResourceGatewayPublic')
            .populate({
                path: 'transferredCandidateId',
                select: 'hiringRequestId candidateName',
                populate: {
                    path: 'hiringRequestId',
                    select: 'requestId roleDetails client'
                }
            })
            .sort({ createdAt: -1 })
            .lean();

        apps.forEach(a => {
            if (!a.hiringRequestId || typeof a.hiringRequestId !== 'object' || !a.hiringRequestId.roleDetails) {
                a.hiringRequestId = hiringRequest;
            }
        });

        await attachTransferredHiringRequestData(apps);
        const appsWithHistory = await attachLastApplicationData(apps);
        res.json(appsWithHistory);
    } catch (err) {
        res.status(500).json({ message: 'Failed to fetch public applications' });
    }
});

router.patch('/hiring-request/:id/public-applications/:appId/review', protect, authorizeAny(['ta.candidate.manage.assigned', 'ta.candidate.manage.all', 'ta.candidate.make_decision', 'ta.candidate.edit', 'ta.edit']), async (req, res) => {
    try {
        const hiringRequest = await HiringRequestModel.findOne({
            _id: req.params.id,
            companyId: req.companyId
        });

        if (!hiringRequest) {
            return res.status(404).json({ message: 'Hiring request not found' });
        }

        const hasAccess = await canAccessHiringRequest(hiringRequest, req.companyId, req.user);
        if (!hasAccess) {
            return res.status(403).json({ message: 'Forbidden: You do not have permission to update this request' });
        }

        const { reviewStatus, reviewNote } = req.body;
        const validStatuses = ['Pending Review', 'Shortlisted', 'Rejected'];

        if (!validStatuses.includes(reviewStatus)) {
            return res.status(400).json({ message: 'Invalid review status' });
        }

        const app = await PublicApplication.findOneAndUpdate(
            {
                _id: req.params.appId,
                hiringRequestId: req.params.id,
                $or: [
                    { companyId: req.companyId },
                    { companyId: { $exists: false } },
                    { companyId: null }
                ]
            },
            {
                reviewStatus,
                reviewNote: reviewNote || '',
                reviewedBy: req.user._id,
                reviewedAt: new Date()
            },
            { new: true }
        ).populate('applicantId', APPLICANT_REVIEW_SELECT);

        if (!app) {
            return res.status(404).json({ message: 'Application not found' });
        }

        res.json(app);
    } catch (err) {
        res.status(500).json({ message: 'Failed to update review status' });
    }
});

router.post('/hiring-request/:id/public-applications/:appId/transfer', protect, authorizeAny(['ta.candidate.manage.assigned', 'ta.candidate.manage.all', 'ta.candidate.transfer', 'ta.bulk_transfer', 'ta.edit']), async (req, res) => {
    try {
        const hiringRequest = await HiringRequestModel.findOne({
            _id: req.params.id,
            companyId: req.companyId
        });

        if (!hiringRequest) {
            return res.status(404).json({ message: 'Hiring request not found' });
        }

        const hasAccess = await canAccessHiringRequest(hiringRequest, req.companyId, req.user);
        if (!hasAccess) {
            return res.status(403).json({ message: 'Forbidden: You do not have permission to update this request' });
        }

        const app = await PublicApplication.findOne({
            _id: req.params.appId,
            hiringRequestId: req.params.id,
            $or: [
                { companyId: req.companyId },
                { companyId: { $exists: false } },
                { companyId: null }
            ]
        });

        if (!app) {
            return res.status(404).json({ message: 'Application not found' });
        }

        if (app.reviewStatus === 'Transferred') {
            return res.status(409).json({ message: 'This applicant has already been transferred.' });
        }

        const targetRequestId = req.body.targetHiringRequestId || req.params.id;

        const targetRequest = await HiringRequestModel.findOne({
            _id: targetRequestId,
            companyId: req.companyId,
            status: { $in: ['Approved', 'Active'] }
        });

        if (!targetRequest) {
            return res.status(404).json({ message: 'Target hiring request not found or not active' });
        }

        const duplicateCandidateConditions = [];
        if (app.email) {
            duplicateCandidateConditions.push({ email: String(app.email).trim().toLowerCase() });
        }
        if (app.mobile) {
            duplicateCandidateConditions.push({ mobile: String(app.mobile).trim() });
        }

        const existing = duplicateCandidateConditions.length
            ? await Candidate.findOne({
                companyId: req.companyId,
                hiringRequestId: targetRequestId,
                $or: duplicateCandidateConditions
            })
            : null;

        if (existing) {
            return res.status(409).json({ message: 'This candidate already exists in the system.' });
        }

        const candidate = new Candidate({
            hiringRequestId: targetRequestId,
            companyId: req.companyId,
            applicantId: app.applicantId || undefined,
            publicApplicationId: app._id,
            profileSnapshot: app.profileSnapshot || undefined,
            resumeUrl: app.resumeUrl,
            resumePublicId: app.resumePublicId,
            uploadedBy: req.user._id,
            candidateName: app.candidateName,
            email: String(app.email || '').trim().toLowerCase(),
            mobile: String(app.mobile || '').trim(),
            source: app.source || 'Public Job Board',
            profilePulledBy: `${req.user.firstName || ''} ${req.user.lastName || ''}`.trim(),
            currentCTC: app.currentCTC,
            expectedCTC: app.expectedCTC,
            noticePeriod: app.noticePeriod,
            remark: app.coverNote || '',
            totalExperience: app.totalExperienceYears || 0,
            currentCompany: app.currentCompany || '',
            status: 'Total Sourced',
            profileShared: false,
            decision: 'None',
            phase2Decision: 'None',
            phase3Decision: 'None',
            isTransferred: targetRequestId.toString() !== req.params.id.toString(),
            transferredFrom: targetRequestId.toString() !== req.params.id.toString() ? req.params.id : undefined,
        });

        await candidate.save();

        app.reviewStatus = 'Transferred';
        app.transferredCandidateId = candidate._id;
        app.transferredHiringRequestId = targetRequestId;
        app.transferredAt = new Date();
        app.transferredBy = req.user._id;
        if (!app.companyId) {
            app.companyId = req.companyId;
        }
        await app.save();

        res.json({
            message: 'Applicant transferred to active request successfully.',
            candidateId: candidate._id
        });
    } catch (err) {
        if (err.code === 11000) {
            return res.status(409).json({ message: 'This candidate already exists in the system.' });
        }

        console.error(err);
        res.status(500).json({ message: 'Failed to transfer applicant' });
    }
});

router.patch('/hiring-request/:id/visibility', protect, authorizeAny(['ta.manage', 'ta.config.edit', 'ta.requisition.update', 'ta.requisition.manage.assigned', 'ta.requisition.manage.all']), taController.toggleJobVisibility);

module.exports = router;
