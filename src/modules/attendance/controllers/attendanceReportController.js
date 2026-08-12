const Attendance = require('../model/attendance.model');
const User = require('../../user/user.model');
const Company = require('../../company/company.model');
const Holiday = require('../../holiday/holiday.model');
const LeaveRequest = require('../../leave/model/leaveRequest.model');
const LeaveConfig = require('../../leave/model/leaveConfig.model');
const { parseDateAsIST, getStartOfDayIST } = require('../attendancePolicy');
const { startOfDay, format, startOfMonth, endOfMonth, getDaysInMonth } = require('date-fns');
const { buildTimesheetPeriodRange, toLocalTimezoneRep } = require('../../timesheet/timesheetPeriod');

exports.getTeamAttendanceReport = async (req, res) => {
    try {
        const { year, month, date } = req.query;
        
        const canViewAll = req.user.roles?.some(r => 
            (typeof r === 'string' && r === 'Admin') || 
            (typeof r === 'object' && r.name === 'Admin')
        ) || req.user.permissions?.includes('*') || req.user.permissions?.includes('user.read') || req.user.permissions?.includes('attendance.view_all') || req.user.permissions?.includes('attendance.view_others');

        let userFilter = { companyId: req.companyId, isActive: true };
        if (!canViewAll) {
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

        const company = await Company.findById(req.companyId);
        const weeklyOffs = company?.settings?.attendance?.weeklyOff || ['Saturday', 'Sunday'];

        const ExcelJS = require('exceljs');
        const workbook = new ExcelJS.Workbook();
        const sheet = workbook.addWorksheet('Team Attendance');

        const canViewAll = req.user.roles?.some(r => 
            (typeof r === 'string' && r === 'Admin') || 
            (typeof r === 'object' && r.name === 'Admin')
        ) || req.user.permissions?.includes('*') || req.user.permissions?.includes('user.read') || req.user.permissions?.includes('attendance.view_all') || req.user.permissions?.includes('attendance.view_others');

        let userFilter = { companyId: req.companyId, isActive: true };
        if (!canViewAll) {
            userFilter.reportingManagers = req.user._id;
        }

        const teamMembers = await User.find(userFilter).select('_id firstName lastName employeeCode designation').lean();
        const userIds = teamMembers.map(m => m._id);

        const { start: startDate, end: endDate } = buildTimesheetPeriodRange(`${year}-${String(month).padStart(2, '0')}`, 'Monthly');
        const daysInMonth = getDaysInMonth(toLocalTimezoneRep(startDate));
        const days = [];
        for (let d = 1; d <= daysInMonth; d++) {
            days.push(new Date(`${year}-${String(month).padStart(2, '0')}-${String(d).padStart(2, '0')}T00:00:00.000+05:30`));
        }

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
                { startDate: { $lte: start }, endDate: { $gte: endDate } }
            ]
        }).lean();

        const leaveConfigs = await LeaveConfig.find({ companyId: req.companyId }).select('leaveType sandwichRule').lean();
        const sandwichMap = leaveConfigs.reduce((acc, c) => ({ ...acc, [c.leaveType]: c.sandwichRule }), {});

        const headerStyle = { font: { bold: true }, fill: { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE0E0E0' } }, border: { top: { style: 'thin' }, left: { style: 'thin' }, bottom: { style: 'thin' }, right: { style: 'thin' } } };

        const headers = ['Employee Code', 'Employee Name'];
        days.forEach(day => headers.push(format(toLocalTimezoneRep(day), 'dd-EEE')));
        headers.push('Present', 'Holiday', 'Weekoff', 'Leave', 'Absent');
        sheet.addRow(headers);
        sheet.getRow(1).eachCell(cell => Object.assign(cell, headerStyle));

        teamMembers.forEach(member => {
            const rowData = [member.employeeCode, `${member.firstName} ${member.lastName}`];
            let presentCount = 0;
            let holidayCount = 0;
            let weekoffCount = 0;
            let leaveCount = 0;
            let absentCount = 0;

            days.forEach(day => {
                const localDay = toLocalTimezoneRep(day);
                const dayStr = format(localDay, 'yyyy-MM-dd');
                const dayName = format(localDay, 'EEEE');
                
                const holiday = holidays.find(h => format(toLocalTimezoneRep(h.date), 'yyyy-MM-dd') === dayStr);
                const isWeeklyOff = weeklyOffs.some(woff => woff.trim().toLowerCase() === dayName.toLowerCase());
                
                const onLeave = leaves.find(l => {
                    if (l.user.toString() !== member._id.toString()) return false;
                    const lStart = startOfDay(toLocalTimezoneRep(l.startDate));
                    const lEnd = startOfDay(toLocalTimezoneRep(l.endDate));
                    const current = startOfDay(localDay);
                    return current >= lStart && current <= lEnd;
                });

                if (onLeave) {
                    const isOffDay = !!holiday || isWeeklyOff;
                    const carriesSandwich = sandwichMap[onLeave.leaveType] || false;
                    
                    if (!isOffDay || carriesSandwich) {
                        rowData.push('L');
                        leaveCount++;
                        return;
                    }
                }

                if (holiday) {
                    rowData.push('H');
                    holidayCount++;
                    return;
                }

                if (isWeeklyOff) {
                    rowData.push('WO');
                    weekoffCount++;
                    return;
                }

                const hasAtt = attendanceRecords.find(a => 
                    a.user.toString() === member._id.toString() && 
                    format(toLocalTimezoneRep(a.date), 'yyyy-MM-dd') === dayStr
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

            row.eachCell((cell, colNumber) => {
                if (colNumber > 2 && colNumber <= (2 + days.length)) {
                    const val = cell.value;
                    if (val === 'P') cell.font = { color: { argb: 'FF008000' }, bold: true };
                    if (val === 'A') cell.font = { color: { argb: 'FFFF0000' } };
                    if (val === 'H') {
                        cell.font = { color: { argb: 'FFFF8C00' }, bold: true };
                        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFF4E5' } };
                    }
                    if (val === 'L') {
                        cell.font = { color: { argb: 'FF0000FF' }, bold: true };
                        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE6E6FF' } };
                    }
                    if (val === 'WO') {
                        cell.font = { color: { argb: 'FF808080' } };
                        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF0F0F0' } };
                    }
                    cell.alignment = { horizontal: 'center' };
                }
            });
        });

        sheet.columns.forEach((col, i) => {
            if (i < 2) col.width = 20;
            else if (i < 2 + days.length) col.width = 8;
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

exports.updateCustomFlexibleOffDays = async (req, res) => {
    try {
        const { flexibleOffDays, userId } = req.body;
        const targetUserId = userId || req.user._id;

        if (String(targetUserId) !== String(req.user._id)) {
            const isAdmin = req.user.roles?.some(r =>
                (typeof r === 'string' && r === 'Admin') ||
                (typeof r === 'object' && r?.name === 'Admin')
            ) || req.user.permissions?.includes('*') || req.user.permissions?.includes('admin');

            const isManager = req.user.directReports?.some(id => String(id) === String(targetUserId));
            if (!isAdmin && !isManager) {
                return res.status(403).json({ message: 'Not authorized to update flexible off days for this user' });
            }
        }

        const userToUpdate = await User.findOne({ _id: targetUserId, companyId: req.companyId });
        if (!userToUpdate) {
            return res.status(404).json({ message: 'User not found' });
        }

        const flexDaysArray = Array.isArray(flexibleOffDays)
            ? flexibleOffDays.map(d => String(d).trim()).filter(Boolean)
            : [];

        userToUpdate.customFlexibleOffDays = flexDaysArray;
        await userToUpdate.save();

        res.json({
            message: 'Flexible off days updated successfully',
            customFlexibleOffDays: userToUpdate.customFlexibleOffDays
        });
    } catch (error) {
        console.error('updateCustomFlexibleOffDays error:', error);
        res.status(500).json({ message: 'Failed to save flexible off days', error: error.message });
    }
};
