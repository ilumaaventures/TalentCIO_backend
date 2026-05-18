const PermissionDelegation = require('../models/PermissionDelegation');

const normalizeId = (value) => String(value?._id || value || '');

const matchesResourceScope = (delegation, resourceType, resourceId) => {
    if (!resourceType || !resourceId) {
        return true;
    }

    const scopes = delegation?.resourceScopes || {};
    if (resourceType === 'hiringRequest') {
        const ids = Array.isArray(scopes.hiringRequestIds) ? scopes.hiringRequestIds.map(normalizeId) : [];
        return ids.length === 0 || ids.includes(normalizeId(resourceId));
    }

    if (resourceType === 'candidate') {
        const ids = Array.isArray(scopes.candidateIds) ? scopes.candidateIds.map(normalizeId) : [];
        return ids.length === 0 || ids.includes(normalizeId(resourceId));
    }

    return true;
};

const findActivePermissionDelegations = async ({
    companyId,
    delegateUserId,
    permissionKeys = [],
    delegatorUserIds = [],
    resourceType = null,
    resourceId = null,
    now = new Date()
}) => {
    const normalizedPermissionKeys = [...new Set((permissionKeys || []).map((permissionKey) => String(permissionKey || '').trim()).filter(Boolean))];
    if (!companyId || !delegateUserId || normalizedPermissionKeys.length === 0) {
        return [];
    }

    const query = {
        companyId,
        delegateUserId,
        status: 'active',
        validFrom: { $lte: now },
        validTo: { $gte: now },
        permissionKeys: { $in: normalizedPermissionKeys }
    };

    const normalizedDelegatorIds = [...new Set((delegatorUserIds || []).map(normalizeId).filter(Boolean))];
    if (normalizedDelegatorIds.length > 0) {
        query.delegatorUserId = { $in: normalizedDelegatorIds };
    }

    const delegations = await PermissionDelegation.find(query)
        .sort({ validFrom: -1, createdAt: -1 })
        .lean();

    return delegations.filter((delegation) => matchesResourceScope(delegation, resourceType, resourceId));
};

const canUseDelegatedPermission = async (options = {}) => {
    const delegations = await findActivePermissionDelegations(options);
    return {
        allowed: delegations.length > 0,
        delegation: delegations[0] || null,
        delegations
    };
};

module.exports = {
    canUseDelegatedPermission,
    findActivePermissionDelegations
};
