const mongoose = require('mongoose');
const CrmLead = require('../models/crmLead.model');
const CrmImportData = require('../models/crmImportData.model');
const CrmContact = require('../models/crmContact.model');
const CrmAccount = require('../models/crmAccount.model');
const CrmDeal = require('../models/crmDeal.model');
const CrmPipeline = require('../models/crmPipeline.model');
const CrmActivity = require('../models/crmActivity.model');
const CrmTask = require('../models/crmTask.model');
const CrmFollowUp = require('../models/crmFollowUp.model');
const { logCrmAudit } = require('../utils/crmAudit');

const getTenantId = (req) => req.companyId || req.user?.companyId;

const getUserDisplayName = (user) => {
  if (!user) return 'System';
  if (user.firstName) return `${user.firstName} ${user.lastName || ''}`.trim();
  return user.name || user.email || 'User';
};

// Multi-factor lead scoring
const calculateLeadScore = (lead) => {
  const hasContactInfo = Boolean(
    lead.firstName?.trim() ||
    lead.lastName?.trim() ||
    lead.email?.trim() ||
    lead.phone?.trim() ||
    lead.companyName?.trim()
  );

  if (!hasContactInfo) return 0;

  let score = 0;

  // 1. Identity & Contact Information (up to 30 pts)
  if (lead.firstName?.trim()) score += 10;
  if (lead.lastName?.trim()) score += 2;
  if (lead.phone?.trim()) score += 15;
  if (lead.email?.trim()) {
    score += 12;
    if (!/@(gmail|yahoo|hotmail|outlook|icloud)\./i.test(lead.email)) {
      score += 3;
    }
  }
  if (lead.alternatePhone?.trim()) score += 3;

  // 2. Organization & Role Authority (up to 25 pts)
  if (lead.companyName?.trim()) score += 12;
  if (lead.website?.trim()) score += 4;
  if (lead.jobTitle?.trim()) {
    const title = lead.jobTitle.toLowerCase();
    if (/(cxo|ceo|cto|cfo|cmo|cro|founder|co-founder|director|vp|vice president|head|partner|owner|md|managing director)/i.test(title)) {
      score += 15;
    } else if (/(manager|lead|principal|supervisor|senior)/i.test(title)) {
      score += 9;
    } else {
      score += 5;
    }
  }

  // 3. Location / Address (up to 10 pts)
  if (lead.address?.city || lead.city) score += 5;
  if (lead.address?.street || lead.street) score += 3;
  if (lead.address?.state || lead.state) score += 2;

  // 4. Commercial Value & Intent (up to 30 pts)
  const estVal = Number(lead.estimatedValue) || 0;
  if (estVal >= 1000000) score += 15;
  else if (estVal >= 500000) score += 10;
  else if (estVal >= 100000) score += 6;
  else if (estVal > 0) score += 3;

  if (lead.budget || lead.qualification?.budget) score += 10;
  if (lead.requirements || lead.qualification?.need) score += 8;

  // 5. Source Quality & Channel
  const sourceScores = {
    'Existing Customer': 12,
    'Referral': 12,
    'Partner': 10,
    'WhatsApp': 10,
    'Website': 8,
    'LinkedIn': 8,
    'Google Ads': 7,
    'Event': 7,
    'Walk-in': 8,
    'Cold Call': 4,
    'Other': 4,
  };
  if (lead.source) {
    score += (sourceScores[lead.source] || 6);
  }

  // 6. Urgency & Priority
  if (lead.priority === 'Urgent') score += 10;
  else if (lead.priority === 'High') score += 6;
  else if (lead.priority === 'Medium') score += 3;
  else if (lead.priority === 'Low') score += 1;

  if (lead.status === 'Qualified') score += 10;
  else if (lead.status === 'Contacted') score += 5;

  return Math.min(100, Math.max(0, Math.round(score)));
};

const getLeadTemperature = (score, explicitTemp, isManual = false) => {
  if (isManual && explicitTemp && ['Cold', 'Warm', 'Hot'].includes(explicitTemp)) return explicitTemp;
  if (score >= 75) return 'Hot';
  if (score >= 45) return 'Warm';
  return 'Cold';
};

// @desc Get all leads with pagination, search & filters
// @route GET /api/crm/leads
const getLeads = async (req, res, next) => {
  try {
    const companyId = getTenantId(req);
    const {
      search,
      status,
      source,
      priority,
      ownerId,
      page = 1,
      limit = 25,
      sortBy = 'createdAt',
      sortOrder = 'desc',
    } = req.query;

    const query = { companyId };

    if (status && status !== 'all') {
      query.status = status;
    }
    if (source && source !== 'all') {
      query.source = source;
    }
    if (priority && priority !== 'all') {
      query.priority = priority;
    }
    if (ownerId && ownerId !== 'all') {
      query.ownerId = ownerId;
    }

    if (search) {
      const searchRegex = new RegExp(search, 'i');
      query.$or = [
        { firstName: searchRegex },
        { lastName: searchRegex },
        { email: searchRegex },
        { phone: searchRegex },
        { companyName: searchRegex },
        { jobTitle: searchRegex },
        { 'address.city': searchRegex },
        { 'address.state': searchRegex },
      ];
    }

    const total = await CrmLead.countDocuments(query);
    const leads = await CrmLead.find(query)
      .populate('ownerId', 'firstName lastName email profilePicture')
      .sort({ [sortBy]: sortOrder === 'asc' ? 1 : -1 })
      .skip((page - 1) * limit)
      .limit(Number(limit));

    res.json({
      success: true,
      data: leads,
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

// @desc Get lead by ID with complete profile, activities, tasks, follow-ups
// @route GET /api/crm/leads/:id
const getLeadById = async (req, res, next) => {
  try {
    const companyId = getTenantId(req);
    const lead = await CrmLead.findOne({ _id: req.params.id, companyId })
      .populate('ownerId', 'firstName lastName email profilePicture roles')
      .populate('convertedContactId', 'firstName lastName email phone jobTitle')
      .populate('convertedAccountId', 'name industry website')
      .populate('convertedDealId', 'title value stage probability');

    if (!lead) {
      return res.status(404).json({ success: false, message: 'Lead not found' });
    }

    const activities = await CrmActivity.find({ leadId: lead._id, companyId })
      .sort({ performedAt: -1 })
      .limit(50);
    const tasks = await CrmTask.find({ leadId: lead._id, companyId })
      .sort({ dueDate: 1 });
    const followUps = await CrmFollowUp.find({ leadId: lead._id, companyId })
      .sort({ scheduledDate: 1 });

    res.json({
      success: true,
      data: {
        lead,
        activities,
        tasks,
        followUps,
      },
    });
  } catch (error) {
    next(error);
  }
};

// @desc Check for duplicate leads
// @route POST /api/crm/leads/check-duplicates
const checkDuplicates = async (req, res, next) => {
  try {
    const companyId = getTenantId(req);
    const { email, phone, companyName, excludeId } = req.body;
    const conditions = [];

    if (email) conditions.push({ email: email.toLowerCase() });
    if (phone) conditions.push({ phone });
    if (companyName && companyName.trim().length > 2) {
      conditions.push({ companyName: new RegExp(`^${companyName.trim()}$`, 'i') });
    }

    if (conditions.length === 0) {
      return res.json({ success: true, duplicates: [] });
    }

    const query = {
      companyId,
      $or: conditions,
    };

    if (excludeId) {
      query._id = { $ne: excludeId };
    }

    const duplicates = await CrmLead.find(query)
      .select('firstName lastName email phone companyName status ownerId score priority lastActivityAt createdAt')
      .populate('ownerId', 'firstName lastName email profilePicture');
    res.json({ success: true, duplicates });
  } catch (error) {
    next(error);
  }
};

// Helper to normalize phone numbers (last 10 digits or digits only)
const normalizePhone = (p) => {
  if (!p) return '';
  const digits = String(p).replace(/\D/g, '');
  return digits.length >= 10 ? digits.slice(-10) : digits;
};

// @desc Check for duplicate leads in batch (by companyName, phone, email)
// @route POST /api/crm/leads/check-duplicates-batch
const checkDuplicatesBatch = async (req, res, next) => {
  try {
    const companyId = getTenantId(req);
    const { items = [] } = req.body;
    if (!Array.isArray(items) || items.length === 0) {
      return res.json({ success: true, results: [] });
    }

    const emails = items.map(i => (i.email || i.emailId || '').trim().toLowerCase()).filter(Boolean);
    const phones = items.map(i => (i.phone || i.mobileNo || '').trim()).filter(Boolean);
    const phoneDigs = phones.map(p => normalizePhone(p)).filter(Boolean);
    const companyNames = items.map(i => (i.companyName || '').trim()).filter(Boolean);

    const conditions = [];
    if (emails.length > 0) conditions.push({ email: { $in: emails } });
    if (phones.length > 0) {
      const phoneRegexes = phoneDigs.map(d => new RegExp(`${d}$`));
      conditions.push({ phone: { $in: [...phones, ...phoneRegexes] } });
    }
    if (companyNames.length > 0) {
      const escapedRegexes = companyNames.map(name => new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i'));
      conditions.push({ companyName: { $in: escapedRegexes } });
    }

    let existingLeads = [];
    if (conditions.length > 0) {
      existingLeads = await CrmLead.find({
        companyId,
        $or: conditions,
      }).select('_id companyName email phone').lean();
    }

    const existingEmails = new Set(existingLeads.map(l => (l.email || '').toLowerCase()).filter(Boolean));
    const existingPhones = new Set(existingLeads.map(l => (l.phone || '').trim()).filter(Boolean));
    const existingPhoneDigs = new Set(existingLeads.map(l => normalizePhone(l.phone)).filter(Boolean));
    const existingCompanyNames = new Set(existingLeads.map(l => (l.companyName || '').trim().toLowerCase()).filter(Boolean));

    const batchEmails = new Set();
    const batchPhones = new Set();
    const batchPhoneDigs = new Set();
    const batchCompanies = new Set();

    const results = items.map((item, idx) => {
      const email = (item.email || item.emailId || '').trim().toLowerCase();
      const phone = (item.phone || item.mobileNo || '').trim();
      const phoneDig = normalizePhone(phone);
      const company = (item.companyName || '').trim().toLowerCase();

      let isDuplicate = false;
      let matchedLead = null;
      const reasons = [];

      if (email) {
        if (existingEmails.has(email)) {
          isDuplicate = true;
          matchedLead = existingLeads.find(l => (l.email || '').toLowerCase() === email);
          reasons.push('Email exists in CRM');
        } else if (batchEmails.has(email)) {
          isDuplicate = true;
          reasons.push('Duplicate Email in sheet');
        }
      }

      if (phone) {
        if (existingPhones.has(phone) || (phoneDig && existingPhoneDigs.has(phoneDig))) {
          isDuplicate = true;
          if (!matchedLead) {
            matchedLead = existingLeads.find(l => (l.phone || '').trim() === phone || (phoneDig && normalizePhone(l.phone) === phoneDig));
          }
          reasons.push('Mobile exists in CRM');
        } else if (batchPhones.has(phone) || (phoneDig && batchPhoneDigs.has(phoneDig))) {
          isDuplicate = true;
          reasons.push('Duplicate Mobile in sheet');
        }
      }

      if (company) {
        if (existingCompanyNames.has(company)) {
          isDuplicate = true;
          if (!matchedLead) {
            matchedLead = existingLeads.find(l => (l.companyName || '').trim().toLowerCase() === company);
          }
          reasons.push('Company exists in CRM');
        } else if (batchCompanies.has(company)) {
          isDuplicate = true;
          reasons.push('Duplicate Company in sheet');
        }
      }

      if (email) batchEmails.add(email);
      if (phone) batchPhones.add(phone);
      if (phoneDig) batchPhoneDigs.add(phoneDig);
      if (company) batchCompanies.add(company);

      const existsInCrm = Boolean(matchedLead);

      return {
        id: item.id || `item_${idx}`,
        isDuplicate,
        existsInCrm,
        leadId: matchedLead ? matchedLead._id : null,
        reason: reasons.join(', '),
      };
    });

    res.json({ success: true, results });
  } catch (error) {
    next(error);
  }
};

// @desc Create new lead
// @route POST /api/crm/leads
const createLead = async (req, res, next) => {
  try {
    const companyId = getTenantId(req);
    const leadData = {
      ...req.body,
      companyId,
      ownerId: req.body.ownerId || req.user?._id,
    };

    if (!leadData.address || typeof leadData.address !== 'object') {
      leadData.address = {
        street: req.body.street || '',
        city: req.body.city || '',
        state: req.body.state || '',
        country: req.body.country || 'India',
        postalCode: req.body.postalCode || '',
      };
    }

    leadData.score = calculateLeadScore(leadData);
    leadData.temperature = getLeadTemperature(leadData.score, req.body.temperature, req.body.isManualTemperature);

    const lead = await CrmLead.create(leadData);

    const actorName = getUserDisplayName(req.user);

    await CrmActivity.create({
      companyId,
      type: 'note',
      subject: `Lead created: ${lead.fullName || lead.firstName}`,
      description: `Lead created from source: ${lead.source || 'Manual entry'}`,
      performedBy: req.user?._id,
      performedByName: actorName,
      leadId: lead._id,
    });

    await logCrmAudit({
      companyId,
      userId: req.user?._id,
      action: 'CREATE_LEAD',
      entityType: 'Lead',
      entityId: lead._id,
      entityName: lead.fullName,
      ipAddress: req.ip,
    });

    res.status(201).json({
      success: true,
      message: 'Lead created successfully',
      data: lead,
    });
  } catch (error) {
    next(error);
  }
};

// @desc Update lead
// @route PUT /api/crm/leads/:id
const updateLead = async (req, res, next) => {
  try {
    const companyId = getTenantId(req);
    let lead = await CrmLead.findOne({ _id: req.params.id, companyId });
    if (!lead) {
      return res.status(404).json({ success: false, message: 'Lead not found' });
    }

    const oldStatus = lead.status;
    const updates = { ...req.body };

    const merged = { ...lead.toObject(), ...updates };
    updates.score = calculateLeadScore(merged);
    updates.lastActivityAt = new Date();

    lead = await CrmLead.findByIdAndUpdate(req.params.id, updates, { new: true, runValidators: true })
      .populate('ownerId', 'firstName lastName email profilePicture');

    if (updates.status && updates.status !== oldStatus) {
      await CrmActivity.create({
        companyId,
        type: 'status_change',
        subject: `Status changed to ${updates.status}`,
        description: `Lead status updated from ${oldStatus} to ${updates.status}`,
        performedBy: req.user?._id,
        performedByName: getUserDisplayName(req.user),
        leadId: lead._id,
      });
    }

    await logCrmAudit({
      companyId,
      userId: req.user?._id,
      action: 'UPDATE_LEAD',
      entityType: 'Lead',
      entityId: lead._id,
      entityName: lead.fullName,
      changes: updates,
      ipAddress: req.ip,
    });

    res.json({
      success: true,
      message: 'Lead updated successfully',
      data: lead,
    });
  } catch (error) {
    next(error);
  }
};

// @desc Delete lead (moves to recycle bin)
// @route DELETE /api/crm/leads/:id
const deleteLead = async (req, res, next) => {
  try {
    const companyId = getTenantId(req);
    const lead = await CrmLead.findOne({ _id: req.params.id, companyId });
    if (!lead) {
      return res.status(404).json({ success: false, message: 'Lead not found' });
    }

    await lead.softDelete(req.user?._id);

    const compName = (lead.companyName || '').trim();
    const orConds = [{ leadId: lead._id }];
    if (compName) {
      orConds.push({ companyName: new RegExp(`^${compName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i') });
    }
    if (lead.email) {
      orConds.push({ emailId: lead.email.toLowerCase() });
    }
    if (lead.phone) {
      orConds.push({ mobileNo: lead.phone });
    }
    await CrmImportData.updateMany(
      { companyId, $or: orConds },
      { $set: { isConvertedToLead: false } }
    );

    await logCrmAudit({
      companyId,
      userId: req.user?._id,
      action: 'DELETE_LEAD',
      entityType: 'Lead',
      entityId: lead._id,
      entityName: lead.fullName,
      ipAddress: req.ip,
    });

    res.json({ success: true, message: 'Lead moved to recycle bin successfully' });
  } catch (error) {
    next(error);
  }
};

// @desc Bulk update leads
// @route POST /api/crm/leads/bulk-update
const bulkUpdateLeads = async (req, res, next) => {
  try {
    const companyId = getTenantId(req);
    const { ids, action, payload } = req.body;
    if (!ids || !ids.length) {
      return res.status(400).json({ success: false, message: 'No lead IDs provided' });
    }

    if (action === 'delete') {
      const leadsToDelete = await CrmLead.find({ _id: { $in: ids }, companyId })
        .select('_id companyName email phone')
        .lean();
      const compNames = leadsToDelete.map((l) => (l.companyName || '').trim()).filter(Boolean);
      const emails = leadsToDelete.map((l) => (l.email || '').toLowerCase().trim()).filter(Boolean);
      const phones = leadsToDelete.map((l) => (l.phone || '').trim()).filter(Boolean);

      await CrmLead.updateMany(
        { _id: { $in: ids }, companyId },
        {
          $set: {
            isDeleted: true,
            deletedAt: new Date(),
            deletedBy: req.user?._id || null,
          },
        }
      );

      const orConds = [{ leadId: { $in: ids } }];
      if (compNames.length > 0) {
        orConds.push({ companyName: { $in: compNames } });
      }
      if (emails.length > 0) {
        orConds.push({ emailId: { $in: emails } });
      }
      if (phones.length > 0) {
        orConds.push({ mobileNo: { $in: phones } });
      }

      await CrmImportData.updateMany(
        { companyId, $or: orConds },
        { $set: { isConvertedToLead: false } }
      );

      return res.json({ success: true, message: `${ids.length} leads moved to recycle bin successfully` });
    }

    const updateFields = {};
    if (action === 'status' && payload?.status) {
      updateFields.status = payload.status;
    } else if (action === 'assign' && payload?.ownerId) {
      updateFields.ownerId = payload.ownerId;
    } else if (action === 'tag' && payload?.tag) {
      await CrmLead.updateMany(
        { _id: { $in: ids }, companyId },
        { $addToSet: { tags: payload.tag } }
      );
      return res.json({ success: true, message: `Tag added to ${ids.length} leads` });
    }

    if (Object.keys(updateFields).length > 0) {
      await CrmLead.updateMany(
        { _id: { $in: ids }, companyId },
        { $set: updateFields }
      );
    }

    res.json({ success: true, message: `Successfully updated ${ids.length} leads` });
  } catch (error) {
    next(error);
  }
};

// @desc Move leads / imported companies to recycle bin
// @route POST /api/crm/leads/move-to-bin
const moveToRecycleBin = async (req, res, next) => {
  try {
    const companyId = getTenantId(req);
    const { items } = req.body;
    if (!items || !Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ success: false, message: 'No items provided' });
    }

    for (const item of items) {
      const rowId = item.id || item.rowId || (item._id ? String(item._id) : null);
      const compName = (item.companyName || '').trim();
      const contactName = (item.contactPerson || '').trim();
      const mobile = (item.mobileNo || item.phone || '').trim();
      const email = (item.emailId || item.email || '').trim().toLowerCase();

      // Look up existing CrmImportData for this company
      let importDoc = null;
      if (rowId) {
        importDoc = await CrmImportData.findOne({ companyId, rowId });
      }
      if (!importDoc && (compName || email || mobile)) {
        const orConds = [];
        if (compName) orConds.push({ companyName: compName });
        if (email) orConds.push({ emailId: email });
        if (mobile) orConds.push({ mobileNo: mobile });
        importDoc = await CrmImportData.findOne({ companyId, $or: orConds });
      }

      const isConverted = Boolean(item.isConvertedToLead);
      const linkedLeadId = item.leadId && mongoose.Types.ObjectId.isValid(item.leadId) ? item.leadId : null;

      if (importDoc) {
        importDoc.isDeleted = true;
        importDoc.deletedAt = new Date();
        importDoc.deletedBy = req.user?._id || null;
        if (linkedLeadId) importDoc.leadId = linkedLeadId;
        importDoc.isConvertedToLead = isConverted;
        await importDoc.save();
      } else {
        await CrmImportData.create({
          companyId,
          rowId: rowId || `row_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`,
          sNo: item.sNo || '',
          companyName: compName,
          industry: item.industry || '',
          address: item.address || '',
          rating: item.rating || '',
          contactPerson: contactName,
          designation: item.designation || '',
          mobileNo: mobile,
          emailId: email,
          remarks: item.remarks || '',
          date: item.date || new Date().toISOString(),
          isConvertedToLead: isConverted,
          leadId: linkedLeadId,
          isDuplicate: Boolean(item.isDuplicate),
          duplicateReason: item.duplicateReason || '',
          source: 'Excel Import',
          isDeleted: true,
          deletedAt: new Date(),
          deletedBy: req.user?._id || null,
        });
      }

      // ONLY soft-delete linked lead if this record was already converted to a CRM lead
      if (isConverted && linkedLeadId) {
        await CrmLead.updateOne(
          { _id: linkedLeadId, companyId },
          { $set: { isDeleted: true, deletedAt: new Date(), deletedBy: req.user?._id || null } }
        );
      }
    }

    await logCrmAudit({
      companyId,
      userId: req.user?._id,
      action: 'MOVE_IMPORT_DATA_TO_BIN',
      entityType: 'ImportData',
      entityName: `${items.length} records`,
      ipAddress: req.ip,
    });

    res.json({
      success: true,
      message: `${items.length} ${items.length === 1 ? 'company' : 'companies'} moved to recycle bin successfully`,
    });
  } catch (error) {
    next(error);
  }
};

// @desc Convert Lead to Contact + Account + Deal
// @route POST /api/crm/leads/:id/convert
const convertLead = async (req, res, next) => {
  try {
    const companyId = getTenantId(req);
    const lead = await CrmLead.findOne({ _id: req.params.id, companyId });
    if (!lead) {
      return res.status(404).json({ success: false, message: 'Lead not found' });
    }

    if (lead.isConverted) {
      return res.status(400).json({ success: false, message: 'Lead has already been converted' });
    }

    const {
      createContact = true,
      createAccount = true,
      createCompany = true, // for backwards compatibility
      createDeal = true,
      dealTitle,
      dealValue,
      pipelineId,
      stage,
      expectedCloseDate,
    } = req.body;

    let contact = null;
    let account = null;
    let deal = null;

    // 1. Create or link Account
    if (createAccount || createCompany) {
      const accountName = req.body.accountName || req.body.companyName || lead.companyName || `${lead.firstName}'s Company`;
      account = await CrmAccount.create({
        companyId,
        name: accountName,
        website: lead.website || '',
        phone: lead.phone || '',
        email: lead.email || '',
        address: lead.address || {},
        ownerId: lead.ownerId || req.user?._id,
        accountType: 'Prospect',
      });
    }

    // 2. Create Contact
    if (createContact) {
      contact = await CrmContact.create({
        companyId,
        firstName: lead.firstName,
        lastName: lead.lastName,
        email: lead.email,
        phone: lead.phone,
        jobTitle: lead.jobTitle,
        accountId: account ? account._id : null,
        ownerId: lead.ownerId || req.user?._id,
        lifecycleStage: 'Opportunity',
        isPrimaryContact: true,
      });
    }

    // 3. Create Deal
    if (createDeal) {
      let targetPipelineId = pipelineId;
      let targetStage = stage;
      let probability = 20;

      if (!targetPipelineId) {
        let defPipeline = await CrmPipeline.findOne({ companyId, isDefault: true });
        if (!defPipeline) {
          defPipeline = await CrmPipeline.findOne({ companyId });
        }
        if (defPipeline) {
          targetPipelineId = defPipeline._id;
          targetStage = defPipeline.stages?.[0]?.name || 'Qualified';
          probability = defPipeline.stages?.[0]?.probability || 20;
        }
      }

      deal = await CrmDeal.create({
        companyId,
        title: dealTitle || `${lead.companyName || lead.fullName} - Deal`,
        value: Number(dealValue) || lead.estimatedValue || 0,
        currency: lead.currency || 'INR',
        pipelineId: targetPipelineId,
        stage: targetStage || 'Qualified',
        probability,
        status: 'Open',
        expectedCloseDate: expectedCloseDate || new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
        accountId: account ? account._id : null,
        contactId: contact ? contact._id : null,
        ownerId: lead.ownerId || req.user?._id,
        leadSource: lead.source || 'Website',
      });
    }

    // 4. Update Lead conversion metadata
    lead.isConverted = true;
    lead.status = 'Converted';
    lead.convertedDate = new Date();
    if (contact) lead.convertedContactId = contact._id;
    if (account) lead.convertedAccountId = account._id;
    if (deal) lead.convertedDealId = deal._id;
    await lead.save();

    await CrmActivity.create({
      companyId,
      type: 'status_change',
      subject: `Lead Converted`,
      description: `Lead converted into Contact, Account, and Deal`,
      performedBy: req.user?._id,
      performedByName: getUserDisplayName(req.user),
      leadId: lead._id,
      accountId: account?._id,
      contactId: contact?._id,
      dealId: deal?._id,
    });

    res.json({
      success: true,
      message: 'Lead converted successfully',
      data: {
        lead,
        contact,
        account,
        deal,
      },
    });
  } catch (error) {
    next(error);
  }
};

module.exports = {
  getLeads,
  getLeadById,
  checkDuplicates,
  checkDuplicatesBatch,
  createLead,
  updateLead,
  deleteLead,
  bulkUpdateLeads,
  moveToRecycleBin,
  convertLead,
};
