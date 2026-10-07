const mongoose = require('mongoose');
const User = require('../../user/user.model');
const CrmLead = require('../models/crmLead.model');
const CrmImportData = require('../models/crmImportData.model');
const CrmDeal = require('../models/crmDeal.model');
const CrmContact = require('../models/crmContact.model');
const CrmAccount = require('../models/crmAccount.model');
const CrmActivity = require('../models/crmActivity.model');
const CrmFollowUp = require('../models/crmFollowUp.model');
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
    const TABLE_FIELDS = 'rowId sNo companyName industry status leadStatus leadSource source date createdAt importedBy importedByUserId isConvertedToLead leadId isDuplicate duplicateReason rating contactPerson designation mobileNo emailId address remarks';
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

      return {
        id: r.rowId || String(r._id),
        _id: r._id,
        sNo: r.sNo || '',
        companyName: r.companyName || '',
        industry: r.industry || '',
        status: r.status || r.leadStatus || (hasActiveLead ? 'Converted to Lead' : 'New'),
        date: r.date,
        leadStatus: r.leadStatus || r.status || '',
        source: r.leadSource || r.source || '',
        leadSource: r.leadSource || r.source || '',
        importedBy: finalImportedBy,
        importedByUserId: finalImportedByUserId,
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

      const setFields = {
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
        status: (item.status || item.leadStatus || 'New').trim(),
        leadStatus: (item.status || item.leadStatus || 'New').trim(),
        source: (item.source || item.leadSource || 'Website').trim(),
        leadSource: (item.source || item.leadSource || 'Website').trim(),
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
      const decoded = Buffer.from(raw, 'base64').toString('utf8');
      const [compName = '', mobile = '', email = ''] = decoded.split('|');

      const query = { companyId };
      const trimmedComp = compName.trim();
      const trimmedMobile = mobile.trim();
      const trimmedEmail = email.trim();

      if (trimmedComp && trimmedMobile) {
        query.companyName = new RegExp(`^${trimmedComp.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i');
        query.mobileNo = trimmedMobile;
      } else if (trimmedComp) {
        query.companyName = new RegExp(`^${trimmedComp.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i');
      } else if (trimmedMobile) {
        query.mobileNo = trimmedMobile;
      } else if (trimmedEmail) {
        query.emailId = trimmedEmail;
      }

      row = await CrmImportData.findOne(query);
      if (row) return row;

      // 4. Auto-persist row if it only existed in local workspace
      if (req) {
        row = await CrmImportData.create({
          companyId,
          rowId: id,
          companyName: trimmedComp || 'Prospect',
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
    } = req.body;

    const row = await resolveImportDataProspect(companyId, id, req);
    if (!row) {
      return res.status(404).json({ success: false, message: 'Prospect record not found' });
    }

    const repName = getUserDisplayName(req.user);
    const userId = req.user?._id;

    // Update the row's interaction counters & last contacted status
    const incField = {};
    if (type === 'call') incField.callCount = 1;
    else if (type === 'whatsapp') incField.whatsappCount = 1;
    else if (type === 'email') incField.emailCount = 1;

    const updateData = {
      lastContactedAt: new Date(),
      lastContactedBy: repName,
      lastContactedByUserId: userId,
      lastOutcome: outcome,
      lastCallType: callType,
    };

    const updatedRow = await CrmImportData.findByIdAndUpdate(
      row._id,
      {
        $set: updateData,
        $inc: Object.keys(incField).length > 0 ? incField : {},
      },
      { new: true }
    );

    // Create the CrmActivity record
    const activity = await CrmActivity.create({
      companyId,
      importDataId: row._id,
      leadId: row.leadId || null,
      type,
      subject: subject || `${type.toUpperCase()} with ${row.contactPerson || row.companyName || 'Prospect'}`,
      description,
      outcome,
      durationMinutes: Number(durationMinutes) || 0,
      callType,
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
    const { status } = req.body;

    if (!status) {
      return res.status(400).json({ success: false, message: 'Status is required' });
    }

    const row = await resolveImportDataProspect(companyId, id, req);
    if (!row) {
      return res.status(404).json({ success: false, message: 'Prospect record not found' });
    }

    const trimmedStatus = String(status).trim();
    row.status = trimmedStatus;
    row.leadStatus = trimmedStatus;
    await row.save();

    res.json({
      success: true,
      message: 'Status updated successfully',
      data: { id: row.rowId || String(row._id), status: trimmedStatus },
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
  getImportDataActivities,
  scheduleImportDataFollowUp,
  getRepPerformanceSummary,
  getRepActivities,
};
