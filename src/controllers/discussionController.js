const Discussion = require('../models/Discussion');
const User = require('../models/User');
const Notification = require('../models/Notification');
const mongoose = require('mongoose');

const setPrivateCache = (res, maxAgeSeconds = 30) => {
    res.set('Cache-Control', `private, max-age=${maxAgeSeconds}, stale-while-revalidate=${maxAgeSeconds}`);
};

exports.createDiscussion = async (req, res) => {
    try {
        const { title, discussion, status, dueDate, supervisor } = req.body;
        if (!supervisor) {
            return res.status(400).json({ message: 'Supervisor is required' });
        }
        const newDiscussion = new Discussion({
            companyId: req.companyId,
            title,
            discussion,
            status: status || 'inprogress',
            dueDate,
            createdBy: req.user._id,
            supervisor
        });
        await newDiscussion.save();

        // Create notification for supervisor
        await Notification.create({
            user: supervisor,
            companyId: req.companyId,
            title: 'New Discussion Assigned',
            message: `You have been assigned as a supervisor for a new discussion: "${discussion.substring(0, 50)}${discussion.length > 50 ? '...' : ''}"`,
            type: 'Info',
            link: '/discussions'
        });

        const populatedDiscussion = await Discussion.findById(newDiscussion._id)
            .populate('createdBy', 'firstName lastName email profilePicture')
            .populate('supervisor', 'firstName lastName email profilePicture');

        res.status(201).json({ message: 'Discussion created successfully', discussion: populatedDiscussion });
    } catch (error) {
        console.error('Error creating discussion:', error);
        res.status(500).json({ message: 'Error creating discussion', error: error.message });
    }
};

exports.getDiscussions = async (req, res) => {
    try {
        setPrivateCache(res, 30);
        const page = parseInt(req.query.page) || 1;
        const limit = parseInt(req.query.limit) || 10;
        const skip = (page - 1) * limit;

        const total = await Discussion.countDocuments({ companyId: req.companyId });

        let discussions = await Discussion.aggregate([
            { $match: { companyId: new mongoose.Types.ObjectId(req.companyId) } },
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
            { path: 'supervisor', select: 'firstName lastName email profilePicture' }
        ]);

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
            .populate('supervisor', 'firstName lastName email profilePicture');
        if (!discussion) return res.status(404).json({ message: 'Discussion not found' });
        res.status(200).json(discussion);
    } catch (error) {
        console.error('Error fetching discussion:', error);
        res.status(500).json({ message: 'Error fetching discussion', error: error.message });
    }
};

exports.updateDiscussion = async (req, res) => {
    try {
        const { id } = req.params;
        const { title, discussion, status, dueDate, supervisor } = req.body;

        const existingDiscussion = await Discussion.findOne({ _id: id, companyId: req.companyId });
        if (!existingDiscussion) return res.status(404).json({ message: 'Discussion not found' });

        // Enforce supervisor-only status change for 'mark as complete' or 'on-hold'
        if (status && (status === 'mark as complete' || status === 'on-hold')) {
            if (existingDiscussion.supervisor.toString() !== req.user._id.toString()) {
                return res.status(403).json({ message: 'Only the assigned supervisor can mark status as complete or on-hold' });
            }
        }

        const updateData = { title, discussion, status, dueDate };
        if (supervisor) updateData.supervisor = supervisor;

        const updatedDiscussion = await Discussion.findOneAndUpdate(
            { _id: id, companyId: req.companyId },
            updateData,
            { new: true, runValidators: true }
        ).populate('createdBy', 'firstName lastName email profilePicture')
         .populate('supervisor', 'firstName lastName email profilePicture');

        res.status(200).json({ message: 'Discussion updated successfully', discussion: updatedDiscussion });
    } catch (error) {
        console.error('Error updating discussion:', error);
        res.status(500).json({ message: 'Error updating discussion', error: error.message });
    }
};

exports.deleteDiscussion = async (req, res) => {
    try {
        const discussion = await Discussion.findOneAndDelete({ _id: req.params.id, companyId: req.companyId });
        if (!discussion) return res.status(404).json({ message: 'Discussion not found' });
        res.status(200).json({ message: 'Discussion deleted successfully' });
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
