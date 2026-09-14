const crypto = require('crypto');
const ClientUser = require('./clientUser.model');
const Client = require('../client/client.model');
const { HiringRequest } = require('../talent-acquisition/model/hiringRequest.model');
const Candidate = require('../talent-acquisition/model/candidate.model');
const { maskEmail, maskPhone } = require('../talent-acquisition/utils/taVisibility');
const { isCandidateVisibleToClient } = require('../talent-acquisition/utils/taClientVisibility');
const { sendEmailForCompany } = require('../../services/companyEmailService');

const escapeRegex = (string = '') => String(string || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

exports.getClientUsers = async (req, res) => {
    try {
        const { clientId } = req.params;
        const companyId = req.companyId;

        const users = await ClientUser.find({
            clientId,
            companyId,
            isDeleted: false
        })
            .select('-password')
            .sort({ createdAt: -1 })
            .lean();

        return res.json(users);
    } catch (error) {
        console.error('Get client users error:', error);
        return res.status(500).json({ message: 'Failed to fetch client users', error: error.message });
    }
};

exports.inviteClientUser = async (req, res) => {
    try {
        const { clientId } = req.params;
        const { firstName, lastName, email, phone, role, isPrimaryContact } = req.body;
        const companyId = req.companyId;

        if (!email || !firstName) {
            return res.status(400).json({ message: 'First name and email are required' });
        }

        const client = await Client.findOne({ _id: clientId, companyId });
        if (!client) {
            return res.status(404).json({ message: 'Client organization not found' });
        }

        const normalizedEmail = email.trim().toLowerCase();
        let user = await ClientUser.findOne({
            clientId,
            companyId,
            email: normalizedEmail,
            isDeleted: false
        });

        if (user && user.status === 'Active') {
            return res.status(409).json({ message: 'A user with this email already exists and is active.' });
        }

        const inviteToken = crypto.randomBytes(32).toString('hex');
        const inviteExpires = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 days

        if (user) {
            user.firstName = firstName.trim();
            if (lastName !== undefined) user.lastName = lastName.trim();
            if (phone !== undefined) user.phone = phone.trim();
            if (role) user.role = role;
            if (isPrimaryContact !== undefined) user.isPrimaryContact = isPrimaryContact;
            user.inviteToken = inviteToken;
            user.inviteExpires = inviteExpires;
            user.status = 'Invited';
            await user.save();
        } else {
            user = await ClientUser.create({
                clientId,
                companyId,
                firstName: firstName.trim(),
                lastName: (lastName || '').trim(),
                email: normalizedEmail,
                phone: (phone || '').trim(),
                role: role || 'ClientViewer',
                isPrimaryContact: Boolean(isPrimaryContact),
                inviteToken,
                inviteExpires,
                status: 'Invited'
            });
        }

        const origin = req.get('origin') || process.env.FRONTEND_URL || '';
        const inviteLink = `${origin}/client-portal/accept-invite?token=${inviteToken}`;

        // Attempt sending invite email, best effort
        try {
            await sendEmailForCompany({
                companyId,
                to: normalizedEmail,
                subject: `Invitation to ${client.name || client.companyName || 'Client'} Portal`,
                html: `
                    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
                        <h2>You're invited to the Client Portal</h2>
                        <p>Hello ${user.firstName},</p>
                        <p>You have been invited to access the recruitment portal for <strong>${client.name || client.companyName}</strong>.</p>
                        <p style="margin: 24px 0;">
                            <a href="${inviteLink}" style="background-color: #2563eb; color: #fff; padding: 12px 24px; text-decoration: none; border-radius: 6px; font-weight: bold;">
                                Accept Invitation & Set Password
                            </a>
                        </p>
                        <p>Or copy this link into your browser:<br/><a href="${inviteLink}">${inviteLink}</a></p>
                        <p>This invitation link expires in 7 days.</p>
                    </div>
                `
            });
        } catch (mailErr) {
            console.warn('Could not send client portal invite email:', mailErr.message);
        }

        const userObj = user.toObject();
        delete userObj.password;

        return res.status(201).json({
            message: 'Client user invited successfully',
            user: userObj,
            inviteLink
        });
    } catch (error) {
        console.error('Invite client user error:', error);
        return res.status(500).json({ message: 'Failed to invite client user', error: error.message });
    }
};

exports.updateClientUser = async (req, res) => {
    try {
        const { clientId, userId } = req.params;
        const { firstName, lastName, phone, role, status, isPrimaryContact } = req.body;
        const companyId = req.companyId;

        const user = await ClientUser.findOne({
            _id: userId,
            clientId,
            companyId,
            isDeleted: false
        });

        if (!user) {
            return res.status(404).json({ message: 'Client user not found' });
        }

        if (firstName) user.firstName = firstName.trim();
        if (lastName !== undefined) user.lastName = lastName.trim();
        if (phone !== undefined) user.phone = phone.trim();
        if (role && ['ClientAdmin', 'ClientInterviewer', 'ClientViewer'].includes(role)) user.role = role;
        if (status && ['Invited', 'Active', 'Suspended'].includes(status)) user.status = status;
        if (isPrimaryContact !== undefined) user.isPrimaryContact = Boolean(isPrimaryContact);

        await user.save();

        const userObj = user.toObject();
        delete userObj.password;

        return res.json({
            message: 'Client user updated successfully',
            user: userObj
        });
    } catch (error) {
        console.error('Update client user error:', error);
        return res.status(500).json({ message: 'Failed to update client user', error: error.message });
    }
};

exports.deleteClientUser = async (req, res) => {
    try {
        const { clientId, userId } = req.params;
        const companyId = req.companyId;

        const user = await ClientUser.findOne({
            _id: userId,
            clientId,
            companyId,
            isDeleted: false
        });

        if (!user) {
            return res.status(404).json({ message: 'Client user not found' });
        }

        user.isDeleted = true;
        user.deletedAt = new Date();
        user.deletedBy = req.user?._id;
        await user.save();

        return res.json({ message: 'Client user removed successfully' });
    } catch (error) {
        console.error('Delete client user error:', error);
        return res.status(500).json({ message: 'Failed to delete client user', error: error.message });
    }
};

exports.resendInvite = async (req, res) => {
    try {
        const { clientId, userId } = req.params;
        const companyId = req.companyId;

        const user = await ClientUser.findOne({
            _id: userId,
            clientId,
            companyId,
            isDeleted: false
        });

        if (!user) {
            return res.status(404).json({ message: 'Client user not found' });
        }

        const client = await Client.findById(clientId).select('name companyName');
        const inviteToken = crypto.randomBytes(32).toString('hex');
        user.inviteToken = inviteToken;
        user.inviteExpires = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
        user.status = 'Invited';
        await user.save();

        const origin = req.get('origin') || process.env.FRONTEND_URL || '';
        const inviteLink = `${origin}/client-portal/accept-invite?token=${inviteToken}`;

        try {
            await sendEmailForCompany({
                companyId,
                to: user.email,
                subject: `Invitation Reminder: ${client?.name || client?.companyName || 'Client'} Portal`,
                html: `
                    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
                        <h2>Client Portal Invitation Reminder</h2>
                        <p>Hello ${user.firstName},</p>
                        <p>This is a reminder to accept your invitation to access the recruitment portal for <strong>${client?.name || client?.companyName}</strong>.</p>
                        <p style="margin: 24px 0;">
                            <a href="${inviteLink}" style="background-color: #2563eb; color: #fff; padding: 12px 24px; text-decoration: none; border-radius: 6px; font-weight: bold;">
                                Accept Invitation & Set Password
                            </a>
                        </p>
                        <p>Or copy this link into your browser:<br/><a href="${inviteLink}">${inviteLink}</a></p>
                    </div>
                `
            });
        } catch (mailErr) {
            console.warn('Could not send client portal invite reminder email:', mailErr.message);
        }

        return res.json({
            message: 'Invitation resent successfully',
            inviteLink
        });
    } catch (error) {
        console.error('Resend invite error:', error);
        return res.status(500).json({ message: 'Failed to resend invitation', error: error.message });
    }
};

/**
 * GET /api/ta/clients/:clientId/shared-summary
 * Agency recruiter/admin endpoint to inspect all items, policies, requisitions,
 * candidate profiles, resume access, and contact masking settings shared with a client.
 */
exports.getClientSharedAccessSummary = async (req, res) => {
    try {
        const { clientId } = req.params;
        const companyId = req.companyId;

        const client = await Client.findOne({ _id: clientId, companyId }).lean();
        if (!client) {
            return res.status(404).json({ message: 'Client organization not found' });
        }

        const names = [client.name, client.companyName, client.nickname]
            .filter(Boolean)
            .map(s => String(s).trim())
            .filter(Boolean);
        const nameRegexes = names.map(n => new RegExp(`^${escapeRegex(n)}$`, 'i'));

        const reqQuery = {
            companyId,
            isDeleted: false,
            $or: [
                { clientId: client._id },
                ...(nameRegexes.length > 0 ? [{ client: { $in: nameRegexes } }] : [])
            ]
        };

        const requisitions = await HiringRequest.find(reqQuery)
            .select('requestId roleDetails client clientId clientVisibility recruitmentPhases status createdAt updatedAt')
            .sort({ createdAt: -1 })
            .lean();

        const reqMap = new Map();
        const reqIds = requisitions.map(r => {
            reqMap.set(String(r._id), r);
            return r._id;
        });

        const candidates = await Candidate.find({
            hiringRequestId: { $in: reqIds },
            companyId,
            isDeleted: false
        })
            .select('candidateName email mobile status decision currentPhaseOrder preference currentCompany totalExperience resumeUrl profileShared hiddenFromClient phase2Decision phase3Decision phase2InterviewStatus interviewRounds hiringRequestId createdAt updatedAt')
            .sort({ updatedAt: -1, createdAt: -1 })
            .lean();

        const sharedCandidates = [];

        for (const candidate of candidates) {
            const reqDoc = reqMap.get(String(candidate.hiringRequestId));
            if (!reqDoc) continue;

            const isVisible = isCandidateVisibleToClient(candidate, reqDoc);
            if (!isVisible) {
                continue;
            }

            const visibility = reqDoc.clientVisibility || {};
            const isContactMasked = visibility.maskCandidateContact !== false;
            const isCompensationMasked = visibility.maskCompensation !== false;
            const isResumeDownloadAllowed = Boolean(visibility.allowResumeDownload);
            const hasResume = Boolean(candidate.resumeUrl);

            let sharedMechanism = 'Phase Gated';
            if (candidate.profileShared) {
                sharedMechanism = 'Explicitly Shared';
            } else if (
                Array.isArray(candidate.interviewRounds) &&
                candidate.interviewRounds.some(r => r.isClientInterview || (Array.isArray(r.assignedClientUsers) && r.assignedClientUsers.length > 0))
            ) {
                sharedMechanism = 'Client Interview';
            }

            const clientFeedbackRounds = (candidate.interviewRounds || []).filter(
                r => r.clientFeedback || r.clientRating || r.isClientInterview
            );

            sharedCandidates.push({
                _id: candidate._id,
                candidateName: candidate.candidateName,
                email: candidate.email,
                mobile: candidate.mobile,
                maskedEmail: maskEmail(candidate.email),
                maskedPhone: maskPhone(candidate.mobile),
                currentCompany: candidate.currentCompany || '',
                totalExperience: candidate.totalExperience || 0,
                status: candidate.status || 'Total Sourced',
                preference: candidate.preference || '',
                resumeUrl: candidate.resumeUrl || null,
                hasResume,
                isContactMasked,
                isCompensationMasked,
                isResumeDownloadAllowed,
                sharedMechanism,
                phase2Decision: candidate.phase2Decision || 'Pending',
                phase2InterviewStatus: candidate.phase2InterviewStatus || 'None',
                clientFeedbackCount: clientFeedbackRounds.length,
                requisition: {
                    _id: reqDoc._id,
                    requestId: reqDoc.requestId,
                    title: reqDoc.roleDetails?.title || 'Untitled Role',
                    department: reqDoc.roleDetails?.department || '',
                    status: reqDoc.status,
                    clientVisibility: visibility
                },
                sharedAt: candidate.updatedAt || candidate.createdAt
            });
        }

        const requisitionSummaries = requisitions.map(r => {
            const sharedCount = sharedCandidates.filter(c => String(c.requisition._id) === String(r._id)).length;
            return {
                _id: r._id,
                requestId: r.requestId,
                title: r.roleDetails?.title || 'Untitled Role',
                department: r.roleDetails?.department || '',
                status: r.status,
                clientVisibility: r.clientVisibility || { enabled: false },
                recruitmentPhases: r.recruitmentPhases || [],
                sharedCandidateCount: sharedCount
            };
        });

        const hasAnyRequisition = requisitions.length > 0;
        const defaultMaskContact = hasAnyRequisition
            ? requisitions.every(r => r.clientVisibility?.maskCandidateContact !== false)
            : true;
        const defaultMaskCompensation = hasAnyRequisition
            ? requisitions.every(r => r.clientVisibility?.maskCompensation !== false)
            : true;
        const defaultAllowResumeDownload = hasAnyRequisition
            ? requisitions.some(r => r.clientVisibility?.allowResumeDownload === true)
            : false;
        const defaultAllowDecision = hasAnyRequisition
            ? requisitions.some(r => r.clientVisibility?.allowClientDecision !== false)
            : true;

        const summary = {
            totalRequisitions: requisitions.length,
            activeRequisitions: requisitions.filter(r => ['Active', 'Approved', 'Open'].includes(r.status)).length,
            totalSharedCandidates: sharedCandidates.length,
            totalResumesAvailable: sharedCandidates.filter(c => c.hasResume).length,
            contactsMaskedCount: sharedCandidates.filter(c => c.isContactMasked).length,
            contactsVisibleCount: sharedCandidates.filter(c => !c.isContactMasked).length,
            resumesDownloadableCount: sharedCandidates.filter(c => c.isResumeDownloadAllowed && c.hasResume).length,
            resumesRestrictedCount: sharedCandidates.filter(c => !c.isResumeDownloadAllowed && c.hasResume).length
        };

        const policy = {
            maskCandidateContact: defaultMaskContact,
            maskCompensation: defaultMaskCompensation,
            allowResumeDownload: defaultAllowResumeDownload,
            allowClientDecision: defaultAllowDecision
        };

        return res.json({
            client: {
                _id: client._id,
                name: client.name,
                companyName: client.companyName
            },
            summary,
            policy,
            requisitions: requisitionSummaries,
            sharedCandidates
        });
    } catch (error) {
        console.error('Get client shared summary error:', error);
        return res.status(500).json({ message: 'Failed to fetch client shared summary', error: error.message });
    }
};

