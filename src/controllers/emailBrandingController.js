require('../config/cloudinary');
const cloudinary = require('cloudinary').v2;
const Company = require('../models/Company');

const DEFAULT_LOGO_WIDTH = 200;
const DEFAULT_LOGO_HEIGHT = 44;
const DEFAULT_LOGO_ALIGNMENT = 'center';

const normalizeDimension = (value, fallback, min, max) => {
    const parsed = Number.parseInt(value, 10);
    if (!Number.isFinite(parsed)) {
        return fallback;
    }

    return Math.min(Math.max(parsed, min), max);
};

const normalizeAlignment = (value) => {
    const normalized = String(value || '').trim().toLowerCase();
    return ['left', 'center', 'right'].includes(normalized)
        ? normalized
        : DEFAULT_LOGO_ALIGNMENT;
};

exports.getEmailBranding = async (req, res) => {
    try {
        const company = await Company.findById(req.companyId)
            .select('name settings.emailBranding settings.logo settings.themeColor')
            .lean();

        if (!company) {
            return res.status(404).json({ message: 'Company not found.' });
        }

        const branding = company?.settings?.emailBranding || {};

        return res.json({
            displayName: branding.displayName || company.name || '',
            logoUrl: branding.logoUrl || company?.settings?.logo || '',
            logoWidth: normalizeDimension(branding.logoWidth, DEFAULT_LOGO_WIDTH, 40, 400),
            logoHeight: normalizeDimension(branding.logoHeight, DEFAULT_LOGO_HEIGHT, 20, 160),
            logoAlignment: normalizeAlignment(branding.logoAlignment),
            brandColor: branding.brandColor || company?.settings?.themeColor || '#6366f1',
            footerText: branding.footerText || '',
            replyTo: branding.replyTo || '',
            companyLogo: company?.settings?.logo || ''
        });
    } catch (error) {
        console.error('getEmailBranding error:', error);
        return res.status(500).json({
            message: 'Failed to load email branding.',
            error: error.message
        });
    }
};

exports.updateEmailBranding = async (req, res) => {
    try {
        const { displayName, brandColor, footerText, replyTo, logoWidth, logoHeight, logoAlignment } = req.body || {};
        const update = {};

        if (displayName !== undefined) {
            update['settings.emailBranding.displayName'] = String(displayName).trim();
        }
        if (brandColor !== undefined) {
            update['settings.emailBranding.brandColor'] = String(brandColor).trim();
        }
        if (footerText !== undefined) {
            update['settings.emailBranding.footerText'] = String(footerText).trim();
        }
        if (replyTo !== undefined) {
            update['settings.emailBranding.replyTo'] = String(replyTo).trim();
        }
        if (logoWidth !== undefined) {
            update['settings.emailBranding.logoWidth'] = normalizeDimension(logoWidth, DEFAULT_LOGO_WIDTH, 40, 400);
        }
        if (logoHeight !== undefined) {
            update['settings.emailBranding.logoHeight'] = normalizeDimension(logoHeight, DEFAULT_LOGO_HEIGHT, 20, 160);
        }
        if (logoAlignment !== undefined) {
            update['settings.emailBranding.logoAlignment'] = normalizeAlignment(logoAlignment);
        }

        await Company.findByIdAndUpdate(req.companyId, { $set: update });

        return res.json({ message: 'Email branding updated successfully.' });
    } catch (error) {
        console.error('updateEmailBranding error:', error);
        return res.status(500).json({
            message: 'Failed to update email branding.',
            error: error.message
        });
    }
};

exports.uploadEmailLogo = async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ message: 'No file uploaded.' });
        }

        const company = await Company.findById(req.companyId)
            .select('settings.emailBranding.logoPublicId')
            .lean();

        const oldPublicId = company?.settings?.emailBranding?.logoPublicId;
        if (oldPublicId) {
            cloudinary.uploader.destroy(oldPublicId).catch((error) => {
                console.warn('[EMAIL BRANDING] Failed to delete old logo:', error.message);
            });
        }

        const result = await new Promise((resolve, reject) => {
            const stream = cloudinary.uploader.upload_stream(
                {
                    folder: `talentcio/${req.companyId}/email-branding`,
                    resource_type: 'image',
                    allowed_formats: ['jpg', 'jpeg', 'png', 'svg', 'webp'],
                    transformation: [{ width: 400, height: 120, crop: 'fit' }]
                },
                (error, uploaded) => (error ? reject(error) : resolve(uploaded))
            );

            stream.end(req.file.buffer);
        });

        await Company.findByIdAndUpdate(req.companyId, {
            $set: {
                'settings.emailBranding.logoUrl': result.secure_url,
                'settings.emailBranding.logoPublicId': result.public_id
            }
        });

        return res.json({
            message: 'Email logo uploaded successfully.',
            logoUrl: result.secure_url,
            logoPublicId: result.public_id
        });
    } catch (error) {
        console.error('uploadEmailLogo error:', error);
        return res.status(500).json({
            message: 'Failed to upload email logo.',
            error: error.message
        });
    }
};

exports.removeEmailLogo = async (req, res) => {
    try {
        const company = await Company.findById(req.companyId)
            .select('settings.emailBranding.logoPublicId')
            .lean();

        const publicId = company?.settings?.emailBranding?.logoPublicId;
        if (publicId) {
            await cloudinary.uploader.destroy(publicId).catch((error) => {
                console.warn('[EMAIL BRANDING] Failed to delete logo:', error.message);
            });
        }

        await Company.findByIdAndUpdate(req.companyId, {
            $set: {
                'settings.emailBranding.logoUrl': '',
                'settings.emailBranding.logoPublicId': ''
            }
        });

        return res.json({ message: 'Email logo removed.' });
    } catch (error) {
        console.error('removeEmailLogo error:', error);
        return res.status(500).json({
            message: 'Failed to remove email logo.',
            error: error.message
        });
    }
};

exports.useCompanyLogo = async (req, res) => {
    try {
        const company = await Company.findById(req.companyId)
            .select('settings.logo settings.emailBranding.logoPublicId')
            .lean();

        const companyLogo = company?.settings?.logo || '';
        if (!companyLogo) {
            return res.status(400).json({ message: 'No company logo set. Upload a company logo first.' });
        }

        const oldPublicId = company?.settings?.emailBranding?.logoPublicId;
        if (oldPublicId) {
            await cloudinary.uploader.destroy(oldPublicId).catch((error) => {
                console.warn('[EMAIL BRANDING] Failed to delete replaced logo:', error.message);
            });
        }

        await Company.findByIdAndUpdate(req.companyId, {
            $set: {
                'settings.emailBranding.logoUrl': companyLogo,
                'settings.emailBranding.logoPublicId': ''
            }
        });

        return res.json({
            message: 'Company logo applied to email branding.',
            logoUrl: companyLogo
        });
    } catch (error) {
        console.error('useCompanyLogo error:', error);
        return res.status(500).json({
            message: 'Failed to apply company logo.',
            error: error.message
        });
    }
};
