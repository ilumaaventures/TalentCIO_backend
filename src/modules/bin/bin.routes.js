const express = require('express');
const router = express.Router();
const { protect } = require('../../common/middleware/authMiddleware');
const { authorize } = require('../../common/middleware/authorize');
const {
    getBinItems,
    restoreItem,
    permanentDeleteItem,
    emptyBin
} = require('./bin.controller');

router.use(protect);

router.get('/', authorize('bin.view'), getBinItems);
router.post('/:entity/:id/restore', authorize('bin.restore'), restoreItem);
router.delete('/:entity/:id/permanent', authorize('bin.permanent_delete'), permanentDeleteItem);
router.delete('/empty', authorize('bin.permanent_delete'), emptyBin);

module.exports = router;
