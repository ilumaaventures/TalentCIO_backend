const mongoose = require('mongoose');
require('dotenv').config();

// Models
const User = require('../src/models/User');
const Company = require('../src/models/Company');
const ApprovalWorkflow = require('../src/models/ApprovalWorkflow');
const InterviewWorkflow = require('../src/models/InterviewWorkflow');
const AuditLog = require('../src/models/AuditLog');
const Discussion = require('../src/models/Discussion');
const EscalationRule = require('../src/models/EscalationRule');
const HelpdeskQuery = require('../src/models/HelpdeskQuery');
const LeaveBalance = require('../src/models/LeaveBalance');
const ModuleModel = require('../src/models/Module');
const QueryType = require('../src/models/QueryType');
const Timesheet = require('../src/models/Timesheet');
const WorkLog = require('../src/models/WorkLog');
const Project = require('../src/models/Project');

async function migrate() {
    try {
        console.log('--- COMPREHENSIVE MULTI-TENANCY MIGRATION STARTED ---');
        const uri = process.env.MONGO_URI;
        if (!uri) {
            throw new Error('MONGO_URI is not defined in environment variables');
        }

        await mongoose.connect(uri);
        console.log('Connected to Database.');

        const fallbackCompany = await Company.findOne();
        if (!fallbackCompany) {
            console.warn('No company found in database. Migration cannot proceed safely.');
            process.exit(1);
        }
        console.log(`Using fallback Company: ${fallbackCompany.name} (ID: ${fallbackCompany._id})`);

        const models = [
            { name: 'ApprovalWorkflow', model: ApprovalWorkflow, userField: 'createdBy' },
            { name: 'InterviewWorkflow', model: InterviewWorkflow, userField: 'createdBy' },
            { name: 'AuditLog', model: AuditLog, userField: 'performedBy' },
            { name: 'Discussion', model: Discussion, userField: 'createdBy' },
            { name: 'EscalationRule', model: EscalationRule, userField: null }, // Global rules
            { name: 'HelpdeskQuery', model: HelpdeskQuery, userField: 'raisedBy' },
            { name: 'LeaveBalance', model: LeaveBalance, userField: 'user' },
            { name: 'Module', model: ModuleModel, userField: null, refField: 'project', refModel: Project },
            { name: 'QueryType', model: QueryType, userField: 'assignedPerson' },
            { name: 'Timesheet', model: Timesheet, userField: 'user' },
            { name: 'WorkLog', model: WorkLog, userField: 'user' },
            { name: 'HiringRequest', model: HiringRequest, userField: 'createdBy' }
        ];

        for (const { name, model, userField, refField, refModel } of models) {
            console.log(`\nProcessing ${name}...`);
            const records = await model.find({ companyId: { $exists: false } });
            console.log(`Found ${records.length} records missing companyId.`);

            let updatedCount = 0;
            for (const record of records) {
                let targetCompanyId = fallbackCompany._id;

                if (userField && record[userField]) {
                    const user = await User.findById(record[userField]);
                    if (user && user.companyId) {
                        targetCompanyId = user.companyId;
                    }
                } else if (refField && refModel && record[refField]) {
                    const refDoc = await refModel.findById(record[refField]);
                    if (refDoc && refDoc.companyId) {
                        targetCompanyId = refDoc.companyId;
                    }
                }

                await model.updateOne({ _id: record._id }, { $set: { companyId: targetCompanyId } });
                updatedCount++;
            }
            console.log(`Successfully updated ${updatedCount} ${name} records.`);
        }

        console.log('\n--- Migration Completed Successfully ---');
        process.exit(0);
    } catch (err) {
        console.error('Migration Failed:', err);
        process.exit(1);
    }
}

migrate();
