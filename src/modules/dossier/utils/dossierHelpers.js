const mongoose = require('mongoose');
const OnboardingEmployee = require('../../onboarding/onboardingEmployee.model');
const Company = require('../../company/company.model');
const {
    DOCUMENT_PENDING_REVIEW_STATUS,
    normalizeDocumentWorkflowStatus,
    syncDocumentSubmissionStatus
} = require('../dossierUtils');

const BANK_DOCUMENT_TITLE = 'Cancelled Cheque / Passbook Front Page';
const PASSPORT_DOCUMENT_TITLE = 'Passport';
const LEGACY_PASSPORT_DOCUMENT_TITLE = 'Passport (Optional)';
const PASSPORT_PHOTO_DOCUMENT_TITLE = 'Recent Passport-Size Photograph';
const LIVE_PHOTO_DOCUMENT_TITLE = 'Live Photograph';
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
        archiveReason,
        livePhotoMetadata: doc.livePhotoMetadata
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
            || normalizedTitle === LIVE_PHOTO_DOCUMENT_TITLE.toLowerCase()
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
        delete profileObj.compensation;
        delete profileObj.identity;
        delete profileObj.family; delete profileObj.contact; delete profileObj.documents; delete profileObj.hris; delete profileObj.skills;
        delete profileObj.pendingUpdates;
    } else {
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

    if (profileObj.compensation && profileObj.compensation.salaryBreakup) {
        if (profileObj.compensation.salaryBreakup instanceof Map) {
            profileObj.compensation.salaryBreakup = Object.fromEntries(profileObj.compensation.salaryBreakup);
        } else if (typeof profileObj.compensation.salaryBreakup.get === 'function') {
            profileObj.compensation.salaryBreakup = Object.fromEntries(profileObj.compensation.salaryBreakup);
        } else if (profile.compensation && profile.compensation.salaryBreakup instanceof Map) {
            profileObj.compensation.salaryBreakup = Object.fromEntries(profile.compensation.salaryBreakup);
        }
    }

    if (profileObj.pendingUpdates && profileObj.pendingUpdates.compensation && profileObj.pendingUpdates.compensation.salaryBreakup) {
        const pb = profileObj.pendingUpdates.compensation.salaryBreakup;
        if (pb instanceof Map) {
            profileObj.pendingUpdates.compensation.salaryBreakup = Object.fromEntries(pb);
        } else if (typeof pb.get === 'function') {
            profileObj.pendingUpdates.compensation.salaryBreakup = Object.fromEntries(pb);
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

module.exports = {
    BANK_DOCUMENT_TITLE,
    PASSPORT_DOCUMENT_TITLE,
    LEGACY_PASSPORT_DOCUMENT_TITLE,
    PASSPORT_PHOTO_DOCUMENT_TITLE,
    LIVE_PHOTO_DOCUMENT_TITLE,
    EXPERIENCE_CERTIFICATE_DOCUMENT_TITLE,
    LEGACY_EXPERIENCE_CERTIFICATE_DOCUMENT_TITLE,
    OFFER_LETTER_DOCUMENT_TITLE,
    POLICY_SOURCE_LABEL,
    normalizeDocumentKey,
    isValidPhone,
    isValidEmail,
    isValidAadhaar,
    isValidPAN,
    hasModifiedSensitiveField,
    getDossierDiff,
    mergePendingUpdates,
    archiveCurrentDocumentVersion,
    reopenDocumentSubmission,
    normalizeProfileDocumentWorkflow,
    buildTransferredOnboardingCustomFiles,
    normalizeTransferredIdentityDocuments,
    ensureTransferredBankDocument,
    filterProfileFields,
    checkIsAdmin,
    hasPermission,
    getHRISApprovers
};
