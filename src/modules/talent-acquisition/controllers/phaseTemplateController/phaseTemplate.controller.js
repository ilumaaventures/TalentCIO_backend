const mongoose = require('mongoose');
const PhaseTemplate = require('../../phaseTemplate.model');
const { HiringRequest } = require('../../hiringRequest.model');
const {
    ACTIVE_HIRING_REQUEST_STATUSES,
    copyTemplatePhasesForHiringRequest,
    isActiveHiringRequestStatus,
    normalizeLabel,
    validateAndSanitizePhases
} = require('../../utils/phaseTemplateUtils');

const isAdminUser = (req) => (
    (req.user?.roles || []).some((role) =>
        role?.isSystem ||
        ['Admin', 'Super Admin', 'System Admin'].includes(role?.name)
    ) || (req.user?.permissions || []).includes('*')
);

const hasAnyPermission = (req, permissionKeys = []) => {
    const userPermissions = Array.isArray(req.user?.permissions) ? req.user.permissions : [];
    return permissionKeys.some((key) => userPermissions.includes(key));
};

const canEditPhaseTemplates = (req) => (
    isAdminUser(req) || hasAnyPermission(req, ['ta.manage', 'ta.config.edit'])
);

const ensureTemplateEditor = (req, res) => {
    if (!canEditPhaseTemplates(req)) {
        res.status(403).json({ message: 'Forbidden: You do not have permission to manage phase templates' });
        return false;
    }

    return true;
};

const getTemplateUsageMap = async (companyId, templateIds = []) => {
    if (!templateIds.length) {
        return new Map();
    }

    const usage = await HiringRequest.aggregate([
        {
            $match: {
                companyId: new mongoose.Types.ObjectId(companyId),
                phaseTemplateId: { $in: templateIds.map((id) => new mongoose.Types.ObjectId(id)) }
            }
        },
        {
            $group: {
                _id: '$phaseTemplateId',
                hiringRequestCount: { $sum: 1 },
                activeHiringRequestCount: {
                    $sum: {
                        $cond: [
                            { $in: ['$status', ACTIVE_HIRING_REQUEST_STATUSES] },
                            1,
                            0
                        ]
                    }
                }
            }
        }
    ]);

    return new Map(usage.map((item) => [String(item._id), item]));
};

const findActiveUsage = async (companyId, templateId) => (
    HiringRequest.find({
        companyId,
        phaseTemplateId: templateId,
        status: { $in: ACTIVE_HIRING_REQUEST_STATUSES }
    })
        .select('requestId roleDetails.title status')
        .lean()
);

const buildTemplateResponse = (template, usage = {}) => ({
    ...template,
    phases: copyTemplatePhasesForHiringRequest(template.phases || []).map((phase, index) => ({
        ...phase,
        _id: template.phases?.[index]?._id || phase.phaseId
    })),
    hiringRequestCount: usage.hiringRequestCount || 0,
    activeHiringRequestCount: usage.activeHiringRequestCount || 0,
    isInUse: (usage.activeHiringRequestCount || 0) > 0
});

exports.createTemplate = async (req, res) => {
    if (!ensureTemplateEditor(req, res)) return;

    try {
        const name = normalizeLabel(req.body?.name);
        if (!name) {
            return res.status(400).json({ message: 'Template name is required' });
        }

        const phases = validateAndSanitizePhases(req.body?.phases || []);
        const isDefault = Boolean(req.body?.isDefault);

        if (isDefault) {
            await PhaseTemplate.updateMany(
                { companyId: req.companyId, isDefault: true },
                { $set: { isDefault: false } }
            );
        }

        const template = await PhaseTemplate.create({
            companyId: req.companyId,
            name,
            description: normalizeLabel(req.body?.description),
            isDefault,
            phases,
            createdBy: req.user._id
        });

        const createdTemplate = await PhaseTemplate.findById(template._id).lean();

        res.status(201).json({
            message: 'Phase template created successfully',
            template: buildTemplateResponse(createdTemplate)
        });
    } catch (error) {
        console.error('createTemplate error:', error);
        if (error.code === 11000) {
            return res.status(400).json({ message: 'A template with this name already exists' });
        }

        res.status(error.statusCode || 500).json({
            message: error.statusCode ? error.message : 'Failed to create phase template',
            error: error.message
        });
    }
};

exports.getTemplates = async (req, res) => {
    try {
        const includeInactive = String(req.query?.includeInactive || 'false').toLowerCase() === 'true';
        const query = {
            companyId: req.companyId,
            ...(includeInactive ? {} : { isActive: true })
        };

        const templates = await PhaseTemplate.find(query).sort({ name: 1 }).lean();
        const usageMap = await getTemplateUsageMap(req.companyId, templates.map((template) => template._id));

        res.status(200).json({
            templates: templates.map((template) => buildTemplateResponse(template, usageMap.get(String(template._id))))
        });
    } catch (error) {
        console.error('getTemplates error:', error);
        res.status(500).json({ message: 'Failed to fetch phase templates', error: error.message });
    }
};

exports.getTemplateById = async (req, res) => {
    try {
        if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
            return res.status(400).json({ message: 'Invalid phase template ID format' });
        }

        const template = await PhaseTemplate.findOne({
            _id: req.params.id,
            companyId: req.companyId
        }).lean();

        if (!template) {
            return res.status(404).json({ message: 'Phase template not found' });
        }

        const usageMap = await getTemplateUsageMap(req.companyId, [template._id]);
        res.status(200).json({
            template: buildTemplateResponse(template, usageMap.get(String(template._id)))
        });
    } catch (error) {
        console.error('getTemplateById error:', error);
        res.status(500).json({ message: 'Failed to fetch phase template', error: error.message });
    }
};

exports.updateTemplate = async (req, res) => {
    if (!ensureTemplateEditor(req, res)) return;

    try {
        if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
            return res.status(400).json({ message: 'Invalid phase template ID format' });
        }

        const template = await PhaseTemplate.findOne({
            _id: req.params.id,
            companyId: req.companyId
        });

        if (!template) {
            return res.status(404).json({ message: 'Phase template not found' });
        }

        const name = normalizeLabel(req.body?.name);
        if (!name) {
            return res.status(400).json({ message: 'Template name is required' });
        }

        const phases = validateAndSanitizePhases(req.body?.phases || []);
        const phasesChanged = JSON.stringify(template.phases.map((phase) => phase.toObject())) !== JSON.stringify(phases);
        const isDefault = Boolean(req.body?.isDefault);

        if (isDefault) {
            await PhaseTemplate.updateMany(
                {
                    companyId: req.companyId,
                    _id: { $ne: template._id },
                    isDefault: true
                },
                { $set: { isDefault: false } }
            );
        }

        template.name = name;
        template.description = normalizeLabel(req.body?.description);
        template.isDefault = isDefault;
        template.phases = phases;
        await template.save();

        const updatedTemplate = await PhaseTemplate.findById(template._id).lean();
        const activeUsage = phasesChanged ? await findActiveUsage(req.companyId, template._id) : [];

        res.status(200).json({
            message: phasesChanged && activeUsage.length
                ? 'Phase template updated. Existing hiring requests keep their saved phase copy.'
                : 'Phase template updated successfully',
            warning: phasesChanged && activeUsage.length
                ? `This template is already in use by ${activeUsage.length} hiring request(s). Existing requests will keep their copied phases.`
                : undefined,
            template: buildTemplateResponse(updatedTemplate, {
                hiringRequestCount: await HiringRequest.countDocuments({ companyId: req.companyId, phaseTemplateId: template._id }),
                activeHiringRequestCount: activeUsage.length
            })
        });
    } catch (error) {
        console.error('updateTemplate error:', error);
        if (error.code === 11000) {
            return res.status(400).json({ message: 'A template with this name already exists' });
        }

        res.status(error.statusCode || 500).json({
            message: error.statusCode ? error.message : 'Failed to update phase template',
            error: error.message
        });
    }
};

exports.deleteTemplate = async (req, res) => {
    if (!ensureTemplateEditor(req, res)) return;

    try {
        if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
            return res.status(400).json({ message: 'Invalid phase template ID format' });
        }

        const template = await PhaseTemplate.findOne({
            _id: req.params.id,
            companyId: req.companyId
        });

        if (!template) {
            return res.status(404).json({ message: 'Phase template not found' });
        }

        const activeRequests = await findActiveUsage(req.companyId, template._id);
        if (activeRequests.length) {
            return res.status(400).json({
                message: `Cannot delete this template because it is used by active hiring requests: ${activeRequests.map((request) => `${request.requestId} (${request.roleDetails?.title || 'Untitled'})`).join(', ')}`
            });
        }

        template.isActive = false;
        template.isDefault = false;
        await template.save();

        res.status(200).json({ message: 'Phase template deleted successfully' });
    } catch (error) {
        console.error('deleteTemplate error:', error);
        res.status(500).json({ message: 'Failed to delete phase template', error: error.message });
    }
};

exports.setDefault = async (req, res) => {
    if (!ensureTemplateEditor(req, res)) return;

    try {
        if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
            return res.status(400).json({ message: 'Invalid phase template ID format' });
        }

        const template = await PhaseTemplate.findOne({
            _id: req.params.id,
            companyId: req.companyId,
            isActive: true
        });

        if (!template) {
            return res.status(404).json({ message: 'Phase template not found' });
        }

        await PhaseTemplate.updateMany(
            { companyId: req.companyId, _id: { $ne: template._id } },
            { $set: { isDefault: false } }
        );

        template.isDefault = true;
        await template.save();

        const updatedTemplate = await PhaseTemplate.findById(template._id).lean();
        res.status(200).json({
            message: 'Default phase template updated successfully',
            template: buildTemplateResponse(updatedTemplate)
        });
    } catch (error) {
        console.error('setDefault error:', error);
        res.status(500).json({ message: 'Failed to set default phase template', error: error.message });
    }
};

exports.cloneTemplate = async (req, res) => {
    if (!ensureTemplateEditor(req, res)) return;

    try {
        if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
            return res.status(400).json({ message: 'Invalid phase template ID format' });
        }

        const template = await PhaseTemplate.findOne({
            _id: req.params.id,
            companyId: req.companyId
        }).lean();

        if (!template) {
            return res.status(404).json({ message: 'Phase template not found' });
        }

        const baseName = `Copy of ${template.name}`;
        let cloneName = baseName;
        let suffix = 2;

        while (await PhaseTemplate.exists({ companyId: req.companyId, name: cloneName })) {
            cloneName = `${baseName} (${suffix})`;
            suffix += 1;
        }

        const clonedTemplate = await PhaseTemplate.create({
            companyId: req.companyId,
            name: cloneName,
            description: template.description || '',
            isDefault: false,
            isActive: true,
            phases: validateAndSanitizePhases(copyTemplatePhasesForHiringRequest(template.phases || [])),
            createdBy: req.user._id
        });

        const freshClone = await PhaseTemplate.findById(clonedTemplate._id).lean();
        res.status(201).json({
            message: 'Phase template cloned successfully',
            template: buildTemplateResponse(freshClone)
        });
    } catch (error) {
        console.error('cloneTemplate error:', error);
        res.status(error.statusCode || 500).json({
            message: error.statusCode ? error.message : 'Failed to clone phase template',
            error: error.message
        });
    }
};

exports.getDefaultTemplate = async (req, res) => {
    try {
        let template = await PhaseTemplate.findOne({
            companyId: req.companyId,
            isActive: true,
            isDefault: true
        }).lean();

        if (!template) {
            template = await PhaseTemplate.findOne({
                companyId: req.companyId,
                isActive: true
            }).sort({ name: 1 }).lean();
        }

        if (!template) {
            return res.status(404).json({ message: 'No phase templates found' });
        }

        const usageMap = await getTemplateUsageMap(req.companyId, [template._id]);
        res.status(200).json({
            template: buildTemplateResponse(template, usageMap.get(String(template._id)))
        });
    } catch (error) {
        console.error('getDefaultTemplate error:', error);
        res.status(500).json({ message: 'Failed to fetch default phase template', error: error.message });
    }
};
