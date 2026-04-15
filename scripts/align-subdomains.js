const mongoose = require('mongoose');
require('dotenv').config();

async function alignSubdomains() {
    try {
        const uri = process.env.MONGO_URI || process.env.MONGODB_URI;
        if (!uri) throw new Error('MONGO_URI or MONGODB_URI not found in environment');
        
        await mongoose.connect(uri);
        console.log('Connected to MongoDB');

        const db = mongoose.connection.db;
        const companiesCol = db.collection('companies');

        // 1. Map 'demo' to 'telentcio-demo'
        const demoRes = await companiesCol.updateOne(
            { subdomain: 'demo' },
            { $set: { subdomain: 'telentcio-demo' } }
        );
        if (demoRes.modifiedCount > 0) {
            console.log("Successfully renamed 'demo' -> 'telentcio-demo'");
        } else {
            console.log("Company with subdomain 'demo' not found or already renamed.");
        }

        // 2. Map 'asdf' (or first other company) to 'telentcio'
        // We'll check for 'asdf' first as it seems to be their main test company
        const prodRes = await companiesCol.updateOne(
            { subdomain: 'asdf' },
            { $set: { subdomain: 'telentcio' } }
        );
        if (prodRes.modifiedCount > 0) {
            console.log("Successfully renamed 'asdf' -> 'telentcio'");
        } else {
            console.log("Company with subdomain 'asdf' not found. Checking if 'telentcio' already exists...");
            const exists = await companiesCol.findOne({ subdomain: 'telentcio' });
            if (!exists) {
                console.log("Neither 'asdf' nor 'telentcio' found. You may need to manually pick a production company.");
            } else {
                console.log("'telentcio' subdomain already exists.");
            }
        }

        process.exit(0);
    } catch (error) {
        console.error('Alignment failed:', error);
        process.exit(1);
    }
}

alignSubdomains();
