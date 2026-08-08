const express = require('express');
const { requireModule } = require('../../common/middleware/moduleGuard');
const router = express.Router();
const { protect } = require('../../common/middleware/authMiddleware');
const {
    getMeetings,
    getMeetingById,
    createMeeting,
    updateMeeting,
    deleteMeeting
} = require('./meeting.controller');

// All meeting routes require authentication
router.use(protect);
router.use(requireModule('meetingsOfMinutes'));

router.get('/', getMeetings);
router.get('/:id', getMeetingById);
router.post('/', createMeeting);
router.put('/:id', updateMeeting);
router.delete('/:id', deleteMeeting);

module.exports = router;
