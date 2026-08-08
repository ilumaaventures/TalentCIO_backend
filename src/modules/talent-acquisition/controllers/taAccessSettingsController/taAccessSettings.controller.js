const User = require('../../../user/user.model');
const Role = require('../../../user/role.model');
const Permission = require('../../../user/permission.model');
const Candidate = require('../../candidate.model');
const { HiringRequest } = require('../../hiringRequest.model');
const {
    addUsersToClientRequisitions,
    mergeAssignedUsersWithClientAssignments,
    normalizeClientName,
    removeUsersFromClientRequisitions
} = require('../../../client/clientAssignmentSync');

const ADMIN_ROLE_NAMES = new Set(['Admin', 'HR', 'Super Admin', 'System Admin']);

const getRoleName = (role) => {
    if (!role) return '';
    if (typeof role === 'string') return role;
    return role.name || '';
};

const normalizeClientKey = (value) => normalizeClientName(value).toLowerCase();

const hasAnyPermission = (user, permissionKeys = []) => {
    const userPermissions = Array.isArray(user?.permissions) ? user.permissions : [];
    return permissionKeys.some((key) => userPermissions.includes(key));
};

const canViewTAAccess = (user) => {
    const roleNames = Array.isArray(user?.roles) ? user.roles.map(getRoleName).filter(Boolean) : [];
    return roleNames.some((roleName) => ADMIN_ROLE_NAMES.has(roleName))
        || hasAnyPermission(user, ['*', 'ta.config.view', 'ta.config.edit', 'ta.manage']);
};

const canManageTAAccess = (user) => {
    return hasAnyPermission(user, ['*', 'ta.config.edit', 'ta.manage']);
};

const canManageTARolePermissions = (user) => {
    return hasAnyPermission(user, ['*', 'ta.manage']);
};

const getTAAccessPermissions = async () => (
    Permission.find({
        key: { $regex: /^ta\./i },
        isDeprecated: { $ne: true }
    })
        .select('key module description isSystem')
        .sort({ key: 1 })
        .lean()
);

const buildRoleResponse = (role, taPermissionIds = new Set()) => {
    const permissions = Array.isArray(role.permissions) ? role.permissions : [];
    const taPermissions = permissions.filter((permission) => taPermissionIds.has(String(permission._id)));

    return {
        _id: role._id,
        name: role.name,
        isSystem: Boolean(role.isSystem),
        isActive: role.isActive !== false,
        taPermissions: taPermissions.map((permission) => ({
            _id: permission._id,
            key: permission.key,
            description: permission.description || ''
        }))
    };
};

const buildUserResponse = (user, requestStats = {}, interviewerStats = {}) => {
    const roleNames = Array.isArray(user.roles) ? user.roles.map((role) => role?.name).filter(Boolean) : [];
    return {
        _id: user._id,
        firstName: user.firstName || '',
        lastName: user.lastName || '',
        email: user.email || '',
        employeeCode: user.employeeCode || '',
        isActive: user.isActive !== false,
        roles: roleNames,
        taAssignedClients: Array.isArray(user.taAssignedClients) ? user.taAssignedClients : [],
        assignedRequests: requestStats.assignedRequests || 0,
        directAssignedRequests: requestStats.directAssignedRequests || 0,
        clientDerivedRequests: requestStats.clientDerivedRequests || 0,
        clientAssignments: requestStats.clientAssignments || 0,
        hiringManagerOn: requestStats.hiringManagerOn || 0,
        analyticsViewerOn: requestStats.analyticsViewerOn || 0,
        interviewRoundsAssigned: interviewerStats.interviewRoundsAssigned || 0
    };
};

const buildRequestResponse = (request, candidateSummary = {}, roundAssigneeIds = []) => ({
    _id: request._id,
    requestId: request.requestId || '',
    title: request.roleDetails?.title || 'Untitled Role',
    client: request.client || '',
    status: request.status || '',
    ownership: {
        hiringManager: request.ownership?.hiringManager || null,
        interviewPanel: Array.isArray(request.ownership?.interviewPanel) ? request.ownership.interviewPanel : []
    },
    assignedUsers: Array.isArray(request.assignedUsers) ? request.assignedUsers : [],
    analyticsViewers: Array.isArray(request.analyticsViewers) ? request.analyticsViewers : [],
    candidateCount: candidateSummary.candidateCount || 0,
    interviewRoundsCount: candidateSummary.interviewRoundsCount || 0,
    interviewerIds: roundAssigneeIds
});

exports.getOverview = async (req, res) => {
    try {
        if (!canViewTAAccess(req.user)) {
            return res.status(403).json({ message: 'Forbidden: You do not have permission to view TA access settings' });
        }

        const [taPermissions, roles, users, requests, candidates] = await Promise.all([
            getTAAccessPermissions(),
            Role.find({ companyId: req.companyId, isActive: true })
                .populate('permissions', 'key description isDeprecated')
                .sort({ name: 1 })
                .lean(),
            User.find({ companyId: req.companyId })
                .select('firstName lastName email employeeCode isActive roles taAssignedClients')
                .populate('roles', 'name')
                .sort({ firstName: 1, lastName: 1, email: 1 })
                .lean(),
            HiringRequest.find({ companyId: req.companyId })
                .select('requestId client status roleDetails.title ownership assignedUsers analyticsViewers')
                .populate('ownership.hiringManager', 'firstName lastName email employeeCode')
                .populate('ownership.interviewPanel', 'firstName lastName email employeeCode')
                .populate('assignedUsers', 'firstName lastName email employeeCode')
                .populate('analyticsViewers', 'firstName lastName email employeeCode')
                .sort({ updatedAt: -1, createdAt: -1 })
                .lean(),
            Candidate.find({ companyId: req.companyId })
                .select('hiringRequestId interviewRounds')
                .lean()
        ]);

        const taPermissionIds = new Set(taPermissions.map((permission) => String(permission._id)));
        const candidateSummaryByRequest = new Map();
        const interviewerSummaryByUser = new Map();
        const roundAssigneesByRequest = new Map();

        candidates.forEach((candidate) => {
            const requestId = String(candidate.hiringRequestId || '');
            if (!requestId) return;

            const currentSummary = candidateSummaryByRequest.get(requestId) || {
                candidateCount: 0,
                interviewRoundsCount: 0
            };
            currentSummary.candidateCount += 1;

            const roundAssigneeSet = roundAssigneesByRequest.get(requestId) || new Set();
            const rounds = Array.isArray(candidate.interviewRounds) ? candidate.interviewRounds : [];
            currentSummary.interviewRoundsCount += rounds.length;

            rounds.forEach((round) => {
                const assignedTo = Array.isArray(round.assignedTo) ? round.assignedTo : [];
                assignedTo.forEach((userId) => {
                    const normalizedUserId = String(userId || '');
                    if (!normalizedUserId) return;

                    roundAssigneeSet.add(normalizedUserId);
                    const userSummary = interviewerSummaryByUser.get(normalizedUserId) || { interviewRoundsAssigned: 0 };
                    userSummary.interviewRoundsAssigned += 1;
                    interviewerSummaryByUser.set(normalizedUserId, userSummary);
                });
            });

            candidateSummaryByRequest.set(requestId, currentSummary);
            roundAssigneesByRequest.set(requestId, roundAssigneeSet);
        });

        const requestSummaryByUser = new Map();
        const ensureRequestSummary = (userId) => {
            const normalizedUserId = String(userId || '');
            if (!normalizedUserId) {
                return null;
            }

            if (!requestSummaryByUser.has(normalizedUserId)) {
                requestSummaryByUser.set(normalizedUserId, {
                    assignedRequestIds: new Set(),
                    directAssignedRequestIds: new Set(),
                    clientDerivedRequestIds: new Set(),
                    hiringManagerOn: 0,
                    analyticsViewerOn: 0,
                    clientAssignments: 0
                });
            }

            return requestSummaryByUser.get(normalizedUserId);
        };

        requests.forEach((request) => {
            const requestId = String(request._id || '');
            const registerCount = (userId, key) => {
                const current = ensureRequestSummary(userId);
                if (!current) return;
                current[key] += 1;
            };

            registerCount(request.ownership?.hiringManager?._id || request.ownership?.hiringManager, 'hiringManagerOn');

            (request.assignedUsers || []).forEach((user) => {
                const current = ensureRequestSummary(user?._id || user);
                if (!current) return;
                current.directAssignedRequestIds.add(requestId);
                current.assignedRequestIds.add(requestId);
            });
            (request.analyticsViewers || []).forEach((user) => {
                registerCount(user?._id || user, 'analyticsViewerOn');
            });
        });

        users.forEach((user) => {
            const normalizedUserId = String(user._id);
            const current = ensureRequestSummary(normalizedUserId) || {
                assignedRequestIds: new Set(),
                directAssignedRequestIds: new Set(),
                clientDerivedRequestIds: new Set(),
                hiringManagerOn: 0,
                analyticsViewerOn: 0,
                clientAssignments: 0
            };
            const assignedClientNames = new Set(
                (Array.isArray(user.taAssignedClients) ? user.taAssignedClients : [])
                    .map(normalizeClientKey)
                    .filter(Boolean)
            );

            if (assignedClientNames.size > 0) {
                requests.forEach((request) => {
                    if (!assignedClientNames.has(normalizeClientKey(request.client))) {
                        return;
                    }

                    const requestId = String(request._id || '');
                    if (!requestId) {
                        return;
                    }

                    current.clientDerivedRequestIds.add(requestId);
                    current.assignedRequestIds.add(requestId);
                });
            }

            current.clientAssignments = Array.isArray(user.taAssignedClients) ? user.taAssignedClients.length : 0;
            requestSummaryByUser.set(normalizedUserId, current);
        });

        const clients = [...new Set([
            ...requests
                .map((request) => String(request.client || '').trim())
                .filter(Boolean),
            ...users.flatMap((user) => (
                Array.isArray(user.taAssignedClients)
                    ? user.taAssignedClients.map((client) => String(client || '').trim()).filter(Boolean)
                    : []
            ))
        ])].sort((left, right) => left.localeCompare(right));

        const userResponses = users.map((user) => {
            const requestSummary = requestSummaryByUser.get(String(user._id));
            return buildUserResponse(
                user,
                requestSummary
                    ? {
                        assignedRequests: requestSummary.assignedRequestIds.size,
                        directAssignedRequests: requestSummary.directAssignedRequestIds.size,
                        clientDerivedRequests: requestSummary.clientDerivedRequestIds.size,
                        clientAssignments: requestSummary.clientAssignments,
                        hiringManagerOn: requestSummary.hiringManagerOn,
                        analyticsViewerOn: requestSummary.analyticsViewerOn
                    }
                    : {},
                interviewerSummaryByUser.get(String(user._id)) || {}
            );
        });

        const requestResponses = requests.map((request) => buildRequestResponse(
            request,
            candidateSummaryByRequest.get(String(request._id)) || {},
            [...(roundAssigneesByRequest.get(String(request._id)) || new Set())]
        ));

        res.status(200).json({
            permissions: taPermissions.map((permission) => ({
                _id: permission._id,
                key: permission.key,
                description: permission.description || ''
            })),
            clients,
            roles: roles.map((role) => buildRoleResponse(role, taPermissionIds)),
            users: userResponses,
            requests: requestResponses
        });
    } catch (error) {
        console.error('getOverview error:', error);
        res.status(500).json({ message: 'Failed to load TA access settings', error: error.message });
    }
};

exports.updateRolePermissions = async (req, res) => {
    try {
        if (!canManageTARolePermissions(req.user)) {
            return res.status(403).json({ message: 'Forbidden: You do not have permission to update TA role access' });
        }

        const role = await Role.findOne({ _id: req.params.roleId, companyId: req.companyId }).populate('permissions', 'key description');
        if (!role) {
            return res.status(404).json({ message: 'Role not found' });
        }

        if (role.isSystem) {
            return res.status(403).json({ message: 'System roles cannot be modified from TA Access Settings' });
        }

        const selectedPermissionIds = Array.isArray(req.body?.permissionIds)
            ? req.body.permissionIds.map((permissionId) => String(permissionId)).filter(Boolean)
            : [];

        const taPermissions = await getTAAccessPermissions();
        const taPermissionIds = new Set(taPermissions.map((permission) => String(permission._id)));

        const invalidSelection = selectedPermissionIds.some((permissionId) => !taPermissionIds.has(permissionId));
        if (invalidSelection) {
            return res.status(400).json({ message: 'One or more selected permissions are not valid TA permissions' });
        }

        const existingPermissionIds = Array.isArray(role.permissions)
            ? role.permissions.map((permission) => String(permission._id || permission))
            : [];

        const nonTAPermissionIds = existingPermissionIds.filter((permissionId) => !taPermissionIds.has(permissionId));
        role.permissions = [...new Set([...nonTAPermissionIds, ...selectedPermissionIds])];
        await role.save();

        await User.updateMany(
            { companyId: req.companyId, roles: role._id },
            { $inc: { tokenVersion: 1 } }
        );

        const updatedRole = await Role.findById(role._id).populate('permissions', 'key description isDeprecated').lean();

        res.status(200).json({
            message: 'TA role permissions updated successfully',
            role: buildRoleResponse(updatedRole, taPermissionIds)
        });
    } catch (error) {
        console.error('updateRolePermissions error:', error);
        res.status(500).json({ message: 'Failed to update TA role permissions', error: error.message });
    }
};

exports.updateRequisitionAccess = async (req, res) => {
    try {
        if (!canManageTAAccess(req.user)) {
            return res.status(403).json({ message: 'Forbidden: You do not have permission to update requisition access' });
        }

        const request = await HiringRequest.findOne({ _id: req.params.id, companyId: req.companyId });
        if (!request) {
            return res.status(404).json({ message: 'Hiring request not found' });
        }

        const assignedUsers = Array.isArray(req.body?.assignedUsers)
            ? [...new Set(req.body.assignedUsers.map((userId) => String(userId)).filter(Boolean))]
            : [];
        const analyticsViewers = Array.isArray(req.body?.analyticsViewers)
            ? [...new Set(req.body.analyticsViewers.map((userId) => String(userId)).filter(Boolean))]
            : [];
        const interviewPanel = Array.isArray(req.body?.interviewPanel)
            ? [...new Set(req.body.interviewPanel.map((userId) => String(userId)).filter(Boolean))]
            : [];

        const unassignClientUsers = Array.isArray(req.body?.unassignClientUsers)
            ? [...new Set(req.body.unassignClientUsers.map((userId) => String(userId)).filter(Boolean))]
            : [];

        if (unassignClientUsers.length > 0) {
            await User.updateMany(
                {
                    companyId: req.companyId,
                    _id: { $in: unassignClientUsers }
                },
                {
                    $pull: { taAssignedClients: request.client },
                    $inc: { tokenVersion: 1 }
                }
            );

            await HiringRequest.updateMany(
                {
                    companyId: req.companyId,
                    client: request.client,
                    _id: { $ne: request._id }
                },
                {
                    $addToSet: { assignedUsers: { $each: unassignClientUsers } }
                }
            );
        }

        request.assignedUsers = await mergeAssignedUsersWithClientAssignments({
            companyId: req.companyId,
            clientName: request.client,
            assignedUsers
        });
        request.analyticsViewers = analyticsViewers;
        request.ownership = {
            ...(request.ownership?.toObject ? request.ownership.toObject() : request.ownership),
            interviewPanel
        };

        await request.save();

        const updatedRequest = await HiringRequest.findById(request._id)
            .select('requestId client status roleDetails.title ownership assignedUsers analyticsViewers')
            .populate('ownership.hiringManager', 'firstName lastName email employeeCode')
            .populate('ownership.interviewPanel', 'firstName lastName email employeeCode')
            .populate('assignedUsers', 'firstName lastName email employeeCode')
            .populate('analyticsViewers', 'firstName lastName email employeeCode')
            .lean();

        const requestCandidates = await Candidate.find({
            companyId: req.companyId,
            hiringRequestId: request._id
        })
            .select('interviewRounds')
            .lean();

        const candidateSummary = {
            candidateCount: requestCandidates.length,
            interviewRoundsCount: requestCandidates.reduce((total, candidate) => (
                total + (Array.isArray(candidate.interviewRounds) ? candidate.interviewRounds.length : 0)
            ), 0)
        };
        const interviewerIds = [...new Set(
            requestCandidates.flatMap((candidate) => (
                (candidate.interviewRounds || []).flatMap((round) => (
                    Array.isArray(round.assignedTo) ? round.assignedTo.map((userId) => String(userId)) : []
                ))
            ))
        )];

        res.status(200).json({
            message: 'Requisition access updated successfully',
            request: buildRequestResponse(updatedRequest, candidateSummary, interviewerIds)
        });
    } catch (error) {
        console.error('updateRequisitionAccess error:', error);
        res.status(500).json({ message: 'Failed to update requisition access', error: error.message });
    }
};

exports.updateUserClientAssignments = async (req, res) => {
    try {
        if (!canManageTAAccess(req.user)) {
            return res.status(403).json({ message: 'Forbidden: You do not have permission to update TA client assignments' });
        }

        const user = await User.findOne({ _id: req.params.userId, companyId: req.companyId });
        if (!user) {
            return res.status(404).json({ message: 'User not found' });
        }

        const assignedClients = Array.isArray(req.body?.assignedClients)
            ? [...new Set(req.body.assignedClients.map((client) => String(client || '').trim()).filter(Boolean))]
            : [];
        const previousAssignedClients = Array.isArray(user.taAssignedClients)
            ? [...new Set(user.taAssignedClients.map((client) => String(client || '').trim()).filter(Boolean))]
            : [];
        const addedClients = assignedClients.filter((client) => !previousAssignedClients.includes(client));
        const removedClients = previousAssignedClients.filter((client) => !assignedClients.includes(client));

        user.taAssignedClients = assignedClients;
        user.tokenVersion = (user.tokenVersion || 0) + 1;
        await user.save();

        await Promise.all([
            ...addedClients.map((clientName) => addUsersToClientRequisitions({
                companyId: req.companyId,
                clientName,
                userIds: [user._id]
            })),
            ...removedClients.map((clientName) => removeUsersFromClientRequisitions({
                companyId: req.companyId,
                clientName,
                userIds: [user._id]
            }))
        ]);

        const updatedUser = await User.findById(user._id)
            .select('firstName lastName email employeeCode isActive roles taAssignedClients')
            .populate('roles', 'name')
            .lean();

        res.status(200).json({
            message: 'TA client assignments updated successfully',
            user: buildUserResponse(updatedUser, { clientAssignments: assignedClients.length }, {})
        });
    } catch (error) {
        console.error('updateUserClientAssignments error:', error);
        res.status(500).json({ message: 'Failed to update TA client assignments', error: error.message });
    }
};

exports.updateClientUserAssignments = async (req, res) => {
    try {
        if (!canManageTAAccess(req.user)) {
            return res.status(403).json({ message: 'Forbidden: You do not have permission to update TA client assignments' });
        }

        const clientName = String(req.body?.clientName || '').trim();
        if (!clientName) {
            return res.status(400).json({ message: 'Client name is required' });
        }

        const selectedUserIds = Array.isArray(req.body?.userIds)
            ? [...new Set(req.body.userIds.map((userId) => String(userId)).filter(Boolean))]
            : [];
        const previouslyAssignedUsers = await User.find({
            companyId: req.companyId,
            taAssignedClients: clientName
        })
            .select('_id')
            .lean();
        const removedUserIds = previouslyAssignedUsers
            .map((user) => String(user._id))
            .filter((userId) => !selectedUserIds.includes(userId));

        const usersToAddQuery = {
            companyId: req.companyId,
            _id: { $in: selectedUserIds }
        };
        const usersToRemoveQuery = {
            companyId: req.companyId,
            _id: { $nin: selectedUserIds },
            taAssignedClients: clientName
        };

        await Promise.all([
            User.updateMany(
                usersToAddQuery,
                {
                    $addToSet: { taAssignedClients: clientName },
                    $inc: { tokenVersion: 1 }
                }
            ),
            User.updateMany(
                usersToRemoveQuery,
                {
                    $pull: { taAssignedClients: clientName },
                    $inc: { tokenVersion: 1 }
                }
            )
        ]);

        await Promise.all([
            addUsersToClientRequisitions({
                companyId: req.companyId,
                clientName,
                userIds: selectedUserIds
            }),
            removeUsersFromClientRequisitions({
                companyId: req.companyId,
                clientName,
                userIds: removedUserIds
            })
        ]);

        const updatedUsers = await User.find({ companyId: req.companyId })
            .select('firstName lastName email employeeCode isActive roles taAssignedClients')
            .populate('roles', 'name')
            .sort({ firstName: 1, lastName: 1, email: 1 })
            .lean();

        res.status(200).json({
            message: 'TA client assignments updated successfully',
            clientName,
            users: updatedUsers.map((user) => buildUserResponse(
                user,
                { clientAssignments: Array.isArray(user.taAssignedClients) ? user.taAssignedClients.length : 0 },
                {}
            ))
        });
    } catch (error) {
        console.error('updateClientUserAssignments error:', error);
        res.status(500).json({ message: 'Failed to update TA client assignments', error: error.message });
    }
};
