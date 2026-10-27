const axios = require('axios');

/**
 * Normalizes phone numbers to standard E.164 without '+' for Meta WhatsApp API.
 * Defaults 10-digit numbers to India country code (+91).
 */
const normalizePhoneNumber = (rawPhone) => {
  if (!rawPhone) return '';
  const digits = String(rawPhone).replace(/\D/g, '');
  if (!digits) return '';

  // 10 digits: standard India mobile
  if (digits.length === 10) {
    return `91${digits}`;
  }

  // 11 digits starting with 0: e.g. 09876543210 -> 919876543210
  if (digits.length === 11 && digits.startsWith('0')) {
    return `91${digits.slice(1)}`;
  }

  // Already includes country code (e.g. 917455876963 or international)
  return digits;
};

/**
 * Resolves credentials for Meta WhatsApp Cloud API.
 * Supports environment defaults with tenant-level overrides.
 */
const getWhatsAppConfig = (companySettings = {}) => {
  const apiVersion = companySettings.apiVersion || process.env.META_WHATSAPP_API_VERSION || 'v25.0';
  const phoneNumberId = companySettings.phoneNumberId || process.env.META_WHATSAPP_PHONE_NUMBER_ID || '1328393653698161';
  const accessToken = companySettings.accessToken || process.env.META_WHATSAPP_ACCESS_TOKEN || '';

  return {
    apiVersion,
    phoneNumberId,
    accessToken,
  };
};

/**
 * Parses Meta Graph API error objects into clear, informative messages.
 */
const parseMetaError = (error) => {
  const metaError = error?.response?.data?.error;
  if (!metaError) {
    return error.message || 'Unknown WhatsApp API error occurred';
  }

  const code = metaError.code;
  const subcode = metaError.error_subcode;
  const details = metaError.error_data?.details;
  const mainMsg = metaError.message || 'Meta WhatsApp API request failed';

  if (code === 190) {
    return 'Meta WhatsApp Access Token has expired or is invalid. Please update the Meta Token in Settings.';
  }

  if (code === 131030) {
    return `Recipient number is not in the Meta Developer sandbox test list. Add this phone number to the allowed recipients in the Meta Developer Console (Error 131030).`;
  }

  if (code === 132000) {
    return `The requested template does not exist or has not been approved by Meta yet.`;
  }

  if (code === 131047) {
    return 'Message failed: 24-hour customer service window is closed. Business must initiate conversation using an approved WhatsApp template.';
  }

  if (details) {
    return `${mainMsg} (${details})`;
  }

  return `${mainMsg} (Meta Code: ${code}${subcode ? `:${subcode}` : ''})`;
};

/**
 * Sends a WhatsApp message via Meta Cloud API.
 * Supports:
 *  - Template messages (required for business-initiated cold outreach)
 *  - Free-form text messages (allowed during active 24-hour conversation window)
 */
const sendWhatsAppCloudMessage = async ({
  to,
  type = 'template',
  templateName = 'hello_world',
  languageCode = 'en_US',
  components = [],
  templateParams = [],
  text = '',
  message = '',
  companySettings = {},
}) => {
  const config = getWhatsAppConfig(companySettings);

  if (!config.accessToken) {
    throw new Error('Meta WhatsApp Access Token is not configured in the system environment.');
  }

  if (!config.phoneNumberId) {
    throw new Error('Meta WhatsApp Phone Number ID is not configured.');
  }

  const normalizedTo = normalizePhoneNumber(to);
  if (!normalizedTo) {
    throw new Error('Recipient phone number is invalid or empty.');
  }

  const url = `https://graph.facebook.com/${config.apiVersion}/${config.phoneNumberId}/messages`;

  let payload;
  const resolvedText = text || message;

  if (type === 'text' && resolvedText) {
    payload = {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: normalizedTo,
      type: 'text',
      text: {
        preview_url: false,
        body: resolvedText,
      },
    };
  } else {
    // Default to template message
    payload = {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: normalizedTo,
      type: 'template',
      template: {
        name: templateName || 'hello_world',
        language: {
          code: languageCode || 'en_US',
        },
      },
    };

    if (Array.isArray(components) && components.length > 0) {
      payload.template.components = components;
    } else if (Array.isArray(templateParams) && templateParams.length > 0) {
      payload.template.components = [
        {
          type: 'body',
          parameters: templateParams.map((param) => ({
            type: 'text',
            text: String(param ?? ''),
          })),
        },
      ];
    }
  }

  try {
    const response = await axios.post(url, payload, {
      headers: {
        Authorization: `Bearer ${config.accessToken}`,
        'Content-Type': 'application/json',
      },
      timeout: 15000,
    });

    const responseData = response.data;
    const messageId = responseData?.messages?.[0]?.id || '';
    const messageStatus = responseData?.messages?.[0]?.message_status || 'accepted';

    return {
      success: true,
      messageId,
      messageStatus,
      normalizedPhone: normalizedTo,
      type: payload.type,
      templateName: payload.template?.name || null,
      raw: responseData,
    };
  } catch (error) {
    const friendlyError = parseMetaError(error);
    const err = new Error(friendlyError);
    err.originalError = error.response?.data || error.message;
    err.statusCode = error.response?.status || 500;
    err.metaCode = error.response?.data?.error?.code;
    throw err;
  }
};

/**
 * Returns the configured webhook verification token.
 */
const getWebhookVerifyToken = () => {
  return process.env.META_WHATSAPP_WEBHOOK_VERIFY_TOKEN || 'talentcio_crm_whatsapp_token_2026';
};

module.exports = {
  normalizePhoneNumber,
  getWhatsAppConfig,
  sendWhatsAppCloudMessage,
  parseMetaError,
  getWebhookVerifyToken,
};

