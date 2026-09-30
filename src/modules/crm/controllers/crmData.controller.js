const CrmLead = require('../models/crmLead.model');
const CrmImportData = require('../models/crmImportData.model');
const CrmDeal = require('../models/crmDeal.model');
const CrmContact = require('../models/crmContact.model');
const CrmAccount = require('../models/crmAccount.model');
const { logCrmAudit } = require('../utils/crmAudit');
const {
  canViewAllImportData,
  getImportDataOwnerFilter,
  canViewAllLeads,
  getLeadOwnerFilter,
} = require('../utils/crmScope');

const getTenantId = (req) => req.companyId || req.user?.companyId;

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
        andConditions.push({
          importedBy: {
            $in: names.map((n) => new RegExp(`^${n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i')),
          },
        });
      }
    }

    // Date filters
    const now = new Date();
    if (dateFilter === 'today') {
      const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
      const endOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999).toISOString();
      andConditions.push({ date: { $gte: startOfDay, $lte: endOfDay } });
    } else if (dateFilter === '2days') {
      const twoDaysAgo = new Date(now.getTime() - 2 * 24 * 60 * 60 * 1000).toISOString();
      andConditions.push({ date: { $gte: twoDaysAgo } });
    } else if (dateFilter === '5days') {
      const fiveDaysAgo = new Date(now.getTime() - 5 * 24 * 60 * 60 * 1000).toISOString();
      andConditions.push({ date: { $gte: fiveDaysAgo } });
    } else if (dateFilter === 'custom' && (fromDate || toDate)) {
      const dateCond = {};
      if (fromDate) dateCond.$gte = new Date(fromDate).toISOString();
      if (toDate) {
        const toDateEnd = new Date(toDate);
        toDateEnd.setHours(23, 59, 59, 999);
        dateCond.$lte = toDateEnd.toISOString();
      }
      andConditions.push({ date: dateCond });
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
    let findQuery = CrmImportData.find(query).sort({ [sortField]: sortOrder === 'asc' ? 1 : -1 });

    if (isPaginated) {
      findQuery = findQuery.skip((pageNum - 1) * limitNum).limit(limitNum);
    }

    const records = await findQuery.lean();

    // Query active leads to accurately reflect if each company is still active in CRM Leads
    const activeLeads = await CrmLead.find({ companyId, isDeleted: false })
      .select('_id companyName email phone')
      .lean();

    const activeLeadIds = new Set(activeLeads.map((l) => String(l._id)));
    const activeLeadCompNames = new Set(
      activeLeads.map((l) => (l.companyName || '').trim().toLowerCase()).filter(Boolean)
    );
    const activeLeadEmails = new Set(
      activeLeads.map((l) => (l.email || '').trim().toLowerCase()).filter(Boolean)
    );
    const activeLeadPhones = new Set(
      activeLeads.map((l) => (l.phone || '').trim()).filter(Boolean)
    );

    const mappedData = records.map((r) => {
      const comp = (r.companyName || '').trim().toLowerCase();
      const email = (r.emailId || '').trim().toLowerCase();
      const phone = (r.mobileNo || '').trim();
      const hasActiveLead = Boolean(
        (r.leadId && activeLeadIds.has(String(r.leadId))) ||
        (comp && activeLeadCompNames.has(comp)) ||
        (email && activeLeadEmails.has(email)) ||
        (phone && activeLeadPhones.has(phone))
      );

      return {
        id: r.rowId || String(r._id),
        _id: r._id,
        sNo: r.sNo || '',
        companyName: r.companyName || '',
        industry: r.industry || '',
        address: r.address || '',
        rating: r.rating || '',
        contactPerson: r.contactPerson || '',
        designation: r.designation || '',
        mobileNo: r.mobileNo || '',
        emailId: r.emailId || '',
        remarks: r.remarks || '',
        date: r.date,
        leadStatus: r.leadStatus || '',
        leadSource: r.leadSource || '',
        importedBy: r.importedBy || '',
        importedByUserId: r.importedByUserId || null,
        isConvertedToLead: hasActiveLead,
        leadId: r.leadId || null,
        isDuplicate: Boolean(r.isDuplicate),
        duplicateReason: hasActiveLead ? '' : (r.duplicateReason || ''),
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
      if (rowId) {
        contentFilter.rowId = rowId;
      } else {
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

      return {
        updateOne: {
          filter: { companyId, ...contentFilter, ...ownFilter },
          update: {
            $set: {
              companyId,
              rowId,
              sNo: item.sNo || '',
              companyName,
              industry: (item.industry || '').trim(),
              address: (item.address || '').trim(),
              rating: (item.rating || '').trim(),
              contactPerson: (item.contactPerson || '').trim(),
              designation: (item.designation || '').trim(),
              mobileNo,
              emailId,
              remarks: (item.remarks || '').trim(),
              date: item.date || new Date().toISOString(),
              leadStatus: (item.status || item.leadStatus || '').trim(),
              leadSource: (item.source || item.leadSource || '').trim(),
              importedBy: (item.importedBy || userFullName || '').trim(),
              importedByUserId: isRestricted ? userId : (item.importedByUserId || userId),
              isConvertedToLead: Boolean(item.isConvertedToLead),
              leadId: item.leadId || null,
              isDuplicate: Boolean(item.isDuplicate),
              duplicateReason: item.duplicateReason || '',
              isDeleted: false,
            },
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

module.exports = {
  importData,
  exportData,
  mergeDuplicates,
  getImportData,
  syncImportData,
};
