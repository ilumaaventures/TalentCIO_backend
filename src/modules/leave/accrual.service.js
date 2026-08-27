const User = require('../../modules/user/user.model');
const LeaveConfig = require('./model/leaveConfig.model');
const LeaveBalance = require('./model/leaveBalance.model');
const EmployeeProfile = require('../dossier/employeeProfile.model');

/**
 * Calculate expiry date and month/year for a given credit month and validity (e.g. 2 months)
 */
const calculateBucketExpiry = (creditMonth, creditYear, validityMonths = 2) => {
    const totalMonths = (creditYear * 12) + (creditMonth - 1) + validityMonths;
    const expiryYear = Math.floor(totalMonths / 12);
    const expiryMonth = (totalMonths % 12) + 1;
    const expiryDate = new Date(expiryYear, expiryMonth - 1, 1, 0, 0, 0);
    return { expiryMonth, expiryYear, expiryDate };
};

/**
 * Expire any buckets whose validity period has elapsed relative to currentMonth and currentYear.
 * Returns the total amount of leaves that expired in this cycle.
 */
const expireOutdatedBuckets = (balance, currentMonth, currentYear) => {
    if (!balance.buckets || !Array.isArray(balance.buckets)) {
        balance.buckets = [];
        return 0;
    }

    let newlyExpiredAmount = 0;

    for (const bucket of balance.buckets) {
        if (bucket.isExpired) continue;

        // Check if expired: credit year < currentYear OR (creditYear === currentYear && currentMonth >= expiryMonth)
        const isPastExpiry = (currentYear > bucket.expiryYear) ||
            (currentYear === bucket.expiryYear && currentMonth >= bucket.expiryMonth);

        if (isPastExpiry) {
            bucket.isExpired = true;
            if (bucket.remainingAmount > 0) {
                newlyExpiredAmount += bucket.remainingAmount;
                bucket.remainingAmount = 0;
            }
        }
    }

    balance.expired = (balance.expired || 0) + newlyExpiredAmount;
    return newlyExpiredAmount;
};

/**
 * Add / Credit a monthly bucket lot to the employee's LeaveBalance document
 */
const creditLeaveBucket = (balance, creditAmount, currentMonth, currentYear, validityMonths = 2, maxCap = 0) => {
    if (!balance.buckets) balance.buckets = [];

    // Check if bucket for this month and year already exists
    const existingBucketIndex = balance.buckets.findIndex(b => b.creditMonth === currentMonth && b.creditYear === currentYear);
    const { expiryMonth, expiryYear, expiryDate } = calculateBucketExpiry(currentMonth, currentYear, validityMonths);

    if (existingBucketIndex >= 0) {
        const b = balance.buckets[existingBucketIndex];
        b.creditAmount = creditAmount;
        b.remainingAmount = Math.max(0, creditAmount - (b.utilizedAmount || 0));
        b.validityMonths = validityMonths;
        b.expiryMonth = expiryMonth;
        b.expiryYear = expiryYear;
        b.expiryDate = expiryDate;
        b.isExpired = false;
    } else {
        balance.buckets.push({
            bucketId: `${currentYear}-${String(currentMonth).padStart(2, '0')}`,
            creditedDate: new Date(currentYear, currentMonth - 1, 1),
            creditMonth: currentMonth,
            creditYear: currentYear,
            creditAmount,
            utilizedAmount: 0,
            remainingAmount: creditAmount,
            validityMonths,
            expiryMonth,
            expiryYear,
            expiryDate,
            isExpired: false,
            notes: `Monthly accrual for ${currentMonth}/${currentYear}`
        });
    }

    // Sort buckets chronologically
    balance.buckets.sort((a, b) => (a.creditYear * 12 + a.creditMonth) - (b.creditYear * 12 + b.creditMonth));

    // If max accumulation cap is set, ensure active remaining sum does not exceed maxCap
    if (maxCap > 0) {
        let activeRemaining = balance.buckets.filter(b => !b.isExpired).reduce((sum, b) => sum + (b.remainingAmount || 0), 0);
        if (activeRemaining > maxCap) {
            let excess = activeRemaining - maxCap;
            for (const bucket of balance.buckets) {
                if (bucket.isExpired || excess <= 0) continue;
                if (bucket.remainingAmount <= excess) {
                    excess -= bucket.remainingAmount;
                    bucket.remainingAmount = 0;
                    bucket.isExpired = true;
                } else {
                    bucket.remainingAmount -= excess;
                    excess = 0;
                }
            }
        }
    }

    // Sync balance totals
    const activeBuckets = balance.buckets.filter(b => !b.isExpired);
    balance.closingBalance = activeBuckets.reduce((sum, b) => sum + (b.remainingAmount || 0), 0);
    balance.accrued = balance.buckets.reduce((sum, b) => sum + (b.creditAmount || 0), 0);
    balance.utilized = balance.buckets.reduce((sum, b) => sum + (b.utilizedAmount || 0), 0);

    return balance;
};

/**
 * Deduct leaves using First In First Out (FIFO) from the earliest active buckets
 */
const deductBucketsFIFO = (balance, daysCount) => {
    if (!balance.buckets || balance.buckets.length === 0) {
        balance.utilized = (balance.utilized || 0) + daysCount;
        balance.closingBalance = Math.max(0, (balance.openingBalance || 0) + (balance.accrued || 0) - balance.utilized);
        return balance;
    }

    let needed = daysCount;
    const activeBuckets = balance.buckets
        .filter(b => !b.isExpired && b.remainingAmount > 0)
        .sort((a, b) => (a.creditYear * 12 + a.creditMonth) - (b.creditYear * 12 + b.creditMonth));

    for (const bucket of activeBuckets) {
        if (needed <= 0) break;
        const availableInBucket = bucket.remainingAmount;
        if (availableInBucket <= needed) {
            bucket.utilizedAmount = (bucket.utilizedAmount || 0) + availableInBucket;
            bucket.remainingAmount = 0;
            needed -= availableInBucket;
        } else {
            bucket.utilizedAmount = (bucket.utilizedAmount || 0) + needed;
            bucket.remainingAmount -= needed;
            needed = 0;
        }
    }

    balance.utilized = balance.buckets.reduce((sum, b) => sum + (b.utilizedAmount || 0), 0);
    balance.closingBalance = balance.buckets.filter(b => !b.isExpired).reduce((sum, b) => sum + (b.remainingAmount || 0), 0);

    return balance;
};

/**
 * Run Monthly Accrual for a specific month/year.
 * Usually runs on 1st of Month.
 */
const runMonthlyAccrual = async (companyId) => {
    if (!companyId) throw new Error('companyId is required for Monthly Accrual');

    const today = new Date();
    const currentYear = today.getFullYear();
    const currentMonth = today.getMonth() + 1; // 1-12

    console.log(`Running Monthly Accrual for Company ${companyId} - Period ${currentMonth}/${currentYear}`);

    const users = await User.find({ isActive: true, companyId });
    const configs = await LeaveConfig.find({ isActive: true, accrualType: 'Monthly', companyId });

    let updates = 0;

    for (const user of users) {
        const userEmploymentType = user.employmentType || 'Full Time';
        const profile = await EmployeeProfile.findOne({ user: user._id, companyId });
        const leaveOverrides = (profile?.leaveOverrides instanceof Map ? Object.fromEntries(profile.leaveOverrides) : (profile?.leaveOverrides || {})) || {};

        for (const config of configs) {
            const override = leaveOverrides[config.leaveType];
            if (override && (override.enabled === false || override.isExcluded === true)) {
                continue;
            }

            // Filter: skip if this policy is restricted to employment types that don't include this user
            if (config.employeeTypes && config.employeeTypes.length > 0 &&
                !config.employeeTypes.includes(userEmploymentType)) {
                continue;
            }

            let balance = await LeaveBalance.findOne({ user: user._id, leaveType: config.leaveType, year: currentYear, companyId });

            if (!balance) {
                const opening = override?.allocatedBalance !== undefined ? override.allocatedBalance : 0;
                balance = await LeaveBalance.create({ user: user._id, leaveType: config.leaveType, year: currentYear, openingBalance: opening, companyId });
            }

            const effectiveAccrualAmount = override?.accrualAmount !== undefined ? override.accrualAmount : config.accrualAmount;
            const maxAccumulationCap = (override?.expiryBalance > 0 ? override.expiryBalance : (override?.maxCarryForward > 0 ? override.maxCarryForward : config.maxLimitPerYear)) || 0;
            const validityMonths = parseInt(override?.expiryMonths !== undefined ? override.expiryMonths : (config.expiryMonths || 2), 10) || 2;

            // 1. Expire outdated monthly buckets whose 2-month (or custom) validity has ended
            expireOutdatedBuckets(balance, currentMonth, currentYear);

            // 2. Credit the new monthly bucket lot (e.g. +1.5)
            creditLeaveBucket(balance, effectiveAccrualAmount, currentMonth, currentYear, validityMonths, maxAccumulationCap);

            await balance.save();
            updates++;
        }
    }

    return { message: `Monthly Accrual Completed for Company ${companyId}. Updated/Created ${updates} records.` };
};

/**
 * Run Yearly Processing (Carry Forward + New Year Initialization)
 * Runs on Jan 1st of newYear.
 */
const runYearlyProcessing = async (companyId, newYear) => {
    if (!companyId) throw new Error('companyId is required for Yearly Processing');
    if (!newYear) newYear = new Date().getFullYear();
    const prevYear = newYear - 1;

    console.log(`Running Yearly Processing for Company ${companyId} - Year ${newYear} (From ${prevYear})`);

    const users = await User.find({ isActive: true, companyId });
    const configs = await LeaveConfig.find({ isActive: true, companyId });

    let processed = 0;

    for (const user of users) {
        for (const config of configs) {
            // Get Previous Year Balance
            const prevBalance = await LeaveBalance.findOne({ user: user._id, leaveType: config.leaveType, year: prevYear, companyId });

            // Calculate Closing of Prev Year
            let prevClosing = 0;
            if (prevBalance) {
                prevClosing = prevBalance.openingBalance + prevBalance.accrued - prevBalance.utilized - prevBalance.encashed;
            }

            // Calculate Opening for New Year (Carry Forward)
            let newOpening = 0;
            if (config.carryForward) {
                newOpening = prevClosing;
                if (config.maxCarryForward > 0 && newOpening > config.maxCarryForward) {
                    newOpening = config.maxCarryForward;
                }
            }

            // Check if already exists to avoid duplicate logic
            let newBalance = await LeaveBalance.findOne({ user: user._id, leaveType: config.leaveType, year: newYear, companyId });

            if (!newBalance) {
                newBalance = new LeaveBalance({
                    user: user._id,
                    leaveType: config.leaveType,
                    year: newYear,
                    openingBalance: newOpening,
                    accrued: 0,
                    utilized: 0,
                    encashed: 0,
                    companyId
                });
            } else {
                // Update existing opening? Safe to update if re-running
                newBalance.openingBalance = newOpening;
            }

            // Yearly Credit (SL fixed 8/year)
            if (config.accrualType === 'Yearly') {
                newBalance.accrued = config.accrualAmount;
            }

            await newBalance.save();
            processed++;
        }
    }

    return { message: `Yearly Processing Completed for Company ${companyId}. Processed ${processed} records.` };
};

module.exports = {
    calculateBucketExpiry,
    expireOutdatedBuckets,
    creditLeaveBucket,
    deductBucketsFIFO,
    runMonthlyAccrual,
    runYearlyProcessing
};
