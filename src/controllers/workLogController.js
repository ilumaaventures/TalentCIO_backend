const Timesheet = require('../models/Timesheet');
const WorkLog = require('../models/WorkLog');
const Task = require('../models/Task');
const { format } = require('date-fns');

// @desc    Log work on a task
// @route   POST /api/projects/tasks/:taskId/log
// @access  Private
const logWork = async (req, res) => {
    const { date, hours, description } = req.body;
    const { taskId } = req.params;

    try {
        const task = await Task.findOne({ _id: taskId, companyId: req.companyId });
        if (!task) {
            return res.status(404).json({ message: 'Task not found' });
        }

        // Check availability (One log per task per day)
        const startOfDay = new Date(date);
        startOfDay.setHours(0, 0, 0, 0);
        const endOfDay = new Date(date);
        endOfDay.setHours(23, 59, 59, 999);

        const existingLog = await WorkLog.findOne({
            task: taskId,
            user: req.user._id,
            companyId: req.companyId,
            date: { $gte: startOfDay, $lte: endOfDay }
        });

        if (existingLog) {
            return res.status(400).json({ message: 'You have already logged work for this task today. Please edit the existing entry.' });
        }

        const workLog = await WorkLog.create({
            task: taskId,
            user: req.user._id,
            companyId: req.companyId,
            date: new Date(date),
            hours,
            description,
            status: 'PENDING' // Default status
        });

        // Ensure a Timesheet exists for this month, but don't duplicate data
        const month = new Date(date).toISOString().slice(0, 7); // YYYY-MM
        let timesheet = await Timesheet.findOne({ user: req.user._id, month, companyId: req.companyId });

        if (!timesheet) {
            await Timesheet.create({
                user: req.user._id,
                month,
                companyId: req.companyId,
                status: 'DRAFT'
            });
        }

        res.status(201).json(workLog);
    } catch (error) {
        console.error(error);
        res.status(500).json({ message: 'Server Error' });
    }
};

// @desc    Update work log
// @route   PUT /api/projects/worklogs/:id
const updateWorkLog = async (req, res) => {
    const { hours, description } = req.body;
    try {
        const workLog = await WorkLog.findOne({ _id: req.params.id, user: req.user._id, companyId: req.companyId });
        if (!workLog) return res.status(404).json({ message: 'Work log not found' });

        // Check if Timesheet is locked (Submitted/Approved)
        const month = format(workLog.date, 'yyyy-MM');
        const timesheet = await Timesheet.findOne({ user: req.user._id, month, companyId: req.companyId });

        if (timesheet && (timesheet.status === 'SUBMITTED' || timesheet.status === 'APPROVED')) {
            return res.status(400).json({ message: 'Cannot edit logs for a submitted timesheet' });
        }

        // Update WorkLog
        workLog.hours = hours;
        workLog.description = description;
        await workLog.save();

        res.json(workLog);
    } catch (error) {
        console.error(error);
        res.status(500).json({ message: 'Server Error' });
    }
};

// @desc    Delete work log
// @route   DELETE /api/projects/worklogs/:id
const deleteWorkLog = async (req, res) => {
    try {
        const workLog = await WorkLog.findOne({ _id: req.params.id, user: req.user._id, companyId: req.companyId });
        if (!workLog) return res.status(404).json({ message: 'Work log not found' });

        // Check if Timesheet is locked (Submitted/Approved)
        const month = format(workLog.date, 'yyyy-MM');
        const timesheet = await Timesheet.findOne({ user: req.user._id, month, companyId: req.companyId });

        if (timesheet && (timesheet.status === 'SUBMITTED' || timesheet.status === 'APPROVED')) {
            return res.status(400).json({ message: 'Cannot delete logs for a submitted timesheet' });
        }

        await WorkLog.deleteOne({ _id: req.params.id });

        res.json({ message: 'Work log deleted' });
    } catch (error) {
        console.error(error);
        res.status(500).json({ message: 'Server Error' });
    }
};

// @desc    Get work logs for user (optional, for history)
// @route   GET /api/projects/worklogs?limit=4
const getWorkLogs = async (req, res) => {
    try {
        const limit = parseInt(req.query.limit) || 0; // 0 means no limit in Mongoose

        const logs = await WorkLog.find({ user: req.user._id, companyId: req.companyId })
            .populate({
                path: 'task',
                populate: {
                    path: 'module',
                    populate: { path: 'project' }
                }
            })
            .sort({ date: -1 })
            .limit(limit)
            .lean();

        res.json(logs);
    } catch (error) {
        res.status(500).json({ message: 'Server Error' });
    }
};

module.exports = { logWork, getWorkLogs, updateWorkLog, deleteWorkLog };
