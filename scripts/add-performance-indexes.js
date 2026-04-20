require('dotenv').config();
const mongoose = require('mongoose');
const HelpdeskQuery = require('../src/models/HelpdeskQuery');
const User = require('../src/models/User');
const Attendance = require('../src/models/Attendance');

async function addPerformanceIndexes() {
    try {
        await mongoose.connect(process.env.MONGO_URI);

        const indexesToEnsure = [
            {
                model: HelpdeskQuery,
                spec: { status: 1, createdAt: 1 },
                options: { name: 'status_1_createdAt_1' }
            },
            {
                model: HelpdeskQuery,
                spec: { companyId: 1, status: 1, createdAt: -1 },
                options: { name: 'companyId_1_status_1_createdAt_-1' }
            },
            {
                model: User,
                spec: { companyId: 1, roles: 1, isActive: 1 },
                options: { name: 'companyId_1_roles_1_isActive_1' }
            },
            {
                model: Attendance,
                spec: { date: 1, clockIn: 1, clockOut: 1 },
                options: { name: 'date_1_clockIn_1_clockOut_1' }
            }
        ];

        for (const { model, spec, options } of indexesToEnsure) {
            await model.collection.createIndex(spec, options);
            console.log(`[INDEX] Ensured ${model.collection.collectionName}: ${JSON.stringify(spec)}`);
        }

        console.log('[INDEX] Performance indexes created successfully.');
    } catch (error) {
        console.error('[INDEX] Failed to create performance indexes:', error);
        process.exitCode = 1;
    } finally {
        await mongoose.connection.close();
    }
}

addPerformanceIndexes();
