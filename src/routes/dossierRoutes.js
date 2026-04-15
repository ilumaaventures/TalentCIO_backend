const express = require('express');
const { requireModule } = require('../middlewares/moduleGuard');
const router = express.Router();
const { protect } = require('../middlewares/authMiddleware'); // Assuming this exists
const { getDossier, updateSection, addDocument, getDossierHistory, deleteDocument, submitHRIS, approveHRIS, rejectHRIS, exportHRISExcel, getHRISRequests, verifyDocument, verifyAllDocuments, submitDocuments, proxyPdf } = require('../controllers/dossierController');
const { upload } = require('../config/cloudinary');

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
    upload.single('file')(req, res, (err) => {
        if (err) {
            console.error('Multer/Cloudinary Middleware Error:', err);
            return res.status(500).json({ message: 'File Upload Error', error: err.message });
        }
        next();
    });
};

router.post('/:userId/documents', requireModule('employeeDossier'), uploadMiddleware, addDocument);
router.patch('/:userId/documents/:docId/verify', requireModule('employeeDossier'), verifyDocument);
router.patch('/:userId/documents/verify-all', requireModule('employeeDossier'), verifyAllDocuments);
router.patch('/:userId/documents/submit', requireModule('employeeDossier'), submitDocuments);
router.delete('/:userId/documents/:docId', requireModule('employeeDossier'), deleteDocument);
router.get('/:userId/history', requireModule('employeeDossier'), getDossierHistory);

router.patch('/:userId/:section', updateSection); // section: personal, contact, employment...
router.get('/:userId', getDossier);

module.exports = router;
