const express = require('express');
const router = express.Router();
const { protect } = require('../../common/middleware/authMiddleware');
const { authorizeAny } = require('../../common/middleware/authorize');
const { requireModule } = require('../../common/middleware/moduleGuard');
const {
    getTasks,
    getTaskById,
    createTask,
    updateTask,
    deleteTask,
    reorderTasks,
    getSubtasks,
    createSubtask,
    getComments,
    createComment,
    updateComment,
    deleteComment,
    getTaskActivity
} = require('./task.controller');

const {
    canAccessTaskReorder,
    canAccessTaskCreate,
    canAccessTaskUpdate,
    canAccessTaskDelete
} = require('./task.middleware');

router.use(protect);
router.use(requireModule(['projects', 'timesheet', 'attendance']));

// Task Reorder (Kanban drag & drop)
router.post('/reorder', canAccessTaskReorder, reorderTasks);

// Subtasks
router.get('/:taskId/subtasks', getSubtasks);
router.post('/:taskId/subtasks', canAccessTaskUpdate, createSubtask);

// Comments
router.get('/:taskId/comments', getComments);
router.post('/:taskId/comments', createComment);
router.put('/:taskId/comments/:commentId', updateComment);
router.delete('/:taskId/comments/:commentId', deleteComment);

// Activity Audit Log
router.get('/:taskId/activity', getTaskActivity);

// Task CRUD
router.get('/', getTasks);
router.get('/:id', getTaskById);
router.post('/', canAccessTaskCreate, createTask);
router.put('/:id', canAccessTaskUpdate, updateTask);
router.delete('/:id', canAccessTaskDelete, deleteTask);

module.exports = router;
