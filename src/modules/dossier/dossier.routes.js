const express = require('express');
const router = express.Router();
const { requireModule } = require('../../common/middleware/moduleGuard');
const { protect } = require('../../common/middleware/authMiddleware');
const { getDossier } = require('./controllers/dossierProfileController');
const { submitHRIS, updateSection } = require('./controllers/dossierSectionController');
const { addDocument, deleteDocument, verifyDocument, revokeDocumentVerification, verifyAllDocuments, submitDocuments } = require('./controllers/dossierDocumentController');
const { getHRISRequests, approveHRIS, rejectHRIS } = require('./controllers/dossierApprovalController');
const { getDossierHistory } = require('./controllers/dossierHistoryController');
const { exportHRISExcel, proxyPdf } = require('./controllers/dossierExportController');
const { uploadDossierDocuments } = require('../../config/cloudinary');

// All routes require login
router.use(protect);

// Global guard removed to allow basic profile viewing in Profile section
// Specific guards applied below

router.get('/requests', requireModule('employeeDossier'), getHRISRequests);
router.get('/export-excel', requireModule('employeeDossier'), exportHRISExcel);
router.get('/proxy-pdf', requireModule('employeeDossier'), proxyPdf); 

router.patch('/:userId/submit-hris', requireModule('employeeDossier'), submitHRIS);
router.patch('/:userId/approve-hris', requireModule('employeeDossier'), approveHRIS);
router.patch('/:userId/reject-hris', requireModule('employeeDossier'), rejectHRIS);

const uploadMiddleware = (req, res, next) => {
    if (!process.env.CLOUDINARY_CLOUD_NAME) {
        return res.status(500).json({
            message: 'Server Misconfiguration: Missing Cloudinary Credentials',
            error: 'CLOUDINARY_CLOUD_NAME is not set'
        });
    }
    uploadDossierDocuments.single('file')(req, res, (err) => {
        if (err) {
            console.error('Multer/Cloudinary Middleware Error:', err);
            if (err.code === 'LIMIT_FILE_SIZE') {
                return res.status(400).json({ message: 'File size must be 5MB or less.' });
            }
            return res.status(400).json({ message: err.message || 'File Upload Error', error: err.message });
        }
        next();
    });
};

router.post('/:userId/documents', requireModule('employeeDossier'), uploadMiddleware, addDocument);
router.patch('/:userId/documents/:docId/verify', requireModule('employeeDossier'), verifyDocument);
router.patch('/:userId/documents/:docId/revoke', requireModule('employeeDossier'), revokeDocumentVerification);
router.patch('/:userId/documents/verify-all', requireModule('employeeDossier'), verifyAllDocuments);
router.patch('/:userId/documents/submit', requireModule('employeeDossier'), submitDocuments);
router.delete('/:userId/documents/:docId', requireModule('employeeDossier'), deleteDocument);
router.get('/:userId/history', requireModule('employeeDossier'), getDossierHistory);

router.patch('/:userId/:section', updateSection); // section: personal, contact, employment...
router.get('/:userId', getDossier);

module.exports = router;
