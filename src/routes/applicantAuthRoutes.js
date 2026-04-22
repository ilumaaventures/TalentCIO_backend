const express = require('express');
const rateLimit = require('express-rate-limit');
const publicController = require('../controllers/publicController');
const { protectApplicant } = require('../middlewares/applicantAuthMiddleware');
const { upload } = require('../config/cloudinary');

const router = express.Router();

const applicantLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 20,
    message: { message: 'Too many attempts, please try again after 15 minutes' },
    standardHeaders: true,
    legacyHeaders: false
});

router.post('/register', applicantLimiter, publicController.applicantRegister);
router.post('/verify-email', applicantLimiter, publicController.applicantVerifyEmail);
router.post('/resend-verification', applicantLimiter, publicController.applicantResendVerification);
router.post('/login', applicantLimiter, publicController.applicantLogin);
router.post('/forgot-password', applicantLimiter, publicController.applicantForgotPassword);
router.post('/reset-password', applicantLimiter, publicController.applicantResetPassword);

router.get('/me', protectApplicant, publicController.applicantGetMe);
router.get('/my-applications', protectApplicant, publicController.applicantGetMyApplications);
router.get('/profile', protectApplicant, publicController.applicantGetProfile);
router.put('/profile/basic', protectApplicant, publicController.applicantUpdateBasic);
router.put('/profile/summary', protectApplicant, publicController.applicantUpdateSummary);
router.put('/profile/compensation', protectApplicant, publicController.applicantUpdateCompensation);
router.put('/profile/links', protectApplicant, publicController.applicantUpdateLinks);
router.put('/profile/skills', protectApplicant, publicController.applicantUpdateSkills);
router.put('/profile/languages', protectApplicant, publicController.applicantUpdateLanguages);

router.post('/profile/experience', protectApplicant, publicController.applicantAddExperience);
router.put('/profile/experience/:expId', protectApplicant, publicController.applicantUpdateExperience);
router.delete('/profile/experience/:expId', protectApplicant, publicController.applicantDeleteExperience);

router.post('/profile/education', protectApplicant, publicController.applicantAddEducation);
router.put('/profile/education/:eduId', protectApplicant, publicController.applicantUpdateEducation);
router.delete('/profile/education/:eduId', protectApplicant, publicController.applicantDeleteEducation);

router.post('/profile/certification', protectApplicant, publicController.applicantAddCertification);
router.put('/profile/certification/:certId', protectApplicant, publicController.applicantUpdateCertification);
router.delete('/profile/certification/:certId', protectApplicant, publicController.applicantDeleteCertification);

router.post('/profile/resume', protectApplicant, upload.single('resume'), publicController.applicantUploadResume);
router.post('/profile/photo', protectApplicant, upload.single('photo'), publicController.applicantUploadPhoto);

module.exports = router;
