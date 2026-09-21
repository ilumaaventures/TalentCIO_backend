const CrmLead = require('../models/crmLead.model');
const CrmImportData = require('../models/crmImportData.model');
const CrmDeal = require('../models/crmDeal.model');
const CrmContact = require('../models/crmContact.model');
const CrmAccount = require('../models/crmAccount.model');
const { logCrmAudit } = require('../utils/crmAudit');

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
              const existingLead = await CrmLead.findOne({
                companyId,
                $or: orConditions,
              }).select('companyName email phone').lean();

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

          if (isDuplicate) {
            duplicateCount++;
            duplicates.push({ row: i + 1, companyName: rawCompany, reason: dupReason });
            continue; // Skip uploading duplicate!
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

          const leadPayload = {
            ...row,
            firstName,
            lastName,
            companyName: row.companyName || '',
            jobTitle: row.jobTitle || row.designation || '',
            phone: row.phone || row.mobileNo || '',
            email: row.email || row.emailId || '',
            address,
            tags,
            source: row.source || 'Excel Import',
            notes: row.notes || row.remarks || '',
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
      changes: { total: rows.length, successCount, failedCount, duplicateCount },
    });

    const msg = duplicateCount > 0
      ? `Import complete: ${successCount} imported successfully, ${duplicateCount} duplicate(s) skipped.`
      : `Import complete: ${successCount} imported successfully, ${failedCount} failed.`;

    res.json({
      success: true,
      message: msg,
      data: { successCount, failedCount, duplicateCount, duplicates, errors },
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
      data = await CrmLead.find({ companyId }).lean();
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

    const query = { companyId, isDeleted: false };

    // Search filter across multiple fields
    if (search && search.trim()) {
      const q = search.trim();
      const regex = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
      query.$or = [
        { companyName: regex },
        { contactPerson: regex },
        { emailId: regex },
        { mobileNo: regex },
        { industry: regex },
        { address: regex },
        { remarks: regex },
        { importedBy: regex },
      ];
    }

    // Imported By user filter (supports array or comma-separated string)
    if (importedBy) {
      const names = (Array.isArray(importedBy) ? importedBy : String(importedBy).split(','))
        .map((s) => s.trim())
        .filter(Boolean);
      if (names.length > 0) {
        query.importedBy = {
          $in: names.map((n) => new RegExp(`^${n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i')),
        };
      }
    }

    // Date filters
    const now = new Date();
    if (dateFilter === 'today') {
      const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
      const endOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999).toISOString();
      query.date = { $gte: startOfDay, $lte: endOfDay };
    } else if (dateFilter === '2days') {
      const twoDaysAgo = new Date(now.getTime() - 2 * 24 * 60 * 60 * 1000).toISOString();
      query.date = { $gte: twoDaysAgo };
    } else if (dateFilter === '5days') {
      const fiveDaysAgo = new Date(now.getTime() - 5 * 24 * 60 * 60 * 1000).toISOString();
      query.date = { $gte: fiveDaysAgo };
    } else if (dateFilter === 'custom' && (fromDate || toDate)) {
      query.date = {};
      if (fromDate) query.date.$gte = new Date(fromDate).toISOString();
      if (toDate) {
        const toDateEnd = new Date(toDate);
        toDateEnd.setHours(23, 59, 59, 999);
        query.date.$lte = toDateEnd.toISOString();
      }
    }

    // Total counts in database
    const totalMatching = await CrmImportData.countDocuments(query);
    const totalAll = await CrmImportData.countDocuments({ companyId, isDeleted: false });

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

    const bulkOps = rows.map((item) => {
      const rowId = item.id || item.rowId;
      return {
        updateOne: {
          filter: { companyId, rowId },
          update: {
            $set: {
              companyId,
              rowId,
              sNo: item.sNo || '',
              companyName: (item.companyName || '').trim(),
              industry: (item.industry || '').trim(),
              address: (item.address || '').trim(),
              rating: (item.rating || '').trim(),
              contactPerson: (item.contactPerson || '').trim(),
              designation: (item.designation || '').trim(),
              mobileNo: (item.mobileNo || '').trim(),
              emailId: (item.emailId || '').trim(),
              remarks: (item.remarks || '').trim(),
              date: item.date || new Date().toISOString(),
              importedBy: (item.importedBy || userFullName || '').trim(),
              importedByUserId: item.importedByUserId || userId,
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
