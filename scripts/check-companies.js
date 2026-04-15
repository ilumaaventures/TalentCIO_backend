const mongoose = require('mongoose');
require('dotenv').config();

async function checkCompanies() {
    try {
        const uri = process.env.MONGO_URI || process.env.MONGODB_URI;
        if (!uri) throw new Error('MONGO_URI or MONGODB_URI not found in environment');
        
        await mongoose.connect(uri);
        console.log('Connected to MongoDB');

        const db = mongoose.connection.db;
        const companiesCol = db.collection('companies');

        const companies = await companiesCol.find({}).toArray();
        console.log('--- Current Companies ---');
        companies.forEach(c => {
            console.log(`- ID: ${c._id}, Name: ${c.name}, Subdomain: ${c.subdomain}`);
        });

        const targetSubdomains = ['telentcio', 'telentcio-demo'];
        for (const sub of targetSubdomains) {
            const found = companies.find(c => c.subdomain === sub);
            if (!found) {
                console.log(`[WARNING] Company with subdomain '${sub}' NOT FOUND. Tenant logic will fail on Vercel for this domain.`);
            }
        }

        process.exit(0);
    } catch (error) {
        console.error('Check failed:', error);
        process.exit(1);
    }
}

checkCompanies();
