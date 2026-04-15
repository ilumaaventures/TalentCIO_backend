const mongoose = require('mongoose');

const ActionItemSchema = new mongoose.Schema({
    taskDescription: { type: String, required: true },
    assignee: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    dueDate: Date,
    priority: { type: String, enum: ['Low', 'Medium', 'High', 'Urgent'], default: 'Medium' },
    status: { type: String, enum: ['Pending', 'In Progress', 'Completed', 'Cancelled'], default: 'Pending' }
});

const AgendaItemSchema = new mongoose.Schema({
    title: { type: String, required: true },
    description: String,
    owner: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    estimatedTime: Number // in minutes
});

const meetingSchema = new mongoose.Schema({
    title: { type: String, required: true },
    date: { type: Date, required: true },
    startTime: String,
    endTime: String,
    companyId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Company',
        index: true
    },
    meetingType: { type: String, enum: ['Internal', 'Client', 'Project', 'Other'], default: 'Internal' },
    location: String,
    objective: String,

    // Participants
    host: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    attendees: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
    absentees: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],

    // Agenda
    agendaItems: [AgendaItemSchema],

    // Notes
    discussionPoints: String,
    decisionsMade: String,

    // Action Items
    actionItems: [ActionItemSchema],

    // Follow-Up
    nextMeetingDate: Date,
    additionalActions: String,

    // Attachments
    files: [{
        name: String,
        url: String
    }],
    links: [String],

    // Approval
    reviewedBy: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
    approvalDate: Date,
    status: { type: String, enum: ['Draft', 'Published', 'Approved', 'Archived'], default: 'Draft' },

    // Misc
    summary: String,
    notes: String

}, { timestamps: true });

meetingSchema.index({ companyId: 1, date: 1 });
meetingSchema.index({ host: 1, companyId: 1, date: -1 });

module.exports = mongoose.model('Meeting', meetingSchema);
