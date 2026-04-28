const Attendance = require('../models/Attendance');
const AttendanceRegularization = require('../models/AttendanceRegularization');
const Timesheet = require('../models/Timesheet');
const User = require('../models/User');
const Project = require('../models/Project');
const Holiday = require('../models/Holiday');
const Company = require('../models/Company');
const { startOfDay, endOfDay, format, differenceInCalendarDays, subDays, startOfMonth, endOfMonth, eachDayOfInterval, isSameDay, getDaysInMonth } = require('date-fns');
const LeaveRequest = require('../models/LeaveRequest');
const LeaveConfig = require('../models/LeaveConfig');
const NotificationService = require('../services/notificationService');
const {
    getISTTime,
    getStartOfDayIST,
    parseDateAsIST,
    buildAttendancePolicy,
    isWithinShiftWindow,
    buildEndOfDayIST
} = require('../utils/attendancePolicy');

const getTimesheetPeriodIdForDate = (dateValue, cycle = 'Monthly') => {
    const date = new Date(dateValue);
    if (cycle === 'Weekly') return format(date, "yyyy-'W'II");
    if (cycle === 'Daily') return format(date, 'yyyy-MM-dd');
    return format(date, 'yyyy-MM');
};

const ensureTimesheetPeriodEditable = async ({ company, companyId, userId, dateValue }) => {
    const cycle = company?.settings?.timesheet?.approvalCycle || 'Monthly';
    const periodId = getTimesheetPeriodIdForDate(dateValue, cycle);
    const timesheet = await Timesheet.findOne({ user: userId, month: periodId, companyId }).select('status').lean();

    if (timesheet && (timesheet.status === 'SUBMITTED' || timesheet.status === 'APPROVED')) {
        return {
            ok: false,
            message: `Cannot modify attendance for a ${timesheet.status.toLowerCase()} timesheet period.`
        };
    }

    return { ok: true };
};

// Helper to extract clean IP address, handling proxies
const getClientIp = (req) => {
    let ip = req.headers['x-forwarded-for'] || req.ip || req.connection?.remoteAddress || req.socket?.remoteAddress;
    if (ip && ip.includes(',')) {
        ip = ip.split(',')[0].trim();
    }
    if (ip === '::1' || ip === '::ffff:127.0.0.1') {
        ip = '127.0.0.1';
    }
    return ip;
};

// Haversine formula to calculate distance between two coordinates in meters
const calculateDistance = (lat1, lon1, lat2, lon2) => {
    const R = 6371e3;
    const φ1 = lat1 * Math.PI / 180;
    const φ2 = lat2 * Math.PI / 180;
    const Δφ = (lat2 - lat1) * Math.PI / 180;
    const Δλ = (lon2 - lon1) * Math.PI / 180;
    const a = Math.sin(Δφ / 2) * Math.sin(Δφ / 2) +
              Math.cos(φ1) * Math.cos(φ2) *
              Math.sin(Δλ / 2) * Math.sin(Δλ / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c;
};

const getAttendanceSettings = (company) => company?.settings?.attendance || {};

const applyPolicyMetadata = (attendance, policy) => {
    attendance.attendanceMode = policy.mode;
    attendance.shiftCode = policy.shift?.code || null;
    attendance.shiftName = policy.shift?.name || null;
    attendance.shiftType = policy.shift?.shiftType || null;
    attendance.shiftStartTime = policy.shift?.startTime || null;
    attendance.shiftEndTime = policy.shift?.endTime || null;
    attendance.maxWorkingHours = policy.maxWorkingHours || null;
    attendance.autoCheckoutAt = policy.autoCheckoutAt || null;
};

const applyPresentOnlyRecord = (attendance, note = '[Marked present]') => {
    attendance.clockIn = null;
    attendance.clockInIST = null;
    attendance.clockOut = null;
    attendance.clockOutIST = null;
    attendance.autoCheckoutAt = null;
    attendance.autoCheckoutReason = null;

    if (note) {
        attendance.notes = attendance.notes?.includes(note)
            ? attendance.notes
            : (attendance.notes ? `${attendance.notes} ${note}` : note);
    }
};

const finalizeCheckout = async (attendance, checkoutTime, reason = '') => {
    attendance.clockOut = checkoutTime;
    attendance.clockOutIST = getISTTime(checkoutTime);
    attendance.status = 'PRESENT';
    if (reason) {
        attendance.autoCheckoutReason = reason;
        attendance.notes = attendance.notes ? `${attendance.notes} ${reason}` : reason;
    }
    await attendance.save();
    return attendance;
};

// @desc    Get today's attendance status
exports.getTodayStatus = async (req, res) => {
    try {
        const today = getStartOfDayIST();
        const attendance = await Attendance.findOne({
            user: req.user._id,
            companyId: req.companyId,
            date: {
                $gte: today,
                $lt: new Date(today.getTime() + 24 * 60 * 60 * 1000)
            }
        })
        .select('user clockIn clockInIST clockOut clockOutIST status attendanceMode shiftCode shiftName shiftType shiftStartTime shiftEndTime maxWorkingHours autoCheckoutAt autoCheckoutReason')
        .lean();
        res.json(attendance || { status: 'Not Clocked In' });
    } catch (error) {
        console.error('getTodayStatus error:', error);
        res.status(500).json({ message: 'Server Error' });
    }
};

// @desc    Clock In
exports.clockIn = async (req, res) => {
    console.log('[DEBUG] Clock-In Request:', { body: req.body, user: req.user?._id, companyId: req.companyId });
    try {
        const company = req.company || await require('../models/Company').findById(req.companyId);
        const attSettings = getAttendanceSettings(company);
        const today = getStartOfDayIST();
        const now = new Date();
        const basePolicy = buildAttendancePolicy({
            company,
            user: req.user,
            attendanceDate: now
        });

        if (req.user.joiningDate && today < new Date(req.user.joiningDate)) {
            return res.status(400).json({ message: 'Cannot clock in before joining date.' });
        }

        let attendance = await Attendance.findOne({
            user: req.user._id,
            companyId: req.companyId,
            date: {
                $gte: today,
                $lt: new Date(today.getTime() + 24 * 60 * 60 * 1000)
            }
        });

        if (attendance && attendance.clockIn) {
            return res.status(400).json({ message: 'Already clocked in for today' });
        }

        if (attendance && attendance.attendanceMode === 'present_only' && attendance.status === 'PRESENT') {
            return res.status(400).json({ message: 'Already marked present for today' });
        }

        if (!attendance) {
            attendance = new Attendance({
                user: req.user._id,
                companyId: req.companyId,
                date: today,
                status: 'PRESENT'
            });
        }

        const location = req.body?.location;
        if (attSettings.ipCheck && attSettings.allowedIps?.length > 0) {
            const clientIp = getClientIp(req);
            if (!attSettings.allowedIps.includes(clientIp)) {
                return res.status(403).json({ message: `Clock-in rejected: IP ${clientIp} not authorized.` });
            }
        }

        if (attSettings.requireLocationCheckIn || attSettings.locationCheck) {
            if (!location || typeof location.lat !== 'number' || typeof location.lng !== 'number') {
                return res.status(400).json({ message: 'Device location is required to clock in.' });
            }
        }

        if (attSettings.locationCheck && attSettings.coordinates?.lat && attSettings.coordinates?.lng) {
            const distance = calculateDistance(location.lat, location.lng, attSettings.coordinates.lat, attSettings.coordinates.lng);
            const allowedLimit = attSettings.allowedRadius || 200;
            if (distance > allowedLimit) {
                return res.status(403).json({ message: `Too far from office (${Math.round(distance)}m).` });
            }
        }

        if (basePolicy.mode === 'clock_in_out' && !isWithinShiftWindow({ policy: basePolicy, currentTime: now })) {
            return res.status(400).json({
                message: `Attendance is allowed only during your shift window (${basePolicy.shift?.startTime || '--'} - ${basePolicy.shift?.endTime || '--'}).`
            });
        }

        attendance.clockIn = new Date();
        attendance.clockInIST = getISTTime(now);
        attendance.ipAddress = getClientIp(req);
        if (location && typeof location.lat === 'number') {
            attendance.location = { lat: location.lat, lng: location.lng, accuracy: location.accuracy };
        }
        attendance.userAgent = req.headers['user-agent'] || 'Unknown';
        attendance.status = 'PRESENT';

        const resolvedPolicy = buildAttendancePolicy({
            company,
            user: req.user,
            attendanceDate: now,
            clockInTime: now
        });
        applyPolicyMetadata(attendance, resolvedPolicy);

        if (resolvedPolicy.mode === 'present_only') {
            applyPresentOnlyRecord(attendance);
        }

        await attendance.save();
        res.json(attendance);
    } catch (error) {
        console.error('clockIn error:', error);
        res.status(500).json({ message: 'Server Error', error: error.message });
    }
};

// @desc    Clock Out
exports.clockOut = async (req, res) => {
    try {
        const company = req.company || await require('../models/Company').findById(req.companyId);
        const attSettings = getAttendanceSettings(company);
        const today = getStartOfDayIST();
        const now = new Date();

        let attendance = await Attendance.findOne({
            user: req.user._id,
            companyId: req.companyId,
            date: {
                $gte: today,
                $lt: new Date(today.getTime() + 24 * 60 * 60 * 1000)
            }
        });

        if (!attendance || !attendance.clockIn) {
            return res.status(400).json({ message: 'You must clock in first.' });
        }

        if (attendance.clockOut) {
            return res.status(400).json({ message: 'Already clocked out for today' });
        }

        if (attendance.attendanceMode === 'present_only') {
            return res.status(400).json({ message: 'This user only needs to mark present. Check-out is not required.' });
        }

        const location = req.body?.location;
        const policy = buildAttendancePolicy({
            company,
            user: req.user,
            attendanceDate: attendance.date,
            clockInTime: attendance.clockIn
        });
        applyPolicyMetadata(attendance, policy);

        if (attendance.autoCheckoutAt && now > new Date(attendance.autoCheckoutAt)) {
            await finalizeCheckout(attendance, new Date(attendance.autoCheckoutAt), '[Auto-checked out by shift policy]');
            return res.json(attendance);
        }

        attendance.clockOut = now;
        attendance.clockOutIST = getISTTime(now);
        attendance.clockOutIpAddress = getClientIp(req);
        if (location && typeof location.lat === 'number') {
            attendance.clockOutLocation = { lat: location.lat, lng: location.lng, accuracy: location.accuracy };
        }
        attendance.status = 'PRESENT';
        
        await attendance.save();
        res.json(attendance);
    } catch (error) {
        console.error('clockOut error:', error);
        res.status(500).json({ message: 'Server Error' });
    }
};

// ... (Rest of the functions rewritten as exports.name = ...)
// For now, I'll just write the core ones to fix the 500s.

exports.getMyAttendance = async (req, res) => {
    try {
        const { month } = req.query; // YYYY-MM
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

        // Support both ?month=YYYY-MM and ?year=YYYY&month=M
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
            .select('date clockIn clockInIST clockOut clockOutIST duration status user')
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

exports.updateAttendance = async (req, res) => {
    const { clockIn, clockOut } = req.body;
    try {
        const attendance = await Attendance.findOne({ _id: req.params.id, companyId: req.companyId }).populate('user');
        if (!attendance) return res.status(404).json({ message: 'Attendance record not found' });
        
        // Authorization Check
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

        if (clockIn) {
            attendance.clockIn = new Date(clockIn);
            attendance.clockInIST = new Date(clockIn).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' });
        }
        if (clockOut) {
            attendance.clockOut = new Date(clockOut);
            attendance.clockOutIST = new Date(clockOut).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' });
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

exports.createAttendance = async (req, res) => {
    try {
        const { date, clockIn, clockOut, userId } = req.body;
        const targetUserId = userId || req.user._id;

        // Authorization Check
        const isAdmin = req.user.roles?.some(r => 
            (typeof r === 'string' && r === 'Admin') || 
            (typeof r === 'object' && r.name === 'Admin')
        ) || req.user.permissions?.includes('*') || req.user.permissions?.includes('attendance.update_others');

        const isSelf = targetUserId.toString() === req.user._id.toString();
        
        // If not self and not admin/privileged, check if manager
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
                .select('attendanceMode attendanceShiftCode')
                .lean()
        ]);

        if (!targetUser) {
            return res.status(404).json({ message: 'User not found' });
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
        const newAttendance = new Attendance({
            user: targetUserId,
            companyId: req.companyId,
            date: attendanceDate,
            status: 'PRESENT',
            clockIn: clockIn ? new Date(clockIn) : null,
            clockOut: clockOut ? new Date(clockOut) : null,
            clockInIST: clockIn ? new Date(clockIn).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }) : null,
            clockOutIST: clockOut ? new Date(clockOut).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }) : null,
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
        res.status(500).json({ message: 'Server Error' });
    }
};

exports.approveAttendance = async (req, res) => {
    try {
        const attendance = await Attendance.findOne({ _id: req.params.id, companyId: req.companyId }).populate('user');
        if (!attendance) return res.status(404).json({ message: 'Attendance record not found' });

        // Robust Admin check
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
        // Robust Admin check
        const isAdmin = req.user.roles?.some(r => 
            (typeof r === 'string' && r === 'Admin') || 
            (typeof r === 'object' && r.name === 'Admin')
        ) || req.user.permissions?.includes('*');

        let query = { companyId: req.companyId, approvalStatus: 'PENDING' };

        if (!isAdmin) {
            // Find direct reports
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

exports.getTeamAttendanceReport = async (req, res) => {
    try {
        const { year, month, date } = req.query;
        
        // Determine user filter (Admin vs Manager)
        // Check roles - assuming roles might be objects or IDs
        const isAdmin = req.user.roles?.some(r => 
            (typeof r === 'string' && r === 'Admin') || 
            (typeof r === 'object' && r.name === 'Admin')
        ) || req.user.permissions?.includes('*');

        let userFilter = { companyId: req.companyId, isActive: true };
        if (!isAdmin) {
            userFilter.reportingManagers = req.user._id;
        }

        const teamMembers = await User.find(userFilter).select('_id firstName lastName employeeCode designation profileImage').lean();

        let attendanceQuery = { user: { $in: teamMembers.map(m => m._id) }, companyId: req.companyId };

        if (year && month) {
            const resolvedMonth = `${year}-${String(month).padStart(2, '0')}`;
            const start = parseDateAsIST(resolvedMonth + '-01');
            const end = new Date(start);
            end.setMonth(end.getMonth() + 1);
            attendanceQuery.date = { $gte: start, $lt: end };
        } else if (date) {
            const targetDate = parseDateAsIST(date);
            attendanceQuery.date = { $gte: targetDate, $lt: new Date(targetDate.getTime() + 24 * 60 * 60 * 1000) };
        } else {
            const today = getStartOfDayIST();
            attendanceQuery.date = { $gte: today, $lt: new Date(today.getTime() + 24 * 60 * 60 * 1000) };
        }

        // Fetch Holidays
        let holidayQuery = { companyId: req.companyId };
        if (year && month) {
            const resolvedMonth = `${year}-${String(month).padStart(2, '0')}`;
            const start = new Date(resolvedMonth + '-01');
            const end = new Date(start);
            end.setMonth(end.getMonth() + 1);
            holidayQuery.date = { $gte: start, $lt: end };
        } else if (date) {
            const targetDate = new Date(date);
            holidayQuery.date = { $gte: targetDate, $lt: new Date(targetDate.getTime() + 24 * 60 * 60 * 1000) };
        }
        const holidays = await Holiday.find(holidayQuery).lean();

        // Fetch Approved Leaves
        let leaveQuery = { 
            companyId: req.companyId, 
            status: 'Approved',
            user: { $in: teamMembers.map(m => m._id) }
        };

        if (year && month) {
            const start = startOfMonth(new Date(`${year}-${String(month).padStart(2, '0')}-01`));
            const end = endOfMonth(start);
            leaveQuery.$or = [
                { startDate: { $gte: start, $lte: end } },
                { endDate: { $gte: start, $lte: end } },
                { startDate: { $lte: start }, endDate: { $gte: end } }
            ];
        }

        const leaves = await LeaveRequest.find(leaveQuery).lean();
        const leaveConfigs = await LeaveConfig.find({ companyId: req.companyId }).select('leaveType sandwichRule').lean();
        const sandwichMap = leaveConfigs.reduce((acc, c) => ({ ...acc, [c.leaveType]: c.sandwichRule }), {});

        const leaveRecords = leaves.map(l => ({
            ...l,
            sandwichRule: sandwichMap[l.leaveType] || false
        }));

        const attendanceRecords = await Attendance.find(attendanceQuery).lean();
        const company = await Company.findById(req.companyId);
        const weeklyOff = company?.settings?.attendance?.weeklyOff || ['Saturday', 'Sunday'];

        res.json({ teamMembers, attendanceRecords, holidays, leaveRecords, weeklyOff });
    } catch (error) {
        console.error('getTeamAttendanceReport error:', error);
        res.status(500).json({ message: 'Server Error' });
    }
};

exports.exportTeamAttendanceExcel = async (req, res) => {
    try {
        const { year, month } = req.query;
        if (!year || !month) return res.status(400).json({ message: 'Year and Month are required' });

        // Fetch Company settings for weekly offs
        const company = await Company.findById(req.companyId);
        const weeklyOffs = company?.settings?.attendance?.weeklyOff || ['Saturday', 'Sunday'];

        const ExcelJS = require('exceljs');
        const workbook = new ExcelJS.Workbook();
        const sheet = workbook.addWorksheet('Team Attendance');

        // Reuse Admin/Manager logic
        const isAdmin = req.user.roles?.some(r => 
            (typeof r === 'string' && r === 'Admin') || 
            (typeof r === 'object' && r.name === 'Admin')
        ) || req.user.permissions?.includes('*');

        let userFilter = { companyId: req.companyId, isActive: true };
        if (!isAdmin) {
            userFilter.reportingManagers = req.user._id;
        }

        const teamMembers = await User.find(userFilter).select('_id firstName lastName employeeCode designation').lean();
        const userIds = teamMembers.map(m => m._id);

        const startDate = parseDateAsIST(`${year}-${String(month).padStart(2, '0')}-01`);
        const endDate = endOfMonth(startDate);
        const days = eachDayOfInterval({ start: startDate, end: endDate });

        // Fetch Data
        const attendanceRecords = await Attendance.find({ 
            user: { $in: userIds }, 
            companyId: req.companyId,
            date: { $gte: startDate, $lte: endDate }
        }).lean();

        const holidays = await Holiday.find({ 
            companyId: req.companyId, 
            date: { $gte: startDate, $lte: endDate } 
        }).lean();

        const leaves = await LeaveRequest.find({ 
            companyId: req.companyId, 
            user: { $in: userIds },
            status: 'Approved',
            $or: [
                { startDate: { $gte: startDate, $lte: endDate } },
                { endDate: { $gte: startDate, $lte: endDate } },
                { startDate: { $lte: startDate }, endDate: { $gte: endDate } }
            ]
        }).lean();

        const leaveConfigs = await LeaveConfig.find({ companyId: req.companyId }).select('leaveType sandwichRule').lean();
        const sandwichMap = leaveConfigs.reduce((acc, c) => ({ ...acc, [c.leaveType]: c.sandwichRule }), {});

        // Styling
        const headerStyle = { font: { bold: true }, fill: { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE0E0E0' } }, border: { top: { style: 'thin' }, left: { style: 'thin' }, bottom: { style: 'thin' }, right: { style: 'thin' } } };

        // Headers
        const headers = ['Employee Code', 'Employee Name'];
        days.forEach(day => headers.push(format(day, 'dd-EEE')));
        headers.push('Present', 'Holiday', 'Weekoff', 'Leave', 'Absent');
        sheet.addRow(headers);
        sheet.getRow(1).eachCell(cell => Object.assign(cell, headerStyle));

        // Rows
        teamMembers.forEach(member => {
            const rowData = [member.employeeCode, `${member.firstName} ${member.lastName}`];
            let presentCount = 0;
            let holidayCount = 0;
            let weekoffCount = 0;
            let leaveCount = 0;
            let absentCount = 0;

            days.forEach(day => {
                const dayStr = format(day, 'yyyy-MM-dd');
                const dayName = format(day, 'EEEE');
                
                // 1. Identification
                const holiday = holidays.find(h => format(new Date(h.date), 'yyyy-MM-dd') === dayStr);
                const isWeeklyOff = weeklyOffs.some(woff => woff.trim().toLowerCase() === dayName.toLowerCase());
                
                const onLeave = leaves.find(l => {
                    if (l.user.toString() !== member._id.toString()) return false;
                    const lStart = startOfDay(new Date(l.startDate));
                    const lEnd = startOfDay(new Date(l.endDate));
                    const current = startOfDay(day);
                    return current >= lStart && current <= lEnd;
                });

                // 2. Status Priority Logic
                
                // If on leave, check if it should override Weekend/Holiday (Sandwich Rule)
                if (onLeave) {
                    const isOffDay = !!holiday || isWeeklyOff;
                    const carriesSandwich = sandwichMap[onLeave.leaveType] || false;
                    
                    if (!isOffDay || carriesSandwich) {
                        rowData.push('L');
                        leaveCount++;
                        return;
                    }
                }

                // If not leave (or leaf didn't sandwich), check holiday
                if (holiday) {
                    rowData.push('H');
                    holidayCount++;
                    return;
                }

                // If not holiday, check weekly off
                if (isWeeklyOff) {
                    rowData.push('WO');
                    weekoffCount++;
                    return;
                }

                // 4. Check Attendance (Priority 4 - Working Days)
                const hasAtt = attendanceRecords.find(a => 
                    a.user.toString() === member._id.toString() && 
                    format(new Date(a.date), 'yyyy-MM-dd') === dayStr
                );

                if (hasAtt) {
                    rowData.push('P');
                    presentCount++;
                } else {
                    rowData.push('A');
                    absentCount++;
                }
            });

            rowData.push(presentCount, holidayCount, weekoffCount, leaveCount, absentCount);
            const row = sheet.addRow(rowData);

            // Conditional Styling for row cells
            row.eachCell((cell, colNumber) => {
                if (colNumber > 2 && colNumber <= (2 + days.length)) {
                    const val = cell.value;
                    if (val === 'P') cell.font = { color: { argb: 'FF008000' }, bold: true }; // Green
                    if (val === 'A') cell.font = { color: { argb: 'FFFF0000' } }; // Red
                    if (val === 'H') {
                        cell.font = { color: { argb: 'FFFF8C00' }, bold: true }; // Dark Orange
                        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFF4E5' } };
                    }
                    if (val === 'L') {
                        cell.font = { color: { argb: 'FF0000FF' }, bold: true }; // Blue
                        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE6E6FF' } };
                    }
                    if (val === 'WO') {
                        cell.font = { color: { argb: 'FF808080' } }; // Gray
                        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF0F0F0' } };
                    }
                    cell.alignment = { horizontal: 'center' };
                }
            });
        });

        // Column widths
        sheet.columns.forEach((col, i) => {
            if (i < 2) col.width = 20;
            else if (i < 2 + days.length) col.width = 8; // Wider for dd-EEE
            else col.width = 10;
        });

        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.setHeader('Content-Disposition', `attachment; filename="Attendance_Report_${month}_${year}.xlsx"`);

        await workbook.xlsx.write(res);
        res.end();

    } catch (error) {
        console.error('exportTeamAttendanceExcel error:', error);
        res.status(500).json({ message: 'Server Error' });
    }
};

exports.requestRegularization = async (req, res) => {
    try {
        const { date, reason, type, requestedClockIn, requestedClockOut } = req.body;
        
        // 1. Restriction: Only allowed for last 4 working days
        const normalizedTargetDate = parseDateAsIST(date);
        const today = getStartOfDayIST();

        // Fetch Company settings for weekly offs
        const company = await Company.findById(req.companyId);
        const weeklyOffs = company?.settings?.attendance?.weeklyOff || ['Saturday', 'Sunday'];
        
        // Fetch Holidays for this year
        const holidays = await Holiday.find({ 
            companyId: req.companyId,
            year: today.getFullYear()
        });
        const holidayDates = holidays.map(h => format(new Date(h.date), 'yyyy-MM-dd'));

        // 1a. Check if target date is a Weekly Off or Holiday
        const targetDayName = format(normalizedTargetDate, 'EEEE');
        const targetDateStr = format(normalizedTargetDate, 'yyyy-MM-dd');

        if (weeklyOffs.includes(targetDayName)) {
            return res.status(400).json({ message: `Regularization not allowed on weekly off days (${targetDayName}).` });
        }
        if (holidayDates.includes(targetDateStr)) {
            return res.status(400).json({ message: 'Regularization not allowed on holidays.' });
        }
        if (normalizedTargetDate > today) {
            return res.status(400).json({ message: 'Regularization not allowed for future dates.' });
        }

        // 1b. Calculate 4 working days ago
        let workingDaysCount = 0;
        let checkDate = new Date(today);
        let maxLookback = 30; // Safety break

        while (workingDaysCount < 4 && maxLookback > 0) {
            checkDate = subDays(checkDate, 1);
            const dayName = format(checkDate, 'EEEE');
            const dateStr = format(checkDate, 'yyyy-MM-dd');
            
            const isWeeklyOff = weeklyOffs.includes(dayName);
            const isHoliday = holidayDates.includes(dateStr);

            if (!isWeeklyOff && !isHoliday) {
                workingDaysCount++;
            }
            maxLookback--;
        }

        const fourWorkingDaysAgo = startOfDay(checkDate);

        if (normalizedTargetDate < fourWorkingDaysAgo) {
            return res.status(400).json({ message: 'Regularization only allowed for the last 4 working days.' });
        }

        // 2. Set Manager (use the first reporting manager as an ObjectId)
        let manager = null;
        if (req.user.reportingManagers && req.user.reportingManagers.length > 0) {
            // Support both populated and unpopulated managers
            const m = req.user.reportingManagers[0];
            manager = m._id || m;
        }

        const request = new AttendanceRegularization({
            user: req.user._id,
            companyId: req.companyId,
            date,
            reason,
            type,
            requestedClockIn,
            requestedClockOut,
            manager
        });
        await request.save();

        // Notify managers
        try {
            const io = req.app.get('io');
            const reportingManagers = req.user.reportingManagers || [];
            const notifyTargets = new Set();
            
            reportingManagers.forEach(m => {
                const id = m && (m._id ? m._id.toString() : m.toString());
                if (id) notifyTargets.add(id);
            });
            if (manager) notifyTargets.add(manager.toString());

            const notifications = Array.from(notifyTargets).map(targetId => ({
                user: targetId,
                companyId: req.companyId,
                title: 'New Regularization Request',
                message: `${req.user.firstName} has requested attendance regularization for ${format(new Date(date), 'dd MMM yyyy')}.`,
                type: 'Approval',
                link: '/attendance?tab=regularize',
                metadata: { regularizationId: request._id }
            }));

            if (notifications.length > 0) {
                await NotificationService.createManyNotifications(io, notifications);
            }
        } catch (notifErr) {
            console.error('Regularization request notification error:', notifErr);
        }

        res.status(201).json(request);
    } catch (error) {
        console.error(error);
        res.status(500).json({ message: 'Server Error' });
    }
};

exports.getRegularizationRequests = async (req, res) => {
    try {
        // Robust Admin check: check for Admin role in various formats
        const isAdmin = req.user.roles?.some(r => 
            (typeof r === 'string' && r === 'Admin') || 
            (typeof r === 'object' && r.name === 'Admin')
        ) || req.user.permissions?.includes('*');

        let query = { companyId: req.companyId };
        
        if (!isAdmin) {
            // Find direct reports to allow any manager to see their reports' requests
            const directReports = await User.find({ 
                companyId: req.companyId, 
                reportingManagers: req.user._id 
            }).select('_id');
            const reportIds = directReports.map(u => u._id);

            query = { 
                companyId: req.companyId,
                $or: [
                    { user: req.user._id },
                    { manager: req.user._id },
                    { user: { $in: reportIds } }
                ]
            };
        }

        const requests = await AttendanceRegularization.find(query)
            .populate('user', 'firstName lastName employeeCode')
            .populate('manager', 'firstName lastName')
            .sort({ createdAt: -1 })
            .lean();
            
        res.json(requests);
    } catch (error) {
        console.error(error);
        res.status(500).json({ message: 'Server Error' });
    }
};

exports.processRegularizationRequest = async (req, res) => {
    try {
        const { status, rejectionReason } = req.body;
        const request = await AttendanceRegularization.findOne({ _id: req.params.id, companyId: req.companyId });
        if (!request) return res.status(404).json({ message: 'Request not found' });

        // Authorization check: Only Admin, reporting manager, or permission holder can process
        const isAdmin = req.user.roles?.some(r => 
            (typeof r === 'string' && r === 'Admin') || 
            (typeof r === 'object' && r.name === 'Admin')
        ) || req.user.permissions?.includes('*') || req.user.permissions?.includes('attendance.update_others');

        const requestUser = await User.findById(request.user);
        const isReportingManager = requestUser?.reportingManagers?.some(m => m.toString() === req.user._id.toString());
        const isAssignedManager = request.manager && request.manager.toString() === req.user._id.toString();

        if (!isAdmin && !isReportingManager && !isAssignedManager) {
            return res.status(403).json({ message: 'Not authorized to process this request' });
        }

        request.status = status;
        request.approvedBy = req.user._id;
        if (status === 'APPROVED') {
            let attendance = await Attendance.findOne({ user: request.user, companyId: req.companyId, date: request.date });
            if (!attendance) {
                attendance = new Attendance({ user: request.user, companyId: req.companyId, date: parseDateAsIST(request.date), status: 'PRESENT' });
            }
            if (request.requestedClockIn) {
                attendance.clockIn = request.requestedClockIn;
                attendance.clockInIST = new Date(request.requestedClockIn).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' });
            }
            if (request.requestedClockOut) {
                attendance.clockOut = request.requestedClockOut;
                attendance.clockOutIST = new Date(request.requestedClockOut).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' });
            }
            attendance.approvalStatus = 'APPROVED';

            const company = req.company || await Company.findById(req.companyId).select('settings.attendance').lean();
            const policy = buildAttendancePolicy({
                company,
                user: requestUser,
                attendanceDate: attendance.date,
                clockInTime: attendance.clockIn
            });
            applyPolicyMetadata(attendance, policy);

            if (policy.mode === 'present_only') {
                applyPresentOnlyRecord(attendance, '[Marked present by regularization]');
            }

            await attendance.save();
        }
        await request.save();

        // Notify Employee
        try {
            const io = req.app.get('io');
            await NotificationService.createNotification(io, {
                user: request.user,
                companyId: req.companyId,
                title: `Regularization ${status === 'APPROVED' ? 'Approved' : 'Rejected'}`,
                message: `Your regularization request for ${format(new Date(request.date), 'dd MMM yyyy')} has been ${status.toLowerCase()}.`,
                type: 'Info',
                link: '/attendance?tab=regularize',
                metadata: { regularizationId: request._id, status }
            });
        } catch (notifErr) {
            console.error('Regularization process notification error:', notifErr);
        }

        res.json(request);
    } catch (error) {
        console.error(error);
        res.status(500).json({ message: 'Server Error' });
    }
};
