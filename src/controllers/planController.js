const Plan = require('../models/Plan');

// GET /api/superadmin/plans
const getPlans = async (req, res) => {
    try {
        const plans = await Plan.find().sort({ price: 1 });
        res.json(plans);
    } catch (err) {
        res.status(500).json({ message: err.message });
    }
};

// POST /api/superadmin/plans
const createPlan = async (req, res) => {
    try {
        const plan = await Plan.create(req.body);
        res.status(201).json(plan);
    } catch (err) {
        res.status(500).json({ message: err.message });
    }
};

// PUT /api/superadmin/plans/:id
const updatePlan = async (req, res) => {
    try {
        const plan = await Plan.findByIdAndUpdate(req.params.id, req.body, { new: true, runValidators: true });
        if (!plan) return res.status(404).json({ message: 'Plan not found' });
        res.json(plan);
    } catch (err) {
        res.status(500).json({ message: err.message });
    }
};

// DELETE /api/superadmin/plans/:id
const deletePlan = async (req, res) => {
    try {
        const plan = await Plan.findByIdAndDelete(req.params.id);
        if (!plan) return res.status(404).json({ message: 'Plan not found' });
        res.json({ message: 'Plan deleted' });
    } catch (err) {
        res.status(500).json({ message: err.message });
    }
};

module.exports = { getPlans, createPlan, updatePlan, deletePlan };
