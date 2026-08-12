const AccessPolicy = require('../../workflow/accessPolicy.model');

const normalizeId = (value) => {
    if (!value) return '';
    if (typeof value === 'string') return value;
    if (typeof value === 'object') {
        if ('_id' in value && value._id && value._id !== value) {
            return normalizeId(value._id);
        }
        if (value.buffer && (value.buffer instanceof Uint8Array || Array.isArray(value.buffer) || ArrayBuffer.isView(value.buffer))) {
            const buf = Uint8Array.from(value.buffer);
            if (buf.length === 12) {
                return Array.from(buf).map(b => b.toString(16).padStart(2, '0')).join('');
            }
        }
        if (typeof value.toString === 'function') {
            const str = value.toString();
            if (str !== '[object Object]') return str;
        }
    }
    const strVal = String(value);
    return strVal === '[object Object]' ? '' : strVal;
};
const normalizeValue = (value) => String(value || '').trim().toLowerCase();

const getUserRoleIds = (user) => (
    [...new Set(
        (Array.isArray(user?.roles) ? user.roles : [])
            .map((role) => normalizeId(role?._id || role))
            .filter(Boolean)
    )]
);

const getUserAssignedClients = (user) => (
    [...new Set(
        (Array.isArray(user?.taAssignedClients) ? user.taAssignedClients : [])
            .map((client) => String(client || '').trim())
            .filter(Boolean)
    )]
);

const buildPolicyConstraint = (policy, user) => {
    const andConditions = [];
    const assignedClientOnly = Boolean(policy?.conditions?.assignedClientOnly);
    const departments = Array.isArray(policy?.conditions?.departments)
        ? policy.conditions.departments.map((department) => String(department || '').trim()).filter(Boolean)
        : [];
    const priorities = Array.isArray(policy?.conditions?.priorities)
        ? policy.conditions.priorities.map((priority) => String(priority || '').trim()).filter(Boolean)
        : [];

    if (assignedClientOnly) {
        const assignedClients = getUserAssignedClients(user);
        if (!assignedClients.length) {
            return { _id: null };
        }
        andConditions.push({ client: { $in: assignedClients } });
    }

    if (departments.length > 0) {
        andConditions.push({ 'roleDetails.department': { $in: departments } });
    }

    if (priorities.length > 0) {
        andConditions.push({ 'hiringDetails.priority': { $in: priorities } });
    }

    if (andConditions.length === 0) {
        return {};
    }

    if (andConditions.length === 1) {
        return andConditions[0];
    }

    return { $and: andConditions };
};

const getActiveTAPoliciesForUser = async ({
    companyId,
    user,
    action = 'view',
    resourceType = 'HiringRequest'
}) => {
    if (!companyId || !user?._id) {
        return [];
    }

    const roleIds = getUserRoleIds(user);

    return AccessPolicy.find({
        companyId,
        module: 'TA',
        resourceType,
        isActive: true,
        actions: action,
        $or: [
            { targetUsers: user._id },
            { targetRoles: { $in: roleIds } }
        ]
    }).lean();
};

const buildTABacHiringRequestConstraint = async ({
    companyId,
    user,
    action = 'view'
}) => {
    const policies = await getActiveTAPoliciesForUser({
        companyId,
        user,
        action,
        resourceType: 'HiringRequest'
    });

    if (!policies.length) {
        return null;
    }

    const policyConstraints = policies.map((policy) => buildPolicyConstraint(policy, user));
    if (policyConstraints.length === 1) {
        return policyConstraints[0];
    }

    return { $or: policyConstraints };
};

const matchesTABacHiringRequest = async ({
    companyId,
    user,
    hiringRequest,
    action = 'view'
}) => {
    const policies = await getActiveTAPoliciesForUser({
        companyId,
        user,
        action,
        resourceType: 'HiringRequest'
    });

    if (!policies.length) {
        return true;
    }

    return policies.some((policy) => {
        const assignedClientOnly = Boolean(policy?.conditions?.assignedClientOnly);
        const departments = Array.isArray(policy?.conditions?.departments)
            ? policy.conditions.departments.map(normalizeValue).filter(Boolean)
            : [];
        const priorities = Array.isArray(policy?.conditions?.priorities)
            ? policy.conditions.priorities.map(normalizeValue).filter(Boolean)
            : [];

        if (assignedClientOnly) {
            const assignedClients = getUserAssignedClients(user).map(normalizeValue);
            if (!assignedClients.length || !assignedClients.includes(normalizeValue(hiringRequest?.client))) {
                return false;
            }
        }

        if (departments.length > 0 && !departments.includes(normalizeValue(hiringRequest?.roleDetails?.department))) {
            return false;
        }

        if (priorities.length > 0 && !priorities.includes(normalizeValue(hiringRequest?.hiringDetails?.priority))) {
            return false;
        }

        return true;
    });
};

const getTABacActionForCapability = (capability = '') => {
    switch (capability) {
        case 'candidate.edit':
            return 'edit';
        case 'candidate.evaluate_round':
            return 'evaluate_round';
        case 'candidate.make_decision':
            return 'make_decision';
        case 'candidate.transfer':
            return 'transfer';
        case 'ta.config.view':
        case 'ta.config.edit':
            return 'config_manage';
        default:
            return 'view';
    }
};

module.exports = {
    buildTABacHiringRequestConstraint,
    getTABacActionForCapability,
    matchesTABacHiringRequest
};
