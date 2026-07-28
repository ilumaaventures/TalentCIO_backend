const nodemailer = require('nodemailer');
const axios = require('axios');
const Company = require('../models/Company');

const DEFAULT_LOGO_LINK = 'https://talentcio.in';
const DEFAULT_BRAND_COLOR = '#6366f1';
const DEFAULT_LOGO_WIDTH = 200;
const DEFAULT_LOGO_HEIGHT = 44;
const DEFAULT_LOGO_ALIGNMENT = 'center';

/**
 * Configure the transporter using Brevo SMTP.
 */
const getTransporter = () => {
    const host = process.env.EMAIL_HOST || 'smtp-relay.brevo.com';
    const port = parseInt(process.env.EMAIL_PORT) || 587;

    return nodemailer.createTransport({
        host,
        port,
        secure: port === 465,
        auth: {
            user: process.env.EMAIL_USER,
            pass: process.env.EMAIL_PASS || process.env.BREVO_API_KEY,
        },
        connectionTimeout: 10000, // 10 seconds
        greetingTimeout: 10000,
        socketTimeout: 10000
    });
};

const getEmailLogoLink = () => process.env.EMAIL_LOGO_LINK || process.env.TALENTCIO_WEBSITE_URL || DEFAULT_LOGO_LINK;

const getCompanyBranding = async (companyId) => {
    if (!companyId) {
        return {
            logoUrl: '',
            logoWidth: DEFAULT_LOGO_WIDTH,
            logoHeight: DEFAULT_LOGO_HEIGHT,
            logoAlignment: DEFAULT_LOGO_ALIGNMENT,
            brandColor: DEFAULT_BRAND_COLOR,
            footerText: '',
            replyTo: '',
            displayName: 'TalentCIO'
        };
    }

    try {
        const company = await Company.findById(companyId)
            .select('name settings.emailBranding settings.logo settings.themeColor')
            .lean();
        const branding = company?.settings?.emailBranding || {};

        return {
            logoUrl: branding.logoUrl || '',
            logoWidth: Number.isFinite(Number(branding.logoWidth)) ? Number(branding.logoWidth) : DEFAULT_LOGO_WIDTH,
            logoHeight: Number.isFinite(Number(branding.logoHeight)) ? Number(branding.logoHeight) : DEFAULT_LOGO_HEIGHT,
            logoAlignment: ['left', 'center', 'right'].includes(String(branding.logoAlignment || '').toLowerCase())
                ? String(branding.logoAlignment).toLowerCase()
                : DEFAULT_LOGO_ALIGNMENT,
            brandColor: branding.brandColor || company?.settings?.themeColor || DEFAULT_BRAND_COLOR,
            footerText: branding.footerText || '',
            replyTo: branding.replyTo || '',
            displayName: branding.displayName || company?.name || 'TalentCIO',
            logoAlt: branding.displayName || company?.name || 'TalentCIO'
        };
    } catch (error) {
        console.warn('[EMAIL] Failed to load company branding:', error.message);
        return {
            logoUrl: '',
            logoWidth: DEFAULT_LOGO_WIDTH,
            logoHeight: DEFAULT_LOGO_HEIGHT,
            logoAlignment: DEFAULT_LOGO_ALIGNMENT,
            brandColor: DEFAULT_BRAND_COLOR,
            footerText: '',
            replyTo: '',
            displayName: 'TalentCIO',
            logoAlt: 'TalentCIO'
        };
    }
};

const wrapEmailHtmlWithBranding = (html, branding = {}) => {
    const content = String(html || '').trim();
    if (!content) return html;

    const logoUrl = String(branding.logoUrl || '').trim();
    const logoLink = branding.logoLink || getEmailLogoLink();
    const logoAlt = branding.logoAlt || 'TalentCIO';
    const brandColor = branding.brandColor || DEFAULT_BRAND_COLOR;
    const footerText = branding.footerText || '';
    const logoWidth = Number.isFinite(Number(branding.logoWidth)) ? Number(branding.logoWidth) : DEFAULT_LOGO_WIDTH;
    const logoHeight = Number.isFinite(Number(branding.logoHeight)) ? Number(branding.logoHeight) : DEFAULT_LOGO_HEIGHT;
    const logoAlignment = ['left', 'center', 'right'].includes(String(branding.logoAlignment || '').toLowerCase())
        ? String(branding.logoAlignment).toLowerCase()
        : DEFAULT_LOGO_ALIGNMENT;

    return `
        <div style="background:#f8fafc;padding:24px 12px;font-family:Arial,sans-serif;">
            <div style="max-width:640px;margin:0 auto;">
                <div style="background:${brandColor};padding:16px 24px;border-radius:8px 8px 0 0;text-align:${logoAlignment};">
                    ${logoUrl
            ? `<a href="${logoLink}" style="display:inline-block;"><img src="${logoUrl}" alt="${logoAlt}" style="width:${logoWidth}px;height:${logoHeight}px;max-width:100%;object-fit:contain;display:block;margin:0 auto;" /></a>`
            : ''
        }
                </div>
                <div style="background:#ffffff;padding:32px 24px;border:1px solid #e2e8f0;border-top:none;">
                    ${content}
                </div>
                ${footerText
            ? `<div style="padding:16px 24px;text-align:center;font-size:12px;color:#94a3b8;">${footerText}</div>`
            : ''}
            </div>
        </div>
    `;
};

/**
 * Generic function to send an email (Supports Brevo API and SMTP)
 */
const sendEmail = async ({
    companyId,
    to,
    subject,
    html,
    text,
    attachments = [],
    brandEmail = true,
    logoUrl,
    logoWidth,
    logoHeight,
    logoAlignment,
    logoLink,
    logoAlt,
    displayName,
    brandColor,
    footerText,
    cc,
    bcc,
    replyTo
}) => {
    const apiKey = process.env.BREVO_API_KEY || process.env.EMAIL_PASS;
    const fromEmail = process.env.EMAIL_FROM || 'no-reply@talentcio.in';
    let branding = {};

    if (companyId && brandEmail) {
        const companyBranding = await getCompanyBranding(companyId);
        branding = {
            ...companyBranding,
            logoLink: getEmailLogoLink()
        };
    }

    if (logoUrl !== undefined) branding.logoUrl = logoUrl;
    if (logoWidth !== undefined) branding.logoWidth = logoWidth;
    if (logoHeight !== undefined) branding.logoHeight = logoHeight;
    if (logoAlignment !== undefined) branding.logoAlignment = logoAlignment;
    if (logoLink !== undefined) branding.logoLink = logoLink;
    if (logoAlt !== undefined) branding.logoAlt = logoAlt;
    if (displayName !== undefined) branding.displayName = displayName;
    if (brandColor !== undefined) branding.brandColor = brandColor;
    if (footerText !== undefined) branding.footerText = footerText;
    if (replyTo !== undefined) branding.replyTo = replyTo;

    const brandedHtml = brandEmail ? wrapEmailHtmlWithBranding(html, branding) : html;
    const resolvedReplyTo = branding.replyTo || replyTo || undefined;
    const senderName = branding.displayName || 'TalentCIO';

    // 1. Try Brevo HTTP API first (Most reliable for production/Render)
    if (apiKey && apiKey.startsWith('xkeysib-')) {
        try {
            console.log(`[EMAIL] Attempting to send via Brevo API: ${to}`);

            // Format attachments for Brevo API if they exist
            const brevoAttachments = attachments.map(att => ({
                name: att.filename || att.name,
                content: att.content ? att.content.toString('base64') : undefined,
                url: att.path && att.path.startsWith('http') ? att.path : undefined
            })).filter(att => att.content || att.url);

            const parseEmailListForBrevo = (emails) => {
                if (!emails) return undefined;
                if (Array.isArray(emails)) {
                    return emails
                        .flatMap(e => (typeof e === 'string' ? e.split(/[,;\s]+/) : [(e && (e.email || e.value)) || '']))
                        .map(e => (typeof e === 'string' ? e.trim() : ''))
                        .filter(e => e && e.includes('@'))
                        .map(email => ({ email }));
                }
                if (typeof emails === 'string') {
                    return emails
                        .split(/[,;\s]+/)
                        .map(e => e.trim())
                        .filter(e => e && e.includes('@'))
                        .map(email => ({ email }));
                }
                return undefined;
            };

            const payload = {
                sender: { name: senderName, email: fromEmail },
                to: Array.isArray(to) ? to.map(e => typeof e === 'object' ? e : { email: e }) : [{ email: to }],
                subject: subject,
                htmlContent: brandedHtml,
                textContent: text
            };

            const parsedCc = parseEmailListForBrevo(cc);
            if (parsedCc && parsedCc.length > 0) {
                payload.cc = parsedCc;
            }

            const parsedBcc = parseEmailListForBrevo(bcc);
            if (parsedBcc && parsedBcc.length > 0) {
                payload.bcc = parsedBcc;
            }

            if (resolvedReplyTo) {
                payload.replyTo = { email: resolvedReplyTo };
            }

            if (brevoAttachments.length > 0) {
                payload.attachment = brevoAttachments;
            }

            const response = await axios.post('https://api.brevo.com/v3/smtp/email', payload, {
                headers: {
                    'api-key': apiKey,
                    'Content-Type': 'application/json'
                }
            });
            console.log(`[EMAIL] API Success: ${response.data.messageId}`);
            return true;
        } catch (apiError) {
            console.error('[EMAIL] Brevo API Failed, trying SMTP fallback:', apiError.response?.data || apiError.message);
            // Fall through to SMTP
        }
    }

    // 2. Fallback to Nodemailer SMTP
    if (!process.env.EMAIL_USER || !apiKey) {
        console.error('Email credentials missing. Skipping email send.');
        return false;
    }

    try {
        const transporter = getTransporter();
        const mailOptions = {
            from: `"${senderName.replace(/"/g, '\\"')}" <${fromEmail}>`,
            to,
            subject,
            html: brandedHtml,
            text
        };

        if (cc) {
            mailOptions.cc = cc;
        }

        if (bcc) {
            mailOptions.bcc = bcc;
        }

        if (resolvedReplyTo) {
            mailOptions.replyTo = resolvedReplyTo;
        }

        if (attachments && attachments.length > 0) {
            mailOptions.attachments = attachments;
        }

        const info = await transporter.sendMail(mailOptions);
        console.log(`[EMAIL] SMTP Success: ${info.messageId}`);
        return true;
    } catch (error) {
        console.error('[EMAIL] SMTP Failed:', error.message);
        return false;
    }
};

/**
 * Specific function for OTP emails
 */
const sendOTPEmail = async (to, otp, firstName, branding = {}) => {
    const html = `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: auto; padding: 20px; border: 1px solid #e0e0e0; border-radius: 10px;">
            <h2 style="color: #4a90e2; text-align: center;">Welcome to TalentCIO!</h2>
            <p>Hello ${firstName},</p>
            <p>To ensure the security of your account, we require a mandatory password reset for your first login.</p>
            <p>Please use the following One-Time Password (OTP) to verify your identity and set your new password:</p>
            <div style="text-align: center; margin: 30px 0;">
                <span style="font-size: 32px; font-weight: bold; letter-spacing: 5px; color: #333; background: #f4f4f4; padding: 10px 20px; border-radius: 5px; border: 1px solid #ccc;">${otp}</span>
            </div>
            <p style="color: #666; font-size: 14px;">This OTP is valid for 10 minutes. If you did not expect this email, please ignore it.</p>
            <hr style="border: none; border-top: 1px solid #eee; margin: 20px 0;">
            <p style="text-align: center; color: #999; font-size: 12px;">© 2026 TalentCIO. All rights reserved.</p>
        </div>
    `;

    return await sendEmail({
        to,
        subject: 'Your Password Reset OTP - TalentCIO',
        html,
        ...branding
    });
};

module.exports = {
    sendEmail,
    sendOTPEmail,
    wrapEmailHtmlWithBranding,
    getCompanyBranding
};
