const mongoose = require('mongoose');
const PmsKpiTemplate = require('./models/pmsKpiTemplate.model');
const PmsKpi = require('./models/pmsKpi.model');
const PmsKra = require('./models/pmsKra.model');
const PmsCycle = require('./models/pmsCycle.model');
const Department = require('../organization/models/department.model');
const Designation = require('../organization/models/designation.model');
const User = require('../user/user.model');
const { calculateKpiAchievement } = require('./services/pmsScoring.service');
const { logPmsAudit } = require('./services/pmsAudit.service');
const { sendPmsNotification } = require('./services/pmsNotification.service');
const { isUserAdminOrSuper, isUserHr } = require('./services/pmsWorkflow.service');

const canManageKpis = (user) => {
  return (
    isUserAdminOrSuper(user) ||
    isUserHr(user) ||
    user?.permissions?.includes('pms.kra.manage') ||
    user?.permissions?.includes('pms.kpi.manage') ||
    user?.permissions?.includes('pms.admin')
  );
};

// ─── 1. KPI TEMPLATES MANAGEMENT ─────────────────────────────────────────────

/**
 * @desc List reusable KPI templates with filters & pagination
 * @route GET /api/performance/kpi-templates
 */
const listKpiTemplates = async (req, res) => {
  try {
    const companyId = req.companyId;
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 20));
    const skip = (page - 1) * limit;

    const filter = { companyId };

    if (req.query.department) {
      if (mongoose.Types.ObjectId.isValid(req.query.department)) {
        filter.department = req.query.department;
      } else {
        filter.$or = [
          { departmentName: { $regex: req.query.department.trim(), $options: 'i' } },
        ];
      }
    }

    if (req.query.designation) {
      if (mongoose.Types.ObjectId.isValid(req.query.designation)) {
        filter.designation = req.query.designation;
      } else {
        filter.designationName = { $regex: req.query.designation.trim(), $options: 'i' };
      }
    }

    if (req.query.kraId) {
      filter.kraId = req.query.kraId;
    }

    if (req.query.status && req.query.status !== 'all') {
      filter.status = req.query.status;
    }

    if (req.query.search) {
      const q = req.query.search.trim();
      filter.$or = [
        { name: { $regex: q, $options: 'i' } },
        { code: { $regex: q, $options: 'i' } },
        { description: { $regex: q, $options: 'i' } },
        { departmentName: { $regex: q, $options: 'i' } },
        { designationName: { $regex: q, $options: 'i' } },
      ];
    }

    const [templates, total] = await Promise.all([
      PmsKpiTemplate.find(filter)
        .populate('kraId', 'name category weightage code')
        .populate('department', 'name code')
        .populate('designation', 'title level')
        .populate('createdBy', 'firstName lastName email')
        .sort({ updatedAt: -1, createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      PmsKpiTemplate.countDocuments(filter),
    ]);

    return res.status(200).json({
      success: true,
      data: templates,
      pagination: {
        page,
        limit,
        total,
        pages: Math.ceil(total / limit),
      },
    });
  } catch (err) {
    console.error('[PMS listKpiTemplates Error]:', err);
    return res.status(500).json({ success: false, message: 'Failed to fetch KPI templates' });
  }
};

/**
 * @desc Get single KPI template details
 * @route GET /api/performance/kpi-templates/:id
 */
const getKpiTemplateById = async (req, res) => {
  try {
    const { id } = req.params;
    const template = await PmsKpiTemplate.findOne({ _id: id, companyId: req.companyId })
      .populate('kraId', 'name category weightage code')
      .populate('department', 'name code')
      .populate('designation', 'title level')
      .populate('createdBy', 'firstName lastName')
      .lean();

    if (!template) {
      return res.status(404).json({ success: false, message: 'KPI template not found' });
    }

    return res.status(200).json({ success: true, data: template });
  } catch (err) {
    console.error('[PMS getKpiTemplateById Error]:', err);
    return res.status(500).json({ success: false, message: 'Failed to fetch KPI template details' });
  }
};

/**
 * @desc Create a new reusable KPI template
 * @route POST /api/performance/kpi-templates
 */
const createKpiTemplate = async (req, res) => {
  try {
    if (!canManageKpis(req.user)) {
      return res.status(403).json({ success: false, message: 'Forbidden: Insufficient permissions to create KPI templates' });
    }

    const {
      name,
      code,
      description,
      department,
      departmentName,
      designation,
      designationName,
      kraId,
      measurementType,
      unit,
      targetValue,
      weightage,
      ratingMethod,
      measurementDirection,
      ratingScale,
      effectiveStartDate,
      effectiveEndDate,
      status,
    } = req.body;

    if (!name || !name.trim()) {
      return res.status(400).json({ success: false, message: 'KPI Name is required' });
    }

    if (!kraId) {
      return res.status(400).json({ success: false, message: 'Linked KRA is required' });
    }

    // Verify parent KRA exists in company
    const parentKra = await PmsKra.findOne({ _id: kraId, companyId: req.companyId }).lean();
    if (!parentKra) {
      return res.status(404).json({ success: false, message: 'Linked parent KRA not found' });
    }

    // Resolve Department & Designation names if IDs provided
    let finalDeptId = null;
    let finalDeptName = departmentName || '';
    if (department && mongoose.Types.ObjectId.isValid(department)) {
      finalDeptId = department;
      const deptDoc = await Department.findById(department).select('name').lean();
      if (deptDoc?.name) finalDeptName = deptDoc.name;
    }

    let finalDesigId = null;
    let finalDesigName = designationName || '';
    if (designation && mongoose.Types.ObjectId.isValid(designation)) {
      finalDesigId = designation;
      const desigDoc = await Designation.findById(designation).select('title').lean();
      if (desigDoc?.title) finalDesigName = desigDoc.title;
    }

    const generatedCode = code
      ? code.trim().toUpperCase()
      : `KPI-${(finalDeptName ? finalDeptName.slice(0, 3) : 'COR').toUpperCase()}-${Date.now().toString().slice(-4)}`;

    const template = await PmsKpiTemplate.create({
      companyId: req.companyId,
      name: name.trim(),
      code: generatedCode,
      description: description || '',
      department: finalDeptId,
      departmentName: finalDeptName,
      designation: finalDesigId,
      designationName: finalDesigName,
      kraId,
      measurementType: measurementType || 'percentage',
      unit: unit || (measurementType === 'currency' ? '$' : measurementType === 'days' ? 'days' : '%'),
      targetValue: Number(targetValue) || 100,
      weightage: Number(weightage) || 20,
      ratingMethod: ratingMethod || 'automatic',
      measurementDirection: measurementDirection || 'higher_is_better',
      ratingScale: ratingScale || '1-5',
      effectiveStartDate: effectiveStartDate || null,
      effectiveEndDate: effectiveEndDate || null,
      status: status || 'active',
      createdBy: req.user._id,
    });

    await logPmsAudit({
      companyId: req.companyId,
      userId: req.user._id,
      action: 'KPI_TEMPLATE_CREATED',
      entityType: 'PmsKpiTemplate',
      entityId: template._id,
      entityName: template.name,
      changes: req.body,
    });

    return res.status(201).json({ success: true, message: 'KPI template created successfully', data: template });
  } catch (err) {
    console.error('[PMS createKpiTemplate Error]:', err);
    return res.status(500).json({ success: false, message: err.message || 'Failed to create KPI template' });
  }
};

/**
 * @desc Update existing KPI template
 * @route PUT /api/performance/kpi-templates/:id
 */
const updateKpiTemplate = async (req, res) => {
  try {
    if (!canManageKpis(req.user)) {
      return res.status(403).json({ success: false, message: 'Forbidden: Insufficient permissions to update KPI templates' });
    }

    const { id } = req.params;
    const template = await PmsKpiTemplate.findOne({ _id: id, companyId: req.companyId });
    if (!template) {
      return res.status(404).json({ success: false, message: 'KPI template not found' });
    }

    const updatable = [
      'name',
      'code',
      'description',
      'department',
      'departmentName',
      'designation',
      'designationName',
      'kraId',
      'measurementType',
      'unit',
      'targetValue',
      'weightage',
      'ratingMethod',
      'measurementDirection',
      'ratingScale',
      'effectiveStartDate',
      'effectiveEndDate',
      'status',
    ];

    updatable.forEach((f) => {
      if (req.body[f] !== undefined) {
        template[f] = req.body[f];
      }
    });

    if (req.body.department && mongoose.Types.ObjectId.isValid(req.body.department)) {
      const deptDoc = await Department.findById(req.body.department).select('name').lean();
      if (deptDoc?.name) template.departmentName = deptDoc.name;
    }

    if (req.body.designation && mongoose.Types.ObjectId.isValid(req.body.designation)) {
      const desigDoc = await Designation.findById(req.body.designation).select('title').lean();
      if (desigDoc?.title) template.designationName = desigDoc.title;
    }

    template.updatedBy = req.user._id;
    await template.save();

    await logPmsAudit({
      companyId: req.companyId,
      userId: req.user._id,
      action: 'KPI_TEMPLATE_UPDATED',
      entityType: 'PmsKpiTemplate',
      entityId: template._id,
      entityName: template.name,
      changes: req.body,
    });

    return res.status(200).json({ success: true, message: 'KPI template updated successfully', data: template });
  } catch (err) {
    console.error('[PMS updateKpiTemplate Error]:', err);
    return res.status(500).json({ success: false, message: 'Failed to update KPI template' });
  }
};

/**
 * @desc Change template status (active / inactive / draft)
 * @route PATCH /api/performance/kpi-templates/:id/status
 */
const changeKpiTemplateStatus = async (req, res) => {
  try {
    if (!canManageKpis(req.user)) {
      return res.status(403).json({ success: false, message: 'Forbidden: Insufficient permissions to change KPI status' });
    }

    const { id } = req.params;
    const { status } = req.body;

    if (!['active', 'inactive', 'draft'].includes(status)) {
      return res.status(400).json({ success: false, message: 'Invalid status. Must be active, inactive, or draft' });
    }

    const template = await PmsKpiTemplate.findOne({ _id: id, companyId: req.companyId });
    if (!template) {
      return res.status(404).json({ success: false, message: 'KPI template not found' });
    }

    template.status = status;
    template.updatedBy = req.user._id;
    await template.save();

    return res.status(200).json({ success: true, message: `KPI template is now ${status}`, data: template });
  } catch (err) {
    console.error('[PMS changeKpiTemplateStatus Error]:', err);
    return res.status(500).json({ success: false, message: 'Failed to change template status' });
  }
};

/**
 * @desc Delete KPI template
 * @route DELETE /api/performance/kpi-templates/:id
 */
const deleteKpiTemplate = async (req, res) => {
  try {
    if (!canManageKpis(req.user)) {
      return res.status(403).json({ success: false, message: 'Forbidden: Insufficient permissions to delete KPI templates' });
    }

    const { id } = req.params;
    const template = await PmsKpiTemplate.findOneAndDelete({ _id: id, companyId: req.companyId });
    if (!template) {
      return res.status(404).json({ success: false, message: 'KPI template not found' });
    }

    await logPmsAudit({
      companyId: req.companyId,
      userId: req.user._id,
      action: 'KPI_TEMPLATE_DELETED',
      entityType: 'PmsKpiTemplate',
      entityId: template._id,
      entityName: template.name,
    });

    return res.status(200).json({ success: true, message: 'KPI template deleted successfully' });
  } catch (err) {
    console.error('[PMS deleteKpiTemplate Error]:', err);
    return res.status(500).json({ success: false, message: 'Failed to delete KPI template' });
  }
};

// ─── 2. KRA-KPI INTEGRATION & WEIGHTAGE VALIDATION ────────────────────────────

/**
 * @desc Get all KPIs linked to a specific KRA with weightage summary
 * @route GET /api/performance/kras/:id/kpis
 */
const getKpisByKra = async (req, res) => {
  try {
    const { id } = req.params;
    const kra = await PmsKra.findOne({ _id: id, companyId: req.companyId }).lean();
    if (!kra) {
      return res.status(404).json({ success: false, message: 'KRA not found' });
    }

    // Fetch both templates and active assigned KPIs under this KRA
    const [templates, assignedKpis] = await Promise.all([
      PmsKpiTemplate.find({ kraId: id, companyId: req.companyId })
        .populate('department', 'name')
        .populate('designation', 'title')
        .sort({ createdAt: -1 })
        .lean(),
      PmsKpi.find({ kraId: id, companyId: req.companyId })
        .select('name targetValue actualValue achievementPercentage status weightage employeeId')
        .lean(),
    ]);

    const activeTemplates = templates.filter((t) => t.status === 'active');
    const totalWeightage = activeTemplates.reduce((sum, t) => sum + (Number(t.weightage) || 0), 0);
    const remainingWeightage = Math.max(0, 100 - totalWeightage);

    return res.status(200).json({
      success: true,
      data: {
        kra: {
          _id: kra._id,
          name: kra.name,
          category: kra.category,
          weightage: kra.weightage,
        },
        templates,
        assignedCount: assignedKpis.length,
        weightageSummary: {
          totalWeightage,
          remainingWeightage,
          isFull: totalWeightage === 100,
          isOverAllocated: totalWeightage > 100,
        },
      },
    });
  } catch (err) {
    console.error('[PMS getKpisByKra Error]:', err);
    return res.status(500).json({ success: false, message: 'Failed to fetch KPIs for KRA' });
  }
};

// ─── 3. EMPLOYEE KPI ASSIGNMENT WORKFLOW ──────────────────────────────────────

/**
 * @desc Bulk or individual assignment of KPI templates to employees
 * @route POST /api/performance/kpis/assign
 */
const assignKpisToEmployees = async (req, res) => {
  try {
    const {
      cycleId,
      departmentId,
      designationId,
      employeeIds,
      kpiTemplates,
      templateIds: rawTemplateIds,
      customTargets = {},
      customWeightages = {},
    } = req.body;

    if (!Array.isArray(employeeIds) || employeeIds.length === 0) {
      return res.status(400).json({ success: false, message: 'At least one employee must be selected' });
    }

    // Normalize both contract formats:
    // Format 1: kpiTemplates: [ { templateId, targetValue, weightage } | string ]
    // Format 2: templateIds: [ string ], customTargets: { [id]: val }, customWeightages: { [id]: val }
    let normalizedTemplates = [];
    if (Array.isArray(kpiTemplates) && kpiTemplates.length > 0) {
      normalizedTemplates = kpiTemplates.map((t) => {
        if (typeof t === 'string') return { templateId: t };
        return t;
      });
    } else if (Array.isArray(rawTemplateIds) && rawTemplateIds.length > 0) {
      normalizedTemplates = rawTemplateIds.map((tId) => ({
        templateId: tId,
        targetValue: customTargets[tId],
        weightage: customWeightages[tId],
      }));
    }

    if (normalizedTemplates.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'At least one KPI template must be selected (provide kpiTemplates array or templateIds)',
      });
    }

    // Determine cycle
    let targetCycleId = cycleId;
    if (!targetCycleId) {
      const activeCycle = await PmsCycle.findOne({
        companyId: req.companyId,
        status: { $in: ['in_progress', 'scheduled', 'draft'] },
      }).sort({ createdAt: -1 });
      targetCycleId = activeCycle?._id;
    }

    const templateIds = normalizedTemplates.map((t) => (typeof t === 'string' ? t : t.templateId));
    const templates = await PmsKpiTemplate.find({
      _id: { $in: templateIds },
      companyId: req.companyId,
    }).lean();

    if (templates.length === 0) {
      return res.status(404).json({ success: false, message: 'None of the selected KPI templates were found' });
    }

    const templateMap = new Map(templates.map((t) => [String(t._id), t]));
    const customConfigMap = new Map();

    for (const t of normalizedTemplates) {
      const tId = String(t.templateId || t);
      const tmpl = templateMap.get(tId);
      if (!tmpl) continue;

      let customTarget = t.targetValue !== undefined && t.targetValue !== null && t.targetValue !== '' ? t.targetValue : undefined;
      let customWeight = t.weightage !== undefined && t.weightage !== null && t.weightage !== '' ? t.weightage : undefined;

      // Validate weightage if provided (0 <= weight <= 100)
      if (customWeight !== undefined) {
        const numWeight = Number(customWeight);
        if (isNaN(numWeight) || numWeight < 0 || numWeight > 100) {
          return res.status(400).json({
            success: false,
            message: `Invalid weightage for KPI "${tmpl.name}": must be a number between 0 and 100`,
          });
        }
        customWeight = numWeight;
      }

      // Validate custom target if provided
      if (customTarget !== undefined) {
        if (tmpl.measurementType === 'yes_no') {
          // Normalize boolean targets to 1 or 0 for storage in numeric targetValue field
          if (typeof customTarget === 'boolean') {
            customTarget = customTarget ? 1 : 0;
          } else if (typeof customTarget === 'string') {
            const lower = customTarget.trim().toLowerCase();
            customTarget = (lower === 'yes' || lower === 'true' || lower === '1') ? 1 : 0;
          } else {
            customTarget = Number(customTarget) ? 1 : 0;
          }
        } else {
          const numTarget = Number(customTarget);
          if (isNaN(numTarget)) {
            return res.status(400).json({
              success: false,
              message: `Invalid target value for KPI "${tmpl.name}": must be a valid number`,
            });
          }
          if (numTarget < 0) {
            return res.status(400).json({
              success: false,
              message: `Invalid target value for KPI "${tmpl.name}": cannot be negative`,
            });
          }
          if (tmpl.measurementDirection === 'higher_is_better' && numTarget === 0) {
            return res.status(400).json({
              success: false,
              message: `Invalid target value for KPI "${tmpl.name}": higher_is_better KPIs require a positive target value`,
            });
          }
          customTarget = numTarget;
        }
      }

      customConfigMap.set(tId, {
        targetValue: customTarget,
        weightage: customWeight,
      });
    }

    const isHrOrAdmin = isUserAdminOrSuper(req.user) || isUserHr(req.user);

    // Filter valid active employees
    const targetEmployees = await User.find({
      _id: { $in: employeeIds },
      companyId: req.companyId,
      isActive: true,
      isDeleted: { $ne: true },
    })
      .select('_id firstName lastName email department departmentRef designation designationRef reportingManagers')
      .lean();

    let createdCount = 0;
    let skippedCount = 0;

    for (const emp of targetEmployees) {
      // Permission check if manager is assigning
      if (!isHrOrAdmin) {
        const isManager = (emp.reportingManagers || []).some((m) => String(m) === String(req.user._id));
        if (!isManager) {
          skippedCount++;
          continue;
        }
      }

      for (const tId of templateIds) {
        const tmpl = templateMap.get(String(tId));
        if (!tmpl) continue;

        const custom = customConfigMap.get(String(tId)) || {};
        const targetVal = custom.targetValue !== undefined ? custom.targetValue : tmpl.targetValue;
        const weightVal = custom.weightage !== undefined ? custom.weightage : tmpl.weightage;

        // Upsert assignment record for this employee and cycle
        const existing = await PmsKpi.findOne({
          companyId: req.companyId,
          templateId: tmpl._id,
          employeeId: emp._id,
          cycleId: targetCycleId || null,
        });

        if (existing) {
          // Update targets if assignment already exists
          existing.targetValue = targetVal;
          existing.weightage = weightVal;
          existing.updatedBy = req.user._id;
          await existing.save();
        } else {
          await PmsKpi.create({
            companyId: req.companyId,
            templateId: tmpl._id,
            kraId: tmpl.kraId,
            cycleId: targetCycleId || null,
            employeeId: emp._id,
            name: tmpl.name,
            code: tmpl.code,
            description: tmpl.description,
            department: tmpl.department || emp.departmentRef || null,
            departmentName: tmpl.departmentName || (typeof emp.department === 'string' ? emp.department : ''),
            designation: tmpl.designation || emp.designationRef || null,
            designationName: tmpl.designationName || (typeof emp.designation === 'string' ? emp.designation : ''),
            scope: 'individual',
            measurementType: tmpl.measurementType || 'percentage',
            measurementUnit: tmpl.measurementType || 'percentage',
            unit: tmpl.unit || '%',
            measurementDirection: tmpl.measurementDirection || 'higher_is_better',
            ratingMethod: tmpl.ratingMethod || 'automatic',
            ratingScale: tmpl.ratingScale || '1-5',
            targetValue: targetVal,
            actualValue: 0,
            weightage: weightVal,
            status: 'assigned',
            assignedBy: req.user._id,
            assignedAt: new Date(),
            createdBy: req.user._id,
          });
          createdCount++;
        }
      }

      // Send notification to employee
      sendPmsNotification(req, {
        userId: emp._id,
        title: 'New KPIs Assigned',
        message: `${templateIds.length} Key Performance Indicator(s) have been assigned for your review cycle.`,
        link: '/ess/performance',
        preferenceKey: 'pms_kpi_assigned',
      });
    }

    await logPmsAudit({
      companyId: req.companyId,
      userId: req.user._id,
      action: 'KPIS_ASSIGNED_TO_EMPLOYEES',
      entityType: 'PmsKpi',
      changes: {
        employeeCount: targetEmployees.length,
        kpiCount: templateIds.length,
        createdCount,
      },
    });

    return res.status(200).json({
      success: true,
      message: `Successfully assigned ${templateIds.length} KPI(s) to ${targetEmployees.length} employee(s).`,
      data: { createdCount, skippedCount, totalEmployees: targetEmployees.length },
    });
  } catch (err) {
    console.error('[PMS assignKpisToEmployees Error]:', err);
    return res.status(500).json({ success: false, message: 'Failed to assign KPIs' });
  }
};

/**
 * @desc List assigned employee KPIs with filtering and search
 * @route GET /api/performance/kpis/assignments
 */
const listAssignedKpis = async (req, res) => {
  try {
    const companyId = req.companyId;
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 20));
    const skip = (page - 1) * limit;

    const filter = { companyId };
    const isHrOrAdmin = isUserAdminOrSuper(req.user) || isUserHr(req.user);

    // Scope check
    if (!isHrOrAdmin) {
      if (req.query.scope === 'my_team') {
        const directReports = await User.find({
          reportingManagers: req.user._id,
          companyId,
          isActive: true,
          isDeleted: { $ne: true },
        }).select('_id').lean();
        filter.employeeId = { $in: directReports.map((d) => d._id) };
      } else {
        filter.employeeId = req.user._id;
      }
    } else if (req.query.employeeId) {
      filter.employeeId = req.query.employeeId;
    }

    if (req.query.cycleId) filter.cycleId = req.query.cycleId;
    if (req.query.kraId) filter.kraId = req.query.kraId;
    if (req.query.status && req.query.status !== 'all') filter.status = req.query.status;
    if (req.query.department) {
      filter.$or = [
        { departmentName: { $regex: req.query.department.trim(), $options: 'i' } },
      ];
    }
    if (req.query.search) {
      const q = req.query.search.trim();
      filter.$or = [
        { name: { $regex: q, $options: 'i' } },
        { code: { $regex: q, $options: 'i' } },
      ];
    }

    const [assignments, total] = await Promise.all([
      PmsKpi.find(filter)
        .populate('kraId', 'name category weightage')
        .populate('templateId', 'name unit measurementType ratingMethod')
        .populate({
          path: 'employeeId',
          match: { isActive: true, isDeleted: { $ne: true } },
          select: 'firstName lastName email profilePicture department departmentRef designation designationRef employeeId',
        })
        .populate('assignedBy', 'firstName lastName')
        .populate('verifiedBy', 'firstName lastName')
        .sort({ updatedAt: -1, createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      PmsKpi.countDocuments(filter),
    ]);

    const cleanAssignments = assignments.filter((a) => a.employeeId != null);

    return res.status(200).json({
      success: true,
      data: cleanAssignments,
      pagination: {
        page,
        limit,
        total: cleanAssignments.length,
        pages: Math.ceil(total / limit),
      },
    });
  } catch (err) {
    console.error('[PMS listAssignedKpis Error]:', err);
    return res.status(500).json({ success: false, message: 'Failed to fetch assigned KPIs' });
  }
};

/**
 * @desc Evaluate or self-assess an assigned KPI (actual value, ratings, calculations)
 * @route PUT /api/performance/kpis/assignments/:id/evaluation
 */
const evaluateAssignedKpi = async (req, res) => {
  try {
    const { id } = req.params;
    const {
      actualValue,
      employeeRating,
      employeeComments,
      managerRating,
      managerComments,
      status,
      evidenceFileUrl,
      evidenceFileName,
      evidenceComment,
    } = req.body;

    const kpi = await PmsKpi.findOne({ _id: id, companyId: req.companyId });
    if (!kpi) {
      return res.status(404).json({ success: false, message: 'Assigned KPI record not found' });
    }

    const isOwner = String(kpi.employeeId) === String(req.user._id);
    const isHrOrAdmin = isUserAdminOrSuper(req.user) || isUserHr(req.user);

    let isManager = false;
    if (!isHrOrAdmin && !isOwner) {
      const emp = await User.findById(kpi.employeeId).select('reportingManagers').lean();
      isManager = (emp?.reportingManagers || []).some((m) => String(m) === String(req.user._id));
      if (!isManager) {
        return res.status(403).json({ success: false, message: 'Unauthorized to evaluate this KPI record.' });
      }
    }

    // 1. Update actual values if provided
    if (actualValue !== undefined) {
      kpi.actualValue = Number(actualValue);
    }

    // 2. Compute Achievement % using scoring service (handles higher-is-better and lower-is-better inverse calculations)
    const calc = calculateKpiAchievement({
      targetValue: kpi.targetValue,
      actualValue: kpi.actualValue,
      measurementDirection: kpi.measurementDirection || 'higher_is_better',
      acceptableRangeMin: kpi.acceptableRangeMin,
      acceptableRangeMax: kpi.acceptableRangeMax,
    });

    kpi.achievementPercentage = calc.achievementPercent;
    kpi.calculatedScore = calc.calculatedScore;
    kpi.weightedScore = Math.round((calc.calculatedScore * (kpi.weightage / 100)) * 100) / 100;

    // 3. Employee Self-Assessment Fields
    if (isOwner) {
      if (employeeRating !== undefined) kpi.employeeRating = Number(employeeRating);
      if (employeeComments !== undefined) kpi.employeeComments = employeeComments;
      if (status) kpi.status = status;
      else if (kpi.status === 'assigned') kpi.status = 'in_progress';
    }

    // 4. Manager / Reviewer Evaluation Fields
    if (isManager || isHrOrAdmin) {
      if (managerRating !== undefined) {
        kpi.managerRating = Number(managerRating);
      } else if (kpi.ratingMethod === 'automatic') {
        // Auto-rating based on calculated score
        kpi.managerRating = calc.calculatedScore;
      }

      if (managerComments !== undefined) kpi.managerComments = managerComments;
      if (status) kpi.status = status;
      kpi.verifiedBy = req.user._id;
      kpi.verifiedAt = new Date();
    }

    // 5. Evidence submission
    if (evidenceFileUrl) {
      kpi.evidence.push({
        fileUrl: evidenceFileUrl,
        fileName: evidenceFileName || 'Proof Document',
        comment: evidenceComment || '',
        submittedAt: new Date(),
        submittedBy: req.user._id,
      });
    }

    // 6. Record history
    kpi.history.push({
      action: isOwner ? 'EMPLOYEE_UPDATED_ACTUALS' : 'MANAGER_EVALUATED_KPI',
      actor: req.user._id,
      date: new Date(),
      details: {
        actualValue: kpi.actualValue,
        achievementPercentage: kpi.achievementPercentage,
        managerRating: kpi.managerRating,
        status: kpi.status,
      },
    });

    kpi.updatedBy = req.user._id;
    await kpi.save();

    return res.status(200).json({
      success: true,
      message: 'KPI assessment saved successfully',
      data: kpi,
    });
  } catch (err) {
    console.error('[PMS evaluateAssignedKpi Error]:', err);
    return res.status(500).json({ success: false, message: 'Failed to evaluate KPI' });
  }
};

// ─── 4. METADATA HELPER FOR KPI MANAGEMENT ───────────────────────────────────

/**
 * @desc Get PMS metadata (departments, designations, KRAs, active cycles, active employees)
 * @route GET /api/performance/meta/options
 */
const getPmsMetadata = async (req, res) => {
  try {
    const companyId = req.companyId;

    const [departments, designations, kras, cycles, employees] = await Promise.all([
      Department.find({ companyId, isDeleted: { $ne: true } })
        .select('_id name code')
        .sort({ name: 1 })
        .lean(),
      Designation.find({ companyId, isDeleted: { $ne: true } })
        .populate('department', 'name')
        .select('_id title department level')
        .sort({ title: 1 })
        .lean(),
      PmsKra.find({ companyId, status: { $ne: 'inactive' } })
        .select('_id name code category weightage applicableDepartments assignmentType')
        .sort({ name: 1 })
        .lean(),
      PmsCycle.find({ companyId })
        .select('_id name status startDate endDate cycleType')
        .sort({ createdAt: -1 })
        .lean(),
      User.find({
        companyId,
        isActive: true,
        isDeleted: { $ne: true },
        status: { $nin: ['deleted', 'inactive', 'terminated', 'Inactive', 'Terminated'] },
      })
        .populate('departmentRef', 'name')
        .populate('designationRef', 'title')
        .select('_id firstName lastName email employeeId department departmentRef designation designationRef profilePicture')
        .sort({ firstName: 1 })
        .lean(),
    ]);

    return res.status(200).json({
      success: true,
      data: {
        departments: departments || [],
        designations: designations || [],
        kras: kras || [],
        cycles: cycles || [],
        employees: employees || [],
        users: employees || [],
      },
    });
  } catch (err) {
    console.error('[PMS getPmsMetadata Error]:', err);
    return res.status(500).json({ success: false, message: 'Failed to load PMS metadata' });
  }
};

module.exports = {
  listKpiTemplates,
  getKpiTemplateById,
  createKpiTemplate,
  updateKpiTemplate,
  changeKpiTemplateStatus,
  deleteKpiTemplate,
  getKpisByKra,
  assignKpisToEmployees,
  listAssignedKpis,
  evaluateAssignedKpi,
  getPmsMetadata,
};
