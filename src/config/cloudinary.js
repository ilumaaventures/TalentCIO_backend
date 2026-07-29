const cloudinary = require('cloudinary').v2;
const { CloudinaryStorage } = require('multer-storage-cloudinary');
const multer = require('multer');

cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET
});

// Test Connection safely
if (process.env.CLOUDINARY_CLOUD_NAME && process.env.CLOUDINARY_API_KEY && process.env.CLOUDINARY_API_SECRET) {
    cloudinary.api.ping((error, result) => {
        if (error) {
            console.error('Cloudinary Connection Failed:', error);
        } else {
            console.log('Cloudinary Connection Successful:', result);
        }
    });
} else {
    console.warn('⚠️  Cloudinary environment variables are missing! Uploads will fail.');
}

// Storage for all document uploads (employee dossier, resumes, etc.)
const storage = new CloudinaryStorage({
    cloudinary: cloudinary,
    params: async (req, file) => {
        let folderName = 'employee_dossier'; // Default folder

        if (file.fieldname === 'resume') {
            folderName = 'resumes';
        }

        // Determine resource_type based on file extension/mimetype
        const isImage = file.mimetype.startsWith('image/');
        const isVideo = file.mimetype.startsWith('video/');
        const resourceType = isImage ? 'image' : (isVideo ? 'video' : 'raw');

        return {
            folder: folderName,
            resource_type: resourceType,
            // For 'raw' files (docs, etc.), Cloudinary requires the extension in public_id to serve it correctly.
            public_id: `${file.originalname.split('.')[0]}-${Date.now()}.${file.originalname.split('.').pop()}`
        };
    },
});

const upload = multer({ storage: storage });
const DOSSIER_DOCUMENT_MIME_TYPES = new Set([
    'application/pdf',
    'image/jpeg',
    'image/png',
    'image/jpg',
    'image/webp'
]);

const uploadDossierDocuments = multer({
    storage,
    limits: {
        fileSize: 5 * 1024 * 1024
    },
    fileFilter: (req, file, cb) => {
        let isAllowed = DOSSIER_DOCUMENT_MIME_TYPES.has(file.mimetype);

        // Fallback check for generic octet-stream using file extension (common on mobile)
        if (!isAllowed && file.mimetype === 'application/octet-stream' && file.originalname) {
            const ext = file.originalname.split('.').pop().toLowerCase();
            const allowedExts = new Set(['pdf', 'jpg', 'jpeg', 'png', 'webp']);
            if (allowedExts.has(ext)) {
                isAllowed = true;
                // Normalize mimetype so storage and Cloudinary can classify it correctly
                if (ext === 'pdf') {
                    file.mimetype = 'application/pdf';
                } else {
                    file.mimetype = `image/${ext === 'jpg' ? 'jpeg' : ext}`;
                }
            }
        }

        if (!isAllowed) {
            return cb(new Error('Only PDF and image files are allowed.'));
        }

        cb(null, true);
    }
});

const CUSTOM_ONBOARDING_FILE_MIME_TYPES = new Set([
    'application/pdf',
    'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.ms-excel',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
]);

const ANNOUNCEMENT_ATTACHMENT_MIME_TYPES = new Set([
    'application/pdf',
    'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.ms-excel',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
]);

const uploadOnboardingCustomFiles = multer({
    storage,
    limits: {
        fileSize: 5 * 1024 * 1024
    },
    fileFilter: (req, file, cb) => {
        const isImage = file.mimetype?.startsWith('image/');
        const isAllowedDocument = CUSTOM_ONBOARDING_FILE_MIME_TYPES.has(file.mimetype);

        if (!isImage && !isAllowedDocument) {
            return cb(new Error('Only PDF, Word, Excel, and image files are allowed.'));
        }

        cb(null, true);
    }
});

const uploadAnnouncementAttachment = multer({
    storage,
    limits: {
        fileSize: 5 * 1024 * 1024
    },
    fileFilter: (req, file, cb) => {
        const isImage = file.mimetype?.startsWith('image/');
        const isAllowedDocument = ANNOUNCEMENT_ATTACHMENT_MIME_TYPES.has(file.mimetype);

        if (!isImage && !isAllowedDocument) {
            return cb(new Error('Only PDF, Word, Excel, and image files are allowed.'));
        }

        cb(null, true);
    }
});

const profilePictureStorage = new CloudinaryStorage({
    cloudinary,
    params: async (req, file) => ({
        folder: 'profile_pictures',
        resource_type: 'image',
        public_id: `profile-${req.user?._id || 'user'}-${Date.now()}`,
        transformation: [
            {
                width: 256,
                height: 256,
                crop: 'fill',
                gravity: 'face',
                quality: 'auto:eco',
                fetch_format: 'auto'
            }
        ]
    })
});

const uploadProfilePicture = multer({
    storage: profilePictureStorage,
    limits: {
        fileSize: 2 * 1024 * 1024
    },
    fileFilter: (req, file, cb) => {
        if (!file.mimetype?.startsWith('image/')) {
            return cb(new Error('Only image files are allowed for profile pictures.'));
        }
        cb(null, true);
    }
});

const ATTENDANCE_DOCUMENT_MIME_TYPES = new Set([
    'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
]);

const uploadAttendanceDocuments = multer({
    storage,
    limits: {
        fileSize: 5 * 1024 * 1024
    },
    fileFilter: (req, file, cb) => {
        const fileExtension = file.originalname.split('.').pop().toLowerCase();
        const isAllowed = ATTENDANCE_DOCUMENT_MIME_TYPES.has(file.mimetype) || fileExtension === 'doc' || fileExtension === 'docx';

        if (!isAllowed) {
            return cb(new Error('Only Word files (.doc, .docx) are allowed.'));
        }

        cb(null, true);
    }
});

const massMailStorage = new CloudinaryStorage({
    cloudinary,
    params: async (req, file) => {
        const isImage = file.mimetype?.startsWith('image/');
        const isVideo = file.mimetype?.startsWith('video/');
        const resourceType = isImage ? 'image' : (isVideo ? 'video' : 'raw');
        const ext = file.originalname?.includes('.') ? file.originalname.split('.').pop() : '';
        const name = (file.originalname?.split('.')[0] || 'attachment').replace(/[^a-zA-Z0-9]/g, '_');

        return {
            folder: 'mass_mail_attachments',
            resource_type: resourceType,
            public_id: `${name}_${Date.now()}${ext ? '.' + ext : ''}`
        };
    }
});

const uploadMassMailAttachments = multer({
    storage: massMailStorage,
    limits: {
        fileSize: 15 * 1024 * 1024
    }
});

const uploadBufferToCloudinary = (buffer, filename, folder = 'mass_mail_attachments') => {
    return new Promise((resolve, reject) => {
        const isImage = /\.(jpg|jpeg|png|gif|webp)$/i.test(filename);
        const isVideo = /\.(mp4|mov|avi|mkv)$/i.test(filename);
        const resourceType = isImage ? 'image' : (isVideo ? 'video' : 'raw');
        const ext = filename.includes('.') ? filename.split('.').pop() : '';
        const name = (filename.split('.')[0] || 'attachment').replace(/[^a-zA-Z0-9]/g, '_');
        const publicId = `${name}_${Date.now()}${ext ? '.' + ext : ''}`;

        const uploadStream = cloudinary.uploader.upload_stream(
            {
                folder,
                resource_type: resourceType,
                public_id: publicId
            },
            (error, result) => {
                if (error) return reject(error);
                resolve(result.secure_url || result.url);
            }
        );
        uploadStream.end(buffer);
    });
};

const uploadFilePathToCloudinary = async (filePath, folder = 'mass_mail_attachments') => {
    const isImage = /\.(jpg|jpeg|png|gif|webp)$/i.test(filePath);
    const isVideo = /\.(mp4|mov|avi|mkv)$/i.test(filePath);
    const resourceType = isImage ? 'image' : (isVideo ? 'video' : 'raw');

    const result = await cloudinary.uploader.upload(filePath, {
        folder,
        resource_type: resourceType
    });
    return result.secure_url || result.url;
};

module.exports = {
    upload,
    uploadDossierDocuments,
    uploadProfilePicture,
    uploadOnboardingCustomFiles,
    uploadAnnouncementAttachment,
    uploadAttendanceDocuments,
    uploadMassMailAttachments,
    uploadBufferToCloudinary,
    uploadFilePathToCloudinary,
    cloudinary
};
