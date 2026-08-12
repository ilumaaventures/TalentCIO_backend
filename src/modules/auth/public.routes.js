const express = require('express');
const rateLimit = require('express-rate-limit');
const publicController = require('./public.controller');
const applicantAuthRoutes = require('../auth/applicantAuth.routes');
const { upload } = require('../../config/cloudinary');
const { protectApplicant } = require('../../common/middleware/applicantAuthMiddleware');

const router = express.Router();
const companyLoginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 5,
    message: { message: 'Too many login attempts. Please try again in 15 minutes.' },
    standardHeaders: true,
    legacyHeaders: false
});

router.get('/plans', publicController.getPublicPlans);
router.post('/demo-request', publicController.createDemoRequest);
router.post('/company-login', companyLoginLimiter, publicController.companyLogin);
router.post('/company-login/exchange', publicController.exchangeHandoffToken);
router.get('/jobs', publicController.getPublicJobs);
router.get('/jobs/:id', publicController.getPublicJobById);
router.get('/resource-gateway/jobs', publicController.getResourceGatewayJobs);
router.get('/resource-gateway/jobs/:id', publicController.getResourceGatewayJobById);
router.post('/jobs/:id/apply', protectApplicant, upload.single('resume'), publicController.applyToJob);
router.post('/general-application', protectApplicant, upload.single('resume'), publicController.submitGeneralApplication);
router.use('/applicant', applicantAuthRoutes);

module.exports = router;
