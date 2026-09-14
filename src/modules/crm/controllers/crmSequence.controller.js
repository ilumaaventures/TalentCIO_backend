const CrmSequence = require('../models/crmSequence.model');
const CrmActivity = require('../models/crmActivity.model');

const getTenantId = (req) => req.companyId || req.user?.companyId;

const getUserDisplayName = (user) => {
  if (!user) return 'System';
  if (user.firstName) return `${user.firstName} ${user.lastName || ''}`.trim();
  return user.name || user.email || 'User';
};

// @desc Get all sales sequences
// @route GET /api/crm/sequences
const getSequences = async (req, res, next) => {
  try {
    const companyId = getTenantId(req);
    const sequences = await CrmSequence.find({ companyId });
    res.json({ success: true, data: sequences });
  } catch (error) {
    next(error);
  }
};

// @desc Create sales sequence
// @route POST /api/crm/sequences
const createSequence = async (req, res, next) => {
  try {
    const companyId = getTenantId(req);
    const sequence = await CrmSequence.create({
      ...req.body,
      companyId,
    });
    res.status(201).json({ success: true, message: 'Sequence created', data: sequence });
  } catch (error) {
    next(error);
  }
};

// @desc Enroll lead into sequence
// @route POST /api/crm/sequences/:id/enroll
const enrollLead = async (req, res, next) => {
  try {
    const companyId = getTenantId(req);
    const { leadId } = req.body;
    const sequence = await CrmSequence.findOneAndUpdate(
      { _id: req.params.id, companyId },
      { $inc: { enrolledCount: 1 } },
      { new: true }
    );

    if (!sequence) return res.status(404).json({ success: false, message: 'Sequence not found' });

    if (leadId) {
      await CrmActivity.create({
        companyId,
        type: 'note',
        subject: `Enrolled in sequence: ${sequence.name}`,
        description: `Drip outreach sequence triggered (${sequence.steps?.length || 0} scheduled touchpoints)`,
        performedBy: req.user?._id,
        performedByName: getUserDisplayName(req.user),
        leadId,
      });
    }

    res.json({ success: true, message: `Lead enrolled in '${sequence.name}'`, data: sequence });
  } catch (error) {
    next(error);
  }
};

module.exports = {
  getSequences,
  createSequence,
  enrollLead,
};
