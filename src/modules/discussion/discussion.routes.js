const express = require('express');
const { requireModule } = require('../../common/middleware/moduleGuard');
const router = express.Router();
const {
    createDiscussion,
    getDiscussions,
    getDiscussionById,
    updateDiscussion,
    deleteDiscussion,
    getSupervisorList
} = require('./discussion.controller');
const { getDiscussionsBootstrap } = require('../system/pageBootstrap.controller');
const { protect } = require('../../common/middleware/authMiddleware');
const { authorize } = require('../../common/middleware/authorize');

router.use(protect);
router.use(requireModule('meetingsOfMinutes'));

router.get('/bootstrap', authorize('discussion.read'), getDiscussionsBootstrap);
router.get('/supervisors', authorize(['discussion.read', 'discussion.create']), getSupervisorList);

router.route('/')
    .get(authorize('discussion.read'), getDiscussions)
    .post(authorize('discussion.create'), createDiscussion);

router.route('/:id')
    .get(authorize('discussion.read'), getDiscussionById)
    .put(authorize('discussion.create'), updateDiscussion)
    .delete(authorize('discussion.create'), deleteDiscussion);

module.exports = router;
