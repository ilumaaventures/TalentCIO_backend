const Attendance = require('../attendance.model');
const AttendanceRegularization = require('../attendanceRegularization.model');
const User = require('../../user/user.model');
const Company = require('../../company/company.model');
const NotificationService = require('../../../services/notificationService');
const { getISTTime, getStartOfDayIST } = require('../attendancePolicy');

exports.requestRegularization = async (req, res) => {
    try {
        const { date, reason, clockIn, clockOut } = req.body;

        if (!date || !reason) {
            return res.status(400).json({ message: 'Date and reason are required.' });
        }

        const dateObj = new Date(date);
        const startOfDayDate = getStartOfDayIST(dateObj);
        const endOfDayDate = new Date(startOfDayDate.getTime() + 24 * 60 * 60 * 1000);

        const existingPending = await AttendanceRegularization.findOne({
            user: req.user._id,
            companyId: req.companyId,
            date: { $gte: startOfDayDate, $lt: endOfDayDate },
            status: 'PENDING'
        });

        if (existingPending) {
            return res.status(400).json({ message: 'A regularization request is already pending for this date.' });
        }

        const regularization = await AttendanceRegularization.create({
            companyId: req.companyId,
            user: req.user._id,
            date: startOfDayDate,
            reason,
            requestedClockIn: clockIn ? new Date(clockIn) : null,
            requestedClockOut: clockOut ? new Date(clockOut) : null,
            status: 'PENDING'
        });

        const io = req.app.get('io');
        const userWithDept = await User.findById(req.user._id).select('department firstName lastName').lean();
        const managerQuery = {
            companyId: req.companyId,
            isActive: true,
            $or: [
                { roles: { $in: ['Admin', 'Manager', 'HR Admin', 'System Admin'] } },
                { permissions: { $in: ['attendance.approve', '*'] } }
            ]
        };

        if (userWithDept?.department) {
            managerQuery.$or.push({ department: userWithDept.department });
        }

        const managers = await User.find(managerQuery).select('_id').lean();
        const managerIds = managers.map(m => m._id.toString()).filter(id => id !== req.user._id.toString());

        if (managerIds.length > 0) {
            await NotificationService.createManyNotifications(io, managerIds.map(managerId => ({
                user: managerId,
                companyId: req.companyId,
                title: 'New Regularization Request',
                message: `${userWithDept?.firstName || 'An employee'} requested attendance regularization for ${startOfDayDate.toLocaleDateString()}.`,
                type: 'Info',
                link: '/attendance/approvals'
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

        const isManager = req.user?.roles?.some(r => ['Admin', 'Manager', 'HR Admin', 'System Admin'].includes(typeof r === 'string' ? r : r.name))
            || req.user?.permissions?.includes('*')
            || req.user?.permissions?.includes('attendance.approve');

        if (!isManager) {
            filter.user = req.user._id;
        }

        if (status) {
            filter.status = status.toUpperCase();
        }

        const requests = await AttendanceRegularization.find(filter)
            .populate('user', 'firstName lastName email department profilePicture')
            .populate('approvedBy', 'firstName lastName')
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
        const { action, adminComment } = req.body;

        if (!['APPROVE', 'REJECT'].includes(action)) {
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

        regularization.status = action === 'APPROVE' ? 'APPROVED' : 'REJECTED';
        regularization.approvedBy = req.user._id;
        regularization.approvedAt = new Date();
        if (adminComment) regularization.adminComment = adminComment;

        await regularization.save();

        if (action === 'APPROVE') {
            const startOfDayDate = getStartOfDayIST(regularization.date);
            let attendance = await Attendance.findOne({
                user: regularization.user,
                companyId: req.companyId,
                date: {
                    $gte: startOfDayDate,
                    $lt: new Date(startOfDayDate.getTime() + 24 * 60 * 60 * 1000)
                }
            });

            if (!attendance) {
                attendance = new Attendance({
                    user: regularization.user,
                    companyId: req.companyId,
                    date: startOfDayDate
                });
            }

            if (regularization.requestedClockIn) {
                attendance.clockIn = regularization.requestedClockIn;
                attendance.clockInIST = getISTTime(regularization.requestedClockIn);
            }
            if (regularization.requestedClockOut) {
                attendance.clockOut = regularization.requestedClockOut;
                attendance.clockOutIST = getISTTime(regularization.requestedClockOut);
            }

            attendance.status = 'PRESENT';
            attendance.isRegularized = true;
            attendance.regularizedBy = req.user._id;
            attendance.regularizedAt = new Date();
            attendance.regularizationReason = regularization.reason;

            await attendance.save();
        }

        const io = req.app.get('io');
        await NotificationService.createNotification(io, {
            user: regularization.user,
            companyId: req.companyId,
            title: `Regularization Request ${action === 'APPROVE' ? 'Approved' : 'Rejected'}`,
            message: `Your attendance regularization request for ${regularization.date.toLocaleDateString()} has been ${action.toLowerCase()}d.`,
            type: action === 'APPROVE' ? 'Success' : 'Warning',
            link: '/attendance/me'
        });

        res.json({ message: `Regularization request ${action.toLowerCase()}d successfully.`, regularization });
    } catch (error) {
        console.error('processRegularizationRequest error:', error);
        res.status(500).json({ message: 'Server Error processing regularization request.' });
    }
};
