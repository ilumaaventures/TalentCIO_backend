const CrmDeal = require('../models/crmDeal.model');
const CrmPipeline = require('../models/crmPipeline.model');
const CrmActivity = require('../models/crmActivity.model');
const CrmTask = require('../models/crmTask.model');
const CrmFollowUp = require('../models/crmFollowUp.model');
const { CrmCommissionRecord, CrmCommissionRule } = require('../models/crmCommission.model');
const { logCrmAudit } = require('../utils/crmAudit');

const getTenantId = (req) => req.companyId || req.user?.companyId;

const getUserDisplayName = (user) => {
  if (!user) return 'System';
  if (user.firstName) return `${user.firstName} ${user.lastName || ''}`.trim();
  return user.name || user.email || 'User';
};

// Compute deal risk level dynamically
const computeDealRisk = (deal) => {
  const reasons = [];
  const now = new Date();

  // 1. Close date passed
  if (deal.status === 'Open' && deal.expectedCloseDate && new Date(deal.expectedCloseDate) < now) {
    reasons.push('Expected close date has passed');
  }

  // 2. Inactivity over 14 days
  const lastAct = deal.lastActivityAt ? new Date(deal.lastActivityAt) : new Date(deal.createdAt);
  const diffDays = Math.floor((now - lastAct) / (1000 * 60 * 60 * 24));
  if (deal.status === 'Open' && diffDays >= 14) {
    reasons.push(`No sales activity in ${diffDays} days`);
  }

  // 3. Stage stall over 21 days
  const stageAge = deal.stageChangedAt ? Math.floor((now - new Date(deal.stageChangedAt)) / (1000 * 60 * 60 * 24)) : 0;
  if (deal.status === 'Open' && stageAge >= 21) {
    reasons.push(`Stalled in current stage for ${stageAge} days`);
  }

  let riskLevel = 'Low';
  if (reasons.length >= 2) riskLevel = 'High';
  else if (reasons.length === 1) riskLevel = 'Medium';

  return { riskLevel, riskReasons: reasons, daysInCurrentStage: stageAge };
};

// @desc Get deals with filters, search, and pagination
// @route GET /api/crm/deals
const getDeals = async (req, res, next) => {
  try {
    const companyId = getTenantId(req);
    const {
      pipelineId,
      stage,
      status = 'Open',
      forecastCategory,
      ownerId,
      search,
      page = 1,
      limit = 50,
      sortBy = 'createdAt',
      sortOrder = 'desc',
    } = req.query;

    const query = { companyId };

    if (status && status !== 'all') {
      query.status = status;
    }
    if (pipelineId && pipelineId !== 'all') {
      query.pipelineId = pipelineId;
    }
    if (stage && stage !== 'all') {
      query.stage = stage;
    }
    if (forecastCategory && forecastCategory !== 'all') {
      query.forecastCategory = forecastCategory;
    }
    if (ownerId && ownerId !== 'all') {
      query.ownerId = ownerId;
    }

    if (search) {
      query.title = new RegExp(search, 'i');
    }

    const total = await CrmDeal.countDocuments(query);
    const deals = await CrmDeal.find(query)
      .populate('accountId', 'name industry healthScore')
      .populate('contactId', 'firstName lastName email phone')
      .populate('ownerId', 'firstName lastName email profilePicture')
      .sort({ [sortBy]: sortOrder === 'asc' ? 1 : -1 })
      .skip((page - 1) * limit)
      .limit(Number(limit));

    const enrichedDeals = deals.map(d => {
      const { riskLevel, riskReasons, daysInCurrentStage } = computeDealRisk(d);
      return {
        ...d.toObject(),
        riskLevel,
        riskReasons,
        daysInCurrentStage,
      };
    });

    res.json({
      success: true,
      data: enrichedDeals,
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

// @desc Get pipeline board view (Kanban) with aggregated stats
// @route GET /api/crm/deals/pipeline-board
const getPipelineBoard = async (req, res, next) => {
  try {
    const companyId = getTenantId(req);
    const { pipelineId, ownerId } = req.query;

    let pipeline;
    if (pipelineId && pipelineId !== 'all') {
      pipeline = await CrmPipeline.findOne({ _id: pipelineId, companyId });
    } else {
      pipeline = await CrmPipeline.findOne({ companyId, isDefault: true }) ||
        await CrmPipeline.findOne({ companyId });
    }

    if (!pipeline) {
      return res.status(404).json({ success: false, message: 'Pipeline not found' });
    }

    const dealQuery = {
      companyId,
      pipelineId: pipeline._id,
      status: 'Open',
    };

    if (ownerId && ownerId !== 'all') {
      dealQuery.ownerId = ownerId;
    }

    const deals = await CrmDeal.find(dealQuery)
      .populate('accountId', 'name industry healthScore')
      .populate('contactId', 'firstName lastName email phone')
      .populate('ownerId', 'firstName lastName email profilePicture')
      .sort({ value: -1 });

    const columns = pipeline.stages.map(stage => {
      const stageDeals = deals
        .filter(d => d.stage.toLowerCase() === stage.name.toLowerCase())
        .map(d => {
          const { riskLevel, riskReasons, daysInCurrentStage } = computeDealRisk(d);
          return { ...d.toObject(), riskLevel, riskReasons, daysInCurrentStage };
        });

      const stageTotal = stageDeals.reduce((sum, d) => sum + (d.value || 0), 0);
      const weightedTotal = Math.round(stageTotal * (stage.probability / 100));

      return {
        id: stage._id,
        name: stage.name,
        probability: stage.probability,
        color: stage.color,
        isWon: stage.isWon,
        isLost: stage.isLost,
        order: stage.order,
        count: stageDeals.length,
        totalValue: stageTotal,
        weightedValue: weightedTotal,
        deals: stageDeals,
      };
    });

    const totalPipelineValue = deals.reduce((sum, d) => sum + (d.value || 0), 0);
    const totalWeightedValue = columns.reduce((sum, c) => sum + c.weightedValue, 0);

    res.json({
      success: true,
      pipeline: {
        id: pipeline._id,
        name: pipeline.name,
        isDefault: pipeline.isDefault,
      },
      summary: {
        totalDeals: deals.length,
        totalPipelineValue,
        totalWeightedValue,
      },
      columns,
    });
  } catch (error) {
    next(error);
  }
};

// @desc Get single deal by ID with activities & tasks
// @route GET /api/crm/deals/:id
const getDealById = async (req, res, next) => {
  try {
    const companyId = getTenantId(req);
    const deal = await CrmDeal.findOne({ _id: req.params.id, companyId })
      .populate('accountId', 'name industry website phone healthScore')
      .populate('contactId', 'firstName lastName email phone jobTitle')
      .populate('ownerId', 'firstName lastName email profilePicture roles')
      .populate('pipelineId', 'name stages');

    if (!deal) {
      return res.status(404).json({ success: false, message: 'Deal not found' });
    }

    const { riskLevel, riskReasons, daysInCurrentStage } = computeDealRisk(deal);

    const activities = await CrmActivity.find({ dealId: deal._id, companyId })
      .sort({ performedAt: -1 })
      .limit(50);
    const tasks = await CrmTask.find({ dealId: deal._id, companyId })
      .sort({ dueDate: 1 });
    const followUps = await CrmFollowUp.find({ dealId: deal._id, companyId })
      .sort({ scheduledDate: 1 });

    res.json({
      success: true,
      data: {
        deal: {
          ...deal.toObject(),
          riskLevel,
          riskReasons,
          daysInCurrentStage,
        },
        activities,
        tasks,
        followUps,
      },
    });
  } catch (error) {
    next(error);
  }
};

// @desc Create new deal
// @route POST /api/crm/deals
const createDeal = async (req, res, next) => {
  try {
    const companyId = getTenantId(req);
    let pipeline = null;

    if (req.body.pipelineId) {
      pipeline = await CrmPipeline.findOne({ _id: req.body.pipelineId, companyId });
    }
    if (!pipeline) {
      pipeline = await CrmPipeline.findOne({ companyId, isDefault: true }) ||
        await CrmPipeline.findOne({ companyId });
    }

    if (!pipeline) {
      return res.status(400).json({ success: false, message: 'No pipeline available. Please create a pipeline first.' });
    }

    const stageName = req.body.stage || pipeline.stages[0]?.name || 'Qualified';
    const stageObj = pipeline.stages.find(s => s.name.toLowerCase() === stageName.toLowerCase());

    const dealData = {
      ...req.body,
      companyId,
      pipelineId: pipeline._id,
      stage: stageName,
      probability: req.body.probability !== undefined ? req.body.probability : (stageObj ? stageObj.probability : 20),
      ownerId: req.body.ownerId || req.user?._id,
      expectedCloseDate: req.body.expectedCloseDate || new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      accountId: req.body.accountId || req.body.companyId,
    };

    const deal = await CrmDeal.create(dealData);
    const actorName = getUserDisplayName(req.user);

    await CrmActivity.create({
      companyId,
      type: 'note',
      subject: `Deal created: ${deal.title}`,
      description: `Opportunity added to pipeline '${pipeline.name}' at stage '${stageName}'`,
      performedBy: req.user?._id,
      performedByName: actorName,
      dealId: deal._id,
      accountId: deal.accountId,
      contactId: deal.contactId,
    });

    await logCrmAudit({
      companyId,
      userId: req.user?._id,
      action: 'CREATE_DEAL',
      entityType: 'Deal',
      entityId: deal._id,
      entityName: deal.title,
      ipAddress: req.ip,
    });

    res.status(201).json({
      success: true,
      message: 'Deal created successfully',
      data: deal,
    });
  } catch (error) {
    next(error);
  }
};

// @desc Move deal stage (Kanban drag-and-drop or stage selector)
// @route PATCH /api/crm/deals/:id/stage
const updateDealStage = async (req, res, next) => {
  try {
    const companyId = getTenantId(req);
    const { stage, winLossReason } = req.body;
    const deal = await CrmDeal.findOne({ _id: req.params.id, companyId });

    if (!deal) {
      return res.status(404).json({ success: false, message: 'Deal not found' });
    }

    const pipeline = await CrmPipeline.findById(deal.pipelineId);
    const stageObj = pipeline?.stages?.find(s => s.name.toLowerCase() === stage.toLowerCase());

    const previousStage = deal.stage;
    deal.stage = stage;
    deal.stageChangedAt = new Date();
    deal.daysInCurrentStage = 0;
    deal.lastActivityAt = new Date();

    if (stageObj) {
      deal.probability = stageObj.probability;
      if (stageObj.isWon) {
        deal.status = 'Won';
        deal.actualCloseDate = new Date();
        deal.forecastCategory = 'Closed';

        // Auto-compute Commission for the owner upon closing
        const rule = await CrmCommissionRule.findOne({ companyId, isActive: true });
        if (rule && deal.ownerId) {
          const rate = rule.basePercentage || 5;
          const commissionAmount = Math.round((deal.value * rate) / 100);
          await CrmCommissionRecord.create({
            companyId,
            userId: deal.ownerId,
            dealId: deal._id,
            dealTitle: deal.title,
            dealValue: deal.value,
            commissionRate: rate,
            commissionAmount,
            currency: deal.currency || 'INR',
            status: 'Pending',
          });
        }
      } else if (stageObj.isLost) {
        deal.status = 'Lost';
        deal.actualCloseDate = new Date();
        deal.forecastCategory = 'Omitted';
        if (winLossReason) deal.winLossReason = winLossReason;
      } else {
        deal.status = 'Open';
      }
    }

    await deal.save();
    const actorName = getUserDisplayName(req.user);

    await CrmActivity.create({
      companyId,
      type: 'stage_change',
      subject: `Stage updated: ${stage}`,
      description: `Deal '${deal.title}' moved from '${previousStage}' to '${stage}'`,
      performedBy: req.user?._id,
      performedByName: actorName,
      dealId: deal._id,
      accountId: deal.accountId,
    });

    res.json({
      success: true,
      message: `Deal moved to ${stage}`,
      data: deal,
    });
  } catch (error) {
    next(error);
  }
};

// @desc Update deal
// @route PUT /api/crm/deals/:id
const updateDeal = async (req, res, next) => {
  try {
    const companyId = getTenantId(req);
    const updates = { ...req.body, lastActivityAt: new Date() };

    const deal = await CrmDeal.findOneAndUpdate(
      { _id: req.params.id, companyId },
      updates,
      { new: true, runValidators: true }
    )
      .populate('accountId', 'name industry healthScore')
      .populate('contactId', 'firstName lastName email phone')
      .populate('ownerId', 'firstName lastName email profilePicture');

    if (!deal) {
      return res.status(404).json({ success: false, message: 'Deal not found' });
    }

    await logCrmAudit({
      companyId,
      userId: req.user?._id,
      action: 'UPDATE_DEAL',
      entityType: 'Deal',
      entityId: deal._id,
      entityName: deal.title,
      changes: updates,
      ipAddress: req.ip,
    });

    res.json({
      success: true,
      message: 'Deal updated successfully',
      data: deal,
    });
  } catch (error) {
    next(error);
  }
};

// @desc Delete deal
// @route DELETE /api/crm/deals/:id
const deleteDeal = async (req, res, next) => {
  try {
    const companyId = getTenantId(req);
    const deal = await CrmDeal.findOneAndDelete({ _id: req.params.id, companyId });
    if (!deal) {
      return res.status(404).json({ success: false, message: 'Deal not found' });
    }

    await logCrmAudit({
      companyId,
      userId: req.user?._id,
      action: 'DELETE_DEAL',
      entityType: 'Deal',
      entityId: deal._id,
      entityName: deal.title,
      ipAddress: req.ip,
    });

    res.json({ success: true, message: 'Deal deleted successfully' });
  } catch (error) {
    next(error);
  }
};

module.exports = {
  getDeals,
  getPipelineBoard,
  getDealById,
  createDeal,
  updateDealStage,
  updateDeal,
  deleteDeal,
};
