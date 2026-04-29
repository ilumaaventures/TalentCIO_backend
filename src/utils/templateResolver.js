function resolveTemplate(template, data) {
    return String(template || '').replace(/\{\{(\w+)\}\}/g, (_, key) => data[key] ?? '');
}

module.exports = { resolveTemplate };
