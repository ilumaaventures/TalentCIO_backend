const { HiringRequest } = require('../../model/hiringRequest.model');
const Candidate = require('../../model/candidate.model');
const mongoose = require('mongoose');

exports.getPreviousCandidates = async (req, res) => {
    try {
        const { id } = req.params;
        if (!id || !mongoose.Types.ObjectId.isValid(id)) {
            return res.json([]);
        }

        const currentReq = await HiringRequest.findById(id);
        if (!currentReq || !currentReq.previousRequestId) {
            return res.json([]);
        }

        // Trace previous requisitions in chain
        const prevReqIds = [];
        let cur = currentReq;
        while (cur && cur.previousRequestId) {
            const prevId = cur.previousRequestId._id || cur.previousRequestId;
            if (!prevId || !mongoose.Types.ObjectId.isValid(prevId)) break;
            if (prevReqIds.includes(String(prevId))) break;
            prevReqIds.push(String(prevId));
            cur = await HiringRequest.findById(prevId).select('previousRequestId');
        }

        if (prevReqIds.length === 0) {
            return res.json([]);
        }

        const otherReqs = await HiringRequest.find({
            companyId: currentReq.companyId || req.companyId,
            _id: { $in: prevReqIds }
        }).sort({ createdAt: -1 });

        const candidateSelect = [
            'candidateName',
            'email',
            'mobile',
            'source',
            'totalExperience',
            'relevantExperience',
            'currentCTC',
            'expectedCTC',
            'noticePeriod',
            'status',
            'decision',
            'createdAt',
            'hiringRequestId',
            'remark',
            'profileShared'
        ].join(' ');

        const openings = await Promise.all(otherReqs.map(async (r) => {
            const candidates = await Candidate.find({
                hiringRequestId: r._id
            })
                .select(candidateSelect)
                .sort({ createdAt: -1 })
                .lean();

            return {
                requisition: {
                    _id: r._id,
                    requestId: r.requestId || `REQ-${String(r._id).slice(-4)}`,
                    title: r.roleDetails?.title || r.roleDetails?.jobTitle || 'Requisition',
                    status: r.status || 'Closed',
                    createdAt: r.createdAt || new Date(),
                    closedAt: r.closedAt || r.updatedAt
                },
                candidates: candidates || []
            };
        }));

        res.json(openings);

    } catch (error) {
        console.error('Error fetching previous candidates:', error);
        res.status(500).json({ message: 'Failed to fetch previous candidates', error: error.message });
    }
};

exports.transferCandidate = async (req, res) => {
    try {
        const { candidateId } = req.params;
        const targetRequisitionId = req.body?.targetRequisitionId
            || req.body?.toRequisitionId
            || req.params?.targetRequisitionId
            || req.query?.targetRequisitionId;

        if (!targetRequisitionId) {
            return res.status(400).json({ message: 'Target hiring request ID is required' });
        }

        const candidate = await Candidate.findOne({ _id: candidateId, companyId: req.companyId });
        if (!candidate) {
            return res.status(404).json({ message: 'Candidate not found' });
        }

        const targetReq = await HiringRequest.findOne({
            _id: targetRequisitionId,
            companyId: req.companyId,
            status: { $nin: ['Closed', 'Rejected'] }
        });
        if (!targetReq) {
            return res.status(404).json({ message: 'Target hiring request not found or is closed' });
        }

        if (candidate.hiringRequestId.toString() === targetRequisitionId.toString()) {
            return res.status(400).json({ message: 'Candidate is already in this requisition' });
        }

        const duplicateCandidateConditions = [];
        if (candidate.email) {
            duplicateCandidateConditions.push({ email: String(candidate.email).trim().toLowerCase() });
        }
        if (candidate.mobile) {
            duplicateCandidateConditions.push({ mobile: String(candidate.mobile).trim() });
        }

        const existingCandidateInTarget = duplicateCandidateConditions.length
            ? await Candidate.findOne({
                companyId: req.companyId,
                hiringRequestId: targetRequisitionId,
                $or: duplicateCandidateConditions
            })
            : null;

        if (existingCandidateInTarget) {
            return res.status(409).json({ message: 'This candidate already exists in the target requisition' });
        }

        const newCandidate = new Candidate({
            hiringRequestId: targetRequisitionId,
            companyId: req.companyId,
            applicantId: candidate.applicantId || undefined,
            publicApplicationId: candidate.publicApplicationId || undefined,
            profileSnapshot: candidate.profileSnapshot || undefined,
            candidateName: candidate.candidateName,
            email: String(candidate.email || '').trim().toLowerCase(),
            mobile: String(candidate.mobile || '').trim(),
            source: candidate.source || 'Transfer',
            totalExperience: candidate.totalExperience || 0,
            currentCTC: candidate.currentCTC || '',
            expectedCTC: candidate.expectedCTC || '',
            noticePeriod: candidate.noticePeriod || '',
            resumeUrl: candidate.resumeUrl || '',
            resumePublicId: candidate.resumePublicId || '',
            uploadedBy: req.user._id,
            profilePulledBy: `${req.user.firstName || ''} ${req.user.lastName || ''}`.trim(),
            remark: `Transferred from ${candidate.hiringRequestId}. Original remark: ${candidate.remark || 'None'}`,
            status: 'Total Sourced',
            profileShared: false,
            decision: 'None',
            phase2Decision: 'None',
            phase3Decision: 'None',
            isTransferred: true,
            transferredFrom: candidate.hiringRequestId
        });

        await newCandidate.save();

        await Candidate.findByIdAndUpdate(candidate._id, {
            isTransferred: true,
            transferredTo: targetRequisitionId
        });

        res.status(201).json({
            message: `Candidate ${candidate.candidateName} transferred successfully to ${targetReq.requestId}`,
            newCandidate
        });

    } catch (error) {
        if (error.code === 11000) {
            return res.status(409).json({ message: 'This candidate already exists in the target requisition' });
        }
        console.error('Error transferring candidate:', error);
        res.status(500).json({ message: 'Failed to transfer candidate', error: error.message });
    }
};

exports.transferCandidateToRequisition = async (req, res) => {
    try {
        const { targetRequisitionId, candidateId } = req.params;

        req.body = { ...(req.body || {}), targetRequisitionId };
        return exports.transferCandidate(req, res);
    } catch (error) {
        console.error('Error transferring candidate via path param:', error);
        res.status(500).json({ message: 'Failed to transfer candidate', error: error.message });
    }
};

exports.transferCandidatesBulk = async (req, res) => {
    try {
        let { candidateIds, targetRequisitionId, transfers } = req.body || {};

        if (Array.isArray(transfers) && transfers.length > 0) {
            candidateIds = transfers.map(t => t.candidateId || t._id).filter(Boolean);
            targetRequisitionId = targetRequisitionId || transfers[0]?.toRequisitionId || transfers[0]?.targetRequisitionId;
        }

        if (!Array.isArray(candidateIds) || candidateIds.length === 0) {
            return res.status(400).json({ message: 'An array of candidateIds is required' });
        }

        if (!targetRequisitionId) {
            return res.status(400).json({ message: 'Target hiring request ID is required' });
        }

        const targetReq = await HiringRequest.findOne({
            _id: targetRequisitionId,
            companyId: req.companyId,
            status: { $nin: ['Closed', 'Rejected'] }
        });

        if (!targetReq) {
            return res.status(404).json({ message: 'Target hiring request not found or is closed' });
        }

        const sourceCandidates = await Candidate.find({
            _id: { $in: candidateIds },
            companyId: req.companyId
        });

        if (sourceCandidates.length === 0) {
            return res.status(404).json({ message: 'No valid source candidates found' });
        }

        const targetCandidates = await Candidate.find({
            hiringRequestId: targetRequisitionId,
            companyId: req.companyId
        }).select('email mobile');

        const existingEmails = new Set(targetCandidates.map(c => c.email ? String(c.email).trim().toLowerCase() : '').filter(Boolean));
        const existingMobiles = new Set(targetCandidates.map(c => c.mobile ? String(c.mobile).trim() : '').filter(Boolean));

        const results = {
            transferred: [],
            skipped: [],
            failed: []
        };

        for (const candidate of sourceCandidates) {
            try {
                if (candidate.hiringRequestId.toString() === targetRequisitionId.toString()) {
                    results.skipped.push({
                        candidateId: candidate._id,
                        name: candidate.candidateName,
                        reason: 'Candidate already belongs to target requisition'
                    });
                    continue;
                }

                const candidateEmail = candidate.email ? String(candidate.email).trim().toLowerCase() : '';
                const candidateMobile = candidate.mobile ? String(candidate.mobile).trim() : '';

                const isEmailDuplicate = candidateEmail && existingEmails.has(candidateEmail);
                const isMobileDuplicate = candidateMobile && existingMobiles.has(candidateMobile);

                if (isEmailDuplicate || isMobileDuplicate) {
                    results.skipped.push({
                        candidateId: candidate._id,
                        name: candidate.candidateName,
                        reason: 'Candidate with matching email or phone already exists in target requisition'
                    });
                    continue;
                }

                const newCandidate = new Candidate({
                    hiringRequestId: targetRequisitionId,
                    companyId: req.companyId,
                    applicantId: candidate.applicantId || undefined,
                    publicApplicationId: candidate.publicApplicationId || undefined,
                    profileSnapshot: candidate.profileSnapshot || undefined,
                    candidateName: candidate.candidateName,
                    email: candidateEmail,
                    mobile: candidateMobile,
                    source: candidate.source || 'Transfer',
                    totalExperience: candidate.totalExperience || 0,
                    currentCTC: candidate.currentCTC || '',
                    expectedCTC: candidate.expectedCTC || '',
                    noticePeriod: candidate.noticePeriod || '',
                    resumeUrl: candidate.resumeUrl || '',
                    resumePublicId: candidate.resumePublicId || '',
                    uploadedBy: req.user._id,
                    profilePulledBy: `${req.user.firstName || ''} ${req.user.lastName || ''}`.trim(),
                    remark: `Bulk transferred from ${candidate.hiringRequestId}. Original remark: ${candidate.remark || 'None'}`,
                    status: 'Total Sourced',
                    profileShared: false,
                    decision: 'None',
                    phase2Decision: 'None',
                    phase3Decision: 'None',
                    isTransferred: true,
                    transferredFrom: candidate.hiringRequestId
                });

                await newCandidate.save();

                if (candidateEmail) existingEmails.add(candidateEmail);
                if (candidateMobile) existingMobiles.add(candidateMobile);

                results.transferred.push({
                    candidateId: candidate._id,
                    newCandidateId: newCandidate._id,
                    name: candidate.candidateName
                });

            } catch (err) {
                if (err.code === 11000) {
                    results.skipped.push({
                        candidateId: candidate._id,
                        name: candidate.candidateName,
                        reason: 'Duplicate entry error'
                    });
                } else {
                    results.failed.push({
                        candidateId: candidate._id,
                        name: candidate.candidateName,
                        error: err.message
                    });
                }
            }
        }

        res.status(200).json({
            message: `Bulk transfer completed: ${results.transferred.length} transferred, ${results.skipped.length} skipped, ${results.failed.length} failed.`,
            targetRequisition: {
                _id: targetReq._id,
                requestId: targetReq.requestId,
                jobTitle: targetReq.roleDetails?.jobTitle
            },
            results
        });

    } catch (error) {
        console.error('Error in bulk transfer candidates:', error);
        res.status(500).json({ message: 'Failed to complete bulk transfer', error: error.message });
    }
};
