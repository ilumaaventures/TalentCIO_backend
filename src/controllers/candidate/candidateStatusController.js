const Candidate = require('../../models/Candidate');
const { TA_CAPABILITIES } = require('../../utils/candidateAccess');
const { ensureCandidateCapability } = require('./utils/candidateHelpers');

// Update candidate status
const updateCandidateStatus = async (req, res) => {
    try {
        const { id } = req.params;
        const { status, remark } = req.body;

        if (!status) {
            return res.status(400).json({ message: 'Status is required' });
        }

        const candidate = await Candidate.findOne({ _id: id, companyId: req.companyId });
        if (!candidate) {
            return res.status(404).json({ message: 'Candidate not found' });
        }

        const { hasAccess } = await ensureCandidateCapability(candidate, req.companyId, req.user, TA_CAPABILITIES.EDIT);
        if (!hasAccess) {
            return res.status(403).json({ message: 'Forbidden: You do not have permission to update this candidate' });
        }

        // Add to status history
        candidate.statusHistory.push({
            status,
            changedBy: req.user._id,
            changedAt: new Date(),
            remark: remark || ''
        });

        candidate.status = status;
        if (remark) candidate.remark = remark;

        await candidate.save();

        const updatedCandidate = await Candidate.findOne({ _id: id, companyId: req.companyId })
            .populate('uploadedBy', 'firstName lastName email')
            .populate('statusHistory.changedBy', 'firstName lastName');

        res.status(200).json({
            message: 'Status updated successfully',
            candidate: updatedCandidate
        });

    } catch (error) {
        console.error('Error updating status:', error);
        res.status(500).json({ message: 'Server error', error: error.message });
    }
};

// Update candidate remark
const updateCandidateRemark = async (req, res) => {
    try {
        const { id } = req.params;
        const { remark } = req.body;

        const candidate = await Candidate.findOne({ _id: id, companyId: req.companyId });
        if (!candidate) {
            return res.status(404).json({ message: 'Candidate not found' });
        }

        const { hasAccess } = await ensureCandidateCapability(candidate, req.companyId, req.user, TA_CAPABILITIES.EDIT);
        if (!hasAccess) {
            return res.status(403).json({ message: 'Forbidden: You do not have permission to update this candidate' });
        }

        candidate.remark = remark;
        await candidate.save();

        const updatedCandidate = await Candidate.findOne({ _id: id, companyId: req.companyId })
            .populate('uploadedBy', 'firstName lastName email')
            .populate('hiringRequestId', 'requestId roleDetails');

        res.status(200).json({
            message: 'Remark updated successfully',
            candidate: updatedCandidate
        });

    } catch (error) {
        console.error('Error updating remark:', error);
        res.status(500).json({ message: 'Server error', error: error.message });
    }
};

// Update candidate internal remark (separate from sourcing remark)
const updateCandidateInternalRemark = async (req, res) => {
    try {
        const { id } = req.params;
        const { internalRemark } = req.body;

        const candidate = await Candidate.findOne({ _id: id, companyId: req.companyId });
        if (!candidate) {
            return res.status(404).json({ message: 'Candidate not found' });
        }

        const { hasAccess } = await ensureCandidateCapability(candidate, req.companyId, req.user, TA_CAPABILITIES.EDIT);
        if (!hasAccess) {
            return res.status(403).json({ message: 'Forbidden: You do not have permission to update this candidate' });
        }

        candidate.internalRemark = internalRemark;
        await candidate.save();

        res.status(200).json({
            message: 'Internal remark updated successfully',
            internalRemark: candidate.internalRemark
        });

    } catch (error) {
        console.error('Error updating internal remark:', error);
        res.status(500).json({ message: 'Server error', error: error.message });
    }
};

module.exports = {
    updateCandidateStatus,
    updateCandidateRemark,
    updateCandidateInternalRemark
};
