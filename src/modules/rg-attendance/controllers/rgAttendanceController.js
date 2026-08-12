const { getRGDocumentSummary } = require('../services/rgAttendanceService');

const MONTH_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;

const getCurrentMonthKey = () => {
    const currentDate = new Date();
    const year = currentDate.getFullYear();
    const month = String(currentDate.getMonth() + 1).padStart(2, '0');
    return `${year}-${month}`;
};

const getDocumentSummary = async (req, res) => {
    try {
        const month = String(req.query.month || getCurrentMonthKey()).trim();

        if (!MONTH_PATTERN.test(month)) {
            return res.status(400).json({
                message: 'Invalid month. Expected format is YYYY-MM.'
            });
        }

        const summary = await getRGDocumentSummary({
            companyId: req.companyId,
            month,
            requester: req.user
        });

        return res.json({
            month,
            totalRecords: summary.records.length,
            totalMissingRecords: summary.missingRecords.length,
            records: summary.records,
            missingRecords: summary.missingRecords
        });
    } catch (error) {
        console.error('getDocumentSummary error:', error);
        return res.status(500).json({ message: 'Server error' });
    }
};

module.exports = {
    getDocumentSummary
};
