const CrmWorkflow = require('../models/crmWorkflow.model');

const getTenantId = (req) => req.companyId || req.user?.companyId;

// @desc Get workflows
// @route GET /api/crm/workflows
const getWorkflows = async (req, res, next) => {
  try {
    const companyId = getTenantId(req);
    const workflows = await CrmWorkflow.find({ companyId });
    res.json({ success: true, data: workflows });
  } catch (error) {
    next(error);
  }
};

// @desc Create workflow
// @route POST /api/crm/workflows
const createWorkflow = async (req, res, next) => {
  try {
    const companyId = getTenantId(req);
    const workflow = await CrmWorkflow.create({
      ...req.body,
      companyId,
    });
    res.status(201).json({ success: true, message: 'Workflow created', data: workflow });
  } catch (error) {
    next(error);
  }
};

// @desc Toggle workflow active status
// @route PATCH /api/crm/workflows/:id/toggle
const toggleWorkflow = async (req, res, next) => {
  try {
    const companyId = getTenantId(req);
    const workflow = await CrmWorkflow.findOne({ _id: req.params.id, companyId });
    if (!workflow) return res.status(404).json({ success: false, message: 'Workflow not found' });

    workflow.isActive = !workflow.isActive;
    await workflow.save();

    res.json({ success: true, message: `Workflow ${workflow.isActive ? 'activated' : 'paused'}`, data: workflow });
  } catch (error) {
    next(error);
  }
};

// @desc Delete workflow
// @route DELETE /api/crm/workflows/:id
const deleteWorkflow = async (req, res, next) => {
  try {
    const companyId = getTenantId(req);
    const workflow = await CrmWorkflow.findOneAndDelete({ _id: req.params.id, companyId });
    if (!workflow) return res.status(404).json({ success: false, message: 'Workflow not found' });
    res.json({ success: true, message: 'Workflow deleted successfully' });
  } catch (error) {
    next(error);
  }
};

module.exports = {
  getWorkflows,
  createWorkflow,
  toggleWorkflow,
  deleteWorkflow,
};
