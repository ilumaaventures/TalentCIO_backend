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
router.use(requireModule(['meetingsOfMinutes', 'projects']));

router.get('/bootstrap', authorize(['discussion.read', 'project.read']), getDiscussionsBootstrap);
router.get('/supervisors', authorize(['discussion.read', 'discussion.create', 'project.read', 'project.create']), getSupervisorList);

router.route('/')
    .get(authorize(['discussion.read', 'project.read']), getDiscussions)
    .post(authorize(['discussion.create', 'project.create', 'project.update']), createDiscussion);

router.route('/:id')
    .get(authorize(['discussion.read', 'project.read']), getDiscussionById)
    .put(authorize(['discussion.create', 'discussion.edit', 'project.create', 'project.update']), updateDiscussion)
    .delete(authorize(['discussion.create', 'discussion.delete', 'project.delete']), deleteDiscussion);

module.exports = router;
