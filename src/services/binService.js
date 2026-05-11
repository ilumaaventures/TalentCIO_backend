const { cloudinary } = require('../config/cloudinary');
const Project = require('../models/Project');
const Module = require('../models/Module');
const Task = require('../models/Task');
const WorkLog = require('../models/WorkLog');
const Candidate = require('../models/Candidate');
const { HiringRequest } = require('../models/HiringRequest');
const User = require('../models/User');
const Role = require('../models/Role');
const Client = require('../models/Client');
const BusinessUnit = require('../models/BusinessUnit');
const Discussion = require('../models/Discussion');
const Meeting = require('../models/Meeting');
const Holiday = require('../models/Holiday');
const ApprovalWorkflow = require('../models/ApprovalWorkflow');
const InterviewWorkflow = require('../models/InterviewWorkflow');
const LeaveConfig = require('../models/LeaveConfig');
const QueryType = require('../models/QueryType');

const ENTITY_MAP = {
    project: Project,
    module: Module,
    task: Task,
    worklog: WorkLog,
    candidate: Candidate,
    hiringrequest: HiringRequest,
    user: User,
    role: Role,
    client: Client,
    businessunit: BusinessUnit,
    discussion: Discussion,
    meeting: Meeting,
    holiday: Holiday,
    approvalworkflow: ApprovalWorkflow,
    interviewworkflow: InterviewWorkflow,
    leaveconfig: LeaveConfig,
    querytype: QueryType
};

const buildSoftDeleteUpdate = (userId, deletedAt = new Date()) => ({
    isDeleted: true,
    deletedAt,
    deletedBy: userId || null
});

const buildRestoreUpdate = () => ({
    isDeleted: false,
    deletedAt: null,
    deletedBy: null
});

const getEntityModel = (entity) => ENTITY_MAP[String(entity || '').trim().toLowerCase()] || null;

const getDeletedEntityKeys = () => Object.keys(ENTITY_MAP);

const softDeleteProjectTree = async (projectId, companyId, userId) => {
    const deletedAt = new Date();
    const deleteUpdate = buildSoftDeleteUpdate(userId, deletedAt);
    const modules = await Module.find({ project: projectId, companyId }, '_id', { includeDeleted: true }).lean();
    const moduleIds = modules.map((moduleDoc) => moduleDoc._id);

    await Module.updateMany(
        { project: projectId, companyId, isDeleted: { $ne: true } },
        { $set: deleteUpdate }
    );

    if (!moduleIds.length) {
        return;
    }

    const tasks = await Task.find({ module: { $in: moduleIds }, companyId }, '_id', { includeDeleted: true }).lean();
    const taskIds = tasks.map((taskDoc) => taskDoc._id);

    await Task.updateMany(
        { module: { $in: moduleIds }, companyId, isDeleted: { $ne: true } },
        { $set: deleteUpdate }
    );

    if (!taskIds.length) {
        return;
    }

    await WorkLog.updateMany(
        { task: { $in: taskIds }, companyId, isDeleted: { $ne: true } },
        { $set: deleteUpdate }
    );
};

const softDeleteModuleTree = async (moduleId, companyId, userId) => {
    const deletedAt = new Date();
    const deleteUpdate = buildSoftDeleteUpdate(userId, deletedAt);
    const tasks = await Task.find({ module: moduleId, companyId }, '_id', { includeDeleted: true }).lean();
    const taskIds = tasks.map((taskDoc) => taskDoc._id);

    await Task.updateMany(
        { module: moduleId, companyId, isDeleted: { $ne: true } },
        { $set: deleteUpdate }
    );

    if (!taskIds.length) {
        return;
    }

    await WorkLog.updateMany(
        { task: { $in: taskIds }, companyId, isDeleted: { $ne: true } },
        { $set: deleteUpdate }
    );
};

const softDeleteTaskTree = async (taskId, companyId, userId) => {
    await WorkLog.updateMany(
        { task: taskId, companyId, isDeleted: { $ne: true } },
        { $set: buildSoftDeleteUpdate(userId, new Date()) }
    );
};

const restoreProjectTree = async (projectId, companyId) => {
    const restoreUpdate = buildRestoreUpdate();
    const modules = await Module.find({ project: projectId, companyId }, '_id', { includeDeleted: true }).lean();
    const moduleIds = modules.map((moduleDoc) => moduleDoc._id);

    await Module.updateMany(
        { project: projectId, companyId, isDeleted: true },
        { $set: restoreUpdate }
    );

    if (!moduleIds.length) {
        return;
    }

    const tasks = await Task.find({ module: { $in: moduleIds }, companyId }, '_id', { includeDeleted: true }).lean();
    const taskIds = tasks.map((taskDoc) => taskDoc._id);

    await Task.updateMany(
        { module: { $in: moduleIds }, companyId, isDeleted: true },
        { $set: restoreUpdate }
    );

    if (!taskIds.length) {
        return;
    }

    await WorkLog.updateMany(
        { task: { $in: taskIds }, companyId, isDeleted: true },
        { $set: restoreUpdate }
    );
};

const restoreModuleTree = async (moduleId, companyId) => {
    const restoreUpdate = buildRestoreUpdate();
    const tasks = await Task.find({ module: moduleId, companyId }, '_id', { includeDeleted: true }).lean();
    const taskIds = tasks.map((taskDoc) => taskDoc._id);

    await Task.updateMany(
        { module: moduleId, companyId, isDeleted: true },
        { $set: restoreUpdate }
    );

    if (!taskIds.length) {
        return;
    }

    await WorkLog.updateMany(
        { task: { $in: taskIds }, companyId, isDeleted: true },
        { $set: restoreUpdate }
    );
};

const restoreTaskTree = async (taskId, companyId) => {
    await WorkLog.updateMany(
        { task: taskId, companyId, isDeleted: true },
        { $set: buildRestoreUpdate() }
    );
};

const permanentlyDeleteProjectTree = async (projectId, companyId) => {
    const modules = await Module.find({ project: projectId, companyId }, '_id', { includeDeleted: true }).lean();
    const moduleIds = modules.map((moduleDoc) => moduleDoc._id);

    if (!moduleIds.length) {
        return;
    }

    const tasks = await Task.find({ module: { $in: moduleIds }, companyId }, '_id', { includeDeleted: true }).lean();
    const taskIds = tasks.map((taskDoc) => taskDoc._id);

    if (taskIds.length) {
        await WorkLog.deleteMany({ task: { $in: taskIds }, companyId });
    }

    await Task.deleteMany({ module: { $in: moduleIds }, companyId });
    await Module.deleteMany({ project: projectId, companyId });
};

const permanentlyDeleteModuleTree = async (moduleId, companyId) => {
    const tasks = await Task.find({ module: moduleId, companyId }, '_id', { includeDeleted: true }).lean();
    const taskIds = tasks.map((taskDoc) => taskDoc._id);

    if (taskIds.length) {
        await WorkLog.deleteMany({ task: { $in: taskIds }, companyId });
    }

    await Task.deleteMany({ module: moduleId, companyId });
};

const permanentlyDeleteTaskTree = async (taskId, companyId) => {
    await WorkLog.deleteMany({ task: taskId, companyId });
};

const deleteCandidateAssets = async (candidate) => {
    if (!candidate?.resumePublicId) {
        return;
    }

    try {
        await cloudinary.uploader.destroy(candidate.resumePublicId, { resource_type: 'raw' });
    } catch (error) {
        console.error(`[Bin] Failed to remove candidate resume ${candidate.resumePublicId}:`, error.message);
    }
};

const purgeDeletedDocument = async (entity, item) => {
    const entityKey = String(entity || '').toLowerCase();
    const companyId = item.companyId;

    if (entityKey === 'project') {
        await permanentlyDeleteProjectTree(item._id, companyId);
    }

    if (entityKey === 'module') {
        await permanentlyDeleteModuleTree(item._id, companyId);
    }

    if (entityKey === 'task') {
        await permanentlyDeleteTaskTree(item._id, companyId);
    }

    if (entityKey === 'candidate') {
        await deleteCandidateAssets(item);
    }

    await item.deleteOne();
};

module.exports = {
    ENTITY_MAP,
    buildSoftDeleteUpdate,
    buildRestoreUpdate,
    getEntityModel,
    getDeletedEntityKeys,
    softDeleteProjectTree,
    softDeleteModuleTree,
    softDeleteTaskTree,
    restoreProjectTree,
    restoreModuleTree,
    restoreTaskTree,
    purgeDeletedDocument
};
