const mongoose = require('mongoose');
require('dotenv').config();

async function checkUsers() {
    try {
        const uri = process.env.MONGO_URI || process.env.MONGODB_URI;
        if (!uri) throw new Error('MONGO_URI or MONGODB_URI not found in environment');

        await mongoose.connect(uri);
        console.log('Connected to MongoDB');

        const db = mongoose.connection.db;
        const usersCol = db.collection('users');

        const users = await usersCol.find({}).toArray();
        console.log('--- User Diagnostics ---');
        users.forEach(u => {
            console.log(`- Email: ${u.email}, companyId: ${u.companyId || 'MISSING'}`);
        });

        const missing = users.filter(u => !u.companyId);
        if (missing.length > 0) {
            console.log(`[WARNING] Found ${missing.length} users WITHOUT a companyId. These users might be bypassing tenant isolation.`);
        }

        process.exit(0);
    } catch (error) {
        console.error('Check failed:', error);
        process.exit(1);
    }
}

checkUsers();
