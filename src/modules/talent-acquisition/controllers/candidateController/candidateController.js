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

const formatTransferDateTime = (date = new Date()) => {
    const d = new Date(date);
    const day = String(d.getDate()).padStart(2, '0');
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const month = months[d.getMonth()];
    const year = d.getFullYear();
    let hours = d.getHours();
    const minutes = String(d.getMinutes()).padStart(2, '0');
    const ampm = hours >= 12 ? 'PM' : 'AM';
    hours = hours % 12;
    hours = hours ? hours : 12;
    const strHours = String(hours).padStart(2, '0');
    return `${day} ${month} ${year} at ${strHours}:${minutes} ${ampm}`;
};

const buildTransferRemark = ({ originLabel, isUpdate = false, previousRemark = '', transferTimeStr }) => {
    const timeStr = transferTimeStr || formatTransferDateTime();
    const action = isUpdate ? 'Transferred and updated' : 'Transferred';
    const mainMsg = `${action} from ${originLabel} on ${timeStr}`;

    let cleanPrevRemark = '';
    if (previousRemark && typeof previousRemark === 'string') {
        const lines = previousRemark.split('\n');
        const nonTransferLines = lines.filter(line => {
            const trimmed = line.trim();
            if (!trimmed) return false;
            if (trimmed.startsWith('Transferred from') || trimmed.startsWith('Transferred and updated from')) return false;
            if (/^(?:Original|Latest)\s+remark:\s*(?:None|undefined|null)?$/i.test(trimmed)) return false;
            return true;
        });
        cleanPrevRemark = nonTransferLines.join('\n').trim();
        if (cleanPrevRemark.toLowerCase() === 'none') cleanPrevRemark = '';
    }

    if (cleanPrevRemark) {
        const remarkPrefix = isUpdate ? 'Latest remark' : 'Original remark';
        return `${mainMsg}.\n${remarkPrefix}: ${cleanPrevRemark}`;
    }
    return `${mainMsg}.`;
};

const buildTransferredCandidateData = (
    candidate,
    targetRequisitionId,
    companyId,
    user,
    includeInterviewDetails = true,
    sourceReq = null,
    isUpdate = false
) => {
    const originName = sourceReq?.roleDetails?.title || sourceReq?.roleDetails?.jobTitle || sourceReq?.requestId || 'previous requisition';
    const originLabel = originName;

    const remark = buildTransferRemark({
        originLabel,
        isUpdate,
        previousRemark: candidate.remark
    });

    const candidateData = {
        hiringRequestId: targetRequisitionId,
        companyId,
        applicantId: candidate.applicantId || undefined,
        publicApplicationId: candidate.publicApplicationId || undefined,
        profileSnapshot: candidate.profileSnapshot || undefined,
        candidateName: candidate.candidateName,
        email: candidate.email ? String(candidate.email).trim().toLowerCase() : '',
        mobile: candidate.mobile ? String(candidate.mobile).trim() : '',
        source: candidate.source || 'Transfer',
        totalExperience: Number(candidate.totalExperience) || 0,
        relevantExperience: Number(candidate.relevantExperience) || 0,
        qualification: candidate.qualification || '',
        currentCompany: candidate.currentCompany || '',
        pastExperience: Array.isArray(candidate.pastExperience) ? candidate.pastExperience.map(p => ({
            companyName: p.companyName,
            experienceYears: p.experienceYears,
            role: p.role
        })) : [],
        mustHaveSkills: Array.isArray(candidate.mustHaveSkills) ? candidate.mustHaveSkills.map(s => ({
            skill: s.skill,
            experience: s.experience
        })) : [],
        niceToHaveSkills: Array.isArray(candidate.niceToHaveSkills) ? candidate.niceToHaveSkills.map(s => ({
            skill: s.skill,
            experience: s.experience
        })) : [],
        currentLocation: candidate.currentLocation || '',
        preferredLocation: candidate.preferredLocation || '',
        tatToJoin: candidate.tatToJoin !== undefined && candidate.tatToJoin !== '' ? Number(candidate.tatToJoin) : 0,
        noticePeriod: candidate.noticePeriod !== undefined && candidate.noticePeriod !== '' ? Number(candidate.noticePeriod) : undefined,
        lastWorkingDay: candidate.lastWorkingDay || undefined,
        currentCTC: candidate.currentCTC !== undefined && candidate.currentCTC !== '' ? Number(candidate.currentCTC) : undefined,
        expectedCTC: candidate.expectedCTC !== undefined && candidate.expectedCTC !== '' ? Number(candidate.expectedCTC) : undefined,
        inHandOffer: Boolean(candidate.inHandOffer),
        offerCompany: candidate.offerCompany || '',
        offerCTC: candidate.offerCTC !== undefined && candidate.offerCTC !== '' ? Number(candidate.offerCTC) : undefined,
        offerJoiningDate: candidate.offerJoiningDate || undefined,
        preference: candidate.preference || undefined,
        calledBy: candidate.calledBy || '',
        rate: candidate.rate !== undefined && candidate.rate !== '' ? Number(candidate.rate) : undefined,
        referralName: candidate.referralName || '',
        resumeUrl: candidate.resumeUrl || '',
        resumePublicId: candidate.resumePublicId || '',
        uploadedBy: user?._id || candidate.uploadedBy,
        profilePulledBy: `${user?.firstName || ''} ${user?.lastName || ''}`.trim() || candidate.profilePulledBy,
        remark,
        internalRemark: candidate.internalRemark || '',
        isTransferred: true,
        transferredFrom: candidate.hiringRequestId
    };

    if (includeInterviewDetails) {
        candidateData.interviewRounds = Array.isArray(candidate.interviewRounds)
            ? candidate.interviewRounds.map(r => ({
                levelName: r.levelName,
                assignAfterStage: r.assignAfterStage,
                phase: r.phase,
                assignedTo: Array.isArray(r.assignedTo) ? r.assignedTo : [],
                status: r.status,
                scheduledDate: r.scheduledDate,
                feedback: r.feedback,
                rating: r.rating,
                evaluatedBy: r.evaluatedBy,
                evaluatedAt: r.evaluatedAt,
                skillRatings: Array.isArray(r.skillRatings) ? r.skillRatings : [],
                customFields: Array.isArray(r.customFields) ? r.customFields : [],
                emailTemplateId: r.emailTemplateId || null,
                emailAccountId: r.emailAccountId || null,
                cc: r.cc || '',
                bcc: r.bcc || '',
                customSubject: r.customSubject || '',
                customHtmlBody: r.customHtmlBody || '',
                mailSent: Boolean(r.mailSent),
                mailSentAt: r.mailSentAt || null,
                lastMailDetails: r.lastMailDetails || undefined
            }))
            : [];

        candidateData.skillRatings = Array.isArray(candidate.skillRatings) ? candidate.skillRatings : [];
        candidateData.status = candidate.status || 'Total Sourced';
        candidateData.profileShared = Boolean(candidate.profileShared);
        candidateData.decision = candidate.decision || 'None';
        candidateData.phase2Decision = candidate.phase2Decision || 'None';
        candidateData.phase2InterviewStatus = candidate.phase2InterviewStatus || 'None';
        candidateData.phase2InterviewerFeedback = candidate.phase2InterviewerFeedback || '';
        candidateData.phase3Decision = candidate.phase3Decision || 'None';
        candidateData.phaseHistory = Array.isArray(candidate.phaseHistory) ? candidate.phaseHistory : [];
        candidateData.currentPhaseId = candidate.currentPhaseId;
        candidateData.currentPhaseOrder = candidate.currentPhaseOrder;
        candidateData.currentPhaseStatus = candidate.currentPhaseStatus;
        candidateData.currentPhaseName = candidate.currentPhaseName;
    } else {
        candidateData.interviewRounds = [];
        candidateData.skillRatings = [];
        candidateData.status = 'Total Sourced';
        candidateData.profileShared = false;
        candidateData.decision = 'None';
        candidateData.phase2Decision = 'None';
        candidateData.phase2InterviewStatus = 'None';
        candidateData.phase2InterviewerFeedback = '';
        candidateData.phase3Decision = 'None';
        candidateData.phaseHistory = [];
    }

    return candidateData;
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

        const includeInterviewDetails = req.body?.includeInterviewDetails !== undefined
            ? Boolean(req.body.includeInterviewDetails)
            : (req.body?.shareInterviewDetails !== undefined ? Boolean(req.body.shareInterviewDetails) : true);

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

        const sourceReq = await HiringRequest.findOne({
            _id: candidate.hiringRequestId,
            companyId: req.companyId
        }).select('requestId roleDetails client');

        const candidateData = buildTransferredCandidateData(
            candidate,
            targetRequisitionId,
            req.companyId,
            req.user,
            includeInterviewDetails,
            sourceReq,
            Boolean(existingCandidateInTarget)
        );

        if (existingCandidateInTarget) {
            // Update existing candidate in target requisition with latest details from source
            if (!includeInterviewDetails) {
                delete candidateData.interviewRounds;
                delete candidateData.skillRatings;
                delete candidateData.status;
                delete candidateData.profileShared;
                delete candidateData.decision;
                delete candidateData.phase2Decision;
                delete candidateData.phase2InterviewStatus;
                delete candidateData.phase2InterviewerFeedback;
                delete candidateData.phase3Decision;
                delete candidateData.phaseHistory;
                delete candidateData.currentPhaseId;
                delete candidateData.currentPhaseOrder;
                delete candidateData.currentPhaseStatus;
                delete candidateData.currentPhaseName;
            }

            Object.assign(existingCandidateInTarget, candidateData);
            await existingCandidateInTarget.save();

            await Candidate.findByIdAndUpdate(candidate._id, {
                isTransferred: true,
                transferredTo: targetRequisitionId
            });

            return res.status(200).json({
                message: `Candidate ${candidate.candidateName} updated successfully in ${targetReq.requestId}`,
                candidate: existingCandidateInTarget,
                newCandidate: existingCandidateInTarget,
                isUpdated: true
            });
        }

        const newCandidate = new Candidate(candidateData);
        await newCandidate.save();

        await Candidate.findByIdAndUpdate(candidate._id, {
            isTransferred: true,
            transferredTo: targetRequisitionId
        });

        res.status(201).json({
            message: `Candidate ${candidate.candidateName} transferred successfully to ${targetReq.requestId}`,
            newCandidate,
            isUpdated: false
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
        let { candidateIds, targetRequisitionId, transfers, includeInterviewDetails } = req.body || {};

        const defaultIncludeInterviewDetails = includeInterviewDetails !== undefined
            ? Boolean(includeInterviewDetails)
            : (req.body?.shareInterviewDetails !== undefined ? Boolean(req.body.shareInterviewDetails) : true);

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
        });

        const targetCandidatesByEmail = new Map();
        const targetCandidatesByMobile = new Map();
        for (const tc of targetCandidates) {
            if (tc.email) targetCandidatesByEmail.set(String(tc.email).trim().toLowerCase(), tc);
            if (tc.mobile) targetCandidatesByMobile.set(String(tc.mobile).trim(), tc);
        }

        const sourceReqIds = [...new Set(sourceCandidates.map(c => String(c.hiringRequestId)).filter(Boolean))];
        const sourceReqs = await HiringRequest.find({
            _id: { $in: sourceReqIds },
            companyId: req.companyId
        }).select('requestId roleDetails client');

        const sourceReqMap = new Map();
        for (const sr of sourceReqs) {
            sourceReqMap.set(String(sr._id), sr);
        }

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

                // Check transfer-level override for includeInterviewDetails
                let candidateIncludeInterviews = defaultIncludeInterviewDetails;
                if (Array.isArray(transfers)) {
                    const matchedTransfer = transfers.find(t => String(t.candidateId || t._id) === String(candidate._id));
                    if (matchedTransfer && matchedTransfer.includeInterviewDetails !== undefined) {
                        candidateIncludeInterviews = Boolean(matchedTransfer.includeInterviewDetails);
                    } else if (matchedTransfer && matchedTransfer.shareInterviewDetails !== undefined) {
                        candidateIncludeInterviews = Boolean(matchedTransfer.shareInterviewDetails);
                    }
                }

                const existingTarget = (candidateEmail && targetCandidatesByEmail.get(candidateEmail))
                    || (candidateMobile && targetCandidatesByMobile.get(candidateMobile));

                const sourceReq = sourceReqMap.get(String(candidate.hiringRequestId));

                const candidateData = buildTransferredCandidateData(
                    candidate,
                    targetRequisitionId,
                    req.companyId,
                    req.user,
                    candidateIncludeInterviews,
                    sourceReq,
                    Boolean(existingTarget)
                );

                if (existingTarget) {
                    // Update existing candidate in target requisition with latest details
                    if (!candidateIncludeInterviews) {
                        delete candidateData.interviewRounds;
                        delete candidateData.skillRatings;
                        delete candidateData.status;
                        delete candidateData.profileShared;
                        delete candidateData.decision;
                        delete candidateData.phase2Decision;
                        delete candidateData.phase2InterviewStatus;
                        delete candidateData.phase2InterviewerFeedback;
                        delete candidateData.phase3Decision;
                        delete candidateData.phaseHistory;
                        delete candidateData.currentPhaseId;
                        delete candidateData.currentPhaseOrder;
                        delete candidateData.currentPhaseStatus;
                        delete candidateData.currentPhaseName;
                    }

                    Object.assign(existingTarget, candidateData);
                    await existingTarget.save();

                    await Candidate.findByIdAndUpdate(candidate._id, {
                        isTransferred: true,
                        transferredTo: targetRequisitionId
                    });

                    results.transferred.push({
                        candidateId: candidate._id,
                        newCandidateId: existingTarget._id,
                        name: candidate.candidateName,
                        isUpdated: true
                    });
                    continue;
                }

                const newCandidate = new Candidate(candidateData);
                await newCandidate.save();

                await Candidate.findByIdAndUpdate(candidate._id, {
                    isTransferred: true,
                    transferredTo: targetRequisitionId
                });

                if (candidateEmail) targetCandidatesByEmail.set(candidateEmail, newCandidate);
                if (candidateMobile) targetCandidatesByMobile.set(candidateMobile, newCandidate);

                results.transferred.push({
                    candidateId: candidate._id,
                    newCandidateId: newCandidate._id,
                    name: candidate.candidateName,
                    isUpdated: false
                });

            } catch (err) {
                if (err.code === 11000) {
                    try {
                        // Fallback: try finding and updating on race condition
                        const candidateEmail = candidate.email ? String(candidate.email).trim().toLowerCase() : '';
                        const candidateMobile = candidate.mobile ? String(candidate.mobile).trim() : '';
                        const fallbackTarget = await Candidate.findOne({
                            companyId: req.companyId,
                            hiringRequestId: targetRequisitionId,
                            $or: [
                                ...(candidateEmail ? [{ email: candidateEmail }] : []),
                                ...(candidateMobile ? [{ mobile: candidateMobile }] : [])
                            ]
                        });
                        if (fallbackTarget) {
                            const sourceReq = sourceReqMap.get(String(candidate.hiringRequestId));
                            const candidateData = buildTransferredCandidateData(
                                candidate,
                                targetRequisitionId,
                                req.companyId,
                                req.user,
                                defaultIncludeInterviewDetails,
                                sourceReq,
                                true
                            );
                            Object.assign(fallbackTarget, candidateData);
                            await fallbackTarget.save();
                            await Candidate.findByIdAndUpdate(candidate._id, {
                                isTransferred: true,
                                transferredTo: targetRequisitionId
                            });
                            results.transferred.push({
                                candidateId: candidate._id,
                                newCandidateId: fallbackTarget._id,
                                name: candidate.candidateName,
                                isUpdated: true
                            });
                            continue;
                        }
                    } catch (innerErr) {
                        // Fall through to skipped
                    }
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

        const updatedCount = results.transferred.filter(t => t.isUpdated).length;
        const newCount = results.transferred.length - updatedCount;

        let message = `Bulk transfer completed: ${results.transferred.length} candidate(s) processed.`;
        if (updatedCount > 0 && newCount > 0) {
            message = `Bulk transfer completed: ${newCount} transferred, ${updatedCount} updated in ${targetReq.requestId}.`;
        } else if (updatedCount > 0) {
            message = `Bulk transfer completed: ${updatedCount} candidate(s) updated in ${targetReq.requestId}.`;
        } else {
            message = `Bulk transfer completed: ${newCount} candidate(s) transferred to ${targetReq.requestId}.`;
        }

        res.status(200).json({
            message,
            targetRequisition: {
                _id: targetReq._id,
                requestId: targetReq.requestId,
                jobTitle: targetReq.roleDetails?.jobTitle
            },
            transferred: results.transferred.length,
            newlyTransferred: newCount,
            updated: updatedCount,
            skipped: results.skipped.length,
            failed: results.failed.length,
            results
        });

    } catch (error) {
        console.error('Error in bulk transfer candidates:', error);
        res.status(500).json({ message: 'Failed to complete bulk transfer', error: error.message });
    }
};
