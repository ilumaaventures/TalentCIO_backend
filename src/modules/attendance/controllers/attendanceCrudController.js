const Attendance = require('../attendance.model');
const User = require('../../user/user.model');
const Company = require('../../company/company.model');
const { parseDateAsIST, getStartOfDayIST, buildAttendancePolicy } = require('../attendancePolicy');
const {
    ensureTimesheetPeriodEditable,
    canUpdateFutureRecords,
    applyPolicyMetadata,
    applyPresentOnlyRecord
} = require('../utils/attendanceHelpers');

exports.getMyAttendance = async (req, res) => {
    try {
        const { month } = req.query;
        let query = { user: req.user._id, companyId: req.companyId };
        if (month) {
            const start = parseDateAsIST(month + '-01');
            const end = new Date(start);
            end.setMonth(end.getMonth() + 1);
            query.date = { $gte: start, $lt: end };
        }
        const history = await Attendance.find(query).sort({ date: -1 }).lean();
        res.json(history);
    } catch (error) {
        console.error(error);
        res.status(500).json({ message: 'Server Error' });
    }
};

exports.getAttendanceByMonth = async (req, res) => {
    try {
        const { month, year, userId } = req.query;
        let query = { companyId: req.companyId };
        
        const isAdmin = req.user.roles?.some(r => 
            (typeof r === 'string' && r === 'Admin') || 
            (typeof r === 'object' && r.name === 'Admin')
        ) || req.user.permissions?.includes('*') || 
          req.user.permissions?.includes('attendance.view') ||
          req.user.permissions?.includes('attendance.update_others');

        if (userId) {
            const isManager = (await User.findById(userId))?.reportingManagers?.some(m => m.toString() === req.user._id.toString());
            if (!isAdmin && !isManager && userId !== req.user._id.toString()) {
                return res.status(403).json({ message: 'Not authorized to view this user\'s attendance' });
            }
            query.user = userId;
        } else {
            query.user = req.user._id;
        }

        let resolvedMonth = month;
        if (year && month && !month.includes('-')) {
            resolvedMonth = `${year}-${String(month).padStart(2, '0')}`;
        }

        if (resolvedMonth) {
            const start = parseDateAsIST(resolvedMonth + '-01');
            const end = new Date(start);
            end.setMonth(end.getMonth() + 1);
            query.date = { $gte: start, $lt: end };
        }
        const history = await Attendance.find(query)
            .select('date clockIn clockInIST clockOut clockOutIST duration status user approvalStatus approvedBy')
            .populate('user', 'firstName lastName')
            .sort({ date: -1 })
            .lean();

        const company = await Company.findById(req.companyId);
        const weeklyOff = company?.settings?.attendance?.weeklyOff || ['Saturday', 'Sunday'];

        res.json({ history, weeklyOff });
    } catch (error) {
        console.error(error);
        res.status(500).json({ message: 'Server Error' });
    }
};

exports.createAttendance = async (req, res) => {
    try {
        const { date, clockIn, clockOut, userId, location, source } = req.body;
        const targetUserId = userId || req.user._id;

        const isAdmin = req.user.roles?.some(r => 
            (typeof r === 'string' && r === 'Admin') || 
            (typeof r === 'object' && r.name === 'Admin')
        ) || req.user.permissions?.includes('*') || req.user.permissions?.includes('attendance.update_others');

        const isSelf = targetUserId.toString() === req.user._id.toString();
        
        if (!isSelf && !isAdmin) {
            const targetUser = await User.findById(targetUserId);
            const isManager = targetUser?.reportingManagers?.some(m => m.toString() === req.user._id.toString());
            if (!isManager) {
                return res.status(403).json({ message: 'Not authorized to create attendance for this user' });
            }
        }

        const [company, targetUser] = await Promise.all([
            req.company
                ? Promise.resolve(req.company)
                : Company.findById(req.companyId).select('settings.timesheet settings.attendance').lean(),
            User.findOne({ _id: targetUserId, companyId: req.companyId })
                .select('attendanceMode attendanceShiftCode joiningDate')
                .lean()
        ]);

        if (!targetUser) {
            return res.status(404).json({ message: 'User not found' });
        }

        const attSettings = company?.settings?.attendance || {};
        if (source === 'timesheet' && attSettings.requireLocationTimesheet && !isAdmin) {
            if (!location || typeof location.lat !== 'number') {
                return res.status(400).json({ message: 'Location is required when submitting attendance from the timesheet.' });
            }
        }

        const editability = await ensureTimesheetPeriodEditable({
            company,
            companyId: req.companyId,
            userId: targetUserId,
            dateValue: date
        });
        if (!editability.ok) {
            return res.status(400).json({ message: editability.message });
        }

        const attendanceDate = parseDateAsIST(date);
        if (targetUser.joiningDate && attendanceDate < parseDateAsIST(targetUser.joiningDate) && !isAdmin) {
            return res.status(400).json({ message: 'Cannot create attendance before employee joining date.' });
        }
        if (attendanceDate > getStartOfDayIST() && !canUpdateFutureRecords(req.user)) {
            return res.status(403).json({ message: 'Not authorized to create attendance for future dates' });
        }

        const existingAttendance = await Attendance.findOne({
            user: targetUserId,
            companyId: req.companyId,
            date: attendanceDate
        });

        if (existingAttendance) {
            return res.status(409).json({
                message: 'Attendance already exists for this user on this date. Update the existing record instead.',
                attendance: existingAttendance
            });
        }

        const newAttendance = new Attendance({
            user: targetUserId,
            companyId: req.companyId,
            date: attendanceDate,
            status: 'PRESENT',
            clockIn: clockIn ? new Date(clockIn) : null,
            clockOut: clockOut ? new Date(clockOut) : null,
            clockInIST: clockIn ? new Date(clockIn).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }) : null,
            clockOutIST: clockOut ? new Date(clockOut).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }) : null,
            ...(location && typeof location.lat === 'number' ? { location: { lat: location.lat, lng: location.lng, accuracy: location.accuracy } } : {})
        });

        const policy = buildAttendancePolicy({
            company,
            user: targetUser,
            attendanceDate,
            clockInTime: newAttendance.clockIn
        });
        applyPolicyMetadata(newAttendance, policy);

        if (policy.mode === 'present_only') {
            applyPresentOnlyRecord(newAttendance, '[Marked present by admin]');
        }

        await newAttendance.save();
        res.status(201).json(newAttendance);
    } catch (error) {
        console.error(error);
        if (error?.code === 11000) {
            return res.status(409).json({
                message: 'Attendance already exists for this user on this date. Update the existing record instead.'
            });
        }
        res.status(500).json({ message: 'Server Error' });
    }
};

exports.updateAttendance = async (req, res) => {
    const { clockIn, clockOut, location, source } = req.body;
    try {
        const attendance = await Attendance.findOne({ _id: req.params.id, companyId: req.companyId }).populate('user');
        if (!attendance) return res.status(404).json({ message: 'Attendance record not found' });
        
        const isAdmin = req.user.roles?.some(r => 
            (typeof r === 'string' && r === 'Admin') || 
            (typeof r === 'object' && r.name === 'Admin')
        ) || req.user.permissions?.includes('*') || req.user.permissions?.includes('attendance.update_others');

        const isOwner = attendance.user?._id.toString() === req.user._id.toString();
        const isManager = attendance.user?.reportingManagers?.some(m => m.toString() === req.user._id.toString());

        if (!isOwner && !isManager && !isAdmin) {
            return res.status(403).json({ message: 'Not authorized to update this attendance record' });
        }

        const company = req.company || await Company.findById(req.companyId).select('settings.timesheet settings.attendance').lean();
        const editability = await ensureTimesheetPeriodEditable({
            company,
            companyId: req.companyId,
            userId: attendance.user?._id || attendance.user,
            dateValue: attendance.date
        });
        if (!editability.ok) {
            return res.status(400).json({ message: editability.message });
        }

        if (parseDateAsIST(attendance.date) > getStartOfDayIST() && !canUpdateFutureRecords(req.user)) {
            return res.status(403).json({ message: 'Not authorized to update attendance for future dates' });
        }

        const attSettingsUpdate = company?.settings?.attendance || {};
        if (source === 'timesheet' && attSettingsUpdate.requireLocationTimesheet && !isAdmin) {
            if (!location || typeof location.lat !== 'number') {
                return res.status(400).json({ message: 'Location is required when submitting attendance from the timesheet.' });
            }
        }

        if (clockIn) {
            attendance.clockIn = new Date(clockIn);
            attendance.clockInIST = new Date(clockIn).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' });
        }
        if (clockOut) {
            attendance.clockOut = new Date(clockOut);
            attendance.clockOutIST = new Date(clockOut).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' });
        }
        if (location && typeof location.lat === 'number') {
            attendance.location = { lat: location.lat, lng: location.lng, accuracy: location.accuracy };
        }

        const policy = buildAttendancePolicy({
            company,
            user: attendance.user,
            attendanceDate: attendance.date,
            clockInTime: attendance.clockIn
        });
        applyPolicyMetadata(attendance, policy);

        if (policy.mode === 'present_only') {
            applyPresentOnlyRecord(attendance, '[Marked present by admin]');
        }

        await attendance.save();
        res.json(attendance);
    } catch (error) {
        console.error(error);
        res.status(500).json({ message: 'Server Error' });
    }
};

exports.deleteAttendance = async (req, res) => {
    try {
        const attendance = await Attendance.findOne({ _id: req.params.id, companyId: req.companyId }).populate('user');
        if (!attendance) return res.status(404).json({ message: 'Attendance record not found' });

        const isAdmin = req.user.roles?.some(r =>
            (typeof r === 'string' && r === 'Admin') ||
            (typeof r === 'object' && r.name === 'Admin')
        ) || req.user.permissions?.includes('*') || req.user.permissions?.includes('attendance.update_others');

        const isOwner = attendance.user?._id.toString() === req.user._id.toString();
        const isManager = attendance.user?.reportingManagers?.some(m => m.toString() === req.user._id.toString());

        if (!isOwner && !isManager && !isAdmin) {
            return res.status(403).json({ message: 'Not authorized to delete this attendance record' });
        }

        const company = req.company || await Company.findById(req.companyId).select('settings.timesheet settings.attendance').lean();
        const editability = await ensureTimesheetPeriodEditable({
            company,
            companyId: req.companyId,
            userId: attendance.user?._id || attendance.user,
            dateValue: attendance.date
        });
        if (!editability.ok) {
            return res.status(400).json({ message: editability.message });
        }

        if (parseDateAsIST(attendance.date) > getStartOfDayIST() && !canUpdateFutureRecords(req.user)) {
            return res.status(403).json({ message: 'Not authorized to delete attendance for future dates' });
        }

        await Attendance.deleteOne({ _id: attendance._id, companyId: req.companyId });
        res.json({ message: 'Attendance deleted successfully', id: attendance._id.toString() });
    } catch (error) {
        console.error(error);
        res.status(500).json({ message: 'Server Error' });
    }
};

exports.approveAttendance = async (req, res) => {
    try {
        const attendance = await Attendance.findOne({ _id: req.params.id, companyId: req.companyId }).populate('user');
        if (!attendance) return res.status(404).json({ message: 'Attendance record not found' });

        const isAdmin = req.user.roles?.some(r => 
            (typeof r === 'string' && r === 'Admin') || 
            (typeof r === 'object' && r.name === 'Admin')
        ) || req.user.permissions?.includes('*');

        const isManager = attendance.user?.reportingManagers?.some(m => m.toString() === req.user._id.toString());

        if (!isAdmin && !isManager) {
            return res.status(403).json({ message: 'Not authorized to approve this attendance' });
        }

        attendance.approvalStatus = 'APPROVED';
        attendance.approvedBy = req.user._id;
        await attendance.save();

        res.json(attendance);
    } catch (error) {
        console.error(error);
        res.status(500).json({ message: 'Server Error' });
    }
};

exports.getPendingRequests = async (req, res) => {
    try {
        const isAdmin = req.user.roles?.some(r => 
            (typeof r === 'string' && r === 'Admin') || 
            (typeof r === 'object' && r.name === 'Admin')
        ) || req.user.permissions?.includes('*');

        let query = { companyId: req.companyId, approvalStatus: 'PENDING' };

        if (!isAdmin) {
            const directReports = await User.find({ 
                companyId: req.companyId, 
                reportingManagers: req.user._id 
            }).select('_id');
            const reportIds = directReports.map(u => u._id);
            
            query.user = { $in: reportIds };
        }

        const requests = await Attendance.find(query)
            .populate('user', 'firstName lastName employeeCode')
            .sort({ date: -1 })
            .lean();
            
        res.json(requests);
    } catch (error) {
        console.error(error);
        res.status(500).json({ message: 'Server Error' });
    }
};
