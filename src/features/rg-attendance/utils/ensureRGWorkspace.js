const resolveTenantSlug = (req) => (
    String(
        req.company?.subdomain
        || req.headers['x-tenant-id']
        || req.query?.tenant
        || ''
    )
        .trim()
        .toLowerCase()
);

const isLocalhostRequest = (req) => {
    const rawHost = String(req.headers['x-forwarded-host'] || req.headers.host || '').toLowerCase();
    const host = rawHost.split(':')[0];

    return host === 'localhost' || host === '127.0.0.1' || host.endsWith('.localhost');
};

const ensureRGWorkspace = (req, res, next) => {
    const tenantSlug = resolveTenantSlug(req);
    const isAllowedTenant = tenantSlug === 'rg' || (isLocalhostRequest(req) && tenantSlug === 'telentcio');

    if (!isAllowedTenant) {
        return res.status(403).json({
            message: 'This feature is only available for the RG workspace.'
        });
    }

    return next();
};

module.exports = {
    ensureRGWorkspace,
    resolveTenantSlug
};
