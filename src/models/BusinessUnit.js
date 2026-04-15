const mongoose = require('mongoose');

const businessUnitSchema = new mongoose.Schema({
    name: {
        type: String,
        required: true,
        trim: true
    },
    companyId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Company',
        index: true
    },
    headOfUnit: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User'
    },
    description: String
}, { timestamps: true });

module.exports = mongoose.model('BusinessUnit', businessUnitSchema);
