const CrmCampaign = require('../models/crmCampaign.model');

const getTenantId = (req) => req.companyId || req.user?.companyId;

// @desc Get campaigns
// @route GET /api/crm/campaigns
const getCampaigns = async (req, res, next) => {
  try {
    const companyId = getTenantId(req);
    const campaigns = await CrmCampaign.find({ companyId }).sort({ createdAt: -1 });
    res.json({ success: true, data: campaigns });
  } catch (error) {
    next(error);
  }
};

// @desc Create campaign
// @route POST /api/crm/campaigns
const createCampaign = async (req, res, next) => {
  try {
    const companyId = getTenantId(req);
    const campaign = await CrmCampaign.create({
      ...req.body,
      companyId,
    });
    res.status(201).json({ success: true, message: 'Campaign created', data: campaign });
  } catch (error) {
    next(error);
  }
};

module.exports = {
  getCampaigns,
  createCampaign,
};
