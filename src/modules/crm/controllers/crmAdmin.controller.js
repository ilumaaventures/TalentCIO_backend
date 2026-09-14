const User = require('../../user/user.model');
const AuditLog = require('../../system/auditLog.model');
const CrmCustomField = require('../models/crmCustomField.model');
const CrmTerritory = require('../models/crmTerritory.model');
const Company = require('../../company/company.model');

const getTenantId = (req) => req.companyId || req.user?.companyId;

// @desc Get organization/company settings & profile
// @route GET /api/crm/admin/settings
const getSettings = async (req, res, next) => {
  try {
    const companyId = getTenantId(req);
    const comp = await Company.findById(companyId);
    res.json({ success: true, data: comp });
  } catch (error) {
    next(error);
  }
};

// @desc Update company CRM settings
// @route PUT /api/crm/admin/settings
const updateSettings = async (req, res, next) => {
  try {
    const companyId = getTenantId(req);
    const comp = await Company.findByIdAndUpdate(companyId, req.body, { new: true });
    res.json({ success: true, message: 'Settings updated successfully', data: comp });
  } catch (error) {
    next(error);
  }
};

// @desc Get sales team users in company
// @route GET /api/crm/admin/users
const getUsers = async (req, res, next) => {
  try {
    const companyId = getTenantId(req);
    const users = await User.find({ companyId })
      .select('firstName lastName email profilePicture roles department workLocation employmentType isActive createdAt')
      .populate('roles', 'name');

    const formatted = users.map(u => ({
      _id: u._id,
      name: `${u.firstName || ''} ${u.lastName || ''}`.trim() || u.email,
      firstName: u.firstName,
      lastName: u.lastName,
      email: u.email,
      avatar: u.profilePicture,
      profilePicture: u.profilePicture,
      department: u.department,
      role: u.roles?.[0]?.name || 'Member',
      status: u.isActive ? 'active' : 'inactive',
    }));

    res.json({ success: true, data: formatted });
  } catch (error) {
    next(error);
  }
};

// @desc Get territories
// @route GET /api/crm/admin/territories
const getTerritories = async (req, res, next) => {
  try {
    const companyId = getTenantId(req);
    const territories = await CrmTerritory.find({ companyId });
    res.json({ success: true, data: territories });
  } catch (error) {
    next(error);
  }
};

// @desc Create territory
// @route POST /api/crm/admin/territories
const createTerritory = async (req, res, next) => {
  try {
    const companyId = getTenantId(req);
    const territory = await CrmTerritory.create({
      ...req.body,
      companyId,
    });
    res.status(201).json({ success: true, message: 'Territory created', data: territory });
  } catch (error) {
    next(error);
  }
};

// @desc Delete territory
// @route DELETE /api/crm/admin/territories/:id
const deleteTerritory = async (req, res, next) => {
  try {
    const companyId = getTenantId(req);
    await CrmTerritory.findOneAndDelete({ _id: req.params.id, companyId });
    res.json({ success: true, message: 'Territory deleted' });
  } catch (error) {
    next(error);
  }
};

// @desc Get CRM audit logs
// @route GET /api/crm/admin/audit-logs
const getAuditLogs = async (req, res, next) => {
  try {
    const companyId = getTenantId(req);
    const { page = 1, limit = 25 } = req.query;
    const pageNum = Math.max(1, Number(page) || 1);
    const limitNum = Math.max(1, Number(limit) || 25);
    const query = { companyId, module: 'CRM' };

    const total = await AuditLog.countDocuments(query);
    const logs = await AuditLog.find(query)
      .populate('performedBy', 'firstName lastName email profilePicture')
      .sort({ createdAt: -1 })
      .skip((pageNum - 1) * limitNum)
      .limit(limitNum);

    const formatted = logs.map(l => ({
      _id: l._id,
      userName: l.performedBy ? `${l.performedBy.firstName || ''} ${l.performedBy.lastName || ''}`.trim() : 'System',
      userEmail: l.performedBy?.email || '',
      action: l.action,
      entityType: l.details?.entityType || 'CRM',
      entityName: l.details?.entityName || '',
      timestamp: l.createdAt,
      ipAddress: l.ipAddress,
    }));

    res.json({
      success: true,
      data: formatted,
      pagination: {
        total,
        page: pageNum,
        limit: limitNum,
        totalPages: Math.ceil(total / limitNum) || 1,
      },
    });
  } catch (error) {
    next(error);
  }
};

// @desc Get custom fields
// @route GET /api/crm/admin/custom-fields
const getCustomFields = async (req, res, next) => {
  try {
    const companyId = getTenantId(req);
    const fields = await CrmCustomField.find({ companyId });
    res.json({ success: true, data: fields });
  } catch (error) {
    next(error);
  }
};

// @desc Create custom field
// @route POST /api/crm/admin/custom-fields
const createCustomField = async (req, res, next) => {
  try {
    const companyId = getTenantId(req);
    const field = await CrmCustomField.create({
      ...req.body,
      companyId,
    });
    res.status(201).json({ success: true, message: 'Custom field created', data: field });
  } catch (error) {
    next(error);
  }
};

module.exports = {
  getSettings,
  updateSettings,
  getUsers,
  getTerritories,
  createTerritory,
  deleteTerritory,
  getAuditLogs,
  getCustomFields,
  createCustomField,
};
