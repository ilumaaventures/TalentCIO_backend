const express = require('express');
const router = express.Router();
const { getHolidays, addHoliday, updateHoliday, deleteHoliday } = require('../controllers/holidayController');
const { protect } = require('../middlewares/authMiddleware');
const { authorize } = require('../middlewares/authorize');
const { requireModule } = require('../middlewares/moduleGuard');

router.use(protect);
router.use(requireModule('holidays'));

router.route('/')
    .get(getHolidays)
    .post(authorize('holiday.create'), addHoliday);

router.route('/:id')
    .put(authorize('holiday.edit'), updateHoliday)
    .delete(authorize('holiday.delete'), deleteHoliday);

module.exports = router;
