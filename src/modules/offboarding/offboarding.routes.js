const express = require('express');
const multer = require('multer');
const { protect } = require('../../common/middleware/authMiddleware');
const { authorize } = require('../../common/middleware/authorize');
const { requireModule } = require('../../common/middleware/moduleGuard');
const {
    initiateOffboarding,
    getOffboardingList,
    getOffboardingById,
    updateOffboarding,
    sendOffboardingEmail,
    sendExitDocuments,
    completeOffboarding,
    getOffboardingStats,
    getLetterTags,
    generateAndSaveLetter,
    previewLetter,
    getDossierLetters,
    sendDossierLetters,
    getLetterTemplates,
    saveLetterTemplate,
    generateBatchLetters
} = require('./offboarding.controller');

const router = express.Router();
const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 10 * 1024 * 1024 }
});

router.use(protect);
router.use(requireModule('offboarding'));

router.get('/stats', authorize('offboarding.read'), getOffboardingStats);
router.get('/templates', authorize('offboarding.read'), getLetterTemplates);
router.post('/templates', authorize('offboarding.create', 'offboarding.update'), upload.single('file'), saveLetterTemplate);
router.get('/letter-tags', authorize('offboarding.read'), getLetterTags);
router.get('/dossier-letters/:userId', authorize('offboarding.read'), getDossierLetters);
router.post('/preview-letter', authorize('offboarding.read'), upload.single('file'), previewLetter);
router.post('/generate-letter', authorize('offboarding.create', 'offboarding.update'), upload.single('file'), generateAndSaveLetter);
router.post('/generate-batch-letters', authorize('offboarding.create', 'offboarding.update'), upload.single('file'), generateBatchLetters);
router.get('/', authorize('offboarding.read'), getOffboardingList);
router.post('/', authorize('offboarding.create'), initiateOffboarding);
router.get('/:id', authorize('offboarding.read'), getOffboardingById);
router.put('/:id', authorize('offboarding.update'), updateOffboarding);
router.post('/:id/send-email', authorize('offboarding.update'), upload.array('attachments', 5), sendOffboardingEmail);
router.post('/:id/send-documents', authorize('offboarding.update'), sendExitDocuments);
router.post('/:id/send-dossier-letters', authorize('offboarding.update'), sendDossierLetters);
router.post('/:id/complete', authorize('offboarding.update'), completeOffboarding);

module.exports = router;
