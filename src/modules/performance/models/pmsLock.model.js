const mongoose = require('mongoose');

const pmsLockSchema = new mongoose.Schema(
  {
    _id: { type: String, required: true },
    lockedAt: { type: Date, default: null },
    expiresAt: { type: Date, default: null },
    acquiredBy: { type: String, default: null },
  },
  { timestamps: true }
);

module.exports = mongoose.model('PmsLock', pmsLockSchema);
