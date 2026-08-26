const mongoose = require('mongoose');
const EmployeeRevision = require('./employeeRevision.model');
const User = require('../user/user.model');
const EmployeeProfile = require('./employeeProfile.model');
const Role = require('../user/role.model');
const Department = require('../organization/models/department.model');
const Designation = require('../organization/models/designation.model');
const PayrollConfig = require('../payroll/payrollConfig.model');
const LeaveConfig = require('../leave/model/leaveConfig.model');
const LeaveBalance = require('../leave/model/leaveBalance.model');
const { creditLeaveBucket } = require('../leave/accrual.service');
const { processCalculatedSalary } = require('../payroll/payrollMath');
const { dispatchEmployeeWebhook } = require('../payroll/payrollIntegration.service');
const { checkIsAdmin, hasPermission } = require('./utils/dossierHelpers');

const getStartOfDayUTC = (dateInput) => {
    const d = new Date(dateInput);
    return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 0, 0, 0, 0));
};

const getStartOfDayLocal = (dateInput) => {
    const d = new Date(dateInput);
    return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0, 0, 0);
};

const isDateInPast = (dateInput) => {
    const target = getStartOfDayLocal(dateInput);
    const today = getStartOfDayLocal(new Date());
    return target.getTime() < today.getTime();
};

const isDateTodayOrPast = (dateInput) => {
    const target = getStartOfDayLocal(dateInput);
    const today = getStartOfDayLocal(new Date());
    return target.getTime() <= today.getTime();
};

/**
 * Resolves human-readable display values for known fields
 */
const resolveDisplayValue = async (field, value, companyId) => {
    if (value === null || value === undefined || value === '') {
        return 'Not Set';
    }

    if (field === 'department' || field === 'departmentRef') {
        if (typeof value === 'object' && value && value.name) return value.name;
        const id = typeof value === 'object' && value && value._id ? value._id : value;
        if (mongoose.Types.ObjectId.isValid(id)) {
            const dept = await Department.findOne({ _id: id, companyId }).select('name');
            if (dept) return dept.name;
        }
        return String(value);
    }

    if (field === 'designation' || field === 'designationRef') {
        if (typeof value === 'object' && value && value.title) return value.title;
        const id = typeof value === 'object' && value && value._id ? value._id : value;
        if (mongoose.Types.ObjectId.isValid(id)) {
            const desig = await Designation.findOne({ _id: id, companyId }).select('title');
            if (desig) return desig.title;
        }
        return String(value);
    }

    if (field === 'reportingManager' || field === 'reportingManagers' || field === 'primaryManagerId') {
        const mgrRaw = Array.isArray(value) ? value[0] : value;
        if (typeof mgrRaw === 'object' && mgrRaw && (mgrRaw.firstName || mgrRaw.email)) {
            return `${mgrRaw.firstName || ''} ${mgrRaw.lastName || ''} (${mgrRaw.email || ''})`.trim();
        }
        const mgrId = typeof mgrRaw === 'object' && mgrRaw && mgrRaw._id ? mgrRaw._id : mgrRaw;
        if (mgrId && mongoose.Types.ObjectId.isValid(mgrId)) {
            const mgr = await User.findById(mgrId).select('firstName lastName email');
            if (mgr) return `${mgr.firstName} ${mgr.lastName || ''} (${mgr.email || ''})`.trim();
        }
        return 'None';
    }

    if (field === 'roles' || field === 'roleId') {
        const roleRaw = Array.isArray(value) ? value[0] : value;
        if (typeof roleRaw === 'object' && roleRaw && roleRaw.name) return roleRaw.name;
        const roleId = typeof roleRaw === 'object' && roleRaw && roleRaw._id ? roleRaw._id : roleRaw;
        if (roleId && mongoose.Types.ObjectId.isValid(roleId)) {
            const role = await Role.findOne({ _id: roleId, companyId }).select('name');
            if (role) return role.name;
        }
        return String(value);
    }

    if (field === 'ctc' || field === 'annualCTC') {
        const num = Number(value) || 0;
        return `₹${num.toLocaleString('en-IN')}/yr`;
    }

    if (field === 'monthlyCTC') {
        const num = Number(value) || 0;
        return `₹${num.toLocaleString('en-IN')}/mo`;
    }

    if (field === 'isTotalWorkforce' || field === 'isActive') {
        return value ? 'Yes' : 'No';
    }

    if (field === 'attendanceMode') {
        if (value === 'clock_in_out') return 'Clock In / Out';
        if (value === 'present_only') return 'Present Only';
        return String(value || 'Clock In / Out');
    }

    if (field === 'attendanceShift' || field === 'attendanceShiftCode') {
        if (value === 'general') return 'General Shift (Default)';
        if (value === 'flexible') return 'Flexible Shift';
        if (value === 'night') return 'Night Shift';
        if (value === 'any') return 'Any Shift';
        return String(value || 'General Shift');
    }

    if (field === 'employmentType') {
        return String(value || 'Full Time');
    }

    if (field.startsWith('leave_') || field.startsWith('leave.') || field.startsWith('leave')) {
        if (typeof value === 'object' && value !== null) {
            const bal = value.allocatedBalance !== undefined ? value.allocatedBalance : (value.balance !== undefined ? value.balance : value.closingBalance);
            const accrual = value.accrualAmount !== undefined && value.accrualAmount > 0
                ? `+${value.accrualAmount}/${value.accrualType === 'Monthly' ? 'mo' : 'yr'}`
                : (value.accrualType === 'None' ? 'No accrual' : '');
            const cf = value.carryForward
                ? `CF: ${value.carryForwardFrequency || 'Monthly'} (Max ${value.maxCarryForward || '∞'})`
                : 'CF: No';
            const exp = value.expiryBalance ? `Exp: ${value.expiryBalance}` : '';
            return [bal !== undefined ? `${bal} Days` : '', accrual, cf, exp].filter(Boolean).join(' • ') || 'Configured';
        }
        return String(value);
    }

    return String(value);
};

/**
 * Extract snapshot of current values from User + EmployeeProfile
 */
const extractEmployeeState = (user, profile) => {
    const emp = profile?.employment || profile?.employeeProfile?.employment || user?.employeeProfile?.employment || {};
    const comp = profile?.compensation || profile?.employeeProfile?.compensation || user?.compensation || {};
    const userSal = user?.salary || user?.compensation || profile?.salary || {};

    const rawBreakup = (comp.salaryBreakup instanceof Map ? Object.fromEntries(comp.salaryBreakup) : comp.salaryBreakup) || userSal || {};

    let monthlyCTC = parseFloat(comp.ctc || userSal.monthlyCTC || rawBreakup.monthlyCTC || 0);
    let annualCTC = parseFloat(userSal.annualCTC || rawBreakup.annualCTC || (monthlyCTC ? monthlyCTC * 12 : 0));
    if (!monthlyCTC && annualCTC > 0) {
        monthlyCTC = Math.round(annualCTC / 12);
    } else if (monthlyCTC > 0 && !annualCTC) {
        annualCTC = monthlyCTC * 12;
    }

    const salaryBreakup = {
        ...rawBreakup,
        monthlyCTC: String(monthlyCTC || 0),
        annualCTC: String(annualCTC || 0),
        compensationType: rawBreakup.compensationType || comp.payType || userSal.compensationType || 'monthly_salary',
        useSalaryComponents: rawBreakup.useSalaryComponents !== false && userSal.useSalaryComponents !== false
    };

    const deptRef = user?.departmentRef || emp.departmentRef || null;
    const deptName = user?.department || emp.department || (typeof deptRef === 'object' && deptRef?.name ? deptRef.name : '');

    const desigRef = user?.designationRef || emp.designationRef || null;
    const desigTitle = user?.designation || emp.designation || (typeof desigRef === 'object' && desigRef?.title ? desigRef.title : '');

    const mgr = user?.reportingManagers?.[0] || emp.reportingManager || null;

    return {
        // Employment
        department: deptName,
        departmentRef: deptRef,
        designation: desigTitle,
        designationRef: desigRef,
        reportingManager: mgr,
        reportingManagers: user?.reportingManagers || (mgr ? [mgr] : []),
        employmentType: user?.employmentType || emp.employmentType || profile?.employmentType || 'Full Time',
        workLocation: user?.workLocation || emp.workLocation || emp.branch || profile?.workLocation || '',
        workforceStatus: emp.status || (user?.isActive ? 'Active' : 'Inactive'),
        isActive: user?.isActive !== false,
        isTotalWorkforce: user?.isTotalWorkforce !== false,

        // Attendance
        attendanceMode: user?.attendanceMode || emp.attendanceMode || profile?.attendanceMode || 'clock_in_out',
        attendanceShiftCode: user?.attendanceShiftCode || emp.attendanceShiftCode || profile?.attendanceShiftCode || 'general',

        // Permissions / Role
        roles: user?.roles || [],
        roleId: user?.roles?.[0] || null,

        // Compensation
        ctc: monthlyCTC,
        annualCTC: annualCTC,
        monthlyCTC: monthlyCTC,
        payType: salaryBreakup.compensationType || 'monthly_salary',
        salaryBreakup
    };
};

/**
 * Apply a revision's changes to User and EmployeeProfile documents
 */
const applyRevisionToEmployee = async (revision, companyId) => {
    const user = await User.findOne({ _id: revision.employeeId, companyId });
    if (!user) {
        throw new Error(`Employee user ${revision.employeeId} not found`);
    }

    let profile = await EmployeeProfile.findOne({ user: user._id, companyId }).select('+compensation.ctc');
    if (!profile) {
        profile = new EmployeeProfile({
            user: user._id,
            companyId,
            personal: {
                firstName: user.firstName,
                lastName: user.lastName || '',
                fullName: `${user.firstName} ${user.lastName || ''}`.trim(),
                joiningDate: user.joiningDate || new Date()
            },
            contact: {
                workEmail: user.email
            },
            employment: {
                joiningDate: user.joiningDate || new Date(),
                status: 'Active'
            }
        });
    }

    const changes = revision.changes || [];
    let salaryModified = false;
    let targetSalary = null;
    let rolesModified = false;

    for (const change of changes) {
        const { field, revisedValue } = change;

        switch (field) {
            case 'department':
            case 'departmentRef':
                if (field === 'departmentRef') {
                    user.departmentRef = revisedValue || null;
                    profile.set('employment.departmentRef', revisedValue || null);
                    if (revisedValue) {
                        const deptDoc = await Department.findById(revisedValue).select('name');
                        if (deptDoc) {
                            user.department = deptDoc.name;
                            profile.set('employment.department', deptDoc.name);
                        }
                    } else {
                        user.department = '';
                        profile.set('employment.department', '');
                    }
                } else {
                    user.department = String(revisedValue || '');
                    profile.set('employment.department', String(revisedValue || ''));
                }
                break;

            case 'designation':
            case 'designationRef':
                if (field === 'designationRef') {
                    user.designationRef = revisedValue || null;
                    profile.set('employment.designationRef', revisedValue || null);
                    if (revisedValue) {
                        const desigDoc = await Designation.findById(revisedValue).select('title');
                        if (desigDoc) {
                            profile.set('employment.designation', desigDoc.title);
                        }
                    } else {
                        profile.set('employment.designation', '');
                    }
                } else {
                    profile.set('employment.designation', String(revisedValue || ''));
                }
                break;

            case 'reportingManager':
            case 'reportingManagers':
            case 'primaryManagerId':
                {
                    const managerId = Array.isArray(revisedValue) ? revisedValue[0] : revisedValue;
                    if (managerId) {
                        user.reportingManagers = [managerId];
                        profile.set('employment.reportingManager', managerId);
                    } else {
                        user.reportingManagers = [];
                        profile.set('employment.reportingManager', null);
                    }
                }
                break;

            case 'employmentType':
                user.employmentType = String(revisedValue || 'Full Time');
                profile.set('employment.employmentType', String(revisedValue || 'Full Time'));
                break;

            case 'workLocation':
                user.workLocation = String(revisedValue || '');
                profile.set('employment.workLocation', String(revisedValue || ''));
                profile.set('employment.branch', String(revisedValue || ''));
                break;

            case 'workforceStatus':
            case 'employmentStatus':
                profile.set('employment.status', String(revisedValue || 'Active'));
                if (revisedValue === 'Terminated' || revisedValue === 'Resigned' || revisedValue === 'Retired') {
                    user.isActive = false;
                } else if (revisedValue === 'Active') {
                    user.isActive = true;
                }
                break;

            case 'isActive':
                user.isActive = Boolean(revisedValue);
                if (!revisedValue) {
                    profile.set('employment.status', 'Terminated');
                } else if (profile.employment?.status === 'Terminated') {
                    profile.set('employment.status', 'Active');
                }
                break;

            case 'isTotalWorkforce':
                user.isTotalWorkforce = Boolean(revisedValue);
                break;

            case 'attendanceMode':
                user.attendanceMode = ['clock_in_out', 'present_only'].includes(revisedValue)
                    ? revisedValue
                    : 'clock_in_out';
                break;

            case 'attendanceShift':
            case 'attendanceShiftCode':
                user.attendanceShiftCode = String(revisedValue || 'general').trim().toLowerCase();
                break;

            case 'roles':
            case 'roleId':
                {
                    const roleIds = Array.isArray(revisedValue) ? revisedValue : (revisedValue ? [revisedValue] : []);
                    user.roles = roleIds;
                    rolesModified = true;
                }
                break;

            case 'ctc':
            case 'annualCTC':
            case 'monthlyCTC':
            case 'salary':
                salaryModified = true;
                targetSalary = revisedValue;
                break;

            case 'payType':
                profile.set('compensation.payType', String(revisedValue || 'salaried'));
                break;

            default:
                if (field.startsWith('employment.')) {
                    profile.set(field, revisedValue);
                } else if (field.startsWith('compensation.')) {
                    profile.set(field, revisedValue);
                }
                break;
        }
    }

    // Process Salary & Compensation if modified
    if (salaryModified || revision.metadata?.salaryBreakup) {
        const config = await PayrollConfig.findOne({ companyId }) || new PayrollConfig({ companyId });
        let calculatedSalary = {};

        if (revision.metadata?.salaryBreakup) {
            calculatedSalary = { ...revision.metadata.salaryBreakup };
        } else if (typeof targetSalary === 'object' && targetSalary !== null) {
            calculatedSalary = { ...targetSalary };
        }

        let annualCTC = 0;
        let monthlyCTC = 0;

        if (typeof targetSalary === 'number') {
            annualCTC = targetSalary;
            monthlyCTC = Math.round(annualCTC / 12);
            calculatedSalary.annualCTC = annualCTC;
            calculatedSalary.monthlyCTC = monthlyCTC;
        } else {
            annualCTC = parseFloat(String(calculatedSalary.annualCTC || '').replace(/[^0-9.]/g, '')) || 0;
            monthlyCTC = parseFloat(String(calculatedSalary.monthlyCTC || '').replace(/[^0-9.]/g, '')) || 0;

            if (annualCTC > 0) {
                monthlyCTC = Math.round(annualCTC / 12);
            } else if (monthlyCTC > 0) {
                annualCTC = monthlyCTC * 12;
            }
        }

        if (annualCTC > 0 || monthlyCTC > 0) {
            processCalculatedSalary(calculatedSalary, config, annualCTC, monthlyCTC);

            const previousCTC = profile.compensation?.ctc ? profile.compensation.ctc * 12 : 0;
            const newCTC = calculatedSalary.annualCTC ? parseFloat(calculatedSalary.annualCTC) / 12 : monthlyCTC;

            profile.set('compensation.ctc', newCTC);
            profile.set('compensation.payType', calculatedSalary.payType || 'salaried');

            const existingBreakup = profile.compensation?.salaryBreakup instanceof Map
                ? Object.fromEntries(profile.compensation.salaryBreakup)
                : (profile.compensation?.salaryBreakup || {});
            const newBreakup = { ...existingBreakup, ...calculatedSalary };
            profile.set('compensation.salaryBreakup', newBreakup);

            // Record into salaryRevisions array in profile for backwards compatibility
            const salaryRevs = Array.isArray(profile.compensation?.salaryRevisions)
                ? profile.compensation.salaryRevisions
                : [];
            salaryRevs.push({
                effectiveDate: revision.effectiveDate,
                previousCTC,
                newCTC: annualCTC,
                reason: revision.reason || 'Effective-Dated Revision'
            });
            profile.set('compensation.salaryRevisions', salaryRevs);
        }
    }

    // Process Leave Management if modified
    const leaveAllocations = Array.isArray(revision.metadata?.leaveAllocations)
        ? revision.metadata.leaveAllocations
        : [];
    const leaveChanges = changes.filter(c => c.module === 'leave');

    if (leaveAllocations.length > 0 || leaveChanges.length > 0) {
        const currentYear = new Date(revision.effectiveDate).getFullYear() || new Date().getFullYear();
        const leaveOverrides = (profile.leaveOverrides instanceof Map ? Object.fromEntries(profile.leaveOverrides) : (profile.leaveOverrides || {})) || {};

        // Merge leaveAllocations from metadata and any discrete leave changes
        const leaveItemsToProcess = [...leaveAllocations];

        for (const ch of leaveChanges) {
            if (typeof ch.revisedValue === 'object' && ch.revisedValue !== null && ch.revisedValue.leaveType) {
                if (!leaveItemsToProcess.some(item => item.leaveType === ch.revisedValue.leaveType)) {
                    leaveItemsToProcess.push(ch.revisedValue);
                }
            }
        }

        for (const item of leaveItemsToProcess) {
            if (!item.leaveType) continue;

            const lType = item.leaveType;
            const isEnabled = item.enabled !== false;

            let balanceDoc = await LeaveBalance.findOne({
                user: user._id,
                leaveType: lType,
                year: currentYear,
                companyId
            });

            if (!isEnabled) {
                // If this leave type was deleted/excluded for the user in this revision:
                if (balanceDoc) {
                    balanceDoc.openingBalance = 0;
                    balanceDoc.accrued = 0;
                    balanceDoc.closingBalance = 0;
                    await balanceDoc.save();
                }
                leaveOverrides[lType] = {
                    enabled: false,
                    isExcluded: true,
                    allocatedBalance: 0,
                    accrualAmount: 0
                };
                continue;
            }

            const newOpening = parseFloat(item.allocatedBalance !== undefined ? item.allocatedBalance : (item.openingBalance || 0)) || 0;
            const newAccrualAmount = parseFloat(item.accrualAmount) || 0;
            const validityMonths = parseFloat(item.expiryMonths) || 2;
            const maxCap = parseFloat(item.expiryBalance) || (parseFloat(item.maxCarryForward) || 0);

            const effDate = revision.effectiveDate ? new Date(revision.effectiveDate) : new Date();
            const effMonth = effDate.getMonth() + 1;
            const effYear = effDate.getFullYear();

            if (!balanceDoc) {
                balanceDoc = new LeaveBalance({
                    user: user._id,
                    leaveType: lType,
                    year: currentYear,
                    openingBalance: newOpening,
                    accrued: 0,
                    utilized: 0,
                    encashed: 0,
                    closingBalance: newOpening,
                    companyId
                });
            } else {
                balanceDoc.openingBalance = newOpening;
            }

            // Initialize or credit initial bucket lot for the revision's effective date
            if (newOpening > 0) {
                creditLeaveBucket(balanceDoc, newOpening, effMonth, effYear, validityMonths, maxCap);
            }

            await balanceDoc.save();

            leaveOverrides[lType] = {
                enabled: true,
                allocatedBalance: newOpening,
                accrualType: item.accrualType || 'Monthly',
                accrualAmount: newAccrualAmount,
                carryForward: Boolean(item.carryForward),
                carryForwardFrequency: item.carryForwardFrequency || 'Monthly',
                maxCarryForward: parseFloat(item.maxCarryForward) || 0,
                expiryBalance: parseFloat(item.expiryBalance) || 0,
                expiryMonths: validityMonths,
                autoRenew: item.autoRenew !== false,
                allowNegativeBalance: Boolean(item.allowNegativeBalance),
                sandwichRule: Boolean(item.sandwichRule),
                proRata: item.proRata !== false
            };
        }

        profile.set('leaveOverrides', leaveOverrides);
    }

    if (rolesModified) {
        user.tokenVersion = (user.tokenVersion || 0) + 1;
    }

    await user.save();
    await profile.save();

    if (!user.employeeProfile) {
        user.employeeProfile = profile._id;
        await user.save();
    }

    // Update revision status to active
    revision.status = 'active';
    revision.appliedAt = new Date();
    await revision.save();

    // Mark previous active revisions before or on this effective date as superseded
    await EmployeeRevision.updateMany(
        {
            _id: { $ne: revision._id },
            companyId,
            employeeId: user._id,
            status: 'active',
            effectiveDate: { $lte: revision.effectiveDate }
        },
        {
            $set: { status: 'superseded' }
        }
    );

    // Dispatch webhook for downstream payroll and third-party integrations
    void dispatchEmployeeWebhook({
        companyId,
        userId: user._id,
        event: 'employee.updated'
    }).catch((err) => {
        console.error('[PayrollWebhook] applyRevision webhook error:', err.message);
    });

    return { user, profile, revision };
};

/**
 * Generate Baseline Revision #1 for an employee who has no revision records yet
 */
const generateBaselineRevision = async (user, profile, companyId, createdByUserId) => {
    const currentState = extractEmployeeState(user, profile);
    const effectiveDate = user.joiningDate || user.createdAt || new Date();

    const changes = [
        {
            module: 'employment',
            field: 'department',
            fieldLabel: 'Department',
            previousValue: null,
            revisedValue: currentState.departmentRef || currentState.department,
            previousDisplayValue: '—',
            revisedDisplayValue: await resolveDisplayValue('department', currentState.departmentRef || currentState.department, companyId)
        },
        {
            module: 'employment',
            field: 'designation',
            fieldLabel: 'Designation',
            previousValue: null,
            revisedValue: currentState.designationRef || currentState.designation,
            previousDisplayValue: '—',
            revisedDisplayValue: await resolveDisplayValue('designation', currentState.designationRef || currentState.designation, companyId)
        },
        {
            module: 'employment',
            field: 'employmentType',
            fieldLabel: 'Employment Type',
            previousValue: null,
            revisedValue: currentState.employmentType,
            previousDisplayValue: '—',
            revisedDisplayValue: currentState.employmentType
        },
        {
            module: 'employment',
            field: 'reportingManager',
            fieldLabel: 'Reporting Manager',
            previousValue: null,
            revisedValue: currentState.reportingManager,
            previousDisplayValue: '—',
            revisedDisplayValue: await resolveDisplayValue('reportingManager', currentState.reportingManager, companyId)
        },
        {
            module: 'employment',
            field: 'workLocation',
            fieldLabel: 'Work Location',
            previousValue: null,
            revisedValue: currentState.workLocation,
            previousDisplayValue: '—',
            revisedDisplayValue: currentState.workLocation || 'Not Set'
        },
        {
            module: 'attendance',
            field: 'attendanceMode',
            fieldLabel: 'Attendance Mode',
            previousValue: null,
            revisedValue: currentState.attendanceMode,
            previousDisplayValue: '—',
            revisedDisplayValue: currentState.attendanceMode === 'clock_in_out' ? 'Clock In / Out' : 'Present Only'
        },
        {
            module: 'attendance',
            field: 'attendanceShiftCode',
            fieldLabel: 'Attendance Shift',
            previousValue: null,
            revisedValue: currentState.attendanceShiftCode,
            previousDisplayValue: '—',
            revisedDisplayValue: currentState.attendanceShiftCode
        },
        {
            module: 'permissions',
            field: 'roles',
            fieldLabel: 'System Role',
            previousValue: null,
            revisedValue: currentState.roles,
            previousDisplayValue: '—',
            revisedDisplayValue: await resolveDisplayValue('roles', currentState.roles, companyId)
        }
    ];

    if (currentState.annualCTC > 0 || currentState.monthlyCTC > 0) {
        changes.push({
            module: 'compensation',
            field: 'annualCTC',
            fieldLabel: 'Annual CTC',
            previousValue: null,
            revisedValue: currentState.annualCTC || currentState.monthlyCTC * 12,
            previousDisplayValue: '—',
            revisedDisplayValue: `₹${(currentState.annualCTC || currentState.monthlyCTC * 12).toLocaleString('en-IN')}/yr`
        });
    }

    const baseline = new EmployeeRevision({
        companyId,
        employeeId: user._id,
        effectiveDate,
        status: 'active',
        reason: 'Initial baseline record (Joining / Onboarding)',
        changes,
        metadata: {
            salaryBreakup: currentState.salaryBreakup || null
        },
        createdBy: createdByUserId || user._id,
        appliedAt: new Date(),
        isInitialBaseline: true
    });

    await baseline.save();
    return baseline;
};

// ==========================================
// CONTROLLER HANDLERS
// ==========================================

/**
 * POST /api/employees/:id/revisions
 * Create a new employee revision (Scheduled, Immediate, or Backdated)
 */
const createRevision = async (req, res) => {
    try {
        const { id: employeeId } = req.params;
        const isAdmin = checkIsAdmin(req.user);
        const canCreate = isAdmin ||
                          hasPermission(req.user, 'employee.revision.create') ||
                          hasPermission(req.user, 'employee.revision.manage') ||
                          hasPermission(req.user, 'user.update') ||
                          hasPermission(req.user, 'dossier.edit');
        if (!canCreate) {
            return res.status(403).json({ message: 'Access denied: You do not have permission to create or schedule revised details' });
        }

        const {
            effectiveDate,
            reason,
            changes = [],
            isBackdatedConfirmed = false,
            confirmBackdated = false,
            metadata = {}
        } = req.body;

        if (!effectiveDate) {
            return res.status(400).json({ message: 'Effective date is required' });
        }

        const parsedEffectiveDate = new Date(effectiveDate);
        if (Number.isNaN(parsedEffectiveDate.getTime())) {
            return res.status(400).json({ message: 'Invalid effective date format' });
        }

        const user = await User.findOne({ _id: employeeId, companyId: req.companyId });
        if (!user) {
            return res.status(404).json({ message: 'Employee not found' });
        }

        const profile = await EmployeeProfile.findOne({ user: user._id, companyId: req.companyId }).select('+compensation.ctc');
        const currentState = extractEmployeeState(user, profile);

        // Check if backdated without confirmation
        const isBackdated = isDateInPast(parsedEffectiveDate);
        const hasConfirmedBackdate = isBackdatedConfirmed === true || confirmBackdated === true;

        if (isBackdated && !hasConfirmedBackdate) {
            return res.status(400).json({
                code: 'BACKDATED_CONFIRMATION_REQUIRED',
                message: 'This revision has an effective date in the past. Applying backdated changes may retroactively affect already-processed payroll, attendance, and leave calculations. Explicit confirmation is required.',
                requiresConfirmation: true,
                effectiveDate: parsedEffectiveDate
            });
        }

        // Validate changes payload
        if (!Array.isArray(changes) || changes.length === 0) {
            return res.status(400).json({ message: 'At least one field change must be specified in the revision' });
        }

        // Conflict validation with pending scheduled revisions
        const existingScheduled = await EmployeeRevision.find({
            companyId: req.companyId,
            employeeId: user._id,
            status: 'scheduled'
        }).sort({ effectiveDate: 1 });

        if (existingScheduled.length > 0) {
            // Check if there is an exact same-date scheduled revision
            const sameDateConflict = existingScheduled.find(r =>
                getStartOfDayLocal(r.effectiveDate).getTime() === getStartOfDayLocal(parsedEffectiveDate).getTime()
            );

            if (sameDateConflict) {
                return res.status(400).json({
                    code: 'CONFLICTING_SCHEDULED_REVISION',
                    message: `A scheduled revision (#${sameDateConflict._id}) already exists for this exact date (${parsedEffectiveDate.toLocaleDateString()}). Please edit or cancel the existing scheduled revision instead.`,
                    conflictingRevisionId: sameDateConflict._id
                });
            }
        }

        // Build enriched changes with previous values and display values
        const enrichedChanges = [];

        for (const change of changes) {
            const field = change.field;
            const moduleName = change.module || 'employment';
            const revisedVal = change.revisedValue;
            let fieldLabel = change.fieldLabel || field;

            let prevVal = null;
            if (field === 'department' || field === 'departmentRef') {
                prevVal = currentState.departmentRef || currentState.department;
                fieldLabel = 'Department';
            } else if (field === 'designation' || field === 'designationRef') {
                prevVal = currentState.designationRef || currentState.designation;
                fieldLabel = 'Designation';
            } else if (field === 'reportingManager' || field === 'reportingManagers' || field === 'primaryManagerId') {
                prevVal = currentState.reportingManager;
                fieldLabel = 'Reporting Manager';
            } else if (field === 'employmentType') {
                prevVal = currentState.employmentType;
                fieldLabel = 'Employment Type';
            } else if (field === 'workLocation') {
                prevVal = currentState.workLocation;
                fieldLabel = 'Work Location';
            } else if (field === 'workforceStatus' || field === 'employmentStatus') {
                prevVal = currentState.workforceStatus;
                fieldLabel = 'Workforce Status';
            } else if (field === 'attendanceMode') {
                prevVal = currentState.attendanceMode;
                fieldLabel = 'Attendance Mode';
            } else if (field === 'attendanceShift' || field === 'attendanceShiftCode') {
                prevVal = currentState.attendanceShiftCode;
                fieldLabel = 'Attendance Shift';
            } else if (field === 'roles' || field === 'roleId') {
                prevVal = currentState.roles;
                fieldLabel = 'System Role / Permissions';
            } else if (field === 'annualCTC' || field === 'ctc') {
                prevVal = currentState.annualCTC;
                fieldLabel = 'Annual CTC';
            } else if (field === 'payType') {
                prevVal = currentState.payType;
                fieldLabel = 'Pay Type';
            } else {
                prevVal = currentState[field] !== undefined ? currentState[field] : null;
            }

            const previousDisplayValue = change.previousDisplayValue
                || await resolveDisplayValue(field, prevVal, req.companyId);
            const revisedDisplayValue = change.revisedDisplayValue
                || await resolveDisplayValue(field, revisedVal, req.companyId);

            enrichedChanges.push({
                module: moduleName,
                field,
                fieldLabel,
                previousValue: prevVal,
                revisedValue: revisedVal,
                previousDisplayValue,
                revisedDisplayValue
            });
        }

        const isImmediate = isDateTodayOrPast(parsedEffectiveDate);

        const newRevision = new EmployeeRevision({
            companyId: req.companyId,
            employeeId: user._id,
            effectiveDate: parsedEffectiveDate,
            status: isImmediate ? 'active' : 'scheduled',
            reason: String(reason || '').trim(),
            changes: enrichedChanges,
            metadata: {
                ...metadata,
                previousSnapshot: currentState
            },
            createdBy: req.user._id,
            appliedAt: isImmediate ? new Date() : null
        });

        if (isImmediate) {
            await newRevision.save();
            await applyRevisionToEmployee(newRevision, req.companyId);
        } else {
            await newRevision.save();
        }

        // Return populated revision
        const populated = await EmployeeRevision.findById(newRevision._id)
            .populate('createdBy', 'firstName lastName email profilePicture')
            .populate('approvedBy', 'firstName lastName email')
            .populate('cancelledBy', 'firstName lastName email');

        res.status(201).json({
            message: isImmediate
                ? 'Revision applied immediately and marked as active'
                : 'Revision scheduled successfully',
            revision: populated,
            isApplied: isImmediate
        });
    } catch (error) {
        console.error('[createRevision Error]:', error);
        res.status(500).json({ message: error.message || 'Failed to create revision' });
    }
};

/**
 * GET /api/employees/:id/revisions
 * List all revisions for an employee (newest first)
 */
const getRevisions = async (req, res) => {
    try {
        const { id: employeeId } = req.params;
        const isSelf = String(req.user._id) === String(employeeId);
        const isAdmin = checkIsAdmin(req.user);

        if (!isAdmin) {
            if (isSelf) {
                const canViewSelf = hasPermission(req.user, 'employee.revision.view.self') ||
                                    hasPermission(req.user, 'employee.revision.manage');
                if (!canViewSelf) {
                    return res.status(403).json({ message: 'Access denied: You do not have permission to view your revised details' });
                }
            } else {
                const canViewOthers = hasPermission(req.user, 'employee.revision.view.others') ||
                                      hasPermission(req.user, 'employee.revision.manage');
                if (!canViewOthers) {
                    return res.status(403).json({ message: 'Access denied: You do not have permission to view other employees\' revised details' });
                }
            }
        }

        const user = await User.findOne({ _id: employeeId, companyId: req.companyId });
        if (!user) {
            return res.status(404).json({ message: 'Employee not found' });
        }

        let revisions = await EmployeeRevision.find({
            companyId: req.companyId,
            employeeId: user._id
        })
            .sort({ effectiveDate: -1, createdAt: -1 })
            .populate('createdBy', 'firstName lastName email profilePicture')
            .populate('approvedBy', 'firstName lastName email')
            .populate('cancelledBy', 'firstName lastName email');

        // If employee has zero revisions, create baseline Revision #1
        if (revisions.length === 0) {
            const profile = await EmployeeProfile.findOne({ user: user._id, companyId: req.companyId }).select('+compensation.ctc');
            const baseline = await generateBaselineRevision(user, profile, req.companyId, req.user._id);

            const populatedBaseline = await EmployeeRevision.findById(baseline._id)
                .populate('createdBy', 'firstName lastName email profilePicture');

            revisions = [populatedBaseline];
        }

        // Chronological reconstruction of state history for all revisions
        const profile = await EmployeeProfile.findOne({ user: user._id, companyId: req.companyId }).select('+compensation.ctc');
        const currentState = extractEmployeeState(user, profile);

        // Sort chronologically ascending to trace timeline (Oldest -> Newest)
        const chronologicalRevisions = [...revisions].sort((a, b) => new Date(a.effectiveDate) - new Date(b.effectiveDate));

        let runningState = { ...currentState };

        for (let i = 0; i < chronologicalRevisions.length; i++) {
            const rev = chronologicalRevisions[i];
            
            // Prior snapshot for rev[i] is the running state before rev[i] was applied
            const priorSnapshotForThisRev = JSON.parse(JSON.stringify(runningState));

            if (!rev.metadata?.previousSnapshot) {
                rev.metadata = {
                    ...(rev.metadata || {}),
                    previousSnapshot: priorSnapshotForThisRev
                };
            }

            // Hydrate changes previousDisplayValue if missing or default (skip baseline initial onboarding records)
            if (Array.isArray(rev.changes) && !rev.isInitialBaseline) {
                for (const ch of rev.changes) {
                    if ((!ch.previousDisplayValue || ch.previousDisplayValue === '—' || ch.previousDisplayValue === 'Not Set') && priorSnapshotForThisRev[ch.field] !== undefined) {
                        ch.previousValue = priorSnapshotForThisRev[ch.field];
                        ch.previousDisplayValue = await resolveDisplayValue(ch.field, priorSnapshotForThisRev[ch.field], req.companyId);
                    }
                }
            }

            // Now advance runningState by applying rev's changes for the subsequent revisions
            if (rev.metadata?.salaryBreakup) {
                runningState.salaryBreakup = rev.metadata.salaryBreakup;
                runningState.annualCTC = parseFloat(String(rev.metadata.salaryBreakup.annualCTC || '0').replace(/[^0-9.]/g, '')) || 0;
                runningState.monthlyCTC = parseFloat(String(rev.metadata.salaryBreakup.monthlyCTC || '0').replace(/[^0-9.]/g, '')) || (runningState.annualCTC ? Math.round(runningState.annualCTC / 12) : 0);
            }

            if (Array.isArray(rev.changes)) {
                for (const ch of rev.changes) {
                    if (ch.field === 'employmentType') runningState.employmentType = ch.revisedValue;
                    if (ch.field === 'attendanceMode') runningState.attendanceMode = ch.revisedValue;
                    if (ch.field === 'attendanceShiftCode' || ch.field === 'attendanceShift') runningState.attendanceShiftCode = ch.revisedValue;
                    if (ch.field === 'department' || ch.field === 'departmentRef') {
                        runningState.departmentRef = ch.revisedValue;
                        runningState.department = ch.revisedDisplayValue || ch.revisedValue;
                    }
                    if (ch.field === 'designation' || ch.field === 'designationRef') {
                        runningState.designationRef = ch.revisedValue;
                        runningState.designation = ch.revisedDisplayValue || ch.revisedValue;
                    }
                    if (ch.field === 'reportingManager' || ch.field === 'reportingManagers' || ch.field === 'primaryManagerId') {
                        runningState.reportingManager = ch.revisedValue;
                    }
                    if (ch.field === 'workLocation') runningState.workLocation = ch.revisedValue;
                    if (ch.field === 'workforceStatus') runningState.workforceStatus = ch.revisedValue;
                    if (ch.field === 'roles' || ch.field === 'roleId') runningState.roles = ch.revisedValue;
                }
            }
        }

        const scheduledCount = revisions.filter(r => r.status === 'scheduled').length;
        const activeRevision = revisions.find(r => r.status === 'active') || null;

        // Return latest revisions at the top
        res.json({
            count: revisions.length,
            scheduledCount,
            activeRevision,
            revisions: chronologicalRevisions.reverse()
        });
    } catch (error) {
        console.error('[getRevisions Error]:', error);
        res.status(500).json({ message: error.message || 'Failed to fetch revisions' });
    }
};

/**
 * GET /api/employees/:id/revisions/:revisionId
 * Single revision detail
 */
const getRevisionById = async (req, res) => {
    try {
        const { id: employeeId, revisionId } = req.params;
        const isSelf = String(req.user._id) === String(employeeId);
        const isAdmin = checkIsAdmin(req.user);

        if (!isAdmin) {
            if (isSelf) {
                const canViewSelf = hasPermission(req.user, 'employee.revision.view.self') ||
                                    hasPermission(req.user, 'employee.revision.manage');
                if (!canViewSelf) {
                    return res.status(403).json({ message: 'Access denied: You do not have permission to view your revised details' });
                }
            } else {
                const canViewOthers = hasPermission(req.user, 'employee.revision.view.others') ||
                                      hasPermission(req.user, 'employee.revision.manage');
                if (!canViewOthers) {
                    return res.status(403).json({ message: 'Access denied: You do not have permission to view other employees\' revised details' });
                }
            }
        }

        const revision = await EmployeeRevision.findOne({
            _id: revisionId,
            employeeId,
            companyId: req.companyId
        })
            .populate('createdBy', 'firstName lastName email profilePicture')
            .populate('approvedBy', 'firstName lastName email')
            .populate('cancelledBy', 'firstName lastName email');

        if (!revision) {
            return res.status(404).json({ message: 'Revision record not found' });
        }

        res.json({ revision });
    } catch (error) {
        console.error('[getRevisionById Error]:', error);
        res.status(500).json({ message: error.message || 'Failed to fetch revision detail' });
    }
};

/**
 * PATCH /api/employees/:id/revisions/:revisionId
 * Edit a scheduled or active revision
 */
const updateScheduledRevision = async (req, res) => {
    try {
        const { id: employeeId, revisionId } = req.params;
        const isAdmin = checkIsAdmin(req.user);
        const canUpdate = isAdmin ||
                          hasPermission(req.user, 'employee.revision.update') ||
                          hasPermission(req.user, 'employee.revision.edit') ||
                          hasPermission(req.user, 'employee.revision.manage') ||
                          hasPermission(req.user, 'user.update') ||
                          hasPermission(req.user, 'dossier.edit');
        if (!canUpdate) {
            return res.status(403).json({ message: 'Access denied: You do not have permission to edit revised details' });
        }

        const { effectiveDate, reason, changes, metadata } = req.body;

        const revision = await EmployeeRevision.findOne({
            _id: revisionId,
            employeeId,
            companyId: req.companyId
        });

        if (!revision) {
            return res.status(404).json({ message: 'Revision record not found' });
        }

        if (revision.status !== 'scheduled' && revision.status !== 'active') {
            return res.status(400).json({
                message: `Cannot edit a revision with status '${revision.status}'. Only scheduled and active revisions can be modified.`
            });
        }

        const wasActive = revision.status === 'active';

        if (effectiveDate) {
            const parsedDate = new Date(effectiveDate);
            if (Number.isNaN(parsedDate.getTime())) {
                return res.status(400).json({ message: 'Invalid effective date' });
            }
            if (revision.status === 'scheduled' && isDateTodayOrPast(parsedDate)) {
                return res.status(400).json({
                    message: 'Cannot reschedule a revision to today or a past date using Edit. Create an immediate revision instead.'
                });
            }
            revision.effectiveDate = parsedDate;
        }

        if (reason !== undefined) {
            revision.reason = String(reason || '').trim();
        }

        if (metadata !== undefined) {
            revision.metadata = metadata;
        }

        if (Array.isArray(changes) && changes.length > 0) {
            const enrichedChanges = [];
            for (const change of changes) {
                const field = change.field;
                const moduleName = change.module || 'employment';
                const revisedVal = change.revisedValue;
                const fieldLabel = change.fieldLabel || field;

                const previousDisplayValue = change.previousDisplayValue
                    || await resolveDisplayValue(field, change.previousValue, req.companyId);
                const revisedDisplayValue = change.revisedDisplayValue
                    || await resolveDisplayValue(field, revisedVal, req.companyId);

                enrichedChanges.push({
                    module: moduleName,
                    field,
                    fieldLabel,
                    previousValue: change.previousValue,
                    revisedValue: revisedVal,
                    previousDisplayValue,
                    revisedDisplayValue
                });
            }
            revision.changes = enrichedChanges;
        }

        if (wasActive) {
            await applyRevisionToEmployee(revision, req.companyId, req.user);
        } else {
            await revision.save();
        }

        const updated = await EmployeeRevision.findById(revision._id)
            .populate('createdBy', 'firstName lastName email profilePicture');

        res.json({ message: 'Revision details updated successfully', revision: updated });
    } catch (error) {
        console.error('[updateScheduledRevision Error]:', error);
        res.status(500).json({ message: error.message || 'Failed to update revision' });
    }
};

/**
 * DELETE /api/employees/:id/revisions/:revisionId
 * Soft-cancel a scheduled revision
 */
const cancelScheduledRevision = async (req, res) => {
    try {
        const { id: employeeId, revisionId } = req.params;
        const isAdmin = checkIsAdmin(req.user);
        const canCancel = isAdmin ||
                          hasPermission(req.user, 'employee.revision.cancel') ||
                          hasPermission(req.user, 'employee.revision.delete') ||
                          hasPermission(req.user, 'employee.revision.manage') ||
                          hasPermission(req.user, 'user.update') ||
                          hasPermission(req.user, 'dossier.edit');
        if (!canCancel) {
            return res.status(403).json({ message: 'Access denied: You do not have permission to cancel revised details' });
        }

        const { reason } = req.body;

        const revision = await EmployeeRevision.findOne({
            _id: revisionId,
            employeeId,
            companyId: req.companyId
        });

        if (!revision) {
            return res.status(404).json({ message: 'Revision record not found' });
        }

        if (revision.status !== 'scheduled') {
            return res.status(400).json({
                message: `Cannot cancel a revision with status '${revision.status}'. Only scheduled revisions can be cancelled.`
            });
        }

        revision.status = 'cancelled';
        revision.cancelledBy = req.user._id;
        revision.cancelledAt = new Date();
        revision.cancellationReason = String(reason || '').trim();

        await revision.save();

        const cancelled = await EmployeeRevision.findById(revision._id)
            .populate('createdBy', 'firstName lastName email profilePicture')
            .populate('cancelledBy', 'firstName lastName email');

        res.json({ message: 'Revision cancelled successfully', revision: cancelled });
    } catch (error) {
        console.error('[cancelScheduledRevision Error]:', error);
        res.status(500).json({ message: error.message || 'Failed to cancel revision' });
    }
};

/**
 * POST /api/employees/revisions/backfill
 * Admin utility to backfill baseline Revision #1 for existing employees
 */
const backfillEmployeeRevisions = async (req, res) => {
    try {
        const users = await User.find({ companyId: req.companyId });
        let backfilled = 0;
        let alreadyHad = 0;

        for (const user of users) {
            const count = await EmployeeRevision.countDocuments({
                companyId: req.companyId,
                employeeId: user._id
            });

            if (count === 0) {
                const profile = await EmployeeProfile.findOne({ user: user._id, companyId: req.companyId }).select('+compensation.ctc');
                await generateBaselineRevision(user, profile, req.companyId, req.user._id);
                backfilled++;
            } else {
                alreadyHad++;
            }
        }

        res.json({
            message: `Revision backfill complete. Created ${backfilled} baseline revision(s). ${alreadyHad} employee(s) already had revisions.`,
            backfilled,
            alreadyHad
        });
    } catch (error) {
        console.error('[backfillEmployeeRevisions Error]:', error);
        res.status(500).json({ message: error.message || 'Failed to backfill revisions' });
    }
};

/**
 * GET /api/employees/:id/leave-balances
 * Fetch all active company leave policies combined with this employee's current LeaveBalance records
 */
const getEmployeeLeaveBalances = async (req, res) => {
    try {
        const { id: employeeId } = req.params;
        const currentYear = new Date().getFullYear();

        const user = await User.findOne({ _id: employeeId, companyId: req.companyId }).select('_id firstName lastName email employmentType');
        if (!user) {
            return res.status(404).json({ message: 'Employee not found' });
        }

        const profile = await EmployeeProfile.findOne({ user: user._id, companyId: req.companyId }).select('+compensation.ctc');
        const userEmploymentType = user.employmentType || profile?.employment?.employmentType || 'Full Time';

        // Fetch company leave configs
        const policies = await LeaveConfig.find({ isActive: true, companyId: req.companyId }).lean();

        // Fetch existing leave balances for this employee
        const balances = await LeaveBalance.find({ user: user._id, year: currentYear, companyId: req.companyId }).lean();
        const balanceMap = new Map(balances.map(b => [b.leaveType, b]));

        // Get any leave overrides saved in profile
        const profileOverrides = (profile?.leaveOverrides instanceof Map ? Object.fromEntries(profile.leaveOverrides) : (profile?.leaveOverrides || {})) || {};

        const combined = policies.map(policy => {
            const existingBalance = balanceMap.get(policy.leaveType);
            const override = profileOverrides[policy.leaveType] || {};

            const openingBalance = existingBalance?.openingBalance ?? 0;
            const accrued = existingBalance?.accrued ?? (policy.accrualType === 'Yearly' ? policy.accrualAmount : (policy.accrualType === 'Monthly' ? policy.accrualAmount * (new Date().getMonth() + 1) : policy.accrualAmount || 0));
            const utilized = existingBalance?.utilized ?? 0;
            const closingBalance = existingBalance?.closingBalance ?? (openingBalance + accrued - utilized);

            return {
                policyId: policy._id,
                leaveType: policy.leaveType,
                name: policy.name,
                description: policy.description || '',
                isPaid: policy.isPaid,
                isEligible: !policy.employeeTypes || policy.employeeTypes.length === 0 || policy.employeeTypes.includes(userEmploymentType),
                // Policy defaults
                defaultAccrualType: policy.accrualType || 'Monthly',
                defaultAccrualAmount: policy.accrualAmount || 0,
                defaultCarryForward: policy.carryForward || false,
                defaultMaxCarryForward: policy.maxCarryForward || 0,
                defaultMaxLimitPerYear: policy.maxLimitPerYear || 0,
                defaultSandwichRule: policy.sandwichRule || false,
                defaultAllowNegativeBalance: policy.allowNegativeBalance || false,
                defaultProRata: policy.proRata ?? true,
                // Current Employee State
                currentOpeningBalance: openingBalance,
                currentAccrued: accrued,
                currentUtilized: utilized,
                currentClosingBalance: closingBalance,
                // Effective / Override State
                allocatedBalance: override.allocatedBalance !== undefined ? override.allocatedBalance : (existingBalance ? (existingBalance.openingBalance !== undefined ? existingBalance.openingBalance : existingBalance.closingBalance) : (policy.accrualType === 'Yearly' ? policy.accrualAmount : policy.accrualAmount || 0)),
                accrualType: override.accrualType || policy.accrualType || 'Monthly',
                accrualAmount: override.accrualAmount !== undefined ? override.accrualAmount : (policy.accrualAmount || 0),
                carryForward: override.carryForward !== undefined ? override.carryForward : (policy.carryForward || false),
                carryForwardFrequency: override.carryForwardFrequency || 'Monthly',
                expiryBalance: override.expiryBalance !== undefined ? override.expiryBalance : (policy.maxLimitPerYear || 0),
                expiryMonths: override.expiryMonths !== undefined ? override.expiryMonths : 2,
                autoRenew: override.autoRenew !== undefined ? override.autoRenew : true,
                allowNegativeBalance: override.allowNegativeBalance !== undefined ? override.allowNegativeBalance : (policy.allowNegativeBalance || false),
                sandwichRule: override.sandwichRule !== undefined ? override.sandwichRule : (policy.sandwichRule || false),
                proRata: override.proRata !== undefined ? override.proRata : (policy.proRata ?? true),
                buckets: existingBalance?.buckets || []
            };
        });

        res.json({
            employee: {
                _id: user._id,
                name: `${user.firstName} ${user.lastName || ''}`.trim(),
                email: user.email,
                employmentType: userEmploymentType
            },
            year: currentYear,
            leaves: combined
        });
    } catch (error) {
        console.error('[getEmployeeLeaveBalances Error]:', error);
        res.status(500).json({ message: error.message || 'Failed to fetch employee leave balances' });
    }
};

module.exports = {
    createRevision,
    getRevisions,
    getRevisionById,
    getEmployeeLeaveBalances,
    updateScheduledRevision,
    cancelScheduledRevision,
    backfillEmployeeRevisions,
    applyRevisionToEmployee,
    extractEmployeeState,
    resolveDisplayValue
};
