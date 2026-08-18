const express = require('express');
const router = express.Router();

const tenantMiddleware = require('../common/middleware/tenantMiddleware');
const planGuard = require('../common/middleware/planGuard');
const { globalLimiter } = require('../common/middleware/rateLimitMiddleware');

// Import routes
const authRoutes = require('../modules/auth/auth.routes');
const attendanceRoutes = require('../modules/attendance/attendance.routes');
const rgAttendanceRoutes = require('../modules/rg-attendance/routes/rgAttendanceRoutes');
const timesheetRoutes = require('../modules/timesheet/timesheet.routes');
const adminRoutes = require('../modules/system/admin.routes');
const projectRoutes = require('../modules/project/project.routes');
const dashboardRoutes = require('../modules/system/dashboard.routes');
const holidayRoutes = require('../modules/holiday/holiday.routes');
const leaveRoutes = require('../modules/leave/leave.routes');
const dossierRoutes = require('../modules/dossier/dossier.routes');
const talentAcquisitionRoutes = require('../modules/talent-acquisition/routes/talentAcquisition.routes');
const emailTemplateRoutes = require('../modules/email/routes/emailTemplate.routes');
const candidateRoutes = require('../modules/talent-acquisition/routes/candidate.routes');
const workflowRoutes = require('../modules/workflow/workflow.routes');
const interviewWorkflowRoutes = require('../modules/talent-acquisition/routes/interviewWorkflow.routes');
const notificationRoutes = require('../modules/notification/notification.routes');
const meetingRoutes = require('../modules/meeting/meeting.routes');
const helpdeskRoutes = require('../modules/helpdesk/helpdesk.routes');
const discussionRoutes = require('../modules/discussion/discussion.routes');
const announcementRoutes = require('../modules/announcement/announcement.routes');
const onboardingRoutes = require('../modules/onboarding/onboarding.routes');
const offboardingRoutes = require('../modules/offboarding/offboarding.routes');
const hrEmailRoutes = require('../modules/email/routes/hrEmail.routes');
const attendanceDocumentRoutes = require('../modules/attendance/attendanceDocument.routes');
const publicRoutes = require('../modules/auth/public.routes');
const payrollIntegrationRoutes = require('../modules/payroll/payrollIntegration.routes');
const payrollRoutes = require('../modules/payroll/payroll.routes');

const phaseTemplateRoutes = require('../modules/talent-acquisition/routes/phaseTemplate.routes');
const candidateDynamicPhaseRoutes = require('../modules/talent-acquisition/routes/candidateDynamicPhase.routes');
const binRoutes = require('../modules/bin/bin.routes');
const emailSettingsRoutes = require('../modules/email/routes/emailSettings.routes');
const notificationSettingsRoutes = require('../modules/notification/notificationSettings.routes');
const emailBrandingRoutes = require('../modules/email/routes/emailBranding.routes');
const emailBrandingTemplateRoutes = require('../modules/email/routes/emailBrandingTemplate.routes');
const celebrationRoutes = require('../modules/celebration/celebration.routes');
const reimbursementRoutes = require('../modules/reimbursement/reimbursement.routes');
const essDocumentRoutes = require('../modules/ess-document/essDocument.routes');

const superAdminAuthRoutes = require('../modules/auth/superAdminAuth.routes');
const companyRoutes = require('../modules/company/company.routes');
const globalUserRoutes = require('../modules/user/globalUser.routes');
const analyticsRoutes = require('../modules/system/analytics.routes');
const planRoutes = require('../modules/plan/plan.routes');
const superAdminMiscRoutes = require('../modules/system/superAdminMisc.routes');

// Rate limiting middleware for non-superadmin
router.use((req, res, next) => {
    if (req.path.startsWith('/superadmin')) return next();
    globalLimiter(req, res, next);
});

// Public routes (no tenant/plan checks)
router.use('/public', publicRoutes);

// Tenant & Plan middleware for tenant routes
router.use((req, res, next) => {
    if (req.path.startsWith('/superadmin') || req.path.startsWith('/v1')) return next();
    tenantMiddleware(req, res, (err) => {
        if (err) return next(err);
        planGuard(req, res, next);
    });
});

// Auth & Core tenant routes
router.use('/auth', authRoutes);
router.use('/v1', payrollIntegrationRoutes);
router.use('/payroll', payrollRoutes);

router.use('/attendance/rg', rgAttendanceRoutes);
router.use('/attendance', attendanceRoutes);
router.use('/attendance/attachments', attendanceDocumentRoutes);
router.use('/timesheet', timesheetRoutes);
router.use('/admin', adminRoutes);
router.use('/projects', projectRoutes);
router.use('/dashboard', dashboardRoutes);
router.use('/holidays', holidayRoutes);
router.use('/leaves', leaveRoutes);
router.use('/dossier', dossierRoutes);
router.use('/ta', talentAcquisitionRoutes);
router.use('/ta', phaseTemplateRoutes);
router.use('/ta/email-templates', emailTemplateRoutes);
router.use('/ta/candidates', candidateRoutes);
router.use('/ta', candidateDynamicPhaseRoutes);
router.use('/ta/interview-workflows', interviewWorkflowRoutes);
router.use('/workflows', workflowRoutes);
router.use('/meetings', meetingRoutes);
router.use('/helpdesk', helpdeskRoutes);
router.use('/notifications', notificationRoutes);
router.use('/discussions', discussionRoutes);
router.use('/announcements', announcementRoutes);
router.use('/onboarding', onboardingRoutes);
router.use('/offboarding', offboardingRoutes);
router.use('/hr-email', hrEmailRoutes);
router.use('/bin', binRoutes);
router.use('/company/email-settings', emailSettingsRoutes);
router.use('/company/notification-settings', notificationSettingsRoutes);
router.use('/email-branding', emailBrandingRoutes);
router.use('/email-templates', emailBrandingTemplateRoutes);
router.use('/celebrations', celebrationRoutes);
router.use('/reimbursements', reimbursementRoutes);
router.use('/ess-documents', essDocumentRoutes);

// Superadmin routes
router.use('/superadmin/auth', superAdminAuthRoutes);
router.use('/superadmin/companies', companyRoutes);
router.use('/superadmin/users', globalUserRoutes);
router.use('/superadmin/analytics', analyticsRoutes);
router.use('/superadmin/plans', planRoutes);
router.use('/superadmin', superAdminMiscRoutes);

module.exports = router;
