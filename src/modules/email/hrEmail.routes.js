const express = require('express');
const multer = require('multer');
const { protect } = require('../../common/middleware/authMiddleware');
const { authorize } = require('../../common/middleware/authorize');
const { requireModule } = require('../../common/middleware/moduleGuard');
const {
    getEmployees,
    getTemplates,
    sendHREmail,
    getHistory
} = require('./controller/hrEmail.controller');

const router = express.Router();
const upload = multer({
    storage: multer.memoryStorage(),
    limits: {
        fileSize: 10 * 1024 * 1024
    }
});

const uploadAttachments = (req, res, next) => {
    upload.array('attachments', 5)(req, res, (error) => {
        if (!error) {
            return next();
        }

        if (error.code === 'LIMIT_FILE_SIZE') {
            return res.status(413).json({ message: 'Each attachment must be 10MB or less.' });
        }

        if (error.code === 'LIMIT_UNEXPECTED_FILE') {
            return res.status(400).json({ message: 'A maximum of 5 attachments is allowed.' });
        }

        return res.status(400).json({ message: error.message || 'Failed to process attachments.' });
    });
};

router.use(protect);
router.use(requireModule('hrEmail'));

router.get('/employees', authorize('hr_email.send'), getEmployees);
router.get('/templates', authorize('hr_email.send'), getTemplates);
router.post('/send', authorize('hr_email.send'), uploadAttachments, sendHREmail);
router.get('/history/:userId', authorize('hr_email.send'), getHistory);

module.exports = router;
