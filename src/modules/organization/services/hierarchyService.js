const mongoose = require('mongoose');
const User = require('../../user/user.model');
const Department = require('../models/department.model');
const Designation = require('../models/designation.model');
const BusinessUnit = require('../../business-unit/businessUnit.model');
const Company = require('../../company/company.model');

/**
 * Returns direct reports for a specific manager within a company (strictly workforce members).
 */
const getDirectReports = async (userId, companyId, { includeInactive = false } = {}) => {
    if (!userId || !companyId) return [];

    const query = {
        companyId,
        isDeleted: { $ne: true },
        isTotalWorkforce: { $ne: false },
        reportingManagers: new mongoose.Types.ObjectId(userId)
    };

    if (!includeInactive) {
        query.isActive = true;
    }

    return await User.find(query)
        .select('_id firstName lastName email department departmentRef designationRef profilePicture isActive reportingManagers employeeCode employmentType')
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
        isDeleted: { $ne: true },
        isTotalWorkforce: { $ne: false }
    };
    if (!includeInactive) {
        query.isActive = true;
    }

    const allUsers = await User.find(query)
        .select('_id firstName lastName email department departmentRef designationRef profilePicture isActive reportingManagers employeeCode employmentType')
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

    const allUsers = await User.find({
        companyId,
        isDeleted: { $ne: true },
        isTotalWorkforce: { $ne: false }
    })
        .select('_id firstName lastName email department departmentRef designationRef profilePicture isActive reportingManagers employeeCode employmentType')
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
 * Resolves the Total Workforce users and company hierarchy context.
 * Strictly adheres to the dashboard calculation:
 * - isActive: true (or all non-deleted if includeInactive is true)
 * - isDeleted: { $ne: true }
 * - Excludes primary admin system user (matching company email or oldest system account with isSystem: true)
 * - Excludes users where isTotalWorkforce === false
 */
const getWorkforceContext = async (companyId, { includeInactive = false } = {}) => {
    const companyObjectId = mongoose.Types.ObjectId.isValid(companyId)
        ? new mongoose.Types.ObjectId(companyId)
        : companyId;

    const matchQuery = {
        companyId: companyObjectId,
        isDeleted: { $ne: true }
    };
    if (!includeInactive) {
        matchQuery.isActive = true;
    }

    const [usersResult, company] = await Promise.all([
        User.aggregate([
            { $match: matchQuery },
            {
                $lookup: {
                    from: 'roles',
                    localField: 'roles',
                    foreignField: '_id',
                    as: 'rolesResolved',
                    pipeline: [{ $project: { name: 1, isSystem: 1 } }]
                }
            },
            {
                $project: {
                    _id: 1,
                    email: 1,
                    createdAt: 1,
                    firstName: 1,
                    lastName: 1,
                    reportingManagers: 1,
                    employmentType: 1,
                    isTotalWorkforce: 1,
                    roles: '$rolesResolved',
                    isSystemUser: {
                        $gt: [
                            { $size: { $filter: { input: '$rolesResolved', as: 'r', cond: { $eq: ['$$r.isSystem', true] } } } },
                            0
                        ]
                    }
                }
            }
        ]),
        Company.findById(companyId).select('email').lean()
    ]);

    const primaryAdminEmail = company?.email?.toLowerCase();
    const systemUsers = usersResult.filter((u) => u.isSystemUser);
    const oldestSystemUser = systemUsers.sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt))[0];
    const oldestSystemUserId = oldestSystemUser?._id?.toString();

    const filteredUsers = usersResult.filter((u) => {
        const isMatchByEmail   = u.email?.toLowerCase() === primaryAdminEmail;
        const isMatchByOldest  = u._id?.toString() === oldestSystemUserId;
        const isPrimaryAccount = isMatchByEmail || isMatchByOldest;
        return !(u.isSystemUser && isPrimaryAccount);
    });

    const totalWorkforceUsers = filteredUsers.filter((u) => u.isTotalWorkforce !== false);
    const totalWorkforceUserIdsSet = new Set(totalWorkforceUsers.map((u) => String(u._id)));
    const allUsersBasicMap = new Map(usersResult.map((u) => [String(u._id), u]));

    return {
        totalWorkforceUsers,
        totalWorkforceUserIdsSet,
        allUsersBasicMap,
        filteredUsers
    };
};

/**
 * Normalizes and checks if a node's employment type matches any selected types.
 */
const matchesEmploymentType = (nodeTypeRaw, selectedTypes = []) => {
    if (!Array.isArray(selectedTypes) || selectedTypes.length === 0) return true;
    const nodeType = (nodeTypeRaw || 'Full Time').trim().toLowerCase();

    return selectedTypes.some((selected) => {
        const sel = String(selected).trim().toLowerCase();
        if (!sel) return false;
        if (sel === 'employee') return nodeType === 'employee' || nodeType === 'full time';
        if (sel === 'full time') return nodeType === 'full time' || nodeType === 'employee';
        if (sel === 'advisor' || sel === 'advisors') return nodeType.includes('advisor');
        if (sel === 'trainee' || sel === 'tranee') return nodeType.includes('trainee') || nodeType.includes('tranee');
        if (sel === 'consultant') return nodeType.includes('consultant');
        if (sel === 'intern') return nodeType.includes('intern');
        if (sel === 'probation') return nodeType.includes('probation');
        if (sel === 'part time') return nodeType.includes('part time');
        if (sel === 'contract') return nodeType.includes('contract');
        if (sel === 'freelance') return nodeType.includes('freelance');
        return nodeType === sel || nodeType.includes(sel);
    });
};

/**
 * Finds the nearest manager up the reporting chain who belongs to the target dataset.
 * Bypasses intermediate unselected accounts gracefully so subordinate links are preserved.
 */
const getEffectiveWorkforceManagerId = (user, allUsersBasicMap, targetUserIdsSet) => {
    let current = user;
    const visited = new Set([String(user._id)]);
    while (current && current.reportingManagers && current.reportingManagers.length > 0) {
        const mgrId = String(current.reportingManagers[0]);
        if (visited.has(mgrId)) break;
        visited.add(mgrId);

        if (targetUserIdsSet.has(mgrId)) {
            return mgrId;
        }
        current = allUsersBasicMap.get(mgrId);
    }
    return null;
};

/**
 * Constructs an in-memory org chart tree/forest for a company.
 * - By default (no employment type filter): Strictly shows Total Workforce members.
 * - When employment type filter is specified: Pulls in matching users (including non-workforce
 *   users such as consultants, interns, trainees, etc.) and prunes tree accordingly.
 */
const getOrgTree = async (companyId, {
    rootUserId = null,
    departmentId = null,
    businessUnitId = null,
    search = '',
    includeInactive = false,
    employmentTypes = [],
    showReportingManagers = false
} = {}) => {
    const {
        totalWorkforceUsers,
        totalWorkforceUserIdsSet,
        allUsersBasicMap,
        filteredUsers
    } = await getWorkforceContext(
        companyId,
        { includeInactive }
    );

    const hasEmploymentTypesFilter = Array.isArray(employmentTypes) && employmentTypes.length > 0;

    // By default (when no employment type filter is set), strictly include Total Workforce members.
    // If employment types filter is active:
    // - When showReportingManagers is false (default): strictly include only matching users for the selected type(s).
    // - When showReportingManagers is true: include matching users AND their upward reporting manager chain.
    const targetUserIdsSet = new Set();
    if (hasEmploymentTypesFilter) {
        const matchingUsers = filteredUsers.filter((u) => matchesEmploymentType(u.employmentType, employmentTypes));
        for (const u of matchingUsers) {
            targetUserIdsSet.add(String(u._id));
        }

        if (showReportingManagers) {
            for (const u of matchingUsers) {
                let curr = u;
                const visitedChain = new Set([String(u._id)]);
                while (curr && curr.reportingManagers && curr.reportingManagers.length > 0) {
                    const primaryMgrId = String(curr.reportingManagers[0]);
                    if (visitedChain.has(primaryMgrId)) break;
                    visitedChain.add(primaryMgrId);

                    if (allUsersBasicMap.has(primaryMgrId)) {
                        targetUserIdsSet.add(primaryMgrId);
                        curr = allUsersBasicMap.get(primaryMgrId);
                    } else {
                        break;
                    }
                }
            }
        }
    } else {
        for (const id of totalWorkforceUserIdsSet) {
            targetUserIdsSet.add(id);
        }
    }

    const allUsers = await User.find({
        _id: { $in: Array.from(targetUserIdsSet) }
    })
        .select('_id firstName lastName email department departmentRef designationRef profilePicture isActive reportingManagers employeeCode employmentType')
        .populate('departmentRef', 'name code businessUnit')
        .populate('designationRef', 'title level')
        .lean();

    const userMap = new Map(allUsers.map((u) => [String(u._id), u]));

    // Construct parent-child relationships with strict cycle prevention
    // Sort users by createdAt ascending so senior/earlier accounts take precedence as parents
    const sortedUsers = [...allUsers].sort((a, b) => new Date(a.createdAt || 0) - new Date(b.createdAt || 0));

    const parentMap = new Map();
    const hasPathInParentMap = (fromId, toId) => {
        let curr = fromId;
        const visited = new Set();
        while (curr && parentMap.has(curr)) {
            if (visited.has(curr)) break;
            visited.add(curr);
            curr = parentMap.get(curr);
            if (curr === toId) return true;
        }
        return false;
    };

    for (const u of sortedUsers) {
        const uId = String(u._id);
        const candidateMgrId = getEffectiveWorkforceManagerId(u, allUsersBasicMap, targetUserIdsSet);
        if (candidateMgrId && userMap.has(candidateMgrId) && candidateMgrId !== uId) {
            // Prevent cycles: only attach as child if candidateMgr is not already a descendant of uId
            if (!hasPathInParentMap(candidateMgrId, uId)) {
                parentMap.set(uId, candidateMgrId);
            }
        }
    }

    const childrenMap = new Map();
    for (const u of allUsers) {
        const uId = String(u._id);
        const parentId = parentMap.get(uId);
        if (parentId && userMap.has(parentId)) {
            if (!childrenMap.has(parentId)) childrenMap.set(parentId, []);
            childrenMap.get(parentId).push(u);
        }
    }

    const visitedGlobal = new Set();

    // Helper to calculate total downstream count and build node recursively
    const buildNode = (u, visitedInBranch = new Set()) => {
        const uId = String(u._id);
        if (visitedInBranch.has(uId)) {
            return null; // Cycle guard for current branch
        }
        visitedGlobal.add(uId);
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

        const effectivePrimaryMgrId = parentMap.get(uId) || null;
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
            employmentType: u.employmentType || 'Full Time',
            department: u.departmentRef?.name || u.department || 'Unassigned',
            departmentId: u.departmentRef?._id || null,
            businessUnitId: u.departmentRef?.businessUnit || null,
            designation: u.designationRef?.title || 'Team Member',
            designationId: u.designationRef?._id || null,
            grade: u.designationRef?.level || '',
            primaryManagerId: effectivePrimaryMgrId,
            secondaryManagers,
            directReportsCount: children.length,
            totalDownstreamCount: totalDownstream,
            children
        };
    };

    let tree = [];

    if (rootUserId && userMap.has(String(rootUserId))) {
        const rootNode = buildNode(userMap.get(String(rootUserId)));
        if (rootNode) tree.push(rootNode);
    } else {
        // 1. Natural roots: users with no parent in parentMap
        for (const u of allUsers) {
            const uId = String(u._id);
            if (!parentMap.has(uId)) {
                const node = buildNode(u);
                if (node) tree.push(node);
            }
        }

        // 2. Unvisited island/cyclic roots: ensure 100% of employees are included even if legacy data has cycles
        for (const u of allUsers) {
            const uId = String(u._id);
            if (!visitedGlobal.has(uId)) {
                const node = buildNode(u);
                if (node) tree.push(node);
            }
        }
    }

    // Sort roots so the primary organizational hierarchy (highest downstream count) is presented first
    tree.sort((a, b) => (b.totalDownstreamCount || 0) - (a.totalDownstreamCount || 0));

    // Apply department, business unit, search, or employment type filtering if requested
    if (departmentId || businessUnitId || (search && search.trim()) || hasEmploymentTypesFilter) {
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
            if (hasEmploymentTypesFilter) {
                if (!matchesEmploymentType(node.employmentType, employmentTypes)) {
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
 * Summary stats for headcount and people managers.
 * Total Headcount strictly mirrors dashboard calculation (active workforce excluding primary admin system user and non-workforce users).
 * People Managers counts active managers who are part of the total workforce and have workforce reports.
 */
const getOrgStats = async (companyId) => {
    const { totalWorkforceUsers, totalWorkforceUserIdsSet, allUsersBasicMap } = await getWorkforceContext(
        companyId,
        { includeInactive: false }
    );

    const totalHeadcount = totalWorkforceUsers.length;

    // People managers who are in the total workforce:
    // A manager must themselves be in total workforce AND have at least one active workforce subordinate reporting to them
    const managersInTotalWorkforce = new Set();
    for (const u of totalWorkforceUsers) {
        const effMgrId = getEffectiveWorkforceManagerId(u, allUsersBasicMap, totalWorkforceUserIdsSet);
        if (effMgrId && effMgrId !== String(u._id) && totalWorkforceUserIdsSet.has(effMgrId)) {
            managersInTotalWorkforce.add(effMgrId);
        }
    }

    const managersCount = managersInTotalWorkforce.size;

    return {
        totalWorkforce: totalHeadcount,
        totalHeadcount,
        totalEmployees: totalHeadcount,
        managersCount
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
