const express = require('express');
const { protect } = require('../../common/middleware/authMiddleware');
const { authorizeRoleOrPermission } = require('../../common/middleware/authorize');
const { requireModule } = require('../../common/middleware/moduleGuard');
const { uploadAnnouncementAttachment } = require('../../config/cloudinary');
const setupController = require('./controllers/announcementSetupController');
const crudController = require('./controllers/announcementCrudController');
const interactionController = require('./controllers/announcementInteractionController');

const {
    addAnnouncementComment,
    deleteAnnouncementComment,
    getAnnouncementAcknowledgements,
    toggleAnnouncementReaction,
    acknowledgeAnnouncement
} = interactionController;

const {
    createAnnouncement,
    deleteAnnouncement,
    getAnnouncementById,
    getAnnouncements,
    updateAnnouncement
} = crudController;

const {
    getAnnouncementBootstrap,
    getAnnouncementCommunity,
    getAnnouncementComposerSetup
} = setupController;

const router = express.Router();

const manageAnnouncements = authorizeRoleOrPermission({
    roles: ['Admin', 'Manager', 'HR Admin', 'System Admin'],
    permissions: ['announcement.manage']
});

const handleAnnouncementAttachmentUpload = (req, res, next) => {
    uploadAnnouncementAttachment.single('attachment')(req, res, (err) => {
        if (!err) return next();

        if (err.code === 'LIMIT_FILE_SIZE') {
            return res.status(413).json({ message: 'Attachment size must be 5 MB or smaller.' });
        }

        return res.status(400).json({ message: err.message || 'Invalid attachment upload.' });
    });
};

router.use(protect);
router.use(requireModule('announcements'));

router.get('/composer-setup', getAnnouncementComposerSetup);
router.get('/community', getAnnouncementCommunity);
router.get('/bootstrap', getAnnouncementBootstrap);
router.get('/', getAnnouncements);
router.get('/:id', getAnnouncementById);
router.post('/:id/react', toggleAnnouncementReaction);
router.post('/:id/comments', addAnnouncementComment);
router.delete('/:id/comments/:commentId', deleteAnnouncementComment);
router.post('/:id/acknowledge', acknowledgeAnnouncement);
router.get('/:id/acknowledgements', manageAnnouncements, getAnnouncementAcknowledgements);
router.post('/', manageAnnouncements, handleAnnouncementAttachmentUpload, createAnnouncement);
router.put('/:id', manageAnnouncements, handleAnnouncementAttachmentUpload, updateAnnouncement);
router.delete('/:id', manageAnnouncements, deleteAnnouncement);

module.exports = router;
