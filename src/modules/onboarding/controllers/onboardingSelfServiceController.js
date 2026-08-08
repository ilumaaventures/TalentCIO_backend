const OnboardingEmployee = require('../onboardingEmployee.model');
const Company = require('../../company/company.model');
const NotificationService = require('../../../services/notificationService');
const jwt = require('jsonwebtoken');
const { setSessionCookie, clearSessionCookie } = require('../../../common/utils/sessionCookies');
const { extractPublicIdFromUrl } = require('../../../utils/cloudinaryHelper');
const { cloudinary } = require('../../../config/cloudinary');
const { normalizeOnboardingExperienceCertificateLabels } = require('../utils/onboardingHelpers');
const { formatEmployeeDynamicTemplates } = require('./onboardingAdminController');
const { getPopulatedDocumentBuffer } = require('./onboardingDocGenController');
const { syncTADecision } = require('../utils/onboardingHelpers');
const path = require('path');

exports.employeeLogin = async (req, res) => {
    try {
        const { tempEmployeeId, password } = req.body;

        if (!tempEmployeeId || !password) {
            return res.status(400).json({ message: 'Employee ID and password are required' });
        }

        let query = { tempEmployeeId };
        const tenantSlug = String(req.company?.subdomain || req.headers['x-tenant-id'] || req.query?.tenant || '').trim().toLowerCase();

        if (req.companyId) {
            query.companyId = req.companyId;
        } else if (tenantSlug) {
            const company = await Company.findOne({ subdomain: tenantSlug }).select('_id subdomain');
            if (company) {
                query.companyId = company._id;
                req.companyId = company._id;
                req.company = company;
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

        if (employee.credentialsExpireAt && new Date() > new Date(employee.credentialsExpireAt)) {
            const workspaceSubdomain = req.company?.subdomain
                || (await Company.findById(employee.companyId).select('subdomain').lean())?.subdomain
                || '';
            return res.status(401).json({
                message: 'Your credentials have expired. Please contact HR.',
                workspaceSubdomain
            });
        }

        const token = jwt.sign(
            { id: employee._id, type: 'onboarding', companyId: employee.companyId, tokenVersion: employee.tokenVersion || 0 },
            process.env.JWT_SECRET,
            { expiresIn: '15m' }
        );

        employee.auditLog.push({
            action: 'LOGIN',
            ip: req.ip || req.headers['x-forwarded-for'] || '',
            details: 'Employee logged in'
        });

        if (employee.status === 'Pending') {
            employee.status = 'In Progress';
        }

        await employee.save();

        setSessionCookie(res, req, token, {
            cookieName: 'onboarding_session',
            maxAgeMs: 15 * 60 * 1000
        });

        res.status(200).json({
            isPasswordChanged: employee.isPasswordChanged,
            employee: {
                _id: employee._id,
                tempEmployeeId: employee.tempEmployeeId,
                firstName: employee.firstName,
                lastName: employee.lastName,
                status: employee.status,
                documentDeadline: employee.documentDeadline
            }
        });
    } catch (error) {
        console.error('Error in employee login:', error);
        res.status(500).json({ message: 'Server error', error: error.message });
    }
};

exports.refreshToken = async (req, res) => {
    try {
        const token = jwt.sign(
            { id: req.onboardingEmployee._id, type: 'onboarding', companyId: req.onboardingEmployee.companyId, tokenVersion: req.onboardingEmployee.tokenVersion || 0 },
            process.env.JWT_SECRET,
            { expiresIn: '15m' }
        );
        setSessionCookie(res, req, token, {
            cookieName: 'onboarding_session',
            maxAgeMs: 15 * 60 * 1000
        });
        res.status(200).json({ message: 'Session refreshed' });
    } catch (error) {
        res.status(500).json({ message: 'Server error', error: error.message });
    }
};

exports.changePassword = async (req, res) => {
    try {
        const { newPassword } = req.body;
        if (!newPassword || newPassword.length < 8) {
            return res.status(400).json({ message: 'Password must be at least 8 characters' });
        }

        const employee = req.onboardingEmployee;
        employee.tempPassword = newPassword;
        employee.pendingCredentialPassword = '';
        employee.isPasswordChanged = true;
        employee.passwordChangedAt = new Date();
        employee.auditLog.push({ action: 'PASSWORD_CHANGE', details: 'Password changed on first login' });

        await employee.save();

        const token = jwt.sign(
            { id: employee._id, type: 'onboarding', companyId: employee.companyId, tokenVersion: employee.tokenVersion || 0 },
            process.env.JWT_SECRET,
            { expiresIn: '15m' }
        );

        setSessionCookie(res, req, token, {
            cookieName: 'onboarding_session',
            maxAgeMs: 15 * 60 * 1000
        });

        res.status(200).json({ message: 'Password changed successfully' });
    } catch (error) {
        console.error('Error changing password:', error);
        res.status(500).json({ message: 'Server error', error: error.message });
    }
};

exports.logout = async (req, res) => {
    try {
        const employee = req.onboardingEmployee;
        employee.tokenVersion = (employee.tokenVersion || 0) + 1;
        employee.auditLog.push({
            action: 'LOGOUT',
            ip: req.ip || req.headers['x-forwarded-for'] || '',
            details: 'Employee logged out'
        });

        await employee.save();
        clearSessionCookie(res, req, 'onboarding_session');
        res.status(200).json({ message: 'Logged out successfully' });
    } catch (error) {
        console.error('Error logging out onboarding employee:', error);
        res.status(500).json({ message: 'Server error', error: error.message });
    }
};

exports.getMyOnboarding = async (req, res) => {
    try {
        const employee = await OnboardingEmployee.findById(req.onboardingEmployee._id)
            .select('-tempPassword -auditLog -salary -joiningDate -offerDate -workLocation -address -letterGenerated -offerStatus');

        if (!employee) return res.status(404).json({ message: 'Not found' });

        await normalizeOnboardingExperienceCertificateLabels(employee);

        const company = await Company.findById(employee.companyId).select('settings.onboarding');
        let policies = company?.settings?.onboarding?.policies || [];
        let dynamicTemplates = company?.settings?.onboarding?.dynamicTemplates || [];

        const employeeObj = employee.toObject();

        delete employeeObj.selectionDraft;

        dynamicTemplates = formatEmployeeDynamicTemplates(employeeObj, dynamicTemplates);

        const activeSectionLabels = (employeeObj.requestedSections || []).map(s => s.label).filter(Boolean);
        const activeDocumentLabels = (employeeObj.requestedDocuments || []).map(d => d.label).filter(Boolean);
        const activeTemplateIds = (employeeObj.requestedDocuments || []).map(d => d.templateId?.toString()).filter(Boolean);

        if (activeSectionLabels.length > 0 || activeDocumentLabels.length > 0) {
            if (activeSectionLabels.length > 0) {
                if (!activeSectionLabels.includes('Personal Details')) {
                    delete employeeObj.personalDetails;
                }
                if (!activeSectionLabels.includes('Emergency Contact')) {
                    delete employeeObj.emergencyContact;
                }
                if (!activeSectionLabels.includes('Bank Details')) {
                    delete employeeObj.bankDetails;
                }

                const showOfferDeclaration = activeSectionLabels.includes('Offer Declaration') ||
                    activeDocumentLabels.includes('Offer Letter') ||
                    dynamicTemplates.some(t => {
                        const hasIdAssigned = activeTemplateIds.includes(t._id.toString());
                        if (hasIdAssigned) return true;
                        return t.isDeleted !== true && activeDocumentLabels.includes(t.name);
                    });

                if (!showOfferDeclaration) {
                    delete employeeObj.offerDeclaration;
                }
            }

            if (activeDocumentLabels.length > 0) {
                if (employeeObj.documents) {
                    employeeObj.documents = employeeObj.documents.filter(doc =>
                        activeDocumentLabels.includes(doc.label) ||
                        activeDocumentLabels.some(al => doc.label.startsWith(al))
                    );
                }

                policies = policies.filter(p => {
                    const hasIdAssigned = activeTemplateIds.includes(p._id.toString());
                    if (hasIdAssigned) return true;
                    return p.isDeleted !== true && activeDocumentLabels.includes(p.name);
                });

                dynamicTemplates = dynamicTemplates.filter(t => {
                    const reqDoc = (employee.requestedDocuments || []).find(d => 
                        d.templateId?.toString() === t._id.toString() || d.label === t.name
                    );
                    const isAccepted = (employee.offerDeclaration?.acceptedTemplates || []).some(at => at.templateId === t._id.toString());

                    if (t.isDeleted !== true) {
                        const hasIdAssigned = activeTemplateIds.includes(t._id.toString());
                        if (hasIdAssigned) return true;
                        return activeDocumentLabels.includes(t.name);
                    }
                    return (reqDoc && reqDoc.emailSentAt) || isAccepted;
                });
            }
        }

        const cleanedTemplates = dynamicTemplates.map(t => {
            const tObj = typeof t.toObject === 'function' ? t.toObject() : { ...t };
            delete tObj.url;
            delete tObj.publicId;
            return tObj;
        });

        res.status(200).json({
            ...employeeObj,
            companyPolicies: policies,
            dynamicTemplates: cleanedTemplates
        });
    } catch (error) {
        console.error('Error fetching profile:', error);
        res.status(500).json({ message: 'Server error', error: error.message });
    }
};

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

        if (section === 'personalDetails') {
            employee.personalDetails = { ...employee.personalDetails, ...data, isComplete: true };
        } else if (section === 'emergencyContact') {
            employee.emergencyContact = { ...employee.emergencyContact, ...data, isComplete: true };
        } else if (section === 'bankDetails') {
            employee.bankDetails = { ...employee.bankDetails, ...data, isComplete: true };
        } else if (section === 'offerDeclaration') {
            employee.offerDeclaration = { ...employee.offerDeclaration, ...data, isComplete: true };
        }

        employee.auditLog.push({ action: 'SECTION_SAVE', details: `Saved section ${section}` });
        if (employee.status === 'Pending') employee.status = 'In Progress';

        await employee.save();

        res.status(200).json({ message: 'Section saved', employee });
    } catch (error) {
        console.error('Error saving section:', error);
        res.status(500).json({ message: 'Server error', error: error.message });
    }
};

exports.uploadDocument = async (req, res) => {
    try {
        const { docId } = req.params;
        const employee = req.onboardingEmployee;

        if (!req.file) {
            return res.status(400).json({ message: 'No file uploaded' });
        }

        const doc = employee.documents.id(docId);
        if (!doc) {
            return res.status(404).json({ message: 'Document slot not found' });
        }

        if (doc.publicId) {
            try { await cloudinary.uploader.destroy(doc.publicId, { resource_type: 'raw' }); } catch (e) { /* ignore */ }
        }

        doc.url = req.file.path;
        doc.publicId = extractPublicIdFromUrl(req.file.path);
        doc.status = 'Uploaded';
        doc.rejectionReason = '';
        doc.uploadedAt = new Date();

        if (doc.type === 'live_photo') {
            doc.livePhotoMetadata = {
                capturedAt: new Date(),
                address: req.body.address || ''
            };
        }

        employee.auditLog.push({ action: 'DOCUMENT_UPLOAD', details: `${doc.label} uploaded` });
        if (employee.status === 'Pending') employee.status = 'In Progress';

        await employee.save();

        res.status(200).json({ message: 'Document uploaded', document: doc });
    } catch (error) {
        console.error('Error uploading document:', error);
        res.status(500).json({ message: 'Server error', error: error.message });
    }
};

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

exports.deleteDocumentSlot = async (req, res) => {
    try {
        const { docId } = req.params;
        const employee = req.onboardingEmployee;

        const doc = employee.documents.id(docId);
        if (!doc) return res.status(404).json({ message: 'Document not found' });

        if (!/\(\d+\)$/.test(doc.label)) {
            return res.status(400).json({ message: 'Cannot delete original document slots' });
        }

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

exports.uploadCheque = async (req, res) => {
    try {
        const employee = req.onboardingEmployee;

        if (!req.file) {
            return res.status(400).json({ message: 'No file uploaded' });
        }

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

exports.submitOnboarding = async (req, res) => {
    try {
        const employee = await OnboardingEmployee.findById(req.onboardingEmployee._id).populate('createdBy', 'firstName lastName email');
        if (!employee) return res.status(404).json({ message: 'Not found' });

        if (employee.submittedAt) {
            return res.status(400).json({ message: 'Already submitted' });
        }

        const errors = [];
        const reqSectionsRaw = employee.requestedSections || [];
        const reqDocsRaw = employee.requestedDocuments || [];
        const reqSectionLabels = reqSectionsRaw.map(rs => typeof rs === 'string' ? rs : rs.label);
        const reqDocLabels = reqDocsRaw.map(rd => typeof rd === 'string' ? rd : rd.label);
        const isSelective = reqSectionLabels.length > 0 || reqDocLabels.length > 0;

        if (!isSelective || reqSectionLabels.includes('Personal Details')) {
            if (!employee.personalDetails?.isComplete) errors.push('Personal Details incomplete');
        }
        if (!isSelective || reqSectionLabels.includes('Emergency Contact')) {
            if (!employee.emergencyContact?.isComplete) errors.push('Emergency Contact incomplete');
        }
        if (!isSelective || reqSectionLabels.includes('Bank Details')) {
            if (!employee.bankDetails?.isComplete) errors.push('Bank Details incomplete');
        }

        const company = await Company.findById(employee.companyId).select('settings.onboarding').lean();
        const dynamicTemplates = company?.settings?.onboarding?.dynamicTemplates || [];
        const hasDynamicTemplate = reqDocLabels.includes('Offer Letter') || dynamicTemplates.some(t => reqDocLabels.includes(t.name));

        if (!isSelective || reqSectionLabels.includes('Offer Declaration') || hasDynamicTemplate) {
            if (!employee.offerDeclaration?.isComplete) errors.push('Offer Declaration incomplete');
        }

        const mandatoryDocTypes = ['pan', 'passport_photo', 'aadhaar_front', 'aadhaar_back'];
        for (const doc of employee.documents) {
            const isMandatory = mandatoryDocTypes.includes(doc.type);
            const isRequested = reqDocLabels.includes(doc.label);
            const isSharedCustomFile = doc.type === 'custom_file';

            if (isSelective) {
                if (!isSharedCustomFile && isRequested && (doc.status === 'Pending' || doc.status === 'Mail Sent' || !doc.url) && doc.type !== 'passport' && doc.type !== 'character_certificate') {
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

        if (employee.createdBy && employee.createdBy._id) {
            const io = req.app.get('io');
            await NotificationService.createNotification(io, {
                user: employee.createdBy._id,
                companyId: req.companyId,
                preferenceKey: 'onboarding_submission_received',
                title: 'Onboarding Submission Received',
                message: `${employee.firstName} ${employee.lastName} (${employee.tempEmployeeId}) has submitted their pre-onboarding documents.`,
                type: 'Info',
                link: '/onboarding',
                origin: req.headers.origin
            });
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

exports.acceptPolicy = async (req, res) => {
    try {
        const { policyId } = req.params;
        const employee = req.onboardingEmployee;

        const alreadyAccepted = employee.offerDeclaration.acceptedPolicies.find(p => p.policyId === policyId);
        if (alreadyAccepted) return res.json({ message: 'Policy already accepted' });

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

exports.acceptTemplate = async (req, res) => {
    try {
        const { templateId } = req.params;
        const employeeId = req.onboardingEmployee._id;

        const company = await Company.findById(req.onboardingEmployee.companyId).select('settings.onboarding').lean();
        const template = company.settings.onboarding.dynamicTemplates.find(t => t._id.toString() === templateId);

        if (!template) return res.status(404).json({ message: 'Template not found' });

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
        const defaultPath = path.join(__dirname, '../../../templates/offer_letter_template.docx');

        const buffer = await getPopulatedDocumentBuffer(employee, company, customUrl, defaultPath);

        await OnboardingEmployee.findByIdAndUpdate(employee._id, {
            $push: {
                auditLog: {
                    $each: [{ action: 'OFFER_LETTER_DOWNLOADED', details: 'Employee downloaded offer letter.' }],
                    $slice: -50
                }
            }
        });

        const fullName = employee.personalDetails?.fullName || `${employee.firstName} ${employee.lastName || ''}`.trim();
        const safeName = fullName.replace(/[^a-zA-Z0-9\s]/g, '').replace(/\s+/g, '_');
        res.setHeader('Content-Disposition', `attachment; filename=OfferLetter_${safeName}.docx`);
        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
        res.send(buffer);
    } catch (error) {
        console.error('Error downloading offer letter:', error);
        res.status(500).json({ message: 'Failed to download offer letter', error: error.message });
    }
};

exports.acceptOfferLetter = async (req, res) => {
    try {
        const employee = await OnboardingEmployee.findById(req.onboardingEmployee._id);
        if (!employee) return res.status(404).json({ message: 'Employee not found' });

        const company = await Company.findById(employee.companyId).select('settings.onboarding');
        const policies = company?.settings?.onboarding?.policies || [];
        const dynamicTemplates = company?.settings?.onboarding?.dynamicTemplates || [];

        employee.requestedDocuments.forEach(doc => {
            const label = doc.label;

            if (/offer\s*letter/i.test(label)) {
                doc.status = 'Accepted';
                employee.offerDeclaration.hasReadOfferLetter = true;
            }

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

        const { eSignName, eSignType, eSignValue } = req.body;
        if (!eSignName) {
            return res.status(400).json({ message: 'Signature name is required.' });
        }

        employee.offerDeclaration.hasReadOfferLetter = true;
        employee.offerDeclaration.eSignName = eSignName;
        employee.offerDeclaration.eSignType = eSignType || 'typed';
        employee.offerDeclaration.eSignValue = eSignValue || '';
        employee.offerDeclaration.eSignDate = new Date();
        employee.offerDeclaration.eSignIp = req.ip || req.headers['x-forwarded-for'] || req.socket.remoteAddress || '';
        employee.offerDeclaration.isComplete = true;

        employee.documents.forEach(doc => {
            if (doc.type === 'offer-letter' || dynamicTemplates.some(t => t.name === doc.label)) {
                doc.status = 'Approved';
            }
        });

        employee.offerStatus = 'Accepted';
        if (employee.status === 'Pending') {
            employee.status = 'In Progress';
        }

        employee.auditLog.push({
            action: 'OFFER_ACCEPTED',
            details: `Employee accepted the offer and digitally signed (${eSignType || 'typed'}) as "${eSignName}". IP: ${employee.offerDeclaration.eSignIp}`
        });

        await employee.save();

        await syncTADecision(employee, 'Offer Accepted');

        res.status(200).json({ message: 'Offer accepted and signed successfully!', offerStatus: employee.offerStatus, status: employee.status });
    } catch (error) {
        console.error('Error accepting offer letter:', error);
        res.status(500).json({ message: 'Failed to accept offer letter', error: error.message });
    }
};

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

        const buffer = await getPopulatedDocumentBuffer(employee, company, template.url);
        const candidateName = `${employee.firstName}_${employee.lastName || ''}`.replace(/[^a-zA-Z0-9]/g, '_').replace(/_+/g, '_').trim();
        const safeName = template.name.replace(/[^a-zA-Z0-9\s]/g, '').replace(/\s+/g, '_');
        res.setHeader('Content-Disposition', `attachment; filename=${candidateName}_${safeName}.docx`);
        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
        res.send(buffer);
    } catch (error) {
        console.error('Error downloading template:', error);
        res.status(500).json({ message: 'Failed to download template', error: error.message });
    }
};
