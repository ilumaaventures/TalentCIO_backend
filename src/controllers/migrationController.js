const Project = require('../models/Project');
const Module = require('../models/Module');
const Task = require('../models/Task');
const WorkLog = require('../models/WorkLog');
const Timesheet = require('../models/Timesheet');
const User = require('../models/User');

// @desc    Backfill missing companyId in timesheet-related models
// @route   POST /api/admin/migrate-timesheets
// @access  Private (Admin)
const backfillTimesheets = async (req, res) => {
    try {
        console.log('[Migration] Starting timesheet backfill...');
        const stats = { projects: 0, modules: 0, tasks: 0, workLogs: 0, timesheets: 0 };

        // 1. Projects
        const orphanProjects = await Project.find({ companyId: { $exists: false } });
        for (const p of orphanProjects) {
            const manager = await User.findById(p.manager || (p.members && p.members[0]));
            if (manager && manager.companyId) {
                p.companyId = manager.companyId;
                await p.save();
                stats.projects++;
            }
        }

        // 2. Modules
        const orphanModules = await Module.find({ companyId: { $exists: false } }).populate('project');
        for (const m of orphanModules) {
            if (m.project && m.project.companyId) {
                m.companyId = m.project.companyId;
                await m.save();
                stats.modules++;
            }
        }

        // 3. Tasks
        const orphanTasks = await Task.find({ companyId: { $exists: false } }).populate('module');
        for (const t of orphanTasks) {
            if (t.module && t.module.companyId) {
                t.companyId = t.module.companyId;
                await t.save();
                stats.tasks++;
            }
        }

        // 4. WorkLogs
        const orphanLogs = await WorkLog.find({ companyId: { $exists: false } });
        for (const l of orphanLogs) {
            const user = await User.findById(l.user);
            if (user && user.companyId) {
                l.companyId = user.companyId;
                await l.save();
                stats.workLogs++;
            }
        }

        // 5. Timesheets
        const orphanTimesheets = await Timesheet.find({ companyId: { $exists: false } });
        for (const ts of orphanTimesheets) {
            const user = await User.findById(ts.user);
            if (user && user.companyId) {
                ts.companyId = user.companyId;
                await ts.save();
                stats.timesheets++;
            }
        }

        console.log('[Migration] Timesheet backfill complete:', stats);
        res.json({ message: 'Migration complete', stats });
    } catch (error) {
        console.error('[Migration] Error:', error);
        res.status(500).json({ message: 'Migration failed', error: error.message });
    }
};

module.exports = { backfillTimesheets };
