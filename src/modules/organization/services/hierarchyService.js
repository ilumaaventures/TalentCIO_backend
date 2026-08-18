const mongoose = require('mongoose');
const User = require('../../user/user.model');
const Department = require('../models/department.model');
const Designation = require('../models/designation.model');
const BusinessUnit = require('../../business-unit/businessUnit.model');

/**
 * Returns direct reports for a specific manager within a company.
 */
const getDirectReports = async (userId, companyId, { includeInactive = false } = {}) => {
    if (!userId || !companyId) return [];

    const query = {
        companyId,
        isDeleted: { $ne: true },
        reportingManagers: new mongoose.Types.ObjectId(userId)
    };

    if (!includeInactive) {
        query.isActive = true;
    }

    return await User.find(query)
        .select('_id firstName lastName email department departmentRef designationRef profilePicture isActive reportingManagers employeeCode')
        .populate('departmentRef', 'name code')
        .populate('designationRef', 'title level')
        .lean();
};

/**
 * Returns all downstream reports recursively (BFS with depth & cycle protection).
 */
const getAllReports = async (userId, companyId, { maxDepth = 25, includeInactive = false } = {}) => {
    if (!userId || !companyId) return [];

    const targetUserIdStr = String(userId);
    const query = {
        companyId,
        isDeleted: { $ne: true }
    };
    if (!includeInactive) {
        query.isActive = true;
    }

    const allUsers = await User.find(query)
        .select('_id firstName lastName email department departmentRef designationRef profilePicture isActive reportingManagers employeeCode')
        .populate('departmentRef', 'name code')
        .populate('designationRef', 'title level')
        .lean();

    // Build manager -> reports adjacency map
    const reportsMap = new Map();
    for (const u of allUsers) {
        const primaryMgr = u.reportingManagers?.[0] ? String(u.reportingManagers[0]) : null;
        if (primaryMgr) {
            if (!reportsMap.has(primaryMgr)) reportsMap.set(primaryMgr, []);
            reportsMap.get(primaryMgr).push(u);
        }
    }

    const downstream = [];
    const visited = new Set([targetUserIdStr]);
    const queue = [{ id: targetUserIdStr, depth: 0 }];

    while (queue.length > 0) {
        const { id, depth } = queue.shift();
        if (depth >= maxDepth) continue;

        const children = reportsMap.get(id) || [];
        for (const child of children) {
            const childIdStr = String(child._id);
            if (!visited.has(childIdStr)) {
                visited.add(childIdStr);
                downstream.push(child);
                queue.push({ id: childIdStr, depth: depth + 1 });
            }
        }
    }

    return downstream;
};

/**
 * Ascends upward through the primary manager chain.
 */
const getManagerChain = async (userId, companyId) => {
    if (!userId || !companyId) return [];

    const allUsers = await User.find({ companyId, isDeleted: { $ne: true } })
        .select('_id firstName lastName email department departmentRef designationRef profilePicture isActive reportingManagers employeeCode')
        .populate('departmentRef', 'name code')
        .populate('designationRef', 'title level')
        .lean();

    const userMap = new Map(allUsers.map((u) => [String(u._id), u]));
    const chain = [];
    const visited = new Set([String(userId)]);

    let current = userMap.get(String(userId));
    while (current && current.reportingManagers?.length > 0) {
        const primaryMgrId = String(current.reportingManagers[0]);
        if (visited.has(primaryMgrId)) {
            // Cycle guard
            break;
        }
        visited.add(primaryMgrId);

        const manager = userMap.get(primaryMgrId);
        if (!manager) break;

        const secondaryManagers = (current.reportingManagers.slice(1) || [])
            .map((id) => userMap.get(String(id)))
            .filter(Boolean);

        chain.push({
            ...manager,
            secondaryManagers
        });

        current = manager;
    }

    return chain;
};

/**
 * Checks whether setting proposedManagerId for userId would create a circular reporting chain.
 * Returns true if a cycle WOULD be created (i.e. assignment is invalid).
 */
const detectCycle = async (userId, proposedManagerId, companyId) => {
    if (!userId || !proposedManagerId) return false;
    const userIdStr = String(userId);
    const proposedManagerIdStr = String(proposedManagerId);

    // Self-reporting is a cycle
    if (userIdStr === proposedManagerIdStr) return true;

    // Check if userId is already an ancestor of proposedManagerId
    const managerChain = await getManagerChain(proposedManagerIdStr, companyId);
    return managerChain.some((mgr) => String(mgr._id) === userIdStr);
};

/**
 * Constructs an in-memory org chart tree/forest for a company.
 */
const getOrgTree = async (companyId, {
    rootUserId = null,
    departmentId = null,
    businessUnitId = null,
    search = '',
    includeInactive = false
} = {}) => {
    const userQuery = { companyId, isDeleted: { $ne: true } };
    if (!includeInactive) {
        userQuery.isActive = true;
    }

    const allUsers = await User.find(userQuery)
        .select('_id firstName lastName email department departmentRef designationRef profilePicture isActive reportingManagers employeeCode')
        .populate('departmentRef', 'name code businessUnit')
        .populate('designationRef', 'title level')
        .lean();

    const userMap = new Map(allUsers.map((u) => [String(u._id), u]));
    const childrenMap = new Map();

    for (const u of allUsers) {
        const primaryMgrId = u.reportingManagers?.[0] ? String(u.reportingManagers[0]) : null;
        if (primaryMgrId && userMap.has(primaryMgrId) && primaryMgrId !== String(u._id)) {
            if (!childrenMap.has(primaryMgrId)) childrenMap.set(primaryMgrId, []);
            childrenMap.get(primaryMgrId).push(u);
        }
    }

    // Helper to calculate total downstream count and build node recursively
    const buildNode = (u, visitedInBranch = new Set()) => {
        const uId = String(u._id);
        if (visitedInBranch.has(uId)) {
            return null; // Cycle guard
        }
        const nextVisited = new Set(visitedInBranch).add(uId);

        const rawChildren = childrenMap.get(uId) || [];
        const children = [];
        let totalDownstream = 0;

        for (const child of rawChildren) {
            const childNode = buildNode(child, nextVisited);
            if (childNode) {
                children.push(childNode);
                totalDownstream += 1 + (childNode.totalDownstreamCount || 0);
            }
        }

        const secondaryManagerIds = (u.reportingManagers || []).slice(1).map(String);
        const secondaryManagers = secondaryManagerIds
            .map((id) => userMap.get(id))
            .filter(Boolean)
            .map((sm) => ({
                _id: sm._id,
                firstName: sm.firstName,
                lastName: sm.lastName,
                email: sm.email
            }));

        return {
            _id: u._id,
            firstName: u.firstName,
            lastName: u.lastName,
            email: u.email,
            employeeCode: u.employeeCode || '',
            profilePicture: u.profilePicture || '',
            isActive: u.isActive !== false,
            department: u.departmentRef?.name || u.department || 'Unassigned',
            departmentId: u.departmentRef?._id || null,
            businessUnitId: u.departmentRef?.businessUnit || null,
            designation: u.designationRef?.title || 'Team Member',
            designationId: u.designationRef?._id || null,
            grade: u.designationRef?.level || '',
            primaryManagerId: u.reportingManagers?.[0] || null,
            secondaryManagers,
            directReportsCount: children.length,
            totalDownstreamCount: totalDownstream,
            children
        };
    };

    let rootCandidates = [];

    if (rootUserId && userMap.has(String(rootUserId))) {
        rootCandidates = [userMap.get(String(rootUserId))];
    } else {
        // Find all roots: users with no primary manager, or whose manager is not in the active dataset
        for (const u of allUsers) {
            const primaryMgrId = u.reportingManagers?.[0] ? String(u.reportingManagers[0]) : null;
            if (!primaryMgrId || !userMap.has(primaryMgrId) || primaryMgrId === String(u._id)) {
                rootCandidates.push(u);
            }
        }
    }

    let tree = rootCandidates.map((r) => buildNode(r)).filter(Boolean);

    // Apply department or business unit filtering if requested
    if (departmentId || businessUnitId || (search && search.trim())) {
        const matchesFilter = (node) => {
            let match = true;
            if (departmentId && String(node.departmentId) !== String(departmentId)) {
                match = false;
            }
            if (businessUnitId && String(node.businessUnitId) !== String(businessUnitId)) {
                match = false;
            }
            if (search && search.trim()) {
                const s = search.trim().toLowerCase();
                const fullName = `${node.firstName || ''} ${node.lastName || ''}`.toLowerCase();
                const email = (node.email || '').toLowerCase();
                const desig = (node.designation || '').toLowerCase();
                if (!fullName.includes(s) && !email.includes(s) && !desig.includes(s)) {
                    match = false;
                }
            }
            return match;
        };

        // Filter tree preserving ancestor paths if a descendant matches
        const pruneTree = (node) => {
            const isSelfMatch = matchesFilter(node);
            const filteredChildren = (node.children || []).map(pruneTree).filter(Boolean);

            if (isSelfMatch || filteredChildren.length > 0) {
                return {
                    ...node,
                    children: filteredChildren,
                    isMatch: isSelfMatch
                };
            }
            return null;
        };

        tree = tree.map(pruneTree).filter(Boolean);
    }

    return {
        totalEmployees: allUsers.length,
        rootCount: tree.length,
        tree
    };
};

/**
 * Summary stats for headcount, department distribution, and span-of-control.
 */
const getOrgStats = async (companyId) => {
    const allUsers = await User.find({ companyId, isDeleted: { $ne: true } })
        .select('_id firstName lastName department departmentRef designationRef isActive reportingManagers')
        .populate('departmentRef', 'name')
        .populate('designationRef', 'title level')
        .lean();

    const activeUsers = allUsers.filter((u) => u.isActive !== false);
    const departmentCounts = {};
    const managerReportCounts = {};

    for (const u of activeUsers) {
        const deptName = u.departmentRef?.name || u.department || 'Unassigned';
        departmentCounts[deptName] = (departmentCounts[deptName] || 0) + 1;

        if (u.reportingManagers?.[0]) {
            const mgrId = String(u.reportingManagers[0]);
            managerReportCounts[mgrId] = (managerReportCounts[mgrId] || 0) + 1;
        }
    }

    const managersCount = Object.keys(managerReportCounts).length;
    const totalReportsAcrossManagers = Object.values(managerReportCounts).reduce((a, b) => a + b, 0);
    const avgSpanOfControl = managersCount > 0 ? (totalReportsAcrossManagers / managersCount).toFixed(1) : 0;

    return {
        totalHeadcount: activeUsers.length,
        inactiveCount: allUsers.length - activeUsers.length,
        managersCount,
        averageSpanOfControl: Number(avgSpanOfControl),
        departmentDistribution: Object.entries(departmentCounts).map(([department, count]) => ({
            department,
            count
        }))
    };
};

module.exports = {
    getDirectReports,
    getAllReports,
    getManagerChain,
    detectCycle,
    getOrgTree,
    getOrgStats
};
