const PayrollConfig = require('./payrollConfig.model');
const Company = require('../company/company.model');
const User = require('../user/user.model');
const EmployeeProfile = require('../dossier/employeeProfile.model');
const Payroll = require('./payroll.model');
const Reimbursement = require('../reimbursement/reimbursement.model');
const Attendance = require('../../modules/attendance/model/attendance.model');
const Holiday = require('../holiday/holiday.model');
const LeaveRequest = require('../leave/model/leaveRequest.model');
const LeaveConfig = require('../leave/model/leaveConfig.model');
const ExcelJS = require('exceljs');
const mongoose = require('mongoose');
const { format } = require('date-fns');
const { parseDateAsIST } = require('../../modules/attendance/attendancePolicy');
const { toLocalTimezoneRep } = require('../timesheet/timesheetPeriod');
const { buildMasterSalaryStructure, buildPayrollSnapshot } = require('./payrollMath');
const { normalizePayrollIntegrationSettings } = require('./payrollIntegration.service');
const { computeCompanyAttendanceSummary } = require('./payrollAttendance.service');
const { shouldApplyJoiningBonus } = require('./payrollAutoRun.cron');

const getCompanyId = (req) => req.companyId || req.user?.companyId || req.user?.company;

const FREQ_MULTIPLIER = {
  monthly: 12,
  quarterly: 4,
  semi_annually: 2,
  annually: 1,
  one_time: 1
};

const extractAnnualBenefits = (rawBreakup = {}) => {
  const list = Array.isArray(rawBreakup?.otherAllowances) ? rawBreakup.otherAllowances : [];
  return list
    .filter((item) => {
      if (!item || !(Number(item.amount) > 0)) return false;
      const freq = String(item.frequency || 'monthly').toLowerCase();
      const isBonusName = /bonus|variable|joining/i.test(String(item.name || ''));
      return freq !== 'monthly' || item.includeInCTC === false || isBonusName;
    })
    .map((item) => {
      const freq = String(item.frequency || 'annually').toLowerCase();
      const mult = FREQ_MULTIPLIER[freq] || 1;
      const amount = Number(item.amount) || 0;
      return {
        name: item.name || 'Bonus',
        frequency: freq,
        perPayoutAmount: amount,
        payoutCount: mult,
        annualAmount: Math.round(amount * mult * 100) / 100,
        includeInCTC: item.includeInCTC !== false
      };
    });
};

exports.getConfig = async (req, res) => {
  try {
    const companyId = getCompanyId(req);
    if (!companyId) return res.status(400).json({ message: 'Company ID not found in user request context.' });

    const [configDoc, company] = await Promise.all([
      PayrollConfig.findOne({ companyId }).lean(),
      req.company
        ? Promise.resolve(req.company)
        : Company.findById(companyId).select('name address settings.logo settings.workspaceBranding').lean()
    ]);

    let config = configDoc;
    if (!config) {
      const created = new PayrollConfig({ companyId });
      await created.save();
      config = created.toObject();
    }
    return res.json({
      ...config,
      company: {
        name: company?.name || '',
        address: typeof company?.address === 'string' ? company.address : (company?.address?.line1 ? `${company.address.line1}${company.address.city ? ', ' + company.address.city : ''}${company.address.state ? ', ' + company.address.state : ''}${company.address.zip ? ' - ' + company.address.zip : ''}` : ''),
        logo: company?.settings?.logo || ''
      }
    });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ message: 'Error retrieving payroll config settings.' });
  }
};

exports.updateConfig = async (req, res) => {
  try {
    const companyId = getCompanyId(req);
    if (!companyId) return res.status(400).json({ message: 'Company ID not found in user request context.' });
    
    const updateData = req.body || {};
    delete updateData.companyId;

    const config = await PayrollConfig.findOneAndUpdate(
      { companyId },
      { $set: updateData },
      { new: true, upsert: true }
    );
    return res.json(config);
  } catch (error) {
    console.error(error);
    return res.status(500).json({ message: 'Error saving payroll config settings.' });
  }
};

exports.calculateSalary = async (req, res) => {
  try {
    const companyId = getCompanyId(req);
    if (!companyId) return res.status(400).json({ message: 'Company ID not found in user request context.' });

    const config = await PayrollConfig.findOne({ companyId }) || new PayrollConfig({ companyId });

    const source = req.body || {};
    
    const master = buildMasterSalaryStructure(source, config);
    const payroll = buildPayrollSnapshot(source, config, {
      workingDays: config.defaultWorkingDays,
      paidDays: config.defaultWorkingDays,
    }, {
      joiningBonus: Number(source.joiningBonus) || 0,
      performanceBonus: Number(source.performanceBonus) || 0,
      specialBonus: Number(source.specialBonus) || 0,
      retentionBonus: Number(source.retentionBonus) || 0,
      incentive: Number(source.incentive) || 0,
      arrear: Number(source.arrear) || 0,
      referralBonus: Number(source.referralBonus) || 0,
    }, new Date().getMonth() + 1, new Date().getFullYear());

    return res.json({
      master,
      payroll,
      monthlyCTC: master.monthlyCTC,
      annualCTC: master.annualCTC
    });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ message: 'Error simulating salary calculations.' });
  }
};

exports.getSyncSettings = async (req, res) => {
  try {
    const companyId = getCompanyId(req);
    if (!companyId) return res.status(400).json({ message: 'Company ID not found in user request context.' });

    const [company, users] = await Promise.all([
      Company.findById(companyId).select('name settings.payrollIntegration').lean(),
      User.find({ companyId, isActive: true })
        .select('_id firstName lastName email employeeCode department employmentType roles')
        .populate('roles', 'name')
        .sort({ firstName: 1 })
        .lean()
    ]);

    if (!company) return res.status(404).json({ message: 'Company not found.' });

    const settings = normalizePayrollIntegrationSettings(company);
    const allowedSet = new Set((settings.allowedEmployeeIds || []).map(String));

    const employees = users.map(u => ({
      _id: String(u._id),
      employeeCode: u.employeeCode || '',
      firstName: u.firstName || '',
      lastName: u.lastName || '',
      fullName: [u.firstName, u.lastName].filter(Boolean).join(' ').trim() || u.email,
      email: u.email || '',
      department: u.department || '',
      employmentType: u.employmentType || '',
      roles: (u.roles || []).map(r => r?.name || String(r)).filter(Boolean),
      isSyncAllowed: settings.syncMode === 'all' || allowedSet.has(String(u._id))
    }));

    return res.json({
      enabled: settings.enabled,
      externalTenantId: settings.externalTenantId,
      webhookUrl: settings.webhookUrl,
      syncMode: settings.syncMode || 'selected',
      allowedEmployeeIds: settings.allowedEmployeeIds || [],
      employees
    });
  } catch (error) {
    console.error('[PayrollController] getSyncSettings error:', error);
    return res.status(500).json({ message: 'Failed to retrieve payroll sync settings.' });
  }
};

exports.updateSyncSettings = async (req, res) => {
  try {
    const companyId = getCompanyId(req);
    if (!companyId) return res.status(400).json({ message: 'Company ID not found in user request context.' });

    const { syncMode, allowedEmployeeIds } = req.body || {};

    const company = await Company.findById(companyId);
    if (!company) return res.status(404).json({ message: 'Company not found.' });

    if (!company.settings) company.settings = {};
    if (!company.settings.payrollIntegration) company.settings.payrollIntegration = {};

    if (syncMode && ['all', 'selected'].includes(syncMode)) {
      company.settings.payrollIntegration.syncMode = syncMode;
    }
    if (Array.isArray(allowedEmployeeIds)) {
      company.settings.payrollIntegration.allowedEmployeeIds = allowedEmployeeIds;
    }

    company.markModified('settings.payrollIntegration');
    await company.save();

    return res.json({
      message: 'Sync settings updated successfully.',
      syncMode: company.settings.payrollIntegration.syncMode,
      allowedEmployeeIds: company.settings.payrollIntegration.allowedEmployeeIds
    });
  } catch (error) {
    console.error('[PayrollController] updateSyncSettings error:', error);
    return res.status(500).json({ message: 'Failed to update payroll sync settings.' });
  }
};

exports.getMonthlyRoll = async (req, res) => {
  try {
    const companyId = getCompanyId(req);
    if (!companyId) return res.status(400).json({ message: 'Company ID not found in user request context.' });

    const month = parseInt(req.query.month) || (new Date().getMonth() + 1);
    const year = parseInt(req.query.year) || new Date().getFullYear();

    const monthNames = [
      'January', 'February', 'March', 'April', 'May', 'June',
      'July', 'August', 'September', 'October', 'November', 'December'
    ];
    const monthName = monthNames[month - 1] || 'Current';
    const periodLabel = `${monthName} ${year}`;
    const isoPeriod = `${year}-${String(month).padStart(2, '0')}`;

    // End of the selected month
    const endOfMonth = new Date(year, month, 0, 23, 59, 59, 999);

    // Eligible users: active, and joined on or before end of this month
    const users = await User.find({
      companyId,
      isActive: true,
      $or: [
        { joiningDate: { $lte: endOfMonth } },
        { joiningDate: null },
        { joiningDate: { $exists: false } }
      ]
    })
      .select('_id firstName lastName email employeeCode department designation joiningDate employmentType roles')
      .populate('roles', 'name')
      .sort({ firstName: 1 })
      .lean();

    const userIds = users.map(u => u._id);
    const [profiles, company] = await Promise.all([
      EmployeeProfile.find({
        companyId,
        user: { $in: userIds }
      }).select('user compensation').lean(),
      Company.findById(companyId).select('name address settings.logo settings.workspaceBranding').lean()
    ]);

    const defaultCompanyName = company?.name || '';
    const defaultCompanyAddress = typeof company?.address === 'string' ? company.address : (company?.address?.line1 ? `${company.address.line1}${company.address.city ? ', ' + company.address.city : ''}${company.address.state ? ', ' + company.address.state : ''}${company.address.zip ? ' - ' + company.address.zip : ''}` : '');
    const defaultCompanyLogo = company?.settings?.logo || '';

    const profileMap = new Map(profiles.map(p => [String(p.user), p]));

    let generatedCount = 0;
    let totalDisbursed = 0;

    const list = users.map(u => {
      const p = profileMap.get(String(u._id)) || null;
      const comp = p?.compensation || {};
      const history = comp.payrollHistory || [];

      // Look for a payslip matching this period
      const slip = history.find(h => {
        const hPeriod = String(h.period || '').trim().toLowerCase();
        return hPeriod === periodLabel.toLowerCase() || hPeriod === isoPeriod.toLowerCase();
      }) || null;

      const ctc = comp.ctc || 0;
      const breakup = comp.salaryBreakup || {};
      const estimatedTakeHome = breakup.netTakeHome || Math.max(0, ctc - 2000);
      const isGenerated = !!slip;

      if (isGenerated) {
        generatedCount++;
        totalDisbursed += (slip.netSalary || slip.netPay || estimatedTakeHome);
      }

      return {
        _id: String(u._id),
        employeeCode: u.employeeCode || '',
        firstName: u.firstName || '',
        lastName: u.lastName || '',
        fullName: [u.firstName, u.lastName].filter(Boolean).join(' ').trim() || u.email,
        email: u.email || '',
        department: u.department || '',
        designation: u.designation || '',
        joiningDate: u.joiningDate || null,
        roles: (u.roles || []).map(r => r?.name || String(r)).filter(Boolean),
        ctc,
        estimatedTakeHome,
        hasPayslip: isGenerated,
        payslip: slip ? {
          _id: slip._id,
          period: slip.period,
          netSalary: slip.netSalary || slip.netPay || 0,
          grossSalary: slip.grossSalary || 0,
          totalDeductions: slip.totalDeductions || 0,
          status: slip.status || 'Paid',
          payslipUrl: slip.payslipUrl || '',
          processedDate: slip.processedDate || slip.createdAt || null,
          workingDays: slip.workingDays !== undefined ? slip.workingDays : 31,
          paidDays: slip.paidDays !== undefined ? slip.paidDays : 31,
          companyName: slip.companyName || defaultCompanyName,
          companyAddress: slip.companyAddress || defaultCompanyAddress,
          companyLogo: slip.companyLogo || defaultCompanyLogo,
          taxRegime: slip.taxRegime || '',
          earningsLineItems: Array.isArray(slip.earningsLineItems) ? slip.earningsLineItems : [],
          deductionsLineItems: Array.isArray(slip.deductionsLineItems) ? slip.deductionsLineItems : [],
          breakdown: slip.breakdown || {},
          taxWorksheet: slip.taxWorksheet || null
        } : null,
        status: slip ? (slip.status || 'Paid') : 'Pending'
      };
    });

    return res.json({
      period: periodLabel,
      isoPeriod,
      month,
      year,
      totalEligible: list.length,
      generatedCount,
      pendingCount: list.length - generatedCount,
      totalDisbursed,
      company: {
        name: defaultCompanyName,
        address: defaultCompanyAddress,
        logo: defaultCompanyLogo
      },
      employees: list
    });
  } catch (error) {
    console.error('[PayrollController] getMonthlyRoll error:', error);
    return res.status(500).json({ message: 'Failed to retrieve monthly payroll roll.' });
  }
};

exports.resetMonthlyRoll = async (req, res) => {
  try {
    const companyId = getCompanyId(req);
    if (!companyId) return res.status(400).json({ message: 'Company ID not found in user request context.' });

    const month = parseInt(req.body.month || req.query.month) || (new Date().getMonth() + 1);
    const year = parseInt(req.body.year || req.query.year) || new Date().getFullYear();

    const monthNames = [
      'January', 'February', 'March', 'April', 'May', 'June',
      'July', 'August', 'September', 'October', 'November', 'December'
    ];
    const monthName = monthNames[month - 1] || 'Current';
    const periodLabel = `${monthName} ${year}`;
    const isoPeriod = `${year}-${String(month).padStart(2, '0')}`;

    // Target periods to remove
    const targetPeriods = [
      periodLabel.toLowerCase(),
      isoPeriod.toLowerCase()
    ];

    // Find profiles with payrollHistory in this company
    const profiles = await EmployeeProfile.find({
      companyId,
      'compensation.payrollHistory': { $exists: true, $not: { $size: 0 } }
    });

    let removedCount = 0;
    for (const profile of profiles) {
      if (profile.compensation && Array.isArray(profile.compensation.payrollHistory)) {
        const origLen = profile.compensation.payrollHistory.length;
        profile.compensation.payrollHistory = profile.compensation.payrollHistory.filter(h => {
          const hPeriod = String(h.period || '').trim().toLowerCase();
          return !targetPeriods.includes(hPeriod);
        });

        if (profile.compensation.payrollHistory.length !== origLen) {
          removedCount += (origLen - profile.compensation.payrollHistory.length);
          profile.markModified('compensation.payrollHistory');
          await profile.save();
        }
      }
    }

    return res.json({
      success: true,
      message: `Successfully reset payslips for ${periodLabel}. Ready for fresh sync with Flance.`,
      period: periodLabel,
      removedCount
    });
  } catch (error) {
    console.error('[PayrollController] resetMonthlyRoll error:', error);
    return res.status(500).json({ message: 'Failed to reset monthly payroll roll.' });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// NATIVE PROCESS PAYROLL ENGINE (MY BILLS PROCEDURE PORTED TO TALENTCIO)
// ─────────────────────────────────────────────────────────────────────────────

const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'
];

const COMPENSATION_TYPES = [
  { key: 'monthly_salary', name: 'Monthly Salary (Standard CTC)', badge: 'Salaried', description: 'Standard CTC-based salary with component breakdown (Basic, HRA, Flexi) and statutory deductions.' },
  { key: 'hourly', name: 'Hourly Rate', badge: 'Hourly', description: 'Paid based on hours worked multiplied by hourly rate. TDS applicable, no PF/ESI by default.' },
  { key: 'daily_wage', name: 'Daily Wage', badge: 'Daily', description: 'Paid per working day completed at fixed daily rate.' },
  { key: 'weekly_salary', name: 'Weekly Rate', badge: 'Weekly', description: 'Weekly rate converted to monthly CTC equivalent and disbursed monthly.' },
  { key: 'piece_rate', name: 'Piece Rate / Deliverable Output', badge: 'Piece Rate', description: 'Billed per unit produced or task delivered.' },
  { key: 'project_based', name: 'Project Based', badge: 'Project', description: 'Fixed contract or project milestone fee.' },
  { key: 'milestone_based', name: 'Milestone Based', badge: 'Milestone', description: 'Payment disbursed upon achieving verified project milestones.' },
  { key: 'attendance_based', name: 'Attendance Based', badge: 'Strict Proration', description: 'Monthly salary with mandatory daily attendance proration (for interns/trainees).' },
  { key: 'timesheet_based', name: 'Timesheet Based', badge: 'Timesheet', description: 'Approved timesheet hours multiplied by blended billing rate.' },
  { key: 'commission_only', name: 'Commission Only', badge: 'Commission', description: '100% incentive / commission driven earnings.' },
  { key: 'salary_plus_commission', name: 'Salary + Commission', badge: 'Base + Comm', description: 'Fixed monthly base salary plus variable commission.' },
  { key: 'retainer', name: 'Retainer', badge: 'Retainer', description: 'Fixed monthly retainer fee with zero attendance proration (consultants).' }
];

const resolveMonthRange = (month, year) => {
  let parsedMonth = Number.parseInt(month, 10);
  let parsedYear = Number.parseInt(year, 10);

  if (typeof month === 'string' && month.includes('-')) {
    const parts = month.split('-');
    if (parts.length === 2) {
      parsedYear = Number.parseInt(parts[0], 10);
      parsedMonth = Number.parseInt(parts[1], 10);
    }
  }

  if (!Number.isInteger(parsedMonth) || parsedMonth < 1 || parsedMonth > 12) {
    parsedMonth = new Date().getMonth() + 1;
  }
  if (!Number.isInteger(parsedYear) || parsedYear < 2000 || parsedYear > 3000) {
    parsedYear = new Date().getFullYear();
  }

  const paddedMonth = String(parsedMonth).padStart(2, '0');
  const nextMonth = parsedMonth === 12 ? 1 : parsedMonth + 1;
  const nextYear = parsedMonth === 12 ? parsedYear + 1 : parsedYear;
  const paddedNextMonth = String(nextMonth).padStart(2, '0');

  const start = parseDateAsIST(`${parsedYear}-${paddedMonth}-01`);
  const end = parseDateAsIST(`${nextYear}-${paddedNextMonth}-01`);

  return { start, end, parsedMonth, parsedYear };
};

/**
 * GET /api/payroll/active-employees
 * Fetches all eligible company employees for a payroll cycle, loads attendance metrics & approved reimbursements,
 * merges existing payroll records if processed, and calculates preview snapshots.
 */
exports.getActivePayrollEmployees = async (req, res) => {
  try {
    const companyId = getCompanyId(req);
    if (!companyId) return res.status(400).json({ message: 'Company ID not found in user request context.' });

    const month = parseInt(req.query.month, 10) || (new Date().getMonth() + 1);
    const year = parseInt(req.query.year, 10) || new Date().getFullYear();
    const { department, search } = req.query;

    const { start, end, parsedMonth, parsedYear } = resolveMonthRange(month, year);
    const totalDaysInMonth = new Date(parsedYear, parsedMonth, 0).getDate();
    const monthEndStr = `${parsedYear}-${String(parsedMonth).padStart(2, '0')}-${String(totalDaysInMonth).padStart(2, '0')}`;
    const monthStartStr = `${parsedYear}-${String(parsedMonth).padStart(2, '0')}-01`;

    const [configDoc, company] = await Promise.all([
      PayrollConfig.findOne({ companyId }).lean(),
      Company.findById(companyId).select('name settings.attendance settings.logo').lean()
    ]);
    const config = configDoc || new PayrollConfig({ companyId });

    // Find users eligible for this payroll cycle
    const andConditions = [
      {
        $or: [
          { joiningDate: { $lte: new Date(parsedYear, parsedMonth - 1, totalDaysInMonth, 23, 59, 59) } },
          { joiningDate: null },
          { joiningDate: { $exists: false } }
        ]
      },
      {
        $or: [
          { dateOfLeaving: { $gte: start } },
          { dateOfLeaving: null },
          { dateOfLeaving: { $exists: false } }
        ]
      }
    ];

    if (search && search.trim()) {
      const regex = new RegExp(search.trim(), 'i');
      andConditions.push({
        $or: [
          { firstName: regex },
          { lastName: regex },
          { email: regex },
          { employeeCode: regex }
        ]
      });
    }

    const userQuery = {
      companyId,
      isActive: true,
      $and: andConditions
    };

    if (department && department !== 'all') {
      userQuery.department = department;
    }

    const users = await User.find(userQuery)
      .select('_id firstName lastName email employeeCode department designation joiningDate employmentType dateOfLeaving roles salary compensation')
      .populate('roles', 'name')
      .sort({ firstName: 1 })
      .lean();

    const userIds = users.map(u => u._id);

    // Parallel fetch: Employee Profiles, Existing Payrolls, Approved Reimbursements, and IST Attendance/Leave/Holiday/Weekly-Off Summary
    const [profiles, existingPayrolls, approvedReimbursements, attendanceSummaryResult] = await Promise.all([
      EmployeeProfile.find({ companyId, user: { $in: userIds } })
        .select('+compensation.ctc +compensation.salaryBreakup +compensation.bankDetails.accountNumber +identity.panNumber +identity.aadhaarNumber')
        .lean(),
      Payroll.find({ companyId, month: parsedMonth, year: parsedYear, isDeleted: { $ne: true } }).lean(),
      Reimbursement.find({ companyId, employee: { $in: userIds }, status: 'Approved' }).lean(),
      computeCompanyAttendanceSummary({
        companyId,
        company,
        month: parsedMonth,
        year: parsedYear,
        userIds,
        includeDailyDetails: false
      })
    ]);

    const profileMap = new Map(profiles.map(p => [String(p.user), p]));
    const payrollMap = new Map(existingPayrolls.map(p => [String(p.user), p]));
    const attendanceSummaryMap = new Map(attendanceSummaryResult.summaries.map(s => [String(s.userId), s]));

    // Group approved reimbursements by employee
    const reimbursementMap = new Map();
    approvedReimbursements.forEach(r => {
      const uid = String(r.employee);
      if (!reimbursementMap.has(uid)) reimbursementMap.set(uid, []);
      reimbursementMap.get(uid).push({
        _id: r._id,
        name: r.category ? `${r.category}: ${r.description || ''}`.trim() : 'Reimbursement Claim',
        claimed: Number(r.amount) || 0,
        approved: Number(r.amount) || 0,
        billUrl: r.receipts?.[0]?.url || ''
      });
    });

    const defaultWorkingDays = totalDaysInMonth || config.defaultWorkingDays || 30;

    let processedCount = 0;
    let draftCount = 0;
    let approvedCount = 0;
    let paidCount = 0;
    let totalNetPayout = 0;
    let totalDeductions = 0;
    let totalEmployerCost = 0;

    const list = users.map(u => {
      const uidStr = String(u._id);
      const profile = profileMap.get(uidStr);
      const existing = payrollMap.get(uidStr);
      const empReimbs = reimbursementMap.get(uidStr) || [];
      const attSummary = attendanceSummaryMap.get(uidStr);

      const userSal = u.salary || u.compensation || {};
      const comp = profile?.compensation || {};
      const rawBreakup = (comp.salaryBreakup instanceof Map ? Object.fromEntries(comp.salaryBreakup) : comp.salaryBreakup) || userSal.salaryBreakup || userSal || {};
      let monthlyCTC = Number(comp.ctc) || Number(userSal.monthlyCTC) || Number(rawBreakup.monthlyCTC) || (comp.salaryBreakup?.monthlyCTC ? Number(comp.salaryBreakup.monthlyCTC) : 0);
      let annualCTC = Number(comp.annualCTC) || Number(userSal.annualCTC) || Number(rawBreakup.annualCTC) || (monthlyCTC ? monthlyCTC * 12 : 0);
      if (!monthlyCTC && annualCTC > 0) {
        monthlyCTC = Math.round(annualCTC / 12);
      } else if (monthlyCTC > 0 && !annualCTC) {
        annualCTC = monthlyCTC * 12;
      }
      const compensationType = comp.payType === 'hourly' || userSal.payType === 'hourly' ? 'hourly' : (comp.compensationType || userSal.compensationType || rawBreakup.compensationType || 'monthly_salary');
      const hourlyRate = Number(comp.hourlyRate) || Number(userSal.hourlyRate) || 0;

      const presentDays = attSummary?.presentDays ?? 0;
      const absentDays = attSummary?.absentDays ?? 0;
      const weeklyOffDays = attSummary?.weeklyOffDays ?? 0;
      const holidayDays = attSummary?.holidayDays ?? 0;
      const workedOffDays = attSummary?.workedOffDays ?? 0;
      const paidLeaves = existing?.paidLeaves !== undefined ? existing.paidLeaves : (attSummary?.paidLeaves ?? 0);
      const unpaidLeaves = existing?.unpaidLeaves !== undefined ? existing.unpaidLeaves : (attSummary?.unpaidLeaves ?? 0);

      // Calendar days in month, with paidDays crediting present + paidLeaves + weeklyOffDays + holidayDays
      const workingDays = existing?.workingDays !== undefined ? existing.workingDays : defaultWorkingDays;
      const computedPaidDays = attSummary ? Math.min(workingDays, Math.max(0, Number(attSummary.paidDays) || 0)) : workingDays;
      let paidDays = existing?.paidDays !== undefined ? existing.paidDays : computedPaidDays;
      let lop = existing?.lop !== undefined ? existing.lop : Math.max(0, workingDays - paidDays);
      const hoursWorked = existing?.hoursWorked !== undefined ? existing.hoursWorked : (attSummary?.totalWorkingHours ?? (presentDays * 8));
      const autoJoiningBonus = !existing && shouldApplyJoiningBonus(u.joiningDate, parsedMonth, parsedYear)
        ? (Number(comp.joiningBonus || userSal.joiningBonus || rawBreakup.joiningBonus) || 0)
        : 0;

      const source = {
        _id: u._id,
        employeeId: u.employeeCode || String(u._id),
        employeeCode: u.employeeCode || '',
        firstName: u.firstName || '',
        lastName: u.lastName || '',
        email: u.email || '',
        department: u.department || '',
        designation: u.designation || '',
        monthlyCTC,
        annualCTC,
        payType: comp.payType || userSal.payType || 'salaried',
        hourlyRate,
        compensationType,
        ptState: comp.salaryBreakup?.ptState || rawBreakup.ptState || 'custom',
        taxRegime: profile?.identity?.taxRegime || 'new',
        pfEnabled: comp.salaryBreakup?.pfEnabled ?? rawBreakup.pfEnabled ?? true,
        esiEnabled: comp.salaryBreakup?.esiEnabled ?? rawBreakup.esiEnabled ?? true,
        ptEnabled: comp.salaryBreakup?.ptEnabled ?? rawBreakup.ptEnabled ?? true,
        lwfEnabled: comp.salaryBreakup?.lwfEnabled ?? rawBreakup.lwfEnabled ?? true,
        gratuityEnabled: comp.salaryBreakup?.gratuityEnabled ?? rawBreakup.gratuityEnabled ?? true,
        basicPercent: comp.salaryBreakup?.basicPercent || rawBreakup.basicPercent || config.basicPercent || 0.5,
        hraPercent: comp.salaryBreakup?.hraPercent || rawBreakup.hraPercent || config.hraPercent || 0.5,
        reimbursements: empReimbs,
        salaryStructure: rawBreakup,
        ...rawBreakup
      };

      let snapshot;
      if (existing) {
        snapshot = {
          basic: existing.earnings?.basic || 0,
          hra: existing.earnings?.hra || 0,
          specialAllowance: existing.earnings?.specialAllowance || 0,
          flexi: existing.earnings?.flexiAmount || 0,
          broadband: existing.earnings?.broadband || 0,
          petrol: existing.earnings?.petrol || 0,
          lta: existing.earnings?.lta || 0,
          conveyance: existing.earnings?.conveyance || 0,
          medicalAllowance: existing.earnings?.medicalAllowance || 0,
          totalEarnings: existing.earnings?.totalEarnings || 0,
          grossSalary: existing.earnings?.totalEarnings || 0,
          pfEmployee: existing.deductions?.pfEmployee || 0,
          esiEmployee: existing.deductions?.esiEmployee || 0,
          professionalTax: existing.deductions?.professionalTax || 0,
          tds: existing.deductions?.tds || 0,
          lwfEmployee: existing.deductions?.lwfEmployee || 0,
          loanDeduction: existing.deductions?.loanDeduction || 0,
          advanceDeduction: existing.deductions?.advanceDeduction || 0,
          totalDeductions: existing.deductions?.totalDeductions || 0,
          pfEmployer: existing.employerContributions?.pfEmployer || 0,
          esiEmployer: existing.employerContributions?.esiEmployer || 0,
          gratuity: existing.employerContributions?.gratuity || 0,
          lwfEmployer: existing.employerContributions?.lwfEmployer || 0,
          totalVariablePay: existing.variablePay?.totalVariablePay || 0,
          reimbursements: existing.reimbursements || [],
          totalReimbursementApproved: existing.totalReimbursementApproved || 0,
          netSalary: existing.netSalary || 0
        };
      } else {
        const attInput = { workingDays, paidDays, lop, hoursWorked };
        const totalReimbs = empReimbs.reduce((acc, r) => acc + (Number(r.approved) || 0), 0);
        const adj = { reimbursements: totalReimbs, joiningBonus: autoJoiningBonus };
        snapshot = buildPayrollSnapshot(source, config, attInput, adj, parsedMonth, parsedYear);
        snapshot.reimbursements = empReimbs;
        snapshot.totalReimbursementApproved = totalReimbs;
      }

      const status = existing ? existing.status : 'unprocessed';
      if (existing) {
        processedCount++;
        if (status === 'draft' || status === 'processed') draftCount++;
        else if (status === 'approved') approvedCount++;
        else if (status === 'paid') paidCount++;

        totalNetPayout += (existing.netSalary || 0);
        totalDeductions += (existing.deductions?.totalDeductions || 0);
        totalEmployerCost += (existing.employerContributions?.grossTotalSalary || (existing.earnings?.totalEarnings + (existing.employerContributions?.pfEmployer || 0)));
      }

      return {
        _id: uidStr,
        userId: uidStr,
        employeeId: uidStr,
        payrollId: existing ? String(existing._id) : null,
        employeeCode: u.employeeCode || '',
        firstName: u.firstName || '',
        lastName: u.lastName || '',
        fullName: [u.firstName, u.lastName].filter(Boolean).join(' ').trim() || u.email,
        email: u.email || '',
        department: u.department || '',
        designation: u.designation || '',
        joiningDate: u.joiningDate,
        employmentType: u.employmentType || 'full-time',
        compensationType,
        hourlyRate,
        monthlyCTC,
        annualCTC,
        ctcMonthly: monthlyCTC,
        workingDays,
        paidDays,
        paidLeaves,
        unpaidLeaves,
        weeklyOffDays,
        holidayDays,
        presentDays,
        absentDays,
        workedOffDays,
        lop,
        hoursWorked,
        flags: {
          pfEnabled: source.pfEnabled,
          esiEnabled: source.esiEnabled,
          ptEnabled: source.ptEnabled,
          lwfEnabled: source.lwfEnabled,
          gratuityEnabled: source.gratuityEnabled,
          insuranceEnabled: source.insuranceEnabled ?? (Number(rawBreakup.insuranceAmount || comp.insuranceAmount || 0) > 0),
          insuranceDeductFromFlexi: source.insuranceDeductFromFlexi ?? rawBreakup.insuranceDeductFromFlexi ?? true,
          insuranceAmount: Number(rawBreakup.insuranceAmount || comp.insuranceAmount || 0),
          employerNPS: Number(rawBreakup.employerNPS || comp.employerNPS || 0),
          ptState: source.ptState || 'custom',
          taxRegime: source.taxRegime || 'new',
          basicPercent: source.basicPercent,
          hraPercent: source.hraPercent
        },
        earnings: {
          basic: snapshot.basic || 0,
          hra: snapshot.hra || 0,
          specialAllowance: snapshot.specialAllowance || 0,
          flexiAmount: snapshot.flexi || snapshot.flexiAmount || 0,
          broadband: snapshot.broadband || 0,
          petrol: snapshot.petrol || 0,
          lta: snapshot.lta || 0,
          conveyance: snapshot.conveyance || 0,
          medicalAllowance: snapshot.medicalAllowance || 0,
          ...(snapshot.earningsMap || {}),
          ...(snapshot.earnings || {}),
          totalEarnings: snapshot.totalEarnings || snapshot.grossSalary || 0
        },
        masterEarnings: snapshot.masterEarnings || snapshot.master?.earningsMap || {
          basic: snapshot.master?.basicMaster,
          hra: snapshot.master?.hraMaster,
          specialAllowance: snapshot.master?.specialAllowance
        },
        deductions: {
          pfEmployee: snapshot.pfEmployee || 0,
          esiEmployee: snapshot.esiEmployee || 0,
          professionalTax: snapshot.professionalTax || 0,
          tds: snapshot.tds || 0,
          lwfEmployee: snapshot.lwfEmployee || 0,
          loanDeduction: snapshot.loanDeduction || 0,
          advanceDeduction: snapshot.advanceDeduction || 0,
          totalDeductions: snapshot.totalDeductions || 0
        },
        employerContributions: {
          pfEmployer: snapshot.pfEmployer || 0,
          esiEmployer: snapshot.esiEmployer || 0,
          gratuity: snapshot.gratuity || 0,
          lwfEmployer: snapshot.lwfEmployer || 0,
          insuranceEmployer: existing?.employerContributions?.insuranceEmployer ?? snapshot.insurance ?? 0,
          nps: existing?.employerContributions?.nps ?? snapshot.employerNPS ?? 0,
          grossTotalSalary: snapshot.grossTotalSalary || 0
        },
        annualBenefits: extractAnnualBenefits(rawBreakup),
        variablePay: {
          totalVariablePay: snapshot.totalVariablePay || 0,
          joiningBonus: existing?.variablePay?.joiningBonus ?? autoJoiningBonus,
          incentive: existing?.variablePay?.incentive || 0,
          specialBonus: existing?.variablePay?.specialBonus || 0,
          otherAllowanceArrear: existing?.variablePay?.otherAllowanceArrear || 0
        },
        reimbursements: snapshot.reimbursements || [],
        totalReimbursementApproved: snapshot.totalReimbursementApproved || 0,
        netSalary: snapshot.netSalary || 0,
        status,
        isFullAndFinal: existing?.isFullAndFinal || false,
        paymentDate: existing?.paymentDate || null,
        paymentMethod: existing?.paymentMethod || 'Bank Transfer',
        transactionId: existing?.transactionId || '',
        notes: existing?.notes || ''
      };
    });

    return res.json({
      period: `${MONTH_NAMES[parsedMonth - 1]} ${parsedYear}`,
      month: parsedMonth,
      year: parsedYear,
      summary: {
        totalEligible: list.length,
        processedCount,
        draftCount,
        approvedCount,
        paidCount,
        unprocessedCount: list.length - processedCount,
        totalNetPayout,
        totalDeductions,
        totalEmployerCost
      },
      employees: list,
      config: {
        defaultWorkingDays,
        basicPercent: config.basicPercent,
        hraPercent: config.hraPercent,
        pfRate: config.pfRate,
        esiEmployeeRate: config.esiEmployeeRate
      }
    });
  } catch (error) {
    console.error('[PayrollController] getActivePayrollEmployees error:', error);
    return res.status(500).json({ message: `Error fetching active employees: ${error.message}` });
  }
};

/**
 * POST /api/payroll/process
 * Runs native payroll calculation and batch persistence for company employees.
 */
exports.processPayroll = async (req, res) => {
  try {
    const companyId = getCompanyId(req);
    if (!companyId) return res.status(400).json({ message: 'Company ID not found in user request context.' });

    const month = Number(req.body.month);
    const year = Number(req.body.year);
    const employeePayloads = Array.isArray(req.body.employees) ? req.body.employees : [];
    const saveAsDraft = req.body.saveAsDraft !== false;

    if (!month || month < 1 || month > 12 || !year || year < 2000) {
      return res.status(400).json({ message: 'Valid month and year are required.' });
    }
    if (employeePayloads.length === 0) {
      return res.status(400).json({ message: 'Select at least one employee to process payroll.' });
    }

    const configDoc = await PayrollConfig.findOne({ companyId }).lean();
    const config = configDoc || new PayrollConfig({ companyId });

    const processedPayrolls = [];
    const now = new Date();
    const status = saveAsDraft ? 'draft' : 'processed';

    for (const emp of employeePayloads) {
      const userId = emp.userId || emp._id;
      if (!userId) continue;

      const user = await User.findOne({ _id: userId, companyId }).lean();
      if (!user) continue;

      const profile = await EmployeeProfile.findOne({ companyId, user: userId })
        .select('+compensation.ctc +compensation.bankDetails.accountNumber +identity.panNumber +identity.aadhaarNumber')
        .lean();

      const userSal = user.salary || user.compensation || {};
      const comp = profile?.compensation || {};
      const rawBreakup = (comp.salaryBreakup instanceof Map ? Object.fromEntries(comp.salaryBreakup) : comp.salaryBreakup) || userSal.salaryBreakup || userSal || {};
      const empFlags = emp.flags || {};

      const totalDaysInMonth = new Date(year, month, 0).getDate();
      const workingDays = Number(emp.workingDays) || totalDaysInMonth || config.defaultWorkingDays || 30;
      const lop = emp.lop !== undefined ? Number(emp.lop) : 0;
      const paidDays = emp.paidDays !== undefined ? Number(emp.paidDays) : Math.max(0, workingDays - lop);
      const hoursWorked = Number(emp.hoursWorked) || 0;
      const hourlyRate = Number(emp.hourlyRate) || Number(comp.hourlyRate) || Number(userSal.hourlyRate) || 0;
      const payType = emp.payType || comp.payType || userSal.payType || 'salaried';
      const compensationType = emp.compensationType || (payType === 'hourly' ? 'hourly' : (comp.compensationType || userSal.compensationType || rawBreakup.compensationType || 'monthly_salary'));
      let monthlyCTC = Number(emp.monthlyCTC) || Number(comp.ctc) || Number(userSal.monthlyCTC) || Number(rawBreakup.monthlyCTC) || 0;
      const annualCTC = Number(comp.annualCTC) || Number(userSal.annualCTC) || Number(rawBreakup.annualCTC) || (monthlyCTC ? monthlyCTC * 12 : 0);
      if (!monthlyCTC && annualCTC > 0) monthlyCTC = Math.round(annualCTC / 12);

      const variablePayInput = emp.variablePay || {};
      const deductionsInput = emp.deductions || {};
      const earningsInput = emp.earnings || {};
      const reimbursements = Array.isArray(emp.reimbursements) ? emp.reimbursements : [];
      const totalReimbursementApproved = reimbursements.reduce((acc, r) => acc + (Number(r.approved) || 0), 0);

      const autoJoiningBonus = shouldApplyJoiningBonus(user.joiningDate, month, year)
        ? (Number(comp.joiningBonus || userSal.joiningBonus || rawBreakup.joiningBonus) || 0)
        : 0;
      const joiningBonus = variablePayInput.joiningBonus !== undefined ? (Number(variablePayInput.joiningBonus) || 0) : autoJoiningBonus;
      const incentive = Number(variablePayInput.incentive) || 0;
      const specialBonus = Number(variablePayInput.specialBonus) || 0;
      const otherAllowanceArrear = Number(variablePayInput.otherAllowanceArrear) || 0;
      const overtime = Number(earningsInput.overtime) || 0;
      const loanDeduction = Number(deductionsInput.loanDeduction) || 0;
      const advanceDeduction = Number(deductionsInput.advanceDeduction) || 0;

      const rawBasicPct = empFlags.basicPercent || comp.salaryBreakup?.basicPercent || rawBreakup.basicPercent || config.basicPercent || 0.5;
      const rawHraPct = empFlags.hraPercent || comp.salaryBreakup?.hraPercent || rawBreakup.hraPercent || config.hraPercent || 0.5;

      const source = {
        ...rawBreakup,
        _id: user._id,
        monthlyCTC,
        annualCTC,
        payType,
        hourlyRate,
        compensationType,
        ptState: empFlags.ptState || comp.salaryBreakup?.ptState || rawBreakup.ptState || 'custom',
        taxRegime: profile?.identity?.taxRegime || 'new',
        pfEnabled: empFlags.pfEnabled ?? comp.salaryBreakup?.pfEnabled ?? rawBreakup.pfEnabled ?? true,
        esiEnabled: empFlags.esiEnabled ?? comp.salaryBreakup?.esiEnabled ?? rawBreakup.esiEnabled ?? true,
        ptEnabled: empFlags.ptEnabled ?? comp.salaryBreakup?.ptEnabled ?? rawBreakup.ptEnabled ?? true,
        lwfEnabled: empFlags.lwfEnabled ?? comp.salaryBreakup?.lwfEnabled ?? rawBreakup.lwfEnabled ?? true,
        gratuityEnabled: empFlags.gratuityEnabled ?? comp.salaryBreakup?.gratuityEnabled ?? rawBreakup.gratuityEnabled ?? true,
        basicPercent: Number(rawBasicPct) > 1 ? Number(rawBasicPct) / 100 : Number(rawBasicPct),
        hraPercent: Number(rawHraPct) > 1 ? Number(rawHraPct) / 100 : Number(rawHraPct),
        salaryStructure: rawBreakup
      };

      const adj = {
        joiningBonus,
        incentive,
        specialBonus,
        otherAllowanceArrear,
        reimbursements: totalReimbursementApproved,
        ...(deductionsInput.tds !== undefined && deductionsInput.tds !== '' ? { tds: Number(deductionsInput.tds) } : {})
      };

      const snapshot = buildPayrollSnapshot(source, config, { workingDays, paidDays, lop, hoursWorked }, adj, month, year);

      const totalEarnings = Number(((snapshot.totalEarnings || 0) + overtime).toFixed(2));
      const totalVariablePay = Number((joiningBonus + incentive + specialBonus + otherAllowanceArrear).toFixed(2));
      const tdsVal = deductionsInput.tds !== undefined && deductionsInput.tds !== '' ? Number(deductionsInput.tds) : (snapshot.tds || 0);
      const ptVal = deductionsInput.professionalTax !== undefined && deductionsInput.professionalTax !== '' && Number(deductionsInput.professionalTax) >= 0 && empFlags.manualPtOverride
        ? Number(deductionsInput.professionalTax)
        : (snapshot.professionalTax || 0);
      const totalDeductions = Number(((snapshot.pfEmployee || 0) + (snapshot.esiEmployee || 0) + ptVal + tdsVal + (snapshot.lwfEmployee || 0) + loanDeduction + advanceDeduction).toFixed(2));
      const netSalary = Math.max(0, Number(((totalEarnings + totalVariablePay + totalReimbursementApproved) - totalDeductions).toFixed(2)));

      const updateData = {
        companyId,
        user: userId,
        employeeCode: user.employeeCode || '',
        month,
        year,
        workingDays,
        paidDays,
        paidLeaves: Number(emp.paidLeaves) || 0,
        unpaidLeaves: Number(emp.unpaidLeaves) || 0,
        lop,
        hoursWorked,
        attendanceSource: emp.attendanceSource || 'hrms',
        payType,
        hourlyRate,
        compensationType,
        periodInput: emp.periodInput || {},
        earnings: {
          basic: snapshot.basic || 0,
          hra: snapshot.hra || 0,
          flexiAmount: snapshot.flexi || 0,
          broadband: snapshot.broadband || 0,
          petrol: snapshot.petrol || 0,
          lta: snapshot.lta || 0,
          specialAllowance: snapshot.specialAllowance || 0,
          overtime,
          conveyance: snapshot.conveyance || 0,
          medicalAllowance: snapshot.medicalAllowance || 0,
          totalEarnings
        },
        employerContributions: {
          pfEmployer: snapshot.pfEmployer || 0,
          esiEmployer: snapshot.esiEmployer || 0,
          gratuity: snapshot.gratuity || 0,
          lwfEmployer: snapshot.lwfEmployer || 0,
          insuranceEmployer: snapshot.insurance || 0,
          nps: snapshot.employerNPS || 0,
          grossTotalSalary: Number((totalEarnings + (snapshot.pfEmployer || 0) + (snapshot.esiEmployer || 0) + (snapshot.gratuity || 0) + (snapshot.lwfEmployer || 0) + (snapshot.insurance || 0) + (snapshot.employerNPS || 0)).toFixed(2))
        },
        variablePay: {
          joiningBonus,
          incentive,
          specialBonus,
          otherAllowanceArrear,
          totalVariablePay
        },
        deductions: {
          pfEmployee: snapshot.pfEmployee || 0,
          esiEmployee: snapshot.esiEmployee || 0,
          professionalTax: ptVal,
          tds: tdsVal,
          lwfEmployee: snapshot.lwfEmployee || 0,
          loanDeduction,
          advanceDeduction,
          totalDeductions
        },
        totalPayable: totalEarnings + totalVariablePay,
        reimbursements,
        totalReimbursementApproved,
        netSalary,
        status,
        notes: emp.notes || '',
        employeeSnapshot: {
          employeeId: user.employeeCode || String(user._id),
          employeeCode: user.employeeCode || '',
          firstName: user.firstName || '',
          lastName: user.lastName || '',
          fullName: [user.firstName, user.lastName].filter(Boolean).join(' ').trim() || user.email,
          email: user.email || '',
          department: user.department || '',
          designation: user.designation || '',
          joiningDate: user.joiningDate,
          monthlyCTC,
          annualCTC: monthlyCTC * 12,
          compensationType,
          payFrequency: 'monthly',
          taxRegime: profile?.identity?.taxRegime || 'new'
        }
      };

      const existingPayroll = await Payroll.findOne({ companyId, user: userId, month, year, isDeleted: { $ne: true } });
      let savedDoc;
      if (existingPayroll) {
        if (existingPayroll.status === 'paid') {
          // Immutability: paid payroll cannot be overwritten by re-process without reopening
          continue;
        }
        Object.assign(existingPayroll, updateData);
        existingPayroll.auditLog.push({
          status,
          changedBy: req.user?.firstName ? `${req.user.firstName} ${req.user.lastName || ''}`.trim() : (req.user?.name || 'HR Admin'),
          changedById: req.user?._id,
          changedAt: now,
          netSalary,
          notes: 'Payroll updated in batch run'
        });
        savedDoc = await existingPayroll.save();
      } else {
        updateData.auditLog = [{
          status,
          changedBy: req.user?.firstName ? `${req.user.firstName} ${req.user.lastName || ''}`.trim() : (req.user?.name || 'HR Admin'),
          changedById: req.user?._id,
          changedAt: now,
          netSalary,
          notes: 'Payroll created in batch run'
        }];
        savedDoc = await Payroll.create(updateData);
      }
      processedPayrolls.push(savedDoc);
    }

    return res.status(201).json({
      success: true,
      message: `Processed ${processedPayrolls.length} employee payroll records.`,
      count: processedPayrolls.length,
      payrolls: processedPayrolls
    });
  } catch (error) {
    console.error('[PayrollController] processPayroll error:', error);
    return res.status(500).json({ message: `Error processing payroll: ${error.message}` });
  }
};

/**
 * POST /api/payroll/preview
 * Instant simulation preview for single employee.
 */
exports.previewPayroll = async (req, res) => {
  try {
    const companyId = getCompanyId(req);
    if (!companyId) return res.status(400).json({ message: 'Company ID not found in user request context.' });

    const { userId, employeeId, month, year, attendance = {}, adjustments = {} } = req.body;
    const targetId = userId || employeeId;
    if (!targetId || !month || !year) {
      return res.status(400).json({ message: 'userId or employeeId, month, and year are required.' });
    }

    const [user, profile, configDoc] = await Promise.all([
      User.findOne({ _id: targetId, companyId })
        .select('_id firstName lastName email employeeCode department designation joiningDate employmentType roles salary compensation')
        .lean(),
      EmployeeProfile.findOne({ companyId, user: targetId })
        .select('+compensation.ctc +compensation.salaryBreakup +compensation.bankDetails.accountNumber +identity.panNumber +identity.aadhaarNumber')
        .lean(),
      PayrollConfig.findOne({ companyId }).lean()
    ]);

    if (!user) return res.status(404).json({ message: 'Employee not found.' });
    const config = configDoc || new PayrollConfig({ companyId });

    const userSal = user.salary || user.compensation || {};
    const comp = profile?.compensation || {};
    const rawBreakup = (comp.salaryBreakup instanceof Map ? Object.fromEntries(comp.salaryBreakup) : comp.salaryBreakup) || userSal.salaryBreakup || userSal || {};
    let monthlyCTC = Number(comp.ctc) || Number(userSal.monthlyCTC) || Number(rawBreakup.monthlyCTC) || (comp.salaryBreakup?.monthlyCTC ? Number(comp.salaryBreakup.monthlyCTC) : 0);
    let annualCTC = Number(comp.annualCTC) || Number(userSal.annualCTC) || Number(rawBreakup.annualCTC) || (monthlyCTC ? monthlyCTC * 12 : 0);
    if (!monthlyCTC && annualCTC > 0) {
      monthlyCTC = Math.round(annualCTC / 12);
    } else if (monthlyCTC > 0 && !annualCTC) {
      annualCTC = monthlyCTC * 12;
    }

    const rawPrevBasicPct = adjustments.basicPercent !== undefined ? adjustments.basicPercent : (comp.salaryBreakup?.basicPercent || rawBreakup.basicPercent || config.basicPercent || 0.5);
    const rawPrevHraPct = adjustments.hraPercent !== undefined ? adjustments.hraPercent : (comp.salaryBreakup?.hraPercent || rawBreakup.hraPercent || config.hraPercent || 0.5);

    const source = {
      ...rawBreakup,
      _id: user._id,
      employeeId: user.employeeCode || String(user._id),
      employeeCode: user.employeeCode || '',
      firstName: user.firstName || '',
      lastName: user.lastName || '',
      email: user.email || '',
      department: user.department || '',
      designation: user.designation || '',
      monthlyCTC,
      annualCTC,
      payType: comp.payType || userSal.payType || 'salaried',
      hourlyRate: Number(comp.hourlyRate) || Number(userSal.hourlyRate) || 0,
      compensationType: comp.payType === 'hourly' || userSal.payType === 'hourly' ? 'hourly' : (comp.compensationType || userSal.compensationType || rawBreakup.compensationType || 'monthly_salary'),
      ptState: adjustments.ptState || comp.salaryBreakup?.ptState || rawBreakup.ptState || 'custom',
      taxRegime: profile?.identity?.taxRegime || 'new',
      pfEnabled: adjustments.pfEnabled !== undefined ? adjustments.pfEnabled : (comp.salaryBreakup?.pfEnabled ?? rawBreakup.pfEnabled ?? true),
      esiEnabled: adjustments.esiEnabled !== undefined ? adjustments.esiEnabled : (comp.salaryBreakup?.esiEnabled ?? rawBreakup.esiEnabled ?? true),
      ptEnabled: adjustments.ptEnabled !== undefined ? adjustments.ptEnabled : (comp.salaryBreakup?.ptEnabled ?? rawBreakup.ptEnabled ?? true),
      lwfEnabled: adjustments.lwfEnabled !== undefined ? adjustments.lwfEnabled : (comp.salaryBreakup?.lwfEnabled ?? rawBreakup.lwfEnabled ?? true),
      gratuityEnabled: adjustments.gratuityEnabled !== undefined ? adjustments.gratuityEnabled : (comp.salaryBreakup?.gratuityEnabled ?? rawBreakup.gratuityEnabled ?? true),
      basicPercent: Number(rawPrevBasicPct) > 1 ? Number(rawPrevBasicPct) / 100 : Number(rawPrevBasicPct),
      hraPercent: Number(rawPrevHraPct) > 1 ? Number(rawPrevHraPct) / 100 : Number(rawPrevHraPct),
      salaryStructure: rawBreakup
    };

    const snapshot = buildPayrollSnapshot(source, config, attendance, adjustments, Number(month), Number(year));
    const employerContributions = {
      pfEmployer: snapshot.pfEmployer || 0,
      esiEmployer: snapshot.esiEmployer || 0,
      gratuity: snapshot.gratuity || 0,
      lwfEmployer: snapshot.lwfEmployer || 0,
      insuranceEmployer: snapshot.insurance || 0,
      nps: snapshot.employerNPS || 0
    };
    const annualBenefits = extractAnnualBenefits(rawBreakup);

    return res.json({
      ...snapshot,
      employerContributions,
      annualBenefits,
      monthlyCTC,
      success: true,
      snapshot: { ...snapshot, employerContributions, annualBenefits, monthlyCTC },
      calculation: { ...snapshot, employerContributions, annualBenefits, monthlyCTC },
      master: source
    });
  } catch (error) {
    console.error('[PayrollController] previewPayroll error:', error);
    return res.status(500).json({ message: `Error previewing payroll: ${error.message}` });
  }
};

/**
 * GET /api/payroll/records
 * Query saved payroll records with filters and pagination.
 */
exports.getPayrolls = async (req, res) => {
  try {
    const companyId = getCompanyId(req);
    if (!companyId) return res.status(400).json({ message: 'Company ID not found in user request context.' });

    const month = parseInt(req.query.month, 10);
    const year = parseInt(req.query.year, 10);
    const { status, search } = req.query;
    const page = parseInt(req.query.page, 10) || 1;
    const limit = parseInt(req.query.limit, 10) || 50;
    const skip = (page - 1) * limit;

    const query = { companyId, isDeleted: { $ne: true } };
    if (month && !Number.isNaN(month)) query.month = month;
    if (year && !Number.isNaN(year)) query.year = year;
    if (status && status !== 'all') query.status = status;

    if (search && search.trim()) {
      const regex = new RegExp(search.trim(), 'i');
      query.$or = [
        { 'employeeSnapshot.fullName': regex },
        { 'employeeSnapshot.employeeCode': regex },
        { 'employeeSnapshot.email': regex },
        { 'employeeSnapshot.department': regex }
      ];
    }

    const [total, records] = await Promise.all([
      Payroll.countDocuments(query),
      Payroll.find(query)
        .populate('user', 'firstName lastName email employeeCode department designation')
        .sort({ year: -1, month: -1, createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean()
    ]);

    let totalNetSalary = 0;
    let totalDeductions = 0;
    let draftCount = 0;
    let approvedCount = 0;
    let paidCount = 0;

    records.forEach(r => {
      totalNetSalary += (r.netSalary || 0);
      totalDeductions += (r.deductions?.totalDeductions || 0);
      if (r.status === 'draft' || r.status === 'processed') draftCount++;
      else if (r.status === 'approved') approvedCount++;
      else if (r.status === 'paid') paidCount++;
    });

    return res.json({
      data: records,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
      summary: {
        totalRecords: total,
        totalNetSalary,
        totalDeductions,
        draftCount,
        approvedCount,
        paidCount
      }
    });
  } catch (error) {
    console.error('[PayrollController] getPayrolls error:', error);
    return res.status(500).json({ message: `Error fetching payroll records: ${error.message}` });
  }
};

/**
 * GET /api/payroll/records/:id
 */
exports.getPayrollById = async (req, res) => {
  try {
    const companyId = getCompanyId(req);
    const { id } = req.params;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ message: 'Invalid payroll ID.' });
    }

    const payroll = await Payroll.findOne({ _id: id, companyId, isDeleted: { $ne: true } })
      .populate('user', 'firstName lastName email employeeCode department designation')
      .lean();

    if (!payroll) return res.status(404).json({ message: 'Payroll record not found.' });
    return res.json(payroll);
  } catch (error) {
    console.error('[PayrollController] getPayrollById error:', error);
    return res.status(500).json({ message: `Error fetching payroll record: ${error.message}` });
  }
};

/**
 * PUT /api/payroll/records/:id
 */
exports.updatePayroll = async (req, res) => {
  try {
    const companyId = getCompanyId(req);
    const { id } = req.params;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ message: 'Invalid payroll ID.' });
    }

    const payroll = await Payroll.findOne({ _id: id, companyId, isDeleted: { $ne: true } });
    if (!payroll) return res.status(404).json({ message: 'Payroll record not found.' });

    if (payroll.status === 'paid') {
      return res.status(400).json({ message: 'Cannot edit paid payroll. Please reopen payroll first.' });
    }

    const updateFields = { ...(req.body || {}) };
    delete updateFields._id;
    delete updateFields.companyId;
    delete updateFields.user;
    if (updateFields.status === 'paid') {
      return res.status(400).json({ message: 'Use the mark-paid endpoint to mark a payroll as paid.' });
    }

    Object.assign(payroll, updateFields);
    payroll.auditLog.push({
      status: payroll.status,
      changedBy: req.user?.firstName ? `${req.user.firstName} ${req.user.lastName || ''}`.trim() : (req.user?.name || 'HR Admin'),
      changedById: req.user?._id,
      changedAt: new Date(),
      netSalary: payroll.netSalary,
      notes: req.body.remarks || 'Individual payroll record updated'
    });

    await payroll.save();
    return res.json({ success: true, message: 'Payroll updated successfully.', payroll });
  } catch (error) {
    console.error('[PayrollController] updatePayroll error:', error);
    return res.status(500).json({ message: `Error updating payroll: ${error.message}` });
  }
};

/**
 * PUT /api/payroll/bulk-approve
 * Approves all draft/processed payrolls for month and year.
 */
exports.bulkApprovePayroll = async (req, res) => {
  try {
    const companyId = getCompanyId(req);
    if (!companyId) return res.status(400).json({ message: 'Company ID not found in user request context.' });

    const month = Number(req.body.month);
    const year = Number(req.body.year);
    const ids = Array.isArray(req.body.ids) ? req.body.ids.filter(id => mongoose.Types.ObjectId.isValid(String(id))) : [];

    const filter = {
      companyId,
      status: { $in: ['draft', 'processed'] },
      isDeleted: { $ne: true }
    };

    if (ids.length > 0) filter._id = { $in: ids };
    if (month && !Number.isNaN(month)) filter.month = month;
    if (year && !Number.isNaN(year)) filter.year = year;

    const payrolls = await Payroll.find(filter);
    if (!payrolls.length) {
      return res.json({ matched: 0, modified: 0, message: 'No eligible payrolls found to approve.' });
    }

    const now = new Date();
    const actorName = req.user?.firstName ? `${req.user.firstName} ${req.user.lastName || ''}`.trim() : (req.user?.name || 'HR Admin');

    const bulkOps = payrolls.map(p => ({
      updateOne: {
        filter: { _id: p._id },
        update: {
          $set: { status: 'approved' },
          $push: {
            auditLog: {
              status: 'approved',
              changedBy: actorName,
              changedById: req.user?._id,
              changedAt: now,
              netSalary: p.netSalary,
              notes: req.body.remarks || 'Bulk approved'
            }
          }
        }
      }
    }));

    const result = await Payroll.bulkWrite(bulkOps);
    return res.json({
      success: true,
      matched: payrolls.length,
      modified: result.modifiedCount,
      message: `Approved ${result.modifiedCount} payroll records.`
    });
  } catch (error) {
    console.error('[PayrollController] bulkApprovePayroll error:', error);
    return res.status(500).json({ message: `Error approving payroll: ${error.message}` });
  }
};

/**
 * POST /api/payroll/records/:id/mark-paid
 * Marks payroll record as paid, sets payment date, records in EmployeeProfile.compensation.payrollHistory,
 * and sets approved reimbursements to Reimbursed.
 */
exports.markPayrollAsPaid = async (req, res) => {
  try {
    const companyId = getCompanyId(req);
    const id = req.params.id;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ message: 'Invalid payroll ID.' });
    }

    const payroll = await Payroll.findOne({ _id: id, companyId, isDeleted: { $ne: true } });
    if (!payroll) return res.status(404).json({ message: 'Payroll record not found.' });

    const paymentDate = req.body.paymentDate ? new Date(req.body.paymentDate) : new Date();
    const paymentMethod = req.body.paymentMethod || 'Bank Transfer';
    const transactionId = req.body.transactionId || '';
    const actorName = req.user?.firstName ? `${req.user.firstName} ${req.user.lastName || ''}`.trim() : (req.user?.name || 'HR Admin');

    payroll.status = 'paid';
    payroll.paymentDate = paymentDate;
    payroll.paymentMethod = paymentMethod;
    payroll.transactionId = transactionId;
    payroll.auditLog.push({
      status: 'paid',
      changedBy: actorName,
      changedById: req.user?._id,
      changedAt: new Date(),
      netSalary: payroll.netSalary,
      notes: req.body.remarks || 'Payroll marked as paid'
    });

    await payroll.save();

    // Push into EmployeeProfile compensation.payrollHistory so it immediately surfaces in Payslips tab
    const monthName = MONTH_NAMES[payroll.month - 1] || 'Current';
    const periodLabel = `${monthName} ${payroll.year}`;

    const profile = await EmployeeProfile.findOne({ companyId, user: payroll.user });
    if (profile) {
      if (!profile.compensation) profile.compensation = {};
      if (!Array.isArray(profile.compensation.payrollHistory)) profile.compensation.payrollHistory = [];

      const existingSlipIdx = profile.compensation.payrollHistory.findIndex(
        h => String(h.period || '').trim().toLowerCase() === periodLabel.toLowerCase()
      );

      const payslipRecord = {
        period: periodLabel,
        netSalary: payroll.netSalary,
        status: 'Paid',
        payslipUrl: `/api/payroll/records/${payroll._id}`
      };

      if (existingSlipIdx >= 0) {
        profile.compensation.payrollHistory[existingSlipIdx] = {
          ...profile.compensation.payrollHistory[existingSlipIdx],
          ...payslipRecord
        };
      } else {
        profile.compensation.payrollHistory.push(payslipRecord);
      }

      profile.markModified('compensation.payrollHistory');
      await profile.save();
    }

    // Mark reimbursements as Reimbursed
    if (payroll.reimbursements && payroll.reimbursements.length > 0) {
      const reimbIds = payroll.reimbursements.map(r => r._id).filter(Boolean);
      if (reimbIds.length > 0) {
        await Reimbursement.updateMany(
          { _id: { $in: reimbIds }, companyId },
          { $set: { status: 'Reimbursed' } }
        );
      }
    }

    return res.json({
      success: true,
      message: 'Payroll marked as paid and payslip generated in employee dossier.',
      payroll
    });
  } catch (error) {
    console.error('[PayrollController] markPayrollAsPaid error:', error);
    return res.status(500).json({ message: `Error marking payroll as paid: ${error.message}` });
  }
};

/**
 * POST /api/payroll/records/:id/reopen
 * Moves paid or approved payroll back to draft.
 */
exports.reopenPayroll = async (req, res) => {
  try {
    const companyId = getCompanyId(req);
    const id = req.params.id;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ message: 'Invalid payroll ID.' });
    }

    const payroll = await Payroll.findOne({ _id: id, companyId, isDeleted: { $ne: true } });
    if (!payroll) return res.status(404).json({ message: 'Payroll record not found.' });

    const actorName = req.user?.firstName ? `${req.user.firstName} ${req.user.lastName || ''}`.trim() : (req.user?.name || 'HR Admin');

    payroll.status = 'draft';
    payroll.paymentDate = null;
    payroll.auditLog.push({
      status: 'draft',
      changedBy: actorName,
      changedById: req.user?._id,
      changedAt: new Date(),
      netSalary: payroll.netSalary,
      notes: req.body.remarks || 'Payroll reopened to draft'
    });
    await payroll.save();

    // Revert linked reimbursements back to Approved so they can be re-included
    if (Array.isArray(payroll.reimbursements) && payroll.reimbursements.length > 0) {
      const reimbIds = payroll.reimbursements.map(r => r._id).filter(Boolean);
      if (reimbIds.length > 0) {
        await Reimbursement.updateMany(
          { _id: { $in: reimbIds }, companyId, status: 'Reimbursed' },
          { $set: { status: 'Approved', payoutDate: null, payoutTransactionId: null } }
        );
      }
    }

    // Clean up payslip from profile
    const monthName = MONTH_NAMES[payroll.month - 1] || 'Current';
    const periodLabel = `${monthName} ${payroll.year}`;
    const profile = await EmployeeProfile.findOne({ companyId, user: payroll.user });
    if (profile && Array.isArray(profile.compensation?.payrollHistory)) {
      profile.compensation.payrollHistory = profile.compensation.payrollHistory.filter(
        h => String(h.period || '').trim().toLowerCase() !== periodLabel.toLowerCase()
      );
      profile.markModified('compensation.payrollHistory');
      await profile.save();
    }

    return res.json({
      success: true,
      message: 'Payroll reopened to draft successfully.',
      payroll
    });
  } catch (error) {
    console.error('[PayrollController] reopenPayroll error:', error);
    return res.status(500).json({ message: `Error reopening payroll: ${error.message}` });
  }
};

/**
 * DELETE /api/payroll/records/:id
 */
exports.deletePayroll = async (req, res) => {
  try {
    const companyId = getCompanyId(req);
    const id = req.params.id;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ message: 'Invalid payroll ID.' });
    }

    const payroll = await Payroll.findOne({ _id: id, companyId, isDeleted: { $ne: true } });
    if (!payroll) return res.status(404).json({ message: 'Payroll record not found.' });

    if (payroll.status === 'paid') {
      return res.status(400).json({ message: 'Cannot delete paid payroll record. Reopen it first.' });
    }

    payroll.isDeleted = true;
    payroll.deletedAt = new Date();
    payroll.deletedBy = req.user?._id;
    await payroll.save();

    return res.json({ success: true, message: 'Payroll record deleted successfully.' });
  } catch (error) {
    console.error('[PayrollController] deletePayroll error:', error);
    return res.status(500).json({ message: `Error deleting payroll: ${error.message}` });
  }
};

/**
 * POST /api/payroll/bulk-delete
 */
exports.bulkDeletePayroll = async (req, res) => {
  try {
    const companyId = getCompanyId(req);
    const month = Number(req.body.month);
    const year = Number(req.body.year);
    const ids = Array.isArray(req.body.ids) ? req.body.ids.filter(id => mongoose.Types.ObjectId.isValid(String(id))) : [];

    const filter = {
      companyId,
      status: { $ne: 'paid' },
      isDeleted: { $ne: true }
    };

    if (ids.length > 0) filter._id = { $in: ids };
    if (month && !Number.isNaN(month)) filter.month = month;
    if (year && !Number.isNaN(year)) filter.year = year;

    const result = await Payroll.updateMany(filter, {
      $set: {
        isDeleted: true,
        deletedAt: new Date(),
        deletedBy: req.user?._id
      }
    });

    return res.json({
      success: true,
      matched: result.matchedCount,
      deleted: result.modifiedCount,
      message: `Deleted ${result.modifiedCount} payroll records.`
    });
  } catch (error) {
    console.error('[PayrollController] bulkDeletePayroll error:', error);
    return res.status(500).json({ message: `Error bulk deleting payroll: ${error.message}` });
  }
};

/**
 * POST /api/payroll/full-and-final
 * Full & Final Settlement processing for exiting employees.
 */
exports.processFullAndFinalSettlement = async (req, res) => {
  try {
    const companyId = getCompanyId(req);
    if (!companyId) return res.status(400).json({ message: 'Company ID not found in user request context.' });

    const {
      userId,
      lastWorkingDay,
      tenureYears,
      leaveEncashmentDays,
      leaveEncashmentAmount,
      gratuityPayout,
      noticeShortfallDeduction,
      loanRecoveryDeduction,
      comments,
      earnings = {},
      deductions = {},
      netSalary
    } = req.body;

    if (!userId || !lastWorkingDay) {
      return res.status(400).json({ message: 'User ID and Last Working Day are required for FnF.' });
    }

    const lwd = new Date(lastWorkingDay);
    const month = lwd.getMonth() + 1;
    const year = lwd.getFullYear();

    const user = await User.findOne({ _id: userId, companyId }).lean();
    if (!user) return res.status(404).json({ message: 'Employee not found.' });

    const fnfDetails = {
      lastWorkingDay: lwd,
      tenureYears: Number(tenureYears) || 0,
      leaveEncashmentDays: Number(leaveEncashmentDays) || 0,
      leaveEncashmentAmount: Number(leaveEncashmentAmount) || 0,
      gratuityPayout: Number(gratuityPayout) || 0,
      noticeShortfallDeduction: Number(noticeShortfallDeduction) || 0,
      loanRecoveryDeduction: Number(loanRecoveryDeduction) || 0,
      comments: comments || ''
    };

    const totalEarnings = (Number(earnings.basic) || 0) +
      (Number(earnings.hra) || 0) +
      (Number(earnings.specialAllowance) || 0) +
      fnfDetails.leaveEncashmentAmount +
      fnfDetails.gratuityPayout;

    const totalDeductions = (Number(deductions.pfEmployee) || 0) +
      (Number(deductions.tds) || 0) +
      (Number(deductions.professionalTax) || 0) +
      fnfDetails.noticeShortfallDeduction +
      fnfDetails.loanRecoveryDeduction;

    const finalNet = netSalary !== undefined ? Number(netSalary) : Math.max(0, totalEarnings - totalDeductions);

    const existingPaid = await Payroll.findOne({ companyId, user: userId, month, year, status: 'paid', isDeleted: { $ne: true } }).lean();
    if (existingPaid) {
      return res.status(400).json({ message: 'A paid payroll already exists for this period. Please reopen it before creating an FnF settlement.' });
    }

    const payrollDoc = await Payroll.findOneAndUpdate(
      { companyId, user: userId, month, year, isDeleted: { $ne: true } },
      {
        $set: {
          isFullAndFinal: true,
          settlementType: 'full_and_final',
          fnfDetails,
          earnings: {
            ...earnings,
            totalEarnings
          },
          deductions: {
            ...deductions,
            totalDeductions
          },
          netSalary: finalNet,
          status: 'draft',
          employeeSnapshot: {
            employeeId: user.employeeCode || String(user._id),
            employeeCode: user.employeeCode || '',
            firstName: user.firstName || '',
            lastName: user.lastName || '',
            fullName: [user.firstName, user.lastName].filter(Boolean).join(' ').trim() || user.email,
            email: user.email || '',
            department: user.department || '',
            designation: user.designation || '',
            joiningDate: user.joiningDate
          }
        },
        $push: {
          auditLog: {
            status: 'draft',
            changedBy: req.user?.firstName ? `${req.user.firstName} ${req.user.lastName || ''}`.trim() : (req.user?.name || 'HR Admin'),
            changedById: req.user?._id,
            changedAt: new Date(),
            netSalary: finalNet,
            notes: 'Full & Final settlement created'
          }
        }
      },
      { upsert: true, new: true }
    );

    return res.status(201).json({
      success: true,
      message: 'Full and Final Settlement drafted successfully.',
      payroll: payrollDoc
    });
  } catch (error) {
    console.error('[PayrollController] processFullAndFinalSettlement error:', error);
    return res.status(500).json({ message: `Error processing Full & Final: ${error.message}` });
  }
};

/**
 * GET /api/payroll/records/:id/generate-payslip
 * GET /api/payroll/:id/generate-payslip
 * Generates official Flance-styled payslip payload with complete earnings, deductions,
 * employer contributions, and tax worksheet.
 */
exports.generatePayslip = async (req, res) => {
  try {
    const companyId = getCompanyId(req);
    const { id } = req.params;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ message: 'Invalid payroll ID.' });
    }

    const payroll = await Payroll.findOne({ _id: id, companyId, isDeleted: { $ne: true } })
      .populate('user', 'firstName lastName email employeeCode department designation joiningDate dateOfLeaving gender')
      .lean();

    if (!payroll) {
      return res.status(404).json({ message: 'Payroll record not found.' });
    }

    const [profile, company, configDoc] = await Promise.all([
      EmployeeProfile.findOne({ companyId, user: payroll.user })
        .select('+compensation.ctc +compensation.bankDetails.accountNumber +identity.panNumber +identity.aadhaarNumber')
        .lean(),
      Company.findById(companyId).select('name address settings.logo settings.companyName settings.address settings.gstin settings.pan').lean(),
      PayrollConfig.findOne({ companyId }).lean()
    ]);

    const config = configDoc || new PayrollConfig({ companyId });
    const snap = payroll.employeeSnapshot || {};
    const user = payroll.user || {};

    const employeeName = snap.fullName || [user.firstName, user.lastName].filter(Boolean).join(' ') || 'Employee';
    const employeeCode = snap.employeeCode || user.employeeCode || snap.employeeId || 'EMP';
    const designation = snap.designation || user.designation || 'Staff';
    const department = snap.department || user.department || '';
    const joiningDate = snap.joiningDate || user.joiningDate;
    const gender = user.gender || profile?.personal?.gender || 'Male';
    const location = profile?.employment?.workLocation || 'Office';
    const panNumber = profile?.identity?.panNumber || '';
    const uanNumber = profile?.compensation?.uanNumber || profile?.identity?.uanNumber || 'NA';
    const pfNumber = profile?.compensation?.pfNumber || 'NA';
    const esiNumber = profile?.compensation?.esiNumber || 'NA';
    const bankAccount = profile?.compensation?.bankDetails?.accountNumber || '';

    const monthNum = payroll.month;
    const yearNum = payroll.year;
    const monthNameStr = MONTH_NAMES[monthNum - 1] || 'Current';
    const payPeriod = `${monthNameStr} ${yearNum}`.toUpperCase();

    const companyName = company?.settings?.companyName || company?.name || 'Company';
    const rawAddress = company?.settings?.address || company?.address;
    const companyAddress = typeof rawAddress === 'string'
      ? rawAddress
      : [rawAddress?.line1, rawAddress?.city, rawAddress?.state, rawAddress?.zip].filter(Boolean).join(', ');
    const companyLogo = company?.settings?.logo || '';

    // 1. Build Itemized Earnings Lines
    const earnings = payroll.earnings || {};
    const earningsLineItems = [];

    if (payroll.compensationType === 'hourly') {
      const hours = payroll.hoursWorked || 0;
      const rate = payroll.hourlyRate || 0;
      const total = earnings.totalEarnings || (hours * rate);
      earningsLineItems.push({
        id: 'hourly',
        name: 'Hourly Contract Wages',
        rate: total,
        monthly: total,
        arrear: `${hours} hrs × ₹${rate}/hr`,
        amount: total
      });
    } else if (payroll.compensationType === 'daily_wage') {
      const days = payroll.paidDays || 0;
      earningsLineItems.push({
        id: 'daily',
        name: 'Daily Wage Earnings',
        rate: earnings.totalEarnings,
        monthly: earnings.totalEarnings,
        arrear: `${days} days`,
        amount: earnings.totalEarnings
      });
    } else {
      if (earnings.basic > 0) {
        earningsLineItems.push({ id: 'basic', name: 'Basic Salary', rate: earnings.basic, monthly: earnings.basic, arrear: '-', amount: earnings.basic });
      }
      if (earnings.hra > 0) {
        earningsLineItems.push({ id: 'hra', name: 'House Rent Allowance (HRA)', rate: earnings.hra, monthly: earnings.hra, arrear: '-', amount: earnings.hra });
      }
      if (earnings.specialAllowance > 0) {
        earningsLineItems.push({ id: 'special', name: 'Special Allowance', rate: earnings.specialAllowance, monthly: earnings.specialAllowance, arrear: '-', amount: earnings.specialAllowance });
      }
      if (earnings.flexiAmount > 0) {
        earningsLineItems.push({ id: 'flexi', name: 'Flexi Allowance', rate: earnings.flexiAmount, monthly: earnings.flexiAmount, arrear: '-', amount: earnings.flexiAmount });
      }
      if (earnings.broadband > 0) {
        earningsLineItems.push({ id: 'broadband', name: 'Broadband Allowance', rate: earnings.broadband, monthly: earnings.broadband, arrear: '-', amount: earnings.broadband });
      }
      if (earnings.petrol > 0) {
        earningsLineItems.push({ id: 'petrol', name: 'Petrol / Fuel Allowance', rate: earnings.petrol, monthly: earnings.petrol, arrear: '-', amount: earnings.petrol });
      }
      if (earnings.lta > 0) {
        earningsLineItems.push({ id: 'lta', name: 'Leave Travel Allowance (LTA)', rate: earnings.lta, monthly: earnings.lta, arrear: '-', amount: earnings.lta });
      }
      if (earnings.conveyance > 0) {
        earningsLineItems.push({ id: 'conveyance', name: 'Conveyance Allowance', rate: earnings.conveyance, monthly: earnings.conveyance, arrear: '-', amount: earnings.conveyance });
      }
      if (earnings.medicalAllowance > 0) {
        earningsLineItems.push({ id: 'medical', name: 'Medical Allowance', rate: earnings.medicalAllowance, monthly: earnings.medicalAllowance, arrear: '-', amount: earnings.medicalAllowance });
      }
      if (earnings.overtime > 0) {
        earningsLineItems.push({ id: 'overtime', name: 'Overtime Pay', rate: earnings.overtime, monthly: earnings.overtime, arrear: '-', amount: earnings.overtime });
      }
    }

    const variablePay = payroll.variablePay || {};
    if (variablePay.joiningBonus > 0) {
      earningsLineItems.push({ id: 'joiningBonus', name: 'Joining Bonus', rate: variablePay.joiningBonus, monthly: variablePay.joiningBonus, arrear: 'Bonus', amount: variablePay.joiningBonus });
    }
    if (variablePay.incentive > 0) {
      earningsLineItems.push({ id: 'incentive', name: 'Performance Incentive', rate: variablePay.incentive, monthly: variablePay.incentive, arrear: 'Incentive', amount: variablePay.incentive });
    }
    if (variablePay.specialBonus > 0) {
      earningsLineItems.push({ id: 'specialBonus', name: 'Special Bonus', rate: variablePay.specialBonus, monthly: variablePay.specialBonus, arrear: 'Bonus', amount: variablePay.specialBonus });
    }
    if (variablePay.otherAllowanceArrear > 0) {
      earningsLineItems.push({ id: 'arrear', name: 'Salary Arrears', rate: variablePay.otherAllowanceArrear, monthly: variablePay.otherAllowanceArrear, arrear: 'Arrear', amount: variablePay.otherAllowanceArrear });
    }
    if (payroll.totalReimbursementApproved > 0) {
      earningsLineItems.push({
        id: 'reimbursements',
        name: 'Approved Expense Claims',
        rate: payroll.totalReimbursementApproved,
        monthly: payroll.totalReimbursementApproved,
        arrear: 'Claim',
        amount: payroll.totalReimbursementApproved
      });
    }

    // 2. Build Itemized Deductions Lines
    const deductions = payroll.deductions || {};
    const deductionsLineItems = [];

    if (deductions.pfEmployee > 0) {
      deductionsLineItems.push({ id: 'pfEmployee', name: 'PF - Employees (EPF 12%)', amount: deductions.pfEmployee });
    }
    if (deductions.esiEmployee > 0) {
      deductionsLineItems.push({ id: 'esiEmployee', name: 'ESIC Deduction', amount: deductions.esiEmployee });
    }
    if (deductions.professionalTax > 0) {
      deductionsLineItems.push({ id: 'pt', name: 'Prof Tax Deduction (PT)', amount: deductions.professionalTax });
    }
    if (deductions.tds > 0) {
      deductionsLineItems.push({ id: 'tds', name: 'Income Tax (TDS)', amount: deductions.tds });
    }
    if (deductions.lwfEmployee > 0) {
      deductionsLineItems.push({ id: 'lwf', name: 'LWF Deduction', amount: deductions.lwfEmployee });
    }
    if (deductions.loanDeduction > 0) {
      deductionsLineItems.push({ id: 'loan', name: 'Loan / Advance Recovery', amount: deductions.loanDeduction });
    }
    if (deductions.advanceDeduction > 0) {
      deductionsLineItems.push({ id: 'advance', name: 'Advance Deduction', amount: deductions.advanceDeduction });
    }

    // 3. Build Employer Contributions
    const empContrib = payroll.employerContributions || {};
    const employerContributionsLineItems = [];

    if (empContrib.pfEmployer > 0) {
      employerContributionsLineItems.push({
        id: 'pfEmployer',
        name: 'Provident Fund (Employer PF)',
        amount: empContrib.pfEmployer,
        details: 'Employer PF Contribution (EPF + EPS)'
      });
    }
    if (empContrib.esiEmployer > 0) {
      employerContributionsLineItems.push({
        id: 'esiEmployer',
        name: 'ESI (Employer Share)',
        amount: empContrib.esiEmployer,
        details: 'Employee State Insurance (3.25%)'
      });
    }
    if (empContrib.gratuity > 0) {
      employerContributionsLineItems.push({
        id: 'gratuity',
        name: 'Gratuity Provision',
        amount: empContrib.gratuity,
        details: 'Retirement Gratuity (4.81%)'
      });
    }
    if (empContrib.lwfEmployer > 0) {
      employerContributionsLineItems.push({
        id: 'lwfEmployer',
        name: 'Labour Welfare Fund (Employer)',
        amount: empContrib.lwfEmployer,
        details: 'LWF Contribution'
      });
    }
    if (empContrib.insuranceEmployer > 0) {
      employerContributionsLineItems.push({
        id: 'insuranceEmployer',
        name: 'Insurance (Flexi Benefit)',
        amount: empContrib.insuranceEmployer,
        details: 'Group Medical / Flexi Insurance'
      });
    }
    if (empContrib.nps > 0) {
      employerContributionsLineItems.push({
        id: 'nps',
        name: 'Employer NPS',
        amount: empContrib.nps,
        details: 'National Pension Scheme'
      });
    }

    const rawProfileBreakup = (profile?.compensation?.salaryBreakup instanceof Map
      ? Object.fromEntries(profile.compensation.salaryBreakup)
      : profile?.compensation?.salaryBreakup) || {};
    const annualBenefits = extractAnnualBenefits(rawProfileBreakup);

    const totalEmployerContributions = employerContributionsLineItems.reduce((acc, i) => acc + (Number(i.amount) || 0), 0);
    const monthlyCTC = Number(snap.monthlyCTC) || (Number(earnings.totalEarnings) + totalEmployerContributions);

    // 4. Build Income Tax Worksheet (April - March)
    let startYear = yearNum;
    let endYear = yearNum;
    if (monthNum >= 4) {
      startYear = yearNum;
      endYear = yearNum + 1;
    } else {
      startYear = yearNum - 1;
      endYear = yearNum;
    }

    const taxRegime = String(snap.taxRegime || profile?.identity?.taxRegime || 'new').toUpperCase();
    const standardDeduction = taxRegime.includes('OLD') ? 50000 : 75000;
    const annualGross = (earnings.totalEarnings || 0) * 12;
    const annualPF = (deductions.pfEmployee || 0) * 12;
    const annualPT = (deductions.professionalTax || 0) * 12;
    const chapterVIA = taxRegime.includes('OLD') ? Math.min(150000, annualPF) : 0;
    const taxableIncome = Math.max(0, annualGross - standardDeduction - annualPT - chapterVIA);

    const tdsMonths = { 4: 0, 5: 0, 6: 0, 7: 0, 8: 0, 9: 0, 10: 0, 11: 0, 12: 0, 1: 0, 2: 0, 3: 0 };
    if (deductions.tds > 0 && monthNum in tdsMonths) {
      tdsMonths[monthNum] = deductions.tds;
    }

    const taxWorksheet = {
      grossSalary: annualGross,
      standardDeduction,
      annualPT,
      annualPF,
      chapterVIA,
      taxableIncome,
      tdsMonths,
      taxRegime
    };

    return res.json({
      success: true,
      payslip: {
        _id: payroll._id,
        payrollId: payroll._id,
        period: {
          month: monthNum,
          year: yearNum,
          monthName: monthNameStr,
          label: payPeriod
        },
        company: {
          companyName,
          address: companyAddress,
          logoUrl: companyLogo,
          pan: company?.settings?.pan || '',
          gstin: company?.settings?.gstin || ''
        },
        employee: {
          _id: user._id || payroll.user,
          employeeId: employeeCode,
          employeeCode,
          firstName: snap.firstName || user.firstName || '',
          lastName: snap.lastName || user.lastName || '',
          fullName: employeeName,
          designation,
          department: { name: department },
          joiningDate,
          gender,
          location,
          panNumber,
          uanNumber,
          pfNumber,
          esiNumber,
          bankDetails: { accountNumber: bankAccount },
          taxRegime,
          monthlyCTC,
          annualCTC: monthlyCTC * 12
        },
        workingDays: payroll.workingDays || 30,
        paidDays: payroll.paidDays || 30,
        paidLeaves: payroll.paidLeaves || 0,
        unpaidLeaves: payroll.unpaidLeaves || 0,
        lop: payroll.lop || 0,
        hoursWorked: payroll.hoursWorked || 0,
        payType: payroll.payType || 'salaried',
        compensationType: payroll.compensationType || 'monthly_salary',
        earningsLineItems,
        deductionsLineItems,
        employerContributionsLineItems,
        totalEmployerContributions,
        annualBenefits,
        monthlyCTC,
        earnings: payroll.earnings,
        deductions: payroll.deductions,
        variablePay: payroll.variablePay,
        employerContributions: payroll.employerContributions,
        netSalary: payroll.netSalary,
        paymentDate: payroll.paymentDate,
        paymentMethod: payroll.paymentMethod || 'Bank Transfer',
        transactionId: payroll.transactionId || '',
        status: payroll.status,
        isFullAndFinal: payroll.isFullAndFinal || false,
        fnfDetails: payroll.fnfDetails || null,
        taxWorksheet,
        generatedAt: new Date()
      }
    });
  } catch (error) {
    console.error('[PayrollController] generatePayslip error:', error);
    return res.status(500).json({ message: `Error generating payslip: ${error.message}` });
  }
};

/**
 * GET /api/payroll/compensation-types
 */
exports.getCompensationTypes = async (req, res) => {
  return res.json(COMPENSATION_TYPES);
};

/**
 * GET /api/payroll/export
 * Downloads comprehensive Excel payroll register.
 */
exports.exportPayrollExcel = async (req, res) => {
  try {
    const companyId = getCompanyId(req);
    const month = parseInt(req.query.month, 10) || (new Date().getMonth() + 1);
    const year = parseInt(req.query.year, 10) || new Date().getFullYear();

    const payrolls = await Payroll.find({ companyId, month, year, isDeleted: { $ne: true } })
      .populate('user', 'firstName lastName email employeeCode department designation')
      .lean();

    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'TalentCIO HRMS';
    workbook.created = new Date();

    const sheet = workbook.addWorksheet(`Payroll_${MONTH_NAMES[month - 1]}_${year}`);
    sheet.columns = [
      { header: 'Employee Code', key: 'code', width: 15 },
      { header: 'Employee Name', key: 'name', width: 25 },
      { header: 'Department', key: 'dept', width: 20 },
      { header: 'Designation', key: 'desig', width: 20 },
      { header: 'Working Days', key: 'workingDays', width: 14 },
      { header: 'Paid Days', key: 'paidDays', width: 12 },
      { header: 'LOP Days', key: 'lop', width: 12 },
      { header: 'Basic Salary', key: 'basic', width: 15 },
      { header: 'HRA', key: 'hra', width: 15 },
      { header: 'Special Allowance', key: 'special', width: 18 },
      { header: 'Other Allowances', key: 'otherAllow', width: 18 },
      { header: 'Variable / Bonus', key: 'variable', width: 18 },
      { header: 'Reimbursements', key: 'reimbursements', width: 16 },
      { header: 'Gross Earnings', key: 'gross', width: 16 },
      { header: 'Employee PF', key: 'pf', width: 14 },
      { header: 'Employee ESI', key: 'esi', width: 14 },
      { header: 'Professional Tax', key: 'pt', width: 16 },
      { header: 'TDS (Income Tax)', key: 'tds', width: 16 },
      { header: 'Other Deductions', key: 'otherDed', width: 16 },
      { header: 'Total Deductions', key: 'totalDed', width: 16 },
      { header: 'Net Take-Home Pay', key: 'net', width: 18 },
      { header: 'Status', key: 'status', width: 12 },
      { header: 'Payment Method', key: 'paymentMethod', width: 16 },
      { header: 'Payment Date', key: 'paymentDate', width: 14 }
    ];

    sheet.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
    sheet.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1E293B' } };

    payrolls.forEach(p => {
      const snap = p.employeeSnapshot || {};
      const user = p.user || {};
      const fullName = snap.fullName || [user.firstName, user.lastName].filter(Boolean).join(' ') || '';
      const otherAllow = (p.earnings?.flexiAmount || 0) + (p.earnings?.broadband || 0) + (p.earnings?.petrol || 0) + (p.earnings?.lta || 0) + (p.earnings?.conveyance || 0) + (p.earnings?.medicalAllowance || 0);
      const otherDed = (p.deductions?.lwfEmployee || 0) + (p.deductions?.loanDeduction || 0) + (p.deductions?.advanceDeduction || 0);

      sheet.addRow({
        code: snap.employeeCode || user.employeeCode || '',
        name: fullName,
        dept: snap.department || user.department || '',
        desig: snap.designation || user.designation || '',
        workingDays: p.workingDays || 30,
        paidDays: p.paidDays || 30,
        lop: p.lop || 0,
        basic: p.earnings?.basic || 0,
        hra: p.earnings?.hra || 0,
        special: p.earnings?.specialAllowance || 0,
        otherAllow,
        variable: p.variablePay?.totalVariablePay || 0,
        reimbursements: p.totalReimbursementApproved || 0,
        gross: p.earnings?.totalEarnings || 0,
        pf: p.deductions?.pfEmployee || 0,
        esi: p.deductions?.esiEmployee || 0,
        pt: p.deductions?.professionalTax || 0,
        tds: p.deductions?.tds || 0,
        otherDed,
        totalDed: p.deductions?.totalDeductions || 0,
        net: p.netSalary || 0,
        status: (p.status || 'draft').toUpperCase(),
        paymentMethod: p.paymentMethod || 'Bank Transfer',
        paymentDate: p.paymentDate ? format(new Date(p.paymentDate), 'yyyy-MM-dd') : ''
      });
    });

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename=Payroll_Register_${MONTH_NAMES[month - 1]}_${year}.xlsx`);

    await workbook.xlsx.write(res);
    return res.end();
  } catch (error) {
    console.error('[PayrollController] exportPayrollExcel error:', error);
    return res.status(500).json({ message: `Error exporting payroll: ${error.message}` });
  }
};

/**
 * GET /api/payroll/export-inputs
 * Exports pre-payroll inputs (attendance, LOP, overtime) to Excel.
 */
exports.exportPayrollInputsExcel = async (req, res) => {
  try {
    const companyId = getCompanyId(req);
    const month = parseInt(req.query.month, 10) || (new Date().getMonth() + 1);
    const year = parseInt(req.query.year, 10) || new Date().getFullYear();

    const users = await User.find({ companyId, isActive: true })
      .select('employeeCode firstName lastName email department designation')
      .sort({ firstName: 1 })
      .lean();

    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet(`Inputs_${MONTH_NAMES[month - 1]}_${year}`);
    sheet.columns = [
      { header: 'Employee Code', key: 'code', width: 15 },
      { header: 'Full Name', key: 'name', width: 25 },
      { header: 'Department', key: 'dept', width: 20 },
      { header: 'Total Working Days', key: 'workingDays', width: 18 },
      { header: 'Paid Days', key: 'paidDays', width: 14 },
      { header: 'Loss of Pay (LOP) Days', key: 'lop', width: 20 },
      { header: 'Overtime / Hours', key: 'hours', width: 16 },
      { header: 'Joining Bonus', key: 'joiningBonus', width: 15 },
      { header: 'Performance Incentive', key: 'incentive', width: 20 },
      { header: 'Arrears / Other', key: 'arrears', width: 15 },
      { header: 'Remarks / Notes', key: 'notes', width: 30 }
    ];

    sheet.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
    sheet.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF2563EB' } };

    users.forEach(u => {
      sheet.addRow({
        code: u.employeeCode || '',
        name: [u.firstName, u.lastName].filter(Boolean).join(' ') || u.email,
        dept: u.department || '',
        workingDays: 30,
        paidDays: 30,
        lop: 0,
        hours: 0,
        joiningBonus: 0,
        incentive: 0,
        arrears: 0,
        notes: ''
      });
    });

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename=Payroll_Inputs_${MONTH_NAMES[month - 1]}_${year}.xlsx`);

    await workbook.xlsx.write(res);
    return res.end();
  } catch (error) {
    console.error('[PayrollController] exportPayrollInputsExcel error:', error);
    return res.status(500).json({ message: `Error exporting payroll inputs: ${error.message}` });
  }
};

/**
 * GET /api/payroll/my-payslips
 * Allows an authenticated employee to fetch their own approved/paid Payroll records
 */
exports.getMyPayslips = async (req, res) => {
  try {
    const companyId = getCompanyId(req);
    const userId = req.user?._id;
    if (!companyId || !userId) {
      return res.status(400).json({ message: 'Company or user context missing.' });
    }

    const records = await Payroll.find({
      companyId,
      user: userId,
      status: { $in: ['approved', 'paid'] },
      isDeleted: { $ne: true }
    })
      .sort({ year: -1, month: -1, createdAt: -1 })
      .lean();

    return res.json({ data: records });
  } catch (error) {
    console.error('[PayrollController] getMyPayslips error:', error);
    return res.status(500).json({ message: `Error fetching your payslips: ${error.message}` });
  }
};

/**
 * GET /api/payroll/my-payslips/:id/generate-payslip
 * Allows an authenticated employee to generate/view their own itemized payslip
 */
exports.generateMyPayslip = async (req, res) => {
  try {
    const companyId = getCompanyId(req);
    const userId = req.user?._id;
    const { id } = req.params;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ message: 'Invalid payroll ID.' });
    }

    const payroll = await Payroll.findOne({ _id: id, companyId, user: userId, isDeleted: { $ne: true } }).select('_id status').lean();
    if (!payroll) {
      return res.status(404).json({ message: 'Payslip not found for your account.' });
    }

    return exports.generatePayslip(req, res);
  } catch (error) {
    console.error('[PayrollController] generateMyPayslip error:', error);
    return res.status(500).json({ message: `Error generating payslip: ${error.message}` });
  }
};



