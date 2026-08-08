const express = require('express');
const { requireModule } = require('../../common/middleware/moduleGuard');
const router = express.Router();
const { protect } = require('../../common/middleware/authMiddleware');
const {
    createQuery,
    getAllQueries,
    getMyQueries,
    getAssignedQueries,
    getEscalatedQueries,
    getQueryById,
    updateQueryStatus,
    addComment,
    addQueryType,
    getQueryTypes,
    updateQueryType,
    deleteQueryType,
    getHelpdeskAnalytics
} = require('./helpdesk.controller');
const { getHelpdeskBootstrap } = require('../system/pageBootstrap.controller');

// All helpdesk routes require authentication
router.use(protect);
router.use(requireModule('helpdesk'));

// Query Type Routes (Admin mostly, but get is open)
router.get('/types', getQueryTypes);
router.post('/types', addQueryType);
router.put('/types/:id', updateQueryType);
router.delete('/types/:id', deleteQueryType);

// Ticket routes
router.post('/', createQuery);
router.get('/bootstrap', getHelpdeskBootstrap);
router.get('/analytics/dashboard', getHelpdeskAnalytics);
router.get('/all', getAllQueries); // Must be above /:id
router.get('/my-queries', getMyQueries);
router.get('/assigned', getAssignedQueries);
router.get('/escalated', getEscalatedQueries);
router.get('/:id', getQueryById);
router.put('/:id/close', updateQueryStatus); // Specialized close route
router.post('/:id/comments', addComment);

module.exports = router;
