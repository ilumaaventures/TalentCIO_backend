const express = require('express');
const { requireModule } = require('../middlewares/moduleGuard');
const router = express.Router();
const taController = require('../controllers/talentAcquisitionController');
const { protect } = require('../middlewares/authMiddleware');
const { authorize } = require('../middlewares/authorize');
const { upload } = require('../config/cloudinary');

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

module.exports = router;
