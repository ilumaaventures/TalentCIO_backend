const mongoose = require('mongoose');

const pmsContinuousFeedbackSchema = new mongoose.Schema({
  companyId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Company',
    required: true,
    index: true,
  },
  fromUser: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true,
  },
  toUser: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true,
  },
  feedbackType: {
    type: String,
    enum: ['appreciation', 'constructive', 'note', '1on1_meeting'],
    default: 'appreciation',
  },
  title: { type: String, trim: true },
  content: { type: String, required: true },
  category: {
    type: String,
    enum: ['Teamwork', 'Innovation', 'Leadership', 'Delivery', 'Customer Focus', 'General'],
    default: 'General',
  },
  visibility: {
    type: String,
    enum: ['public', 'manager_only', 'private'],
    default: 'public',
  },
  tags: [{ type: String, trim: true }],
  meetingDetails: {
    meetingDate: { type: Date },
    discussionTopics: [{ type: String }],
    actionItems: [
      {
        task: { type: String, required: true },
        owner: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
        dueDate: { type: Date },
        completed: { type: Boolean, default: false },
      },
    ],
    privateNotes: { type: String, default: '' },
  },
  reactions: [
    {
      user: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
      emoji: { type: String, default: '👏' },
    },
  ],
}, { timestamps: true });

pmsContinuousFeedbackSchema.index({ companyId: 1, toUser: 1, createdAt: -1 });
pmsContinuousFeedbackSchema.index({ companyId: 1, fromUser: 1 });

module.exports = mongoose.model('PmsContinuousFeedback', pmsContinuousFeedbackSchema);
