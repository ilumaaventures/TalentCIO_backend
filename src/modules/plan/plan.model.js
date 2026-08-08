const mongoose = require('mongoose');

const planSchema = new mongoose.Schema({
    name: { type: String, required: true, trim: true },
    description: { type: String, default: '' },
    price: { type: Number, required: true, default: 0 },
    billingCycle: { type: String, enum: ['Monthly', 'Quarterly', 'Yearly'], default: 'Monthly' },
    maxUsers: { type: Number, default: 50 },
    maxModules: { type: Number, default: 5 },
    features: { type: [String], default: [] },
    includedModules: { type: [String], default: [] },
    isActive: { type: Boolean, default: true },
    isPopular: { type: Boolean, default: false },
    trialDays: { type: Number, default: 14 },
}, { timestamps: true });

module.exports = mongoose.model('Plan', planSchema);
