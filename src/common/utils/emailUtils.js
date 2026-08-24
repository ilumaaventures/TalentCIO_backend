/**
 * Shared email utility functions used by both emailService and companyEmailService.
 * Extracted to avoid duplication (previously defined identically in both).
 */

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

const mapBrevoAttachments = (attachments = []) => (
    attachments.map((attachment) => {
        let contentBase64 = undefined;
        if (attachment.content) {
            contentBase64 = Buffer.isBuffer(attachment.content)
                ? attachment.content.toString('base64')
                : String(attachment.content);
        }
        const url = (typeof attachment.path === 'string' && attachment.path.startsWith('http'))
            ? attachment.path
            : (typeof attachment.url === 'string' && attachment.url.startsWith('http') ? attachment.url : undefined);

        return {
            name: attachment.filename || attachment.name,
            content: contentBase64,
            url
        };
    }).filter((attachment) => attachment.name && (attachment.content || attachment.url))
);

module.exports = {
    parseEmailListForBrevo,
    mapBrevoAttachments
};
