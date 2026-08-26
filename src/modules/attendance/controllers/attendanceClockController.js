const Attendance = require('../model/attendance.model');
const Company = require('../../company/company.model');
const { getISTTime, getStartOfDayIST, buildAttendancePolicy, isWithinShiftWindow } = require('../attendancePolicy');
const {
    getClientIp,
    calculateDistance,
    getAttendanceSettings,
    applyPolicyMetadata,
    finalizeCheckout,
    ensureTimesheetPeriodEditable
} = require('../utils/attendanceHelpers');

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

const parseReqLocation = (body) => {
    if (body.location && typeof body.location.lat === 'number' && typeof body.location.lng === 'number') {
        return {
            lat: Number(body.location.lat),
            lng: Number(body.location.lng),
            accuracy: body.location.accuracy != null ? Number(body.location.accuracy) : undefined
        };
    }
    if (body.latitude != null && body.longitude != null && !Number.isNaN(Number(body.latitude)) && !Number.isNaN(Number(body.longitude))) {
        return {
            lat: Number(body.latitude),
            lng: Number(body.longitude),
            accuracy: body.accuracy != null ? Number(body.accuracy) : undefined
        };
    }
    return null;
};

exports.clockIn = async (req, res) => {
    console.log('[DEBUG] Clock-In Request:', { body: req.body, user: req.user?._id, companyId: req.companyId });
    try {
        const company = req.company || await Company.findById(req.companyId);
        const attSettings = getAttendanceSettings(company);
        const today = getStartOfDayIST();
        const now = new Date();
        const locData = parseReqLocation(req.body);

        const periodEditability = await ensureTimesheetPeriodEditable({
            company,
            companyId: req.companyId,
            userId: req.user._id,
            dateValue: today
        });
        if (!periodEditability.ok) {
            return res.status(403).json({ message: periodEditability.message });
        }

        const policy = buildAttendancePolicy({
            company,
            user: req.user,
            attendanceDate: today,
            clockInTime: now,
            currentTime: now
        });

        if (!policy.canClockIn) {
            return res.status(400).json({
                message: policy.denialReason || 'Clock-in is not permitted for your shift right now.'
            });
        }

        if (attSettings.ipRestriction?.enabled && attSettings.ipRestriction.allowedIps?.length > 0) {
            const clientIp = getClientIp(req);
            const isAllowed = attSettings.ipRestriction.allowedIps.some(allowedIp => allowedIp.trim() === clientIp);
            if (!isAllowed) {
                return res.status(403).json({ message: `Access denied. Your IP (${clientIp}) is not authorized for clock-in.` });
            }
        }

        if (attSettings.geofencing?.enabled) {
            if (!locData) {
                return res.status(400).json({ message: 'Location data (latitude and longitude) is required for clock-in.' });
            }
            const { latitude: officeLat, longitude: officeLng, radiusMeters } = attSettings.geofencing;
            const distance = calculateDistance(locData.lat, locData.lng, officeLat, officeLng);
            if (distance > radiusMeters) {
                return res.status(403).json({ message: `Access denied. You are ${Math.round(distance)}m away from office (max allowed: ${radiusMeters}m).` });
            }
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

        if (!attendance) {
            attendance = new Attendance({
                user: req.user._id,
                companyId: req.companyId,
                date: today
            });
        }

        attendance.clockIn = now;
        attendance.clockInIST = getISTTime(now);
        attendance.status = 'PRESENT';
        if (locData) {
            attendance.location = locData;
        }
        applyPolicyMetadata(attendance, policy);

        await attendance.save();
        res.json({ message: 'Clocked in successfully', attendance });
    } catch (error) {
        console.error('Clock-in error:', error);
        res.status(500).json({ message: 'Server Error during clock-in' });
    }
};

exports.clockOut = async (req, res) => {
    try {
        const company = req.company || await Company.findById(req.companyId);
        const attSettings = getAttendanceSettings(company);
        const today = getStartOfDayIST();
        const now = new Date();
        const locData = parseReqLocation(req.body);

        const periodEditability = await ensureTimesheetPeriodEditable({
            company,
            companyId: req.companyId,
            userId: req.user._id,
            dateValue: today
        });
        if (!periodEditability.ok) {
            return res.status(403).json({ message: periodEditability.message });
        }

        if (attSettings.ipRestriction?.enabled && attSettings.ipRestriction.allowedIps?.length > 0) {
            const clientIp = getClientIp(req);
            const isAllowed = attSettings.ipRestriction.allowedIps.some(allowedIp => allowedIp.trim() === clientIp);
            if (!isAllowed) {
                return res.status(403).json({ message: `Access denied. Your IP (${clientIp}) is not authorized for clock-out.` });
            }
        }

        if (attSettings.geofencing?.enabled) {
            if (!locData) {
                return res.status(400).json({ message: 'Location data (latitude and longitude) is required for clock-out.' });
            }
            const { latitude: officeLat, longitude: officeLng, radiusMeters } = attSettings.geofencing;
            const distance = calculateDistance(locData.lat, locData.lng, officeLat, officeLng);
            if (distance > radiusMeters) {
                return res.status(403).json({ message: `Access denied. You are ${Math.round(distance)}m away from office (max allowed: ${radiusMeters}m).` });
            }
        }

        const attendance = await Attendance.findOne({
            user: req.user._id,
            companyId: req.companyId,
            date: {
                $gte: today,
                $lt: new Date(today.getTime() + 24 * 60 * 60 * 1000)
            }
        });

        if (!attendance || !attendance.clockIn) {
            return res.status(400).json({ message: 'You have not clocked in today' });
        }

        if (attendance.clockOut) {
            return res.status(400).json({ message: 'Already clocked out for today' });
        }

        await finalizeCheckout(attendance, now, '', locData);
        res.json({ message: 'Clocked out successfully', attendance });
    } catch (error) {
        console.error('Clock-out error:', error);
        res.status(500).json({ message: 'Server Error during clock-out' });
    }
};
