const express = require('express');
const router = express.Router();
const { protect, admin } = require('../middlewares/authMiddleware');
const { authorize } = require('../middlewares/authorize');
const { upload } = require('../config/cloudinary');
const onboardingController = require('../controllers/onboardingController');
const OnboardingEmployee = require('../models/OnboardingEmployee');
const jwt = require('jsonwebtoken');
const { getOnboardingBootstrap } = require('../controllers/pageBootstrapController');

// ==========================================
// Onboarding Token Auth Middleware
// ==========================================
const protectOnboarding = async (req, res, next) => {
    let token;

    if (req.headers.authorization && req.headers.authorization.startsWith('Bearer')) {
        try {
            token = req.headers.authorization.split(' ')[1];
            const decoded = jwt.verify(token, process.env.JWT_SECRET);

            if (decoded.type !== 'onboarding') {
                return res.status(401).json({ message: 'Invalid token type' });
            }

            const employee = await OnboardingEmployee.findById(decoded.id);
            if (!employee) {
                return res.status(401).json({ message: 'Employee not found' });
            }

            // Check credential expiry
            if (employee.credentialsExpireAt && new Date() > new Date(employee.credentialsExpireAt)) {
                return res.status(401).json({ message: 'Credentials expired' });
            }

            req.onboardingEmployee = employee;
            next();
        } catch (error) {
            if (error.name === 'TokenExpiredError') {
                return res.status(401).json({ message: 'Session expired. Please login again.', code: 'SESSION_EXPIRED' });
            }
            return res.status(401).json({ message: 'Not authorized' });
        }
    } else {
        return res.status(401).json({ message: 'Not authorized, no token' });
    }
};

// ==========================================
// HR ADMIN ROUTES (Protected + Admin)
// ==========================================
const requireOnboarding = authorize('onboarding.manage');

router.post('/employees', protect, requireOnboarding, onboardingController.addEmployee);
router.post('/employees/bulk', protect, requireOnboarding, onboardingController.bulkAddEmployees);
router.get('/bootstrap', protect, requireOnboarding, getOnboardingBootstrap);
router.get('/employees', protect, requireOnboarding, onboardingController.getOnboardingList);
router.get('/employees/:id', protect, requireOnboarding, onboardingController.getOnboardingEmployee);
router.patch('/employees/:id', protect, requireOnboarding, onboardingController.updateEmployee);
router.post('/employees/:id/regenerate-credentials', protect, requireOnboarding, onboardingController.regenerateCredentials);
router.post('/employees/:id/send-onboarding-email', protect, requireOnboarding, onboardingController.sendPreOnboardingEmail);
router.post('/employees/:id/send-custom-file', protect, requireOnboarding, upload.array('documents', 10), onboardingController.sendCustomFile);
router.patch('/employees/:id/documents/:docId/flag', protect, requireOnboarding, onboardingController.flagDocument);
router.patch('/employees/:id/documents/:docId/approve', protect, requireOnboarding, onboardingController.approveDocument);
router.post('/employees/:id/extension/:extId/resolve', protect, requireOnboarding, onboardingController.resolveExtensionRequest);
router.get('/employees/:id/download', protect, requireOnboarding, onboardingController.downloadAllDocuments);
router.get('/employees/:id/offer-letter', protect, requireOnboarding, onboardingController.generateOfferLetter);
router.get('/employees/:id/declaration', protect, requireOnboarding, onboardingController.generateDeclaration);
router.get('/employees/:id/dynamic-template/:templateId', protect, requireOnboarding, onboardingController.generateDynamicTemplate);
router.post('/employees/:id/transfer-to-active', protect, requireOnboarding, onboardingController.transferToActiveEmployee);

// --- Settings & Templates ---
router.get('/settings', protect, requireOnboarding, onboardingController.getOnboardingSettings);
router.post('/settings/templates', protect, requireOnboarding, onboardingController.updateTemplate);
router.post('/settings/templates/upload', protect, requireOnboarding, upload.single('document'), onboardingController.uploadAndSetTemplate);
router.post('/settings/templates/dynamic/upload', protect, requireOnboarding, upload.single('document'), onboardingController.addDynamicTemplate);
router.delete('/settings/templates/dynamic/:templateId', protect, requireOnboarding, onboardingController.deleteDynamicTemplate);
router.get('/settings/templates/:type/preview', protect, requireOnboarding, onboardingController.getTemplatePreview);
router.delete('/settings/templates/:type', protect, requireOnboarding, onboardingController.deleteBaseTemplate);
router.get('/settings/templates/:type/download', protect, requireOnboarding, onboardingController.downloadTemplate);

// --- Policies ---
router.post('/settings/policies/upload', protect, requireOnboarding, upload.single('document'), onboardingController.addPolicy);
router.delete('/settings/policies/:policyId', protect, requireOnboarding, onboardingController.deletePolicy);

// ==========================================
// EMPLOYEE SELF-SERVICE ROUTES (Public / Onboarding Token)
// ==========================================
router.post('/login', onboardingController.employeeLogin);
router.post('/change-password', protectOnboarding, onboardingController.changePassword);
router.get('/my-offer-letter', protectOnboarding, onboardingController.getMyOfferLetter);
router.post('/my-profile/accept-offer', protectOnboarding, onboardingController.acceptOfferLetter);
router.post('/refresh-token', protectOnboarding, onboardingController.refreshToken);
router.get('/my-profile', protectOnboarding, onboardingController.getMyOnboarding);
router.patch('/my-profile/:section', protectOnboarding, onboardingController.saveSection);
router.post('/my-profile/upload/:docId', protectOnboarding, upload.single('document'), onboardingController.uploadDocument);
router.post('/my-profile/add-document-slot', protectOnboarding, onboardingController.addDocumentSlot);
router.delete('/my-profile/delete-document-slot/:docId', protectOnboarding, onboardingController.deleteDocumentSlot);
router.post('/my-profile/upload-cheque', protectOnboarding, upload.single('document'), onboardingController.uploadCheque);
router.post('/my-profile/policies/:policyId/accept', protectOnboarding, onboardingController.acceptPolicy);
router.get('/my-profile/download-template/:templateId', protectOnboarding, onboardingController.downloadTemplateById);
router.post('/my-profile/templates/:templateId/accept', protectOnboarding, onboardingController.acceptTemplate);
router.post('/my-profile/submit', protectOnboarding, onboardingController.submitOnboarding);
router.post('/my-profile/request-extension', protectOnboarding, onboardingController.requestExtension);
router.post('/request-regeneration', onboardingController.requestCredentialRegeneration);

module.exports = router;
