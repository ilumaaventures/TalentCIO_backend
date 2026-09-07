const OnboardingEmployee = require('../model/onboardingEmployee.model');
const Company = require('../../company/company.model');
const OnboardingPolicyBin = require('../model/onboardingPolicyBin.model');
const OnboardingTemplateBin = require('../model/onboardingTemplateBin.model');
const PizZip = require('pizzip');
const Docxtemplater = require('docxtemplater');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const mammoth = require('mammoth');
const { uploadBufferToCloudinary } = require('../../../config/cloudinary');
const { extractPublicIdFromUrl } = require('../../../utils/cloudinaryHelper');
const { formatDate, formatCurrency, buildSalaryTableXml, preprocessDocxXml } = require('../utils/onboardingHelpers');

const escapeXml = (unsafe) => String(unsafe)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');

const updateDocxWithText = (originalBuffer, textContent) => {
    const zip = new PizZip(originalBuffer);
    const currentXml = zip.file('word/document.xml') ? zip.file('word/document.xml').asText() : '';
    const sectPrMatch = currentXml.match(/<w:sectPr[\s\S]*?<\/w:sectPr>/);
    const sectPrXml = sectPrMatch ? sectPrMatch[0] : '';

    // Extract all original paragraphs with their pPr
    const origParagraphs = currentXml.match(/<w:p\b[\s\S]*?<\/w:p>/g) || [];
    const origPPrMap = [];
    origParagraphs.forEach(p => {
        const t = [...p.matchAll(/<w:t[^>]*>([\s\S]*?)<\/w:t>/g)].map(m => m[1]).join('').trim();
        const pPrMatch = p.match(/<w:pPr[\s\S]*?<\/w:pPr>/);
        const pPr = pPrMatch ? pPrMatch[0] : '';
        if (t) {
            origPPrMap.push({ text: t, pPr });
        }
    });

    const normalized = (textContent || '')
        .replace(/\r\n/g, '\n')
        .replace(/^[ \t]+$/gm, '')
        .replace(/\n{3,}/g, '\n\n')
        .trim();

    const lines = normalized.split('\n');
    let nonBlankIdx = 0;
    let consecutiveEmpty = 0;

    const paragraphsXml = lines.map(line => {
        const trimmed = line.trim();
        if (!trimmed) {
            consecutiveEmpty++;
            if (consecutiveEmpty > 1) return '';
            return '<w:p><w:pPr><w:spacing w:after="120" w:line="240" w:lineRule="auto"/></w:pPr></w:p>';
        }
        consecutiveEmpty = 0;

        // Check if we can reuse an original pPr
        let pPr = '';
        const exactMatch = origPPrMap.find(item => item.text === trimmed);
        if (exactMatch && exactMatch.pPr) {
            pPr = exactMatch.pPr;
        } else if (nonBlankIdx < origPPrMap.length && origPPrMap[nonBlankIdx].pPr) {
            pPr = origPPrMap[nonBlankIdx].pPr;
        }
        nonBlankIdx++;

        if (!pPr) {
            const isTitle = nonBlankIdx <= 2 && trimmed.length < 50;
            const isHeading = /^(\d+\.|\bAnnexure\b|[A-Z]\.)/i.test(trimmed) || (trimmed.length < 50 && trimmed === trimmed.toUpperCase());
            if (isTitle) {
                pPr = '<w:pPr><w:jc w:val="center"/><w:spacing w:before="120" w:after="240"/><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri"/><w:b/><w:sz w:val="28"/><w:szCs w:val="28"/></w:rPr></w:pPr>';
            } else if (isHeading) {
                pPr = '<w:pPr><w:spacing w:before="240" w:after="120"/><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri"/><w:b/><w:sz w:val="24"/><w:szCs w:val="24"/></w:rPr></w:pPr>';
            } else {
                pPr = '<w:pPr><w:spacing w:after="160" w:line="276" w:lineRule="auto"/><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri"/><w:sz w:val="22"/><w:szCs w:val="22"/></w:rPr></w:pPr>';
            }
        }

        const isAnnexure = /^Annexure\s+[A-Z]/i.test(trimmed);
        const pageBreakXml = isAnnexure ? '<w:r><w:br w:type="page"/></w:r>' : '';

        const isHeadingText = /^(\d+\.|\bAnnexure\b|[A-Z]\.)/i.test(trimmed) || /^(PRIVATE\s*&\s*CONFIDENTIAL|Letter of Intent|Dear\b)/i.test(trimmed);
        let runXml = '';

        if (trimmed.includes('**')) {
            const parts = [];
            const regex = /\*\*(.*?)\*\*/g;
            let lastIndex = 0;
            let match;
            while ((match = regex.exec(trimmed)) !== null) {
                if (match.index > lastIndex) parts.push({ text: trimmed.substring(lastIndex, match.index), bold: false });
                parts.push({ text: match[1], bold: true });
                lastIndex = match.index + match[0].length;
            }
            if (lastIndex < trimmed.length) parts.push({ text: trimmed.substring(lastIndex), bold: false });
            runXml = parts.map(p => {
                const rPr = p.bold
                    ? '<w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri"/><w:b/></w:rPr>'
                    : '<w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri"/></w:rPr>';
                return `<w:r>${rPr}<w:t xml:space="preserve">${escapeXml(p.text)}</w:t></w:r>`;
            }).join('');
        } else {
            const rPr = isHeadingText
                ? '<w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri"/><w:b/></w:rPr>'
                : '<w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri"/></w:rPr>';
            runXml = `<w:r>${rPr}<w:t xml:space="preserve">${escapeXml(line)}</w:t></w:r>`;
        }

        return `<w:p>${pageBreakXml}${pPr}${runXml}</w:p>`;
    }).filter(Boolean).join('');

    const newDocXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"
            xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <w:body>
    ${paragraphsXml}
    ${sectPrXml}
  </w:body>
</w:document>`;

    zip.file('word/document.xml', newDocXml);
    return zip.generate({ type: 'nodebuffer', compression: 'DEFLATE' });
};

const getTemplateContent = async (customUrl) => {
    if (customUrl && typeof customUrl === 'string' && customUrl.startsWith('http')) {
        const response = await axios.get(customUrl, { responseType: 'arraybuffer' });
        return response.data;
    }
    throw new Error('Template document not found or URL is invalid. Please upload a template in Document Settings.');
};

exports.getTemplateContent = getTemplateContent;

const DUMMY_EARNINGS = [
    { name: 'Basic Salary', monthly: '₹ 1,00,000', annual: '₹ 12,00,000' },
    { name: 'House Rent Allowance (HRA)', monthly: '₹ 40,000', annual: '₹ 4,80,000' },
    { name: 'Special Allowance', monthly: '₹ 68,333', annual: '₹ 8,20,000' }
];

const DUMMY_CONTRIBUTIONS = [
    { name: 'PF Employer Contribution', monthly: '₹ 1,800', annual: '₹ 21,600' },
    { name: 'Gratuity Provision', monthly: '₹ 4,808', annual: '₹ 57,696' }
];

const DUMMY_DEDUCTIONS = [
    { name: 'PF Employee Contribution', monthly: '₹ 1,800', annual: '₹ 21,600' },
    { name: 'Professional Tax (PT)', monthly: '₹ 200', annual: '₹ 2,400' }
];

const DUMMY_TOTALS = {
    monthlyGross: '₹ 2,08,333',
    annualGross: '₹ 25,00,000',
    monthlyContributions: '₹ 6,608',
    annualContributions: '₹ 79,296',
    monthlyCTC: '₹ 2,15,000',
    annualCTC: '₹ 25,79,296',
    monthlyDeductions: '₹ 2,000',
    annualDeductions: '₹ 24,000',
    monthlyNet: '₹ 2,06,333',
    annualNet: '₹ 24,76,000'
};

const DUMMY_SALARY_TABLE_XML = buildSalaryTableXml(DUMMY_EARNINGS, DUMMY_CONTRIBUTIONS, DUMMY_DEDUCTIONS, DUMMY_TOTALS);

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
    salary_table: DUMMY_SALARY_TABLE_XML,
    salaryTable: DUMMY_SALARY_TABLE_XML,
    earnings_breakdown: DUMMY_EARNINGS,
    contributions_breakdown: DUMMY_CONTRIBUTIONS,
    deductions_breakdown: DUMMY_DEDUCTIONS,
    all_components: [
        ...DUMMY_EARNINGS.map(e => ({ ...e, category: 'Earnings' })),
        ...DUMMY_CONTRIBUTIONS.map(c => ({ ...c, category: 'Employer Contributions' })),
        ...DUMMY_DEDUCTIONS.map(d => ({ ...d, category: 'Employee Deductions' }))
    ],
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

exports.updatePolicy = async (req, res) => {
    try {
        const { policyId } = req.params;
        const { name, isRequired } = req.body;

        const company = await Company.findById(req.companyId);
        if (!company) return res.status(404).json({ message: 'Company not found' });

        const policy = company.settings?.onboarding?.policies?.find(p => p._id.toString() === policyId);
        if (!policy) return res.status(404).json({ message: 'Policy not found' });

        if (name && typeof name === 'string' && name.trim()) {
            policy.name = name.trim();
        }

        if (isRequired !== undefined) {
            policy.isRequired = isRequired === 'true' || isRequired === true;
        }

        if (req.file) {
            const oldPublicId = policy.publicId;
            if (oldPublicId) {
                const { cloudinary } = require('../../../config/cloudinary');
                try {
                    await cloudinary.uploader.destroy(oldPublicId, { resource_type: 'raw' });
                } catch (e) {
                    console.error('Failed to delete old policy file on Cloudinary:', e.message);
                }
            }

            policy.url = req.file.path;
            policy.publicId = extractPublicIdFromUrl(req.file.path);
        }

        await company.save();

        res.status(200).json({
            message: 'Policy updated successfully!',
            policy
        });
    } catch (error) {
        console.error('Error updating policy:', error);
        res.status(500).json({ message: 'Failed to update policy', error: error.message });
    }
};

exports.addDynamicTemplate = async (req, res) => {
    try {
        if (!req.file) return res.status(400).json({ message: 'No file uploaded' });

        const { name, isRequired } = req.body;
        if (!name) return res.status(400).json({ message: 'Template name is required' });

        const url = req.file.path;
        const publicId = extractPublicIdFromUrl(url);

        const company = await Company.findById(req.companyId);
        if (!company) return res.status(404).json({ message: 'Company not found' });
        if (!company.settings) company.settings = {};
        if (!company.settings.onboarding) company.settings.onboarding = {};
        if (!company.settings.onboarding.dynamicTemplates) company.settings.onboarding.dynamicTemplates = [];

        company.settings.onboarding.dynamicTemplates.push({
            name,
            url,
            publicId,
            isRequired: isRequired === 'true' || isRequired === true,
            isDeleted: false
        });
        await company.save();

        const createdTemplate = company.settings.onboarding.dynamicTemplates[company.settings.onboarding.dynamicTemplates.length - 1];
        res.status(200).json({ message: 'Dynamic template uploaded successfully!', template: createdTemplate });
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

exports.getDynamicTemplateContent = async (req, res) => {
    try {
        const { templateId } = req.params;
        const company = await Company.findById(req.companyId).select('settings.onboarding');
        if (!company) return res.status(404).json({ message: 'Company not found' });

        const dynamicTemplates = company.settings?.onboarding?.dynamicTemplates || [];
        const normId = (templateId || '').trim();
        const normClean = normId.replace(/[\s_-]+/g, '').toLowerCase();

        let template = dynamicTemplates.find(t => 
            (t._id && t._id.toString() === normId) || 
            (t.id && t.id.toString() === normId) ||
            t.name === normId || 
            t.name?.toLowerCase() === normId.toLowerCase() ||
            (normClean && t.name?.replace(/[\s_-]+/g, '').toLowerCase() === normClean) ||
            (/offer/i.test(normId) && /offer/i.test(t.name)) ||
            (/declaration/i.test(normId) && /declaration/i.test(t.name)) ||
            (/loi/i.test(normId) && /loi/i.test(t.name)) ||
            (/^cl$/i.test(normId) && /^cl$/i.test(t.name))
        );

        let targetUrl = template?.url;
        let templateName = template?.name;

        if (!targetUrl) {
            if (/offer/i.test(normId) || normClean === 'offerletter') {
                targetUrl = company.settings?.onboarding?.offerLetterTemplateUrl;
                templateName = templateName || 'Offer letter';
            } else if (/declaration/i.test(normId) || normClean === 'declaration') {
                targetUrl = company.settings?.onboarding?.declarationTemplateUrl;
                templateName = templateName || 'Declaration';
            }
        }

        if (!targetUrl && (normId === 'undefined' || normId === 'null' || !normId)) {
            const activeTpl = dynamicTemplates.find(t => !t.isDeleted && t.url);
            if (activeTpl) {
                targetUrl = activeTpl.url;
                templateName = activeTpl.name;
            } else if (company.settings?.onboarding?.offerLetterTemplateUrl) {
                targetUrl = company.settings?.onboarding?.offerLetterTemplateUrl;
                templateName = 'Offer letter';
            }
        }

        if (!targetUrl) return res.status(404).json({ message: 'Template not found' });

        const buffer = await getTemplateContent(targetUrl);
        const { value: rawContent } = await mammoth.extractRawText({ buffer: Buffer.from(buffer) });
        const content = (rawContent || '')
            .replace(/\r\n/g, '\n')
            .replace(/^[ \t]+$/gm, '')
            .replace(/\n{3,}/g, '\n\n')
            .trim();

        res.json({ content, name: templateName || template?.name || 'Document' });
    } catch (error) {
        console.error('Error getting dynamic template content:', error);
        res.status(500).json({ message: 'Failed to extract template content', error: error.message });
    }
};

exports.generateTemplatePreviewBuffer = async (req, res) => {
    try {
        const { templateId } = req.params;
        const { content, targetUrl: explicitUrl } = req.body || {};

        const company = await Company.findById(req.companyId).select('settings.onboarding');
        if (!company) return res.status(404).json({ message: 'Company not found' });

        const dynamicTemplates = company.settings?.onboarding?.dynamicTemplates || [];
        const normId = (templateId || '').trim();
        const normClean = normId.replace(/[\s_-]+/g, '').toLowerCase();

        let template = dynamicTemplates.find(t => 
            (t._id && t._id.toString() === normId) || 
            (t.id && t.id.toString() === normId) ||
            t.name === normId || 
            t.name?.toLowerCase() === normId.toLowerCase() ||
            (normClean && t.name?.replace(/[\s_-]+/g, '').toLowerCase() === normClean) ||
            (/offer/i.test(normId) && /offer/i.test(t.name)) ||
            (/declaration/i.test(normId) && /declaration/i.test(t.name)) ||
            (/loi/i.test(normId) && /loi/i.test(t.name)) ||
            (/^cl$/i.test(normId) && /^cl$/i.test(t.name))
        );

        let targetUrl = explicitUrl || template?.url;
        let templateName = template?.name;

        if (!targetUrl) {
            if (/offer/i.test(normId) || normClean === 'offerletter') {
                targetUrl = company.settings?.onboarding?.offerLetterTemplateUrl;
                templateName = templateName || 'Offer letter';
            } else if (/declaration/i.test(normId) || normClean === 'declaration') {
                targetUrl = company.settings?.onboarding?.declarationTemplateUrl;
                templateName = templateName || 'Declaration';
            }
        }

        if (!targetUrl && (normId === 'undefined' || normId === 'null' || !normId)) {
            const activeTpl = dynamicTemplates.find(t => !t.isDeleted && t.url);
            if (activeTpl) {
                targetUrl = activeTpl.url;
                templateName = activeTpl.name;
            } else if (company.settings?.onboarding?.offerLetterTemplateUrl) {
                targetUrl = company.settings?.onboarding?.offerLetterTemplateUrl;
                templateName = 'Offer letter';
            }
        }

        if (!targetUrl) return res.status(404).json({ message: 'Template not found' });

        const originalBuffer = await getTemplateContent(targetUrl);
        let previewBuffer = Buffer.from(originalBuffer);

        if (content && typeof content === 'string' && content.trim()) {
            const { value: rawContent } = await mammoth.extractRawText({ buffer: Buffer.from(originalBuffer) });
            const normalize = (s) => (s || '').replace(/\r\n/g, '\n').replace(/^[ \t]+$/gm, '').replace(/\n{3,}/g, '\n\n').trim();
            const isChanged = normalize(content) !== normalize(rawContent);

            if (isChanged) {
                previewBuffer = updateDocxWithText(previewBuffer, content);
            }
        }

        const safeDocName = (templateName || 'Document').replace(/[^a-zA-Z0-9\s]/g, '').replace(/\s+/g, '_');
        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
        res.setHeader('Content-Disposition', `inline; filename="${safeDocName}_preview.docx"`);
        res.send(previewBuffer);
    } catch (error) {
        console.error('Error generating template preview buffer:', error);
        res.status(500).json({ message: 'Failed to generate preview', error: error.message });
    }
};

exports.updateDynamicTemplate = async (req, res) => {
    try {
        const { templateId } = req.params;
        const { name, isRequired, content } = req.body;

        const company = await Company.findById(req.companyId);
        if (!company) return res.status(404).json({ message: 'Company not found' });

        const dynamicTemplates = company.settings?.onboarding?.dynamicTemplates || [];
        const normId = (templateId || '').trim();
        const normClean = normId.replace(/[\s_-]+/g, '').toLowerCase();

        let template = dynamicTemplates.find(t => 
            (t._id && t._id.toString() === normId) || 
            (t.id && t.id.toString() === normId) ||
            t.name === normId || 
            t.name?.toLowerCase() === normId.toLowerCase() ||
            (normClean && t.name?.replace(/[\s_-]+/g, '').toLowerCase() === normClean) ||
            (/offer/i.test(normId) && /offer/i.test(t.name)) ||
            (/declaration/i.test(normId) && /declaration/i.test(t.name)) ||
            (/loi/i.test(normId) && /loi/i.test(t.name)) ||
            (/^cl$/i.test(normId) && /^cl$/i.test(t.name))
        );
        if (!template && (normId === 'undefined' || normId === 'null' || !normId)) {
            template = dynamicTemplates.find(t => !t.isDeleted && t.url);
        }
        if (!template) return res.status(404).json({ message: 'Template not found' });

        if (name && typeof name === 'string' && name.trim()) {
            template.name = name.trim();
        }

        if (isRequired !== undefined) {
            template.isRequired = isRequired === 'true' || isRequired === true;
        }

        if (req.file) {
            const oldPublicId = template.publicId;
            if (oldPublicId) {
                const { cloudinary } = require('../../../config/cloudinary');
                try {
                    await cloudinary.uploader.destroy(oldPublicId, { resource_type: 'raw' });
                } catch (e) {
                    console.error('Failed to delete old template on Cloudinary:', e.message);
                }
            }

            template.url = req.file.path;
            template.publicId = extractPublicIdFromUrl(req.file.path);
        } else if (content !== undefined && typeof content === 'string') {
            if (!template.url) return res.status(400).json({ message: 'No template file to update. Please upload a .docx file.' });
            const originalBuffer = await getTemplateContent(template.url);
            const { value: rawContent } = await mammoth.extractRawText({ buffer: Buffer.from(originalBuffer) });
            const normalize = (s) => (s || '').replace(/\r\n/g, '\n').replace(/^[ \t]+$/gm, '').replace(/\n{3,}/g, '\n\n').trim();
            const isChanged = normalize(content) !== normalize(rawContent);

            if (isChanged) {
                const updatedBuffer = updateDocxWithText(Buffer.from(originalBuffer), content);
                const oldPublicId = template.publicId;
                if (oldPublicId) {
                    const { cloudinary } = require('../../../config/cloudinary');
                    try {
                        await cloudinary.uploader.destroy(oldPublicId, { resource_type: 'raw' });
                    } catch (e) {
                        console.error('Failed to delete old template on Cloudinary:', e.message);
                    }
                }

                const safeFileName = `${(template.name || 'template').replace(/[^a-zA-Z0-9_-]/g, '_')}.docx`;
                const uploadedUrl = await uploadBufferToCloudinary(updatedBuffer, safeFileName, 'onboarding_documents');
                template.url = uploadedUrl;
                template.publicId = extractPublicIdFromUrl(uploadedUrl);
            }
        }

        await company.save();

        res.status(200).json({
            message: 'Dynamic template updated successfully!',
            template
        });
    } catch (error) {
        console.error('Error updating dynamic template:', error);
        res.status(500).json({ message: 'Failed to update template', error: error.message });
    }
};

exports.getTemplatePreview = async (req, res) => {
    try {
        const { type } = req.params;
        const { withData } = req.query;
        const company = await Company.findById(req.companyId).select('settings.onboarding').lean();

        const customUrl = type === 'offerLetter' ? company?.settings?.onboarding?.offerLetterTemplateUrl : company?.settings?.onboarding?.declarationTemplateUrl;
        if (!customUrl) {
            return res.status(404).json({ message: `No ${type === 'offerLetter' ? 'Offer Letter' : 'Declaration'} template uploaded yet. Please upload a template in Settings first.` });
        }

        const content = await getTemplateContent(customUrl);
        const zip = new PizZip(content);

        try {
            let docXml = zip.file('word/document.xml').asText();
            docXml = preprocessDocxXml(docXml);
            zip.file('word/document.xml', docXml);
        } catch (xmlErr) {
            console.error('Error preprocessing template preview document.xml:', xmlErr);
        }

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
        if (!customUrl) {
            return res.status(404).json({ message: `No ${type === 'offerLetter' ? 'Offer Letter' : 'Declaration'} template uploaded yet.` });
        }

        const content = await getTemplateContent(customUrl);

        const filename = `${type === 'offerLetter' ? 'OfferLetter' : 'Declaration'}_Template.docx`;
        res.setHeader('Content-Disposition', `attachment; filename=${filename}`);
        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');

        res.send(Buffer.from(content, 'binary'));
    } catch (error) {
        console.error('Error downloading template:', error);
        res.status(500).json({ message: 'Failed to download template', error: error.message });
    }
};

exports.getEmployeeTemplateContent = async (req, res) => {
    try {
        const { id, templateId } = req.params;
        const [employee, company] = await Promise.all([
            OnboardingEmployee.findOne({ _id: id, companyId: req.companyId }),
            Company.findById(req.companyId).select('settings.onboarding').lean()
        ]);

        if (!employee) return res.status(404).json({ message: 'Employee not found' });

        const normId = (templateId || '').trim();
        const normClean = normId.replace(/[\s_-]+/g, '').toLowerCase();

        const custom = employee.customTemplates?.find(t => 
            t.templateId === normId || 
            (t._id && t._id.toString() === normId) || 
            t.name === normId ||
            t.name?.toLowerCase() === normId.toLowerCase() ||
            (normClean && t.name?.replace(/[\s_-]+/g, '').toLowerCase() === normClean) ||
            (/offer/i.test(normId) && /offer/i.test(t.name))
        );
        const dynamicTemplates = company.settings?.onboarding?.dynamicTemplates || [];
        const dynamicTemplate = dynamicTemplates.find(t => 
            (t._id && t._id.toString() === normId) || 
            (t.id && t.id.toString() === normId) || 
            t.name === normId ||
            t.name?.toLowerCase() === normId.toLowerCase() ||
            (normClean && t.name?.replace(/[\s_-]+/g, '').toLowerCase() === normClean) ||
            (/offer/i.test(normId) && /offer/i.test(t.name)) ||
            (/declaration/i.test(normId) && /declaration/i.test(t.name)) ||
            (/loi/i.test(normId) && /loi/i.test(t.name)) ||
            (/^cl$/i.test(normId) && /^cl$/i.test(t.name))
        );

        let targetUrl = custom?.url || dynamicTemplate?.url;
        let templateName = custom?.name || dynamicTemplate?.name || 'Document';

        if (!targetUrl) {
            if (/offer/i.test(normId) || normClean === 'offerletter' || /offer/i.test(templateName)) {
                targetUrl = employee.offerLetterUrl || company.settings?.onboarding?.offerLetterTemplateUrl;
                templateName = templateName || 'Offer letter';
            } else if (/declaration/i.test(normId) || normClean === 'declaration' || /declaration/i.test(templateName)) {
                targetUrl = company.settings?.onboarding?.declarationTemplateUrl;
                templateName = templateName || 'Declaration';
            }
        }

        if (!targetUrl && (normId === 'undefined' || normId === 'null' || !normId)) {
            const activeTpl = dynamicTemplates.find(t => !t.isDeleted && t.url);
            if (activeTpl) {
                targetUrl = activeTpl.url;
                templateName = activeTpl.name;
            } else if (employee.offerLetterUrl || company.settings?.onboarding?.offerLetterTemplateUrl) {
                targetUrl = employee.offerLetterUrl || company.settings?.onboarding?.offerLetterTemplateUrl;
                templateName = 'Offer letter';
            }
        }

        if (!targetUrl) {
            return res.status(404).json({ message: 'Template not found' });
        }

        const buffer = await getTemplateContent(targetUrl);
        const { value: rawContent } = await mammoth.extractRawText({ buffer: Buffer.from(buffer) });
        const content = (rawContent || '')
            .replace(/\r\n/g, '\n')
            .replace(/^[ \t]+$/gm, '')
            .replace(/\n{3,}/g, '\n\n')
            .trim();

        res.json({
            content,
            name: templateName,
            isCustomized: Boolean(custom)
        });
    } catch (error) {
        console.error('Error getting employee template content:', error);
        res.status(500).json({ message: 'Failed to extract template content', error: error.message });
    }
};

exports.updateEmployeeTemplateContent = async (req, res) => {
    try {
        const { id, templateId } = req.params;
        const { content } = req.body;

        if (typeof content !== 'string') {
            return res.status(400).json({ message: 'Content is required' });
        }

        const [employee, company] = await Promise.all([
            OnboardingEmployee.findOne({ _id: id, companyId: req.companyId }),
            Company.findById(req.companyId).select('settings.onboarding').lean()
        ]);

        if (!employee) return res.status(404).json({ message: 'Employee not found' });

        const normId = (templateId || '').trim();
        const normClean = normId.replace(/[\s_-]+/g, '').toLowerCase();

        const isOffer = /offer/i.test(normId) || normClean === 'offerletter';
        const isAlreadyAccepted = (employee.offerDeclaration?.acceptedTemplates || []).some(at => 
            at.templateId === normId || (at._id && at._id.toString() === normId)
        ) || (isOffer && (employee.offerStatus === 'Accepted' || employee.status === 'Submitted'));

        if (isAlreadyAccepted) {
            return res.status(400).json({ message: 'Cannot edit document after it has been accepted by the candidate' });
        }

        const existingCustom = employee.customTemplates?.find(t => 
            t.templateId === normId || 
            (t._id && t._id.toString() === normId) || 
            t.name === normId ||
            t.name?.toLowerCase() === normId.toLowerCase() ||
            (normClean && t.name?.replace(/[\s_-]+/g, '').toLowerCase() === normClean) ||
            (/offer/i.test(normId) && /offer/i.test(t.name))
        );
        const dynamicTemplates = company.settings?.onboarding?.dynamicTemplates || [];
        const dynamicTemplate = dynamicTemplates.find(t => 
            (t._id && t._id.toString() === normId) || 
            (t.id && t.id.toString() === normId) ||
            t.name === normId ||
            t.name?.toLowerCase() === normId.toLowerCase() ||
            (normClean && t.name?.replace(/[\s_-]+/g, '').toLowerCase() === normClean) ||
            (/offer/i.test(normId) && /offer/i.test(t.name)) ||
            (/declaration/i.test(normId) && /declaration/i.test(t.name)) ||
            (/loi/i.test(normId) && /loi/i.test(t.name)) ||
            (/^cl$/i.test(normId) && /^cl$/i.test(t.name))
        );

        let baseTemplateUrl = existingCustom?.url || dynamicTemplate?.url;
        let templateName = existingCustom?.name || dynamicTemplate?.name || 'Document';

        if (!baseTemplateUrl) {
            if (/offer/i.test(normId) || normClean === 'offerletter' || /offer/i.test(templateName)) {
                baseTemplateUrl = employee.offerLetterUrl || company.settings?.onboarding?.offerLetterTemplateUrl;
                templateName = templateName || 'Offer letter';
            } else if (/declaration/i.test(normId) || normClean === 'declaration' || /declaration/i.test(templateName)) {
                baseTemplateUrl = company.settings?.onboarding?.declarationTemplateUrl;
                templateName = templateName || 'Declaration';
            }
        }

        if (!baseTemplateUrl && (normId === 'undefined' || normId === 'null' || !normId)) {
            const activeTpl = dynamicTemplates.find(t => !t.isDeleted && t.url);
            if (activeTpl) {
                baseTemplateUrl = activeTpl.url;
                templateName = activeTpl.name;
            } else if (employee.offerLetterUrl || company.settings?.onboarding?.offerLetterTemplateUrl) {
                baseTemplateUrl = employee.offerLetterUrl || company.settings?.onboarding?.offerLetterTemplateUrl;
                templateName = 'Offer letter';
            }
        }

        if (!baseTemplateUrl) {
            return res.status(404).json({ message: 'Base template not found to customize' });
        }

        const originalBuffer = await getTemplateContent(baseTemplateUrl);
        const { value: rawContent } = await mammoth.extractRawText({ buffer: Buffer.from(originalBuffer) });
        const normalize = (s) => (s || '').replace(/\r\n/g, '\n').replace(/^[ \t]+$/gm, '').replace(/\n{3,}/g, '\n\n').trim();
        const isChanged = normalize(content) !== normalize(rawContent);

        let updatedBuffer = Buffer.from(originalBuffer);
        if (isChanged) {
            updatedBuffer = updateDocxWithText(Buffer.from(originalBuffer), content);
        }

        if (existingCustom?.publicId) {
            const { cloudinary } = require('../../../config/cloudinary');
            try {
                await cloudinary.uploader.destroy(existingCustom.publicId, { resource_type: 'raw' });
            } catch (e) {
                console.error('Failed to destroy old candidate custom template:', e.message);
            }
        }

        const safeCandidateName = `${employee.firstName}_${employee.lastName || ''}`.replace(/[^a-zA-Z0-9]/g, '_');
        const safeDocName = templateName.replace(/[^a-zA-Z0-9]/g, '_');
        const fileName = `${safeCandidateName}_${safeDocName}.docx`;
        const uploadedUrl = await uploadBufferToCloudinary(updatedBuffer, fileName, 'onboarding_documents');
        const publicId = extractPublicIdFromUrl(uploadedUrl);

        if (!employee.customTemplates) {
            employee.customTemplates = [];
        }

        const existingIndex = employee.customTemplates.findIndex(t => t.templateId === templateId);
        const entry = {
            templateId,
            name: templateName,
            url: uploadedUrl,
            publicId,
            updatedAt: new Date()
        };

        if (existingIndex > -1) {
            employee.customTemplates[existingIndex] = entry;
        } else {
            employee.customTemplates.push(entry);
        }

        employee.auditLog.push({
            action: 'TEMPLATE_CUSTOMIZED',
            details: `Customized ${templateName} template specifically for this employee.`
        });

        await employee.save();

        res.status(200).json({
            message: `${templateName} customized successfully for ${employee.firstName}!`,
            customTemplates: employee.customTemplates
        });
    } catch (error) {
        console.error('Error updating employee template content:', error);
        res.status(500).json({ message: 'Failed to customize template for employee', error: error.message });
    }
};

exports.updateDocxWithText = updateDocxWithText;
