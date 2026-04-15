const mongoose = require('mongoose');
require('dotenv').config();

const cleanup = async () => {
    try {
        await mongoose.connect(process.env.MONGO_URI);
        console.log('Connected to MongoDB');

        const collection = mongoose.connection.collection('onboardingemployees');

        // Remove the global unique index on tempEmployeeId
        try {
            await collection.dropIndex('tempEmployeeId_1');
            console.log('Dropped global unique index: tempEmployeeId_1');
        } catch (e) {
            console.log('Global index tempEmployeeId_1 not found or already dropped');
        }

        // Ensure compound index exists
        await collection.createIndex({ companyId: 1, tempEmployeeId: 1 }, { unique: true });
        console.log('Ensured compound unique index: companyId_1_tempEmployeeId_1');

        process.exit(0);
    } catch (err) {
        console.error('Error during cleanup:', err);
        process.exit(1);
    }
};

cleanup();
