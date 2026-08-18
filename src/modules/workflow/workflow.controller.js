const mongoose = require('mongoose');
const ApprovalWorkflow = require('../workflow/approvalWorkflow.model');

const mapLevel = (l) => {
    const isObjectId = l.role && mongoose.Types.ObjectId.isValid(l.role) && String(new mongoose.Types.ObjectId(l.role)) === String(l.role);
    return {
        levelCheck: Number(l.levelCheck) || 1,
        role: isObjectId ? l.role : null,
        roleName: typeof l.role === 'string' && !isObjectId ? l.role : (l.roleName || ''),
        approvers: l.approvers || [],
        isFinal: Boolean(l.isFinal)
    };
};

const handleWorkflowWriteError = (error, res) => {
    if (error?.code === 11000) {
        return res.status(409).json({
            message: 'A workflow with this name already exists for this company.'
        });
    }

    console.error(error);
    return res.status(500).json({ message: 'Server Error', error: error.message });
};

// --- Create Workflow ---
exports.createWorkflow = async (req, res) => {
    try {
        const { name, description, levels, module, isActive } = req.body;

        const workflow = await ApprovalWorkflow.create({
            companyId: req.companyId,
            name,
            description,
            levels: (levels || []).map(mapLevel),
            module: module || 'TA', // Default to TA if not provided
            isActive: isActive !== false,
            createdBy: req.user._id
        });

        res.status(201).json(workflow);
    } catch (error) {
        handleWorkflowWriteError(error, res);
    }
};

// --- Get All Workflows ---
exports.getWorkflows = async (req, res) => {
    try {
        const query = {};
        if (req.query.module) {
            query.module = req.query.module;
        }

        const workflows = await ApprovalWorkflow.find({ ...query, companyId: req.companyId })
            .populate('levels.role', 'name')
            .populate('levels.approvers', 'firstName lastName email');
        res.status(200).json(workflows);
    } catch (error) {
        console.error(error);
        res.status(500).json({ message: 'Server Error', error: error.message });
    }
};

// --- Get Single Workflow ---
exports.getWorkflowById = async (req, res) => {
    try {
        const workflow = await ApprovalWorkflow.findOne({ _id: req.params.id, companyId: req.companyId })
            .populate('levels.role', 'name')
            .populate('levels.approvers', 'firstName lastName email');
        if (!workflow) return res.status(404).json({ message: 'Workflow not found' });
        res.status(200).json(workflow);
    } catch (error) {
        console.error(error);
        res.status(500).json({ message: 'Server Error', error: error.message });
    }
};

// --- Update Workflow ---
exports.updateWorkflow = async (req, res) => {
    try {
        const updateData = { ...req.body };
        if (Array.isArray(updateData.levels)) {
            updateData.levels = updateData.levels.map(mapLevel);
        }

        const workflow = await ApprovalWorkflow.findOneAndUpdate(
            { _id: req.params.id, companyId: req.companyId },
            updateData,
            { new: true, runValidators: true }
        );
        if (!workflow) return res.status(404).json({ message: 'Workflow not found' });
        res.status(200).json(workflow);
    } catch (error) {
        handleWorkflowWriteError(error, res);
    }
};

// --- Delete Workflow ---
exports.deleteWorkflow = async (req, res) => {
    try {
        const workflow = await ApprovalWorkflow.findOne({ _id: req.params.id, companyId: req.companyId });
        if (!workflow) return res.status(404).json({ message: 'Workflow not found' });
        await workflow.softDelete(req.user._id);
        res.status(200).json({ message: 'Workflow moved to bin successfully' });
    } catch (error) {
        console.error(error);
        res.status(500).json({ message: 'Server Error', error: error.message });
    }
};
