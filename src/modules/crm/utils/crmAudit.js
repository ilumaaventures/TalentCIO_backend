const AuditLog = require('../../system/auditLog.model');

const logCrmAudit = async (params = {}) => {
  try {
    const {
      companyId,
      userId,
      action,
      entityType,
      entityId,
      entityName,
      changes,
      ipAddress,
    } = params;

    if (!companyId) return;

    await AuditLog.create({
      action: action || 'CRM_ACTION',
      module: 'CRM',
      performedBy: userId || null,
      details: {
        entityType,
        entityId,
        entityName,
        changes,
      },
      ipAddress: ipAddress || '',
      companyId,
    });
  } catch (err) {
    console.error('[CRM Audit Log Error]:', err.message);
  }
};

module.exports = { logCrmAudit };
