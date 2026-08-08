const EmployeeProfile = require('../employeeProfile.model');
const { getDossierDiff, checkIsAdmin, hasPermission } = require('../utils/dossierHelpers');
const { logDossierActivity } = require('./dossierHistoryController');

exports.getHRISRequests = async (req, res) => {
    try {
        const canApprove = hasPermission(req.user, 'dossier.approve');
        const isAdmin = checkIsAdmin(req.user);

        if (!canApprove && !isAdmin) {
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
                const existingBreakup = profile.compensation?.salaryBreakup instanceof Map
                    ? Object.fromEntries(profile.compensation.salaryBreakup)
                    : (profile.compensation?.salaryBreakup || {});
                profile.compensation = {
                    ...(profile.compensation?.toObject?.() || {}),
                    ...pending.compensation,
                    bankDetails: { ...(profile.compensation?.bankDetails || {}), ...(pending.compensation?.bankDetails || {}) },
                    salaryBreakup: { ...existingBreakup, ...(pending.compensation?.salaryBreakup || {}) }
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

        profile.hris.status = 'Rejected';
        profile.hris.rejectionReason = reason;
        profile.hris.approvedBy = null;
        profile.hris.approvalDate = null;

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
