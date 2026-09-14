const crypto = require('crypto');
const mongoose = require('mongoose');
const ClientUser = require('./clientUser.model');
const { HiringRequest } = require('../talent-acquisition/model/hiringRequest.model');
const Candidate = require('../talent-acquisition/model/candidate.model');
const {
    isCandidateVisibleToClient,
    sanitizeCandidateForClient,
    sanitizeRequisitionForClient
} = require('../talent-acquisition/utils/taClientVisibility');

const escapeRegex = (string = '') => String(string || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Builds a query for HiringRequest that matches the client either via clientId or client name,
 * ensuring robust backward compatibility for unmigrated or legacy requisitions.
 */
const buildClientRequisitionQuery = (req, extraFilter = {}) => {
    const clientOr = [];
    if (req.clientId) {
        clientOr.push({ clientId: req.clientId });
    }
    if (req.client) {
        const names = [req.client.name, req.client.companyName, req.client.nickname]
            .filter(Boolean)
            .map(s => String(s).trim())
            .filter(Boolean);

        const uniqueNames = Array.from(new Set(names));
        uniqueNames.forEach(name => {
            clientOr.push({
                client: new RegExp(`^${escapeRegex(name)}$`, 'i'),
                // Prevent matching a requisition assigned to a different client
                clientId: { $in: [null, undefined, req.clientId] }
            });
        });
    }

    const base = {
        companyId: req.companyId,
        isDeleted: false
    };

    if (clientOr.length === 1) {
        Object.assign(base, clientOr[0]);
    } else if (clientOr.length > 1) {
        base.$or = clientOr;
    }

    if (!extraFilter || Object.keys(extraFilter).length === 0) {
        return base;
    }

    if (base.$or && extraFilter.$or) {
        const { $or: extraOr, ...restExtra } = extraFilter;
        return {
            companyId: base.companyId,
            isDeleted: base.isDeleted,
            $and: [
                { $or: base.$or },
                { $or: extraOr }
            ],
            ...restExtra
        };
    }

    return { ...base, ...extraFilter };
};

/**
 * GET /api/client-portal/requisitions
 * List all active/open requisitions assigned to this client.
 */
exports.getRequisitions = async (req, res) => {
    try {
        const { search, status } = req.query;
        const extraFilter = {
            status: { $nin: ['Draft', 'Rejected'] },
            'clientVisibility.enabled': { $ne: false }
        };

        if (status) {
            extraFilter.status = status;
        }

        if (search) {
            const searchRegex = new RegExp(escapeRegex(search), 'i');
            extraFilter.$or = [
                { requestId: searchRegex },
                { 'roleDetails.title': searchRegex }
            ];
        }

        const query = buildClientRequisitionQuery(req, extraFilter);

        const requisitions = await HiringRequest.find(query)
            .select('requestId client clientId roleDetails employmentDetails hiringDetails requirements status clientVisibility createdAt updatedAt')
            .sort({ createdAt: -1 })
            .lean();

        // Auto-heal clientId on legacy requisitions matched by client name
        const unlinkedReqs = requisitions.filter(r => !r.clientId && req.clientId);
        if (unlinkedReqs.length > 0) {
            HiringRequest.updateMany(
                { _id: { $in: unlinkedReqs.map(r => r._id) } },
                { $set: { clientId: req.clientId } }
            ).catch(err => console.error('Failed to auto-heal requisition clientId:', err));
        }

        // Attach candidate visibility counts for each requisition
        const reqIds = requisitions.map(r => r._id);
        const candidates = await Candidate.find({
            hiringRequestId: { $in: reqIds },
            companyId: req.companyId,
            isDeleted: false
        }).select('_id hiringRequestId status decision profileShared currentPhaseOrder phase2Decision phase3Decision interviewRounds hiddenFromClient').lean();

        const candidateCountMap = new Map();
        candidates.forEach(c => {
            const key = String(c.hiringRequestId);
            if (!candidateCountMap.has(key)) {
                candidateCountMap.set(key, []);
            }
            candidateCountMap.get(key).push(c);
        });

        const result = requisitions.map(r => {
            const rCandidates = candidateCountMap.get(String(r._id)) || [];
            const visibleCandidates = rCandidates.filter(c => isCandidateVisibleToClient(c, r, req.clientUser));

            const sanitized = sanitizeRequisitionForClient(r);
            sanitized.totalCandidates = visibleCandidates.length;
            sanitized.shortlistedCandidates = visibleCandidates.filter(c => c.phase2Decision === 'Shortlisted' || c.status === 'Shortlisted').length;
            sanitized.interviewingCandidates = visibleCandidates.filter(c => c.status === 'Interview Scheduled' || c.status === 'In Interview').length;
            return sanitized;
        });

        return res.json(result);
    } catch (error) {
        console.error('Client getRequisitions error:', error);
        return res.status(500).json({ message: 'Failed to fetch requisitions', error: error.message });
    }
};

/**
 * GET /api/client-portal/requisitions/:id
 */
exports.getRequisitionById = async (req, res) => {
    try {
        const { id } = req.params;
        if (!mongoose.Types.ObjectId.isValid(id)) {
            return res.status(404).json({ message: 'Requisition not found' });
        }

        const requisition = await HiringRequest.findOne(
            buildClientRequisitionQuery(req, { _id: id })
        ).lean();

        if (!requisition || requisition.clientVisibility?.enabled === false) {
            return res.status(404).json({ message: 'Requisition not found or access disabled' });
        }

        if (!requisition.clientId && req.clientId) {
            HiringRequest.updateOne({ _id: requisition._id }, { $set: { clientId: req.clientId } }).catch(() => {});
        }

        return res.json(sanitizeRequisitionForClient(requisition));
    } catch (error) {
        console.error('Client getRequisitionById error:', error);
        return res.status(500).json({ message: 'Failed to fetch requisition details', error: error.message });
    }
};

/**
 * GET /api/client-portal/requisitions/:id/candidates
 * List candidates for a requisition, filtered by visibility engine.
 */
exports.getRequisitionCandidates = async (req, res) => {
    try {
        const { id } = req.params;
        if (!mongoose.Types.ObjectId.isValid(id)) {
            return res.status(404).json({ message: 'Requisition not found' });
        }

        const requisition = await HiringRequest.findOne(
            buildClientRequisitionQuery(req, { _id: id })
        ).lean();

        if (!requisition || requisition.clientVisibility?.enabled === false) {
            return res.status(404).json({ message: 'Requisition not accessible' });
        }

        if (!requisition.clientId && req.clientId) {
            HiringRequest.updateOne({ _id: requisition._id }, { $set: { clientId: req.clientId } }).catch(() => {});
        }

        const rawCandidates = await Candidate.find({
            hiringRequestId: id,
            companyId: req.companyId,
            isDeleted: false
        }).sort({ createdAt: -1 });

        const visibleCandidates = rawCandidates
            .filter(c => isCandidateVisibleToClient(c, requisition, req.clientUser))
            .map(c => sanitizeCandidateForClient(c, requisition, req.clientUser));

        return res.json(visibleCandidates);
    } catch (error) {
        console.error('Client getRequisitionCandidates error:', error);
        return res.status(500).json({ message: 'Failed to fetch candidates', error: error.message });
    }
};

/**
 * GET /api/client-portal/candidates/:id
 */
exports.getCandidateById = async (req, res) => {
    try {
        const { id } = req.params;
        if (!mongoose.Types.ObjectId.isValid(id)) {
            return res.status(404).json({ message: 'Candidate not found' });
        }

        const candidate = await Candidate.findOne({
            _id: id,
            companyId: req.companyId,
            isDeleted: false
        });

        if (!candidate) {
            return res.status(404).json({ message: 'Candidate not found' });
        }

        const requisition = await HiringRequest.findOne(
            buildClientRequisitionQuery(req, { _id: candidate.hiringRequestId })
        ).lean();

        if (!requisition || !isCandidateVisibleToClient(candidate, requisition, req.clientUser)) {
            return res.status(404).json({ message: 'Candidate not found or access not granted' });
        }

        if (!requisition.clientId && req.clientId) {
            HiringRequest.updateOne({ _id: requisition._id }, { $set: { clientId: req.clientId } }).catch(() => {});
        }

        const sanitized = sanitizeCandidateForClient(candidate, requisition, req.clientUser);
        sanitized.requisition = {
            _id: requisition._id,
            requestId: requisition.requestId,
            title: requisition.roleDetails?.title
        };

        return res.json(sanitized);
    } catch (error) {
        console.error('Client getCandidateById error:', error);
        return res.status(500).json({ message: 'Failed to fetch candidate', error: error.message });
    }
};

/**
 * GET /api/client-portal/interviews/my
 * List interviews assigned to the current client interviewer/admin.
 */
exports.getMyInterviews = async (req, res) => {
    try {
        const isClientAdmin = req.clientUser.role === 'ClientAdmin';

        // Pre-fetch client's accessible requisitions
        const visibleReqs = await HiringRequest.find(
            buildClientRequisitionQuery(req, {
                'clientVisibility.enabled': { $ne: false },
                status: { $nin: ['Draft', 'Rejected'] }
            })
        ).lean();

        const reqMap = new Map(visibleReqs.map(r => [String(r._id), r]));
        const visibleReqIds = Array.from(reqMap.keys());

        if (visibleReqIds.length === 0) {
            return res.json([]);
        }

        const query = {
            companyId: req.companyId,
            hiringRequestId: { $in: visibleReqIds },
            hiddenFromClient: { $ne: true },
            isDeleted: false
        };

        if (isClientAdmin) {
            query['interviewRounds.0'] = { $exists: true };
        } else {
            query['interviewRounds.assignedClientUsers'] = req.clientUser._id;
        }

        const candidates = await Candidate.find(query).lean();

        const myInterviews = [];

        candidates.forEach(c => {
            const reqDoc = reqMap.get(String(c.hiringRequestId));
            if (!reqDoc) return;

            // Enforce visibility engine
            if (!isCandidateVisibleToClient(c, reqDoc, req.clientUser)) {
                return;
            }

            // Auto-heal clientId if missing on requisition
            if (!reqDoc.clientId && req.clientId) {
                HiringRequest.updateOne({ _id: reqDoc._id }, { $set: { clientId: req.clientId } }).catch(() => {});
            }

            (c.interviewRounds || []).forEach(round => {
                const isAssigned = Array.isArray(round.assignedClientUsers) &&
                    round.assignedClientUsers.some(uid => String(uid?._id || uid) === String(req.clientUser._id));

                if (isClientAdmin || isAssigned) {
                    myInterviews.push({
                        candidateId: c._id,
                        candidateName: c.candidateName,
                        requisitionId: reqDoc._id,
                        requisitionTitle: reqDoc.roleDetails?.title,
                        requisitionCode: reqDoc.requestId,
                        roundId: round._id,
                        levelName: round.levelName,
                        scheduledDate: round.scheduledDate,
                        status: round.status,
                        isClientInterview: Boolean(round.isClientInterview || isAssigned),
                        clientFeedback: round.clientFeedback,
                        clientRating: round.clientRating,
                        clientEvaluatedAt: round.clientEvaluatedAt,
                        skillRatings: round.skillRatings || []
                    });
                }
            });
        });

        myInterviews.sort((a, b) => new Date(b.scheduledDate || 0) - new Date(a.scheduledDate || 0));

        return res.json(myInterviews);
    } catch (error) {
        console.error('Client getMyInterviews error:', error);
        return res.status(500).json({ message: 'Failed to fetch interviews', error: error.message });
    }
};

/**
 * PATCH /api/client-portal/candidates/:id/rounds/:roundId/evaluate
 * Submit interview score and feedback.
 */
exports.evaluateRound = async (req, res) => {
    try {
        const { id, roundId } = req.params;
        const { rating, feedback, status, skillRatings } = req.body;

        if (!mongoose.Types.ObjectId.isValid(id)) {
            return res.status(404).json({ message: 'Candidate not found' });
        }

        const candidate = await Candidate.findOne({
            _id: id,
            companyId: req.companyId,
            isDeleted: false
        });

        if (!candidate) {
            return res.status(404).json({ message: 'Candidate not found' });
        }

        const requisition = await HiringRequest.findOne(
            buildClientRequisitionQuery(req, { _id: candidate.hiringRequestId })
        );

        if (!requisition) {
            return res.status(403).json({ message: 'Unauthorized candidate evaluation' });
        }

        if (!requisition.clientId && req.clientId) {
            HiringRequest.updateOne({ _id: requisition._id }, { $set: { clientId: req.clientId } }).catch(() => {});
        }

        // Enforce candidate visibility in client portal
        if (!isCandidateVisibleToClient(candidate, requisition, req.clientUser)) {
            return res.status(403).json({ message: 'Candidate is not accessible in client portal' });
        }

        // Enforce client feedback permission toggle
        if (requisition.clientVisibility?.allowClientFeedback === false) {
            return res.status(403).json({ message: 'Client interview feedback is disabled for this requisition' });
        }

        const round = candidate.interviewRounds.id(roundId);
        if (!round) {
            return res.status(404).json({ message: 'Interview round not found' });
        }

        const isClientAdmin = req.clientUser.role === 'ClientAdmin';
        const isAssigned = Array.isArray(round.assignedClientUsers) &&
            round.assignedClientUsers.some(uid => String(uid?._id || uid) === String(req.clientUser._id));

        if (!isClientAdmin && !isAssigned) {
            return res.status(403).json({ message: 'You are not assigned to evaluate this round' });
        }

        if (rating !== undefined) {
            const parsedRating = Number(rating);
            if (parsedRating < 1 || parsedRating > 10) {
                return res.status(400).json({ message: 'Rating must be between 1 and 10' });
            }
            round.clientRating = parsedRating;
        }

        if (feedback !== undefined) {
            round.clientFeedback = String(feedback).trim();
        }

        if (status && ['Passed', 'Failed', 'Shortlisted', 'Rejected', 'Hold'].includes(status)) {
            round.status = status;
        }

        if (Array.isArray(skillRatings)) {
            round.skillRatings = skillRatings;
        }

        round.clientEvaluatedBy = req.clientUser._id;
        round.clientEvaluatedAt = new Date();

        await candidate.save();

        return res.json({
            message: 'Interview evaluation recorded successfully',
            round
        });
    } catch (error) {
        console.error('Client evaluateRound error:', error);
        return res.status(500).json({ message: 'Failed to record evaluation', error: error.message });
    }
};

/**
 * PATCH /api/client-portal/candidates/:id/client-decision
 * Submit client hiring decision on candidate.
 */
exports.submitClientDecision = async (req, res) => {
    try {
        const { id } = req.params;
        const { decision, notes } = req.body;

        if (!decision || !['Shortlisted', 'Selected', 'Rejected', 'On Hold'].includes(decision)) {
            return res.status(400).json({ message: 'Valid decision is required (Shortlisted, Selected, Rejected, On Hold)' });
        }

        // Only ClientAdmin or ClientInterviewer can submit decision
        if (!['ClientAdmin', 'ClientInterviewer'].includes(req.clientUser.role)) {
            return res.status(403).json({ message: 'Permission denied to submit client decision' });
        }

        if (!mongoose.Types.ObjectId.isValid(id)) {
            return res.status(404).json({ message: 'Candidate not found' });
        }

        const candidate = await Candidate.findOne({
            _id: id,
            companyId: req.companyId,
            isDeleted: false
        });

        if (!candidate) {
            return res.status(404).json({ message: 'Candidate not found' });
        }

        const requisition = await HiringRequest.findOne(
            buildClientRequisitionQuery(req, { _id: candidate.hiringRequestId })
        );

        if (!requisition) {
            return res.status(403).json({ message: 'Access denied' });
        }

        if (!requisition.clientId && req.clientId) {
            HiringRequest.updateOne({ _id: requisition._id }, { $set: { clientId: req.clientId } }).catch(() => {});
        }

        // Enforce candidate visibility in client portal
        if (!isCandidateVisibleToClient(candidate, requisition, req.clientUser)) {
            return res.status(403).json({ message: 'Candidate is not accessible in client portal' });
        }

        // Enforce client decision permission toggle
        if (requisition.clientVisibility?.allowClientDecision === false) {
            return res.status(403).json({ message: 'Client decisions are disabled for this requisition' });
        }

        // Enforce allowedDecisionActions on requisition
        const allowedActions = Array.isArray(requisition.clientVisibility?.allowedDecisionActions) && requisition.clientVisibility.allowedDecisionActions.length > 0
            ? requisition.clientVisibility.allowedDecisionActions
            : ['Shortlist', 'Reject', 'Hold'];

        const actionNorm = (val) => {
            const v = String(val || '').toLowerCase().trim();
            if (v.startsWith('shortlist')) return 'shortlist';
            if (v.startsWith('select')) return 'select';
            if (v.startsWith('reject')) return 'reject';
            if (v.includes('hold')) return 'hold';
            return v;
        };

        const isAllowed = allowedActions.some(a => actionNorm(a) === actionNorm(decision));
        if (!isAllowed) {
            return res.status(400).json({
                message: `Decision '${decision}' is not permitted for this requisition. Allowed actions: ${allowedActions.join(', ')}`
            });
        }

        candidate.phase2Decision = decision;
        if (notes) {
            candidate.phase2InterviewerFeedback = notes.trim();
        }

        await candidate.save();

        return res.json({
            message: `Decision '${decision}' recorded successfully`,
            candidateId: candidate._id,
            phase2Decision: candidate.phase2Decision
        });
    } catch (error) {
        console.error('Client submitClientDecision error:', error);
        return res.status(500).json({ message: 'Failed to submit decision', error: error.message });
    }
};

/**
 * GET /api/client-portal/dashboard
 * Aggregated KPIs for the client portal.
 */
exports.getDashboard = async (req, res) => {
    try {
        const requisitions = await HiringRequest.find(
            buildClientRequisitionQuery(req, {
                status: { $nin: ['Draft', 'Rejected'] }
            })
        ).select('_id status clientVisibility').lean();

        const reqIds = requisitions.map(r => r._id);

        const candidates = await Candidate.find({
            hiringRequestId: { $in: reqIds },
            companyId: req.companyId,
            isDeleted: false
        }).select('_id hiringRequestId status phase2Decision interviewRounds hiddenFromClient profileShared currentPhaseOrder').lean();

        const reqMap = new Map(requisitions.map(r => [String(r._id), r]));
        const visibleCandidates = candidates.filter(c => {
            const r = reqMap.get(String(c.hiringRequestId));
            return isCandidateVisibleToClient(c, r, req.clientUser);
        });

        let upcomingInterviews = 0;
        const now = new Date();

        visibleCandidates.forEach(c => {
            (c.interviewRounds || []).forEach(round => {
                if (round.scheduledDate && new Date(round.scheduledDate) >= now && round.status === 'Scheduled') {
                    upcomingInterviews++;
                }
            });
        });

        return res.json({
            activeRequisitions: requisitions.filter(r => r.status === 'Approved').length,
            totalVisibleCandidates: visibleCandidates.length,
            shortlistedCandidates: visibleCandidates.filter(c => c.phase2Decision === 'Shortlisted').length,
            upcomingInterviews
        });
    } catch (error) {
        console.error('Client getDashboard error:', error);
        return res.status(500).json({ message: 'Failed to fetch dashboard metrics', error: error.message });
    }
};

/**
 * PATCH /api/client-portal/candidates/:id/rounds/:roundId/schedule
 * Propose or confirm an interview slot from the client side.
 */
exports.scheduleRound = async (req, res) => {
    try {
        const { id, roundId } = req.params;
        const { scheduledDate, meetingLink, meetingProvider } = req.body;

        if (!scheduledDate) {
            return res.status(400).json({ message: 'Scheduled date is required' });
        }

        if (!mongoose.Types.ObjectId.isValid(id)) {
            return res.status(404).json({ message: 'Candidate not found' });
        }

        const candidate = await Candidate.findOne({
            _id: id,
            companyId: req.companyId,
            isDeleted: false
        });

        if (!candidate) {
            return res.status(404).json({ message: 'Candidate not found' });
        }

        const requisition = await HiringRequest.findOne(
            buildClientRequisitionQuery(req, { _id: candidate.hiringRequestId })
        );

        if (!requisition) {
            return res.status(403).json({ message: 'Access denied' });
        }

        if (!requisition.clientId && req.clientId) {
            HiringRequest.updateOne({ _id: requisition._id }, { $set: { clientId: req.clientId } }).catch(() => {});
        }

        // Enforce candidate visibility in client portal
        if (!isCandidateVisibleToClient(candidate, requisition, req.clientUser)) {
            return res.status(403).json({ message: 'Candidate is not accessible in client portal' });
        }

        // Check if scheduling is allowed on this requisition
        if (requisition.clientVisibility?.allowClientScheduling !== true) {
            return res.status(403).json({ message: 'Client interview scheduling is not enabled for this requisition' });
        }

        const round = (candidate.interviewRounds || []).id(roundId);
        if (!round) {
            return res.status(404).json({ message: 'Interview round not found' });
        }

        const isClientAdmin = req.clientUser.role === 'ClientAdmin';
        const isAssigned = Array.isArray(round.assignedClientUsers) &&
            round.assignedClientUsers.some(uid => String(uid?._id || uid) === String(req.clientUser._id));

        if (!isClientAdmin && !isAssigned) {
            return res.status(403).json({ message: 'You are not assigned to schedule this interview round' });
        }

        round.scheduledDate = new Date(scheduledDate);
        round.status = 'Scheduled';
        if (meetingLink !== undefined) round.meetingLink = String(meetingLink).trim();
        if (meetingProvider !== undefined) round.meetingProvider = meetingProvider;

        await candidate.save();

        return res.json({
            message: 'Interview round scheduled successfully',
            round
        });
    } catch (error) {
        console.error('Client scheduleRound error:', error);
        return res.status(500).json({ message: 'Failed to schedule interview round', error: error.message });
    }
};

/**
 * GET /api/client-portal/team
 * List all users belonging to this client organization.
 */
exports.getTeam = async (req, res) => {
    try {
        const users = await ClientUser.find({
            clientId: req.clientId,
            companyId: req.companyId,
            isDeleted: false
        })
            .select('-password -resetPasswordToken -resetPasswordExpires')
            .sort({ createdAt: -1 })
            .lean();

        return res.json(users);
    } catch (error) {
        console.error('Client getTeam error:', error);
        return res.status(500).json({ message: 'Failed to fetch team members', error: error.message });
    }
};

/**
 * POST /api/client-portal/team/invite
 * Invite a new member to the client team (ClientAdmin only).
 */
exports.inviteTeamMember = async (req, res) => {
    try {
        if (req.clientUser.role !== 'ClientAdmin') {
            return res.status(403).json({ message: 'Only Client Administrators can invite team members' });
        }

        const { firstName, lastName, email, role, phone } = req.body;
        if (!firstName || !email) {
            return res.status(400).json({ message: 'First name and email are required' });
        }

        const normalizedEmail = String(email).trim().toLowerCase();
        const validRoles = ['ClientAdmin', 'ClientInterviewer', 'ClientViewer'];
        const selectedRole = validRoles.includes(role) ? role : 'ClientInterviewer';

        const existing = await ClientUser.findOne({
            companyId: req.companyId,
            clientId: req.clientId,
            email: normalizedEmail,
            isDeleted: false
        });

        if (existing) {
            return res.status(409).json({ message: 'A team member with this email already exists' });
        }

        const inviteToken = crypto.randomBytes(32).toString('hex');
        const inviteExpires = new Date(Date.now() + 7 * 86400 * 1000); // 7 days

        const newUser = await ClientUser.create({
            clientId: req.clientId,
            companyId: req.companyId,
            firstName: firstName.trim(),
            lastName: (lastName || '').trim(),
            email: normalizedEmail,
            phone: (phone || '').trim(),
            role: selectedRole,
            status: 'Invited',
            inviteToken,
            inviteExpires
        });

        const userObj = newUser.toObject();
        delete userObj.password;

        return res.status(201).json({
            message: 'Team member invited successfully',
            user: userObj,
            inviteToken
        });
    } catch (error) {
        console.error('Client inviteTeamMember error:', error);
        return res.status(500).json({ message: 'Failed to invite team member', error: error.message });
    }
};

/**
 * PATCH /api/client-portal/team/:userId
 * Update role or status of a team member (ClientAdmin only).
 */
exports.updateTeamMember = async (req, res) => {
    try {
        if (req.clientUser.role !== 'ClientAdmin') {
            return res.status(403).json({ message: 'Only Client Administrators can manage team members' });
        }

        const { userId } = req.params;
        const { role, status, phone } = req.body;

        const targetUser = await ClientUser.findOne({
            _id: userId,
            clientId: req.clientId,
            companyId: req.companyId,
            isDeleted: false
        });

        if (!targetUser) {
            return res.status(404).json({ message: 'Team member not found' });
        }

        // Prevent self-demotion or self-suspension if you are the logged in admin
        if (String(targetUser._id) === String(req.clientUser._id)) {
            if (role && role !== 'ClientAdmin') {
                return res.status(400).json({ message: 'You cannot remove your own ClientAdmin role' });
            }
            if (status && status !== 'Active') {
                return res.status(400).json({ message: 'You cannot suspend your own account' });
            }
        }

        if (role && ['ClientAdmin', 'ClientInterviewer', 'ClientViewer'].includes(role)) {
            targetUser.role = role;
        }
        if (status && ['Active', 'Suspended'].includes(status)) {
            targetUser.status = status;
        }
        if (phone !== undefined) {
            targetUser.phone = String(phone).trim();
        }

        await targetUser.save();

        const userObj = targetUser.toObject();
        delete userObj.password;

        return res.json({
            message: 'Team member updated successfully',
            user: userObj
        });
    } catch (error) {
        console.error('Client updateTeamMember error:', error);
        return res.status(500).json({ message: 'Failed to update team member', error: error.message });
    }
};

/**
 * DELETE /api/client-portal/team/:userId
 * Remove a team member (ClientAdmin only).
 */
exports.removeTeamMember = async (req, res) => {
    try {
        if (req.clientUser.role !== 'ClientAdmin') {
            return res.status(403).json({ message: 'Only Client Administrators can remove team members' });
        }

        const { userId } = req.params;
        if (String(userId) === String(req.clientUser._id)) {
            return res.status(400).json({ message: 'You cannot remove yourself' });
        }

        const targetUser = await ClientUser.findOne({
            _id: userId,
            clientId: req.clientId,
            companyId: req.companyId,
            isDeleted: false
        });

        if (!targetUser) {
            return res.status(404).json({ message: 'Team member not found' });
        }

        targetUser.isDeleted = true;
        targetUser.deletedAt = new Date();
        await targetUser.save();

        return res.json({ message: 'Team member removed successfully' });
    } catch (error) {
        console.error('Client removeTeamMember error:', error);
        return res.status(500).json({ message: 'Failed to remove team member', error: error.message });
    }
};

/**
 * POST /api/client-portal/requisitions/:id/panel
 * Add a client user to the requisition's interview panel (ClientAdmin only).
 */
exports.addPanelMember = async (req, res) => {
    try {
        if (req.clientUser.role !== 'ClientAdmin') {
            return res.status(403).json({ message: 'Only Client Administrators can configure the interview panel' });
        }

        const { id } = req.params;
        const { clientUserId, role } = req.body;

        if (!clientUserId) {
            return res.status(400).json({ message: 'clientUserId is required' });
        }

        if (!mongoose.Types.ObjectId.isValid(id) || !mongoose.Types.ObjectId.isValid(clientUserId)) {
            return res.status(404).json({ message: 'Invalid ID provided' });
        }

        // Validate client user belongs to same client
        const clientUser = await ClientUser.findOne({
            _id: clientUserId,
            clientId: req.clientId,
            companyId: req.companyId,
            isDeleted: false
        });

        if (!clientUser) {
            return res.status(404).json({ message: 'Client user not found in your organization' });
        }

        const requisition = await HiringRequest.findOne(
            buildClientRequisitionQuery(req, { _id: id })
        );

        if (!requisition) {
            return res.status(404).json({ message: 'Requisition not found' });
        }

        if (!requisition.clientId && req.clientId) {
            HiringRequest.updateOne({ _id: requisition._id }, { $set: { clientId: req.clientId } }).catch(() => {});
        }

        if (!requisition.ownership) requisition.ownership = {};
        if (!Array.isArray(requisition.ownership.clientInterviewPanel)) {
            requisition.ownership.clientInterviewPanel = [];
        }

        const alreadyExists = requisition.ownership.clientInterviewPanel.some(
            p => String(p.clientUserId) === String(clientUserId)
        );

        if (alreadyExists) {
            return res.status(409).json({ message: 'User is already on the client interview panel' });
        }

        requisition.ownership.clientInterviewPanel.push({
            clientUserId,
            role: role === 'Approver' ? 'Approver' : 'Interviewer',
            addedAt: new Date()
        });

        await requisition.save();

        return res.json({
            message: 'Interviewer added to panel successfully',
            panel: requisition.ownership.clientInterviewPanel
        });
    } catch (error) {
        console.error('Client addPanelMember error:', error);
        return res.status(500).json({ message: 'Failed to add panel member', error: error.message });
    }
};

/**
 * DELETE /api/client-portal/requisitions/:id/panel/:clientUserId
 * Remove a client user from the requisition's interview panel (ClientAdmin only).
 */
exports.removePanelMember = async (req, res) => {
    try {
        if (req.clientUser.role !== 'ClientAdmin') {
            return res.status(403).json({ message: 'Only Client Administrators can configure the interview panel' });
        }

        const { id, clientUserId } = req.params;

        if (!mongoose.Types.ObjectId.isValid(id)) {
            return res.status(404).json({ message: 'Requisition not found' });
        }

        const requisition = await HiringRequest.findOne(
            buildClientRequisitionQuery(req, { _id: id })
        );

        if (!requisition) {
            return res.status(404).json({ message: 'Requisition not found' });
        }

        if (!requisition.clientId && req.clientId) {
            HiringRequest.updateOne({ _id: requisition._id }, { $set: { clientId: req.clientId } }).catch(() => {});
        }

        if (requisition.ownership?.clientInterviewPanel) {
            requisition.ownership.clientInterviewPanel = requisition.ownership.clientInterviewPanel.filter(
                p => String(p.clientUserId) !== String(clientUserId)
            );
            await requisition.save();
        }

        return res.json({
            message: 'Interviewer removed from panel successfully',
            panel: requisition.ownership?.clientInterviewPanel || []
        });
    } catch (error) {
        console.error('Client removePanelMember error:', error);
        return res.status(500).json({ message: 'Failed to remove panel member', error: error.message });
    }
};
