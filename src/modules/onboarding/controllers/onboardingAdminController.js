const OnboardingEmployee = require('../onboardingEmployee.model');
const Candidate = require('../../talent-acquisition/candidate.model');
const Company = require('../../company/company.model');
const PayrollConfig = require('../../payroll/payrollConfig.model');
const { processCalculatedSalary } = require('../../payroll/payrollMath');
const {
    generateTempPassword,
    formatDate,
    formatCurrency,
    syncTADecision,
    normalizeOnboardingExperienceCertificateLabels
} = require('../utils/onboardingHelpers');

exports.addEmployee = async (req, res) => {
    try {
        const { firstName, lastName, email, phone, designation, department, joiningDate, offerDate, documentDeadline, offerLetterUrl, offerLetterPublicId, address, workLocation, probationPeriod, salary } = req.body;

        if (!firstName || !email) {
            return res.status(400).json({ message: 'First name and email are required' });
        }

        const existing = await OnboardingEmployee.findOne({ email, companyId: req.companyId });
        if (existing) {
            return res.status(400).json({ message: 'An onboarding entry with this email already exists' });
        }

        const tempEmployeeId = await OnboardingEmployee.generateTempId(req.companyId);
        const rawPassword = generateTempPassword();

        const defaultDocuments = [
            { type: 'resume', label: 'Updated Resume' },
            { type: 'aadhaar_front', label: 'Aadhaar Card (Front)' },
            { type: 'aadhaar_back', label: 'Aadhaar Card (Back)' },
            { type: 'pan', label: 'PAN Card' },
            { type: 'salary_slip', label: 'Salary Slip' },
            { type: 'passport', label: 'Passport (Optional)' },
            { type: '10th_marksheet', label: '10th Marksheet / Certificate' },
            { type: '12th_marksheet', label: '12th Marksheet / Certificate' },
            { type: 'graduation', label: 'Graduation Marksheet / Certificate' },
            { type: 'relieving_letter', label: 'Previous Employer Relieving Letter' },
            { type: 'experience_certificate', label: 'Previous Experience Certificate' },
            { type: 'passport_photo', label: 'Recent Passport-Size Photograph' },
            { type: 'live_photo', label: 'Live Photograph', requireLivePhoto: true },
            { type: 'character_certificate', label: 'Character Certificate' }
        ];

        let calculatedSalary = salary || {};
        if (calculatedSalary && (calculatedSalary.annualCTC || calculatedSalary.hourlyRate)) {
            try {
                const config = await PayrollConfig.findOne({ companyId: req.companyId }) || new PayrollConfig({ companyId: req.companyId });
                if (config) {
                    const payType = calculatedSalary.payType || 'salaried';
                    let annualCTC = 0;
                    let monthlyCTC = 0;

                    if (payType === 'hourly') {
                        const hourlyRate = parseFloat(calculatedSalary.hourlyRate) || 0;
                        const hoursWorked = parseFloat(calculatedSalary.hoursWorked) || 160;
                        monthlyCTC = hourlyRate * hoursWorked;
                        annualCTC = monthlyCTC * 12;

                        calculatedSalary.annualCTC = String(annualCTC);
                        calculatedSalary.monthlyCTC = String(Math.round(monthlyCTC));
                        calculatedSalary.basic = String(Math.round(monthlyCTC));
                        calculatedSalary.hra = '0';
                        calculatedSalary.specialAllowance = '0';
                        calculatedSalary.monthlyGross = String(Math.round(monthlyCTC));
                    } else if (payType === 'flat') {
                        monthlyCTC = parseFloat(calculatedSalary.flatSalary || calculatedSalary.monthlyCTC) || 0;
                        annualCTC = monthlyCTC * 12;

                        calculatedSalary.annualCTC = String(annualCTC);
                        calculatedSalary.monthlyCTC = String(Math.round(monthlyCTC));
                        calculatedSalary.basic = String(Math.round(monthlyCTC));
                        calculatedSalary.hra = '0';
                        calculatedSalary.specialAllowance = '0';
                        calculatedSalary.monthlyGross = String(Math.round(monthlyCTC));
                    } else {
                        annualCTC = parseFloat(String(calculatedSalary.annualCTC).replace(/[^0-9.]/g, '')) || 0;
                        monthlyCTC = annualCTC / 12;

                        processCalculatedSalary(calculatedSalary, config, annualCTC, monthlyCTC);
                    }
                }
            } catch (err) {
                console.error('Error calculating candidate salary on backend add:', err);
            }
        }

        const employee = new OnboardingEmployee({
            tempEmployeeId,
            tempPassword: rawPassword,
            pendingCredentialPassword: rawPassword,
            firstName,
            lastName: lastName || '',
            email,
            phone: phone || '',
            designation: designation || '',
            department: department || '',
            joiningDate: joiningDate || undefined,
            offerDate: offerDate || undefined,
            documentDeadline: documentDeadline || undefined,
            workLocation: workLocation || '',
            address: address || '',
            probationPeriod: probationPeriod || '',
            salary: calculatedSalary,
            credentialsExpireAt: documentDeadline || undefined,
            offerLetterUrl: offerLetterUrl || '',
            offerLetterPublicId: offerLetterPublicId || '',
            documents: defaultDocuments,
            companyId: req.companyId,
            createdBy: req.user._id,
            requestedSections: [],
            requestedDocuments: [],
            auditLog: [{ action: 'CREATED', details: `Created by ${req.user.firstName || 'Admin'}. ID: ${tempEmployeeId}, Password: ${rawPassword}` }]
        });

        await employee.save();

        res.status(201).json({
            message: 'Onboarding employee added successfully.',
            employee: {
                _id: employee._id,
                tempEmployeeId: employee.tempEmployeeId,
                firstName: employee.firstName,
                lastName: employee.lastName,
                email: employee.email,
                status: employee.status,
                joiningDate: employee.joiningDate,
                documentDeadline: employee.documentDeadline
            }
        });

    } catch (error) {
        console.error('Error adding onboarding employee:', error);
        if (error.code === 11000) {
            return res.status(400).json({ message: 'Duplicate entry detected. This employee may already exist.', error: error.message });
        }
        res.status(500).json({ message: 'Server error', error: error.message });
    }
};

exports.bulkAddEmployees = async (req, res) => {
    try {
        const { employees } = req.body;
        if (!Array.isArray(employees) || employees.length === 0) {
            return res.status(400).json({ message: 'An array of employees is required' });
        }

        const results = [];
        for (const empData of employees) {
            try {
                const { firstName, lastName, email, phone, designation, department, joiningDate } = empData;
                if (!firstName || !email) {
                    results.push({ email: email || 'N/A', status: 'Failed', reason: 'First name and email required' });
                    continue;
                }

                const existing = await OnboardingEmployee.findOne({ email, companyId: req.companyId });
                if (existing) {
                    results.push({ email, status: 'Skipped', reason: 'Email already exists' });
                    continue;
                }

                const tempEmployeeId = await OnboardingEmployee.generateTempId(req.companyId);
                const rawPassword = generateTempPassword();

                const defaultDocuments = [
                    { type: 'resume', label: 'Updated Resume' },
                    { type: 'aadhaar_front', label: 'Aadhaar Card (Front)' },
                    { type: 'aadhaar_back', label: 'Aadhaar Card (Back)' },
                    { type: 'pan', label: 'PAN Card' },
                    { type: 'salary_slip', label: 'Salary Slip' },
                    { type: 'passport', label: 'Passport (Optional)' },
                    { type: '10th_marksheet', label: '10th Marksheet / Certificate' },
                    { type: '12th_marksheet', label: '12th Marksheet / Certificate' },
                    { type: 'graduation', label: 'Graduation Marksheet / Certificate' },
                    { type: 'relieving_letter', label: 'Previous Employer Relieving Letter' },
                    { type: 'experience_certificate', label: 'Previous Experience Certificate' },
                    { type: 'passport_photo', label: 'Recent Passport-Size Photograph' },
                    { type: 'live_photo', label: 'Live Photograph', requireLivePhoto: true },
                    { type: 'character_certificate', label: 'Character Certificate' }
                ];

                const employee = new OnboardingEmployee({
                    tempEmployeeId,
                    tempPassword: rawPassword,
                    pendingCredentialPassword: rawPassword,
                    firstName,
                    lastName: lastName || '',
                    email,
                    phone: phone || '',
                    designation: designation || '',
                    department: department || '',
                    joiningDate: joiningDate || undefined,
                    documents: defaultDocuments,
                    companyId: req.companyId,
                    createdBy: req.user._id,
                    auditLog: [{ action: 'CREATED', details: `Bulk created by ${req.user.firstName || 'Admin'}` }]
                });

                await employee.save();
                results.push({ email, status: 'Success', tempEmployeeId });
            } catch (err) {
                results.push({ email: empData.email || 'N/A', status: 'Failed', reason: err.message });
            }
        }

        res.status(200).json({ message: 'Bulk addition completed', results });
    } catch (error) {
        console.error('Error in bulk add employees:', error);
        res.status(500).json({ message: 'Server error', error: error.message });
    }
};

const formatEmployeeDynamicTemplates = (employeeObj, companyDynamicTemplates = []) => {
    return (companyDynamicTemplates || [])
        .filter((template) => template && template.isDeleted !== true)
        .map((template) => {
            const templateIdStr = template._id ? template._id.toString() : '';

            return {
                ...template,
                candidateName: `${employeeObj.firstName || ''} ${employeeObj.lastName || ''}`.trim() || employeeObj.firstName || 'Candidate',
                name: template.name
            };
        });
};

exports.formatEmployeeDynamicTemplates = formatEmployeeDynamicTemplates;

exports.getOnboardingList = async (req, res) => {
    try {
        const { status, search } = req.query;
        let query = { companyId: req.companyId };

        if (status) {
            query.status = status;
        }

        if (search) {
            query.$or = [
                { firstName: { $regex: search, $options: 'i' } },
                { lastName: { $regex: search, $options: 'i' } },
                { email: { $regex: search, $options: 'i' } },
                { tempEmployeeId: { $regex: search, $options: 'i' } }
            ];
        }

        let employees = await OnboardingEmployee.find(query)
            .sort({ createdAt: -1 })
            .lean();

        const company = await Company.findById(req.companyId).select('settings.onboarding').lean();
        const companyDynamicTemplates = company?.settings?.onboarding?.dynamicTemplates || [];
        const companyPolicies = company?.settings?.onboarding?.policies || [];

        employees = employees.map(emp => {
            emp.companyDynamicTemplates = formatEmployeeDynamicTemplates(emp, companyDynamicTemplates);
            emp.companyPolicies = companyPolicies;
            return emp;
        });

        res.json(employees);
    } catch (error) {
        console.error('Error fetching onboarding list:', error);
        res.status(500).json({ message: 'Server error', error: error.message });
    }
};

exports.getOnboardingEmployee = async (req, res) => {
    try {
        let employee = await OnboardingEmployee.findOne({
            _id: req.params.id,
            companyId: req.companyId
        });

        if (!employee) {
            return res.status(404).json({ message: 'Onboarding employee not found' });
        }

        employee = await normalizeOnboardingExperienceCertificateLabels(employee);

        const employeeObj = employee.toObject();
        delete employeeObj.pendingCredentialPassword;

        const company = await Company.findById(req.companyId).select('settings.onboarding').lean();
        const companyDynamicTemplates = company?.settings?.onboarding?.dynamicTemplates || [];
        const companyPolicies = company?.settings?.onboarding?.policies || [];

        employeeObj.companyDynamicTemplates = formatEmployeeDynamicTemplates(employeeObj, companyDynamicTemplates);
        employeeObj.companyPolicies = companyPolicies;

        res.json(employeeObj);
    } catch (error) {
        console.error('Error fetching onboarding employee:', error);
        res.status(500).json({ message: 'Server error', error: error.message });
    }
};

exports.updateEmployee = async (req, res) => {
    try {
        const employee = await OnboardingEmployee.findOne({
            _id: req.params.id,
            companyId: req.companyId
        });

        if (!employee) {
            return res.status(404).json({ message: 'Employee not found' });
        }

        const allowedFields = ['firstName', 'lastName', 'phone', 'designation', 'department', 'joiningDate', 'offerDate', 'documentDeadline', 'workLocation', 'address', 'probationPeriod', 'salary', 'status', 'selectionDraft'];

        allowedFields.forEach(field => {
            if (req.body[field] !== undefined) {
                if (field === 'salary' && req.body.salary) {
                    let calculatedSalary = { ...req.body.salary };
                    try {
                        const PayrollConfig = require('../../payroll/payrollConfig.model');
                        PayrollConfig.findOne({ companyId: req.companyId }).then(config => {
                            if (config) {
                                const payType = calculatedSalary.payType || 'salaried';
                                let annualCTC = 0;
                                let monthlyCTC = 0;

                                if (payType === 'hourly') {
                                    const hourlyRate = parseFloat(calculatedSalary.hourlyRate) || 0;
                                    const hoursWorked = parseFloat(calculatedSalary.hoursWorked) || 160;
                                    monthlyCTC = hourlyRate * hoursWorked;
                                    annualCTC = monthlyCTC * 12;

                                    calculatedSalary.annualCTC = String(annualCTC);
                                    calculatedSalary.monthlyCTC = String(Math.round(monthlyCTC));
                                    calculatedSalary.basic = String(Math.round(monthlyCTC));
                                    calculatedSalary.hra = '0';
                                    calculatedSalary.specialAllowance = '0';
                                    calculatedSalary.monthlyGross = String(Math.round(monthlyCTC));
                                } else if (payType === 'flat') {
                                    monthlyCTC = parseFloat(calculatedSalary.flatSalary || calculatedSalary.monthlyCTC) || 0;
                                    annualCTC = monthlyCTC * 12;

                                    calculatedSalary.annualCTC = String(annualCTC);
                                    calculatedSalary.monthlyCTC = String(Math.round(monthlyCTC));
                                    calculatedSalary.basic = String(Math.round(monthlyCTC));
                                    calculatedSalary.hra = '0';
                                    calculatedSalary.specialAllowance = '0';
                                    calculatedSalary.monthlyGross = String(Math.round(monthlyCTC));
                                } else {
                                    annualCTC = parseFloat(String(calculatedSalary.annualCTC).replace(/[^0-9.]/g, '')) || 0;
                                    monthlyCTC = annualCTC / 12;

                                    processCalculatedSalary(calculatedSalary, config, annualCTC, monthlyCTC);
                                }
                            }
                        }).catch(e => console.error('Error auto-calc salary:', e));
                    } catch (e) {
                        console.error('Error requiring PayrollConfig:', e);
                    }
                    employee.salary = calculatedSalary;
                } else {
                    employee[field] = req.body[field];
                }
            }
        });

        if (req.body.documentDeadline) {
            employee.credentialsExpireAt = new Date(req.body.documentDeadline);
        }

        employee.auditLog.push({
            action: 'UPDATED',
            details: `Updated details by ${req.user.firstName || 'Admin'}`
        });

        await employee.save();
        res.json({ message: 'Employee updated successfully', employee });
    } catch (error) {
        console.error('Error updating onboarding employee:', error);
        res.status(500).json({ message: 'Server error', error: error.message });
    }
};

exports.regenerateCredentials = async (req, res) => {
    try {
        const employee = await OnboardingEmployee.findOne({
            _id: req.params.id,
            companyId: req.companyId
        });

        if (!employee) {
            return res.status(404).json({ message: 'Employee not found' });
        }

        const newPassword = generateTempPassword();
        employee.tempPassword = newPassword;
        employee.pendingCredentialPassword = newPassword;
        employee.tokenVersion = (employee.tokenVersion || 0) + 1;
        employee.credentialsExpireAt = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000);

        employee.auditLog.push({
            action: 'CREDENTIALS_REGENERATED',
            details: `Regenerated by ${req.user.firstName || 'Admin'}. New Temp Password: ${newPassword}`
        });

        await employee.save();

        res.json({
            message: 'Credentials regenerated successfully',
            tempEmployeeId: employee.tempEmployeeId,
            tempPassword: newPassword,
            credentialsExpireAt: employee.credentialsExpireAt
        });
    } catch (error) {
        console.error('Error regenerating credentials:', error);
        res.status(500).json({ message: 'Server error', error: error.message });
    }
};

exports.requestExtension = async (req, res) => {
    try {
        const { reason } = req.body;
        const employee = req.onboardingEmployee;

        if (!reason || !reason.trim()) {
            return res.status(400).json({ message: 'Reason for extension is required' });
        }

        employee.extensionRequests.push({
            requestedAt: new Date(),
            reason: reason.trim(),
            status: 'Pending'
        });

        employee.auditLog.push({
            action: 'EXTENSION_REQUESTED',
            details: `Candidate requested deadline extension. Reason: ${reason.trim()}`
        });

        await employee.save();
        res.json({ message: 'Extension request submitted successfully' });
    } catch (error) {
        console.error('Error requesting extension:', error);
        res.status(500).json({ message: 'Server error', error: error.message });
    }
};

exports.resolveExtensionRequest = async (req, res) => {
    try {
        const { action, newDeadline } = req.body;
        const { id, extId } = req.params;

        if (!['Approve', 'Reject'].includes(action)) {
            return res.status(400).json({ message: 'Action must be Approve or Reject' });
        }

        const employee = await OnboardingEmployee.findOne({
            _id: id,
            companyId: req.companyId
        });

        if (!employee) {
            return res.status(404).json({ message: 'Employee not found' });
        }

        const extReq = employee.extensionRequests.id(extId);
        if (!extReq) {
            return res.status(404).json({ message: 'Extension request not found' });
        }

        extReq.status = action === 'Approve' ? 'Approved' : 'Rejected';

        if (action === 'Approve') {
            if (!newDeadline) {
                return res.status(400).json({ message: 'New deadline is required when approving' });
            }
            employee.documentDeadline = new Date(newDeadline);
            employee.credentialsExpireAt = new Date(newDeadline);
        }

        employee.auditLog.push({
            action: `EXTENSION_${action.toUpperCase()}D`,
            details: `Extension request ${action.toLowerCase()}d by ${req.user.firstName || 'Admin'}${action === 'Approve' ? `. New deadline: ${newDeadline}` : ''}`
        });

        await employee.save();
        res.json({ message: `Extension request ${action.toLowerCase()}d successfully`, employee });
    } catch (error) {
        console.error('Error resolving extension request:', error);
        res.status(500).json({ message: 'Server error', error: error.message });
    }
};

exports.requestCredentialRegeneration = async (req, res) => {
    try {
        const { email } = req.body;
        if (!email) {
            return res.status(400).json({ message: 'Email address is required' });
        }

        const employee = await OnboardingEmployee.findOne({ email: email.trim().toLowerCase() });
        if (!employee) {
            return res.json({ message: 'If an onboarding record matches that email, HR will be notified of your request.' });
        }

        employee.extensionRequests.push({
            requestedAt: new Date(),
            reason: 'Candidate requested credential regeneration from login page.',
            status: 'Pending'
        });

        employee.auditLog.push({
            action: 'CREDENTIAL_REGEN_REQUESTED',
            details: `Candidate requested credential regeneration from login screen.`
        });

        await employee.save();
        res.json({ message: 'If an onboarding record matches that email, HR will be notified of your request.' });
    } catch (error) {
        console.error('Error requesting credential regeneration:', error);
        res.status(500).json({ message: 'Server error', error: error.message });
    }
};
