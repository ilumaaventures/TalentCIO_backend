const mongoose = require('mongoose');
const User = require('../../user/user.model');
const EmployeeProfile = require('../../dossier/employeeProfile.model');
const hierarchyService = require('../services/hierarchyService');

const isGlobalOrgViewer = (user) => {
    const userRoles = (user?.roles || []).map((r) => (typeof r === 'string' ? r : r?.name));
    return (
        userRoles.some((r) => ['Admin', 'Super Admin', 'System Admin'].includes(r))
        || (user?.permissions || []).includes('org_chart.view')
        || (user?.permissions || []).includes('*')
        || Boolean(user?.hasAllPermissions)
    );
};

/**
 * Get organization tree/forest with optional filtering.
 * If user has full permission (org_chart.view / Admin), returns complete company tree.
 * Otherwise, scopes strictly to the user and their subordinates (downstream reports).
 */
const getOrgChart = async (req, res) => {
    try {
        const companyId = req.companyId || req.user?.companyId;
        const { rootUserId, departmentId, businessUnitId, search, includeInactive } = req.query;

        const isGlobal = isGlobalOrgViewer(req.user);
        // If not global viewer, enforce root to the logged-in user so they only see themselves and their subordinates
        const effectiveRootUserId = isGlobal ? rootUserId : String(req.user?._id);

        const result = await hierarchyService.getOrgTree(companyId, {
            rootUserId: effectiveRootUserId,
            departmentId: isGlobal ? departmentId : undefined,
            businessUnitId: isGlobal ? businessUnitId : undefined,
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

        const isGlobal = isGlobalOrgViewer(req.user);
        const loggedInUserId = String(req.user?._id);

        if (!isGlobal && String(userId) !== loggedInUserId) {
            // Verify if target user is in logged-in user's downstream reports
            const downstream = await hierarchyService.getAllReports(loggedInUserId, companyId, { includeInactive: true });
            const isSubordinate = downstream.some((d) => String(d._id) === String(userId));
            if (!isSubordinate) {
                return res.status(403).json({ message: 'You can only view reporting lines for yourself and your subordinates.' });
            }
        }

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
        const companyId = req.companyId || req.user?.companyId;
        const isGlobal = isGlobalOrgViewer(req.user);

        if (isGlobal) {
            const stats = await hierarchyService.getOrgStats(companyId);
            return res.json(stats);
        }

        const [directReports, allReports] = await Promise.all([
            hierarchyService.getDirectReports(req.user?._id, companyId),
            hierarchyService.getAllReports(req.user?._id, companyId)
        ]);

        res.json({
            totalEmployees: 1 + allReports.length,
            activeEmployees: 1 + allReports.filter((r) => r.isActive !== false).length,
            totalDepartments: new Set(allReports.map((r) => r.departmentRef?._id || r.department).filter(Boolean)).size,
            totalDesignations: new Set(allReports.map((r) => r.designationRef?._id || r.designation).filter(Boolean)).size,
            rootNodesCount: 1,
            directReportsCount: directReports.length
        });
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
