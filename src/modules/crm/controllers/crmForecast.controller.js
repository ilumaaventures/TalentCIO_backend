const CrmDeal = require('../models/crmDeal.model');
const CrmTarget = require('../models/crmTarget.model');
const { CrmCommissionRule, CrmCommissionRecord } = require('../models/crmCommission.model');
const { getEmployeeSalesPerformance } = require('../services/crmPerformance.service');
const { logCrmAudit } = require('../utils/crmAudit');

const getTenantId = (req) => req.companyId || req.user?.companyId;

// @desc Get comprehensive sales forecast summary
// @route GET /api/crm/forecast
const getForecastSummary = async (req, res, next) => {
  try {
    const companyId = getTenantId(req);
    const deals = await CrmDeal.find({ companyId });
    const currentYear = new Date().getFullYear();
    const targets = await CrmTarget.find({ companyId, year: currentYear })
      .populate('userId', 'firstName lastName email profilePicture team');

    const categories = {
      Closed: { count: 0, value: 0, weightedValue: 0 },
      Commit: { count: 0, value: 0, weightedValue: 0 },
      'Best Case': { count: 0, value: 0, weightedValue: 0 },
      Pipeline: { count: 0, value: 0, weightedValue: 0 },
    };

    deals.forEach(deal => {
      const cat = deal.status === 'Won' ? 'Closed' : (deal.forecastCategory || 'Pipeline');
      if (categories[cat]) {
        categories[cat].count += 1;
        categories[cat].value += (deal.value || 0);
        categories[cat].weightedValue += (deal.weightedValue || 0);
      }
    });

    const totalTarget = targets.reduce((sum, t) => sum + (t.targetValue || 0), 0);
    const totalWon = categories.Closed.value;
    const totalWeightedForecast = categories.Closed.value + categories.Commit.weightedValue + categories['Best Case'].weightedValue;

    res.json({
      success: true,
      data: {
        categories,
        metrics: {
          totalTarget,
          totalWon,
          totalWeightedForecast,
          achievementPercent: totalTarget > 0 ? Math.round((totalWon / totalTarget) * 100) : 0,
        },
        targets,
      },
    });
  } catch (error) {
    next(error);
  }
};

// @desc Get targets
// @route GET /api/crm/forecast/targets
const getTargets = async (req, res, next) => {
  try {
    const companyId = getTenantId(req);
    const targets = await CrmTarget.find({ companyId })
      .populate('userId', 'firstName lastName email profilePicture team');
    res.json({ success: true, data: targets });
  } catch (error) {
    next(error);
  }
};

// @desc Create or update target
// @route POST /api/crm/forecast/targets
const createOrUpdateTarget = async (req, res, next) => {
  try {
    const companyId = getTenantId(req);
    const target = await CrmTarget.create({
      ...req.body,
      companyId,
    });
    res.status(201).json({ success: true, message: 'Target created', data: target });
  } catch (error) {
    next(error);
  }
};

// @desc Get commissions
// @route GET /api/crm/forecast/commissions
const getCommissions = async (req, res, next) => {
  try {
    const companyId = getTenantId(req);
    const records = await CrmCommissionRecord.find({ companyId })
      .populate('userId', 'firstName lastName email profilePicture')
      .populate('approvedBy', 'firstName lastName')
      .sort({ createdAt: -1 });
    const rules = await CrmCommissionRule.find({ companyId });

    res.json({ success: true, data: { records, rules } });
  } catch (error) {
    next(error);
  }
};

// @desc Approve commission record
// @route PATCH /api/crm/forecast/commissions/:id/approve
const approveCommission = async (req, res, next) => {
  try {
    const companyId = getTenantId(req);
    const record = await CrmCommissionRecord.findOneAndUpdate(
      { _id: req.params.id, companyId },
      {
        status: 'Approved',
        approvedBy: req.user?._id,
        approvedAt: new Date(),
      },
      { new: true }
    );

    if (!record) return res.status(404).json({ success: false, message: 'Commission record not found' });

    await logCrmAudit({
      companyId,
      userId: req.user?._id,
      action: 'APPROVE_COMMISSION',
      entityType: 'Commission',
      entityId: record._id,
      changes: { status: 'Approved' },
    });

    res.json({ success: true, message: 'Commission approved successfully', data: record });
  } catch (error) {
    next(error);
  }
};

// @desc Sync approved commissions to payroll
// @route POST /api/crm/forecast/commissions/sync-payroll
const syncCommissionsToPayroll = async (req, res, next) => {
  try {
    const companyId = getTenantId(req);
    const { recordIds } = req.body;
    const query = { companyId, status: 'Approved' };
    if (Array.isArray(recordIds) && recordIds.length > 0) {
      query._id = { $in: recordIds };
    }
    const approvedRecords = await CrmCommissionRecord.find(query);
    if (!approvedRecords.length) {
      return res.json({ success: true, message: 'No approved commissions found to sync', syncedCount: 0, userTotals: {} });
    }
    await CrmCommissionRecord.updateMany(query, {
      status: 'SyncedToPayroll',
      syncedAt: new Date(),
      syncedBy: req.user?._id,
    });
    const userTotals = {};
    for (const rec of approvedRecords) {
      const uid = String(rec.userId);
      userTotals[uid] = (userTotals[uid] || 0) + (rec.commissionAmount || 0);
    }
    res.json({
      success: true,
      message: `Successfully synced ${approvedRecords.length} commission records to payroll`,
      syncedCount: approvedRecords.length,
      userTotals,
    });
  } catch (error) {
    next(error);
  }
};

// @desc Get employee empirical sales performance (Used by Dossier and Appraisals)
// @route GET /api/crm/forecast/performance/:userId
const getEmployeePerformance = async (req, res, next) => {
  try {
    const companyId = getTenantId(req);
    const targetUserId = req.params.userId || req.user?._id;
    const year = Number(req.query.year) || new Date().getFullYear();

    const scorecard = await getEmployeeSalesPerformance(targetUserId, companyId, year);
    res.json({ success: true, data: scorecard });
  } catch (error) {
    next(error);
  }
};

module.exports = {
  getForecastSummary,
  getTargets,
  createOrUpdateTarget,
  getCommissions,
  approveCommission,
  syncCommissionsToPayroll,
  getEmployeePerformance,
};
