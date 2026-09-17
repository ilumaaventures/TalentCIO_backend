const express = require('express');
const router = express.Router();
const { protect } = require('../../../common/middleware/authMiddleware');
const { authorize } = require('../../../common/middleware/authorize');

const leadController = require('../controllers/crmLead.controller');
const dealController = require('../controllers/crmDeal.controller');
const contactController = require('../controllers/crmContact.controller');
const accountController = require('../controllers/crmAccount.controller');
const pipelineController = require('../controllers/crmPipeline.controller');
const activityController = require('../controllers/crmActivity.controller');
const taskController = require('../controllers/crmTask.controller');
const followUpController = require('../controllers/crmFollowUp.controller');
const communicationController = require('../controllers/crmCommunication.controller');
const sequenceController = require('../controllers/crmSequence.controller');
const campaignController = require('../controllers/crmCampaign.controller');
const forecastController = require('../controllers/crmForecast.controller');
const analyticsController = require('../controllers/crmAnalytics.controller');
const workflowController = require('../controllers/crmWorkflow.controller');
const aiController = require('../controllers/crmAi.controller');
const adminController = require('../controllers/crmAdmin.controller');
const dataController = require('../controllers/crmData.controller');

const { requireModule } = require('../../../common/middleware/moduleGuard');

// Require authentication and company module access for all CRM routes
router.use(protect);
router.use(requireModule('crm'));

// --- Leads ---
router.get('/leads', authorize(['crm.leads.read', 'crm.admin']), leadController.getLeads);
router.post('/leads/check-duplicates', authorize(['crm.leads.read', 'crm.leads.create', 'crm.leads.update', 'crm.admin']), leadController.checkDuplicates);
router.post('/leads/check-duplicates-batch', authorize(['crm.leads.read', 'crm.leads.create', 'crm.data.import', 'crm.admin']), leadController.checkDuplicatesBatch);
router.post('/leads/bulk-update', authorize(['crm.leads.update', 'crm.admin']), leadController.bulkUpdateLeads);
router.post('/leads/move-to-bin', authorize(['crm.leads.delete', 'crm.leads.update', 'crm.leads.create', 'crm.admin']), leadController.moveToRecycleBin);
router.get('/leads/:id', authorize(['crm.leads.read', 'crm.admin']), leadController.getLeadById);
router.post('/leads', authorize(['crm.leads.create', 'crm.admin']), leadController.createLead);
router.put('/leads/:id', authorize(['crm.leads.update', 'crm.admin']), leadController.updateLead);
router.delete('/leads/:id', authorize(['crm.leads.delete', 'crm.admin']), leadController.deleteLead);
router.post('/leads/:id/convert', authorize(['crm.leads.convert', 'crm.leads.update', 'crm.admin']), leadController.convertLead);

// --- Deals / Opportunities ---
router.get('/deals/pipeline-board', authorize(['crm.deals.read', 'crm.admin']), dealController.getPipelineBoard);
router.get('/deals', authorize(['crm.deals.read', 'crm.admin']), dealController.getDeals);
router.get('/deals/:id', authorize(['crm.deals.read', 'crm.admin']), dealController.getDealById);
router.post('/deals', authorize(['crm.deals.create', 'crm.admin']), dealController.createDeal);
router.patch('/deals/:id/stage', authorize(['crm.deals.update', 'crm.admin']), dealController.updateDealStage);
router.put('/deals/:id', authorize(['crm.deals.update', 'crm.admin']), dealController.updateDeal);
router.delete('/deals/:id', authorize(['crm.deals.delete', 'crm.admin']), dealController.deleteDeal);

// --- Pipelines ---
router.get('/pipelines', authorize(['crm.pipelines.read', 'crm.pipelines.manage', 'crm.deals.read', 'crm.admin']), pipelineController.getPipelines);
router.post('/pipelines', authorize(['crm.pipelines.manage', 'crm.admin']), pipelineController.createPipeline);
router.put('/pipelines/:id', authorize(['crm.pipelines.manage', 'crm.admin']), pipelineController.updatePipeline);
router.delete('/pipelines/:id', authorize(['crm.pipelines.manage', 'crm.admin']), pipelineController.deletePipeline);

// --- Contacts ---
router.get('/contacts', authorize(['crm.contacts.read', 'crm.contacts.manage', 'crm.admin']), contactController.getContacts);
router.get('/contacts/:id', authorize(['crm.contacts.read', 'crm.contacts.manage', 'crm.admin']), contactController.getContactById);
router.post('/contacts', authorize(['crm.contacts.manage', 'crm.admin']), contactController.createContact);
router.put('/contacts/:id', authorize(['crm.contacts.manage', 'crm.admin']), contactController.updateContact);
router.delete('/contacts/:id', authorize(['crm.contacts.manage', 'crm.admin']), contactController.deleteContact);

// --- Accounts / Companies ---
router.get('/companies', authorize(['crm.accounts.read', 'crm.accounts.manage', 'crm.admin']), accountController.getAccounts);
router.get('/companies/:id', authorize(['crm.accounts.read', 'crm.accounts.manage', 'crm.admin']), accountController.getAccountById);
router.post('/companies', authorize(['crm.accounts.manage', 'crm.admin']), accountController.createAccount);
router.put('/companies/:id', authorize(['crm.accounts.manage', 'crm.admin']), accountController.updateAccount);
router.delete('/companies/:id', authorize(['crm.accounts.manage', 'crm.admin']), accountController.deleteAccount);

router.get('/accounts', authorize(['crm.accounts.read', 'crm.accounts.manage', 'crm.admin']), accountController.getAccounts);
router.get('/accounts/:id', authorize(['crm.accounts.read', 'crm.accounts.manage', 'crm.admin']), accountController.getAccountById);
router.post('/accounts', authorize(['crm.accounts.manage', 'crm.admin']), accountController.createAccount);
router.put('/accounts/:id', authorize(['crm.accounts.manage', 'crm.admin']), accountController.updateAccount);
router.delete('/accounts/:id', authorize(['crm.accounts.manage', 'crm.admin']), accountController.deleteAccount);

// --- Activities & Timeline ---
router.get('/activities', authorize(['crm.activities.read', 'crm.activities.create', 'crm.admin']), activityController.getActivities);
router.post('/activities', authorize(['crm.activities.create', 'crm.admin']), activityController.logActivity);

// --- Tasks ---
router.get('/tasks', authorize(['crm.tasks.read', 'crm.tasks.manage', 'crm.admin']), taskController.getTasks);
router.post('/tasks', authorize(['crm.tasks.manage', 'crm.admin']), taskController.createTask);
router.put('/tasks/:id', authorize(['crm.tasks.manage', 'crm.admin']), taskController.updateTask);
router.delete('/tasks/:id', authorize(['crm.tasks.manage', 'crm.admin']), taskController.deleteTask);

// --- Follow-ups ---
router.get('/follow-ups', authorize(['crm.followups.read', 'crm.followups.manage', 'crm.admin']), followUpController.getFollowUps);
router.post('/follow-ups', authorize(['crm.followups.manage', 'crm.admin']), followUpController.createFollowUp);
router.patch('/follow-ups/:id/complete', authorize(['crm.followups.manage', 'crm.admin']), followUpController.completeFollowUp);
router.patch('/follow-ups/:id/reschedule', authorize(['crm.followups.manage', 'crm.admin']), followUpController.rescheduleFollowUp);
router.delete('/follow-ups/:id', authorize(['crm.followups.manage', 'crm.admin']), followUpController.deleteFollowUp);

// --- Communication Hub ---
router.get('/communication/emails', authorize(['crm.communication.read', 'crm.communication.send', 'crm.admin']), communicationController.getEmails);
router.post('/communication/emails', authorize(['crm.communication.send', 'crm.admin']), communicationController.sendEmail);
router.get('/communication/whatsapp', authorize(['crm.communication.read', 'crm.communication.send', 'crm.admin']), communicationController.getWhatsAppMessages);
router.post('/communication/whatsapp', authorize(['crm.communication.send', 'crm.admin']), communicationController.sendWhatsAppMessage);
router.get('/communication/calls', authorize(['crm.communication.read', 'crm.communication.send', 'crm.admin']), communicationController.getCalls);
router.post('/communication/calls', authorize(['crm.communication.send', 'crm.admin']), communicationController.logCall);

// --- Growth, Sequences & Campaigns ---
router.get('/sequences', authorize(['crm.growth.read', 'crm.growth.manage', 'crm.admin']), sequenceController.getSequences);
router.post('/sequences', authorize(['crm.growth.manage', 'crm.admin']), sequenceController.createSequence);
router.post('/sequences/:id/enroll', authorize(['crm.growth.manage', 'crm.admin']), sequenceController.enrollLead);

router.get('/campaigns', authorize(['crm.growth.read', 'crm.growth.manage', 'crm.admin']), campaignController.getCampaigns);
router.post('/campaigns', authorize(['crm.growth.manage', 'crm.admin']), campaignController.createCampaign);

// --- Forecasting, Targets & Commissions ---
router.get('/forecast', authorize(['crm.forecast.read', 'crm.forecast.manage', 'crm.admin']), forecastController.getForecastSummary);
router.get('/forecast/targets', authorize(['crm.forecast.read', 'crm.forecast.manage', 'crm.admin']), forecastController.getTargets);
router.post('/forecast/targets', authorize(['crm.forecast.manage', 'crm.admin']), forecastController.createOrUpdateTarget);
router.get('/forecast/commissions', authorize(['crm.commissions.read', 'crm.commissions.manage', 'crm.admin']), forecastController.getCommissions);
router.patch('/forecast/commissions/:id/approve', authorize(['crm.commissions.manage', 'crm.admin']), forecastController.approveCommission);
router.post('/forecast/commissions/sync-payroll', authorize(['crm.commissions.manage', 'crm.admin']), forecastController.syncCommissionsToPayroll);
router.get('/forecast/performance/:userId', authorize(['crm.forecast.read', 'crm.commissions.read', 'crm.admin']), forecastController.getEmployeePerformance);

// --- Analytics & Dashboard KPIs ---
router.get('/analytics/dashboard', authorize(['crm.analytics.read', 'crm.view', 'crm.admin']), analyticsController.getDashboardAnalytics);

// --- Automation & Workflows ---
router.get('/workflows', authorize(['crm.workflows.read', 'crm.workflows.manage', 'crm.admin']), workflowController.getWorkflows);
router.post('/workflows', authorize(['crm.workflows.manage', 'crm.admin']), workflowController.createWorkflow);
router.patch('/workflows/:id/toggle', authorize(['crm.workflows.manage', 'crm.admin']), workflowController.toggleWorkflow);
router.delete('/workflows/:id', authorize(['crm.workflows.manage', 'crm.admin']), workflowController.deleteWorkflow);

// --- AI Sales Assistant & Insights ---
router.post('/ai/ask', authorize(['crm.ai.use', 'crm.admin']), aiController.askAssistant);
router.get('/ai/insights', authorize(['crm.ai.use', 'crm.admin']), aiController.getAiInsights);

// --- Administration & Settings ---
router.get('/admin/settings', authorize(['crm.admin']), adminController.getSettings);
router.put('/admin/settings', authorize(['crm.admin']), adminController.updateSettings);
router.get('/admin/users', authorize(['crm.admin']), adminController.getUsers);
router.get('/admin/territories', authorize(['crm.territories.read', 'crm.territories.manage', 'crm.admin']), adminController.getTerritories);
router.post('/admin/territories', authorize(['crm.territories.manage', 'crm.admin']), adminController.createTerritory);
router.delete('/admin/territories/:id', authorize(['crm.territories.manage', 'crm.admin']), adminController.deleteTerritory);
router.get('/admin/audit-logs', authorize(['crm.admin']), adminController.getAuditLogs);
router.get('/admin/custom-fields', authorize(['crm.admin']), adminController.getCustomFields);
router.post('/admin/custom-fields', authorize(['crm.admin']), adminController.createCustomField);

// --- Data Management: Import, Export, Merge ---
router.post('/data/import', authorize(['crm.data.import', 'crm.leads.create', 'crm.admin']), dataController.importData);
router.get('/data/export/:entityType', authorize(['crm.data.export', 'crm.admin']), dataController.exportData);
router.post('/data/merge', authorize(['crm.data.merge', 'crm.admin']), dataController.mergeDuplicates);

module.exports = router;
