const mongoose = require('mongoose');
const Designation = require('../models/designation.model');
const User = require('../../user/user.model');
const { isDuplicateCaseInsensitive } = require('../utils/orgValidation');

/**
 * List designations for a tenant.
 */
const listDesignations = async (req, res) => {
    try {
        const companyId = req.companyId || req.user?.companyId;
        const { department, search, includeInactive } = req.query;

        const query = { companyId, isDeleted: { $ne: true } };

        if (includeInactive !== 'true') {
            query.isActive = true;
        }

        if (department && mongoose.Types.ObjectId.isValid(department)) {
            query.department = department;
        }

        if (search && search.trim()) {
            query.$or = [
                { title: { $regex: search.trim(), $options: 'i' } },
                { level: { $regex: search.trim(), $options: 'i' } }
            ];
        }

        const designations = await Designation.find(query)
            .populate('department', 'name code')
            .sort({ title: 1 })
            .lean();

        // Attach headcount per designation
        const userCounts = await User.aggregate([
            { $match: { companyId: new mongoose.Types.ObjectId(companyId), isDeleted: { $ne: true }, isActive: true } },
            { $group: { _id: '$designationRef', count: { $sum: 1 } } }
        ]);

        const countMap = new Map(userCounts.map((uc) => [String(uc._id), uc.count]));

        const results = designations.map((desig) => ({
            ...desig,
            employeeCount: countMap.get(String(desig._id)) || 0
        }));

        res.json(results);
    } catch (error) {
        console.error('listDesignations error:', error);
        res.status(500).json({ message: error.message || 'Failed to list designations' });
    }
};

/**
 * Get designation by ID.
 */
const getDesignationById = async (req, res) => {
    try {
        const companyId = req.companyId || req.user?.companyId;
        const { id } = req.params;

        const designation = await Designation.findOne({ _id: id, companyId, isDeleted: { $ne: true } })
            .populate('department', 'name code')
            .lean();

        if (!designation) {
            return res.status(404).json({ message: 'Designation not found' });
        }

        const employeeCount = await User.countDocuments({ companyId, designationRef: id, isDeleted: { $ne: true }, isActive: true });
        res.json({ ...designation, employeeCount });
    } catch (error) {
        console.error('getDesignationById error:', error);
        res.status(500).json({ message: error.message || 'Failed to fetch designation' });
    }
};

/**
 * Create a new designation.
 */
const createDesignation = async (req, res) => {
    try {
        const companyId = req.companyId || req.user?.companyId;
        const { title, department, level, description } = req.body;

        if (!title || !title.trim()) {
            return res.status(400).json({ message: 'Designation title is required' });
        }

        const isDuplicate = await isDuplicateCaseInsensitive(
            Designation,
            'title',
            title.trim(),
            companyId
        );

        if (isDuplicate) {
            return res.status(409).json({ message: 'A designation with this title already exists in your organization' });
        }

        const designation = new Designation({
            title: title.trim(),
            companyId,
            department: department && mongoose.Types.ObjectId.isValid(department) ? department : null,
            level: level?.trim() || '',
            description: description?.trim() || ''
        });

        await designation.save();
        res.status(201).json({
            ...designation.toObject(),
            message: 'Designation created successfully',
            designation
        });
    } catch (error) {
        console.error('createDesignation error:', error);
        res.status(500).json({ message: error.message || 'Failed to create designation' });
    }
};

/**
 * Update an existing designation.
 */
const updateDesignation = async (req, res) => {
    try {
        const companyId = req.companyId || req.user?.companyId;
        const { id } = req.params;
        const { title, department, level, description, isActive } = req.body;

        const designation = await Designation.findOne({ _id: id, companyId, isDeleted: { $ne: true } });
        if (!designation) {
            return res.status(404).json({ message: 'Designation not found' });
        }

        if (title && title.trim() !== designation.title) {
            const isDuplicate = await isDuplicateCaseInsensitive(
                Designation,
                'title',
                title.trim(),
                companyId,
                id
            );
            if (isDuplicate) {
                return res.status(409).json({ message: 'A designation with this title already exists in your organization' });
            }
            designation.title = title.trim();
        }

        if (department !== undefined) {
            designation.department = department && mongoose.Types.ObjectId.isValid(department) ? department : null;
        }

        if (level !== undefined) designation.level = level?.trim() || '';
        if (description !== undefined) designation.description = description?.trim() || '';
        if (typeof isActive === 'boolean') designation.isActive = isActive;

        await designation.save();
        res.json({ message: 'Designation updated successfully', designation });
    } catch (error) {
        console.error('updateDesignation error:', error);
        res.status(500).json({ message: error.message || 'Failed to update designation' });
    }
};

/**
 * Soft delete a designation with dependency safety.
 */
const deleteDesignation = async (req, res) => {
    try {
        const companyId = req.companyId || req.user?.companyId;
        const { id } = req.params;
        const { force } = req.query;

        const designation = await Designation.findOne({ _id: id, companyId, isDeleted: { $ne: true } });
        if (!designation) {
            return res.status(404).json({ message: 'Designation not found' });
        }

        const userCount = await User.countDocuments({ companyId, designationRef: id, isDeleted: { $ne: true } });
        if (userCount > 0 && force !== 'true') {
            return res.status(400).json({
                message: `Cannot delete designation: ${userCount} employee(s) are currently assigned to this designation. Please reassign them first.`,
                code: 'HAS_ASSIGNED_EMPLOYEES',
                userCount
            });
        }

        await designation.softDelete(req.user?._id);
        res.json({ message: 'Designation deleted successfully', id });
    } catch (error) {
        console.error('deleteDesignation error:', error);
        res.status(500).json({ message: error.message || 'Failed to delete designation' });
    }
};

/**
 * Restore soft-deleted designation.
 */
const restoreDesignation = async (req, res) => {
    try {
        const { companyId } = req;
        const { id } = req.params;

        const designation = await Designation.findOne({ _id: id, companyId, isDeleted: true });
        if (!designation) {
            return res.status(404).json({ message: 'Deleted designation not found' });
        }

        await designation.restore();
        res.json({ message: 'Designation restored successfully', designation });
    } catch (error) {
        console.error('restoreDesignation error:', error);
        res.status(500).json({ message: error.message || 'Failed to restore designation' });
    }
};

module.exports = {
    listDesignations,
    getDesignationById,
    createDesignation,
    updateDesignation,
    deleteDesignation,
    restoreDesignation
};
