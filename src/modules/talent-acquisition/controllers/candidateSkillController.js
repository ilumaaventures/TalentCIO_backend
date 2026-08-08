const Candidate = require('../candidate.model');
const { TA_CAPABILITIES } = require('../utils/candidateAccess');
const { ensureCandidateCapability } = require('../utils/candidateAccess');

// Update all skill ratings for a candidate
const updateSkillRatings = async (req, res) => {
    try {
        const { id } = req.params;
        const { skillRatings } = req.body; // Expecting an array of { skill, rating, category, _id }

        if (!Array.isArray(skillRatings)) {
            return res.status(400).json({ message: 'Skill ratings must be an array' });
        }

        const candidate = await Candidate.findOne({ _id: id, companyId: req.companyId });
        if (!candidate) {
            return res.status(404).json({ message: 'Candidate not found' });
        }

        const { hasAccess } = await ensureCandidateCapability(candidate, req.companyId, req.user, TA_CAPABILITIES.EDIT);
        if (!hasAccess) {
            return res.status(403).json({ message: 'Forbidden: You do not have permission to update this candidate' });
        }

        candidate.skillRatings = skillRatings;
        await candidate.save();

        res.status(200).json({
            message: 'Skill ratings updated successfully',
            skillRatings: candidate.skillRatings
        });
    } catch (error) {
        console.error('Error updating skill ratings:', error);
        res.status(500).json({ message: 'Server error updating skill ratings', error: error.message });
    }
};

// Add a new skill to candidate's skillRatings
const addSkillRating = async (req, res) => {
    try {
        const { id } = req.params;
        const { skill, rating, category } = req.body;

        if (!skill) {
            return res.status(400).json({ message: 'Skill name is required' });
        }

        const candidate = await Candidate.findOne({ _id: id, companyId: req.companyId });
        if (!candidate) {
            return res.status(404).json({ message: 'Candidate not found' });
        }

        const { hasAccess } = await ensureCandidateCapability(candidate, req.companyId, req.user, TA_CAPABILITIES.EDIT);
        if (!hasAccess) {
            return res.status(403).json({ message: 'Forbidden: You do not have permission to update this candidate' });
        }

        candidate.skillRatings.push({
            skill,
            rating: rating || 0,
            category: category || 'Additional'
        });

        await candidate.save();

        res.status(200).json({
            message: 'Skill added successfully',
            skillRatings: candidate.skillRatings
        });
    } catch (error) {
        console.error('Error adding skill rating:', error);
        res.status(500).json({ message: 'Server error adding skill rating', error: error.message });
    }
};

// Delete a skill from candidate's skillRatings
const deleteSkillRating = async (req, res) => {
    try {
        const { id, skillId } = req.params;

        const candidate = await Candidate.findOne({ _id: id, companyId: req.companyId });
        if (!candidate) {
            return res.status(404).json({ message: 'Candidate not found' });
        }

        const { hasAccess } = await ensureCandidateCapability(candidate, req.companyId, req.user, TA_CAPABILITIES.EDIT);
        if (!hasAccess) {
            return res.status(403).json({ message: 'Forbidden: You do not have permission to update this candidate' });
        }

        candidate.skillRatings.pull(skillId);
        await candidate.save();

        res.status(200).json({
            message: 'Skill deleted successfully',
            skillRatings: candidate.skillRatings
        });
    } catch (error) {
        console.error('Error deleting skill rating:', error);
        res.status(500).json({ message: 'Server error deleting skill rating', error: error.message });
    }
};

module.exports = {
    updateSkillRatings,
    addSkillRating,
    deleteSkillRating
};
