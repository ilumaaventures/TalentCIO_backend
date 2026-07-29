const express = require('express');
const { requireModule } = require('../middlewares/moduleGuard');
const router = express.Router();
const taController = require('../controllers/talentAcquisitionController');
const taAccessSettingsController = require('../controllers/taAccessSettingsController');
const { protect } = require('../middlewares/authMiddleware');
const { authorizeAny } = require('../middlewares/authorize');
const { upload, uploadMassMailAttachments } = require('../config/cloudinary');
const PublicApplication = require('../models/PublicApplication');
const Candidate = require('../models/Candidate');
const { HiringRequest: HiringRequestModel } = require('../models/HiringRequest');
const { canAccessHiringRequest } = require('../utils/hiringRequestAccess');
const { hasAssignedTAAnalyticsAccess, hasGlobalTAAnalyticsAccess } = require('../utils/taAnalyticsAccess');
const { authorizeHiringRequestApproval } = require('../middlewares/authorizeHiringRequestApproval');

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
router.delete('/hiring-request/:id', protect, authorizeAny(['ta.requisition.delete', 'ta.requisition.manage.assigned', 'ta.requisition.manage.all', 'ta.delete']), taController.deleteHiringRequest);
router.patch('/hiring-request/:id/approve', protect, authorizeHiringRequestApproval, taController.approveHiringRequest);
router.patch('/hiring-request/:id/reject', protect, authorizeHiringRequestApproval, taController.rejectHiringRequest);
router.patch('/hiring-request/:id/close', protect, authorizeAny(['ta.manage', 'ta.hiring_request.manage']), taController.closeHiringRequest);
router.get('/hiring-request/:id/previous-candidates', protect, taController.getPreviousCandidates);
router.post('/hiring-request/transfer-candidate/:candidateId', protect, authorizeAny(['ta.candidate.manage.assigned', 'ta.candidate.manage.all', 'ta.candidate.transfer', 'ta.bulk_transfer', 'ta.edit']), taController.transferCandidate);
router.patch('/hiring-request/:targetRequisitionId/transfer-candidate/:candidateId', protect, authorizeAny(['ta.candidate.manage.assigned', 'ta.candidate.manage.all', 'ta.candidate.transfer', 'ta.bulk_transfer', 'ta.edit']), taController.transferCandidateToRequisition);
router.post('/transfer-candidates-bulk', protect, authorizeAny(['ta.candidate.manage.assigned', 'ta.candidate.manage.all', 'ta.candidate.transfer', 'ta.bulk_transfer', 'ta.edit']), taController.transferCandidatesBulk);
router.post('/hiring-request/:id/send-mass-mail', protect, authorizeAny(['ta.candidate.manage.assigned', 'ta.candidate.manage.all', 'ta.mass_mail', 'ta.edit']), uploadMassMailAttachments.array('attachments', 10), taController.sendMassMail);
router.post('/send-mass-mail-bulk', protect, authorizeAny(['ta.candidate.manage.assigned', 'ta.candidate.manage.all', 'ta.mass_mail', 'ta.edit']), uploadMassMailAttachments.array('attachments', 10), taController.sendMassMailBulk);
router.get('/email-history', protect, authorizeAny(['ta.view', 'ta.manage', 'ta.candidate.manage.all', 'ta.candidate.manage.assigned', 'ta.mass_mail', 'ta.edit']), taController.getTAEmailHistory);
router.get('/email-history/:id', protect, authorizeAny(['ta.view', 'ta.manage', 'ta.candidate.manage.all', 'ta.candidate.manage.assigned', 'ta.mass_mail', 'ta.edit']), taController.getTAEmailHistoryById);
router.get('/email-history/:id/attachment/:attachmentIndex', protect, authorizeAny(['ta.view', 'ta.manage', 'ta.candidate.manage.all', 'ta.candidate.manage.assigned', 'ta.mass_mail', 'ta.edit']), taController.downloadTAEmailAttachment);

// Analytics
router.get('/analytics/global', protect, requireTAAnalyticsAccess, taController.getGlobalAnalytics);
router.get('/analytics/client/:clientName', protect, requireTAAnalyticsAccess, taController.getClientAnalytics);
router.get('/analytics/interviews', protect, taController.getInterviewAnalytics);

// Clients list for TA
router.get('/clients', protect, taController.getTAClients);

// TA access settings
router.get('/settings/access/overview', protect, authorizeAny(taAccessSettingsViewPermissions), taAccessSettingsController.getOverview);
router.put('/settings/access/roles/:roleId', protect, authorizeAny(taAccessSettingsEditPermissions), taAccessSettingsController.updateRolePermissions);
router.put('/settings/access/requisitions/:id', protect, authorizeAny(taAccessSettingsEditPermissions), taAccessSettingsController.updateRequisitionAccess);
router.put('/settings/access/users/:userId/clients', protect, authorizeAny(taAccessSettingsEditPermissions), taAccessSettingsController.updateUserClientAssignments);
router.put('/settings/access/clients/assignments', protect, authorizeAny(taAccessSettingsEditPermissions), taAccessSettingsController.updateClientUserAssignments);

// File Uploads
router.post('/hiring-request/upload-jd', protect, upload.single('jdFile'), taController.uploadJDFile);

router.get('/hiring-request/:id/public-applications', protect, async (req, res) => {
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
            return res.status(403).json({ message: 'Forbidden: You do not have permission to view this request' });
        }

        const apps = await PublicApplication.find({
            hiringRequestId: req.params.id,
            companyId: req.companyId
        })
            .populate('applicantId', APPLICANT_REVIEW_SELECT)
            .sort({ createdAt: -1 });

        res.json(apps);
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
                companyId: req.companyId
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
            companyId: req.companyId
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
            status: { $in: ['Approved'] }
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
            source: 'Public Job Board',
            profilePulledBy: `${req.user.firstName || ''} ${req.user.lastName || ''}`.trim(),
            currentCTC: app.currentCTC,
            expectedCTC: app.expectedCTC,
            noticePeriod: app.noticePeriod,
            remark: app.coverNote || '',
            totalExperience: 0,
            status: 'Interested',
            decision: 'None',
            phase2Decision: 'None',
            phase3Decision: 'None',
            isTransferred: targetRequestId.toString() !== req.params.id.toString(),
            transferredFrom: targetRequestId.toString() !== req.params.id.toString() ? req.params.id : undefined,
        });

        await candidate.save();

        app.reviewStatus = 'Transferred';
        app.transferredCandidateId = candidate._id;
        app.transferredAt = new Date();
        app.transferredBy = req.user._id;
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
