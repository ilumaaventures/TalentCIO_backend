const cron = require('node-cron');
const {
    getDeletedEntityKeys,
    getEntityModel,
    purgeDeletedDocument
} = require('./bin.service');

let binAutoPurgeTask = null;

const scheduleBinAutoPurge = () => {
    if (binAutoPurgeTask) {
        return binAutoPurgeTask;
    }

    binAutoPurgeTask = cron.schedule('0 2 * * *', async () => {
        const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
        console.log('[BinAutoPurge] Running auto-purge for items deleted before', thirtyDaysAgo.toISOString());

        for (const entityKey of getDeletedEntityKeys()) {
            const Model = getEntityModel(entityKey);
            try {
                const items = await Model.find(
                    { isDeleted: true, deletedAt: { $lt: thirtyDaysAgo } },
                    null,
                    { includeDeleted: true }
                );

                for (const item of items) {
                    await purgeDeletedDocument(entityKey, item);
                }

                if (items.length > 0) {
                    console.log(`[BinAutoPurge] ${entityKey}: purged ${items.length} records`);
                }
            } catch (error) {
                console.error(`[BinAutoPurge] Error purging ${entityKey}:`, error.message);
            }
        }
    }, { scheduled: true });

    return binAutoPurgeTask;
};

module.exports = {
    startBinAutoPurgeCron: () => {
        scheduleBinAutoPurge();
        console.log('[BinAutoPurge] Cron scheduled');
    }
};
