const OnboardingEmployee = require('../model/onboardingEmployee.model');
const Candidate = require('../../talent-acquisition/model/candidate.model');
const Company = require('../../company/company.model');
const User = require('../../user/user.model');
const Role = require('../../user/role.model');
const EmployeeProfile = require('../../dossier/employeeProfile.model');
const HREmailLog = require('../../email/model/hrEmailLog.model');
const { sendEmailForCompany } = require('../../../services/companyEmailService');
const { getCompanyEmailBranding } = require('./onboardingEmailController');
const {
    generateTempPassword,
    resolveNotificationEmailDelivery,
    syncTADecision
} = require('../utils/onboardingHelpers');
const { getPopulatedDocumentBuffer } = require('./onboardingDocGenController');
const { dispatchEmployeeWebhook } = require('../../payroll/payrollIntegration.service');
const { cloudinary } = require('../../../config/cloudinary');

const DOC_CATEGORY_MAP = {
    'resume': 'Resume',
    'pan': 'ID Proof',
    'aadhaar_front': 'ID Proof',
    'aadhaar_back': 'ID Proof',
    'passport': 'ID Proof',
    'passport_photo': 'ID Proof',
    'live_photo': 'ID Proof',
    'salary_slip': 'Payslips',
    '10th_marksheet': 'Education',
    '12th_marksheet': 'Education',
    'graduation': 'Education',
    'relieving_letter': 'Relieving Letter',
    'experience_certificate': 'Employment',
    'character_certificate': 'Other'
};

const DOC_TITLE_MAP = {
    'passport': 'Passport',
    'passport_photo': 'Recent Passport-Size Photograph',
    'live_photo': 'Live Photograph',
    'experience_certificate': 'Previous Experience Certificate',
    'character_certificate': 'Character Certificate'
};

const EMPLOYMENT_WORK_LOCATION_OPTIONS = new Set(['Office', 'Remote', 'Hybrid']);

const normalizeEmploymentWorkLocation = (value = '') => {
    const trimmedValue = String(value || '').trim();
    return EMPLOYMENT_WORK_LOCATION_OPTIONS.has(trimmedValue) ? trimmedValue : 'Office';
};

const uploadBufferToCloudinary = async (buffer, folder, filename) => {
    return new Promise((resolve, reject) => {
        const stream = cloudinary.uploader.upload_stream(
            {
                folder,
                resource_type: 'raw',
                public_id: filename
            },
            (error, uploaded) => {
                if (error) {
                    console.error('Cloudinary upload error:', error);
                    return reject(error);
                }
                resolve(uploaded);
            }
        );
        stream.end(buffer);
    });
};

exports.transferToActiveEmployee = async (req, res) => {
    try {
        const { roleId, employeeCode, password } = req.body || {};

        const employee = await OnboardingEmployee.findOne({ _id: req.params.id, companyId: req.companyId });
        if (!employee) return res.status(404).json({ message: 'Onboarding employee not found' });

        if (employee.transferredToUserId) {
            return res.status(400).json({ message: 'This employee has already been transferred to an active user.' });
        }

        const company = await Company.findById(req.companyId).populate('planId');
        if (company && company.allowedDomains && company.allowedDomains.length > 0) {
            const userEmailDomain = employee.email.split('@')[1];
            if (!company.allowedDomains.includes(userEmailDomain)) {
                return res.status(400).json({ message: "Email for this user is not authorized for this company. Please update to an allowed domain before transferring." });
            }
        }

        if (company && company.planId) {
            const activeUserCount = await User.countDocuments({ companyId: req.companyId, isActive: true });
            if (activeUserCount >= company.planId.maxUsers) {
                return res.status(403).json({
                    message: `Plan Limit Reached: You have used all ${company.planId.maxUsers} active user slots. Please upgrade your plan to activate this employee.`
                });
            }
        }

        const existingUser = await User.findOne({ email: employee.email, companyId: req.companyId });
        if (existingUser) {
            return res.status(400).json({ message: `A user with email ${employee.email} already exists.` });
        }

        let assignedRoleId = roleId;
        if (!assignedRoleId) {
            const defaultRole = await Role.findOne({ name: 'Employee', companyId: req.companyId });
            if (!defaultRole) {
                return res.status(400).json({ message: 'No roleId provided and no default "Employee" role found. Please specify a role.' });
            }
            assignedRoleId = defaultRole._id;
        }

        const userPassword = password || generateTempPassword();

        const newUser = await User.create({
            companyId: req.companyId,
            firstName: employee.firstName,
            lastName: employee.lastName || '',
            email: employee.email,
            password: userPassword,
            roles: [assignedRoleId],
            department: employee.department || '',
            workLocation: employee.workLocation || '',
            employmentType: 'Full Time',
            employeeCode: (typeof employeeCode === 'string' && employeeCode.trim() !== '')
                ? employeeCode.trim()
                : (typeof employee.tempEmployeeId === 'string' && employee.tempEmployeeId.trim() !== '' ? employee.tempEmployeeId.trim() : undefined),
            joiningDate: employee.joiningDate || new Date(),
            isPasswordResetRequired: true
        });

        const personalDetails = employee.personalDetails || {};
        const emergencyContact = employee.emergencyContact || {};
        const bankDetails = employee.bankDetails || {};
        const normalizedEmploymentWorkLocation = normalizeEmploymentWorkLocation(employee.workLocation);

        const dossierDocuments = (employee.documents || [])
            .filter(doc => doc.url)
            .map(doc => {
                const normalizedTitle = DOC_TITLE_MAP[doc.type] || doc.label;

                return ({
                    category: DOC_CATEGORY_MAP[doc.type] || 'Other',
                    title: normalizedTitle,
                    fileName: normalizedTitle.replace(/[^a-zA-Z0-9]/g, '_') + '.pdf',
                    url: doc.url,
                    uploadDate: doc.uploadedAt || new Date(),
                    verificationStatus: doc.status === 'Approved' ? 'Verified' : 'Pending',
                    livePhotoMetadata: doc.livePhotoMetadata
                });
            });

        if (bankDetails.cancelledChequeUrl) {
            dossierDocuments.push({
                category: 'Bank',
                title: 'Cancelled Cheque / Passbook Front Page',
                fileName: 'Cancelled_Cheque_Passbook_Front_Page.pdf',
                url: bankDetails.cancelledChequeUrl,
                uploadDate: new Date(),
                verificationStatus: 'Pending'
            });
        }

        const acceptedTemplates = employee.offerDeclaration?.acceptedTemplates || [];
        for (const acceptedT of acceptedTemplates) {
            const template = company.settings?.onboarding?.dynamicTemplates?.find(t => t._id.toString() === acceptedT.templateId.toString());
            if (template && template.url) {
                try {
                    const templateBuffer = await getPopulatedDocumentBuffer(employee, company, template.url);
                    const candidateName = `${employee.firstName}_${employee.lastName || ''}`.replace(/[^a-zA-Z0-9]/g, '_').replace(/_+/g, '_').trim();
                    const safeName = template.name.replace(/[^a-zA-Z0-9\s]/g, '').replace(/\s+/g, '_');
                    const candidateSafeName = `${candidateName}_${safeName}`;
                    const uploadedTemplate = await uploadBufferToCloudinary(
                        templateBuffer,
                        `talentcio/${employee.companyId}/dossier/${newUser._id}`,
                        `${candidateSafeName}_${Date.now()}.docx`
                    );

                    dossierDocuments.push({
                        category: 'Other',
                        title: `${template.name} - ${employee.firstName} ${employee.lastName || ''}`.trim(),
                        fileName: `${candidateSafeName}.docx`,
                        url: uploadedTemplate.secure_url,
                        uploadDate: acceptedT.acceptedAt || new Date(),
                        verificationStatus: 'Verified'
                    });
                } catch (err) {
                    console.error(`Failed to transfer dynamic template ${template.name}:`, err.message);
                }
            }
        }

        if (employee.offerStatus === 'Accepted') {
            const offerLetterTemplateUrl = employee.offerLetterUrl || company.settings?.onboarding?.offerLetterTemplateUrl;
            if (offerLetterTemplateUrl) {
                try {
                    const offerLetterBuffer = await getPopulatedDocumentBuffer(employee, company, offerLetterTemplateUrl);
                    const candidateName = `${employee.firstName}_${employee.lastName || ''}`.replace(/[^a-zA-Z0-9]/g, '_').replace(/_+/g, '_').trim();
                    const uploadedOffer = await uploadBufferToCloudinary(
                        offerLetterBuffer,
                        `talentcio/${employee.companyId}/dossier/${newUser._id}`,
                        `Offer_Letter_${candidateName}_${Date.now()}.docx`
                    );

                    dossierDocuments.push({
                        category: 'Offer Letter',
                        title: 'Offer Letter',
                        fileName: `Offer_Letter_${candidateName}.docx`,
                        url: uploadedOffer.secure_url,
                        uploadDate: employee.offerDeclaration?.eSignDate || new Date(),
                        verificationStatus: 'Verified'
                    });
                } catch (err) {
                    console.error('Failed to transfer Offer Letter:', err.message);
                }
            }
        }

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
                nationality: 'Indian',
                joiningDate: employee.joiningDate || new Date()
            },
            identity: {},
            contact: {
                personalEmail: personalDetails.personalEmail || '',
                workEmail: employee.email || '',
                mobileNumber: personalDetails.personalMobile || employee.phone || '',
                emergencyNumber: emergencyContact.phoneNumber || '',
                emergencyContact: {
                    name: emergencyContact.contactName || '',
                    relation: emergencyContact.relationship || '',
                    phone: emergencyContact.phoneNumber || '',
                },
                addresses: personalDetails.currentAddress?.line1 ? [{
                    type: 'Current',
                    line1: personalDetails.currentAddress.line1,
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
                workLocation: normalizedEmploymentWorkLocation,
                branch: employee.workLocation || '',
                employmentType: 'Full Time'
            },
            compensation: {
                ctc: employee.salary?.annualCTC ? (parseFloat(employee.salary.annualCTC) / 12) : (employee.salary?.monthlyCTC ? parseFloat(employee.salary.monthlyCTC) : null),
                salaryBreakup: employee.salary || {},
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

        newUser.employeeProfile = profile._id;
        await newUser.save();

        employee.transferredToUserId = newUser._id;
        employee.status = 'Reviewed';
        employee.auditLog.push({
            action: 'TRANSFERRED_TO_ACTIVE',
            details: `Transferred to active employee (User: ${newUser._id}) by ${req.user.firstName || 'Admin'}. Temporary Credentials - Email: ${newUser.email}, Password: ${userPassword}`
        });
        await employee.save();

        await syncTADecision(employee, 'Joined');

        void dispatchEmployeeWebhook({
            companyId: req.companyId,
            company: req.company,
            userId: newUser._id,
            event: 'employee.activated'
        }).catch((webhookError) => {
            console.error('[PayrollWebhook] transferToActiveEmployee failed:', webhookError.message);
        });

        const portalUrl = `${req.headers.origin || process.env.FRONTEND_URL || 'http://localhost:5173'}/login`;
        const branding = await getCompanyEmailBranding(employee.companyId, req.company);
        const delivery = await resolveNotificationEmailDelivery(
            employee.companyId,
            'onboarding_account_ready'
        );
        if (delivery.shouldSendEmail) {
            const emailHtml = `
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
            `;

            await sendEmailForCompany({
                companyId: employee.companyId,
                emailAccountId: delivery.emailAccountId,
                to: employee.email,
                subject: `Welcome! Your Employee Account is Ready`,
                html: emailHtml,
                ...branding
            });

            await HREmailLog.create({
                companyId: employee.companyId,
                sentBy: req.user?._id,
                recipientUserId: newUser._id,
                recipientEmail: employee.email,
                subject: `Welcome! Your Employee Account is Ready`,
                body: emailHtml,
                type: 'onboarding',
                templateName: 'Account Activation',
                emailAccountId: delivery.emailAccountId || 'platform',
                emailAccountLabel: delivery.emailAccountId === 'platform' ? 'TalentCIO Platform' : (delivery.emailAccountId || 'TalentCIO Platform'),
                sentAt: new Date()
            });
        }

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
