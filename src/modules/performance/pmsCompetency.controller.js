const PmsCompetency = require('./models/pmsCompetency.model');
const { logPmsAudit } = require('./services/pmsAudit.service');
const { isUserAdminOrSuper, isUserHr } = require('./services/pmsWorkflow.service');

const canManageCompetencies = (user) => {
  return isUserAdminOrSuper(user) || isUserHr(user) || user?.permissions?.includes('pms.admin');
};

/**
 * @desc List competencies with filters & pagination
 * @route GET /api/performance/competencies
 */
const listCompetencies = async (req, res) => {
  try {
    const companyId = req.companyId;
    const filter = { companyId };
    if (req.query.category) filter.category = req.query.category;
    if (req.query.department) filter.applicableDepartments = req.query.department;
    if (req.query.isActive !== undefined) filter.isActive = req.query.isActive === 'true';
    if (req.query.search) {
      filter.name = { $regex: req.query.search.trim(), $options: 'i' };
    }

    const competencies = await PmsCompetency.find(filter)
      .sort({ category: 1, name: 1 })
      .lean();

    return res.status(200).json({ success: true, data: competencies });
  } catch (err) {
    console.error('[PMS listCompetencies Error]:', err);
    return res.status(500).json({ success: false, message: 'Failed to fetch competencies' });
  }
};

/**
 * @desc Create new competency
 * @route POST /api/performance/competencies
 */
const createCompetency = async (req, res) => {
  try {
    if (!canManageCompetencies(req.user)) {
      return res.status(403).json({ success: false, message: 'Forbidden: Insufficient permissions to create competencies' });
    }
    const {
      name,
      code,
      category,
      description,
      applicableDepartments,
      applicableDesignations,
      expectedProficiency,
      observableBehaviors,
      ratingScaleMax,
      weightage,
    } = req.body;

    if (!name) {
      return res.status(400).json({ success: false, message: 'Competency name is required' });
    }

    const competency = await PmsCompetency.create({
      companyId: req.companyId,
      name: name.trim(),
      code: code || `COMP-${Date.now().toString().slice(-4)}`,
      category: category || 'Core Organizational',
      description,
      applicableDepartments: applicableDepartments || [],
      applicableDesignations: applicableDesignations || [],
      expectedProficiency: Number(expectedProficiency) || 3,
      observableBehaviors: Array.isArray(observableBehaviors) ? observableBehaviors : [],
      ratingScaleMax: Number(ratingScaleMax) || 5,
      weightage: Number(weightage) || 10,
      createdBy: req.user._id,
    });

    await logPmsAudit({
      companyId: req.companyId,
      userId: req.user._id,
      action: 'COMPETENCY_CREATED',
      entityType: 'PmsCompetency',
      entityId: competency._id,
      entityName: competency.name,
      changes: req.body,
    });

    return res.status(201).json({ success: true, message: 'Competency created successfully', data: competency });
  } catch (err) {
    console.error('[PMS createCompetency Error]:', err);
    return res.status(500).json({ success: false, message: 'Failed to create competency' });
  }
};

/**
 * @desc Update competency
 * @route PUT /api/performance/competencies/:id
 */
const updateCompetency = async (req, res) => {
  try {
    if (!canManageCompetencies(req.user)) {
      return res.status(403).json({ success: false, message: 'Forbidden: Insufficient permissions to update competencies' });
    }
    const { id } = req.params;
    const competency = await PmsCompetency.findOne({ _id: id, companyId: req.companyId });
    if (!competency) {
      return res.status(404).json({ success: false, message: 'Competency not found' });
    }

    const fields = [
      'name',
      'code',
      'category',
      'description',
      'applicableDepartments',
      'applicableDesignations',
      'expectedProficiency',
      'observableBehaviors',
      'ratingScaleMax',
      'weightage',
      'isActive',
    ];

    fields.forEach((f) => {
      if (req.body[f] !== undefined) competency[f] = req.body[f];
    });

    competency.updatedBy = req.user._id;
    await competency.save();

    return res.status(200).json({ success: true, message: 'Competency updated successfully', data: competency });
  } catch (err) {
    console.error('[PMS updateCompetency Error]:', err);
    return res.status(500).json({ success: false, message: 'Failed to update competency' });
  }
};

/**
 * @desc Delete competency
 * @route DELETE /api/performance/competencies/:id
 */
const deleteCompetency = async (req, res) => {
  try {
    if (!canManageCompetencies(req.user)) {
      return res.status(403).json({ success: false, message: 'Forbidden: Insufficient permissions to delete competencies' });
    }
    const { id } = req.params;
    const competency = await PmsCompetency.findOneAndDelete({ _id: id, companyId: req.companyId });
    if (!competency) {
      return res.status(404).json({ success: false, message: 'Competency not found' });
    }

    return res.status(200).json({ success: true, message: 'Competency deleted successfully' });
  } catch (err) {
    console.error('[PMS deleteCompetency Error]:', err);
    return res.status(500).json({ success: false, message: 'Failed to delete competency' });
  }
};

module.exports = {
  listCompetencies,
  createCompetency,
  updateCompetency,
  deleteCompetency,
};
