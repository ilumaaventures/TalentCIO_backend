const express = require('express');
const { requireModule } = require('../middlewares/moduleGuard');
const router = express.Router();
const taController = require('../controllers/talentAcquisitionController');
const { protect } = require('../middlewares/authMiddleware');
const { authorize } = require('../middlewares/authorize');
const { upload } = require('../config/cloudinary');
const PublicApplication = require('../models/PublicApplication');
const Candidate = require('../models/Candidate');
const { HiringRequest: HiringRequestModel } = require('../models/HiringRequest');

router.use(protect);
router.use(requireModule('talentAcquisition'));

// Hiring Requests
router.post('/hiring-request', protect, authorize('ta.create'), taController.createHiringRequest);
router.get('/hiring-request', protect, taController.getHiringRequests);
router.get('/hiring-request/:id', protect, taController.getHiringRequestById);
router.put('/hiring-request/:id', protect, authorize('ta.edit'), taController.updateHiringRequest);
router.patch('/hiring-request/:id/approve', protect, authorize(['ta.hiring_request.manage', 'ta.super_approve']), taController.approveHiringRequest);
router.patch('/hiring-request/:id/reject', protect, authorize(['ta.hiring_request.manage', 'ta.super_approve']), taController.rejectHiringRequest);
router.patch('/hiring-request/:id/close', protect, authorize('ta.hiring_request.manage'), taController.closeHiringRequest);
router.get('/hiring-request/:id/previous-candidates', protect, taController.getPreviousCandidates);
router.post('/hiring-request/transfer-candidate/:candidateId', protect, authorize('ta.edit'), taController.transferCandidate);

// Analytics
router.get('/analytics/global', protect, taController.getGlobalAnalytics);
router.get('/analytics/client/:clientName', protect, taController.getClientAnalytics);

// Clients list for TA
router.get('/clients', protect, taController.getTAClients);

// File Uploads
router.post('/hiring-request/upload-jd', protect, upload.single('jdFile'), taController.uploadJDFile);

router.get('/hiring-request/:id/public-applications', protect, async (req, res) => {
    try {
        const apps = await PublicApplication.find({
            hiringRequestId: req.params.id,
            companyId: req.companyId
        }).sort({ createdAt: -1 });

        res.json(apps);
    } catch (err) {
        res.status(500).json({ message: 'Failed to fetch public applications' });
    }
});

router.patch('/hiring-request/:id/public-applications/:appId/review', protect, authorize('ta.edit'), async (req, res) => {
    try {
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
        );

        if (!app) {
            return res.status(404).json({ message: 'Application not found' });
        }

        res.json(app);
    } catch (err) {
        res.status(500).json({ message: 'Failed to update review status' });
    }
});

router.post('/hiring-request/:id/public-applications/:appId/transfer', protect, authorize('ta.edit'), async (req, res) => {
    try {
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

        const existing = await Candidate.findOne({
            hiringRequestId: targetRequestId,
            email: app.email
        });

        if (existing) {
            return res.status(409).json({ message: `${app.email} already exists as a candidate in that request.` });
        }

        const candidate = new Candidate({
            hiringRequestId: targetRequestId,
            companyId: req.companyId,
            resumeUrl: app.resumeUrl,
            resumePublicId: app.resumePublicId,
            uploadedBy: req.user._id,
            candidateName: app.candidateName,
            email: app.email,
            mobile: app.mobile,
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
            return res.status(409).json({ message: 'This applicant already exists as a candidate in that request.' });
        }

        console.error(err);
        res.status(500).json({ message: 'Failed to transfer applicant' });
    }
});

router.patch('/hiring-request/:id/visibility', protect, authorize('ta.edit'), async (req, res) => {
    try {
        const { isPublic, publicJobTitle, publicJobDescription } = req.body;

        const job = await HiringRequestModel.findOneAndUpdate(
            { _id: req.params.id, companyId: req.companyId },
            {
                isPublic: Boolean(isPublic),
                ...(publicJobTitle !== undefined && { publicJobTitle }),
                ...(publicJobDescription !== undefined && { publicJobDescription })
            },
            { new: true }
        );

        if (!job) {
            return res.status(404).json({ message: 'Hiring request not found' });
        }

        res.json({
            job,
            message: `Job is now ${isPublic ? 'public on talentcio.in/jobs' : 'private (unlisted)'}`
        });
    } catch (err) {
        res.status(500).json({ message: 'Failed to update job visibility' });
    }
});

module.exports = router;
