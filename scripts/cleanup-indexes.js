const mongoose = require('mongoose');
require('dotenv').config();

async function cleanupIndexes() {
    try {
        const uri = process.env.MONGO_URI || process.env.MONGODB_URI;
        if (!uri) throw new Error('MONGO_URI or MONGODB_URI not found in environment');
        
        console.log(`Connecting to: ${uri.replace(/\/\/.*@/, '//****:****@')}`); // log URI with credentials hidden
        await mongoose.connect(uri);
        console.log('Connected to MongoDB');

        const db = mongoose.connection.db;
        const collections = await db.listCollections().toArray();
        const collectionNames = collections.map(c => c.name);

        const targetCollections = [
            'roles', 'timesheets', 'hiringrequests', 'worklogs', 'attendance', 
            'querytypes', 'leavebalances', 'leaveconfigs', 'holidays', 
            'projects', 'modules', 'tasks', 'helpdeskqueries', 'candidates'
        ];

        for (const collName of targetCollections) {
            if (!collectionNames.includes(collName)) {
                console.log(`Collection ${collName} does not exist, skipping.`);
                continue;
            }

            console.log(`--- Checking indexes for: ${collName} ---`);
            const coll = db.collection(collName);
            const indexes = await coll.indexes();
            
            for (const idx of indexes) {
                // If it's a unique index and doesn't contain companyId (except for _id)
                const isUnique = idx.unique;
                const keys = Object.keys(idx.key);
                const isCompoundWithCompany = keys.includes('companyId');

                if (isUnique && !isCompoundWithCompany && idx.name !== '_id_') {
                    console.log(`[WARNING] Found unscoped unique index: ${idx.name} on ${collName}`);
                    console.log(`Dropping index ${idx.name}...`);
                    try {
                        await coll.dropIndex(idx.name);
                        console.log(`Successfully dropped ${idx.name}`);
                    } catch (e) {
                        console.error(`Failed to drop ${idx.name}:`, e.message);
                    }
                } else {
                    console.log(`Index ${idx.name} is fine.`);
                }
            }
        }

        console.log('\nCleanup complete.');
        process.exit(0);
    } catch (error) {
        console.error('Cleanup failed:', error);
        process.exit(1);
    }
}

cleanupIndexes();
