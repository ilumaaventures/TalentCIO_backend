const mongoose = require('mongoose');
const EmailTemplate = require('../models/EmailTemplate');

const normalizeTemplatePayload = (body = {}) => ({
    name: String(body.name || '').trim(),
    subject: String(body.subject || '').trim(),
    htmlBody: String(body.htmlBody || ''),
    category: body.category || 'general',
    isActive: typeof body.isActive === 'boolean' ? body.isActive : true
});

exports.createEmailTemplate = async (req, res) => {
    try {
        const payload = normalizeTemplatePayload(req.body);

        if (!payload.name || !payload.subject || !payload.htmlBody) {
            return res.status(400).json({ message: 'Name, subject, and HTML body are required.' });
        }

        const template = await EmailTemplate.create({
            ...payload,
            companyId: req.companyId,
            createdBy: req.user._id
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
        const query = { companyId: req.companyId };

        if (active === 'true') query.isActive = true;
        if (active === 'false') query.isActive = false;

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

        const template = await EmailTemplate.findOne({ _id: req.params.id, companyId: req.companyId })
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

        if (!payload.name || !payload.subject || !payload.htmlBody) {
            return res.status(400).json({ message: 'Name, subject, and HTML body are required.' });
        }

        const template = await EmailTemplate.findOneAndUpdate(
            { _id: req.params.id, companyId: req.companyId },
            {
                $set: {
                    name: payload.name,
                    subject: payload.subject,
                    htmlBody: payload.htmlBody,
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

        const template = await EmailTemplate.findOneAndUpdate(
            { _id: req.params.id, companyId: req.companyId },
            { $set: { isActive: false } },
            { new: true }
        ).lean();

        if (!template) {
            return res.status(404).json({ message: 'Email template not found.' });
        }

        res.status(200).json({ message: 'Email template archived successfully.', template });
    } catch (error) {
        console.error('deleteEmailTemplate error:', error);
        res.status(500).json({ message: 'Failed to delete email template', error: error.message });
    }
};
