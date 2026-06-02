const express = require('express');
const { protect } = require('../middlewares/authMiddleware');
const { authorizeRoleOrPermission } = require('../middlewares/authorize');
const {
    addAnnouncementComment,
    createAnnouncement,
    deleteAnnouncement,
    deleteAnnouncementComment,
    getAnnouncementCommunity,
    getAnnouncementComposerSetup,
    getAnnouncementBootstrap,
    getAnnouncementById,
    getAnnouncements,
    toggleAnnouncementReaction,
    updateAnnouncement
} = require('../controllers/announcementController');

const router = express.Router();

const manageAnnouncements = authorizeRoleOrPermission({
    roles: ['Admin', 'Manager', 'HR Admin', 'System Admin'],
    permissions: ['announcement.manage']
});

router.use(protect);

router.get('/composer-setup', getAnnouncementComposerSetup);
router.get('/community', getAnnouncementCommunity);
router.get('/bootstrap', getAnnouncementBootstrap);
router.get('/', getAnnouncements);
router.get('/:id', getAnnouncementById);
router.post('/:id/react', toggleAnnouncementReaction);
router.post('/:id/comments', addAnnouncementComment);
router.delete('/:id/comments/:commentId', deleteAnnouncementComment);
router.post('/', manageAnnouncements, createAnnouncement);
router.put('/:id', manageAnnouncements, updateAnnouncement);
router.delete('/:id', manageAnnouncements, deleteAnnouncement);

module.exports = router;
