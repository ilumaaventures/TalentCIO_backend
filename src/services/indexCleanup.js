const mongoose = require('mongoose');

const cleanupStaleIndexes = async () => {
    const report = {
        checked: [],
        dropped: [],
        errors: []
    };

    try {
        console.log('[INDEX_CLEANUP] Starting stale index check...');
        const db = mongoose.connection.db;
        const collections = await db.listCollections().toArray();
        const collectionNames = collections.map(c => c.name);

        const targetCollections = [
            'roles', 'timesheets', 'hiringrequests', 'worklogs', 'attendance',
            'querytypes', 'leavebalances', 'leaveconfigs', 'holidays',
            'projects', 'modules', 'tasks', 'helpdeskqueries', 'candidates', 'users',
            'onboardingemployees'
        ];

        for (const collName of targetCollections) {
            if (!collectionNames.includes(collName)) continue;

            report.checked.push(collName);
            const coll = db.collection(collName);
            const indexes = await coll.indexes();

            for (const idx of indexes) {
                // If it's a unique index and doesn't contain companyId (except for _id)
                const isUnique = idx.unique;
                const keys = Object.keys(idx.key);
                const isCompoundWithCompany = keys.includes('companyId');

                if (isUnique && !isCompoundWithCompany && idx.name !== '_id_') {
                    console.log(`[INDEX_CLEANUP] Found unscoped unique index: ${idx.name} on ${collName}. Dropping...`);
                    try {
                        await coll.dropIndex(idx.name);
                        console.log(`[INDEX_CLEANUP] Successfully dropped ${idx.name}`);
                        report.dropped.push({ collection: collName, index: idx.name });
                    } catch (e) {
                        console.error(`[INDEX_CLEANUP] Failed to drop ${idx.name}:`, e.message);
                        report.errors.push({ collection: collName, index: idx.name, error: e.message });
                    }
                }
            }
        }
        console.log('[INDEX_CLEANUP] Stale index check complete.');
        return report;
    } catch (error) {
        console.error('[INDEX_CLEANUP] Cleanup failed:', error);
        report.errors.push({ global: error.message });
        return report;
    }
};

module.exports = cleanupStaleIndexes;
