const express = require('express');
const router = express.Router();
const { getHolidays, addHoliday, updateHoliday, deleteHoliday } = require('./holiday.controller');
const { protect } = require('../../common/middleware/authMiddleware');
const { authorize } = require('../../common/middleware/authorize');
const { requireModule } = require('../../common/middleware/moduleGuard');

router.use(protect);
router.use(requireModule('holidays'));

router.route('/')
    .get(getHolidays)
    .post(authorize('holiday.create'), addHoliday);

router.route('/:id')
    .put(authorize('holiday.edit'), updateHoliday)
    .delete(authorize('holiday.delete'), deleteHoliday);

module.exports = router;
