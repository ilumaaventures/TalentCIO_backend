const Holiday = require('../models/Holiday');

const setPrivateCache = (res, maxAgeSeconds = 60) => {
    res.set('Cache-Control', `private, max-age=${maxAgeSeconds}, stale-while-revalidate=${maxAgeSeconds}`);
};

// @desc    Get holidays (optionally filtered by month)
// @route   GET /api/holidays?year=2026&month=2
// @access  Private
exports.getHolidays = async (req, res) => {
    try {
        setPrivateCache(res, 60);
        const year = parseInt(req.query.year) || new Date().getFullYear();
        const month = parseInt(req.query.month); // 1-12, optional

        let filter = { year, companyId: req.companyId };

        if (month >= 1 && month <= 12) {
            // Filter to just the requested calendar month
            const start = new Date(year, month - 1, 1);
            const end = new Date(year, month, 1);   // exclusive
            filter = { date: { $gte: start, $lt: end }, companyId: req.companyId };
        }

        const holidays = await Holiday.find(filter)
            .select('name date isOptional')
            .sort({ date: 1 })
            .lean();

        res.json(holidays);
    } catch (err) {
        console.error(err.message);
        res.status(500).send('Server Error');
    }
};

// @desc    Add a holiday
// @route   POST /api/holidays
// @access  Private (Admin only)
exports.addHoliday = async (req, res) => {
    const { name, date, isOptional } = req.body;

    try {
        const year = new Date(date).getFullYear();

        const newHoliday = new Holiday({
            name,
            date,
            isOptional,
            year,
            companyId: req.companyId
        });

        const holiday = await newHoliday.save();
        res.json(holiday);
    } catch (err) {
        console.error(err.message);
        res.status(500).send('Server Error');
    }
};

// @desc    Update a holiday
// @route   PUT /api/holidays/:id
// @access  Private (Admin only)
exports.updateHoliday = async (req, res) => {
    const { name, date, isOptional } = req.body;

    try {
        let holiday = await Holiday.findOne({ _id: req.params.id, companyId: req.companyId });

        if (!holiday) {
            return res.status(404).json({ msg: 'Holiday not found' });
        }

        const taskFields = {};
        if (name) taskFields.name = name;
        if (date) {
            taskFields.date = date;
            taskFields.year = new Date(date).getFullYear();
        }
        if (isOptional !== undefined) taskFields.isOptional = isOptional;

        holiday = await Holiday.findOneAndUpdate({ _id: req.params.id, companyId: req.companyId },
            { $set: taskFields },
            { new: true }
        );

        res.json(holiday);
    } catch (err) {
        console.error(err.message);
        res.status(500).send('Server Error');
    }
};

// @desc    Delete a holiday
// @route   DELETE /api/holidays/:id
// @access  Private (Admin only)
exports.deleteHoliday = async (req, res) => {
    try {
        let holiday = await Holiday.findOne({ _id: req.params.id, companyId: req.companyId });

        if (!holiday) {
            return res.status(404).json({ msg: 'Holiday not found' });
        }

        await Holiday.findOneAndDelete({ _id: req.params.id, companyId: req.companyId });

        res.json({ msg: 'Holiday removed' });
    } catch (err) {
        console.error(err.message);
        res.status(500).send('Server Error');
    }
};
