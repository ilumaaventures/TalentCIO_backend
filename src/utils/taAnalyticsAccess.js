const { getUserPermissionKeys, isHiringRequestAdmin } = require('./hiringRequestAccess');

const TA_ANALYTICS_GLOBAL_PERMISSION = 'ta.analytics.global';

const hasGlobalTAAnalyticsAccess = (user) => {
    const permissions = getUserPermissionKeys(user);
    return isHiringRequestAdmin(user) || permissions.includes(TA_ANALYTICS_GLOBAL_PERMISSION) || permissions.includes('*');
};

const buildAnalyticsHiringRequestQuery = (companyId, user) => {
    if (hasGlobalTAAnalyticsAccess(user)) {
        return { companyId };
    }

    return {
        companyId,
        analyticsViewers: user?._id
    };
};

module.exports = {
    TA_ANALYTICS_GLOBAL_PERMISSION,
    hasGlobalTAAnalyticsAccess,
    buildAnalyticsHiringRequestQuery
};
