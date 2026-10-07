const CrmActivity = require('../models/crmActivity.model');
const CrmImportData = require('../models/crmImportData.model');
const CrmLead = require('../models/crmLead.model');
const EmailTemplate = require('../../email/model/emailTemplate.model');
const {
  sendEmailForCompany,
  getCompanyEmailSettings,
  pickEmailAccount,
  isRateLimitError
} = require('../../../services/companyEmailService');
const {
  resolveTemplate,
  renderTemplateBody,
  validateTemplateSyntax,
  CRM_EMAIL_TEMPLATE_PLACEHOLDERS
} = require('../../email/templateResolver');

const getTenantId = (req) => req.companyId || req.user?.companyId;

const getUserDisplayName = (user) => {
  if (!user) return 'System';
  if (user.firstName) return `${user.firstName} ${user.lastName || ''}`.trim();
  return user.name || user.email || 'User';
};

// In-memory preview log queues
const emailThreads = [];
const whatsAppMessages = [];

const DEFAULT_SALES_TEMPLATES = [
  {
    name: 'Introductory Pitch & Overview',
    category: 'sales_pitch',
    scope: 'crm',
    templateType: 'crm',
    subject: 'Intro: {{companyName}} & {{senderCompany}} Partnership Discussion',
    htmlBody: `<p>Hi {{contactPerson}},</p>
<p>I hope this email finds you well.</p>
<p>I am reaching out from <strong>{{senderCompany}}</strong>. We help organizations in the <strong>{{industry}}</strong> sector streamline their operations, talent management, and workforce performance.</p>
<p>We recently reviewed <strong>{{companyName}}</strong> and identified high-impact opportunities where our integrated platform can reduce operational overhead and scale your productivity.</p>
<p>Would you have 10-15 minutes this week for a brief introductory call?</p>
<br/>
<p>Best regards,<br/><strong>{{senderName}}</strong><br/>{{senderDesignation}}<br/>{{senderCompany}}<br/>{{senderPhone}} | {{senderEmail}}</p>`
  },
  {
    name: 'Product Demonstration Walkthrough',
    category: 'meeting_invite',
    scope: 'crm',
    templateType: 'crm',
    subject: 'Invitation: Product Demonstration for {{companyName}}',
    htmlBody: `<p>Hi {{contactPerson}},</p>
<p>Following up on our preliminary discussion, I would like to invite you and your team to an interactive product walkthrough tailored specifically for <strong>{{companyName}}</strong>.</p>
<p>In this 20-minute session, we will showcase:</p>
<ul>
  <li>Automated workforce & HR lifecycle workflows</li>
  <li>Real-time analytics and tracking dashboards</li>
  <li>Seamless data integration and customization options</li>
</ul>
<p>You can join the meeting directly using this link: <a href="{{meetingLink}}">{{meetingLink}}</a></p>
<p>Please let me know if another time works better for your schedule.</p>
<br/>
<p>Warm regards,<br/><strong>{{senderName}}</strong><br/>{{senderCompany}}</p>`
  },
  {
    name: 'Follow-Up After Call / Meeting',
    category: 'follow_up',
    scope: 'crm',
    templateType: 'crm',
    subject: 'Follow-up on our conversation - {{companyName}}',
    htmlBody: `<p>Hi {{contactPerson}},</p>
<p>Thank you for taking the time to speak with me regarding <strong>{{companyName}}</strong>'s strategic goals.</p>
<p>As discussed, I am following up with key details and next steps.</p>
<p>{{customNote}}</p>
<p>Feel free to reply directly to this email or call me at {{senderPhone}} if you have any questions.</p>
<br/>
<p>Best regards,<br/><strong>{{senderName}}</strong><br/>{{senderCompany}}</p>`
  },
  {
    name: 'Commercial Proposal & Scope of Work',
    category: 'quote_proposal',
    scope: 'crm',
    templateType: 'crm',
    subject: 'Commercial Proposal & Solution Overview for {{companyName}}',
    htmlBody: `<p>Dear {{contactPerson}},</p>
<p>Thank you for considering <strong>{{senderCompany}}</strong> as your technology partner.</p>
<p>We have tailored the commercial proposal based on your current operational scope and business requirements for <strong>{{companyName}}</strong>.</p>
<p><strong>Proposal Overview:</strong></p>
<p>{{proposalDetails}}</p>
<p>Please review the details at your convenience. I am available to answer questions or adjust the scope as needed.</p>
<br/>
<p>Sincerely,<br/><strong>{{senderName}}</strong><br/>{{senderDesignation}}<br/>{{senderCompany}}</p>`
  },
  {
    name: 'Executive Cold Outreach',
    category: 'cold_outreach',
    scope: 'crm',
    templateType: 'crm',
    subject: 'Quick question regarding {{companyName}}\'s workforce strategy',
    htmlBody: `<p>Hello {{contactPerson}},</p>
<p>I noticed your work heading operations at <strong>{{companyName}}</strong> and wanted to reach out directly.</p>
<p>Leading enterprises in the {{industry}} space use {{senderCompany}} to eliminate administrative bottlenecks and accelerate organizational efficiency.</p>
<p>Are you open to exploring a brief 5-minute conversation to see how we could support {{companyName}}?</p>
<br/>
<p>Best,<br/><strong>{{senderName}}</strong><br/>{{senderCompany}}</p>`
  }
];

const Company = require('../../company/company.model');

// @desc Get company sender email accounts
// @route GET /api/crm/communication/senders
const getSenderAccounts = async (req, res, next) => {
  try {
    const companyId = getTenantId(req);
    const company = await Company.findById(companyId)
      .select('name settings.email')
      .lean();

    const companyName = company?.name || 'TalentCIO';
    const emailSettings = company?.settings?.email || {};
    const {
      normalizeStoredEmailAccounts,
      resolveStoredAccountConfig,
      PLATFORM_EMAIL_ACCOUNT_ID
    } = require('../../../services/companyEmailService');

    const accounts = normalizeStoredEmailAccounts(emailSettings, companyName);

    const mappedAccounts = accounts.map((acc) => {
      const ready = Boolean(resolveStoredAccountConfig(acc, companyName));
      const prov = (acc.provider || 'smtp').toUpperCase();
      const displayName = acc.name || acc.fromName || 'Saved Sender';
      return {
        _id: String(acc._id || ''),
        name: displayName,
        provider: acc.provider || 'smtp',
        fromName: acc.fromName || displayName,
        fromAddress: acc.fromAddress || '',
        verified: Boolean(acc.verified),
        ready,
        label: `${displayName} (${acc.fromAddress || 'no-email'}) - ${prov}`
      };
    });

    const readyAccounts = mappedAccounts.filter((a) => a.ready);
    const defaultAccId = String(emailSettings.defaultAccountId || 'platform');

    const platformOption = {
      _id: 'platform',
      name: 'TalentCIO Platform',
      provider: 'platform',
      fromName: 'TalentCIO',
      fromAddress: process.env.EMAIL_FROM || 'no-reply@talentcio.in',
      ready: true,
      label: `TalentCIO Platform (${process.env.EMAIL_FROM || 'no-reply@talentcio.in'}) - PLATFORM`
    };

    return res.json({
      success: true,
      defaultAccountId: defaultAccId,
      platformOption,
      accounts: readyAccounts,
      data: {
        defaultAccountId: defaultAccId,
        platformOption,
        accounts: readyAccounts
      }
    });
  } catch (error) {
    next(error);
  }
};

// @desc Get CRM Email Templates (with auto-seeding default templates)
// @route GET /api/crm/communication/email-templates
const getCrmEmailTemplates = async (req, res, next) => {
  try {
    const companyId = getTenantId(req);
    let templates = await EmailTemplate.find({
      companyId,
      isDeleted: { $ne: true },
      scope: 'crm'
    }).sort({ updatedAt: -1 });

    if (templates.length === 0) {
      // Auto-seed default sales templates
      const toCreate = DEFAULT_SALES_TEMPLATES.map((tmpl) => ({
        ...tmpl,
        companyId,
        createdBy: req.user?._id || companyId,
        isActive: true
      }));

      try {
        templates = await EmailTemplate.insertMany(toCreate);
      } catch (seedErr) {
        console.warn('[CRM_EMAIL_TEMPLATES] Seed warning:', seedErr.message);
        templates = await EmailTemplate.find({ companyId, isDeleted: { $ne: true }, scope: 'crm' });
      }
    }

    res.json({
      success: true,
      data: templates
    });
  } catch (error) {
    next(error);
  }
};

// @desc Create CRM Email Template
// @route POST /api/crm/communication/email-templates
const createCrmEmailTemplate = async (req, res, next) => {
  try {
    const companyId = getTenantId(req);
    const { name, category, subject, htmlBody, isActive = true } = req.body;

    if (!name || !subject || !htmlBody) {
      return res.status(400).json({
        success: false,
        message: 'Name, subject, and body are required.'
      });
    }

    const template = await EmailTemplate.create({
      companyId,
      scope: 'crm',
      templateType: 'crm',
      name: name.trim(),
      category: category || 'general',
      subject: subject.trim(),
      htmlBody,
      isActive: Boolean(isActive),
      createdBy: req.user?._id
    });

    res.status(201).json({
      success: true,
      message: 'Template created successfully',
      data: template
    });
  } catch (error) {
    next(error);
  }
};

// @desc Update CRM Email Template
// @route PUT /api/crm/communication/email-templates/:id
const updateCrmEmailTemplate = async (req, res, next) => {
  try {
    const companyId = getTenantId(req);
    const { id } = req.params;
    const { name, category, subject, htmlBody, isActive } = req.body;

    const template = await EmailTemplate.findOne({
      _id: id,
      companyId,
      isDeleted: { $ne: true }
    });

    if (!template) {
      return res.status(404).json({
        success: false,
        message: 'Email template not found'
      });
    }

    if (name !== undefined) template.name = name.trim();
    if (category !== undefined) template.category = category;
    if (subject !== undefined) template.subject = subject.trim();
    if (htmlBody !== undefined) template.htmlBody = htmlBody;
    if (isActive !== undefined) template.isActive = Boolean(isActive);

    await template.save();

    res.json({
      success: true,
      message: 'Template updated successfully',
      data: template
    });
  } catch (error) {
    next(error);
  }
};

// @desc Delete CRM Email Template
// @route DELETE /api/crm/communication/email-templates/:id
const deleteCrmEmailTemplate = async (req, res, next) => {
  try {
    const companyId = getTenantId(req);
    const { id } = req.params;

    const template = await EmailTemplate.findOne({
      _id: id,
      companyId,
      isDeleted: { $ne: true }
    });

    if (!template) {
      return res.status(404).json({
        success: false,
        message: 'Email template not found'
      });
    }

    template.isDeleted = true;
    await template.save();

    res.json({
      success: true,
      message: 'Template deleted successfully'
    });
  } catch (error) {
    next(error);
  }
};

// @desc Get email threads & activities
// @route GET /api/crm/communication/emails
const getEmails = async (req, res, next) => {
  try {
    const companyId = getTenantId(req);
    const emailActivities = await CrmActivity.find({
      companyId,
      type: 'email',
    })
      .populate('performedBy', 'firstName lastName email profilePicture')
      .populate('leadId', 'firstName lastName email companyName')
      .populate('importDataId', 'companyName contactPerson emailId mobileNo')
      .sort({ performedAt: -1 })
      .limit(50);

    res.json({
      success: true,
      data: {
        threads: emailThreads,
        activities: emailActivities,
      },
    });
  } catch (error) {
    next(error);
  }
};

// @desc Send email via selected company account + log activity
// @route POST /api/crm/communication/send-email (and POST /api/crm/communication/emails)
const sendEmail = async (req, res, next) => {
  try {
    const companyId = getTenantId(req);
    const {
      to,
      recipientName,
      subject,
      body,
      htmlBody,
      plainBody,
      emailAccountId,
      cc,
      bcc,
      prospectId,
      importDataId,
      leadId,
      dealId,
      contactId,
      templateId
    } = req.body;

    if (!to || !to.trim()) {
      return res.status(400).json({
        success: false,
        message: 'Recipient email address (to) is required.'
      });
    }

    if (!subject || !subject.trim()) {
      return res.status(400).json({
        success: false,
        message: 'Email subject is required.'
      });
    }

    const emailContent = htmlBody || body || plainBody || '';
    if (!emailContent.trim()) {
      return res.status(400).json({
        success: false,
        message: 'Email body content is required.'
      });
    }

    // Ensure clean HTML body without attaching corporate branding or logo header
    let formattedHtml = emailContent;
    if (!/<[a-z][\s\S]*>/i.test(formattedHtml)) {
      formattedHtml = formattedHtml
        .split(/\r?\n\r?\n/)
        .map((para) => `<p style="margin: 0 0 16px 0;">${para.replace(/\r?\n/g, '<br/>')}</p>`)
        .join('\n');
    }

    if (!formattedHtml.includes('font-family')) {
      formattedHtml = `<div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; font-size: 14px; line-height: 1.6; color: #1e293b;">${formattedHtml}</div>`;
    }

    // Dispatch email using configured company account or platform default
    // Sales outreach emails exclude the corporate logo header configured in general email settings
    let sendResult = false;
    let errorMessage = null;

    try {
      sendResult = await sendEmailForCompany({
        companyId,
        emailAccountId: emailAccountId || undefined,
        to: to.trim(),
        cc: cc ? String(cc).trim() : undefined,
        bcc: bcc ? String(bcc).trim() : undefined,
        subject: subject.trim(),
        html: formattedHtml,
        text: plainBody || emailContent.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim(),
        brandEmail: false,
        logoUrl: '',
        throwOnError: true
      });
    } catch (err) {
      console.error('[CRM_EMAIL_DISPATCH_ERROR]', err.message);
      errorMessage = err.message;
      if (isRateLimitError(err)) {
        return res.status(429).json({
          success: false,
          message: 'Email sending rate limit reached. Please try again in a few minutes.'
        });
      }
      return res.status(500).json({
        success: false,
        message: `Failed to deliver email: ${err.message}`
      });
    }

    const targetImportId = prospectId || importDataId || null;

    const cleanText = plainBody || emailContent.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

    // Log in CrmActivity
    const activity = await CrmActivity.create({
      companyId,
      type: 'email',
      subject: subject.trim().startsWith('Email:') ? subject.trim() : `Email: ${subject.trim()}`,
      description: `To: ${recipientName ? `${recipientName} <${to}>` : to}\n\n${cleanText}`,
      outcome: 'Sent',
      performedBy: req.user?._id,
      performedByName: getUserDisplayName(req.user),
      leadId: leadId || undefined,
      dealId: dealId || undefined,
      contactId: contactId || undefined,
      importDataId: targetImportId || undefined,
      metadata: {
        to: to.trim(),
        recipientName: recipientName || '',
        cc: cc || '',
        bcc: bcc || '',
        emailAccountId: emailAccountId || 'platform',
        templateId: templateId || null,
        sentAt: new Date(),
        emailSubject: subject.trim(),
        htmlBody: emailContent,
        plainBody: cleanText
      }
    });

    // If prospect is linked, update call/interaction counters and last contacted timestamp
    if (targetImportId) {
      try {
        await CrmImportData.findOneAndUpdate(
          { _id: targetImportId, companyId },
          {
            $inc: { emailCount: 1 },
            $set: { lastContactedAt: new Date(), updatedAt: new Date() }
          }
        );
      } catch (updateErr) {
        console.warn('[CRM_IMPORT_UPDATE_WARN]', updateErr.message);
      }
    }

    const threadEntry = {
      id: `em-${Date.now()}`,
      to: to.trim(),
      recipientName: recipientName || to.trim(),
      subject: subject.trim(),
      body: emailContent,
      status: 'Sent',
      opened: false,
      sentAt: new Date(),
    };
    emailThreads.unshift(threadEntry);

    res.status(201).json({
      success: true,
      message: 'Email dispatched and outreach logged successfully',
      data: {
        email: threadEntry,
        activity
      }
    });
  } catch (error) {
    next(error);
  }
};

// @desc Get WhatsApp messages
// @route GET /api/crm/communication/whatsapp
const getWhatsAppMessages = async (req, res, next) => {
  try {
    const companyId = getTenantId(req);
    const waActivities = await CrmActivity.find({
      companyId,
      type: 'whatsapp',
    })
      .populate('performedBy', 'firstName lastName')
      .sort({ performedAt: -1 })
      .limit(30);

    res.json({
      success: true,
      data: {
        messages: whatsAppMessages,
        activities: waActivities,
      },
    });
  } catch (error) {
    next(error);
  }
};

// @desc Send WhatsApp message
// @route POST /api/crm/communication/whatsapp
const sendWhatsAppMessage = async (req, res, next) => {
  try {
    const companyId = getTenantId(req);
    const { phone, recipientPhone, recipientName, message, leadId, dealId, contactId } = req.body;
    const targetPhone = phone || recipientPhone || '';

    const newMsg = {
      id: `wa-${Date.now()}`,
      phone: targetPhone,
      recipientPhone: targetPhone,
      recipientName: recipientName || targetPhone,
      message,
      status: 'Delivered',
      sentAt: new Date(),
    };
    whatsAppMessages.unshift(newMsg);

    await CrmActivity.create({
      companyId,
      type: 'whatsapp',
      subject: `WhatsApp to ${recipientName || targetPhone}`,
      description: message,
      outcome: 'Sent',
      performedBy: req.user?._id,
      performedByName: getUserDisplayName(req.user),
      leadId,
      dealId,
      contactId,
    });

    res.status(201).json({
      success: true,
      message: 'WhatsApp message sent',
      data: newMsg,
    });
  } catch (error) {
    next(error);
  }
};

// @desc Get Call logs
// @route GET /api/crm/communication/calls
const getCalls = async (req, res, next) => {
  try {
    const companyId = getTenantId(req);
    const calls = await CrmActivity.find({
      companyId,
      type: 'call',
    })
      .populate('performedBy', 'firstName lastName email profilePicture')
      .populate('leadId', 'firstName lastName phone companyName')
      .populate('dealId', 'title')
      .sort({ performedAt: -1 })
      .limit(50);

    res.json({ success: true, data: calls });
  } catch (error) {
    next(error);
  }
};

// @desc Log a completed or missed call
// @route POST /api/crm/communication/calls
const logCall = async (req, res, next) => {
  try {
    const companyId = getTenantId(req);
    const {
      phone,
      contactName,
      outcome = 'Connected',
      durationMinutes = 5,
      notes,
      leadId,
      dealId,
      contactId,
    } = req.body;

    const callActivity = await CrmActivity.create({
      companyId,
      type: 'call',
      subject: `Call with ${contactName || phone} (${outcome})`,
      description: notes || `Phone call (${durationMinutes} min)`,
      outcome,
      durationMinutes: Number(durationMinutes) || 0,
      performedBy: req.user?._id,
      performedByName: getUserDisplayName(req.user),
      leadId,
      dealId,
      contactId,
    });

    res.status(201).json({
      success: true,
      message: 'Call logged successfully',
      data: callActivity,
    });
  } catch (error) {
    next(error);
  }
};

module.exports = {
  getSenderAccounts,
  getCrmEmailTemplates,
  createCrmEmailTemplate,
  updateCrmEmailTemplate,
  deleteCrmEmailTemplate,
  getEmails,
  sendEmail,
  getWhatsAppMessages,
  sendWhatsAppMessage,
  getCalls,
  logCall,
};
