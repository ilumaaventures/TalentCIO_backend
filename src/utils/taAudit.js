const mongoose = require('mongoose');
const { HRRAuditLog } = require('../models/HiringRequest');

const createCorrelationId = () => new mongoose.Types.ObjectId().toString();

const buildAuditMeta = (req, overrides = {}) => ({
    companyId: overrides.companyId || req.companyId,
    performedBy: overrides.performedBy || req.user?._id,
    ipAddress: overrides.ipAddress || req.ip || req.headers['x-forwarded-for'] || '',
    correlationId: overrides.correlationId || req.headers['x-correlation-id'] || createCorrelationId()
});

const logTAAuditEvent = async ({
    hiringRequestId = null,
    companyId,
    action,
    performedBy,
    details = {},
    resourceType = 'HiringRequest',
    resourceId = null,
    candidateId = null,
    permissionKey = '',
    scope = 'tenant',
    before = null,
    after = null,
    ipAddress = '',
    correlationId = '',
    delegation = null
}) => (
    HRRAuditLog.create({
        hiringRequestId,
        companyId,
        action,
        performedBy,
        details,
        resourceType,
        resourceId: resourceId || hiringRequestId || candidateId || null,
        candidateId: candidateId || null,
        permissionKey,
        scope,
        before,
        after,
        ipAddress,
        correlationId,
        delegation: delegation || null
    })
);

module.exports = {
    buildAuditMeta,
    logTAAuditEvent
};
