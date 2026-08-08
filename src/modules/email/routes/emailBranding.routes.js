const express = require('express');
const multer = require('multer');
const { protect } = require('../../../common/middleware/authMiddleware');
const { authorize } = require('../../../common/middleware/authorize');
const controller = require('../controller/emailBranding.controller');

const router = express.Router();

const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 3 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
        const allowedMimeTypes = [
            'image/jpeg',
            'image/jpg',
            'image/png',
            'image/svg+xml',
            'image/webp'
        ];

        if (allowedMimeTypes.includes(file.mimetype)) {
            return cb(null, true);
        }

        return cb(new Error('Only JPG, PNG, SVG, WEBP images are allowed.'));
    }
});

router.use(protect);

router.get('/', authorize('settings.email.view'), controller.getEmailBranding);
router.put('/', authorize('settings.email.manage'), controller.updateEmailBranding);
router.post('/logo', authorize('settings.email.manage'), upload.single('logo'), controller.uploadEmailLogo);
router.delete('/logo', authorize('settings.email.manage'), controller.removeEmailLogo);
router.post('/use-company-logo', authorize('settings.email.manage'), controller.useCompanyLogo);

module.exports = router;
