const mongoose = require('mongoose');
const User = require('../../../user/user.model');

// @desc    Get all designated interviewers
// @route   GET /api/ta/interviewers
// @access  Private (TA view permissions)
exports.getInterviewers = async (req, res) => {
    try {
        const interviewers = await User.find({
            companyId: req.companyId,
            isInterviewer: true,
            isActive: { $ne: false },
            isDeleted: { $ne: true }
        })
            .select('firstName lastName email employeeCode profilePicture roles department departmentRef designationRef isActive isInterviewer createdAt')
            .populate('roles', 'name')
            .populate('departmentRef', 'name')
            .populate('designationRef', 'title')
            .sort({ firstName: 1, lastName: 1 })
            .lean();

        res.status(200).json(interviewers);
    } catch (error) {
        console.error('Error fetching interviewers:', error);
        res.status(500).json({ message: 'Server error fetching interviewers', error: error.message });
    }
};

// @desc    Add one or multiple users to interviewers
// @route   POST /api/ta/interviewers
// @access  Private (TA edit permissions)
exports.addInterviewers = async (req, res) => {
    try {
        let userIds = req.body.userIds;
        if (!userIds && req.body.userId) {
            userIds = [req.body.userId];
        }

        if (!Array.isArray(userIds) || userIds.length === 0) {
            return res.status(400).json({ message: 'Please provide at least one valid user ID' });
        }

        const validUserIds = userIds
            .filter((id) => mongoose.Types.ObjectId.isValid(id))
            .map((id) => new mongoose.Types.ObjectId(id));

        if (validUserIds.length === 0) {
            return res.status(400).json({ message: 'No valid user IDs provided' });
        }

        await User.updateMany(
            { _id: { $in: validUserIds }, companyId: req.companyId },
            { $set: { isInterviewer: true } }
        );

        const updatedInterviewers = await User.find({
            companyId: req.companyId,
            isInterviewer: true,
            isActive: { $ne: false },
            isDeleted: { $ne: true }
        })
            .select('firstName lastName email employeeCode profilePicture roles department departmentRef designationRef isActive isInterviewer createdAt')
            .populate('roles', 'name')
            .populate('departmentRef', 'name')
            .populate('designationRef', 'title')
            .sort({ firstName: 1, lastName: 1 })
            .lean();

        res.status(200).json({
            success: true,
            message: `${validUserIds.length} interviewer(s) added successfully`,
            data: updatedInterviewers
        });
    } catch (error) {
        console.error('Error adding interviewers:', error);
        res.status(500).json({ message: 'Server error adding interviewers', error: error.message });
    }
};

// @desc    Sync / set full list of interviewers
// @route   PUT /api/ta/interviewers
// @access  Private (TA edit permissions)
exports.syncInterviewers = async (req, res) => {
    try {
        const userIds = Array.isArray(req.body.userIds) ? req.body.userIds : [];
        const validUserIds = userIds
            .filter((id) => mongoose.Types.ObjectId.isValid(id))
            .map((id) => new mongoose.Types.ObjectId(id));

        // 1. Mark selected user IDs as interviewers
        if (validUserIds.length > 0) {
            await User.updateMany(
                { _id: { $in: validUserIds }, companyId: req.companyId },
                { $set: { isInterviewer: true } }
            );
        }

        // 2. Mark any other users in company as not interviewer
        await User.updateMany(
            { _id: { $nin: validUserIds }, companyId: req.companyId, isInterviewer: true },
            { $set: { isInterviewer: false } }
        );

        const updatedInterviewers = await User.find({
            companyId: req.companyId,
            isInterviewer: true,
            isActive: { $ne: false },
            isDeleted: { $ne: true }
        })
            .select('firstName lastName email employeeCode profilePicture roles department departmentRef designationRef isActive isInterviewer createdAt')
            .populate('roles', 'name')
            .populate('departmentRef', 'name')
            .populate('designationRef', 'title')
            .sort({ firstName: 1, lastName: 1 })
            .lean();

        res.status(200).json({
            success: true,
            message: 'Interviewers updated successfully',
            data: updatedInterviewers
        });
    } catch (error) {
        console.error('Error syncing interviewers:', error);
        res.status(500).json({ message: 'Server error syncing interviewers', error: error.message });
    }
};

// @desc    Remove an interviewer
// @route   DELETE /api/ta/interviewers/:userId
// @access  Private (TA edit permissions)
exports.removeInterviewer = async (req, res) => {
    try {
        const { userId } = req.params;
        if (!mongoose.Types.ObjectId.isValid(userId)) {
            return res.status(400).json({ message: 'Invalid user ID' });
        }

        await User.updateOne(
            { _id: userId, companyId: req.companyId },
            { $set: { isInterviewer: false } }
        );

        res.status(200).json({
            success: true,
            message: 'User removed from interviewers successfully'
        });
    } catch (error) {
        console.error('Error removing interviewer:', error);
        res.status(500).json({ message: 'Server error removing interviewer', error: error.message });
    }
};
