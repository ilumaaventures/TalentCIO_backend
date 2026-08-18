const mongoose = require('mongoose');
const User = require('../../user/user.model');
const EmployeeProfile = require('../../dossier/employeeProfile.model');
const hierarchyService = require('../services/hierarchyService');

/**
 * Get organization tree/forest with optional filtering.
 */
const getOrgChart = async (req, res) => {
    try {
        const { companyId } = req;
        const { rootUserId, departmentId, businessUnitId, search, includeInactive } = req.query;

        const result = await hierarchyService.getOrgTree(companyId, {
            rootUserId,
            departmentId,
            businessUnitId,
            search,
            includeInactive: includeInactive === 'true'
        });

        res.json(result);
    } catch (error) {
        console.error('getOrgChart error:', error);
        res.status(500).json({ message: error.message || 'Failed to retrieve org chart' });
    }
};

/**
 * Get employee's upward manager chain and downward direct reports.
 */
const getEmployeeReportingLine = async (req, res) => {
    try {
        const companyId = req.companyId || req.user?.companyId;
        const { userId } = req.params;

        const user = await User.findOne({ _id: userId, companyId, isDeleted: { $ne: true } })
            .select('_id firstName lastName email department departmentRef designationRef profilePicture isActive reportingManagers employeeCode')
            .populate('departmentRef', 'name code')
            .populate('designationRef', 'title level')
            .lean();

        if (!user) {
            return res.status(404).json({ message: 'Employee not found' });
        }

        const [managerChain, directReports] = await Promise.all([
            hierarchyService.getManagerChain(userId, companyId),
            hierarchyService.getDirectReports(userId, companyId)
        ]);

        res.json({
            user,
            managerChain,
            directReports
        });
    } catch (error) {
        console.error('getEmployeeReportingLine error:', error);
        res.status(500).json({ message: error.message || 'Failed to fetch reporting line' });
    }
};

/**
 * Update reporting manager(s) for an employee with cycle prevention.
 */
const updateReportingManager = async (req, res) => {
    try {
        const companyId = req.companyId || req.user?.companyId;
        const { userId } = req.params;
        const { reportingManagers, managerId } = req.body;

        const targetUser = await User.findOne({ _id: userId, companyId, isDeleted: { $ne: true } });
        if (!targetUser) {
            return res.status(404).json({ message: 'User not found' });
        }

        let newReportingManagers = [];
        if (Array.isArray(reportingManagers)) {
            newReportingManagers = reportingManagers
                .map((id) => (typeof id === 'object' && id?._id ? id._id : id))
                .filter((id) => mongoose.Types.ObjectId.isValid(id));
        } else if (managerId) {
            const rawId = typeof managerId === 'object' && managerId?._id ? managerId._id : managerId;
            if (mongoose.Types.ObjectId.isValid(rawId)) {
                newReportingManagers = [rawId];
            }
        }

        const primaryManagerId = newReportingManagers[0] || null;

        if (primaryManagerId) {
            const hasCycle = await hierarchyService.detectCycle(userId, primaryManagerId, companyId);
            if (hasCycle) {
                return res.status(400).json({
                    message: 'Cannot assign this manager: a circular reporting relationship would be created.',
                    code: 'CIRCULAR_REPORTING_LINE'
                });
            }

            // Verify manager exists in same company
            const managerExists = await User.findOne({ _id: primaryManagerId, companyId, isDeleted: { $ne: true } }).select('_id');
            if (!managerExists) {
                return res.status(400).json({ message: 'Selected manager does not exist in this organization' });
            }
        }

        targetUser.reportingManagers = newReportingManagers;
        await targetUser.save();

        // Sync primary manager to EmployeeProfile
        try {
            await EmployeeProfile.updateOne(
                { user: userId, companyId },
                { $set: { 'employment.reportingManager': primaryManagerId } }
            );
        } catch (profileErr) {
            console.error('Failed to sync reportingManager to EmployeeProfile:', profileErr);
        }

        const updatedUser = await User.findById(userId)
            .select('_id firstName lastName email department departmentRef designationRef profilePicture isActive reportingManagers')
            .populate('departmentRef', 'name code')
            .populate('designationRef', 'title level')
            .populate('reportingManagers', 'firstName lastName email profilePicture');

        res.json({
            message: 'Reporting manager updated successfully',
            user: updatedUser
        });
    } catch (error) {
        console.error('updateReportingManager error:', error);
        res.status(500).json({ message: error.message || 'Failed to update reporting manager' });
    }
};

/**
 * Get organization summary statistics.
 */
const getOrgStats = async (req, res) => {
    try {
        const { companyId } = req;
        const stats = await hierarchyService.getOrgStats(companyId);
        res.json(stats);
    } catch (error) {
        console.error('getOrgStats error:', error);
        res.status(500).json({ message: error.message || 'Failed to retrieve org stats' });
    }
};

module.exports = {
    getOrgChart,
    getEmployeeReportingLine,
    updateReportingManager,
    getOrgStats
};
