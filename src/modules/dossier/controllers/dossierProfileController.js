const EmployeeProfile = require('../employeeProfile.model');
const User = require('../../user/user.model');
const {
    normalizeTransferredIdentityDocuments,
    ensureTransferredBankDocument,
    normalizeProfileDocumentWorkflow,
    filterProfileFields,
    checkIsAdmin,
    hasPermission,
    buildTransferredOnboardingCustomFiles
} = require('../utils/dossierHelpers');
const { isActiveDocument } = require('../dossierUtils');

exports.getDossier = async (req, res) => {
    try {
        const { userId } = req.params;
        const viewerId = req.user._id.toString();
        const isSelf = userId === viewerId;

        const targetUser = await User.findById(userId);
        if (!targetUser) return res.status(404).json({ message: 'User not found' });

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
            try {
                if (profile.skills && Array.isArray(profile.skills)) {
                    console.warn(`[FIX] Converting skills array to object for user ${userId}`);
                    const newSkills = {
                        technical: [],
                        behavioral: [],
                        learningInterests: []
                    };

                    await EmployeeProfile.updateOne(
                        { _id: profile._id },
                        { $set: { skills: newSkills } }
                    );

                    profile.skills = newSkills;
                }
            } catch (skillError) {
                console.error('[WARNING] Failed to migrate skills array:', skillError.message);
            }

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

        let filteredProfile = filterProfileFields(profile, req.user, isSelf);

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
            error: error.message
        });
    }
};
