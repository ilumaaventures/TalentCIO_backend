const axios = require('axios');
const Company = require('../models/Company');
const User = require('../models/User');
const EmployeeProfile = require('../models/EmployeeProfile');
const { signWebhookPayload } = require('../utils/payrollCrypto');

const PAYROLL_COMPANY_SELECT = 'name status settings.payrollIntegration settings.attendance.weeklyOff';
const PAYROLL_USER_SELECT = [
    '_id',
    'firstName',
    'lastName',
    'email',
    'department',
    'workLocation',
    'employmentType',
    'employeeCode',
    'joiningDate',
    'isActive',
    'employeeProfile',
    'companyId'
].join(' ');
const PAYROLL_PROFILE_SELECT = [
    'user',
    'companyId',
    'personal.firstName',
    'personal.middleName',
    'personal.lastName',
    'personal.fullName',
    'personal.dob',
    'personal.gender',
    'contact.personalEmail',
    'contact.workEmail',
    'contact.mobileNumber',
    'contact.alternateNumber',
    'contact.addresses',
    'employment.designation',
    'employment.department',
    'employment.joiningDate',
    'employment.status',
    'employment.workLocation',
    'employment.branch',
    'employment.employmentType',
    'compensation.bankDetails.ifscCode',
    'compensation.bankDetails.bankName',
    'compensation.bankDetails.accountHolderName',
    'compensation.bankDetails.branchAddress',
    'compensation.uanNumber',
    'compensation.salaryBreakup'
].join(' ');
const PAYROLL_PROFILE_HIDDEN_SELECT = '+identity.aadhaarNumber +identity.panNumber +compensation.ctc +compensation.bankDetails.accountNumber';

const normalizePayrollIntegrationSettings = (companyOrSettings = {}) => {
    const base = companyOrSettings?.settings?.payrollIntegration || companyOrSettings?.payrollIntegration || companyOrSettings || {};

    return {
        enabled: base.enabled === true,
        externalTenantId: String(base.externalTenantId || '').trim(),
        accessToken: String(base.accessToken || '').trim(),
        encryptPayloads: base.encryptPayloads === true,
        encryptionSecret: String(base.encryptionSecret || '').trim(),
        webhookUrl: String(base.webhookUrl || '').trim(),
        webhookSecret: String(base.webhookSecret || '').trim()
    };
};

const findCompanyByExternalTenantId = async (externalTenantId) => {
    const normalizedTenantId = String(externalTenantId || '').trim();
    if (!normalizedTenantId) {
        return null;
    }

    return Company.findOne({
        'settings.payrollIntegration.enabled': true,
        'settings.payrollIntegration.externalTenantId': normalizedTenantId
    }).select(PAYROLL_COMPANY_SELECT);
};

const buildProfileMap = async (companyId, userIds = []) => {
    if (!Array.isArray(userIds) || userIds.length === 0) {
        return new Map();
    }

    const profiles = await EmployeeProfile.find({
        companyId,
        user: { $in: userIds }
    })
        .select(`${PAYROLL_PROFILE_SELECT} ${PAYROLL_PROFILE_HIDDEN_SELECT}`)
        .lean();

    return new Map(
        profiles.map((profile) => [String(profile.user), profile])
    );
};

const formatDateValue = (value) => {
    if (!value) return null;
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
};

const getSalaryField = (salaryBreakup, key, defaultValue) => {
    if (!salaryBreakup) return defaultValue;
    let val;
    if (typeof salaryBreakup.get === 'function') {
        val = salaryBreakup.get(key);
    } else {
        val = salaryBreakup[key];
    }
    return val !== undefined ? val : defaultValue;
};

const buildEmployeePayload = (user, profile = null) => {
    const personal = profile?.personal || {};
    const contact = profile?.contact || {};
    const employment = profile?.employment || {};
    const compensation = profile?.compensation || {};
    const bankDetails = compensation.bankDetails || {};
    const identity = profile?.identity || {};
    const fullName = personal.fullName
        || [user?.firstName, user?.lastName].filter(Boolean).join(' ').trim();

    const salaryBreakup = compensation.salaryBreakup;
    const getBool = (key, def) => {
        const val = getSalaryField(salaryBreakup, key, def);
        return val === true || val === 'true';
    };
    const getNum = (key, def) => {
        const val = getSalaryField(salaryBreakup, key, def);
        return val !== null && val !== undefined && val !== '' ? Number(val) : def;
    };
    const getStr = (key, def) => {
        const val = getSalaryField(salaryBreakup, key, def);
        return val !== null && val !== undefined ? String(val) : def;
    };

    return {
        employeeId: user?.employeeCode || String(user?._id || ''),
        userId: String(user?._id || ''),
        employeeCode: user?.employeeCode || '',
        firstName: user?.firstName || personal.firstName || '',
        middleName: personal.middleName || '',
        lastName: user?.lastName || personal.lastName || '',
        fullName,
        email: user?.email || contact.workEmail || '',
        department: employment.department || user?.department || '',
        designation: employment.designation || '',
        employmentType: employment.employmentType || user?.employmentType || '',
        workLocation: employment.branch || user?.workLocation || '',
        joiningDate: formatDateValue(employment.joiningDate || user?.joiningDate),
        isActive: user?.isActive !== false,
        personal: {
            dob: formatDateValue(personal.dob),
            gender: personal.gender || '',
            mobileNumber: contact.mobileNumber || '',
            alternateNumber: contact.alternateNumber || '',
            personalEmail: contact.personalEmail || '',
            workEmail: contact.workEmail || user?.email || '',
            addresses: Array.isArray(contact.addresses) ? contact.addresses : []
        },
        identity: {
            panNumber: identity.panNumber || '',
            aadhaarNumber: identity.aadhaarNumber || ''
        },
        compensation: {
            ctc: compensation.ctc ?? null,
            pfEnabled: getBool('pfEnabled', true),
            esiEnabled: getBool('esiEnabled', true),
            ptEnabled: getBool('ptEnabled', true),
            lwfEnabled: getBool('lwfEnabled', true),
            gratuityEnabled: getBool('gratuityEnabled', true),
            includePfInCTC: getBool('includePfInCTC', false),
            includeGratuityInCTC: getBool('includeGratuityInCTC', true),
            basicPercent: getNum('basicPercent', null),
            hraPercent: getNum('hraPercent', null),
            useSalaryComponents: getBool('useSalaryComponents', true),
            ptState: getStr('ptState', '')
        },
        bankDetails: {
            accountNumber: bankDetails.accountNumber || '',
            ifscCode: bankDetails.ifscCode || '',
            bankName: bankDetails.bankName || '',
            accountHolderName: bankDetails.accountHolderName || fullName,
            branchAddress: bankDetails.branchAddress || '',
            uanNumber: compensation.uanNumber || ''
        }
    };
};

const getEmployeePayloadByUserId = async ({ companyId, userId, includeDeleted = true }) => {
    const user = await User.findOne(
        { _id: userId, companyId },
        null,
        includeDeleted ? { includeDeleted: true } : undefined
    )
        .select(PAYROLL_USER_SELECT)
        .lean();

    if (!user) {
        return null;
    }

    const profileMap = await buildProfileMap(companyId, [user._id]);
    return buildEmployeePayload(user, profileMap.get(String(user._id)) || null);
};

const listActiveEmployeesForPayroll = async (companyId) => {
    const users = await User.find({ companyId, isActive: true })
        .select(PAYROLL_USER_SELECT)
        .sort({ joiningDate: 1, createdAt: 1 })
        .lean();
    const profileMap = await buildProfileMap(companyId, users.map((user) => user._id));

    return users.map((user) => buildEmployeePayload(user, profileMap.get(String(user._id)) || null));
};

const dispatchEmployeeWebhook = async ({
    companyId,
    company = null,
    userId,
    event = 'employee.updated'
}) => {
    const resolvedCompany = company || await Company.findById(companyId).select(PAYROLL_COMPANY_SELECT).lean();
    if (!resolvedCompany) {
        return { dispatched: false, reason: 'company_not_found' };
    }

    const config = normalizePayrollIntegrationSettings(resolvedCompany);
    if (!config.enabled || !config.webhookUrl || !config.webhookSecret || !config.externalTenantId) {
        return { dispatched: false, reason: 'integration_not_configured' };
    }

    const employee = await getEmployeePayloadByUserId({ companyId: resolvedCompany._id || companyId, userId });
    if (!employee) {
        return { dispatched: false, reason: 'employee_not_found' };
    }

    const payload = {
        event,
        tenantId: config.externalTenantId,
        timestamp: new Date().toISOString(),
        employee
    };
    const signature = signWebhookPayload(payload, config.webhookSecret);

    await axios.post(config.webhookUrl, payload, {
        headers: {
            'Content-Type': 'application/json',
            'x-hrms-signature': signature
        },
        timeout: 10000
    });

    return { dispatched: true };
};

module.exports = {
    normalizePayrollIntegrationSettings,
    findCompanyByExternalTenantId,
    listActiveEmployeesForPayroll,
    getEmployeePayloadByUserId,
    dispatchEmployeeWebhook,
    buildEmployeePayload
};
