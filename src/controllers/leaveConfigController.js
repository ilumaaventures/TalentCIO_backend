const LeaveConfig = require('../models/LeaveConfig');
const LeaveBalance = require('../models/LeaveBalance'); // Added for balance recalculation

// @desc    Get all leave policies
// @route   GET /api/leaves/config
// @access  Public (Authenticated)
const getLeavePolicies = async (req, res) => {
    try {
        res.set('Cache-Control', 'private, max-age=60, stale-while-revalidate=60');
        console.log(`[LeaveConfig] GET policies for company: ${req.companyId}`);
        const policies = await LeaveConfig.find({ isActive: true, companyId: req.companyId });
        res.json(policies);
    } catch (error) {
        console.error('[LeaveConfig GET Error]', error);
        res.status(500).json({ message: 'Server Error', details: error.message });
    }
};

// @desc    Create or Update a leave policy
// @route   POST /api/leaves/config
// @access  Private (Admin)
const updateLeavePolicy = async (req, res) => {
    const {
        leaveType, name, description, employeeTypes, isPaid,
        accrualType, accrualAmount, carryForward, maxCarryForward,
        maxLimitPerYear, genderSpecific, applicableGender,
        sandwichRule, allowNegativeBalance, proofRequiredAbove, allowBackdated, proRata
    } = req.body;

    try {
        console.log(`[LeaveConfig] POST update for company: ${req.companyId}, policy: ${leaveType}`);
        
        if (!req.companyId) {
            return res.status(400).json({ message: 'Tenant context (companyId) is missing' });
        }

        let policy = await LeaveConfig.findOne({ leaveType, companyId: req.companyId });

        if (policy) {
            // Update existing
            policy.name = name || policy.name;
            policy.description = description || policy.description;
            policy.employeeTypes = employeeTypes || policy.employeeTypes;
            policy.isPaid = isPaid !== undefined ? isPaid : policy.isPaid;
            policy.accrualType = accrualType || policy.accrualType;
            policy.accrualAmount = accrualAmount !== undefined ? accrualAmount : policy.accrualAmount;
            policy.carryForward = carryForward !== undefined ? carryForward : policy.carryForward;
            policy.maxCarryForward = maxCarryForward !== undefined ? maxCarryForward : policy.maxCarryForward;
            policy.maxLimitPerYear = maxLimitPerYear !== undefined ? maxLimitPerYear : policy.maxLimitPerYear;
            policy.genderSpecific = genderSpecific !== undefined ? genderSpecific : policy.genderSpecific;
            policy.applicableGender = applicableGender || policy.applicableGender;

            // Rules
            policy.sandwichRule = sandwichRule !== undefined ? sandwichRule : policy.sandwichRule;
            policy.allowNegativeBalance = allowNegativeBalance !== undefined ? allowNegativeBalance : policy.allowNegativeBalance;
            policy.proofRequiredAbove = proofRequiredAbove !== undefined ? proofRequiredAbove : policy.proofRequiredAbove;
            policy.allowBackdated = allowBackdated !== undefined ? allowBackdated : policy.allowBackdated;
            policy.proRata = proRata !== undefined ? proRata : policy.proRata;

            await policy.save();

            // RECALCULATE PROPAGATION LOGIC: Auto-update existing LeaveBalance records 
            // for the current year to reflect the newly edited rules.
            try {
                const currentYear = new Date().getFullYear();
                let newAccruedValue = 0;

                if (policy.accrualType === 'Yearly') {
                    newAccruedValue = policy.accrualAmount;
                } else if (policy.accrualType === 'Monthly') {
                    const currentMonth = new Date().getMonth() + 1; // 1-12
                    newAccruedValue = policy.accrualAmount * currentMonth;
                    if (policy.maxLimitPerYear > 0 && newAccruedValue > policy.maxLimitPerYear) {
                        newAccruedValue = policy.maxLimitPerYear;
                    }
                } else if (policy.accrualType === 'Policy') {
                    newAccruedValue = policy.accrualAmount || 0;
                }

                // Update all current year balances for this policy across all users
                await LeaveBalance.updateMany(
                    { leaveType: policy.leaveType, year: currentYear, companyId: req.companyId },
                    { $set: { accrued: newAccruedValue } }
                );
            } catch (calcError) {
                console.error('[LeaveConfig Update] Failed to propagate balance changes:', calcError);
            }

            return res.json(policy);
        } else {
            // Create New
            policy = await LeaveConfig.create({
                companyId: req.companyId,
                leaveType, name, description, employeeTypes, isPaid,
                accrualType, accrualAmount, carryForward, maxCarryForward,
                maxLimitPerYear, genderSpecific, applicableGender,
                sandwichRule, allowNegativeBalance, proofRequiredAbove, allowBackdated, proRata
            });
            return res.status(201).json(policy);
        }
    } catch (error) {
        console.error('[LeaveConfig POST Error]', error);
        res.status(500).json({ message: 'Server Error', details: error.message });
    }
};

// @desc    Seed Default Policies
// @route   POST /api/leaves/config/seed
// @access  Private (Admin)
const seedDefaultPolicies = async (req, res) => {
    try {
        console.log(`[LeaveConfig] SEED for company: ${req.companyId}`);
        const defaults = [
            { leaveType: 'CL', name: 'Casual Leave', isPaid: true, accrualType: 'Monthly', accrualAmount: 1, maxLimitPerYear: 12, carryForward: false },
            { leaveType: 'SL', name: 'Sick Leave', isPaid: true, accrualType: 'Yearly', accrualAmount: 8, maxLimitPerYear: 8, carryForward: false },
            { leaveType: 'EL', name: 'Earned Leave', isPaid: true, accrualType: 'Monthly', accrualAmount: 1.25, maxLimitPerYear: 15, carryForward: true, maxCarryForward: 30 }, // Approx 15/year logic varies
            { leaveType: 'LOP', name: 'Loss of Pay', isPaid: false, accrualType: 'None', maxLimitPerYear: 0, carryForward: false },
            { leaveType: 'WFH', name: 'Work From Home', isPaid: true, accrualType: 'Policy', maxLimitPerYear: 0, carryForward: false }
        ];

        for (const def of defaults) {
            const exists = await LeaveConfig.findOne({ leaveType: def.leaveType, companyId: req.companyId });
            if (!exists) {
                await LeaveConfig.create({ ...def, companyId: req.companyId });
            }
        }

        res.json({ message: 'Default policies seeded' });
    } catch (error) {
        console.error('[LeaveConfig SEED Error]', error);
        res.status(500).json({ message: 'Server Error', details: error.message });
    }
};

const { runMonthlyAccrual, runYearlyProcessing } = require('../services/accrualService');

// @desc    Trigger Monthly Accrual
// @route   POST /api/leaves/accrual/monthly
// @access  Admin
const triggerMonthlyAccrual = async (req, res) => {
    try {
        const result = await runMonthlyAccrual(req.companyId);
        res.json(result);
    } catch (error) {
        console.error(error);
        res.status(500).json({ message: 'Failed to run monthly accrual' });
    }
};

// @desc    Trigger Yearly Processing
// @route   POST /api/leaves/accrual/yearly
// @access  Admin
const triggerYearlyAccrual = async (req, res) => {
    try {
        const { year } = req.body;
        const result = await runYearlyProcessing(req.companyId, year);
        res.json(result);
    } catch (error) {
        console.error(error);
        res.status(500).json({ message: 'Failed to run yearly processing' });
    }
};

// @desc    Delete a leave policy
// @route   DELETE /api/leaves/config/:id
// @access  Private (Admin)
const deleteLeavePolicy = async (req, res) => {
    try {
        const policy = await LeaveConfig.findOne({ _id: req.params.id, companyId: req.companyId });

        if (!policy) {
            return res.status(404).json({ message: 'Policy not found' });
        }

        await policy.deleteOne();
        res.json({ message: 'Policy removed' });
    } catch (error) {
        console.error(error);
        res.status(500).json({ message: 'Server Error' });
    }
};

module.exports = {
    getLeavePolicies,
    updateLeavePolicy,
    deleteLeavePolicy,
    seedDefaultPolicies,
    triggerMonthlyAccrual,
    triggerYearlyAccrual
};
