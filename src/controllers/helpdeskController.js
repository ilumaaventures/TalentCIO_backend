const HelpdeskQuery = require('../models/HelpdeskQuery');
const QueryType = require('../models/QueryType');
const User = require('../models/User');
const Role = require('../models/Role');
const Company = require('../models/Company');
const NotificationService = require('../services/notificationService');
const { calculateWorkHours } = require('../services/helpdeskUtils');

const setPrivateCache = (res, maxAgeSeconds = 30) => {
    res.set('Cache-Control', `private, max-age=${maxAgeSeconds}, stale-while-revalidate=${maxAgeSeconds}`);
};


// === QUERY TYPE MANAGEMENT ===

exports.getQueryTypes = async (req, res) => {
    try {
        setPrivateCache(res, 60);
        const types = await QueryType.find({ companyId: req.companyId })
            .populate('assignedRole', 'name')
            .populate('assignedPerson', 'firstName lastName email')
            .populate('escalationRole', 'name')
            .populate('escalationPerson', 'firstName lastName email')
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
        if (!req.user.roles.some(r => r.name === 'Admin')) return res.status(403).json({ success: false, message: 'Admins only' });

        const {
            name, assignedRole, assignedPerson,
            enableEscalation, escalationDays, escalationRole, escalationPerson
        } = req.body;

        const newType = new QueryType({
            name, assignedRole, assignedPerson,
            enableEscalation, escalationDays, escalationRole, escalationPerson,
            companyId: req.companyId
        });
        await newType.save();

        res.status(201).json({ success: true, data: newType });
    } catch (error) {
        console.error('Error adding query type:', error);
        res.status(500).json({ success: false, message: 'Server Error' });
    }
};

exports.updateQueryType = async (req, res) => {
    try {
        if (!req.user.roles.some(r => r.name === 'Admin')) return res.status(403).json({ success: false, message: 'Admins only' });

        const {
            name, assignedRole, assignedPerson, isActive,
            enableEscalation, escalationDays, escalationRole, escalationPerson
        } = req.body;
        const type = await QueryType.findOne({ _id: req.params.id, companyId: req.companyId });

        if (!type) return res.status(404).json({ success: false, message: 'Type not found' });

        if (name) type.name = name;
        if (assignedRole !== undefined) type.assignedRole = assignedRole ? assignedRole : null;
        if (assignedPerson) type.assignedPerson = assignedPerson;
        if (isActive !== undefined) type.isActive = isActive;
        if (enableEscalation !== undefined) type.enableEscalation = enableEscalation;
        if (escalationDays !== undefined) type.escalationDays = escalationDays;
        if (escalationRole !== undefined) type.escalationRole = escalationRole ? escalationRole : null;
        if (escalationPerson !== undefined) type.escalationPerson = escalationPerson ? escalationPerson : null;

        await type.save();
        res.status(200).json({ success: true, data: type });
    } catch (error) {
        console.error('Error updating query type:', error);
        res.status(500).json({ success: false, message: 'Server Error' });
    }
};

exports.deleteQueryType = async (req, res) => {
    try {
        if (!req.user.roles.some(r => r.name === 'Admin')) return res.status(403).json({ success: false, message: 'Admins only' });

        await QueryType.findOneAndDelete({ _id: req.params.id, companyId: req.companyId });
        res.status(200).json({ success: true, message: 'Type deleted' });
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
        });
        if (!qType || !qType.isActive) return res.status(400).json({ success: false, message: 'Invalid or inactive query type.' });

        const newQuery = new HelpdeskQuery({
            subject,
            description,
            queryType: qType._id,
            priority: priority || 'Medium',
            raisedBy: req.user._id,
            assignedTo: qType.assignedPerson,
            status: 'New',
            companyId: req.companyId
        });

        await newQuery.save();

        // --- TARGETED NOTIFICATIONS ---
        const io = req.app.get('io');
        const notificationTargets = new Set();
        
        // Only Notify Specific Assigned Person
        if (qType.assignedPerson) {
            notificationTargets.add(qType.assignedPerson.toString());
        }


        // 4. Cleanup & Logging
        notificationTargets.delete(req.user._id.toString()); // Don't notify the raiser twice
        // console.log(`[NOTIF DEBUG] Total unique notification targets: ${notificationTargets.size}`);
        // if (!io) console.warn('[NOTIF WARNING] Socket.io instance (io) NOT found in app context!');

        const notificationsData = Array.from(notificationTargets).map(userId => ({
            user: userId,
            companyId: req.companyId,
            title: 'New Helpdesk Query',
            message: `A new ${priority || 'Medium'} priority query has been raised: "${subject}"`,
            type: 'Alert',
            link: `/helpdesk`
        }));

        if (notificationsData.length > 0) {
            await NotificationService.createManyNotifications(io, notificationsData);
        }

        // 5. Notify the raiser as well (Confirmation)
        await NotificationService.createNotification(io, {
            user: req.user._id,
            companyId: req.companyId,
            title: 'Query Raised Successfully',
            message: `Your query "${subject}" has been submitted and is being reviewed.`,
            type: 'Info',
            link: `/helpdesk`
        });

        // POPULATE FOR INSTANT UI UPDATE
        const populatedQuery = await HelpdeskQuery.findById(newQuery._id)
            .populate('raisedBy', 'firstName lastName email profilePicture')
            .populate('assignedTo', 'firstName lastName email profilePicture')
            .populate('queryType', 'name')
            .lean();

        res.status(201).json({
            success: true,
            data: populatedQuery
        });

    } catch (error) {
        console.error('Error creating query:', error);
        res.status(500).json({ success: false, message: 'Server Error' });
    }
};

exports.getMyQueries = async (req, res) => {
    try {
        setPrivateCache(res, 20);
        const queries = await HelpdeskQuery.find({ raisedBy: req.user._id, companyId: req.companyId })
            .populate('queryType', 'name')
            .populate('assignedTo', 'firstName lastName email')
            .sort({ createdAt: -1 })
            .lean();

        res.status(200).json({ success: true, data: queries });
    } catch (error) {
        console.error('Error fetching queries:', error);
        res.status(500).json({ success: false, message: 'Server Error' });
    }
};

exports.getAssignedQueries = async (req, res) => {
    try {
        setPrivateCache(res, 20);
        const queries = await HelpdeskQuery.find({ assignedTo: req.user._id, companyId: req.companyId })
            .populate('raisedBy', 'firstName lastName email')
            .populate('queryType', 'name')
            .sort({ priority: -1, createdAt: 1 }) // High priority first, then oldest
            .lean();

        res.status(200).json({ success: true, data: queries });
    } catch (error) {
        console.error('Error fetching assigned queries:', error);
        res.status(500).json({ success: false, message: 'Server Error' });
    }
};

exports.getAllQueries = async (req, res) => {
    try {
        setPrivateCache(res, 20);
        const isAdmin = req.user.roles.some(r => ['Admin', 'System'].includes(r.name || r) || r.isSystem === true);
        
        console.log(`[HelpDesk Debug] User: ${req.user.email}, Roles: ${JSON.stringify(req.user.roles.map(r => r.name || r))}, IsAdmin: ${isAdmin}, CompanyId: ${req.companyId}`);

        if (!isAdmin) return res.status(403).json({ success: false, message: 'Admins only' });

        const queries = await HelpdeskQuery.find({ companyId: req.companyId })
            .populate('raisedBy', 'firstName lastName email')
            .populate('assignedTo', 'firstName lastName email')
            .populate('queryType', 'name')
            .sort({ priority: -1, createdAt: -1 })
            .lean();

        res.status(200).json({ success: true, data: queries });
    } catch (error) {
        console.error('Error fetching all queries:', error);
        res.status(500).json({ success: false, message: 'Server Error' });
    }
};

exports.getEscalatedQueries = async (req, res) => {
    try {
        setPrivateCache(res, 20);
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

        // First try to find by ID and Company (strict multi-tenant)
        let query = await HelpdeskQuery.findOne({ _id: id, companyId: req.companyId })
            .populate('raisedBy', 'firstName lastName email')
            .populate('assignedTo', 'firstName lastName email')
            .populate('originalAssignee', 'firstName lastName email')
            .populate('comments.user', 'firstName lastName roles')
            .populate('queryType', 'name')
            .lean();

        // If not found, try to find by ID only to see if it's an old record or a mismatch
        if (!query) {
            query = await HelpdeskQuery.findById(id)
                .populate('raisedBy', 'firstName lastName email')
                .populate('assignedTo', 'firstName lastName email')
                .populate('originalAssignee', 'firstName lastName email')
                .populate('comments.user', 'firstName lastName roles')
                .populate('queryType', 'name')
                .lean();
            
            // SECURITY REFINEMENT: If found but different company, we allow viewing ONLY if they are the raiser or assignee.
            // Otherwise, it's a potential cross-tenant leak.
            if (query && query.companyId && query.companyId.toString() !== req.companyId.toString()) {
                const isAdmin = req.user.roles.some(r => (r.name || r) === 'Admin' || r.isSystem === true);
                const isAssignee = query.assignedTo?._id?.toString() === req.user._id.toString() || query.assignedTo?.toString() === req.user._id.toString();
                const isRaiser = query.raisedBy?._id?.toString() === req.user._id.toString() || query.raisedBy?.toString() === req.user._id.toString();
                
                if (!isAdmin && !isAssignee && !isRaiser) {
                    return res.status(403).json({ success: false, message: 'Access denied: Query belongs to a different workspace.' });
                }
            }
        }

        if (!query) {
            return res.status(404).json({ success: false, message: 'Query not found' });
        }

        const isAdmin = req.user.roles.some(r => ['Admin', 'System'].includes(r.name || r) || r.isSystem === true);
        const isAssignee = query.assignedTo?._id?.toString() === req.user._id.toString() || query.assignedTo?.toString() === req.user._id.toString();
        const isRaiser = query.raisedBy?._id?.toString() === req.user._id.toString() || query.raisedBy?.toString() === req.user._id.toString();

        if (!isAdmin && !isAssignee && !isRaiser) {
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
        const query = await HelpdeskQuery.findOne({ _id: req.params.id, companyId: req.companyId }).populate('queryType');

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

            // Manual Reassignment logic (mirroring cron behavior)
            const qType = query.queryType;
            if (qType && qType.enableEscalation && qType.escalationPerson) {
                const oldAssignee = query.assignedTo;
                const newAssignee = qType.escalationPerson;

                if (newAssignee.toString() !== (oldAssignee?._id?.toString() || oldAssignee?.toString())) {
                    // Pre-population: Store current assignee as ORIGINAL if not already set
                    if (!query.originalAssignee) {
                        query.originalAssignee = query.assignedTo;
                    }
                    query.assignedTo = newAssignee;

                    // Notify the new assignee specifically
                    const io = req.app.get('io');
                    await NotificationService.createNotification(io, {
                        user: newAssignee,
                        companyId: req.companyId,
                        title: 'Manual Escalation Assigned',
                        message: `An escalated query "${query.subject}" has been assigned to you.`,
                        type: 'Alert',
                        link: `/helpdesk/${query._id}`
                    });
                }
            }
        } else if (status === 'Closed' || status === 'Resolved' || status === 'In Progress' || status === 'Pending' || status === 'Escalated') {
            // Handled with special permissions or general status transition logic
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

        // Notify the other party about the status change
        const io = req.app.get('io');
        const isUserRaiser = req.user._id.toString() === query.raisedBy?.toString();
        const notifyTarget = isUserRaiser ? query.assignedTo : query.raisedBy;

        if (notifyTarget) {
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

            await NotificationService.createNotification(io, {
                user: notifyTarget,
                companyId: req.companyId,
                title: notificationTitle,
                message: notificationMessage,
                type: 'Info',
                link: `/helpdesk/${query._id}`
            });
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
        const isRaiser = query.raisedBy?.toString() === req.user._id.toString();

        if (!isAdmin && !isAssignee && !isRaiser) {
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

        // Notify the other party
        const notifyTarget = isRaiser ? query.assignedTo : query.raisedBy;
        if (notifyTarget) {
            await NotificationService.createNotification(io, {
                user: notifyTarget,
                companyId: req.companyId,
                title: 'New Comment on Query',
                message: `${req.user.firstName} commented on "${query.subject}"`,
                type: 'Info',
                link: `/helpdesk/${query._id}`
            });
        }

        res.status(200).json({ success: true, data: query });
    } catch (error) {
        console.error('Error adding comment:', error);
        res.status(500).json({ success: false, message: 'Server Error' });
    }
};
