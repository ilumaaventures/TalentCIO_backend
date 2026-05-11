const {
    getEntityModel,
    getDeletedEntityKeys,
    restoreProjectTree,
    restoreModuleTree,
    restoreTaskTree,
    getEntityConflictLabel,
    findRestoreConflict,
    moveEntityToBin,
    purgeDeletedDocument
} = require('../services/binService');

const ENTITY_POPULATE_FIELDS = 'firstName lastName email';

const restoreEntityTree = async (entity, item, req) => {
    const entityKey = String(entity || '').toLowerCase();

    if (entityKey === 'project') {
        await restoreProjectTree(item._id, req.companyId);
    }

    if (entityKey === 'module') {
        await restoreModuleTree(item._id, req.companyId);
    }

    if (entityKey === 'task') {
        await restoreTaskTree(item._id, req.companyId);
    }

    if (entityKey === 'user') {
        item.isActive = true;
        await item.save();
    }
};

const buildConflictResponse = (entity, binItem, activeItem) => {
    const entityLabel = String(entity || 'item').toLowerCase();
    const conflictingLabel = getEntityConflictLabel(entity, activeItem);
    const restoringLabel = getEntityConflictLabel(entity, binItem);

    return {
        message: `A matching ${entityLabel} already exists. Choose replace to move "${conflictingLabel}" to the bin and restore "${restoringLabel}", or cancel.`,
        requiresAction: true,
        options: ['replace', 'cancel'],
        conflict: {
            id: activeItem._id,
            entity: entityLabel,
            title: conflictingLabel
        }
    };
};

exports.getBinItems = async (req, res) => {
    try {
        const { entity, page = 1, limit = 20 } = req.query;
        const companyId = req.companyId;
        const normalizedPage = Math.max(Number(page) || 1, 1);
        const normalizedLimit = Math.max(Number(limit) || 20, 1);
        const skip = (normalizedPage - 1) * normalizedLimit;

        if (entity) {
            const Model = getEntityModel(entity);
            if (!Model) {
                return res.status(400).json({ message: `Unknown entity type: ${entity}` });
            }

            const [items, total] = await Promise.all([
                Model.find({ companyId, isDeleted: true }, null, { includeDeleted: true })
                    .sort({ deletedAt: -1 })
                    .skip(skip)
                    .limit(normalizedLimit)
                    .populate('deletedBy', ENTITY_POPULATE_FIELDS)
                    .lean(),
                Model.countDocuments({ companyId, isDeleted: true })
            ]);

            return res.json({
                entity: String(entity).toLowerCase(),
                items,
                total,
                page: normalizedPage,
                limit: normalizedLimit
            });
        }

        const keys = getDeletedEntityKeys();
        const groupedEntries = await Promise.all(keys.map(async (key) => {
            const Model = getEntityModel(key);
            const [items, total] = await Promise.all([
                Model.find({ companyId, isDeleted: true }, null, { includeDeleted: true })
                    .sort({ deletedAt: -1 })
                    .limit(5)
                    .populate('deletedBy', ENTITY_POPULATE_FIELDS)
                    .lean(),
                Model.countDocuments({ companyId, isDeleted: true })
            ]);

            return [key, { items, total }];
        }));

        const groups = Object.fromEntries(groupedEntries.map(([key, value]) => [key, value.items]));
        const counts = Object.fromEntries(groupedEntries.map(([key, value]) => [key, value.total]));
        const total = Object.values(counts).reduce((sum, count) => sum + count, 0);

        res.json({ groups, counts, total });
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
};

exports.restoreItem = async (req, res) => {
    try {
        const { entity, id } = req.params;
        const action = String(req.body?.action || '').trim().toLowerCase();
        const Model = getEntityModel(entity);
        if (!Model) {
            return res.status(400).json({ message: `Unknown entity type: ${entity}` });
        }

        const item = await Model.findOne(
            { _id: id, companyId: req.companyId, isDeleted: true },
            null,
            { includeDeleted: true }
        );
        if (!item) {
            return res.status(404).json({ message: 'Item not found in bin' });
        }

        const conflictingItem = await findRestoreConflict(entity, item);
        if (conflictingItem) {
            if (action === 'cancel') {
                return res.json({ message: 'Restore cancelled', cancelled: true });
            }

            if (action !== 'replace') {
                return res.status(409).json(buildConflictResponse(entity, item, conflictingItem));
            }

            await moveEntityToBin(entity, conflictingItem, req.user?._id, req.companyId);
        }

        await item.restore();
        await restoreEntityTree(entity, item, req);

        res.json({
            message: conflictingItem
                ? `${entity} restored successfully and the existing conflicting item was moved to the bin`
                : `${entity} restored successfully`
        });
    } catch (error) {
        if (error?.code === 11000) {
            return res.status(409).json({
                message: 'A conflicting active record already exists, so this item cannot be restored as-is.',
                requiresAction: true,
                options: ['replace', 'cancel']
            });
        }

        res.status(500).json({ message: error.message });
    }
};

exports.permanentDeleteItem = async (req, res) => {
    try {
        const { entity, id } = req.params;
        const Model = getEntityModel(entity);
        if (!Model) {
            return res.status(400).json({ message: `Unknown entity type: ${entity}` });
        }

        const item = await Model.findOne(
            { _id: id, companyId: req.companyId, isDeleted: true },
            null,
            { includeDeleted: true }
        );
        if (!item) {
            return res.status(404).json({ message: 'Item not found in bin' });
        }

        await purgeDeletedDocument(entity, item);
        res.json({ message: `${entity} permanently deleted` });
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
};

exports.emptyBin = async (req, res) => {
    try {
        const { entity } = req.query;
        const companyId = req.companyId;

        if (entity) {
            const Model = getEntityModel(entity);
            if (!Model) {
                return res.status(400).json({ message: `Unknown entity type: ${entity}` });
            }

            const items = await Model.find({ companyId, isDeleted: true }, null, { includeDeleted: true });
            for (const item of items) {
                await purgeDeletedDocument(entity, item);
            }

            return res.json({ message: `Bin for ${entity} emptied` });
        }

        for (const entityKey of getDeletedEntityKeys()) {
            const Model = getEntityModel(entityKey);
            const items = await Model.find({ companyId, isDeleted: true }, null, { includeDeleted: true });
            for (const item of items) {
                await purgeDeletedDocument(entityKey, item);
            }
        }

        res.json({ message: 'Entire bin emptied' });
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
};
