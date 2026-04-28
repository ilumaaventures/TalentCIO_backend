const mongoose = require('mongoose');

const companySchema = new mongoose.Schema({
    name: { type: String, required: true, trim: true },
    subdomain: { type: String, required: true, unique: true, lowercase: true, trim: true },
    email: { type: String, required: true, lowercase: true, trim: true },
    contactPerson: { type: String, trim: true },
    contactPhone: { type: String, trim: true },
    industry: { type: String, trim: true },
    country: { type: String, trim: true },
    timezone: { type: String, default: 'Asia/Kolkata' },
    status: { type: String, enum: ['Active', 'Suspended', 'Trial', 'Inactive'], default: 'Active' },
    planId: { type: mongoose.Schema.Types.ObjectId, ref: 'Plan' },
    allowedDomains: { type: [String], default: [] },
    enabledModules: {
        type: [String],
        default: ['attendance', 'leaves', 'helpdesk', 'userManagement']
    },
    settings: {
        // Branding
        logo: { type: String, default: '' },
        themeColor: { type: String, default: '#6366f1' },

        // HR & General Settings
        leavePolicy: { type: String, default: '' },
        attendanceRules: { type: String, default: '' },
        overtimeRules: { type: String, default: '' },

        // Module Specific Configurations
        careers: {
            enableResourceGatewayPublishing: { type: Boolean, default: false }
        },
        onboarding: {
            offerLetterTemplateUrl: { type: String, default: '' },
            declarationTemplateUrl: { type: String, default: '' },
            dynamicTemplates: [{
                name: { type: String, required: true },
                url: { type: String, required: true },
                publicId: { type: String },
                isRequired: { type: Boolean, default: true }
            }],
            policies: [{
                name: { type: String, required: true },
                url: { type: String, required: true },
                publicId: { type: String },
                isRequired: { type: Boolean, default: false }
            }]
        },
        attendance: {
            weeklyOff: { type: [String], default: ['Saturday', 'Sunday'] },
            workingHours: { type: Number, default: 8 },
            selfService: {
                weeklyOff: { type: Boolean, default: true },
                workingHours: { type: Boolean, default: true },
                defaultAttendanceMode: { type: Boolean, default: true },
                attendanceShifts: { type: Boolean, default: true },
                exportFormat: { type: Boolean, default: true },
                locationRules: { type: Boolean, default: true },
                ipRules: { type: Boolean, default: true }
            },
            defaultShiftCode: { type: String, default: 'general' },
            defaultAttendanceMode: {
                type: String,
                enum: ['clock_in_out', 'present_only'],
                default: 'clock_in_out'
            },
            attendanceShifts: {
                type: [{
                    code: { type: String, required: true, trim: true, lowercase: true },
                    name: { type: String, required: true, trim: true },
                    shiftType: {
                        type: String,
                        enum: ['general', 'any'],
                        default: 'general'
                    },
                    startTime: { type: String, default: '09:00' },
                    endTime: { type: String, default: '18:00' },
                    maxWorkingHours: { type: Number, default: 8 }
                }],
                default: [
                    {
                        code: 'general',
                        name: 'General',
                        shiftType: 'general',
                        startTime: '09:00',
                        endTime: '18:00',
                        maxWorkingHours: 9
                    },
                    {
                        code: 'any',
                        name: 'Any Time',
                        shiftType: 'any',
                        startTime: '00:00',
                        endTime: '23:59',
                        maxWorkingHours: 8
                    }
                ]
            },
            exportFormat: { type: String, default: 'Standard' }, // Standard, Detailed, Compact
            halfDayAllowed: { type: Boolean, default: true },
            requireLocationCheckIn: { type: Boolean, default: false },
            requireLocationCheckOut: { type: Boolean, default: false },
            locationCheck: { type: Boolean, default: false }, // Geo-fencing
            ipCheck: { type: Boolean, default: false },
            allowedRadius: { type: Number, default: 200 }, // in meters
            coordinates: {
                lat: { type: Number },
                lng: { type: Number }
            },
            allowedIps: { type: [String], default: [] }
        },
        timesheet: {
            approvalCycle: {
                type: String,
                enum: ['Daily', 'Weekly', 'Bi-Weekly', 'Monthly'],
                default: 'Monthly'
            },
            exportFormat: { type: String, default: 'Standard' },
            allowPastEntries: { type: Boolean, default: true },
            requireAttachment: { type: Boolean, default: false },
        },
        // File Import/Export
        excelImportFormat: { type: String, default: 'default' },
    },
    employeeCount: { type: Number, default: 0 },
    activeUserCount: { type: Number, default: 0 },
    trialEndsAt: { type: Date }
}, { timestamps: true });

module.exports = mongoose.model('Company', companySchema);
