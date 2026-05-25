const mongoose = require('mongoose');
const EmailTemplate = require('../models/EmailTemplate');
const {
    GENERAL_EMAIL_TEMPLATE_PLACEHOLDERS,
    ONBOARDING_EMAIL_TEMPLATE_PLACEHOLDERS,
    TEMPLATE_PLACEHOLDERS,
    validateTemplateSyntax
} = require('../utils/templateResolver');

const getTemplateScope = (req) => req.templateScope === 'general' ? 'general' : 'ta';
const normalizeTemplateType = (value) => value === 'onboarding' ? 'onboarding' : 'general';
const getTemplateTypeForPayload = (req, body = {}) => normalizeTemplateType(body.templateType);
const getAllowedPlaceholdersForScope = (req, body = {}) => {
    if (getTemplateScope(req) !== 'general') {
        return TEMPLATE_PLACEHOLDERS;
    }

    return getTemplateTypeForPayload(req, body) === 'onboarding'
        ? ONBOARDING_EMAIL_TEMPLATE_PLACEHOLDERS
        : GENERAL_EMAIL_TEMPLATE_PLACEHOLDERS;
};

const applyTemplateTypeFilter = (req, query, templateType) => {
    if (getTemplateScope(req) !== 'general') {
        return query;
    }

    if (templateType === 'onboarding') {
        query.templateType = 'onboarding';
        return query;
    }

    if (templateType === 'general') {
        query.$or = [{ templateType: 'general' }, { templateType: { $exists: false } }];
    }

    return query;
};

const buildScopedTemplateQuery = (req, extra = {}) => {
    const scope = getTemplateScope(req);

    if (scope === 'general') {
        return {
            companyId: req.companyId,
            scope: 'general',
            ...extra
        };
    }

    return {
        companyId: req.companyId,
        $and: [
            { $or: [{ scope: 'ta' }, { scope: { $exists: false } }] },
            extra
        ]
    };
};

const normalizeTemplatePayload = (body = {}) => ({
    name: String(body.name || '').trim(),
    subject: String(body.subject || '').trim(),
    htmlBody: String(body.htmlBody || ''),
    templateType: normalizeTemplateType(body.templateType),
    category: body.category || 'general',
    isActive: typeof body.isActive === 'boolean' ? body.isActive : true
});

exports.createEmailTemplate = async (req, res) => {
    try {
        const payload = normalizeTemplatePayload(req.body);
        const allowedPlaceholders = getAllowedPlaceholdersForScope(req, payload);

        if (!payload.name || !payload.subject || !payload.htmlBody) {
            return res.status(400).json({ message: 'Name, subject, and HTML body are required.' });
        }

        const subjectValidation = validateTemplateSyntax(payload.subject, allowedPlaceholders);
        if (!subjectValidation.valid) {
            return res.status(400).json({ message: `Subject error: ${subjectValidation.message}` });
        }

        const bodyValidation = validateTemplateSyntax(payload.htmlBody, allowedPlaceholders);
        if (!bodyValidation.valid) {
            return res.status(400).json({ message: `HTML body error: ${bodyValidation.message}` });
        }

        const template = await EmailTemplate.create({
            ...payload,
            companyId: req.companyId,
            createdBy: req.user._id,
            scope: getTemplateScope(req)
        });

        const populatedTemplate = await EmailTemplate.findById(template._id)
            .populate('createdBy', 'firstName lastName email')
            .lean();

        res.status(201).json(populatedTemplate);
    } catch (error) {
        console.error('createEmailTemplate error:', error);
        res.status(500).json({ message: 'Failed to create email template', error: error.message });
    }
};

exports.listEmailTemplates = async (req, res) => {
    try {
        const { active } = req.query;
        const extra = {};

        if (active === 'true') extra.isActive = true;
        if (active === 'false') extra.isActive = false;

        const query = applyTemplateTypeFilter(
            req,
            buildScopedTemplateQuery(req, extra),
            req.query.templateType
        );

        const templates = await EmailTemplate.find(query)
            .populate('createdBy', 'firstName lastName email')
            .sort({ updatedAt: -1, createdAt: -1 })
            .lean();

        res.status(200).json(templates);
    } catch (error) {
        console.error('listEmailTemplates error:', error);
        res.status(500).json({ message: 'Failed to fetch email templates', error: error.message });
    }
};

exports.getEmailTemplateById = async (req, res) => {
    try {
        if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
            return res.status(400).json({ message: 'Invalid template ID.' });
        }

        const template = await EmailTemplate.findOne(buildScopedTemplateQuery(req, { _id: req.params.id }))
            .populate('createdBy', 'firstName lastName email')
            .lean();

        if (!template) {
            return res.status(404).json({ message: 'Email template not found.' });
        }

        res.status(200).json(template);
    } catch (error) {
        console.error('getEmailTemplateById error:', error);
        res.status(500).json({ message: 'Failed to fetch email template', error: error.message });
    }
};

exports.updateEmailTemplate = async (req, res) => {
    try {
        if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
            return res.status(400).json({ message: 'Invalid template ID.' });
        }

        const payload = normalizeTemplatePayload(req.body);
        const allowedPlaceholders = getAllowedPlaceholdersForScope(req, payload);

        if (!payload.name || !payload.subject || !payload.htmlBody) {
            return res.status(400).json({ message: 'Name, subject, and HTML body are required.' });
        }

        const subjectValidation = validateTemplateSyntax(payload.subject, allowedPlaceholders);
        if (!subjectValidation.valid) {
            return res.status(400).json({ message: `Subject error: ${subjectValidation.message}` });
        }

        const bodyValidation = validateTemplateSyntax(payload.htmlBody, allowedPlaceholders);
        if (!bodyValidation.valid) {
            return res.status(400).json({ message: `HTML body error: ${bodyValidation.message}` });
        }

        const template = await EmailTemplate.findOneAndUpdate(
            buildScopedTemplateQuery(req, { _id: req.params.id }),
            {
                $set: {
                    name: payload.name,
                    subject: payload.subject,
                    htmlBody: payload.htmlBody,
                    templateType: payload.templateType,
                    category: payload.category,
                    isActive: payload.isActive
                }
            },
            { new: true }
        )
            .populate('createdBy', 'firstName lastName email')
            .lean();

        if (!template) {
            return res.status(404).json({ message: 'Email template not found.' });
        }

        res.status(200).json(template);
    } catch (error) {
        console.error('updateEmailTemplate error:', error);
        res.status(500).json({ message: 'Failed to update email template', error: error.message });
    }
};

exports.deleteEmailTemplate = async (req, res) => {
    try {
        if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
            return res.status(400).json({ message: 'Invalid template ID.' });
        }

        const template = await EmailTemplate.findOne(buildScopedTemplateQuery(req, { _id: req.params.id }));

        if (!template) {
            return res.status(404).json({ message: 'Email template not found.' });
        }

        template.isActive = false;
        await template.softDelete(req.user?._id);

        res.status(200).json({ message: 'Email template moved to recycle bin successfully.', template });
    } catch (error) {
        console.error('deleteEmailTemplate error:', error);
        res.status(500).json({ message: 'Failed to delete email template', error: error.message });
    }
};
