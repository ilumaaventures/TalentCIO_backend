const CrmDeal = require('../models/crmDeal.model');
const CrmTarget = require('../models/crmTarget.model');
const CrmActivity = require('../models/crmActivity.model');
const { CrmCommissionRecord } = require('../models/crmCommission.model');

/**
 * Aggregates empirical sales performance metrics for an employee.
 * This is consumed by the Employee Dossier, Performance Reviews, and CRM Leaderboards.
 * 
 * @param {string} userId - TalentCIO User ID
 * @param {string} companyId - Tenant Company ID
 * @param {number} [year] - Assessment year (default: current year)
 * @returns {Promise<Object>} Performance scorecard
 */
const getEmployeeSalesPerformance = async (userId, companyId, year = new Date().getFullYear()) => {
  // 1. Fetch sales targets for this user
  const targets = await CrmTarget.find({ companyId, userId, year });
  const totalTargetValue = targets.reduce((sum, t) => sum + (t.targetValue || 0), 0);

  // 2. Fetch all deals owned by this employee
  const deals = await CrmDeal.find({ companyId, ownerId: userId });
  const wonDeals = deals.filter(d => d.status === 'Won');
  const lostDeals = deals.filter(d => d.status === 'Lost');
  const openDeals = deals.filter(d => d.status === 'Open');

  const closedRevenue = wonDeals.reduce((sum, d) => sum + (d.value || 0), 0);
  const openPipelineValue = openDeals.reduce((sum, d) => sum + (d.value || 0), 0);
  const weightedPipelineValue = openDeals.reduce((sum, d) => sum + (d.weightedValue || 0), 0);

  // Win rate calculation
  const decidedDealsCount = wonDeals.length + lostDeals.length;
  const winRatePercent = decidedDealsCount > 0 ? Math.round((wonDeals.length / decidedDealsCount) * 100) : 0;

  // Quota attainment %
  const quotaAttainmentPercent = totalTargetValue > 0
    ? Math.round((closedRevenue / totalTargetValue) * 100)
    : (closedRevenue > 0 ? 100 : 0);

  // 3. Activity metrics (Calls, Meetings, Emails logged)
  const activities = await CrmActivity.find({ companyId, performedBy: userId });
  const callCount = activities.filter(a => a.type === 'call').length;
  const meetingCount = activities.filter(a => a.type === 'meeting').length;
  const emailCount = activities.filter(a => a.type === 'email').length;
  const noteCount = activities.filter(a => a.type === 'note').length;

  // 4. Commission metrics
  const commissions = await CrmCommissionRecord.find({ companyId, userId });
  const approvedCommissions = commissions
    .filter(c => c.status === 'Approved' || c.status === 'Paid' || c.status === 'SyncedToPayroll')
    .reduce((sum, c) => sum + (c.commissionAmount || 0), 0);
  const pendingCommissions = commissions
    .filter(c => c.status === 'Pending')
    .reduce((sum, c) => sum + (c.commissionAmount || 0), 0);

  return {
    year,
    overview: {
      totalTargetValue,
      closedRevenue,
      quotaAttainmentPercent,
      openPipelineValue,
      weightedPipelineValue,
      totalDealsCount: deals.length,
      wonDealsCount: wonDeals.length,
      lostDealsCount: lostDeals.length,
      openDealsCount: openDeals.length,
      winRatePercent,
    },
    activityIndex: {
      totalActivities: activities.length,
      calls: callCount,
      meetings: meetingCount,
      emails: emailCount,
      notes: noteCount,
    },
    commissions: {
      approvedTotal: approvedCommissions,
      pendingTotal: pendingCommissions,
      recordsCount: commissions.length,
    },
    targets,
    recentDeals: wonDeals.slice(0, 5).map(d => ({
      id: d._id,
      title: d.title,
      value: d.value,
      closeDate: d.actualCloseDate || d.updatedAt,
    })),
  };
};

module.exports = {
  getEmployeeSalesPerformance,
};
