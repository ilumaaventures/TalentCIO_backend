const express = require('express');
const multer = require('multer');
const { protect } = require('../middlewares/authMiddleware');
const { authorize } = require('../middlewares/authorize');
const { requireModule } = require('../middlewares/moduleGuard');
const {
    initiateOffboarding,
    getOffboardingList,
    getOffboardingById,
    updateOffboarding,
    sendOffboardingEmail,
    sendExitDocuments,
    completeOffboarding,
    getOffboardingStats
} = require('../controllers/offboardingController');

const router = express.Router();
const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 10 * 1024 * 1024 }
});

router.use(protect);
router.use(requireModule('offboarding'));

router.get('/stats', authorize('offboarding.read'), getOffboardingStats);
router.get('/', authorize('offboarding.read'), getOffboardingList);
router.post('/', authorize('offboarding.create'), initiateOffboarding);
router.get('/:id', authorize('offboarding.read'), getOffboardingById);
router.put('/:id', authorize('offboarding.update'), updateOffboarding);
router.post('/:id/send-email', authorize('offboarding.update'), upload.array('attachments', 5), sendOffboardingEmail);
router.post('/:id/send-documents', authorize('offboarding.update'), sendExitDocuments);
router.post('/:id/complete', authorize('offboarding.update'), completeOffboarding);

module.exports = router;
