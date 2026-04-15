const LeaveRequest = require('../models/LeaveRequest');
const LeaveBalance = require('../models/LeaveBalance');
const LeaveConfig = require('../models/LeaveConfig');
const User = require('../models/User');
const Company = require('../models/Company');
const { calculateLeaveDays } = require('../utils/leaveUtils');
const NotificationService = require('../services/notificationService');

const parseBoolean = (value) => {
    if (typeof value === 'boolean') return value;
    if (typeof value === 'string') return value.toLowerCase() === 'true';
    return false;
};

const normalizeDocuments = (documents, uploadedFile) => {
    const normalized = [];

    if (uploadedFile?.path) {
        normalized.push(uploadedFile.path);
    }

    if (Array.isArray(documents)) {
        normalized.push(...documents.filter(Boolean));
    } else if (typeof documents === 'string' && documents.trim()) {
        try {
            const parsed = JSON.parse(documents);
            if (Array.isArray(parsed)) {
                normalized.push(...parsed.filter(Boolean));
            } else {
                normalized.push(documents);
            }
        } catch {
            normalized.push(documents);
        }
    }

    return [...new Set(normalized)];
};


// Helper to initialize balance dynamically based on policy
const initializeBalance = async (userId, policy, year, companyId) => {
    let initialAccrued = 0;

    if (policy.accrualType === 'Yearly') {
        initialAccrued = policy.accrualAmount;
    } else if (policy.accrualType === 'Monthly') {
        const currentMonth = new Date().getMonth() + 1; // 1-12
        initialAccrued = policy.accrualAmount * currentMonth;
        if (policy.maxLimitPerYear > 0 && initialAccrued > policy.maxLimitPerYear) {
            initialAccrued = policy.maxLimitPerYear;
        }
    } else if (policy.accrualType === 'Policy') {
        // Special case for fixed policies that might grant full amount
        initialAccrued = policy.accrualAmount || 0;
    }

    return await LeaveBalance.create({
        user: userId,
        leaveType: policy.leaveType,
        year: year,
        openingBalance: 0,
        accrued: initialAccrued,
        utilized: 0,
        encashed: 0,
        closingBalance: initialAccrued,
        companyId: companyId || policy.companyId
    });
};

// @desc    Apply for Leave
// @route   POST /api/leaves/apply
// @access  Private
const applyLeave = async (req, res) => {
    const { leaveType, startDate, endDate, halfDaySession, reason } = req.body;
    const isHalfDay = parseBoolean(req.body.isHalfDay);
    const documents = normalizeDocuments(req.body.documents, req.file);
    const userId = req.user._id;

    try {
        console.log(`[LeaveApply] company: ${req.companyId}, user: ${userId}`);
        
        if (!req.companyId) return res.status(400).json({ message: 'Tenant context missing' });

        // 1. Fetch Policy
        const policy = await LeaveConfig.findOne({ leaveType, isActive: true, companyId: req.companyId });
        if (!policy) {
            return res.status(400).json({ message: 'Invalid or inactive leave type' });
        }

        const userEmploymentType = req.user.employmentType || 'Full Time';
        if (policy.employeeTypes && policy.employeeTypes.length > 0 && !policy.employeeTypes.includes(userEmploymentType)) {
            return res.status(403).json({ message: 'You are not eligible for this leave type based on your employment type.' });
        }

        // 2. Validate Backdated
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        const start = new Date(startDate);
        if (start < today && !policy.allowBackdated) {
            return res.status(400).json({ message: 'Backdated leave is not allowed for this leave type' });
        }

        // 3. Check for Overlapping Leave Requests
        const reqStart = new Date(startDate);
        const reqEnd = new Date(endDate);
        const overlapping = await LeaveRequest.findOne({
            user: userId,
            companyId: req.companyId,
            status: { $in: ['Pending', 'Approved'] },
            // Two ranges overlap when: existingStart <= reqEnd AND existingEnd >= reqStart
            startDate: { $lte: reqEnd },
            endDate: { $gte: reqStart }
        });

        if (overlapping) {
            const fmt = (d) => new Date(d).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
            return res.status(400).json({
                message: `Dates overlap with an existing ${overlapping.status.toLowerCase()} leave (${overlapping.leaveType}: ${fmt(overlapping.startDate)} – ${fmt(overlapping.endDate)}). Please choose different dates.`
            });
        }

        // 4. Calculate Days
        const company = await Company.findById(req.companyId);
        const weeklyOffs = company?.settings?.attendance?.weeklyOff || ['Saturday', 'Sunday'];

        let daysCount = 0;
        if (isHalfDay) {
            // Validate Half Day is same date
            if (new Date(startDate).toDateString() !== new Date(endDate).toDateString()) {
                return res.status(400).json({ message: 'Half day leave must be on a single date' });
            }
            
            // Check if this date is a holiday or weekend
            const holidayCheck = await calculateLeaveDays(new Date(startDate), new Date(endDate), policy, weeklyOffs);
            if (holidayCheck === 0) {
                // It's a holiday/weekend and sandwich rule is OFF
                daysCount = 0;
            } else {
                daysCount = 0.5;
            }
        } else {
            daysCount = await calculateLeaveDays(new Date(startDate), new Date(endDate), policy, weeklyOffs);
        }

        if (daysCount <= 0) {
            return res.status(400).json({ message: 'Invalid date range (0 working days selected)' });
        }

        // 5. Check Balance
        const currentYear = new Date().getFullYear();
        let balance = await LeaveBalance.findOne({ user: userId, leaveType, year: currentYear, companyId: req.companyId });

        // Auto-create balance if missing
        if (!balance) {
            balance = await initializeBalance(userId, policy, currentYear, req.companyId);
        }

        // Calculate Available
        const available = balance.openingBalance + balance.accrued - balance.utilized;

        // Validation
        if (policy.accrualAmount !== 0 && !policy.allowNegativeBalance && daysCount > available) {
            return res.status(400).json({
                message: `Insufficient balance. Available: ${available}, Requested: ${daysCount}`
            });
        }

        // 6. Validate Required Proof
        if (policy.proofRequiredAbove > 0 && daysCount > policy.proofRequiredAbove) {
            if (!documents || !Array.isArray(documents) || documents.length === 0) {
                return res.status(400).json({
                    message: `Proof document is mandatory for ${policy.leaveType} exceeding ${policy.proofRequiredAbove} days.`
                });
            }
        }

        // 7. Create Request
        const leaveRequest = await LeaveRequest.create({
            user: userId,
            companyId: req.companyId,
            leaveType,

            startDate,
            endDate,
            isHalfDay,
            halfDaySession: isHalfDay ? halfDaySession : null,
            reason,
            documents,
            daysCount,
            status: 'Pending',
            auditLog: [{ action: 'Applied', by: userId, comment: 'Initial Application' }]
        });

        // Notify Managers
        const currentUser = await User.findById(userId).populate('reportingManagers');
        if (currentUser && currentUser.reportingManagers && currentUser.reportingManagers.length > 0) {
            const io = req.app.get('io');
            const notifications = currentUser.reportingManagers.map(manager => ({
                user: manager._id,
                companyId: req.companyId,
                title: 'New Leave Request',
                message: `${currentUser.firstName} ${currentUser.lastName} has applied for ${daysCount} days of ${leaveType} leave.`,
                type: 'Approval',
                link: '/leaves'
            }));
            await NotificationService.createManyNotifications(io, notifications);
        }

        res.status(201).json(leaveRequest);

    } catch (error) {
        console.error('[LeaveApply Error]', error);
        res.status(500).json({ message: 'Server Error', details: error.message });
    }
};

// @desc    Get My Leave Requests (Paginated)
// @route   GET /api/leaves/requests?page=1&limit=10
// @access  Private
const getMyLeaves = async (req, res) => {
    try {
        const page = parseInt(req.query.page) || 1;
        const limit = parseInt(req.query.limit) || 10;
        const skip = (page - 1) * limit;

        const [leaves, total, configs] = await Promise.all([
            LeaveRequest.find({ user: req.user._id, companyId: req.companyId })
                .sort({ createdAt: -1 })
                .skip(skip)
                .limit(limit)
                .select('leaveType startDate endDate isHalfDay halfDaySession reason status createdAt daysCount documents rejectionReason')
                .lean(),
            LeaveRequest.countDocuments({ user: req.user._id, companyId: req.companyId }),
            LeaveConfig.find({ companyId: req.companyId }).select('leaveType sandwichRule').lean()
        ]);

        const sandwichMap = configs.reduce((acc, c) => ({ ...acc, [c.leaveType]: c.sandwichRule }), {});

        const enrichedLeaves = leaves.map(l => ({
            ...l,
            sandwichRule: sandwichMap[l.leaveType] || false
        }));

        res.json({
            data: enrichedLeaves,
            pagination: {
                page,
                limit,
                total,
                totalPages: Math.ceil(total / limit)
            }
        });
    } catch (error) {
        console.error('[LeaveRequests Error]', error);
        res.status(500).json({ message: 'Server Error', details: error.message });
    }
};

// @desc    Get My Balances
// @route   GET /api/leaves/balance
// @access  Private
const getMyBalances = async (req, res) => {
    try {
        const year = new Date().getFullYear();
        
        console.log(`[LeaveBalance] GET for company: ${req.companyId}, user: ${req.user._id}`);
        if (!req.companyId) return res.status(400).json({ message: 'Tenant context missing' });

        // Start by getting all active policies
        const allPolicies = await LeaveConfig.find({ isActive: true, companyId: req.companyId }).lean();

        // Filter policies based on user employment type (Strict Check)
        const userEmploymentType = req.user.employmentType || 'Full Time';
        const policies = allPolicies.filter(p =>
            !p.employeeTypes ||
            p.employeeTypes.length === 0 ||
            p.employeeTypes.includes(userEmploymentType)
        );

        const balances = [];
        
        // Batch fetch all existing balances for this user/year
        const existingBalances = await LeaveBalance.find({ 
            user: req.user._id, 
            year, 
            companyId: req.companyId 
        }).lean();

        // Map for quick lookup
        const balanceMap = new Map(existingBalances.map(b => [b.leaveType, b]));

        // Process all policies in parallel
        const results = await Promise.all(policies.map(async (policy) => {
            let balance = balanceMap.get(policy.leaveType);

            if (!balance) {
                // Initialize missing balance
                const newB = await initializeBalance(req.user._id, policy, year, req.companyId);
                balance = newB.toObject();
            } else {
                balance.closingBalance = (balance.openingBalance || 0) + (balance.accrued || 0) - (balance.utilized || 0);
            }

            return {
                ...balance,
                policyName: policy.name,
                policyDescription: policy.description,
                policyAccrualAmount: policy.accrualAmount,
                proofRequiredAbove: policy.proofRequiredAbove
            };
        }));

        res.json(results);
    } catch (error) {
        console.error('[LeaveBalance Error]', error);
        res.status(500).json({ message: 'Server Error', details: error.message });
    }
};

// @desc    Get Team Approvals (Manager)
// @route   GET /api/leaves/approvals
// @access  Private (Manager)
const getManagerApprovals = async (req, res) => {
    try {
        const isAdmin = req.user.roles && req.user.roles.some(r =>
            (typeof r === 'string' ? r : r.name) === 'Admin'
        );

        const { status, userIds } = req.query;
        let query = { companyId: req.companyId };
        
        if (status && status !== 'All') {
            query.status = status;
        } else if (!status) {
            // Default to Pending if no status specified
            query.status = 'Pending';
        }
        // If status is 'All', we don't add a status filter to the query

        if (!isAdmin) {
            // Managers only see their direct reports' requests
            const subordinates = await User.find({ reportingManagers: req.user._id, companyId: req.companyId }).select('_id');
            const subordinateIds = subordinates.map(u => u._id.toString());

            if (subordinateIds.length === 0) {
                return res.json([]);
            }

            if (userIds) {
                const requestedUserIds = userIds.split(',').filter(Boolean);
                // Intersect requested with allowed subordinates
                const allowedIds = requestedUserIds.filter(id => subordinateIds.includes(id));
                query.user = { $in: allowedIds };
            } else {
                query.user = { $in: subordinateIds };
            }
        } else if (userIds) {
            // Admin: no restriction, just filter if userIds provided
            const requestedUserIds = userIds.split(',').filter(Boolean);
            if (requestedUserIds.length > 0) {
                query.user = { $in: requestedUserIds };
            }
        }
        // Admins: if no userIds provided, see all pending requests across the org

        const [requests, configs] = await Promise.all([
            LeaveRequest.find(query)
                .populate('user', 'firstName lastName email employeeCode')
                .sort({ createdAt: -1 })
                .select('user leaveType startDate endDate daysCount reason status isHalfDay halfDaySession createdAt documents rejectionReason')
                .lean(),
            LeaveConfig.find({ companyId: req.companyId }).select('leaveType sandwichRule').lean()
        ]);

        const sandwichMap = configs.reduce((acc, c) => ({ ...acc, [c.leaveType]: c.sandwichRule }), {});

        const enrichedRequests = requests.map(r => ({
            ...r,
            sandwichRule: sandwichMap[r.leaveType] || false
        }));

        res.json(enrichedRequests);
    } catch (error) {
        console.error('[LeaveApprovals Error]', error);
        res.status(500).json({ message: 'Server Error', details: error.message });
    }
};

// @desc    Approve/Reject Leave
// @route   PUT /api/leaves/approve/:id
// @access  Private (Manager)
const updateLeaveStatus = async (req, res) => {
    const { status, rejectionReason } = req.body; // Approved or Rejected
    const requestId = req.params.id;
    const managerId = req.user._id;

    try {
        const request = await LeaveRequest.findOne({ _id: requestId, companyId: req.companyId });
        if (!request) {
            return res.status(404).json({ message: 'Request not found' });
        }

        // Verify Authority: must be a direct reporting manager OR have an admin role
        const employee = await User.findOne({ _id: request.user, companyId: req.companyId });
        if (!employee) {
            return res.status(404).json({ message: 'Employee not found' });
        }
        const isManager = employee.reportingManagers.some(rm => rm.toString() === managerId.toString());
        const isAdmin = req.user.roles && req.user.roles.some(r =>
            (typeof r === 'string' ? r : r.name) === 'Admin'
        );

        if (!isManager && !isAdmin) {
            return res.status(403).json({ message: 'Not authorized to approve this request' });
        }

        // Double check: if already processed
        if (request.status !== 'Pending') {
            return res.status(400).json({ message: 'Request already processed' });
        }

        if (status === 'Approved') {
            // Update Balance
            const currentYear = new Date().getFullYear();
            let balance = await LeaveBalance.findOne({ user: request.user, leaveType: request.leaveType, year: currentYear, companyId: req.companyId });

            // If balance check wasn't strict during apply (wait state), re-check here? 
            // We checked during apply. But let's assume valid.
            // Deduct
            // Note: utilized increases.

            if (!balance) {
                // Should exist if applied, but safe
                balance = await LeaveBalance.create({ user: request.user, leaveType: request.leaveType, year: currentYear, companyId: req.companyId });
            }

            balance.utilized += request.daysCount;
            balance.closingBalance = balance.openingBalance + balance.accrued - balance.utilized;
            await balance.save();
        }

        request.status = status;
        request.approvedBy = managerId;
        request.rejectionReason = status === 'Rejected' ? rejectionReason : undefined;
        request.auditLog.push({
            action: status,
            by: managerId,
            comment: status === 'Rejected' ? rejectionReason : 'Approved by Manager'
        });

        await request.save();

        // Notify Employee
        const io = req.app.get('io');
        await NotificationService.createNotification(io, {
            user: request.user,
            companyId: req.companyId,
            title: `Leave Request ${status}`,
            message: `Your leave request for ${request.daysCount} days of ${request.leaveType} has been ${status.toLowerCase()}.`,
            type: status === 'Approved' ? 'Info' : 'Alert',
            link: '/leaves'
        });

        res.json(request);

    } catch (error) {
        console.error('[LeaveUpdateStatus Error]', error);
        res.status(500).json({ message: 'Server Error', details: error.message });
    }
};

// @desc    Cancel a pending leave request (by the employee themselves)
// @route   PUT /api/leaves/cancel/:id
// @access  Private
const cancelLeave = async (req, res) => {
    const requestId = req.params.id;
    const userId = req.user._id;

    try {
        const request = await LeaveRequest.findOne({ _id: requestId, user: userId, companyId: req.companyId });

        if (!request) {
            return res.status(404).json({ message: 'Request not found' });
        }

        if (request.status !== 'Pending') {
            return res.status(400).json({ message: `Cannot cancel a request that is already ${request.status}` });
        }

        request.status = 'Cancelled';
        request.auditLog.push({
            action: 'Cancelled',
            by: userId,
            comment: 'Cancelled by employee'
        });

        await request.save();
        res.json({ message: 'Leave request cancelled successfully', request });

    } catch (error) {
        console.error('[LeaveCancel Error]', error);
        res.status(500).json({ message: 'Server Error', details: error.message });
    }
};

module.exports = {
    applyLeave,
    getMyLeaves,
    getMyBalances,
    getManagerApprovals,
    updateLeaveStatus,
    cancelLeave
};
