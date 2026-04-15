const ActivityLog = require('../models/ActivityLog');

// GET /api/superadmin/logs
const getLogs = async (req, res) => {
    try {
        const { page = 1, limit = 30, companyId: queryCompanyId = '', action = '', startDate = '', endDate = '' } = req.query;
        const companyId = req.companyId || queryCompanyId;
        const filter = {};
        if (companyId) filter.companyId = companyId;
        if (action) filter.action = { $regex: action, $options: 'i' };
        if (startDate || endDate) {
            filter.createdAt = {};
            if (startDate) filter.createdAt.$gte = new Date(startDate);
            if (endDate) filter.createdAt.$lte = new Date(endDate);
        }

        const total = await ActivityLog.countDocuments(filter);
        const logs = await ActivityLog.find(filter)
            .populate('companyId', 'name subdomain')
            .sort({ createdAt: -1 })
            .skip((page - 1) * limit)
            .limit(Number(limit));

        res.json({ logs, total, page: Number(page), totalPages: Math.ceil(total / limit) });
    } catch (err) {
        res.status(500).json({ message: err.message });
    }
};

module.exports = { getLogs };
