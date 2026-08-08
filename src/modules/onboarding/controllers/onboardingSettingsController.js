const OnboardingEmployee = require('../onboardingEmployee.model');
const Company = require('../../company/company.model');
const OnboardingPolicyBin = require('../onboardingPolicyBin.model');
const OnboardingTemplateBin = require('../onboardingTemplateBin.model');
const PizZip = require('pizzip');
const Docxtemplater = require('docxtemplater');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { extractPublicIdFromUrl } = require('../../../utils/cloudinaryHelper');
const { formatDate, formatCurrency } = require('../utils/onboardingHelpers');

const getTemplateContent = async (customUrl, defaultPath) => {
    try {
        if (customUrl && typeof customUrl === 'string' && customUrl.startsWith('http')) {
            const response = await axios.get(customUrl, { responseType: 'arraybuffer' });
            return response.data;
        }
    } catch (err) {
        console.error('Failed to fetch remote template, falling back to default:', err.message);
    }

    if (!fs.existsSync(defaultPath)) {
        throw new Error(`Default template not found at ${defaultPath}. Please run the template generation script.`);
    }
    return fs.readFileSync(defaultPath, 'binary');
};

exports.getTemplateContent = getTemplateContent;

const DUMMY_PREVIEW_DATA = {
    offer_date: formatDate(new Date()),
    employee_full_name: 'Johnathan Doe',
    employee_first_name: 'Johnathan',
    employee_last_name: 'Doe',
    employee_permanent_address: '123 Main Street, Phase 5',
    employee_address: '123 Main Street, Phase 5',
    employee_city: 'New Delhi',
    designation: 'Senior Software Engineer',
    department: 'Information Technology',
    joining_date: formatDate(new Date(Date.now() + 15 * 24 * 60 * 60 * 1000)),
    work_location: 'Bangalore (Hybrid)',
    probation_period: '6 months',
    probationPeriod: '6 months',
    annual_ctc: '₹ 25,00,000',
    basic_salary: '₹ 1,00,000',
    hra: '₹ 40,000',
    special_allowance: '₹ 68,333',
    monthly_gross: '₹ 2,08,333',
    monthly_ctc: '₹ 2,15,000',
    hr_name: 'Sarah Smith',
    hr_designation: 'HR Director',
    declaration_date: formatDate(new Date()),
    employee_signature_name: 'Johnathan Doe',
    employee_id: 'TEMP_123456'
};

exports.getOnboardingSettings = async (req, res) => {
    try {
        res.set('Cache-Control', 'private, max-age=60, stale-while-revalidate=60');
        const company = await Company.findById(req.companyId).select('settings.onboarding');
        res.json(company.settings.onboarding || { offerLetterTemplateUrl: '', declarationTemplateUrl: '' });
    } catch (error) {
        res.status(500).json({ message: 'Failed to fetch settings', error: error.message });
    }
};

exports.updateTemplate = async (req, res) => {
    try {
        const { type, url } = req.body;
        const field = type === 'offerLetter' ? 'settings.onboarding.offerLetterTemplateUrl' : 'settings.onboarding.declarationTemplateUrl';

        await Company.findByIdAndUpdate(req.companyId, { [field]: url });
        res.json({ message: 'Template updated successfully!', url });
    } catch (error) {
        res.status(500).json({ message: 'Failed to update template', error: error.message });
    }
};

exports.uploadAndSetTemplate = async (req, res) => {
    try {
        if (!req.file) return res.status(400).json({ message: 'No file uploaded' });

        const { type } = req.body;
        if (!['offerLetter', 'declaration'].includes(type)) {
            return res.status(400).json({ message: 'Invalid template type. Use offerLetter or declaration.' });
        }

        const url = req.file.path;
        const field = type === 'offerLetter' ? 'settings.onboarding.offerLetterTemplateUrl' : 'settings.onboarding.declarationTemplateUrl';

        await Company.findByIdAndUpdate(req.companyId, { [field]: url });

        res.status(200).json({
            message: `${type === 'offerLetter' ? 'Offer Letter' : 'Declaration'} template uploaded and set successfully!`,
            url
        });
    } catch (error) {
        console.error('Error uploading template:', error);
        res.status(500).json({ message: 'Failed to upload template', error: error.message });
    }
};

exports.deleteBaseTemplate = async (req, res) => {
    try {
        const { type } = req.params;
        if (!['offerLetter', 'declaration'].includes(type)) {
            return res.status(400).json({ message: 'Invalid template type' });
        }

        const company = await Company.findById(req.companyId).select('settings.onboarding');
        const field = type === 'offerLetter' ? 'offerLetterTemplateUrl' : 'declarationTemplateUrl';
        const templateUrl = company.settings.onboarding[field];

        if (!templateUrl) {
            return res.status(400).json({ message: 'No custom template to delete' });
        }

        const publicId = extractPublicIdFromUrl(templateUrl);
        if (publicId) {
            const { cloudinary } = require('../../../config/cloudinary');
            try {
                await cloudinary.uploader.destroy(publicId, { resource_type: 'raw' });
            } catch (e) {
                console.error('Cloudinary delete error:', e.message);
            }
        }

        company.settings.onboarding[field] = '';
        await company.save();

        res.json({ message: `${type === 'offerLetter' ? 'Offer Letter' : 'Declaration'} template deleted successfully.` });
    } catch (error) {
        console.error('Error deleting template:', error);
        res.status(500).json({ message: 'Failed to delete template', error: error.message });
    }
};

exports.addPolicy = async (req, res) => {
    try {
        if (!req.file) return res.status(400).json({ message: 'No file uploaded' });

        const { name, isRequired } = req.body;
        if (!name) return res.status(400).json({ message: 'Policy name is required' });

        const url = req.file.path;
        const publicId = extractPublicIdFromUrl(url);

        const newPolicy = {
            name,
            url,
            publicId,
            isRequired: isRequired === 'true' || isRequired === true
        };

        await Company.findByIdAndUpdate(req.companyId, {
            $push: { 'settings.onboarding.policies': newPolicy }
        });

        res.status(200).json({ message: 'Policy uploaded successfully!', policy: newPolicy });
    } catch (error) {
        console.error('Error adding policy:', error);
        res.status(500).json({ message: 'Failed to add policy', error: error.message });
    }
};

exports.deletePolicy = async (req, res) => {
    try {
        const { policyId } = req.params;
        const company = await Company.findById(req.companyId);

        const policy = company.settings.onboarding.policies.id(policyId);
        if (!policy) return res.status(404).json({ message: 'Policy not found' });

        const isUsed = await OnboardingEmployee.exists({
            companyId: req.companyId,
            $or: [
                { 'requestedDocuments.templateId': policyId },
                { 'offerDeclaration.acceptedPolicies.policyId': policyId }
            ]
        });

        await OnboardingPolicyBin.deleteMany({ companyId: req.companyId, originalId: policyId });
        const binItem = new OnboardingPolicyBin({
            companyId: req.companyId,
            originalId: policyId,
            name: policy.name,
            url: policy.url,
            publicId: policy.publicId,
            isRequired: policy.isRequired,
            isDeleted: true,
            deletedAt: new Date(),
            deletedBy: req.user?._id
        });
        await binItem.save();

        if (isUsed) {
            await Company.updateOne(
                { _id: req.companyId, 'settings.onboarding.policies._id': policyId },
                { $set: { 'settings.onboarding.policies.$.isDeleted': true } }
            );
        } else {
            await Company.findByIdAndUpdate(req.companyId, {
                $pull: { 'settings.onboarding.policies': { _id: policyId } }
            });
        }

        res.json({ message: 'Policy deleted successfully' });
    } catch (error) {
        console.error('Error deleting policy:', error);
        res.status(500).json({ message: 'Failed to delete policy', error: error.message });
    }
};

exports.addDynamicTemplate = async (req, res) => {
    try {
        if (!req.file) return res.status(400).json({ message: 'No file uploaded' });

        const { name, isRequired } = req.body;
        if (!name) return res.status(400).json({ message: 'Template name is required' });

        const url = req.file.path;
        const publicId = extractPublicIdFromUrl(url);

        const newTemplate = {
            name,
            url,
            publicId,
            isRequired: isRequired === 'true' || isRequired === true
        };

        await Company.findByIdAndUpdate(req.companyId, {
            $push: { 'settings.onboarding.dynamicTemplates': newTemplate }
        });

        res.status(200).json({ message: 'Dynamic template uploaded successfully!', template: newTemplate });
    } catch (error) {
        console.error('Error adding dynamic template:', error);
        res.status(500).json({ message: 'Failed to add template', error: error.message });
    }
};

exports.deleteDynamicTemplate = async (req, res) => {
    try {
        const { templateId } = req.params;
        const company = await Company.findById(req.companyId);

        const template = company.settings.onboarding.dynamicTemplates.find(t => t._id.toString() === templateId);
        if (!template) return res.status(404).json({ message: 'Template not found' });

        const isUsed = await OnboardingEmployee.exists({
            companyId: req.companyId,
            $or: [
                { 'requestedDocuments.templateId': templateId },
                { 'offerDeclaration.acceptedTemplates.templateId': templateId }
            ]
        });

        await OnboardingTemplateBin.deleteMany({ companyId: req.companyId, originalId: templateId });
        const binItem = new OnboardingTemplateBin({
            companyId: req.companyId,
            originalId: templateId,
            name: template.name,
            url: template.url,
            publicId: template.publicId,
            isRequired: template.isRequired,
            isDeleted: true,
            deletedAt: new Date(),
            deletedBy: req.user?._id
        });
        await binItem.save();

        if (isUsed) {
            await Company.updateOne(
                { _id: req.companyId, 'settings.onboarding.dynamicTemplates._id': templateId },
                { $set: { 'settings.onboarding.dynamicTemplates.$.isDeleted': true } }
            );
        } else {
            await Company.findByIdAndUpdate(req.companyId, {
                $pull: { 'settings.onboarding.dynamicTemplates': { _id: templateId } }
            });
        }

        res.json({ message: 'Template deleted successfully' });
    } catch (error) {
        console.error('Error deleting template:', error);
        res.status(500).json({ message: 'Failed to delete template', error: error.message });
    }
};

exports.getTemplatePreview = async (req, res) => {
    try {
        const { type } = req.params;
        const { withData } = req.query;
        const company = await Company.findById(req.companyId).select('settings.onboarding').lean();

        const customUrl = type === 'offerLetter' ? company?.settings?.onboarding?.offerLetterTemplateUrl : company?.settings?.onboarding?.declarationTemplateUrl;
        const defaultPath = type === 'offerLetter' ?
            path.join(__dirname, '../../../templates/offer_letter_template.docx') :
            path.join(__dirname, '../../../templates/declaration_template.docx');

        const content = await getTemplateContent(customUrl, defaultPath);
        const zip = new PizZip(content);
        const doc = new Docxtemplater(zip, {
            paragraphLoop: true,
            linebreaks: true,
            nullGetter: () => '—'
        });

        let previewData = { ...DUMMY_PREVIEW_DATA };
        try {
            const PayrollConfig = require('../../payroll/payrollConfig.model');
            const config = await PayrollConfig.findOne({ companyId: req.companyId });
            if (config && config.salaryComponents) {
                config.salaryComponents.forEach(c => {
                    previewData[c.id] = '₹ 10,000';
                    previewData[`${c.id}_annual`] = '₹ 1,20,000';
                    const cleanId = c.id.replace(/([A-Z])/g, '_$1').toLowerCase();
                    previewData[cleanId] = '₹ 10,000';
                    previewData[`${cleanId}_annual`] = '₹ 1,20,000';
                    if (!cleanId.endsWith('_allowance')) {
                        previewData[`${cleanId}_allowance`] = '₹ 10,000';
                        previewData[`${cleanId}_allowance_annual`] = '₹ 1,20,000';
                    }
                });
            }
        } catch (e) {
            console.error('Error populating dynamic dummy preview data:', e);
        }

        if (withData !== 'false') {
            doc.render(previewData);
        }

        const buffer = doc.getZip().generate({ type: 'nodebuffer' });

        const filename = `Preview_${type}.docx`;
        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
        res.setHeader('Content-Disposition', `inline; filename=${filename}`);
        res.send(buffer);
    } catch (error) {
        console.error('Error generating template preview:', error);
        res.status(500).json({ message: 'Failed to generate preview', error: error.message });
    }
};

exports.downloadTemplate = async (req, res) => {
    try {
        const { type } = req.params;
        const company = await Company.findById(req.companyId).select('settings.onboarding').lean();

        const customUrl = type === 'offerLetter' ? company?.settings?.onboarding?.offerLetterTemplateUrl : company?.settings?.onboarding?.declarationTemplateUrl;
        const defaultPath = type === 'offerLetter' ?
            path.join(__dirname, '../../../templates/offer_letter_template.docx') :
            path.join(__dirname, '../../../templates/declaration_template.docx');

        const content = await getTemplateContent(customUrl, defaultPath);

        const filename = `${type === 'offerLetter' ? 'OfferLetter' : 'Declaration'}_Template.docx`;
        res.setHeader('Content-Disposition', `attachment; filename=${filename}`);
        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');

        res.send(Buffer.from(content, 'binary'));
    } catch (error) {
        console.error('Error downloading template:', error);
        res.status(500).json({ message: 'Failed to download template', error: error.message });
    }
};
