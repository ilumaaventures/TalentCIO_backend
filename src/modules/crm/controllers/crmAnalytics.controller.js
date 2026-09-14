const CrmLead = require('../models/crmLead.model');
const CrmDeal = require('../models/crmDeal.model');
const CrmActivity = require('../models/crmActivity.model');
const CrmFollowUp = require('../models/crmFollowUp.model');
const CrmTarget = require('../models/crmTarget.model');
const User = require('../../user/user.model');

const getTenantId = (req) => req.companyId || req.user?.companyId;

// @desc Get main sales dashboard analytics
// @route GET /api/crm/analytics/dashboard
const getDashboardAnalytics = async (req, res, next) => {
  try {
    const companyId = getTenantId(req);

    // 1. Fetch counts & totals in parallel
    const [
      totalLeads,
      qualifiedLeads,
      openDeals,
      wonDeals,
      lostDeals,
      recentActivities,
      upcomingFollowUps,
      users,
      targets,
    ] = await Promise.all([
      CrmLead.countDocuments({ companyId }),
      CrmLead.countDocuments({ companyId, status: 'Qualified' }),
      CrmDeal.find({ companyId, status: 'Open' }),
      CrmDeal.find({ companyId, status: 'Won' }),
      CrmDeal.find({ companyId, status: 'Lost' }),
      CrmActivity.find({ companyId })
        .populate('performedBy', 'firstName lastName email profilePicture')
        .sort({ performedAt: -1 })
        .limit(10),
      CrmFollowUp.find({
        companyId,
        status: { $in: ['scheduled', 'rescheduled'] },
      })
        .populate('assignedTo', 'firstName lastName')
        .populate('leadId', 'firstName lastName companyName')
        .populate('dealId', 'title value')
        .sort({ scheduledDate: 1 })
        .limit(6),
      User.find({ companyId, isActive: true }).select('firstName lastName email profilePicture department workLocation'),
      CrmTarget.find({ companyId }),
    ]);

    // Financial KPIs
    const pipelineValue = openDeals.reduce((sum, d) => sum + (d.value || 0), 0);
    const weightedPipelineValue = openDeals.reduce((sum, d) => sum + (d.weightedValue || 0), 0);
    const wonRevenue = wonDeals.reduce((sum, d) => sum + (d.value || 0), 0);

    const totalClosed = wonDeals.length + lostDeals.length;
    const winRate = totalClosed > 0 ? Math.round((wonDeals.length / totalClosed) * 100) : 0;
    const leadConversionRate = totalLeads > 0 ? Math.round((wonDeals.length / totalLeads) * 100) : 0;

    const totalTarget = targets.reduce((sum, t) => sum + (t.targetValue || 0), 0);
    const targetAchievement = totalTarget > 0 ? Math.round((wonRevenue / totalTarget) * 100) : 0;

    // 2. Funnel metrics
    const contactedLeads = await CrmLead.countDocuments({ companyId, status: { $in: ['Contacted', 'Qualified', 'Converted'] } });
    const proposalDeals = openDeals.filter(d => ['proposal', 'quote'].some(term => d.stage.toLowerCase().includes(term))).length;
    const negotiationDeals = openDeals.filter(d => d.stage.toLowerCase().includes('negotiat')).length;

    const funnel = [
      { stage: 'Total Leads', count: totalLeads, conversion: 100 },
      { stage: 'Contacted', count: contactedLeads, conversion: totalLeads > 0 ? Math.round((contactedLeads / totalLeads) * 100) : 0 },
      { stage: 'Qualified', count: qualifiedLeads, conversion: contactedLeads > 0 ? Math.round((qualifiedLeads / contactedLeads) * 100) : 0 },
      { stage: 'Proposal / Demo', count: proposalDeals + negotiationDeals + wonDeals.length, conversion: qualifiedLeads > 0 ? Math.round(((proposalDeals + wonDeals.length) / qualifiedLeads) * 100) : 0 },
      { stage: 'Negotiation', count: negotiationDeals + wonDeals.length, conversion: (proposalDeals + wonDeals.length) > 0 ? Math.round(((negotiationDeals + wonDeals.length) / (proposalDeals + wonDeals.length)) * 100) : 0 },
      { stage: 'Closed Won', count: wonDeals.length, conversion: (negotiationDeals + wonDeals.length) > 0 ? Math.round((wonDeals.length / (negotiationDeals + wonDeals.length)) * 100) : 0 },
    ];

    // 3. Monthly Revenue Trend (Last 6 months)
    const monthlyTrend = [];
    const now = new Date();
    for (let i = 5; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      const monthName = d.toLocaleString('en-US', { month: 'short' });
      const nextMonth = new Date(now.getFullYear(), now.getMonth() - i + 1, 1);

      const monthDeals = wonDeals.filter(deal => {
        const cDate = deal.actualCloseDate ? new Date(deal.actualCloseDate) : new Date(deal.updatedAt);
        return cDate >= d && cDate < nextMonth;
      });

      monthlyTrend.push({
        month: monthName,
        revenue: monthDeals.reduce((sum, dl) => sum + (dl.value || 0), 0),
        dealsCount: monthDeals.length,
      });
    }

    res.json({
      success: true,
      data: {
        kpis: {
          pipelineValue,
          weightedPipelineValue,
          wonRevenue,
          winRate,
          leadConversionRate,
          totalTarget,
          targetAchievement,
          openDealsCount: openDeals.length,
          wonDealsCount: wonDeals.length,
          totalLeadsCount: totalLeads,
        },
        funnel,
        monthlyTrend,
        recentActivities,
        upcomingFollowUps,
        activeTeamCount: users.length,
      },
    });
  } catch (error) {
    next(error);
  }
};

module.exports = {
  getDashboardAnalytics,
};
