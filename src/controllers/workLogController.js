const Timesheet = require('../models/Timesheet');
const WorkLog = require('../models/WorkLog');
const Task = require('../models/Task');
const { buildEndOfDayIST, parseDateAsIST } = require('../utils/attendancePolicy');
const { getTimesheetPeriodIdForDate } = require('../utils/timesheetPeriod');

// @desc    Log work on a task
// @route   POST /api/projects/tasks/:taskId/log
// @access  Private
const logWork = async (req, res) => {
    const { date, hours, description } = req.body;
    const { taskId } = req.params;

    try {
        const task = await Task.findOne({ _id: taskId, companyId: req.companyId }).populate({
            path: 'module',
            select: 'project'
        });
        if (!task) {
            return res.status(404).json({ message: 'Task not found' });
        }

        const parsedDate = new Date(date);
        if (!date || Number.isNaN(parsedDate.getTime())) {
            return res.status(400).json({ message: 'Valid work log date is required' });
        }
        const normalizedDate = parseDateAsIST(parsedDate);

        const cycle = req.company?.settings?.timesheet?.approvalCycle || 'Monthly';
        const periodId = getTimesheetPeriodIdForDate(normalizedDate, cycle);
        const existingTimesheet = await Timesheet.findOne({
            user: req.user._id,
            month: periodId,
            companyId: req.companyId
        });

        if (existingTimesheet && (existingTimesheet.status === 'SUBMITTED' || existingTimesheet.status === 'APPROVED')) {
            return res.status(400).json({ message: 'Cannot add logs to a submitted or approved timesheet.' });
        }

        if (req.user?.joiningDate) {
            const isAdmin = req.user.roles?.some(r => 
                (typeof r === 'string' && r === 'Admin') || 
                (typeof r === 'object' && r.name === 'Admin')
            ) || req.user.permissions?.includes('*');

            if (!isAdmin) {
                const joiningDateIST = parseDateAsIST(req.user.joiningDate);
                if (joiningDateIST && normalizedDate < joiningDateIST) {
                    return res.status(400).json({ message: 'Cannot add logs before joining date.' });
                }
            }
        }

        const startOfDay = normalizedDate;
        const endOfDay = buildEndOfDayIST(normalizedDate);

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
            module: task.module?._id || null,
            project: task.module?.project || null,
            user: req.user._id,
            companyId: req.companyId,
            date: normalizedDate,
            hours,
            description,
            status: 'PENDING' // Default status
        });

        // Ensure a Timesheet exists for this period, but don't duplicate data
        let timesheet = existingTimesheet;

        if (!timesheet) {
            await Timesheet.create({
                user: req.user._id,
                month: periodId,
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
        const cycle = req.company?.settings?.timesheet?.approvalCycle || 'Monthly';
        const periodId = getTimesheetPeriodIdForDate(workLog.date, cycle);
        const timesheet = await Timesheet.findOne({ user: req.user._id, month: periodId, companyId: req.companyId });

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
        const cycle = req.company?.settings?.timesheet?.approvalCycle || 'Monthly';
        const periodId = getTimesheetPeriodIdForDate(workLog.date, cycle);
        const timesheet = await Timesheet.findOne({ user: req.user._id, month: periodId, companyId: req.companyId });

        if (timesheet && (timesheet.status === 'SUBMITTED' || timesheet.status === 'APPROVED')) {
            return res.status(400).json({ message: 'Cannot delete logs for a submitted timesheet' });
        }

        await workLog.softDelete(req.user._id);

        res.json({ message: 'Work log moved to bin' });
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
