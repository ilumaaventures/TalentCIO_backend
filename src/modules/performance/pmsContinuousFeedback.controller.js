const PmsContinuousFeedback = require('./models/pmsContinuousFeedback.model');
const { logPmsAudit } = require('./services/pmsAudit.service');
const { sendPmsNotification } = require('./services/pmsNotification.service');

/**
 * @desc List feedback entries & 1-on-1 meetings
 * @route GET /api/performance/feedback
 */
const listFeedbacks = async (req, res) => {
  try {
    const companyId = req.companyId;
    const { type, userId, tab } = req.query;

    const filter = { companyId };
    if (type) filter.feedbackType = type;

    if (tab === 'received') {
      filter.toUser = req.user._id;
    } else if (tab === 'given') {
      filter.fromUser = req.user._id;
    } else if (tab === 'meetings') {
      filter.feedbackType = '1on1_meeting';
      filter.$or = [{ fromUser: req.user._id }, { toUser: req.user._id }];
    } else {
      // Public wall + user's own feedback
      filter.$or = [
        { visibility: 'public' },
        { fromUser: req.user._id },
        { toUser: req.user._id },
      ];
    }

    if (userId) {
      filter.$or = [{ fromUser: userId }, { toUser: userId }];
    }

    const rawItems = await PmsContinuousFeedback.find(filter)
      .populate({
        path: 'fromUser',
        match: {
          isActive: true,
          isDeleted: { $ne: true },
          status: { $nin: ['deleted', 'inactive', 'terminated', 'Inactive', 'Terminated'] },
        },
        select: 'firstName lastName profilePicture department designationRef',
      })
      .populate({
        path: 'toUser',
        match: {
          isActive: true,
          isDeleted: { $ne: true },
          status: { $nin: ['deleted', 'inactive', 'terminated', 'Inactive', 'Terminated'] },
        },
        select: 'firstName lastName profilePicture department designationRef',
      })
      .populate('meetingDetails.actionItems.owner', 'firstName lastName')
      .sort({ createdAt: -1 })
      .limit(50)
      .lean();

    const items = rawItems.filter((i) => i.fromUser != null && i.toUser != null);

    return res.status(200).json({ success: true, data: items });
  } catch (err) {
    console.error('[PMS listFeedbacks Error]:', err);
    return res.status(500).json({ success: false, message: 'Failed to fetch continuous feedback' });
  }
};

/**
 * @desc Give appreciation or constructive feedback
 * @route POST /api/performance/feedback
 */
const giveFeedback = async (req, res) => {
  try {
    const { toUser, feedbackType, title, content, category, visibility, tags } = req.body;

    if (!toUser || !content) {
      return res.status(400).json({ success: false, message: 'Recipient and content are required' });
    }

    const feedback = await PmsContinuousFeedback.create({
      companyId: req.companyId,
      fromUser: req.user._id,
      toUser,
      feedbackType: feedbackType || 'appreciation',
      title: title || (feedbackType === 'appreciation' ? 'Kudos & Appreciation' : 'Feedback'),
      content: content.trim(),
      category: category || 'General',
      visibility: visibility || 'public',
      tags: Array.isArray(tags) ? tags : [],
    });

    // Notify recipient
    sendPmsNotification(req, {
      userId: toUser,
      title: 'You received new feedback',
      message: `${req.user.firstName || 'A colleague'} shared ${feedback.feedbackType}: "${content.slice(0, 50)}..."`,
      link: '/performance?tab=continuous',
      preferenceKey: 'pms_feedback_received',
    });

    return res.status(201).json({ success: true, message: 'Feedback shared successfully', data: feedback });
  } catch (err) {
    console.error('[PMS giveFeedback Error]:', err);
    return res.status(500).json({ success: false, message: 'Failed to give feedback' });
  }
};

/**
 * @desc Create or record a 1-on-1 meeting note
 * @route POST /api/performance/feedback/1on1
 */
const create1on1Meeting = async (req, res) => {
  try {
    const { toUser, meetingDate, discussionTopics, actionItems, privateNotes, content } = req.body;

    if (!toUser) {
      return res.status(400).json({ success: false, message: 'Meeting participant is required' });
    }

    const meeting = await PmsContinuousFeedback.create({
      companyId: req.companyId,
      fromUser: req.user._id,
      toUser,
      feedbackType: '1on1_meeting',
      title: '1-on-1 Catchup',
      content: content || '1-on-1 Discussion Notes',
      visibility: 'manager_only',
      meetingDetails: {
        meetingDate: meetingDate || new Date(),
        discussionTopics: Array.isArray(discussionTopics) ? discussionTopics : [],
        actionItems: Array.isArray(actionItems) ? actionItems : [],
        privateNotes: privateNotes || '',
      },
    });

    return res.status(201).json({ success: true, message: '1-on-1 meeting record saved', data: meeting });
  } catch (err) {
    console.error('[PMS create1on1Meeting Error]:', err);
    return res.status(500).json({ success: false, message: 'Failed to record 1-on-1 meeting' });
  }
};

/**
 * @desc Toggle completion on a 1-on-1 action item
 * @route PATCH /api/performance/feedback/:id/action-item
 */
const toggleActionItem = async (req, res) => {
  try {
    const { id } = req.params;
    const { itemIndex, completed } = req.body;

    const feedback = await PmsContinuousFeedback.findOne({ _id: id, companyId: req.companyId });
    if (!feedback || !feedback.meetingDetails?.actionItems) {
      return res.status(404).json({ success: false, message: 'Meeting action items not found' });
    }

    if (feedback.meetingDetails.actionItems[itemIndex]) {
      feedback.meetingDetails.actionItems[itemIndex].completed = Boolean(completed);
      await feedback.save();
    }

    return res.status(200).json({ success: true, message: 'Action item updated', data: feedback });
  } catch (err) {
    console.error('[PMS toggleActionItem Error]:', err);
    return res.status(500).json({ success: false, message: 'Failed to update action item' });
  }
};

module.exports = {
  listFeedbacks,
  giveFeedback,
  create1on1Meeting,
  toggleActionItem,
};
