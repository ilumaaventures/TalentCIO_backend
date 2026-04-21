const express = require('express');
const router = express.Router();
const attachmentController = require('../controllers/attendanceDocumentController');
const { protect } = require('../middlewares/authMiddleware');
const { upload } = require('../config/cloudinary');

router.use(protect);

router.get('/:userId/:month', attachmentController.getAttachments);
router.post('/:userId/:month', upload.single('file'), attachmentController.uploadAttachment);
router.delete('/:userId/:month/:fileId', attachmentController.deleteAttachment);

router.put('/:userId/:month/:fileId/submit', attachmentController.submitAttachmentForApproval);
router.put('/:userId/:month/:fileId/review', attachmentController.reviewAttachment);
router.put('/:userId/:month/:fileId/replace', upload.single('file'), attachmentController.replaceAttachment);

module.exports = router;
