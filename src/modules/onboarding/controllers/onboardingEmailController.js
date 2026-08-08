const OnboardingEmployee = require('../onboardingEmployee.model');
const Candidate = require('../../talent-acquisition/candidate.model');
const Company = require('../../company/company.model');
const EmailTemplate = require('../../email/model/emailTemplate.model');
const HREmailLog = require('../../email/model/hrEmailLog.model');
const { sendEmailForCompany } = require('../../../services/companyEmailService');
const { extractPublicIdFromUrl } = require('../../../utils/cloudinaryHelper');
const {
    hasHtmlMarkup,
    ONBOARDING_EMAIL_TEMPLATE_PLACEHOLDERS,
    renderTemplateBody,
    resolveTemplate,
    validateTemplateSyntax
} = require('../../email/templateResolver');
const {
    DEFAULT_PRE_ONBOARDING_EMAIL_SUBJECT,
    DEFAULT_PRE_ONBOARDING_EMAIL_BODY,
    resolveNotificationEmailDelivery,
    stripHtml,
    buildPreOnboardingTemplateData,
    syncTADecision
} = require('../utils/onboardingHelpers');

const getCompanyEmailBranding = async (companyId, company = null) => {
    const { getCompanyBranding } = require('../../../services/emailService');
    const branding = await getCompanyBranding(companyId);

    return {
        ...branding,
        logoAlt: branding.logoAlt || company?.name || 'TalentCIO'
    };
};

exports.getCompanyEmailBranding = getCompanyEmailBranding;

exports.sendPreOnboardingEmail = async (req, res) => {
    try {
        const {
            sections,
            documents,
            submissionDeadline,
            emailTemplateId,
            emailSubject,
            emailHtmlBody
        } = req.body;

        const employee = await OnboardingEmployee
            .findOne({ _id: req.params.id, companyId: req.companyId })
            .select('+pendingCredentialPassword');
        if (!employee) {
            return res.status(404).json({ message: 'Employee not found' });
        }

        const emailSentAt = new Date();

        if (submissionDeadline) {
            employee.documentDeadline = new Date(submissionDeadline);
            employee.credentialsExpireAt = new Date(submissionDeadline);
        }

        const sectionsData = employee.requestedSections || [];
        (sections || []).forEach(s => {
            const found = sectionsData.find(rs => rs.label === s);
            if (found) {
                found.emailSentAt = emailSentAt;
            } else {
                sectionsData.push({ label: s, emailSentAt });
            }
        });
        employee.requestedSections = sectionsData;

        const companyRecord = await Company.findById(req.companyId).select('settings.onboarding').lean();
        const companyDynamicTemplates = companyRecord?.settings?.onboarding?.dynamicTemplates || [];
        const companyPolicies = companyRecord?.settings?.onboarding?.policies || [];

        const docsData = employee.requestedDocuments || [];
        (documents || []).forEach(d => {
            const template = companyDynamicTemplates.find(t => t.name === d && t.isDeleted !== true);
            const policy = companyPolicies.find(p => p.name === d && p.isDeleted !== true);

            const resolvedId = template ? template._id : (policy ? policy._id : null);
            const resolvedIdStr = resolvedId ? resolvedId.toString() : null;

            const found = docsData.find(rd =>
                (resolvedIdStr && rd.templateId && rd.templateId.toString() === resolvedIdStr) ||
                (!resolvedIdStr && rd.label === d)
            );

            if (found) {
                found.emailSentAt = emailSentAt;
            } else {
                docsData.push({
                    label: d,
                    emailSentAt,
                    templateId: resolvedId || undefined
                });
            }
        });
        employee.requestedDocuments = docsData;

        if (documents && documents.length > 0) {
            const docLabelsSet = new Set(documents);
            employee.documents.forEach(doc => {
                if (docLabelsSet.has(doc.label) && (doc.status === 'Pending' || doc.status === 'Mail Sent')) {
                    doc.status = 'Mail Sent';
                    doc.emailSentAt = emailSentAt;
                }
            });
        }

        if (employee.status === 'Submitted' || employee.status === 'Reviewed' || employee.status === 'Accepted') {
            employee.status = 'In Progress';
            employee.submittedAt = null;
            employee.auditLog.push({
                action: 'REOPENED',
                details: `Re-opened by HR for additional sections/documents`
            });
        }

        const includesDynamicTemplate = (documents || []).includes('Offer Letter') ||
            (sections || []).includes('Offer Declaration') ||
            companyDynamicTemplates.some(t => (documents || []).includes(t.name));

        if (includesDynamicTemplate) {
            if (employee.offerDeclaration) {
                employee.offerDeclaration.isComplete = false;
                if ((documents || []).includes('Offer Letter')) {
                    employee.offerDeclaration.hasReadOfferLetter = false;
                }
                if (employee.offerDeclaration.acceptedTemplates) {
                    employee.offerDeclaration.acceptedTemplates = employee.offerDeclaration.acceptedTemplates.filter(
                        t => !documents.includes(t.name)
                    );
                }
                if (employee.offerDeclaration.acceptedPolicies) {
                    employee.offerDeclaration.acceptedPolicies = employee.offerDeclaration.acceptedPolicies.filter(
                        p => !documents.includes(p.name)
                    );
                }
            }
        }

        employee.selectionDraft = {
            sections: [],
            documents: [],
            emailTemplateId: '',
            emailSubject: '',
            emailHtmlBody: '',
            updatedAt: new Date()
        };

        await employee.save();

        const employeeResponse = employee.toObject();
        delete employeeResponse.pendingCredentialPassword;

        const { formatEmployeeDynamicTemplates } = require('./onboardingAdminController');
        const formattedTemplates = formatEmployeeDynamicTemplates(employeeResponse, companyDynamicTemplates);
        employeeResponse.companyDynamicTemplates = formattedTemplates;
        employeeResponse.companyPolicies = companyPolicies;

        const portalUrl = `${req.headers.origin || process.env.FRONTEND_URL || 'http://localhost:5173'}/pre-onboarding/login`;

        let credentialsHtml = '';
        let rawPassword = employee.pendingCredentialPassword || '';
        if (employee.isPasswordChanged === false) {
            if (!rawPassword) {
                const { generateTempPassword } = require('../utils/onboardingHelpers');
                rawPassword = generateTempPassword();
                employee.tempPassword = rawPassword;
                employee.pendingCredentialPassword = rawPassword;
                await employee.save();
            }
            credentialsHtml = `
                <div style="background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 8px; padding: 20px; margin: 24px 0;">
                    <h3 style="color: #1e293b; font-size: 15px; margin: 0 0 12px; font-weight: 700;">🔑 Your Login Credentials</h3>
                    <p style="margin: 4px 0; font-size: 14px;"><strong>Employee ID:</strong> <code style="background: #e0e7ff; padding: 2px 8px; border-radius: 4px; font-size: 16px;">${employee.tempEmployeeId}</code></p>
                    <p style="margin: 4px 0; font-size: 14px;"><strong>Temporary Password:</strong> <code style="background: #e0e7ff; padding: 2px 8px; border-radius: 4px; font-size: 16px;">${rawPassword}</code></p>
                    ${employee.credentialsExpireAt ? `
                    <p style="margin: 12px 0 0; font-size: 13px; color: #dc2626;"><strong>⏳ Credentials Expire On:</strong> ${new Date(employee.credentialsExpireAt).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Kolkata' })}</p>
                    ` : ''}
                    <p style="color: #64748b; font-size: 12px; margin-top: 8px;">⚠️ You will be asked to change your password on first login. Please keep these credentials secure.</p>
                </div>
            `;
        } else {
            credentialsHtml = `
                <div style="background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 8px; padding: 20px; margin: 24px 0;">
                    <h3 style="color: #1e293b; font-size: 15px; margin: 0 0 12px; font-weight: 700;">🔑 Portal Access</h3>
                    <p style="margin: 4px 0; font-size: 14px;"><strong>Employee ID:</strong> <code style="background: #e0e7ff; padding: 2px 8px; border-radius: 4px; font-size: 16px;">${employee.tempEmployeeId}</code></p>
                    <p style="margin: 4px 0; font-size: 14px;">Please use the <strong>password you previously set</strong> to log in.</p>
                </div>
            `;
        }

        let sectionsHtml = '';
        if (sections && sections.length > 0) {
            sectionsHtml = `
                <div style="margin-bottom: 24px;">
                    <h3 style="color: #1e293b; font-size: 16px; margin: 0 0 12px; border-bottom: 2px solid #3b82f6; padding-bottom: 8px;">📋 Forms to Complete</h3>
                    <ul style="margin: 0; padding: 0 0 0 20px; color: #334155;">
                        ${sections.map(s => `<li style="padding: 6px 0; font-size: 14px;">${s}</li>`).join('')}
                    </ul>
                </div>
            `;
        }

        const selectedCustomDocuments = (employee.documents || []).filter((doc) =>
            doc.type === 'custom_file' && (documents || []).includes(doc.label) && doc.url
        );

        let documentsHtml = '';
        if (documents && documents.length > 0) {
            documentsHtml = `
                <div style="margin-bottom: 24px;">
                    <h3 style="color: #1e293b; font-size: 16px; margin: 0 0 12px; border-bottom: 2px solid #8b5cf6; padding-bottom: 8px;">📎 Items to Complete</h3>
                    <ul style="margin: 0; padding: 0 0 0 20px; color: #334155;">
                        ${documents.map(d => `<li style="padding: 6px 0; font-size: 14px;">${d}</li>`).join('')}
                    </ul>
                </div>
            `;
        }

        let sharedFilesHtml = '';
        if (selectedCustomDocuments.length > 0) {
            sharedFilesHtml = `
                <div style="margin-bottom: 24px;">
                    <h3 style="color: #1e293b; font-size: 16px; margin: 0 0 12px; border-bottom: 2px solid #0ea5e9; padding-bottom: 8px;">📁 Files Shared by HR</h3>
                    <ul style="margin: 0; padding: 0 0 0 20px; color: #334155;">
                        ${selectedCustomDocuments.map((doc) => `<li style="padding: 6px 0; font-size: 14px;">${doc.label}</li>`).join('')}
                    </ul>
                    <p style="margin: 10px 0 0; font-size: 12px; color: #0369a1;">These files are attached with this email for your reference.</p>
                </div>
            `;
        }

        const deadlineStr = employee.documentDeadline
            ? new Date(employee.documentDeadline).toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Asia/Kolkata' })
            : 'Not specified';

        let selectedTemplate = null;
        if (emailTemplateId) {
            selectedTemplate = await EmailTemplate.findOne({
                _id: emailTemplateId,
                companyId: req.companyId,
                scope: 'general',
                templateType: 'onboarding',
                isActive: true
            }).lean();

            if (!selectedTemplate) {
                return res.status(404).json({ message: 'Selected onboarding email template was not found.' });
            }
        }

        const subjectTemplate = String(
            emailSubject
            || selectedTemplate?.subject
            || DEFAULT_PRE_ONBOARDING_EMAIL_SUBJECT
        ).trim();
        const bodyTemplate = String(
            emailHtmlBody
            || selectedTemplate?.htmlBody
            || DEFAULT_PRE_ONBOARDING_EMAIL_BODY
        );

        if (!subjectTemplate || !bodyTemplate.trim()) {
            return res.status(400).json({ message: 'Email subject and body are required.' });
        }

        const subjectValidation = validateTemplateSyntax(subjectTemplate, ONBOARDING_EMAIL_TEMPLATE_PLACEHOLDERS);
        if (!subjectValidation.valid) {
            return res.status(400).json({ message: `Subject error: ${subjectValidation.message}` });
        }

        const bodyValidation = validateTemplateSyntax(bodyTemplate, ONBOARDING_EMAIL_TEMPLATE_PLACEHOLDERS);
        if (!bodyValidation.valid) {
            return res.status(400).json({ message: `Body error: ${bodyValidation.message}` });
        }

        const companyName = req.company?.name || (await Company.findById(req.companyId).select('name').lean())?.name || 'TalentCIO';
        const taContactName = `${req.user?.firstName || ''} ${req.user?.lastName || ''}`.trim() || 'HR Team';
        const deadlineBlock = `
            <div style="background: #fffbeb; border: 1px solid #fde68a; border-radius: 8px; padding: 14px; margin: 20px 0; font-size: 13px; color: #92400e;">
                <strong>Submission Deadline:</strong> ${deadlineStr}
            </div>
        `;
        const portalButton = `
            <table role="presentation" cellpadding="0" cellspacing="0" border="0" align="center" style="margin:0 auto;">
                <tr>
                    <td bgcolor="#2563eb" style="border-radius:8px; text-align:center;">
                        <a href="${portalUrl}" style="display:inline-block; padding:14px 32px; color:#ffffff; text-decoration:none; font-size:15px; font-weight:700;">Open Portal</a>
                    </td>
                </tr>
            </table>`;
        const templateData = buildPreOnboardingTemplateData({
            employee,
            companyName,
            taContactName,
            portalUrl,
            deadlineText: deadlineStr,
            credentialsSection: credentialsHtml,
            requestedSectionsBlock: sectionsHtml,
            requestedDocumentsBlock: documentsHtml,
            sharedFilesBlock: sharedFilesHtml,
            deadlineBlock,
            portalButton
        });
        const resolvedSubject = resolveTemplate(subjectTemplate, templateData);
        const emailHtml = renderTemplateBody(bodyTemplate, templateData);
        const emailText = hasHtmlMarkup(emailHtml) ? stripHtml(emailHtml) : emailHtml;
        const attachments = selectedCustomDocuments.map((doc) => ({
            filename: doc.label,
            path: doc.url
        }));

        const branding = await getCompanyEmailBranding(employee.companyId, req.company);
        const delivery = await resolveNotificationEmailDelivery(
            employee.companyId,
            'pre_onboarding_email_sent',
            req.body?.emailAccountId
        );
        if (!delivery.shouldSendEmail) {
            return res.status(400).json({ message: 'Pre-onboarding email delivery is disabled in notification settings.' });
        }

        const cc = String(req.body?.cc || '').trim();
        const bcc = String(req.body?.bcc || '').trim();

        await sendEmailForCompany({
            companyId: employee.companyId,
            emailAccountId: delivery.emailAccountId,
            to: employee.email,
            cc: cc || undefined,
            bcc: bcc || undefined,
            html: emailHtml,
            subject: resolvedSubject,
            text: emailText,
            attachments,
            ...branding
        });

        await HREmailLog.create({
            companyId: employee.companyId,
            sentBy: req.user?._id,
            recipientUserId: employee.transferredToUserId || null,
            recipientEmail: employee.email,
            cc,
            bcc,
            subject: resolvedSubject,
            body: emailHtml,
            type: 'onboarding',
            templateId: selectedTemplate?._id || null,
            templateName: selectedTemplate?.name || 'Default Pre-Onboarding Template',
            emailAccountId: delivery.emailAccountId || 'platform',
            emailAccountLabel: delivery.emailAccountId === 'platform' ? 'TalentCIO Platform' : (delivery.emailAccountId || 'TalentCIO Platform'),
            attachments: (attachments || []).map(att => ({
                filename: att.filename,
                cloudinaryUrl: att.path,
                publicId: extractPublicIdFromUrl(att.path) || '',
                dossierDocId: null
            })),
            sentAt: new Date()
        });

        await OnboardingEmployee.findByIdAndUpdate(employee._id, {
            $push: {
                auditLog: {
                    $each: [{
                        action: 'PRE_ONBOARD_EMAIL_SENT',
                        details: `Email sent with ${(sections || []).length} section(s), ${(documents || []).length} document(s), template: ${selectedTemplate?.name || 'Default'}`
                    }],
                    $slice: -50
                }
            }
        });

        const includesOfferOrDeclaration = (documents || []).length > 0 || (sections || []).length > 0 ||
            (sections || []).some(s => /offer|declaration/i.test(s)) ||
            (documents || []).some(d => /offer|letter|declaration/i.test(d) || companyDynamicTemplates.some(t => t.name === d));

        if (includesOfferOrDeclaration) {
            await syncTADecision(employee, 'Offer Sent');
        }

        res.json({ message: 'Pre-onboarding email sent successfully', employee: employeeResponse });
    } catch (error) {
        console.error('Error sending pre-onboarding email:', error);
        res.status(500).json({ message: 'Failed to send email', error: error.message });
    }
};

exports.addCustomFiles = async (req, res) => {
    try {
        const { id } = req.params;
        const employee = await OnboardingEmployee.findOne({ _id: id, companyId: req.companyId });
        if (!employee) return res.status(404).json({ message: 'Employee not found' });

        const files = req.files || [];
        if (files.length === 0) {
            return res.status(400).json({ message: 'No files uploaded' });
        }

        const uploadedAt = new Date();
        const createdDocuments = [];
        const { getUniqueDocumentLabel } = require('../utils/onboardingHelpers');

        files.forEach((file) => {
            const label = getUniqueDocumentLabel(employee.documents, file.originalname || 'Manual Document');
            const newDocument = {
                type: 'custom_file',
                label,
                url: file.path,
                publicId: extractPublicIdFromUrl(file.path) || '',
                status: 'Pending',
                uploadedAt
            };

            employee.documents.push(newDocument);
            createdDocuments.push(newDocument);
            employee.auditLog.push({
                action: 'CUSTOM_FILE_ADDED',
                details: `Custom file "${label}" uploaded by HR`
            });
        });

        await employee.save();

        res.status(201).json({
            message: `${createdDocuments.length} file(s) added to the document list`,
            employee,
            createdDocuments: employee.documents
                .filter((doc) => createdDocuments.some((createdDoc) => createdDoc.label === doc.label))
                .map((doc) => doc.toObject ? doc.toObject() : doc)
        });
    } catch (error) {
        console.error('Error adding custom file(s):', error);
        res.status(500).json({ message: 'Server error', error: error.message });
    }
};

exports.deleteCustomFile = async (req, res) => {
    try {
        const { id, docId } = req.params;
        const employee = await OnboardingEmployee.findOne({ _id: id, companyId: req.companyId });
        if (!employee) return res.status(404).json({ message: 'Employee not found' });

        const doc = employee.documents.id(docId);
        if (!doc) return res.status(404).json({ message: 'Custom file not found' });
        if (doc.type !== 'custom_file') {
            return res.status(400).json({ message: 'Only HR shared custom files can be deleted here.' });
        }

        if (doc.publicId) {
            try {
                const { cloudinary } = require('../../../config/cloudinary');
                await cloudinary.uploader.destroy(doc.publicId, { resource_type: 'raw' });
            } catch (error) {
                console.error('Failed to delete custom file from Cloudinary:', error.message);
            }
        }

        employee.requestedDocuments = (employee.requestedDocuments || []).filter((item) => item.label !== doc.label);

        if (employee.selectionDraft) {
            employee.selectionDraft.documents = (employee.selectionDraft.documents || []).filter((label) => label !== doc.label);
        }

        employee.auditLog.push({
            action: 'CUSTOM_FILE_DELETED',
            details: `Custom file "${doc.label}" deleted by HR`
        });

        employee.documents.pull(docId);
        await employee.save();

        res.json({ message: 'Custom file deleted successfully', employee });
    } catch (error) {
        console.error('Error deleting custom file:', error);
        res.status(500).json({ message: 'Server error', error: error.message });
    }
};

exports.sendCustomFile = async (req, res) => {
    try {
        const { id } = req.params;
        const employee = await OnboardingEmployee.findOne({ _id: id, companyId: req.companyId });
        if (!employee) return res.status(404).json({ message: 'Employee not found' });

        const files = req.files || [];
        if (files.length === 0) {
            return res.status(400).json({ message: 'No files uploaded' });
        }

        const fileNamesList = files.map(f => `<li><strong>${f.originalname}</strong></li>`).join('');
        const fileCountText = files.length === 1 ? 'a document' : `${files.length} documents`;

        const emailHtml = `
            <div style="font-family: sans-serif; max-width: 600px; margin: auto; border: 1px solid #e2e8f0; border-radius: 12px; padding: 24px;">
                <h2 style="color: #2563eb; margin: 0 0 16px;">New Document(s) from HR</h2>
                <p>Hello <strong>${employee.firstName}</strong>,</p>
                <p>Your HR team has sent you ${fileCountText} regarding your onboarding process.</p>
                <p>Please find the attached files:</p>
                <ul>
                    ${fileNamesList}
                </ul>
                <hr style="border: none; border-top: 1px solid #eee; margin: 24px 0;">
                <p style="font-size: 12px; color: #94a3b8; text-align: center;">© ${new Date().getFullYear()} TalentCio. All rights reserved.</p>
            </div>
        `;

        const attachments = files.map(f => ({
            filename: f.originalname,
            path: f.path
        }));

        const branding = await getCompanyEmailBranding(employee.companyId, req.company);
        const delivery = await resolveNotificationEmailDelivery(
            employee.companyId,
            'onboarding_custom_file_sent',
            req.body?.emailAccountId
        );
        if (!delivery.shouldSendEmail) {
            return res.status(400).json({ message: 'Onboarding custom file email delivery is disabled in notification settings.' });
        }
        const sent = await sendEmailForCompany({
            companyId: employee.companyId,
            emailAccountId: delivery.emailAccountId,
            to: employee.email,
            subject: `Action Required: New ${files.length > 1 ? 'Documents' : 'Document'} for Your Onboarding`,
            html: emailHtml,
            attachments,
            ...branding
        });

        if (sent) {
            await HREmailLog.create({
                companyId: employee.companyId,
                sentBy: req.user?._id,
                recipientUserId: employee.transferredToUserId || null,
                recipientEmail: employee.email,
                subject: `Action Required: New ${files.length > 1 ? 'Documents' : 'Document'} for Your Onboarding`,
                body: emailHtml,
                type: 'onboarding',
                emailAccountId: delivery.emailAccountId || 'platform',
                emailAccountLabel: delivery.emailAccountId === 'platform' ? 'TalentCIO Platform' : (delivery.emailAccountId || 'TalentCIO Platform'),
                attachments: (attachments || []).map(att => ({
                    filename: att.filename,
                    cloudinaryUrl: att.path,
                    publicId: extractPublicIdFromUrl(att.path) || '',
                    dossierDocId: null
                })),
                sentAt: new Date()
            });
        }

        if (!sent) {
            return res.status(500).json({ message: 'Failed to send email' });
        }

        const sentAt = new Date();
        const { getUniqueDocumentLabel } = require('../utils/onboardingHelpers');

        files.forEach(f => {
            const label = getUniqueDocumentLabel(employee.documents, f.originalname || 'Manual Document');
            employee.documents.push({
                type: 'custom_file',
                label,
                url: f.path,
                publicId: extractPublicIdFromUrl(f.path) || '',
                status: 'Mail Sent',
                uploadedAt: sentAt,
                emailSentAt: sentAt
            });

            employee.auditLog.push({
                action: 'CUSTOM_FILE_SENT',
                details: `File "${label}" sent to candidate's email by HR`
            });
        });
        await employee.save();

        res.json({
            message: `${files.length} file(s) sent successfully to candidate email`,
            employee
        });
    } catch (error) {
        console.error('Error sending custom file(s):', error);
        res.status(500).json({ message: 'Server error', error: error.message });
    }
};
