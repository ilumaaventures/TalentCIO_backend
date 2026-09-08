const Attendance = require('../model/attendance.model');
const AttendanceRegularization = require('../model/attendanceRegularization.model');
const User = require('../../user/user.model');
const Role = require('../../user/role.model');
const Company = require('../../company/company.model');
const NotificationService = require('../../../services/notificationService');
const { getISTTime, getStartOfDayIST, buildAttendancePolicy } = require('../attendancePolicy');
const {
    ensureTimesheetPeriodEditable,
    applyPolicyMetadata,
    applyPresentOnlyRecord
} = require('../utils/attendanceHelpers');

exports.requestRegularization = async (req, res) => {
    try {
        const { date, reason, clockIn, clockOut, requestedClockIn, requestedClockOut, type } = req.body;

        if (!date || !reason) {
            return res.status(400).json({ message: 'Date and reason are required.' });
        }

        const dateObj = new Date(date);
        const startOfDayDate = getStartOfDayIST(dateObj);
        const endOfDayDate = new Date(startOfDayDate.getTime() + 24 * 60 * 60 * 1000);
        const todayStart = getStartOfDayIST();

        if (startOfDayDate > todayStart) {
            return res.status(400).json({ message: 'Cannot request regularization for future dates.' });
        }

        const userDoc = await User.findById(req.user._id).select('department firstName lastName joiningDate reportingManagers').lean();
        if (userDoc?.joiningDate && startOfDayDate < getStartOfDayIST(userDoc.joiningDate)) {
            return res.status(400).json({ message: 'Cannot regularize attendance prior to joining date.' });
        }

        const company = req.company || await Company.findById(req.companyId).select('settings.timesheet settings.attendance').lean();
        const editability = await ensureTimesheetPeriodEditable({
            company,
            companyId: req.companyId,
            userId: req.user._id,
            dateValue: startOfDayDate
        });
        if (!editability.ok) {
            return res.status(400).json({ message: editability.message });
        }

        const existingPending = await AttendanceRegularization.findOne({
            user: req.user._id,
            companyId: req.companyId,
            date: { $gte: startOfDayDate, $lt: endOfDayDate },
            status: 'PENDING'
        });

        if (existingPending) {
            return res.status(400).json({ message: 'A regularization request is already pending for this date.' });
        }

        const rawClockIn = requestedClockIn || clockIn;
        const rawClockOut = requestedClockOut || clockOut;

        let finalType = type;
        if (!finalType) {
            if (rawClockIn && rawClockOut) finalType = 'BOTH';
            else if (rawClockIn) finalType = 'IN';
            else if (rawClockOut) finalType = 'OUT';
            else finalType = 'PRESENT';
        }

        let finalClockIn = (finalType === 'IN' || finalType === 'BOTH') && rawClockIn ? new Date(rawClockIn) : null;
        let finalClockOut = (finalType === 'OUT' || finalType === 'BOTH') && rawClockOut ? new Date(rawClockOut) : null;

        if (finalType === 'BOTH') {
            if (!finalClockIn || !finalClockOut) {
                return res.status(400).json({ message: 'Both check-in and check-out times are required for BOTH type.' });
            }
            if (finalClockIn >= finalClockOut) {
                return res.status(400).json({ message: 'Check-in time must be before check-out time.' });
            }
        } else if (finalType === 'IN') {
            if (!finalClockIn) {
                return res.status(400).json({ message: 'Check-in time is required for IN type.' });
            }
            finalClockOut = null;
        } else if (finalType === 'OUT') {
            if (!finalClockOut) {
                return res.status(400).json({ message: 'Check-out time is required for OUT type.' });
            }
            finalClockIn = null;
        } else if (finalType === 'PRESENT') {
            finalClockIn = null;
            finalClockOut = null;
        }

        const primaryManager = (userDoc?.reportingManagers && userDoc.reportingManagers.length > 0)
            ? userDoc.reportingManagers[0]
            : null;

        const regularization = await AttendanceRegularization.create({
            companyId: req.companyId,
            user: req.user._id,
            manager: primaryManager,
            date: startOfDayDate,
            type: finalType,
            reason,
            requestedClockIn: finalClockIn,
            requestedClockOut: finalClockOut,
            status: 'PENDING'
        });

        const io = req.app.get('io');
        
        // Target notifications: ONLY direct reporting managers + active Admins/HR Admins
        const directManagerIds = (userDoc?.reportingManagers || []).map(id => id.toString());
        const targetRoles = await Role.find({
            companyId: req.companyId,
            name: { $in: ['Admin', 'HR Admin', 'System Admin'] },
            isActive: true
        }).select('_id').lean();

        const roleIds = targetRoles.map(r => r._id);
        const adminUsers = roleIds.length > 0
            ? await User.find({ companyId: req.companyId, roles: { $in: roleIds }, isActive: true }).select('_id').lean()
            : [];
        const adminUserIds = adminUsers.map(u => u._id.toString());

        const recipientIds = [...new Set([...directManagerIds, ...adminUserIds])]
            .filter(id => id !== req.user._id.toString());

        if (recipientIds.length > 0) {
            await NotificationService.createManyNotifications(io, recipientIds.map(managerId => ({
                user: managerId,
                companyId: req.companyId,
                preferenceKey: 'attendance_regularization_submitted',
                title: 'New Regularization Request',
                message: `${userDoc?.firstName || 'An employee'} requested attendance regularization for ${startOfDayDate.toLocaleDateString()}.`,
                type: 'Info',
                link: '/attendance?tab=regularize',
                origin: req.headers?.origin || ''
            })));
        }

        res.status(201).json({ message: 'Regularization request submitted successfully.', regularization });
    } catch (error) {
        console.error('requestRegularization error:', error);
        res.status(500).json({ message: 'Server Error submitting regularization request.' });
    }
};

exports.getRegularizationRequests = async (req, res) => {
    try {
        const { status, page = 1, limit = 20 } = req.query;
        const filter = { companyId: req.companyId };

        const isAdmin = req.user?.roles?.some(r => ['Admin', 'HR Admin', 'System Admin'].includes(typeof r === 'string' ? r : r.name))
            || req.user?.permissions?.includes('*')
            || req.user?.permissions?.includes('attendance.view_all')
            || req.user?.permissions?.includes('attendance.update_others');

        const isManager = req.user?.roles?.some(r => (typeof r === 'string' ? r : r.name) === 'Manager')
            || (req.user?.directReports && req.user.directReports.length > 0)
            || req.user?.permissions?.includes('attendance.approve');

        if (!isAdmin) {
            if (isManager) {
                const directReports = await User.find({
                    companyId: req.companyId,
                    reportingManagers: req.user._id
                }).select('_id').lean();
                const directReportIds = directReports.map(u => u._id);
                filter.user = { $in: [req.user._id, ...directReportIds] };
            } else {
                filter.user = req.user._id;
            }
        }

        if (status) {
            filter.status = status.toUpperCase();
        }

        const requests = await AttendanceRegularization.find(filter)
            .populate('user', 'firstName lastName email department profilePicture employeeCode')
            .populate('approvedBy', 'firstName lastName')
            .populate('manager', 'firstName lastName')
            .sort({ createdAt: -1 })
            .skip((page - 1) * limit)
            .limit(Number(limit))
            .lean();

        const total = await AttendanceRegularization.countDocuments(filter);

        res.json({
            requests,
            total,
            page: Number(page),
            pages: Math.ceil(total / limit)
        });
    } catch (error) {
        console.error('getRegularizationRequests error:', error);
        res.status(500).json({ message: 'Server Error fetching regularization requests.' });
    }
};

exports.processRegularizationRequest = async (req, res) => {
    try {
        const { id } = req.params;
        const { action, status, adminComment, rejectionReason } = req.body;

        const rawAction = action || status;
        const normalized = String(rawAction || '').trim().toUpperCase();

        let effectiveAction = '';
        if (['APPROVE', 'APPROVED'].includes(normalized)) {
            effectiveAction = 'APPROVE';
        } else if (['REJECT', 'REJECTED'].includes(normalized)) {
            effectiveAction = 'REJECT';
        }

        if (!effectiveAction) {
            return res.status(400).json({ message: 'Action must be APPROVE or REJECT.' });
        }

        const regularization = await AttendanceRegularization.findOne({
            _id: id,
            companyId: req.companyId,
            status: 'PENDING'
        });

        if (!regularization) {
            return res.status(404).json({ message: 'Pending regularization request not found.' });
        }

        // Self-Approval Prevention
        const isSelf = regularization.user.toString() === req.user._id.toString();
        if (isSelf) {
            return res.status(403).json({ message: 'You cannot approve or reject your own regularization request.' });
        }

        // Authorization Check: Admin/HR Admin or direct reporting manager
        const isAdmin = req.user?.roles?.some(r => ['Admin', 'HR Admin', 'System Admin'].includes(typeof r === 'string' ? r : r.name))
            || req.user?.permissions?.includes('*')
            || req.user?.permissions?.includes('attendance.approve');

        const targetUser = await User.findById(regularization.user).select('reportingManagers attendanceMode attendanceShiftCode').lean();
        const isDirectManager = targetUser?.reportingManagers?.some(m => m.toString() === req.user._id.toString());

        if (!isAdmin && !isDirectManager) {
            return res.status(403).json({ message: 'Not authorized to process this regularization request.' });
        }

        const finalComment = adminComment || rejectionReason || '';
        regularization.status = effectiveAction === 'APPROVE' ? 'APPROVED' : 'REJECTED';
        regularization.approvedBy = req.user._id;
        regularization.approvedAt = new Date();
        if (finalComment) {
            regularization.adminComment = finalComment;
            regularization.rejectionReason = finalComment;
        }

        await regularization.save();

        if (effectiveAction === 'APPROVE') {
            const startOfDayDate = getStartOfDayIST(regularization.date);
            let attendance = await Attendance.findOne({
                user: regularization.user,
                companyId: req.companyId,
                date: {
                    $gte: startOfDayDate,
                    $lt: new Date(startOfDayDate.getTime() + 24 * 60 * 60 * 1000)
                }
            });

            const company = req.company || await Company.findById(req.companyId).select('settings.attendance').lean();

            if (!attendance) {
                attendance = new Attendance({
                    user: regularization.user,
                    companyId: req.companyId,
                    date: startOfDayDate
                });
            }

            // Apply Shift Policy Metadata
            const policy = buildAttendancePolicy({
                company,
                user: targetUser,
                attendanceDate: startOfDayDate,
                clockInTime: regularization.requestedClockIn || attendance.clockIn
            });
            applyPolicyMetadata(attendance, policy);

            // Shift Integrity & Safe Update:
            // ONLY update clockIn if regularization is for IN or BOTH
            if (regularization.type === 'IN' || regularization.type === 'BOTH') {
                if (regularization.requestedClockIn) {
                    attendance.clockIn = regularization.requestedClockIn;
                    attendance.clockInIST = getISTTime(regularization.requestedClockIn);
                }
            }

            // ONLY update clockOut if regularization is for OUT or BOTH
            // If type === 'IN', attendance.clockOut is left untouched (null if currently on active shift, or preserving existing clockOut)
            if (regularization.type === 'OUT' || regularization.type === 'BOTH') {
                if (regularization.requestedClockOut) {
                    attendance.clockOut = regularization.requestedClockOut;
                    attendance.clockOutIST = getISTTime(regularization.requestedClockOut);
                }
            }

            if (regularization.type === 'PRESENT' || policy.mode === 'present_only') {
                applyPresentOnlyRecord(attendance, '[Regularized as Present]');
            }

            attendance.status = 'PRESENT';
            attendance.approvalStatus = 'APPROVED';
            attendance.approvedBy = req.user._id;
            attendance.isRegularized = true;
            attendance.regularizedBy = req.user._id;
            attendance.regularizedAt = new Date();
            attendance.regularizationReason = regularization.reason;

            await attendance.save();
        }

        const io = req.app.get('io');
        try {
            await NotificationService.createNotification(io, {
                user: regularization.user,
                companyId: req.companyId,
                preferenceKey: 'attendance_regularization_status_updated',
                title: `Regularization Request ${effectiveAction === 'APPROVE' ? 'Approved' : 'Rejected'}`,
                message: `Your attendance regularization request for ${regularization.date.toLocaleDateString()} has been ${effectiveAction.toLowerCase()}d.`,
                type: effectiveAction === 'APPROVE' ? 'Approval' : 'Alert',
                link: '/attendance?tab=regularize',
                origin: req.headers?.origin || ''
            });
        } catch (notifErr) {
            console.error('Notification error in processRegularizationRequest:', notifErr);
        }

        res.json({ message: `Regularization request ${effectiveAction.toLowerCase()}d successfully.`, regularization });
    } catch (error) {
        console.error('processRegularizationRequest error:', error);
        res.status(500).json({ message: 'Server Error processing regularization request.' });
    }
};
