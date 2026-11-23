const mongoose = require('mongoose');
const axios = require('axios');
const { format } = require('date-fns');
const OffboardingRecord = require('./offboardingRecord.model');
const User = require('../../modules/user/user.model');
const EmployeeProfile = require('../dossier/employeeProfile.model');
const Company = require('../company/company.model');
const EmailTemplate = require('../email/model/emailTemplate.model');
const HREmailLog = require('../email/model/hrEmailLog.model');
const { extractPublicIdFromUrl } = require('../../utils/cloudinaryHelper');
const { cloudinary, uploadBufferToCloudinary } = require('../../config/cloudinary');
const PizZip = require('pizzip');
const Docxtemplater = require('docxtemplater');
const mammoth = require('mammoth');
const { sendEmailForCompany } = require('../../services/companyEmailService');
const { sendEmail } = require('../../services/emailService');
const { invalidateAuthUserCache } = require('../../common/middleware/authMiddleware');
const {
    GENERAL_EMAIL_TEMPLATE_PLACEHOLDERS,
    renderTemplateBody,
    resolveTemplate,
    validateTemplateSyntax
} = require('../email/templateResolver');

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
    cc,
    bcc,
    subject,
    html,
    text,
    attachments = []
}) => {
    const sentViaCompany = await sendEmailForCompany({
        companyId,
        emailAccountId,
        to,
        cc,
        bcc,
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
        cc,
        bcc,
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
    record.clearance = record.clearance || {};
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

        if (record.status === 'Initiated' || record.status === 'Clearance Pending') {
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
    record.fnfDetails = record.fnfDetails || {};
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
        if (req.body?.emailTemplateId && req.body.emailTemplateId !== '__custom__') {
            if (!mongoose.isValidObjectId(req.body.emailTemplateId)) {
                return res.status(400).json({ message: 'Invalid emailTemplateId' });
            }
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

        const cc = String(req.body?.cc || '').trim();
        const bcc = String(req.body?.bcc || '').trim();

        const sent = await sendCompanyEmailWithFallback({
            companyId: req.companyId,
            emailAccountId: req.body?.emailAccountId || undefined,
            to: recipientEmail,
            cc: cc || undefined,
            bcc: bcc || undefined,
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
                cc,
                bcc,
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
        if (emailTemplateId && emailTemplateId !== '__custom__') {
            if (!mongoose.isValidObjectId(emailTemplateId)) {
                return res.status(400).json({ message: 'Invalid emailTemplateId' });
            }
            selectedTemplate = await EmailTemplate.findOne({
                _id: emailTemplateId,
                companyId: req.companyId,
                scope: 'general',
                isActive: true,
                $or: [
                    { templateType: { $in: ['general', 'offboarding'] } },
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
        employee.tokenVersion = (employee.tokenVersion || 0) + 1;
        await employee.save();
        invalidateAuthUserCache(employee._id);

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

const LETTER_TEMPLATE_TAGS = [
    { tag: '{{fullName}}', key: 'fullName', label: 'Full Name', desc: 'Employee full legal name' },
    { tag: '{{firstName}}', key: 'firstName', label: 'First Name', desc: 'Employee first name' },
    { tag: '{{lastName}}', key: 'lastName', label: 'Last Name', desc: 'Employee last name' },
    { tag: '{{employeeCode}}', key: 'employeeCode', label: 'Employee Code', desc: 'Employee ID or Code' },
    { tag: '{{designation}}', key: 'designation', label: 'Designation', desc: 'Employee job title / designation' },
    { tag: '{{department}}', key: 'department', label: 'Department', desc: 'Department name' },
    { tag: '{{joiningDate}}', key: 'joiningDate', label: 'Joining Date', desc: 'Date employee joined company' },
    { tag: '{{lastWorkingDay}}', key: 'lastWorkingDay', label: 'Last Working Day', desc: 'Official last day of employment' },
    { tag: '{{exitType}}', key: 'exitType', label: 'Exit Type', desc: 'Resignation, Termination, Retirement, etc.' },
    { tag: '{{companyName}}', key: 'companyName', label: 'Company Name', desc: 'Your company name' },
    { tag: '{{companyAddress}}', key: 'companyAddress', label: 'Company Address', desc: 'Company registered location' },
    { tag: '{{currentDate}}', key: 'currentDate', label: 'Current Date', desc: 'Date of issuance' },
    { tag: '{{currentYear}}', key: 'currentYear', label: 'Current Year', desc: 'Current four-digit year' },
    { tag: '{{noticePeriodServed}}', key: 'noticePeriodServed', label: 'Notice Period', desc: 'Notice period status (Yes/No)' },
    { tag: '{{hrRemarks}}', key: 'hrRemarks', label: 'HR Remarks', desc: 'Remarks recorded by HR' }
];

const DEFAULT_RELIEVING_BODY = `<p>To whom it may concern,</p>
<p>
    This is to certify that <strong>{{fullName}}</strong>, Employee Code
    <strong>{{employeeCode}}</strong>, worked with
    <strong>{{companyName}}</strong> as
    <strong>{{designation}}</strong> in the
    <strong>{{department}}</strong> department from
    <strong>{{joiningDate}}</strong> to
    <strong>{{lastWorkingDay}}</strong>.
</p>
<p>
    The employee has been formally relieved from their duties and responsibilities with effect from the close of business
    on {{lastWorkingDay}}.
</p>
<p>We thank them for their contribution and wish them every success in their future endeavors.</p>
<div style="margin-top:48px;">
    <div style="font-weight:600;">HR Department</div>
    <div>{{companyName}}</div>
</div>`;

const DEFAULT_EXPERIENCE_BODY = `<p>To whom it may concern,</p>
<p>
    This is to certify that <strong>{{fullName}}</strong>, Employee Code
    <strong>{{employeeCode}}</strong>, was employed with
    <strong>{{companyName}}</strong> from
    <strong>{{joiningDate}}</strong> to
    <strong>{{lastWorkingDay}}</strong>.
</p>
<p>
    During this period, the employee served as
    <strong>{{designation}}</strong> in the
    <strong>{{department}}</strong> department.
</p>
<p>
    Throughout their tenure, the employee has been found to be sincere, hardworking, and dedicated in the discharge
    of their responsibilities.
</p>
<p>We wish them continued success in their future professional journey.</p>
<div style="margin-top:48px;">
    <div style="font-weight:600;">HR Department</div>
    <div>{{companyName}}</div>
</div>`;

exports.getLetterTags = async (req, res) => {
    try {
        return res.json({
            tags: LETTER_TEMPLATE_TAGS,
            defaultTemplates: {
                'Relieving Letter': DEFAULT_RELIEVING_BODY,
                'Experience Letter': DEFAULT_EXPERIENCE_BODY
            }
        });
    } catch (error) {
        console.error('Error fetching letter tags:', error);
        return res.status(500).json({ message: 'Internal server error' });
    }
};

const replaceTemplatePlaceholders = (text, data = {}) => {
    if (!text || typeof text !== 'string') return '';
    return text.replace(/\{\{?([a-zA-Z0-9_]+)\}?\}/g, (match, tag) => {
        if (data[tag] !== undefined && data[tag] !== null) return data[tag];
        const lowerTag = tag.toLowerCase();
        for (const [key, val] of Object.entries(data)) {
            if (key.toLowerCase() === lowerTag && val !== undefined && val !== null) return val;
        }
        const snakeTag = tag.replace(/([A-Z])/g, '_$1').toLowerCase();
        if (data[snakeTag] !== undefined && data[snakeTag] !== null) return data[snakeTag];
        return match;
    });
};

const populateLetterDocx = async ({ buffer, templateData, letterType, employee, company }) => {
    const zip = new PizZip(buffer);
    let docXml = zip.file('word/document.xml')?.asText() || '';
    if (docXml) {
        // Normalize {{tag}} to {tag} so both bracket styles work in Word templates
        docXml = docXml.replace(/\{\{([^{}]+)\}\}/g, '{$1}');
        zip.file('word/document.xml', docXml);
    }

    const doc = new Docxtemplater(zip, {
        paragraphLoop: true,
        linebreaks: true,
        nullGetter: () => ''
    });

    const docData = {
        fullName: templateData.fullName,
        full_name: templateData.fullName,
        firstName: templateData.firstName,
        first_name: templateData.firstName,
        lastName: templateData.lastName,
        last_name: templateData.lastName,
        employeeCode: templateData.employeeCode,
        employee_code: templateData.employeeCode,
        employeeId: templateData.employeeCode,
        employee_id: templateData.employeeCode,
        designation: templateData.designation,
        department: templateData.department,
        joiningDate: templateData.joiningDate,
        joining_date: templateData.joiningDate,
        lastWorkingDay: templateData.lastWorkingDay,
        last_working_day: templateData.lastWorkingDay,
        exitType: templateData.exitType,
        exit_type: templateData.exitType,
        companyName: templateData.companyName,
        company_name: templateData.companyName,
        companyAddress: templateData.companyAddress,
        company_address: templateData.companyAddress,
        currentDate: templateData.currentDate,
        current_date: templateData.currentDate,
        currentYear: templateData.currentYear,
        current_year: templateData.currentYear,
        noticePeriodServed: templateData.noticePeriodServed,
        notice_period_served: templateData.noticePeriodServed,
        hrRemarks: templateData.hrRemarks,
        hr_remarks: templateData.hrRemarks
    };

    doc.render(docData);
    const populatedBuffer = doc.getZip().generate({ type: 'nodebuffer', compression: 'DEFLATE' });

    let htmlBody = '';
    try {
        const mammothRes = await mammoth.convertToHtml({ buffer: populatedBuffer });
        htmlBody = mammothRes.value || '';
    } catch (e) {
        console.warn('[OFFBOARDING] Mammoth conversion notice:', e.message);
    }

    return { populatedBuffer, htmlBody };
};

exports.previewLetter = async (req, res) => {
    try {
        const {
            userId,
            letterType = 'Relieving Letter',
            customBody,
            lastWorkingDay: customLastWorkingDay,
            exitType: customExitType
        } = req.body || {};

        let employee = null;
        let profile = null;
        let offboarding = null;

        if (userId && mongoose.isValidObjectId(userId)) {
            employee = await User.findOne({ _id: userId, companyId: req.companyId });
            profile = await EmployeeProfile.findOne({ user: userId, companyId: req.companyId });
            offboarding = await OffboardingRecord.findOne({ userId, companyId: req.companyId }).sort({ createdAt: -1 });
        }

        const company = await getCompanyForRequest(req);
        const resolvedLastWorkingDay = customLastWorkingDay || offboarding?.lastWorkingDay || new Date();
        const resolvedExitType = customExitType || offboarding?.exitType || 'Resignation';

        const templateData = {
            firstName: employee?.firstName || 'Employee',
            lastName: employee?.lastName || '',
            fullName: employee ? buildEmployeeName(employee) : 'Employee Name',
            email: employee?.email || 'employee@example.com',
            workEmail: profile?.contact?.workEmail || employee?.email || 'employee@company.com',
            personalEmail: profile?.contact?.personalEmail || '',
            employeeCode: employee?.employeeCode || profile?.employment?.employeeCode || 'EMP001',
            employeeId: employee?.employeeCode || profile?.employment?.employeeCode || 'EMP001',
            designation: employee ? getEmployeeDesignation(employee, profile) : 'Designation',
            jobTitle: employee ? getEmployeeDesignation(employee, profile) : 'Designation',
            department: employee ? getEmployeeDepartment(employee, profile) : 'Department',
            location: profile?.employment?.branch || employee?.workLocation || 'Headquarters',
            joiningDate: formatDateValue(getEmployeeJoiningDate(employee || {}, profile || {})),
            lastWorkingDay: formatDateValue(resolvedLastWorkingDay),
            exitType: resolvedExitType,
            companyName: company?.name || 'TalentCIO',
            companyAddress: buildCompanyAddressLine(company) || 'Headquarters',
            currentDate: formatDateValue(new Date()),
            currentYear: new Date().getFullYear().toString(),
            noticePeriodServed: offboarding?.noticePeriodServed ? 'Yes' : 'No',
            hrRemarks: offboarding?.hrRemarks || ''
        };

        const resolvedLetterType = ['Relieving Letter', 'Experience Letter'].includes(letterType)
            ? letterType
            : 'Relieving Letter';

        if (req.file && req.file.buffer) {
            const originalName = req.file.originalname || '';
            if (/\.docx$/i.test(originalName)) {
                const { htmlBody } = await populateLetterDocx({
                    buffer: req.file.buffer,
                    templateData,
                    letterType: resolvedLetterType,
                    employee: employee || { firstName: 'Employee' },
                    company
                });
                return res.json({
                    success: true,
                    html: htmlBody || '<p>Parsed Word document successfully.</p>'
                });
            } else if (/\.(html|htm)$/i.test(originalName)) {
                const text = req.file.buffer.toString('utf-8');
                return res.json({
                    success: true,
                    html: replaceTemplatePlaceholders(text, templateData)
                });
            } else {
                const text = req.file.buffer.toString('utf-8');
                const rendered = replaceTemplatePlaceholders(text, templateData)
                    .split('\n')
                    .map(l => `<p style="margin:0 0 8px;">${escapeHtml(l)}</p>`)
                    .join('');
                return res.json({ success: true, html: rendered });
            }
        }

        const defaultBody = resolvedLetterType === 'Relieving Letter' ? DEFAULT_RELIEVING_BODY : DEFAULT_EXPERIENCE_BODY;
        const bodyContent = String(customBody || defaultBody);
        const rendered = replaceTemplatePlaceholders(bodyContent, templateData);
        return res.json({ success: true, html: rendered });
    } catch (error) {
        console.error('Error previewing letter:', error);
        return res.status(500).json({ message: error.message || 'Failed to preview letter' });
    }
};

exports.generateAndSaveLetter = async (req, res) => {
    try {
        const {
            userId,
            offboardingId,
            letterType = 'Relieving Letter',
            customBody,
            lastWorkingDay: customLastWorkingDay,
            exitType: customExitType
        } = req.body || {};

        if (!userId) {
            return res.status(400).json({ message: 'userId is required' });
        }

        const employee = await User.findOne({ _id: userId, companyId: req.companyId });
        if (!employee) {
            return res.status(404).json({ message: 'Employee not found' });
        }

        const profile = await EmployeeProfile.findOne({ user: userId, companyId: req.companyId });
        if (!profile) {
            return res.status(404).json({ message: 'Employee profile not found' });
        }

        let offboarding = null;
        if (offboardingId && mongoose.isValidObjectId(offboardingId)) {
            offboarding = await OffboardingRecord.findOne({ _id: offboardingId, companyId: req.companyId });
        } else {
            offboarding = await OffboardingRecord.findOne({ userId, companyId: req.companyId }).sort({ createdAt: -1 });
        }

        const company = await getCompanyForRequest(req);
        const resolvedLastWorkingDay = customLastWorkingDay || offboarding?.lastWorkingDay || new Date();
        const resolvedExitType = customExitType || offboarding?.exitType || 'Resignation';

        const templateData = {
            firstName: employee.firstName || '',
            lastName: employee.lastName || '',
            fullName: buildEmployeeName(employee),
            email: employee.email || '',
            workEmail: profile.contact?.workEmail || employee.email || '',
            personalEmail: profile.contact?.personalEmail || '',
            employeeCode: employee.employeeCode || profile.employment?.employeeCode || 'N/A',
            employeeId: employee.employeeCode || profile.employment?.employeeCode || 'N/A',
            designation: getEmployeeDesignation(employee, profile),
            jobTitle: getEmployeeDesignation(employee, profile),
            department: getEmployeeDepartment(employee, profile),
            location: profile.employment?.branch || employee.workLocation || '',
            joiningDate: formatDateValue(getEmployeeJoiningDate(employee, profile)),
            lastWorkingDay: formatDateValue(resolvedLastWorkingDay),
            exitType: resolvedExitType,
            companyName: company?.name || 'TalentCIO',
            companyAddress: buildCompanyAddressLine(company) || '',
            currentDate: formatDateValue(new Date()),
            currentYear: new Date().getFullYear().toString(),
            noticePeriodServed: offboarding?.noticePeriodServed ? 'Yes' : 'No',
            hrRemarks: offboarding?.hrRemarks || ''
        };

        const resolvedLetterType = ['Relieving Letter', 'Experience Letter'].includes(letterType)
            ? letterType
            : (req.file?.originalname?.toLowerCase().includes('experience') ? 'Experience Letter' : 'Relieving Letter');

        let fileUrl = '';
        let generatedHtml = '';
        let fileName = '';
        const sentAt = new Date();

        if (req.file && req.file.buffer) {
            const originalName = req.file.originalname || 'letter_template';
            const isDocx = /\.docx$/i.test(originalName);
            const isHtml = /\.(html|htm)$/i.test(originalName);

            if (isDocx) {
                const { populatedBuffer, htmlBody } = await populateLetterDocx({
                    buffer: req.file.buffer,
                    templateData,
                    letterType: resolvedLetterType,
                    employee,
                    company
                });

                fileName = `${resolvedLetterType.replace(/[^a-zA-Z0-9]+/g, '_')}_${employee.employeeCode || 'doc'}.docx`;
                try {
                    fileUrl = await uploadBufferToCloudinary(
                        populatedBuffer,
                        fileName,
                        `talentcio/${req.companyId}/offboarding/${employee._id}`
                    );
                } catch (uploadError) {
                    console.error('[OFFBOARDING] Failed to upload docx letter to Cloudinary:', uploadError.message);
                }

                generatedHtml = `<!DOCTYPE html>
<html>
<head><meta charset="utf-8" /><title>${escapeHtml(resolvedLetterType)} - ${escapeHtml(buildEmployeeName(employee))}</title></head>
<body style="font-family:Arial,sans-serif;color:#111827;line-height:1.6;padding:32px;">
    ${buildLetterhead(company)}
    <div style="text-align:right;margin-bottom:24px;font-size:14px;">Date: ${formatDateValue(new Date())}</div>
    <h2 style="margin:0 0 20px;font-size:22px;">${escapeHtml(resolvedLetterType)}</h2>
    ${htmlBody || '<p>Populated Word template document.</p>'}
</body>
</html>`;
                if (!fileUrl) {
                    const fallbackHtmlDoc = await uploadHtmlDocumentToCloudinary({
                        companyId: req.companyId,
                        employeeId: employee._id,
                        documentType: resolvedLetterType,
                        html: generatedHtml
                    });
                    fileUrl = fallbackHtmlDoc.url;
                }
            } else if (isHtml) {
                const rawContent = req.file.buffer.toString('utf-8');
                const renderedBody = replaceTemplatePlaceholders(rawContent, templateData);
                generatedHtml = rawContent.includes('<html') ? renderedBody : `<!DOCTYPE html>
<html>
<head><meta charset="utf-8" /><title>${escapeHtml(resolvedLetterType)} - ${escapeHtml(buildEmployeeName(employee))}</title></head>
<body style="font-family:Arial,sans-serif;color:#111827;line-height:1.6;padding:32px;">
    ${buildLetterhead(company)}
    <div style="text-align:right;margin-bottom:24px;font-size:14px;">Date: ${formatDateValue(new Date())}</div>
    <h2 style="margin:0 0 20px;font-size:22px;">${escapeHtml(resolvedLetterType)}</h2>
    ${renderedBody}
</body>
</html>`;
                fileName = `${resolvedLetterType.replace(/[^a-zA-Z0-9]+/g, '_')}_${employee.employeeCode || 'doc'}.html`;
                const uploadedDoc = await uploadHtmlDocumentToCloudinary({
                    companyId: req.companyId,
                    employeeId: employee._id,
                    documentType: resolvedLetterType,
                    html: generatedHtml
                });
                fileUrl = uploadedDoc.url;
            } else {
                // Text file (.txt)
                const rawContent = req.file.buffer.toString('utf-8');
                const renderedBody = replaceTemplatePlaceholders(rawContent, templateData)
                    .split('\n')
                    .map(line => `<p style="margin: 0 0 10px;">${escapeHtml(line)}</p>`)
                    .join('');

                generatedHtml = `<!DOCTYPE html>
<html>
<head><meta charset="utf-8" /><title>${escapeHtml(resolvedLetterType)} - ${escapeHtml(buildEmployeeName(employee))}</title></head>
<body style="font-family:Arial,sans-serif;color:#111827;line-height:1.6;padding:32px;">
    ${buildLetterhead(company)}
    <div style="text-align:right;margin-bottom:24px;font-size:14px;">Date: ${formatDateValue(new Date())}</div>
    <h2 style="margin:0 0 20px;font-size:22px;">${escapeHtml(resolvedLetterType)}</h2>
    ${renderedBody}
</body>
</html>`;
                fileName = `${resolvedLetterType.replace(/[^a-zA-Z0-9]+/g, '_')}_${employee.employeeCode || 'doc'}.html`;
                const uploadedDoc = await uploadHtmlDocumentToCloudinary({
                    companyId: req.companyId,
                    employeeId: employee._id,
                    documentType: resolvedLetterType,
                    html: generatedHtml
                });
                fileUrl = uploadedDoc.url;
            }
        } else {
            // Direct template body
            const defaultBody = resolvedLetterType === 'Relieving Letter' ? DEFAULT_RELIEVING_BODY : DEFAULT_EXPERIENCE_BODY;
            const bodyContent = String(customBody || defaultBody);
            const renderedBody = replaceTemplatePlaceholders(bodyContent, templateData);

            generatedHtml = `<!DOCTYPE html>
<html>
<head><meta charset="utf-8" /><title>${escapeHtml(resolvedLetterType)} - ${escapeHtml(buildEmployeeName(employee))}</title></head>
<body style="font-family:Arial,sans-serif;color:#111827;line-height:1.6;padding:32px;">
    ${buildLetterhead(company)}
    <div style="text-align:right;margin-bottom:24px;font-size:14px;">Date: ${formatDateValue(new Date())}</div>
    <h2 style="margin:0 0 20px;font-size:22px;">${escapeHtml(resolvedLetterType)}</h2>
    ${renderedBody}
</body>
</html>`;
            fileName = `${resolvedLetterType.replace(/[^a-zA-Z0-9]+/g, '_')}_${employee.employeeCode || 'doc'}.html`;
            const uploadedDoc = await uploadHtmlDocumentToCloudinary({
                companyId: req.companyId,
                employeeId: employee._id,
                documentType: resolvedLetterType,
                html: generatedHtml
            });
            fileUrl = uploadedDoc.url;
        }

        const category = resolvedLetterType === 'Relieving Letter' ? 'Relieving Letter' : 'Employment';
        const title = `${resolvedLetterType} - ${buildEmployeeName(employee)}`;

        const docEntry = {
            category,
            title,
            fileName,
            url: fileUrl || '',
            uploadDate: sentAt,
            uploadedBy: req.user._id,
            verificationStatus: 'Verified'
        };

        profile.documents = Array.isArray(profile.documents) ? profile.documents : [];
        const existingIdx = profile.documents.findIndex(d => d.category === category && d.title === title);
        if (existingIdx >= 0) {
            profile.documents[existingIdx].url = fileUrl || profile.documents[existingIdx].url;
            profile.documents[existingIdx].fileName = fileName || profile.documents[existingIdx].fileName;
            profile.documents[existingIdx].uploadDate = sentAt;
            profile.documents[existingIdx].verificationStatus = 'Verified';
        } else {
            profile.documents.push(docEntry);
        }
        await profile.save();

        if (offboarding) {
            offboarding.documentsIssued.push({
                type: resolvedLetterType,
                sentAt,
                sentTo: profile.contact?.personalEmail || employee.email,
                sentBy: req.user._id,
                emailSubject: `${resolvedLetterType} Generated`,
                cloudinaryUrl: fileUrl || '',
                profileDocumentCategory: category,
                profileDocumentTitle: title,
                notes: 'Generated from template and archived to employee Dossier'
            });
            await offboarding.save();
        }

        const savedDoc = profile.documents[profile.documents.length - 1];

        return res.status(201).json({
            success: true,
            message: `${resolvedLetterType} generated and saved to employee's Dossier!`,
            document: {
                ...docEntry,
                _id: savedDoc?._id
            },
            html: generatedHtml,
            url: fileUrl || ''
        });
    } catch (error) {
        console.error('Error generating letter:', error);
        return res.status(500).json({ message: error.message || 'Internal server error' });
    }
};

exports.getDossierLetters = async (req, res) => {
    try {
        const { userId } = req.params;
        if (!userId || !mongoose.isValidObjectId(userId)) {
            return res.status(400).json({ message: 'Invalid userId' });
        }

        const profile = await EmployeeProfile.findOne({ user: userId, companyId: req.companyId })
            .select('documents user')
            .lean();

        if (!profile) {
            return res.status(404).json({ message: 'Employee profile not found' });
        }

        const allDocs = Array.isArray(profile.documents) ? profile.documents : [];
        const relevantDocs = allDocs.filter(d => {
            if (!d || d.isDeleted === true) return false;
            const category = String(d.category || '').toLowerCase();
            const title = String(d.title || '').toLowerCase();
            const fileName = String(d.fileName || '').toLowerCase();
            return category.includes('relieving') ||
                category.includes('experience') ||
                category.includes('employment') ||
                category.includes('exit') ||
                title.includes('relieving') ||
                title.includes('experience') ||
                title.includes('exit') ||
                title.includes('noc') ||
                title.includes('settlement') ||
                fileName.includes('relieving') ||
                fileName.includes('experience') ||
                fileName.includes('exit');
        }).map(d => ({
            _id: d._id,
            title: d.title || d.fileName || 'Untitled Document',
            category: d.category || 'Exit Document',
            fileName: d.fileName || 'document.html',
            url: d.url || '',
            uploadDate: d.uploadDate || d.createdAt,
            verificationStatus: d.verificationStatus || 'Verified'
        }));

        return res.json({
            success: true,
            letters: relevantDocs,
            documents: relevantDocs,
            total: relevantDocs.length
        });
    } catch (error) {
        console.error('Error fetching dossier letters:', error);
        return res.status(500).json({ message: 'Internal server error' });
    }
};

exports.sendDossierLetters = async (req, res) => {
    try {
        const { id } = req.params;
        const {
            dossierDocIds,
            recipientEmail,
            personalNote,
            emailAccountId,
            customSubject
        } = req.body || {};

        if (!Array.isArray(dossierDocIds) || dossierDocIds.length === 0) {
            return res.status(400).json({ message: 'Select at least one document from the dossier to send' });
        }

        let record = await OffboardingRecord.findOne({ _id: id, companyId: req.companyId })
            .populate('userId', 'firstName lastName email department employeeCode');

        if (!record && mongoose.isValidObjectId(id)) {
            record = await OffboardingRecord.findOne({ userId: id, companyId: req.companyId })
                .populate('userId', 'firstName lastName email department employeeCode')
                .sort({ createdAt: -1 });
        }

        if (!record) {
            return res.status(404).json({ message: 'Offboarding record not found' });
        }

        const employee = record.userId;
        const profile = await EmployeeProfile.findOne({ user: employee._id, companyId: req.companyId });
        if (!profile) {
            return res.status(404).json({ message: 'Employee profile not found' });
        }

        const company = await getCompanyForRequest(req);
        const resolvedRecipientEmail = String(
            recipientEmail ||
            profile.contact?.personalEmail ||
            employee.email ||
            ''
        ).trim();

        if (!resolvedRecipientEmail) {
            return res.status(400).json({ message: 'Recipient email is required' });
        }

        const idSet = new Set(dossierDocIds.map(dId => String(dId)));
        const allDocs = Array.isArray(profile.documents) ? profile.documents : [];
        const selectedDocs = allDocs.filter(d => idSet.has(String(d._id)) && d.url);

        if (selectedDocs.length === 0) {
            return res.status(400).json({ message: 'No valid documents found in the employee dossier matching selection' });
        }

        const attachments = [];
        for (const doc of selectedDocs) {
            if (doc.url && doc.url.startsWith('http')) {
                try {
                    const resp = await axios.get(doc.url, { responseType: 'arraybuffer', timeout: 20000 });
                    let filename = doc.fileName || doc.title || 'document';
                    if (!filename.includes('.')) {
                        if (doc.url.includes('.docx')) filename += '.docx';
                        else if (doc.url.includes('.pdf')) filename += '.pdf';
                        else filename += '.html';
                    }
                    const cleanName = filename.replace(/[^a-zA-Z0-9._-]+/g, '_');
                    attachments.push({
                        filename: cleanName,
                        content: Buffer.from(resp.data),
                        contentType: resp.headers['content-type'] || 'application/octet-stream'
                    });
                } catch (fetchErr) {
                    console.error(`[OFFBOARDING] Failed to download dossier document ${doc.title}:`, fetchErr.message);
                }
            }
        }

        if (attachments.length === 0) {
            return res.status(500).json({ message: 'Failed to retrieve selected documents from storage' });
        }

        const companyName = company?.name || 'TalentCIO';
        const docNames = selectedDocs.map(d => d.title || d.fileName).join(', ');
        const subject = customSubject || `Official Exit Documents from ${companyName}`;

        const emailHtml = `
            <div style="font-family:Arial,sans-serif;font-size:14px;line-height:1.7;color:#1f2937;">
                <p>Dear ${escapeHtml(buildEmployeeName(employee))},</p>
                <p>Please find attached your official exit documents from <strong>${escapeHtml(companyName)}</strong>:</p>
                <ul style="padding-left:20px;margin:12px 0;">
                    ${selectedDocs.map(d => `<li><strong>${escapeHtml(d.title || d.fileName)}</strong></li>`).join('')}
                </ul>
                ${personalNote ? `
                    <div style="margin:16px 0;padding:12px 14px;background:#f8fafc;border-left:4px solid #2563eb;">
                        <div style="font-weight:600;margin-bottom:4px;">Message from HR:</div>
                        <div>${escapeHtml(personalNote)}</div>
                    </div>
                ` : ''}
                <p>For any queries regarding your documents, please feel free to reach out to the HR department.</p>
                <p>Best wishes,<br />${escapeHtml(companyName)} HR Team</p>
            </div>
        `;

        const sent = await sendCompanyEmailWithFallback({
            companyId: req.companyId,
            emailAccountId,
            to: resolvedRecipientEmail,
            subject,
            html: emailHtml,
            text: `Your exit documents (${docNames}) are attached.`,
            attachments
        });

        if (!sent) {
            return res.status(500).json({ message: 'Failed to send exit documents via email' });
        }

        const sentAt = new Date();

        await HREmailLog.create({
            companyId: req.companyId,
            sentBy: req.user._id,
            recipientUserId: employee._id,
            recipientEmail: resolvedRecipientEmail,
            subject,
            body: emailHtml,
            type: 'offboarding',
            emailAccountId: emailAccountId || 'platform',
            emailAccountLabel: getSenderLabel(emailAccountId),
            attachments: selectedDocs.map(d => ({
                filename: d.fileName || d.title,
                cloudinaryUrl: d.url,
                publicId: extractPublicIdFromUrl(d.url) || '',
                dossierDocId: d._id
            })),
            sentAt
        });

        selectedDocs.forEach(d => {
            record.documentsIssued.push({
                type: d.category === 'Relieving Letter' ? 'Relieving Letter' : (d.title.includes('Experience') ? 'Experience Letter' : 'Other'),
                sentAt,
                sentTo: resolvedRecipientEmail,
                sentBy: req.user._id,
                emailAccountId: emailAccountId || 'platform',
                emailSubject: subject,
                cloudinaryUrl: d.url,
                profileDocumentCategory: d.category,
                profileDocumentTitle: d.title,
                notes: personalNote || 'Sent from employee dossier'
            });
        });

        if (record.status === 'Initiated') {
            record.status = 'In Progress';
        }

        await record.save();

        return res.json({
            success: true,
            sentTo: resolvedRecipientEmail,
            documentsSent: selectedDocs.map(d => d.title),
            attachmentsCount: attachments.length
        });
    } catch (error) {
        console.error('Error sending dossier letters:', error);
        return res.status(500).json({ message: 'Internal server error' });
    }
};

exports.getLetterTemplates = async (req, res) => {
    try {
        const company = await getCompanyForRequest(req);
        const relievingSettings = company?.settings?.offboarding?.relievingTemplate || {};
        const experienceSettings = company?.settings?.offboarding?.experienceTemplate || {};

        return res.json({
            success: true,
            templates: {
                'Relieving Letter': {
                    title: 'Relieving Letter',
                    body: relievingSettings.body || DEFAULT_RELIEVING_BODY,
                    fileUrl: relievingSettings.fileUrl || '',
                    fileName: relievingSettings.fileName || '',
                    updatedAt: relievingSettings.updatedAt || null
                },
                'Experience Letter': {
                    title: 'Experience Letter',
                    body: experienceSettings.body || DEFAULT_EXPERIENCE_BODY,
                    fileUrl: experienceSettings.fileUrl || '',
                    fileName: experienceSettings.fileName || '',
                    updatedAt: experienceSettings.updatedAt || null
                }
            }
        });
    } catch (error) {
        console.error('Error fetching offboarding templates:', error);
        return res.status(500).json({ message: 'Internal server error' });
    }
};

exports.saveLetterTemplate = async (req, res) => {
    try {
        const { letterType = 'Relieving Letter', body = '' } = req.body || {};
        const isRelieving = letterType.toLowerCase().includes('reliev');
        const targetKey = isRelieving ? 'relievingTemplate' : 'experienceTemplate';
        const defaultTitle = isRelieving ? 'Relieving Letter' : 'Experience Letter';

        const company = await Company.findById(req.companyId);
        if (!company) {
            return res.status(404).json({ message: 'Company not found' });
        }

        company.settings = company.settings || {};
        company.settings.offboarding = company.settings.offboarding || {};
        const existingTemplate = company.settings.offboarding[targetKey] || {};

        let fileUrl = existingTemplate.fileUrl || '';
        let fileName = existingTemplate.fileName || '';
        let publicId = existingTemplate.publicId || '';
        let extractedBody = body;

        if (req.file && req.file.buffer) {
            const originalName = req.file.originalname || `${targetKey}.docx`;
            const isDocx = /\.docx$/i.test(originalName);
            const isHtml = /\.(html|htm)$/i.test(originalName);

            fileName = originalName;

            if (isDocx) {
                try {
                    const mammothResult = await mammoth.convertToHtml({ buffer: req.file.buffer });
                    if (mammothResult && mammothResult.value && !body) {
                        extractedBody = mammothResult.value;
                    }
                } catch (mErr) {
                    console.warn('[OFFBOARDING] Failed to extract HTML from uploaded template docx:', mErr.message);
                }
                try {
                    fileUrl = await uploadBufferToCloudinary(
                        req.file.buffer,
                        originalName,
                        `talentcio/${req.companyId}/offboarding/templates`
                    );
                } catch (upErr) {
                    console.warn('[OFFBOARDING] Failed to upload template docx to Cloudinary:', upErr.message);
                }
            } else if (isHtml || /\.txt$/i.test(originalName)) {
                const fileContent = req.file.buffer.toString('utf-8');
                if (!body) {
                    extractedBody = fileContent;
                }
                try {
                    fileUrl = await uploadBufferToCloudinary(
                        req.file.buffer,
                        originalName,
                        `talentcio/${req.companyId}/offboarding/templates`
                    );
                } catch (upErr) {
                    console.warn('[OFFBOARDING] Failed to upload template to Cloudinary:', upErr.message);
                }
            }
        }

        company.settings.offboarding[targetKey] = {
            title: defaultTitle,
            body: extractedBody || (isRelieving ? DEFAULT_RELIEVING_BODY : DEFAULT_EXPERIENCE_BODY),
            fileUrl,
            fileName,
            publicId,
            updatedAt: new Date()
        };

        company.markModified('settings');
        await company.save();

        return res.json({
            success: true,
            message: `${defaultTitle} template saved successfully for future use.`,
            template: company.settings.offboarding[targetKey]
        });
    } catch (error) {
        console.error('Error saving offboarding template:', error);
        return res.status(500).json({ message: error.message || 'Failed to save offboarding template' });
    }
};

exports.generateBatchLetters = async (req, res) => {
    try {
        const {
            userId,
            offboardingId,
            letterTypes = ['Relieving Letter'],
            customBodies = {},
            lastWorkingDay: customLastWorkingDay,
            exitType: customExitType,
            saveToDossier = false
        } = req.body || {};

        if (!userId) {
            return res.status(400).json({ message: 'userId is required' });
        }

        const employee = await User.findOne({ _id: userId, companyId: req.companyId });
        if (!employee) {
            return res.status(404).json({ message: 'Employee not found' });
        }

        const profile = await EmployeeProfile.findOne({ user: userId, companyId: req.companyId });
        if (!profile) {
            return res.status(404).json({ message: 'Employee profile not found' });
        }

        let offboarding = null;
        if (offboardingId && mongoose.isValidObjectId(offboardingId)) {
            offboarding = await OffboardingRecord.findOne({ _id: offboardingId, companyId: req.companyId });
        } else {
            offboarding = await OffboardingRecord.findOne({ userId, companyId: req.companyId }).sort({ createdAt: -1 });
        }

        const company = await getCompanyForRequest(req);
        const resolvedLastWorkingDay = customLastWorkingDay || offboarding?.lastWorkingDay || new Date();
        const resolvedExitType = customExitType || offboarding?.exitType || 'Resignation';

        const templateData = {
            firstName: employee.firstName || '',
            lastName: employee.lastName || '',
            fullName: buildEmployeeName(employee),
            email: employee.email || '',
            workEmail: profile.contact?.workEmail || employee.email || '',
            personalEmail: profile.contact?.personalEmail || '',
            employeeCode: employee.employeeCode || profile.employment?.employeeCode || 'N/A',
            employeeId: employee.employeeCode || profile.employment?.employeeCode || 'N/A',
            designation: getEmployeeDesignation(employee, profile),
            jobTitle: getEmployeeDesignation(employee, profile),
            department: getEmployeeDepartment(employee, profile),
            location: profile.employment?.branch || employee.workLocation || '',
            joiningDate: formatDateValue(getEmployeeJoiningDate(employee, profile)),
            lastWorkingDay: formatDateValue(resolvedLastWorkingDay),
            exitType: resolvedExitType,
            companyName: company?.name || 'TalentCIO',
            companyAddress: buildCompanyAddressLine(company) || '',
            currentDate: formatDateValue(new Date()),
            currentYear: new Date().getFullYear().toString(),
            noticePeriodServed: offboarding?.noticePeriodServed ? 'Yes' : 'No',
            hrRemarks: offboarding?.hrRemarks || ''
        };

        const companyOffboardingSettings = company?.settings?.offboarding || {};
        const savedRelievingBody = companyOffboardingSettings?.relievingTemplate?.body || DEFAULT_RELIEVING_BODY;
        const savedExperienceBody = companyOffboardingSettings?.experienceTemplate?.body || DEFAULT_EXPERIENCE_BODY;

        const results = [];
        const rawTypes = Array.isArray(letterTypes) ? letterTypes : [letterTypes];
        const typesToGenerate = rawTypes.length > 0 ? rawTypes : ['Relieving Letter'];

        for (const type of typesToGenerate) {
            const isRelieving = String(type).toLowerCase().includes('reliev');
            const normalizedType = isRelieving ? 'Relieving Letter' : 'Experience Letter';
            const defaultBodyForType = isRelieving ? savedRelievingBody : savedExperienceBody;
            const chosenBody = (customBodies && customBodies[normalizedType]) || defaultBodyForType;

            const renderedBody = replaceTemplatePlaceholders(chosenBody, templateData);
            const generatedHtml = `<!DOCTYPE html>
<html>
<head><meta charset="utf-8" /><title>${escapeHtml(normalizedType)} - ${escapeHtml(buildEmployeeName(employee))}</title></head>
<body style="font-family:Arial,sans-serif;color:#111827;line-height:1.6;padding:32px;">
    ${buildLetterhead(company)}
    <div style="text-align:right;margin-bottom:24px;font-size:14px;">Date: ${formatDateValue(new Date())}</div>
    <h2 style="margin:0 0 20px;font-size:22px;">${escapeHtml(normalizedType)}</h2>
    ${renderedBody}
</body>
</html>`;

            let fileUrl = '';
            const fileName = `${normalizedType.replace(/[^a-zA-Z0-9]+/g, '_')}_${employee.employeeCode || 'doc'}.html`;

            if (saveToDossier) {
                const uploadedDoc = await uploadHtmlDocumentToCloudinary({
                    companyId: req.companyId,
                    employeeId: employee._id,
                    documentType: normalizedType,
                    html: generatedHtml
                });
                fileUrl = uploadedDoc.url;

                const category = isRelieving ? 'Relieving Letter' : 'Employment';
                const title = `${normalizedType} - ${buildEmployeeName(employee)}`;
                const sentAt = new Date();

                const docEntry = {
                    category,
                    title,
                    fileName,
                    url: fileUrl || '',
                    uploadDate: sentAt,
                    uploadedBy: req.user._id,
                    verificationStatus: 'Verified'
                };

                profile.documents = Array.isArray(profile.documents) ? profile.documents : [];
                const existingIdx = profile.documents.findIndex(d => d.category === category && d.title === title);
                if (existingIdx >= 0) {
                    profile.documents[existingIdx].url = fileUrl || profile.documents[existingIdx].url;
                    profile.documents[existingIdx].fileName = fileName || profile.documents[existingIdx].fileName;
                    profile.documents[existingIdx].uploadDate = sentAt;
                    profile.documents[existingIdx].verificationStatus = 'Verified';
                } else {
                    profile.documents.push(docEntry);
                }

                if (offboarding) {
                    offboarding.documentsIssued.push({
                        type: normalizedType,
                        sentAt,
                        sentTo: profile.contact?.personalEmail || employee.email,
                        sentBy: req.user._id,
                        emailSubject: `${normalizedType} Generated`,
                        cloudinaryUrl: fileUrl || '',
                        profileDocumentCategory: category,
                        profileDocumentTitle: title,
                        notes: 'Generated from template and saved to employee Dossier'
                    });
                }
            }

            results.push({
                type: normalizedType,
                title: `${normalizedType} - ${buildEmployeeName(employee)}`,
                fileName,
                url: fileUrl,
                html: generatedHtml,
                savedToDossier: !!saveToDossier
            });
        }

        if (saveToDossier) {
            await profile.save();
            if (offboarding) {
                await offboarding.save();
            }
        }

        return res.json({
            success: true,
            message: saveToDossier
                ? `${results.length} letter(s) successfully generated and saved to employee's Dossier.`
                : `${results.length} letter preview(s) generated successfully.`,
            letters: results
        });
    } catch (error) {
        console.error('Error in generateBatchLetters:', error);
        return res.status(500).json({ message: error.message || 'Failed to generate letters' });
    }
};
