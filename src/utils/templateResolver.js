const TEMPLATE_PLACEHOLDERS = [
    'candidateName',
    'email',
    'mobile',
    'jobTitle',
    'client',
    'department',
    'recruiterName',
    'companyName',
    'requestId',
    'currentStatus',
    'interviewDate',
    'interviewLink',
    'customNote'
];

const PLACEHOLDER_REGEX = /\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g;
const HTML_TAG_REGEX = /<\/?[a-z][\s\S]*>/i;
const COMMON_PLACEHOLDER_BOUNDARY_REGEX = /\}(\s*)\{\{/g;

const normalizeTemplatePlaceholders = (template) => String(template || '').replace(
    COMMON_PLACEHOLDER_BOUNDARY_REGEX,
    '}}$1{{'
);

const getLineAndColumn = (input, index) => {
    const content = normalizeTemplatePlaceholders(input);
    const lines = content.slice(0, index).split('\n');
    return {
        line: lines.length,
        column: (lines[lines.length - 1] || '').length + 1
    };
};

const validateTemplateSyntax = (template, allowedPlaceholders = TEMPLATE_PLACEHOLDERS) => {
    const content = normalizeTemplatePlaceholders(template);

    for (let index = 0; index < content.length - 1; index += 1) {
        const currentPair = content.slice(index, index + 2);

        if (currentPair === '{{') {
            const closingIndex = content.indexOf('}}', index + 2);
            if (closingIndex === -1) {
                const { line, column } = getLineAndColumn(content, index);
                return {
                    valid: false,
                    message: `Invalid placeholder syntax at line ${line}:${column}. Expected '}}' to close '{{'.`
                };
            }

            const token = content.slice(index + 2, closingIndex).trim();
            if (!token) {
                const { line, column } = getLineAndColumn(content, index);
                return {
                    valid: false,
                    message: `Empty placeholder found at line ${line}:${column}.`
                };
            }

            if (!/^[a-zA-Z0-9_]+$/.test(token)) {
                const { line, column } = getLineAndColumn(content, index);
                return {
                    valid: false,
                    message: `Invalid placeholder '${token}' at line ${line}:${column}. Use letters, numbers, or underscores only.`
                };
            }

            if (Array.isArray(allowedPlaceholders) && allowedPlaceholders.length && !allowedPlaceholders.includes(token)) {
                const { line, column } = getLineAndColumn(content, index);
                return {
                    valid: false,
                    message: `Unknown placeholder '${token}' at line ${line}:${column}.`
                };
            }

            index = closingIndex + 1;
            continue;
        }

        if (currentPair === '}}') {
            const { line, column } = getLineAndColumn(content, index);
            return {
                valid: false,
                message: `Unexpected '}}' at line ${line}:${column}.`
            };
        }
    }

    return { valid: true };
};

function resolveTemplate(template, data) {
    return normalizeTemplatePlaceholders(template).replace(PLACEHOLDER_REGEX, (_, key) => data[key] ?? '');
}

const hasHtmlMarkup = (content) => HTML_TAG_REGEX.test(String(content || ''));

const escapeHtml = (content) => String(content || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

const formatTemplateBodyAsHtml = (content) => {
    const body = String(content || '');
    if (!body.trim()) return '';
    if (hasHtmlMarkup(body)) return body;

    return `<div style="white-space: pre-wrap; font-family: Arial, sans-serif; line-height: 1.6;">${escapeHtml(body)}</div>`;
};

const renderTemplateBody = (template, data) => formatTemplateBodyAsHtml(resolveTemplate(template, data));

module.exports = {
    HTML_TAG_REGEX,
    COMMON_PLACEHOLDER_BOUNDARY_REGEX,
    PLACEHOLDER_REGEX,
    TEMPLATE_PLACEHOLDERS,
    formatTemplateBodyAsHtml,
    hasHtmlMarkup,
    normalizeTemplatePlaceholders,
    renderTemplateBody,
    resolveTemplate,
    validateTemplateSyntax
};
