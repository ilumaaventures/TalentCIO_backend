const OnboardingEmployee = require('../models/OnboardingEmployee');
const Company = require('../models/Company');
const Candidate = require('../models/Candidate');
const { sendEmail } = require('../services/emailService');
const NotificationService = require('../services/notificationService');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const { cloudinary } = require('../config/cloudinary');
const archiver = require('archiver');
const axios = require('axios');
const Docxtemplater = require('docxtemplater');
const PizZip = require('pizzip');
const mammoth = require('mammoth');
const fs = require('fs');
const path = require('path');

// ==========================================
// TA SYNC HELPER — silently update phase3Decision on the sourced candidate
// ==========================================
const syncTADecision = async (employee, decision) => {
    if (!employee.sourcedFromTA || !employee.candidateId) return;
    try {
        await Candidate.findByIdAndUpdate(employee.candidateId, { phase3Decision: decision });
    } catch (err) {
        console.error('[syncTADecision] Failed to sync TA decision:', err.message);
    }
};

// ==========================================
// HR ADMIN ENDPOINTS
// ==========================================

// Generate a random alphanumeric password
const generateTempPassword = (length = 10) => {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
    let password = '';
    for (let i = 0; i < length; i++) {
        password += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return password;
};

const formatDate = (date) => {
    if (!date) return '';
    return new Date(date).toLocaleDateString('en-IN', { day: '2-digit', month: 'long', year: 'numeric' });
};

const formatCurrency = (val) => {
    if (!val) return '—';
    const num = parseFloat(String(val).replace(/[^0-9.]/g, ''));
    if (isNaN(num)) return val;
    return '₹ ' + num.toLocaleString('en-IN');
};

const getTemplateContent = async (customUrl, defaultPath) => {
    try {
        if (customUrl && typeof customUrl === 'string' && customUrl.startsWith('http')) {
            console.log('Fetching custom template from:', customUrl);
            const response = await axios.get(customUrl, { responseType: 'arraybuffer' });
            return response.data;
        }
    } catch (err) {
        console.error('Failed to fetch remote template, falling back to default:', err.message);
    }

    if (!fs.existsSync(defaultPath)) {
        throw new Error(`Default template not found at ${defaultPath}. Please run the template generation script.`);
    }
    return fs.readFileSync(defaultPath, 'binary');
};

// --- Add a new onboarding employee ---
exports.addEmployee = async (req, res) => {
    try {
        const { firstName, lastName, email, phone, designation, department, joiningDate, offerDate, documentDeadline, offerLetterUrl, offerLetterPublicId, address, workLocation, probationPeriod, salary } = req.body;

        if (!firstName || !email) {
            return res.status(400).json({ message: 'First name and email are required' });
        }

        // Check duplicate email within same company
        const existing = await OnboardingEmployee.findOne({ email, companyId: req.companyId });
        if (existing) {
            return res.status(400).json({ message: 'An onboarding entry with this email already exists' });
        }

        const tempEmployeeId = await OnboardingEmployee.generateTempId(req.companyId);
        const rawPassword = generateTempPassword();

        // Default document slots
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
            { type: 'experience_certificate', label: 'Experience Certificate' },
            { type: 'passport_photo', label: 'Recent Passport-Size Photograph' }
        ];

        const employee = new OnboardingEmployee({
            tempEmployeeId,
            tempPassword: rawPassword,
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
            probationPeriod: probationPeriod || '6 months',
            salary: salary || {},
            credentialsExpireAt: documentDeadline || undefined,
            offerLetterUrl: offerLetterUrl || '',
            offerLetterPublicId: offerLetterPublicId || '',
            documents: defaultDocuments,
            companyId: req.companyId,
            createdBy: req.user._id,
            requestedSections: [],
            requestedDocuments: [],
            auditLog: [{ action: 'CREATED', details: `Created by ${req.user.firstName || 'Admin'}` }]
        });

        await employee.save();

        // Email sending removed. Email will be sent when HR triggers "Send Pre-Onboarding Email" with selected sections.

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

// --- Send selective pre-onboarding email ---
exports.sendPreOnboardingEmail = async (req, res) => {
    try {
        const { sections, documents, submissionDeadline } = req.body;

        if ((!sections || sections.length === 0) && (!documents || documents.length === 0)) {
            return res.status(400).json({ message: 'Please select at least one section or document' });
        }

        const employee = await OnboardingEmployee.findOne({ _id: req.params.id, companyId: req.companyId });
        if (!employee) {
            return res.status(404).json({ message: 'Employee not found' });
        }

        // Update deadline if provided
        if (submissionDeadline) {
            employee.documentDeadline = new Date(submissionDeadline);
            // Also update credential expiry to match the deadline (if not already further ahead)
            employee.credentialsExpireAt = new Date(submissionDeadline);
        }

        // Save requested items for portal filtering (additive merge with timestamps)
        const sectionsData = employee.requestedSections || [];
        (sections || []).forEach(s => {
            const found = sectionsData.find(rs => rs.label === s);
            if (found) {
                found.emailSentAt = new Date();
            } else {
                sectionsData.push({ label: s, emailSentAt: new Date() });
            }
        });
        employee.requestedSections = sectionsData;

        const docsData = employee.requestedDocuments || [];
        (documents || []).forEach(d => {
            const found = docsData.find(rd => rd.label === d);
            if (found) {
                found.emailSentAt = new Date();
            } else {
                docsData.push({ label: d, emailSentAt: new Date() });
            }
        });
        employee.requestedDocuments = docsData;

        // Mark emailed documents as "Mail Sent" if they are still Pending
        if (documents && documents.length > 0) {
            const docLabelsSet = new Set(documents);
            employee.documents.forEach(doc => {
                if (docLabelsSet.has(doc.label) && (doc.status === 'Pending' || doc.status === 'Mail Sent')) {
                    doc.status = 'Mail Sent';
                    doc.emailSentAt = new Date();
                }
            });
        }

        // If employee already submitted, re-open for editing on new sections
        if (employee.status === 'Submitted' || employee.status === 'Reviewed') {
            employee.status = 'In Progress';
            employee.submittedAt = null;
            employee.auditLog.push({
                action: 'REOPENED',
                details: `Re-opened by HR for additional sections/documents`
            });
        }

        await employee.save();

        const portalUrl = `${req.headers.origin || process.env.FRONTEND_URL || 'http://localhost:5173'}/pre-onboarding/login`;

        // Credentials Logic - include original ID and password (regenerate if not changed yet)
        let credentialsHtml = '';
        let rawPassword = '';
        if (employee.isPasswordChanged === false) {
            rawPassword = generateTempPassword();
            employee.tempPassword = rawPassword; // Hooks will hash it
            await employee.save();
            credentialsHtml = `
                <div style="background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 8px; padding: 20px; margin: 24px 0;">
                    <h3 style="color: #1e293b; font-size: 15px; margin: 0 0 12px; font-weight: 700;">🔑 Your Login Credentials</h3>
                    <p style="margin: 4px 0; font-size: 14px;"><strong>Employee ID:</strong> <code style="background: #e0e7ff; padding: 2px 8px; border-radius: 4px; font-size: 16px;">${employee.tempEmployeeId}</code></p>
                    <p style="margin: 4px 0; font-size: 14px;"><strong>Temporary Password:</strong> <code style="background: #e0e7ff; padding: 2px 8px; border-radius: 4px; font-size: 16px;">${rawPassword}</code></p>
                    ${employee.credentialsExpireAt ? `
                    <p style="margin: 12px 0 0; font-size: 13px; color: #dc2626;"><strong>⏳ Credentials Expire On:</strong> ${new Date(employee.credentialsExpireAt).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })}</p>
                    ` : ''}
                    <p style="color: #64748b; font-size: 12px; margin-top: 8px;">⚠️ You will be asked to change your password on first login. Please keep these credentials secure.</p>
                </div>
            `;
        } else {
            credentialsHtml = `
                <div style="background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 8px; padding: 20px; margin: 24px 0;">
                    <h3 style="color: #1e293b; font-size: 15px; margin: 0 0 12px; font-weight: 700;">🔑 Portal Access</h3>
                    <p style="margin: 4px 0; font-size: 14px;"><strong>Employee ID:</strong> <code style="background: #e0e7ff; padding: 2px 8px; border-radius: 4px; font-size: 16px;">${employee.tempEmployeeId}</code></p>
                    <p style="margin: 4px 0; font-size: 14px;">Please use the <strong>password you previously set</strong> to log in.</p>
                </div>
            `;
        }

        // Build sections list HTML
        let sectionsHtml = '';
        if (sections && sections.length > 0) {
            sectionsHtml = `
                <div style="margin-bottom: 24px;">
                    <h3 style="color: #1e293b; font-size: 16px; margin: 0 0 12px; border-bottom: 2px solid #3b82f6; padding-bottom: 8px;">📋 Forms to Complete</h3>
                    <ul style="margin: 0; padding: 0 0 0 20px; color: #334155;">
                        ${sections.map(s => `<li style="padding: 6px 0; font-size: 14px;">${s}</li>`).join('')}
                    </ul>
                </div>
            `;
        }

        // Build documents list HTML
        let documentsHtml = '';
        if (documents && documents.length > 0) {
            documentsHtml = `
                <div style="margin-bottom: 24px;">
                    <h3 style="color: #1e293b; font-size: 16px; margin: 0 0 12px; border-bottom: 2px solid #8b5cf6; padding-bottom: 8px;">📎 Items to Complete</h3>
                    <ul style="margin: 0; padding: 0 0 0 20px; color: #334155;">
                        ${documents.map(d => `<li style="padding: 6px 0; font-size: 14px;">${d}</li>`).join('')}
                    </ul>
                </div>
            `;
        }

        const deadlineStr = employee.documentDeadline
            ? new Date(employee.documentDeadline).toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric' })
            : 'Not specified';

        const emailHtml = `
            <div style="font-family: 'Segoe UI', Arial, sans-serif; max-width: 600px; margin: auto; border: 1px solid #e2e8f0; border-radius: 12px; overflow: hidden;">
                <div style="background: linear-gradient(135deg, #2563eb, #7c3aed); padding: 32px; text-align: center;">
                    <h1 style="color: white; margin: 0; font-size: 22px;">Pre-Onboarding Action Required</h1>
                    <p style="color: #e0e7ff; margin-top: 8px; font-size: 14px;">Please complete the following items on your portal</p>
                </div>
                <div style="padding: 32px;">
                    <p>Hello <strong>${employee.firstName}</strong>,</p>
                    <p style="color: #475569;">Your HR team has requested that you complete the following items on the pre-onboarding portal before your joining date.</p>

                    ${credentialsHtml}
                    ${sectionsHtml}
                    ${documentsHtml}

                    <div style="background: #fffbeb; border: 1px solid #fde68a; border-radius: 8px; padding: 14px; margin: 20px 0; font-size: 13px; color: #92400e;">
                        ⏰ <strong>Submission Deadline:</strong> ${deadlineStr}
                    </div>

                    <div style="text-align: center; margin: 28px 0;">
                        <a href="${portalUrl}" style="background: linear-gradient(135deg, #2563eb, #7c3aed); color: white; text-decoration: none; padding: 14px 32px; border-radius: 8px; font-weight: bold; display: inline-block; font-size: 15px;">Open Pre-Onboarding Portal</a>
                    </div>
                </div>
                <div style="background: #f1f5f9; padding: 16px; text-align: center; color: #94a3b8; font-size: 12px;">
                    © ${new Date().getFullYear()} TalentCio. All rights reserved.
                </div>
            </div>
        `;

        await sendEmail({
            to: employee.email,
            subject: `Action Required: Complete Your Pre-Onboarding – ${employee.tempEmployeeId}`,
            html: emailHtml
        });

        // Add audit log
        await OnboardingEmployee.findByIdAndUpdate(employee._id, {
            $push: {
                auditLog: {
                    action: 'PRE_ONBOARD_EMAIL_SENT',
                    details: `Email sent with ${(sections || []).length} section(s) and ${(documents || []).length} document(s)`
                }
            }
        });

        // Sync TA phase3Decision → 'Offer Sent' if offer letter was included in this email
        const includesOfferLetter = (documents || []).some(d =>
            /offer\s*letter/i.test(d) || /offer[-_]letter/i.test(d)
        ) || (sections || []).some(s =>
            /offer\s*letter/i.test(s) || /offer[-_]letter/i.test(s)
        );
        if (includesOfferLetter) {
            await syncTADecision(employee, 'Offer Sent');
        }

        res.json({ message: 'Pre-onboarding email sent successfully', employee });
    } catch (error) {
        console.error('Error sending pre-onboarding email:', error);
        res.status(500).json({ message: 'Failed to send email', error: error.message });
    }
};

// --- Send custom file(s) to candidate ---
exports.sendCustomFile = async (req, res) => {
    try {
        const { id } = req.params;
        const employee = await OnboardingEmployee.findOne({ _id: id, companyId: req.companyId });
        if (!employee) return res.status(404).json({ message: 'Employee not found' });

        const files = req.files || [];
        if (files.length === 0) {
            return res.status(400).json({ message: 'No files uploaded' });
        }

        const fileNamesList = files.map(f => `<li><strong>${f.originalname}</strong></li>`).join('');
        const fileCountText = files.length === 1 ? 'a document' : `${files.length} documents`;

        const emailHtml = `
            <div style="font-family: sans-serif; max-width: 600px; margin: auto; border: 1px solid #e2e8f0; border-radius: 12px; padding: 24px;">
                <h2 style="color: #2563eb; margin: 0 0 16px;">New Document(s) from HR</h2>
                <p>Hello <strong>${employee.firstName}</strong>,</p>
                <p>Your HR team has sent you ${fileCountText} regarding your onboarding process.</p>
                <p>Please find the attached files:</p>
                <ul>
                    ${fileNamesList}
                </ul>
                <hr style="border: none; border-top: 1px solid #eee; margin: 24px 0;">
                <p style="font-size: 12px; color: #94a3b8; text-align: center;">© ${new Date().getFullYear()} TalentCio. All rights reserved.</p>
            </div>
        `;

        const attachments = files.map(f => ({
            filename: f.originalname,
            path: f.path
        }));

        const sent = await sendEmail({
            to: employee.email,
            subject: `Action Required: New ${files.length > 1 ? 'Documents' : 'Document'} for Your Onboarding`,
            html: emailHtml,
            attachments
        });

        if (!sent) {
            return res.status(500).json({ message: 'Failed to send email' });
        }

        // Add audit log entries
        files.forEach(f => {
            employee.auditLog.push({
                action: 'CUSTOM_FILE_SENT',
                details: `File "${f.originalname}" sent to candidate's email by HR`
            });
        });
        await employee.save();

        res.json({ message: `${files.length} file(s) sent successfully to candidate email` });
    } catch (error) {
        console.error('Error sending custom file(s):', error);
        res.status(500).json({ message: 'Server error', error: error.message });
    }
};

// --- Bulk add employees ---
exports.bulkAddEmployees = async (req, res) => {
    try {
        const { employees } = req.body;
        if (!employees || !Array.isArray(employees) || employees.length === 0) {
            return res.status(400).json({ message: 'An array of employees is required' });
        }

        const results = [];
        const errors = [];

        for (const emp of employees) {
            try {
                const existing = await OnboardingEmployee.findOne({ email: emp.email, companyId: req.companyId });
                if (existing) {
                    errors.push({ email: emp.email, reason: 'Already exists' });
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
                    { type: 'experience_certificate', label: 'Experience Certificate' },
                    { type: 'passport_photo', label: 'Recent Passport-Size Photograph' }
                ];

                const employee = new OnboardingEmployee({
                    tempEmployeeId,
                    tempPassword: rawPassword,
                    firstName: emp.firstName,
                    lastName: emp.lastName || '',
                    email: emp.email,
                    phone: emp.phone || '',
                    designation: emp.designation || '',
                    department: emp.department || '',
                    joiningDate: emp.joiningDate || undefined,
                    documentDeadline: emp.documentDeadline || undefined,
                    workLocation: emp.workLocation || '',
                    address: emp.address || '',
                    probationPeriod: emp.probationPeriod || '6 months',
                    credentialsExpireAt: emp.documentDeadline || undefined,
                    documents: defaultDocuments,
                    companyId: req.companyId,
                    createdBy: req.user._id,
                    auditLog: [{ action: 'CREATED', details: 'Bulk created' }]
                });

                await employee.save();

                // Email sending removed. Email will be sent via "Send Pre-Onboarding Email" action.

                results.push({ email: emp.email, tempEmployeeId, status: 'Created' });
            } catch (innerErr) {
                errors.push({ email: emp.email, reason: innerErr.message });
            }
        }

        res.status(201).json({ message: `Processed ${results.length + errors.length} employees`, created: results, errors });
    } catch (error) {
        console.error('Error in bulk add:', error);
        res.status(500).json({ message: 'Server error', error: error.message });
    }
};

// --- Get all onboarding employees ---
exports.getOnboardingList = async (req, res) => {
    try {
        res.set('Cache-Control', 'private, max-age=30, stale-while-revalidate=30');
        const { status, page = 1, limit = 20, search } = req.query;
        let query = { companyId: req.companyId };

        if (status && status !== 'All') query.status = status;
        if (search) {
            query.$or = [
                { firstName: { $regex: search, $options: 'i' } },
                { lastName: { $regex: search, $options: 'i' } },
                { email: { $regex: search, $options: 'i' } },
                { tempEmployeeId: { $regex: search, $options: 'i' } }
            ];
        }

        const pageNum = parseInt(page);
        const limitNum = parseInt(limit);
        const skip = (pageNum - 1) * limitNum;

        const [employees, total] = await Promise.all([
            OnboardingEmployee.find(query)
                .select('-tempPassword -auditLog')
                .populate('createdBy', 'firstName lastName')
                .sort({ createdAt: -1 })
                .skip(skip)
                .limit(limitNum)
                .lean(),
            OnboardingEmployee.countDocuments(query)
        ]);

        // Get stats
        const stats = await OnboardingEmployee.aggregate([
            { $match: { companyId: require('mongoose').Types.ObjectId.createFromHexString(req.companyId.toString()) } },
            { $group: { _id: '$status', count: { $sum: 1 } } }
        ]);

        const statusCounts = { Pending: 0, Accepted: 0, 'In Progress': 0, Submitted: 0, Reviewed: 0 };
        stats.forEach(s => { statusCounts[s._id] = s.count; });

        res.status(200).json({
            employees,
            total,
            totalPages: Math.ceil(total / limitNum),
            currentPage: pageNum,
            stats: statusCounts
        });
    } catch (error) {
        console.error('Error fetching onboarding list:', error);
        res.status(500).json({ message: 'Server error', error: error.message });
    }
};

// --- Get single onboarding employee ---
exports.getOnboardingEmployee = async (req, res) => {
    try {
        const employee = await OnboardingEmployee.findOne({ _id: req.params.id, companyId: req.companyId })
            .select('-tempPassword')
            .populate('createdBy', 'firstName lastName')
            .lean();

        if (!employee) return res.status(404).json({ message: 'Onboarding employee not found' });

        res.status(200).json(employee);
    } catch (error) {
        console.error('Error fetching onboarding employee:', error);
        res.status(500).json({ message: 'Server error', error: error.message });
    }
};

// --- Update onboarding employee details ---
exports.updateEmployee = async (req, res) => {
    try {
        const { firstName, lastName, email, phone, designation, department, joiningDate, offerDate, documentDeadline, workLocation, address, probationPeriod, salary } = req.body;

        const employee = await OnboardingEmployee.findOne({ _id: req.params.id, companyId: req.companyId });
        if (!employee) return res.status(404).json({ message: 'Employee not found' });

        // Update fields
        if (firstName) employee.firstName = firstName;
        if (lastName) employee.lastName = lastName;
        if (email) employee.email = email;
        if (phone) employee.phone = phone;
        if (designation) employee.designation = designation;
        if (department) employee.department = department;
        if (joiningDate) employee.joiningDate = joiningDate;
        if (offerDate) employee.offerDate = offerDate;
        if (documentDeadline) employee.documentDeadline = documentDeadline;
        if (workLocation) employee.workLocation = workLocation;
        if (address) employee.address = address;
        if (probationPeriod) employee.probationPeriod = probationPeriod;
        if (salary) {
            employee.salary = { ...employee.salary.toObject(), ...salary };
        }

        // Add audit log
        employee.auditLog.push({
            action: 'DETAILS_UPDATED',
            details: `Details updated by ${req.user.firstName || 'Admin'}`
        });

        await employee.save();
        res.status(200).json({ message: 'Employee updated successfully', employee });
    } catch (error) {
        console.error('Error updating employee:', error);
        res.status(500).json({ message: 'Server error', error: error.message });
    }
};

// --- Regenerate temporary credentials ---
exports.regenerateCredentials = async (req, res) => {
    try {
        const employee = await OnboardingEmployee.findOne({ _id: req.params.id, companyId: req.companyId });
        if (!employee) return res.status(404).json({ message: 'Employee not found' });

        const newPassword = Math.random().toString(36).slice(-8);
        employee.tempPassword = newPassword;

        // Reset expiry to 7 days from now
        const expiry = new Date();
        expiry.setDate(expiry.getDate() + 7);
        employee.credentialsExpireAt = expiry;

        // Clear any pending regeneration request
        if (employee.credentialRegenerationRequest) {
            employee.credentialRegenerationRequest.requested = false;
        }

        // Add audit log
        employee.auditLog.push({
            action: 'CREDENTIALS_REGENERATED',
            details: `Credentials regenerated by ${req.user.firstName || 'Admin'}`
        });

        await employee.save();

        // Email logic removed per requirements; credentials will be sent when 'Send Pre-Onboarding Email' is triggered.

        res.status(200).json({
            message: 'Credentials regenerated successfully.',
            tempEmployeeId: employee.tempEmployeeId,
            tempPassword: newPassword,
            expiry
        });
    } catch (error) {
        console.error('Error regenerating credentials:', error);
        res.status(500).json({ message: 'Server error', error: error.message });
    }
};

// --- Flag a document for re-upload ---
exports.flagDocument = async (req, res) => {
    try {
        const { id, docId } = req.params;
        const { reason } = req.body;

        const employee = await OnboardingEmployee.findOne({ _id: id, companyId: req.companyId });
        if (!employee) return res.status(404).json({ message: 'Not found' });

        const doc = employee.documents.id(docId);
        if (!doc) return res.status(404).json({ message: 'Document not found' });

        doc.status = 'Re-upload Required';
        doc.rejectionReason = reason || 'Please re-upload this document';

        // If the form was submitted, reopen it
        if (employee.status === 'Submitted' || employee.status === 'Reviewed') {
            employee.status = 'In Progress';
            employee.submittedAt = null;
            // Also reopen the declaration section to ensure re-signing
            if (employee.offerDeclaration) {
                employee.offerDeclaration.isComplete = false;
            }
        }

        employee.auditLog.push({ action: 'DOCUMENT_FLAGGED', details: `${doc.label} flagged: ${reason}` });
        await employee.save();

        // Check if all uploaded documents are now reviewed to send consolidated notification
        const pendingReview = employee.documents.filter(d => d.status === 'Uploaded');
        if (pendingReview.length === 0) {
            const flaggedDocs = employee.documents.filter(d => d.status === 'Re-upload Required');
            if (flaggedDocs.length > 0) {
                // Send consolidated email
                const flaggedListHtml = flaggedDocs.map(fd => `
                    <div style="background: #fff5f5; border-left: 4px solid #f56565; padding: 12px; margin-bottom: 8px;">
                        <strong style="color: #c53030;">${fd.label}</strong><br/>
                        <span style="color: #718096; font-size: 13px;">Reason: ${fd.rejectionReason}</span>
                    </div>
                `).join('');

                await sendEmail({
                    to: employee.email,
                    subject: `Action Required: Document Updates Needed for Your Onboarding`,
                    html: `
                        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: auto; padding: 20px; border: 1px solid #e2e8f0; border-radius: 10px;">
                            <h2 style="color: #e53e3e;">Document Updates Required</h2>
                            <p>Hello ${employee.firstName},</p>
                            <p>During the review of your pre-onboarding submission, some documents were found to require updates or re-uploads:</p>
                            ${flaggedListHtml}
                            <p style="margin-top: 20px;">Please log in to your <a href="${process.env.FRONTEND_URL || 'http://localhost:5173'}/pre-onboarding/login" style="color: #3182ce; font-weight: bold; text-decoration: none;">Pre-Onboarding Portal</a> to upload the corrected documents.</p>
                            <p>Once you've uploaded all the required items, please resubmit the form.</p>
                        </div>
                    `
                });
            }
        }

        res.status(200).json({ message: 'Document flagged for re-upload', document: doc, employee });
    } catch (error) {
        console.error('Error flagging document:', error);
        res.status(500).json({ message: 'Server error', error: error.message });
    }
};

// --- Approve a document ---
exports.approveDocument = async (req, res) => {
    try {
        const { id, docId } = req.params;

        const employee = await OnboardingEmployee.findOne({ _id: id, companyId: req.companyId });
        if (!employee) return res.status(404).json({ message: 'Not found' });

        const doc = employee.documents.id(docId);
        if (!doc) return res.status(404).json({ message: 'Document not found' });

        doc.status = 'Approved';
        doc.rejectionReason = '';

        // Check if all uploaded docs are approved, then mark as Accepted (previously Reviewed)
        const allReviewedStatus = employee.documents.every(d =>
            d.status === 'Approved' || d.status === 'Pending' || d.status === 'Mail Sent'
        );
        if (allReviewedStatus && employee.status === 'Submitted') {
            employee.status = 'Accepted';
        }

        employee.auditLog.push({ action: 'DOCUMENT_APPROVED', details: `${doc.label} approved` });
        await employee.save();

        // Sync TA phase3Decision → 'Joined' if all uploaded documents are now Approved
        const uploadedDocs = employee.documents.filter(d => d.url);
        const allApproved = uploadedDocs.length > 0 && uploadedDocs.every(d => d.status === 'Approved');
        if (allApproved) {
            await syncTADecision(employee, 'Joined');
        }

        // Check for consolidated notification if all uploaded docs are now reviewed
        const pendingReview = employee.documents.filter(d => d.status === 'Uploaded');
        if (pendingReview.length === 0) {
            const flaggedDocs = employee.documents.filter(d => d.status === 'Re-upload Required');
            if (flaggedDocs.length > 0) {
                const flaggedListHtml = flaggedDocs.map(fd => `
                    <div style="background: #fff5f5; border-left: 4px solid #f56565; padding: 12px; margin-bottom: 8px;">
                        <strong style="color: #c53030;">${fd.label}</strong><br/>
                        <span style="color: #718096; font-size: 13px;">Reason: ${fd.rejectionReason}</span>
                    </div>
                `).join('');

                await sendEmail({
                    to: employee.email,
                    subject: `Action Required: Document Updates Needed for Your Onboarding`,
                    html: `
                        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: auto; padding: 20px; border: 1px solid #e2e8f0; border-radius: 10px;">
                            <h2 style="color: #e53e3e;">Document Updates Required</h2>
                            <p>Hello ${employee.firstName},</p>
                            <p>During the review of your pre-onboarding submission, some documents were found to require updates or re-uploads:</p>
                            ${flaggedListHtml}
                            <p style="margin-top: 20px;">Please log in to your <a href="${process.env.FRONTEND_URL || 'http://localhost:5173'}/pre-onboarding/login" style="color: #3182ce; font-weight: bold; text-decoration: none;">Pre-Onboarding Portal</a> to upload the corrected documents.</p>
                            <p>Once you've uploaded all the required items, please resubmit the form.</p>
                        </div>
                    `
                });
            }
        }

        res.status(200).json({ message: 'Document approved', document: doc, employee });
    } catch (error) {
        console.error('Error approving document:', error);
        res.status(500).json({ message: 'Server error', error: error.message });
    }
};

// --- Download all documents as ZIP ---
exports.downloadAllDocuments = async (req, res) => {
    try {
        const employee = await OnboardingEmployee.findOne({ _id: req.params.id, companyId: req.companyId }).lean();
        if (!employee) return res.status(404).json({ message: 'Not found' });

        const uploadedDocs = employee.documents.filter(d => d.url);
        if (uploadedDocs.length === 0) {
            return res.status(400).json({ message: 'No documents uploaded yet' });
        }

        res.setHeader('Content-Type', 'application/zip');
        res.setHeader('Content-Disposition', `attachment; filename=${employee.tempEmployeeId}_documents.zip`);

        const archive = archiver('zip', { zlib: { level: 9 } });
        archive.pipe(res);

        for (const doc of uploadedDocs) {
            try {
                const response = await axios.get(doc.url, { responseType: 'stream' });
                const ext = doc.url.split('.').pop().split('?')[0] || 'pdf';
                archive.append(response.data, { name: `${doc.label.replace(/[^a-zA-Z0-9]/g, '_')}.${ext}` });
            } catch (downloadErr) {
                console.error(`Error downloading ${doc.label}:`, downloadErr.message);
            }
        }

        // Add bank cheque if present
        if (employee.bankDetails?.cancelledChequeUrl) {
            try {
                const response = await axios.get(employee.bankDetails.cancelledChequeUrl, { responseType: 'stream' });
                const ext = employee.bankDetails.cancelledChequeUrl.split('.').pop().split('?')[0] || 'pdf';
                archive.append(response.data, { name: `Cancelled_Cheque.${ext}` });
            } catch (e) { /* skip */ }
        }

        await archive.finalize();
    } catch (error) {
        console.error('Error generating ZIP:', error);
        res.status(500).json({ message: 'Server error', error: error.message });
    }
};


// ==========================================
// EMPLOYEE SELF-SERVICE ENDPOINTS
// ==========================================

// --- Employee Login ---
exports.employeeLogin = async (req, res) => {
    try {
        const { tempEmployeeId, password } = req.body;

        if (!tempEmployeeId || !password) {
            return res.status(400).json({ message: 'Employee ID and password are required' });
        }

        // Fetch the corresponding company if the frontend provides a tenant ID
        let query = { tempEmployeeId };
        const tenantId = req.headers['x-tenant-id'];

        if (tenantId) {
            const company = await Company.findOne({ tenantId });
            if (company) {
                query.companyId = company._id;
            }
        }

        const employees = await OnboardingEmployee.find(query);
        if (employees.length === 0) {
            return res.status(401).json({ message: 'Invalid credentials' });
        }

        let employee = null;
        for (let emp of employees) {
            const isMatch = await emp.matchPassword(password);
            if (isMatch) {
                employee = emp;
                break;
            }
        }

        if (!employee) {
            return res.status(401).json({ message: 'Invalid credentials' });
        }

        // Check expiry
        if (employee.credentialsExpireAt && new Date() > new Date(employee.credentialsExpireAt)) {
            return res.status(401).json({ message: 'Your credentials have expired. Please contact HR.' });
        }

        // Verify password
        const isMatch = await employee.matchPassword(password);
        if (!isMatch) {
            return res.status(401).json({ message: 'Invalid credentials' });
        }

        // Generate JWT (15 min expiry for session timeout)
        const token = jwt.sign(
            { id: employee._id, type: 'onboarding', companyId: employee.companyId },
            process.env.JWT_SECRET,
            { expiresIn: '15m' }
        );

        // Log the login
        employee.auditLog.push({
            action: 'LOGIN',
            ip: req.ip || req.headers['x-forwarded-for'] || '',
            details: 'Employee logged in'
        });

        // Update status if first time
        if (employee.status === 'Pending') {
            employee.status = 'In Progress';
        }

        await employee.save();

        res.status(200).json({
            token,
            isPasswordChanged: employee.isPasswordChanged,
            employee: {
                _id: employee._id,
                tempEmployeeId: employee.tempEmployeeId,
                firstName: employee.firstName,
                lastName: employee.lastName,
                status: employee.status,
                documentDeadline: employee.documentDeadline,
                joiningDate: employee.joiningDate
            }
        });
    } catch (error) {
        console.error('Error in employee login:', error);
        res.status(500).json({ message: 'Server error', error: error.message });
    }
};

// --- Refresh token (for extending session) ---
exports.refreshToken = async (req, res) => {
    try {
        const token = jwt.sign(
            { id: req.onboardingEmployee._id, type: 'onboarding', companyId: req.onboardingEmployee.companyId },
            process.env.JWT_SECRET,
            { expiresIn: '15m' }
        );
        res.status(200).json({ token });
    } catch (error) {
        res.status(500).json({ message: 'Server error', error: error.message });
    }
};

// --- Change Password (first login) ---
exports.changePassword = async (req, res) => {
    try {
        const { newPassword } = req.body;
        if (!newPassword || newPassword.length < 8) {
            return res.status(400).json({ message: 'Password must be at least 8 characters' });
        }

        const employee = req.onboardingEmployee;
        employee.tempPassword = newPassword;
        employee.isPasswordChanged = true;
        employee.passwordChangedAt = new Date();
        employee.auditLog.push({ action: 'PASSWORD_CHANGE', details: 'Password changed on first login' });

        await employee.save();

        // Generate a new token
        const token = jwt.sign(
            { id: employee._id, type: 'onboarding', companyId: employee.companyId },
            process.env.JWT_SECRET,
            { expiresIn: '15m' }
        );

        res.status(200).json({ message: 'Password changed successfully', token });
    } catch (error) {
        console.error('Error changing password:', error);
        res.status(500).json({ message: 'Server error', error: error.message });
    }
};

// --- Get my onboarding profile ---
exports.getMyOnboarding = async (req, res) => {
    try {
        const employee = await OnboardingEmployee.findById(req.onboardingEmployee._id)
            .select('-tempPassword -auditLog')
            .lean();

        if (!employee) return res.status(404).json({ message: 'Not found' });

        // Fetch company settings for templates and policies
        const company = await Company.findById(employee.companyId).select('settings.onboarding');
        const policies = company?.settings?.onboarding?.policies || [];
        const dynamicTemplates = company?.settings?.onboarding?.dynamicTemplates || [];

        res.status(200).json({
            ...employee,
            companyPolicies: policies,
            dynamicTemplates: dynamicTemplates
        });
    } catch (error) {
        console.error('Error fetching profile:', error);
        res.status(500).json({ message: 'Server error', error: error.message });
    }
};

// --- Save a section (auto-save) ---
exports.saveSection = async (req, res) => {
    try {
        const { section } = req.params;
        const data = req.body;
        const employee = req.onboardingEmployee;

        if (employee.submittedAt && employee.status === 'Submitted') {
            return res.status(400).json({ message: 'Form is already submitted and read-only' });
        }

        const allowedSections = ['personalDetails', 'emergencyContact', 'bankDetails', 'offerDeclaration'];
        if (!allowedSections.includes(section)) {
            return res.status(400).json({ message: 'Invalid section' });
        }

        // Merge the update
        const update = {};
        for (const key of Object.keys(data)) {
            update[`${section}.${key}`] = data[key];
        }

        await OnboardingEmployee.findByIdAndUpdate(employee._id, { $set: update });

        employee.auditLog.push({ action: 'SAVE', details: `Section ${section} saved` });
        if (employee.status === 'Pending') {
            employee.status = 'In Progress';
        }
        await employee.save();

        res.status(200).json({ message: 'Section saved' });
    } catch (error) {
        console.error('Error saving section:', error);
        res.status(500).json({ message: 'Server error', error: error.message });
    }
};

// --- Upload a document ---
exports.uploadDocument = async (req, res) => {
    try {
        const { docId } = req.params;
        const employee = req.onboardingEmployee;

        if (!req.file) {
            return res.status(400).json({ message: 'No file uploaded' });
        }

        // Validate file size (5MB)
        if (req.file.size > 5 * 1024 * 1024) {
            return res.status(400).json({ message: 'File size exceeds 5MB limit' });
        }

        const doc = employee.documents.id(docId);
        if (!doc) return res.status(404).json({ message: 'Document slot not found' });

        // Delete old file from Cloudinary if replacing
        if (doc.publicId) {
            try {
                await cloudinary.uploader.destroy(doc.publicId, { resource_type: 'raw' });
            } catch (e) { /* ignore */ }
        }

        const { extractPublicIdFromUrl } = require('../utils/cloudinaryHelper');

        doc.url = req.file.path;
        doc.publicId = extractPublicIdFromUrl(req.file.path);
        doc.status = 'Uploaded';
        doc.rejectionReason = '';
        doc.uploadedAt = new Date();

        employee.auditLog.push({ action: 'DOCUMENT_UPLOAD', details: `${doc.label} uploaded` });
        if (employee.status === 'Pending') employee.status = 'In Progress';

        await employee.save();

        res.status(200).json({ message: 'Document uploaded', document: doc });
    } catch (error) {
        console.error('Error uploading document:', error);
        res.status(500).json({ message: 'Server error', error: error.message });
    }
};

// --- Add additional document slot (for multi-file types like salary_slip, graduation) ---
exports.addDocumentSlot = async (req, res) => {
    try {
        const { type, label } = req.body;
        const employee = req.onboardingEmployee;

        if (!type || !label) {
            return res.status(400).json({ message: 'Type and label are required' });
        }

        const existingCount = employee.documents.filter(d => d.type === type).length;
        const newLabel = `${label} (${existingCount + 1})`;

        employee.documents.push({ type, label: newLabel, status: 'Pending' });
        await employee.save();

        const newDoc = employee.documents[employee.documents.length - 1];
        res.status(201).json({ message: 'Document slot added', document: newDoc });
    } catch (error) {
        console.error('Error adding document slot:', error);
        res.status(500).json({ message: 'Server error', error: error.message });
    }
};

// --- Delete a dynamically added document slot ---
exports.deleteDocumentSlot = async (req, res) => {
    try {
        const { docId } = req.params;
        const employee = req.onboardingEmployee;

        const doc = employee.documents.id(docId);
        if (!doc) return res.status(404).json({ message: 'Document not found' });

        // Only allow deleting dynamically added docs (labels with parenthetical numbers)
        if (!/\(\d+\)$/.test(doc.label)) {
            return res.status(400).json({ message: 'Cannot delete original document slots' });
        }

        // Delete from Cloudinary if uploaded
        if (doc.publicId) {
            try { await cloudinary.uploader.destroy(doc.publicId, { resource_type: 'raw' }); } catch (e) { /* ignore */ }
        }

        employee.documents.pull(docId);
        await employee.save();

        res.status(200).json({ message: 'Document slot removed' });
    } catch (error) {
        console.error('Error deleting document slot:', error);
        res.status(500).json({ message: 'Server error', error: error.message });
    }
};

// --- Upload cancelled cheque ---
exports.uploadCheque = async (req, res) => {
    try {
        const employee = req.onboardingEmployee;

        if (!req.file) {
            return res.status(400).json({ message: 'No file uploaded' });
        }

        const { extractPublicIdFromUrl } = require('../utils/cloudinaryHelper');

        // Delete old if present
        if (employee.bankDetails?.cancelledChequePublicId) {
            try {
                await cloudinary.uploader.destroy(employee.bankDetails.cancelledChequePublicId, { resource_type: 'raw' });
            } catch (e) { /* ignore */ }
        }

        employee.bankDetails.cancelledChequeUrl = req.file.path;
        employee.bankDetails.cancelledChequePublicId = extractPublicIdFromUrl(req.file.path);

        employee.auditLog.push({ action: 'DOCUMENT_UPLOAD', details: 'Cancelled cheque uploaded' });
        await employee.save();

        res.status(200).json({
            message: 'Cheque uploaded',
            url: employee.bankDetails.cancelledChequeUrl
        });
    } catch (error) {
        console.error('Error uploading cheque:', error);
        res.status(500).json({ message: 'Server error', error: error.message });
    }
};

// --- Submit the entire onboarding form ---
exports.submitOnboarding = async (req, res) => {
    try {
        const employee = await OnboardingEmployee.findById(req.onboardingEmployee._id).populate('createdBy', 'firstName lastName email');
        if (!employee) return res.status(404).json({ message: 'Not found' });

        if (employee.submittedAt) {
            return res.status(400).json({ message: 'Already submitted' });
        }

        // Validate only requested items
        const errors = [];
        const reqSectionsRaw = employee.requestedSections || [];
        const reqDocsRaw = employee.requestedDocuments || [];
        const reqSectionLabels = reqSectionsRaw.map(rs => typeof rs === 'string' ? rs : rs.label);
        const reqDocLabels = reqDocsRaw.map(rd => typeof rd === 'string' ? rd : rd.label);
        const isSelective = reqSectionLabels.length > 0 || reqDocLabels.length > 0;

        // Form Sections Validation
        if (!isSelective || reqSectionLabels.includes('Personal Details')) {
            if (!employee.personalDetails?.isComplete) errors.push('Personal Details incomplete');
        }
        if (!isSelective || reqSectionLabels.includes('Emergency Contact')) {
            if (!employee.emergencyContact?.isComplete) errors.push('Emergency Contact incomplete');
        }
        if (!isSelective || reqSectionLabels.includes('Bank Details')) {
            if (!employee.bankDetails?.isComplete) errors.push('Bank Details incomplete');
        }
        if (!isSelective || reqSectionLabels.includes('Offer Declaration')) {
            if (!employee.offerDeclaration?.isComplete) errors.push('Offer Declaration incomplete');
        }

        // Documents Validation
        const mandatoryDocTypes = ['pan', 'passport_photo', 'aadhaar_front', 'aadhaar_back'];
        for (const doc of employee.documents) {
            const isMandatory = mandatoryDocTypes.includes(doc.type);
            const isRequested = reqDocLabels.includes(doc.label);

            if (isSelective) {
                // Modified: Skip validation for 'passport' type even if requested (it is labeled as Optional)
                if (isRequested && (doc.status === 'Pending' || doc.status === 'Mail Sent' || !doc.url) && doc.type !== 'passport') {
                    errors.push(`${doc.label} not uploaded`);
                }
            } else if (isMandatory) {
                if (doc.status === 'Pending' || doc.status === 'Mail Sent' || !doc.url) {
                    errors.push(`${doc.label} not uploaded`);
                }
            }
        }

        if (errors.length > 0) {
            return res.status(400).json({ message: 'Incomplete submission', errors });
        }

        employee.status = 'Submitted';
        employee.submittedAt = new Date();
        employee.auditLog.push({ action: 'SUBMIT', details: 'Onboarding form submitted' });

        await employee.save();

        // Notify HR (creator) via in-app notification
        if (employee.createdBy && employee.createdBy._id) {
            const io = req.app.get('io');
            await NotificationService.createNotification(io, {
                user: employee.createdBy._id,
                title: 'Onboarding Submission Received',
                message: `${employee.firstName} ${employee.lastName} (${employee.tempEmployeeId}) has submitted their pre-onboarding documents.`,
                type: 'Info',
                link: '/onboarding'
            });

            // Notify HR via email
            if (employee.createdBy.email) {
                await sendEmail({
                    to: employee.createdBy.email,
                    subject: `Onboarding Submitted: ${employee.firstName} ${employee.lastName}`,
                    html: `
                        <div style="font-family: Arial, sans-serif; max-width: 600px; padding: 20px; border: 1px solid #e2e8f0; border-radius: 8px;">
                            <h2 style="color: #2563eb;">Onboarding Submission Received</h2>
                            <p>Hello <strong>${employee.createdBy.firstName}</strong>,</p>
                            <p><strong>${employee.firstName} ${employee.lastName}</strong> (${employee.tempEmployeeId}) has completed and submitted their pre-onboarding portal form and documents.</p>
                            <p>Please log in to the HR Portal to review the submission.</p>
                            <div style="margin-top: 24px; text-align: center;">
                                <a href="${process.env.FRONTEND_URL || 'http://localhost:5173'}/onboarding" style="background: #2563eb; color: white; padding: 10px 20px; text-decoration: none; border-radius: 6px; font-weight: bold;">Review Submission</a>
                            </div>
                        </div>
                    `
                });
            }
        }

        res.status(200).json({
            message: 'Onboarding form submitted successfully',
            submittedAt: employee.submittedAt
        });
    } catch (error) {
        console.error('Error submitting onboarding:', error);
        res.status(500).json({ message: 'Server error', error: error.message });
    }
};

// ==========================================
// ONBOARDING SETTINGS & TEMPLATES
// ==========================================

// GET /api/onboarding/settings
exports.getOnboardingSettings = async (req, res) => {
    try {
        res.set('Cache-Control', 'private, max-age=60, stale-while-revalidate=60');
        const company = await Company.findById(req.companyId).select('settings.onboarding');
        res.json(company.settings.onboarding || { offerLetterTemplateUrl: '', declarationTemplateUrl: '' });
    } catch (error) {
        res.status(500).json({ message: 'Failed to fetch settings', error: error.message });
    }
};

// POST /api/onboarding/settings/templates
exports.updateTemplate = async (req, res) => {
    try {
        const { type, url } = req.body; // type: 'offerLetter' or 'declaration'
        const field = type === 'offerLetter' ? 'settings.onboarding.offerLetterTemplateUrl' : 'settings.onboarding.declarationTemplateUrl';

        await Company.findByIdAndUpdate(req.companyId, { [field]: url });
        res.json({ message: 'Template updated successfully!', url });
    } catch (error) {
        res.status(500).json({ message: 'Failed to update template', error: error.message });
    }
};

// POST /api/onboarding/settings/templates/upload
exports.uploadAndSetTemplate = async (req, res) => {
    try {
        if (!req.file) return res.status(400).json({ message: 'No file uploaded' });

        const { type } = req.body; // 'offerLetter' or 'declaration'
        if (!['offerLetter', 'declaration'].includes(type)) {
            return res.status(400).json({ message: 'Invalid template type. Use offerLetter or declaration.' });
        }

        const url = req.file.path; // Cloudinary URL
        const field = type === 'offerLetter' ? 'settings.onboarding.offerLetterTemplateUrl' : 'settings.onboarding.declarationTemplateUrl';

        await Company.findByIdAndUpdate(req.companyId, { [field]: url });

        res.status(200).json({
            message: `${type === 'offerLetter' ? 'Offer Letter' : 'Declaration'} template uploaded and set successfully!`,
            url
        });
    } catch (error) {
        console.error('Error uploading template:', error);
        res.status(500).json({ message: 'Failed to upload template', error: error.message });
    }
};

// DELETE /api/onboarding/settings/templates/:type
exports.deleteBaseTemplate = async (req, res) => {
    try {
        const { type } = req.params; // 'offerLetter' or 'declaration'
        if (!['offerLetter', 'declaration'].includes(type)) {
            return res.status(400).json({ message: 'Invalid template type' });
        }

        const company = await Company.findById(req.companyId).select('settings.onboarding');
        const field = type === 'offerLetter' ? 'offerLetterTemplateUrl' : 'declarationTemplateUrl';
        const templateUrl = company.settings.onboarding[field];

        if (!templateUrl) {
            return res.status(400).json({ message: 'No custom template to delete' });
        }

        // Delete from Cloudinary if it's a Cloudinary URL
        const { extractPublicIdFromUrl } = require('../utils/cloudinaryHelper');
        const publicId = extractPublicIdFromUrl(templateUrl);
        if (publicId) {
            const { cloudinary } = require('../config/cloudinary');
            try {
                // Templates are usually uploaded as 'raw' resource_type in many setups, 
                // but if using standard upload single, it might be 'auto'.
                // Cloudinary destroy often needs resource_type: 'raw' for .docx.
                await cloudinary.uploader.destroy(publicId, { resource_type: 'raw' });
            } catch (e) {
                console.error('Cloudinary delete error:', e.message);
            }
        }

        // Clear in DB
        company.settings.onboarding[field] = '';
        await company.save();

        res.json({ message: `${type === 'offerLetter' ? 'Offer Letter' : 'Declaration'} template deleted successfully.` });
    } catch (error) {
        console.error('Error deleting template:', error);
        res.status(500).json({ message: 'Failed to delete template', error: error.message });
    }
};

// POST /api/onboarding/settings/policies/upload
exports.addPolicy = async (req, res) => {
    try {
        if (!req.file) return res.status(400).json({ message: 'No file uploaded' });

        const { name, isRequired } = req.body;
        if (!name) return res.status(400).json({ message: 'Policy name is required' });

        const { extractPublicIdFromUrl } = require('../utils/cloudinaryHelper');
        const url = req.file.path;
        const publicId = extractPublicIdFromUrl(url);

        const newPolicy = {
            name,
            url,
            publicId,
            isRequired: isRequired === 'true' || isRequired === true
        };

        await Company.findByIdAndUpdate(req.companyId, {
            $push: { 'settings.onboarding.policies': newPolicy }
        });

        res.status(200).json({ message: 'Policy uploaded successfully!', policy: newPolicy });
    } catch (error) {
        console.error('Error adding policy:', error);
        res.status(500).json({ message: 'Failed to add policy', error: error.message });
    }
};

// DELETE /api/onboarding/settings/policies/:policyId
exports.deletePolicy = async (req, res) => {
    try {
        const { policyId } = req.params;
        const company = await Company.findById(req.companyId);

        const policy = company.settings.onboarding.policies.id(policyId);
        if (!policy) return res.status(404).json({ message: 'Policy not found' });

        // Delete from Cloudinary
        if (policy.publicId) {
            try {
                await cloudinary.uploader.destroy(policy.publicId, { resource_type: 'raw' });
            } catch (e) { /* ignore */ }
        }

        // Remove from DB
        await Company.findByIdAndUpdate(req.companyId, {
            $pull: { 'settings.onboarding.policies': { _id: policyId } }
        });

        res.json({ message: 'Policy deleted successfully' });
    } catch (error) {
        console.error('Error deleting policy:', error);
        res.status(500).json({ message: 'Failed to delete policy', error: error.message });
    }
};

// POST /api/onboarding/my-profile/policies/:policyId/accept
exports.acceptPolicy = async (req, res) => {
    try {
        const { policyId } = req.params;
        const employee = req.onboardingEmployee;

        // Check if already accepted
        const alreadyAccepted = employee.offerDeclaration.acceptedPolicies.find(p => p.policyId === policyId);
        if (alreadyAccepted) return res.json({ message: 'Policy already accepted' });

        // Get policy name from company settings
        const company = await Company.findById(employee.companyId);
        const policy = company.settings.onboarding.policies.id(policyId);
        if (!policy) return res.status(404).json({ message: 'Policy not found' });

        await OnboardingEmployee.findByIdAndUpdate(employee._id, {
            $push: {
                'offerDeclaration.acceptedPolicies': {
                    policyId,
                    name: policy.name,
                    acceptedAt: new Date()
                }
            }
        });

        res.json({ message: 'Policy accepted' });
    } catch (error) {
        res.status(500).json({ message: 'Failed to accept policy', error: error.message });
    }
};

// POST /api/onboarding/my-profile/templates/:templateId/accept
exports.acceptTemplate = async (req, res) => {
    try {
        const { templateId } = req.params;
        const employeeId = req.onboardingEmployee._id;

        const company = await Company.findById(req.onboardingEmployee.companyId).select('settings.onboarding').lean();
        const template = company.settings.onboarding.dynamicTemplates.find(t => t._id.toString() === templateId);

        if (!template) return res.status(404).json({ message: 'Template not found' });

        // Check if already accepted
        const employee = await OnboardingEmployee.findById(employeeId);
        const alreadyAccepted = employee.offerDeclaration.acceptedTemplates.find(t => t.templateId === templateId);
        if (alreadyAccepted) return res.json({ message: 'Template already accepted' });

        await OnboardingEmployee.findByIdAndUpdate(employeeId, {
            $push: {
                'offerDeclaration.acceptedTemplates': {
                    templateId,
                    name: template.name,
                    acceptedAt: new Date()
                }
            }
        });

        res.json({ message: 'Template accepted' });
    } catch (error) {
        console.error('Error accepting template:', error);
        res.status(500).json({ message: 'Failed to accept template', error: error.message });
    }
};

const DUMMY_PREVIEW_DATA = {
    offer_date: formatDate(new Date()),
    employee_full_name: 'Johnathan Doe',
    employee_first_name: 'Johnathan',
    employee_last_name: 'Doe',
    employee_permanent_address: '123 Main Street, Phase 5',
    employee_address: '123 Main Street, Phase 5',
    employee_city: 'New Delhi',
    designation: 'Senior Software Engineer',
    department: 'Information Technology',
    joining_date: formatDate(new Date(Date.now() + 15 * 24 * 60 * 60 * 1000)), // 15 days from now
    work_location: 'Bangalore (Hybrid)',
    probation_period: '6 months',
    probationPeriod: '6 months',
    annual_ctc: '₹ 25,00,000',
    basic_salary: '₹ 1,00,000',
    hra: '₹ 40,000',
    special_allowance: '₹ 68,333',
    monthly_gross: '₹ 2,08,333',
    monthly_ctc: '₹ 2,15,000',
    hr_name: 'Sarah Smith',
    hr_designation: 'HR Director',
    declaration_date: formatDate(new Date()),
    employee_signature_name: 'Johnathan Doe',
    employee_id: 'TEMP_123456'
};

// GET /api/onboarding/settings/templates/:type/preview
exports.getTemplatePreview = async (req, res) => {
    try {
        const { type } = req.params; // 'offerLetter' or 'declaration'
        const company = await Company.findById(req.companyId).select('settings.onboarding').lean();

        const customUrl = type === 'offerLetter' ? company?.settings?.onboarding?.offerLetterTemplateUrl : company?.settings?.onboarding?.declarationTemplateUrl;
        const defaultPath = type === 'offerLetter' ?
            path.join(__dirname, '../../templates/offer_letter_template.docx') :
            path.join(__dirname, '../../templates/declaration_template.docx');

        const { withData } = req.query;

        const content = await getTemplateContent(customUrl, defaultPath);
        const zip = new PizZip(content);
        const doc = new Docxtemplater(zip, {
            paragraphLoop: true,
            linebreaks: true,
            nullGetter: () => '—'
        });

        if (withData !== 'false') {
            doc.render(DUMMY_PREVIEW_DATA);
        }

        const buffer = doc.getZip().generate({ type: 'nodebuffer' });

        // Serve the populated .docx as a file for the frontend to render with docx-preview
        const filename = `Preview_${type}.docx`;
        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
        res.setHeader('Content-Disposition', `inline; filename=${filename}`);
        res.send(buffer);
    } catch (error) {
        console.error('Error generating template preview:', error);
        res.status(500).json({ message: 'Failed to generate preview', error: error.message });
    }
};

// GET /api/onboarding/settings/templates/:type/download
exports.downloadTemplate = async (req, res) => {
    try {
        const { type } = req.params; // 'offerLetter' or 'declaration'
        const company = await Company.findById(req.companyId).select('settings.onboarding').lean();

        const customUrl = type === 'offerLetter' ? company?.settings?.onboarding?.offerLetterTemplateUrl : company?.settings?.onboarding?.declarationTemplateUrl;
        const defaultPath = type === 'offerLetter' ?
            path.join(__dirname, '../../templates/offer_letter_template.docx') :
            path.join(__dirname, '../../templates/declaration_template.docx');

        const content = await getTemplateContent(customUrl, defaultPath);

        const filename = `${type === 'offerLetter' ? 'OfferLetter' : 'Declaration'}_Template.docx`;
        res.setHeader('Content-Disposition', `attachment; filename=${filename}`);
        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');

        // If content is already a buffer (from axios arraybuffer or fs.readFileSync)
        res.send(Buffer.from(content, 'binary'));
    } catch (error) {
        console.error('Error downloading template:', error);
        res.status(500).json({ message: 'Failed to download template', error: error.message });
    }
};

// --- Shared Helper for Populating Documents ---
const getPopulatedDocumentBuffer = async (employee, company, templateUrl, defaultPath = null) => {
    const content = await getTemplateContent(templateUrl, defaultPath);
    const zip = new PizZip(content);
    const doc = new Docxtemplater(zip, {
        paragraphLoop: true,
        linebreaks: true,
        nullGetter: () => '—'
    });

    const fullName = employee.personalDetails?.fullName || `${employee.firstName} ${employee.lastName}`.trim();
    const hrUser = employee.createdBy || {};
    const permAddr = employee.personalDetails?.permanentAddress || employee.personalDetails?.currentAddress || {};

    doc.render({
        offer_date: formatDate(employee.offerDate || new Date()),
        employee_full_name: fullName,
        employee_first_name: employee.firstName,
        employee_last_name: employee.lastName,
        employee_id: employee.tempEmployeeId,
        designation: employee.designation || '—',
        department: employee.department || '—',
        joining_date: formatDate(employee.joiningDate),
        work_location: employee.workLocation || '—',
        probation_period: employee.probationPeriod || '6 months',
        probationPeriod: employee.probationPeriod || '6 months',
        annual_ctc: formatCurrency(employee.salary?.annualCTC),
        annual_salary: formatCurrency(employee.salary?.annualCTC),
        basic_salary: formatCurrency(employee.salary?.basic),
        hra: formatCurrency(employee.salary?.hra),
        special_allowance: formatCurrency(employee.salary?.specialAllowance),
        monthly_gross: formatCurrency(employee.salary?.monthlyGross),
        monthly_ctc: formatCurrency(employee.salary?.monthlyCTC),
        employee_address: [permAddr.line1, permAddr.line2].filter(Boolean).join(', ') || employee.address || '—',
        employee_city: permAddr.city || '—',
        hr_name: hrUser.firstName ? `${hrUser.firstName} ${hrUser.lastName || ''}`.trim() : 'Authorized Signatory',
        hr_designation: hrUser.designation || 'HR Manager',
        declaration_date: formatDate(new Date()),
        employee_signature_name: fullName
    });

    return doc.getZip().generate({ type: 'nodebuffer' });
};



// --- Generate & download Offer Letter ---
exports.generateOfferLetter = async (req, res) => {
    try {
        const [employee, company] = await Promise.all([
            OnboardingEmployee.findOne({ _id: req.params.id, companyId: req.companyId })
                .populate('createdBy', 'firstName lastName designation')
                .lean(),
            Company.findById(req.companyId).select('settings.onboarding').lean()
        ]);

        if (!employee) return res.status(404).json({ message: 'Employee not found' });

        const buffer = await getPopulatedDocumentBuffer(
            employee,
            company,
            company?.settings?.onboarding?.offerLetterTemplateUrl,
            path.join(__dirname, '../../templates/offer_letter_template.docx')
        );

        // Track generation
        await OnboardingEmployee.findByIdAndUpdate(employee._id, {
            letterGenerated: true,
            letterGeneratedAt: new Date(),
            $push: { auditLog: { action: 'OFFER_LETTER_GENERATED', details: `Offer letter generated by ${hrUser.firstName || 'Admin'}` } }
        });

        const safeName = fullName.replace(/[^a-zA-Z0-9\s]/g, '').replace(/\s+/g, '_');
        res.setHeader('Content-Disposition', `attachment; filename=OfferLetter_${safeName}.docx`);
        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
        res.send(buffer);

    } catch (error) {
        console.error('Error generating offer letter:', error);
        res.status(500).json({ message: 'Failed to generate offer letter', error: error.message });
    }
};

// --- Generate & download Declaration ---
exports.generateDeclaration = async (req, res) => {
    try {
        const [employee, company] = await Promise.all([
            OnboardingEmployee.findOne({ _id: req.params.id, companyId: req.companyId })
                .populate('createdBy', 'firstName lastName designation')
                .lean(),
            Company.findById(req.companyId).select('settings.onboarding').lean()
        ]);

        if (!employee) return res.status(404).json({ message: 'Employee not found' });

        const buffer = await getPopulatedDocumentBuffer(
            employee,
            company,
            company?.settings?.onboarding?.declarationTemplateUrl,
            path.join(__dirname, '../../templates/declaration_template.docx')
        );

        const hrUser = employee.createdBy || {};
        const fullName = employee.personalDetails?.fullName || `${employee.firstName} ${employee.lastName}`.trim();

        // Audit log
        await OnboardingEmployee.findByIdAndUpdate(employee._id, {
            $push: { auditLog: { action: 'DECLARATION_GENERATED', details: `Declaration generated by ${hrUser.firstName || 'Admin'}` } }
        });

        const safeName = fullName.replace(/[^a-zA-Z0-9\s]/g, '').replace(/\s+/g, '_');
        res.setHeader('Content-Disposition', `attachment; filename=Declaration_${safeName}.docx`);
        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
        res.send(buffer);

    } catch (error) {
        console.error('Error generating declaration:', error);
        res.status(500).json({ message: 'Failed to generate declaration', error: error.message });
    }
};

// --- Generate & download Dynamic Template ---
exports.generateDynamicTemplate = async (req, res) => {
    try {
        const { id, templateId } = req.params;
        const [employee, company] = await Promise.all([
            OnboardingEmployee.findOne({ _id: id, companyId: req.companyId })
                .populate('createdBy', 'firstName lastName designation')
                .lean(),
            Company.findById(req.companyId).select('settings.onboarding').lean()
        ]);

        if (!employee) return res.status(404).json({ message: 'Employee not found' });

        const template = company.settings.onboarding.dynamicTemplates.find(t => t._id.toString() === templateId);
        if (!template) return res.status(404).json({ message: 'Template not found' });

        const buffer = await getPopulatedDocumentBuffer(employee, company, template.url);

        const safeName = template.name.replace(/[^a-zA-Z0-9\s]/g, '').replace(/\s+/g, '_');
        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
        res.setHeader('Content-Disposition', `inline; filename=${safeName}.docx`);
        res.send(buffer);
    } catch (error) {
        console.error('Error generating dynamic template preview:', error);
        res.status(500).json({ message: 'Failed to generate document', error: error.message });
    }
};

// ==========================================
// EMPLOYEE SELF-SERVICE EXTENSIONS
// ==========================================

// --- Get My Offer Letter ---
exports.getMyOfferLetter = async (req, res) => {
    try {
        const [employee, company] = await Promise.all([
            OnboardingEmployee.findById(req.onboardingEmployee._id)
                .populate('createdBy', 'firstName lastName designation')
                .lean(),
            Company.findById(req.onboardingEmployee.companyId).select('settings.onboarding').lean()
        ]);

        if (!employee) return res.status(404).json({ message: 'Employee not found' });

        const customUrl = company?.settings?.onboarding?.offerLetterTemplateUrl;
        const defaultPath = path.join(__dirname, '../../templates/offer_letter_template.docx');

        const content = await getTemplateContent(customUrl, defaultPath);
        const zip = new PizZip(content);
        const doc = new Docxtemplater(zip, {
            paragraphLoop: true,
            linebreaks: true,
            nullGetter: () => '—'
        });

        const fullName = employee.personalDetails?.fullName || `${employee.firstName} ${employee.lastName}`.trim();
        const permAddr = employee.personalDetails?.permanentAddress || employee.personalDetails?.currentAddress || {};
        const hrUser = employee.createdBy || {};

        doc.render({
            offer_date: formatDate(employee.offerDate || new Date()),
            employee_full_name: fullName,
            employee_first_name: employee.firstName,
            employee_last_name: employee.lastName,
            employee_permanent_address: [permAddr.line1, permAddr.line2].filter(Boolean).join(', ') || employee.address || '—',
            employee_address: [permAddr.line1, permAddr.line2].filter(Boolean).join(', ') || employee.address || '—',
            employee_city: permAddr.city || '—',
            designation: employee.designation || '—',
            department: employee.department || '—',
            joining_date: formatDate(employee.joiningDate),
            work_location: employee.workLocation || '—',
            probation_period: employee.probationPeriod || '6 months',
            probationPeriod: employee.probationPeriod || '6 months',
            annual_ctc: formatCurrency(employee.salary?.annualCTC),
            annual_salary: formatCurrency(employee.salary?.annualCTC),
            basic_salary: formatCurrency(employee.salary?.basic),
            hra: formatCurrency(employee.salary?.hra),
            special_allowance: formatCurrency(employee.salary?.specialAllowance),
            monthly_gross: formatCurrency(employee.salary?.monthlyGross),
            monthly_ctc: formatCurrency(employee.salary?.monthlyCTC),
            hr_name: hrUser.firstName ? `${hrUser.firstName} ${hrUser.lastName || ''}`.trim() : 'Authorized Signatory',
            hr_designation: hrUser.designation || 'HR Manager',
            declaration_date: formatDate(employee.offerDate || new Date()),
            employee_signature_name: fullName,
            employee_id: employee.tempEmployeeId
        });

        const buffer = doc.getZip().generate({ type: 'nodebuffer' });

        await OnboardingEmployee.findByIdAndUpdate(employee._id, {
            $push: { auditLog: { action: 'OFFER_LETTER_DOWNLOADED', details: 'Employee downloaded offer letter.' } }
        });

        const safeName = fullName.replace(/[^a-zA-Z0-9\s]/g, '').replace(/\s+/g, '_');
        res.setHeader('Content-Disposition', `attachment; filename=OfferLetter_${safeName}.docx`);
        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
        res.send(buffer);
    } catch (error) {
        console.error('Error downloading offer letter:', error);
        res.status(500).json({ message: 'Failed to download offer letter', error: error.message });
    }
};

// --- Accept Offer Letter ---
exports.acceptOfferLetter = async (req, res) => {
    try {
        const employee = await OnboardingEmployee.findById(req.onboardingEmployee._id);
        if (!employee) return res.status(404).json({ message: 'Employee not found' });

        const company = await Company.findById(employee.companyId).select('settings.onboarding');
        const policies = company?.settings?.onboarding?.policies || [];
        const dynamicTemplates = company?.settings?.onboarding?.dynamicTemplates || [];

        // Prepare lists for automated acceptance
        // 1. Process requestedDocuments to update statuses (like "Mail Sent" -> "Accepted")
        employee.requestedDocuments.forEach(doc => {
            const label = doc.label;

            // A. Check for Offer Letter (Case-insensitive regex)
            if (/offer\s*letter/i.test(label)) {
                doc.status = 'Accepted';
                employee.offerDeclaration.hasReadOfferLetter = true;
            }

            // B. Check for Dynamic Templates
            const temp = dynamicTemplates.find(t => t.name === label);
            if (temp) {
                doc.status = 'Accepted';
                if (!employee.offerDeclaration.acceptedTemplates.some(t => t.templateId === temp._id.toString())) {
                    employee.offerDeclaration.acceptedTemplates.push({
                        templateId: temp._id.toString(),
                        name: temp.name,
                        acceptedAt: new Date()
                    });
                }
            }

            // C. Check for Policies
            const policy = policies.find(p => p.name === label);
            if (policy) {
                doc.status = 'Accepted';
                if (!employee.offerDeclaration.acceptedPolicies.some(p => p.policyId === policy._id.toString())) {
                    employee.offerDeclaration.acceptedPolicies.push({
                        policyId: policy._id.toString(),
                        name: policy.name,
                        acceptedAt: new Date()
                    });
                }
            }
        });

        // 2. Ensure hasReadOfferLetter is true unconditionally upon offer acceptance
        employee.offerDeclaration.hasReadOfferLetter = true;

        // 3. Mark matching document status to Approved
        employee.documents.forEach(doc => {
            if (doc.type === 'offer-letter' || dynamicTemplates.some(t => t.name === doc.label)) {
                doc.status = 'Approved';
            }
        });

        // 4. Update overall status
        employee.offerStatus = 'Accepted';
        if (employee.status === 'Pending') {
            employee.status = 'In Progress';
        }

        employee.auditLog.push({
            action: 'OFFER_ACCEPTED',
            details: 'Employee accepted the offer and acknowledged all requested documents/policies.'
        });

        await employee.save();

        // Sync TA phase3Decision → 'Offer Accepted'
        await syncTADecision(employee, 'Offer Accepted');

        res.status(200).json({ message: 'Offer accepted successfully!', offerStatus: employee.offerStatus, status: employee.status });
    } catch (error) {
        console.error('Error accepting offer letter:', error);
        res.status(500).json({ message: 'Failed to accept offer letter', error: error.message });
    }
};

// --- Multi-Document Management ---

// POST /api/onboarding/settings/templates/dynamic/upload
exports.addDynamicTemplate = async (req, res) => {
    try {
        if (!req.file) return res.status(400).json({ message: 'No file uploaded' });

        const { name, isRequired } = req.body;
        if (!name) return res.status(400).json({ message: 'Template name is required' });

        const { extractPublicIdFromUrl } = require('../utils/cloudinaryHelper');
        const url = req.file.path;
        const publicId = extractPublicIdFromUrl(url);

        const newTemplate = {
            name,
            url,
            publicId,
            isRequired: isRequired === 'true' || isRequired === true
        };

        await Company.findByIdAndUpdate(req.companyId, {
            $push: { 'settings.onboarding.dynamicTemplates': newTemplate }
        });

        res.status(200).json({ message: 'Dynamic template uploaded successfully!', template: newTemplate });
    } catch (error) {
        console.error('Error adding dynamic template:', error);
        res.status(500).json({ message: 'Failed to add template', error: error.message });
    }
};

// DELETE /api/onboarding/settings/templates/dynamic/:templateId
exports.deleteDynamicTemplate = async (req, res) => {
    try {
        const { templateId } = req.params;
        const company = await Company.findById(req.companyId);

        const template = company.settings.onboarding.dynamicTemplates.find(t => t._id.toString() === templateId);
        if (!template) return res.status(404).json({ message: 'Template not found' });

        const { cloudinary } = require('../config/cloudinary');
        if (template.publicId) {
            try {
                await cloudinary.uploader.destroy(template.publicId, { resource_type: 'raw' });
            } catch (e) { /* ignore */ }
        }

        await Company.findByIdAndUpdate(req.companyId, {
            $pull: { 'settings.onboarding.dynamicTemplates': { _id: templateId } }
        });

        res.json({ message: 'Template deleted successfully' });
    } catch (error) {
        console.error('Error deleting template:', error);
        res.status(500).json({ message: 'Failed to delete template', error: error.message });
    }
};

// GET /api/onboarding/my-profile/download-template/:templateId
exports.downloadTemplateById = async (req, res) => {
    try {
        const { templateId } = req.params;
        const employeeId = req.onboardingEmployee._id;

        const [employee, company] = await Promise.all([
            OnboardingEmployee.findById(employeeId).populate('createdBy').lean(),
            Company.findById(req.onboardingEmployee.companyId).select('settings.onboarding').lean()
        ]);

        const template = company.settings.onboarding.dynamicTemplates.find(t => t._id.toString() === templateId);
        if (!template) return res.status(404).json({ message: 'Template not found' });

        const content = await getTemplateContent(template.url);
        const zip = new PizZip(content);
        const doc = new Docxtemplater(zip, { paragraphLoop: true, linebreaks: true, nullGetter: () => '—' });

        const fullName = employee.personalDetails?.fullName || `${employee.firstName} ${employee.lastName}`.trim();
        const hrUser = employee.createdBy || {};
        const permAddr = employee.personalDetails?.permanentAddress || employee.personalDetails?.currentAddress || {};

        doc.render({
            offer_date: formatDate(employee.offerDate || new Date()),
            employee_full_name: fullName,
            employee_first_name: employee.firstName,
            employee_last_name: employee.lastName,
            employee_id: employee.tempEmployeeId,
            designation: employee.designation || '—',
            department: employee.department || '—',
            joining_date: formatDate(employee.joiningDate),
            work_location: employee.workLocation || '—',
            probation_period: employee.probationPeriod || '6 months',
            probationPeriod: employee.probationPeriod || '6 months',
            annual_ctc: formatCurrency(employee.salary?.annualCTC),
            annual_salary: formatCurrency(employee.salary?.annualCTC),
            basic_salary: formatCurrency(employee.salary?.basic),
            hra: formatCurrency(employee.salary?.hra),
            special_allowance: formatCurrency(employee.salary?.specialAllowance),
            monthly_gross: formatCurrency(employee.salary?.monthlyGross),
            monthly_ctc: formatCurrency(employee.salary?.monthlyCTC),
            employee_address: [permAddr.line1, permAddr.line2].filter(Boolean).join(', ') || employee.address || '—',
            hr_name: hrUser.firstName ? `${hrUser.firstName} ${hrUser.lastName || ''}`.trim() : 'Authorized Signatory',
            hr_designation: hrUser.designation || 'HR Manager'
        });

        const buffer = doc.getZip().generate({ type: 'nodebuffer' });
        const safeName = template.name.replace(/[^a-zA-Z0-9\s]/g, '').replace(/\s+/g, '_');
        res.setHeader('Content-Disposition', `attachment; filename=${safeName}.docx`);
        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
        res.send(buffer);
    } catch (error) {
        console.error('Error downloading template:', error);
        res.status(500).json({ message: 'Failed to download template', error: error.message });
    }
};

// ==========================================
// TRANSFER TO ACTIVE EMPLOYEE
// ==========================================

const User = require('../models/User');
const EmployeeProfile = require('../models/EmployeeProfile');
const Role = require('../models/Role');

// Map onboarding document types to dossier categories
const DOC_CATEGORY_MAP = {
    'resume': 'Resume',
    'pan': 'ID Proof',
    'aadhaar_front': 'ID Proof',
    'aadhaar_back': 'ID Proof',
    'passport': 'ID Proof',
    'salary_slip': 'Payslips',
    '10th_marksheet': 'Education',
    '12th_marksheet': 'Education',
    'graduation': 'Education',
    'relieving_letter': 'Relieving Letter',
    'experience_certificate': 'Employment',
    'passport_photo': 'Other'
};

exports.transferToActiveEmployee = async (req, res) => {
    try {
        const { roleId, employeeCode, password } = req.body || {};

        const employee = await OnboardingEmployee.findOne({ _id: req.params.id, companyId: req.companyId });
        if (!employee) return res.status(404).json({ message: 'Onboarding employee not found' });

        // Check if already transferred
        if (employee.transferredToUserId) {
            return res.status(400).json({ message: 'This employee has already been transferred to an active user.' });
        }

        // Validate Allowed Domains & Plan Limits
        const company = await Company.findById(req.companyId).populate('planId');
        if (company && company.allowedDomains && company.allowedDomains.length > 0) {
            const userEmailDomain = employee.email.split('@')[1];
            if (!company.allowedDomains.includes(userEmailDomain)) {
                return res.status(400).json({ message: "Email for this user is not authorized for this company. Please update to an allowed domain before transferring." });
            }
        }

        // Plan Enforcement: Check maxUsers
        if (company && company.planId) {
            const activeUserCount = await User.countDocuments({ companyId: req.companyId, isActive: true });
            if (activeUserCount >= company.planId.maxUsers) {
                return res.status(403).json({
                    message: `Plan Limit Reached: You have used all ${company.planId.maxUsers} active user slots. Please upgrade your plan to activate this employee.`
                });
            }
        }

        // Check if user with this email already exists
        const existingUser = await User.findOne({ email: employee.email, companyId: req.companyId });
        if (existingUser) {
            return res.status(400).json({ message: `A user with email ${employee.email} already exists.` });
        }

        // Validate role
        let assignedRoleId = roleId;
        if (!assignedRoleId) {
            // Default to "Employee" role if none provided
            const defaultRole = await Role.findOne({ name: 'Employee', companyId: req.companyId });
            if (!defaultRole) {
                return res.status(400).json({ message: 'No roleId provided and no default "Employee" role found. Please specify a role.' });
            }
            assignedRoleId = defaultRole._id;
        }

        // Generate temp password if not provided
        const userPassword = password || generateTempPassword();

        // 1. Create the User account
        const newUser = await User.create({
            companyId: req.companyId,
            firstName: employee.firstName,
            lastName: employee.lastName || '',
            email: employee.email,
            password: userPassword,
            roles: [assignedRoleId],
            department: employee.department || '',
            workLocation: employee.workLocation || 'Headquarters',
            employmentType: 'Full Time',
            employeeCode: employeeCode || employee.tempEmployeeId,
            joiningDate: employee.joiningDate || new Date(),
            isPasswordResetRequired: true
        });

        // 2. Build EmployeeProfile with onboarding data
        const personalDetails = employee.personalDetails || {};
        const emergencyContact = employee.emergencyContact || {};
        const bankDetails = employee.bankDetails || {};

        // Map onboarding documents to dossier documents
        const dossierDocuments = (employee.documents || [])
            .filter(doc => doc.url) // Only docs that were actually uploaded
            .map(doc => ({
                category: DOC_CATEGORY_MAP[doc.type] || 'Other',
                title: doc.label,
                fileName: doc.label.replace(/[^a-zA-Z0-9]/g, '_') + '.pdf',
                url: doc.url,
                uploadDate: doc.uploadedAt || new Date(),
                verificationStatus: doc.status === 'Approved' ? 'Verified' : 'Pending'
            }));

        const profile = new EmployeeProfile({
            user: newUser._id,
            companyId: req.companyId,
            personal: {
                firstName: employee.firstName,
                lastName: employee.lastName || '',
                fullName: personalDetails.fullName || `${employee.firstName} ${employee.lastName || ''}`.trim(),
                dob: personalDetails.dateOfBirth || null,
                gender: personalDetails.gender || null,
                bloodGroup: personalDetails.bloodGroup || '',
                nationality: 'Indian'
            },
            identity: {},
            contact: {
                personalEmail: personalDetails.personalEmail || employee.email,
                mobileNumber: personalDetails.personalMobile || employee.phone || '',
                emergencyNumber: emergencyContact.phoneNumber || '',
                emergencyContact: {
                    name: emergencyContact.contactName || '',
                    relation: emergencyContact.relationship || '',
                    phone: emergencyContact.phoneNumber || '',
                },
                addresses: personalDetails.currentAddress?.line1 ? [{
                    type: 'Current',
                    street: personalDetails.currentAddress.line1,
                    addressLine2: personalDetails.currentAddress.line2 || '',
                    city: personalDetails.currentAddress.city || '',
                    state: personalDetails.currentAddress.state || '',
                    zipCode: personalDetails.currentAddress.pincode || '',
                    country: personalDetails.currentAddress.country || 'India'
                }] : []
            },
            employment: {
                designation: employee.designation || '',
                department: employee.department || '',
                joiningDate: employee.joiningDate || new Date(),
                status: 'Active',
                workLocation: employee.workLocation || 'Office',
                employmentType: 'Full Time'
            },
            compensation: {
                ctc: employee.salary?.annualCTC ? parseFloat(employee.salary.annualCTC) : null,
                bankDetails: {
                    accountNumber: bankDetails.accountNumber || '',
                    ifscCode: bankDetails.ifscCode || '',
                    bankName: bankDetails.bankName || '',
                    accountHolderName: `${employee.firstName} ${employee.lastName || ''}`.trim(),
                    branchAddress: bankDetails.branchName || ''
                }
            },
            documents: dossierDocuments,
            documentSubmissionStatus: dossierDocuments.length > 0 ? 'Submitted' : 'Draft'
        });

        await profile.save();

        // Link profile to user
        newUser.employeeProfile = profile._id;
        await newUser.save();

        // 3. Update onboarding record
        employee.transferredToUserId = newUser._id;
        employee.status = 'Reviewed';
        employee.auditLog.push({
            action: 'TRANSFERRED_TO_ACTIVE',
            details: `Transferred to active employee (User: ${newUser._id}) by ${req.user.firstName || 'Admin'}`
        });
        await employee.save();

        // 4. Send welcome email
        const portalUrl = `${req.headers.origin || process.env.FRONTEND_URL || 'http://localhost:5173'}/login`;
        await sendEmail({
            to: employee.email,
            subject: `Welcome! Your Employee Account is Ready`,
            html: `
                <div style="font-family: 'Segoe UI', Arial, sans-serif; max-width: 600px; margin: auto; border: 1px solid #e2e8f0; border-radius: 12px; overflow: hidden;">
                    <div style="background: linear-gradient(135deg, #059669, #10b981); padding: 32px; text-align: center;">
                        <h1 style="color: white; margin: 0; font-size: 24px;">Welcome to the Team! 🎉</h1>
                        <p style="color: #d1fae5; margin-top: 8px;">Your employee account has been activated</p>
                    </div>
                    <div style="padding: 32px;">
                        <p>Hello <strong>${employee.firstName}</strong>,</p>
                        <p>Congratulations! Your pre-onboarding has been completed and your employee account is now active.</p>
                        
                        <div style="background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 8px; padding: 20px; margin: 24px 0;">
                            <p style="margin: 4px 0;"><strong>Employee Code:</strong> <code style="background: #e0e7ff; padding: 2px 8px; border-radius: 4px; font-size: 16px;">${employeeCode || employee.tempEmployeeId}</code></p>
                            <p style="margin: 4px 0;"><strong>Email:</strong> <code style="background: #e0e7ff; padding: 2px 8px; border-radius: 4px; font-size: 16px;">${employee.email}</code></p>
                            <p style="margin: 4px 0;"><strong>Temporary Password:</strong> <code style="background: #e0e7ff; padding: 2px 8px; border-radius: 4px; font-size: 16px;">${userPassword}</code></p>
                        </div>

                        <div style="text-align: center; margin: 24px 0;">
                            <a href="${portalUrl}" style="background: linear-gradient(135deg, #059669, #10b981); color: white; text-decoration: none; padding: 14px 32px; border-radius: 8px; font-weight: bold; display: inline-block;">Login to Your Account</a>
                        </div>
                        
                        <p style="color: #64748b; font-size: 13px;">⚠️ You will be asked to change your password on first login.</p>
                    </div>
                    <div style="background: #f1f5f9; padding: 16px; text-align: center; color: #94a3b8; font-size: 12px;">
                        © ${new Date().getFullYear()} TalentCio. All rights reserved.
                    </div>
                </div>
            `
        });

        res.status(201).json({
            message: 'Employee transferred to active user successfully!',
            user: {
                _id: newUser._id,
                firstName: newUser.firstName,
                lastName: newUser.lastName,
                email: newUser.email,
                employeeCode: newUser.employeeCode
            },
            documentsTransferred: dossierDocuments.length,
            tempPassword: userPassword
        });

    } catch (error) {
        console.error('Error transferring to active employee:', error);
        if (error.code === 11000) {
            return res.status(400).json({ message: 'Duplicate entry. This employee may already exist.' });
        }
        res.status(500).json({ message: 'Server error', error: error.message });
    }
};

// ==========================================
// Extension & Credential Regeneration Requests (Candidate Actions)
// ==========================================

exports.requestExtension = async (req, res) => {
    try {
        const { reason, requestedDays } = req.body;
        const employeeId = req.onboardingEmployee._id;

        if (!reason || !requestedDays) {
            return res.status(400).json({ message: 'Reason and number of days are required' });
        }

        const employee = await OnboardingEmployee.findById(employeeId);
        if (!employee) {
            return res.status(404).json({ message: 'Employee not found' });
        }

        // Check if there is already a pending request
        const hasPending = employee.extensionRequests.some(r => r.status === 'Pending');
        if (hasPending) {
            return res.status(400).json({ message: 'You already have a pending extension request' });
        }

        employee.extensionRequests.push({
            reason,
            requestedDays: Number(requestedDays),
            status: 'Pending',
            requestedAt: new Date()
        });

        // Audit log
        employee.auditLog.push({
            action: 'EXTENSION_REQUESTED',
            details: `Requested ${requestedDays} days extension due to: ${reason}`,
            ip: req.ip
        });

        await employee.save();
        res.status(200).json({ message: 'Extension request submitted successfully' });
    } catch (error) {
        console.error('Error requesting extension:', error);
        res.status(500).json({ message: 'Failed to request extension', error: error.message });
    }
};

exports.requestCredentialRegeneration = async (req, res) => {
    try {
        const { tempEmployeeId, reason } = req.body;

        if (!tempEmployeeId) {
            return res.status(400).json({ message: 'Employee ID is required' });
        }

        // Allow looking up without auth since they are locked out
        const employee = await OnboardingEmployee.findOne({ tempEmployeeId });
        if (!employee) {
            return res.status(404).json({ message: 'Employee not found' });
        }

        if (employee.credentialRegenerationRequest?.requested && !employee.credentialRegenerationRequest?.resolved) {
            return res.status(400).json({ message: 'You already have a pending request for new credentials' });
        }

        employee.credentialRegenerationRequest = {
            requested: true,
            requestedAt: new Date(),
            reason: reason || 'Credentials expired or lost'
        };

        employee.auditLog.push({
            action: 'REGENERATION_REQUESTED',
            details: reason || 'Credentials expired or lost',
            ip: req.ip
        });

        await employee.save();
        res.status(200).json({ message: 'Request sent! HR will review and send new credentials to your email.' });
    } catch (error) {
        console.error('Error requesting credential regeneration:', error);
        res.status(500).json({ message: 'Failed to request credentials', error: error.message });
    }
};

exports.resolveExtensionRequest = async (req, res) => {
    try {
        const { id, extId } = req.params;
        const { status, responseNote, newDeadline } = req.body;

        const employee = await OnboardingEmployee.findOne({ _id: id, companyId: req.companyId });
        if (!employee) return res.status(404).json({ message: 'Employee not found' });

        const extReq = employee.extensionRequests.id(extId);
        if (!extReq) return res.status(404).json({ message: 'Extension request not found' });

        extReq.status = status;
        extReq.respondedAt = new Date();
        extReq.responseNote = responseNote || '';

        let logDetail = `Extension request ${status}`;
        if (status === 'Approved' && newDeadline) {
            employee.documentDeadline = new Date(newDeadline);
            logDetail += ` - New deadline: ${new Date(newDeadline).toLocaleDateString()}`;
        }

        employee.auditLog.push({
            action: 'EXTENSION_RESOLVED',
            details: logDetail,
            ip: req.ip
        });

        await employee.save();
        res.status(200).json({ message: `Extension request ${status.toLowerCase()} successfully`, employee });
    } catch (error) {
        console.error('Error resolving extension:', error);
        res.status(500).json({ message: 'Failed to resolve extension', error: error.message });
    }
};

