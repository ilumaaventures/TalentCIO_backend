const mongoose = require('mongoose');
const BusinessUnit = require('../../business-unit/businessUnit.model');
const Department = require('../models/department.model');
const Project = require('../../project/project.model');
const { isDuplicateCaseInsensitive } = require('../utils/orgValidation');

/**
 * List all business units for a company.
 */
const getBusinessUnits = async (req, res) => {
    try {
        const companyId = req.companyId || req.user?.companyId;
        const units = await BusinessUnit.find({ companyId, isDeleted: { $ne: true } })
            .populate('headOfUnit', 'firstName lastName email profilePicture')
            .sort({ name: 1 })
            .lean();

        res.json(units);
    } catch (error) {
        console.error('getBusinessUnits error:', error);
        res.status(500).json({ message: error.message || 'Failed to list business units' });
    }
};

/**
 * Get single business unit by ID.
 */
const getBusinessUnit = async (req, res) => {
    try {
        const companyId = req.companyId || req.user?.companyId;
        const { id } = req.params;

        const unit = await BusinessUnit.findOne({ _id: id, companyId, isDeleted: { $ne: true } })
            .populate('headOfUnit', 'firstName lastName email profilePicture')
            .lean();

        if (!unit) {
            return res.status(404).json({ message: 'Business Unit not found' });
        }

        res.json(unit);
    } catch (error) {
        console.error('getBusinessUnit error:', error);
        res.status(500).json({ message: error.message || 'Failed to fetch business unit' });
    }
};

/**
 * Create a new business unit.
 */
const createBusinessUnit = async (req, res) => {
    try {
        const { companyId } = req;
        const { name, headOfUnit, description } = req.body;

        if (!name || !name.trim()) {
            return res.status(400).json({ message: 'Business Unit name is required' });
        }

        const isDuplicate = await isDuplicateCaseInsensitive(BusinessUnit, {
            companyId,
            field: 'name',
            value: name
        });

        if (isDuplicate) {
            return res.status(400).json({ message: `A business unit named "${name.trim()}" already exists.` });
        }

        const unit = new BusinessUnit({
            name: name.trim(),
            companyId,
            headOfUnit: headOfUnit || null,
            description: description ? description.trim() : ''
        });

        await unit.save();

        const populated = await BusinessUnit.findById(unit._id)
            .populate('headOfUnit', 'firstName lastName email profilePicture');

        res.status(201).json(populated);
    } catch (error) {
        console.error('createBusinessUnit error:', error);
        res.status(500).json({ message: error.message || 'Failed to create business unit' });
    }
};

/**
 * Update a business unit.
 */
const updateBusinessUnit = async (req, res) => {
    try {
        const companyId = req.companyId || req.user?.companyId;
        const { id } = req.params;
        const { name, headOfUnit, description } = req.body;

        const unit = await BusinessUnit.findOne({ _id: id, companyId, isDeleted: { $ne: true } });
        if (!unit) {
            return res.status(404).json({ message: 'Business Unit not found' });
        }

        if (name && name.trim()) {
            const isDuplicate = await isDuplicateCaseInsensitive(
                BusinessUnit,
                'name',
                name.trim(),
                companyId,
                id
            );

            if (isDuplicate) {
                return res.status(409).json({ message: 'A business unit with this name already exists in your organization' });
            }
            unit.name = name.trim();
        }

        if (headOfUnit !== undefined) {
            unit.headOfUnit = headOfUnit && mongoose.Types.ObjectId.isValid(headOfUnit) ? headOfUnit : null;
        }

        if (description !== undefined) {
            unit.description = description ? description.trim() : '';
        }

        await unit.save();

        const populated = await BusinessUnit.findById(unit._id)
            .populate('headOfUnit', 'firstName lastName email profilePicture');

        res.json({ message: 'Business Unit updated successfully', unit: populated });
    } catch (error) {
        console.error('updateBusinessUnit error:', error);
        res.status(500).json({ message: error.message || 'Failed to update business unit' });
    }
};

/**
 * Soft delete a business unit with dependency check.
 */
const deleteBusinessUnit = async (req, res) => {
    try {
        const companyId = req.companyId || req.user?.companyId;
        const { id } = req.params;
        const { force } = req.query;

        const unit = await BusinessUnit.findOne({ _id: id, companyId, isDeleted: { $ne: true } });
        if (!unit) {
            return res.status(404).json({ message: 'Business Unit not found' });
        }

        // Check attached projects
        const projectCount = await Project.countDocuments({ companyId, businessUnit: id, isDeleted: { $ne: true } });
        if (projectCount > 0 && force !== 'true') {
            return res.status(400).json({
                message: `Cannot delete business unit: ${projectCount} project(s) are attached to this business unit.`,
                code: 'HAS_ASSIGNED_PROJECTS',
                projectCount
            });
        }

        // Check attached departments
        const departmentCount = await Department.countDocuments({ companyId, businessUnit: id, isDeleted: { $ne: true } });
        if (departmentCount > 0 && force !== 'true') {
            return res.status(400).json({
                message: `Cannot delete business unit: ${departmentCount} department(s) are attached to this business unit.`,
                code: 'HAS_ASSIGNED_DEPARTMENTS',
                departmentCount
            });
        }

        await unit.softDelete(req.user?._id);
        res.json({ message: 'Business Unit deleted successfully', id });
    } catch (error) {
        console.error('deleteBusinessUnit error:', error);
        res.status(500).json({ message: error.message || 'Failed to delete business unit' });
    }
};

/**
 * Restore soft-deleted business unit.
 */
const restoreBusinessUnit = async (req, res) => {
    try {
        const { companyId } = req;
        const { id } = req.params;

        const unit = await BusinessUnit.findOne({ _id: id, companyId, isDeleted: true });
        if (!unit) {
            return res.status(404).json({ message: 'Deleted business unit not found' });
        }

        await unit.restore();
        res.json({ message: 'Business Unit restored successfully', unit });
    } catch (error) {
        console.error('restoreBusinessUnit error:', error);
        res.status(500).json({ message: error.message || 'Failed to restore business unit' });
    }
};

module.exports = {
    getBusinessUnits,
    getBusinessUnit,
    createBusinessUnit,
    updateBusinessUnit,
    deleteBusinessUnit,
    restoreBusinessUnit
};
