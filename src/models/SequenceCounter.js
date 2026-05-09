const mongoose = require('mongoose');

const sequenceCounterSchema = new mongoose.Schema({
    companyId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Company',
        required: true,
        index: true
    },
    key: {
        type: String,
        required: true,
        trim: true
    },
    year: {
        type: Number,
        required: true
    },
    seq: {
        type: Number,
        default: 0,
        min: 0
    }
}, { timestamps: true });

sequenceCounterSchema.index({ companyId: 1, key: 1, year: 1 }, { unique: true });

module.exports = mongoose.model('SequenceCounter', sequenceCounterSchema);
