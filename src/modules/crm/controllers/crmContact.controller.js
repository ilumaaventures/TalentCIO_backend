const CrmContact = require('../models/crmContact.model');
const CrmAccount = require('../models/crmAccount.model');
const CrmDeal = require('../models/crmDeal.model');
const CrmActivity = require('../models/crmActivity.model');
const CrmTask = require('../models/crmTask.model');
const { logCrmAudit } = require('../utils/crmAudit');

const getTenantId = (req) => req.companyId || req.user?.companyId;

const getUserDisplayName = (user) => {
  if (!user) return 'System';
  if (user.firstName) return `${user.firstName} ${user.lastName || ''}`.trim();
  return user.name || user.email || 'User';
};

// @desc Get contacts
// @route GET /api/crm/contacts
const getContacts = async (req, res, next) => {
  try {
    const companyId = getTenantId(req);
    const { search, accountId, companyId: queryAccId, lifecycleStage, page = 1, limit = 25 } = req.query;
    const query = { companyId };

    const effectiveAccountId = accountId || queryAccId;
    if (effectiveAccountId && effectiveAccountId !== 'all') {
      query.accountId = effectiveAccountId;
    }
    if (lifecycleStage && lifecycleStage !== 'all') {
      query.lifecycleStage = lifecycleStage;
    }
    if (search) {
      const searchRegex = new RegExp(search, 'i');
      query.$or = [
        { firstName: searchRegex },
        { lastName: searchRegex },
        { email: searchRegex },
        { phone: searchRegex },
        { jobTitle: searchRegex },
      ];
    }

    const total = await CrmContact.countDocuments(query);
    const contacts = await CrmContact.find(query)
      .populate('accountId', 'name industry')
      .populate('ownerId', 'firstName lastName email profilePicture')
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(Number(limit));

    res.json({
      success: true,
      data: contacts,
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

// @desc Get contact by ID
// @route GET /api/crm/contacts/:id
const getContactById = async (req, res, next) => {
  try {
    const companyId = getTenantId(req);
    const contact = await CrmContact.findOne({ _id: req.params.id, companyId })
      .populate('accountId')
      .populate('ownerId', 'firstName lastName email profilePicture');

    if (!contact) {
      return res.status(404).json({ success: false, message: 'Contact not found' });
    }

    const deals = await CrmDeal.find({ contactId: contact._id, companyId });
    const activities = await CrmActivity.find({ contactId: contact._id, companyId }).sort({ performedAt: -1 });
    const tasks = await CrmTask.find({ contactId: contact._id, companyId }).sort({ dueDate: 1 });

    res.json({
      success: true,
      data: {
        contact,
        deals,
        activities,
        tasks,
      },
    });
  } catch (error) {
    next(error);
  }
};

// @desc Create contact
// @route POST /api/crm/contacts
const createContact = async (req, res, next) => {
  try {
    const companyId = getTenantId(req);
    const contactData = {
      ...req.body,
      companyId,
      accountId: req.body.accountId || req.body.companyId,
      ownerId: req.body.ownerId || req.user?._id,
    };

    const contact = await CrmContact.create(contactData);
    const actorName = getUserDisplayName(req.user);

    await CrmActivity.create({
      companyId,
      type: 'note',
      subject: `Contact added: ${contact.fullName}`,
      performedBy: req.user?._id,
      performedByName: actorName,
      contactId: contact._id,
      accountId: contact.accountId,
    });

    await logCrmAudit({
      companyId,
      userId: req.user?._id,
      action: 'CREATE_CONTACT',
      entityType: 'Contact',
      entityId: contact._id,
      entityName: contact.fullName,
      ipAddress: req.ip,
    });

    res.status(201).json({
      success: true,
      message: 'Contact created successfully',
      data: contact,
    });
  } catch (error) {
    next(error);
  }
};

// @desc Update contact
// @route PUT /api/crm/contacts/:id
const updateContact = async (req, res, next) => {
  try {
    const companyId = getTenantId(req);
    const updates = { ...req.body, lastActivityAt: new Date() };
    if (req.body.companyId && !req.body.accountId) {
      updates.accountId = req.body.companyId;
    }

    const contact = await CrmContact.findOneAndUpdate(
      { _id: req.params.id, companyId },
      updates,
      { new: true, runValidators: true }
    )
      .populate('accountId', 'name industry')
      .populate('ownerId', 'firstName lastName email profilePicture');

    if (!contact) {
      return res.status(404).json({ success: false, message: 'Contact not found' });
    }

    await logCrmAudit({
      companyId,
      userId: req.user?._id,
      action: 'UPDATE_CONTACT',
      entityType: 'Contact',
      entityId: contact._id,
      entityName: contact.fullName,
      changes: updates,
      ipAddress: req.ip,
    });

    res.json({
      success: true,
      message: 'Contact updated successfully',
      data: contact,
    });
  } catch (error) {
    next(error);
  }
};

// @desc Delete contact
// @route DELETE /api/crm/contacts/:id
const deleteContact = async (req, res, next) => {
  try {
    const companyId = getTenantId(req);
    const contact = await CrmContact.findOneAndDelete({ _id: req.params.id, companyId });
    if (!contact) {
      return res.status(404).json({ success: false, message: 'Contact not found' });
    }

    await logCrmAudit({
      companyId,
      userId: req.user?._id,
      action: 'DELETE_CONTACT',
      entityType: 'Contact',
      entityId: contact._id,
      entityName: contact.fullName,
      ipAddress: req.ip,
    });

    res.json({ success: true, message: 'Contact deleted successfully' });
  } catch (error) {
    next(error);
  }
};

module.exports = {
  getContacts,
  getContactById,
  createContact,
  updateContact,
  deleteContact,
};
