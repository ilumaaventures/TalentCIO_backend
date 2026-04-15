const mongoose = require('mongoose');
require('dotenv').config();

// Models
const Company = require('../src/models/Company');
const User = require('../src/models/User');
const Attendance = require('../src/models/Attendance');
const AttendanceRegularization = require('../src/models/AttendanceRegularization');
const LeaveRequest = require('../src/models/LeaveRequest');
const LeaveConfig = require('../src/models/LeaveConfig');
const HelpdeskQuery = require('../src/models/HelpdeskQuery');
const Candidate = require('../src/models/Candidate');
const { HiringRequest } = require('../src/models/HiringRequest');
const Project = require('../src/models/Project');
const Task = require('../src/models/Task');
const Timesheet = require('../src/models/Timesheet');
const Holiday = require('../src/models/Holiday');
const EmployeeProfile = require('../src/models/EmployeeProfile');
const Client = require('../src/models/Client');
const BusinessUnit = require('../src/models/BusinessUnit');
const ActivityLog = require('../src/models/ActivityLog');
const Meeting = require('../src/models/Meeting');
const Notification = require('../src/models/Notification');
const Role = require('../src/models/Role');

async function migrate() {
    try {
        console.log('--- PRODUCTION MIGRATION STARTED ---');
        const uri = process.env.MONGO_URI;
        if (!uri) {
            throw new Error('MONGO_URI is not defined in environment variables');
        }

        await mongoose.connect(uri);
        console.log('Connected to Database.');

        // 1. Find the company that currently holds the migrated data, or grab the first one
        const targetSubdomain = "telentcio"; 
        const companyName = "ilumaa";

        // 1. Find the company that holds actual user data
        let attachedCompany;
        const attachedUser = await User.findOne({ companyId: { $exists: true } });
        if (attachedUser) {
            attachedCompany = await Company.findById(attachedUser.companyId);
        } else {
            attachedCompany = await Company.findOne(); // Fallback if no users have companyId yet
        }

        // 2. Check if the target 'telentcio' company exists and is DIFFERENT from the attached one
        const existingTargetCompany = await Company.findOne({ subdomain: targetSubdomain });

        if (existingTargetCompany && attachedCompany && existingTargetCompany._id.toString() !== attachedCompany._id.toString()) {
            // An empty company was created previously with this subdomain. We need to delete it so we can give its subdomain to the real company.
            console.log(`Deleting empty duplicate company with subdomain '${targetSubdomain}' to make room for data migration.`);
            await Company.findByIdAndDelete(existingTargetCompany._id);
        }

        // 3. Now safely update the real attached company
        if (!attachedCompany) {
            attachedCompany = await Company.create({
                name: companyName,
                subdomain: targetSubdomain,
                email: "admin@ilumaa.com",
                status: "Active",
                timezone: "Asia/Kolkata",
                settings: {
                    attendance: { workingHours: 8, weeklyOff: ['Saturday', 'Sunday'] }
                }
            });
            console.log(`Created Default Company: ${attachedCompany.name} (ID: ${attachedCompany._id})`);
        } else {
            attachedCompany.name = companyName;
            attachedCompany.subdomain = targetSubdomain;
            await attachedCompany.save();
            console.log(`Updated real Company ${attachedCompany._id} to name: ${attachedCompany.name}, subdomain: ${attachedCompany.subdomain}`);
        }

        const defaultCompany = attachedCompany;
 
        // 4. Seed Default Leave Policies for this company if none exist
        console.log('\n--- Seeding Default Leave Policies ---');
        const defaults = [
            { leaveType: 'CL', name: 'Casual Leave', isPaid: true, accrualType: 'Monthly', accrualAmount: 1, maxLimitPerYear: 12, carryForward: false },
            { leaveType: 'SL', name: 'Sick Leave', isPaid: true, accrualType: 'Yearly', accrualAmount: 8, maxLimitPerYear: 8, carryForward: false },
            { leaveType: 'EL', name: 'Earned Leave', isPaid: true, accrualType: 'Monthly', accrualAmount: 1.25, maxLimitPerYear: 15, carryForward: true, maxCarryForward: 30 },
            { leaveType: 'LOP', name: 'Loss of Pay', isPaid: false, accrualType: 'None', maxLimitPerYear: 0, carryForward: false },
            { leaveType: 'WFH', name: 'Work From Home', isPaid: true, accrualType: 'Policy', maxLimitPerYear: 0, carryForward: false }
        ];
 
        for (const def of defaults) {
            const exists = await LeaveConfig.findOne({ leaveType: def.leaveType, companyId: defaultCompany._id });
            if (!exists) {
                await LeaveConfig.create({ ...def, companyId: defaultCompany._id });
                console.log(`Seeded ${def.name} for ${defaultCompany.name}`);
            }
        }

        // 2. All Models that require companyId association
        const modelsToUpdate = [
            { name: 'User', model: User },
            { name: 'Role', model: Role },
            { name: 'Attendance', model: Attendance },
            { name: 'AttendanceRegularization', model: AttendanceRegularization },
            { name: 'LeaveRequest', model: LeaveRequest },
            { name: 'LeaveConfig', model: LeaveConfig },
            { name: 'HelpdeskQuery', model: HelpdeskQuery },
            { name: 'Candidate', model: Candidate },
            { name: 'HiringRequest', model: HiringRequest },
            { name: 'Project', model: Project },
            { name: 'Task', model: Task },
            { name: 'Timesheet', model: Timesheet },
            { name: 'Holiday', model: Holiday },
            { name: 'EmployeeProfile', model: EmployeeProfile },
            { name: 'Client', model: Client },
            { name: 'BusinessUnit', model: BusinessUnit },
            { name: 'ActivityLog', model: ActivityLog },
            { name: 'Meeting', model: Meeting },
            { name: 'Notification', model: Notification }
        ];

        console.log('\n--- Syncing Data with Company ID ---');
        for (const { name, model } of modelsToUpdate) {
            const result = await model.updateMany(
                { companyId: { $exists: false } },
                { $set: { companyId: defaultCompany._id } }
            );
            console.log(`Associated ${result.modifiedCount} ${name} records.`);
        }

        console.log('\n--- Migration Completed Successfully ---');
        process.exit(0);
    } catch (err) {
        console.error('Migration Failed:', err);
        process.exit(1);
    }
}

migrate();
