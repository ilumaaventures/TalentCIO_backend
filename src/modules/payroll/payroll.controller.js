const PayrollConfig = require('./payrollConfig.model');
const Company = require('../company/company.model');
const User = require('../user/user.model');
const EmployeeProfile = require('../dossier/employeeProfile.model');
const { buildMasterSalaryStructure, buildPayrollSnapshot } = require('./payrollMath');
const { normalizePayrollIntegrationSettings } = require('./payrollIntegration.service');

const getCompanyId = (req) => req.companyId || req.user?.companyId || req.user?.company;

exports.getConfig = async (req, res) => {
  try {
    const companyId = getCompanyId(req);
    if (!companyId) return res.status(400).json({ message: 'Company ID not found in user request context.' });
    
    let config = await PayrollConfig.findOne({ companyId }).lean();
    if (!config) {
      const created = new PayrollConfig({ companyId });
      await created.save();
      config = created.toObject();
    }
    const company = await Company.findById(companyId).select('name address settings.logo settings.workspaceBranding').lean();
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


