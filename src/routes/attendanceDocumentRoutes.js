const express = require('express');
const router = express.Router();
const attachmentController = require('../controllers/attendanceDocumentController');
const { protect } = require('../middlewares/authMiddleware');
const { upload } = require('../config/cloudinary');

router.use(protect);

router.get('/:userId/:month', attachmentController.getAttachments);
router.post('/:userId/:month', upload.single('file'), attachmentController.uploadAttachment);
router.delete('/:userId/:month/:fileId', attachmentController.deleteAttachment);

module.exports = router;
