const express = require('express');
const { protect } = require('../../common/middleware/authMiddleware');
const { authorizeRoleOrPermission } = require('../../common/middleware/authorize');
const { requireModule } = require('../../common/middleware/moduleGuard');
const { uploadAnnouncementAttachment } = require('../../config/cloudinary');
const controller = require('./essDocument.controller');

const router = express.Router();

/** Admin / HR roles that can upload and manage documents */
const manageDocuments = authorizeRoleOrPermission({
    roles:       ['Admin', 'HR Admin', 'System Admin'],
    permissions: ['ess_document.manage']
});

/** Multiple / single file upload middleware — reuses announcement Cloudinary storage */
const handleDocumentUpload = (req, res, next) => {
    uploadAnnouncementAttachment.fields([
        { name: 'file',  maxCount: 1 },
        { name: 'files', maxCount: 10 }
    ])(req, res, (err) => {
        if (!err) {
            if (req.files?.files?.length) {
                req.filesList = req.files.files;
            } else if (req.files?.file?.length) {
                req.filesList = req.files.file;
                req.file = req.files.file[0];
            } else {
                req.filesList = [];
            }
            return next();
        }
        if (err.code === 'LIMIT_FILE_SIZE')
            return res.status(413).json({ message: 'Each document must be 5 MB or smaller.' });
        return res.status(400).json({ message: err.message || 'Invalid file upload.' });
    });
};

// ─── All routes require auth + module enabled ─────────────────────────────────

router.use(protect);
router.use(requireModule('essDocuments'));

// ─── Employee routes ──────────────────────────────────────────────────────────

router.get('/mine',             controller.getEmployeeDocuments);
router.post('/:id/acknowledge', controller.acknowledgeDocument);

// ─── Admin routes ─────────────────────────────────────────────────────────────

router.get('/',                          manageDocuments, controller.getDocuments);
router.post('/',                         manageDocuments, handleDocumentUpload, controller.createDocument);
router.get('/:id/acknowledgements',      manageDocuments, controller.getDocumentAcknowledgements);
router.delete('/:id',                    manageDocuments, controller.deleteDocument);

module.exports = router;
