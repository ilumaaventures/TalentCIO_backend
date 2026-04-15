const mongoose = require('mongoose');
require('dotenv').config();

async function fixIndexes() {
    try {
        const uri = process.env.MONGO_URI || process.env.MONGODB_URI;
        if (!uri) throw new Error('MONGO_URI or MONGODB_URI not found');

        console.log('Connecting to MongoDB...');
        await mongoose.connect(uri);
        console.log('Connected.');

        const db = mongoose.connection.db;
        const collection = db.collection('onboardingemployees');

        console.log('Checking indexes for onboardingemployees...');
        const indexes = await collection.indexes();
        console.log('Current indexes:', JSON.stringify(indexes, null, 2));

        const rogueIndex = 'tempEmployeeId_1';
        const hasRogue = indexes.some(idx => idx.name === rogueIndex);

        if (hasRogue) {
            console.log(`Found rogue index: ${rogueIndex}. Dropping it...`);
            await collection.dropIndex(rogueIndex);
            console.log('Successfully dropped rogue index.');
        } else {
            console.log(`Rogue index ${rogueIndex} not found.`);
        }

        console.log('Finished.');
        process.exit(0);
    } catch (err) {
        console.error('Error:', err);
        process.exit(1);
    }
}

fixIndexes();
