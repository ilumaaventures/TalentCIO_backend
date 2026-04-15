const Company = require('../models/Company');

/**
 * Tenant Middleware — resolves the current tenant (company) from the request.
 *
 * Resolution priority:
 *   1. x-tenant-id header (sent by frontend axios interceptor)
 *   2. ?tenant= query param
 *   3. Subdomain extracted from the Host header
 *
 * Supported environments:
 *   - localhost            → no tenant (main app)
 *   - ilumaa.localhost     → tenant: ilumaa
 *   - telentcio.vercel.app → tenant: telentcio   (full Vercel slug = tenant slug)
 *   - ilumaa.talentcio.com → tenant: ilumaa       (subdomain of main custom domain)
 *   - talentcio.com        → no tenant (main marketing site)
 *   - talentcio.onrender.com → no tenant (backend itself)
 */

// Hostnames that are infrastructure — NOT tenant subdomains
const NON_TENANT_HOSTS = new Set([
    'www',
    'api',
    'talentcio-be',  // backend Render service prefix
    'talentcio',     // backend Render / Vercel main project name (not a tenant)
]);

// Root domains we own — subdomains of these ARE tenant slugs
const OWN_ROOT_DOMAINS = ['talentcio.com', 'telentcio.com'];

const tenantMiddleware = async (req, res, next) => {
    try {
        let subdomain = '';

        // ── Step 1: Explicit header / query override (highest priority) ──
        const tenantHeader = req.headers['x-tenant-id'];
        const tenantQuery = req.query.tenant;
        if (tenantHeader || tenantQuery) {
            subdomain = (tenantHeader || tenantQuery).toLowerCase().trim();
        }

        // ── Step 2: Extract from Host header (if no explicit override) ──
        if (!subdomain) {
            const rawHost = req.headers['x-forwarded-host'] || req.headers.host || '';
            const host = rawHost.split(':')[0].toLowerCase(); // strip port
            const parts = host.split('.');

            if (host === 'localhost' || host === '') {
                // Plain localhost — no tenant
            } else if (host.endsWith('localhost')) {
                // e.g. ilumaa.localhost
                if (parts.length > 1 && parts[0] !== 'localhost') {
                    subdomain = parts[0];
                }
            } else if (host.endsWith('vercel.app')) {
                // e.g. telentcio.vercel.app → 'telentcio'
                // e.g. telentcio-demo.vercel.app → 'telentcio-demo'
                subdomain = host.replace(/\.vercel\.app$/, '');
            } else if (host.endsWith('onrender.com')) {
                // Backend service — no tenant extraction from host
                // (tenant comes from x-tenant-id header instead)
            } else {
                // Custom domain: could be ilumaa.talentcio.com or talentcio.com
                const isOwnRoot = OWN_ROOT_DOMAINS.some(root => host === root);
                const isOwnSubdomain = OWN_ROOT_DOMAINS.some(root => host.endsWith('.' + root));

                if (isOwnSubdomain) {
                    // e.g. ilumaa.talentcio.com → parts[0] = 'ilumaa'
                    subdomain = parts[0];
                } else if (!isOwnRoot && parts.length > 2) {
                    // Unknown custom domain with subdomain → use parts[0]
                    subdomain = parts[0];
                }
                // If isOwnRoot (talentcio.com itself) → no subdomain
            }
        }

        // ── Step 3: Skip if no subdomain or it's an infra name ──
        if (!subdomain || NON_TENANT_HOSTS.has(subdomain)) {
            return next();
        }

        // ── Step 4: Resolve to Company ──
        const company = await Company.findOne({ subdomain });

        if (!company) {
            console.warn(`[TENANT] Workspace '${subdomain}' not found.`);
            return res.status(404).json({ message: `Workspace '${subdomain}' not found.` });
        }

        if (company.status === 'Suspended') {
            return res.status(403).json({ message: 'This workspace is suspended. Please contact support.' });
        }

        // Attach to request for downstream use
        req.company = company;
        req.companyId = company._id;

        next();
    } catch (err) {
        console.error('Tenant Middleware Error:', err);
        res.status(500).json({ message: 'Error resolving tenant identity' });
    }
};

module.exports = tenantMiddleware;
