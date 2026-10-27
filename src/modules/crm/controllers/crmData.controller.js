const mongoose = require('mongoose');
const User = require('../../user/user.model');
const CrmLead = require('../models/crmLead.model');
const CrmImportData = require('../models/crmImportData.model');
const CrmDeal = require('../models/crmDeal.model');
const CrmContact = require('../models/crmContact.model');
const CrmAccount = require('../models/crmAccount.model');
const CrmActivity = require('../models/crmActivity.model');
const CrmFollowUp = require('../models/crmFollowUp.model');
const CrmExcelFile = require('../models/crmExcelFile.model');
const { logCrmAudit } = require('../utils/crmAudit');
const {
  canViewAllImportData,
  getImportDataOwnerFilter,
  canViewAllLeads,
  getLeadOwnerFilter,
} = require('../utils/crmScope');

const getTenantId = (req) => req.companyId || req.user?.companyId;

const getUserDisplayName = (user) => {
  if (!user) return 'Sales Representative';
  if (user.firstName) return `${user.firstName} ${user.lastName || ''}`.trim();
  return user.name || user.email || 'Sales Representative';
};

const normalizePhone = (p) => {
  if (!p) return '';
  const digits = String(p).replace(/\D/g, '');
  return digits.length >= 10 ? digits.slice(-10) : digits;
};

// @desc Import data into specified CRM entity with validation
// @route POST /api/crm/data/import
const importData = async (req, res, next) => {
  try {
    const companyId = getTenantId(req);
    const { entityType, rows } = req.body;
    if (!rows || !Array.isArray(rows) || rows.length === 0) {
      return res.status(400).json({ success: false, message: 'No data rows provided for import.' });
    }

    let successCount = 0;
    let failedCount = 0;
    let duplicateCount = 0;
    const errors = [];
    const duplicates = [];

    const seenEmails = new Set();
    const seenPhones = new Set();
    const seenPhoneDigs = new Set();
    const seenCompanies = new Set();

    // Valid enum values for CrmLead schema — used to sanitize imported rows
    const VALID_STATUS = ['New', 'Contacted', 'Qualified', 'Unqualified', 'Nurturing', 'Converted', 'Lost'];
    const VALID_PRIORITY = ['Low', 'Medium', 'High', 'Urgent'];
    const VALID_TEMPERATURE = ['Cold', 'Warm', 'Hot'];

    let updateCount = 0;

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      try {
        if (entityType === 'leads') {
          const rawEmail = (row.email || row.emailId || '').trim().toLowerCase();
          const rawPhone = (row.phone || row.mobileNo || '').trim();
          const rawPhoneDig = normalizePhone(rawPhone);
          const rawCompany = (row.companyName || '').trim();

          // 1. Check intra-batch duplicate
          let isDuplicate = false;
          let dupReason = '';
          let existingLead = null;

          if (rawEmail && seenEmails.has(rawEmail)) {
            isDuplicate = true;
            dupReason = `Duplicate Email in upload: ${rawEmail}`;
          } else if (rawPhone && (seenPhones.has(rawPhone) || (rawPhoneDig && seenPhoneDigs.has(rawPhoneDig)))) {
            isDuplicate = true;
            dupReason = `Duplicate Mobile in upload: ${rawPhone}`;
          } else if (rawCompany && seenCompanies.has(rawCompany.toLowerCase())) {
            isDuplicate = true;
            dupReason = `Duplicate Company in upload: ${rawCompany}`;
          }

          // 2. Check existing lead in database
          if (!isDuplicate) {
            const orConditions = [];
            if (rawEmail) orConditions.push({ email: rawEmail });
            if (rawPhone) {
              orConditions.push({ phone: rawPhone });
              if (rawPhoneDig) {
                orConditions.push({ phone: new RegExp(`${rawPhoneDig}$`) });
              }
            }
            if (rawCompany && rawCompany.length > 1) {
              orConditions.push({
                companyName: new RegExp(`^${rawCompany.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i'),
              });
            }

            if (orConditions.length > 0) {
              existingLead = await CrmLead.findOne({
                companyId,
                $or: orConditions,
              }).select('_id companyName email phone').lean();

              if (existingLead) {
                isDuplicate = true;
                const leadPhoneDig = normalizePhone(existingLead.phone);
                if (rawEmail && existingLead.email?.toLowerCase() === rawEmail) {
                  dupReason = `Email '${rawEmail}' already exists in CRM`;
                } else if (rawPhone && (existingLead.phone === rawPhone || (rawPhoneDig && leadPhoneDig === rawPhoneDig))) {
                  dupReason = `Mobile '${rawPhone}' already exists in CRM`;
                } else {
                  dupReason = `Company '${rawCompany}' already exists in CRM`;
                }
              }
            }
          }

          // FIX #2: If record already exists in CRM and the row is flagged as an update,
          // update the safe back-fields instead of silently skipping.
          if (isDuplicate && existingLead && row.isUpdate) {
            const safeUpdateFields = {};

            if (row.notes || row.remarks) safeUpdateFields.notes = row.notes || row.remarks;
            if (row.jobTitle || row.designation) safeUpdateFields.jobTitle = row.jobTitle || row.designation;
            if (row.website) safeUpdateFields.website = row.website;

            // Sanitize enum fields before update
            if (row.status && VALID_STATUS.includes(row.status)) safeUpdateFields.status = row.status;
            if (row.priority && VALID_PRIORITY.includes(row.priority)) safeUpdateFields.priority = row.priority;
            if (row.temperature && VALID_TEMPERATURE.includes(row.temperature)) safeUpdateFields.temperature = row.temperature;

            // Rebuild address if provided
            if (row.address) {
              safeUpdateFields.address = typeof row.address === 'string'
                ? { street: row.address, city: '', state: '', country: 'India', postalCode: '' }
                : row.address;
            }

            if (Object.keys(safeUpdateFields).length > 0) {
              await CrmLead.findByIdAndUpdate(existingLead._id, { $set: safeUpdateFields });
              updateCount++;
              successCount++;
            } else {
              // Nothing to update — count as duplicate skip
              duplicateCount++;
              duplicates.push({ row: i + 1, companyName: rawCompany, reason: dupReason });
            }
            continue;
          }

          if (isDuplicate) {
            duplicateCount++;
            duplicates.push({ row: i + 1, companyName: rawCompany, reason: dupReason });
            continue; // Skip uploading duplicate that has no update intent
          }

          // Mark as seen in batch
          if (rawEmail) seenEmails.add(rawEmail);
          if (rawPhone) seenPhones.add(rawPhone);
          if (rawPhoneDig) seenPhoneDigs.add(rawPhoneDig);
          if (rawCompany) seenCompanies.add(rawCompany.toLowerCase());

          const contactName = (row.contactPerson || row.contact_person || row.name || '').trim();
          const nameParts = contactName ? contactName.split(/\s+/) : [];
          const firstName = row.firstName || nameParts[0] || row.companyName || 'Lead';
          const lastName = row.lastName || nameParts.slice(1).join(' ') || '';

          let address = row.address;
          if (typeof address === 'string') {
            address = { street: address, city: '', state: '', country: 'India', postalCode: '' };
          } else if (!address || typeof address !== 'object') {
            address = { street: '', city: '', state: '', country: 'India', postalCode: '' };
          }

          const tags = Array.isArray(row.tags) ? [...row.tags] : [];
          if (row.industry && !tags.includes(row.industry)) tags.push(row.industry);
          if (row.rating && !tags.some(t => t.startsWith('Rating:'))) tags.push(`Rating: ${row.rating}`);

          // FIX #1: Whitelist only known CrmLead schema fields — never spread raw row.
          // Sanitize enum fields to prevent Mongoose ValidationError from bad Excel values.
          const leadPayload = {
            firstName,
            lastName,
            companyName: rawCompany,
            jobTitle: (row.jobTitle || row.designation || '').trim(),
            phone: rawPhone,
            email: rawEmail,
            alternatePhone: (row.alternatePhone || row.altPhone || '').trim(),
            website: (row.website || '').trim(),
            address,
            tags,
            source: (row.source || 'Excel Import').trim(),
            notes: (row.notes || row.remarks || '').trim(),
            budget: (row.budget || '').trim(),
            requirements: (row.requirements || '').trim(),
            estimatedValue: Number(row.estimatedValue) || 0,
            // Sanitize enum values — fall back to schema defaults if invalid
            status: VALID_STATUS.includes(row.status) ? row.status : 'New',
            priority: VALID_PRIORITY.includes(row.priority) ? row.priority : 'Medium',
            temperature: VALID_TEMPERATURE.includes(row.temperature) ? row.temperature : 'Warm',
            companyId,
            ownerId: req.user?._id,
          };

          if (row.date) {
            const parsedDate = new Date(row.date);
            if (!isNaN(parsedDate.getTime())) {
              leadPayload.createdAt = parsedDate;
            }
          }

          await CrmLead.create(leadPayload);
        } else if (entityType === 'contacts') {
          if (!row.firstName) throw new Error('First Name is required');
          await CrmContact.create({
            ...row,
            companyId,
            ownerId: req.user?._id,
          });
        } else if (entityType === 'companies' || entityType === 'accounts') {
          if (!row.name) throw new Error('Account Name is required');
          await CrmAccount.create({
            ...row,
            companyId,
            ownerId: req.user?._id,
          });
        } else if (entityType === 'deals') {
          if (!row.title) throw new Error('Deal Title is required');
          await CrmDeal.create({
            ...row,
            companyId,
            ownerId: req.user?._id,
          });
        }
        successCount++;
      } catch (err) {
        failedCount++;
        errors.push({ row: i + 1, message: err.message });
      }
    }

    await logCrmAudit({
      companyId,
      userId: req.user?._id,
      action: 'DATA_IMPORT',
      entityType,
      changes: { total: rows.length, successCount, updateCount, failedCount, duplicateCount },
    });

    // FIX #3: Return success:false when every single row failed (not just some)
    const totalProcessed = successCount + failedCount + duplicateCount;
    const allFailed = failedCount > 0 && successCount === 0 && duplicateCount === 0;

    let msg;
    if (allFailed) {
      msg = `Import failed: all ${failedCount} row(s) could not be processed.`;
    } else if (updateCount > 0 && successCount > updateCount) {
      msg = `Import complete: ${successCount - updateCount} new, ${updateCount} updated, ${duplicateCount} duplicate(s) skipped${failedCount > 0 ? `, ${failedCount} failed` : ''}.`;
    } else if (updateCount > 0) {
      msg = `Import complete: ${updateCount} record(s) updated, ${duplicateCount} duplicate(s) skipped${failedCount > 0 ? `, ${failedCount} failed` : ''}.`;
    } else if (duplicateCount > 0) {
      msg = `Import complete: ${successCount} imported successfully, ${duplicateCount} duplicate(s) skipped${failedCount > 0 ? `, ${failedCount} failed` : ''}.`;
    } else {
      msg = `Import complete: ${successCount} imported successfully${failedCount > 0 ? `, ${failedCount} failed` : ''}.`;
    }

    res.json({
      success: !allFailed,
      message: msg,
      data: { successCount, updateCount, failedCount, duplicateCount, duplicates, errors },
    });
  } catch (error) {
    next(error);
  }
};

// @desc Export data
// @route GET /api/crm/data/export/:entityType
const exportData = async (req, res, next) => {
  try {
    const companyId = getTenantId(req);
    const { entityType } = req.params;
    let data = [];

    if (entityType === 'leads') {
      const q = { companyId };
      if (!canViewAllLeads(req.user)) {
        Object.assign(q, getLeadOwnerFilter(req.user));
      }
      data = await CrmLead.find(q).lean();
    } else if (entityType === 'import-data' || entityType === 'database') {
      const q = { companyId, isDeleted: false };
      if (!canViewAllImportData(req.user)) {
        Object.assign(q, getImportDataOwnerFilter(req.user));
      }
      data = await CrmImportData.find(q).lean();
    } else if (entityType === 'contacts') {
      data = await CrmContact.find({ companyId }).lean();
    } else if (entityType === 'companies' || entityType === 'accounts') {
      data = await CrmAccount.find({ companyId }).lean();
    } else if (entityType === 'deals') {
      data = await CrmDeal.find({ companyId }).lean();
    } else {
      return res.status(400).json({ success: false, message: 'Invalid entity type for export.' });
    }

    res.json({ success: true, count: data.length, data });
  } catch (error) {
    next(error);
  }
};

// @desc Merge duplicate records
// @route POST /api/crm/data/merge
const mergeDuplicates = async (req, res, next) => {
  try {
    const companyId = getTenantId(req);
    const { entityType, primaryId, duplicateId } = req.body;

    if (!primaryId || !duplicateId || primaryId === duplicateId) {
      return res.status(400).json({ success: false, message: 'Valid primaryId and duplicateId required.' });
    }

    if (entityType === 'leads') {
      const primary = await CrmLead.findOne({ _id: primaryId, companyId });
      const duplicate = await CrmLead.findOne({ _id: duplicateId, companyId });
      if (!primary || !duplicate) return res.status(404).json({ success: false, message: 'Record not found.' });

      // Merge empty fields
      ['phone', 'alternatePhone', 'website', 'jobTitle'].forEach(field => {
        if (!primary[field] && duplicate[field]) primary[field] = duplicate[field];
      });

      await primary.save();
      await CrmLead.findByIdAndDelete(duplicateId);
    } else if (entityType === 'contacts') {
      const primary = await CrmContact.findOne({ _id: primaryId, companyId });
      const duplicate = await CrmContact.findOne({ _id: duplicateId, companyId });
      if (!primary || !duplicate) return res.status(404).json({ success: false, message: 'Record not found.' });

      ['phone', 'jobTitle', 'department'].forEach(field => {
        if (!primary[field] && duplicate[field]) primary[field] = duplicate[field];
      });

      await primary.save();
      await CrmContact.findByIdAndDelete(duplicateId);
    }

    res.json({ success: true, message: 'Records merged successfully' });
  } catch (error) {
    next(error);
  }
};

// @desc Get active imported data rows with pagination and filters
// @route GET /api/crm/data/import-data
const getImportData = async (req, res, next) => {
  try {
    const companyId = getTenantId(req);
    const {
      page,
      limit,
      search,
      dateFilter,
      dateFilterType = 'updatedAt',
      fromDate,
      toDate,
      importedBy,
      sortBy = 'createdAt',
      sortOrder = 'desc',
      all,
    } = req.query;

    const andConditions = [{ companyId, isDeleted: false }];

    // Scoping: If user cannot view all imported data, restrict to their own uploaded/assigned records
    if (!canViewAllImportData(req.user)) {
      andConditions.push(getImportDataOwnerFilter(req.user));
    }

    // Search filter across multiple fields
    if (search && search.trim()) {
      const q = search.trim();
      const regex = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
      andConditions.push({
        $or: [
          { companyName: regex },
          { gstin: regex },
          { contactPerson: regex },
          { emailId: regex },
          { mobileNo: regex },
          { industry: regex },
          { address: regex },
          { remarks: regex },
          { importedBy: regex },
        ],
      });
    }

    // Imported By user filter (supports array or comma-separated string)
    if (importedBy) {
      const names = (Array.isArray(importedBy) ? importedBy : String(importedBy).split(','))
        .map((s) => s.trim())
        .filter(Boolean);
      if (names.length > 0) {
        // Resolve user IDs if names or IDs were supplied
        const validObjectIds = names.filter((n) => mongoose.Types.ObjectId.isValid(n)).map((n) => new mongoose.Types.ObjectId(n));
        const matchingUsers = await User.find({
          companyId,
          $or: [
            ...(validObjectIds.length > 0 ? [{ _id: { $in: validObjectIds } }] : []),
            ...names.map((n) => ({
              $or: [
                { firstName: new RegExp(`^${n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i') },
                { lastName: new RegExp(`^${n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i') },
                { email: new RegExp(`^${n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i') },
              ],
            })),
          ],
        }).select('_id').lean();

        const allUserIds = [...new Set([...validObjectIds, ...matchingUsers.map((u) => u._id)])];

        const userFilterOr = [
          {
            importedBy: {
              $in: names.map((n) => new RegExp(`^${n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i')),
            },
          },
        ];
        if (allUserIds.length > 0) {
          userFilterOr.push({ importedByUserId: { $in: allUserIds } });
        }
        andConditions.push({ $or: userFilterOr });
      }
    }

    // Date filters (supports dateFilterType: 'updatedAt' vs 'createdAt' vs default)
    const targetDateField = dateFilterType === 'createdAt' ? 'createdAt' : (dateFilterType === 'updatedAt' ? 'updatedAt' : 'date');
    const now = new Date();
    if (dateFilter === 'today') {
      const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      const endOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999);
      andConditions.push({
        $or: [
          { [targetDateField]: { $gte: startOfDay, $lte: endOfDay } },
          { date: { $gte: startOfDay.toISOString(), $lte: endOfDay.toISOString() } },
        ],
      });
    } else if (dateFilter === '2days') {
      const twoDaysAgo = new Date(now.getTime() - 2 * 24 * 60 * 60 * 1000);
      andConditions.push({
        $or: [
          { [targetDateField]: { $gte: twoDaysAgo } },
          { date: { $gte: twoDaysAgo.toISOString() } },
        ],
      });
    } else if (dateFilter === '5days') {
      const fiveDaysAgo = new Date(now.getTime() - 5 * 24 * 60 * 60 * 1000);
      andConditions.push({
        $or: [
          { [targetDateField]: { $gte: fiveDaysAgo } },
          { date: { $gte: fiveDaysAgo.toISOString() } },
        ],
      });
    } else if (dateFilter === 'custom' && (fromDate || toDate)) {
      const dateCondTarget = {};
      const dateCondString = {};
      if (fromDate) {
        const fromD = new Date(fromDate);
        dateCondTarget.$gte = fromD;
        dateCondString.$gte = fromD.toISOString();
      }
      if (toDate) {
        const toD = new Date(toDate);
        toD.setHours(23, 59, 59, 999);
        dateCondTarget.$lte = toD;
        dateCondString.$lte = toD.toISOString();
      }
      andConditions.push({
        $or: [
          { [targetDateField]: dateCondTarget },
          { date: dateCondString },
        ],
      });
    }

    const query = andConditions.length > 1 ? { $and: andConditions } : andConditions[0];

    const baseCountConditions = [{ companyId, isDeleted: false }];
    if (!canViewAllImportData(req.user)) {
      baseCountConditions.push(getImportDataOwnerFilter(req.user));
    }
    const baseCountQuery = baseCountConditions.length > 1 ? { $and: baseCountConditions } : baseCountConditions[0];

    // Total counts in database
    const totalMatching = await CrmImportData.countDocuments(query);
    const totalAll = await CrmImportData.countDocuments(baseCountQuery);

    // Determine pagination
    const isPaginated = all !== 'true' && (page !== undefined || limit !== undefined);
    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const parsedLimit = parseInt(limit, 10);
    const limitNum = [50, 80, 100].includes(parsedLimit) ? parsedLimit : (parsedLimit > 0 ? parsedLimit : 50);

    const sortField = sortBy === 'date' ? 'date' : 'createdAt';
    const TABLE_FIELDS = 'rowId sNo companyName industry status leadStatus statusHistory leadSource source date createdAt updatedAt lastContactedAt importedBy importedByUserId isConvertedToLead leadId isDuplicate duplicateReason rating contactPerson designation mobileNo emailId address remarks contacts';
    let findQuery = CrmImportData.find(query)
      .select(TABLE_FIELDS)
      .populate('importedByUserId', 'firstName lastName name email')
      .sort({ [sortField]: sortOrder === 'asc' ? 1 : -1 });

    if (isPaginated) {
      findQuery = findQuery.skip((pageNum - 1) * limitNum).limit(limitNum);
    }

    const records = await findQuery.lean();

    // Query active leads to accurately reflect if each company is still active in CRM Leads
    const activeLeads = await CrmLead.find({ companyId, isDeleted: false })
      .select('_id companyName')
      .lean();

    const activeLeadIds = new Set(activeLeads.map((l) => String(l._id)));
    const activeLeadCompNames = new Set(
      activeLeads.map((l) => (l.companyName || '').trim().toLowerCase()).filter(Boolean)
    );

    const mappedData = records.map((r) => {
      const comp = (r.companyName || '').trim().toLowerCase();
      const hasActiveLead = Boolean(
        (r.leadId && activeLeadIds.has(String(r.leadId))) ||
        (comp && activeLeadCompNames.has(comp))
      );

      const userDoc = r.importedByUserId;
      const actualUserName = (userDoc && typeof userDoc === 'object' && userDoc._id)
        ? ([userDoc.firstName, userDoc.lastName].filter(Boolean).join(' ').trim() || userDoc.name || userDoc.email || '')
        : '';
      const finalImportedBy = actualUserName || r.importedBy || '';
      const finalImportedByUserId = (userDoc && typeof userDoc === 'object' && userDoc._id)
        ? String(userDoc._id)
        : (r.importedByUserId ? String(r.importedByUserId) : null);

      const hasStoredContacts = Array.isArray(r.contacts) && r.contacts.length > 0;
      const contacts = hasStoredContacts
        ? r.contacts
        : ((r.contactPerson || r.mobileNo || r.emailId)
          ? [{
            contactPerson: r.contactPerson || '',
            designation: r.designation || '',
            mobileNo: r.mobileNo || '',
            emailId: r.emailId || '',
            isPrimary: true,
          }]
          : []);

      const resolvedSource = (r.source && r.source !== 'Excel Import' && r.source !== 'Website')
        ? r.source
        : (r.leadSource && r.leadSource !== 'Website' ? r.leadSource : '');

      return {
        id: r.rowId || String(r._id),
        _id: r._id,
        sNo: r.sNo || '',
        companyName: r.companyName || '',
        dateOfRegistration: r.dateOfRegistration || '',
        industry: r.industry || '',
        status: r.status || r.leadStatus || (hasActiveLead ? 'Converted to Lead' : 'New'),
        date: r.date,
        createdAt: r.createdAt ? new Date(r.createdAt).toISOString() : (r.date || null),
        updatedAt: r.updatedAt ? new Date(r.updatedAt).toISOString() : (r.lastContactedAt ? new Date(r.lastContactedAt).toISOString() : (r.date || null)),
        lastContactedAt: r.lastContactedAt || null,
        leadStatus: r.leadStatus || r.status || '',
        source: resolvedSource,
        leadSource: resolvedSource,
        importedBy: finalImportedBy,
        importedByUserId: finalImportedByUserId,
        isConvertedToLead: hasActiveLead,
        leadId: r.leadId || null,
        isDuplicate: Boolean(r.isDuplicate),
        duplicateReason: hasActiveLead ? '' : (r.duplicateReason || ''),
        rating: r.rating || '',
        contactPerson: r.contactPerson || '',
        designation: r.designation || '',
        mobileNo: r.mobileNo || '',
        emailId: r.emailId || '',
        address: r.address || '',
        gstin: r.gstin || '',
        remarks: r.remarks || '',
        contacts,
        statusHistory: r.statusHistory || [],
      };
    });

    res.json({
      success: true,
      data: mappedData,
      pagination: {
        total: totalMatching,
        totalAll,
        page: isPaginated ? pageNum : 1,
        limit: isPaginated ? limitNum : totalMatching,
        totalPages: isPaginated ? Math.max(1, Math.ceil(totalMatching / limitNum)) : 1,
      },
    });
  } catch (error) {
    next(error);
  }
};

// @desc Sync active imported data rows from frontend workspace
// @route POST /api/crm/data/import-data/sync
const syncImportData = async (req, res, next) => {
  try {
    const companyId = getTenantId(req);
    const { rows } = req.body;
    if (!Array.isArray(rows)) {
      return res.status(400).json({ success: false, message: 'Rows array required' });
    }

    const userId = req.user?._id || req.user?.id || null;
    const userFullName = [req.user?.firstName, req.user?.lastName].filter(Boolean).join(' ').trim() || req.user?.name || req.user?.email || '';
    const isRestricted = !canViewAllImportData(req.user);

    // Security Filter: Restricted users can ONLY sync records that belong to them
    const eligibleRows = isRestricted
      ? rows.filter((item) => {
        const itemUser = (item.importedBy || '').trim().toLowerCase();
        const currUser = userFullName.toLowerCase();
        const itemUserId = item.importedByUserId ? String(item.importedByUserId) : '';
        const myId = String(userId || '');
        return (itemUserId && itemUserId === myId) || (!itemUserId && (!itemUser || itemUser === currUser));
      })
      : rows;

    if (eligibleRows.length === 0) {
      return res.json({ success: true, message: 'No eligible user rows to sync' });
    }

    const bulkOps = eligibleRows.map((item) => {
      const rowId = item.id || item.rowId;
      const companyName = (item.companyName || '').trim();
      const mobileNo = (item.mobileNo || '').trim();
      const emailId = (item.emailId || '').trim().toLowerCase();

      // Compound content-key filter
      const contentFilter = {};
      if (item._id && mongoose.isValidObjectId(item._id)) {
        contentFilter._id = item._id;
      } else if (rowId && mongoose.isValidObjectId(rowId)) {
        contentFilter.$or = [{ _id: rowId }, { rowId }];
      } else if (rowId) {
        contentFilter.rowId = rowId;
      } else {
        if (item.gstin) contentFilter.gstin = String(item.gstin).trim().toUpperCase();
        if (companyName) contentFilter.companyName = companyName;
        if (mobileNo) contentFilter.mobileNo = mobileNo;
        if (emailId) contentFilter.emailId = emailId;
      }

      const ownFilter = isRestricted && userId
        ? {
          $or: [
            { importedByUserId: userId },
            { importedByUserId: { $exists: false } },
            { importedByUserId: null },
          ],
        }
        : {};

      const contactsList = Array.isArray(item.contacts) && item.contacts.length > 0
        ? item.contacts
        : ((item.contactPerson || item.mobileNo || item.emailId)
          ? [{
            contactPerson: (item.contactPerson || '').trim(),
            designation: (item.designation || '').trim(),
            mobileNo: (item.mobileNo || '').trim(),
            emailId: (item.emailId || '').trim(),
            isPrimary: true,
          }]
          : []);

      const primaryContact = contactsList.find((c) => c.isPrimary) || contactsList[0] || null;
      const resolvedContactPerson = (item.contactPerson || primaryContact?.contactPerson || '').trim();
      const resolvedDesignation = (item.designation || primaryContact?.designation || '').trim();
      const resolvedMobile = (item.mobileNo || primaryContact?.mobileNo || mobileNo || '').trim();
      const resolvedEmail = (item.emailId || primaryContact?.emailId || emailId || '').trim();

      const resolvedSyncSource = (item.source && item.source !== 'Website' && item.source !== 'Excel Import')
        ? item.source
        : (item.leadSource && item.leadSource !== 'Website' ? item.leadSource : '');

      const setFields = {
        companyId,
        rowId,
        sNo: item.sNo || '',
        companyName,
        dateOfRegistration: (item.dateOfRegistration || '').trim(),
        gstin: (item.gstin || '').trim().toUpperCase(),
        industry: (item.industry || '').trim(),
        address: (item.address || '').trim(),
        rating: (item.rating || '').trim(),
        contactPerson: resolvedContactPerson,
        designation: resolvedDesignation,
        mobileNo: resolvedMobile,
        emailId: resolvedEmail,
        contacts: contactsList,
        remarks: (item.remarks || '').trim(),
        date: item.date || new Date().toISOString(),
        status: (item.status || item.leadStatus || 'New').trim(),
        leadStatus: (item.status || item.leadStatus || 'New').trim(),
        source: String(resolvedSyncSource).trim(),
        leadSource: String(resolvedSyncSource).trim(),
        isConvertedToLead: Boolean(item.isConvertedToLead),
        leadId: item.leadId || null,
        isDuplicate: Boolean(item.isDuplicate),
        duplicateReason: item.duplicateReason || '',
        isDeleted: false,
      };

      const setOnInsertFields = {};

      if (isRestricted) {
        setFields.importedBy = userFullName;
        setFields.importedByUserId = userId;
      } else {
        // If an explicit user is passed on item, preserve it
        if (item.importedBy && item.importedBy.trim()) {
          setFields.importedBy = item.importedBy.trim();
        }
        if (item.importedByUserId) {
          setFields.importedByUserId = item.importedByUserId;
        }
        // Fallback for new documents created by this sync
        if (!setFields.importedBy) {
          setOnInsertFields.importedBy = (item.importedBy || userFullName || '').trim();
        }
        if (!setFields.importedByUserId) {
          setOnInsertFields.importedByUserId = item.importedByUserId || userId;
        }
      }

      return {
        updateOne: {
          filter: { companyId, ...contentFilter, ...ownFilter },
          update: {
            $set: setFields,
            ...(Object.keys(setOnInsertFields).length > 0 ? { $setOnInsert: setOnInsertFields } : {}),
          },
          upsert: true,
        },
      };
    });

    if (bulkOps.length > 0) {
      await CrmImportData.bulkWrite(bulkOps);
    }

    res.json({ success: true, message: `Synced ${rows.length} rows` });
  } catch (error) {
    next(error);
  }
};

// Helper: Safely resolve an ImportData document regardless of whether 'id' is a MongoDB ObjectId or an imported 'rowId' string
const resolveImportDataProspect = async (companyId, id, req = null) => {
  if (!id) return null;

  // 1. Try finding by MongoDB ObjectId if id is 24 hex characters
  const isObjectId = mongoose.Types.ObjectId.isValid(id) && String(new mongoose.Types.ObjectId(id)) === String(id);
  if (isObjectId) {
    const row = await CrmImportData.findOne({
      companyId,
      $or: [{ _id: id }, { rowId: id }],
    }).populate('importedByUserId', 'firstName lastName name email');
    if (row) return row;
  }

  // 2. Try finding by rowId string
  let row = await CrmImportData.findOne({ companyId, rowId: id }).populate('importedByUserId', 'firstName lastName name email');
  if (row) return row;

  // 3. If id is base64 row format (e.g. 'row_YmhrIGluIGd1cmdhb258OTIwNTEzNjE0NHw_')
  if (typeof id === 'string' && id.startsWith('row_')) {
    try {
      const raw = id.slice(4);
      const cleaned = raw.replace(/_+$/, ''); // strip trailing padding
      let decoded = '';
      try {
        decoded = Buffer.from(cleaned.replace(/_/g, '/').replace(/-/g, '+'), 'base64').toString('utf8');
      } catch (_) {}
      if (!decoded || !decoded.includes('|')) {
        try {
          decoded = Buffer.from(cleaned.replace(/_/g, '+'), 'base64').toString('utf8');
        } catch (_) {}
      }
      if (!decoded || !decoded.includes('|')) {
        try {
          decoded = Buffer.from(raw, 'base64').toString('utf8');
        } catch (_) {}
      }

      const parts = decoded.split('|');
      let compName = '';
      let gstin = '';
      let mobile = '';
      let email = '';

      if (parts.length >= 4) {
        compName = parts[0] || '';
        gstin = parts[1] || '';
        mobile = parts[2] || '';
        email = parts[3] || '';
      } else {
        compName = parts[0] || '';
        mobile = parts[1] || '';
        email = parts[2] || '';
      }

      const trimmedComp = compName.trim();
      const trimmedGstin = gstin.trim().toUpperCase();
      const trimmedMobile = mobile.trim();
      const trimmedEmail = email.trim();

      const query = { companyId, isDeleted: false };

      if (trimmedGstin) {
        query.gstin = trimmedGstin;
      } else if (trimmedComp && trimmedMobile) {
        query.companyName = new RegExp(`^${trimmedComp.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i');
        query.mobileNo = trimmedMobile;
      } else if (trimmedComp) {
        query.companyName = new RegExp(`^${trimmedComp.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i');
      } else if (trimmedMobile) {
        query.mobileNo = trimmedMobile;
      } else if (trimmedEmail) {
        query.emailId = trimmedEmail;
      }

      row = await CrmImportData.findOne(query).populate('importedByUserId', 'firstName lastName name email');
      if (row) return row;

      // 4. Auto-persist row if it only existed in local workspace
      if (req) {
        row = await CrmImportData.create({
          companyId,
          rowId: id,
          companyName: trimmedComp || 'Prospect',
          gstin: trimmedGstin || undefined,
          mobileNo: trimmedMobile,
          emailId: trimmedEmail,
          importedBy: getUserDisplayName(req.user),
          importedByUserId: req.user?._id,
        });
        return row;
      }
    } catch {
      // ignore decode error
    }
  }

  return null;
};

// @desc Log outreach activity (call, WhatsApp, email, meeting, note) for an ImportData prospect
// @route POST /api/crm/data/import-data/:id/activity
const logImportDataActivity = async (req, res, next) => {
  try {
    const companyId = getTenantId(req);
    const { id } = req.params;
    const {
      type = 'call', // 'call', 'whatsapp', 'email', 'meeting', 'note'
      subject,
      description = '',
      outcome = 'Connected',
      durationMinutes = 0,
      callType = 'Cold Call',
      contactPerson = '',
      contactPhone = '',
      contactDesignation = '',
      contactEmail = '',
      contactPersons = [],
      metadata = {},
    } = req.body;

    const row = await resolveImportDataProspect(companyId, id, req);
    if (!row) {
      return res.status(404).json({ success: false, message: 'Prospect record not found' });
    }

    const repName = getUserDisplayName(req.user);
    const userId = req.user?._id;

    // Normalize multiple contact persons if supplied
    const cleanContactPersons = Array.isArray(contactPersons)
      ? contactPersons
          .map((p) => ({
            name: (p.name || p.contactPerson || '').trim(),
            phone: (p.phone || p.mobileNo || '').trim(),
            designation: (p.designation || '').trim(),
            email: (p.email || p.emailId || '').trim(),
            callType: (p.callType || callType || 'Cold Call').trim(),
            durationMinutes: Number(p.durationMinutes ?? durationMinutes) || 0,
            outcome: (p.outcome || outcome || 'Connected').trim(),
            notes: (p.notes ?? p.description ?? '').trim(),
          }))
          .filter((p) => p.name || p.phone)
      : [];

    // Update the row's interaction counters & last contacted status
    const incField = {};
    if (type === 'call') incField.callCount = cleanContactPersons.length > 1 ? cleanContactPersons.length : 1;
    else if (type === 'whatsapp') incField.whatsappCount = cleanContactPersons.length > 1 ? cleanContactPersons.length : 1;
    else if (type === 'email') incField.emailCount = 1;

    const updateData = {
      lastContactedAt: new Date(),
      lastContactedBy: repName,
      lastContactedByUserId: userId,
      lastOutcome: outcome,
      lastCallType: callType,
    };

    // Auto-persist new contact persons into the company record's contacts array
    if (cleanContactPersons.length > 0) {
      const existingContacts = Array.isArray(row.contacts) ? [...row.contacts] : [];
      let addedAny = false;
      cleanContactPersons.forEach((cp) => {
        if (!cp.name && !cp.phone) return;
        const exists = existingContacts.some((ec) => {
          const ecName = (ec.contactPerson || ec.name || '').trim().toLowerCase();
          const ecPhone = (ec.mobileNo || ec.phone || '').trim().replace(/\D/g, '');
          const cpCleanPhone = cp.phone.replace(/\D/g, '');
          return (
            (cp.name && ecName === cp.name.toLowerCase()) ||
            (cpCleanPhone && ecPhone === cpCleanPhone && cpCleanPhone.length >= 10)
          );
        });
        if (!exists && cp.name) {
          existingContacts.push({
            contactPerson: cp.name,
            designation: cp.designation || '',
            mobileNo: cp.phone || '',
            emailId: cp.email || '',
            isPrimary: false,
          });
          addedAny = true;
        }
      });
      if (addedAny) {
        updateData.contacts = existingContacts;
      }
    }

    const updatedRow = await CrmImportData.findByIdAndUpdate(
      row._id,
      {
        $set: updateData,
        $inc: Object.keys(incField).length > 0 ? incField : {},
      },
      { new: true }
    );

    // Resolve main contact names & phones
    let resolvedContactPerson = (contactPerson || '').trim();
    let resolvedContactPhone = (contactPhone || '').trim();
    let resolvedContactDesignation = (contactDesignation || '').trim();
    let resolvedContactEmail = (contactEmail || '').trim();

    if (!resolvedContactPerson && cleanContactPersons.length > 0) {
      resolvedContactPerson = cleanContactPersons.map((p) => p.name).filter(Boolean).join(' & ');
    }
    if (!resolvedContactPerson) {
      resolvedContactPerson = (row.contactPerson || '').trim();
    }

    if (!resolvedContactPhone && cleanContactPersons.length > 0) {
      resolvedContactPhone = cleanContactPersons.map((p) => p.phone).filter(Boolean).join(', ');
    }
    if (!resolvedContactPhone) {
      resolvedContactPhone = (row.mobileNo || row.phone || '').trim();
    }

    if (!resolvedContactDesignation && cleanContactPersons.length > 0) {
      resolvedContactDesignation = cleanContactPersons.map((p) => p.designation).filter(Boolean).join(', ');
    }
    if (!resolvedContactDesignation) {
      resolvedContactDesignation = (row.designation || '').trim();
    }

    const activity = await CrmActivity.create({
      companyId,
      importDataId: row._id,
      leadId: row.leadId || null,
      type,
      subject: subject || `${type.toUpperCase()} with ${resolvedContactPerson || row.companyName || 'Prospect'}`,
      description,
      outcome,
      durationMinutes: Number(durationMinutes) || 0,
      callType,
      contactPerson: resolvedContactPerson,
      contactPhone: resolvedContactPhone,
      contactDesignation: resolvedContactDesignation,
      contactEmail: resolvedContactEmail,
      contactPersons: cleanContactPersons.length > 0 ? cleanContactPersons : (resolvedContactPerson ? [{
        name: resolvedContactPerson,
        phone: resolvedContactPhone,
        designation: resolvedContactDesignation,
        email: resolvedContactEmail,
        callType: callType || 'Cold Call',
        durationMinutes: Number(durationMinutes) || 0,
        outcome: outcome || 'Connected',
        notes: description || '',
      }] : []),
      metadata: {
        ...(typeof metadata === 'object' && metadata !== null ? metadata : {}),
        contactPerson: resolvedContactPerson,
        contactPhone: resolvedContactPhone,
        contactDesignation: resolvedContactDesignation,
        contactEmail: resolvedContactEmail,
        contactPersons: cleanContactPersons,
      },
      performedBy: userId,
      performedByName: repName,
      performedAt: new Date(),
    });

    res.status(201).json({
      success: true,
      message: `${type.toUpperCase()} interaction logged successfully`,
      data: activity,
      record: updatedRow,
    });
  } catch (error) {
    next(error);
  }
};

// @desc Update outreach activity (call, WhatsApp, email, meeting, note)
// @route PUT /api/crm/data/import-data/activity/:activityId
const updateImportDataActivity = async (req, res, next) => {
  try {
    const companyId = getTenantId(req);
    const { activityId } = req.params;
    const {
      callType,
      outcome,
      durationMinutes,
      description,
      subject,
      contactPerson,
      contactPhone,
      contactDesignation,
      contactEmail,
      contactPersons,
    } = req.body;

    let activity = null;
    if (companyId) {
      activity = await CrmActivity.findOne({ _id: activityId, companyId });
    }
    if (!activity) {
      activity = await CrmActivity.findById(activityId);
    }
    if (!activity) {
      return res.status(404).json({ success: false, message: 'Activity record not found' });
    }

    if (callType !== undefined) activity.callType = callType;
    if (outcome !== undefined) activity.outcome = outcome;
    if (durationMinutes !== undefined) activity.durationMinutes = Number(durationMinutes) || 0;
    if (description !== undefined) activity.description = description;
    if (subject !== undefined) activity.subject = subject;
    if (contactPerson !== undefined) activity.contactPerson = contactPerson;
    if (contactPhone !== undefined) activity.contactPhone = contactPhone;
    if (contactDesignation !== undefined) activity.contactDesignation = contactDesignation;
    if (contactEmail !== undefined) activity.contactEmail = contactEmail;

    if (Array.isArray(contactPersons)) {
      const cleanPersons = contactPersons.map((p) => ({
        name: (p.name || p.contactPerson || '').trim(),
        phone: (p.phone || p.mobileNo || '').trim(),
        designation: (p.designation || '').trim(),
        email: (p.email || p.emailId || '').trim(),
        callType: (p.callType || callType || activity.callType || 'Cold Call').trim(),
        durationMinutes: Number(p.durationMinutes ?? durationMinutes ?? 0) || 0,
        outcome: (p.outcome || outcome || activity.outcome || 'Connected').trim(),
        notes: (p.notes ?? p.description ?? '').trim(),
      }));

      activity.contactPersons = cleanPersons;

      if (cleanPersons.length > 1) {
        activity.contactPerson = cleanPersons.map((p) => p.name).filter(Boolean).join(' & ');
        activity.contactPhone = cleanPersons.map((p) => p.phone).filter(Boolean).join(', ');
        activity.contactDesignation = cleanPersons.map((p) => p.designation).filter(Boolean).join(', ');
        if (!subject) {
          activity.subject = `Multi-Person Call (${cleanPersons.length}) with ${activity.contactPerson}`;
        }
      } else if (cleanPersons.length === 1) {
        activity.contactPerson = cleanPersons[0].name || activity.contactPerson;
        activity.contactPhone = cleanPersons[0].phone || activity.contactPhone;
        activity.contactDesignation = cleanPersons[0].designation || activity.contactDesignation;
      }

      // Safely update Mongoose Map if present without spreading internal $ properties
      if (activity.metadata && typeof activity.metadata.set === 'function') {
        activity.metadata.set('contactPersons', cleanPersons);
        activity.metadata.set('contactPerson', activity.contactPerson);
        activity.metadata.set('contactPhone', activity.contactPhone);
        activity.metadata.set('contactDesignation', activity.contactDesignation);
        activity.metadata.set('contactEmail', activity.contactEmail);
      }
    }

    await activity.save();

    // If linked to an importData row, update row's lastOutcome / lastCallType if this was the latest activity
    if (activity.importDataId) {
      const latestActivity = await CrmActivity.findOne({
        importDataId: activity.importDataId,
      }).sort({ performedAt: -1 });

      if (latestActivity && String(latestActivity._id) === String(activity._id)) {
        await CrmImportData.findByIdAndUpdate(activity.importDataId, {
          lastOutcome: activity.outcome,
          lastCallType: activity.callType,
        });
      }
    }

    res.json({
      success: true,
      message: 'Activity updated successfully',
      data: activity,
    });
  } catch (error) {
    next(error);
  }
};

// @desc Get activity & follow-up history for a specific ImportData prospect
// @route GET /api/crm/data/import-data/:id/activities
const getImportDataActivities = async (req, res, next) => {
  try {
    const companyId = getTenantId(req);
    const { id } = req.params;
    const { companyName, mobileNo, phone, email } = req.query;

    let row = await resolveImportDataProspect(companyId, id, req);

    if (!row && (companyName || mobileNo || phone || email)) {
      const orConds = [];
      if (companyName && companyName.trim()) {
        const escaped = companyName.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        orConds.push({ companyName: new RegExp(`^${escaped}$`, 'i') });
      }
      const rawPhone = mobileNo || phone;
      if (rawPhone && rawPhone.trim()) {
        const phoneDigits = rawPhone.replace(/\D/g, '').slice(-10);
        orConds.push({ mobileNo: rawPhone.trim() });
        if (phoneDigits) {
          orConds.push({ mobileNo: new RegExp(`${phoneDigits}$`) });
        }
      }
      if (email && email.trim()) {
        orConds.push({ emailId: email.trim().toLowerCase() });
      }
      if (orConds.length > 0) {
        row = await CrmImportData.findOne({ companyId, $or: orConds });
      }
    }

    if (!row) {
      return res.json({
        success: true,
        data: {
          activities: [],
          followUps: [],
          summary: {
            totalCalls: 0,
            totalWhatsApps: 0,
            totalEmails: 0,
            totalTouches: 0,
            lastOutcome: 'No contact yet',
          },
        },
        activities: [],
        followUps: [],
      });
    }

    const actConditions = [{ importDataId: row._id }];
    if (row.leadId) {
      actConditions.push({ leadId: row.leadId });
    }
    if (row.companyName && row.companyName.trim()) {
      const escaped = row.companyName.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      actConditions.push({ subject: new RegExp(escaped, 'i') });
    }

    // Pagination parameters (default 20, allowed up to 100)
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 20));
    const skip = (page - 1) * limit;

    // Optional channel filter ('all', 'call', 'whatsapp', 'email', etc.)
    const channel = req.query.channel || req.query.type;
    const baseActFilter = {
      companyId,
      $or: actConditions,
    };

    const queryActFilter = { ...baseActFilter };
    if (channel && ['call', 'whatsapp', 'email', 'task', 'meeting'].includes(channel)) {
      queryActFilter.type = channel;
    }

    const [
      totalCalls,
      totalWhatsApps,
      totalEmails,
      totalAllActivities,
      totalFilteredActivities,
    ] = await Promise.all([
      CrmActivity.countDocuments({ ...baseActFilter, type: 'call' }),
      CrmActivity.countDocuments({ ...baseActFilter, type: 'whatsapp' }),
      CrmActivity.countDocuments({ ...baseActFilter, type: 'email' }),
      CrmActivity.countDocuments(baseActFilter),
      CrmActivity.countDocuments(queryActFilter),
    ]);

    const activities = await CrmActivity.find(queryActFilter)
      .populate('performedBy', 'firstName lastName name email profilePicture')
      .sort({ performedAt: -1 })
      .skip(skip)
      .limit(limit);

    const flwConditions = [{ importDataId: row._id }];
    if (row.leadId) {
      flwConditions.push({ leadId: row.leadId });
    }

    const followUps = await CrmFollowUp.find({
      companyId,
      $or: flwConditions,
    })
      .populate('assignedTo', 'firstName lastName name email')
      .sort({ scheduledDate: 1 });

    const totalPages = Math.ceil(totalFilteredActivities / limit) || 1;
    const pagination = {
      page,
      limit,
      total: totalFilteredActivities,
      totalPages,
      hasNextPage: page < totalPages,
      hasPrevPage: page > 1,
    };

    // Self-healing / reconciliation of stored counters when activities exist
    if (totalAllActivities > 0) {
      if (
        row.callCount !== totalCalls ||
        row.whatsappCount !== totalWhatsApps ||
        row.emailCount !== totalEmails
      ) {
        await CrmImportData.findByIdAndUpdate(row._id, {
          $set: {
            callCount: totalCalls,
            whatsappCount: totalWhatsApps,
            emailCount: totalEmails,
          },
        });
        row.callCount = totalCalls;
        row.whatsappCount = totalWhatsApps;
        row.emailCount = totalEmails;
      }
    }

    res.json({
      success: true,
      data: {
        activities,
        followUps,
        record: row,
        pagination,
        summary: {
          totalCalls: totalAllActivities > 0 ? totalCalls : (row.callCount || 0),
          totalWhatsApps: totalAllActivities > 0 ? totalWhatsApps : (row.whatsappCount || 0),
          totalEmails: totalAllActivities > 0 ? totalEmails : (row.emailCount || 0),
          totalFollowUps: followUps.length,
          totalTouches: totalAllActivities > 0 ? totalAllActivities : ((row.callCount || 0) + (row.whatsappCount || 0) + (row.emailCount || 0)),
          lastOutcome: row.lastOutcome || activities[0]?.outcome || 'No contact yet',
          lastContactedAt: row.lastContactedAt || activities[0]?.performedAt || null,
          lastContactedBy: row.lastContactedBy || activities[0]?.performedByName || '',
        },
      },
      activities,
      followUps,
      pagination,
    });
  } catch (error) {
    next(error);
  }
};

// @desc Schedule a follow-up call/meeting for an ImportData prospect
// @route POST /api/crm/data/import-data/:id/follow-up
const scheduleImportDataFollowUp = async (req, res, next) => {
  try {
    const companyId = getTenantId(req);
    const { id } = req.params;
    const {
      title,
      scheduledDate,
      type = 'call',
      priority = 'Medium',
      notes = '',
    } = req.body;

    if (!scheduledDate) {
      return res.status(400).json({ success: false, message: 'Follow-up scheduled date is required' });
    }

    const row = await resolveImportDataProspect(companyId, id, req);
    if (!row) {
      return res.status(404).json({ success: false, message: 'Prospect record not found' });
    }

    const repName = getUserDisplayName(req.user);
    const userId = req.user?._id;

    const followUp = await CrmFollowUp.create({
      companyId,
      importDataId: row._id,
      leadId: row.leadId || null,
      title: title || `Follow-up ${type} with ${row.contactPerson || row.companyName || 'Prospect'}`,
      scheduledDate: new Date(scheduledDate),
      type,
      priority,
      notes,
      assignedTo: userId,
      status: 'scheduled',
    });

    await CrmImportData.findByIdAndUpdate(
      row._id,
      { $set: { nextFollowUpAt: new Date(scheduledDate) } }
    );

    // Also record an activity entry for audit
    await CrmActivity.create({
      companyId,
      importDataId: row._id,
      type: 'task',
      subject: `Follow-up scheduled (${type})`,
      description: notes || `Follow-up set for ${new Date(scheduledDate).toLocaleString()}`,
      outcome: 'Scheduled Meeting',
      performedBy: userId,
      performedByName: repName,
      performedAt: new Date(),
    });

    res.status(201).json({
      success: true,
      message: 'Follow-up scheduled successfully',
      data: followUp,
    });
  } catch (error) {
    next(error);
  }
};

// @desc Get real-time sales rep performance summary across database interactions
// @route GET /api/crm/data/performance
const getRepPerformanceSummary = async (req, res, next) => {
  try {
    const companyId = getTenantId(req);
    const { dateRange = 'today', from, to, userId } = req.query;

    const now = new Date();
    let startDate;
    let endDate = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999);

    if (dateRange === 'today') {
      startDate = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0);
    } else if (dateRange === 'yesterday') {
      startDate = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1, 0, 0, 0, 0);
      endDate = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1, 23, 59, 59, 999);
    } else if (dateRange === 'this_week') {
      const day = now.getDay();
      const diff = now.getDate() - day + (day === 0 ? -6 : 1);
      startDate = new Date(now.getFullYear(), now.getMonth(), diff, 0, 0, 0, 0);
    } else if (dateRange === 'this_month') {
      startDate = new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0, 0);
    } else if (dateRange === 'custom' && from) {
      if (typeof from === 'string' && from.includes('-')) {
        const [fY, fM, fD] = from.split('-').map(Number);
        startDate = new Date(fY, fM - 1, fD, 0, 0, 0, 0);
      } else {
        startDate = new Date(from);
      }
      if (to) {
        if (typeof to === 'string' && to.includes('-')) {
          const [tY, tM, tD] = to.split('-').map(Number);
          endDate = new Date(tY, tM - 1, tD, 23, 59, 59, 999);
        } else {
          endDate = new Date(new Date(to).setHours(23, 59, 59, 999));
        }
      }
    } else {
      startDate = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0);
    }

    const canViewAll = canViewAllImportData(req.user);

    const activityQuery = {
      companyId,
      performedAt: { $gte: startDate, $lte: endDate },
    };

    if (!canViewAll) {
      // User can only view their own performance metrics
      const myId = req.user?._id;
      const myName = getUserDisplayName(req.user);
      const orConditions = [];
      if (myId) orConditions.push({ performedBy: myId });
      if (myName) orConditions.push({ performedByName: new RegExp(`^${myName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i') });
      activityQuery.$or = orConditions;
    } else if (userId && userId !== 'all') {
      activityQuery.performedBy = userId;
    }

    // Fetch activities in date range
    const activities = await CrmActivity.find(activityQuery)
      .populate('performedBy', 'firstName lastName name email profilePicture roles')
      .populate('importDataId', 'companyName contactPerson mobileNo isConvertedToLead')
      .sort({ performedAt: -1 });

    // Aggregate summary metrics
    const totalActivities = activities.length;
    const calls = activities.filter((a) => a.type === 'call');
    const whatsapps = activities.filter((a) => a.type === 'whatsapp');
    const emails = activities.filter((a) => a.type === 'email');

    const connectedCalls = calls.filter((c) =>
      ['Connected', 'Connected - Interested', 'Connected - Not Interested', 'Scheduled Meeting', 'Callback Requested'].includes(c.outcome)
    );
    const positiveOutcomes = activities.filter((a) =>
      ['Connected - Interested', 'Scheduled Meeting'].includes(a.outcome)
    );
    const callbacks = activities.filter((a) => a.outcome === 'Callback Requested');

    const connectionRate = calls.length > 0 ? Math.round((connectedCalls.length / calls.length) * 100) : 0;
    const positiveRate = connectedCalls.length > 0 ? Math.round((positiveOutcomes.length / connectedCalls.length) * 100) : 0;

    // Converted to lead in date range
    const convertedConds = {
      companyId,
      isConvertedToLead: true,
      updatedAt: { $gte: startDate, $lte: endDate },
    };
    if (!canViewAll) {
      const myId = req.user?._id;
      const myName = getUserDisplayName(req.user);
      const orConds = [];
      if (myId) orConds.push({ importedByUserId: myId });
      if (myName) orConds.push({ importedBy: new RegExp(`^${myName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i') });
      convertedConds.$or = orConds;
    } else if (userId && userId !== 'all') {
      convertedConds.importedByUserId = userId;
    }

    const convertedRows = await CrmImportData.countDocuments(convertedConds);

    // Prospects with actual status changes (excluding untouched initial status)
    const statusChangeConds = {
      companyId,
      statusHistory: {
        $elemMatch: {
          previousStatus: { $exists: true, $ne: '' },
        },
      },
    };
    if (!canViewAll) {
      const myId = req.user?._id;
      const myName = getUserDisplayName(req.user);
      const orConds = [];
      if (myId) orConds.push({ importedByUserId: myId });
      if (myName) orConds.push({ importedBy: new RegExp(`^${myName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i') });
      statusChangeConds.$and = [
        { statusHistory: statusChangeConds.statusHistory },
        { $or: orConds },
      ];
      delete statusChangeConds.statusHistory;
    } else if (userId && userId !== 'all') {
      statusChangeConds.importedByUserId = userId;
    }
    const statusChangesCount = await CrmImportData.countDocuments(statusChangeConds);

    // Fetch follow-ups in date range
    const followUpQuery = {
      companyId,
      scheduledDate: { $gte: startDate, $lte: endDate },
    };
    if (!canViewAll) {
      const myId = req.user?._id;
      if (myId) followUpQuery.assignedTo = myId;
    } else if (userId && userId !== 'all') {
      followUpQuery.assignedTo = userId;
    }

    const followUps = await CrmFollowUp.find(followUpQuery)
      .populate('assignedTo', 'firstName lastName name email profilePicture')
      .populate('importDataId', 'companyName contactPerson mobileNo emailId industry source leadSource')
      .populate('leadId', 'firstName lastName companyName phone email')
      .sort({ scheduledDate: 1 });

    // Group activities by sales rep
    const repMap = new Map();

    for (const act of activities) {
      const repId = act.performedBy?._id ? String(act.performedBy._id) : (act.performedByName || 'Unknown');
      const repName = getUserDisplayName(act.performedBy) || act.performedByName || 'Rep';
      const repEmail = act.performedBy?.email || '';

      if (!repMap.has(repId)) {
        repMap.set(repId, {
          userId: act.performedBy?._id || null,
          userName: repName,
          email: repEmail,
          totalCalls: 0,
          totalWhatsApps: 0,
          totalEmails: 0,
          totalFollowUps: 0,
          totalActivities: 0,
          connectedCalls: 0,
          positiveOutcomes: 0,
          callbacksRequested: 0,
          notInterested: 0,
          noAnswer: 0,
          convertedCount: 0,
        });
      }

      const repStats = repMap.get(repId);
      repStats.totalActivities += 1;

      if (act.type === 'call') {
        repStats.totalCalls += 1;
        if (['Connected', 'Connected - Interested', 'Connected - Not Interested', 'Scheduled Meeting', 'Callback Requested'].includes(act.outcome)) {
          repStats.connectedCalls += 1;
        }
        if (act.outcome === 'Connected - Interested' || act.outcome === 'Scheduled Meeting') {
          repStats.positiveOutcomes += 1;
        } else if (act.outcome === 'Callback Requested') {
          repStats.callbacksRequested += 1;
        } else if (act.outcome === 'Connected - Not Interested') {
          repStats.notInterested += 1;
        } else if (['No Answer', 'Busy', 'Wrong Number', 'Left Voicemail'].includes(act.outcome)) {
          repStats.noAnswer += 1;
        }
      } else if (act.type === 'whatsapp') {
        repStats.totalWhatsApps += 1;
      } else if (act.type === 'email') {
        repStats.totalEmails += 1;
      } else if (act.type === 'task') {
        repStats.totalFollowUps += 1;
      }
    }

    // Also count assigned follow-ups per rep
    for (const flw of followUps) {
      if (flw.assignedTo?._id) {
        const rId = String(flw.assignedTo._id);
        const rName = getUserDisplayName(flw.assignedTo);
        const rEmail = flw.assignedTo?.email || '';
        if (!repMap.has(rId)) {
          repMap.set(rId, {
            userId: flw.assignedTo._id,
            userName: rName,
            email: rEmail,
            totalCalls: 0,
            totalWhatsApps: 0,
            totalEmails: 0,
            totalFollowUps: 0,
            totalActivities: 0,
            connectedCalls: 0,
            positiveOutcomes: 0,
            callbacksRequested: 0,
            notInterested: 0,
            noAnswer: 0,
            convertedCount: 0,
          });
        }
        const repStats = repMap.get(rId);
        // If not already counted from task activity
        if (!activities.some((a) => a.type === 'task' && String(a.performedBy?._id || '') === rId && a.importDataId?._id?.toString() === flw.importDataId?._id?.toString())) {
          repStats.totalFollowUps += 1;
        }
      }
    }

    // Attach converted counts per rep
    for (const [repId, stats] of repMap.entries()) {
      if (stats.userId) {
        const count = await CrmImportData.countDocuments({
          companyId,
          isConvertedToLead: true,
          importedByUserId: stats.userId,
          updatedAt: { $gte: startDate, $lte: endDate },
        });
        stats.convertedCount = count;
      }
      stats.connectionRate = stats.totalCalls > 0 ? Math.round((stats.connectedCalls / stats.totalCalls) * 100) : 0;
    }

    const leaderboard = Array.from(repMap.values()).sort((a, b) => b.totalCalls - a.totalCalls);

    res.json({
      success: true,
      data: {
        canViewAll,
        dateRange,
        startDate,
        endDate,
        summary: {
          totalActivities,
          totalCalls: calls.length,
          totalWhatsApps: whatsapps.length,
          totalEmails: emails.length,
          totalFollowUps: followUps.length,
          connectedCalls: connectedCalls.length,
          connectionRate,
          positiveOutcomes: positiveOutcomes.length,
          positiveRate,
          callbacks: callbacks.length,
          convertedRows,
          statusChangesCount,
        },
        leaderboard,
        followUps,
        recentActivities: activities.slice(0, 30),
      },
    });
  } catch (error) {
    next(error);
  }
};

// @desc Get detailed paginated outreach & activity history for a specific sales representative
// @route GET /api/crm/data/rep-activities
const getRepActivities = async (req, res, next) => {
  try {
    const companyId = getTenantId(req);
    const {
      userId,
      userName,
      dateRange = 'today',
      from,
      to,
      type = 'all',
      outcome = 'all',
      search = '',
      page = 1,
      limit = 15,
    } = req.query;

    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const limitNum = Math.max(1, Math.min(100, parseInt(limit, 10) || 15));
    const skip = (pageNum - 1) * limitNum;

    // Date range calculation
    const now = new Date();
    let startDate = null;
    let endDate = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999);

    if (dateRange === 'today') {
      startDate = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0);
    } else if (dateRange === 'yesterday') {
      startDate = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1, 0, 0, 0, 0);
      endDate = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1, 23, 59, 59, 999);
    } else if (dateRange === '2days') {
      // Last 2 days: yesterday 00:00:00 to end of today
      startDate = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1, 0, 0, 0, 0);
    } else if (dateRange === '5days') {
      // Last 5 days: 4 days ago 00:00:00 to end of today
      startDate = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 4, 0, 0, 0, 0);
    } else if (dateRange === 'this_week') {
      const day = now.getDay();
      const diff = now.getDate() - day + (day === 0 ? -6 : 1);
      startDate = new Date(now.getFullYear(), now.getMonth(), diff, 0, 0, 0, 0);
    } else if (dateRange === 'this_month') {
      startDate = new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0, 0);
    } else if (dateRange === 'custom' && from) {
      if (typeof from === 'string' && from.includes('-')) {
        const [fY, fM, fD] = from.split('-').map(Number);
        startDate = new Date(fY, fM - 1, fD, 0, 0, 0, 0);
      } else {
        startDate = new Date(from);
      }
      if (to) {
        if (typeof to === 'string' && to.includes('-')) {
          const [tY, tM, tD] = to.split('-').map(Number);
          endDate = new Date(tY, tM - 1, tD, 23, 59, 59, 999);
        } else {
          endDate = new Date(new Date(to).setHours(23, 59, 59, 999));
        }
      }
    } else if (dateRange === 'all') {
      startDate = null;
    }

    const canViewAll = canViewAllImportData(req.user);
    const myId = req.user?._id;
    const myName = getUserDisplayName(req.user);

    const query = { companyId };

    // Rep filter conditions: if user cannot view all company data, restrict strictly to their own activities
    const repConditions = [];
    if (!canViewAll) {
      if (myId) repConditions.push({ performedBy: myId });
      if (myName) repConditions.push({ performedByName: new RegExp(`^${myName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i') });
    } else {
      if (userId && mongoose.Types.ObjectId.isValid(userId)) {
        repConditions.push({ performedBy: new mongoose.Types.ObjectId(userId) });
      }
      if (userName && userName.trim() && userName.trim().toLowerCase() !== 'all' && !userName.toLowerCase().includes('all team') && !userName.toLowerCase().includes('team telemetry')) {
        const escaped = userName.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        repConditions.push({ performedByName: new RegExp(`^${escaped}$`, 'i') });
      }
    }

    if (repConditions.length === 1) {
      Object.assign(query, repConditions[0]);
    } else if (repConditions.length > 1) {
      query.$or = repConditions;
    }

    if (startDate) {
      query.performedAt = { $gte: startDate, $lte: endDate };
    }

    if (type && type !== 'all') {
      query.type = type;
    }

    if (outcome && outcome !== 'all') {
      if (outcome === 'positive') {
        query.outcome = { $in: ['Connected - Interested', 'Scheduled Meeting'] };
      } else if (outcome === 'connected') {
        query.outcome = { $in: ['Connected', 'Connected - Interested', 'Connected - Not Interested', 'Scheduled Meeting', 'Callback Requested'] };
      } else {
        query.outcome = outcome;
      }
    }

    // Search filter
    if (search && search.trim()) {
      const sEscaped = search.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const searchRegex = new RegExp(sEscaped, 'i');

      const matchingProspects = await CrmImportData.find({
        companyId,
        $or: [
          { companyName: searchRegex },
          { contactPerson: searchRegex },
          { mobileNo: searchRegex },
          { emailId: searchRegex },
        ],
      }).select('_id').lean();

      const prospectIds = matchingProspects.map((p) => p._id);

      const searchConditions = [
        { subject: searchRegex },
        { description: searchRegex },
      ];
      if (prospectIds.length > 0) {
        searchConditions.push({ importDataId: { $in: prospectIds } });
      }

      if (query.$or) {
        query.$and = [
          { $or: query.$or },
          { $or: searchConditions },
        ];
        delete query.$or;
      } else {
        query.$or = searchConditions;
      }
    }

    const [total, activities] = await Promise.all([
      CrmActivity.countDocuments(query),
      CrmActivity.find(query)
        .populate('performedBy', 'firstName lastName name email profilePicture')
        .populate('importDataId', 'companyName contactPerson designation mobileNo emailId address leadStatus leadSource isConvertedToLead nextFollowUpAt lastOutcome lastCallType')
        .populate('leadId', 'firstName lastName companyName phone email status score')
        .sort({ performedAt: -1 })
        .skip(skip)
        .limit(limitNum)
        .lean(),
    ]);

    // Also calculate type summary for the active rep & date range
    const baseRepQuery = { companyId };
    if (repConditions.length === 1) {
      Object.assign(baseRepQuery, repConditions[0]);
    } else if (repConditions.length > 1) {
      baseRepQuery.$or = repConditions;
    }
    if (startDate) {
      baseRepQuery.performedAt = { $gte: startDate, $lte: endDate };
    }

    const baseActivities = await CrmActivity.find(baseRepQuery).select('type outcome durationMinutes').lean();
    const typeCounts = {
      all: baseActivities.length,
      call: 0,
      whatsapp: 0,
      email: 0,
      task: 0,
      meeting: 0,
    };
    let connectedCalls = 0;
    let positiveOutcomes = 0;

    baseActivities.forEach((a) => {
      if (typeCounts[a.type] !== undefined) {
        typeCounts[a.type] += 1;
      }
      if (a.type === 'call') {
        if (['Connected', 'Connected - Interested', 'Connected - Not Interested', 'Scheduled Meeting', 'Callback Requested'].includes(a.outcome)) {
          connectedCalls += 1;
        }
      }
      if (['Connected - Interested', 'Scheduled Meeting'].includes(a.outcome)) {
        positiveOutcomes += 1;
      }
    });

    const connectionRate = typeCounts.call > 0 ? Math.round((connectedCalls / typeCounts.call) * 100) : 0;

    res.json({
      success: true,
      data: {
        activities,
        pagination: {
          page: pageNum,
          limit: limitNum,
          total,
          totalPages: Math.ceil(total / limitNum) || 1,
        },
        summary: {
          totalActivities: baseActivities.length,
          typeCounts,
          totalCalls: typeCounts.call,
          totalWhatsApps: typeCounts.whatsapp,
          totalEmails: typeCounts.email,
          totalFollowUps: typeCounts.task,
          connectedCalls,
          connectionRate,
          positiveOutcomes,
        },
        filters: {
          dateRange,
          startDate,
          endDate,
          type,
          outcome,
        },
      },
    });
  } catch (error) {
    next(error);
  }
};

// @desc Get single ImportData prospect record by ID or lookup
// @route GET /api/crm/data/import-data/:id
const getImportDataById = async (req, res, next) => {
  try {
    const companyId = getTenantId(req);
    const { id } = req.params;
    const { companyName, mobileNo, email } = req.query;

    let row = await resolveImportDataProspect(companyId, id, req);

    if (!row && (companyName || mobileNo || email)) {
      const orConds = [];
      if (companyName) {
        orConds.push({ companyName: new RegExp(`^${companyName.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i') });
      }
      if (mobileNo) {
        orConds.push({ mobileNo: new RegExp(mobileNo.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i') });
      }
      if (email) {
        orConds.push({ emailId: new RegExp(`^${email.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i') });
      }
      if (orConds.length > 0) {
        row = await CrmImportData.findOne({ companyId, $or: orConds });
      }
    }

    if (!row) {
      return res.status(404).json({ success: false, message: 'Prospect record not found' });
    }

    const rowObj = row.toObject ? row.toObject() : row;
    rowObj.id = rowObj.rowId || String(rowObj._id);

    const userDoc = rowObj.importedByUserId;
    if (userDoc && typeof userDoc === 'object' && userDoc._id) {
      const actualUserName = [userDoc.firstName, userDoc.lastName].filter(Boolean).join(' ').trim() || userDoc.name || userDoc.email || '';
      if (actualUserName) {
        rowObj.importedBy = actualUserName;
      }
      rowObj.importedByUserId = String(userDoc._id);
    }

    if (!Array.isArray(rowObj.contacts) || rowObj.contacts.length === 0) {
      if (rowObj.contactPerson || rowObj.mobileNo || rowObj.emailId) {
        rowObj.contacts = [{
          contactPerson: rowObj.contactPerson || '',
          designation: rowObj.designation || '',
          mobileNo: rowObj.mobileNo || '',
          emailId: rowObj.emailId || '',
          isPrimary: true,
        }];
      } else {
        rowObj.contacts = [];
      }
    }

    const resolvedSingleSource = (rowObj.source && rowObj.source !== 'Excel Import' && rowObj.source !== 'Website')
      ? rowObj.source
      : (rowObj.leadSource && rowObj.leadSource !== 'Website' ? rowObj.leadSource : (rowObj.source || rowObj.leadSource || ''));
    rowObj.source = resolvedSingleSource;
    rowObj.leadSource = resolvedSingleSource;

    res.json({
      success: true,
      data: rowObj,
    });
  } catch (error) {
    next(error);
  }
};

// @desc Update status of an imported data prospect
// @route PATCH /api/crm/data/import-data/:id/status
const updateImportDataStatus = async (req, res, next) => {
  try {
    const companyId = getTenantId(req);
    const { id } = req.params;
    const { status, note = '' } = req.body;

    if (!status) {
      return res.status(400).json({ success: false, message: 'Status is required' });
    }

    const row = await resolveImportDataProspect(companyId, id, req);
    if (!row) {
      return res.status(404).json({ success: false, message: 'Prospect record not found' });
    }

    const trimmedStatus = String(status).trim();
    const oldStatus = row.status || row.leadStatus || 'New';
    row.status = trimmedStatus;
    row.leadStatus = trimmedStatus;

    if (!Array.isArray(row.statusHistory)) {
      row.statusHistory = [];
    }

    const displayName = getUserDisplayName(req.user) || 'User';

    // If statusHistory is empty and this is the first change from oldStatus, record baseline
    if (row.statusHistory.length === 0 && oldStatus && oldStatus !== trimmedStatus) {
      row.statusHistory.push({
        status: oldStatus,
        previousStatus: '',
        changedAt: row.createdAt || row.date || new Date(),
        changedBy: row.importedBy || 'Initial Import',
        note: 'Initial status on import',
      });
    }

    row.statusHistory.push({
      status: trimmedStatus,
      previousStatus: oldStatus,
      changedAt: new Date(),
      changedBy: displayName,
      changedByUserId: req.user?._id || null,
      note: note ? String(note).trim() : '',
    });

    await row.save();

    // Also log an activity entry so it shows in Timeline
    try {
      await CrmActivity.create({
        companyId,
        importDataId: row._id,
        leadId: row.leadId || null,
        type: 'task',
        subject: `Status changed to ${trimmedStatus}`,
        description: `Status changed from "${oldStatus}" to "${trimmedStatus}"${note ? `. Note: ${note}` : ''}`,
        performedBy: req.user?._id || null,
        performedByName: displayName,
        performedAt: new Date(),
        outcome: trimmedStatus,
      });
    } catch (actErr) {
      console.warn('Failed to log status change activity:', actErr.message);
    }

    res.json({
      success: true,
      message: 'Status updated successfully',
      data: {
        id: row.rowId || String(row._id),
        status: trimmedStatus,
        leadStatus: trimmedStatus,
        statusHistory: row.statusHistory,
      },
    });
  } catch (error) {
    next(error);
  }
};

// @desc Save uploaded/imported Excel file record
// @route POST /api/crm/data/excel-files
const saveExcelFile = async (req, res, next) => {
  try {
    const companyId = getTenantId(req);
    const {
      fileName,
      fileSize,
      fileSizeBytes,
      totalRowsFetched,
      totalCompanies,
      newCount,
      updateCount,
      duplicateCount,
      importMode,
      fileData,
    } = req.body;

    if (!fileName) {
      return res.status(400).json({ success: false, message: 'File name is required' });
    }

    const displayName = getUserDisplayName(req.user);

    // Prevent duplicate entries if confirmed multiple times within 30 seconds
    const recentDuplicate = await CrmExcelFile.findOne({
      companyId,
      fileName,
      totalRowsFetched: Number(totalRowsFetched) || 0,
      isDeleted: false,
      createdAt: { $gte: new Date(Date.now() - 30000) },
    }).lean();

    if (recentDuplicate) {
      return res.status(200).json({
        success: true,
        message: 'Excel file already stored',
        data: recentDuplicate,
      });
    }

    const excelFile = await CrmExcelFile.create({
      companyId,
      fileName,
      fileSize: fileSize || '',
      fileSizeBytes: fileSizeBytes || 0,
      totalRowsFetched: Number(totalRowsFetched) || 0,
      totalCompanies: Number(totalCompanies) || 0,
      newCount: Number(newCount) || 0,
      updateCount: Number(updateCount) || 0,
      duplicateCount: Number(duplicateCount) || 0,
      importMode: importMode || 'all',
      importedBy: displayName,
      importedByUserId: req.user?._id || null,
      status: 'Imported',
      fileData: fileData || '',
    });

    logCrmAudit({
      companyId,
      userId: req.user?._id,
      userName: displayName,
      action: 'upload',
      entityType: 'lead',
      entityId: excelFile._id,
      entityTitle: fileName,
      description: `Imported Excel file "${fileName}" (${totalRowsFetched || 0} rows fetched, ${newCount || 0} new, ${updateCount || 0} updated)`,
      ipAddress: req.ip,
    });

    res.status(201).json({
      success: true,
      message: 'Excel file stored successfully',
      data: excelFile,
    });
  } catch (error) {
    next(error);
  }
};

// @desc Get stored Excel files with pagination and search
// @route GET /api/crm/data/excel-files
const getExcelFiles = async (req, res, next) => {
  try {
    const companyId = getTenantId(req);
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.max(1, Math.min(100, parseInt(req.query.limit, 10) || 10));
    const search = req.query.search ? String(req.query.search).trim() : '';

    const query = { companyId, isDeleted: false };
    if (search) {
      query.$or = [
        { fileName: { $regex: search, $options: 'i' } },
        { importedBy: { $regex: search, $options: 'i' } },
      ];
    }

    const total = await CrmExcelFile.countDocuments(query);
    const totalPages = Math.ceil(total / limit) || 1;

    // Projection excludes heavy fileData for list view to keep responses fast
    const files = await CrmExcelFile.find(query)
      .select('-fileData')
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .lean();

    res.json({
      success: true,
      data: files,
      pagination: {
        page,
        limit,
        total,
        totalPages,
      },
    });
  } catch (error) {
    next(error);
  }
};

// @desc Get single Excel file with data for download
// @route GET /api/crm/data/excel-files/:id
const getExcelFileById = async (req, res, next) => {
  try {
    const companyId = getTenantId(req);
    const { id } = req.params;

    const file = await CrmExcelFile.findOne({ _id: id, companyId, isDeleted: false }).lean();
    if (!file) {
      return res.status(404).json({ success: false, message: 'Excel file record not found' });
    }

    res.json({
      success: true,
      data: file,
    });
  } catch (error) {
    next(error);
  }
};

// @desc Delete stored Excel file
// @route DELETE /api/crm/data/excel-files/:id
const deleteExcelFile = async (req, res, next) => {
  try {
    const companyId = getTenantId(req);
    const { id } = req.params;

    const file = await CrmExcelFile.findOne({ _id: id, companyId });
    if (!file) {
      return res.status(404).json({ success: false, message: 'Excel file record not found' });
    }

    file.isDeleted = true;
    await file.save();

    res.json({
      success: true,
      message: 'Excel file record deleted successfully',
    });
  } catch (error) {
    next(error);
  }
};

module.exports = {
  importData,
  exportData,
  mergeDuplicates,
  getImportData,
  getImportDataById,
  syncImportData,
  updateImportDataStatus,
  logImportDataActivity,
  updateImportDataActivity,
  getImportDataActivities,
  scheduleImportDataFollowUp,
  getRepPerformanceSummary,
  getRepActivities,
  saveExcelFile,
  getExcelFiles,
  getExcelFileById,
  deleteExcelFile,
};
