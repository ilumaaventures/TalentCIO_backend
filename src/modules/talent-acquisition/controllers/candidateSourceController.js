const CandidateSource = require('../candidateSource.model');

// GET /api/ta/candidates/sources
const getCandidateSources = async (req, res) => {
    try {
        const defaultSources = [
            'Direct Upload',
            'Employee Referral',
            'Job Board',
            'LinkedIn',
            'Naukri',
            'Company Career Page',
            'Recruitment Agency',
            'Walk-In'
        ];

        const customSources = await CandidateSource.find({ companyId: req.companyId }).lean();
        const customNames = customSources.map(s => s.name);

        const combined = [
            ...defaultSources.map(name => ({ name, isCustom: false })),
            ...customSources.map(s => ({ _id: s._id, name: s.name, isCustom: true }))
        ];

        res.status(200).json(combined.sort((a, b) => a.name.localeCompare(b.name)));
    } catch (error) {
        console.error('Error fetching sources:', error);
        res.status(500).json({ message: 'Server error', error: error.message });
    }
};

// Add a new custom candidate source
const addCandidateSource = async (req, res) => {
    try {
        const { name } = req.body;
        if (!name) {
            return res.status(400).json({ message: 'Source name is required' });
        }

        const existing = await CandidateSource.findOne({ name, companyId: req.companyId });
        if (existing) {
            return res.status(400).json({ message: 'Source already exists' });
        }

        const newSource = new CandidateSource({
            name,
            companyId: req.companyId,
            createdBy: req.user._id
        });

        await newSource.save();
        res.status(201).json({ message: 'Source added successfully', source: newSource });
    } catch (error) {
        console.error('Error adding source:', error);
        res.status(500).json({ message: 'Server error', error: error.message });
    }
};

// Delete a custom candidate source
const deleteCandidateSource = async (req, res) => {
    try {
        const { id } = req.params;
        const source = await CandidateSource.findOneAndDelete({ _id: id, companyId: req.companyId });

        if (!source) {
            return res.status(404).json({ message: 'Source not found' });
        }

        res.status(200).json({ message: 'Source deleted successfully' });
    } catch (error) {
        console.error('Error deleting source:', error);
        res.status(500).json({ message: 'Server error', error: error.message });
    }
};

module.exports = {
    getCandidateSources,
    addCandidateSource,
    deleteCandidateSource
};
