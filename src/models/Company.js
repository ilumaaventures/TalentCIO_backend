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
        logoPublicId: { type: String, default: '' },
        themeColor: { type: String, default: '#6366f1' },
        workspaceBranding: {
            displayMode: {
                type: String,
                enum: ['talentcio', 'company', 'none'],
                default: 'talentcio'
            },
            logoAlignment: {
                type: String,
                enum: ['left', 'center', 'right'],
                default: 'left'
            },
            logoSize: {
                type: Number,
                default: 140
            }
        },
        emailBranding: {
            displayName: { type: String, default: '' },
            logoUrl: { type: String, default: '' },
            logoPublicId: { type: String, default: '' },
            logoWidth: { type: Number, default: 200 },
            logoHeight: { type: Number, default: 44 },
            logoAlignment: {
                type: String,
                enum: ['left', 'center', 'right'],
                default: 'center'
            },
            brandColor: { type: String, default: '#6366f1' },
            footerText: { type: String, default: '' },
            replyTo: { type: String, default: '' }
        },

        // HR & General Settings
        leavePolicy: { type: String, default: '' },
        attendanceRules: { type: String, default: '' },
        overtimeRules: { type: String, default: '' },

        // Module Specific Configurations
        careers: {
            enableResourceGatewayPublishing: { type: Boolean, default: false }
        },
        email: {
            defaultAccountId: { type: String, default: 'platform' },
            accounts: [{
                name: { type: String, default: '' },
                provider: {
                    type: String,
                    enum: ['brevo', 'smtp'],
                    default: 'brevo'
                },
                fromName: { type: String, default: '' },
                fromAddress: { type: String, default: '' },
                brevoApiKey: { type: String, default: '' },
                smtp: {
                    host: { type: String, default: '' },
                    port: { type: Number, default: 587 },
                    secure: { type: Boolean, default: false },
                    user: { type: String, default: '' },
                    pass: { type: String, default: '' }
                },
                verified: { type: Boolean, default: false },
                verifiedAt: { type: Date, default: null },
                testSentAt: { type: Date, default: null }
            }],
            fromName: { type: String, default: '' },
            fromAddress: { type: String, default: '' },
            provider: {
                type: String,
                enum: ['platform', 'brevo', 'smtp'],
                default: 'platform'
            },
            brevoApiKey: { type: String, default: '' },
            smtp: {
                host: { type: String, default: '' },
                port: { type: Number, default: 587 },
                secure: { type: Boolean, default: false },
                user: { type: String, default: '' },
                pass: { type: String, default: '' }
            },
            verified: { type: Boolean, default: false },
            verifiedAt: { type: Date, default: null },
            testSentAt: { type: Date, default: null }
        },
        notifications: {
            emailSenderAccountId: { type: String, default: '' },
            events: {
                type: Map,
                of: {
                    type: String,
                    enum: ['off', 'system', 'email', 'both']
                },
                default: {}
            },
            eventEmailSenderSources: {
                type: Map,
                of: {
                    type: String,
                    enum: ['notification', 'default']
                },
                default: {}
            },
            eventEmailSenderAccountIds: {
                type: Map,
                of: {
                    type: String
                },
                default: {}
            }
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
            requireLocationTimesheet: { type: Boolean, default: false },
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
        payrollIntegration: {
            enabled: { type: Boolean, default: false },
            externalTenantId: { type: String, default: '', trim: true },
            accessToken: { type: String, default: '', trim: true },
            encryptPayloads: { type: Boolean, default: false },
            encryptionSecret: { type: String, default: '' },
            webhookUrl: { type: String, default: '', trim: true },
            webhookSecret: { type: String, default: '' }
        },
        // Profile settings
        profile: {
            requireCameraCapture: { type: Boolean, default: false }
        },
        // File Import/Export
        excelImportFormat: { type: String, default: 'default' },
    },
    employeeCount: { type: Number, default: 0 },
    activeUserCount: { type: Number, default: 0 },
    trialEndsAt: { type: Date }
}, { timestamps: true });

// Explicit index for tenant middleware lookup — this is the hottest query path
companySchema.index({ subdomain: 1 }, { unique: true });
companySchema.index({ status: 1 });

module.exports = mongoose.model('Company', companySchema);
