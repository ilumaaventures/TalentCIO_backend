const CrmTask = require('../models/crmTask.model');
const CrmActivity = require('../models/crmActivity.model');

const getTenantId = (req) => req.companyId || req.user?.companyId;

const getUserDisplayName = (user) => {
  if (!user) return 'System';
  if (user.firstName) return `${user.firstName} ${user.lastName || ''}`.trim();
  return user.name || user.email || 'User';
};

// @desc Get tasks with status and priority filters
// @route GET /api/crm/tasks
const getTasks = async (req, res, next) => {
  try {
    const companyId = getTenantId(req);
    const { status, priority, assignedTo, search, page = 1, limit = 50 } = req.query;
    const query = { companyId };

    if (status && status !== 'all') query.status = status;
    if (priority && priority !== 'all') query.priority = priority;
    if (assignedTo && assignedTo !== 'all') query.assignedTo = assignedTo;

    if (search) {
      query.title = new RegExp(search, 'i');
    }

    const total = await CrmTask.countDocuments(query);
    const tasks = await CrmTask.find(query)
      .populate('assignedTo', 'firstName lastName email profilePicture')
      .populate('leadId', 'firstName lastName companyName')
      .populate('dealId', 'title value')
      .populate('accountId', 'name')
      .populate('contactId', 'firstName lastName')
      .sort({ dueDate: 1 })
      .skip((page - 1) * limit)
      .limit(Number(limit));

    res.json({
      success: true,
      data: tasks,
      pagination: {
        total,
        page: Number(page),
        limit: Number(limit),
        totalPages: Math.ceil(total / limit),
      },
    });
  } catch (error) {
    next(error);
  }
};

// @desc Create task
// @route POST /api/crm/tasks
const createTask = async (req, res, next) => {
  try {
    const companyId = getTenantId(req);
    const task = await CrmTask.create({
      ...req.body,
      companyId,
      assignedTo: req.body.assignedTo || req.user?._id,
      createdByUser: req.user?._id,
      accountId: req.body.accountId || req.body.companyId,
    });

    res.status(201).json({ success: true, message: 'Task created successfully', data: task });
  } catch (error) {
    next(error);
  }
};

// @desc Update task
// @route PUT /api/crm/tasks/:id
const updateTask = async (req, res, next) => {
  try {
    const companyId = getTenantId(req);
    const updates = { ...req.body };
    if (updates.status === 'Completed' && !updates.completedAt) {
      updates.completedAt = new Date();
    }

    const task = await CrmTask.findOneAndUpdate(
      { _id: req.params.id, companyId },
      updates,
      { new: true }
    );

    if (!task) return res.status(404).json({ success: false, message: 'Task not found' });

    if (updates.status === 'Completed') {
      await CrmActivity.create({
        companyId,
        type: 'task',
        subject: `Completed task: ${task.title}`,
        performedBy: req.user?._id,
        performedByName: getUserDisplayName(req.user),
        leadId: task.leadId,
        dealId: task.dealId,
        accountId: task.accountId,
        contactId: task.contactId,
      });
    }

    res.json({ success: true, message: 'Task updated', data: task });
  } catch (error) {
    next(error);
  }
};

// @desc Delete task
// @route DELETE /api/crm/tasks/:id
const deleteTask = async (req, res, next) => {
  try {
    const companyId = getTenantId(req);
    const task = await CrmTask.findOneAndDelete({ _id: req.params.id, companyId });
    if (!task) return res.status(404).json({ success: false, message: 'Task not found' });
    res.json({ success: true, message: 'Task deleted' });
  } catch (error) {
    next(error);
  }
};

module.exports = {
  getTasks,
  createTask,
  updateTask,
  deleteTask,
};
