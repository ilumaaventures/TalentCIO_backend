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
const {
  sendWhatsAppCloudMessage,
  normalizePhoneNumber,
  getWebhookVerifyToken,
} = require('../../../services/whatsappCloudService');

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

    // Process uploaded attachments (from multer memory storage) or raw attachment body payloads
    let emailAttachments = [];
    if (Array.isArray(req.files) && req.files.length > 0) {
      emailAttachments = req.files.map((file) => ({
        filename: file.originalname,
        content: file.buffer,
        contentType: file.mimetype || 'application/octet-stream',
      }));
    } else if (Array.isArray(req.body.attachments)) {
      emailAttachments = req.body.attachments;
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
        attachments: emailAttachments,
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
    const attachmentFileNames = emailAttachments.map((a) => a.filename).filter(Boolean);
    const attachmentNote = attachmentFileNames.length > 0 ? `\n\nAttachments (${attachmentFileNames.length}): ${attachmentFileNames.join(', ')}` : '';

    // Log in CrmActivity
    const activity = await CrmActivity.create({
      companyId,
      type: 'email',
      subject: subject.trim().startsWith('Email:') ? subject.trim() : `Email: ${subject.trim()}`,
      description: `To: ${recipientName ? `${recipientName} <${to}>` : to}\n\n${cleanText}${attachmentNote}`,
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
        plainBody: cleanText,
        attachments: attachmentFileNames,
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
      attachments: attachmentFileNames,
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
      .populate('leadId', 'firstName lastName phone companyName')
      .populate('contactId', 'firstName lastName phone')
      .populate('importDataId', 'companyName contactPerson mobileNo')
      .sort({ performedAt: -1 })
      .limit(50);

    res.json({
      success: true,
      data: {
        messages: whatsAppMessages,
        activities: waActivities,
        defaultTemplates: [
          { name: 'hello_world', language: 'en_US', label: 'Meta Default Welcome (hello_world)' }
        ],
      },
    });
  } catch (error) {
    next(error);
  }
};

// @desc Send WhatsApp message via Meta Cloud API
// @route POST /api/crm/communication/whatsapp
const sendWhatsAppMessage = async (req, res, next) => {
  try {
    const companyId = getTenantId(req);
    const {
      phone,
      recipientPhone,
      to,
      recipientName,
      message,
      text,
      type = 'template',
      templateName = 'hello_world',
      languageCode = 'en_US',
      components = [],
      templateParams = [],
      leadId,
      dealId,
      contactId,
      importDataId,
    } = req.body;

    const rawPhone = to || phone || recipientPhone || '';
    if (!rawPhone) {
      return res.status(400).json({
        success: false,
        message: 'Recipient phone number is required.',
      });
    }

    const resolvedText = message || text || '';
    const repName = getUserDisplayName(req.user);
    const userId = req.user?._id;

    // Call Meta WhatsApp Cloud API
    let metaResult;
    try {
      metaResult = await sendWhatsAppCloudMessage({
        to: rawPhone,
        type,
        templateName: templateName || 'hello_world',
        languageCode: languageCode || 'en_US',
        components,
        templateParams,
        text: resolvedText,
        message: resolvedText,
      });
    } catch (metaErr) {
      // Record failed activity for sales rep visibility
      await CrmActivity.create({
        companyId,
        type: 'whatsapp',
        subject: `Failed WhatsApp to ${recipientName || rawPhone}`,
        description: `Error: ${metaErr.message}. Content: ${resolvedText || templateName}`,
        outcome: 'Failed',
        durationMinutes: 0,
        performedBy: userId,
        performedByName: repName,
        leadId: leadId || null,
        dealId: dealId || null,
        contactId: contactId || null,
        importDataId: importDataId || null,
        contactPerson: recipientName || rawPhone,
        contactPhone: rawPhone,
        metadata: {
          error: metaErr.message,
          metaCode: metaErr.metaCode,
          isMetaCloudApi: true,
        },
      });

      return res.status(metaErr.statusCode || 400).json({
        success: false,
        message: metaErr.message,
        errorDetails: metaErr.originalError,
      });
    }

    const newMsg = {
      id: metaResult.messageId || `wa-${Date.now()}`,
      metaMessageId: metaResult.messageId,
      phone: metaResult.normalizedPhone || rawPhone,
      recipientPhone: metaResult.normalizedPhone || rawPhone,
      recipientName: recipientName || rawPhone,
      message: resolvedText || `Template: ${templateName}`,
      status: metaResult.messageStatus || 'Delivered',
      templateName: metaResult.templateName,
      sentAt: new Date(),
    };
    whatsAppMessages.unshift(newMsg);

    // Record successful activity in CRM timeline
    const activity = await CrmActivity.create({
      companyId,
      type: 'whatsapp',
      subject: `WhatsApp to ${recipientName || rawPhone}`,
      description: resolvedText || `Template: ${templateName}`,
      outcome: 'Delivered',
      durationMinutes: 0,
      performedBy: userId,
      performedByName: repName,
      leadId: leadId || null,
      dealId: dealId || null,
      contactId: contactId || null,
      importDataId: importDataId || null,
      contactPerson: recipientName || rawPhone,
      contactPhone: metaResult.normalizedPhone || rawPhone,
      metadata: {
        metaMessageId: metaResult.messageId,
        metaStatus: metaResult.messageStatus,
        templateName: metaResult.templateName,
        type: metaResult.type,
        isMetaCloudApi: true,
      },
    });

    // Update prospect outreach metrics if linked to an ImportData record
    if (importDataId) {
      await CrmImportData.findByIdAndUpdate(importDataId, {
        $inc: { whatsappCount: 1 },
        $set: {
          lastContactedAt: new Date(),
          lastContactedBy: repName,
          lastContactedByUserId: userId,
          lastOutcome: 'Sent WhatsApp (Meta Cloud API)',
        },
      });
    }

    // Update lead activity timestamp if linked to a Lead
    if (leadId) {
      await CrmLead.findByIdAndUpdate(leadId, {
        $set: { lastActivityAt: new Date() },
      });
    }

    res.status(201).json({
      success: true,
      message: 'WhatsApp message sent successfully via Meta Cloud API',
      data: newMsg,
      activity,
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

// @desc Verify Meta WhatsApp webhook challenge
// @route GET /api/crm/communication/whatsapp/webhook
const verifyWhatsAppWebhook = (req, res) => {
  try {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];

    const expectedToken = getWebhookVerifyToken();

    if (mode && token) {
      if (mode === 'subscribe' && token === expectedToken) {
        return res.status(200).send(challenge);
      }
      return res.sendStatus(403);
    }
    return res.sendStatus(400);
  } catch (err) {
    console.error('WhatsApp Webhook verification error:', err);
    return res.sendStatus(500);
  }
};

// @desc Handle incoming Meta WhatsApp messages & delivery statuses
// @route POST /api/crm/communication/whatsapp/webhook
const handleWhatsAppWebhookEvent = async (req, res) => {
  try {
    const body = req.body;

    if (body.object === 'whatsapp_business_account') {
      const entries = body.entry || [];

      for (const entry of entries) {
        const changes = entry.changes || [];

        for (const change of changes) {
          const value = change.value;
          if (!value) continue;

          // 1. Inbound messages from clients/contacts
          if (Array.isArray(value.messages)) {
            for (const msg of value.messages) {
              const senderPhone = msg.from || '';
              const senderName = value.contacts?.[0]?.profile?.name || senderPhone;
              const textBody = msg.text?.body || (msg.type ? `[${msg.type.toUpperCase()} Message]` : 'Incoming Message');
              const last10 = senderPhone.replace(/\D/g, '').slice(-10);

              const matchedProspect = last10
                ? await CrmImportData.findOne({
                  mobileNo: new RegExp(`${last10}$`),
                  isDeleted: false,
                }).select('_id companyId companyName')
                : null;

              const matchedLead = (!matchedProspect && last10)
                ? await CrmLead.findOne({
                  phone: new RegExp(`${last10}$`),
                }).select('_id companyId')
                : null;

              const resolvedCompanyId = matchedProspect?.companyId || matchedLead?.companyId;

              const incomingMsg = {
                id: msg.id,
                metaMessageId: msg.id,
                phone: senderPhone,
                recipientPhone: senderPhone,
                recipientName: senderName,
                message: textBody,
                direction: 'incoming',
                status: 'Received',
                timestamp: new Date(Number(msg.timestamp) * 1000 || Date.now()),
              };
              whatsAppMessages.unshift(incomingMsg);

              if (resolvedCompanyId) {
                await CrmActivity.create({
                  companyId: resolvedCompanyId,
                  type: 'whatsapp',
                  subject: `Incoming WhatsApp from ${senderName}`,
                  description: textBody,
                  outcome: 'Received',
                  contactPerson: senderName,
                  contactPhone: senderPhone,
                  importDataId: matchedProspect?._id || null,
                  leadId: matchedLead?._id || null,
                  metadata: {
                    direction: 'incoming',
                    metaMessageId: msg.id,
                    timestamp: msg.timestamp,
                  },
                  performedAt: new Date(Number(msg.timestamp) * 1000 || Date.now()),
                });
              }
            }
          }

          // 2. Outbound message delivery statuses (delivered, read, failed)
          if (Array.isArray(value.statuses)) {
            for (const statusObj of value.statuses) {
              const statusId = statusObj.id;
              const newStatus = statusObj.status; // 'sent' | 'delivered' | 'read' | 'failed'

              const targetMsg = whatsAppMessages.find((m) => m.metaMessageId === statusId || m.id === statusId);
              if (targetMsg) {
                targetMsg.status = newStatus.charAt(0).toUpperCase() + newStatus.slice(1);
              }

              await CrmActivity.updateMany(
                { 'metadata.metaMessageId': statusId },
                {
                  $set: {
                    outcome: newStatus === 'read' ? 'Read' : (newStatus === 'delivered' ? 'Delivered' : 'Sent'),
                    'metadata.metaStatus': newStatus,
                  },
                }
              );
            }
          }
        }
      }

      return res.status(200).send('EVENT_RECEIVED');
    }

    return res.sendStatus(404);
  } catch (err) {
    console.error('WhatsApp Webhook Event processing error:', err);
    return res.status(200).send('EVENT_RECEIVED');
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
  verifyWhatsAppWebhook,
  handleWhatsAppWebhookEvent,
};

