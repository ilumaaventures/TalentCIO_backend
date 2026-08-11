const Holiday = require('./holiday.model');

const setPrivateCache = (res) => {
    res.set('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.set('Pragma', 'no-cache');
    res.set('Expires', '0');
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

    if (!name || !date) {
        return res.status(400).json({ message: 'Name and date are required.' });
    }

    try {
        const year = new Date(date).getFullYear();

        const existing = await Holiday.findOne({
            companyId: req.companyId,
            name: { $regex: new RegExp(`^${name.trim()}$`, 'i') },
            year
        });

        if (existing) {
            return res.status(400).json({ message: `A holiday named "${name.trim()}" already exists for year ${year}.` });
        }

        const newHoliday = new Holiday({
            name: name.trim(),
            date,
            isOptional,
            year,
            companyId: req.companyId
        });

        const holiday = await newHoliday.save();
        res.json(holiday);
    } catch (err) {
        console.error('addHoliday error:', err);
        if (err.code === 11000) {
            return res.status(400).json({ message: 'A holiday with this name already exists for this year.' });
        }
        res.status(500).json({ message: 'Server Error adding holiday.' });
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
            return res.status(404).json({ message: 'Holiday not found' });
        }

        const targetName = name ? name.trim() : holiday.name;
        const targetDate = date || holiday.date;
        const targetYear = new Date(targetDate).getFullYear();

        const existing = await Holiday.findOne({
            _id: { $ne: req.params.id },
            companyId: req.companyId,
            name: { $regex: new RegExp(`^${targetName}$`, 'i') },
            year: targetYear
        });

        if (existing) {
            return res.status(400).json({ message: `A holiday named "${targetName}" already exists for year ${targetYear}.` });
        }

        const taskFields = {};
        if (name) taskFields.name = targetName;
        if (date) {
            taskFields.date = targetDate;
            taskFields.year = targetYear;
        }
        if (isOptional !== undefined) taskFields.isOptional = isOptional;

        holiday = await Holiday.findOneAndUpdate(
            { _id: req.params.id, companyId: req.companyId },
            { $set: taskFields },
            { new: true }
        );

        res.json(holiday);
    } catch (err) {
        console.error('updateHoliday error:', err);
        if (err.code === 11000) {
            return res.status(400).json({ message: 'A holiday with this name already exists for this year.' });
        }
        res.status(500).json({ message: 'Server Error updating holiday.' });
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

        await holiday.softDelete(req.user._id);

        res.json({ msg: 'Holiday moved to bin' });
    } catch (err) {
        console.error(err.message);
        res.status(500).send('Server Error');
    }
};
