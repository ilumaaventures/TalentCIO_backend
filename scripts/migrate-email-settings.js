require('dotenv').config();
const mongoose = require('mongoose');
const Company = require('../src/models/Company');

async function run() {
    const mongoUri = process.env.MONGODB_URI || process.env.MONGO_URI;
    if (!mongoUri) {
        throw new Error('MONGODB_URI is not configured.');
    }

    await mongoose.connect(mongoUri);
    console.log('Connected. Running email settings migration...');

    const result = await Company.updateMany(
        { 'settings.email': { $exists: false } },
        {
            $set: {
                'settings.email': {
                    defaultAccountId: 'platform',
                    accounts: [],
                    provider: 'platform',
                    fromName: '',
                    fromAddress: '',
                    brevoApiKey: '',
                    smtp: {
                        host: '',
                        port: 587,
                        secure: false,
                        user: '',
                        pass: ''
                    },
                    verified: false,
                    verifiedAt: null,
                    testSentAt: null
                }
            }
        }
    );

    console.log(`Migration complete. Updated ${result.modifiedCount || 0} companies.`);
    await mongoose.disconnect();
}

run().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
