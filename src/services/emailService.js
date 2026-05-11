const nodemailer = require('nodemailer');
const axios = require('axios');

const DEFAULT_LOGO_URL = 'https://talentcio.in/navbar-logo.png';
const DEFAULT_LOGO_LINK = 'https://talentcio.in';

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

const getEmailLogoUrl = () => process.env.EMAIL_LOGO_URL || process.env.TALENTCIO_LOGO_URL || DEFAULT_LOGO_URL;
const getEmailLogoLink = () => process.env.EMAIL_LOGO_LINK || process.env.TALENTCIO_WEBSITE_URL || DEFAULT_LOGO_LINK;

const wrapEmailHtmlWithBranding = (html, branding = {}) => {
    const content = String(html || '').trim();
    if (!content) return html;

    const logoUrl = branding.logoUrl || getEmailLogoUrl();
    const logoLink = branding.logoLink || getEmailLogoLink();
    const logoAlt = branding.logoAlt || 'TalentCIO';

    return `
        <div style="background: #f8fafc; padding: 24px 12px;">
            <div style="max-width: 680px; margin: 0 auto;">
                <div style="text-align: center; margin-bottom: 20px;">
                    <a href="${logoLink}" target="_blank" rel="noopener noreferrer" style="display: inline-block; text-decoration: none;">
                        <img
                            src="${logoUrl}"
                            alt="${logoAlt}"
                            style="display: inline-block; max-width: 200px; width: auto; height: 48px; object-fit: contain; border: 0; outline: none; text-decoration: none;"
                        />
                    </a>
                </div>
                ${content}
            </div>
        </div>
    `;
};

/**
 * Generic function to send an email (Supports Brevo API and SMTP)
 */
const sendEmail = async ({
    to,
    subject,
    html,
    text,
    attachments = [],
    brandEmail = true,
    logoUrl,
    logoLink,
    logoAlt
}) => {
    const apiKey = process.env.BREVO_API_KEY || process.env.EMAIL_PASS;
    const fromEmail = process.env.EMAIL_FROM || 'no-reply@talentcio.in';
    const brandedHtml = brandEmail ? wrapEmailHtmlWithBranding(html, { logoUrl, logoLink, logoAlt }) : html;

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

            const payload = {
                sender: { name: 'TalentCIO', email: fromEmail },
                to: [{ email: to }],
                subject: subject,
                htmlContent: brandedHtml,
                textContent: text
            };

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
            from: `"TalentCIO" <${fromEmail}>`,
            to,
            subject,
            html: brandedHtml,
            text
        };

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
    sendOTPEmail
};
