const User = require('../user/user.model');
const { HiringRequest } = require('../talent-acquisition/model/hiringRequest.model');

const normalizeClientName = (value) => String(value || '').trim();

const normalizeUserIds = (userIds = []) => (
    [...new Set(
        (Array.isArray(userIds) ? userIds : [])
            .map((userId) => String(userId || '').trim())
            .filter(Boolean)
    )]
);

const getClientAssignedUserIds = async (companyId, clientName) => {
    const normalizedClientName = normalizeClientName(clientName);
    if (!companyId || !normalizedClientName) {
        return [];
    }

    const users = await User.find({
        companyId,
        taAssignedClients: normalizedClientName
    })
        .select('_id')
        .lean();

    return normalizeUserIds(users.map((user) => user._id));
};

const mergeAssignedUsersWithClientAssignments = async ({ companyId, clientName, assignedUsers = [] }) => {
    const clientAssignedUserIds = await getClientAssignedUserIds(companyId, clientName);
    return normalizeUserIds([
        ...assignedUsers,
        ...clientAssignedUserIds
    ]);
};

const addUsersToClientRequisitions = async ({ companyId, clientName, userIds = [] }) => {
    const normalizedClientName = normalizeClientName(clientName);
    const normalizedUserIds = normalizeUserIds(userIds);

    if (!companyId || !normalizedClientName || normalizedUserIds.length === 0) {
        return;
    }

    await HiringRequest.updateMany(
        {
            companyId,
            client: normalizedClientName
        },
        {
            $addToSet: {
                assignedUsers: {
                    $each: normalizedUserIds
                }
            }
        }
    );
};

const removeUsersFromClientRequisitions = async ({ companyId, clientName, userIds = [] }) => {
    const normalizedClientName = normalizeClientName(clientName);
    const normalizedUserIds = normalizeUserIds(userIds);

    if (!companyId || !normalizedClientName || normalizedUserIds.length === 0) {
        return;
    }

    await HiringRequest.updateMany(
        {
            companyId,
            client: normalizedClientName
        },
        {
            $pull: {
                assignedUsers: {
                    $in: normalizedUserIds
                }
            }
        }
    );
};

module.exports = {
    addUsersToClientRequisitions,
    getClientAssignedUserIds,
    mergeAssignedUsersWithClientAssignments,
    normalizeClientName,
    normalizeUserIds,
    removeUsersFromClientRequisitions
};
