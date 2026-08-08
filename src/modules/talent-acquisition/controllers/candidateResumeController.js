const { HiringRequest } = require('../model/hiringRequest.model');
const { parseCV } = require('../utils/cvParser');
const { isDynamicHiringRequest } = require('../utils/phaseTemplateUtils');
const { TA_CAPABILITIES, canAccessHiringRequestForCapability } = require('../utils/candidateAccess');
const { extractPublicIdFromUrl } = require('../../../utils/cloudinaryHelper');

// Upload resume to Cloudinary
const uploadResume = async (req, res) => {
    try {
        const { hiringRequestId } = req.params;

        console.log('📤 Upload resume request for hiring request:', hiringRequestId);

        // Verify hiring request exists
        const hiringRequest = await HiringRequest.findOne({ _id: hiringRequestId, companyId: req.companyId });
        if (!hiringRequest) {
            return res.status(404).json({ message: 'Hiring request not found' });
        }
        const canManageHiringRequest = await canAccessHiringRequestForCapability(hiringRequest, req.user, TA_CAPABILITIES.EDIT, req.companyId);
        if (!canManageHiringRequest) {
            return res.status(403).json({ message: 'Forbidden: You do not have permission to upload candidates for this requisition' });
        }
        const isDynamicRequest = isDynamicHiringRequest(hiringRequest);

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
const parseResume = async (req, res) => {
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

module.exports = {
    uploadResume,
    parseResume
};
