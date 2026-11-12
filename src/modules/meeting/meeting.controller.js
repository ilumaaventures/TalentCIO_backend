const Meeting = require('./meeting.model');

const isAdminOrHasMeetingPermission = (user, permKey) => {
    const roles = Array.isArray(user?.roles) ? user.roles : [];
    const isSystemOrAdmin = roles.some(r => {
        const name = typeof r === 'string' ? r : r?.name;
        return ['Admin', 'System Admin', 'Super Admin', 'HR Admin'].includes(name) || Boolean(r?.isSystem);
    });
    if (isSystemOrAdmin) return true;
    if (user?.permissions?.includes('*')) return true;
    if (user?.permissions?.includes('admin')) return true;
    if (user?.permissions?.includes(permKey)) return true;
    if (user?.permissions?.includes('meeting.manage')) return true;
    return roles.some(r => r?.permissions?.some(p => p.key === permKey || p.key === 'meeting.manage'));
};

// Get all meetings (can be filtered by type, date, or user's involvement)
const getMeetings = async (req, res) => {
    try {
        const query = { companyId: req.companyId };

        // Basic filtering, you could add more (e.g., date range, type)
        if (req.query.meetingType) query.meetingType = req.query.meetingType;

        // Security/Access Control:
        // Admin or Global Read can see all.
        // Otherwise, see meetings where user is host, attendee, or absentee.
        const canViewAll = isAdminOrHasMeetingPermission(req.user, 'meeting.read');

        if (!canViewAll) {
            query.$or = [
                { host: req.user._id },
                { attendees: req.user._id },
                { absentees: req.user._id }
            ];
        }

        const meetings = await Meeting.find(query)
            .populate('host', 'firstName lastName')
            .populate('attendees', 'firstName lastName')
            .sort({ date: -1, startTime: -1 });

        res.json(meetings);
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
};

// Get single meeting by ID
const getMeetingById = async (req, res) => {
    try {
        const meeting = await Meeting.findOne({ _id: req.params.id, companyId: req.companyId })
            .populate('host', 'firstName lastName')
            .populate('attendees', 'firstName lastName')
            .populate('absentees', 'firstName lastName')
            .populate('agendaItems.owner', 'firstName lastName')
            .populate('actionItems.assignee', 'firstName lastName')
            .populate('reviewedBy', 'firstName lastName');

        if (!meeting) return res.status(404).json({ message: 'Meeting not found' });

        // Check access
        const canViewAll = isAdminOrHasMeetingPermission(req.user, 'meeting.read');

        const isParticipant =
            meeting.host._id.toString() === req.user._id.toString() ||
            meeting.attendees.some(a => a._id.toString() === req.user._id.toString()) ||
            meeting.absentees.some(a => a._id.toString() === req.user._id.toString());

        if (!canViewAll && !isParticipant) {
            return res.status(403).json({ message: 'Not authorized to view this meeting' });
        }

        res.json(meeting);
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
};

// Create a new meeting
const createMeeting = async (req, res) => {
    try {
        const canCreate = isAdminOrHasMeetingPermission(req.user, 'meeting.create');
        if (!canCreate) {
            return res.status(403).json({ message: 'Not authorized to create meetings' });
        }

        // Auto-assign host to the user creating it if not provided
        if (!req.body.host) {
            req.body.host = req.user._id;
        }

        const meeting = await Meeting.create({ ...req.body, companyId: req.companyId });
        res.status(201).json(meeting);
    } catch (error) {
        res.status(400).json({ message: error.message });
    }
};

// Update a meeting
const updateMeeting = async (req, res) => {
    try {
        const meeting = await Meeting.findOne({ _id: req.params.id, companyId: req.companyId });
        if (!meeting) return res.status(404).json({ message: 'Meeting not found' });

        // Authorization: Admin or Host can update
        const canEditAll = isAdminOrHasMeetingPermission(req.user, 'meeting.edit');

        if (!canEditAll && meeting.host.toString() !== req.user._id.toString()) {
            return res.status(403).json({ message: 'Not authorized to update this meeting' });
        }

        const updatedMeeting = await Meeting.findOneAndUpdate({ _id: req.params.id, companyId: req.companyId },
            req.body,
            { new: true }
        ).populate('host attendees absentees');

        res.json(updatedMeeting);
    } catch (error) {
        res.status(400).json({ message: error.message });
    }
};

// Delete a meeting
const deleteMeeting = async (req, res) => {
    try {
        const meeting = await Meeting.findOne({ _id: req.params.id, companyId: req.companyId });
        if (!meeting) return res.status(404).json({ message: 'Meeting not found' });

        // Authorization
        const canDeleteAll = isAdminOrHasMeetingPermission(req.user, 'meeting.delete');

        if (!canDeleteAll && meeting.host.toString() !== req.user._id.toString()) {
            return res.status(403).json({ message: 'Not authorized to delete this meeting' });
        }

        await meeting.softDelete(req.user._id);
        res.json({ message: 'Meeting moved to bin successfully' });
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
};

module.exports = {
    getMeetings,
    getMeetingById,
    createMeeting,
    updateMeeting,
    deleteMeeting
};
