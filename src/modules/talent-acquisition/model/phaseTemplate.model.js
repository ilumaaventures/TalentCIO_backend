const mongoose = require('mongoose');
const { validateAndSanitizePhases } = require('../utils/phaseTemplateUtils');

const statusOptionSchema = new mongoose.Schema({
    value: { type: String, required: true, trim: true },
    label: { type: String, required: true, trim: true },
    color: { type: String, default: '#3B82F6' },
    isDefault: { type: Boolean, default: false }
}, { _id: false });

const decisionOptionSchema = new mongoose.Schema({
    value: { type: String, required: true, trim: true },
    label: { type: String, required: true, trim: true },
    color: { type: String, default: '#10B981' },
    type: {
        type: String,
        enum: ['advance', 'hold', 'reject'],
        required: true
    },
    nextPhaseOrder: { type: Number }
}, { _id: false });

const phaseSchema = new mongoose.Schema({
    name: { type: String, required: true, trim: true },
    description: { type: String, default: '' },
    order: { type: Number, required: true },
    color: { type: String, default: '#3B82F6' },
    statusOptions: {
        type: [statusOptionSchema],
        default: []
    },
    decisionOptions: {
        type: [decisionOptionSchema],
        default: []
    },
    allowedActions: {
        type: [String],
        default: []
    }
});

const phaseTemplateSchema = new mongoose.Schema({
    companyId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Company',
        required: true,
        index: true
    },
    name: {
        type: String,
        required: true,
        trim: true
    },
    description: {
        type: String,
        default: ''
    },
    isDefault: {
        type: Boolean,
        default: false
    },
    isActive: {
        type: Boolean,
        default: true
    },
    phases: {
        type: [phaseSchema],
        default: [],
        validate: {
            validator(value) {
                return Array.isArray(value) && value.length > 0;
            },
            message: 'At least one phase is required.'
        }
    },
    createdBy: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User'
    }
}, { timestamps: true });

phaseTemplateSchema.index({ companyId: 1, isActive: 1 });
phaseTemplateSchema.index({ companyId: 1, isDefault: 1 });
phaseTemplateSchema.index({ companyId: 1, name: 1 }, { unique: true });

phaseTemplateSchema.pre('validate', async function phaseTemplatePreValidate() {
    this.phases = validateAndSanitizePhases(this.phases || []);
});

phaseTemplateSchema.pre('save', async function phaseTemplatePreSave() {
    if (this.isDefault) {
        await this.constructor.updateMany(
            {
                companyId: this.companyId,
                _id: { $ne: this._id },
                isDefault: true
            },
            { $set: { isDefault: false } }
        );
    }
});

module.exports = mongoose.model('PhaseTemplate', phaseTemplateSchema);
