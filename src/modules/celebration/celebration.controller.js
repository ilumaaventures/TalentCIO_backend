const CelebrationAck = require('./celebration.model');
const Company = require('../company/company.model');

/**
 * Helper to extract year, month, day in Asia/Kolkata timezone
 */
const getKolkataDateInfo = () => {
    const now = new Date();
    const formatter = new Intl.DateTimeFormat('en-US', {
        timeZone: 'Asia/Kolkata',
        year: 'numeric',
        month: 'numeric',
        day: 'numeric',
        hour: 'numeric',
        minute: 'numeric',
        second: 'numeric',
        hour12: false
    });
    const parts = formatter.formatToParts(now);
    const dateObj = {};
    parts.forEach(p => { dateObj[p.type] = p.value; });

    const year = parseInt(dateObj.year, 10);
    const month = parseInt(dateObj.month, 10); // 1-12 (August is 8)
    const day = parseInt(dateObj.day, 10); // 1-31

    return { year, month, day, now };
};

/**
 * @desc    Check Independence Day celebration status for logged-in user
 * @route   GET /api/celebrations/independence-day-status
 * @access  Private
 */
const getIndependenceDayStatus = async (req, res) => {
    try {
        const userId = req.user._id;
        const companyId = req.companyId || req.user.companyId;

        const isPreview = req.query.preview === 'true';
        const { year, month, day } = getKolkataDateInfo();

        // Independence Day is 15th August.
        // It becomes active on August 15 (month 8, day >= 15) and continues for users who haven't logged in on that day.
        const isEligibleDate = isPreview || (month === 8 && day >= 15) || (month > 8);
        const eventKey = `INDEPENDENCE_DAY_${year}`;

        if (!isEligibleDate) {
            return res.json({
                shouldShow: false,
                eventKey,
                reason: 'Independence Day celebration window has not started yet'
            });
        }

        // Check if user has already acknowledged this celebration event for the current year
        if (!isPreview) {
            const ack = await CelebrationAck.findOne({
                user: userId,
                eventKey
            });

            if (ack) {
                return res.json({
                    shouldShow: false,
                    eventKey,
                    alreadyAcknowledged: true,
                    shownAt: ack.shownAt
                });
            }
        }

        // Fetch company details for personalized branding/wishes
        let companyName = 'Talentcio';
        if (companyId) {
            try {
                const company = await Company.findById(companyId).select('name');
                if (company?.name) companyName = company.name;
            } catch {
                // Fallback to default
            }
        }

        const employeeName = `${req.user.firstName || ''} ${req.user.lastName || ''}`.trim() || 'Valued Team Member';

        return res.json({
            shouldShow: true,
            eventKey,
            celebrationType: 'INDEPENDENCE_DAY',
            employeeName,
            companyName,
            year
        });
    } catch (error) {
        console.error('[Celebration] getIndependenceDayStatus error:', error);
        return res.status(500).json({ message: 'Server error checking celebration status', error: error.message });
    }
};

/**
 * @desc    Acknowledge/record celebration viewed by user
 * @route   POST /api/celebrations/acknowledge
 * @access  Private
 */
const acknowledgeCelebration = async (req, res) => {
    try {
        const userId = req.user._id;
        const companyId = req.companyId || req.user.companyId;
        const { eventKey, celebrationType = 'INDEPENDENCE_DAY', metadata = {} } = req.body;

        if (!eventKey) {
            return res.status(400).json({ message: 'eventKey is required' });
        }

        const ack = await CelebrationAck.findOneAndUpdate(
            { user: userId, eventKey },
            {
                $setOnInsert: {
                    user: userId,
                    companyId,
                    eventKey,
                    celebrationType,
                    shownAt: new Date(),
                    metadata: {
                        ...metadata,
                        ip: req.ip,
                        userAgent: req.headers['user-agent']
                    }
                }
            },
            { upsert: true, new: true }
        );

        return res.json({
            success: true,
            message: 'Celebration marked as seen successfully',
            ack
        });
    } catch (error) {
        console.error('[Celebration] acknowledgeCelebration error:', error);
        return res.status(500).json({ message: 'Server error recording celebration acknowledgment', error: error.message });
    }
};

module.exports = {
    getIndependenceDayStatus,
    acknowledgeCelebration,
    getKolkataDateInfo
};
