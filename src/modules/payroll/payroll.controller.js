const PayrollConfig = require('./payrollConfig.model');
const { buildMasterSalaryStructure, buildPayrollSnapshot } = require('./payrollMath');

const getCompanyId = (req) => req.companyId || req.user?.companyId || req.user?.company;

exports.getConfig = async (req, res) => {
  try {
    const companyId = getCompanyId(req);
    if (!companyId) return res.status(400).json({ message: 'Company ID not found in user request context.' });
    
    let config = await PayrollConfig.findOne({ companyId });
    if (!config) {
      config = new PayrollConfig({ companyId });
      await config.save();
    }
    return res.json(config);
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
