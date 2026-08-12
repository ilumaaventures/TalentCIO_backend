const crypto = require('crypto');

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;
const SALT_LENGTH = 16;
const KEY_LENGTH = 32;
const AUTH_TAG_LENGTH = 16;
const PBKDF2_ITERATIONS = 100000;
const PBKDF2_DIGEST = 'sha256';

const assertSecret = (secret) => {
    const normalizedSecret = String(secret || '').trim();
    if (!normalizedSecret) {
        throw new Error('A payroll integration secret is required.');
    }

    return normalizedSecret;
};

const deriveKey = (secret, salt) => crypto.pbkdf2Sync(
    assertSecret(secret),
    salt,
    PBKDF2_ITERATIONS,
    KEY_LENGTH,
    PBKDF2_DIGEST
);

const encryptPayload = (payload, secret) => {
    const salt = crypto.randomBytes(SALT_LENGTH);
    const iv = crypto.randomBytes(IV_LENGTH);
    const key = deriveKey(secret, salt);
    const cipher = crypto.createCipheriv(ALGORITHM, key, iv, { authTagLength: AUTH_TAG_LENGTH });
    const serializedPayload = JSON.stringify(payload);
    const encrypted = Buffer.concat([
        cipher.update(serializedPayload, 'utf8'),
        cipher.final()
    ]);
    const authTag = cipher.getAuthTag();

    return {
        data: encrypted.toString('base64'),
        iv: iv.toString('base64'),
        salt: salt.toString('base64'),
        authTag: authTag.toString('base64')
    };
};

const decryptPayload = (payload, secret) => {
    if (!payload || typeof payload !== 'object') {
        throw new Error('A valid encrypted payload package is required.');
    }

    const salt = Buffer.from(String(payload.salt || ''), 'base64');
    const iv = Buffer.from(String(payload.iv || ''), 'base64');
    const authTag = Buffer.from(String(payload.authTag || ''), 'base64');
    const encrypted = Buffer.from(String(payload.data || ''), 'base64');
    const key = deriveKey(secret, salt);
    const decipher = crypto.createDecipheriv(ALGORITHM, key, iv, { authTagLength: AUTH_TAG_LENGTH });
    decipher.setAuthTag(authTag);
    const decrypted = Buffer.concat([
        decipher.update(encrypted),
        decipher.final()
    ]).toString('utf8');

    return JSON.parse(decrypted);
};

const signWebhookPayload = (payload, secret) => crypto
    .createHmac('sha256', assertSecret(secret))
    .update(JSON.stringify(payload))
    .digest('hex');

module.exports = {
    encryptPayload,
    decryptPayload,
    signWebhookPayload,
    deriveKey,
    PBKDF2_ITERATIONS,
    PBKDF2_DIGEST
};
