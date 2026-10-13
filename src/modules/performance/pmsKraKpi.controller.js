const mongoose = require('mongoose');
const PmsKra = require('./models/pmsKra.model');
const PmsKpi = require('./models/pmsKpi.model');
const User = require('../user/user.model');
const { calculateKpiAchievement } = require('./services/pmsScoring.service');
const { logPmsAudit } = require('./services/pmsAudit.service');
const { isUserAdminOrSuper, isUserHr } = require('./services/pmsWorkflow.service');

/**
 * @desc List KRAs with pagination & filters
 * @route GET /api/performance/kras
 */
const listKras = async (req, res) => {
  try {
    const companyId = req.companyId;
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 20));
    const skip = (page - 1) * limit;

    const filter = { companyId };
    if (req.query.isTemplate !== undefined) {
      filter.isTemplate = req.query.isTemplate === 'true';
    }
    if (req.query.category) filter.category = req.query.category;
    if (req.query.department) filter.applicableDepartments = req.query.department;
    if (req.query.cycleId) filter.cycleId = req.query.cycleId;
    if (req.query.search) {
      filter.name = { $regex: req.query.search.trim(), $options: 'i' };
    }

    let [kras, total] = await Promise.all([
      PmsKra.find(filter)
        .populate('cycleId', 'name startDate endDate')
        .populate('createdBy', 'firstName lastName')
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      PmsKra.countDocuments(filter),
    ]);

    if (total === 0 && !req.query.search && !req.query.category) {
      const { ensureDefaultCycleAndParticipants } = require('./pmsSimpleEvaluation.controller');
      await ensureDefaultCycleAndParticipants(companyId, req.user._id);
      kras = await PmsKra.find(filter)
        .populate('cycleId', 'name startDate endDate')
        .populate('createdBy', 'firstName lastName')
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean();
      total = await PmsKra.countDocuments(filter);
    }

    // Attach count of KPIs for each KRA
    const kraIds = kras.map((k) => k._id);
    const kpiCounts = await PmsKpi.aggregate([
      { $match: { kraId: { $in: kraIds } } },
      { $group: { _id: '$kraId', count: { $sum: 1 } } },
    ]);
    const kpiCountMap = new Map(kpiCounts.map((c) => [String(c._id), c.count]));

    const result = kras.map((k) => ({
      ...k,
      kpiCount: kpiCountMap.get(String(k._id)) || 0,
    }));

    return res.status(200).json({
      success: true,
      data: result,
      pagination: {
        page,
        limit,
        total,
        pages: Math.ceil(total / limit),
      },
    });
  } catch (err) {
    console.error('[PMS listKras Error]:', err);
    return res.status(500).json({ success: false, message: 'Failed to fetch KRAs' });
  }
};

/**
 * @desc Create new KRA or KRA Template
 * @route POST /api/performance/kras
 */
const createKra = async (req, res) => {
  try {
    const {
      name,
      code,
      description,
      category,
      applicableDepartments,
      applicableDesignations,
      weightage,
      measurementMethod,
      targetDefinition,
      isTemplate,
      isMandatory,
      cycleId,
    } = req.body;

    if (!name) {
      return res.status(400).json({ success: false, message: 'KRA name is required' });
    }

    const kra = await PmsKra.create({
      companyId: req.companyId,
      name: name.trim(),
      code: code || `KRA-${Date.now().toString().slice(-4)}`,
      description,
      category: category || 'Productivity & Delivery',
      applicableDepartments: applicableDepartments || [],
      applicableDesignations: applicableDesignations || [],
      weightage: Number(weightage) || 20,
      measurementMethod,
      targetDefinition,
      isTemplate: Boolean(isTemplate),
      isMandatory: Boolean(isMandatory),
      cycleId: cycleId || null,
      createdBy: req.user._id,
    });

    await logPmsAudit({
      companyId: req.companyId,
      userId: req.user._id,
      action: 'KRA_CREATED',
      entityType: 'PmsKra',
      entityId: kra._id,
      entityName: kra.name,
      changes: req.body,
    });

    return res.status(201).json({ success: true, message: 'KRA created successfully', data: kra });
  } catch (err) {
    console.error('[PMS createKra Error]:', err);
    return res.status(500).json({ success: false, message: 'Failed to create KRA' });
  }
};

/**
 * @desc Update existing KRA
 * @route PUT /api/performance/kras/:id
 */
const updateKra = async (req, res) => {
  try {
    const { id } = req.params;
    const kra = await PmsKra.findOne({ _id: id, companyId: req.companyId });
    if (!kra) {
      return res.status(404).json({ success: false, message: 'KRA not found' });
    }

    const allowed = [
      'name',
      'code',
      'description',
      'category',
      'applicableDepartments',
      'applicableDesignations',
      'weightage',
      'measurementMethod',
      'targetDefinition',
      'isTemplate',
      'isMandatory',
      'status',
    ];

    allowed.forEach((field) => {
      if (req.body[field] !== undefined) kra[field] = req.body[field];
    });

    kra.updatedBy = req.user._id;
    await kra.save();

    await logPmsAudit({
      companyId: req.companyId,
      userId: req.user._id,
      action: 'KRA_UPDATED',
      entityType: 'PmsKra',
      entityId: kra._id,
      entityName: kra.name,
      changes: req.body,
    });

    return res.status(200).json({ success: true, message: 'KRA updated successfully', data: kra });
  } catch (err) {
    console.error('[PMS updateKra Error]:', err);
    return res.status(500).json({ success: false, message: 'Failed to update KRA' });
  }
};

/**
 * @desc Delete KRA
 * @route DELETE /api/performance/kras/:id
 */
const deleteKra = async (req, res) => {
  try {
    const { id } = req.params;
    const kra = await PmsKra.findOneAndDelete({ _id: id, companyId: req.companyId });
    if (!kra) {
      return res.status(404).json({ success: false, message: 'KRA not found' });
    }

    // Also delete linked KPIs
    await PmsKpi.deleteMany({ kraId: id, companyId: req.companyId });

    await logPmsAudit({
      companyId: req.companyId,
      userId: req.user._id,
      action: 'KRA_DELETED',
      entityType: 'PmsKra',
      entityId: kra._id,
      entityName: kra.name,
    });

    return res.status(200).json({ success: true, message: 'KRA and linked KPIs deleted successfully' });
  } catch (err) {
    console.error('[PMS deleteKra Error]:', err);
    return res.status(500).json({ success: false, message: 'Failed to delete KRA' });
  }
};

/**
 * @desc List KPIs with calculation values & pagination
 * @route GET /api/performance/kpis
 */
const listKpis = async (req, res) => {
  try {
    const companyId = req.companyId;
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 20));
    const skip = (page - 1) * limit;

    const filter = { companyId };
    const isHrOrAdmin = isUserAdminOrSuper(req.user) || isUserHr(req.user);
    if (!isHrOrAdmin) {
      if (req.query.scope === 'my_team') {
        const directReports = await User.find({ reportingManagers: req.user._id, companyId }).select('_id').lean();
        const reportIds = directReports.map((d) => d._id);
        filter.employeeId = { $in: reportIds };
      } else if (!req.query.scope || req.query.scope === 'self' || req.query.employeeId === String(req.user._id)) {
        filter.employeeId = req.user._id;
      } else {
        const directReports = await User.find({ reportingManagers: req.user._id, companyId }).select('_id').lean();
        const isReport = directReports.some((d) => String(d._id) === String(req.query.employeeId));
        if (!isReport) {
          filter.employeeId = req.user._id;
        }
      }
    } else if (req.query.employeeId) {
      filter.employeeId = req.query.employeeId;
    }

    if (req.query.kraId) filter.kraId = req.query.kraId;
    if (req.query.cycleId) filter.cycleId = req.query.cycleId;
    if (req.query.scope && isHrOrAdmin) filter.scope = req.query.scope;
    if (req.query.search) {
      filter.name = { $regex: req.query.search.trim(), $options: 'i' };
    }

    const [kpis, total] = await Promise.all([
      PmsKpi.find(filter)
        .populate('kraId', 'name category weightage')
        .populate('employeeId', 'firstName lastName email profilePicture')
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      PmsKpi.countDocuments(filter),
    ]);

    return res.status(200).json({
      success: true,
      data: kpis,
      pagination: {
        page,
        limit,
        total,
        pages: Math.ceil(total / limit),
      },
    });
  } catch (err) {
    console.error('[PMS listKpis Error]:', err);
    return res.status(500).json({ success: false, message: 'Failed to fetch KPIs' });
  }
};

/**
 * @desc Create new KPI
 * @route POST /api/performance/kpis
 */
const createKpi = async (req, res) => {
  try {
    const {
      kraId,
      cycleId,
      employeeId,
      name,
      code,
      description,
      scope,
      measurementUnit,
      measurementDirection,
      baselineValue,
      targetValue,
      actualValue,
      acceptableRangeMin,
      acceptableRangeMax,
      weightage,
      measurementFrequency,
    } = req.body;

    if (!kraId || !name || targetValue === undefined) {
      return res.status(400).json({ success: false, message: 'KRA, KPI Name, and Target Value are required' });
    }

    const kra = await PmsKra.findOne({ _id: kraId, companyId: req.companyId });
    if (!kra) {
      return res.status(404).json({ success: false, message: 'Parent KRA not found' });
    }

    // Auto-calculate initial achievement
    const calc = calculateKpiAchievement({
      targetValue,
      actualValue: actualValue || 0,
      measurementDirection,
      acceptableRangeMin,
      acceptableRangeMax,
    });

    const kpi = await PmsKpi.create({
      companyId: req.companyId,
      kraId,
      cycleId: cycleId || kra.cycleId || null,
      employeeId: employeeId || null,
      name: name.trim(),
      code: code || `KPI-${Date.now().toString().slice(-4)}`,
      description,
      scope: scope || 'individual',
      measurementUnit: measurementUnit || 'percentage',
      measurementDirection: measurementDirection || 'higher_is_better',
      baselineValue: Number(baselineValue) || 0,
      targetValue: Number(targetValue),
      actualValue: Number(actualValue) || 0,
      acceptableRangeMin: Number(acceptableRangeMin) || 0,
      acceptableRangeMax: Number(acceptableRangeMax) || 0,
      weightage: Number(weightage) || 20,
      achievementPercentage: calc.achievementPercent,
      calculatedScore: calc.calculatedScore,
      measurementFrequency: measurementFrequency || 'quarterly',
      createdBy: req.user._id,
    });

    return res.status(201).json({ success: true, message: 'KPI created successfully', data: kpi });
  } catch (err) {
    console.error('[PMS createKpi Error]:', err);
    return res.status(500).json({ success: false, message: 'Failed to create KPI' });
  }
};

/**
 * @desc Update KPI values, recalculate achievement and score
 * @route PUT /api/performance/kpis/:id
 */
const updateKpi = async (req, res) => {
  try {
    const { id } = req.params;
    const kpi = await PmsKpi.findOne({ _id: id, companyId: req.companyId });
    if (!kpi) {
      return res.status(404).json({ success: false, message: 'KPI not found' });
    }

    const fields = [
      'name',
      'code',
      'description',
      'measurementUnit',
      'measurementDirection',
      'baselineValue',
      'targetValue',
      'actualValue',
      'acceptableRangeMin',
      'acceptableRangeMax',
      'weightage',
      'measurementFrequency',
      'status',
    ];

    fields.forEach((f) => {
      if (req.body[f] !== undefined) kpi[f] = req.body[f];
    });

    // Recompute score on update
    const calc = calculateKpiAchievement({
      targetValue: kpi.targetValue,
      actualValue: kpi.actualValue,
      measurementDirection: kpi.measurementDirection,
      acceptableRangeMin: kpi.acceptableRangeMin,
      acceptableRangeMax: kpi.acceptableRangeMax,
    });

    kpi.achievementPercentage = calc.achievementPercent;
    kpi.calculatedScore = calc.calculatedScore;
    kpi.updatedBy = req.user._id;

    await kpi.save();

    return res.status(200).json({ success: true, message: 'KPI updated successfully', data: kpi });
  } catch (err) {
    console.error('[PMS updateKpi Error]:', err);
    return res.status(500).json({ success: false, message: 'Failed to update KPI' });
  }
};

/**
 * @desc Submit evidence document or proof for KPI
 * @route POST /api/performance/kpis/:id/evidence
 */
const submitKpiEvidence = async (req, res) => {
  try {
    const { id } = req.params;
    const { fileUrl, fileName, comment, actualValue } = req.body;

    const kpi = await PmsKpi.findOne({ _id: id, companyId: req.companyId });
    if (!kpi) {
      return res.status(404).json({ success: false, message: 'KPI not found' });
    }

    if (actualValue !== undefined) {
      kpi.actualValue = Number(actualValue);
      const calc = calculateKpiAchievement({
        targetValue: kpi.targetValue,
        actualValue: kpi.actualValue,
        measurementDirection: kpi.measurementDirection,
      });
      kpi.achievementPercentage = calc.achievementPercent;
      kpi.calculatedScore = calc.calculatedScore;
    }

    kpi.evidence.push({
      fileUrl: fileUrl || '',
      fileName: fileName || 'Evidence Document',
      comment: comment || '',
      submittedAt: new Date(),
      submittedBy: req.user._id,
    });

    kpi.status = 'submitted';
    await kpi.save();

    return res.status(200).json({ success: true, message: 'KPI evidence submitted successfully', data: kpi });
  } catch (err) {
    console.error('[PMS submitKpiEvidence Error]:', err);
    return res.status(500).json({ success: false, message: 'Failed to submit evidence' });
  }
};

/**
 * @desc Manager or verifier verifies/approves KPI actual value
 * @route POST /api/performance/kpis/:id/verify
 */
const verifyKpi = async (req, res) => {
  try {
    const { id } = req.params;
    const { status, verificationComment } = req.body;

    const kpi = await PmsKpi.findOne({ _id: id, companyId: req.companyId });
    if (!kpi) {
      return res.status(404).json({ success: false, message: 'KPI not found' });
    }

    // Separation of duties: cannot verify own KPI
    if (String(kpi.employeeId) === String(req.user._id)) {
      return res.status(403).json({ success: false, message: 'Separation of duties: You cannot verify your own KPI.' });
    }

    kpi.status = status || 'verified';
    kpi.verifiedBy = req.user._id;
    kpi.verifiedAt = new Date();
    kpi.verificationComment = verificationComment || '';
    await kpi.save();

    return res.status(200).json({ success: true, message: 'KPI verified successfully', data: kpi });
  } catch (err) {
    console.error('[PMS verifyKpi Error]:', err);
    return res.status(500).json({ success: false, message: 'Failed to verify KPI' });
  }
};

module.exports = {
  listKras,
  createKra,
  updateKra,
  deleteKra,
  listKpis,
  createKpi,
  updateKpi,
  submitKpiEvidence,
  verifyKpi,
};
