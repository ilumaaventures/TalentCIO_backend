const express = require('express');
const { requireModule } = require('../../common/middleware/moduleGuard');
const router = express.Router();
const { protect } = require('../../common/middleware/authMiddleware');
const { authorize } = require('../../common/middleware/authorize');
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

const helpdeskAdmin = authorize('helpdesk.manage', 'helpdesk.types.manage', 'admin');
const helpdeskViewAll = authorize('helpdesk.manage', 'helpdesk.view_all', 'admin');
const helpdeskAnalytics = authorize('helpdesk.manage', 'helpdesk.analytics.view', 'admin');

// Query Type Routes (Admin mostly, but get is open)
router.get('/types', getQueryTypes);
router.post('/types', helpdeskAdmin, addQueryType);
router.put('/types/:id', helpdeskAdmin, updateQueryType);
router.delete('/types/:id', helpdeskAdmin, deleteQueryType);

// Ticket routes
router.post('/', createQuery);
router.get('/bootstrap', getHelpdeskBootstrap);
router.get('/analytics/dashboard', helpdeskAnalytics, getHelpdeskAnalytics);
router.get('/all', helpdeskViewAll, getAllQueries); // Must be above /:id
router.get('/my-queries', getMyQueries);
router.get('/assigned', getAssignedQueries);
router.get('/escalated', helpdeskViewAll, getEscalatedQueries);
router.get('/:id', getQueryById);
router.put('/:id/close', updateQueryStatus); // Specialized close route
router.post('/:id/comments', addComment);

module.exports = router;
