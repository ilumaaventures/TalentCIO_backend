const {
    listActiveEmployeesForPayroll
} = require('./payrollIntegration.service');
const { encryptPayload } = require('./payrollCrypto');
const { resolveMonthRange, computeCompanyAttendanceSummary } = require('./payrollAttendance.service');

const buildEncryptedResponseIfNeeded = (payload, payrollIntegration) => {
    if (!payrollIntegration?.encryptPayloads) return payload;
    if (!payrollIntegration.encryptionSecret) {
        throw new Error('Payload encryption is enabled but no encryptionSecret is configured.');
    }
    return encryptPayload(payload, payrollIntegration.encryptionSecret);
};

const countLeaveDaysInRange = ({
    startDate,
    endDate,
    isHalfDay = false,
    sandwichRule = false,
    weeklyOffs = ['Saturday', 'Sunday'],
    holidayDateSet = new Set()
}) => {
    if (!startDate || !endDate) return 0;

    const localStart = toLocalTimezoneRep(startDate);
    const localEnd = toLocalTimezoneRep(endDate);

    if (isHalfDay) {
        const isOffDay = weeklyOffs.includes(format(localStart, 'EEEE')) || holidayDateSet.has(localStart.toDateString());
        return isOffDay && !sandwichRule ? 0 : 0.5;
    }

    let count = 0;
    for (let d = new Date(localStart); d <= localEnd; d.setDate(d.getDate() + 1)) {
        const isOffDay = weeklyOffs.includes(format(d, 'EEEE')) || holidayDateSet.has(d.toDateString());
        if (!isOffDay || sandwichRule) count++;
    }
    return count;
};

const getEmployees = async (req, res) => {
    try {
        const employees = await listActiveEmployeesForPayroll(req.companyId);
        const responsePayload = buildEncryptedResponseIfNeeded(employees, req.payrollIntegration);
        res.json(responsePayload);
    } catch (error) {
        console.error('[PayrollIntegration] employees sync error:', error);
        res.status(500).json({ message: 'Failed to fetch employee directory for payroll sync.' });
    }
};

const getAttendanceSummary = async (req, res) => {
    try {
        const { month, year } = req.query;
        const monthRange = resolveMonthRange(month, year);

        if (!monthRange) {
            return res.status(400).json({ message: 'Valid month and year query parameters are required.' });
        }

        const isSelectedMode = req.payrollIntegration?.syncMode === 'selected'
            && Array.isArray(req.payrollIntegration.allowedEmployeeIds)
            && req.payrollIntegration.allowedEmployeeIds.length > 0;

        const { summaries } = await computeCompanyAttendanceSummary({
            companyId: req.companyId,
            company: req.company,
            month: monthRange.parsedMonth,
            year: monthRange.parsedYear,
            allowedEmployeeIds: isSelectedMode ? req.payrollIntegration.allowedEmployeeIds : null,
            includeDailyDetails: true
        });

        const responsePayload = buildEncryptedResponseIfNeeded(summaries, req.payrollIntegration);
        res.json(responsePayload);
    } catch (error) {
        console.error('[PayrollIntegration] attendance sync error:', error);
        res.status(500).json({ message: 'Failed to fetch monthly attendance summary for payroll sync.' });
    }
};

const PayrollConfig = require('./payrollConfig.model');

const getPayrollConfig = async (req, res) => {
    try {
        const config = await PayrollConfig.findOne({ companyId: req.companyId }).lean();
        const responsePayload = buildEncryptedResponseIfNeeded(config || {}, req.payrollIntegration);
        res.json(responsePayload);
    } catch (error) {
        console.error('[PayrollIntegration] config sync error:', error);
        res.status(500).json({ message: 'Failed to fetch payroll configuration for sync.' });
    }
};

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const PayrollResult = require('./payrollResult.model');
const EmployeeProfile = require('../dossier/employeeProfile.model');
const { uploadBufferToCloudinary } = require('../../config/cloudinary');

const MONTH_NAMES = [
    'January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December'
];

async function storePayslipFile(item, companyId) {
    if (!item.payslipPdfBase64) {
        return item.payslipUrl || '';
    }

    try {
        const buffer = Buffer.from(item.payslipPdfBase64, 'base64');
        const monthStr = MONTH_NAMES[item.month - 1] || `M${item.month}`;
        const fileName = `payslip_${item.employeeCode}_${monthStr}_${item.year}.pdf`;

        // Try Cloudinary first if configured
        if (process.env.CLOUDINARY_CLOUD_NAME && process.env.CLOUDINARY_API_KEY) {
            try {
                const cloudUrl = await uploadBufferToCloudinary(buffer, fileName, 'payslips');
                if (cloudUrl) return cloudUrl;
            } catch (cErr) {
                console.warn('[storePayslipFile] Cloudinary upload failed, using local file:', cErr.message);
            }
        }

        // Local storage fallback in /uploads/payslips/
        const uploadDir = path.join(__dirname, '../../../uploads/payslips');
        if (!fs.existsSync(uploadDir)) {
            fs.mkdirSync(uploadDir, { recursive: true });
        }
        const filePath = path.join(uploadDir, fileName);
        fs.writeFileSync(filePath, buffer);
        return `/uploads/payslips/${fileName}`;
    } catch (err) {
        console.error('[storePayslipFile] Error storing payslip:', err.message);
        return item.payslipUrl || '';
    }
}

async function saveSinglePayrollResult(companyId, payrollResult) {
    if (!payrollResult || !payrollResult.employeeCode || !Number.isInteger(payrollResult.month) || !Number.isInteger(payrollResult.year)) {
        return null;
    }

    const payslipUrl = await storePayslipFile(payrollResult, companyId);
    const monthStr = MONTH_NAMES[payrollResult.month - 1] || `Month ${payrollResult.month}`;
    const period = `${monthStr} ${payrollResult.year}`;

    // 1. Upsert into PayrollResult
    const updatedResult = await PayrollResult.findOneAndUpdate(
        {
            companyId,
            employeeCode: payrollResult.employeeCode,
            month: payrollResult.month,
            year: payrollResult.year,
        },
        {
            $set: {
                status: payrollResult.status || 'paid',
                payslipUrl: payslipUrl || '',
                netSalary: payrollResult.netSalary || 0,
                grossSalary: payrollResult.grossSalary || 0,
                totalDeductions: payrollResult.totalDeductions || 0,
                paidDate: payrollResult.paidDate ? new Date(payrollResult.paidDate) : new Date(),
                breakdown: payrollResult.breakdown || {},
                receivedAt: new Date(),
            },
        },
        { upsert: true, new: true }
    );

    // 2. Sync into EmployeeProfile (for ESS MyPayslips and Dossier documents)
    try {
        const query = {
            companyId,
            $or: [
                { employeeCode: String(payrollResult.employeeCode).trim() },
                ...(payrollResult.email ? [{ email: String(payrollResult.email).trim().toLowerCase() }] : [])
            ]
        };
        const user = await User.findOne(query).select('_id companyId');
        if (user) {
            const profile = await EmployeeProfile.findOne({ user: user._id });
            if (profile) {
                // Upsert payrollHistory
                if (!profile.compensation) profile.compensation = {};
                if (!Array.isArray(profile.compensation.payrollHistory)) profile.compensation.payrollHistory = [];

                const historyIdx = profile.compensation.payrollHistory.findIndex(h => h.period === period);
                const historyEntry = {
                    period,
                    netSalary: payrollResult.netSalary || 0,
                    grossSalary: payrollResult.grossSalary || 0,
                    totalDeductions: payrollResult.totalDeductions || 0,
                    status: payrollResult.status === 'draft' ? 'Draft' : 'Paid',
                    payslipUrl: payslipUrl || '',
                    workingDays: payrollResult.workingDays !== undefined ? payrollResult.workingDays : 31,
                    paidDays: payrollResult.paidDays !== undefined ? payrollResult.paidDays : 31,
                    companyName: payrollResult.companyName || '',
                    companyAddress: payrollResult.companyAddress || '',
                    companyLogo: payrollResult.companyLogo || '',
                    taxRegime: payrollResult.taxRegime || '',
                    earningsLineItems: Array.isArray(payrollResult.earningsLineItems) ? payrollResult.earningsLineItems : [],
                    deductionsLineItems: Array.isArray(payrollResult.deductionsLineItems) ? payrollResult.deductionsLineItems : [],
                    breakdown: payrollResult.breakdown || {},
                    taxWorksheet: payrollResult.taxWorksheet || null,
                    processedDate: payrollResult.paidDate ? new Date(payrollResult.paidDate) : new Date(),
                };

                if (historyIdx !== -1) {
                    profile.compensation.payrollHistory[historyIdx] = {
                        ...(profile.compensation.payrollHistory[historyIdx]?.toObject?.() || profile.compensation.payrollHistory[historyIdx]),
                        ...historyEntry,
                    };
                } else {
                    profile.compensation.payrollHistory.push(historyEntry);
                }

                // Upsert documents (category: 'Payslips')
                if (payslipUrl) {
                    if (!Array.isArray(profile.documents)) profile.documents = [];
                    const docIdx = profile.documents.findIndex(d => d.category === 'Payslips' && d.title === `Payslip - ${period}`);
                    const docEntry = {
                        category: 'Payslips',
                        title: `Payslip - ${period}`,
                        fileName: `Payslip_${payrollResult.employeeCode}_${period.replace(/\s+/g, '_')}.pdf`,
                        url: payslipUrl,
                        uploadDate: new Date(),
                        verificationStatus: 'Verified'
                    };
                    if (docIdx !== -1) {
                        profile.documents[docIdx] = {
                            ...(profile.documents[docIdx]?.toObject?.() || profile.documents[docIdx]),
                            ...docEntry,
                        };
                    } else {
                        profile.documents.push(docEntry);
                    }
                }

                await profile.save();
            }
        }
    } catch (profileErr) {
        console.error('[PayrollIntegration] Error syncing payslip to employee profile:', profileErr.message);
    }

    return updatedResult;
}

const receivePayrollResult = async (req, res) => {
    try {
        // Verify HMAC signature from MyBills
        const signature = req.headers['x-mybills-signature'];
        if (!signature) {
            return res.status(401).json({ message: 'x-mybills-signature header is required.' });
        }

        const rawBody = req.rawBody
            ? (Buffer.isBuffer(req.rawBody) ? req.rawBody.toString('utf8') : String(req.rawBody))
            : (typeof req.body === 'string' ? req.body : JSON.stringify(req.body));
        const jsonBody = typeof req.body === 'string' ? req.body : JSON.stringify(req.body);
        const tsHeader = req.headers['x-hrms-timestamp'];

        const secretsToTry = Array.from(new Set([
            req.payrollIntegration?.webhookSecret,
            req.payrollIntegration?.accessToken
        ].filter(Boolean)));

        if (secretsToTry.length === 0) {
            return res.status(401).json({ message: 'Payroll integration webhook secret is not configured.' });
        }

        const provided = Buffer.from(String(signature).trim(), 'hex');
        let isValid = false;

        for (const secret of secretsToTry) {
            const inputsToTry = [
                tsHeader ? `${tsHeader}.${rawBody}` : null,
                rawBody,
                tsHeader ? `${tsHeader}.${jsonBody}` : null,
                jsonBody
            ].filter(Boolean);

            for (const input of inputsToTry) {
                const computedHex = crypto.createHmac('sha256', secret).update(input).digest('hex');
                const computed = Buffer.from(computedHex, 'hex');
                if (provided.length === computed.length && crypto.timingSafeEqual(provided, computed)) {
                    isValid = true;
                    break;
                }
            }
            if (isValid) break;
        }

        if (!isValid) {
            return res.status(401).json({ message: 'Signature mismatch: HMAC verification failed.' });
        }

        const results = Array.isArray(req.body.payrollResults)
            ? req.body.payrollResults
            : (req.body.payrollResult ? [req.body.payrollResult] : []);

        if (results.length === 0) {
            return res.status(400).json({
                message: 'Invalid payload: payrollResult object or payrollResults array is required.'
            });
        }

        const saved = [];
        for (const item of results) {
            const resDoc = await saveSinglePayrollResult(req.companyId, item);
            if (resDoc) saved.push(resDoc);
        }

        res.json({ message: `Successfully processed ${saved.length} payroll result(s).`, count: saved.length });
    } catch (error) {
        console.error('[PayrollIntegration] receivePayrollResult error:', error);
        res.status(500).json({ message: 'Failed to process payroll result.' });
    }
};

module.exports = {
    getEmployees,
    getAttendanceSummary,
    getPayrollConfig,
    receivePayrollResult,
};