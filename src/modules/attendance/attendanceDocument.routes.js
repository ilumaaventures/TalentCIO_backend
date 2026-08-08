const express = require('express');
const router = express.Router();
const attachmentController = require('./controllers/attendanceDocument.controller');
const { protect } = require('../../common/middleware/authMiddleware');
const { uploadAttendanceDocuments } = require('../../config/cloudinary');

const uploadMiddleware = (req, res, next) => {
    uploadAttendanceDocuments.single('file')(req, res, (err) => {
        if (err) {
            return res.status(400).json({ message: err.message });
        }
        next();
    });
};

router.use(protect);

router.get('/:userId/:month', attachmentController.getAttachments);
router.post('/:userId/:month', uploadMiddleware, attachmentController.uploadAttachment);
router.delete('/:userId/:month/:fileId', attachmentController.deleteAttachment);

router.put('/:userId/:month/:fileId/submit', attachmentController.submitAttachmentForApproval);
router.put('/:userId/:month/:fileId/review', attachmentController.reviewAttachment);
router.put('/:userId/:month/:fileId/replace', uploadMiddleware, attachmentController.replaceAttachment);

module.exports = router;
