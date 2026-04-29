const Candidate = require('../models/Candidate');
const { HiringRequest } = require('../models/HiringRequest');
const { cloudinary } = require('../config/cloudinary');
const { extractPublicIdFromUrl } = require('../utils/cloudinaryHelper');
const mongoose = require('mongoose');
const Company = require('../models/Company');
const { sendEmail } = require('../services/emailService');
const NotificationService = require('../services/notificationService');
const OnboardingEmployee = require('../models/OnboardingEmployee');
const CandidateSource = require('../models/CandidateSource');
const { parseCV } = require('../utils/cvParser');
const PublicApplication = require('../models/PublicApplication');

const APPLICANT_REVIEW_SELECT = [
    'firstName',
    'lastName',
    'email',
    'mobile',
    'headline',
    'summary',
    'currentCity',
    'currentState',
    'currentCountry',
    'willingToRelocate',
    'preferredLocations',
    'preferredJobTypes',
    'preferredDepartments',
    'jobSearchStatus',
    'currentCTC',
    'expectedCTC',
    'noticePeriod',
    'totalExperienceYears',
    'workExperience',
    'education',
    'skills',
    'certifications',
    'languages',
    'linkedinUrl',
    'githubUrl',
    'portfolioUrl',
    'otherLinks',
    'resumeUrl',
    'resumeFileName',
    'resumeUpdatedAt',
    'profilePhotoUrl',
    'profileCompletionScore',
    'createdAt',
    'updatedAt'
].join(' ');

const enrichCandidatesWithPublicProfiles = async (candidates, companyId) => {
    const candidateList = Array.isArray(candidates) ? candidates : [candidates].filter(Boolean);
    if (!candidateList.length) return candidates;

    const missingPublicProfileIds = candidateList
        .filter((candidate) => !candidate.publicApplicationId && !candidate.applicantId && !candidate.profileSnapshot)
        .map((candidate) => candidate._id)
        .filter(Boolean);

    let applicationsByCandidate = new Map();
    if (missingPublicProfileIds.length) {
        const publicApplications = await PublicApplication.find({
            companyId,
            transferredCandidateId: { $in: missingPublicProfileIds }
        })
            .populate('applicantId', APPLICANT_REVIEW_SELECT)
            .lean();

        applicationsByCandidate = new Map(
            publicApplications.map((application) => [application.transferredCandidateId?.toString(), application])
        );
    }

    const enriched = candidateList.map((candidate) => {
        const publicApplication = applicationsByCandidate.get(candidate._id?.toString());
        if (!publicApplication) return candidate;

        return {
            ...candidate,
            applicantId: candidate.applicantId || publicApplication.applicantId,
            publicApplicationId: candidate.publicApplicationId || publicApplication._id,
            profileSnapshot: candidate.profileSnapshot || publicApplication.profileSnapshot,
            publicApplicationReviewStatus: publicApplication.reviewStatus,
            publicApplicationAppliedAt: publicApplication.createdAt,
            coverNote: candidate.coverNote || publicApplication.coverNote
        };
    });

    return Array.isArray(candidates) ? enriched : enriched[0];
};

// Upload resume to Cloudinary
exports.uploadResume = async (req, res) => {
    try {
        const { hiringRequestId } = req.params;

        console.log('📤 Upload resume request for hiring request:', hiringRequestId);

        // Verify hiring request exists
        const hiringRequest = await HiringRequest.findOne({ _id: hiringRequestId, companyId: req.companyId });
        if (!hiringRequest) {
            return res.status(404).json({ message: 'Hiring request not found' });
        }

        // Check if file is uploaded
        if (!req.file) {
            console.log('❌ No file in request');
            return res.status(400).json({ message: 'No file uploaded' });
        }

        console.log('📄 File received:', {
            originalname: req.file.originalname,
            mimetype: req.file.mimetype,
            size: req.file.size,
            path: req.file.path
        });

        // File is already uploaded to Cloudinary by multer middleware
        // req.file.path contains the Cloudinary URL
        const resumeUrl = req.file.path;

        // Extract public_id from the Cloudinary URL
        const { extractPublicIdFromUrl } = require('../utils/cloudinaryHelper');
        const resumePublicId = extractPublicIdFromUrl(resumeUrl);

        console.log('✅ Resume uploaded successfully to Cloudinary');
        console.log('📎 Public ID:', resumePublicId);
        console.log('📎 Resume URL:', resumeUrl);

        res.status(200).json({
            message: 'Resume uploaded successfully',
            resumeUrl: resumeUrl,
            resumePublicId: resumePublicId
        });

    } catch (error) {
        console.error('❌ Error uploading resume:', error);
        res.status(500).json({ message: 'Server error', error: error.message });
    }
};

// Parse resume without saving to DB
exports.parseResume = async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ message: 'No resume file uploaded' });
        }

        const fileBuffer = req.file.buffer;
        const fileType = req.file.mimetype;

        const parsedData = await parseCV(fileBuffer, fileType);

        res.status(200).json({
            message: 'Resume parsed successfully',
            data: parsedData
        });

    } catch (error) {
        console.error('Error parsing resume:', error);
        res.status(500).json({ message: 'Failed to parse resume', error: error.message });
    }
};

// Create new candidate
exports.createCandidate = async (req, res) => {
    try {
        const {
            hiringRequestId,
            resumeUrl,
            resumePublicId,
            candidateName,
            email,
            mobile,
            source,
            referralName,
            profilePulledBy,
            calledBy,
            rate,
            currentCTC,
            expectedCTC,
            inHandOffer,
            offerCompany,
            offerCTC,
            preference,
            totalExperience,
            qualification,
            currentCompany,
            pastExperience,
            currentLocation,
            preferredLocation,
            tatToJoin,
            noticePeriod,
            lastWorkingDay,
            status,
            remark,
            mustHaveSkills,
            niceToHaveSkills,
            interviewRounds
        } = req.body;

        // Verify hiring request exists
        const hiringRequest = await HiringRequest.findOne({ _id: hiringRequestId, companyId: req.companyId });
        if (!hiringRequest) {
            return res.status(404).json({ message: 'Hiring request not found' });
        }

        // Check for duplicate email or mobile in same hiring request
        let candidate = await Candidate.findOne({
            hiringRequestId,
            $or: [{ email: email.toLowerCase().trim() }, { mobile: mobile.trim() }],
            companyId: req.companyId
        });

        if (candidate) {
            // Update mode
            console.log('🔄 Existing candidate found, updating fields...');

            // Track status change for history
            const statusChanged = status && candidate.status !== status;

            const updatedFields = [];
            const compareAndUpdate = (field, newValue, label) => {
                if (newValue !== undefined && newValue !== null && newValue !== '' && candidate[field] !== newValue) {
                    candidate[field] = newValue;
                    updatedFields.push(label || field);
                }
            };

            compareAndUpdate('candidateName', candidateName, 'Name');
            compareAndUpdate('mobile', mobile, 'Mobile');
            compareAndUpdate('source', source, 'Source');
            compareAndUpdate('profilePulledBy', profilePulledBy, 'Pulled By');
            compareAndUpdate('calledBy', calledBy, 'Called By');
            compareAndUpdate('rate', rate, 'Rate');
            compareAndUpdate('currentCTC', currentCTC, 'Current CTC');
            compareAndUpdate('expectedCTC', expectedCTC, 'Expected CTC');
            compareAndUpdate('inHandOffer', inHandOffer, 'Offer in Hand');
            compareAndUpdate('offerCompany', offerCompany, 'Offer Company');
            compareAndUpdate('offerCTC', offerCTC, 'Offer CTC');
            compareAndUpdate('totalExperience', totalExperience, 'Experience');
            compareAndUpdate('qualification', qualification, 'Qualification');
            compareAndUpdate('currentCompany', currentCompany, 'Company');
            compareAndUpdate('currentLocation', currentLocation, 'Location');
            compareAndUpdate('preferredLocation', preferredLocation, 'Preferred Location');
            compareAndUpdate('tatToJoin', tatToJoin, 'TAT Join');
            compareAndUpdate('noticePeriod', noticePeriod, 'Notice Period');
            compareAndUpdate('lastWorkingDay', lastWorkingDay, 'DOJ/LWD');
            compareAndUpdate('status', status, 'Status');
            compareAndUpdate('decision', req.body.decision, 'Decision');
            compareAndUpdate('remark', remark, 'Remark');

            if (mustHaveSkills && Array.isArray(mustHaveSkills)) {
                const existingSkills = candidate.mustHaveSkills || [];
                const skillsChanged = existingSkills.length !== mustHaveSkills.length ||
                    mustHaveSkills.some((s, idx) =>
                        !existingSkills[idx] ||
                        existingSkills[idx].skill !== s.skill ||
                        existingSkills[idx].experience !== s.experience
                    );

                if (skillsChanged) {
                    candidate.mustHaveSkills = mustHaveSkills;
                    updatedFields.push('Skills');
                }
            }
            if (niceToHaveSkills && Array.isArray(niceToHaveSkills)) {
                candidate.niceToHaveSkills = niceToHaveSkills;
            }
            if (interviewRounds && Array.isArray(interviewRounds)) {
                const existingRounds = candidate.interviewRounds || [];
                const roundsChanged = existingRounds.length !== interviewRounds.length ||
                    interviewRounds.some((r, idx) => {
                        const er = existingRounds[idx];
                        if (!er) return true;
                        return er.levelName !== r.levelName ||
                            er.status !== r.status ||
                            er.remarks !== r.remarks ||
                            er.feedback !== r.feedback ||
                            er.rating !== r.rating ||
                            er.evaluatedBy?.toString() !== r.evaluatedBy?.toString();
                    });

                if (roundsChanged) {
                    candidate.interviewRounds = interviewRounds;
                    updatedFields.push('Interview History');
                }
            }

            if (statusChanged) {
                candidate.statusHistory.push({
                    status: status,
                    changedBy: req.user._id,
                    changedAt: new Date(),
                    remark: `Updated via Bulk Import: ${remark || ''}`
                });
            }

            await candidate.save();

            const populatedUpdate = await Candidate.findOne({ _id: candidate._id, companyId: req.companyId })
                .populate('uploadedBy', 'firstName lastName email')
                .populate('hiringRequestId', 'requestId roleDetails')
                .populate('interviewRounds.assignedTo', 'firstName lastName email')
                .populate('interviewRounds.evaluatedBy', 'firstName lastName');

            return res.status(200).json({
                message: 'Candidate updated successfully',
                candidate: populatedUpdate,
                isUpdate: true,
                updatedFields
            });
        }

        // Create mode (original logic continue)
        candidate = new Candidate({
            companyId: req.companyId,
            hiringRequestId,
            resumeUrl,
            resumePublicId,
            uploadedBy: req.user._id,
            candidateName,
            email,
            mobile,
            source,
            referralName,
            profilePulledBy,
            calledBy,
            rate,
            currentCTC,
            expectedCTC,
            inHandOffer: inHandOffer || false,
            offerCompany,
            offerCTC,
            preference,
            totalExperience,
            qualification,
            currentCompany,
            pastExperience,
            currentLocation,
            preferredLocation,
            tatToJoin,
            noticePeriod,
            lastWorkingDay,
            decision: req.body.decision || 'None',
            status: status,
            remark,
            mustHaveSkills: mustHaveSkills || [],
            niceToHaveSkills: niceToHaveSkills || [],
            interviewRounds: interviewRounds || [],
            statusHistory: [{
                status: status,
                changedBy: req.user._id,
                changedAt: new Date(),
                remark
            }]
        });

        await candidate.save();

        const populatedCandidate = await Candidate.findOne({ _id: candidate._id, companyId: req.companyId })
            .populate('uploadedBy', 'firstName lastName email')
            .populate('hiringRequestId', 'requestId roleDetails')
            .populate('interviewRounds.assignedTo', 'firstName lastName email')
            .populate('interviewRounds.evaluatedBy', 'firstName lastName');

        res.status(201).json({
            message: 'Candidate created successfully',
            candidate: populatedCandidate,
            isUpdate: false
        });

    } catch (error) {
        console.error('Error creating candidate:', error);
        if (error.code === 11000) {
            return res.status(400).json({ message: 'A candidate with this email is already added to this hiring request' });
        }
        res.status(500).json({ message: 'Server error', error: error.message });
    }
};

// Get all candidates for a hiring request
exports.getCandidatesByHiringRequest = async (req, res) => {
    try {
        const { hiringRequestId } = req.params;

        if (!mongoose.Types.ObjectId.isValid(hiringRequestId)) {
            return res.status(400).json({ message: 'Invalid Hiring Request ID format' });
        }

        // Verify if user has access to see all candidates vs only assigned ones
        const isAdmin = req.user.roles.some(r => r.name === 'Admin' || r.name === 'HR' || r.name === 'Super Admin');
        const userPermissions = req.user.roles.flatMap(role => (role.permissions || []).map(p => p.key));
        const hasTaView = userPermissions.includes('ta.view') || userPermissions.includes('*');

        // Check if user is creator/HM/recruiter/approver of the hiring request
        const hiringRequest = await HiringRequest.findOne({ _id: hiringRequestId, companyId: req.companyId });
        const isRequestParticipant = hiringRequest && (
            hiringRequest.createdBy?._id?.toString() === req.user._id.toString() ||
            hiringRequest.ownership?.hiringManager?._id?.toString() === req.user._id.toString() ||
            hiringRequest.ownership?.recruiter?._id?.toString() === req.user._id.toString() ||
            hiringRequest.approvalChain?.some(step =>
                step.approvers?.some(approver => approver._id?.toString() === req.user._id.toString() || approver.toString() === req.user._id.toString())
            )
        );

        let query = { hiringRequestId };

        if (!isAdmin && !hasTaView && !isRequestParticipant) {
            // User is likely just an interviewer. Only show candidates they are assigned to.
            query['interviewRounds.assignedTo'] = req.user._id;
        }

        const candidates = await Candidate.find({ ...query, companyId: req.companyId })
            .populate('uploadedBy', 'firstName lastName email')
            .populate('hiringRequestId', 'requestId roleDetails')
            .populate('applicantId', APPLICANT_REVIEW_SELECT)
            .populate('interviewRounds.assignedTo', 'firstName lastName email')
            .populate('interviewRounds.evaluatedBy', 'firstName lastName')
            .sort({ uploadedAt: -1 })
            .lean();

        const enrichedCandidates = await enrichCandidatesWithPublicProfiles(candidates, req.companyId);

        res.status(200).json({
            count: enrichedCandidates.length,
            candidates: enrichedCandidates
        });

    } catch (error) {
        console.error('Error fetching candidates:', error);
        res.status(500).json({ message: 'Server error', error: error.message });
    }
};

// Get shortlisted candidates for a hiring request with pagination
exports.getShortlistedCandidates = async (req, res) => {
    try {
        const { hiringRequestId } = req.params;

        if (!mongoose.Types.ObjectId.isValid(hiringRequestId)) {
            return res.status(400).json({ message: 'Invalid Hiring Request ID format' });
        }

        const page = parseInt(req.query.page, 10) || 1;
        const limit = parseInt(req.query.limit, 10) || 10;
        const skip = (page - 1) * limit;

        const isAdmin = req.user.roles.some(r => r.name === 'Admin' || r.name === 'HR' || r.name === 'Super Admin');
        const userPermissions = req.user.roles.flatMap(role => (role.permissions || []).map(p => p.key));
        const hasTaView = userPermissions.includes('ta.view') || userPermissions.includes('*');

        const hiringRequest = await HiringRequest.findOne({ _id: hiringRequestId, companyId: req.companyId });
        const isRequestParticipant = hiringRequest && (
            hiringRequest.createdBy?._id?.toString() === req.user._id.toString() ||
            hiringRequest.ownership?.hiringManager?._id?.toString() === req.user._id.toString() ||
            hiringRequest.ownership?.recruiter?._id?.toString() === req.user._id.toString() ||
            hiringRequest.approvalChain?.some(step =>
                step.approvers?.some(approver => approver._id?.toString() === req.user._id.toString() || approver.toString() === req.user._id.toString())
            )
        );

        let query = { hiringRequestId, decision: { $in: ['Shortlisted', 'Hired'] } };

        if (!isAdmin && !hasTaView && !isRequestParticipant) {
            query['interviewRounds.assignedTo'] = req.user._id;
        }

        const totalOptions = await Candidate.countDocuments({ ...query, companyId: req.companyId });
        const candidates = await Candidate.find({ ...query, companyId: req.companyId })
            .populate('uploadedBy', 'firstName lastName')
            .populate('hiringRequestId', 'requestId roleDetails')
            .populate('interviewRounds.assignedTo', 'firstName lastName') // only pull what is necessary
            .populate('interviewRounds.evaluatedBy', 'firstName lastName')
            .select('candidateName email mobile status decision uploadedAt interviewRounds profilePulledBy calledBy rate totalExperience currentCTC expectedCTC location expectedLocation pastExperience currentCompany')
            .sort({ uploadedAt: -1 })
            .skip(skip)
            .limit(limit)
            .lean();

        res.status(200).json({
            count: totalOptions,
            totalPages: Math.ceil(totalOptions / limit),
            currentPage: page,
            candidates
        });

    } catch (error) {
        console.error('Error fetching shortlisted candidates:', error);
        res.status(500).json({ message: 'Server error', error: error.message });
    }
};

// Get single candidate by ID
exports.getCandidateById = async (req, res) => {
    try {
        const { id } = req.params;

        let candidateData = await Candidate.findOne({ _id: id, companyId: req.companyId })
            .populate('uploadedBy', 'firstName lastName email')
            .populate('hiringRequestId', 'requestId roleDetails requirements')
            .populate('applicantId', APPLICANT_REVIEW_SELECT)
            .populate('statusHistory.changedBy', 'firstName lastName')
            .populate('interviewRounds.assignedTo', 'firstName lastName email')
            .populate('interviewRounds.evaluatedBy', 'firstName lastName')
            .lean();

        if (!candidateData) {
            return res.status(404).json({ message: 'Candidate not found' });
        }

        // Sync skillRatings from HiringRequest requirements (Smart Sync)
        if (candidateData.hiringRequestId?.requirements) {
            const hrr = candidateData.hiringRequestId.requirements;
            const currentRatings = candidateData.skillRatings || [];
            let hasChanges = false;

            // Helper to add missing skills
            const syncSkills = (skills, category) => {
                if (!skills || !Array.isArray(skills)) return;
                skills.forEach(s => {
                    const exists = currentRatings.some(sr => sr.skill.toLowerCase() === s.toLowerCase());
                    if (!exists) {
                        currentRatings.push({ skill: s, rating: 0, category });
                        hasChanges = true;
                    }
                });
            };

            syncSkills(hrr.mustHaveSkills, 'Must-Have');
            syncSkills(hrr.niceToHaveSkills, 'Nice-To-Have');

            if (hasChanges) {
                await Candidate.findOneAndUpdate({ _id: id, companyId: req.companyId }, { $set: { skillRatings: currentRatings } });
                candidateData.skillRatings = currentRatings;
            }
        }

        const candidate = await enrichCandidatesWithPublicProfiles(candidateData, req.companyId);

        // Verify if user has access to see this candidate
        const isAdmin = req.user.roles.some(r => r.name === 'Admin' || r.name === 'HR' || r.name === 'Super Admin');
        const userPermissions = req.user.roles.flatMap(role => (role.permissions || []).map(p => p.key));
        const hasTaView = userPermissions.includes('ta.view') || userPermissions.includes('*');

        const hiringRequest = candidate.hiringRequestId; // populated object

        const isRequestParticipant = hiringRequest && (
            hiringRequest.createdBy?._id?.toString() === req.user._id.toString() ||
            hiringRequest.ownership?.hiringManager?._id?.toString() === req.user._id.toString() ||
            hiringRequest.ownership?.recruiter?._id?.toString() === req.user._id.toString() ||
            (candidate.hiringRequestId.approvalChain && candidate.hiringRequestId.approvalChain.some(step =>
                step.approvers?.some(approver => approver._id?.toString() === req.user._id.toString() || approver.toString() === req.user._id.toString())
            ))
        );

        // Check if they are assigned to any round for this candidate
        const isAssignedInterviewer = candidate.interviewRounds?.some(round =>
            round.assignedTo?.some(ass => ass._id?.toString() === req.user._id.toString() || ass.toString() === req.user._id.toString())
        );

        if (!isAdmin && !hasTaView && !isRequestParticipant && !isAssignedInterviewer) {
            return res.status(403).json({ message: 'Forbidden: You do not have permission to view this candidate' });
        }

        res.status(200).json(candidate);

    } catch (error) {
        console.error('Error fetching candidate:', error);
        res.status(500).json({ message: 'Server error', error: error.message });
    }
};

// Update candidate
exports.updateCandidate = async (req, res) => {
    try {
        const { id } = req.params;
        const updateData = req.body;

        const candidate = await Candidate.findOne({ _id: id, companyId: req.companyId });
        if (!candidate) {
            return res.status(404).json({ message: 'Candidate not found' });
        }

        // Check if email is being changed and if it conflicts
        if (updateData.email && updateData.email !== candidate.email) {
            const existingCandidate = await Candidate.findOne({ hiringRequestId: candidate.hiringRequestId, email: updateData.email, _id: { $ne: id }, companyId: req.companyId });
            if (existingCandidate) {
                return res.status(400).json({ message: 'Another candidate with this email already exists for this hiring request' });
            }
        }

        // Track status change
        if (updateData.status && updateData.status !== candidate.status) {
            candidate.statusHistory.push({
                status: updateData.status,
                changedBy: req.user._id,
                changedAt: new Date(),
                remark: updateData.remark || ''
            });
        }

        // Update fields securely (prevent mass assignment)
        const allowedUpdates = [
            'candidateName', 'email', 'mobile', 'source', 'referralName',
            'profilePulledBy', 'calledBy', 'rate', 'currentCTC', 'expectedCTC', 'inHandOffer', 'offerCompany', 'offerCTC',
            'preference', 'totalExperience', 'qualification', 'currentCompany', 'pastExperience',
            'currentLocation', 'preferredLocation', 'tatToJoin', 'noticePeriod',
            'status', 'remark', 'decision', 'phase2Decision', 'phase3Decision', 'lastWorkingDay', 'resumeUrl', 'resumePublicId',
            'mustHaveSkills', 'niceToHaveSkills'
        ];

        allowedUpdates.forEach(field => {
            if (updateData[field] !== undefined) {
                candidate[field] = updateData[field];
            }
        });

        await candidate.save();

        const updatedCandidate = await Candidate.findOne({ _id: id, companyId: req.companyId })
            .populate('uploadedBy', 'firstName lastName email')
            .populate('hiringRequestId', 'requestId roleDetails');

        res.status(200).json({
            message: 'Candidate updated successfully',
            candidate: updatedCandidate
        });

    } catch (error) {
        console.error('Error updating candidate:', error);
        res.status(500).json({ message: 'Server error', error: error.message });
    }
};

// Delete candidate
exports.deleteCandidate = async (req, res) => {
    try {
        const { id } = req.params;

        const candidate = await Candidate.findOne({ _id: id, companyId: req.companyId });
        if (!candidate) {
            return res.status(404).json({ message: 'Candidate not found' });
        }

        // Delete resume from Cloudinary
        if (candidate.resumePublicId) {
            try {
                await cloudinary.uploader.destroy(candidate.resumePublicId, { resource_type: 'raw' });
            } catch (cloudinaryError) {
                console.error('Error deleting from Cloudinary:', cloudinaryError);
                // Continue with deletion even if Cloudinary fails
            }
        }

        await Candidate.findOneAndDelete({ _id: id, companyId: req.companyId });

        res.status(200).json({ message: 'Candidate deleted successfully' });

    } catch (error) {
        console.error('Error deleting candidate:', error);
        res.status(500).json({ message: 'Server error', error: error.message });
    }
};

// Update candidate status
exports.updateCandidateStatus = async (req, res) => {
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
exports.updateCandidateRemark = async (req, res) => {
    try {
        const { id } = req.params;
        const { remark } = req.body;

        const candidate = await Candidate.findOne({ _id: id, companyId: req.companyId });
        if (!candidate) {
            return res.status(404).json({ message: 'Candidate not found' });
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
exports.updateCandidateInternalRemark = async (req, res) => {
    try {
        const { id } = req.params;
        const { internalRemark } = req.body;

        const candidate = await Candidate.findOne({ _id: id, companyId: req.companyId });
        if (!candidate) {
            return res.status(404).json({ message: 'Candidate not found' });
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

// Update candidate decision
exports.updateCandidateDecision = async (req, res) => {
    try {
        const { id } = req.params;
        const { decision } = req.body;

        if (!decision) {
            return res.status(400).json({ message: 'Decision is required' });
        }

        const candidate = await Candidate.findOne({ _id: id, companyId: req.companyId });
        if (!candidate) {
            return res.status(404).json({ message: 'Candidate not found' });
        }

        candidate.decision = decision;
        await candidate.save();

        const updatedCandidate = await Candidate.findOne({ _id: id, companyId: req.companyId })
            .populate('uploadedBy', 'firstName lastName email')
            .populate('hiringRequestId', 'requestId roleDetails');

        res.status(200).json({
            message: 'Decision updated successfully',
            candidate: updatedCandidate
        });

    } catch (error) {
        console.error('Error updating decision:', error);
        res.status(500).json({ message: 'Server error', error: error.message });
    }
};

// Update candidate Phase 2 decision
exports.updatePhase2Decision = async (req, res) => {
    try {
        const { id } = req.params;
        const { phase2Decision } = req.body;

        if (!phase2Decision) {
            return res.status(400).json({ message: 'Phase 2 Decision is required' });
        }

        const candidate = await Candidate.findOne({ _id: id, companyId: req.companyId });
        if (!candidate) {
            return res.status(404).json({ message: 'Candidate not found' });
        }

        candidate.phase2Decision = phase2Decision;
        await candidate.save();

        const updatedCandidate = await Candidate.findOne({ _id: id, companyId: req.companyId })
            .populate('uploadedBy', 'firstName lastName email')
            .populate('hiringRequestId', 'requestId roleDetails');

        res.status(200).json({
            message: 'Phase 2 Decision updated successfully',
            candidate: updatedCandidate
        });

    } catch (error) {
        console.error('Error updating Phase 2 decision:', error);
        res.status(500).json({ message: 'Server error', error: error.message });
    }
};

// Update candidate Phase 3 decision (Offer & Onboarding)
exports.updatePhase3Decision = async (req, res) => {
    try {
        const { id } = req.params;
        const { phase3Decision } = req.body;

        if (!phase3Decision) {
            return res.status(400).json({ message: 'Phase 3 Decision is required' });
        }

        const candidate = await Candidate.findOne({ _id: id, companyId: req.companyId });
        if (!candidate) {
            return res.status(404).json({ message: 'Candidate not found' });
        }

        candidate.phase3Decision = phase3Decision;
        await candidate.save();

        const updatedCandidate = await Candidate.findOne({ _id: id, companyId: req.companyId })
            .populate('uploadedBy', 'firstName lastName email')
            .populate('hiringRequestId', 'requestId roleDetails');

        res.status(200).json({
            message: 'Phase 3 Decision updated successfully',
            candidate: updatedCandidate
        });

    } catch (error) {
        console.error('Error updating Phase 3 decision:', error);
        res.status(500).json({ message: 'Server error', error: error.message });
    }
};

// Get distinct candidate sources + stored custom sources
exports.getCandidateSources = async (req, res) => {
    try {
        // 1. Get sources from actual candidates
        const existingSources = await Candidate.distinct('source', { companyId: req.companyId });

        // 2. Get sources from CandidateSource master data
        const masterSources = await CandidateSource.find({ companyId: req.companyId });

        const defaultSources = ['Job Portal', 'Referral', 'LinkedIn', 'Consultancy', 'Internal Database', 'Other'];

        // Format master sources to include ID for deletion
        const customSources = masterSources.map(s => ({
            _id: s._id,
            name: s.name,
            isCustom: true
        }));

        // Combine all and return as objects to differentiate custom ones
        const combined = [...defaultSources.map(s => ({ name: s, isCustom: false }))];

        // Add existing from candidates if not in default
        existingSources.forEach(s => {
            if (!combined.some(c => c.name === s)) {
                combined.push({ name: s, isCustom: false });
            }
        });

        // Add custom from master data
        customSources.forEach(s => {
            if (!combined.some(c => c.name === s.name)) {
                combined.push(s);
            } else {
                // If already there but we have a custom record, mark it as custom
                const index = combined.findIndex(c => c.name === s.name);
                combined[index] = s;
            }
        });

        res.status(200).json(combined.sort((a, b) => a.name.localeCompare(b.name)));
    } catch (error) {
        console.error('Error fetching sources:', error);
        res.status(500).json({ message: 'Server error', error: error.message });
    }
};

// Add a new custom candidate source
exports.addCandidateSource = async (req, res) => {
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
exports.deleteCandidateSource = async (req, res) => {
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

// --- INTERVIEW ROUNDS MANAGEMENT ---

// Add a new interview round
exports.addInterviewRound = async (req, res) => {
    try {
        const { id } = req.params;
        const { levelName, assignedTo, scheduledDate, phase } = req.body;

        if (!levelName) {
            return res.status(400).json({ message: 'Level name is required' });
        }

        const candidate = await Candidate.findOne({ _id: id, companyId: req.companyId });
        if (!candidate) {
            return res.status(404).json({ message: 'Candidate not found' });
        }

        const newRound = {
            levelName,
            assignedTo: assignedTo || [],
            status: 'Pending',
            scheduledDate,
            phase: phase || 1
        };

        candidate.interviewRounds.push(newRound);
        await candidate.save();

        const updatedCandidate = await Candidate.findOne({ _id: id, companyId: req.companyId })
            .populate('hiringRequestId', 'requestId')
            .populate('interviewRounds.assignedTo', 'firstName lastName email')
            .populate('interviewRounds.evaluatedBy', 'firstName lastName');

        // Create notification for assigned interviewers and emit real-time updates
        if (assignedTo && assignedTo.length > 0) {
            const io = req.app.get('io');
            const notifications = assignedTo.map(userId => ({
                user: userId,
                title: 'New Interview Assigned',
                message: `You have been assigned to evaluate ${candidate.candidateName} for the ${levelName} round.`,
                type: 'Interview',
                link: `/ta/hiring-request/${candidate.hiringRequestId._id || candidate.hiringRequestId}/candidate/${candidate._id}/view`,
                metadata: {
                    candidateId: candidate._id,
                    roundId: candidate.interviewRounds[candidate.interviewRounds.length - 1]._id
                }
            }));
            await NotificationService.createManyNotifications(io, notifications);

            // Also emit an 'interview_update' event to each assigned user to refresh their list
            assignedTo.forEach(userId => {
                NotificationService.emitToUser(io, userId, 'interview_update', {
                    candidateId: candidate._id,
                    candidateName: candidate.candidateName,
                    roundId: candidate.interviewRounds[candidate.interviewRounds.length - 1]._id
                });
            });
        }

        res.status(201).json({
            message: 'Interview round added successfully',
            round: updatedCandidate.interviewRounds[updatedCandidate.interviewRounds.length - 1],
            candidate: updatedCandidate
        });
    } catch (error) {
        console.error('Error adding interview round:', error);
        res.status(500).json({ message: 'Server error', error: error.message });
    }
};

// Update an existing interview round (e.g., reschedule, change assignment)
exports.updateInterviewRound = async (req, res) => {
    try {
        const { id, roundId } = req.params;
        const { levelName, assignedTo, scheduledDate, phase } = req.body;

        const candidate = await Candidate.findOne({ _id: id, companyId: req.companyId });
        if (!candidate) {
            return res.status(404).json({ message: 'Candidate not found' });
        }

        const round = candidate.interviewRounds.id(roundId);
        if (!round) {
            return res.status(404).json({ message: 'Interview round not found' });
        }

        if (levelName) round.levelName = levelName;
        if (assignedTo !== undefined) round.assignedTo = assignedTo;
        if (scheduledDate !== undefined) round.scheduledDate = scheduledDate;
        if (phase !== undefined) round.phase = phase;

        await candidate.save();

        const updatedCandidate = await Candidate.findOne({ _id: id, companyId: req.companyId })
            .populate('interviewRounds.assignedTo', 'firstName lastName email')
            .populate('interviewRounds.evaluatedBy', 'firstName lastName');

        const io = req.app.get('io');
        // Notify assigned interviewers about the update
        if (updatedCandidate.interviewRounds.id(roundId).assignedTo) {
            updatedCandidate.interviewRounds.id(roundId).assignedTo.forEach(user => {
                const userId = user._id || user;
                NotificationService.emitToUser(io, userId, 'interview_update', {
                    candidateId: updatedCandidate._id,
                    candidateName: updatedCandidate.candidateName,
                    roundId: roundId,
                    type: 'UPDATE'
                });
            });
        }

        res.status(200).json({
            message: 'Interview round updated successfully',
            round: updatedCandidate.interviewRounds.id(roundId),
            candidate: updatedCandidate
        });
    } catch (error) {
        console.error('Error updating interview round:', error);
        res.status(500).json({ message: 'Server error', error: error.message });
    }
};

// Delete an interview round
exports.deleteInterviewRound = async (req, res) => {
    try {
        const { id, roundId } = req.params;

        const candidate = await Candidate.findOne({ _id: id, companyId: req.companyId });
        if (!candidate) {
            return res.status(404).json({ message: 'Candidate not found' });
        }

        const round = candidate.interviewRounds.id(roundId);
        if (!round) {
            return res.status(404).json({ message: 'Interview round not found' });
        }

        candidate.interviewRounds.pull(roundId);
        await candidate.save();

        res.status(200).json({ message: 'Interview round deleted successfully' });
    } catch (error) {
        console.error('Error deleting interview round:', error);
        res.status(500).json({ message: 'Server error', error: error.message });
    }
};

// Get current user's scheduled interviews
exports.getMyScheduledInterviews = async (req, res) => {
    try {
        const userId = req.user._id;

        // Only return rounds that are actually scheduled for the interviewer.
        // Some rounds are created in a "Pending" state before a date is set, and those
        // should not appear in the "Upcoming Interviews" widgets.
        const candidates = await Candidate.find({
            companyId: req.companyId,
            'interviewRounds': {
                $elemMatch: {
                    assignedTo: userId,
                    status: { $in: ['Pending', 'Scheduled'] },
                    scheduledDate: { $type: 'date' }
                }
            }
        })
            .populate('hiringRequestId', 'requestId roleDetails')
            .select('candidateName email mobile interviewRounds hiringRequestId');

        // Extract and flatten the specific rounds assigned to the user
        const scheduledInterviews = [];

        candidates.forEach(candidate => {
            candidate.interviewRounds.forEach(round => {
                const hasScheduledDate = Boolean(round.scheduledDate);
                const isAssigned = round.assignedTo.some(id => id.toString() === userId.toString());
                if (isAssigned && hasScheduledDate && ['Pending', 'Scheduled'].includes(round.status)) {
                    scheduledInterviews.push({
                        candidateId: candidate._id,
                        candidateName: candidate.candidateName,
                        candidateEmail: candidate.email,
                        candidateMobile: candidate.mobile,
                        role: candidate.hiringRequestId?.roleDetails?.title || 'Unknown Role',
                        hiringRequestId: candidate.hiringRequestId?._id,
                        roundId: round._id,
                        phase: round.phase || 1,
                        levelName: round.levelName,
                        scheduledDate: round.scheduledDate,
                        status: 'Scheduled',
                        rawStatus: round.status
                    });
                }
            });
        });

        // Sort by date (oldest/nearest first), pushing null dates to the end
        scheduledInterviews.sort((a, b) => {
            if (!a.scheduledDate) return 1;
            if (!b.scheduledDate) return -1;
            return new Date(a.scheduledDate) - new Date(b.scheduledDate);
        });

        res.status(200).json(scheduledInterviews);
    } catch (error) {
        console.error('Error fetching user interviews:', error);
        res.status(500).json({ message: 'Server error fetching scheduled interviews', error: error.message });
    }
};

// Get all candidates pulled by a specific user for the User TA Dashboard
exports.getCandidatesByPulledBy = async (req, res) => {
    try {
        const { userName } = req.params;

        // Optionally, check if the current user has access to view this.
        // For now, if they can reach this route (requires 'ta.view' or implicit access), allow it.
        const isAdmin = req.user.roles.some(r => r.name === 'Admin' || r.name === 'HR' || r.name === 'Super Admin');
        const userPermissions = req.user.roles.flatMap(role => (role.permissions || []).map(p => p.key));
        const hasTaView = userPermissions.includes('ta.view') || userPermissions.includes('*');

        // We assume userName is the literal string stored in `profilePulledBy`
        // Use a case-insensitive regex for more robust matching
        const query = { profilePulledBy: { $regex: new RegExp(`^${userName}$`, 'i') } };

        const candidates = await Candidate.find({ ...query, companyId: req.companyId })
            .populate('hiringRequestId', 'requestId roleDetails')
            .populate('uploadedBy', 'firstName lastName email')
            .sort({ uploadedAt: -1 })
            .lean();

        res.status(200).json({
            count: candidates.length,
            candidates
        });

    } catch (error) {
        console.error('Error fetching candidates by pulled by:', error);
        res.status(500).json({ message: 'Server error fetching candidates', error: error.message });
    }
};

// Evaluate an interview round (Pass/Fail) or edit feedback for an already-evaluated round
exports.evaluateInterviewRound = async (req, res) => {
    try {
        const { id, roundId } = req.params;
        const { status, feedback, rating, skillRatings } = req.body; // status: 'Passed' or 'Failed'; rating: 1-10 (for Passed)

        if (!['Passed', 'Failed'].includes(status)) {
            return res.status(400).json({ message: 'Status must be Passed or Failed' });
        }

        if (!feedback) {
            return res.status(400).json({ message: 'Feedback is required for evaluation' });
        }

        const candidate = await Candidate.findOne({ _id: id, companyId: req.companyId }).populate('interviewRounds.assignedTo');
        if (!candidate) {
            return res.status(404).json({ message: 'Candidate not found' });
        }

        const round = candidate.interviewRounds.id(roundId);
        if (!round) {
            return res.status(404).json({ message: 'Interview round not found' });
        }

        // Authorization check: User must be an assigned evaluator or have super approve
        const userPermissions = req.user.roles.flatMap(role => (role.permissions || []).map(p => p.key));
        const hasSuperApprove = userPermissions.includes('ta.super_approve') || userPermissions.includes('*');
        const isAssigned = round.assignedTo.some(user => user._id.toString() === req.user._id.toString());

        if (!isAssigned && !hasSuperApprove) {
            return res.status(403).json({ message: 'Forbidden: You are not authorized to evaluate this round' });
        }

        round.status = status;
        round.feedback = feedback;
        round.evaluatedBy = req.user._id;
        round.evaluatedAt = new Date();

        // Save rating only when the round is Passed
        if (status === 'Passed' && rating !== undefined && rating !== null && rating !== '') {
            const parsedRating = parseInt(rating, 10);
            if (parsedRating >= 1 && parsedRating <= 10) {
                round.rating = parsedRating;
            }
        } else if (status === 'Failed') {
            round.rating = undefined; // Clear rating if changed to Failed
        }

        // Save round-specific skill ratings and update global ones
        if (skillRatings && Array.isArray(skillRatings)) {
            round.skillRatings = skillRatings.map(sr => ({
                skill: sr.skill,
                rating: sr.rating,
                category: sr.category
            }));

            // Sync to global skillRatings
            skillRatings.forEach(newSr => {
                const globalSrIndex = candidate.skillRatings.findIndex(s => s.skill === newSr.skill);
                if (globalSrIndex !== -1) {
                    candidate.skillRatings[globalSrIndex].rating = newSr.rating;
                } else {
                    candidate.skillRatings.push({
                        skill: newSr.skill,
                        rating: newSr.rating,
                        category: newSr.category || 'Additional'
                    });
                }
            });
        }

        await candidate.save();

        const updatedCandidate = await Candidate.findOne({ _id: id, companyId: req.companyId })
            .populate('interviewRounds.assignedTo', 'firstName lastName email')
            .populate('interviewRounds.evaluatedBy', 'firstName lastName');

        const io = req.app.get('io');
        // Notify assigned interviewers that the round is evaluated (to remove from their "Pending" list)
        if (updatedCandidate.interviewRounds.id(roundId).assignedTo) {
            updatedCandidate.interviewRounds.id(roundId).assignedTo.forEach(user => {
                const userId = user._id || user;
                NotificationService.emitToUser(io, userId, 'interview_update', {
                    candidateId: updatedCandidate._id,
                    candidateName: updatedCandidate.candidateName,
                    roundId: roundId,
                    type: 'EVALUATED',
                    status: status
                });
            });
        }

        res.status(200).json({
            message: `Round evaluated as ${status}`,
            round: updatedCandidate.interviewRounds.id(roundId),
            candidate: updatedCandidate
        });
    } catch (error) {
        console.error('Error evaluating interview round:', error);
        res.status(500).json({ message: 'Server error', error: error.message });
    }
};

// --- SKILL RATINGS MANAGEMENT ---

// Update all skill ratings for a candidate
exports.updateSkillRatings = async (req, res) => {
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
exports.addSkillRating = async (req, res) => {
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
exports.deleteSkillRating = async (req, res) => {
    try {
        const { id, skillId } = req.params;

        const candidate = await Candidate.findOne({ _id: id, companyId: req.companyId });
        if (!candidate) {
            return res.status(404).json({ message: 'Candidate not found' });
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

// Transfer candidate to Onboarding module
exports.transferToOnboarding = async (req, res) => {
    try {
        const { id } = req.params;

        const candidate = await Candidate.findOne({ _id: id, companyId: req.companyId })
            .populate('hiringRequestId');

        if (!candidate) {
            return res.status(404).json({ message: 'Candidate not found' });
        }

        // Validation: Ensure a valid decision is set (Phase 3 decision or Phase 2 Selected)
        const hasPhase3Decision = candidate.phase3Decision && candidate.phase3Decision !== 'None';
        const hasPhase2Selected = candidate.phase2Decision === 'Selected';

        if (!hasPhase3Decision && !hasPhase2Selected) {
            return res.status(400).json({ message: 'A valid decision (Selected in Phase 2 or any Phase 3 decision) must be set before transferring to onboarding' });
        }

        if (candidate.isTransferredToOnboarding) {
            return res.status(400).json({ message: 'Candidate is already transferred to onboarding' });
        }

        // Check if employee with same email already exists in onboarding
        const existingOnboarding = await OnboardingEmployee.findOne({ email: candidate.email, companyId: req.companyId });
        if (existingOnboarding) {
            candidate.isTransferredToOnboarding = true; // Mark as transferred since they exist
            await candidate.save();
            return res.status(400).json({ message: 'An onboarding record with this email already exists' });
        }


        // Split name into first and last
        const nameParts = candidate.candidateName.trim().split(/\s+/);
        const firstName = nameParts[0];
        const lastName = nameParts.length > 1 ? nameParts.slice(1).join(' ') : '';

        // Generate credentials
        const tempEmployeeId = await OnboardingEmployee.generateTempId(req.companyId);
        const tempPassword = Math.random().toString(36).slice(-8); // Random 8 char password

        // Default document slots
        const defaultDocuments = [
            { type: 'resume', label: 'Updated Resume' },
            { type: 'aadhaar_front', label: 'Aadhaar Card (Front)' },
            { type: 'aadhaar_back', label: 'Aadhaar Card (Back)' },
            { type: 'pan', label: 'PAN Card' },
            { type: 'salary_slip', label: 'Salary Slip' },
            { type: 'passport', label: 'Passport (Optional)' },
            { type: '10th_marksheet', label: '10th Marksheet / Certificate' },
            { type: '12th_marksheet', label: '12th Marksheet / Certificate' },
            { type: 'graduation', label: 'Graduation Marksheet / Certificate' },
            { type: 'relieving_letter', label: 'Previous Employer Relieving Letter' },
            { type: 'experience_certificate', label: 'Experience Certificate' },
            { type: 'passport_photo', label: 'Recent Passport-Size Photograph' }
        ];

        console.log('📄 Initializing onboarding documents:', defaultDocuments.length);

        // Create onboarding employee
        const onboardingEmployee = new OnboardingEmployee({
            companyId: req.companyId,
            createdBy: req.user._id,
            sourcedFromTA: true,
            candidateId: candidate._id,
            tempEmployeeId,
            tempPassword, // hashed in pre-save
            firstName,
            lastName,
            email: candidate.email,
            phone: candidate.mobile,
            designation: candidate.hiringRequestId?.roleDetails?.positionName || '',
            joiningDate: candidate.lastWorkingDay || null,
            workLocation: candidate.preferredLocation || candidate.currentLocation || '',
            salary: {
                annualCTC: candidate.currentCTC?.toString() || ''
            },
            personalDetails: {
                fullName: candidate.candidateName,
                personalEmail: candidate.email,
                personalMobile: candidate.mobile,
                currentAddress: {
                    line1: candidate.currentLocation || '',
                    city: candidate.currentLocation || ''
                }
            },
            status: 'Pending',
            documents: defaultDocuments,
            requestedSections: [],
            requestedDocuments: []
        });

        console.log('💾 Saving onboarding employee with documents:', onboardingEmployee.documents.length);
        await onboardingEmployee.save();
        console.log('✅ Onboarding employee saved successfully:', onboardingEmployee._id);

        // Mark candidate as transferred
        candidate.isTransferredToOnboarding = true;
        await candidate.save();

        // Add audit log to onboarding employee
        try {
            await OnboardingEmployee.findByIdAndUpdate(onboardingEmployee._id, {
                $push: {
                    auditLog: {
                        action: 'TRANSFERRED_FROM_TA',
                        details: 'Candidate successfully transferred from Talent Acquisition'
                    }
                }
            });
        } catch (logError) {
            console.error('Failed to log transfer audit:', logError);
        }

        res.status(200).json({
            message: 'Candidate successfully transferred to onboarding',
            onboardingEmployeeId: onboardingEmployee._id
        });

    } catch (error) {
        console.error('Error transferring to onboarding:', error);
        res.status(500).json({ message: 'Server error during transfer', error: error.message });
    }
};
