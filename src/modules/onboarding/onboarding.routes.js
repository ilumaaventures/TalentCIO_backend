const express = require('express');
const router = express.Router();
const { protect, admin } = require('../../common/middleware/authMiddleware');
const { authorize } = require('../../common/middleware/authorize');
const { upload, uploadOnboardingCustomFiles } = require('../../config/cloudinary');
const { requireModule } = require('../../common/middleware/moduleGuard');

// Apply module checks to HR Admin / Settings routes
router.use('/employees', requireModule('onboarding'));
router.use('/bootstrap', requireModule('onboarding'));
router.use('/settings', requireModule('onboarding'));

const adminController = require('./controllers/onboardingAdminController');
const emailController = require('./controllers/onboardingEmailController');
const reviewController = require('./controllers/onboardingReviewController');
const docGenController = require('./controllers/onboardingDocGenController');
const transferController = require('./controllers/onboardingTransferController');
const settingsController = require('./controllers/onboardingSettingsController');
const selfServiceController = require('./controllers/onboardingSelfServiceController');

const onboardingController = {
    addEmployee: adminController.addEmployee,
    bulkAddEmployees: adminController.bulkAddEmployees,
    getOnboardingList: adminController.getOnboardingList,
    getOnboardingEmployee: adminController.getOnboardingEmployee,
    updateEmployee: adminController.updateEmployee,
    regenerateCredentials: adminController.regenerateCredentials,
    requestExtension: adminController.requestExtension,
    resolveExtensionRequest: adminController.resolveExtensionRequest,
    requestCredentialRegeneration: adminController.requestCredentialRegeneration,

    sendPreOnboardingEmail: emailController.sendPreOnboardingEmail,
    addCustomFiles: emailController.addCustomFiles,
    deleteCustomFile: emailController.deleteCustomFile,
    sendCustomFile: emailController.sendCustomFile,

    toggleDocLivePhoto: reviewController.toggleDocLivePhoto,
    flagDocument: reviewController.flagDocument,
    approveDocument: reviewController.approveDocument,
    downloadAllDocuments: reviewController.downloadAllDocuments,

    generateOfferLetter: docGenController.generateOfferLetter,
    generateDeclaration: docGenController.generateDeclaration,
    generateDynamicTemplate: docGenController.generateDynamicTemplate,

    transferToActiveEmployee: transferController.transferToActiveEmployee,

    getOnboardingSettings: settingsController.getOnboardingSettings,
    updateTemplate: settingsController.updateTemplate,
    uploadAndSetTemplate: settingsController.uploadAndSetTemplate,
    deleteBaseTemplate: settingsController.deleteBaseTemplate,
    addPolicy: settingsController.addPolicy,
    deletePolicy: settingsController.deletePolicy,
    addDynamicTemplate: settingsController.addDynamicTemplate,
    deleteDynamicTemplate: settingsController.deleteDynamicTemplate,
    getTemplatePreview: settingsController.getTemplatePreview,
    downloadTemplate: settingsController.downloadTemplate,

    employeeLogin: selfServiceController.employeeLogin,
    refreshToken: selfServiceController.refreshToken,
    changePassword: selfServiceController.changePassword,
    logout: selfServiceController.logout,
    getMyOnboarding: selfServiceController.getMyOnboarding,
    saveSection: selfServiceController.saveSection,
    uploadDocument: selfServiceController.uploadDocument,
    addDocumentSlot: selfServiceController.addDocumentSlot,
    deleteDocumentSlot: selfServiceController.deleteDocumentSlot,
    uploadCheque: selfServiceController.uploadCheque,
    submitOnboarding: selfServiceController.submitOnboarding,
    acceptPolicy: selfServiceController.acceptPolicy,
    acceptTemplate: selfServiceController.acceptTemplate,
    getMyOfferLetter: selfServiceController.getMyOfferLetter,
    acceptOfferLetter: selfServiceController.acceptOfferLetter,
    downloadTemplateById: selfServiceController.downloadTemplateById
};
const OnboardingEmployee = require('./model/onboardingEmployee.model');
const jwt = require('jsonwebtoken');
const { getTokenFromRequest } = require('../../common/utils/sessionCookies');
const { getOnboardingBootstrap } = require('../system/pageBootstrap.controller');
// Onboarding Token Auth Middleware
// ==========================================
const protectOnboarding = async (req, res, next) => {
    let token = getTokenFromRequest(req, 'onboarding_session');

    if (token) {
        try {
            const decoded = jwt.verify(token, process.env.JWT_SECRET);

            if (decoded.type !== 'onboarding') {
                return res.status(401).json({ message: 'Invalid token type' });
            }

            const employee = await OnboardingEmployee.findById(decoded.id);
            if (!employee) {
                return res.status(401).json({ message: 'Employee not found' });
            }

            if (decoded.companyId && String(decoded.companyId) !== String(employee.companyId)) {
                return res.status(401).json({ message: 'Tenant validation failed' });
            }

            if (req.companyId && String(req.companyId) !== String(employee.companyId)) {
                return res.status(401).json({ message: 'Workspace validation failed' });
            }

            if ((decoded.tokenVersion || 0) !== (employee.tokenVersion || 0)) {
                return res.status(401).json({ message: 'Session expired. Please login again.', code: 'SESSION_EXPIRED' });
            }

            // Check credential expiry
            if (employee.credentialsExpireAt && new Date() > new Date(employee.credentialsExpireAt)) {
                return res.status(401).json({ message: 'Credentials expired' });
            }

            req.companyId = employee.companyId;
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
const ONBOARDING_VIEW_PERMISSIONS = [
    'onboarding.view',
    'onboarding.document.review',
    'onboarding.document.request',
    'onboarding.credential.manage',
    'onboarding.complete',
    'onboarding.manage'
];
const ONBOARDING_REQUEST_PERMISSIONS = ['onboarding.document.request', 'onboarding.manage'];
const ONBOARDING_REVIEW_PERMISSIONS = ['onboarding.document.review', 'onboarding.manage'];
const ONBOARDING_CREDENTIAL_PERMISSIONS = ['onboarding.credential.manage', 'onboarding.manage'];
const ONBOARDING_COMPLETE_PERMISSIONS = ['onboarding.complete', 'onboarding.manage'];

const requireOnboardingView = authorize(ONBOARDING_VIEW_PERMISSIONS);
const requireOnboardingRequest = authorize(ONBOARDING_REQUEST_PERMISSIONS);
const requireOnboardingReview = authorize(ONBOARDING_REVIEW_PERMISSIONS);
const requireOnboardingCredentialManage = authorize(ONBOARDING_CREDENTIAL_PERMISSIONS);
const requireOnboardingComplete = authorize(ONBOARDING_COMPLETE_PERMISSIONS);
const requireOnboardingRequestOrCredentialManage = authorize([
    ...new Set([...ONBOARDING_REQUEST_PERMISSIONS, ...ONBOARDING_CREDENTIAL_PERMISSIONS])
]);

const handleCustomFileUpload = (req, res, next) => {
    uploadOnboardingCustomFiles.array('documents', 10)(req, res, (err) => {
        if (!err) return next();

        if (err.code === 'LIMIT_FILE_SIZE') {
            return res.status(413).json({ message: 'Each file must be 5 MB or smaller.' });
        }

        return res.status(400).json({ message: err.message || 'Invalid file upload.' });
    });
};

router.post('/employees', protect, requireOnboardingRequest, onboardingController.addEmployee);
router.post('/employees/bulk', protect, requireOnboardingRequest, onboardingController.bulkAddEmployees);
router.get('/bootstrap', protect, requireOnboardingView, getOnboardingBootstrap);
router.get('/employees', protect, requireOnboardingView, onboardingController.getOnboardingList);
router.get('/employees/:id', protect, requireOnboardingView, onboardingController.getOnboardingEmployee);
router.patch('/employees/:id', protect, requireOnboardingRequestOrCredentialManage, onboardingController.updateEmployee);
router.post('/employees/:id/custom-files', protect, requireOnboardingRequest, handleCustomFileUpload, onboardingController.addCustomFiles);
router.delete('/employees/:id/custom-files/:docId', protect, requireOnboardingRequest, onboardingController.deleteCustomFile);
router.post('/employees/:id/regenerate-credentials', protect, requireOnboardingCredentialManage, onboardingController.regenerateCredentials);
router.post('/employees/:id/send-onboarding-email', protect, requireOnboardingRequest, onboardingController.sendPreOnboardingEmail);
router.post('/employees/:id/send-custom-file', protect, requireOnboardingRequest, handleCustomFileUpload, onboardingController.sendCustomFile);
router.patch('/employees/:id/documents/:docId/flag', protect, requireOnboardingReview, onboardingController.flagDocument);
router.patch('/employees/:id/documents/:docId/approve', protect, requireOnboardingReview, onboardingController.approveDocument);
router.patch('/employees/:id/documents/:docId/live-photo', protect, requireOnboardingReview, onboardingController.toggleDocLivePhoto);
router.post('/employees/:id/extension/:extId/resolve', protect, requireOnboardingCredentialManage, onboardingController.resolveExtensionRequest);
router.get('/employees/:id/download', protect, requireOnboardingReview, onboardingController.downloadAllDocuments);
router.get('/employees/:id/offer-letter', protect, requireOnboardingRequest, onboardingController.generateOfferLetter);
router.get('/employees/:id/declaration', protect, requireOnboardingRequest, onboardingController.generateDeclaration);
router.get('/employees/:id/dynamic-template/:templateId', protect, requireOnboardingRequest, onboardingController.generateDynamicTemplate);
router.post('/employees/:id/transfer-to-active', protect, requireOnboardingComplete, onboardingController.transferToActiveEmployee);

// --- Settings & Templates ---
router.get('/settings', protect, requireOnboardingView, onboardingController.getOnboardingSettings);
router.post('/settings/templates', protect, requireOnboardingRequest, onboardingController.updateTemplate);
router.post('/settings/templates/upload', protect, requireOnboardingRequest, upload.single('document'), onboardingController.uploadAndSetTemplate);
router.post('/settings/templates/dynamic/upload', protect, requireOnboardingRequest, upload.single('document'), onboardingController.addDynamicTemplate);
router.delete('/settings/templates/dynamic/:templateId', protect, requireOnboardingRequest, onboardingController.deleteDynamicTemplate);
router.get('/settings/templates/:type/preview', protect, requireOnboardingView, onboardingController.getTemplatePreview);
router.delete('/settings/templates/:type', protect, requireOnboardingRequest, onboardingController.deleteBaseTemplate);
router.get('/settings/templates/:type/download', protect, requireOnboardingView, onboardingController.downloadTemplate);

// --- Policies ---
router.post('/settings/policies/upload', protect, requireOnboardingRequest, upload.single('document'), onboardingController.addPolicy);
router.delete('/settings/policies/:policyId', protect, requireOnboardingRequest, onboardingController.deletePolicy);

// ==========================================
// EMPLOYEE SELF-SERVICE ROUTES (Public / Onboarding Token)
// ==========================================
router.post('/login', onboardingController.employeeLogin);
router.post('/change-password', protectOnboarding, onboardingController.changePassword);
router.post('/logout', protectOnboarding, onboardingController.logout);
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
