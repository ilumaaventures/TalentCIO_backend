const CrmLead = require('../models/crmLead.model');
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

module.exports = {
  importData,
  exportData,
  mergeDuplicates,
};
