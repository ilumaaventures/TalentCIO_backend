const mongoose = require('mongoose');
const EmployeeProfile = require('../models/EmployeeProfile');
const User = require('../models/User');
const AuditLog = require('../models/AuditLog');
const NotificationService = require('../services/notificationService');
const OnboardingEmployee = require('../models/OnboardingEmployee');
const Company = require('../models/Company');
const { cloudinary } = require('../config/cloudinary');
const { extractPublicIdFromUrl } = require('../utils/cloudinaryHelper');
const {
    DOCUMENT_PENDING_REVIEW_STATUS,
    normalizeDocumentWorkflowStatus,
    isActiveDocument,
    getActiveDocuments,
    syncDocumentSubmissionStatus
} = require('../utils/dossierUtils');
const axios = require('axios');

const BANK_DOCUMENT_TITLE = 'Cancelled Cheque / Passbook Front Page';
const PASSPORT_DOCUMENT_TITLE = 'Passport';
const LEGACY_PASSPORT_DOCUMENT_TITLE = 'Passport (Optional)';
const PASSPORT_PHOTO_DOCUMENT_TITLE = 'Recent Passport-Size Photograph';
const EXPERIENCE_CERTIFICATE_DOCUMENT_TITLE = 'Previous Experience Certificate';
const LEGACY_EXPERIENCE_CERTIFICATE_DOCUMENT_TITLE = 'Experience Certificate';
const OFFER_LETTER_DOCUMENT_TITLE = 'Offer Letter';
const POLICY_SOURCE_LABEL = 'Policy shared during onboarding';

const normalizeDocumentKey = (value = '') => String(value || '').trim().toLowerCase();

const isValidPhone = (phone) => {
    if (phone === undefined || phone === null || phone === '') return true;
    return /^\d{10}$/.test(String(phone).trim());
};

const isValidEmail = (email) => {
    if (email === undefined || email === null || email === '') return true;
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email).trim());
};

const isValidAadhaar = (aadhaar) => {
    if (aadhaar === undefined || aadhaar === null || aadhaar === '') return true;
    return /^\d{12}$/.test(String(aadhaar).trim());
};

const isValidPAN = (pan) => {
    if (pan === undefined || pan === null || pan === '') return true;
    return /^[A-Z]{5}[0-9]{4}[A-Z]{1}$/.test(String(pan).trim().toUpperCase());
};

const hasModifiedSensitiveField = (oldData, newData, keys) => {
    if (!newData) return false;
    if (!oldData) return true;

    const areDatesEqual = (d1, d2) => {
        try {
            const time1 = new Date(d1).getTime();
            const time2 = new Date(d2).getTime();
            return time1 === time2;
        } catch (e) {
            return false;
        }
    };

    const isDateVal = (val) => {
        if (val instanceof Date) return true;
        if (typeof val === 'string' && val.length >= 10 && !isNaN(Date.parse(val)) && isNaN(Number(val))) {
            return val.includes('-') || val.includes('/');
        }
        return false;
    };

    for (const key of keys) {
        if (newData[key] === undefined) continue;

        let oldVal = oldData[key];
        let newVal = newData[key];

        if (isDateVal(oldVal) && isDateVal(newVal)) {
            if (!areDatesEqual(oldVal, newVal)) {
                return true;
            }
            continue;
        }

        if (key === 'bankDetails' && (oldVal || newVal)) {
            const bankKeys = ['accountNumber', 'ifscCode', 'bankName', 'accountHolderName', 'branchAddress'];
            if (hasModifiedSensitiveField(oldVal || {}, newVal || {}, bankKeys)) {
                return true;
            }
            continue;
        }

        const oldStr = oldVal !== undefined && oldVal !== null ? String(oldVal).trim() : '';
        const newStr = newVal !== undefined && newVal !== null ? String(newVal).trim() : '';

        if (oldStr !== newStr) {
            return true;
        }
    }
    return false;
};

const getDossierDiff = (oldObj, newObj, prefix = '') => {
    const diff = { oldValues: {}, newValues: {} };
    if (!newObj) return diff;

    const isDateVal = (val) => {
        if (val instanceof Date) return true;
        if (typeof val === 'string' && val.length >= 10 && !isNaN(Date.parse(val)) && isNaN(Number(val))) {
            return val.includes('-') || val.includes('/');
        }
        return false;
    };

    const areEqual = (v1, v2) => {
        if (isDateVal(v1) && isDateVal(v2)) {
            return new Date(v1).getTime() === new Date(v2).getTime();
        }
        const s1 = v1 !== undefined && v1 !== null ? String(v1).trim() : '';
        const s2 = v2 !== undefined && v2 !== null ? String(v2).trim() : '';
        return s1 === s2;
    };

    const compare = (oldVal, newVal, path) => {
        if (newVal === undefined) return;

        if (Array.isArray(newVal)) {
            const oldArr = Array.isArray(oldVal) ? oldVal : [];
            if (JSON.stringify(oldArr) !== JSON.stringify(newVal)) {
                diff.oldValues[path] = oldArr;
                diff.newValues[path] = newVal;
            }
        } else if (newVal && typeof newVal === 'object' && !(newVal instanceof Date)) {
            const oldSub = oldVal && typeof oldVal === 'object' ? oldVal : {};
            Object.keys(newVal).forEach(key => {
                compare(oldSub[key], newVal[key], path ? `${path}.${key}` : key);
            });
        } else {
            if (!areEqual(oldVal, newVal)) {
                diff.oldValues[path] = oldVal !== undefined && oldVal !== null ? oldVal : null;
                diff.newValues[path] = newVal !== undefined && newVal !== null ? newVal : null;
            }
        }
    };

    compare(oldObj, newObj, prefix);
    return diff;
};

const mergePendingUpdates = (profileObj) => {
    if (!profileObj) return profileObj;
    const pending = profileObj.pendingUpdates;
    if (!pending) return profileObj;

    const merged = { ...profileObj };

    // Helper to merge nested objects
    const mergeObj = (target, src) => {
        if (!src) return target;
        if (!target) return src;
        return { ...target, ...src };
    };

    if (pending.personal) merged.personal = mergeObj(merged.personal, pending.personal);
    if (pending.identity) merged.identity = mergeObj(merged.identity, pending.identity);
    if (pending.contact) merged.contact = mergeObj(merged.contact, pending.contact);
    if (pending.family) merged.family = mergeObj(merged.family, pending.family);
    if (pending.employment) merged.employment = mergeObj(merged.employment, pending.employment);
    if (pending.compensation) {
        merged.compensation = mergeObj(merged.compensation, pending.compensation);
        if (pending.compensation.bankDetails) {
            merged.compensation.bankDetails = mergeObj(
                merged.compensation.bankDetails,
                pending.compensation.bankDetails
            );
        }
    }
    if (pending.education) merged.education = pending.education;
    if (pending.experience) merged.experience = pending.experience;
    if (pending.skills) merged.skills = pending.skills;

    return merged;
};

const archiveCurrentDocumentVersion = (doc, archiveReason) => {
    if (!doc) return;

    doc.versionHistory = Array.isArray(doc.versionHistory) ? doc.versionHistory : [];
    doc.versionHistory.push({
        versionNumber: doc.versionNumber || 1,
        title: doc.title,
        fileName: doc.fileName,
        url: doc.url,
        uploadDate: doc.uploadDate,
        uploadedBy: doc.uploadedBy,
        verificationStatus: normalizeDocumentWorkflowStatus(doc.verificationStatus),
        verifiedBy: doc.verifiedBy,
        verifiedAt: doc.verifiedAt,
        rejectedBy: doc.rejectedBy,
        rejectedAt: doc.rejectedAt,
        rejectionReason: doc.rejectionReason,
        revokedBy: doc.revokedBy,
        revokedAt: doc.revokedAt,
        revocationReason: doc.revocationReason,
        archivedAt: new Date(),
        archiveReason
    });
};

const reopenDocumentSubmission = (profile) => {
    if (!profile) {
        return;
    }

    profile.documentSubmissionStatus = 'Draft';
};

const normalizeProfileDocumentWorkflow = async (profile) => {
    if (!profile || !Array.isArray(profile.documents)) {
        return profile;
    }

    let changed = false;

    profile.documents.forEach((doc) => {
        const normalizedStatus = normalizeDocumentWorkflowStatus(doc.verificationStatus);
        if (doc.verificationStatus !== normalizedStatus) {
            doc.verificationStatus = normalizedStatus;
            changed = true;
        }

        if (typeof doc.versionNumber !== 'number' || doc.versionNumber < 1) {
            doc.versionNumber = 1;
            changed = true;
        }

        if (typeof doc.isDeleted !== 'boolean') {
            doc.isDeleted = false;
            changed = true;
        }

        if (!Array.isArray(doc.versionHistory)) {
            doc.versionHistory = [];
            changed = true;
        }
    });

    if (changed) {
        syncDocumentSubmissionStatus(profile);
        await profile.save();
    }

    return profile;
};

const buildTransferredOnboardingCustomFiles = async (profile, userId, companyId) => {
    if (!userId || !companyId) {
        return [];
    }

    const onboardingEmployee = await OnboardingEmployee.findOne({
        transferredToUserId: userId,
        companyId
    })
        .select('offerLetterUrl documents offerDate createdAt updatedAt requestedDocuments')
        .lean();

    if (!onboardingEmployee) {
        return [];
    }

    const existingUrls = new Set(
        (Array.isArray(profile?.documents) ? profile.documents : [])
            .map((doc) => normalizeDocumentKey(doc?.url))
            .filter(Boolean)
    );

    const customFiles = [];

    if (onboardingEmployee.offerLetterUrl && !existingUrls.has(normalizeDocumentKey(onboardingEmployee.offerLetterUrl))) {
        customFiles.push({
            _id: `onboarding-offer-letter-${userId}`,
            title: OFFER_LETTER_DOCUMENT_TITLE,
            fileName: 'Offer_Letter.pdf',
            category: 'Custom Files',
            url: onboardingEmployee.offerLetterUrl,
            uploadDate: onboardingEmployee.offerDate || onboardingEmployee.updatedAt || onboardingEmployee.createdAt || new Date(),
            sourceType: 'offer_letter',
            sourceLabel: 'Shared during onboarding',
            isOnboardingShared: true
        });
    }

    (onboardingEmployee.documents || [])
        .filter((doc) => doc?.type === 'custom_file' && doc?.url)
        .forEach((doc) => {
            const normalizedUrl = normalizeDocumentKey(doc.url);
            if (!normalizedUrl || existingUrls.has(normalizedUrl)) {
                return;
            }

            customFiles.push({
                _id: `onboarding-custom-file-${doc._id}`,
                title: doc.label || 'Custom File',
                fileName: doc.label || 'Custom File',
                category: 'Custom Files',
                url: doc.url,
                uploadDate: doc.emailSentAt || doc.uploadedAt || onboardingEmployee.updatedAt || onboardingEmployee.createdAt || new Date(),
                sourceType: 'custom_file',
                sourceLabel: 'Sent during onboarding',
                isOnboardingShared: true
            });
        });

    const requestedDocumentLabels = new Set(
        (onboardingEmployee.requestedDocuments || [])
            .map((item) => normalizeDocumentKey(item?.label || item))
            .filter(Boolean)
    );

    if (requestedDocumentLabels.size > 0) {
        const company = await Company.findById(companyId).select('settings.onboarding.policies').lean();
        const policies = company?.settings?.onboarding?.policies || [];
        const customFileUrls = new Set(customFiles.map((file) => normalizeDocumentKey(file.url)).filter(Boolean));

        policies.forEach((policy) => {
            const policyNameKey = normalizeDocumentKey(policy?.name);
            const policyUrlKey = normalizeDocumentKey(policy?.url);

            if (!policyNameKey || !policyUrlKey) {
                return;
            }

            if (!requestedDocumentLabels.has(policyNameKey)) {
                return;
            }

            if (existingUrls.has(policyUrlKey) || customFileUrls.has(policyUrlKey)) {
                return;
            }

            customFiles.push({
                _id: `onboarding-policy-${policy._id}`,
                title: policy.name,
                fileName: policy.name,
                category: 'Custom Files',
                url: policy.url,
                uploadDate: onboardingEmployee.updatedAt || onboardingEmployee.createdAt || new Date(),
                sourceType: 'policy',
                sourceLabel: POLICY_SOURCE_LABEL,
                isOnboardingShared: true
            });

            customFileUrls.add(policyUrlKey);
        });
    }

    return customFiles;
};

const normalizeTransferredIdentityDocuments = async (profile) => {
    if (!profile || !Array.isArray(profile.documents) || profile.documents.length === 0) {
        return profile;
    }

    let changed = false;

    profile.documents.forEach((doc) => {
        const title = String(doc?.title || '').trim();
        const normalizedTitle = title.toLowerCase();

        if (normalizedTitle === LEGACY_PASSPORT_DOCUMENT_TITLE.toLowerCase()) {
            doc.title = PASSPORT_DOCUMENT_TITLE;
            if (doc.category !== 'ID Proof') {
                doc.category = 'ID Proof';
            }
            changed = true;
            return;
        }

        if (normalizedTitle === LEGACY_EXPERIENCE_CERTIFICATE_DOCUMENT_TITLE.toLowerCase()) {
            doc.title = EXPERIENCE_CERTIFICATE_DOCUMENT_TITLE;
            if (doc.category !== 'Employment') {
                doc.category = 'Employment';
            }
            changed = true;
            return;
        }

        if (
            normalizedTitle === PASSPORT_DOCUMENT_TITLE.toLowerCase()
            || normalizedTitle === PASSPORT_PHOTO_DOCUMENT_TITLE.toLowerCase()
        ) {
            if (doc.category !== 'ID Proof') {
                doc.category = 'ID Proof';
                changed = true;
            }
        }
    });

    if (changed) {
        await profile.save();
    }

    return profile;
};

const ensureTransferredBankDocument = async (profile, userId, companyId) => {
    if (!profile || !userId || !companyId) return profile;

    const hasBankDocument = Array.isArray(profile.documents)
        && profile.documents.some((doc) => (
            doc?.category === 'Bank'
            || String(doc?.title || '').trim().toLowerCase() === BANK_DOCUMENT_TITLE.toLowerCase()
        ));

    if (hasBankDocument) {
        return profile;
    }

    const onboardingEmployee = await OnboardingEmployee.findOne({
        transferredToUserId: userId,
        companyId
    })
        .select('bankDetails submittedAt updatedAt')
        .lean();

    const cancelledChequeUrl = onboardingEmployee?.bankDetails?.cancelledChequeUrl;
    if (!cancelledChequeUrl) {
        return profile;
    }

    profile.documents = Array.isArray(profile.documents) ? profile.documents : [];
    profile.documents.push({
        category: 'Bank',
        title: BANK_DOCUMENT_TITLE,
        fileName: 'Cancelled_Cheque_Passbook_Front_Page.pdf',
        url: cancelledChequeUrl,
        uploadDate: onboardingEmployee.submittedAt || onboardingEmployee.updatedAt || new Date(),
        verificationStatus: DOCUMENT_PENDING_REVIEW_STATUS
    });

    await profile.save();
    return profile;
};

// Helper to check permissions using the same role-based lookup as hasPermission()
const filterProfileFields = (profile, viewer, isSelf) => {
    let profileObj = profile.toObject();
    const roles = (viewer && Array.isArray(viewer.roles)) ? viewer.roles : [];
    const isAdmin = roles.some(r => r && (r.name === 'Admin' || r.name === 'Super Admin'));

    const viewerHasPermission = (key) => {
        if (isAdmin) return true;
        if (viewer && Array.isArray(viewer.permissions) && viewer.permissions.includes(key)) return true;
        return roles.some(role =>
            role.permissions && role.permissions.some(p => p.key === key)
        );
    };

    const canViewDossier = isAdmin || viewerHasPermission('dossier.view') || viewerHasPermission('dossier.view.sensitive') || viewerHasPermission('payroll.salary.view') || viewerHasPermission('payroll.salary.manage');

    if (!canViewDossier && !isSelf) {
        // Redact sensitive info for users without explicit dossier view permission
        delete profileObj.compensation;
        delete profileObj.identity;
        delete profileObj.family; delete profileObj.contact; delete profileObj.documents; delete profileObj.hris; delete profileObj.skills;
        delete profileObj.pendingUpdates;
    } else {
        // Even if authorized to view dossier (or self), protect the compensation details specifically
        if (isSelf) {
            const canViewSelfSalary = isAdmin || viewerHasPermission('payroll.salary.view.self') || viewerHasPermission('payroll.salary.view') || viewerHasPermission('payroll.salary.manage');
            if (!canViewSelfSalary) {
                delete profileObj.compensation;
            }
        } else {
            const canViewOtherSalary = isAdmin || viewerHasPermission('payroll.salary.view') || viewerHasPermission('payroll.salary.manage');
            if (!canViewOtherSalary) {
                delete profileObj.compensation;
            }
        }
    }

    return profileObj;
};

const checkIsAdmin = (user) => {
    if (!user || !user.roles) return false;
    return user.roles.some((role) => {
        const roleName = typeof role === 'string' ? role : role?.name;
        return ['Admin', 'Super Admin', 'System Admin'].includes(roleName);
    });
};

const hasPermission = (user, permissionKey) => {
    if (checkIsAdmin(user)) return true;
    if (user && Array.isArray(user.permissions) && user.permissions.includes(permissionKey)) return true;
    if (!user || !user.roles) return false;
    return user.roles.some(role =>
        role.permissions && role.permissions.some(p => p.key === permissionKey)
    );
};

const getHRISApprovers = async (companyId, excludeUserId) => {
    try {
        const Role = mongoose.model('Role');
        const Permission = mongoose.model('Permission');
        const User = mongoose.model('User');

        const permission = await Permission.findOne({ key: 'dossier.approve' }).lean();
        const permissionIdStr = permission ? permission._id.toString() : null;

        const roles = await Role.find({
            $or: [
                { companyId },
                { companyId: null }
            ],
            isActive: true
        }).populate('permissions').lean();

        const authorizedRoleIds = new Set();
        const adminRoleNames = ['Admin', 'Super Admin', 'System Admin'];
        const roleMap = new Map(roles.map(r => [r._id.toString(), r]));

        const checkRoleAuthorized = (role, visited = new Set()) => {
            const roleIdStr = role._id.toString();
            if (visited.has(roleIdStr)) return false;
            visited.add(roleIdStr);

            if (adminRoleNames.includes(role.name)) {
                return true;
            }

            if (permissionIdStr && role.permissions && role.permissions.some(p => p._id.toString() === permissionIdStr || p.key === 'dossier.approve')) {
                return true;
            }

            if (role.inheritsFrom && role.inheritsFrom.length > 0) {
                for (const parentId of role.inheritsFrom) {
                    const parentRole = roleMap.get(parentId.toString());
                    if (parentRole && checkRoleAuthorized(parentRole, visited)) {
                        return true;
                    }
                }
            }

            return false;
        };

        for (const role of roles) {
            if (checkRoleAuthorized(role)) {
                authorizedRoleIds.add(role._id.toString());
            }
        }

        const query = {
            companyId,
            isActive: true,
            roles: { $in: Array.from(authorizedRoleIds) }
        };
        if (excludeUserId) {
            query._id = { $ne: excludeUserId };
        }

        return await User.find(query).select('_id email firstName lastName').lean();
    } catch (err) {
        console.error('[dossierController] getHRISApprovers error:', err);
        return [];
    }
};

exports.getDossier = async (req, res) => {
    try {
        const { userId } = req.params;
        const viewerId = req.user._id.toString();
        const isSelf = userId === viewerId;

        // Verify existence
        const targetUser = await User.findById(userId);
        if (!targetUser) return res.status(404).json({ message: 'User not found' });

        // Permission Check: View Dossier
        // Users can always view their own. To view others, need 'dossier.view' or Admin.
        if (!isSelf) {
            const canView = checkIsAdmin(req.user)
                || hasPermission(req.user, "dossier.view")
                || hasPermission(req.user, "dossier.view.sensitive")
                || hasPermission(req.user, "payroll.salary.view")
                || hasPermission(req.user, "payroll.salary.manage")
                || hasPermission(req.user, "dossier.export");
            if (!canView) {
                return res.status(403).json({ message: 'Not authorized to view this dossier' });
            }
        }

        let profile = await EmployeeProfile.findOne({
            user: userId,
            companyId: req.companyId
        })
            .select('+identity.aadhaarNumber +identity.panNumber +identity.passportNumber +compensation.ctc +compensation.bankDetails.accountNumber')
            .populate({
                path: 'user',
                select: 'firstName lastName email employeeCode roles department joiningDate employmentType workLocation',
                populate: { path: 'roles', select: 'name' }
            })
            .populate('employment.businessUnit', 'name')
            .populate('employment.reportingManager', 'firstName lastName')
            .populate('documents.uploadedBy', 'firstName lastName email')
            .populate('documents.verifiedBy', 'firstName lastName email')
            .populate('documents.rejectedBy', 'firstName lastName email')
            .populate('documents.revokedBy', 'firstName lastName email')
            .populate('documents.deletedBy', 'firstName lastName email')
            .populate('documents.versionHistory.uploadedBy', 'firstName lastName email')
            .populate('documents.versionHistory.verifiedBy', 'firstName lastName email')
            .populate('documents.versionHistory.rejectedBy', 'firstName lastName email')
            .populate('documents.versionHistory.revokedBy', 'firstName lastName email');

        if (!profile) {
            // Create a skeleton profile if it doesn't exist (Lazy Initialization)
            profile = new EmployeeProfile({
                user: userId,
                companyId: req.companyId,
                personal: {
                    firstName: targetUser.firstName,
                    lastName: targetUser.lastName,
                    joiningDate: targetUser.joiningDate
                },
                contact: {
                    personalEmail: '',
                    workEmail: targetUser.email
                },
                employment: {
                    department: targetUser.department,
                    reportingManager: targetUser.reportingManagers?.[0],
                    joiningDate: targetUser.joiningDate
                },
                compensation: {},
                documents: [],
                skills: { technical: [], behavioral: [], learningInterests: [] }
            });
            await profile.save();
            await User.findByIdAndUpdate(userId, { employeeProfile: profile._id });

            // Re-fetch to get populated fields
            profile = await EmployeeProfile.findById(profile._id)
                .populate({
                    path: 'user',
                    select: 'firstName lastName email employeeCode roles department joiningDate employmentType workLocation',
                    populate: { path: 'roles', select: 'name' }
                })
                .populate('employment.businessUnit', 'name')
                .populate('employment.reportingManager', 'firstName lastName')
                .populate('documents.uploadedBy', 'firstName lastName email')
                .populate('documents.verifiedBy', 'firstName lastName email')
                .populate('documents.rejectedBy', 'firstName lastName email')
                .populate('documents.revokedBy', 'firstName lastName email')
                .populate('documents.deletedBy', 'firstName lastName email')
                .populate('documents.versionHistory.uploadedBy', 'firstName lastName email')
                .populate('documents.versionHistory.verifiedBy', 'firstName lastName email')
                .populate('documents.versionHistory.rejectedBy', 'firstName lastName email')
                .populate('documents.versionHistory.revokedBy', 'firstName lastName email');
        } else {

            // --- Critical Fix for Production (Moved to Top) ---
            try {
                if (profile.skills && Array.isArray(profile.skills)) {
                    console.warn(`[FIX] Converting skills array to object for user ${userId}`);
                    // Force reset to correct structure in DB directly
                    const newSkills = {
                        technical: [],
                        behavioral: [],
                        learningInterests: []
                    };

                    await EmployeeProfile.updateOne(
                        { _id: profile._id },
                        { $set: { skills: newSkills } }
                    );

                    // Update local object and mark as modified to prevent current instance from trying to save the old array
                    profile.skills = newSkills;
                }
            } catch (skillError) {
                console.error('[WARNING] Failed to migrate skills array:', skillError.message);
            }
            // -----------------------------------

            // Sync missing data for existing profiles
            let changed = false;
            if (!profile.employment?.department && targetUser.department) {
                if (!profile.employment) profile.employment = {};
                profile.employment.department = targetUser.department;
                changed = true;
            }
            if (!profile.employment?.reportingManager && targetUser.reportingManagers?.length > 0) {
                if (!profile.employment) profile.employment = {};
                profile.employment.reportingManager = targetUser.reportingManagers[0];
                changed = true;
            }
            if (!profile.employment?.joiningDate && targetUser.joiningDate) {
                if (!profile.employment) profile.employment = {};
                profile.employment.joiningDate = targetUser.joiningDate;
                changed = true;
            }
            if (!profile.personal?.joiningDate && targetUser.joiningDate) {
                if (!profile.personal) profile.personal = {};
                profile.personal.joiningDate = targetUser.joiningDate;
                changed = true;
            }
            if (!profile.contact?.workEmail && targetUser.email) {
                if (!profile.contact) profile.contact = {};
                profile.contact.workEmail = targetUser.email;
                changed = true;
            }
            if (changed) {
                await profile.save();
                await profile.populate('employment.reportingManager', 'firstName lastName');
            }
        }

        profile = await normalizeTransferredIdentityDocuments(profile);
        profile = await ensureTransferredBankDocument(profile, userId, req.companyId);
        profile = await normalizeProfileDocumentWorkflow(profile);

        // (Removed duplicate skills fix)

        let filteredProfile = filterProfileFields(profile, req.user, isSelf);

        // Pass pendingUpdates as a separate, untouched key for Self/Admin/Approvers so
        // the frontend can build an old-vs-new diff without merging into the live view.
        // Live profile fields are NEVER modified here — they only change on approveHRIS.
        if (isSelf || checkIsAdmin(req.user) || hasPermission(req.user, 'dossier.approve')) {
            filteredProfile.pendingUpdates = profile.pendingUpdates || null;
        } else {
            delete filteredProfile.pendingUpdates;
        }

        if (filteredProfile.documents !== undefined) {
            filteredProfile.documents = filteredProfile.documents.filter(isActiveDocument);
            filteredProfile.onboardingCustomFiles = await buildTransferredOnboardingCustomFiles(profile, userId, req.companyId);
        }
        res.status(200).json(filteredProfile);

    } catch (error) {
        console.error('Get Dossier Error:', error);
        console.error('Req User:', JSON.stringify(req.user, null, 2));
        console.error('Params:', req.params);
        res.status(500).json({
            message: 'Server Error',
            error: error.message,
            // stack: process.env.NODE_ENV === 'production' ? '🥞' : error.stack
        });
    }
};

exports.submitHRIS = async (req, res) => {
    try {
        const { userId } = req.params;
        const updates = req.body; // Expecting complex object
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

        // Validate spouse name if marital status is Married
        const currentMaritalStatus = updates.personal?.maritalStatus || profile.personal?.maritalStatus;
        const spouseName = updates.family?.spouseName || profile.family?.spouseName;
        if (currentMaritalStatus === 'Married' && (!spouseName || !spouseName.trim())) {
            return res.status(400).json({ message: 'Spouse Name is required when marital status is Married' });
        }

        // Validate new fields if provided
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

        // Validate contact details if provided
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

        // Validate identity details if provided
        if (updates.identity) {
            if (updates.identity.aadhaarNumber && !isValidAadhaar(updates.identity.aadhaarNumber)) {
                return res.status(400).json({ message: 'Aadhaar number must be a 12-digit number' });
            }
            if (updates.identity.panNumber && !isValidPAN(updates.identity.panNumber)) {
                return res.status(400).json({ message: 'PAN number must be a valid 10-character alphanumeric code' });
            }
        }

        // Sensitive sections modifications check
        const canEditSensitive = isAdmin || hasPermission(req.user, 'dossier.edit.sensitive') || hasPermission(req.user, 'payroll.salary.manage');
        if (!canEditSensitive) {
            const profileObj = profile.toObject();

            const employmentKeys = ['designation', 'department', 'businessUnit', 'reportingManager', 'joiningDate', 'confirmationDate', 'status', 'workLocation', 'branch', 'employmentType'];
            if (updates.employment && hasModifiedSensitiveField(profileObj.employment || {}, updates.employment, employmentKeys)) {
                return res.status(403).json({ message: 'You are not authorized to modify sensitive employment details. Contact HR.' });
            }

            // Identity changes are allowed for staging via HRIS submission.

            // Only block compensation updates if truly sensitive fields (ctc, salaryBreakup) are modified.
            const sensitiveCompKeys = ['ctc', 'salaryBreakup'];
            if (updates.compensation && hasModifiedSensitiveField(profileObj.compensation || {}, updates.compensation, sensitiveCompKeys)) {
                return res.status(403).json({ message: 'You are not authorized to modify sensitive compensation details. Contact HR.' });
            }
        }

        const shouldDirectWrite = isAdmin && !isSelf;

        if (shouldDirectWrite) {
            // Apply directly to active profile fields for Admins (when editing someone else)
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

            profile.pendingUpdates = null; // Clear staging area for Admins

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
            // Stage updates in pendingUpdates for employees
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

            // Set HRIS submission status
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

        // Send notification to authorized users who can approve HRIS
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
                        link: `/dossier/${userId}?tab=hris`
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
        const updates = req.body; // Expecting object matching the section structure
        const viewerId = req.user._id.toString();
        const isSelf = userId === viewerId;
        const isAdmin = checkIsAdmin(req.user);
        let canEdit = isSelf || isAdmin || hasPermission(req.user, 'dossier.edit');
        if (section === 'compensation' && hasPermission(req.user, 'payroll.salary.manage')) {
            canEdit = true;
        }

        // Permission Check
        if (!canEdit) {
            return res.status(403).json({ message: 'Not authorized to edit this profile' });
        }

        // Check for specific permission to edit sensitive sections
        const canEditSensitive = isAdmin || hasPermission(req.user, 'dossier.edit.sensitive') || hasPermission(req.user, 'payroll.salary.manage');

        if (!isAdmin && !canEditSensitive) {
            if (section === 'employment') {
                return res.status(403).json({ message: 'You cannot edit this section. Contact HR.' });
            }
            if (section === 'compensation') {
                // Employees/managers are only allowed to modify bankDetails and uanNumber!
                if (updates && typeof updates === 'object') {
                    const compKeys = Object.keys(updates);
                    const allowedKeys = ['bankDetails', 'uanNumber'];
                    const hasDisallowed = compKeys.some(k => !allowedKeys.includes(k));
                    if (hasDisallowed) {
                        return res.status(403).json({ message: 'You are not authorized to modify sensitive salary/compensation details. Contact HR.' });
                    }
                }
            }
            // 'identity' section is fully allowed to be updated/staged since it requires approval
        }

        const profile = await EmployeeProfile.findOne({
            user: userId,
            companyId: req.companyId
        })
            .select('+identity.aadhaarNumber +identity.panNumber +identity.passportNumber +compensation.ctc +compensation.bankDetails.accountNumber +compensation.uanNumber');
        if (!profile) return res.status(404).json({ message: 'Profile not found' });

        const originalProfile = profile.toObject();

        // Validation Logic
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
                // These are arrays, replace entirely
                profile[section] = Array.isArray(updates) ? updates : [];
            } else {
                if (!profile[section]) {
                    profile[section] = {};
                }

                // Apply updates intelligently for object-based sections
                Object.keys(updates).forEach(key => {
                    let value = updates[key];
                    // Handle empty strings for dates/numbers to avoid CastError
                    if (value === "") {
                        value = null;
                    }

                    // Nested object handling
                    if (profile[section] && typeof profile[section] === 'object') {
                        profile[section][key] = value;
                    }
                });
                profile.markModified(section);
            }
        } else {
            // Stage updates in pendingUpdates for employees (or self-updates by Admins)
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

        // Reset HRIS declaration if user is not doing direct live writes (i.e. self-updates)
        if (!shouldDirectWrite && profile.hris && (profile.hris.isDeclared || profile.hris.status !== 'Draft')) {
            profile.hris.isDeclared = false;
            profile.hris.status = 'Draft';
        }

        const diff = getDossierDiff(originalProfile[section], updates, section);
        const originModule = req.body.originModule || req.headers['x-origin-module'] || (section === 'experience' ? 'Employment History' : 'Personal Information');

        await profile.save();

        // Audit Log
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

exports.addDocument = async (req, res) => {
    try {
        const { userId } = req.params;
        const { category, title, expiryDate, replaceDocId } = req.body;



        const fileUrl = req.file ? req.file.path : req.body.url;

        if (!fileUrl) {
            console.error('No file URL found');
            return res.status(400).json({ message: 'No file uploaded or URL provided' });
        }

        const isSelf = req.user._id.toString() === userId;
        const isAdmin = checkIsAdmin(req.user);
        const canEdit = isSelf || isAdmin || hasPermission(req.user, 'dossier.edit');

        if (!canEdit) {
            return res.status(403).json({ message: 'Not authorized to upload documents for this user' });
        }

        const profile = await EmployeeProfile.findOne({
            user: userId,
            companyId: req.companyId
        });
        if (!profile) {
            console.error('Profile not found for user:', userId);
            return res.status(404).json({ message: 'Profile not found' });
        }

        const uploadedAt = new Date();
        const nextFileName = req.file ? req.file.originalname : (fileUrl.split('/').pop() || 'document');
        let auditAction = 'UPLOAD_DOCUMENT';
        let auditDetails = {
            targetUser: userId,
            targetuser: userId,
            companyId: req.companyId,
            docTitle: title
        };

        if (replaceDocId) {
            const existingDoc = profile.documents.id(replaceDocId);
            if (!existingDoc || existingDoc.isDeleted) {
                return res.status(404).json({ message: 'Document not found for re-upload' });
            }

            if (normalizeDocumentWorkflowStatus(existingDoc.verificationStatus) !== 'Rejected') {
                return res.status(400).json({ message: 'Only rejected documents can be corrected with a new version' });
            }

            archiveCurrentDocumentVersion(existingDoc, 'Employee re-uploaded a corrected version');

            existingDoc.category = category || existingDoc.category;
            existingDoc.title = title || existingDoc.title;
            existingDoc.fileName = nextFileName;
            existingDoc.url = fileUrl;
            existingDoc.expiryDate = expiryDate || existingDoc.expiryDate;
            existingDoc.uploadDate = uploadedAt;
            existingDoc.uploadedBy = req.user._id;
            existingDoc.verificationStatus = DOCUMENT_PENDING_REVIEW_STATUS;
            existingDoc.versionNumber = (existingDoc.versionNumber || 1) + 1;
            existingDoc.verifiedBy = undefined;
            existingDoc.verifiedAt = undefined;
            existingDoc.rejectedBy = undefined;
            existingDoc.rejectedAt = undefined;
            existingDoc.rejectionReason = undefined;
            existingDoc.revokedBy = undefined;
            existingDoc.revokedAt = undefined;
            existingDoc.revocationReason = undefined;
            existingDoc.deletedBy = undefined;
            existingDoc.deletedAt = undefined;
            existingDoc.isDeleted = false;

            auditAction = 'UPLOAD_DOCUMENT_VERSION';
            auditDetails = {
                ...auditDetails,
                docId: existingDoc._id,
                versionNumber: existingDoc.versionNumber
            };
        } else {
            profile.documents.push({
                category,
                title,
                fileName: nextFileName,
                url: fileUrl,
                expiryDate,
                uploadDate: uploadedAt,
                uploadedBy: req.user._id,
                verificationStatus: DOCUMENT_PENDING_REVIEW_STATUS,
                versionNumber: 1,
                versionHistory: []
            });
        }

        syncDocumentSubmissionStatus(profile);
        reopenDocumentSubmission(profile);

        // Reset HRIS declaration if user is not Admin
        if (!isAdmin && profile.hris && (profile.hris.isDeclared || profile.hris.status !== 'Draft')) {
            profile.hris.isDeclared = false;
            profile.hris.status = 'Draft';
        }

        await profile.save();
        await logDossierActivity({
            action: auditAction,
            performedBy: req.user._id,
            companyId: req.companyId,
            details: auditDetails,
            ipAddress: req.ip
        });

        res.status(201).json({
            documents: getActiveDocuments(profile),
            submissionStatus: profile.documentSubmissionStatus
        });

    } catch (error) {
        console.error('Upload Document Error:', error);
        res.status(500).json({ message: 'Server Error', error: error.message });
    }
};

exports.deleteDocument = async (req, res) => {
    try {
        const { userId, docId } = req.params;

        const isSelf = req.user._id.toString() === userId;
        const isAdmin = checkIsAdmin(req.user);
        const canEdit = isSelf || isAdmin || hasPermission(req.user, 'dossier.edit');

        if (!canEdit) {
            return res.status(403).json({ message: 'Not authorized to delete documents for this user' });
        }

        const profile = await EmployeeProfile.findOne({
            user: userId,
            companyId: req.companyId
        });

        if (!profile) return res.status(404).json({ message: 'Profile not found' });

        // Find document to get title for audit log
        const doc = profile.documents.id(docId);
        if (!doc) return res.status(404).json({ message: 'Document not found' });

        if (doc.isDeleted) {
            return res.status(400).json({ message: 'Document is already deleted' });
        }

        const currentStatus = normalizeDocumentWorkflowStatus(doc.verificationStatus);
        if (!['Rejected', DOCUMENT_PENDING_REVIEW_STATUS].includes(currentStatus)) {
            return res.status(403).json({ message: 'Delete is only allowed for pending review or rejected documents' });
        }

        const docTitle = doc.title;
        doc.isDeleted = true;
        doc.deletedBy = req.user._id;
        doc.deletedAt = new Date();

        syncDocumentSubmissionStatus(profile);
        reopenDocumentSubmission(profile);

        // Reset HRIS declaration if user is not Admin
        if (!isAdmin && profile.hris && (profile.hris.isDeclared || profile.hris.status !== 'Draft')) {
            profile.hris.isDeclared = false;
            profile.hris.status = 'Draft';
        }
        await profile.save();

        await logDossierActivity({
            action: 'DELETE_DOCUMENT',
            performedBy: req.user._id,
            companyId: req.companyId,
            details: {
                targetUser: userId,
                targetuser: userId,
                companyId: req.companyId,
                docTitle: docTitle,
                versionNumber: doc.versionNumber
            },
            ipAddress: req.ip
        });

        res.status(200).json({
            documents: getActiveDocuments(profile),
            submissionStatus: profile.documentSubmissionStatus
        });

    } catch (error) {
        console.error('Delete Document Error:', error);
        res.status(500).json({ message: 'Server Error' });
    }
};

exports.verifyDocument = async (req, res) => {
    try {
        const { userId, docId } = req.params;
        const { status, reason } = req.body; // 'Verified' or 'Rejected'

        if (!['Verified', 'Rejected'].includes(status)) {
            return res.status(400).json({ message: 'Invalid status. Must be Verified or Rejected.' });
        }

        const isAdmin = checkIsAdmin(req.user);
        const canApprove = isAdmin || hasPermission(req.user, 'dossier.verify_documents') || hasPermission(req.user, 'dossier.approve');

        if (!canApprove) {
            return res.status(403).json({ message: 'Not authorized to verify documents' });
        }

        const profile = await EmployeeProfile.findOne({
            user: userId,
            companyId: req.companyId
        });
        if (!profile) return res.status(404).json({ message: 'Profile not found' });

        const doc = profile.documents.id(docId);
        if (!doc) return res.status(404).json({ message: 'Document not found' });
        if (doc.isDeleted) return res.status(400).json({ message: 'Deleted documents cannot be reviewed' });

        const currentStatus = normalizeDocumentWorkflowStatus(doc.verificationStatus);
        if (currentStatus !== DOCUMENT_PENDING_REVIEW_STATUS) {
            return res.status(400).json({ message: 'Only documents in pending review can be approved or rejected' });
        }

        if (status === 'Rejected' && !String(reason || '').trim()) {
            return res.status(400).json({ message: 'Rejection reason is required' });
        }

        doc.verificationStatus = status;
        if (status === 'Verified') {
            doc.verifiedBy = req.user._id;
            doc.verifiedAt = new Date();
            doc.rejectedBy = undefined;
            doc.rejectedAt = undefined;
            doc.rejectionReason = undefined;
        } else {
            doc.rejectedBy = req.user._id;
            doc.rejectedAt = new Date();
            doc.rejectionReason = String(reason || '').trim();
        }

        syncDocumentSubmissionStatus(profile);

        await profile.save();

        await logDossierActivity({
            action: status === 'Verified' ? 'VERIFY_DOCUMENT' : 'REJECT_DOCUMENT',
            performedBy: req.user._id,
            companyId: req.companyId,
            details: {
                targetUser: userId,
                targetuser: userId,
                companyId: req.companyId,
                docTitle: doc.title,
                status,
                reason: status === 'Rejected' ? String(reason || '').trim() : undefined,
                versionNumber: doc.versionNumber,
                newSubmissionStatus: profile.documentSubmissionStatus
            },
            ipAddress: req.ip
        });

        res.status(200).json({
            documents: getActiveDocuments(profile),
            submissionStatus: profile.documentSubmissionStatus
        });

    } catch (error) {
        console.error('Verify Document Error:', error);
        res.status(500).json({ message: 'Server Error' });
    }
};

exports.revokeDocumentVerification = async (req, res) => {
    try {
        const { userId, docId } = req.params;
        const { reason } = req.body;

        if (!String(reason || '').trim()) {
            return res.status(400).json({ message: 'Revocation reason is required' });
        }

        const isAdmin = checkIsAdmin(req.user);
        const canApprove = isAdmin || hasPermission(req.user, 'dossier.verify_documents') || hasPermission(req.user, 'dossier.approve');

        if (!canApprove) {
            return res.status(403).json({ message: 'Not authorized to revoke document verification' });
        }

        const profile = await EmployeeProfile.findOne({ user: userId, companyId: req.companyId });
        if (!profile) return res.status(404).json({ message: 'Profile not found' });

        const doc = profile.documents.id(docId);
        if (!doc) return res.status(404).json({ message: 'Document not found' });
        if (doc.isDeleted) return res.status(400).json({ message: 'Deleted documents cannot be revoked' });

        if (normalizeDocumentWorkflowStatus(doc.verificationStatus) !== 'Verified') {
            return res.status(400).json({ message: 'Only verified documents can be revoked' });
        }

        doc.verificationStatus = DOCUMENT_PENDING_REVIEW_STATUS;
        doc.revokedBy = req.user._id;
        doc.revokedAt = new Date();
        doc.revocationReason = String(reason || '').trim();

        syncDocumentSubmissionStatus(profile);

        await profile.save();

        await logDossierActivity({
            action: 'REVOKE_DOCUMENT_VERIFICATION',
            performedBy: req.user._id,
            companyId: req.companyId,
            details: {
                targetUser: userId,
                targetuser: userId,
                companyId: req.companyId,
                docTitle: doc.title,
                reason: doc.revocationReason,
                versionNumber: doc.versionNumber,
                newSubmissionStatus: profile.documentSubmissionStatus
            },
            ipAddress: req.ip
        });

        res.status(200).json({
            documents: getActiveDocuments(profile),
            submissionStatus: profile.documentSubmissionStatus
        });
    } catch (error) {
        console.error('Revoke Document Verification Error:', error);
        res.status(500).json({ message: 'Server Error' });
    }
};

exports.verifyAllDocuments = async (req, res) => {
    try {
        const { userId } = req.params;
        const { status } = req.body; // 'Verified'

        if (status !== 'Verified') {
            return res.status(400).json({ message: 'Bulk review only supports verification.' });
        }

        const isAdmin = checkIsAdmin(req.user);
        const canApprove = isAdmin || hasPermission(req.user, 'dossier.verify_documents') || hasPermission(req.user, 'dossier.approve');

        if (!canApprove) {
            return res.status(403).json({ message: 'Not authorized to verify documents' });
        }

        const profile = await EmployeeProfile.findOne({
            user: userId,
            companyId: req.companyId
        });
        if (!profile) return res.status(404).json({ message: 'Profile not found' });

        let updatedCount = 0;
        profile.documents.forEach(doc => {
            if (!isActiveDocument(doc)) return;
            if (normalizeDocumentWorkflowStatus(doc.verificationStatus) === DOCUMENT_PENDING_REVIEW_STATUS) {
                doc.verificationStatus = status;
                doc.verifiedBy = req.user._id;
                doc.verifiedAt = new Date();
                doc.rejectedBy = undefined;
                doc.rejectedAt = undefined;
                doc.rejectionReason = undefined;
                updatedCount++;
            }
        });

        if (updatedCount > 0) {
            syncDocumentSubmissionStatus(profile);

            await profile.save();

            await logDossierActivity({
                action: 'VERIFY_ALL_DOCUMENTS',
                performedBy: req.user._id,
                companyId: req.companyId,
                details: {
                    targetUser: userId,
                    targetuser: userId,
                    companyId: req.companyId,
                    status,
                    count: updatedCount,
                    newSubmissionStatus: profile.documentSubmissionStatus
                },
                ipAddress: req.ip
            });
        }

        res.status(200).json({
            message: `Updated ${updatedCount} documents`,
            documents: getActiveDocuments(profile),
            submissionStatus: profile.documentSubmissionStatus
        });

    } catch (error) {
        console.error('Verify All Documents Error:', error);
        res.status(500).json({ message: 'Server Error' });
    }
};

exports.submitDocuments = async (req, res) => {
    try {
        const { userId } = req.params;
        const viewerId = req.user._id.toString();
        const isSelf = userId === viewerId; // Only self (or admin acting as self?) usually self.

        if (!isSelf) {
            return res.status(403).json({ message: 'Can only submit your own documents.' });
        }

        const profile = await EmployeeProfile.findOne({
            user: userId,
            companyId: req.companyId
        });
        if (!profile) return res.status(404).json({ message: 'Profile not found' });

        const activeDocuments = getActiveDocuments(profile);
        if (!activeDocuments.length) {
            return res.status(400).json({ message: 'No documents to submit.' });
        }

        profile.documentSubmissionStatus = 'Submitted';
        activeDocuments.forEach((doc) => {
            doc.verificationStatus = normalizeDocumentWorkflowStatus(doc.verificationStatus);
        });

        await profile.save();

        await logDossierActivity({
            action: 'SUBMIT_DOCUMENTS',
            performedBy: req.user._id,
            companyId: req.companyId,
            details: {
                targetUser: userId,
                targetuser: userId,
                companyId: req.companyId
            },
            ipAddress: req.ip
        });

        res.status(200).json({
            message: 'Documents submitted successfully',
            submissionStatus: profile.documentSubmissionStatus
        });

    } catch (error) {
        console.error('Submit Documents Error:', error);
        res.status(500).json({ message: 'Server Error' });
    }
};

exports.proxyPdf = async (req, res) => {
    try {
        const { url, download } = req.query;
        console.log('Proxying URL:', url, 'Download:', download);

        if (!url || !url.includes('cloudinary')) {
            return res.status(400).json({ message: 'Invalid or missing Cloudinary URL' });
        }

        // Helper to attempt a fetch
        const attemptFetch = async (targetUrl) => {
            console.log('Fetching:', targetUrl);
            return axios({
                method: 'GET',
                url: targetUrl,
                responseType: 'stream',
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
                    'Referer': 'https://res.cloudinary.com/'
                },
                validateStatus: (status) => status < 400
            });
        };

        // Extract version
        // Matches /v12345/
        const versionMatch = url.match(/\/upload\/v(\d+)\//);
        const version = versionMatch ? versionMatch[1] : undefined;

        // Helper to generate signed URL
        const getSignedUrl = (targetUrl, type) => {
            const publicId = extractPublicIdFromUrl(targetUrl);
            if (!publicId) return null;

            const resourceType = targetUrl.includes('/video/') ? 'video' : (targetUrl.includes('/raw/') ? 'raw' : 'image');

            return cloudinary.url(publicId, {
                resource_type: resourceType,
                secure: true,
                sign_url: true,
                type: type, // 'authenticated' or 'upload' or 'private'
                version: version, // Crucial for valid signature if versioned
                format: 'pdf' // Validate/Force extension
            });
        };


        // Define fetch candidates
        const candidates = [];

        // 1. Original URL
        candidates.push(url);

        // 2. Alternate Type URL (Swap image <-> raw)
        let alternateUrl = null;
        if (url.includes('/image/upload/')) {
            alternateUrl = url.replace('/image/upload/', '/raw/upload/');
        } else if (url.includes('/raw/upload/')) {
            alternateUrl = url.replace('/raw/upload/', '/image/upload/');
        }
        if (alternateUrl) candidates.push(alternateUrl);

        // 3. Signed Versions of Original (Authenticated & Upload)
        const signedOriginalAuth = getSignedUrl(url, 'authenticated');
        if (signedOriginalAuth) candidates.push(signedOriginalAuth);

        const signedOriginalUpload = getSignedUrl(url, 'upload');
        if (signedOriginalUpload) candidates.push(signedOriginalUpload);

        // 4. Signed Versions of Alternate
        if (alternateUrl) {
            const signedAlternateAuth = getSignedUrl(alternateUrl, 'authenticated');
            if (signedAlternateAuth) candidates.push(signedAlternateAuth);

            const signedAlternateUpload = getSignedUrl(alternateUrl, 'upload');
            if (signedAlternateUpload) candidates.push(signedAlternateUpload);
        }

        // Execute sequentially until success
        let finalResponse;
        let errors = [];

        for (const candidate of candidates) {
            if (!candidate) continue;
            try {
                const fetchRes = await attemptFetch(candidate);

                // Check if content length is valid (> 0)
                const len = fetchRes.headers['content-length'];
                if (len && parseInt(len) === 0) {
                    throw new Error('Empty response body');
                }


                if (fetchRes.status < 400) {
                    finalResponse = fetchRes;
                    break;
                }
            } catch (err) {
                // If it's a 404/401, axios might not throw if validateStatus is true (but we set it <400 above)
                // If validateStatus fails, it throws.
                console.warn(`Failed candidate ${candidate}: ${err.message}`);
                errors.push(`${candidate}: ${err.message}`);
            }
        }

        if (!finalResponse) {
            console.error('All proxy attempts failed', errors);
            return res.status(502).json({ message: 'Failed to fetch document', details: errors });
        }

        // Forward headers
        const contentType = finalResponse.headers['content-type'];
        const contentLength = finalResponse.headers['content-length'];

        if (contentType) res.setHeader('Content-Type', contentType);
        if (contentLength) res.setHeader('Content-Length', contentLength);

        res.setHeader('Content-Disposition', download === 'true' ? 'attachment' : 'inline');

        finalResponse.data.pipe(res);

    } catch (error) {
        console.error('Proxy Pdf Global Error:', error.message);
        res.status(500).json({ message: 'Proxy Server Error', error: error.message });
    }
};

const trimDossierHistory = async (userId, companyId) => {
    try {
        const userIds = [userId];
        const companyIds = [companyId];
        try {
            userIds.push(new mongoose.Types.ObjectId(userId));
        } catch (e) { }
        try {
            companyIds.push(new mongoose.Types.ObjectId(companyId));
        } catch (e) { }

        const query = {
            module: 'EmployeeDossier',
            $and: [
                {
                    $or: [
                        { companyId: { $in: companyIds } },
                        { company: { $in: companyIds } },
                        { 'details.companyId': { $in: companyIds } },
                        { 'details.company': { $in: companyIds } },
                        {
                            $and: [
                                { companyId: { $exists: false } },
                                { company: { $exists: false } },
                                { 'details.companyId': { $exists: false } },
                                { 'details.company': { $exists: false } }
                            ]
                        }
                    ]
                },
                {
                    $or: [
                        { 'details.targetUser': { $in: userIds } },
                        { 'details.targetuser': { $in: userIds } }
                    ]
                }
            ]
        };

        const logs = await AuditLog.find(query)
            .select('_id')
            .sort({ createdAt: -1 });

        if (logs.length > 30) {
            const idsToDelete = logs.slice(30).map(log => log._id);
            await AuditLog.deleteMany({ _id: { $in: idsToDelete } });
            console.log(`[DossierHistory] Trimmed ${idsToDelete.length} logs for user ${userId}`);
        }
    } catch (err) {
        console.error('[DossierHistory] Trim error:', err);
    }
};

const logDossierActivity = async ({ action, performedBy, companyId, details, ipAddress }) => {
    try {
        const newLog = await AuditLog.create({
            action,
            module: 'EmployeeDossier',
            performedBy,
            companyId,
            details,
            ipAddress
        });

        const targetUserId = details?.targetUser || details?.targetuser;
        if (targetUserId && companyId) {
            trimDossierHistory(targetUserId, companyId).catch(err =>
                console.error('[DossierHistory] Background trim error:', err)
            );
        }
        return newLog;
    } catch (err) {
        console.error('[DossierHistory] Failed to log activity:', err);
    }
};

exports.getDossierHistory = async (req, res) => {
    try {
        const { userId } = req.params;

        const userIds = [userId];
        const companyIds = [req.companyId];
        try {
            userIds.push(new mongoose.Types.ObjectId(userId));
        } catch (e) { }
        try {
            companyIds.push(new mongoose.Types.ObjectId(req.companyId));
        } catch (e) { }

        const logs = await AuditLog.find({
            module: 'EmployeeDossier',
            $and: [
                {
                    $or: [
                        { companyId: { $in: companyIds } },
                        { company: { $in: companyIds } },
                        { 'details.companyId': { $in: companyIds } },
                        { 'details.company': { $in: companyIds } },
                        {
                            $and: [
                                { companyId: { $exists: false } },
                                { company: { $exists: false } },
                                { 'details.companyId': { $exists: false } },
                                { 'details.company': { $exists: false } }
                            ]
                        }
                    ]
                },
                {
                    $or: [
                        { 'details.targetUser': { $in: userIds } },
                        { 'details.targetuser': { $in: userIds } }
                    ]
                }
            ]
        })
            .populate('performedBy', 'firstName lastName')
            .sort({ createdAt: -1 })
            .limit(30);

        res.status(200).json(logs);
    } catch (error) {
        console.error('Fetch History Error:', error);
        res.status(500).json({ message: 'Server Error' });
    }
};

// @desc    Get all pending HRIS requests
// @route   GET /api/dossier/requests
// @access  Private (Admin or Manager with dossier.approve permission)
exports.getHRISRequests = async (req, res) => {
    try {
        const canApprove = hasPermission(req.user, 'dossier.approve');
        const isAdmin = checkIsAdmin(req.user);

        if (!canApprove && !isAdmin) {
            // STRICT: No permission = No access, even for managers.
            return res.status(403).json({ message: 'Access denied. Missing dossier.approve permission.' });
        }

        console.log('[getHRISRequests] User:', req.user?.email, 'companyId:', req.companyId, 'permissions:', req.user?.permissions);
        let query = { 'hris.status': { $in: ['Pending Approval', 'Approved', 'Rejected'] } };

        console.log('[getHRISRequests] Query:', { ...query, companyId: req.companyId });
        const requests = await EmployeeProfile.find({ ...query, companyId: req.companyId })
            .populate('user', 'firstName lastName employeeCode department');

        console.log('[getHRISRequests] Raw profiles found:', requests.length);

        const formattedRequests = requests.map(reqProfile => {
            if (!reqProfile.user) {
                console.log('[getHRISRequests] Profile has no user populated:', reqProfile._id);
                return null;
            }
            return {
                _id: reqProfile.user._id,
                firstName: reqProfile.user.firstName,
                lastName: reqProfile.user.lastName,
                employeeCode: reqProfile.user.employeeCode,
                department: reqProfile.user.department,
                employeeProfile: {
                    hris: {
                        submittedAt: reqProfile.hris?.submittedAt,
                        status: reqProfile.hris?.status
                    }
                }
            };
        }).filter(r => r !== null);

        console.log('[getHRISRequests] Formatted requests returned:', formattedRequests.length);
        res.status(200).json(formattedRequests);
    } catch (error) {
        console.error('Get HRIS Requests Error:', error);
        res.status(500).json({ message: 'Server Error', error: error.message });
    }
};

exports.approveHRIS = async (req, res) => {
    try {
        const { userId } = req.params;

        const canApprove = hasPermission(req.user, 'dossier.approve');
        const isAdmin = checkIsAdmin(req.user);

        if (!isAdmin && !canApprove) {
            return res.status(403).json({ message: 'Not authorized to approve HRIS requests. Missing permission.' });
        }

        // Find profile 
        const profile = await EmployeeProfile.findOne({ user: userId, companyId: req.companyId })
            .select('+identity.aadhaarNumber +identity.panNumber +identity.passportNumber +compensation.ctc +compensation.bankDetails.accountNumber +compensation.uanNumber');

        if (!profile) return res.status(404).json({ message: 'Profile not found' });

        const originalProfile = profile.toObject();
        const diff = { oldValues: {}, newValues: {} };

        if (profile.pendingUpdates) {
            const pending = profile.pendingUpdates;

            ['personal', 'identity', 'contact', 'family', 'employment', 'compensation', 'education', 'experience', 'skills'].forEach(section => {
                if (pending[section]) {
                    const sectionDiff = getDossierDiff(originalProfile[section], pending[section], section);
                    Object.assign(diff.oldValues, sectionDiff.oldValues);
                    Object.assign(diff.newValues, sectionDiff.newValues);
                }
            });

            if (pending.personal) profile.personal = { ...(profile.personal?.toObject?.() || {}), ...pending.personal };
            if (pending.identity) profile.identity = { ...(profile.identity?.toObject?.() || {}), ...pending.identity };
            if (pending.contact) profile.contact = { ...(profile.contact?.toObject?.() || {}), ...pending.contact };
            if (pending.family) profile.family = { ...(profile.family?.toObject?.() || {}), ...pending.family };
            if (pending.employment) profile.employment = { ...(profile.employment?.toObject?.() || {}), ...pending.employment };
            if (pending.compensation) {
                profile.compensation = {
                    ...(profile.compensation?.toObject?.() || {}),
                    ...pending.compensation,
                    bankDetails: { ...(profile.compensation?.bankDetails || {}), ...(pending.compensation?.bankDetails || {}) },
                    salaryBreakup: { ...(profile.compensation?.salaryBreakup || {}), ...(pending.compensation?.salaryBreakup || {}) }
                };
            }
            if (pending.education) profile.education = pending.education;
            if (pending.experience) profile.experience = pending.experience;
            if (pending.skills) profile.skills = pending.skills;

            profile.pendingUpdates = null;
        }

        profile.hris.status = 'Approved';
        profile.hris.approvedBy = req.user._id;
        profile.hris.approvalDate = new Date();
        profile.hris.rejectionReason = null;

        await profile.save();

        await logDossierActivity({
            action: 'APPROVE_HRIS',
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

        res.status(200).json({ message: 'HRIS Approved successfully', hris: profile.hris });
    } catch (error) {
        console.error('Approve HRIS Error:', error);
        res.status(500).json({ message: 'Server Error' });
    }
};

exports.rejectHRIS = async (req, res) => {
    try {
        const { userId } = req.params;
        const { reason } = req.body;

        const canApprove = hasPermission(req.user, 'dossier.approve');
        const isAdmin = checkIsAdmin(req.user);

        if (!isAdmin && !canApprove) {
            return res.status(403).json({ message: 'Not authorized to reject HRIS requests. Missing permission.' });
        }

        const profile = await EmployeeProfile.findOne({ user: userId, companyId: req.companyId });

        if (!profile) return res.status(404).json({ message: 'Profile not found' });

        // Removed isManager check to enforce strict permissions


        profile.hris.status = 'Rejected';
        profile.hris.rejectionReason = reason;
        profile.hris.approvedBy = null;
        profile.hris.approvalDate = null;

        // Clear staging area — live profile fields were never modified so the
        // profile automatically reverts to its last approved state for all viewers.
        profile.pendingUpdates = null;

        await profile.save();

        await logDossierActivity({
            action: 'REJECT_HRIS',
            performedBy: req.user._id,
            companyId: req.companyId,
            details: {
                targetUser: userId,
                targetuser: userId,
                companyId: req.companyId,
                reason
            },
            ipAddress: req.ip
        });

        res.status(200).json({ message: 'HRIS Rejected', hris: profile.hris });
    } catch (error) {
        console.error('Reject HRIS Error:', error);
        res.status(500).json({ message: 'Server Error' });
    }
};

exports.exportHRISExcel = async (req, res) => {
    try {
        const ExcelJS = require('exceljs');
        const workbook = new ExcelJS.Workbook();
        const sheet = workbook.addWorksheet('HRIS Data');

        const query = {
            companyId: req.companyId,
            'hris.status': { $in: ['Pending Approval', 'Approved'] } // Fetch only submitted or approved profiles
        };

        if (req.query.userId) {
            query.user = req.query.userId;
        }

        const profiles = await EmployeeProfile.find(query)
            .sort({ 'hris.submittedAt': -1, 'hris.approvalDate': -1 })
            .select('+identity.aadhaarNumber +identity.panNumber +identity.passportNumber +compensation.bankDetails.accountNumber +compensation.ctc +compensation.uanNumber')
            .populate('user', 'employeeCode firstName lastName email')
            .populate('employment.businessUnit', 'name');

        const formatDate = (date) => date ? new Date(date).toLocaleDateString() : '';

        // --- Configuration: Define Sections and their Columns ---
        const sections = [
            {
                title: 'Employee Details',
                columns: [
                    { header: 'Employee Code', key: 'empCode', width: 15 },
                    { header: 'Full Name', key: 'fullName', width: 25 },
                    { header: 'First Name', key: 'firstName', width: 15 },
                    { header: 'Middle Name', key: 'middleName', width: 15 },
                    { header: 'Last Name', key: 'lastName', width: 15 },
                    { header: 'Gender', key: 'gender', width: 10 },
                    { header: 'Date of Birth', key: 'dob', width: 12 },
                    { header: 'Marital Status', key: 'maritalStatus', width: 15 },
                    { header: 'Date of Marriage', key: 'dateOfMarriage', width: 15 },
                    { header: 'Nationality', key: 'nationality', width: 15 },
                    { header: 'Blood Group', key: 'bloodGroup', width: 10 },
                    { header: 'Disability Status', key: 'disabilityStatus', width: 15 },
                    { header: 'Nature of Disability', key: 'disabilityDetails', width: 25 },
                    { header: 'Date of Joining', key: 'joiningDate', width: 12 },
                ]
            },
            {
                title: 'Contact Information',
                columns: [
                    { header: 'Personal Email ID', key: 'personalEmail', width: 25 },
                    { header: 'Mobile Number', key: 'mobile', width: 15 },
                    { header: 'Alternate Mobile Number', key: 'altMobile', width: 15 },
                    { header: 'Emergency Contact Name', key: 'emergencyName', width: 20 },
                    { header: 'Emergency Contact Relationship', key: 'emergencyRelation', width: 15 },
                    { header: 'Emergency Contact Number', key: 'emergencyPhone', width: 15 },
                    { header: 'Emergency Contact Email', key: 'emergencyEmail', width: 25 },
                ]
            },
            {
                title: 'Address Details',
                columns: [
                    { header: 'Present', key: 'currAddrFull', width: 40 },
                    { header: 'Permanent', key: 'permAddrFull', width: 40 },
                    { header: 'Mailing', key: 'mailAddrFull', width: 40 },
                ]
            },
            {
                title: 'Bank Account Details',
                columns: [
                    { header: 'Account Holder Name', key: 'accHolder', width: 20 },
                    { header: 'Bank Name', key: 'bankName', width: 20 },
                    { header: 'Branch Address', key: 'branchAddress', width: 30 },
                    { header: 'Account Number', key: 'accNum', width: 20 },
                    { header: 'IFSC Code', key: 'ifsc', width: 15 },
                    { header: 'UAN', key: 'uan', width: 15 },
                ]
            },
            {
                title: 'Government / Identity Details',
                columns: [
                    { header: 'PAN Number', key: 'pan', width: 15 },
                    { header: 'Aadhaar Number', key: 'aadhaar', width: 15 },
                    { header: 'Passport Number', key: 'passport', width: 15 },
                ]
            },
            {
                title: 'Medical Insurance Details',
                columns: [
                    { header: 'father name', key: 'fatherName', width: 20 },
                    { header: 'father occupation', key: 'fatherOcc', width: 20 },
                    { header: 'mother name', key: 'motherName', width: 20 },
                    { header: 'mother occupation', key: 'motherOcc', width: 20 },
                    { header: 'parents marital status', key: 'famMarital', width: 15 },
                    { header: 'total sibling', key: 'totalSiblings', width: 10 },
                    { header: 'spouse name', key: 'spouseName', width: 20 },
                    { header: 'spouse DOB', key: 'spouseDob', width: 12 },
                    { header: 'childern name', key: 'childNames', width: 25 },
                    { header: 'children DOB', key: 'childDobs', width: 25 },
                ]
            },
            {
                title: 'Educational Qualification',
                columns: [
                    { header: 'college name', key: 'college', width: 20 },
                    { header: 'Course Name', key: 'course', width: 20 },
                    { header: 'University', key: 'university', width: 20 },
                    { header: 'from date', key: 'eduFrom', width: 12 },
                    { header: 'to date', key: 'eduTo', width: 12 },
                    { header: 'Percentage / CGPA', key: 'cgpa', width: 10 },
                ]
            },
            {
                title: 'Work Experience',
                columns: [
                    { header: 'Total Years of Experience', key: 'totalExp', width: 10 },
                    { header: 'Previous Company Name', key: 'prevComp', width: 20 },
                    { header: 'Start Date', key: 'expStart', width: 12 },
                    { header: 'End Date', key: 'expEnd', width: 12 },
                    { header: 'Reason for Leaving', key: 'reasonForLeaving', width: 25 },
                ]
            },
            {
                title: 'Skills',
                columns: [
                    { header: 'Technical Skills', key: 'techSkills', width: 30 },
                    { header: 'Behavioral Skills', key: 'behavSkills', width: 30 },
                    { header: 'Skill you would like to learn', key: 'learnSkills', width: 30 },
                ]
            }
        ];

        // --- Build Headers ---

        let currentColumnIndex = 1;

        // Row 1: Section Headers
        const headerRow1 = sheet.getRow(1);
        headerRow1.font = { bold: true, size: 12 };
        headerRow1.alignment = { horizontal: 'center' };

        // Row 2: Sub Headers
        const headerRow2 = sheet.getRow(2);
        headerRow2.font = { bold: true };
        headerRow2.alignment = { horizontal: 'center', wrapText: true };

        // We need to define columns in ExcelJS to map keys correctly for addRow
        // But with empty separator columns, it's tricky. 
        // Strategy: We will manually map the key to the column object in the sheet
        const sheetColumns = [];

        sections.forEach((section, index) => {
            const startCol = currentColumnIndex;
            const endCol = startCol + section.columns.length - 1;

            // Merge cells for Section Title
            sheet.mergeCells(1, startCol, 1, endCol);
            const titleCell = sheet.getCell(1, startCol);
            titleCell.value = section.title;
            titleCell.fill = {
                type: 'pattern',
                pattern: 'solid',
                fgColor: { argb: 'FFD3D3D3' } // Light Gray
            };
            titleCell.border = { top: { style: 'thin' }, left: { style: 'thin' }, bottom: { style: 'thin' }, right: { style: 'thin' } };

            // Set Sub Headers and Column Widths
            section.columns.forEach((col, colIdx) => {
                const effectiveCol = startCol + colIdx;
                const cell = sheet.getCell(2, effectiveCol);
                cell.value = col.header;

                // Construct column definition for ExcelJS
                // Note: We need to pad with empty/null columns for separators if we use sheet.columns assignment
                // Instead, we will assign column properties directly
                const column = sheet.getColumn(effectiveCol);
                column.key = col.key;
                column.width = col.width;
            });

            currentColumnIndex = endCol + 2; // +1 for next, +1 for empty separator column
        });

        // --- Populate Data ---
        profiles.forEach(p => {
            const merged = p.toObject();
            if (merged.pendingUpdates && p.hris?.status === 'Approved') {
                const pending = merged.pendingUpdates;
                if (pending.personal) merged.personal = { ...(merged.personal || {}), ...pending.personal };
                if (pending.identity) merged.identity = { ...(merged.identity || {}), ...pending.identity };
                if (pending.contact) {
                    const mergedAddresses = [...(merged.contact?.addresses || [])];
                    if (pending.contact.addresses && Array.isArray(pending.contact.addresses)) {
                        pending.contact.addresses.forEach(addr => {
                            const idx = mergedAddresses.findIndex(a => a.type === addr.type);
                            if (idx !== -1) {
                                mergedAddresses[idx] = { ...mergedAddresses[idx], ...addr };
                            } else {
                                mergedAddresses.push(addr);
                            }
                        });
                    }
                    merged.contact = {
                        ...(merged.contact || {}),
                        ...pending.contact,
                        addresses: mergedAddresses
                    };
                }
                if (pending.family) merged.family = { ...(merged.family || {}), ...pending.family };
                if (pending.employment) merged.employment = { ...(merged.employment || {}), ...pending.employment };
                if (pending.compensation) {
                    merged.compensation = {
                        ...(merged.compensation || {}),
                        ...pending.compensation,
                        bankDetails: { ...(merged.compensation?.bankDetails || {}), ...(pending.compensation?.bankDetails || {}) }
                    };
                }
                if (pending.education) merged.education = pending.education;
                if (pending.experience) merged.experience = pending.experience;
                if (pending.skills) merged.skills = pending.skills;
            }

            const getAddr = (type) => merged.contact?.addresses?.find(a => a.type === type) || {};
            const curr = getAddr('Current');
            const perm = getAddr('Permanent');
            // Assuming 'Mailing' schema, fallback to empty
            const mail = merged.contact?.addresses?.find(a => a.type === 'Mailing') || {};

            // Calculate total experience
            let totalExpYears = 0;
            if (merged.experience && merged.experience.length > 0) {
                const msInYear = 1000 * 60 * 60 * 24 * 365.25;
                totalExpYears = merged.experience.reduce((acc, exp) => {
                    const start = exp.startDate ? new Date(exp.startDate) : new Date();
                    const end = exp.endDate ? new Date(exp.endDate) : new Date();
                    return acc + (end - start);
                }, 0) / msInYear;
            }

            // Determine max rows needed for this profile (based on array lengths)
            const eduCount = merged.education?.length || 0;
            const expCount = merged.experience?.length || 0;
            const childCount = merged.family?.children?.length || 0;
            const maxRows = Math.max(1, eduCount, expCount, childCount);

            for (let i = 0; i < maxRows; i++) {
                const isFirst = i === 0;

                // Get array items for current row index
                const edu = merged.education?.[i] || {};
                const exp = merged.experience?.[i] || {};
                const child = merged.family?.children?.[i] || {};

                // Helper to safely get date or empty
                const getDate = (d) => d ? formatDate(d) : '';

                // Helper to formatting address (only need to calculate once really, but simple enough)
                const formatFullAddr = (addr) => {
                    const l1 = addr?.line1 || addr?.street;
                    if (!addr || !l1) return '';
                    const parts = [
                        l1,
                        addr.addressLine2,
                        addr.city,
                        addr.state,
                        addr.country,
                        addr.zipCode,
                        addr.phone ? `Phone: ${addr.phone}` : ''
                    ];
                    return parts.filter(Boolean).join(', ');
                };

                const rowData = {
                    // --- STATIC FIELDS (Show only on first row) ---
                    empCode: isFirst ? merged.user?.employeeCode : '',
                    fullName: isFirst ? (merged.personal?.fullName || `${merged.user?.firstName} ${merged.user?.lastName}`.trim()) : '',
                    firstName: isFirst ? merged.user?.firstName : '',
                    middleName: isFirst ? merged.personal?.middleName : '',
                    lastName: isFirst ? merged.user?.lastName : '',
                    gender: isFirst ? merged.personal?.gender : '',
                    dob: isFirst ? formatDate(merged.personal?.dob) : '',
                    maritalStatus: isFirst ? merged.personal?.maritalStatus : '',
                    dateOfMarriage: isFirst ? (merged.personal?.dateOfMarriage ? formatDate(merged.personal?.dateOfMarriage) : '') : '',
                    nationality: isFirst ? merged.personal?.nationality : '',
                    bloodGroup: isFirst ? merged.personal?.bloodGroup : '',
                    disabilityStatus: isFirst ? (merged.personal?.disabilityStatus ? 'Yes' : 'No') : '',
                    disabilityDetails: isFirst ? (merged.personal?.disabilityStatus ? merged.personal?.disabilityDetails : '') : '',
                    joiningDate: isFirst ? formatDate(merged.employment?.joiningDate) : '',

                    // Contact
                    personalEmail: isFirst ? merged.contact?.personalEmail : '',
                    mobile: isFirst ? merged.contact?.mobileNumber : '',
                    altMobile: isFirst ? merged.contact?.alternateNumber : '',
                    emergencyName: isFirst ? merged.contact?.emergencyContact?.name : '',
                    emergencyRelation: isFirst ? (merged.contact?.emergencyContact?.relation || '') : '',
                    emergencyPhone: isFirst ? merged.contact?.emergencyContact?.phone : '',
                    emergencyEmail: isFirst ? merged.contact?.emergencyContact?.email : '',

                    // Addresses (Consolidated)
                    currAddrFull: isFirst ? formatFullAddr(curr) : '',
                    permAddrFull: isFirst ? formatFullAddr(perm) : '',
                    mailAddrFull: isFirst ? formatFullAddr(mail) : '',

                    // Bank
                    accHolder: isFirst ? (merged.compensation?.bankDetails?.accountHolderName || merged.personal?.fullName || `${merged.user?.firstName} ${merged.user?.lastName}`) : '',
                    bankName: isFirst ? merged.compensation?.bankDetails?.bankName : '',
                    branchAddress: isFirst ? merged.compensation?.bankDetails?.branchAddress : '',
                    accNum: isFirst ? merged.compensation?.bankDetails?.accountNumber : '',
                    ifsc: isFirst ? merged.compensation?.bankDetails?.ifscCode : '',
                    uan: isFirst ? (merged.compensation?.isUanApplicable === true ? (merged.compensation?.uanNumber || '') : 'Not Applicable') : '',

                    // Identity
                    pan: isFirst ? merged.identity?.panNumber : '',
                    aadhaar: isFirst ? merged.identity?.aadhaarNumber : '',
                    passport: isFirst ? merged.identity?.passportNumber : '',

                    // Family (Static Parents/Spouse)
                    fatherName: isFirst ? merged.family?.fatherName : '',
                    fatherOcc: isFirst ? merged.family?.fatherOccupation : '',
                    motherName: isFirst ? merged.family?.motherName : '',
                    motherOcc: isFirst ? merged.family?.motherOccupation : '',
                    famMarital: isFirst ? merged.family?.parentsMaritalStatus : '',
                    totalSiblings: isFirst ? merged.family?.totalSiblings : '',
                    spouseName: isFirst ? merged.family?.spouseName : '',
                    spouseDob: isFirst ? formatDate(merged.family?.spouseDob) : '',

                    // --- ARRAY FIELDS (Spread across rows) ---

                    // Children (One per row)
                    childNames: child.name || '',
                    childDobs: getDate(child.dob),

                    // Education (One per row)
                    college: edu.institution || '',
                    course: edu.courseName || edu.degree || '',
                    university: edu.university || '',
                    eduFrom: getDate(edu.fromDate),
                    eduTo: getDate(edu.toDate),
                    cgpa: edu.grade || '',

                    // Experience (One per row)
                    totalExp: isFirst && totalExpYears > 0 ? totalExpYears.toFixed(1) : '', // Summary field only on first row
                    prevComp: exp.companyName || '',
                    expStart: getDate(exp.startDate),
                    expEnd: getDate(exp.endDate),
                    reasonForLeaving: exp.reasonForLeaving || '',

                    // Skills (Are arrays but usually comma separated list is better than rows for skills, keeping as comma separated on first row)
                    techSkills: isFirst ? (merged.skills?.technical?.join(', ') || '') : '',
                    behavSkills: isFirst ? (merged.skills?.behavioral?.join(', ') || '') : '',
                    learnSkills: isFirst ? (merged.skills?.learningInterests?.join(', ') || '') : ''
                };

                sheet.addRow(rowData);
            }
        });

        const exportProfile = req.query.userId && profiles.length === 1 ? profiles[0] : null;
        const exportDisplayName = exportProfile
            ? [
                exportProfile.user?.firstName,
                exportProfile.user?.lastName
            ].filter(Boolean).join(' ').trim()
            : 'Employee_HRIS_Export';
        const safeExportFileName = (exportDisplayName || 'Employee_HRIS_Export')
            .replace(/\s+/g, '_')
            .replace(/[^a-zA-Z0-9_-]/g, '')
            || 'Employee_HRIS_Export';

        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.setHeader('Content-Disposition', `attachment; filename="${safeExportFileName}_HRIS.xlsx"`);

        await workbook.xlsx.write(res);
        res.end();

    } catch (error) {
        console.error('Export Excel Error:', error);
        res.status(500).json({ message: 'Failed to generate Excel' });
    }
};
