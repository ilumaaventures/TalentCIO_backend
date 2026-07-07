const mongoose = require('mongoose');
const { format } = require('date-fns');
const OffboardingRecord = require('../models/OffboardingRecord');
const User = require('../models/User');
const EmployeeProfile = require('../models/EmployeeProfile');
const Company = require('../models/Company');
const EmailTemplate = require('../models/EmailTemplate');
const HREmailLog = require('../models/HREmailLog');
const { extractPublicIdFromUrl } = require('../utils/cloudinaryHelper');
const { cloudinary } = require('../config/cloudinary');
const { sendEmailForCompany } = require('../services/companyEmailService');
const { sendEmail } = require('../services/emailService');
const {
    GENERAL_EMAIL_TEMPLATE_PLACEHOLDERS,
    renderTemplateBody,
    resolveTemplate,
    validateTemplateSyntax
} = require('../utils/templateResolver');

const EXIT_DOCUMENT_TYPES = new Set([
    'Relieving Letter',
    'Experience Letter',
    'Full & Final Settlement',
    'NOC',
    'Payslip Bundle',
    'Other'
]);
const EDITABLE_OFFBOARDING_STATUSES = new Set(['Initiated', 'In Progress', 'Clearance Pending']);

const DEFAULT_OFFBOARDING_EMAIL_SUBJECT = 'Your Exit Documents from {{companyName}}';
const DEFAULT_OFFBOARDING_EMAIL_BODY = `
    <div style="font-family:Arial,sans-serif;font-size:14px;line-height:1.7;color:#1f2937;">
        <p>Dear {{firstName}},</p>
        <p>Please find attached your exit documents as requested.</p>
        <div style="margin:16px 0;">
            <div style="font-weight:600;margin-bottom:8px;">Documents included:</div>
            {{documentListBlock}}
        </div>
        {{personalNote}}
        <p>For any queries, please contact your HR team.</p>
        <p>Best wishes,<br />{{companyName}} HR Team</p>
    </div>
`;

const escapeHtml = (value) => String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

const formatDateValue = (value) => {
    if (!value) return 'N/A';

    try {
        return format(new Date(value), 'dd MMMM yyyy');
    } catch (error) {
        return 'N/A';
    }
};

const formatCurrencyValue = (value) => {
    const numericValue = Number(value || 0);
    return `INR ${numericValue.toLocaleString('en-IN', {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2
    })}`;
};

const buildEmployeeName = (employee = {}) => (
    `${employee.firstName || ''} ${employee.lastName || ''}`.trim() || 'Employee'
);

const formatShortDateValue = (value) => {
    if (!value) return '';

    try {
        return format(new Date(value), 'dd MMM yyyy');
    } catch (error) {
        return '';
    }
};

const buildCompanyAddressLine = (company = {}) => {
    const parts = [company.country].filter(Boolean);
    return parts.length > 0 ? escapeHtml(parts.join(', ')) : '';
};

const buildLetterhead = (company = {}) => `
    <div style="border-bottom:2px solid #1f2937;padding-bottom:16px;margin-bottom:24px;">
        <div style="font-size:24px;font-weight:700;color:#111827;">${escapeHtml(company.name || 'TalentCIO')}</div>
        ${buildCompanyAddressLine(company)
        ? `<div style="font-size:13px;color:#6b7280;margin-top:6px;">${buildCompanyAddressLine(company)}</div>`
        : ''
    }
    </div>
`;

const getEmployeeDesignation = (employee = {}, profile = {}) => (
    profile?.employment?.designation || employee.designation || 'N/A'
);

const getEmployeeDepartment = (employee = {}, profile = {}) => (
    profile?.employment?.department || employee.department || 'N/A'
);

const getEmployeeJoiningDate = (employee = {}, profile = {}) => (
    profile?.employment?.joiningDate || employee.joiningDate || null
);

const getEmploymentStatusForInitiation = (exitType) => {
    const map = {
        Resignation: 'On Notice',
        Termination: 'Terminated',
        Retirement: 'Retired',
        'End of Contract': 'On Notice',
        'Mutual Separation': 'On Notice',
        Absconding: 'Terminated'
    };

    return map[exitType] || 'On Notice';
};

const getEmploymentStatusForCompletion = (exitType) => {
    const map = {
        Resignation: 'Resigned',
        Termination: 'Terminated',
        Retirement: 'Retired',
        'End of Contract': 'Terminated',
        'Mutual Separation': 'Resigned',
        Absconding: 'Terminated'
    };

    return map[exitType] || 'Resigned';
};

const getResolvedRecipientEmail = ({ recipientEmail, profile, employee }) => {
    const candidates = [
        recipientEmail,
        profile?.contact?.personalEmail,
        employee?.email
    ];

    return candidates.map((value) => String(value || '').trim()).find(Boolean) || '';
};

const getSenderLabel = (emailAccountId = '') => {
    if (!emailAccountId || emailAccountId === 'platform') {
        return 'TalentCIO Platform';
    }

    return emailAccountId;
};

const buildOffboardingTemplateData = ({
    employee,
    profile,
    company,
    offboarding,
    documentTypes = [],
    personalNote = ''
}) => {
    const firstName = employee?.firstName || '';
    const lastName = employee?.lastName || '';
    const fullName = buildEmployeeName(employee);
    const documentListItems = documentTypes.map((documentType) => `<li>${escapeHtml(documentType)}</li>`).join('');
    const resolvedPersonalNote = String(personalNote || '').trim();

    return {
        firstName,
        lastName,
        fullName,
        email: employee?.email || '',
        workEmail: profile?.contact?.workEmail || employee?.email || '',
        mobile: profile?.contact?.mobileNumber || '',
        phoneNumber: profile?.contact?.mobileNumber || '',
        jobTitle: getEmployeeDesignation(employee, profile),
        designation: getEmployeeDesignation(employee, profile),
        department: getEmployeeDepartment(employee, profile),
        location: profile?.employment?.branch || employee?.workLocation || '',
        managerName: '',
        managerEmail: '',
        companyName: company?.name || 'TalentCIO',
        employeeCode: employee?.employeeCode || '',
        exitType: offboarding?.exitType || '',
        lastWorkingDay: formatDateValue(offboarding?.lastWorkingDay),
        documentList: documentTypes.join(', '),
        documentListBlock: `<ul style="padding-left:20px;margin:0;">${documentListItems}</ul>`,
        personalNote: resolvedPersonalNote
            ? `<div style="margin:18px 0;padding:12px 14px;background:#f8fafc;border-left:4px solid #0f766e;"><div style="font-weight:600;margin-bottom:6px;">Note from HR:</div><div>${escapeHtml(resolvedPersonalNote)}</div></div>`
            : '',
        offboardingStatus: offboarding?.status || '',
        hrRemarks: offboarding?.hrRemarks || ''
    };
};

const mapOffboardingDocumentCategory = (documentType) => {
    if (documentType === 'Relieving Letter') return 'Relieving Letter';
    if (documentType === 'Payslip Bundle') return 'Payslips';
    if (documentType === 'Experience Letter' || documentType === 'NOC') return 'Employment';
    return 'Other';
};

const buildCoveringEmailHtml = ({ employeeName, companyName, documentTypes, personalNote }) => `
    <div style="font-family:Arial,sans-serif;font-size:14px;line-height:1.7;color:#1f2937;">
        <p>Dear ${escapeHtml(employeeName)},</p>
        <p>Please find attached your exit documents as requested.</p>
        <div style="margin:16px 0;">
            <div style="font-weight:600;margin-bottom:8px;">Documents included:</div>
            <ul style="padding-left:20px;margin:0;">
                ${documentTypes.map((documentType) => `<li>${escapeHtml(documentType)}</li>`).join('')}
            </ul>
        </div>
        ${personalNote
        ? `<div style="margin:18px 0;padding:12px 14px;background:#f8fafc;border-left:4px solid #0f766e;">
                <div style="font-weight:600;margin-bottom:6px;">Note from HR:</div>
                <div>${escapeHtml(personalNote)}</div>
            </div>`
        : ''
    }
        <p>For any queries, please contact your HR team.</p>
        <p>Best wishes,<br />${escapeHtml(companyName)} HR Team</p>
    </div>
`;

const generateRelievingLetter = (employee, profile, company, offboarding) => `
    <!DOCTYPE html>
    <html>
    <head><meta charset="utf-8" /></head>
    <body style="font-family:Arial,sans-serif;color:#111827;line-height:1.6;padding:32px;">
        ${buildLetterhead(company)}
        <div style="text-align:right;margin-bottom:24px;font-size:14px;">Date: ${formatDateValue(new Date())}</div>
        <h2 style="margin:0 0 20px;font-size:22px;">Relieving Letter</h2>
        <p>To whom it may concern,</p>
        <p>
            This is to certify that <strong>${escapeHtml(buildEmployeeName(employee))}</strong>, Employee Code
            <strong>${escapeHtml(employee.employeeCode || 'N/A')}</strong>, worked with
            <strong>${escapeHtml(company.name || 'TalentCIO')}</strong> as
            <strong>${escapeHtml(getEmployeeDesignation(employee, profile))}</strong> in the
            <strong>${escapeHtml(getEmployeeDepartment(employee, profile))}</strong> department from
            <strong>${formatDateValue(getEmployeeJoiningDate(employee, profile))}</strong> to
            <strong>${formatDateValue(offboarding.lastWorkingDay)}</strong>.
        </p>
        <p>
            The employee has been formally relieved from their duties and responsibilities with effect from the close of business
            on ${formatDateValue(offboarding.lastWorkingDay)}.
        </p>
        <p>We thank them for their contribution and wish them every success in their future endeavors.</p>
        <div style="margin-top:48px;">
            <div style="font-weight:600;">HR Department</div>
            <div>${escapeHtml(company.name || 'TalentCIO')}</div>
        </div>
    </body>
    </html>
`;

const generateExperienceLetter = (employee, profile, company, offboarding) => `
    <!DOCTYPE html>
    <html>
    <head><meta charset="utf-8" /></head>
    <body style="font-family:Arial,sans-serif;color:#111827;line-height:1.6;padding:32px;">
        ${buildLetterhead(company)}
        <div style="text-align:right;margin-bottom:24px;font-size:14px;">Date: ${formatDateValue(new Date())}</div>
        <h2 style="margin:0 0 20px;font-size:22px;">Experience Letter</h2>
        <p>To whom it may concern,</p>
        <p>
            This is to certify that <strong>${escapeHtml(buildEmployeeName(employee))}</strong>, Employee Code
            <strong>${escapeHtml(employee.employeeCode || 'N/A')}</strong>, was employed with
            <strong>${escapeHtml(company.name || 'TalentCIO')}</strong> from
            <strong>${formatDateValue(getEmployeeJoiningDate(employee, profile))}</strong> to
            <strong>${formatDateValue(offboarding.lastWorkingDay)}</strong>.
        </p>
        <p>
            During this period, the employee served as
            <strong>${escapeHtml(getEmployeeDesignation(employee, profile))}</strong> in the
            <strong>${escapeHtml(getEmployeeDepartment(employee, profile))}</strong> department.
        </p>
        <p>
            Throughout their tenure, the employee has been found to be sincere, hardworking, and dedicated in the discharge
            of their responsibilities.
        </p>
        <p>We wish them continued success in their future professional journey.</p>
        <div style="margin-top:48px;">
            <div style="font-weight:600;">HR Department</div>
            <div>${escapeHtml(company.name || 'TalentCIO')}</div>
        </div>
    </body>
    </html>
`;

const generateFnFSummary = (employee, profile, company, offboarding) => `
    <!DOCTYPE html>
    <html>
    <head><meta charset="utf-8" /></head>
    <body style="font-family:Arial,sans-serif;color:#111827;line-height:1.6;padding:32px;">
        ${buildLetterhead(company)}
        <div style="text-align:right;margin-bottom:24px;font-size:14px;">Date: ${formatDateValue(new Date())}</div>
        <h2 style="margin:0 0 20px;font-size:22px;">Full &amp; Final Settlement Summary</h2>
        <table style="width:100%;border-collapse:collapse;margin-bottom:24px;font-size:14px;">
            <tr>
                <td style="border:1px solid #d1d5db;padding:10px;font-weight:600;background:#f9fafb;">Employee Name</td>
                <td style="border:1px solid #d1d5db;padding:10px;">${escapeHtml(buildEmployeeName(employee))}</td>
            </tr>
            <tr>
                <td style="border:1px solid #d1d5db;padding:10px;font-weight:600;background:#f9fafb;">Employee Code</td>
                <td style="border:1px solid #d1d5db;padding:10px;">${escapeHtml(employee.employeeCode || 'N/A')}</td>
            </tr>
            <tr>
                <td style="border:1px solid #d1d5db;padding:10px;font-weight:600;background:#f9fafb;">Designation</td>
                <td style="border:1px solid #d1d5db;padding:10px;">${escapeHtml(getEmployeeDesignation(employee, profile))}</td>
            </tr>
            <tr>
                <td style="border:1px solid #d1d5db;padding:10px;font-weight:600;background:#f9fafb;">Department</td>
                <td style="border:1px solid #d1d5db;padding:10px;">${escapeHtml(getEmployeeDepartment(employee, profile))}</td>
            </tr>
            <tr>
                <td style="border:1px solid #d1d5db;padding:10px;font-weight:600;background:#f9fafb;">Last Working Day</td>
                <td style="border:1px solid #d1d5db;padding:10px;">${formatDateValue(offboarding.lastWorkingDay)}</td>
            </tr>
        </table>

        <table style="width:100%;border-collapse:collapse;font-size:14px;">
            <tr style="background:#f3f4f6;">
                <th style="border:1px solid #d1d5db;padding:10px;text-align:left;">Settlement Component</th>
                <th style="border:1px solid #d1d5db;padding:10px;text-align:right;">Amount</th>
            </tr>
            <tr>
                <td style="border:1px solid #d1d5db;padding:10px;">Basic Salary Due</td>
                <td style="border:1px solid #d1d5db;padding:10px;text-align:right;">${formatCurrencyValue(offboarding.fnfDetails?.basicSalaryDue)}</td>
            </tr>
            <tr>
                <td style="border:1px solid #d1d5db;padding:10px;">Leave Encashment</td>
                <td style="border:1px solid #d1d5db;padding:10px;text-align:right;">${formatCurrencyValue(offboarding.fnfDetails?.leaveEncashment)}</td>
            </tr>
            <tr>
                <td style="border:1px solid #d1d5db;padding:10px;">Bonus Due</td>
                <td style="border:1px solid #d1d5db;padding:10px;text-align:right;">${formatCurrencyValue(offboarding.fnfDetails?.bonusDue)}</td>
            </tr>
            <tr>
                <td style="border:1px solid #d1d5db;padding:10px;">Deductions</td>
                <td style="border:1px solid #d1d5db;padding:10px;text-align:right;">${formatCurrencyValue(offboarding.fnfDetails?.deductions)}</td>
            </tr>
            <tr style="background:#ecfeff;font-weight:700;">
                <td style="border:1px solid #d1d5db;padding:10px;">Net Payable</td>
                <td style="border:1px solid #d1d5db;padding:10px;text-align:right;">${formatCurrencyValue(offboarding.fnfDetails?.netPayable)}</td>
            </tr>
        </table>
        <p style="margin-top:18px;font-size:13px;color:#6b7280;">
            This is a system-generated summary. Final settlement is subject to approval.
        </p>
    </body>
    </html>
`;

const generateGenericExitDocument = (documentType, employee, profile, company, offboarding) => `
    <!DOCTYPE html>
    <html>
    <head><meta charset="utf-8" /></head>
    <body style="font-family:Arial,sans-serif;color:#111827;line-height:1.6;padding:32px;">
        ${buildLetterhead(company)}
        <div style="text-align:right;margin-bottom:24px;font-size:14px;">Date: ${formatDateValue(new Date())}</div>
        <h2 style="margin:0 0 20px;font-size:22px;">${escapeHtml(documentType)}</h2>
        <p>This document pertains to the offboarding of <strong>${escapeHtml(buildEmployeeName(employee))}</strong>.</p>
        <p>
            Employee Code: <strong>${escapeHtml(employee.employeeCode || 'N/A')}</strong><br />
            Designation: <strong>${escapeHtml(getEmployeeDesignation(employee, profile))}</strong><br />
            Department: <strong>${escapeHtml(getEmployeeDepartment(employee, profile))}</strong><br />
            Last Working Day: <strong>${formatDateValue(offboarding.lastWorkingDay)}</strong>
        </p>
        <p>
            This communication is being shared by the HR Department of ${escapeHtml(company.name || 'TalentCIO')}
            as part of the employee exit process.
        </p>
        <div style="margin-top:48px;">
            <div style="font-weight:600;">HR Department</div>
            <div>${escapeHtml(company.name || 'TalentCIO')}</div>
        </div>
    </body>
    </html>
`;

const buildDocumentHtml = (documentType, employee, profile, company, offboarding) => {
    if (documentType === 'Relieving Letter') {
        return generateRelievingLetter(employee, profile, company, offboarding);
    }

    if (documentType === 'Experience Letter') {
        return generateExperienceLetter(employee, profile, company, offboarding);
    }

    if (documentType === 'Full & Final Settlement') {
        return generateFnFSummary(employee, profile, company, offboarding);
    }

    return generateGenericExitDocument(documentType, employee, profile, company, offboarding);
};

const getCompanyForRequest = async (req) => {
    if (req.company) {
        return req.company;
    }

    return Company.findById(req.companyId)
        .select('name country')
        .lean();
};

const sendCompanyEmailWithFallback = async ({
    companyId,
    emailAccountId,
    to,
    subject,
    html,
    text,
    attachments = []
}) => {
    const sentViaCompany = await sendEmailForCompany({
        companyId,
        emailAccountId,
        to,
        subject,
        html,
        text,
        attachments
    });

    if (sentViaCompany) {
        return true;
    }

    return sendEmail({
        companyId,
        to,
        subject,
        html,
        text,
        attachments
    });
};

const uploadHtmlDocumentToCloudinary = async ({
    companyId,
    employeeId,
    documentType,
    html
}) => {
    const sanitizedType = String(documentType || 'document')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '') || 'document';

    const uploadResult = await new Promise((resolve, reject) => {
        const stream = cloudinary.uploader.upload_stream(
            {
                folder: `talentcio/${companyId}/offboarding/${employeeId}`,
                resource_type: 'raw',
                public_id: `${sanitizedType}-${Date.now()}.html`
            },
            (error, uploaded) => (error ? reject(error) : resolve(uploaded))
        );

        stream.end(Buffer.from(html, 'utf-8'));
    });

    return {
        url: uploadResult?.secure_url || '',
        publicId: uploadResult?.public_id || ''
    };
};

const uploadAttachmentBufferToCloudinary = async ({
    companyId,
    employeeId,
    file
}) => {
    const originalName = String(file?.originalname || 'attachment').trim() || 'attachment';
    const extension = originalName.includes('.') ? originalName.split('.').pop() : '';
    const baseName = originalName.replace(/\.[^/.]+$/, '') || 'attachment';
    const sanitizedBaseName = baseName
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '') || 'attachment';
    const isImage = String(file?.mimetype || '').startsWith('image/');
    const publicId = isImage
        ? `${sanitizedBaseName}-${Date.now()}`
        : `${sanitizedBaseName}-${Date.now()}${extension ? `.${extension}` : ''}`;

    const uploadResult = await new Promise((resolve, reject) => {
        const stream = cloudinary.uploader.upload_stream(
            {
                folder: `talentcio/${companyId}/offboarding/${employeeId}/attachments`,
                resource_type: isImage ? 'image' : 'raw',
                public_id: publicId
            },
            (error, uploaded) => (error ? reject(error) : resolve(uploaded))
        );

        stream.end(file.buffer);
    });

    return {
        url: uploadResult?.secure_url || '',
        publicId: uploadResult?.public_id || '',
        resourceType: isImage ? 'image' : 'raw'
    };
};

const applyClearanceUpdate = (record, clearance = {}) => {
    const keys = ['it', 'finance', 'hr', 'admin', 'manager'];
    keys.forEach((key) => {
        if (clearance[key] !== undefined) {
            record.clearance[key] = Boolean(clearance[key]);
        }
    });

    const currentClearance = record.clearance || {};
    const allClear = keys.every((key) => Boolean(currentClearance[key]));

    if (allClear) {
        if (!record.clearance.completedAt) {
            record.clearance.completedAt = new Date();
        }

        if (record.status === 'Initiated') {
            record.status = 'In Progress';
        }
    } else {
        record.clearance.completedAt = null;

        if (Object.keys(clearance).length > 0 && record.status === 'Initiated') {
            record.status = 'Clearance Pending';
        }
    }
};

const applyFnfDetailsUpdate = (record, fnfDetails = {}, actingUserId) => {
    const numericKeys = ['basicSalaryDue', 'leaveEncashment', 'bonusDue', 'deductions', 'netPayable'];
    let recalculateNetPayable = false;

    numericKeys.forEach((key) => {
        if (fnfDetails[key] !== undefined) {
            record.fnfDetails[key] = Number(fnfDetails[key] || 0);
            if (key !== 'netPayable') {
                recalculateNetPayable = true;
            }
        }
    });

    if (fnfDetails.settledAt !== undefined) {
        record.fnfDetails.settledAt = fnfDetails.settledAt ? new Date(fnfDetails.settledAt) : null;
        if (fnfDetails.settledAt && !fnfDetails.settledBy && !record.fnfDetails.settledBy) {
            record.fnfDetails.settledBy = actingUserId;
        }
    }

    if (fnfDetails.settledBy !== undefined) {
        record.fnfDetails.settledBy = fnfDetails.settledBy || null;
    }

    if (fnfDetails.netPayable === undefined && recalculateNetPayable) {
        record.fnfDetails.netPayable = Number(record.fnfDetails.basicSalaryDue || 0)
            + Number(record.fnfDetails.leaveEncashment || 0)
            + Number(record.fnfDetails.bonusDue || 0)
            - Number(record.fnfDetails.deductions || 0);
    }
};

const populateOffboardingQuery = (query) => query
    .populate({
        path: 'userId',
        select: 'firstName lastName email department employeeCode joiningDate employeeProfile',
        populate: {
            path: 'employeeProfile',
            select: 'contact.personalEmail employment.designation employment.joiningDate'
        }
    })
    .populate('initiatedBy', 'firstName lastName')
    .populate('completedBy', 'firstName lastName');

exports.initiateOffboarding = async (req, res) => {
    try {
        const { userId, exitType, lastWorkingDay, noticePeriodServed, hrRemarks } = req.body || {};

        if (!userId || !exitType || !lastWorkingDay) {
            return res.status(400).json({ message: 'userId, exitType, and lastWorkingDay are required' });
        }

        if (!mongoose.isValidObjectId(userId)) {
            return res.status(400).json({ message: 'Invalid userId' });
        }

        const existingRecord = await OffboardingRecord.findOne({
            userId,
            companyId: req.companyId,
            status: { $ne: 'Completed' }
        });

        if (existingRecord) {
            return res.status(400).json({ message: 'An active offboarding record already exists for this employee' });
        }

        const employee = await User.findOne({ _id: userId, companyId: req.companyId });
        if (!employee) {
            return res.status(404).json({ message: 'Employee not found' });
        }

        const profile = await EmployeeProfile.findOne({ user: userId, companyId: req.companyId });
        if (!profile) {
            return res.status(404).json({ message: 'Employee profile not found' });
        }

        const record = await OffboardingRecord.create({
            userId,
            companyId: req.companyId,
            exitType,
            initiatedBy: req.user._id,
            lastWorkingDay: new Date(lastWorkingDay),
            noticePeriodServed: Boolean(noticePeriodServed),
            hrRemarks: hrRemarks || ''
        });

        profile.employment = profile.employment || {};
        profile.employment.status = getEmploymentStatusForInitiation(exitType);
        await profile.save();

        const populatedRecord = await populateOffboardingQuery(
            OffboardingRecord.findOne({ _id: record._id, companyId: req.companyId })
        );

        return res.status(201).json(populatedRecord);
    } catch (error) {
        console.error('Error initiating offboarding:', error);
        return res.status(500).json({ message: 'Internal server error' });
    }
};

exports.getOffboardingList = async (req, res) => {
    try {
        const status = String(req.query.status || '').trim();
        const exitType = String(req.query.exitType || '').trim();
        const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
        const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 20, 1), 100);
        const skip = (page - 1) * limit;

        const query = { companyId: req.companyId };
        if (status) query.status = status;
        if (exitType) query.exitType = exitType;

        const [total, records] = await Promise.all([
            OffboardingRecord.countDocuments(query),
            populateOffboardingQuery(
                OffboardingRecord.find(query)
                    .sort({ initiatedAt: -1, createdAt: -1 })
                    .skip(skip)
                    .limit(limit)
            ).lean()
        ]);

        return res.json({
            total,
            page,
            limit,
            totalPages: Math.ceil(total / limit) || 1,
            records
        });
    } catch (error) {
        console.error('Error fetching offboarding list:', error);
        return res.status(500).json({ message: 'Internal server error' });
    }
};

exports.getOffboardingById = async (req, res) => {
    try {
        const record = await populateOffboardingQuery(
            OffboardingRecord.findOne({ _id: req.params.id, companyId: req.companyId })
        );

        if (!record) {
            return res.status(404).json({ message: 'Offboarding record not found' });
        }

        return res.json(record);
    } catch (error) {
        console.error('Error fetching offboarding record:', error);
        return res.status(500).json({ message: 'Internal server error' });
    }
};

exports.sendOffboardingEmail = async (req, res) => {
    try {
        const record = await OffboardingRecord.findOne({
            _id: req.params.id,
            companyId: req.companyId
        }).populate({
            path: 'userId',
            select: 'firstName lastName email department employeeCode joiningDate employeeProfile',
            populate: {
                path: 'employeeProfile',
                select: 'contact.personalEmail employment.designation employment.joiningDate'
            }
        });

        if (!record) {
            return res.status(404).json({ message: 'Offboarding record not found' });
        }

        const user = record.userId || {};
        const populatedProfile = user?.employeeProfile || null;
        const profile = await EmployeeProfile.findOne({ user: user?._id, companyId: req.companyId });
        const recipientEmail = String(
            req.body?.recipientEmail
            || profile?.contact?.personalEmail
            || populatedProfile?.contact?.personalEmail
            || user?.email
            || ''
        ).trim();

        if (!recipientEmail) {
            return res.status(400).json({ message: 'Recipient email is required' });
        }

        const templateData = {
            firstName: user?.firstName || '',
            lastName: user?.lastName || '',
            fullName: `${user?.firstName || ''} ${user?.lastName || ''}`.trim(),
            email: user?.email || '',
            designation: profile?.employment?.designation || populatedProfile?.employment?.designation || '',
            department: user?.department || '',
            joiningDate: formatShortDateValue(user?.joiningDate || profile?.employment?.joiningDate || populatedProfile?.employment?.joiningDate),
            lastWorkingDay: formatShortDateValue(record?.lastWorkingDay),
            exitType: record?.exitType || '',
            companyName: req.company?.name || '',
            currentYear: new Date().getFullYear().toString(),
            currentDate: new Date().toLocaleDateString('en-US', { month: 'long', day: '2-digit', year: 'numeric' })
        };

        let template = null;
        if (req.body?.emailTemplateId) {
            template = await EmailTemplate.findOne({
                _id: req.body.emailTemplateId,
                companyId: req.companyId
            }).lean();

            if (!template) {
                return res.status(404).json({ message: 'Email template not found' });
            }
        }

        const fallbackBody = '<p>Dear {{firstName}},<br>Please find attached your exit documents.<br>Best regards,<br>HR Team</p>';
        const subjectTemplate = String(
            req.body?.customSubject
            || template?.subject
            || 'Exit Documents from {{companyName}}'
        ).trim();
        const bodyTemplate = String(
            req.body?.customBody
            || template?.htmlBody
            || fallbackBody
        );

        const resolvedSubject = resolveTemplate(subjectTemplate, templateData);
        const resolvedHtml = renderTemplateBody(bodyTemplate, templateData);
        const requestedFiles = Array.isArray(req.files) ? req.files : [];
        const attachments = requestedFiles.map((file) => ({
            filename: file.originalname,
            content: file.buffer,
            contentType: file.mimetype
        }));

        const sent = await sendEmailForCompany({
            companyId: req.companyId,
            emailAccountId: req.body?.emailAccountId || undefined,
            to: recipientEmail,
            subject: resolvedSubject,
            html: resolvedHtml,
            attachments
        });

        if (!sent) {
            return res.status(500).json({ message: 'Failed to send offboarding email' });
        }

        const sentAt = new Date();
        const uploadedAttachments = [];
        for (const file of requestedFiles) {
            try {
                const uploaded = await uploadAttachmentBufferToCloudinary({
                    companyId: req.companyId,
                    employeeId: user?._id,
                    file
                });

                uploadedAttachments.push({
                    file,
                    url: uploaded.url,
                    publicId: uploaded.publicId
                });
            } catch (uploadError) {
                console.error(`[OFFBOARDING] Failed to upload attachment ${file?.originalname || 'attachment'}:`, uploadError.message);
            }
        }

        if (uploadedAttachments.length > 0) {
            uploadedAttachments.forEach(({ file, url }) => {
                record.documentsIssued.push({
                    type: 'Other',
                    sentAt,
                    sentTo: recipientEmail,
                    sentBy: req.user._id,
                    emailAccountId: req.body?.emailAccountId || '',
                    emailTemplateId: template?._id || null,
                    emailTemplateName: template?.name || '',
                    emailSubject: resolvedSubject,
                    cloudinaryUrl: url,
                    profileDocumentCategory: 'Other',
                    profileDocumentTitle: file.originalname,
                    notes: `Sent via template: ${template?.name || 'custom'}`
                });
            });
        } else {
            record.documentsIssued.push({
                type: 'Other',
                sentAt,
                sentTo: recipientEmail,
                sentBy: req.user._id,
                emailAccountId: req.body?.emailAccountId || '',
                emailTemplateId: template?._id || null,
                emailTemplateName: template?.name || '',
                emailSubject: resolvedSubject,
                notes: `Sent via template: ${template?.name || 'custom'}`
            });
        }

        if (profile && uploadedAttachments.length > 0) {
            profile.documents = Array.isArray(profile.documents) ? profile.documents : [];
            profile.documents.push(...uploadedAttachments.map(({ file, url }) => ({
                category: 'Other',
                title: file.originalname,
                fileName: file.originalname,
                url,
                uploadDate: sentAt,
                verificationStatus: 'Verified'
            })));
            await profile.save();
        }

        if (record.status === 'Initiated') {
            record.status = 'In Progress';
        }

        await record.save();

        if (sent) {
            await HREmailLog.create({
                companyId: req.companyId,
                sentBy: req.user?._id,
                recipientUserId: record.userId || null,
                recipientEmail: recipientEmail,
                subject: resolvedSubject,
                body: resolvedHtml,
                type: 'offboarding',
                emailAccountId: req.body?.emailAccountId || 'platform',
                emailAccountLabel: req.body?.emailAccountId === 'platform' ? 'TalentCIO Platform' : (req.body?.emailAccountId || 'TalentCIO Platform'),
                attachments: uploadedAttachments.map(ua => ({
                    filename: ua.file.originalname,
                    cloudinaryUrl: ua.url,
                    publicId: ua.publicId || '',
                    dossierDocId: null
                })),
                sentAt: new Date()
            });
        }

        return res.json({
            success: true,
            sentTo: recipientEmail,
            storedAttachments: uploadedAttachments.length
        });
    } catch (error) {
        console.error('Error sending offboarding email:', error);
        return res.status(500).json({ message: 'Internal server error' });
    }
};

exports.updateOffboarding = async (req, res) => {
    try {
        const record = await OffboardingRecord.findOne({ _id: req.params.id, companyId: req.companyId });
        if (!record) {
            return res.status(404).json({ message: 'Offboarding record not found' });
        }

        const {
            status,
            exitType,
            lastWorkingDay,
            noticePeriodServed,
            exitInterviewDone,
            exitInterviewNotes,
            clearance,
            fnfDetails,
            hrRemarks
        } = req.body || {};

        if (exitType !== undefined) {
            record.exitType = exitType;

            const profile = await EmployeeProfile.findOne({ user: record.userId, companyId: req.companyId });
            if (profile) {
                profile.employment = profile.employment || {};
                profile.employment.status = getEmploymentStatusForInitiation(exitType);
                await profile.save();
            }
        }

        if (lastWorkingDay !== undefined) {
            record.lastWorkingDay = new Date(lastWorkingDay);
        }

        if (noticePeriodServed !== undefined) {
            record.noticePeriodServed = Boolean(noticePeriodServed);
        }

        if (exitInterviewDone !== undefined) {
            record.exitInterviewDone = Boolean(exitInterviewDone);
        }

        if (exitInterviewNotes !== undefined) {
            record.exitInterviewNotes = exitInterviewNotes || '';
        }

        if (hrRemarks !== undefined) {
            record.hrRemarks = hrRemarks || '';
        }

        if (clearance && typeof clearance === 'object') {
            applyClearanceUpdate(record, clearance);
        }

        if (fnfDetails && typeof fnfDetails === 'object') {
            applyFnfDetailsUpdate(record, fnfDetails, req.user._id);
        }

        if (status !== undefined) {
            if (status === 'Completed') {
                return res.status(400).json({ message: 'Use the completion action to mark offboarding as completed' });
            }

            if (!EDITABLE_OFFBOARDING_STATUSES.has(status)) {
                return res.status(400).json({ message: 'Invalid offboarding status' });
            }

            record.status = status;
        }

        await record.save();

        const updatedRecord = await populateOffboardingQuery(
            OffboardingRecord.findOne({ _id: record._id, companyId: req.companyId })
        );

        return res.json(updatedRecord);
    } catch (error) {
        console.error('Error updating offboarding record:', error);
        return res.status(500).json({ message: 'Internal server error' });
    }
};

exports.sendExitDocuments = async (req, res) => {
    try {
        const {
            documentTypes,
            recipientEmail,
            personalNote,
            emailAccountId,
            emailAccountLabel,
            emailTemplateId,
            emailSubject,
            emailHtmlBody
        } = req.body || {};

        if (!Array.isArray(documentTypes) || documentTypes.length === 0) {
            return res.status(400).json({ message: 'documentTypes must be a non-empty array' });
        }

        const invalidType = documentTypes.find((type) => !EXIT_DOCUMENT_TYPES.has(type));
        if (invalidType) {
            return res.status(400).json({ message: `Unsupported document type: ${invalidType}` });
        }

        const offboarding = await OffboardingRecord.findOne({
            _id: req.params.id,
            companyId: req.companyId
        }).populate('userId', 'firstName lastName email department employeeCode joiningDate');

        if (!offboarding) {
            return res.status(404).json({ message: 'Offboarding record not found' });
        }

        const employee = offboarding.userId;
        const profile = await EmployeeProfile.findOne({ user: employee._id, companyId: req.companyId });
        if (!profile) {
            return res.status(404).json({ message: 'Employee profile not found' });
        }

        const company = await getCompanyForRequest(req);
        const resolvedRecipientEmail = getResolvedRecipientEmail({ recipientEmail, profile, employee });

        if (!resolvedRecipientEmail) {
            return res.status(400).json({ message: 'No recipient email found for this employee' });
        }

        let selectedTemplate = null;
        if (emailTemplateId) {
            selectedTemplate = await EmailTemplate.findOne({
                _id: emailTemplateId,
                companyId: req.companyId,
                scope: 'general',
                isActive: true,
                $or: [
                    { templateType: 'general' },
                    { templateType: { $exists: false } }
                ]
            }).lean();

            if (!selectedTemplate) {
                return res.status(404).json({ message: 'Selected email template was not found.' });
            }
        }

        const subjectTemplate = String(
            emailSubject
            || selectedTemplate?.subject
            || DEFAULT_OFFBOARDING_EMAIL_SUBJECT
        ).trim();
        const bodyTemplate = String(
            emailHtmlBody
            || selectedTemplate?.htmlBody
            || DEFAULT_OFFBOARDING_EMAIL_BODY
        );

        if (!subjectTemplate || !bodyTemplate.trim()) {
            return res.status(400).json({ message: 'Email subject and body are required.' });
        }

        const subjectValidation = validateTemplateSyntax(subjectTemplate, GENERAL_EMAIL_TEMPLATE_PLACEHOLDERS);
        if (!subjectValidation.valid) {
            return res.status(400).json({ message: `Subject error: ${subjectValidation.message}` });
        }

        const bodyValidation = validateTemplateSyntax(bodyTemplate, GENERAL_EMAIL_TEMPLATE_PLACEHOLDERS);
        if (!bodyValidation.valid) {
            return res.status(400).json({ message: `Body error: ${bodyValidation.message}` });
        }

        const companyName = company?.name || 'TalentCIO';
        const templateData = buildOffboardingTemplateData({
            employee,
            profile,
            company: company || {},
            offboarding,
            documentTypes,
            personalNote
        });
        const resolvedSubject = resolveTemplate(subjectTemplate, templateData);
        const resolvedEmailHtml = renderTemplateBody(bodyTemplate, templateData);

        const generatedDocuments = await Promise.all(documentTypes.map(async (documentType) => {
            const html = buildDocumentHtml(documentType, employee, profile, company || {}, offboarding);
            let uploadedDocument = { url: '' };

            try {
                uploadedDocument = await uploadHtmlDocumentToCloudinary({
                    companyId: req.companyId,
                    employeeId: employee._id,
                    documentType,
                    html
                });
            } catch (uploadError) {
                console.error(`[OFFBOARDING] Failed to upload ${documentType} to Cloudinary:`, uploadError.message);
            }

            return {
                type: documentType,
                html,
                cloudinaryUrl: uploadedDocument.url || '',
                profileDocumentCategory: mapOffboardingDocumentCategory(documentType),
                profileDocumentTitle: documentType
            };
        }));

        const attachments = generatedDocuments.map((document) => ({
            filename: `${document.type.replace(/[^a-zA-Z0-9]+/g, '_')}.html`,
            content: Buffer.from(document.html, 'utf-8'),
            contentType: 'text/html'
        }));

        const sent = await sendCompanyEmailWithFallback({
            companyId: req.companyId,
            emailAccountId,
            to: resolvedRecipientEmail,
            subject: resolvedSubject,
            html: resolvedEmailHtml,
            text: `Your exit documents from ${companyName} are attached.`,
            attachments
        });

        if (!sent) {
            return res.status(500).json({ message: 'Failed to send exit documents' });
        }

        if (sent) {
            await HREmailLog.create({
                companyId: req.companyId,
                sentBy: req.user?._id,
                recipientUserId: offboarding.userId || null,
                recipientEmail: resolvedRecipientEmail,
                subject: resolvedSubject,
                body: resolvedEmailHtml,
                type: 'offboarding',
                emailAccountId: emailAccountId || 'platform',
                emailAccountLabel: emailAccountLabel || getSenderLabel(emailAccountId),
                attachments: generatedDocuments.map(doc => ({
                    filename: `${doc.type.replace(/[^a-zA-Z0-9]+/g, '_')}.html`,
                    cloudinaryUrl: doc.cloudinaryUrl,
                    publicId: extractPublicIdFromUrl(doc.cloudinaryUrl) || '',
                    dossierDocId: null
                })),
                sentAt: new Date()
            });
        }

        const sentAt = new Date();
        generatedDocuments.forEach((document) => {
            offboarding.documentsIssued.push({
                type: document.type,
                sentAt,
                sentTo: resolvedRecipientEmail,
                sentBy: req.user._id,
                emailAccountId: emailAccountId || 'platform',
                emailAccountLabel: emailAccountLabel || getSenderLabel(emailAccountId),
                emailTemplateId: selectedTemplate?._id || null,
                emailTemplateName: selectedTemplate?.name || 'Built-in Offboarding Template',
                emailSubject: resolvedSubject,
                cloudinaryUrl: document.cloudinaryUrl,
                profileDocumentCategory: document.profileDocumentCategory,
                profileDocumentTitle: document.profileDocumentTitle,
                notes: personalNote || ''
            });
        });

        const profileDocumentsToAdd = generatedDocuments.map((document) => ({
            category: document.profileDocumentCategory,
            title: document.profileDocumentTitle,
            fileName: `${document.type.replace(/[^a-zA-Z0-9]+/g, '_')}.html`,
            url: document.cloudinaryUrl,
            uploadDate: sentAt,
            verificationStatus: 'Verified'
        }));

        profile.documents = Array.isArray(profile.documents) ? profile.documents : [];
        profile.documents.push(...profileDocumentsToAdd);
        await profile.save();

        if (offboarding.status === 'Initiated') {
            offboarding.status = 'In Progress';
        }

        await offboarding.save();

        return res.json({
            success: true,
            sentTo: resolvedRecipientEmail,
            documentsSent: documentTypes,
            emailAccountId: emailAccountId || 'platform',
            emailTemplateId: selectedTemplate?._id || null
        });
    } catch (error) {
        console.error('Error sending exit documents:', error);
        return res.status(500).json({ message: 'Internal server error' });
    }
};

exports.completeOffboarding = async (req, res) => {
    try {
        const record = await OffboardingRecord.findOne({ _id: req.params.id, companyId: req.companyId });
        if (!record) {
            return res.status(404).json({ message: 'Offboarding record not found' });
        }

        if (record.status === 'Completed') {
            return res.status(400).json({ message: 'Offboarding has already been completed' });
        }

        const employee = await User.findOne({ _id: record.userId, companyId: req.companyId });
        if (!employee) {
            return res.status(404).json({ message: 'Employee not found' });
        }

        const profile = await EmployeeProfile.findOne({ user: record.userId, companyId: req.companyId });
        if (!profile) {
            return res.status(404).json({ message: 'Employee profile not found' });
        }

        record.status = 'Completed';
        record.completedAt = new Date();
        record.completedBy = req.user._id;
        record.isActive = false;
        await record.save();

        employee.isActive = false;
        await employee.save();

        profile.employment = profile.employment || {};
        profile.employment.status = getEmploymentStatusForCompletion(record.exitType);
        await profile.save();

        const company = await getCompanyForRequest(req);
        const companyName = company?.name || 'TalentCIO';
        const resolvedRecipientEmail = getResolvedRecipientEmail({ profile, employee });
        const farewellHtml = `
            <div style="font-family:Arial,sans-serif;font-size:14px;line-height:1.7;color:#1f2937;">
                <p>Dear ${escapeHtml(buildEmployeeName(employee))},</p>
                <p>Your offboarding has been completed successfully.</p>
                <p>Your recorded last working day was <strong>${formatDateValue(record.lastWorkingDay)}</strong>.</p>
                <p>Thank you for your service and contributions to ${escapeHtml(companyName)}.</p>
                <p>For any further queries, please contact your HR team.</p>
                <p>Best regards,<br />${escapeHtml(companyName)} HR Team</p>
            </div>
        `;

        let emailSent = false;
        if (resolvedRecipientEmail) {
            emailSent = await sendCompanyEmailWithFallback({
                companyId: req.companyId,
                to: resolvedRecipientEmail,
                subject: `Your offboarding has been completed - ${companyName}`,
                html: farewellHtml,
                text: `Your offboarding has been completed. Last working day: ${formatDateValue(record.lastWorkingDay)}.`
            });

            if (emailSent) {
                await HREmailLog.create({
                    companyId: req.companyId,
                    sentBy: req.user?._id,
                    recipientUserId: record.userId || null,
                    recipientEmail: resolvedRecipientEmail,
                    subject: `Your offboarding has been completed - ${companyName}`,
                    body: farewellHtml,
                    type: 'offboarding',
                    emailAccountId: 'platform',
                    emailAccountLabel: 'TalentCIO Platform',
                    sentAt: new Date()
                });
            }
        }

        const updatedRecord = await populateOffboardingQuery(
            OffboardingRecord.findOne({ _id: record._id, companyId: req.companyId })
        );

        return res.json({
            ...updatedRecord.toObject(),
            emailSent
        });
    } catch (error) {
        console.error('Error completing offboarding:', error);
        return res.status(500).json({ message: 'Internal server error' });
    }
};

exports.getOffboardingStats = async (req, res) => {
    try {
        const now = new Date();
        const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
        const nextMonthStart = new Date(now.getFullYear(), now.getMonth() + 1, 1);

        const [total, initiated, inProgress, clearancePending, completed, thisMonth] = await Promise.all([
            OffboardingRecord.countDocuments({ companyId: req.companyId }),
            OffboardingRecord.countDocuments({ companyId: req.companyId, status: 'Initiated' }),
            OffboardingRecord.countDocuments({ companyId: req.companyId, status: 'In Progress' }),
            OffboardingRecord.countDocuments({ companyId: req.companyId, status: 'Clearance Pending' }),
            OffboardingRecord.countDocuments({ companyId: req.companyId, status: 'Completed' }),
            OffboardingRecord.countDocuments({
                companyId: req.companyId,
                initiatedAt: { $gte: monthStart, $lt: nextMonthStart }
            })
        ]);

        return res.json({
            total,
            initiated,
            inProgress,
            clearancePending,
            completed,
            thisMonth
        });
    } catch (error) {
        console.error('Error fetching offboarding stats:', error);
        return res.status(500).json({ message: 'Internal server error' });
    }
};
