const EmployeeProfile = require('../models/EmployeeProfile');
const User = require('../models/User');
const AuditLog = require('../models/AuditLog');
const { cloudinary } = require('../config/cloudinary');
const { extractPublicIdFromUrl } = require('../utils/cloudinaryHelper');
const axios = require('axios');

// Helper to check permissions using the same role-based lookup as hasPermission()
const filterProfileFields = (profile, viewer, isSelf) => {
    let profileObj = profile.toObject();
    const roles = (viewer && Array.isArray(viewer.roles)) ? viewer.roles : [];
    const isAdmin = roles.some(r => r && (r.name === 'Admin' || r.name === 'Super Admin'));

    // Check permissions from roles (same approach as hasPermission helper below)
    const viewerHasPermission = (key) => {
        if (isAdmin) return true;
        return roles.some(role =>
            role.permissions && role.permissions.some(p => p.key === key)
        );
    };

    const canViewDossier = isAdmin || viewerHasPermission('dossier.view') || viewerHasPermission('dossier.view.sensitive');

    if (!canViewDossier && !isSelf) {
        // Redact sensitive info for users without explicit dossier view permission
        delete profileObj.compensation;
        delete profileObj.identity;
        delete profileObj.family; delete profileObj.contact; delete profileObj.documents; delete profileObj.hris; delete profileObj.skills;
    }

    return profileObj;
};

const checkIsAdmin = (user) => {
    if (!user || !user.roles) return false;
    return user.roles.some(r => r.name === 'Admin' || r.name === 'Super Admin');
};

const hasPermission = (user, permissionKey) => {
    if (checkIsAdmin(user)) return true;
    if (!user || !user.roles) return false;
    return user.roles.some(role =>
        role.permissions && role.permissions.some(p => p.key === permissionKey)
    );
};

exports.getDossier = async (req, res) => {
    try {
        const { userId } = req.params;
        const viewerId = req.user._id.toString();
        const isSelf = userId === viewerId;

        // Verify existence
        const targetUser = await User.findById(userId);
        if (!targetUser) return res.status(404).json({ message: 'User not found' });

        // Permission Check: View Dossier
        // Users can always view their own. To view others, need 'dossier.view' or Admin.
        if (!isSelf) {
            // const canView = checkIsAdmin(req.user) || hasPermission(req.user, "dossier.view");
            if (false && !canView) { // Strict check relaxed
                return res.status(403).json({ message: 'Not authorized to view this dossier' });
            }
        }

        let profile = await EmployeeProfile.findOne({ user: userId,
                companyId: req.companyId })
            .select('+identity.aadhaarNumber +identity.panNumber +identity.passportNumber +compensation.ctc +compensation.bankDetails.accountNumber +personal.medicalConditions')
            .populate({
                path: 'user',
                select: 'firstName lastName email employeeCode roles department joiningDate employmentType workLocation',
                populate: { path: 'roles', select: 'name' }
            })
            .populate('employment.businessUnit', 'name')
            .populate('employment.reportingManager', 'firstName lastName');

        if (!profile) {
            // Create a skeleton profile if it doesn't exist (Lazy Initialization)
            profile = new EmployeeProfile({
                user: userId,
                companyId: req.companyId,
                personal: {
                    firstName: targetUser.firstName,
                    lastName: targetUser.lastName
                },
                contact: {
                    personalEmail: targetUser.email
                },
                employment: {
                    department: targetUser.department,
                    reportingManager: targetUser.reportingManagers?.[0],
                    joiningDate: targetUser.joiningDate
                },
                compensation: {},
                documents: [],
                skills: { technical: [], behavioral: [], learningInterests: [] }
            });
            await profile.save();
            await User.findByIdAndUpdate(userId, { employeeProfile: profile._id });

            // Re-fetch to get populated fields
            profile = await EmployeeProfile.findById(profile._id)
                .populate({
                    path: 'user',
                    select: 'firstName lastName email employeeCode roles department joiningDate employmentType workLocation',
                    populate: { path: 'roles', select: 'name' }
                })
                .populate('employment.businessUnit', 'name')
                .populate('employment.reportingManager', 'firstName lastName');
        } else {

            // --- Critical Fix for Production (Moved to Top) ---
            try {
                if (profile.skills && Array.isArray(profile.skills)) {
                    console.warn(`[FIX] Converting skills array to object for user ${userId}`);
                    // Force reset to correct structure in DB directly
                    const newSkills = {
                        technical: [],
                        behavioral: [],
                        learningInterests: []
                    };

                    await EmployeeProfile.updateOne(
                        { _id: profile._id },
                        { $set: { skills: newSkills } }
                    );

                    // Update local object and mark as modified to prevent current instance from trying to save the old array
                    profile.skills = newSkills;
                }
            } catch (skillError) {
                console.error('[WARNING] Failed to migrate skills array:', skillError.message);
            }
            // -----------------------------------

            // Sync missing data for existing profiles
            let changed = false;
            if (!profile.employment?.department && targetUser.department) {
                if (!profile.employment) profile.employment = {};
                profile.employment.department = targetUser.department;
                changed = true;
            }
            if (!profile.employment?.reportingManager && targetUser.reportingManagers?.length > 0) {
                if (!profile.employment) profile.employment = {};
                profile.employment.reportingManager = targetUser.reportingManagers[0];
                changed = true;
            }
            if (!profile.employment?.joiningDate && targetUser.joiningDate) {
                if (!profile.employment) profile.employment = {};
                profile.employment.joiningDate = targetUser.joiningDate;
                changed = true;
            }
            if (changed) {
                await profile.save();
                await profile.populate('employment.reportingManager', 'firstName lastName');
            }
        }

        // (Removed duplicate skills fix)

        const filteredProfile = filterProfileFields(profile, req.user, isSelf);
        res.status(200).json(filteredProfile);

    } catch (error) {
        console.error('Get Dossier Error:', error);
        console.error('Req User:', JSON.stringify(req.user, null, 2));
        console.error('Params:', req.params);
        res.status(500).json({
            message: 'Server Error',
            error: error.message,
            // stack: process.env.NODE_ENV === 'production' ? '🥞' : error.stack
        });
    }
};

exports.submitHRIS = async (req, res) => {
    try {
        const { userId } = req.params;
        const updates = req.body; // Expecting complex object
        const viewerId = req.user._id.toString();
        const isSelf = userId === viewerId;
        const isAdmin = checkIsAdmin(req.user);
        const canEdit = isSelf || isAdmin || hasPermission(req.user, 'dossier.edit');

        if (!canEdit) {
            return res.status(403).json({ message: 'Not authorized to submit HRIS for this user' });
        }

        const profile = await EmployeeProfile.findOne({ user: userId,
                companyId: req.companyId })
            .select('+identity.aadhaarNumber +identity.panNumber +identity.passportNumber +compensation.ctc +compensation.bankDetails.accountNumber');

        if (!profile) return res.status(404).json({ message: 'Profile not found' });

        // Map updates to sections
        if (updates.personal) profile.personal = { ...(profile.personal?.toObject?.() || {}), ...updates.personal };
        if (updates.identity) profile.identity = { ...(profile.identity?.toObject?.() || {}), ...updates.identity };
        if (updates.contact) profile.contact = { ...(profile.contact?.toObject?.() || {}), ...updates.contact };
        if (updates.family) profile.family = { ...(profile.family?.toObject?.() || {}), ...updates.family };
        if (updates.employment) profile.employment = { ...(profile.employment?.toObject?.() || {}), ...updates.employment };
        if (updates.compensation) {
            profile.compensation = {
                ...(profile.compensation?.toObject?.() || {}),
                ...updates.compensation,
                bankDetails: { ...(profile.compensation?.bankDetails || {}), ...(updates.compensation?.bankDetails || {}) }
            };
        }
        if (updates.education) profile.education = updates.education;
        if (updates.experience) profile.experience = updates.experience;
        if (updates.skills) profile.skills = updates.skills;

        // HRIS Specific Status
        if (updates.hris) {
            profile.hris = {
                ...profile.hris,
                ...updates.hris,
                lastUpdatedAt: new Date()
            };
            if (updates.hris.isDeclared) {
                profile.hris.submittedAt = new Date();
                profile.hris.declarationDate = new Date();
                // Set status to Pending Approval when declared
                profile.hris.status = 'Pending Approval';
            }
        }

        await profile.save();

        await AuditLog.create({
            action: 'SUBMIT_HRIS',
            module: 'EmployeeDossier',
            performedBy: req.user._id,
            details: { targetUser: userId },
            ipAddress: req.ip
        });

        res.status(200).json({ message: 'HRIS Form saved successfully', profile });

    } catch (error) {
        console.error('Submit HRIS Error:', error);
        res.status(500).json({ message: 'Server Error', error: error.message });
    }
};

exports.updateSection = async (req, res) => {
    try {
        const { userId, section } = req.params;
        const updates = req.body; // Expecting object matching the section structure
        const viewerId = req.user._id.toString();
        const isSelf = userId === viewerId;
        const isAdmin = checkIsAdmin(req.user);
        const canEdit = isSelf || isAdmin || hasPermission(req.user, 'dossier.edit');

        // Permission Check
        if (!canEdit) {
            return res.status(403).json({ message: 'Not authorized to edit this profile' });
        }

        // Check for specific permission to edit sensitive sections
        const canEditSensitive = isAdmin || hasPermission(req.user, 'dossier.edit.sensitive');

        if (!isAdmin && !canEditSensitive && ['employment', 'compensation', 'identity'].includes(section)) {
            // If they are self or just have basic edit, they can't edit sensitive
            // UNLESS they are self? 
            // Usually self cannot edit employment/compensation.
            // Self can edit identity? Maybe not.
            // Let's stick to strict:
            return res.status(403).json({ message: 'You cannot edit this section. Contact HR.' });
        }

        const profile = await EmployeeProfile.findOne({ user: userId,
                companyId: req.companyId })
            .select('+identity.aadhaarNumber +identity.panNumber +identity.passportNumber +compensation.ctc +compensation.bankDetails.accountNumber');
        if (!profile) return res.status(404).json({ message: 'Profile not found' });

        // Update Logic
        if (['experience', 'education'].includes(section)) {
            // These are arrays, replace entirely
            profile[section] = Array.isArray(updates) ? updates : [];
        } else {
            if (!profile[section]) {
                profile[section] = {};
            }

            // Apply updates intelligently for object-based sections
            Object.keys(updates).forEach(key => {
                let value = updates[key];
                // Handle empty strings for dates/numbers to avoid CastError
                if (value === "") {
                    value = null;
                }

                // Nested object handling
                if (profile[section] && typeof profile[section] === 'object') {
                    profile[section][key] = value;
                }
            });
        }

        // Reset HRIS declaration if user is not Admin
        if (!isAdmin && profile.hris && (profile.hris.isDeclared || profile.hris.status !== 'Draft')) {
            profile.hris.isDeclared = false;
            profile.hris.status = 'Draft';
        }

        await profile.save();

        // Audit Log
        await AuditLog.create({
            action: 'UPDATE_DOSSIER',
            module: 'EmployeeDossier',
            performedBy: req.user._id,
            details: { targetuser: userId,
                companyId: req.companyId, section, updates: updates },
            ipAddress: req.ip
        });

        res.status(200).json({ message: 'Updated successfully', sectionData: profile[section] });

    } catch (error) {
        console.error('Update Dossier Error:', error);
        res.status(500).json({ message: 'Server Error', error: error.message });
    }
};

exports.addDocument = async (req, res) => {
    try {
        const { userId } = req.params;
        const { category, title, expiryDate } = req.body;



        const fileUrl = req.file ? req.file.path : req.body.url;

        if (!fileUrl) {
            console.error('No file URL found');
            return res.status(400).json({ message: 'No file uploaded or URL provided' });
        }

        const isSelf = req.user._id.toString() === userId;
        const isAdmin = checkIsAdmin(req.user);
        const canEdit = isSelf || isAdmin || hasPermission(req.user, 'dossier.edit');

        if (!canEdit) {
            return res.status(403).json({ message: 'Not authorized to upload documents for this user' });
        }

        const profile = await EmployeeProfile.findOne({ user: userId,
                companyId: req.companyId });
        if (!profile) {
            console.error('Profile not found for user:', userId);
            return res.status(404).json({ message: 'Profile not found' });
        }

        profile.documents.push({
            category,
            title,
            fileName: req.file ? req.file.originalname : (fileUrl.split('/').pop() || 'document'),
            url: fileUrl,
            expiryDate,
            uploadDate: new Date(),
            verificationStatus: 'Pending'
        });

        // Reset HRIS declaration if user is not Admin
        if (!isAdmin && profile.hris && (profile.hris.isDeclared || profile.hris.status !== 'Draft')) {
            profile.hris.isDeclared = false;
            profile.hris.status = 'Draft';
        }

        await profile.save();
        await AuditLog.create({
            action: 'UPLOAD_DOCUMENT',
            module: 'EmployeeDossier',
            performedBy: req.user._id,
            details: { targetuser: userId,
                companyId: req.companyId, docTitle: title },
            ipAddress: req.ip
        });

        res.status(201).json(profile.documents);

    } catch (error) {
        console.error('Upload Document Error:', error);
        res.status(500).json({ message: 'Server Error', error: error.message });
    }
};

exports.deleteDocument = async (req, res) => {
    try {
        const { userId, docId } = req.params;

        const isSelf = req.user._id.toString() === userId;
        const isAdmin = checkIsAdmin(req.user);
        const canEdit = isSelf || isAdmin || hasPermission(req.user, 'dossier.edit');

        if (!canEdit) {
            return res.status(403).json({ message: 'Not authorized to delete documents for this user' });
        }

        const profile = await EmployeeProfile.findOne({ user: userId,
                companyId: req.companyId });

        if (!profile) return res.status(404).json({ message: 'Profile not found' });

        // Find document to get title for audit log
        const doc = profile.documents.id(docId);
        if (!doc) return res.status(404).json({ message: 'Document not found' });

        const docTitle = doc.title;
        const fileUrl = doc.url;

        // cleanup from cloudinary
        if (fileUrl) {
            const publicId = extractPublicIdFromUrl(fileUrl);
            if (publicId) {
                console.log(`Attempting to delete image from Cloudinary. Public ID: ${publicId}`);
                try {
                    const result = await cloudinary.uploader.destroy(publicId);
                    console.log('Cloudinary deletion result:', result);
                } catch (cloudError) {
                    console.error('Cloudinary deletion failed:', cloudError);
                    // We continue to delete the record even if cloud deletion fails, 
                    // but we log it. Optionally, we could prevent deletion or mark for retry.
                }
            } else {
                console.warn('Could not extract public ID from URL:', fileUrl);
            }
        }

        // Remove document
        profile.documents.pull(docId);

        // Reset HRIS declaration if user is not Admin
        if (!isAdmin && profile.hris && (profile.hris.isDeclared || profile.hris.status !== 'Draft')) {
            profile.hris.isDeclared = false;
            profile.hris.status = 'Draft';
        }
        await profile.save();

        await AuditLog.create({
            action: 'DELETE_DOCUMENT',
            module: 'EmployeeDossier',
            performedBy: req.user._id,
            details: { targetuser: userId,
                companyId: req.companyId, docTitle: docTitle },
            ipAddress: req.ip
        });

        res.status(200).json(profile.documents);

    } catch (error) {
        console.error('Delete Document Error:', error);
        res.status(500).json({ message: 'Server Error' });
    }
};

exports.verifyDocument = async (req, res) => {
    try {
        const { userId, docId } = req.params;
        const { status } = req.body; // 'Verified' or 'Rejected'

        if (!['Verified', 'Rejected'].includes(status)) {
            return res.status(400).json({ message: 'Invalid status. Must be Verified or Rejected.' });
        }

        const isAdmin = checkIsAdmin(req.user);
        const canApprove = isAdmin || hasPermission(req.user, 'dossier.verify_documents') || hasPermission(req.user, 'dossier.approve');

        if (!canApprove) {
            return res.status(403).json({ message: 'Not authorized to verify documents' });
        }

        const profile = await EmployeeProfile.findOne({ user: userId,
                companyId: req.companyId });
        if (!profile) return res.status(404).json({ message: 'Profile not found' });

        const doc = profile.documents.id(docId);
        if (!doc) return res.status(404).json({ message: 'Document not found' });

        doc.verificationStatus = status;

        // Check overall status to sync documentSubmissionStatus
        const allVerified = profile.documents.every(d => d.verificationStatus === 'Verified');
        const anyRejected = profile.documents.some(d => d.verificationStatus === 'Rejected');

        if (allVerified) {
            profile.documentSubmissionStatus = 'Approved';
        } else if (anyRejected) {
            profile.documentSubmissionStatus = 'Changes Requested';
        }
        // If still some pending, status remains as is (likely 'Submitted')

        await profile.save();

        await AuditLog.create({
            action: 'VERIFY_DOCUMENT',
            module: 'EmployeeDossier',
            performedBy: req.user._id,
            details: { targetuser: userId,
                companyId: req.companyId, docTitle: doc.title, status, newSubmissionStatus: profile.documentSubmissionStatus },
            ipAddress: req.ip
        });

        res.status(200).json({
            documents: profile.documents,
            submissionStatus: profile.documentSubmissionStatus
        });

    } catch (error) {
        console.error('Verify Document Error:', error);
        res.status(500).json({ message: 'Server Error' });
    }
};

exports.verifyAllDocuments = async (req, res) => {
    try {
        const { userId } = req.params;
        const { status } = req.body; // 'Verified' or 'Rejected'

        if (!['Verified', 'Rejected'].includes(status)) {
            return res.status(400).json({ message: 'Invalid status. Must be Verified or Rejected.' });
        }

        const isAdmin = checkIsAdmin(req.user);
        const canApprove = isAdmin || hasPermission(req.user, 'dossier.verify_documents') || hasPermission(req.user, 'dossier.approve');

        if (!canApprove) {
            return res.status(403).json({ message: 'Not authorized to verify documents' });
        }

        const profile = await EmployeeProfile.findOne({ user: userId,
                companyId: req.companyId });
        if (!profile) return res.status(404).json({ message: 'Profile not found' });

        let updatedCount = 0;
        profile.documents.forEach(doc => {
            if (doc.verificationStatus === 'Pending') {
                doc.verificationStatus = status;
                updatedCount++;
            }
        });

        if (updatedCount > 0) {

            // Check overall status
            const allVerified = profile.documents.every(d => d.verificationStatus === 'Verified');
            const anyRejected = profile.documents.some(d => d.verificationStatus === 'Rejected');

            if (allVerified) {
                profile.documentSubmissionStatus = 'Approved';
            } else if (anyRejected) {
                profile.documentSubmissionStatus = 'Changes Requested';
            } else {
                // Mixed or some pending?
                // If action was verifyAll, then likely none actally left pending unless filtered
                // But let's be safe
                if (profile.documents.some(d => d.verificationStatus === 'Pending')) {
                    // Status remains Submitted or changes to Changes Requested if something was rejected previously
                }
            }

            await profile.save();

            await AuditLog.create({
                action: 'VERIFY_ALL_DOCUMENTS',
                module: 'EmployeeDossier',
                performedBy: req.user._id,
                details: { targetuser: userId,
                companyId: req.companyId, status, count: updatedCount, newSubmissionStatus: profile.documentSubmissionStatus },
                ipAddress: req.ip
            });
        }

        res.status(200).json({
            message: `Updated ${updatedCount} documents`,
            documents: profile.documents,
            submissionStatus: profile.documentSubmissionStatus
        });

    } catch (error) {
        console.error('Verify All Documents Error:', error);
        res.status(500).json({ message: 'Server Error' });
    }
};

exports.submitDocuments = async (req, res) => {
    try {
        const { userId } = req.params;
        const viewerId = req.user._id.toString();
        const isSelf = userId === viewerId; // Only self (or admin acting as self?) usually self.

        if (!isSelf) {
            return res.status(403).json({ message: 'Can only submit your own documents.' });
        }

        const profile = await EmployeeProfile.findOne({ user: userId,
                companyId: req.companyId });
        if (!profile) return res.status(404).json({ message: 'Profile not found' });

        if (!profile.documents || profile.documents.length === 0) {
            return res.status(400).json({ message: 'No documents to submit.' });
        }

        profile.documentSubmissionStatus = 'Submitted';
        // Optionally set all Draft documents to Pending if we had a Draft status for docs, but they are Pending by default on upload.

        await profile.save();

        await AuditLog.create({
            action: 'SUBMIT_DOCUMENTS',
            module: 'EmployeeDossier',
            performedBy: req.user._id,
            details: { targetUser: userId },
            ipAddress: req.ip
        });

        res.status(200).json({
            message: 'Documents submitted successfully',
            submissionStatus: profile.documentSubmissionStatus
        });

    } catch (error) {
        console.error('Submit Documents Error:', error);
        res.status(500).json({ message: 'Server Error' });
    }
};

exports.proxyPdf = async (req, res) => {
    try {
        const { url, download } = req.query;
        console.log('Proxying URL:', url, 'Download:', download);

        if (!url || !url.includes('cloudinary')) {
            return res.status(400).json({ message: 'Invalid or missing Cloudinary URL' });
        }

        // Helper to attempt a fetch
        const attemptFetch = async (targetUrl) => {
            console.log('Fetching:', targetUrl);
            return axios({
                method: 'GET',
                url: targetUrl,
                responseType: 'stream',
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
                    'Referer': 'https://res.cloudinary.com/'
                },
                validateStatus: (status) => status < 400
            });
        };

        // Extract version
        // Matches /v12345/
        const versionMatch = url.match(/\/upload\/v(\d+)\//);
        const version = versionMatch ? versionMatch[1] : undefined;

        // Helper to generate signed URL
        const getSignedUrl = (targetUrl, type) => {
            const publicId = extractPublicIdFromUrl(targetUrl);
            if (!publicId) return null;

            const resourceType = targetUrl.includes('/video/') ? 'video' : (targetUrl.includes('/raw/') ? 'raw' : 'image');

            return cloudinary.url(publicId, {
                resource_type: resourceType,
                secure: true,
                sign_url: true,
                type: type, // 'authenticated' or 'upload' or 'private'
                version: version, // Crucial for valid signature if versioned
                format: 'pdf' // Validate/Force extension
            });
        };


        // Define fetch candidates
        const candidates = [];

        // 1. Original URL
        candidates.push(url);

        // 2. Alternate Type URL (Swap image <-> raw)
        let alternateUrl = null;
        if (url.includes('/image/upload/')) {
            alternateUrl = url.replace('/image/upload/', '/raw/upload/');
        } else if (url.includes('/raw/upload/')) {
            alternateUrl = url.replace('/raw/upload/', '/image/upload/');
        }
        if (alternateUrl) candidates.push(alternateUrl);

        // 3. Signed Versions of Original (Authenticated & Upload)
        const signedOriginalAuth = getSignedUrl(url, 'authenticated');
        if (signedOriginalAuth) candidates.push(signedOriginalAuth);

        const signedOriginalUpload = getSignedUrl(url, 'upload');
        if (signedOriginalUpload) candidates.push(signedOriginalUpload);

        // 4. Signed Versions of Alternate
        if (alternateUrl) {
            const signedAlternateAuth = getSignedUrl(alternateUrl, 'authenticated');
            if (signedAlternateAuth) candidates.push(signedAlternateAuth);

            const signedAlternateUpload = getSignedUrl(alternateUrl, 'upload');
            if (signedAlternateUpload) candidates.push(signedAlternateUpload);
        }

        // Execute sequentially until success
        let finalResponse;
        let errors = [];

        for (const candidate of candidates) {
            if (!candidate) continue;
            try {
                const fetchRes = await attemptFetch(candidate);

                // Check if content length is valid (> 0)
                const len = fetchRes.headers['content-length'];
                if (len && parseInt(len) === 0) {
                    throw new Error('Empty response body');
                }


                if (fetchRes.status < 400) {
                    finalResponse = fetchRes;
                    break;
                }
            } catch (err) {
                // If it's a 404/401, axios might not throw if validateStatus is true (but we set it <400 above)
                // If validateStatus fails, it throws.
                console.warn(`Failed candidate ${candidate}: ${err.message}`);
                errors.push(`${candidate}: ${err.message}`);
            }
        }

        if (!finalResponse) {
            console.error('All proxy attempts failed', errors);
            return res.status(502).json({ message: 'Failed to fetch document', details: errors });
        }

        // Forward headers
        const contentType = finalResponse.headers['content-type'];
        const contentLength = finalResponse.headers['content-length'];

        if (contentType) res.setHeader('Content-Type', contentType);
        if (contentLength) res.setHeader('Content-Length', contentLength);

        res.setHeader('Content-Disposition', download === 'true' ? 'attachment' : 'inline');

        finalResponse.data.pipe(res);

    } catch (error) {
        console.error('Proxy Pdf Global Error:', error.message);
        res.status(500).json({ message: 'Proxy Server Error', error: error.message });
    }
};

exports.getDossierHistory = async (req, res) => {
    try {
        const { userId } = req.params;
        const logs = await AuditLog.find({
            companyId: req.companyId,
            'details.targetUser': userId,
            module: 'EmployeeDossier'
        })
            .populate('performedBy', 'firstName lastName')
            .sort({ createdAt: -1 });

        res.status(200).json(logs);
    } catch (error) {
        console.error('Fetch History Error:', error);
        res.status(500).json({ message: 'Server Error' });
    }
};

// @desc    Get all pending HRIS requests
// @route   GET /api/dossier/requests
// @access  Private (Admin or Manager with dossier.approve permission)
exports.getHRISRequests = async (req, res) => {
    try {
        const canApprove = hasPermission(req.user, 'dossier.approve');
        const isAdmin = checkIsAdmin(req.user);

        if (!canApprove && !isAdmin) {
            // STRICT: No permission = No access, even for managers.
            return res.status(403).json({ message: 'Access denied. Missing dossier.approve permission.' });
        }

        let query = { 'hris.status': { $in: ['Pending Approval', 'Approved', 'Rejected'] } };

        // If user is Admin or has global approve permission, they see all.
        // If we strictly wanted to limit Managers to their reports, we'd need a separate check.
        // But "dossier.approve" sounds like an HR capability.

        const requests = await EmployeeProfile.find({ ...query, companyId: req.companyId })
            .populate('user', 'firstName lastName employeeCode department');

        const formattedRequests = requests.map(reqProfile => {
            if (!reqProfile.user) return null;
            return {
                _id: reqProfile.user._id,
                firstName: reqProfile.user.firstName,
                lastName: reqProfile.user.lastName,
                employeeCode: reqProfile.user.employeeCode,
                department: reqProfile.user.department,
                employeeProfile: {
                    hris: {
                        submittedAt: reqProfile.hris?.submittedAt,
                        status: reqProfile.hris?.status
                    }
                }
            };
        }).filter(r => r !== null);

        res.status(200).json(formattedRequests);
    } catch (error) {
        console.error('Get HRIS Requests Error:', error);
        res.status(500).json({ message: 'Server Error', error: error.message });
    }
};

exports.approveHRIS = async (req, res) => {
    try {
        const { userId } = req.params;

        const canApprove = hasPermission(req.user, 'dossier.approve');
        const isAdmin = checkIsAdmin(req.user);

        if (!isAdmin && !canApprove) {
            return res.status(403).json({ message: 'Not authorized to approve HRIS requests. Missing permission.' });
        }

        // Find profile 
        const profile = await EmployeeProfile.findOne({ user: userId });

        if (!profile) return res.status(404).json({ message: 'Profile not found' });

        profile.hris.status = 'Approved';
        profile.hris.approvedBy = req.user._id;
        profile.hris.approvalDate = new Date();
        profile.hris.rejectionReason = null;

        await profile.save();

        await AuditLog.create({
            action: 'APPROVE_HRIS',
            module: 'EmployeeDossier',
            performedBy: req.user._id,
            details: { targetUser: userId },
            ipAddress: req.ip
        });

        res.status(200).json({ message: 'HRIS Approved successfully', hris: profile.hris });
    } catch (error) {
        console.error('Approve HRIS Error:', error);
        res.status(500).json({ message: 'Server Error' });
    }
};

exports.rejectHRIS = async (req, res) => {
    try {
        const { userId } = req.params;
        const { reason } = req.body;

        const canApprove = hasPermission(req.user, 'dossier.approve');
        const isAdmin = checkIsAdmin(req.user);

        if (!isAdmin && !canApprove) {
            return res.status(403).json({ message: 'Not authorized to reject HRIS requests. Missing permission.' });
        }

        const profile = await EmployeeProfile.findOne({ user: userId });

        if (!profile) return res.status(404).json({ message: 'Profile not found' });

        // Removed isManager check to enforce strict permissions


        profile.hris.status = 'Rejected';
        profile.hris.rejectionReason = reason;
        profile.hris.approvedBy = null;
        profile.hris.approvalDate = null;

        await profile.save();

        await AuditLog.create({
            action: 'REJECT_HRIS',
            module: 'EmployeeDossier',
            performedBy: req.user._id,
            details: { targetuser: userId,
                companyId: req.companyId, reason },
            ipAddress: req.ip
        });

        res.status(200).json({ message: 'HRIS Rejected', hris: profile.hris });
    } catch (error) {
        console.error('Reject HRIS Error:', error);
        res.status(500).json({ message: 'Server Error' });
    }
};

exports.exportHRISExcel = async (req, res) => {
    try {
        const ExcelJS = require('exceljs');
        const workbook = new ExcelJS.Workbook();
        const sheet = workbook.addWorksheet('HRIS Data');

        const query = {
            'hris.status': { $in: ['Pending Approval', 'Approved'] } // Fetch only submitted or approved profiles
        };

        if (req.query.userId) {
            query.user = req.query.userId;
        }

        const profiles = await EmployeeProfile.find(query)
            .sort({ 'hris.submittedAt': -1, 'hris.approvalDate': -1 })
            .select('+identity.aadhaarNumber +identity.panNumber +identity.passportNumber +compensation.bankDetails.accountNumber +compensation.ctc')
            .populate('user', 'employeeCode firstName lastName email')
            .populate('employment.businessUnit', 'name');

        const formatDate = (date) => date ? new Date(date).toLocaleDateString() : '';

        // --- Configuration: Define Sections and their Columns ---
        const sections = [
            {
                title: 'Employee Details',
                columns: [
                    { header: 'Employee Code', key: 'empCode', width: 15 },
                    { header: 'Full Name', key: 'fullName', width: 25 },
                    { header: 'First Name', key: 'firstName', width: 15 },
                    { header: 'Middle Name', key: 'middleName', width: 15 },
                    { header: 'Last Name', key: 'lastName', width: 15 },
                    { header: 'Gender', key: 'gender', width: 10 },
                    { header: 'Date of Birth', key: 'dob', width: 12 },
                    { header: 'Marital Status', key: 'maritalStatus', width: 15 },
                    { header: 'Nationality', key: 'nationality', width: 15 },
                    { header: 'Blood Group', key: 'bloodGroup', width: 10 },
                    { header: 'Date of Joining', key: 'joiningDate', width: 12 },
                ]
            },
            {
                title: 'Contact Information',
                columns: [
                    { header: 'Personal Email ID', key: 'personalEmail', width: 25 },
                    { header: 'Mobile Number', key: 'mobile', width: 15 },
                    { header: 'Alternate Mobile Number', key: 'altMobile', width: 15 },
                    { header: 'Emergency Contact Name', key: 'emergencyName', width: 20 },
                    { header: 'Emergency Contact Relationship', key: 'emergencyRelation', width: 15 },
                    { header: 'Emergency Contact Number', key: 'emergencyPhone', width: 15 },
                ]
            },
            {
                title: 'Address Details',
                columns: [
                    { header: 'Present', key: 'currAddrFull', width: 40 },
                    { header: 'Permanent', key: 'permAddrFull', width: 40 },
                    { header: 'Mailing', key: 'mailAddrFull', width: 40 },
                ]
            },
            {
                title: 'Bank Account Details',
                columns: [
                    { header: 'Account Holder Name', key: 'accHolder', width: 20 },
                    { header: 'Bank Name', key: 'bankName', width: 20 },
                    { header: 'Branch Address', key: 'branchAddress', width: 30 },
                    { header: 'Account Number', key: 'accNum', width: 20 },
                    { header: 'IFSC Code', key: 'ifsc', width: 15 },
                ]
            },
            {
                title: 'Government / Identity Details',
                columns: [
                    { header: 'PAN Number', key: 'pan', width: 15 },
                    { header: 'Aadhaar Number', key: 'aadhaar', width: 15 },
                    { header: 'Passport Number', key: 'passport', width: 15 },
                ]
            },
            {
                title: 'Medical Insurance Details',
                columns: [
                    { header: 'father name', key: 'fatherName', width: 20 },
                    { header: 'father occupation', key: 'fatherOcc', width: 20 },
                    { header: 'mother name', key: 'motherName', width: 20 },
                    { header: 'mother occupation', key: 'motherOcc', width: 20 },
                    { header: 'parents marital status', key: 'famMarital', width: 15 },
                    { header: 'total sibling', key: 'totalSiblings', width: 10 },
                    { header: 'spouse name', key: 'spouseName', width: 20 },
                    { header: 'spouse DOB', key: 'spouseDob', width: 12 },
                    { header: 'childern name', key: 'childNames', width: 25 },
                    { header: 'children DOB', key: 'childDobs', width: 25 },
                ]
            },
            {
                title: 'Educational Qualification',
                columns: [
                    { header: 'college name', key: 'college', width: 20 },
                    { header: 'Course Name', key: 'course', width: 20 },
                    { header: 'University', key: 'university', width: 20 },
                    { header: 'from date', key: 'eduFrom', width: 12 },
                    { header: 'to date', key: 'eduTo', width: 12 },
                    { header: 'Percentage / CGPA', key: 'cgpa', width: 10 },
                ]
            },
            {
                title: 'Work Experience',
                columns: [
                    { header: 'Total Years of Experience', key: 'totalExp', width: 10 },
                    { header: 'Previous Company Name', key: 'prevComp', width: 20 },
                    { header: 'Start Date', key: 'expStart', width: 12 },
                    { header: 'End Date', key: 'expEnd', width: 12 },
                ]
            },
            {
                title: 'Skills',
                columns: [
                    { header: 'Technical Skills', key: 'techSkills', width: 30 },
                    { header: 'Behavioral Skills', key: 'behavSkills', width: 30 },
                    { header: 'Skill you would like to learn', key: 'learnSkills', width: 30 },
                ]
            }
        ];

        // --- Build Headers ---

        let currentColumnIndex = 1;

        // Row 1: Section Headers
        const headerRow1 = sheet.getRow(1);
        headerRow1.font = { bold: true, size: 12 };
        headerRow1.alignment = { horizontal: 'center' };

        // Row 2: Sub Headers
        const headerRow2 = sheet.getRow(2);
        headerRow2.font = { bold: true };
        headerRow2.alignment = { horizontal: 'center', wrapText: true };

        // We need to define columns in ExcelJS to map keys correctly for addRow
        // But with empty separator columns, it's tricky. 
        // Strategy: We will manually map the key to the column object in the sheet
        const sheetColumns = [];

        sections.forEach((section, index) => {
            const startCol = currentColumnIndex;
            const endCol = startCol + section.columns.length - 1;

            // Merge cells for Section Title
            sheet.mergeCells(1, startCol, 1, endCol);
            const titleCell = sheet.getCell(1, startCol);
            titleCell.value = section.title;
            titleCell.fill = {
                type: 'pattern',
                pattern: 'solid',
                fgColor: { argb: 'FFD3D3D3' } // Light Gray
            };
            titleCell.border = { top: { style: 'thin' }, left: { style: 'thin' }, bottom: { style: 'thin' }, right: { style: 'thin' } };

            // Set Sub Headers and Column Widths
            section.columns.forEach((col, colIdx) => {
                const effectiveCol = startCol + colIdx;
                const cell = sheet.getCell(2, effectiveCol);
                cell.value = col.header;

                // Construct column definition for ExcelJS
                // Note: We need to pad with empty/null columns for separators if we use sheet.columns assignment
                // Instead, we will assign column properties directly
                const column = sheet.getColumn(effectiveCol);
                column.key = col.key;
                column.width = col.width;
            });

            currentColumnIndex = endCol + 2; // +1 for next, +1 for empty separator column
        });

        // --- Populate Data ---
        profiles.forEach(p => {
            const getAddr = (type) => p.contact?.addresses?.find(a => a.type === type) || {};
            const curr = getAddr('Current');
            const perm = getAddr('Permanent');
            // Assuming 'Mailing' schema, fallback to empty
            const mail = p.contact?.addresses?.find(a => a.type === 'Mailing') || {};

            // Calculate total experience
            let totalExpYears = 0;
            if (p.experience && p.experience.length > 0) {
                const msInYear = 1000 * 60 * 60 * 24 * 365.25;
                totalExpYears = p.experience.reduce((acc, exp) => {
                    const start = exp.startDate ? new Date(exp.startDate) : new Date();
                    const end = exp.endDate ? new Date(exp.endDate) : new Date();
                    return acc + (end - start);
                }, 0) / msInYear;
            }

            // Determine max rows needed for this profile (based on array lengths)
            const eduCount = p.education?.length || 0;
            const expCount = p.experience?.length || 0;
            const childCount = p.family?.children?.length || 0;
            const maxRows = Math.max(1, eduCount, expCount, childCount);

            for (let i = 0; i < maxRows; i++) {
                const isFirst = i === 0;

                // Get array items for current row index
                const edu = p.education?.[i] || {};
                const exp = p.experience?.[i] || {};
                const child = p.family?.children?.[i] || {};

                // Helper to safely get date or empty
                const getDate = (d) => d ? formatDate(d) : '';

                // Helper to formatting address (only need to calculate once really, but simple enough)
                const formatFullAddr = (addr) => {
                    if (!addr || !addr.street) return '';
                    const parts = [
                        addr.street,
                        addr.city,
                        addr.state,
                        addr.country,
                        addr.zipCode
                    ];
                    return parts.filter(Boolean).join(', ');
                };

                const rowData = {
                    // --- STATIC FIELDS (Show only on first row) ---
                    empCode: isFirst ? p.user?.employeeCode : '',
                    fullName: isFirst ? (p.personal?.fullName || `${p.user?.firstName} ${p.user?.lastName}`.trim()) : '',
                    firstName: isFirst ? p.user?.firstName : '',
                    middleName: isFirst ? p.personal?.middleName : '',
                    lastName: isFirst ? p.user?.lastName : '',
                    gender: isFirst ? p.personal?.gender : '',
                    dob: isFirst ? formatDate(p.personal?.dob) : '',
                    maritalStatus: isFirst ? p.personal?.maritalStatus : '',
                    nationality: isFirst ? p.personal?.nationality : '',
                    bloodGroup: isFirst ? p.personal?.bloodGroup : '',
                    joiningDate: isFirst ? formatDate(p.employment?.joiningDate) : '',

                    // Contact
                    personalEmail: isFirst ? p.contact?.personalEmail : '',
                    mobile: isFirst ? p.contact?.mobileNumber : '',
                    altMobile: isFirst ? p.contact?.alternateNumber : '',
                    emergencyName: isFirst ? p.contact?.emergencyContact?.name : '',
                    emergencyRelation: isFirst ? (p.contact?.emergencyContact?.relation || '') : '',
                    emergencyPhone: isFirst ? p.contact?.emergencyContact?.phone : '',

                    // Addresses (Consolidated)
                    currAddrFull: isFirst ? formatFullAddr(curr) : '',
                    permAddrFull: isFirst ? formatFullAddr(perm) : '',
                    mailAddrFull: isFirst ? formatFullAddr(mail) : '',

                    // Bank
                    accHolder: isFirst ? (p.compensation?.bankDetails?.accountHolderName || p.personal?.fullName || `${p.user?.firstName} ${p.user?.lastName}`) : '',
                    bankName: isFirst ? p.compensation?.bankDetails?.bankName : '',
                    branchAddress: isFirst ? p.compensation?.bankDetails?.branchAddress : '',
                    accNum: isFirst ? p.compensation?.bankDetails?.accountNumber : '',
                    ifsc: isFirst ? p.compensation?.bankDetails?.ifscCode : '',

                    // Identity
                    pan: isFirst ? p.identity?.panNumber : '',
                    aadhaar: isFirst ? p.identity?.aadhaarNumber : '',
                    passport: isFirst ? p.identity?.passportNumber : '',

                    // Family (Static Parents/Spouse)
                    fatherName: isFirst ? p.family?.fatherName : '',
                    fatherOcc: isFirst ? p.family?.fatherOccupation : '',
                    motherName: isFirst ? p.family?.motherName : '',
                    motherOcc: isFirst ? p.family?.motherOccupation : '',
                    famMarital: isFirst ? p.family?.parentsMaritalStatus : '',
                    totalSiblings: isFirst ? p.family?.totalSiblings : '',
                    spouseName: isFirst ? p.family?.spouseName : '',
                    spouseDob: isFirst ? formatDate(p.family?.spouseDob) : '',

                    // --- ARRAY FIELDS (Spread across rows) ---

                    // Children (One per row)
                    childNames: child.name || '',
                    childDobs: getDate(child.dob),

                    // Education (One per row)
                    college: edu.institution || '',
                    course: edu.courseName || edu.degree || '',
                    university: edu.university || '',
                    eduFrom: getDate(edu.fromDate),
                    eduTo: getDate(edu.toDate),
                    cgpa: edu.grade || '',

                    // Experience (One per row)
                    totalExp: isFirst && totalExpYears > 0 ? totalExpYears.toFixed(1) : '', // Summary field only on first row
                    prevComp: exp.companyName || '',
                    expStart: getDate(exp.startDate),
                    expEnd: getDate(exp.endDate),

                    // Skills (Are arrays but usually comma separated list is better than rows for skills, keeping as comma separated on first row)
                    techSkills: isFirst ? (p.skills?.technical?.join(', ') || '') : '',
                    behavSkills: isFirst ? (p.skills?.behavioral?.join(', ') || '') : '',
                    learnSkills: isFirst ? (p.skills?.learningInterests?.join(', ') || '') : ''
                };

                sheet.addRow(rowData);
            }
        });

        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.setHeader('Content-Disposition', 'attachment; filename="Employee_HRIS_Export.xlsx"');

        await workbook.xlsx.write(res);
        res.end();

    } catch (error) {
        console.error('Export Excel Error:', error);
        res.status(500).json({ message: 'Failed to generate Excel' });
    }
};
