const mongoose = require('mongoose');

/**
 * Checks if user is an Administrator with global access
 */
const isAdminOrSuperAdmin = (user) => {
  if (!user) return false;

  const roles = Array.isArray(user.roles) ? user.roles : [];
  const hasAdminRole = roles.some((r) => {
    const roleName = typeof r === 'string' ? r : r?.name;
    return ['Admin', 'Super Admin', 'System Admin'].includes(roleName) || r?.isSystem;
  });

  if (hasAdminRole) return true;

  const perms = Array.isArray(user.permissions) ? user.permissions : [];
  return (
    perms.includes('*') ||
    perms.includes('all') ||
    perms.includes('admin')
  );
};

/**
 * Checks if user has permission to view all organization leads
 */
const canViewAllLeads = (user) => {
  if (isAdminOrSuperAdmin(user)) return true;
  const perms = Array.isArray(user?.permissions) ? user.permissions : [];
  return perms.includes('crm.leads.read_all');
};

/**
 * Checks if user has permission to view all imported database records
 */
const canViewAllImportData = (user) => {
  if (isAdminOrSuperAdmin(user)) return true;
  const perms = Array.isArray(user?.permissions) ? user.permissions : [];
  return perms.includes('crm.data.view_all');
};

/**
 * Builds ownership filter for Leads query when user does not have view_all permission
 */
const getLeadOwnerFilter = (user) => {
  if (!user || !user._id) return { _id: null }; // block if no user
  const uid = user._id;

  return {
    $or: [
      { ownerId: uid },
      { assignedTo: uid },
      { createdBy: uid },
    ],
  };
};

/**
 * Builds ownership filter for CrmImportData when user does not have view_all permission
 */
const getImportDataOwnerFilter = (user) => {
  if (!user || !user._id) return { _id: null };
  const uid = user._id;
  const fullName = [user.firstName, user.lastName].filter(Boolean).join(' ').trim() || user.name || '';

  const orConditions = [
    { importedByUserId: uid },
    { assignedTo: uid },
  ];

  if (fullName) {
    const escaped = fullName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    orConditions.push({ importedBy: new RegExp(`^${escaped}$`, 'i') });
  }

  return { $or: orConditions };
};

module.exports = {
  isAdminOrSuperAdmin,
  canViewAllLeads,
  canViewAllImportData,
  getLeadOwnerFilter,
  getImportDataOwnerFilter,
};
