const {
    getAssignedClientNames,
    getUserPermissionKeys,
    isHiringRequestAdmin
} = require('./hiringRequestAccess');
const { buildTABacHiringRequestConstraint } = require('./taABAC');

const TA_ANALYTICS_GLOBAL_PERMISSION = 'ta.analytics.global';
const TA_ANALYTICS_ASSIGNED_PERMISSION = 'ta.analytics.assigned';

const hasGlobalTAAnalyticsAccess = (user) => {
    const permissions = getUserPermissionKeys(user);
    return isHiringRequestAdmin(user)
        || permissions.includes(TA_ANALYTICS_GLOBAL_PERMISSION)
        || permissions.includes('ta.manage')
        || permissions.includes('*');
};

const hasAssignedTAAnalyticsAccess = (user) => {
    const permissions = getUserPermissionKeys(user);
    return hasGlobalTAAnalyticsAccess(user)
        || permissions.includes(TA_ANALYTICS_ASSIGNED_PERMISSION);
};

const buildAnalyticsHiringRequestQuery = async (companyId, user) => {
    if (hasGlobalTAAnalyticsAccess(user)) {
        return { companyId };
    }

    if (hasAssignedTAAnalyticsAccess(user)) {
        const baseAccessQuery = {
            companyId,
            $or: [
                { createdBy: user?._id },
                { 'ownership.hiringManager': user?._id },
                { assignedUsers: user?._id },
                { analyticsViewers: user?._id },
                { 'ownership.interviewPanel': user?._id }
            ]
        };

        const assignedClientNames = getAssignedClientNames(user);
        if (assignedClientNames.length > 0) {
            baseAccessQuery.$or.push({ client: { $in: assignedClientNames } });
        }

        const abacConstraint = await buildTABacHiringRequestConstraint({
            companyId,
            user,
            action: 'view'
        });

        if (!abacConstraint) {
            return baseAccessQuery;
        }

        return {
            $and: [
                baseAccessQuery,
                abacConstraint
            ]
        };
    }

    return {
        companyId,
        analyticsViewers: user?._id
    };
};

module.exports = {
    TA_ANALYTICS_GLOBAL_PERMISSION,
    TA_ANALYTICS_ASSIGNED_PERMISSION,
    hasAssignedTAAnalyticsAccess,
    hasGlobalTAAnalyticsAccess,
    buildAnalyticsHiringRequestQuery
};
