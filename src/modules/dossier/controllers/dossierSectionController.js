const EmployeeProfile = require('../employeeProfile.model');
const User = require('../../user/user.model');
const NotificationService = require('../../../services/notificationService');
const {
    isValidEmail,
    isValidPhone,
    isValidAadhaar,
    isValidPAN,
    hasModifiedSensitiveField,
    getDossierDiff,
    mergePendingUpdates,
    checkIsAdmin,
    hasPermission,
    getHRISApprovers
} = require('../utils/dossierHelpers');
const { logDossierActivity } = require('./dossierHistoryController');

exports.submitHRIS = async (req, res) => {
    try {
        const { userId } = req.params;
        const updates = req.body;
        const viewerId = req.user._id.toString();
        const isSelf = userId === viewerId;
        const isAdmin = checkIsAdmin(req.user);
        const canEdit = isSelf || isAdmin || hasPermission(req.user, 'dossier.edit');

        if (!canEdit) {
            return res.status(403).json({ message: 'Not authorized to submit HRIS for this user' });
        }

        const profile = await EmployeeProfile.findOne({
            user: userId,
            companyId: req.companyId
        })
            .select('+identity.aadhaarNumber +identity.panNumber +identity.passportNumber +compensation.ctc +compensation.bankDetails.accountNumber');

        if (!profile) return res.status(404).json({ message: 'Profile not found' });

        const currentMaritalStatus = updates.personal?.maritalStatus || profile.personal?.maritalStatus;
        const spouseName = updates.family?.spouseName || profile.family?.spouseName;
        if (currentMaritalStatus === 'Married' && (!spouseName || !spouseName.trim())) {
            return res.status(400).json({ message: 'Spouse Name is required when marital status is Married' });
        }

        if (updates.personal) {
            if (updates.personal.nationality !== undefined && (!updates.personal.nationality || !updates.personal.nationality.trim())) {
                return res.status(400).json({ message: 'Nationality is required' });
            }
            if (updates.personal.bloodGroup !== undefined && (!updates.personal.bloodGroup || !updates.personal.bloodGroup.trim())) {
                return res.status(400).json({ message: 'Blood Group is required' });
            }
            if (updates.personal.disabilityStatus !== undefined && (updates.personal.disabilityStatus === null || updates.personal.disabilityStatus === undefined)) {
                return res.status(400).json({ message: 'Disability Status is required' });
            }
            if (updates.personal.disabilityStatus === true && (!updates.personal.disabilityDetails || !updates.personal.disabilityDetails.trim())) {
                return res.status(400).json({ message: 'Nature of disability is required if Disability Status is Yes' });
            }
        }
        if (updates.contact?.emergencyContact) {
            const ec = updates.contact.emergencyContact;
            if (ec.name !== undefined && (!ec.name || !ec.name.trim())) {
                return res.status(400).json({ message: 'Emergency contact name is required' });
            }
            if (ec.relation !== undefined && (!ec.relation || !ec.relation.trim())) {
                return res.status(400).json({ message: 'Emergency contact relation is required' });
            }
            if (ec.email && !isValidEmail(ec.email)) {
                return res.status(400).json({ message: 'Invalid emergency contact email format' });
            }
        }

        const originalProfile = profile.toObject();

        if (updates.contact) {
            if (updates.contact.personalEmail && !isValidEmail(updates.contact.personalEmail)) {
                return res.status(400).json({ message: 'Invalid personal email format' });
            }
            if (updates.contact.workEmail && !isValidEmail(updates.contact.workEmail)) {
                return res.status(400).json({ message: 'Invalid work email format' });
            }
            if (updates.contact.mobileNumber && !isValidPhone(updates.contact.mobileNumber)) {
                return res.status(400).json({ message: 'Mobile number must be a 10-digit number' });
            }
            if (updates.contact.alternateNumber && !isValidPhone(updates.contact.alternateNumber)) {
                return res.status(400).json({ message: 'Alternate mobile number must be a 10-digit number' });
            }
            if (updates.contact.emergencyContact) {
                const ec = updates.contact.emergencyContact;
                if (!ec.phone || !ec.phone.trim()) {
                    return res.status(400).json({ message: 'Emergency contact phone number is required' });
                }
                if (!isValidPhone(ec.phone)) {
                    return res.status(400).json({ message: 'Emergency contact phone number must be a 10-digit number' });
                }
                if (!ec.alternatePhone || !ec.alternatePhone.trim()) {
                    return res.status(400).json({ message: 'Emergency contact alternate phone number is required' });
                }
                if (!isValidPhone(ec.alternatePhone)) {
                    return res.status(400).json({ message: 'Emergency contact alternate phone number must be a 10-digit number' });
                }
            }
            if (updates.contact.addresses && Array.isArray(updates.contact.addresses)) {
                const currentAddr = updates.contact.addresses.find(a => a.type === 'Current');
                const permanentAddr = updates.contact.addresses.find(a => a.type === 'Permanent');

                if (!currentAddr) {
                    return res.status(400).json({ message: 'Current address is required' });
                }
                if (!permanentAddr) {
                    return res.status(400).json({ message: 'Permanent address is required' });
                }

                const requiredCurrentFields = ['line1', 'addressLine2', 'city', 'state', 'zipCode', 'country', 'phone'];
                for (const f of requiredCurrentFields) {
                    if (!currentAddr[f] || !currentAddr[f].toString().trim()) {
                        const fieldNameLabel = f === 'line1' ? 'Line 1' : f === 'addressLine2' ? 'Line 2' : f === 'zipCode' ? 'Pincode' : f;
                        return res.status(400).json({ message: `Current Address ${fieldNameLabel} is required` });
                    }
                }
                if (!isValidPhone(currentAddr.phone)) {
                    return res.status(400).json({ message: 'Current Address Phone must be a valid 10-digit number' });
                }

                const requiredPermFields = ['line1', 'addressLine2', 'city', 'state', 'zipCode', 'country'];
                for (const f of requiredPermFields) {
                    if (!permanentAddr[f] || !permanentAddr[f].toString().trim()) {
                        const fieldNameLabel = f === 'line1' ? 'Line 1' : f === 'addressLine2' ? 'Line 2' : f === 'zipCode' ? 'Pincode' : f;
                        return res.status(400).json({ message: `Permanent Address ${fieldNameLabel} is required` });
                    }
                }
            }
        }

        if (updates.identity) {
            if (updates.identity.aadhaarNumber && !isValidAadhaar(updates.identity.aadhaarNumber)) {
                return res.status(400).json({ message: 'Aadhaar number must be a 12-digit number' });
            }
            if (updates.identity.panNumber && !isValidPAN(updates.identity.panNumber)) {
                return res.status(400).json({ message: 'PAN number must be a valid 10-character alphanumeric code' });
            }
        }

        const canEditSensitive = isAdmin || hasPermission(req.user, 'dossier.edit.sensitive') || hasPermission(req.user, 'payroll.salary.manage');
        if (!canEditSensitive) {
            const profileObj = profile.toObject();

            const employmentKeys = ['designation', 'department', 'businessUnit', 'reportingManager', 'joiningDate', 'confirmationDate', 'status', 'workLocation', 'branch', 'employmentType'];
            if (updates.employment && hasModifiedSensitiveField(profileObj.employment || {}, updates.employment, employmentKeys)) {
                return res.status(403).json({ message: 'You are not authorized to modify sensitive employment details. Contact HR.' });
            }

            const sensitiveCompKeys = ['ctc', 'salaryBreakup'];
            if (updates.compensation && hasModifiedSensitiveField(profileObj.compensation || {}, updates.compensation, sensitiveCompKeys)) {
                return res.status(403).json({ message: 'You are not authorized to modify sensitive compensation details. Contact HR.' });
            }
        }

        const shouldDirectWrite = isAdmin && !isSelf;

        if (shouldDirectWrite) {
            if (updates.personal) profile.personal = { ...(profile.personal?.toObject?.() || {}), ...updates.personal };
            if (updates.identity) profile.identity = { ...(profile.identity?.toObject?.() || {}), ...updates.identity };
            if (updates.contact) profile.contact = { ...(profile.contact?.toObject?.() || {}), ...updates.contact };
            if (updates.family) profile.family = { ...(profile.family?.toObject?.() || {}), ...updates.family };
            if (updates.employment) profile.employment = { ...(profile.employment?.toObject?.() || {}), ...updates.employment };
            if (updates.compensation) {
                const isUanApplicable = updates.compensation.isUanApplicable;
                const uan = updates.compensation.uanNumber;
                if (isUanApplicable === true) {
                    if (!uan || !uan.trim()) {
                        return res.status(400).json({ message: 'UAN Number is required when UAN is applicable' });
                    }
                    if (!/^\d{12}$/.test(uan)) {
                        return res.status(400).json({ message: 'UAN must be a 12-digit number' });
                    }
                } else if (isUanApplicable === false) {
                    updates.compensation.uanNumber = '';
                }
                profile.compensation = {
                    ...(profile.compensation?.toObject?.() || {}),
                    ...updates.compensation,
                    bankDetails: { ...(profile.compensation?.bankDetails || {}), ...(updates.compensation?.bankDetails || {}) }
                };
            }
            if (updates.education) profile.education = updates.education;
            if (updates.experience) profile.experience = updates.experience;
            if (updates.skills) profile.skills = updates.skills;

            profile.pendingUpdates = null;

            if (updates.hris) {
                profile.hris = {
                    ...profile.hris,
                    ...updates.hris,
                    lastUpdatedAt: new Date()
                };
                if (updates.hris.isDeclared) {
                    profile.hris.submittedAt = new Date();
                    profile.hris.declarationDate = new Date();
                    profile.hris.status = 'Approved';
                }
            }
        } else {
            const pending = { ...(profile.pendingUpdates || {}) };

            if (updates.personal) pending.personal = { ...(pending.personal || {}), ...updates.personal };
            if (updates.identity) pending.identity = { ...(pending.identity || {}), ...updates.identity };
            if (updates.contact) pending.contact = { ...(pending.contact || {}), ...updates.contact };
            if (updates.family) pending.family = { ...(pending.family || {}), ...updates.family };
            if (updates.employment) pending.employment = { ...(pending.employment || {}), ...updates.employment };
            if (updates.compensation) {
                const isUanApplicable = updates.compensation.isUanApplicable;
                const uan = updates.compensation.uanNumber;
                if (isUanApplicable === true) {
                    if (!uan || !uan.trim()) {
                        return res.status(400).json({ message: 'UAN Number is required when UAN is applicable' });
                    }
                    if (!/^\d{12}$/.test(uan)) {
                        return res.status(400).json({ message: 'UAN must be a 12-digit number' });
                    }
                } else if (isUanApplicable === false) {
                    updates.compensation.uanNumber = '';
                }
                pending.compensation = {
                    ...(pending.compensation || {}),
                    ...updates.compensation,
                    bankDetails: { ...(pending.compensation?.bankDetails || {}), ...(updates.compensation?.bankDetails || {}) }
                };
            }
            if (updates.education) pending.education = updates.education;
            if (updates.experience) pending.experience = updates.experience;
            if (updates.skills) pending.skills = updates.skills;

            profile.pendingUpdates = pending;
            profile.markModified('pendingUpdates');

            if (updates.hris) {
                profile.hris = {
                    ...profile.hris,
                    ...updates.hris,
                    lastUpdatedAt: new Date()
                };
                if (updates.hris.isDeclared) {
                    profile.hris.submittedAt = new Date();
                    profile.hris.declarationDate = new Date();
                    profile.hris.status = 'Pending Approval';
                } else {
                    profile.hris.status = 'Draft';
                    profile.hris.isDeclared = false;
                }
            }
        }

        const diff = { oldValues: {}, newValues: {} };
        ['personal', 'identity', 'contact', 'family', 'employment', 'compensation', 'education', 'experience', 'skills'].forEach(section => {
            if (updates[section]) {
                const sectionDiff = getDossierDiff(originalProfile[section], updates[section], section);
                Object.assign(diff.oldValues, sectionDiff.oldValues);
                Object.assign(diff.newValues, sectionDiff.newValues);
            }
        });

        await profile.save();

        if (!shouldDirectWrite && updates.hris && updates.hris.isDeclared) {
            try {
                const io = req.app.get('io');
                const submittingUser = await User.findById(userId).select('firstName lastName').lean();
                const employeeName = submittingUser ? `${submittingUser.firstName} ${submittingUser.lastName}`.trim() : 'An employee';
                const approvers = await getHRISApprovers(req.companyId, userId);

                if (approvers.length > 0) {
                    const notifications = approvers.map(approver => ({
                        user: approver._id,
                        companyId: req.companyId,
                        preferenceKey: 'hris_submission_received',
                        title: 'HRIS Approval Needed',
                        message: `${employeeName} has submitted their HRIS details for approval.`,
                        type: 'Approval',
                        link: `/dossier/${userId}?tab=hris`,
                        origin: req.headers?.origin || ''
                    }));
                    await NotificationService.createManyNotifications(io, notifications);
                }
            } catch (notifErr) {
                console.error('[dossierController] Failed to send HRIS submission notification:', notifErr);
            }
        }

        await logDossierActivity({
            action: 'SUBMIT_HRIS',
            performedBy: req.user._id,
            companyId: req.companyId,
            details: {
                targetUser: userId,
                targetuser: userId,
                companyId: req.companyId,
                oldValues: diff.oldValues,
                newValues: diff.newValues,
                originModule: 'HRIS'
            },
            ipAddress: req.ip
        });

        const mergedProfile = mergePendingUpdates(profile.toObject());
        mergedProfile.pendingUpdates = profile.pendingUpdates;

        res.status(200).json({ message: 'HRIS Form saved successfully', profile: mergedProfile });

    } catch (error) {
        console.error('Submit HRIS Error:', error);
        res.status(500).json({ message: 'Server Error', error: error.message });
    }
};

exports.updateSection = async (req, res) => {
    try {
        const { userId, section } = req.params;
        const updates = req.body;
        const viewerId = req.user._id.toString();
        const isSelf = userId === viewerId;
        const isAdmin = checkIsAdmin(req.user);
        let canEdit = isSelf || isAdmin || hasPermission(req.user, 'dossier.edit');
        if (section === 'compensation' && hasPermission(req.user, 'payroll.salary.manage')) {
            canEdit = true;
        }

        if (!canEdit) {
            return res.status(403).json({ message: 'Not authorized to edit this profile' });
        }

        const canEditSensitive = isAdmin || hasPermission(req.user, 'dossier.edit.sensitive') || hasPermission(req.user, 'payroll.salary.manage');

        if (!isAdmin && !canEditSensitive) {
            if (section === 'employment') {
                return res.status(403).json({ message: 'You cannot edit this section. Contact HR.' });
            }
            if (section === 'compensation') {
                if (updates && typeof updates === 'object') {
                    const compKeys = Object.keys(updates);
                    const allowedKeys = ['bankDetails', 'uanNumber'];
                    const hasDisallowed = compKeys.some(k => !allowedKeys.includes(k));
                    if (hasDisallowed) {
                        return res.status(403).json({ message: 'You are not authorized to modify sensitive salary/compensation details. Contact HR.' });
                    }
                }
            }
        }

        const profile = await EmployeeProfile.findOne({
            user: userId,
            companyId: req.companyId
        })
            .select('+identity.aadhaarNumber +identity.panNumber +identity.passportNumber +compensation.ctc +compensation.bankDetails.accountNumber +compensation.uanNumber');
        if (!profile) return res.status(404).json({ message: 'Profile not found' });

        const originalProfile = profile.toObject();

        if (section === 'contact') {
            if (updates.personalEmail && !isValidEmail(updates.personalEmail)) {
                return res.status(400).json({ message: 'Invalid personal email format' });
            }
            if (updates.workEmail && !isValidEmail(updates.workEmail)) {
                return res.status(400).json({ message: 'Invalid work email format' });
            }
            if (updates.mobileNumber && !isValidPhone(updates.mobileNumber)) {
                return res.status(400).json({ message: 'Mobile number must be a 10-digit number' });
            }
            if (updates.alternateNumber && !isValidPhone(updates.alternateNumber)) {
                return res.status(400).json({ message: 'Alternate mobile number must be a 10-digit number' });
            }
            if (updates.emergencyContact) {
                const ec = updates.emergencyContact;
                if (!ec.phone || !ec.phone.trim()) {
                    return res.status(400).json({ message: 'Emergency contact phone number is required' });
                }
                if (!isValidPhone(ec.phone)) {
                    return res.status(400).json({ message: 'Emergency contact phone number must be a 10-digit number' });
                }
                if (!ec.alternatePhone || !ec.alternatePhone.trim()) {
                    return res.status(400).json({ message: 'Emergency contact alternate phone number is required' });
                }
                if (!isValidPhone(ec.alternatePhone)) {
                    return res.status(400).json({ message: 'Emergency contact alternate phone number must be a 10-digit number' });
                }
            }
            if (updates.addresses && Array.isArray(updates.addresses)) {
                const currentAddr = updates.addresses.find(a => a.type === 'Current');
                const permanentAddr = updates.addresses.find(a => a.type === 'Permanent');

                if (!currentAddr) {
                    return res.status(400).json({ message: 'Current address is required' });
                }
                if (!permanentAddr) {
                    return res.status(400).json({ message: 'Permanent address is required' });
                }

                const requiredCurrentFields = ['line1', 'addressLine2', 'city', 'state', 'zipCode', 'country', 'phone'];
                for (const f of requiredCurrentFields) {
                    if (!currentAddr[f] || !currentAddr[f].toString().trim()) {
                        const fieldNameLabel = f === 'line1' ? 'Line 1' : f === 'addressLine2' ? 'Line 2' : f === 'zipCode' ? 'Pincode' : f;
                        return res.status(400).json({ message: `Current Address ${fieldNameLabel} is required` });
                    }
                }
                if (!isValidPhone(currentAddr.phone)) {
                    return res.status(400).json({ message: 'Current Address Phone must be a valid 10-digit number' });
                }

                const requiredPermFields = ['line1', 'addressLine2', 'city', 'state', 'zipCode', 'country'];
                for (const f of requiredPermFields) {
                    if (!permanentAddr[f] || !permanentAddr[f].toString().trim()) {
                        const fieldNameLabel = f === 'line1' ? 'Line 1' : f === 'addressLine2' ? 'Line 2' : f === 'zipCode' ? 'Pincode' : f;
                        return res.status(400).json({ message: `Permanent Address ${fieldNameLabel} is required` });
                    }
                }
            }
        }

        if (section === 'identity') {
            if (updates.aadhaarNumber && !isValidAadhaar(updates.aadhaarNumber)) {
                return res.status(400).json({ message: 'Aadhaar number must be a 12-digit number' });
            }
            if (updates.panNumber && !isValidPAN(updates.panNumber)) {
                return res.status(400).json({ message: 'PAN number must be a valid 10-character alphanumeric code' });
            }
        }

        if (section === 'personal') {
            if (updates.disabilityStatus === true && (!updates.disabilityDetails || !updates.disabilityDetails.trim())) {
                return res.status(400).json({ message: 'Nature of disability is required if Disability Status is Yes' });
            }
        }

        if (section === 'family') {
            const currentMaritalStatus = profile.personal?.maritalStatus;
            if (currentMaritalStatus === 'Married' && (!updates.spouseName || !updates.spouseName.trim())) {
                return res.status(400).json({ message: 'Spouse Name is required when marital status is Married' });
            }
        }
        if (section === 'compensation') {
            const isUanApplicable = updates.isUanApplicable;
            const uan = updates.uanNumber;
            if (isUanApplicable === true) {
                if (!uan || !uan.trim()) {
                    return res.status(400).json({ message: 'UAN Number is required when UAN is applicable' });
                }
                if (!/^\d{12}$/.test(uan)) {
                    return res.status(400).json({ message: 'UAN must be a 12-digit number' });
                }
            } else if (isUanApplicable === false) {
                updates.uanNumber = '';
            }
        }

        const shouldDirectWrite = isAdmin && !isSelf;

        if (shouldDirectWrite) {
            if (['experience', 'education'].includes(section)) {
                profile[section] = Array.isArray(updates) ? updates : [];
            } else {
                if (!profile[section]) {
                    profile[section] = {};
                }

                Object.keys(updates).forEach(key => {
                    let value = updates[key];
                    if (value === "") {
                        value = null;
                    }

                    if (profile[section] && typeof profile[section] === 'object') {
                        profile[section][key] = value;
                    }
                });
                profile.markModified(section);
            }
        } else {
            if (!profile.pendingUpdates) {
                profile.pendingUpdates = {};
            }
            if (['experience', 'education'].includes(section)) {
                profile.pendingUpdates[section] = Array.isArray(updates) ? updates : [];
            } else {
                if (!profile.pendingUpdates[section]) {
                    profile.pendingUpdates[section] = {};
                }
                Object.keys(updates).forEach(key => {
                    let value = updates[key];
                    if (value === "") {
                        value = null;
                    }
                    profile.pendingUpdates[section][key] = value;
                });
            }
            profile.markModified('pendingUpdates');
        }

        if (!shouldDirectWrite && profile.hris && (profile.hris.isDeclared || profile.hris.status !== 'Draft')) {
            profile.hris.isDeclared = false;
            profile.hris.status = 'Draft';
        }

        const diff = getDossierDiff(originalProfile[section], updates, section);
        const originModule = req.body.originModule || req.headers['x-origin-module'] || (section === 'experience' ? 'Employment History' : 'Personal Information');

        await profile.save();

        await logDossierActivity({
            action: 'UPDATE_DOSSIER',
            performedBy: req.user._id,
            companyId: req.companyId,
            details: {
                targetUser: userId,
                targetuser: userId,
                companyId: req.companyId,
                section,
                updates: updates,
                oldValues: diff.oldValues,
                newValues: diff.newValues,
                originModule
            },
            ipAddress: req.ip
        });

        const mergedProfile = mergePendingUpdates(profile.toObject());
        res.status(200).json({ message: 'Updated successfully', sectionData: mergedProfile[section] });

    } catch (error) {
        console.error('Update Dossier Error:', error);
        res.status(500).json({ message: 'Server Error', error: error.message });
    }
};
