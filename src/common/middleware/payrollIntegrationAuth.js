const crypto = require('crypto');
const {
    findCompanyByExternalTenantId,
    normalizePayrollIntegrationSettings
} = require('../../modules/payroll/payrollIntegration.service');

const extractBearerToken = (req) => {
    const authHeader = String(req.headers.authorization || '').trim();
    if (!authHeader.startsWith('Bearer ')) {
        return '';
    }

    return authHeader.slice(7).trim();
};

const safeTokenCompare = (providedToken, expectedToken) => {
    const provided = Buffer.from(String(providedToken || ''));
    const expected = Buffer.from(String(expectedToken || ''));

    if (provided.length === 0 || expected.length === 0 || provided.length !== expected.length) {
        return false;
    }

    return crypto.timingSafeEqual(provided, expected);
};

const protectPayrollIntegration = async (req, res, next) => {
    try {
        const externalTenantId = String(req.query.tenantId || req.body?.tenantId || '').trim();
        if (!externalTenantId) {
            return res.status(400).json({ message: 'tenantId query parameter or body field is required.' });
        }

        const token = extractBearerToken(req);
        if (!token) {
            return res.status(401).json({ message: 'Authorization bearer token is required.' });
        }

        const company = await findCompanyByExternalTenantId(externalTenantId);
        if (!company) {
            return res.status(404).json({ message: 'Payroll integration tenant was not found.' });
        }

        if (company.status === 'Suspended' || company.status === 'Inactive') {
            return res.status(403).json({ message: 'This workspace is not available for payroll sync.' });
        }

        const payrollIntegration = normalizePayrollIntegrationSettings(company);
        if (!payrollIntegration.enabled || !payrollIntegration.accessToken) {
            return res.status(403).json({ message: 'Payroll integration is not configured for this workspace.' });
        }

        if (!safeTokenCompare(token, payrollIntegration.accessToken)) {
            return res.status(401).json({ message: 'Invalid payroll integration token.' });
        }

        req.company = company;
        req.companyId = company._id;
        req.payrollIntegration = payrollIntegration;

        next();
    } catch (error) {
        console.error('[PayrollIntegrationAuth] Error:', error);
        res.status(500).json({ message: 'Unable to validate payroll integration request.' });
    }
};

module.exports = { protectPayrollIntegration };
