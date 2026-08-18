const mongoose = require('mongoose');
const Department = require('../models/department.model');
const User = require('../../user/user.model');
const { isDuplicateCaseInsensitive } = require('../utils/orgValidation');

/**
 * List departments for a tenant with optional filtering.
 */
const listDepartments = async (req, res) => {
    try {
        const companyId = req.companyId || req.user?.companyId;
        const { includeInactive, parentDepartment, businessUnit, search } = req.query;

        const query = { companyId, isDeleted: { $ne: true } };

        if (includeInactive !== 'true') {
            query.isActive = true;
        }

        if (parentDepartment === 'null' || parentDepartment === 'root') {
            query.parentDepartment = null;
        } else if (parentDepartment && mongoose.Types.ObjectId.isValid(parentDepartment)) {
            query.parentDepartment = parentDepartment;
        }

        if (businessUnit && mongoose.Types.ObjectId.isValid(businessUnit)) {
            query.businessUnit = businessUnit;
        }

        if (search && search.trim()) {
            query.$or = [
                { name: { $regex: search.trim(), $options: 'i' } },
                { code: { $regex: search.trim(), $options: 'i' } }
            ];
        }

        const departments = await Department.find(query)
            .populate('parentDepartment', 'name code')
            .populate('businessUnit', 'name')
            .populate('head', 'firstName lastName email profilePicture')
            .sort({ name: 1 })
            .lean();

        // Attach headcount per department
        const userCounts = await User.aggregate([
            { $match: { companyId: new mongoose.Types.ObjectId(companyId), isDeleted: { $ne: true }, isActive: true } },
            { $group: { _id: '$departmentRef', count: { $sum: 1 } } }
        ]);

        const countMap = new Map(userCounts.map((uc) => [String(uc._id), uc.count]));

        const results = departments.map((dept) => ({
            ...dept,
            employeeCount: countMap.get(String(dept._id)) || 0
        }));

        res.json(results);
    } catch (error) {
        console.error('listDepartments error:', error);
        res.status(500).json({ message: error.message || 'Failed to list departments' });
    }
};

/**
 * Returns nested parent-child department tree.
 */
const getDepartmentTree = async (req, res) => {
    try {
        const companyId = req.companyId || req.user?.companyId;
        const departments = await Department.find({ companyId, isDeleted: { $ne: true }, isActive: true })
            .populate('head', 'firstName lastName email profilePicture')
            .populate('businessUnit', 'name')
            .sort({ name: 1 })
            .lean();

        const userCounts = await User.aggregate([
            { $match: { companyId: new mongoose.Types.ObjectId(companyId), isDeleted: { $ne: true }, isActive: true } },
            { $group: { _id: '$departmentRef', count: { $sum: 1 } } }
        ]);
        const countMap = new Map(userCounts.map((uc) => [String(uc._id), uc.count]));

        const deptMap = new Map();
        for (const d of departments) {
            deptMap.set(String(d._id), {
                ...d,
                employeeCount: countMap.get(String(d._id)) || 0,
                children: []
            });
        }

        const tree = [];
        for (const d of departments) {
            const dId = String(d._id);
            const parentId = d.parentDepartment ? String(d.parentDepartment) : null;
            const node = deptMap.get(dId);

            if (parentId && deptMap.has(parentId)) {
                deptMap.get(parentId).children.push(node);
            } else {
                tree.push(node);
            }
        }

        res.json(tree);
    } catch (error) {
        console.error('getDepartmentTree error:', error);
        res.status(500).json({ message: error.message || 'Failed to retrieve department tree' });
    }
};

/**
 * Get single department by ID.
 */
const getDepartmentById = async (req, res) => {
    try {
        const companyId = req.companyId || req.user?.companyId;
        const { id } = req.params;

        const department = await Department.findOne({ _id: id, companyId, isDeleted: { $ne: true } })
            .populate('parentDepartment', 'name code')
            .populate('businessUnit', 'name')
            .populate('head', 'firstName lastName email profilePicture')
            .lean();

        if (!department) {
            return res.status(404).json({ message: 'Department not found' });
        }

        const employeeCount = await User.countDocuments({ companyId, departmentRef: id, isDeleted: { $ne: true }, isActive: true });
        res.json({ ...department, employeeCount });
    } catch (error) {
        console.error('getDepartmentById error:', error);
        res.status(500).json({ message: error.message || 'Failed to fetch department' });
    }
};

/**
 * Create a new department.
 */
const createDepartment = async (req, res) => {
    try {
        const { companyId } = req;
        const { name, code, parentDepartment, businessUnit, head, description, isActive } = req.body;

        if (!name || !name.trim()) {
            return res.status(400).json({ message: 'Department name is required' });
        }

        const isDuplicate = await isDuplicateCaseInsensitive(Department, {
            companyId,
            field: 'name',
            value: name
        });

        if (isDuplicate) {
            return res.status(400).json({ message: `A department named "${name.trim()}" already exists.` });
        }

        const department = new Department({
            name: name.trim(),
            code: code ? code.trim().toUpperCase() : undefined,
            companyId,
            parentDepartment: parentDepartment || null,
            businessUnit: businessUnit || null,
            head: head || null,
            description: description ? description.trim() : '',
            isActive: isActive !== false
        });

        await department.save();

        const populated = await Department.findById(department._id)
            .populate('parentDepartment', 'name code')
            .populate('businessUnit', 'name')
            .populate('head', 'firstName lastName email profilePicture');

        res.status(201).json(populated);
    } catch (error) {
        console.error('createDepartment error:', error);
        res.status(500).json({ message: error.message || 'Failed to create department' });
    }
};

/**
 * Update an existing department.
 */
const updateDepartment = async (req, res) => {
    try {
        const { companyId } = req;
        const { id } = req.params;
        const { name, code, parentDepartment, businessUnit, head, description, isActive } = req.body;

        const department = await Department.findOne({ _id: id, companyId, isDeleted: false });
        if (!department) {
            return res.status(404).json({ message: 'Department not found' });
        }

        if (name && name.trim()) {
            const isDuplicate = await isDuplicateCaseInsensitive(Department, {
                companyId,
                field: 'name',
                value: name,
                excludeId: id
            });

            if (isDuplicate) {
                return res.status(400).json({ message: `A department named "${name.trim()}" already exists.` });
            }
            department.name = name.trim();
        }

        if (code !== undefined) {
            department.code = code ? code.trim().toUpperCase() : '';
        }

        if (parentDepartment !== undefined) {
            if (parentDepartment && String(parentDepartment) === String(id)) {
                return res.status(400).json({ message: 'A department cannot be its own parent.' });
            }
            department.parentDepartment = parentDepartment || null;
        }

        if (businessUnit !== undefined) {
            department.businessUnit = businessUnit || null;
        }

        if (head !== undefined) {
            department.head = head || null;
        }

        if (description !== undefined) {
            department.description = description ? description.trim() : '';
        }

        if (isActive !== undefined) {
            department.isActive = Boolean(isActive);
        }

        await department.save();

        const populated = await Department.findById(department._id)
            .populate('parentDepartment', 'name code')
            .populate('businessUnit', 'name')
            .populate('head', 'firstName lastName email profilePicture');

        res.json(populated);
    } catch (error) {
        console.error('updateDepartment error:', error);
        res.status(500).json({ message: error.message || 'Failed to update department' });
    }
};

/**
 * Soft delete a department (with dependency safety).
 */
const deleteDepartment = async (req, res) => {
    try {
        const companyId = req.companyId || req.user?.companyId;
        const { id } = req.params;
        const { force } = req.query;

        const department = await Department.findOne({ _id: id, companyId, isDeleted: { $ne: true } });
        if (!department) {
            return res.status(404).json({ message: 'Department not found' });
        }

        // Dependency check 1: Active child departments
        const childCount = await Department.countDocuments({ companyId, parentDepartment: id, isDeleted: { $ne: true } });
        if (childCount > 0 && force !== 'true') {
            return res.status(400).json({
                message: `Cannot delete department: ${childCount} sub-department(s) are still attached. Please reassign or delete them first.`,
                code: 'HAS_CHILD_DEPARTMENTS',
                childCount
            });
        }

        // Dependency check 2: Active employees assigned
        const userCount = await User.countDocuments({ companyId, departmentRef: id, isDeleted: { $ne: true } });
        if (userCount > 0 && force !== 'true') {
            return res.status(400).json({
                message: `Cannot delete department: ${userCount} employee(s) are currently assigned to this department. Please reassign them first.`,
                code: 'HAS_ASSIGNED_EMPLOYEES',
                userCount
            });
        }

        await department.softDelete(req.user?._id);
        res.json({ message: 'Department deleted successfully', id });
    } catch (error) {
        console.error('deleteDepartment error:', error);
        res.status(500).json({ message: error.message || 'Failed to delete department' });
    }
};

/**
 * Restore soft-deleted department.
 */
const restoreDepartment = async (req, res) => {
    try {
        const companyId = req.companyId || req.user?.companyId;
        const { id } = req.params;

        const department = await Department.findOne({ _id: id, companyId, isDeleted: true });
        if (!department) {
            return res.status(404).json({ message: 'Deleted department not found' });
        }

        await department.restore();
        res.json({ message: 'Department restored successfully', department });
    } catch (error) {
        console.error('restoreDepartment error:', error);
        res.status(500).json({ message: error.message || 'Failed to restore department' });
    }
};

module.exports = {
    listDepartments,
    getDepartmentTree,
    getDepartmentById,
    createDepartment,
    updateDepartment,
    deleteDepartment,
    restoreDepartment
};
