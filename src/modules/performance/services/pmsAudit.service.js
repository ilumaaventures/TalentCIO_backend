const AuditLog = require('../../system/auditLog.model');

/**
 * Standard audit logger for PMS operations
 * @param {Object} params
 */
const logPmsAudit = async (params = {}) => {
  try {
    const {
      companyId,
      userId,
      action,
      entityType,
      entityId,
      entityName,
      changes,
      reason,
      ipAddress,
    } = params;

    if (!companyId) return;

    await AuditLog.create({
      action: action || 'PMS_ACTION',
      module: 'PERFORMANCE',
      performedBy: userId || null,
      details: {
        entityType,
        entityId,
        entityName,
        changes,
        reason,
      },
      ipAddress: ipAddress || '',
      companyId,
    });
  } catch (err) {
    console.error('[PMS Audit Log Error]:', err.message);
  }
};

module.exports = { logPmsAudit };
