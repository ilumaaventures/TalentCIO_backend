const Discussion = require('./discussion.model');
const User = require('../../modules/user/user.model');
const WorkLog = require('../../modules/timesheet/workLog.model');
const NotificationService = require('../../services/notificationService');
const mongoose = require('mongoose');
const {
    attachDiscussionPermissions,
    buildAccessibleDiscussionMatch,
    buildDiscussionParticipants,
    canAccessDiscussion,
    canChangeRestrictedDiscussionStatus,
    canDeleteDiscussion,
    canEditDiscussion
} = require('./discussion.access');

const setPrivateCache = (res, maxAgeSeconds = 30) => {
    res.set('Cache-Control', `private, max-age=${maxAgeSeconds}, stale-while-revalidate=${maxAgeSeconds}`);
};

const attachWorkLogTotals = async (discussions) => {
    if (!discussions || discussions.length === 0) return discussions;
    const objectIds = [];
    const stringIds = [];
    discussions.forEach(d => {
        if (d && d._id) {
            const strId = String(d._id);
            stringIds.push(strId);
            if (mongoose.isValidObjectId(strId)) {
                objectIds.push(new mongoose.Types.ObjectId(strId));
            }
        }
    });

    const totals = await WorkLog.aggregate([
        {
            $match: {
                discussion: { $in: [...objectIds, ...stringIds] },
                isDeleted: { $ne: true }
            }
        },
        { $group: { _id: '$discussion', total: { $sum: '$hours' } } }
    ]);

    const totalsMap = new Map(totals.map(t => [String(t._id), t.total]));
    return discussions.map(d => ({
        ...d,
        totalLoggedHours: totalsMap.get(String(d._id)) || 0
    }));
};

exports.createDiscussion = async (req, res) => {
    try {
        const { title, discussion, status, dueDate, supervisor, visibleToUserIds = [], participantUserId, project, priority, hours } = req.body;
        const selectedSupervisorIds = Array.isArray(supervisor)
            ? supervisor
            : (supervisor || participantUserId ? [supervisor || participantUserId] : []);
        const normalizedVisibleTo = Array.isArray(visibleToUserIds)
            ? visibleToUserIds
            : (visibleToUserIds ? [visibleToUserIds] : []);

        if (!selectedSupervisorIds.length) {
            return res.status(400).json({ message: 'Supervisor is required' });
        }

        if (!normalizedVisibleTo.length) {
            return res.status(400).json({ message: 'At least one visible user is required' });
        }
        const newDiscussion = new Discussion({
            companyId: req.companyId,
            title,
            discussion,
            status: status || 'inprogress',
            dueDate,
            createdBy: req.user._id,
            supervisor: selectedSupervisorIds,
            visibleToUsers: normalizedVisibleTo,
            participants: buildDiscussionParticipants(req.user._id, selectedSupervisorIds, normalizedVisibleTo),
            project: (project && mongoose.isValidObjectId(project)) ? project : null,
            priority: priority || 'Medium',
            hours: (hours !== undefined && hours !== null && hours !== '') ? Number(hours) : null
        });
        await newDiscussion.save();

        const recipients = buildDiscussionParticipants(selectedSupervisorIds, normalizedVisibleTo)
            .filter((userId) => String(userId) !== String(req.user._id));

        if (recipients.length) {
            const io = req.app.get('io');
            await NotificationService.createManyNotifications(io, recipients.map((userId) => ({
                user: userId,
                companyId: req.companyId,
                preferenceKey: 'discussion_created',
                title: 'New Private Discussion',
                message: `You have been added to a private discussion: "${discussion.substring(0, 50)}${discussion.length > 50 ? '...' : ''}"`,
                type: 'Info',
                link: '/discussions',
                origin: req.headers?.origin || ''
            })));
        }

        const populatedDiscussion = await Discussion.findById(newDiscussion._id)
            .populate('createdBy', 'firstName lastName email profilePicture')
            .populate('supervisor', 'firstName lastName email profilePicture')
            .populate('visibleToUsers', 'firstName lastName email profilePicture')
            .populate('project', 'name')
            .lean();

        res.status(201).json({ message: 'Discussion created successfully', discussion: attachDiscussionPermissions(populatedDiscussion, req.user) });
    } catch (error) {
        console.error('Error creating discussion:', error);
        res.status(500).json({ message: 'Error creating discussion', error: error.message });
    }
};

exports.getDiscussions = async (req, res) => {
    try {
        res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
        const page = parseInt(req.query.page) || 1;
        const limit = parseInt(req.query.limit, 10) || 100;
        const skip = (page - 1) * limit;

        const accessMatch = buildAccessibleDiscussionMatch(req.companyId, req.user);
        if (req.query.status) {
            accessMatch.status = req.query.status;
        }
        if (req.query.project) {
            accessMatch.project = req.query.project === 'null' ? null : new mongoose.Types.ObjectId(String(req.query.project));
        }
        if (req.query.priority) {
            if (req.query.priority === 'Medium') {
                accessMatch.$and = accessMatch.$and || [];
                accessMatch.$and.push({
                    $or: [
                        { priority: 'Medium' },
                        { priority: { $exists: false } }
                    ]
                });
            } else {
                accessMatch.priority = req.query.priority;
            }
        }
        const total = await Discussion.countDocuments(accessMatch);

        let discussions = await Discussion.aggregate([
            { $match: accessMatch },
            {
                $addFields: {
                    isCompleted: { $cond: { if: { $eq: ["$status", "mark as complete"] }, then: 1, else: 0 } }
                }
            },
            { $sort: { isCompleted: 1, createdAt: -1 } },
            { $skip: skip },
            { $limit: limit }
        ]);

        discussions = await Discussion.populate(discussions, [
            { path: 'createdBy', select: 'firstName lastName email profilePicture' },
            { path: 'supervisor', select: 'firstName lastName email profilePicture' },
            { path: 'visibleToUsers', select: 'firstName lastName email profilePicture' },
            { path: 'project', select: 'name' }
        ]);

        discussions = await attachWorkLogTotals(discussions);
        discussions = discussions.map((discussion) => attachDiscussionPermissions(discussion, req.user));

        res.status(200).json({
            discussions,
            currentPage: page,
            totalPages: Math.ceil(total / limit),
            total
        });
    } catch (error) {
        console.error('Error fetching discussions:', error);
        res.status(500).json({ message: 'Error fetching discussions', error: error.message });
    }
};

exports.getDiscussionById = async (req, res) => {
    try {
        const discussion = await Discussion.findOne({ _id: req.params.id, companyId: req.companyId })
            .populate('createdBy', 'firstName lastName email profilePicture')
            .populate('supervisor', 'firstName lastName email profilePicture')
            .populate('visibleToUsers', 'firstName lastName email profilePicture')
            .populate('project', 'name')
            .lean();
        if (!discussion) return res.status(404).json({ message: 'Discussion not found' });
        if (!canAccessDiscussion(discussion, req.user)) {
            return res.status(403).json({ message: 'Forbidden: You do not have permission to view this discussion' });
        }
        const discIdStr = String(req.params.id);
        const matchIds = [discIdStr];
        if (mongoose.isValidObjectId(discIdStr)) {
            matchIds.push(new mongoose.Types.ObjectId(discIdStr));
        }
        const totals = await WorkLog.aggregate([
            { $match: { discussion: { $in: matchIds }, isDeleted: { $ne: true } } },
            { $group: { _id: null, total: { $sum: '$hours' } } }
        ]);
        discussion.totalLoggedHours = totals[0]?.total || 0;
        res.status(200).json(attachDiscussionPermissions(discussion, req.user));
    } catch (error) {
        console.error('Error fetching discussion:', error);
        res.status(500).json({ message: 'Error fetching discussion', error: error.message });
    }
};

exports.updateDiscussion = async (req, res) => {
    try {
        const { id } = req.params;
        const { title, discussion, status, dueDate, supervisor, visibleToUserIds, participantUserId, project, priority, hours } = req.body;

        const existingDiscussion = await Discussion.findOne({ _id: id, companyId: req.companyId });
        if (!existingDiscussion) return res.status(404).json({ message: 'Discussion not found' });

        if (!canEditDiscussion(existingDiscussion, req.user)) {
            return res.status(403).json({ message: 'Forbidden: You do not have permission to update this discussion' });
        }

        // Enforce supervisor-only status changes after creation
        if (status && status !== existingDiscussion.status) {
            if (!canChangeRestrictedDiscussionStatus(existingDiscussion, req.user)) {
                return res.status(403).json({ message: 'Only the assigned supervisor can update the discussion status' });
            }
        }

        const updateData = { discussion };
        if (title !== undefined) {
            updateData.title = title;
        }
        if (dueDate !== undefined) {
            updateData.dueDate = dueDate;
        }
        if (status !== undefined) {
            updateData.status = status;
        }
        if (project !== undefined) {
            updateData.project = (project && mongoose.isValidObjectId(project)) ? project : null;
        }
        if (priority !== undefined) {
            updateData.priority = priority;
        }
        if (hours !== undefined) {
            updateData.hours = (hours !== null && hours !== '') ? Number(hours) : null;
        }

        // Sanitize: strip empty objects or invalid values — only keep valid 24-char hex ObjectId strings
        const sanitizeIds = (arr) => {
            if (!Array.isArray(arr)) {
                if (arr && typeof arr === 'string' && mongoose.isValidObjectId(arr.trim())) return [arr.trim()];
                return [];
            }
            return arr
                .map((v) => {
                    if (!v) return null;
                    if (typeof v === 'string' && mongoose.isValidObjectId(v.trim())) return v.trim();
                    if (typeof v === 'object') {
                        const id = String(v._id || v.id || '');
                        if (mongoose.isValidObjectId(id)) return id;
                    }
                    return null;
                })
                .filter(Boolean);
        };

        const selectedSupervisorIds = sanitizeIds(
            Array.isArray(supervisor) ? supervisor
                : (supervisor || participantUserId ? [supervisor || participantUserId] : existingDiscussion.supervisor)
        );
        const normalizedVisibleTo = sanitizeIds(
            Array.isArray(visibleToUserIds) ? visibleToUserIds
                : (visibleToUserIds ? [visibleToUserIds] : existingDiscussion.visibleToUsers || [])
        );

        if (selectedSupervisorIds.length === 0 && supervisor !== undefined) {
            return res.status(400).json({ message: 'At least one valid supervisor is required' });
        }

        if (supervisor || participantUserId) {
            updateData.supervisor = selectedSupervisorIds;
        }
        if (visibleToUserIds !== undefined) {
            updateData.visibleToUsers = normalizedVisibleTo;
        }
        updateData.participants = buildDiscussionParticipants(
            existingDiscussion.createdBy,
            updateData.supervisor || selectedSupervisorIds,
            updateData.visibleToUsers || normalizedVisibleTo
        );

        const updatedDiscussion = await Discussion.findOneAndUpdate(
            { _id: id, companyId: req.companyId },
            updateData,
            { new: true, runValidators: true }
        ).populate('createdBy', 'firstName lastName email profilePicture')
         .populate('supervisor', 'firstName lastName email profilePicture')
         .populate('visibleToUsers', 'firstName lastName email profilePicture')
         .populate('project', 'name')
         .lean();

        res.status(200).json({ message: 'Discussion updated successfully', discussion: attachDiscussionPermissions(updatedDiscussion, req.user) });
    } catch (error) {
        console.error('Error updating discussion:', error);
        res.status(500).json({ message: 'Error updating discussion', error: error.message });
    }
};

exports.deleteDiscussion = async (req, res) => {
    try {
        const discussion = await Discussion.findOne({ _id: req.params.id, companyId: req.companyId });
        if (!discussion) return res.status(404).json({ message: 'Discussion not found' });
        if (!canDeleteDiscussion(discussion, req.user)) {
            return res.status(403).json({ message: 'Forbidden: You do not have permission to delete this discussion' });
        }

        await discussion.softDelete(req.user._id);
        res.status(200).json({ message: 'Discussion moved to bin successfully' });
    } catch (error) {
        console.error('Error deleting discussion:', error);
        res.status(500).json({ message: 'Error deleting discussion', error: error.message });
    }
};

exports.getSupervisorList = async (req, res) => {
    try {
        setPrivateCache(res, 60);
        const users = await User.find({ companyId: req.companyId, isActive: true })
            .select('firstName lastName email profilePicture')
            .sort({ firstName: 1 });
        res.status(200).json(users);
    } catch (error) {
        console.error('Error fetching supervisor list:', error);
        res.status(500).json({ message: 'Error fetching supervisor list', error: error.message });
    }
};
