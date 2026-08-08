const Candidate = require('../../model/candidate.model');
const { HiringRequest } = require('../../model/hiringRequest.model');
const mongoose = require('mongoose');
const {
    TA_CAPABILITIES,
    buildAccessibleCandidateQuery,
    canAccessHiringRequestForCapability,
    findDuplicateCandidateInCompany,
    isCandidateOwnedByUser,
    canOverrideDuplicateCandidateOwnership,
    buildDuplicateCandidateMessage,
    getUserDisplayName
} = require('../../utils/candidateAccess');

exports.checkDuplicateCandidate = async (req, res) => {
    try {
        const { hiringRequestId, email, mobile, allowOwnedDuplicateUpdate } = req.query;

        if (!mongoose.Types.ObjectId.isValid(hiringRequestId)) {
            return res.status(400).json({ message: 'Invalid Hiring Request ID format' });
        }

        const hiringRequest = await HiringRequest.findOne({ _id: hiringRequestId, companyId: req.companyId });
        if (!hiringRequest) {
            return res.status(404).json({ message: 'Hiring request not found' });
        }

        const canManageHiringRequest = await canAccessHiringRequestForCapability(
            hiringRequest,
            req.user,
            TA_CAPABILITIES.EDIT,
            req.companyId
        );

        if (!canManageHiringRequest) {
            return res.status(403).json({ message: 'Forbidden: You do not have permission to add candidates to this requisition' });
        }

        const duplicateCandidate = await findDuplicateCandidateInCompany({
            companyId: req.companyId,
            hiringRequestId,
            email,
            mobile
        });

        const ownedByCurrentUser = duplicateCandidate
            ? isCandidateOwnedByUser(duplicateCandidate, req.user?._id)
            : false;
        const hasDuplicateOverrideAccess = duplicateCandidate
            ? await canOverrideDuplicateCandidateOwnership({
                user: req.user,
                companyId: req.companyId,
                hiringRequest
            })
            : false;
        const canAutoUpdate = Boolean(allowOwnedDuplicateUpdate) && (ownedByCurrentUser || hasDuplicateOverrideAccess);

        return res.status(200).json({
            exists: Boolean(duplicateCandidate),
            canAutoUpdate,
            ownedByCurrentUser,
            uploadedByName: getUserDisplayName(duplicateCandidate?.uploadedBy),
            message: duplicateCandidate
                ? buildDuplicateCandidateMessage(duplicateCandidate, req.user?._id, canAutoUpdate)
                : ''
        });
    } catch (error) {
        console.error('Error checking duplicate candidate:', error);
        return res.status(500).json({ message: 'Server error', error: error.message });
    }
};

exports.getCandidatesByPulledBy = async (req, res) => {
    try {
        const { userName } = req.params;
        const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
        const limit = Math.max(parseInt(req.query.limit, 10) || 10, 1);
        const skip = (page - 1) * limit;

        const query = await buildAccessibleCandidateQuery(req.companyId, req.user, {
            profilePulledBy: { $regex: new RegExp(`^${userName}$`, 'i') }
        }, { capability: TA_CAPABILITIES.VIEW });

        const [totalCandidates, summaryRows, candidates] = await Promise.all([
            Candidate.countDocuments(query),
            Candidate.aggregate([
                { $match: query },
                {
                    $project: {
                        status: 1,
                        decision: 1,
                        interviewRounds: { $ifNull: ['$interviewRounds', []] }
                    }
                },
                {
                    $addFields: {
                        interviewRoundsCount: { $size: '$interviewRounds' },
                        failedRoundsCount: {
                            $size: {
                                $filter: {
                                    input: '$interviewRounds',
                                    as: 'round',
                                    cond: { $eq: ['$$round.status', 'Failed'] }
                                }
                            }
                        }
                    }
                },
                {
                    $group: {
                        _id: null,
                        total: { $sum: 1 },
                        interested: {
                            $sum: {
                                $cond: [
                                    {
                                        $and: [
                                            { $eq: ['$status', 'Interested'] },
                                            { $not: [{ $in: ['$decision', ['Rejected', 'On Hold', 'Did Not Turn Up']] }] },
                                            { $eq: ['$interviewRoundsCount', 0] }
                                        ]
                                    },
                                    1,
                                    0
                                ]
                            }
                        },
                        inInterviews: {
                            $sum: {
                                $cond: [
                                    {
                                        $and: [
                                            { $gt: ['$interviewRoundsCount', 0] },
                                            { $not: [{ $in: ['$decision', ['Rejected', 'On Hold', 'Did Not Turn Up']] }] },
                                            { $eq: ['$failedRoundsCount', 0] }
                                        ]
                                    },
                                    1,
                                    0
                                ]
                            }
                        },
                        rejected: {
                            $sum: {
                                $cond: [{ $in: ['$decision', ['Rejected', 'Did Not Turn Up']] }, 1, 0]
                            }
                        },
                        onHold: {
                            $sum: {
                                $cond: [{ $eq: ['$decision', 'On Hold'] }, 1, 0]
                            }
                        }
                    }
                }
            ]),
            Candidate.find(query)
                .populate('hiringRequestId', 'requestId roleDetails')
                .populate('uploadedBy', 'firstName lastName email')
                .sort({ uploadedAt: -1 })
                .skip(skip)
                .limit(limit)
                .lean()
        ]);

        const summary = summaryRows[0] || {
            total: totalCandidates,
            interested: 0,
            inInterviews: 0,
            rejected: 0,
            onHold: 0
        };

        res.status(200).json({
            count: totalCandidates,
            currentPage: page,
            limit,
            totalPages: Math.ceil(totalCandidates / limit) || 1,
            summary,
            candidates
        });

    } catch (error) {
        console.error('Error fetching candidates by pulled by:', error);
        res.status(500).json({ message: 'Server error fetching candidates', error: error.message });
    }
};
