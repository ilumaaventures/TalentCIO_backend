const axios = require('axios');
const mongoose = require('mongoose');
const User = require('../user/user.model');
const EmployeeProfile = require('../dossier/employeeProfile.model');
const EmailTemplate = require('../email/emailTemplate.model');
const HREmailLog = require('../email/hrEmailLog.model');
const Company = require('../company/company.model');
const { cloudinary } = require('../../config/cloudinary');
const { extractPublicIdFromUrl } = require('../../utils/cloudinaryHelper');
const { syncDocumentSubmissionStatus } = require('../dossier/dossierUtils');
const {
    PLATFORM_EMAIL_ACCOUNT_ID,
    getCompanyEmailSettings,
    sendEmailForCompany
} = require('../../services/companyEmailService');
const {
    GENERAL_EMAIL_TEMPLATE_PLACEHOLDERS,
    renderTemplateBody,
    resolveTemplate,
    validateTemplateSyntax
} = require('../email/templateResolver');

const ALLOWED_DOSSIER_CATEGORIES = new Set([
    'Resume',
    'ID Proof',
    'Education',
    'Employment',
    'Payslips',
    'Bank',
    'Relieving Letter',
    'Other',
    'Custom Files'
]);
const MAX_ATTACHMENTS = 5;
const DOSSIER_CATEGORY_STORAGE_MAP = {
    'Custom Files': 'Other'
};

const escapeRegex = (value = '') => String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const formatDate = (value) => {
    if (!value) return '';

    try {
        return new Date(value).toLocaleDateString('en-IN', {
            day: '2-digit',
            month: 'short',
            year: 'numeric'
        });
    } catch (error) {
        return '';
    }
};

const sanitizeFileName = (value = '', fallback = 'attachment') => {
    const trimmedValue = String(value || '').trim();
    return (trimmedValue || fallback).replace(/[<>:"/\\|?*\u0000-\u001F]/g, '_');
};

const parseJsonArray = (value, fieldName) => {
    if (!value) return [];

    try {
        const parsed = typeof value === 'string' ? JSON.parse(value) : value;
        if (!Array.isArray(parsed)) {
            throw new Error(`${fieldName} must be an array`);
        }
        return parsed;
    } catch (error) {
        throw new Error(`${fieldName} must be a valid JSON array`);
    }
};

const resolveProfileStorageCategory = (category = '') => (
    DOSSIER_CATEGORY_STORAGE_MAP[String(category || '').trim()] || String(category || '').trim()
);

const resolveRecipientEmail = (user, profile) => (
    String(
        profile?.contact?.workEmail
        || profile?.contact?.personalEmail
        || user?.email
        || ''
    ).trim()
);

const buildTemplateData = ({ user, profile, company }) => ({
    firstName: user?.firstName || '',
    lastName: user?.lastName || '',
    fullName: `${user?.firstName || ''} ${user?.lastName || ''}`.trim(),
    email: user?.email || '',
    workEmail: profile?.contact?.workEmail || user?.email || '',
    mobile: profile?.contact?.mobileNumber || '',
    phoneNumber: profile?.contact?.mobileNumber || '',
    designation: profile?.employment?.designation || user?.designation || '',
    jobTitle: profile?.employment?.designation || user?.designation || '',
    department: profile?.employment?.department || user?.department || '',
    employeeCode: user?.employeeCode || '',
    joiningDate: formatDate(profile?.employment?.joiningDate || user?.joiningDate),
    companyName: company?.name || '',
    location: profile?.employment?.branch || user?.workLocation || '',
    currentYear: String(new Date().getFullYear()),
    currentDate: new Date().toLocaleDateString('en-US', { month: 'long', day: '2-digit', year: 'numeric' }),
    managerName: '',
    managerEmail: ''
});

const getEmailAccountSnapshot = async (companyId, requestedEmailAccountId) => {
    const settings = await getCompanyEmailSettings(companyId);
    const requestedId = String(requestedEmailAccountId || '').trim();
    const defaultAccountId = String(settings?.defaultAccountId || PLATFORM_EMAIL_ACCOUNT_ID);
    const accountIdToUse = requestedId || defaultAccountId || PLATFORM_EMAIL_ACCOUNT_ID;

    if (accountIdToUse === PLATFORM_EMAIL_ACCOUNT_ID) {
        return {
            emailAccountId: PLATFORM_EMAIL_ACCOUNT_ID,
            emailAccountLabel: 'TalentCIO Platform'
        };
    }

    const selectedAccount = (settings?.accounts || []).find((account) => String(account?._id || '') === accountIdToUse);
    if (!selectedAccount) {
        return {
            emailAccountId: accountIdToUse,
            emailAccountLabel: accountIdToUse
        };
    }

    return {
        emailAccountId: String(selectedAccount._id),
        emailAccountLabel: selectedAccount.name || selectedAccount.fromAddress || accountIdToUse
    };
};

const fetchRemoteAttachmentPayloads = async (cloudinaryUrls = []) => {
    const payloads = [];

    for (const item of cloudinaryUrls) {
        const url = String(item?.url || '').trim();
        if (!url) {
            throw new Error('Each cloudinaryUrls item must include a url.');
        }

        const response = await axios.get(url, { responseType: 'arraybuffer', timeout: 20000 });
        const pathSegment = url.split('/').pop()?.split('?')[0] || 'attachment';
        const filename = sanitizeFileName(item?.filename, pathSegment);

        payloads.push({
            filename,
            content: Buffer.from(response.data),
            contentType: response.headers['content-type'] || 'application/octet-stream',
            cloudinaryUrl: url,
            publicId: extractPublicIdFromUrl(url) || ''
        });
    }

    return payloads;
};

const uploadAttachmentBufferToCloudinary = async (companyId, file) => {
    const originalName = sanitizeFileName(file?.originalname, 'attachment');
    const extension = originalName.includes('.') ? `.${originalName.split('.').pop()}` : '';
    const baseName = originalName.replace(/\.[^/.]+$/, '') || 'attachment';
    const publicId = `${baseName.replace(/[^a-zA-Z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'attachment'}-${Date.now()}${extension}`;

    const uploadResult = await new Promise((resolve, reject) => {
        const stream = cloudinary.uploader.upload_stream(
            {
                folder: `talentcio/${companyId}/hr-emails`,
                resource_type: 'raw',
                public_id: publicId
            },
            (error, uploaded) => (error ? reject(error) : resolve(uploaded))
        );

        stream.end(file.buffer);
    });

    return {
        filename: originalName,
        cloudinaryUrl: uploadResult?.secure_url || '',
        publicId: uploadResult?.public_id || ''
    };
};

exports.getEmployees = async (req, res) => {
    try {
        const page = Math.max(Number.parseInt(req.query?.page, 10) || 1, 1);
        const limit = Math.min(Math.max(Number.parseInt(req.query?.limit, 10) || 20, 1), 100);
        const search = String(req.query?.search || '').trim();
        const baseQuery = {
            companyId: req.companyId,
            isActive: true,
            isDeleted: { $ne: true }
        };

        if (search) {
            const regex = new RegExp(escapeRegex(search), 'i');
            baseQuery.$or = [
                { firstName: regex },
                { lastName: regex },
                { email: regex },
                { employeeCode: regex },
                { department: regex }
            ];
        }

        const [total, users] = await Promise.all([
            User.countDocuments(baseQuery),
            User.find(baseQuery)
                .select('firstName lastName email employeeCode department employeeProfile')
                .populate('employeeProfile', 'contact.workEmail contact.personalEmail employment.designation employment.department')
                .sort({ firstName: 1, lastName: 1 })
                .skip((page - 1) * limit)
                .limit(limit)
                .lean()
        ]);

        const employees = users.map((user) => {
            const profile = user.employeeProfile || {};
            const resolvedEmail = resolveRecipientEmail(user, profile);

            return {
                _id: user._id,
                firstName: user.firstName || '',
                lastName: user.lastName || '',
                email: resolvedEmail,
                employeeCode: user.employeeCode || '',
                department: profile?.employment?.department || user.department || '',
                designation: profile?.employment?.designation || '',
                workEmail: profile?.contact?.workEmail || '',
                personalEmail: profile?.contact?.personalEmail || ''
            };
        });

        return res.json({
            employees,
            total,
            totalPages: Math.max(Math.ceil(total / limit), 1)
        });
    } catch (error) {
        console.error('getEmployees error:', error);
        return res.status(500).json({ message: 'Failed to fetch active employees.' });
    }
};

exports.getTemplates = async (req, res) => {
    try {
        const templates = await EmailTemplate.find({
            companyId: req.companyId,
            scope: 'general',
            isActive: true,
            isDeleted: { $ne: true },
            $or: [
                { templateType: 'general' },
                { templateType: { $exists: false } }
            ]
        })
            .select('_id name subject htmlBody templateType category')
            .sort({ updatedAt: -1 })
            .lean();

        return res.json({ templates });
    } catch (error) {
        console.error('getTemplates error:', error);
        return res.status(500).json({ message: 'Failed to fetch email templates.' });
    }
};

exports.sendHREmail = async (req, res) => {
    try {
        const requestedFiles = Array.isArray(req.files) ? req.files : [];
        const recipientUserIds = parseJsonArray(req.body?.recipientUserIds, 'recipientUserIds')
            .map((value) => String(value || '').trim())
            .filter(Boolean);
        const cloudinaryUrls = parseJsonArray(req.body?.cloudinaryUrls, 'cloudinaryUrls');
        const dossierSave = String(req.body?.dossierSave || 'true').trim().toLowerCase() !== 'false';

        let customEmails = {};
        if (req.body?.customEmails) {
            try {
                customEmails = typeof req.body.customEmails === 'string'
                    ? JSON.parse(req.body.customEmails)
                    : req.body.customEmails;
            } catch (e) {
                console.error('Failed to parse customEmails:', e);
            }
        }
        const dossierCategory = String(req.body?.dossierCategory || '').trim();
        const notes = String(req.body?.notes || '').trim();
        const cc = String(req.body?.cc || '').trim();
        const bcc = String(req.body?.bcc || '').trim();
        const totalAttachmentCount = requestedFiles.length + cloudinaryUrls.length;

        if (recipientUserIds.length === 0) {
            return res.status(400).json({ message: 'Select at least one recipient.' });
        }

        if (requestedFiles.length > MAX_ATTACHMENTS || totalAttachmentCount > MAX_ATTACHMENTS) {
            return res.status(400).json({ message: `A maximum of ${MAX_ATTACHMENTS} attachments is allowed.` });
        }

        if (totalAttachmentCount > 0 && dossierSave && !dossierCategory) {
            return res.status(400).json({ message: 'Choose a dossier category when saving attachments to the dossier.' });
        }

        if (dossierCategory && !ALLOWED_DOSSIER_CATEGORIES.has(dossierCategory)) {
            return res.status(400).json({ message: 'Invalid dossier category.' });
        }

        const company = req.company || await Company.findById(req.companyId).select('name').lean();
        const templateId = String(req.body?.emailTemplateId || '').trim();
        let selectedTemplate = null;

        if (templateId) {
            if (!mongoose.isValidObjectId(templateId)) {
                return res.status(400).json({ message: 'Invalid email template id.' });
            }

            selectedTemplate = await EmailTemplate.findOne({
                _id: templateId,
                companyId: req.companyId,
                scope: 'general',
                isActive: true,
                isDeleted: { $ne: true }
            }).lean();

            if (!selectedTemplate) {
                return res.status(400).json({ message: 'Selected email template was not found.' });
            }
        }

        const subjectTemplate = String(req.body?.subject || selectedTemplate?.subject || '').trim();
        const bodyTemplate = String(req.body?.htmlBody || selectedTemplate?.htmlBody || '');

        if (!subjectTemplate || !bodyTemplate.trim()) {
            return res.status(400).json({ message: 'Email subject and body are required.' });
        }

        const subjectValidation = validateTemplateSyntax(subjectTemplate, GENERAL_EMAIL_TEMPLATE_PLACEHOLDERS);
        if (!subjectValidation.valid) {
            return res.status(400).json({ message: `Subject error: ${subjectValidation.message}` });
        }

        const bodyValidation = validateTemplateSyntax(bodyTemplate, GENERAL_EMAIL_TEMPLATE_PLACEHOLDERS);
        if (!bodyValidation.valid) {
            return res.status(400).json({ message: `Body error: ${bodyValidation.message}` });
        }

        const remoteAttachmentPayloads = await fetchRemoteAttachmentPayloads(cloudinaryUrls);
        const localAttachmentPayloads = requestedFiles.map((file) => ({
            filename: sanitizeFileName(file.originalname, 'attachment'),
            content: file.buffer,
            contentType: file.mimetype || 'application/octet-stream'
        }));
        const emailAttachments = [
            ...localAttachmentPayloads,
            ...remoteAttachmentPayloads.map((item) => ({
                filename: item.filename,
                content: item.content,
                contentType: item.contentType
            }))
        ];
        const emailAccountSnapshot = await getEmailAccountSnapshot(req.companyId, req.body?.emailAccountId);
        const sent = [];
        const failed = [];

        for (const recipientUserId of recipientUserIds) {
            let resolvedEmail = '';

            try {
                if (!mongoose.isValidObjectId(recipientUserId)) {
                    failed.push({ userId: recipientUserId, email: '', reason: 'Invalid user id' });
                    continue;
                }

                const user = await User.findOne({
                    _id: recipientUserId,
                    companyId: req.companyId,
                    isActive: true,
                    isDeleted: { $ne: true }
                })
                    .select('firstName lastName email department employeeCode joiningDate employeeProfile')
                    .populate('employeeProfile', 'contact.workEmail contact.personalEmail contact.mobileNumber employment.designation employment.department employment.joiningDate employment.branch')
                    .lean();

                if (!user) {
                    failed.push({ userId: recipientUserId, email: '', reason: 'Active employee not found' });
                    continue;
                }

                const profile = user.employeeProfile || null;
                resolvedEmail = customEmails[recipientUserId] || resolveRecipientEmail(user, profile);

                if (!resolvedEmail) {
                    failed.push({ userId: recipientUserId, email: '', reason: 'No email address found' });
                    continue;
                }

                const templateData = buildTemplateData({ user, profile, company });
                if (customEmails[recipientUserId]) {
                    templateData.email = customEmails[recipientUserId];
                    templateData.workEmail = customEmails[recipientUserId];
                }
                const resolvedSubject = resolveTemplate(subjectTemplate, templateData);
                const resolvedHtml = renderTemplateBody(bodyTemplate, templateData);
                const emailSent = await sendEmailForCompany({
                    companyId: req.companyId,
                    emailAccountId: emailAccountSnapshot.emailAccountId,
                    to: resolvedEmail,
                    cc: cc || undefined,
                    bcc: bcc || undefined,
                    subject: resolvedSubject,
                    html: resolvedHtml,
                    attachments: emailAttachments
                });

                if (!emailSent) {
                    failed.push({ userId: recipientUserId, email: resolvedEmail, reason: 'Failed to send email' });
                    continue;
                }

                let dossierSaved = false;
                let dossierSaveError = '';
                let loggedAttachments = [
                    ...requestedFiles.map((file) => ({
                        filename: sanitizeFileName(file.originalname, 'attachment'),
                        cloudinaryUrl: '',
                        publicId: '',
                        dossierDocId: null
                    })),
                    ...remoteAttachmentPayloads.map((item) => ({
                        filename: item.filename,
                        cloudinaryUrl: item.cloudinaryUrl,
                        publicId: item.publicId,
                        dossierDocId: null
                    }))
                ];
                let dossierDocIds = [];

                if (dossierSave && totalAttachmentCount > 0) {
                    if (!profile?._id) {
                        dossierSaveError = 'Profile not found';
                    } else {
                        try {
                            const profileDoc = await EmployeeProfile.findOne({
                                _id: profile._id,
                                companyId: req.companyId
                            });

                            if (!profileDoc) {
                                dossierSaveError = 'Profile not found';
                            } else {
                                const uploadedLocalAttachments = [];
                                for (const file of requestedFiles) {
                                    try {
                                        const uploaded = await uploadAttachmentBufferToCloudinary(req.companyId, file);
                                        uploadedLocalAttachments.push(uploaded);
                                    } catch (uploadError) {
                                        throw new Error(`Failed to upload ${file?.originalname || 'attachment'} to Cloudinary`);
                                    }
                                }

                                const combinedAttachments = [
                                    ...uploadedLocalAttachments,
                                    ...remoteAttachmentPayloads.map((item) => ({
                                        filename: item.filename,
                                        cloudinaryUrl: item.cloudinaryUrl,
                                        publicId: item.publicId
                                    }))
                                ];

                                profileDoc.documents = Array.isArray(profileDoc.documents) ? profileDoc.documents : [];
                                loggedAttachments = [];

                                combinedAttachments.forEach((attachment) => {
                                    profileDoc.documents.push({
                                        category: resolveProfileStorageCategory(dossierCategory || 'Other'),
                                        title: attachment.filename,
                                        fileName: attachment.filename,
                                        url: attachment.cloudinaryUrl,
                                        uploadDate: new Date(),
                                        uploadedBy: req.user._id,
                                        verificationStatus: 'Pending Review',
                                        versionNumber: 1,
                                        isDeleted: false,
                                        versionHistory: []
                                    });

                                    const insertedDoc = profileDoc.documents[profileDoc.documents.length - 1];
                                    if (insertedDoc?._id) {
                                        dossierDocIds.push(insertedDoc._id);
                                    }

                                    loggedAttachments.push({
                                        filename: attachment.filename,
                                        cloudinaryUrl: attachment.cloudinaryUrl,
                                        publicId: attachment.publicId || '',
                                        dossierDocId: insertedDoc?._id || null
                                    });
                                });

                                syncDocumentSubmissionStatus(profileDoc);
                                await profileDoc.save();
                                dossierSaved = true;
                            }
                        } catch (dossierError) {
                            dossierSaveError = dossierError.message || 'Failed to save attachments to dossier';
                        }
                    }
                }

                await HREmailLog.create({
                    companyId: req.companyId,
                    sentBy: req.user._id,
                    recipientUserId: user._id,
                    recipientEmail: resolvedEmail,
                    cc,
                    bcc,
                    subject: resolvedSubject,
                    body: resolvedHtml,
                    type: 'general',
                    templateId: selectedTemplate?._id || null,
                    templateName: selectedTemplate?.name || '',
                    emailAccountId: emailAccountSnapshot.emailAccountId,
                    emailAccountLabel: emailAccountSnapshot.emailAccountLabel,
                    attachments: loggedAttachments,
                    dossierCategory: dossierCategory || '',
                    dossierSaved,
                    dossierSaveError,
                    sentAt: new Date(),
                    notes
                });

                sent.push({
                    userId: user._id,
                    email: resolvedEmail,
                    dossierDocIds
                });
            } catch (error) {
                console.error(`sendHREmail error for recipient ${recipientUserId}:`, error);
                failed.push({
                    userId: recipientUserId,
                    email: resolvedEmail,
                    reason: error.message || 'Unexpected error while sending email'
                });
            }
        }

        return res.json({
            sent,
            failed,
            totalSent: sent.length,
            totalFailed: failed.length
        });
    } catch (error) {
        console.error('sendHREmail error:', error);
        return res.status(500).json({ message: error.message || 'Failed to send HR emails.' });
    }
};

exports.getHistory = async (req, res) => {
    try {
        const { type = 'general' } = req.query;
        const user = await User.findById(req.params.userId).select('email').lean();
        const emailList = [];
        if (user && user.email) {
            emailList.push(user.email.toLowerCase());
        }
        const profile = await EmployeeProfile.findOne({ user: req.params.userId })
            .select('contact.workEmail contact.personalEmail')
            .lean();
        if (profile && profile.contact) {
            if (profile.contact.workEmail) emailList.push(profile.contact.workEmail.toLowerCase());
            if (profile.contact.personalEmail) emailList.push(profile.contact.personalEmail.toLowerCase());
        }

        const query = {
            companyId: req.companyId,
            type
        };

        if (emailList.length > 0) {
            query.$or = [
                { recipientUserId: req.params.userId },
                { recipientEmail: { $in: emailList } }
            ];
        } else {
            query.recipientUserId = req.params.userId;
        }

        const history = await HREmailLog.find(query)
            .populate('sentBy', 'firstName lastName')
            .populate('templateId', 'name')
            .sort({ sentAt: -1 })
            .limit(20)
            .lean();

        return res.json({ history });
    } catch (error) {
        console.error('getHistory error:', error);
        return res.status(500).json({ message: 'Failed to fetch HR email history.' });
    }
};
