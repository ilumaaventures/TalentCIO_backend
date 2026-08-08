const mongoose = require('mongoose');

const VALID_DECISION_TYPES = ['advance', 'hold', 'reject'];
const ACTIVE_HIRING_REQUEST_STATUSES = [
    'Draft',
    'Submitted',
    'Pending_L1',
    'Pending_Final',
    'Approved',
    'On_Hold',
    'Pending_Approval'
];

const isPlainObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

const normalizeColor = (value, fallback = '#94A3B8') => {
    const color = String(value || '').trim();
    return /^#([0-9A-F]{3}|[0-9A-F]{6})$/i.test(color) ? color.toUpperCase() : fallback;
};

const normalizeLabel = (value, fallback = '') => String(value ?? fallback).trim();

const normalizeValue = (value, fallback = '') => {
    const normalized = String(value ?? fallback)
        .trim()
        .replace(/\s+/g, '_')
        .replace(/[^a-zA-Z0-9_-]/g, '_')
        .replace(/_+/g, '_')
        .replace(/^_+|_+$/g, '')
        .toLowerCase();

    return normalized;
};

const createValidationError = (message) => {
    const error = new Error(message);
    error.statusCode = 400;
    return error;
};

const ensureSequentialOrders = (phases = []) => {
    const orders = phases.map((phase) => Number(phase.order));
    const expected = Array.from({ length: phases.length }, (_, index) => index + 1);
    const isSequential = orders.every((order, index) => Number.isInteger(order) && order === expected[index]);

    if (!isSequential) {
        throw createValidationError('Phase orders must be sequential starting from 1 with no gaps.');
    }
};

const sanitizeStatusOptions = (phaseName, statusOptions = []) => {
    if (!Array.isArray(statusOptions) || statusOptions.length === 0) {
        throw createValidationError(`Phase "${phaseName}" must have at least one status option.`);
    }

    const sanitized = statusOptions.map((option, index) => {
        const label = normalizeLabel(option?.label, option?.value);
        const value = normalizeValue(option?.value, label);

        if (!label || !value) {
            throw createValidationError(`Each status option in phase "${phaseName}" requires a label and value.`);
        }

        return {
            value,
            label,
            color: normalizeColor(option?.color, '#3B82F6'),
            isDefault: Boolean(option?.isDefault)
        };
    });

    const hasExplicitDefault = sanitized.some((option) => option.isDefault);
    if (!hasExplicitDefault && sanitized[0]) {
        sanitized[0].isDefault = true;
    }

    return sanitized.map((option, index) => ({
        ...option,
        isDefault: option.isDefault && sanitized.findIndex((item) => item.isDefault) === index
    }));
};

const sanitizeDecisionOptions = (phaseName, decisionOptions = []) => {
    if (!Array.isArray(decisionOptions) || decisionOptions.length === 0) {
        throw createValidationError(`Phase "${phaseName}" must have at least one decision option.`);
    }

    return decisionOptions.map((option) => {
        const label = normalizeLabel(option?.label, option?.value);
        const value = normalizeValue(option?.value, label);
        const type = String(option?.type || '').trim().toLowerCase();

        if (!label || !value) {
            throw createValidationError(`Each decision option in phase "${phaseName}" requires a label and value.`);
        }

        if (!VALID_DECISION_TYPES.includes(type)) {
            throw createValidationError(`Decision option "${label}" in phase "${phaseName}" has an invalid type.`);
        }

        const sanitizedOption = {
            value,
            label,
            color: normalizeColor(option?.color, type === 'reject' ? '#EF4444' : type === 'hold' ? '#F59E0B' : '#10B981'),
            type
        };

        if (option?.nextPhaseOrder !== undefined && option?.nextPhaseOrder !== null && option?.nextPhaseOrder !== '') {
            sanitizedOption.nextPhaseOrder = Number(option.nextPhaseOrder);
        }

        return sanitizedOption;
    });
};

const validateAndSanitizePhases = (phases = []) => {
    if (!Array.isArray(phases) || phases.length === 0) {
        throw createValidationError('At least one phase is required.');
    }

    const sanitizedPhases = phases.map((phase, index) => {
        const name = normalizeLabel(phase?.name);
        if (!name) {
            throw createValidationError(`Phase ${index + 1} requires a name.`);
        }

        const order = Number(phase?.order);
        if (!Number.isInteger(order) || order < 1) {
            throw createValidationError(`Phase "${name}" requires a valid order value.`);
        }

        return {
            _id: phase?._id || new mongoose.Types.ObjectId(),
            name,
            description: normalizeLabel(phase?.description),
            order,
            color: normalizeColor(phase?.color, '#3B82F6'),
            statusOptions: sanitizeStatusOptions(name, phase?.statusOptions),
            decisionOptions: sanitizeDecisionOptions(name, phase?.decisionOptions),
            allowedActions: Array.isArray(phase?.allowedActions)
                ? [...new Set(
                    phase.allowedActions
                        .map((action) => String(action || '').trim())
                        .filter(Boolean)
                )]
                : []
        };
    }).sort((a, b) => a.order - b.order);

    ensureSequentialOrders(sanitizedPhases);

    const validOrders = new Set(sanitizedPhases.map((phase) => phase.order));

    sanitizedPhases.forEach((phase, index) => {
        phase.decisionOptions = phase.decisionOptions.map((decision) => {
            if (decision.type !== 'advance') {
                return decision;
            }

            const isTerminalPhase = index === sanitizedPhases.length - 1;
            if (decision.nextPhaseOrder === undefined) {
                if (isTerminalPhase) {
                    return decision;
                }

                throw createValidationError(`Advance decision "${decision.label}" in phase "${phase.name}" must point to a valid next phase.`);
            }

            if (!validOrders.has(decision.nextPhaseOrder)) {
                throw createValidationError(`Advance decision "${decision.label}" in phase "${phase.name}" references an invalid next phase.`);
            }

            return decision;
        });
    });

    return sanitizedPhases;
};

const copyTemplatePhasesForHiringRequest = (templatePhases = []) => (
    (Array.isArray(templatePhases) ? templatePhases : []).map((phase, index) => ({
        phaseId: phase?.phaseId || phase?._id || new mongoose.Types.ObjectId(),
        name: normalizeLabel(phase?.name),
        description: normalizeLabel(phase?.description),
        order: Number(phase?.order) || index + 1,
        color: normalizeColor(phase?.color, '#3B82F6'),
        statusOptions: (phase?.statusOptions || []).map((option, optionIndex) => ({
            value: normalizeValue(option?.value, option?.label),
            label: normalizeLabel(option?.label, option?.value),
            color: normalizeColor(option?.color, '#3B82F6'),
            isDefault: Boolean(option?.isDefault) || optionIndex === 0
        })),
        decisionOptions: (phase?.decisionOptions || []).map((option) => ({
            value: normalizeValue(option?.value, option?.label),
            label: normalizeLabel(option?.label, option?.value),
            color: normalizeColor(option?.color, '#10B981'),
            type: String(option?.type || 'hold').trim().toLowerCase(),
            ...(option?.nextPhaseOrder !== undefined && option?.nextPhaseOrder !== null && option?.nextPhaseOrder !== ''
                ? { nextPhaseOrder: Number(option.nextPhaseOrder) }
                : {})
        })),
        allowedActions: Array.isArray(phase?.allowedActions)
            ? [...new Set(phase.allowedActions.map((action) => String(action || '').trim()).filter(Boolean))]
            : []
    }))
);

const isDynamicHiringRequest = (hiringRequest) => Boolean(
    hiringRequest &&
    hiringRequest.useDynamicPhases === true &&
    Array.isArray(hiringRequest.phases) &&
    hiringRequest.phases.length > 0
);

const getDefaultStatusOption = (phase) => {
    const options = Array.isArray(phase?.statusOptions) ? phase.statusOptions : [];
    return options.find((option) => option.isDefault) || options[0] || null;
};

const buildInitialDynamicPhaseState = (hiringRequest, assignedTo = []) => {
    if (!isDynamicHiringRequest(hiringRequest)) {
        return {};
    }

    const phases = [...hiringRequest.phases].sort((a, b) => (a.order || 0) - (b.order || 0));
    const firstPhase = phases[0];
    if (!firstPhase) {
        return {};
    }

    const defaultStatus = getDefaultStatusOption(firstPhase);
    const now = new Date();
    const assignedUsers = Array.isArray(assignedTo)
        ? assignedTo.filter(Boolean).map((value) => new mongoose.Types.ObjectId(value))
        : [];

    const phaseId = firstPhase.phaseId || firstPhase._id || new mongoose.Types.ObjectId();
    const initialStatus = defaultStatus?.value || '';

    return {
        phaseHistory: [{
            phaseId,
            phaseName: firstPhase.name,
            phaseOrder: firstPhase.order,
            status: initialStatus,
            decision: 'None',
            enteredAt: now,
            exitedAt: null,
            assignedTo: assignedUsers,
            notes: '',
            metadata: {}
        }],
        currentPhaseId: phaseId,
        currentPhaseOrder: firstPhase.order,
        currentPhaseStatus: initialStatus,
        currentPhaseName: firstPhase.name
    };
};

const matchObjectId = (left, right) => String(left || '') === String(right || '');

const findPhaseById = (phases = [], phaseId) => (
    (Array.isArray(phases) ? phases : []).find((phase) => matchObjectId(phase?.phaseId || phase?._id, phaseId))
);

const findPhaseByOrder = (phases = [], order) => (
    (Array.isArray(phases) ? phases : []).find((phase) => Number(phase?.order) === Number(order))
);

const getCurrentPhaseEntry = (candidate) => (
    (candidate?.phaseHistory || []).find((entry) => !entry.exitedAt) || null
);

const isActiveHiringRequestStatus = (status) => ACTIVE_HIRING_REQUEST_STATUSES.includes(status);

const getPhaseDecisionOption = (phase, decisionValue) => (
    (phase?.decisionOptions || []).find((option) => option.value === decisionValue) || null
);

const getPhaseStatusOption = (phase, statusValue) => (
    (phase?.statusOptions || []).find((option) => option.value === statusValue) || null
);

const calculateDaysSpent = (enteredAt, exitedAt) => {
    const start = enteredAt ? new Date(enteredAt) : null;
    const end = exitedAt ? new Date(exitedAt) : new Date();
    if (!start || Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
        return 0;
    }

    const days = (end.getTime() - start.getTime()) / (1000 * 60 * 60 * 24);
    return Number(days.toFixed(1));
};

module.exports = {
    ACTIVE_HIRING_REQUEST_STATUSES,
    VALID_DECISION_TYPES,
    buildInitialDynamicPhaseState,
    calculateDaysSpent,
    copyTemplatePhasesForHiringRequest,
    createValidationError,
    findPhaseById,
    findPhaseByOrder,
    getCurrentPhaseEntry,
    getDefaultStatusOption,
    getPhaseDecisionOption,
    getPhaseStatusOption,
    isActiveHiringRequestStatus,
    isDynamicHiringRequest,
    isPlainObject,
    matchObjectId,
    normalizeColor,
    normalizeLabel,
    normalizeValue,
    validateAndSanitizePhases
};
