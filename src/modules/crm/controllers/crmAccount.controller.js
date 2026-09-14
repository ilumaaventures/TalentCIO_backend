const CrmAccount = require('../models/crmAccount.model');
const CrmContact = require('../models/crmContact.model');
const CrmDeal = require('../models/crmDeal.model');
const CrmActivity = require('../models/crmActivity.model');
const CrmLead = require('../models/crmLead.model');
const { logCrmAudit } = require('../utils/crmAudit');

const getTenantId = (req) => req.companyId || req.user?.companyId;

const getUserDisplayName = (user) => {
  if (!user) return 'System';
  if (user.firstName) return `${user.firstName} ${user.lastName || ''}`.trim();
  return user.name || user.email || 'User';
};

// @desc Get accounts / companies with filters
// @route GET /api/crm/companies or /api/crm/accounts
const getAccounts = async (req, res, next) => {
  try {
    const companyId = getTenantId(req);
    const { search, industry, healthScore, page = 1, limit = 25 } = req.query;
    const query = { companyId };

    if (industry && industry !== 'all') query.industry = industry;
    if (healthScore && healthScore !== 'all') query.healthScore = healthScore;

    if (search) {
      query.name = new RegExp(search, 'i');
    }

    const total = await CrmAccount.countDocuments(query);
    const accounts = await CrmAccount.find(query)
      .populate('ownerId', 'firstName lastName email profilePicture')
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(Number(limit));

    res.json({
      success: true,
      data: accounts,
      pagination: {
        total,
        page: Number(page),
        limit: Number(limit),
        totalPages: Math.ceil(total / limit),
      },
    });
  } catch (error) {
    next(error);
  }
};

// @desc Get single account with 360-degree relationship view
// @route GET /api/crm/companies/:id or /api/crm/accounts/:id
const getAccountById = async (req, res, next) => {
  try {
    const companyId = getTenantId(req);
    const account = await CrmAccount.findOne({ _id: req.params.id, companyId })
      .populate('ownerId', 'firstName lastName email profilePicture');

    if (!account) {
      return res.status(404).json({ success: false, message: 'Account not found' });
    }

    const contacts = await CrmContact.find({ accountId: account._id, companyId });
    const deals = await CrmDeal.find({ accountId: account._id, companyId });
    const leads = await CrmLead.find({ companyName: new RegExp(`^${account.name}$`, 'i'), companyId });
    const activities = await CrmActivity.find({ accountId: account._id, companyId }).sort({ performedAt: -1 });

    res.json({
      success: true,
      data: {
        company: account, // alias for frontend backwards compatibility
        account,
        contacts,
        deals,
        leads,
        activities,
      },
    });
  } catch (error) {
    next(error);
  }
};

// @desc Create account / company
// @route POST /api/crm/companies or /api/crm/accounts
const createAccount = async (req, res, next) => {
  try {
    const companyId = getTenantId(req);
    const accountData = {
      ...req.body,
      companyId,
      ownerId: req.body.ownerId || req.user?._id,
    };

    const account = await CrmAccount.create(accountData);

    await logCrmAudit({
      companyId,
      userId: req.user?._id,
      action: 'CREATE_ACCOUNT',
      entityType: 'Account',
      entityId: account._id,
      entityName: account.name,
      ipAddress: req.ip,
    });

    res.status(201).json({
      success: true,
      message: 'Account created successfully',
      data: account,
    });
  } catch (error) {
    next(error);
  }
};

// @desc Update account
// @route PUT /api/crm/companies/:id or /api/crm/accounts/:id
const updateAccount = async (req, res, next) => {
  try {
    const companyId = getTenantId(req);
    const updates = { ...req.body, lastActivityAt: new Date() };

    const account = await CrmAccount.findOneAndUpdate(
      { _id: req.params.id, companyId },
      updates,
      { new: true, runValidators: true }
    ).populate('ownerId', 'firstName lastName email profilePicture');

    if (!account) {
      return res.status(404).json({ success: false, message: 'Account not found' });
    }

    await logCrmAudit({
      companyId,
      userId: req.user?._id,
      action: 'UPDATE_ACCOUNT',
      entityType: 'Account',
      entityId: account._id,
      entityName: account.name,
      changes: updates,
      ipAddress: req.ip,
    });

    res.json({
      success: true,
      message: 'Account updated successfully',
      data: account,
    });
  } catch (error) {
    next(error);
  }
};

// @desc Delete account
// @route DELETE /api/crm/companies/:id or /api/crm/accounts/:id
const deleteAccount = async (req, res, next) => {
  try {
    const companyId = getTenantId(req);
    const account = await CrmAccount.findOneAndDelete({ _id: req.params.id, companyId });
    if (!account) {
      return res.status(404).json({ success: false, message: 'Account not found' });
    }

    await logCrmAudit({
      companyId,
      userId: req.user?._id,
      action: 'DELETE_ACCOUNT',
      entityType: 'Account',
      entityId: account._id,
      entityName: account.name,
      ipAddress: req.ip,
    });

    res.json({ success: true, message: 'Account deleted successfully' });
  } catch (error) {
    next(error);
  }
};

module.exports = {
  getAccounts,
  getAccountById,
  createAccount,
  updateAccount,
  deleteAccount,
  // Aliases for compatibility
  getCompanies: getAccounts,
  getCompanyById: getAccountById,
  createCompany: createAccount,
  updateCompany: updateAccount,
  deleteCompany: deleteAccount,
};
