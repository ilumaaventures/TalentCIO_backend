const path = require('path');
const fs = require('fs');
const { HiringRequest } = require('../../model/hiringRequest.model');
const Candidate = require('../../model/candidate.model');
const Company = require('../../../company/company.model');
const EmailTemplate = require('../../../email/model/emailTemplate.model');
const TAEmailLog = require('../../model/taEmailLog.model');
const NotificationService = require('../../../../services/notificationService');
const { sendEmailForCompany, isRateLimitError } = require('../../../../services/companyEmailService');
const {
    hasHtmlMarkup,
    TA_EMAIL_TEMPLATE_PLACEHOLDERS,
    renderTemplateBody,
    resolveTemplate,
    validateTemplateSyntax
} = require('../../../email/templateResolver');
const { canAccessHiringRequest } = require('../../utils/hiringRequestAccess');
const { extractPublicIdFromUrl } = require('../../../../utils/cloudinaryHelper');

const DEFAULT_MASS_MAIL_SUBJECT = 'Opportunity Update: {{jobTitle}}';
const DEFAULT_MASS_MAIL_BODY = `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: auto; padding: 20px; border: 1px solid #e2e8f0; border-radius: 10px;">
        <h2 style="color: #2563eb;">Application Update for {{jobTitle}}</h2>
        <p>Hello {{candidateName}},</p>
        <p>Thank you for expressing interest in the <strong>{{jobTitle}}</strong> position at <strong>{{companyName}}</strong>.</p>
        <p>We are reaching out to provide an update regarding your application process.</p>
        <p>If you have any questions, feel free to reply to this email.</p>
        <br/>
        <p>Best regards,<br/><strong>{{recruiterName}}</strong><br/>{{companyName}} Talent Acquisition Team</p>
    </div>
`;

const formatDate = (date) => {
    if (!date) return '';
    return new Date(date).toLocaleDateString('en-IN', { day: '2-digit', month: 'long', year: 'numeric', timeZone: 'Asia/Kolkata' });
};

const formatCurrency = (val) => {
    if (!val) return '—';
    const num = parseFloat(String(val).replace(/[^0-9.]/g, ''));
    if (isNaN(num)) return val;
    return '₹ ' + num.toLocaleString('en-IN');
};

const stripHtml = (html = '') => String(html || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

const buildTATemplateData = ({ candidate, hiringRequest, companyName, recruiterName, customData = {} }) => {
    const candidateName = candidate.candidateName || `${candidate.firstName || ''} ${candidate.lastName || ''}`.trim() || 'Candidate';
    const jobTitle = hiringRequest?.roleDetails?.jobTitle || candidate.jobTitle || 'Role';

    return {
        candidateName,
        firstName: candidate.firstName || candidateName.split(' ')[0] || '',
        lastName: candidate.lastName || candidateName.split(' ').slice(1).join(' ') || '',
        fullName: candidateName,
        email: candidate.email || '',
        phone: candidate.mobile || candidate.phone || '',
        workEmail: candidate.email || '',
        mobile: candidate.mobile || candidate.phone || '',
        phoneNumber: candidate.mobile || candidate.phone || '',
        jobTitle,
        designation: hiringRequest?.roleDetails?.designation || jobTitle,
        client: hiringRequest?.client || '',
        department: hiringRequest?.roleDetails?.department || '',
        offerDate: formatDate(candidate.offerDate),
        dateOfOffer: formatDate(candidate.offerDate),
        workLocation: hiringRequest?.employmentDetails?.workLocation || candidate.workLocation || '',
        employmentDetails: [hiringRequest?.roleDetails?.designation || jobTitle, hiringRequest?.roleDetails?.department || '', hiringRequest?.employmentDetails?.workLocation || '']
            .filter(Boolean)
            .join(' | '),
        location: candidate.location || hiringRequest?.employmentDetails?.workLocation || '',
        managerName: candidate.managerName || '',
        managerEmail: candidate.managerEmail || '',
        recruiterName: recruiterName || 'Talent Acquisition Team',
        companyName: companyName || 'Our Company',
        requestId: hiringRequest?.requestId || '',
        currentStatus: candidate.status || '',
        interviewDate: formatDate(candidate.interviewDate),
        interviewLink: candidate.interviewLink || '',
        customNote: customData.customNote || '',
        currentYear: String(new Date().getFullYear()),
        currentDate: formatDate(new Date()),
        ...customData
    };
};

const resolveNotificationEmailDelivery = async (companyId, preferenceKey, requestedEmailAccountId = '') => {
    const preference = await NotificationService.getEmailPreferenceForEvent(
        companyId,
        preferenceKey,
        requestedEmailAccountId
    );

    return {
        shouldSendEmail: preference.shouldSendEmail,
        emailAccountId: preference.emailAccountId
    };
};

const getCompanyEmailBranding = async (companyId, company = null) => {
    const { getCompanyBranding } = require('../../../../services/emailService');
    const branding = await getCompanyBranding(companyId);

    return {
        ...branding,
        logoAlt: branding.logoAlt || company?.name || 'TalentCIO'
    };
};

exports.sendMassMail = async (req, res) => {
    try {
        const { id } = req.params;
        let {
            candidateIds,
            filters,
            templateId,
            emailSubject,
            customSubject,
            subject,
            emailHtmlBody,
            customHtmlBody,
            body,
            customNote,
            emailAccountId,
            cc,
            bcc
        } = req.body;

        if (typeof candidateIds === 'string') {
            try {
                candidateIds = JSON.parse(candidateIds);
            } catch (e) {
                candidateIds = candidateIds ? [candidateIds] : [];
            }
        }

        if (typeof filters === 'string') {
            try {
                filters = JSON.parse(filters);
            } catch (e) {
                filters = {};
            }
        }

        const hiringRequest = await HiringRequest.findOne({
            _id: id,
            companyId: req.companyId
        });

        if (!hiringRequest) {
            return res.status(404).json({ message: 'Hiring request not found.' });
        }

        const hasAccess = await canAccessHiringRequest(hiringRequest, req.companyId, req.user);
        if (!hasAccess) {
            return res.status(403).json({ message: 'Forbidden: You do not have permission to email candidates for this request.' });
        }

        let query = {
            hiringRequestId: id,
            companyId: req.companyId
        };

        if (Array.isArray(candidateIds) && candidateIds.length > 0) {
            query._id = { $in: candidateIds };
        } else if (filters && typeof filters === 'object' && Object.keys(filters).length > 0) {
            if (Array.isArray(filters.status) && filters.status.length > 0) query.status = { $in: filters.status };
            if (Array.isArray(filters.decision) && filters.decision.length > 0) query.decision = { $in: filters.decision };
            if (Array.isArray(filters.phase2Decision) && filters.phase2Decision.length > 0) query.phase2Decision = { $in: filters.phase2Decision };
            if (Array.isArray(filters.phase3Decision) && filters.phase3Decision.length > 0) query.phase3Decision = { $in: filters.phase3Decision };
        } else {
            return res.status(400).json({ message: 'At least one candidate must be selected.' });
        }

        const candidates = await Candidate.find(query);

        if (candidates.length === 0) {
            return res.status(404).json({ message: 'No valid candidates found for this hiring request.' });
        }

        let selectedTemplate = null;
        if (templateId) {
            selectedTemplate = await EmailTemplate.findOne({
                _id: templateId,
                companyId: req.companyId
            }).lean();

            if (!selectedTemplate) {
                selectedTemplate = await EmailTemplate.findById(templateId).lean();
            }
        }

        const resolvedTemplateName = selectedTemplate?.name || templateName || (templateId ? 'Saved Template' : 'Custom Mass Mail');

        const incomingSubject = (customSubject !== undefined && customSubject !== null && String(customSubject).trim() !== '')
            ? customSubject
            : ((emailSubject !== undefined && emailSubject !== null && String(emailSubject).trim() !== '')
                ? emailSubject
                : ((subject !== undefined && subject !== null && String(subject).trim() !== '') ? subject : ''));

        const incomingHtmlBody = (customHtmlBody !== undefined && customHtmlBody !== null && String(customHtmlBody).trim() !== '')
            ? customHtmlBody
            : ((emailHtmlBody !== undefined && emailHtmlBody !== null && String(emailHtmlBody).trim() !== '')
                ? emailHtmlBody
                : ((body !== undefined && body !== null && String(body).trim() !== '') ? body : ''));

        const subjectTemplate = String(
            incomingSubject
            || selectedTemplate?.subject
            || DEFAULT_MASS_MAIL_SUBJECT
        ).trim();

        const bodyTemplate = String(
            incomingHtmlBody
            || selectedTemplate?.htmlBody
            || DEFAULT_MASS_MAIL_BODY
        );

        if (!subjectTemplate || !bodyTemplate.trim()) {
            return res.status(400).json({ message: 'Email subject and body are required.' });
        }

        const subjectValidation = validateTemplateSyntax(subjectTemplate, TA_EMAIL_TEMPLATE_PLACEHOLDERS);
        if (!subjectValidation.valid) {
            return res.status(400).json({ message: `Subject error: ${subjectValidation.message}` });
        }

        const bodyValidation = validateTemplateSyntax(bodyTemplate, TA_EMAIL_TEMPLATE_PLACEHOLDERS);
        if (!bodyValidation.valid) {
            return res.status(400).json({ message: `Body error: ${bodyValidation.message}` });
        }

        const company = await Company.findById(req.companyId).select('name logoUrl subdomain').lean();
        const companyName = company?.name || 'TalentCIO';
        const senderName = [req.user.firstName, req.user.lastName].filter(Boolean).join(' ') || 'Recruiter';
        const recruiterName = senderName || 'Talent Acquisition Team';
        const hiringRequestTitle = hiringRequest?.roleDetails?.title || hiringRequest?.roleDetails?.jobTitle || hiringRequest?.positionName || '';
        const branding = await getCompanyEmailBranding(req.companyId, company);

        const delivery = await resolveNotificationEmailDelivery(
            req.companyId,
            'ta_mass_mail_sent',
            emailAccountId
        );

        if (!delivery.shouldSendEmail) {
            return res.status(400).json({ message: 'TA mass mail delivery is disabled in notification settings.' });
        }

        const uploadedFiles = req.files || [];
        const attachments = uploadedFiles.map(file => ({
            filename: file.originalname,
            path: file.path
        }));

        const results = [];

        let consecutiveRateLimitFailures = 0;
        const MAX_CONSECUTIVE_RATE_LIMIT_FAILURES = 3;
        const MAX_RETRIES_PER_EMAIL = 3;

        for (const [index, candidate] of candidates.entries()) {
            if (consecutiveRateLimitFailures >= MAX_CONSECUTIVE_RATE_LIMIT_FAILURES) {
                console.warn(`[MassMail] Aborting remaining ${candidates.length - index} emails due to consecutive rate limit failures.`);
                for (let remainingIdx = index; remainingIdx < candidates.length; remainingIdx++) {
                    results.push({
                        candidateId: candidates[remainingIdx]._id,
                        email: candidates[remainingIdx].email,
                        status: 'Failed',
                        error: 'Aborted: Provider rate limit exceeded. Remaining emails skipped.'
                    });
                }
                break;
            }

            try {
                const templateData = buildTATemplateData({
                    candidate,
                    hiringRequest,
                    companyName,
                    recruiterName,
                    customData: { customNote: customNote || '' }
                });

                const resolvedSubject = resolveTemplate(subjectTemplate, templateData);
                const emailHtml = renderTemplateBody(bodyTemplate, templateData);
                const emailText = hasHtmlMarkup(emailHtml) ? stripHtml(emailHtml) : emailHtml;

                let sendResult = null;
                let lastErr = null;
                let attempt = 0;

                while (attempt < MAX_RETRIES_PER_EMAIL) {
                    attempt++;
                    try {
                        sendResult = await sendEmailForCompany({
                            companyId: req.companyId,
                            emailAccountId: delivery.emailAccountId,
                            to: candidate.email,
                            cc: cc || undefined,
                            bcc: bcc || undefined,
                            subject: resolvedSubject,
                            html: emailHtml,
                            text: emailText,
                            attachments,
                            ...branding
                        });

                        consecutiveRateLimitFailures = 0;
                        break;
                    } catch (emailErr) {
                        lastErr = emailErr;
                        if (isRateLimitError(emailErr)) {
                            console.warn(`[MassMail] Rate limit hit on attempt ${attempt} for ${candidate.email}: ${emailErr.message}`);
                            consecutiveRateLimitFailures++;
                            if (attempt < MAX_RETRIES_PER_EMAIL) {
                                const backoffMs = attempt * 2000;
                                await new Promise(r => setTimeout(r, backoffMs));
                            }
                        } else {
                            break;
                        }
                    }
                }

                if (!sendResult && lastErr) {
                    throw lastErr;
                }

                await TAEmailLog.create({
                    companyId: req.companyId,
                    hiringRequestId: hiringRequest._id,
                    hiringRequestTitle,
                    candidateId: candidate._id,
                    recipientName: candidate.candidateName || `${candidate.firstName || ''} ${candidate.lastName || ''}`.trim() || 'Candidate',
                    recipientEmail: candidate.email,
                    sentBy: req.user._id,
                    senderName,
                    senderEmail: req.user.email || '',
                    templateId: selectedTemplate?._id || (templateId || null),
                    templateName: resolvedTemplateName,
                    emailAccountId: delivery.emailAccountId || 'platform',
                    emailAccountLabel: delivery.emailAccountId === 'platform' ? 'TalentCIO Platform' : (delivery.emailAccountId || 'TalentCIO Platform'),
                    cc: cc || '',
                    bcc: bcc || '',
                    subject: resolvedSubject,
                    body: emailHtml,
                    attachments: attachments.map(att => ({
                        filename: att.filename,
                        url: att.path,
                        path: att.path,
                        cloudinaryUrl: att.path,
                        publicId: extractPublicIdFromUrl(att.path) || ''
                    })),
                    status: 'Sent',
                    sentAt: new Date()
                });

                results.push({
                    candidateId: candidate._id,
                    email: candidate.email,
                    status: 'Sent'
                });

            } catch (candErr) {
                console.error(`Failed to send mass mail to ${candidate.email}:`, candErr);

                await TAEmailLog.create({
                    companyId: req.companyId,
                    hiringRequestId: hiringRequest._id,
                    hiringRequestTitle,
                    candidateId: candidate._id,
                    recipientName: candidate.candidateName || `${candidate.firstName || ''} ${candidate.lastName || ''}`.trim() || 'Candidate',
                    recipientEmail: candidate.email,
                    sentBy: req.user._id,
                    senderName,
                    senderEmail: req.user.email || '',
                    templateId: selectedTemplate?._id || (templateId || null),
                    templateName: resolvedTemplateName,
                    emailAccountId: delivery.emailAccountId || 'platform',
                    emailAccountLabel: delivery.emailAccountId === 'platform' ? 'TalentCIO Platform' : (delivery.emailAccountId || 'TalentCIO Platform'),
                    cc: cc || '',
                    bcc: bcc || '',
                    subject: subjectTemplate,
                    body: bodyTemplate,
                    attachments: attachments.map(att => ({
                        filename: att.filename,
                        url: att.path,
                        path: att.path,
                        cloudinaryUrl: att.path,
                        publicId: extractPublicIdFromUrl(att.path) || ''
                    })),
                    status: 'Failed',
                    errorReason: candErr.message,
                    errorMessage: candErr.message,
                    sentAt: new Date()
                });

                results.push({
                    candidateId: candidate._id,
                    email: candidate.email,
                    status: 'Failed',
                    error: candErr.message
                });
            }
        }

        const sentCount = results.filter(r => r.status === 'Sent').length;
        const failedCount = results.filter(r => r.status === 'Failed').length;

        res.json({
            message: `Mass mail process completed. Sent: ${sentCount}, Failed: ${failedCount}`,
            summary: {
                totalRequested: candidateIds?.length || candidates.length,
                totalTargeted: candidates.length,
                sentCount,
                failedCount
            },
            results
        });

    } catch (error) {
        console.error('Error sending mass mail:', error);
        res.status(500).json({ message: 'Failed to process mass mail', error: error.message });
    }
};

exports.sendMassMailBulk = async (req, res) => {
    try {
        let {
            candidateIds,
            templateId,
            templateName,
            emailSubject,
            customSubject,
            subject,
            emailHtmlBody,
            customHtmlBody,
            body,
            customNote,
            emailAccountId,
            cc,
            bcc
        } = req.body;

        if (typeof candidateIds === 'string') {
            try {
                candidateIds = JSON.parse(candidateIds);
            } catch (e) {
                candidateIds = candidateIds ? [candidateIds] : [];
            }
        }

        if (!Array.isArray(candidateIds) || candidateIds.length === 0) {
            return res.status(400).json({ message: 'At least one candidate must be selected.' });
        }

        const candidates = await Candidate.find({
            _id: { $in: candidateIds },
            companyId: req.companyId
        }).populate('hiringRequestId');

        if (candidates.length === 0) {
            return res.status(404).json({ message: 'No valid candidates found.' });
        }

        const reqMap = new Map();
        for (const candidate of candidates) {
            const reqId = candidate.hiringRequestId?._id?.toString() || candidate.hiringRequestId?.toString();
            if (reqId && !reqMap.has(reqId)) {
                const hiringReq = candidate.hiringRequestId?._id
                    ? candidate.hiringRequestId
                    : await HiringRequest.findOne({ _id: reqId, companyId: req.companyId });
                reqMap.set(reqId, hiringReq);
            }
        }

        let selectedTemplate = null;
        if (templateId) {
            selectedTemplate = await EmailTemplate.findOne({
                _id: templateId,
                companyId: req.companyId
            }).lean();

            if (!selectedTemplate) {
                selectedTemplate = await EmailTemplate.findById(templateId).lean();
            }
        }

        const resolvedTemplateName = selectedTemplate?.name || templateName || (templateId ? 'Saved Template' : 'Custom Mass Mail');

        const incomingSubject = (customSubject !== undefined && customSubject !== null && String(customSubject).trim() !== '')
            ? customSubject
            : ((emailSubject !== undefined && emailSubject !== null && String(emailSubject).trim() !== '')
                ? emailSubject
                : ((subject !== undefined && subject !== null && String(subject).trim() !== '') ? subject : ''));

        const incomingHtmlBody = (customHtmlBody !== undefined && customHtmlBody !== null && String(customHtmlBody).trim() !== '')
            ? customHtmlBody
            : ((emailHtmlBody !== undefined && emailHtmlBody !== null && String(emailHtmlBody).trim() !== '')
                ? emailHtmlBody
                : ((body !== undefined && body !== null && String(body).trim() !== '') ? body : ''));

        const subjectTemplate = String(
            incomingSubject
            || selectedTemplate?.subject
            || DEFAULT_MASS_MAIL_SUBJECT
        ).trim();

        const bodyTemplate = String(
            incomingHtmlBody
            || selectedTemplate?.htmlBody
            || DEFAULT_MASS_MAIL_BODY
        );

        if (!subjectTemplate || !bodyTemplate.trim()) {
            return res.status(400).json({ message: 'Email subject and body are required.' });
        }

        const subjectValidation = validateTemplateSyntax(subjectTemplate, TA_EMAIL_TEMPLATE_PLACEHOLDERS);
        if (!subjectValidation.valid) {
            return res.status(400).json({ message: `Subject error: ${subjectValidation.message}` });
        }

        const bodyValidation = validateTemplateSyntax(bodyTemplate, TA_EMAIL_TEMPLATE_PLACEHOLDERS);
        if (!bodyValidation.valid) {
            return res.status(400).json({ message: `Body error: ${bodyValidation.message}` });
        }

        const company = await Company.findById(req.companyId).select('name logoUrl subdomain').lean();
        const companyName = company?.name || 'TalentCIO';
        const senderName = [req.user.firstName, req.user.lastName].filter(Boolean).join(' ') || 'Recruiter';
        const recruiterName = senderName || 'Talent Acquisition Team';
        const branding = await getCompanyEmailBranding(req.companyId, company);

        const delivery = await resolveNotificationEmailDelivery(
            req.companyId,
            'ta_mass_mail_sent',
            emailAccountId
        );

        if (!delivery.shouldSendEmail) {
            return res.status(400).json({ message: 'TA mass mail delivery is disabled in notification settings.' });
        }

        const uploadedFiles = req.files || [];
        const attachments = uploadedFiles.map(file => ({
            filename: file.originalname,
            path: file.path
        }));

        const results = [];

        let consecutiveRateLimitFailures = 0;
        const MAX_CONSECUTIVE_RATE_LIMIT_FAILURES = 3;
        const MAX_RETRIES_PER_EMAIL = 3;

        for (const [index, candidate] of candidates.entries()) {
            if (consecutiveRateLimitFailures >= MAX_CONSECUTIVE_RATE_LIMIT_FAILURES) {
                console.warn(`[MassMailBulk] Aborting remaining ${candidates.length - index} emails due to consecutive rate limit failures.`);
                for (let remainingIdx = index; remainingIdx < candidates.length; remainingIdx++) {
                    results.push({
                        candidateId: candidates[remainingIdx]._id,
                        email: candidates[remainingIdx].email,
                        status: 'Failed',
                        error: 'Aborted: Provider rate limit exceeded. Remaining emails skipped.'
                    });
                }
                break;
            }

            try {
                const reqId = candidate.hiringRequestId?._id?.toString() || candidate.hiringRequestId?.toString();
                const hiringRequest = reqMap.get(reqId) || null;
                const hiringRequestTitle = hiringRequest?.roleDetails?.title || hiringRequest?.roleDetails?.jobTitle || hiringRequest?.positionName || '';

                const templateData = buildTATemplateData({
                    candidate,
                    hiringRequest,
                    companyName,
                    recruiterName,
                    customData: { customNote: customNote || '' }
                });

                const resolvedSubject = resolveTemplate(subjectTemplate, templateData);
                const emailHtml = renderTemplateBody(bodyTemplate, templateData);
                const emailText = hasHtmlMarkup(emailHtml) ? stripHtml(emailHtml) : emailHtml;

                let sendResult = null;
                let lastErr = null;
                let attempt = 0;

                while (attempt < MAX_RETRIES_PER_EMAIL) {
                    attempt++;
                    try {
                        sendResult = await sendEmailForCompany({
                            companyId: req.companyId,
                            emailAccountId: delivery.emailAccountId,
                            to: candidate.email,
                            cc: cc || undefined,
                            bcc: bcc || undefined,
                            subject: resolvedSubject,
                            html: emailHtml,
                            text: emailText,
                            attachments,
                            ...branding
                        });

                        consecutiveRateLimitFailures = 0;
                        break;
                    } catch (emailErr) {
                        lastErr = emailErr;
                        if (isRateLimitError(emailErr)) {
                            console.warn(`[MassMailBulk] Rate limit hit on attempt ${attempt} for ${candidate.email}: ${emailErr.message}`);
                            consecutiveRateLimitFailures++;
                            if (attempt < MAX_RETRIES_PER_EMAIL) {
                                const backoffMs = attempt * 2000;
                                await new Promise(r => setTimeout(r, backoffMs));
                            }
                        } else {
                            break;
                        }
                    }
                }

                if (!sendResult && lastErr) {
                    throw lastErr;
                }

                await TAEmailLog.create({
                    companyId: req.companyId,
                    hiringRequestId: hiringRequest?._id || null,
                    hiringRequestTitle,
                    candidateId: candidate._id,
                    recipientName: candidate.candidateName || `${candidate.firstName || ''} ${candidate.lastName || ''}`.trim() || 'Candidate',
                    recipientEmail: candidate.email,
                    sentBy: req.user._id,
                    senderName,
                    senderEmail: req.user.email || '',
                    templateId: selectedTemplate?._id || (templateId || null),
                    templateName: resolvedTemplateName,
                    emailAccountId: delivery.emailAccountId || 'platform',
                    emailAccountLabel: delivery.emailAccountId === 'platform' ? 'TalentCIO Platform' : (delivery.emailAccountId || 'TalentCIO Platform'),
                    recipientEmail: candidate.email,
                    cc: cc || '',
                    bcc: bcc || '',
                    subject: resolvedSubject,
                    body: emailHtml,
                    attachments: attachments.map(att => ({
                        filename: att.filename,
                        url: att.path,
                        path: att.path,
                        cloudinaryUrl: att.path,
                        publicId: extractPublicIdFromUrl(att.path) || ''
                    })),
                    status: 'Sent',
                    sentAt: new Date()
                });

                results.push({
                    candidateId: candidate._id,
                    email: candidate.email,
                    status: 'Sent'
                });

            } catch (candErr) {
                console.error(`Failed to send bulk mass mail to ${candidate.email}:`, candErr);

                const reqId = candidate.hiringRequestId?._id?.toString() || candidate.hiringRequestId?.toString();
                const hiringRequest = reqMap.get(reqId) || null;
                const hiringRequestTitle = hiringRequest?.roleDetails?.title || hiringRequest?.roleDetails?.jobTitle || hiringRequest?.positionName || '';

                await TAEmailLog.create({
                    companyId: req.companyId,
                    hiringRequestId: hiringRequest?._id || null,
                    hiringRequestTitle,
                    candidateId: candidate._id,
                    recipientName: candidate.candidateName || `${candidate.firstName || ''} ${candidate.lastName || ''}`.trim() || 'Candidate',
                    recipientEmail: candidate.email,
                    sentBy: req.user._id,
                    senderName,
                    senderEmail: req.user.email || '',
                    templateId: selectedTemplate?._id || (templateId || null),
                    templateName: resolvedTemplateName,
                    emailAccountId: delivery.emailAccountId || 'platform',
                    emailAccountLabel: delivery.emailAccountId === 'platform' ? 'TalentCIO Platform' : (delivery.emailAccountId || 'TalentCIO Platform'),
                    recipientEmail: candidate.email,
                    cc: cc || '',
                    bcc: bcc || '',
                    subject: subjectTemplate,
                    body: bodyTemplate,
                    attachments: attachments.map(att => ({
                        filename: att.filename,
                        url: att.path,
                        path: att.path,
                        cloudinaryUrl: att.path,
                        publicId: extractPublicIdFromUrl(att.path) || ''
                    })),
                    status: 'Failed',
                    errorReason: candErr.message,
                    errorMessage: candErr.message,
                    sentAt: new Date()
                });

                results.push({
                    candidateId: candidate._id,
                    email: candidate.email,
                    status: 'Failed',
                    error: candErr.message
                });
            }
        }

        const sentCount = results.filter(r => r.status === 'Sent').length;
        const failedCount = results.filter(r => r.status === 'Failed').length;

        res.json({
            message: `Bulk mass mail process completed. Sent: ${sentCount}, Failed: ${failedCount}`,
            summary: {
                totalRequested: candidateIds.length,
                totalTargeted: candidates.length,
                sentCount,
                failedCount
            },
            results
        });

    } catch (error) {
        console.error('Error sending bulk mass mail:', error);
        res.status(500).json({ message: 'Failed to process bulk mass mail', error: error.message });
    }
};

exports.getTAEmailHistory = async (req, res) => {
    try {
        const { hiringRequestId, candidateId, status, page = 1, limit = 20 } = req.query;

        const query = { companyId: req.companyId };

        if (hiringRequestId) query.hiringRequestId = hiringRequestId;
        if (candidateId) query.candidateId = candidateId;
        if (status) query.status = status;

        const pageNum = parseInt(page, 10) || 1;
        const limitNum = parseInt(limit, 10) || 20;
        const skip = (pageNum - 1) * limitNum;

        const [logs, total] = await Promise.all([
            TAEmailLog.find(query)
                .populate('sentBy', 'firstName lastName email')
                .populate('candidateId', 'candidateName email mobile')
                .populate('hiringRequestId', 'requestId roleDetails.jobTitle client')
                .sort({ sentAt: -1 })
                .skip(skip)
                .limit(limitNum)
                .lean(),
            TAEmailLog.countDocuments(query)
        ]);

        res.json({
            logs,
            pagination: {
                total,
                page: pageNum,
                limit: limitNum,
                pages: Math.ceil(total / limitNum)
            }
        });

    } catch (error) {
        console.error('Error fetching TA email history:', error);
        res.status(500).json({ message: 'Failed to fetch TA email history', error: error.message });
    }
};

exports.getTAEmailHistoryById = async (req, res) => {
    try {
        const { id } = req.params;
        const log = await TAEmailLog.findOne({
            _id: id,
            companyId: req.companyId
        })
            .populate('sentBy', 'firstName lastName email')
            .populate('candidateId', 'candidateName email mobile')
            .populate('hiringRequestId', 'requestId roleDetails.jobTitle client')
            .lean();

        if (!log) {
            return res.status(404).json({ message: 'Email log not found.' });
        }

        res.json(log);
    } catch (error) {
        console.error('Error fetching TA email history detail:', error);
        res.status(500).json({ message: 'Failed to fetch email history detail', error: error.message });
    }
};

exports.downloadTAEmailAttachment = async (req, res) => {
    try {
        const { id, attachmentIndex } = req.params;
        const log = await TAEmailLog.findOne({
            _id: id,
            companyId: req.companyId
        }).lean();

        if (!log) {
            return res.status(404).json({ message: 'Email log not found.' });
        }

        const idx = parseInt(attachmentIndex, 10);
        if (isNaN(idx) || idx < 0 || !log.attachments || idx >= log.attachments.length) {
            return res.status(404).json({ message: 'Attachment not found.' });
        }

        const attachment = log.attachments[idx];
        if (!attachment.cloudinaryUrl) {
            return res.status(404).json({ message: 'Attachment URL is missing.' });
        }

        const axios = require('axios');
        const response = await axios({
            method: 'GET',
            url: attachment.cloudinaryUrl,
            responseType: 'stream'
        });

        res.setHeader('Content-Type', response.headers['content-type'] || 'application/octet-stream');
        res.setHeader('Content-Disposition', `attachment; filename="${attachment.filename || 'attachment'}"`);

        response.data.pipe(res);

    } catch (error) {
        console.error('Error downloading TA email attachment:', error);
        res.status(500).json({ message: 'Failed to download attachment', error: error.message });
    }
};

exports.resendTAEmail = async (req, res) => {
    try {
        const { id } = req.params;
        const originalLog = await TAEmailLog.findOne({
            _id: id,
            companyId: req.companyId
        }).populate('candidateId').populate('hiringRequestId');

        if (!originalLog) {
            return res.status(404).json({ message: 'Email log not found.' });
        }

        const payload = req.body || {};
        const recipientEmail = (payload.recipientEmail || originalLog.recipientEmail || originalLog.candidateId?.email || '').trim();
        if (!recipientEmail) {
            return res.status(400).json({ message: 'Recipient email is missing.' });
        }

        const subject = payload.subject || originalLog.subject || 'No Subject';
        const body = payload.body || originalLog.body || '';
        const cc = payload.cc !== undefined ? payload.cc : (originalLog.cc || '');
        const bcc = payload.bcc !== undefined ? payload.bcc : (originalLog.bcc || '');

        const company = await Company.findById(req.companyId).select('name logoUrl subdomain').lean();
        const branding = await getCompanyEmailBranding(req.companyId, company);

        const delivery = await resolveNotificationEmailDelivery(
            req.companyId,
            'ta_mass_mail_sent',
            originalLog.emailAccountId
        );

        if (!delivery.shouldSendEmail) {
            return res.status(400).json({ message: 'TA email delivery is disabled in notification settings.' });
        }

        const attachments = (originalLog.attachments || []).map(att => ({
            filename: att.filename,
            path: att.url || att.path || att.cloudinaryUrl
        })).filter(att => att.path);

        const emailHtml = body;
        const emailText = hasHtmlMarkup(emailHtml) ? stripHtml(emailHtml) : emailHtml;

        let sendResult = null;
        let lastErr = null;
        try {
            sendResult = await sendEmailForCompany({
                companyId: req.companyId,
                emailAccountId: delivery.emailAccountId,
                to: recipientEmail,
                cc: cc || undefined,
                bcc: bcc || undefined,
                subject,
                html: emailHtml,
                text: emailText,
                attachments,
                ...branding
            });
        } catch (err) {
            lastErr = err;
        }

        const senderName = [req.user.firstName, req.user.lastName].filter(Boolean).join(' ') || 'Recruiter';

        const newLog = await TAEmailLog.create({
            companyId: req.companyId,
            hiringRequestId: originalLog.hiringRequestId?._id || originalLog.hiringRequestId || null,
            hiringRequestTitle: originalLog.hiringRequestTitle || '',
            candidateId: originalLog.candidateId?._id || originalLog.candidateId || null,
            recipientName: originalLog.recipientName || 'Candidate',
            recipientEmail,
            sentBy: req.user._id,
            senderName,
            senderEmail: req.user.email || '',
            templateId: originalLog.templateId || null,
            templateName: originalLog.templateName || 'General Mail',
            emailAccountId: delivery.emailAccountId || 'platform',
            emailAccountLabel: delivery.emailAccountId === 'platform' ? 'TalentCIO Platform' : (delivery.emailAccountId || 'TalentCIO Platform'),
            cc,
            bcc,
            subject,
            body: emailHtml,
            attachments: originalLog.attachments || [],
            status: sendResult ? 'Sent' : 'Failed',
            errorReason: lastErr ? lastErr.message : '',
            errorMessage: lastErr ? lastErr.message : '',
            sentAt: new Date()
        });

        if (!sendResult && lastErr) {
            return res.status(500).json({
                message: `Failed to resend email: ${lastErr.message}`,
                log: newLog
            });
        }

        const io = req.app.get('io');
        if (io) {
            io.to(`company_${req.companyId}`).emit('ta_email_logged', { log: newLog });
        }

        res.json({
            message: `Email successfully resent to ${recipientEmail}`,
            log: newLog
        });
    } catch (error) {
        console.error('Error resending TA email:', error);
        res.status(500).json({ message: 'Failed to resend email', error: error.message });
    }
};
