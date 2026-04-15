const express = require('express');
const router = express.Router();
const { getHolidays, addHoliday, updateHoliday, deleteHoliday } = require('../controllers/holidayController');
const { protect } = require('../middlewares/authMiddleware');
const { authorize } = require('../middlewares/authorize');

router.route('/')
    .get(protect, getHolidays)
    .post(protect, authorize('holiday.create'), addHoliday);

router.route('/:id')
    .put(protect, authorize('holiday.edit'), updateHoliday)
    .delete(protect, authorize('holiday.delete'), deleteHoliday);

module.exports = router;
