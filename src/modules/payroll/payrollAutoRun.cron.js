const cron = require('node-cron');
const Company = require('../company/company.model');
const User = require('../user/user.model');
const EmployeeProfile = require('../dossier/employeeProfile.model');
const PayrollConfig = require('./payrollConfig.model');
const Payroll = require('./payroll.model');
const Reimbursement = require('../reimbursement/reimbursement.model');
const { computeCompanyAttendanceSummary } = require('./payrollAttendance.service');
const { buildPayrollSnapshot } = require('./payrollMath');
const { toLocalTimezoneRep } = require('../timesheet/timesheetPeriod');

const shouldApplyJoiningBonus = (joiningDate, month, year) => {
  if (!joiningDate) return false;
  const d = toLocalTimezoneRep(joiningDate);
  if (Number.isNaN(d.getTime())) return false;
  return (d.getMonth() + 1) === Number(month) && d.getFullYear() === Number(year);
};

/**
 * Automatically generates/calculates monthly draft payrolls for all active companies
 * with the payroll module enabled for the previous completed month.
 */
const runMonthlyAutoPayroll = async (targetMonth, targetYear) => {
  const nowLocal = toLocalTimezoneRep(new Date());
  const prevDate = new Date(nowLocal.getFullYear(), nowLocal.getMonth() - 1, 1);
  const month = targetMonth || (prevDate.getMonth() + 1);
  const year = targetYear || prevDate.getFullYear();

  const companies = await Company.find({
    status: { $in: ['Active', 'Trial'] },
    isDeleted: { $ne: true }
  }).select('_id name settings.attendance enabledModules').lean();

  for (const company of companies) {
    try {
      const enabledModules = company.enabledModules || {};
      if (enabledModules.payroll === false) continue;

      const companyId = company._id;
      const [configDoc, users, existingPayrolls] = await Promise.all([
        PayrollConfig.findOne({ companyId }).lean(),
        User.find({
          companyId,
          isActive: true,
          isDeleted: { $ne: true }
        }).select('_id firstName lastName email employeeCode department designation joiningDate dateOfLeaving employmentType salary compensation').lean(),
        Payroll.find({ companyId, month, year, isDeleted: { $ne: true } }).select('user').lean()
      ]);

      if (!users.length) continue;

      const existingUserSet = new Set(existingPayrolls.map(p => String(p.user)));
      const pendingUsers = users.filter(u => !existingUserSet.has(String(u._id)));
      if (!pendingUsers.length) continue;

      const config = configDoc || new PayrollConfig({ companyId });
      const pendingUserIds = pendingUsers.map(u => u._id);

      const [{ totalDaysInMonth, summaries }, profiles, approvedReimbursements] = await Promise.all([
        computeCompanyAttendanceSummary({
          companyId,
          company,
          month,
          year,
          userIds: pendingUserIds,
          includeDailyDetails: false
        }),
        EmployeeProfile.find({ companyId, user: { $in: pendingUserIds } })
          .select('+compensation.ctc +compensation.salaryBreakup +compensation.bankDetails.accountNumber +identity.panNumber +identity.aadhaarNumber')
          .lean(),
        Reimbursement.find({ companyId, employee: { $in: pendingUserIds }, status: 'Approved' }).lean()
      ]);

      const summaryMap = new Map(summaries.map(s => [String(s.userId), s]));
      const profileMap = new Map(profiles.map(p => [String(p.user), p]));
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

      for (const u of pendingUsers) {
        const uidStr = String(u._id);
        const summary = summaryMap.get(uidStr);
        if (!summary) continue;

        const profile = profileMap.get(uidStr);
        const userSal = u.salary || u.compensation || {};
        const comp = profile?.compensation || {};
        const rawBreakup = (comp.salaryBreakup instanceof Map ? Object.fromEntries(comp.salaryBreakup) : comp.salaryBreakup) || userSal.salaryBreakup || userSal || {};
        let monthlyCTC = Number(comp.ctc) || Number(userSal.monthlyCTC) || Number(rawBreakup.monthlyCTC) || 0;
        let annualCTC = Number(comp.annualCTC) || Number(userSal.annualCTC) || Number(rawBreakup.annualCTC) || (monthlyCTC ? monthlyCTC * 12 : 0);
        if (!monthlyCTC && annualCTC > 0) monthlyCTC = Math.round(annualCTC / 12);
        if (monthlyCTC <= 0 && !(Number(comp.hourlyRate) || Number(userSal.hourlyRate))) continue;

        const workingDays = totalDaysInMonth;
        const paidDays = Math.min(workingDays, Math.max(0, Number(summary.paidDays) || 0));
        const lop = Math.max(0, workingDays - paidDays);
        const hoursWorked = Number(summary.totalWorkingHours) || 0;
        const empReimbs = reimbursementMap.get(uidStr) || [];
        const totalReimbs = empReimbs.reduce((acc, r) => acc + (Number(r.approved) || 0), 0);
        const joiningBonus = shouldApplyJoiningBonus(u.joiningDate, month, year)
          ? (Number(comp.joiningBonus || userSal.joiningBonus || rawBreakup.joiningBonus) || 0)
          : 0;

        const source = {
          ...rawBreakup,
          _id: u._id,
          monthlyCTC,
          annualCTC,
          payType: comp.payType || userSal.payType || 'salaried',
          hourlyRate: Number(comp.hourlyRate) || Number(userSal.hourlyRate) || 0,
          compensationType: comp.payType === 'hourly' || userSal.payType === 'hourly' ? 'hourly' : (comp.compensationType || userSal.compensationType || rawBreakup.compensationType || 'monthly_salary'),
          ptState: comp.salaryBreakup?.ptState || rawBreakup.ptState || 'custom',
          taxRegime: profile?.identity?.taxRegime || 'new',
          pfEnabled: comp.salaryBreakup?.pfEnabled ?? rawBreakup.pfEnabled ?? true,
          esiEnabled: comp.salaryBreakup?.esiEnabled ?? rawBreakup.esiEnabled ?? true,
          ptEnabled: comp.salaryBreakup?.ptEnabled ?? rawBreakup.ptEnabled ?? true,
          lwfEnabled: comp.salaryBreakup?.lwfEnabled ?? rawBreakup.lwfEnabled ?? true,
          gratuityEnabled: comp.salaryBreakup?.gratuityEnabled ?? rawBreakup.gratuityEnabled ?? true,
          basicPercent: comp.salaryBreakup?.basicPercent || rawBreakup.basicPercent || config.basicPercent || 0.5,
          hraPercent: comp.salaryBreakup?.hraPercent || rawBreakup.hraPercent || config.hraPercent || 0.5,
          salaryStructure: rawBreakup
        };

        const snapshot = buildPayrollSnapshot(
          source,
          config,
          { workingDays, paidDays, lop, hoursWorked },
          { joiningBonus, reimbursements: totalReimbs },
          month,
          year
        );

        await Payroll.create({
          companyId,
          user: u._id,
          employeeCode: u.employeeCode || '',
          month,
          year,
          workingDays,
          paidDays,
          paidLeaves: summary.paidLeaves || 0,
          unpaidLeaves: summary.unpaidLeaves || 0,
          lop,
          hoursWorked,
          attendanceSource: 'hrms',
          payType: source.payType,
          hourlyRate: source.hourlyRate,
          compensationType: source.compensationType,
          earnings: {
            basic: snapshot.basic || 0,
            hra: snapshot.hra || 0,
            flexiAmount: snapshot.flexi || 0,
            broadband: snapshot.broadband || 0,
            petrol: snapshot.petrol || 0,
            lta: snapshot.lta || 0,
            specialAllowance: snapshot.specialAllowance || 0,
            conveyance: snapshot.conveyance || 0,
            medicalAllowance: snapshot.medicalAllowance || 0,
            totalEarnings: snapshot.totalEarnings || 0
          },
          employerContributions: {
            pfEmployer: snapshot.pfEmployer || 0,
            esiEmployer: snapshot.esiEmployer || 0,
            gratuity: snapshot.gratuity || 0,
            lwfEmployer: snapshot.lwfEmployer || 0,
            grossTotalSalary: snapshot.grossTotalSalary || 0
          },
          variablePay: {
            joiningBonus,
            totalVariablePay: joiningBonus
          },
          deductions: {
            pfEmployee: snapshot.pfEmployee || 0,
            esiEmployee: snapshot.esiEmployee || 0,
            professionalTax: snapshot.professionalTax || 0,
            tds: snapshot.tds || 0,
            lwfEmployee: snapshot.lwfEmployee || 0,
            totalDeductions: snapshot.totalDeductions || 0
          },
          totalPayable: (snapshot.totalEarnings || 0) + joiningBonus,
          reimbursements: empReimbs,
          totalReimbursementApproved: totalReimbs,
          netSalary: snapshot.netSalary || 0,
          status: 'draft',
          notes: 'Auto-calculated monthly payroll draft',
          employeeSnapshot: {
            employeeId: u.employeeCode || String(u._id),
            employeeCode: u.employeeCode || '',
            firstName: u.firstName || '',
            lastName: u.lastName || '',
            fullName: [u.firstName, u.lastName].filter(Boolean).join(' ').trim() || u.email,
            email: u.email || '',
            department: u.department || '',
            designation: u.designation || '',
            joiningDate: u.joiningDate
          },
          auditLog: [{
            status: 'draft',
            changedBy: 'System Scheduler',
            changedAt: new Date(),
            netSalary: snapshot.netSalary || 0,
            notes: 'Monthly auto-calculated draft payroll'
          }]
        });
      }
    } catch (companyErr) {
      console.error(`[PayrollAutoRun] Failed for company ${company._id}:`, companyErr.message);
    }
  }
};

const startPayrollAutoRunCron = () => {
  const timezone = process.env.CRON_TIMEZONE || 'Asia/Kolkata';
  // Run on the 1st of every month at 00:30 IST for the previous completed month
  cron.schedule('30 0 1 * *', async () => {
    try {
      console.log('[PayrollAutoRun] Running monthly automated payroll draft calculation...');
      await runMonthlyAutoPayroll();
      console.log('[PayrollAutoRun] Completed monthly automated payroll draft calculation.');
    } catch (err) {
      console.error('[PayrollAutoRun] Cron error:', err.message);
    }
  }, { timezone });
};

module.exports = {
  startPayrollAutoRunCron,
  runMonthlyAutoPayroll,
  shouldApplyJoiningBonus
};
