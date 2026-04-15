const mongoose = require('mongoose');

const clientSchema = new mongoose.Schema({
    // Company Details
    companyName: { type: String, trim: true },
    companyUrl: { type: String, trim: true },
    companyLocation: { type: String, trim: true },

    // Client Details
    name: {
        type: String,
        required: true,
        trim: true
    },
    businessUnit: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'BusinessUnit'
    },
    email: String,
    phone: String,
    location: String,
    companyId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Company',
        index: true
    },

    // Contact Persons (multiple)
    contactPersons: [
        {
            name: { type: String, trim: true },
            email: { type: String, trim: true },
            phone: { type: String, trim: true },
        }
    ],
}, { timestamps: true });

module.exports = mongoose.model('Client', clientSchema);
