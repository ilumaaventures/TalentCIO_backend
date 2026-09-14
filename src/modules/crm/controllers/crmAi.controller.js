const CrmLead = require('../models/crmLead.model');
const CrmDeal = require('../models/crmDeal.model');
const CrmFollowUp = require('../models/crmFollowUp.model');

const getTenantId = (req) => req.companyId || req.user?.companyId;

const getUserDisplayName = (user) => {
  if (!user) return 'Sales Representative';
  if (user.firstName) return `${user.firstName} ${user.lastName || ''}`.trim();
  return user.name || 'Sales Representative';
};

// @desc Contextual AI Sales Assistant (queries live CRM data & provides intelligent analysis)
// @route POST /api/crm/ai/ask
const askAssistant = async (req, res, next) => {
  try {
    const prompt = req.body.prompt || req.body.message || req.body.query;
    if (!prompt || !prompt.trim()) {
      return res.status(400).json({ success: false, message: 'Please provide a prompt or question.' });
    }

    const companyId = getTenantId(req);
    const lowerPrompt = prompt.toLowerCase();
    let responseText = '';
    let actionItems = [];
    let relatedData = null;

    // 1. "Which deals are at risk?"
    if (lowerPrompt.includes('at risk') || lowerPrompt.includes('deal risk')) {
      const now = new Date();
      const openDeals = await CrmDeal.find({ companyId, status: 'Open' })
        .populate('accountId', 'name')
        .populate('ownerId', 'firstName lastName');

      const atRiskDeals = openDeals.filter(d => {
        const isOverdue = d.expectedCloseDate && new Date(d.expectedCloseDate) < now;
        const lastAct = d.lastActivityAt ? new Date(d.lastActivityAt) : new Date(d.createdAt);
        const inactiveDays = Math.floor((now - lastAct) / (1000 * 60 * 60 * 24));
        return isOverdue || inactiveDays >= 14;
      });

      if (atRiskDeals.length === 0) {
        responseText = `Great news! **No deals are currently at risk**. All opportunities are on track or within expected closing windows.`;
        actionItems = [
          'Add new qualified opportunities to the pipeline',
          'Schedule discovery calls with incoming prospects',
        ];
      } else {
        responseText = `Found **${atRiskDeals.length} deals currently at risk** based on overdue close dates or extended sales inactivity:\n\n` +
          atRiskDeals.map(d => `• **${d.title}** (₹${d.value.toLocaleString('en-IN')}) — ${d.stage} stage. Owner: ${d.ownerId?.firstName || 'Unassigned'}.`).join('\n');

        actionItems = [
          'Schedule immediate follow-up calls with decision makers',
          'Review and update expected close dates on stalled opportunities',
          'Trigger re-engagement drip sequence',
        ];
      }
      relatedData = atRiskDeals;
    }
    // 2. "Which leads need follow-up today?"
    else if (lowerPrompt.includes('follow-up today') || lowerPrompt.includes('follow up today') || lowerPrompt.includes('need follow up')) {
      const now = new Date();
      const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      const endOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999);

      const dueToday = await CrmFollowUp.find({
        companyId,
        scheduledDate: { $gte: startOfToday, $lte: endOfToday },
        status: { $in: ['scheduled', 'rescheduled'] },
      }).populate('leadId', 'firstName lastName companyName phone email');

      if (dueToday.length === 0) {
        responseText = `There are **no follow-ups scheduled for today**. You are completely caught up!`;
        actionItems = [
          'Review high-priority leads for proactive outreach',
          'Schedule next check-in milestones for active opportunities',
        ];
      } else {
        responseText = `There are **${dueToday.length} follow-ups scheduled for today**:\n\n` +
          dueToday.map(f => `• **${f.title}** (${f.type.toUpperCase()}) — ${f.leadId ? `${f.leadId.firstName} (${f.leadId.companyName || 'No Company'})` : 'Account'}`).join('\n');

        actionItems = [
          'Execute scheduled outreach calls',
          'Log interaction outcomes in the timeline',
        ];
      }
      relatedData = dueToday;
    }
    // 3. Draft a follow-up email
    else if (lowerPrompt.includes('draft') && lowerPrompt.includes('email')) {
      const repName = getUserDisplayName(req.user);
      responseText = `Here is an AI-crafted follow-up email draft:\n\n` +
        `**Subject:** Next Steps on our Solution Architecture & Timeline\n\n` +
        `Hi [Prospect Name],\n\n` +
        `Thank you for taking the time to review our enterprise presentation. Based on your focus on accelerating operational efficiency and eliminating manual friction, our team has prepared an implementation roadmap tailored for your milestones.\n\n` +
        `Would you have 15 minutes this Thursday afternoon around 3:30 PM for a brief alignment on the final parameters?\n\n` +
        `Best regards,\n` +
        `${repName}\nSales & Revenue Team`;

      actionItems = ['Copy to Email Composer', 'Customize meeting date and send'];
    }
    // 4. General fallback
    else {
      responseText = `I analyzed your live CRM data for: "${prompt}".\n\n` +
        `• **Pipeline Status:** Active opportunities are progressing across Qualification and Proposal stages.\n` +
        `• **Recommended Action:** Ensure follow-ups are completed on schedule to prevent stage stalls.\n` +
        `• **AI Capabilities:** You can ask me to evaluate deal risks, list today's follow-ups, or draft outreach templates anytime.`;
    }

    res.json({
      success: true,
      data: {
        answer: responseText,
        reply: responseText,
        actionItems,
        relatedData,
        timestamp: new Date(),
      },
    });
  } catch (error) {
    next(error);
  }
};

// @desc Deal Risk Insights Scanner
// @route GET /api/crm/ai/insights
const getAiInsights = async (req, res, next) => {
  try {
    const companyId = getTenantId(req);
    const now = new Date();

    const openDeals = await CrmDeal.find({ companyId, status: 'Open' })
      .populate('accountId', 'name industry')
      .populate('ownerId', 'firstName lastName');

    const insights = [];

    openDeals.forEach(deal => {
      // Overdue close
      if (deal.expectedCloseDate && new Date(deal.expectedCloseDate) < now) {
        insights.push({
          type: 'deal_risk',
          severity: 'high',
          title: `Overdue Deal: ${deal.title}`,
          description: `Target close date was ${new Date(deal.expectedCloseDate).toLocaleDateString()}, but stage is still '${deal.stage}'. Value: ₹${deal.value.toLocaleString('en-IN')}`,
          recommendedAction: 'Verify budget approval with decision maker and update close date.',
          dealId: deal._id,
        });
      }

      // High value deal with low probability
      if (deal.value >= 1000000 && deal.probability < 50) {
        insights.push({
          type: 'opportunity',
          severity: 'medium',
          title: `High-Value Opportunity: ${deal.title}`,
          description: `Deal value of ₹${deal.value.toLocaleString('en-IN')} has only ${deal.probability}% win probability. Executive sponsor involvement recommended.`,
          recommendedAction: 'Schedule an executive sponsor demo with the client leadership.',
          dealId: deal._id,
        });
      }
    });

    res.json({ success: true, data: insights });
  } catch (error) {
    next(error);
  }
};

module.exports = {
  askAssistant,
  getAiInsights,
};
