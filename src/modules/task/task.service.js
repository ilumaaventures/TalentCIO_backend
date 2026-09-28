const mongoose = require('mongoose');
const Task = require('./task.model');
const Module = require('./module.model');
const Project = require('../project/project.model');
const TaskActivity = require('./taskActivity.model');

const WORKFLOW_ORDER = {
    TODO: 0,
    IN_PROGRESS: 1,
    REVIEW: 2,
    DONE: 3,
    BLOCKED: 1
};

/**
 * Generate human-friendly task key (e.g. TAL-101)
 */
const generateNextTaskKey = async (companyId, moduleId, projectId = null) => {
    try {
        let effectiveProjectId = projectId;

        if (!effectiveProjectId && moduleId) {
            const mod = await Module.findById(moduleId).select('project').lean();
            if (mod && mod.project) {
                effectiveProjectId = mod.project;
            }
        }

        let prefix = 'TAL';
        if (effectiveProjectId) {
            const project = await Project.findById(effectiveProjectId).select('name').lean();
            if (project && project.name) {
                const words = project.name.trim().split(/\s+/);
                if (words.length >= 2) {
                    prefix = (words[0].slice(0, 2) + words[1].slice(0, 2)).toUpperCase();
                } else if (words[0].length >= 3) {
                    prefix = words[0].slice(0, 3).toUpperCase();
                }
                // Strip non-alphanumeric
                prefix = prefix.replace(/[^A-Z0-9]/g, '') || 'TAL';
            }
        }

        const regex = new RegExp(`^${prefix}-(\\d+)$`, 'i');
        const latestTasks = await Task.find({
            companyId,
            taskKey: { $regex: regex }
        })
            .select('taskKey')
            .lean();

        let maxNum = 100;
        latestTasks.forEach((t) => {
            const match = t.taskKey && t.taskKey.match(regex);
            if (match && match[1]) {
                const num = parseInt(match[1], 10);
                if (!isNaN(num) && num > maxNum) {
                    maxNum = num;
                }
            }
        });

        const nextKey = `${prefix}-${maxNum + 1}`;
        return nextKey;
    } catch (err) {
        console.error('[TaskService] Error generating task key:', err);
        return `TAL-${Date.now().toString().slice(-4)}`;
    }
};

/**
 * Validate that task dependencies do not form cycles or self-references
 */
const checkCircularDependency = async (taskId, blockedByIds = [], companyId) => {
    if (!blockedByIds || !blockedByIds.length) {
        return { hasCycle: false };
    }

    const taskIdStr = String(taskId || '');

    // 1. Direct self-dependency
    for (const id of blockedByIds) {
        if (String(id) === taskIdStr) {
            return {
                hasCycle: true,
                message: 'A task cannot be blocked by itself'
            };
        }
    }

    // 2. Transitive graph cycle check using BFS
    const queue = [...blockedByIds.map(id => String(id))];
    const visited = new Set(queue);

    while (queue.length > 0) {
        const currentId = queue.shift();
        if (currentId === taskIdStr) {
            return {
                hasCycle: true,
                message: 'Circular dependency detected: a cycle was found in the task dependency chain'
            };
        }

        const currentTask = await Task.findOne({ _id: currentId, companyId })
            .select('blockedBy')
            .lean();

        if (currentTask && Array.isArray(currentTask.blockedBy)) {
            for (const depId of currentTask.blockedBy) {
                const depStr = String(depId);
                if (depStr === taskIdStr) {
                    return {
                        hasCycle: true,
                        message: 'Circular dependency detected: a cycle was found in the task dependency chain'
                    };
                }
                if (!visited.has(depStr)) {
                    visited.add(depStr);
                    queue.push(depStr);
                }
            }
        }
    }

    return { hasCycle: false };
};

/**
 * Normalizes values for comparison in activity logs
 */
const normalizeValue = (val) => {
    if (val === null || val === undefined) return null;
    if (val instanceof Date) return val.toISOString();
    if (Array.isArray(val)) {
        return val.map(item => String(item?._id || item)).sort();
    }
    if (typeof val === 'object' && val._id) {
        return String(val._id);
    }
    return String(val);
};

const areValuesEqual = (a, b) => {
    const normA = normalizeValue(a);
    const normB = normalizeValue(b);
    if (Array.isArray(normA) && Array.isArray(normB)) {
        return normA.length === normB.length && normA.every((v, i) => v === normB[i]);
    }
    return normA === normB;
};

/**
 * Record audit activity logs for task updates
 */
const recordTaskActivities = async ({ taskId, oldTask, updates, changedBy, companyId }) => {
    if (!taskId || !oldTask || !updates) return [];

    const trackedFields = [
        'status',
        'assignees',
        'priority',
        'storyPoints',
        'estimatedHours',
        'dueDate',
        'startDate',
        'labels',
        'reporter',
        'parentTask',
        'blockedBy',
        'name',
        'description',
        'order'
    ];

    const activitiesToInsert = [];

    for (const field of trackedFields) {
        if (updates[field] !== undefined) {
            const oldValue = oldTask[field];
            const newValue = updates[field];

            if (!areValuesEqual(oldValue, newValue)) {
                activitiesToInsert.push({
                    task: taskId,
                    field,
                    oldValue,
                    newValue,
                    changedBy,
                    companyId
                });
            }
        }
    }

    if (activitiesToInsert.length > 0) {
        try {
            await TaskActivity.insertMany(activitiesToInsert);
        } catch (err) {
            console.error('[TaskService] Error recording activities:', err);
        }
    }

    return activitiesToInsert;
};

/**
 * Apply status transition rules (completedAt, reopenCount, workflow detection)
 */
const applyTaskWorkflowRules = (updates, currentTask) => {
    const newStatus = updates.status;
    const oldStatus = currentTask?.status;

    if (newStatus && newStatus !== oldStatus) {
        if (newStatus === 'DONE') {
            updates.completedAt = new Date();
        } else if (oldStatus === 'DONE') {
            updates.reopenCount = (currentTask.reopenCount || 0) + 1;
            updates.completedAt = null;
        }

        // Backward workflow check
        const oldOrder = WORKFLOW_ORDER[oldStatus] ?? null;
        const newOrder = WORKFLOW_ORDER[newStatus] ?? null;
        if (oldOrder !== null && newOrder !== null && newOrder < oldOrder) {
            updates.__isBackwardMovement = true;
        }
    }

    return updates;
};

module.exports = {
    WORKFLOW_ORDER,
    generateNextTaskKey,
    checkCircularDependency,
    recordTaskActivities,
    applyTaskWorkflowRules
};
