const mongoose = require('mongoose');

const escalationRuleSchema = new mongoose.Schema({
    queryType: {
        type: String,
        enum: ['Payroll Issue', 'Leave Query', 'Benefits Query', 'Policy Query', 'IT Support', 'Other'],
        required: true
    },
    companyId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Company',
        required: true,
        index: true
    },
    firstLevelTeam: {
        type: String,
        required: true
    },
    escalationTeam: {
        type: String,
        required: true
    },
    escalationDays: {
        type: Number,
        default: 2
    },
    escalationRole: {
        type: String,
        enum: ['Admin', 'HR Manager', 'IT Manager'],
        default: 'Admin'
    }
});
 
escalationRuleSchema.index({ queryType: 1, companyId: 1 }, { unique: true });

module.exports = mongoose.model('EscalationRule', escalationRuleSchema);
