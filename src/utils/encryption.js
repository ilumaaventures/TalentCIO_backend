const crypto = require('crypto');

const ALGORITHM = 'aes-256-cbc';
const IV_LENGTH = 16;
const ENCRYPTED_VALUE_PATTERN = /^[0-9a-f]{32}:[0-9a-f]+$/i;

const getKeyBuffer = () => {
    const rawKey = String(process.env.EMAIL_ENCRYPTION_KEY || '').trim();
    if (!rawKey) {
        return null;
    }

    try {
        const key = Buffer.from(rawKey, 'hex');
        return key.length === 32 ? key : null;
    } catch (error) {
        return null;
    }
};

const encrypt = (text) => {
    if (!text) return text;

    const key = getKeyBuffer();
    if (!key) {
        return text;
    }

    const iv = crypto.randomBytes(IV_LENGTH);
    const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
    const encrypted = Buffer.concat([cipher.update(String(text), 'utf8'), cipher.final()]);

    return `${iv.toString('hex')}:${encrypted.toString('hex')}`;
};

const isEncryptionConfigured = () => Boolean(getKeyBuffer());

const isEncryptedValue = (text) => {
    const value = String(text || '').trim();
    if (!value || !value.includes(':')) {
        return false;
    }

    return ENCRYPTED_VALUE_PATTERN.test(value);
};

const encryptIfNeeded = (text) => {
    if (!text) return text;
    return isEncryptedValue(text) ? text : encrypt(text);
};

const decrypt = (text) => {
    if (!text) return text;

    const key = getKeyBuffer();
    if (!key || !String(text).includes(':')) {
        return text;
    }

    try {
        const [ivHex, encryptedHex] = String(text).split(':');
        const iv = Buffer.from(ivHex, 'hex');
        const encryptedText = Buffer.from(encryptedHex, 'hex');
        const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);

        return Buffer.concat([decipher.update(encryptedText), decipher.final()]).toString('utf8');
    } catch (error) {
        return text;
    }
};

module.exports = {
    encrypt,
    decrypt,
    encryptIfNeeded,
    isEncryptedValue,
    isEncryptionConfigured
};
