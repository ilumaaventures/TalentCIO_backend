const { cloudinary } = require('../../config/cloudinary');
const Project = require('../project/project.model');
const Module = require('../task/module.model');
const Task = require('../task/task.model');
const WorkLog = require('../timesheet/workLog.model');
const Candidate = require('../talent-acquisition/model/candidate.model');
const { HiringRequest } = require('../talent-acquisition/model/hiringRequest.model');
const User = require('../user/user.model');
const Role = require('../user/role.model');
const Client = require('../client/client.model');
const BusinessUnit = require('../business-unit/businessUnit.model');
const Discussion = require('../discussion/discussion.model');
const Meeting = require('../meeting/meeting.model');
const Holiday = require('../holiday/holiday.model');
const ApprovalWorkflow = require('../workflow/approvalWorkflow.model');
const InterviewWorkflow = require('../talent-acquisition/model/interviewWorkflow.model');
const LeaveConfig = require('../leave/model/leaveConfig.model');
const QueryType = require('../helpdesk/queryType.model');
const EmailTemplate = require('../email/model/emailTemplate.model');
const OnboardingTemplateBin = require('../onboarding/model/onboardingTemplateBin.model');
const OnboardingPolicyBin = require('../onboarding/model/onboardingPolicyBin.model');

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
    querytype: QueryType,
    emailtemplate: EmailTemplate,
    onboardingtemplate: OnboardingTemplateBin,
    onboardingpolicy: OnboardingPolicyBin
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

const getDateRangeForDay = (value) => {
    const parsedDate = new Date(value);
    if (Number.isNaN(parsedDate.getTime())) {
        return null;
    }

    const start = new Date(parsedDate);
    start.setHours(0, 0, 0, 0);

    const end = new Date(parsedDate);
    end.setHours(23, 59, 59, 999);

    return { start, end };
};

const getEntityConflictQuery = (entity, item) => {
    const entityKey = String(entity || '').trim().toLowerCase();
    const baseQuery = {
        companyId: item.companyId,
        isDeleted: { $ne: true },
        _id: { $ne: item._id }
    };

    if (entityKey === 'project' && item.name) {
        return { ...baseQuery, name: item.name };
    }

    if (entityKey === 'module' && item.name && item.project) {
        return { ...baseQuery, project: item.project, name: item.name };
    }

    if (entityKey === 'task' && item.name && item.module) {
        return { ...baseQuery, module: item.module, name: item.name };
    }

    if (entityKey === 'worklog' && item.task && item.user && item.date) {
        const dateRange = getDateRangeForDay(item.date);
        if (!dateRange) {
            return null;
        }

        return {
            ...baseQuery,
            task: item.task,
            user: item.user,
            date: { $gte: dateRange.start, $lte: dateRange.end }
        };
    }

    if (entityKey === 'candidate' && item.hiringRequestId) {
        const candidateDuplicateConditions = [];
        if (item.email) {
            candidateDuplicateConditions.push({ email: item.email });
        }
        if (item.mobile) {
            candidateDuplicateConditions.push({ mobile: item.mobile });
        }

        if (!candidateDuplicateConditions.length) {
            return null;
        }

        return {
            ...baseQuery,
            hiringRequestId: item.hiringRequestId,
            $or: candidateDuplicateConditions
        };
    }

    if (entityKey === 'hiringrequest' && item.requestId) {
        return { ...baseQuery, requestId: item.requestId };
    }

    if (entityKey === 'user' && item.email) {
        return { ...baseQuery, email: item.email };
    }

    if (entityKey === 'role' && item.name) {
        return { ...baseQuery, name: item.name };
    }

    if (entityKey === 'client' && item.name) {
        return { ...baseQuery, name: item.name };
    }

    if (entityKey === 'businessunit' && item.name) {
        return { ...baseQuery, name: item.name };
    }

    if (entityKey === 'discussion' && item.title && item.createdBy && item.supervisor) {
        return {
            ...baseQuery,
            title: item.title,
            createdBy: item.createdBy,
            supervisor: item.supervisor
        };
    }

    if (entityKey === 'meeting' && item.title && item.date && item.host) {
        return {
            ...baseQuery,
            title: item.title,
            date: item.date,
            host: item.host
        };
    }

    if (entityKey === 'holiday' && item.name && item.year) {
        return { ...baseQuery, name: item.name, year: item.year };
    }

    if (entityKey === 'approvalworkflow' && item.name) {
        return { ...baseQuery, name: item.name };
    }

    if (entityKey === 'interviewworkflow' && item.name) {
        return { ...baseQuery, name: item.name };
    }

    if (entityKey === 'leaveconfig' && item.leaveType) {
        return { ...baseQuery, leaveType: item.leaveType };
    }

    if (entityKey === 'querytype' && item.name) {
        return { ...baseQuery, name: item.name };
    }

    if (entityKey === 'emailtemplate' && item.name) {
        return {
            ...baseQuery,
            scope: item.scope,
            templateType: item.templateType,
            name: item.name
        };
    }

    return null;
};

const getEntityConflictLabel = (entity, item) => {
    const entityKey = String(entity || '').trim().toLowerCase();

    if (['project', 'module', 'task', 'role', 'client', 'businessunit', 'holiday', 'approvalworkflow', 'interviewworkflow', 'querytype', 'emailtemplate'].includes(entityKey)) {
        return item.name || entityKey;
    }

    if (entityKey === 'leaveconfig') {
        return item.name || item.leaveType || 'leave policy';
    }

    if (entityKey === 'candidate') {
        return item.candidateName || item.email || 'candidate';
    }

    if (entityKey === 'hiringrequest') {
        return item.requestId || item.roleDetails?.title || 'hiring request';
    }

    if (entityKey === 'user') {
        const fullName = [item.firstName, item.lastName].filter(Boolean).join(' ').trim();
        return fullName || item.email || 'user';
    }

    if (entityKey === 'discussion' || entityKey === 'meeting') {
        return item.title || entityKey;
    }

    if (entityKey === 'worklog') {
        return item.description || 'work log';
    }

    return item.name || item.title || item.email || item.requestId || entityKey;
};

const findRestoreConflict = async (entity, item) => {
    const Model = getEntityModel(entity);
    if (!Model) {
        return null;
    }

    const conflictQuery = getEntityConflictQuery(entity, item);
    if (!conflictQuery) {
        return null;
    }

    return Model.findOne(conflictQuery);
};

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

const moveEntityToBin = async (entity, item, userId, companyId) => {
    const entityKey = String(entity || '').trim().toLowerCase();

    if (entityKey === 'user') {
        item.isActive = false;
        item.isDeleted = true;
        item.deletedAt = new Date();
        item.deletedBy = userId || null;
        await item.save();
        return item;
    }

    if (entityKey === 'emailtemplate') {
        item.isActive = false;
    }

    await item.softDelete(userId);

    if (entityKey === 'project') {
        await softDeleteProjectTree(item._id, companyId, userId);
    }

    if (entityKey === 'module') {
        await softDeleteModuleTree(item._id, companyId, userId);
    }

    if (entityKey === 'task') {
        await softDeleteTaskTree(item._id, companyId, userId);
    }

    return item;
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

    if (entityKey === 'onboardingtemplate' || entityKey === 'onboardingpolicy') {
        const OnboardingEmployee = require('../onboarding/model/onboardingEmployee.model');
        const Company = require('../company/company.model');
        const isUsed = await OnboardingEmployee.exists({
            companyId: item.companyId,
            $or: [
                { 'requestedDocuments.templateId': item.originalId },
                { 'offerDeclaration.acceptedTemplates.templateId': item.originalId },
                { 'offerDeclaration.acceptedPolicies.policyId': item.originalId }
            ]
        });
        if (!isUsed) {
            if (item.publicId) {
                try {
                    await cloudinary.uploader.destroy(item.publicId, { resource_type: 'raw' });
                } catch (e) { /* ignore */ }
            }
            const fieldName = entityKey === 'onboardingtemplate' ? 'dynamicTemplates' : 'policies';
            await Company.findByIdAndUpdate(item.companyId, {
                $pull: { [`settings.onboarding.${fieldName}`]: { _id: item.originalId } }
            });
        }
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
    getEntityConflictLabel,
    findRestoreConflict,
    moveEntityToBin,
    purgeDeletedDocument
};
