const HelpdeskQuery = require('./helpdeskQuery.model');
const QueryType = require('./queryType.model');
const User = require('../../modules/user/user.model');
const Role = require('../../modules/user/role.model');
const Company = require('../company/company.model');
const NotificationService = require('../../services/notificationService');
const { calculateWorkHours } = require('./helpdesk.utils');

const setPrivateCache = (res, maxAgeSeconds = 30) => {
    res.set('Cache-Control', `private, max-age=${maxAgeSeconds}, stale-while-revalidate=${maxAgeSeconds}`);
};

const isAdminUser = (user) =>
    user.roles.some(r => ['Admin', 'System'].includes(r.name || r) || r.isSystem === true);

const buildRequestError = (message, statusCode = 400) => {
    const error = new Error(message);
    error.statusCode = statusCode;
    return error;
};

const validateQueryTypeAssignments = async ({
    companyId,
    assignedRole,
    assignedPerson,
    enableEscalation,
    escalationRole,
    escalationPerson,
    escalationLevels = []
}) => {
    if (!assignedPerson) {
        throw buildRequestError('Assigned responsible person is required.');
    }

    const roleIdsToFetch = new Set();
    const userIdsToFetch = new Set();

    if (assignedRole) roleIdsToFetch.add(assignedRole.toString());
    if (assignedPerson) userIdsToFetch.add(assignedPerson.toString());
    if (escalationRole) roleIdsToFetch.add(escalationRole.toString());
    if (escalationPerson) userIdsToFetch.add(escalationPerson.toString());

    if (enableEscalation && Array.isArray(escalationLevels) && escalationLevels.length > 0) {
        escalationLevels.forEach((level, idx) => {
            if (!level.escalationPerson) {
                throw buildRequestError(`Escalation Level ${level.level || idx + 1} requires a designated responsible person.`);
            }
            if (!level.escalationDays || Number(level.escalationDays) < 1) {
                throw buildRequestError(`Escalation Level ${level.level || idx + 1} requires a valid SLA threshold (at least 1 day).`);
            }
            if (level.escalationRole) roleIdsToFetch.add(level.escalationRole.toString());
            if (level.escalationPerson) userIdsToFetch.add(level.escalationPerson.toString());
        });

        // Ensure escalationDays are strictly increasing
        for (let i = 1; i < escalationLevels.length; i++) {
            if (Number(escalationLevels[i].escalationDays) <= Number(escalationLevels[i - 1].escalationDays)) {
                throw buildRequestError(`Escalation Level ${i + 1} SLA days (${escalationLevels[i].escalationDays}d) must be greater than Level ${i} SLA days (${escalationLevels[i - 1].escalationDays}d).`);
            }
        }
    }

    const [roles, users] = await Promise.all([
        Role.find({ _id: { $in: Array.from(roleIdsToFetch) }, companyId, isActive: true }).select('_id name').lean(),
        User.find({ _id: { $in: Array.from(userIdsToFetch) }, companyId, isActive: true }).select('_id roles').lean()
    ]);

    const roleMap = new Map(roles.map(r => [r._id.toString(), r]));
    const userMap = new Map(users.map(u => [u._id.toString(), u]));

    // Validate assigned person
    const assignedPersonDoc = userMap.get(assignedPerson.toString());
    if (!assignedPersonDoc) {
        throw buildRequestError('Assigned responsible person must belong to this workspace and be active.');
    }
    if (assignedRole) {
        const assignedRoleDoc = roleMap.get(assignedRole.toString());
        if (!assignedRoleDoc) {
            throw buildRequestError('Assigned role must belong to this workspace.');
        }
        const hasAssignedRole = (assignedPersonDoc.roles || []).some(rId => rId?.toString() === assignedRoleDoc._id.toString());
        if (!hasAssignedRole) {
            throw buildRequestError('Assigned responsible person must have the selected assigned role.');
        }
    }

    // Validate escalation levels if enabled
    if (enableEscalation && Array.isArray(escalationLevels) && escalationLevels.length > 0) {
        for (let idx = 0; idx < escalationLevels.length; idx++) {
            const level = escalationLevels[idx];
            const escPersonId = (level.escalationPerson?._id || level.escalationPerson).toString();
            const escPersonDoc = userMap.get(escPersonId);
            if (!escPersonDoc) {
                throw buildRequestError(`Escalation person for Level ${level.level || idx + 1} must belong to this workspace and be active.`);
            }
            if (level.escalationRole) {
                const escRoleId = (level.escalationRole?._id || level.escalationRole).toString();
                const escRoleDoc = roleMap.get(escRoleId);
                if (!escRoleDoc) {
                    throw buildRequestError(`Escalation role for Level ${level.level || idx + 1} must belong to this workspace.`);
                }
                const hasRole = (escPersonDoc.roles || []).some(rId => rId?.toString() === escRoleDoc._id.toString());
                if (!hasRole) {
                    throw buildRequestError(`Escalation person for Level ${level.level || idx + 1} must have the selected escalation role.`);
                }
            }
        }
    } else if (enableEscalation && escalationPerson) {
        // Fallback single-level check
        const escalationPersonDoc = userMap.get(escalationPerson.toString());
        if (!escalationPersonDoc) {
            throw buildRequestError('Escalation person must belong to this workspace and be active.');
        }
        if (escalationRole) {
            const escalationRoleDoc = roleMap.get(escalationRole.toString());
            if (!escalationRoleDoc) {
                throw buildRequestError('Escalation role must belong to this workspace.');
            }
            const hasEscalationRole = (escalationPersonDoc.roles || []).some(rId => rId?.toString() === escalationRoleDoc._id.toString());
            if (!hasEscalationRole) {
                throw buildRequestError('Escalation person must have the selected escalation role.');
            }
        }
    }
};


// === QUERY TYPE MANAGEMENT ===

exports.getQueryTypes = async (req, res) => {
    try {
        const types = await QueryType.find({ companyId: req.companyId })
            .populate('assignedRole', 'name')
            .populate('assignedPerson', 'firstName lastName email')
            .populate('escalationRole', 'name')
            .populate('escalationPerson', 'firstName lastName email')
            .populate('escalationLevels.escalationRole', 'name')
            .populate('escalationLevels.escalationPerson', 'firstName lastName email')
            .sort({ name: 1 })
            .lean();
        res.status(200).json({ success: true, data: types });
    } catch (error) {
        console.error('Error fetching query types:', error);
        res.status(500).json({ success: false, message: 'Server Error' });
    }
};

exports.addQueryType = async (req, res) => {
    try {
        if (!isAdminUser(req.user)) return res.status(403).json({ success: false, message: 'Admins only' });

        const {
            name, assignedRole, assignedPerson,
            enableEscalation, escalationDays, escalationRole, escalationPerson,
            escalationLevels,
            autoResponse
        } = req.body;

        await validateQueryTypeAssignments({
            companyId: req.companyId,
            assignedRole,
            assignedPerson,
            enableEscalation,
            escalationRole,
            escalationPerson,
            escalationLevels
        });

        let normalizedLevels = [];
        if (enableEscalation && Array.isArray(escalationLevels) && escalationLevels.length > 0) {
            normalizedLevels = escalationLevels.map((lvl, index) => ({
                level: index + 1,
                escalationDays: Number(lvl.escalationDays) || 2,
                escalationRole: lvl.escalationRole || null,
                escalationPerson: lvl.escalationPerson?._id || lvl.escalationPerson
            }));
        } else if (enableEscalation && escalationPerson) {
            normalizedLevels = [{
                level: 1,
                escalationDays: Number(escalationDays) || 2,
                escalationRole: escalationRole || null,
                escalationPerson: escalationPerson?._id || escalationPerson
            }];
        }

        const primaryEscalation = normalizedLevels[0] || null;

        const newType = new QueryType({
            name,
            assignedRole: assignedRole || null,
            assignedPerson,
            enableEscalation: !!enableEscalation,
            escalationDays: primaryEscalation ? primaryEscalation.escalationDays : (escalationDays || 2),
            escalationRole: primaryEscalation ? primaryEscalation.escalationRole : (escalationRole || null),
            escalationPerson: primaryEscalation ? primaryEscalation.escalationPerson : (escalationPerson || null),
            escalationLevels: normalizedLevels,
            autoResponse: autoResponse || "",
            companyId: req.companyId
        });
        await newType.save();

        res.status(201).json({ success: true, data: newType });
    } catch (error) {
        console.error('Error adding query type:', error);
        res.status(error.statusCode || 500).json({
            success: false,
            message: error.statusCode ? error.message : 'Server Error'
        });
    }
};

exports.updateQueryType = async (req, res) => {
    try {
        if (!isAdminUser(req.user)) return res.status(403).json({ success: false, message: 'Admins only' });

        const {
            name, assignedRole, assignedPerson, isActive,
            enableEscalation, escalationDays, escalationRole, escalationPerson,
            escalationLevels,
            autoResponse
        } = req.body;
        const type = await QueryType.findOne({ _id: req.params.id, companyId: req.companyId });

        if (!type) return res.status(404).json({ success: false, message: 'Type not found' });

        const effectiveEnableEscalation = enableEscalation !== undefined ? enableEscalation : type.enableEscalation;
        const effectiveEscalationLevels = escalationLevels !== undefined ? escalationLevels : type.escalationLevels;

        await validateQueryTypeAssignments({
            companyId: req.companyId,
            assignedRole: assignedRole !== undefined ? assignedRole : type.assignedRole,
            assignedPerson: assignedPerson || type.assignedPerson,
            enableEscalation: effectiveEnableEscalation,
            escalationRole: escalationRole !== undefined ? escalationRole : type.escalationRole,
            escalationPerson: escalationPerson !== undefined ? escalationPerson : type.escalationPerson,
            escalationLevels: effectiveEscalationLevels
        });

        if (name) type.name = name;
        if (assignedRole !== undefined) type.assignedRole = assignedRole ? assignedRole : null;
        if (assignedPerson) type.assignedPerson = assignedPerson;
        if (isActive !== undefined) type.isActive = isActive;
        if (enableEscalation !== undefined) type.enableEscalation = enableEscalation;

        if (escalationLevels !== undefined) {
            let normalizedLevels = [];
            if (type.enableEscalation && Array.isArray(escalationLevels) && escalationLevels.length > 0) {
                normalizedLevels = escalationLevels.map((lvl, index) => ({
                    level: index + 1,
                    escalationDays: Number(lvl.escalationDays) || 2,
                    escalationRole: lvl.escalationRole || null,
                    escalationPerson: lvl.escalationPerson?._id || lvl.escalationPerson
                }));
            }
            type.escalationLevels = normalizedLevels;

            if (normalizedLevels.length > 0) {
                type.escalationDays = normalizedLevels[0].escalationDays;
                type.escalationRole = normalizedLevels[0].escalationRole;
                type.escalationPerson = normalizedLevels[0].escalationPerson;
            } else if (!type.enableEscalation) {
                type.escalationDays = 2;
                type.escalationRole = null;
                type.escalationPerson = null;
            }
        } else {
            if (escalationDays !== undefined) type.escalationDays = escalationDays;
            if (escalationRole !== undefined) type.escalationRole = escalationRole ? escalationRole : null;
            if (escalationPerson !== undefined) type.escalationPerson = escalationPerson ? escalationPerson : null;
        }

        if (autoResponse !== undefined) type.autoResponse = autoResponse;

        await type.save();
        res.status(200).json({ success: true, data: type });
    } catch (error) {
        console.error('Error updating query type:', error);
        res.status(error.statusCode || 500).json({
            success: false,
            message: error.statusCode ? error.message : 'Server Error'
        });
    }
};

exports.deleteQueryType = async (req, res) => {
    try {
        if (!isAdminUser(req.user)) return res.status(403).json({ success: false, message: 'Admins only' });

        const queryType = await QueryType.findOne({ _id: req.params.id, companyId: req.companyId });
        if (!queryType) return res.status(404).json({ success: false, message: 'Type not found' });

        await queryType.softDelete(req.user._id);
        res.status(200).json({ success: true, message: 'Type moved to bin' });
    } catch (error) {
        console.error('Error deleting query type:', error);
        res.status(500).json({ success: false, message: 'Server Error' });
    }
};


// === TICKET MANAGEMENT ===

exports.createQuery = async (req, res) => {
    try {
        const { subject, description, queryTypeId, priority } = req.body;

        const qType = await QueryType.findOne({
            _id: queryTypeId,
            companyId: req.companyId
        }).populate('assignedPerson', 'firstName lastName');
        if (!qType || !qType.isActive) return res.status(400).json({ success: false, message: 'Invalid or inactive query type.' });

        const newQuery = new HelpdeskQuery({
            subject,
            description,
            queryType: qType._id,
            priority: priority || 'Medium',
            raisedBy: req.user._id,
            assignedTo: qType.assignedPerson?._id || qType.assignedPerson,
            status: 'New',
            companyId: req.companyId
        });

        if (qType.autoResponse && qType.autoResponse.trim()) {
            newQuery.comments.push({
                user: qType.assignedPerson?._id || qType.assignedPerson,
                text: qType.autoResponse.trim()
            });
        }

        await newQuery.save();

        // --- TARGETED NOTIFICATIONS ---
        const io = req.app.get('io');
        const assignedUserId = (qType.assignedPerson?._id || qType.assignedPerson)?.toString();
        const raiserUserId = req.user._id.toString();
        const notificationsData = [];

        // 1. Notify the Assigned Initial Resolver
        if (assignedUserId) {
            notificationsData.push({
                user: assignedUserId,
                companyId: req.companyId,
                preferenceKey: 'helpdesk_query_created',
                title: 'New Helpdesk Query Assigned',
                message: `A new ${priority || 'Medium'} priority query "${subject}" has been assigned to you.`,
                type: 'Alert',
                link: `/helpdesk/${newQuery._id}`,
                origin: req.headers?.origin || ''
            });
        }

        // 2. Notify the ticket raiser (Confirmation) if different from assigned person
        const autoNote = (qType.autoResponse && qType.autoResponse.trim())
            ? ` An initial response has been provided.`
            : '';

        if (raiserUserId !== assignedUserId) {
            notificationsData.push({
                user: raiserUserId,
                companyId: req.companyId,
                preferenceKey: 'helpdesk_query_created',
                title: 'Query Raised Successfully',
                message: `Your query "${subject}" has been submitted and is being reviewed.${autoNote}`,
                type: 'Info',
                link: `/helpdesk/${newQuery._id}`,
                origin: req.headers?.origin || ''
            });
        }

        if (notificationsData.length > 0) {
            await NotificationService.createManyNotifications(io, notificationsData);
        }

        // POPULATE FOR INSTANT UI UPDATE
        const populatedQuery = await HelpdeskQuery.findById(newQuery._id)
            .populate('raisedBy', 'firstName lastName email profilePicture')
            .populate('assignedTo', 'firstName lastName email profilePicture')
            .populate('comments.user', 'firstName lastName roles')
            .populate('queryType', 'name autoResponse')
            .lean();

        res.status(201).json({
            success: true,
            data: populatedQuery,
            autoResponse: qType.autoResponse ? qType.autoResponse.trim() : ""
        });

    } catch (error) {
        console.error('Error creating query:', error);
        res.status(500).json({ success: false, message: 'Server Error' });
    }
};

exports.getMyQueries = async (req, res) => {
    try {
        // Caching disabled for real-time visibility consistency
        // setPrivateCache(res, 20);

        const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
        const limit = Math.max(parseInt(req.query.limit, 10) || 30, 1);
        const skip = (page - 1) * limit;

        const filter = { raisedBy: req.user._id, companyId: req.companyId };

        const [queries, total] = await Promise.all([
            HelpdeskQuery.find(filter)
                .populate('queryType', 'name')
                .populate('assignedTo', 'firstName lastName email')
                .sort({ createdAt: -1 })
                .skip(skip)
                .limit(limit)
                .lean(),
            HelpdeskQuery.countDocuments(filter)
        ]);

        res.status(200).json({
            success: true,
            data: queries,
            pagination: {
                page,
                limit,
                total,
                totalPages: Math.ceil(total / limit)
            }
        });
    } catch (error) {
        console.error('Error fetching queries:', error);
        res.status(500).json({ success: false, message: 'Server Error' });
    }
};

exports.getAssignedQueries = async (req, res) => {
    try {
        // Caching disabled for real-time visibility consistency
        // setPrivateCache(res, 20);

        const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
        const limit = Math.max(parseInt(req.query.limit, 10) || 30, 1);
        const skip = (page - 1) * limit;

        const filter = {
            companyId: req.companyId,
            $or: [
                { assignedTo: req.user._id },
                { originalAssignee: req.user._id }
            ]
        };

        const [queries, total] = await Promise.all([
            HelpdeskQuery.find(filter)
                .populate('raisedBy', 'firstName lastName email')
                .populate('queryType', 'name')
                .sort({ createdAt: -1 })
                .skip(skip)
                .limit(limit)
                .lean(),
            HelpdeskQuery.countDocuments(filter)
        ]);

        res.status(200).json({
            success: true,
            data: queries,
            pagination: {
                page,
                limit,
                total,
                totalPages: Math.ceil(total / limit)
            }
        });
    } catch (error) {
        console.error('Error fetching assigned queries:', error);
        res.status(500).json({ success: false, message: 'Server Error' });
    }
};

exports.getAllQueries = async (req, res) => {
    try {
        // Caching disabled for real-time visibility consistency
        // setPrivateCache(res, 20);
        const isAdmin = req.user.roles.some(r => ['Admin', 'System'].includes(r.name || r) || r.isSystem === true);

        console.log(`[HelpDesk Debug] User: ${req.user.email}, Roles: ${JSON.stringify(req.user.roles.map(r => r.name || r))}, IsAdmin: ${isAdmin}, CompanyId: ${req.companyId}`);

        if (!isAdmin) return res.status(403).json({ success: false, message: 'Admins only' });

        const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
        const limit = Math.max(parseInt(req.query.limit, 10) || 30, 1);
        const skip = (page - 1) * limit;

        const filter = { companyId: req.companyId };

        const [queries, total] = await Promise.all([
            HelpdeskQuery.find(filter)
                .populate('raisedBy', 'firstName lastName email')
                .populate('assignedTo', 'firstName lastName email')
                .populate('queryType', 'name')
                .sort({ createdAt: -1 })
                .skip(skip)
                .limit(limit)
                .lean(),
            HelpdeskQuery.countDocuments(filter)
        ]);

        res.status(200).json({
            success: true,
            data: queries,
            pagination: {
                page,
                limit,
                total,
                totalPages: Math.ceil(total / limit)
            }
        });
    } catch (error) {
        console.error('Error fetching all queries:', error);
        res.status(500).json({ success: false, message: 'Server Error' });
    }
};

exports.getEscalatedQueries = async (req, res) => {
    try {
        // Caching disabled for real-time visibility consistency
        // setPrivateCache(res, 20);
        const isAdmin = req.user.roles.some(r => ['Admin', 'System'].includes(r.name || r) || r.isSystem === true);
        if (!isAdmin) return res.status(403).json({ success: false, message: 'Admins only' });

        const queries = await HelpdeskQuery.find({ status: 'Escalated', companyId: req.companyId })
            .populate('raisedBy', 'firstName lastName email')
            .populate('assignedTo', 'firstName lastName email')
            .populate('queryType', 'name')
            .sort({ escalatedAt: -1 })
            .lean();

        res.status(200).json({ success: true, data: queries });
    } catch (error) {
        console.error('Error fetching escalated queries:', error);
        res.status(500).json({ success: false, message: 'Server Error' });
    }
};

exports.getQueryById = async (req, res) => {
    try {
        const { id } = req.params;

        // Prevent CastError if someone goes to /helpdesk/new (which shouldn't happen anymore but just in case)
        if (!id.match(/^[0-9a-fA-F]{24}$/)) {
            return res.status(404).json({ success: false, message: 'Invalid Query ID format' });
        }

        const query = await HelpdeskQuery.findOne({ _id: id, companyId: req.companyId })
            .populate('raisedBy', 'firstName lastName email profilePicture')
            .populate('assignedTo', 'firstName lastName email profilePicture')
            .populate('originalAssignee', 'firstName lastName email profilePicture')
            .populate('escalationHistory.escalatedFrom', 'firstName lastName email')
            .populate('escalationHistory.escalatedTo', 'firstName lastName email')
            .populate('comments.user', 'firstName lastName roles')
            .populate({
                path: 'queryType',
                select: 'name autoResponse enableEscalation escalationDays escalationRole escalationPerson escalationLevels',
                populate: [
                    { path: 'assignedPerson', select: 'firstName lastName email' },
                    { path: 'escalationLevels.escalationRole', select: 'name' },
                    { path: 'escalationLevels.escalationPerson', select: 'firstName lastName email' }
                ]
            })
            .lean();

        if (!query) {
            return res.status(404).json({ success: false, message: 'Query not found' });
        }

        const isAdmin = isAdminUser(req.user);
        const isAssignee = query.assignedTo?._id?.toString() === req.user._id.toString() || query.assignedTo?.toString() === req.user._id.toString();
        const isOriginalAssignee = query.originalAssignee?._id?.toString() === req.user._id.toString() || query.originalAssignee?.toString() === req.user._id.toString();
        const isRaiser = query.raisedBy?._id?.toString() === req.user._id.toString() || query.raisedBy?.toString() === req.user._id.toString();

        if (!isAdmin && !isAssignee && !isOriginalAssignee && !isRaiser) {
            return res.status(403).json({ success: false, message: 'Unauthorized to view this query.' });
        }

        // Calculate work-hours elapsed
        const company = await Company.findById(query.companyId).lean();
        const weeklyOff = company?.settings?.attendance?.weeklyOff || ['Saturday', 'Sunday'];
        const workHoursElapsed = calculateWorkHours(query.createdAt, new Date(), weeklyOff);

        let resolvedWorkHoursElapsed = 0;
        if (query.status === 'Resolved' && query.resolvedAt) {
            resolvedWorkHoursElapsed = calculateWorkHours(query.resolvedAt, new Date(), weeklyOff);
        }

        const responseData = {
            ...query,
            workHoursElapsed,
            resolvedWorkHoursElapsed,
            canEscalate: isAdmin || isAssignee || (isRaiser && workHoursElapsed >= 48),
            canDirectlyClose: isAdmin || (isAssignee && query.status === 'Resolved' && resolvedWorkHoursElapsed >= 48)
        };

        res.status(200).json({ success: true, data: responseData });
    } catch (error) {
        console.error('Error fetching query:', error);
        res.status(500).json({ success: false, message: 'Server Error' });
    }
};

exports.updateQueryStatus = async (req, res) => {
    try {
        const { status } = req.body;
        const query = await HelpdeskQuery.findOne({ _id: req.params.id, companyId: req.companyId })
            .populate({
                path: 'queryType',
                populate: [
                    { path: 'escalationLevels.escalationPerson', select: '_id firstName lastName email' },
                    { path: 'escalationPerson', select: '_id firstName lastName email' }
                ]
            });

        if (!query) {
            return res.status(404).json({ success: false, message: 'Query not found' });
        }

        const originalStatus = query.status;

        const isAdmin = req.user.roles.some(r => ['Admin', 'System'].includes(r.name || r) || r.isSystem === true);
        const isAssignee = query.assignedTo?.toString() === req.user._id.toString();
        const isRaiser = query.raisedBy?.toString() === req.user._id.toString();

        // Security logic based on target status
        if (status === 'Closed') {
            // Only Admin or Assignee can close directly (e.g. if it was a mistake or duplicate)
            // Raiser can only close from a 'Resolved' state via specific flow (Confirmation)
            // NEW RULE: Query MUST be in 'Resolved' status before it can be closed.
            if (!isAdmin && !isAssignee && !isRaiser) {
                return res.status(403).json({ success: false, message: 'Unauthorized to close this query.' });
            }
            if (query.status !== 'Resolved' && !isAdmin) {
                return res.status(403).json({ success: false, message: 'Only resolved queries can be closed. Please mark as resolved first.' });
            }

            // If NOT raiser, must wait 48h after resolution
            if (!isRaiser && !isAdmin && query.status === 'Resolved') {
                const company = await Company.findById(query.companyId).lean();
                const weeklyOff = company?.settings?.attendance?.weeklyOff || ['Saturday', 'Sunday'];
                const resolvedHours = calculateWorkHours(query.resolvedAt, new Date(), weeklyOff);

                if (resolvedHours < 48) {
                    return res.status(403).json({ success: false, message: `Admins/Assignees can only close a resolved query after 48 work hours if the raiser doesn't confirm. Currently ${resolvedHours.toFixed(1)} work hours have passed since resolution.` });
                }
            }

            query.closedAt = Date.now();
        } else if (status === 'Resolved') {
            if (!isAdmin && !isAssignee) {
                return res.status(403).json({ success: false, message: 'Only the assignee or admin can mark a query as resolved.' });
            }
            // Transition to resolved
            query.resolvedAt = Date.now();
        } else if (status === 'In Progress' || status === 'Pending') {
            if (!isAdmin && !isAssignee && !(isRaiser && query.status === 'Resolved')) {
                return res.status(403).json({ success: false, message: 'Only assignee or admin can change status to ' + status });
            }
        } else if (status === 'Escalated') {
            // Permission check: Admin or Assignee can always escalate. Raiser can only escalate after 48h.
            const isManager = isAdmin || isAssignee;
            if (!isManager && !isRaiser) {
                return res.status(403).json({ success: false, message: 'Unauthorized to escalate this query.' });
            }

            if (isRaiser && !isAdmin) {
                const company = await Company.findById(query.companyId).lean();
                const weeklyOff = company?.settings?.attendance?.weeklyOff || ['Saturday', 'Sunday'];
                const workHoursElapsed = calculateWorkHours(query.createdAt, new Date(), weeklyOff);

                if (workHoursElapsed < 48) {
                    return res.status(403).json({ success: false, message: `You can only escalate your query after 48 work hours. Currently ${workHoursElapsed.toFixed(1)} work hours have passed (excluding weekends).` });
                }
            }
            if (!query.escalatedAt) query.escalatedAt = Date.now();

            // Multi-level manual reassignment logic
            const qType = query.queryType;
            if (qType && qType.enableEscalation) {
                let levels = [];
                if (Array.isArray(qType.escalationLevels) && qType.escalationLevels.length > 0) {
                    levels = [...qType.escalationLevels].sort((a, b) => a.level - b.level);
                } else if (qType.escalationPerson) {
                    levels = [{
                        level: 1,
                        escalationDays: qType.escalationDays || 2,
                        escalationPerson: qType.escalationPerson
                    }];
                }

                const currentLevel = Number.isInteger(query.currentEscalationLevel) ? query.currentEscalationLevel : 0;
                let nextLevel = levels.find(l => l.level > currentLevel);

                // If already at or past highest level, remain at highest level
                if (!nextLevel && levels.length > 0) {
                    nextLevel = levels[levels.length - 1];
                }

                if (nextLevel && nextLevel.escalationPerson) {
                    const oldAssignee = query.assignedTo;
                    const newAssigneeDoc = nextLevel.escalationPerson;
                    const newAssignee = newAssigneeDoc?._id || newAssigneeDoc;
                    const newAssigneeName = newAssigneeDoc?.firstName
                        ? `${newAssigneeDoc.firstName} ${newAssigneeDoc.lastName || ''}`.trim()
                        : 'Designated Escalation Contact';
                    const nextLevelNum = nextLevel.level || 1;

                    if (!query.originalAssignee) {
                        query.originalAssignee = query.assignedTo;
                    }
                    query.currentEscalationLevel = nextLevelNum;
                    query.assignedTo = newAssignee;

                    if (!Array.isArray(query.escalationHistory)) {
                        query.escalationHistory = [];
                    }

                    query.escalationHistory.push({
                        level: nextLevelNum,
                        escalatedFrom: oldAssignee,
                        escalatedTo: newAssignee,
                        escalatedAt: Date.now(),
                        reason: req.body.reason || `Manually escalated to Level ${nextLevelNum}`,
                        triggeredBy: 'manual'
                    });

                    // Add comment
                    query.comments.push({
                        user: req.user._id,
                        text: `[SYSTEM] Manually escalated to Level ${nextLevelNum}. Ticket reassigned to ${newAssigneeName}.`,
                        createdAt: Date.now()
                    });

                    // Notify new assignee and ticket raiser
                    const io = req.app.get('io');
                    const manualEscalationNotifs = [];

                    if (newAssignee) {
                        manualEscalationNotifs.push({
                            user: newAssignee,
                            companyId: req.companyId,
                            preferenceKey: 'helpdesk_query_escalated',
                            title: `Escalated Query Assigned (Level ${nextLevelNum})`,
                            message: `An escalated query (Level ${nextLevelNum}) "${query.subject}" has been assigned to you.`,
                            type: 'Alert',
                            link: `/helpdesk/${query._id}`,
                            origin: req.headers?.origin || ''
                        });
                    }

                    if (query.raisedBy && query.raisedBy.toString() !== req.user._id.toString()) {
                        manualEscalationNotifs.push({
                            user: query.raisedBy,
                            companyId: req.companyId,
                            preferenceKey: 'helpdesk_query_escalated',
                            title: `Query Escalated (Level ${nextLevelNum})`,
                            message: `Your query "${query.subject}" has been escalated to Level ${nextLevelNum} (${newAssigneeName}).`,
                            type: 'Alert',
                            link: `/helpdesk/${query._id}`,
                            origin: req.headers?.origin || ''
                        });
                    }

                    if (manualEscalationNotifs.length > 0) {
                        await NotificationService.createManyNotifications(io, manualEscalationNotifs);
                    }
                }
            }
        } else {
            return res.status(400).json({ success: false, message: 'Invalid status transition: ' + status });
        }

        // SPECIAL TRANSITION: If query is 'Resolved' and user marks it as 'In Progress' (Reopen)
        if (query.status === 'Resolved' && status === 'In Progress') {
            if (!isRaiser && !isAdmin) {
                return res.status(403).json({ success: false, message: 'Only the raiser or admin can reopen a resolved query.' });
            }
            const { feedback } = req.body;
            if (!feedback) {
                return res.status(400).json({ success: false, message: 'Feedback is required to reopen a query.' });
            }

            // Add feedback as a comment
            query.comments.push({
                user: req.user._id,
                text: `[REOPENED] ${feedback}`
            });
        }

        // SPECIAL TRANSITION: If query is 'Resolved' and raiser clicks 'Yes' (Confirm Resolution)
        if (query.status === 'Resolved' && status === 'Closed') {
            if (!isRaiser && !isAdmin && !isAssignee) {
                return res.status(403).json({ success: false, message: 'Unauthorized to confirm resolution.' });
            }
            query.closedAt = Date.now();
        }

        query.status = status;
        await query.save();

        // Notify all relevant parties about the status change
        const io = req.app.get('io');
        const actorId = req.user._id.toString();

        let notificationTitle = 'Query Status Updated';
        let notificationMessage = `The query "${query.subject}" is now ${status}.`;

        if (status === 'Resolved') {
            notificationTitle = 'Query Resolved';
            notificationMessage = `Your query "${query.subject}" has been marked as Resolved. Please confirm if it's fixed.`;
        } else if (status === 'In Progress' && originalStatus === 'Resolved') {
            notificationTitle = 'Query Reopened';
            notificationMessage = `The query "${query.subject}" has been reopened by the raiser.`;
        } else if (status === 'In Progress') {
            notificationTitle = 'Query In Progress';
            notificationMessage = `The query "${query.subject}" is now being worked on.`;
        } else if (status === 'Closed') {
            notificationTitle = 'Query Closed';
            notificationMessage = `The query "${query.subject}" has been officially closed.`;
        }

        // Collect all parties that should be notified (raiser + assignee), excluding the actor
        const statusNotifyTargets = new Set();
        if (query.raisedBy) statusNotifyTargets.add(query.raisedBy.toString());
        if (query.assignedTo) statusNotifyTargets.add(query.assignedTo.toString());
        statusNotifyTargets.delete(actorId);

        const statusNotifications = Array.from(statusNotifyTargets).map(userId => ({
            user: userId,
            companyId: req.companyId,
            preferenceKey: 'helpdesk_query_status_updated',
            title: notificationTitle,
            message: notificationMessage,
            type: 'Info',
            link: `/helpdesk/${query._id}`,
            origin: req.headers?.origin || ''
        }));

        if (statusNotifications.length > 0) {
            await NotificationService.createManyNotifications(io, statusNotifications);
        }

        res.status(200).json({ success: true, data: query });
    } catch (error) {
        console.error('Error updating query status:', error);
        res.status(500).json({ success: false, message: 'Server Error' });
    }
};

exports.addComment = async (req, res) => {
    try {
        const { text } = req.body;

        if (!text) return res.status(400).json({ success: false, message: 'Comment text is required' });

        const query = await HelpdeskQuery.findOne({ _id: req.params.id, companyId: req.companyId });

        if (!query) return res.status(404).json({ success: false, message: 'Query not found' });

        const isAdmin = req.user.roles.some(r => ['Admin', 'System'].includes(r.name || r) || r.isSystem === true);
        const isAssignee = query.assignedTo?.toString() === req.user._id.toString();
        const isOriginalAssignee = query.originalAssignee?.toString() === req.user._id.toString();
        const isRaiser = query.raisedBy?.toString() === req.user._id.toString();

        if (!isAdmin && !isAssignee && !isOriginalAssignee && !isRaiser) {
            return res.status(403).json({ success: false, message: 'Unauthorized to comment on this query.' });
        }

        // Status Transition Logic
        if (query.status === 'New' && (isAssignee || isAdmin)) {
            query.status = 'In Progress';
        } else if (query.status === 'Pending' && isRaiser) {
            // Raiser replied to a pending request
            query.status = 'In Progress';
        }

        query.comments.push({
            user: req.user._id,
            text
        });

        await query.save();
        await query.populate('comments.user', 'firstName lastName roles');

        // Socket.IO Emission
        const io = req.app.get('io');
        if (io) {
            io.to(query._id.toString()).emit('new_comment', query.comments);
        }

        // Notify all relevant parties (raiser, assignee, original assignee) except the commenter
        const commentNotifyTargets = new Set();
        if (query.raisedBy) commentNotifyTargets.add(query.raisedBy.toString());
        if (query.assignedTo) commentNotifyTargets.add(query.assignedTo.toString());
        if (query.originalAssignee) commentNotifyTargets.add(query.originalAssignee.toString());
        commentNotifyTargets.delete(req.user._id.toString());

        const commentNotifications = Array.from(commentNotifyTargets).map(userId => ({
            user: userId,
            companyId: req.companyId,
            preferenceKey: 'helpdesk_query_comment_added',
            title: 'New Comment on Query',
            message: `${req.user.firstName} commented on "${query.subject}"`,
            type: 'Info',
            link: `/helpdesk/${query._id}`,
            origin: req.headers?.origin || ''
        }));

        if (commentNotifications.length > 0) {
            await NotificationService.createManyNotifications(io, commentNotifications);
        }

        res.status(200).json({ success: true, data: query });
    } catch (error) {
        console.error('Error adding comment:', error);
        res.status(500).json({ success: false, message: 'Server Error' });
    }
};

exports.getHelpdeskAnalytics = async (req, res) => {
    try {
        const mongoose = require('mongoose');
        const companyId = req.companyId;

        const isAdmin = req.user.roles.some(r => ['Admin', 'System'].includes(r.name || r) || r.isSystem === true);
        const isResolverRole = req.user.roles.some(r => ['HR', 'Supervisor', 'Admin', 'System'].includes(r.name || r));
        if (!isAdmin && !isResolverRole) {
            return res.status(403).json({ success: false, message: 'Admins or resolvers only' });
        }

        let queryFilter = { companyId };
        let queryTypeFilter = { companyId };
        const matchQuery = { companyId: new mongoose.Types.ObjectId(companyId) };

        if (!isAdmin) {
            // Find query types assigned to the user
            const assignedQueryTypes = await QueryType.find({
                companyId,
                $or: [
                    { assignedPerson: req.user._id },
                    { escalationPerson: req.user._id }
                ]
            }).select('_id');

            const queryTypeIds = assignedQueryTypes.map(qt => qt._id);
            queryFilter.queryType = { $in: queryTypeIds };
            queryTypeFilter._id = { $in: queryTypeIds };
            matchQuery.queryType = { $in: queryTypeIds.map(id => new mongoose.Types.ObjectId(id)) };
        }

        const [
            totalQueries,
            totalQueryTypes,
            statusBreakdown,
            priorityBreakdown,
            queryTypeBreakdown,
            trendBreakdown
        ] = await Promise.all([
            HelpdeskQuery.countDocuments(queryFilter),
            QueryType.countDocuments(queryTypeFilter),

            HelpdeskQuery.aggregate([
                { $match: matchQuery },
                { $group: { _id: "$status", count: { $sum: 1 } } }
            ]),

            HelpdeskQuery.aggregate([
                { $match: matchQuery },
                { $group: { _id: "$priority", count: { $sum: 1 } } }
            ]),

            HelpdeskQuery.aggregate([
                { $match: matchQuery },
                { $group: { _id: "$queryType", count: { $sum: 1 } } },
                {
                    $lookup: {
                        from: "querytypes",
                        localField: "_id",
                        foreignField: "_id",
                        as: "queryTypeInfo"
                    }
                },
                { $unwind: { path: "$queryTypeInfo", preserveNullAndEmptyArrays: true } },
                {
                    $project: {
                        name: { $ifNull: ["$queryTypeInfo.name", "Unknown Type"] },
                        count: 1
                    }
                }
            ]),

            HelpdeskQuery.aggregate([
                {
                    $match: {
                        ...matchQuery,
                        createdAt: { $gte: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) }
                    }
                },
                {
                    $group: {
                        _id: { $dateToString: { format: "%Y-%m-%d", date: "$createdAt", timezone: "Asia/Kolkata" } },
                        count: { $sum: 1 }
                    }
                },
                { $sort: { _id: 1 } }
            ])
        ]);

        const statusSummary = {
            New: 0,
            "In Progress": 0,
            Resolved: 0,
            Closed: 0,
            Escalated: 0,
            Pending: 0
        };
        statusBreakdown.forEach(item => {
            if (item._id in statusSummary) {
                statusSummary[item._id] = item.count;
            }
        });

        const prioritySummary = {
            Low: 0,
            Medium: 0,
            High: 0,
            Urgent: 0
        };
        priorityBreakdown.forEach(item => {
            if (item._id in prioritySummary) {
                prioritySummary[item._id] = item.count;
            }
        });

        res.status(200).json({
            success: true,
            data: {
                totalQueries,
                totalQueryTypes,
                escalatedQueriesCount: statusSummary.Escalated || 0,
                statusSummary,
                prioritySummary,
                queryTypeBreakdown,
                trendBreakdown
            }
        });
    } catch (error) {
        console.error('Error fetching helpdesk analytics:', error);
        res.status(500).json({ success: false, message: 'Server Error' });
    }
};
