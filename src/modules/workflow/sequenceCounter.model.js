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

sequenceCounterSchema.statics.getNextSequence = async function (companyId, key, step = 1, session = null) {
    const year = new Date().getFullYear();
    const query = { companyId, key, year };
    const update = { $inc: { seq: step } };
    const options = { new: true, upsert: true, setDefaultsOnInsert: true };
    if (session) {
        options.session = session;
    }
    const doc = await this.findOneAndUpdate(query, update, options);
    return doc.seq;
};

module.exports = mongoose.model('SequenceCounter', sequenceCounterSchema);
