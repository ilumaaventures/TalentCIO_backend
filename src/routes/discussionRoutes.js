const express = require('express');
const { requireModule } = require('../middlewares/moduleGuard');
const router = express.Router();
const {
    createDiscussion,
    getDiscussions,
    getDiscussionById,
    updateDiscussion,
    deleteDiscussion,
    getSupervisorList
} = require('../controllers/discussionController');
const { getDiscussionsBootstrap } = require('../controllers/pageBootstrapController');
const { protect } = require('../middlewares/authMiddleware');
const { authorize } = require('../middlewares/authorize');

router.use(protect);
router.use(requireModule('meetingsOfMinutes'));

router.get('/bootstrap', getDiscussionsBootstrap);
router.get('/supervisors', getSupervisorList);

router.route('/')
    .get(authorize('discussion.read'), getDiscussions)
    .post(authorize('discussion.create'), createDiscussion);

router.route('/:id')
    .get(authorize('discussion.read'), getDiscussionById)
    .put(authorize('discussion.create'), updateDiscussion)
    .delete(authorize('discussion.create'), deleteDiscussion);

module.exports = router;
