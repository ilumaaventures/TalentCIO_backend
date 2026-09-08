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
    const isAttendanceDocsEnabled = Boolean(
        req.company?.settings?.timesheet?.requireAttachment
        || req.company?.settings?.attendance?.requireAttachment
    );

    if (!isAllowedTenant && !isAttendanceDocsEnabled) {
        return res.status(403).json({
            message: 'Attendance documents feature is not enabled for this workspace.'
        });
    }

    return next();
};

module.exports = {
    ensureRGWorkspace,
    resolveTenantSlug
};
