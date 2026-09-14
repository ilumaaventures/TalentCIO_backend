const CrmPipeline = require('../models/crmPipeline.model');

const getTenantId = (req) => req.companyId || req.user?.companyId;

// @desc Get pipelines
// @route GET /api/crm/pipelines
const getPipelines = async (req, res, next) => {
  try {
    const companyId = getTenantId(req);
    let pipelines = await CrmPipeline.find({ companyId }).sort({ isDefault: -1, createdAt: 1 });

    // If no pipeline exists yet, bootstrap a default sales pipeline
    if (!pipelines || pipelines.length === 0) {
      const defaultPipeline = await CrmPipeline.create({
        companyId,
        name: 'Standard Sales Pipeline',
        isDefault: true,
        stages: [
          { name: 'Lead', probability: 10, color: '#94a3b8', order: 0, isWon: false, isLost: false },
          { name: 'Qualified', probability: 30, color: '#3b82f6', order: 1, isWon: false, isLost: false },
          { name: 'Discovery / Demo', probability: 50, color: '#a855f7', order: 2, isWon: false, isLost: false },
          { name: 'Proposal / Quote', probability: 70, color: '#eab308', order: 3, isWon: false, isLost: false },
          { name: 'Negotiation', probability: 85, color: '#f97316', order: 4, isWon: false, isLost: false },
          { name: 'Closed Won', probability: 100, color: '#22c55e', order: 5, isWon: true, isLost: false },
          { name: 'Closed Lost', probability: 0, color: '#ef4444', order: 6, isWon: false, isLost: true },
        ],
      });
      pipelines = [defaultPipeline];
    }

    res.json({ success: true, data: pipelines });
  } catch (error) {
    next(error);
  }
};

// @desc Create pipeline
// @route POST /api/crm/pipelines
const createPipeline = async (req, res, next) => {
  try {
    const companyId = getTenantId(req);
    const pipeline = await CrmPipeline.create({
      ...req.body,
      companyId,
    });
    res.status(201).json({ success: true, message: 'Pipeline created', data: pipeline });
  } catch (error) {
    next(error);
  }
};

// @desc Update pipeline & stages
// @route PUT /api/crm/pipelines/:id
const updatePipeline = async (req, res, next) => {
  try {
    const companyId = getTenantId(req);
    if (req.body.isDefault) {
      await CrmPipeline.updateMany(
        { companyId },
        { isDefault: false }
      );
    }
    const pipeline = await CrmPipeline.findOneAndUpdate(
      { _id: req.params.id, companyId },
      req.body,
      { new: true }
    );
    if (!pipeline) return res.status(404).json({ success: false, message: 'Pipeline not found' });
    res.json({ success: true, message: 'Pipeline updated', data: pipeline });
  } catch (error) {
    next(error);
  }
};

// @desc Delete pipeline
// @route DELETE /api/crm/pipelines/:id
const deletePipeline = async (req, res, next) => {
  try {
    const companyId = getTenantId(req);
    const pipeline = await CrmPipeline.findOne({ _id: req.params.id, companyId });
    if (!pipeline) return res.status(404).json({ success: false, message: 'Pipeline not found' });
    if (pipeline.isDefault) {
      return res.status(400).json({ success: false, message: 'Cannot delete the default sales pipeline.' });
    }
    await CrmPipeline.deleteOne({ _id: pipeline._id });
    res.json({ success: true, message: 'Pipeline deleted successfully' });
  } catch (error) {
    next(error);
  }
};

module.exports = {
  getPipelines,
  createPipeline,
  updatePipeline,
  deletePipeline,
};
