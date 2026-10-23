const mongoose = require('mongoose');
const PmsCycle = require('../models/pmsCycle.model');
const PmsAppraisal = require('../models/pmsAppraisal.model');
const User = require('../../user/user.model');
const Company = require('../../company/company.model');
const Department = require('../../organization/models/department.model');
const { sendPmsNotification } = require('./pmsNotification.service');
const { logPmsAudit } = require('./pmsAudit.service');

const REMINDER_COOLDOWN_MS = 24 * 60 * 60 * 1000; // 24-hour deduplication window

/**
 * Checks if a specific reminder type was sent to a user within the cooldown period
 */
const wasReminderRecentlySent = (appraisal, reminderType, userId) => {
  if (!Array.isArray(appraisal.remindersSent) || appraisal.remindersSent.length === 0) {
    return false;
  }
  const cutoff = new Date(Date.now() - REMINDER_COOLDOWN_MS);
  return appraisal.remindersSent.some((r) => {
    return (
      r.reminderType === reminderType &&
      String(r.sentTo) === String(userId) &&
      new Date(r.sentAt) > cutoff
    );
  });
};

/**
 * Executes automated reminder workflow for pending appraisals and unacknowledged published records
 * @param {Object} options { companyId, io, dryRun }
 */
const runPmsRemindersJob = async (options = {}) => {
  const results = {
    processedCycles: 0,
    dispatchedReminders: 0,
    skippedDeduplicated: 0,
    errors: [],
  };

  try {
    const companyQuery = { isActive: { $ne: false }, isDeleted: { $ne: true } };
    if (options.companyId) companyQuery._id = options.companyId;

    const companies = await Company.find(companyQuery).select('_id name').lean();

    for (const company of companies) {
      const companyId = company._id;

      // Find active / in-progress appraisal cycles
      const activeCycles = await PmsCycle.find({
        companyId,
        status: { $in: ['in_progress', 'self_review', 'manager_review', 'goal_setting', 'peer_feedback', 'calibration', 'published'] },
      }).lean();

      results.processedCycles += activeCycles.length;

      for (const cycle of activeCycles) {
        const appraisals = await PmsAppraisal.find({
          companyId,
          cycleId: cycle._id,
        }).populate({
          path: 'employeeId',
          select: 'firstName lastName email department designation',
        });

        for (const appraisal of appraisals) {
          if (!appraisal.employeeId) continue;

          const employeeName = `${appraisal.employeeId.firstName || ''} ${appraisal.employeeId.lastName || ''}`.trim() || 'Employee';

          // 1. Employee Self-Appraisal Pending Reminder
          if (appraisal.status === 'self_review_pending') {
            const recipientId = appraisal.employeeId._id;
            if (wasReminderRecentlySent(appraisal, 'self_review', recipientId)) {
              results.skippedDeduplicated++;
            } else {
              if (!options.dryRun) {
                await sendPmsNotification({ companyId }, {
                  userId: recipientId,
                  title: 'Reminder: Complete Your Self-Appraisal',
                  message: `Cycle "${cycle.name}" is underway. Please complete and submit your self-appraisal score and KPI actuals.`,
                  link: `/performance?tab=reviews&appraisalId=${appraisal._id}`,
                  preferenceKey: 'pms_self_review_reminder',
                });

                appraisal.remindersSent.push({
                  reminderType: 'self_review',
                  sentTo: recipientId,
                  sentAt: new Date(),
                  stageKey: 'self_review',
                });
                await appraisal.save();
              }
              results.dispatchedReminders++;
            }
          }

          // 2. Manager Review Pending Reminder
          else if (appraisal.status === 'manager_review_pending') {
            const recipientId = appraisal.managerId;
            if (recipientId) {
              if (wasReminderRecentlySent(appraisal, 'manager_review', recipientId)) {
                results.skippedDeduplicated++;
              } else {
                if (!options.dryRun) {
                  await sendPmsNotification({ companyId }, {
                    userId: recipientId,
                    title: 'Reminder: Pending Team Member Review',
                    message: `Performance evaluation for ${employeeName} in cycle "${cycle.name}" is waiting for your manager review.`,
                    link: `/performance?tab=reviews&appraisalId=${appraisal._id}`,
                    preferenceKey: 'pms_manager_review_reminder',
                  });

                  appraisal.remindersSent.push({
                    reminderType: 'manager_review',
                    sentTo: recipientId,
                    sentAt: new Date(),
                    stageKey: 'manager_review',
                  });
                  await appraisal.save();
                }
                results.dispatchedReminders++;
              }
            }
          }

          // 3. Department Head Review Pending Reminder
          else if (appraisal.status === 'department_head_review_pending' || appraisal.status === 'dept_head_review_pending') {
            let deptHeadUser = null;
            if (appraisal.employeeId.department) {
              const dept = await Department.findOne({ companyId, name: appraisal.employeeId.department }).lean();
              if (dept?.departmentHead) {
                deptHeadUser = dept.departmentHead;
              }
            }

            if (deptHeadUser) {
              if (wasReminderRecentlySent(appraisal, 'department_head_review', deptHeadUser)) {
                results.skippedDeduplicated++;
              } else {
                if (!options.dryRun) {
                  await sendPmsNotification({ companyId }, {
                    userId: deptHeadUser,
                    title: 'Reminder: Department Head Review Pending',
                    message: `Appraisal for ${employeeName} has completed manager review and is pending department leadership endorsement.`,
                    link: `/performance?tab=reviews&appraisalId=${appraisal._id}`,
                    preferenceKey: 'pms_dept_head_reminder',
                  });

                  appraisal.remindersSent.push({
                    reminderType: 'department_head_review',
                    sentTo: deptHeadUser,
                    sentAt: new Date(),
                    stageKey: 'department_head_review',
                  });
                  await appraisal.save();
                }
                results.dispatchedReminders++;
              }
            }
          }

          // 4. HR Evaluation Pending Reminder
          else if (appraisal.status === 'hr_evaluation_pending') {
            const hrUsers = await User.find({
              companyId,
              isActive: true,
              isDeleted: { $ne: true },
              $or: [
                { roles: { $in: await getHrRoleIds(companyId) } },
                { permissions: 'pms.view.all' },
              ],
            }).select('_id').limit(5).lean();

            for (const hr of hrUsers) {
              if (wasReminderRecentlySent(appraisal, 'hr_evaluation', hr._id)) {
                results.skippedDeduplicated++;
              } else {
                if (!options.dryRun) {
                  await sendPmsNotification({ companyId }, {
                    userId: hr._id,
                    title: 'Reminder: Appraisal Pending HR Evaluation',
                    message: `Appraisal for ${employeeName} is awaiting HR evaluation and calibration in cycle "${cycle.name}".`,
                    link: `/performance?tab=reviews&appraisalId=${appraisal._id}`,
                    preferenceKey: 'pms_hr_eval_reminder',
                  });

                  appraisal.remindersSent.push({
                    reminderType: 'hr_evaluation',
                    sentTo: hr._id,
                    sentAt: new Date(),
                    stageKey: 'hr_evaluation',
                  });
                  await appraisal.save();
                }
                results.dispatchedReminders++;
                break; // One HR alert per appraisal to avoid spamming all HR staff
              }
            }
          }

          // 5. Final Approval Pending Reminder
          else if (appraisal.status === 'final_approval_pending') {
            const approvers = await User.find({
              companyId,
              isActive: true,
              isDeleted: { $ne: true },
              $or: [
                { roles: { $in: await getAdminRoleIds(companyId) } },
                { permissions: 'pms.approval.final' },
              ],
            }).select('_id').limit(3).lean();

            for (const approver of approvers) {
              if (wasReminderRecentlySent(appraisal, 'final_approval', approver._id)) {
                results.skippedDeduplicated++;
              } else {
                if (!options.dryRun) {
                  await sendPmsNotification({ companyId }, {
                    userId: approver._id,
                    title: 'Reminder: Final Appraisal Approval Pending',
                    message: `Appraisal for ${employeeName} has completed HR evaluation and awaits final leadership sign-off.`,
                    link: `/performance?tab=reviews&appraisalId=${appraisal._id}`,
                    preferenceKey: 'pms_final_approval_reminder',
                  });

                  appraisal.remindersSent.push({
                    reminderType: 'final_approval',
                    sentTo: approver._id,
                    sentAt: new Date(),
                    stageKey: 'final_approval',
                  });
                  await appraisal.save();
                }
                results.dispatchedReminders++;
                break;
              }
            }
          }

          // 6. Published Appraisal Pending Acknowledgment Reminder
          else if (appraisal.isPublished && appraisal.status === 'published' && appraisal.acknowledgement?.isAcknowledged !== true) {
            const recipientId = appraisal.employeeId._id;
            if (wasReminderRecentlySent(appraisal, 'acknowledgement', recipientId)) {
              results.skippedDeduplicated++;
            } else {
              if (!options.dryRun) {
                await sendPmsNotification({ companyId }, {
                  userId: recipientId,
                  title: 'Action Required: Acknowledge Performance Appraisal',
                  message: `Your final performance evaluation for cycle "${cycle.name}" has been published. Please review and acknowledge.`,
                  link: `/performance?tab=reviews&appraisalId=${appraisal._id}`,
                  preferenceKey: 'pms_acknowledgement_reminder',
                });

                appraisal.remindersSent.push({
                  reminderType: 'acknowledgement',
                  sentTo: recipientId,
                  sentAt: new Date(),
                  stageKey: 'published',
                });
                await appraisal.save();
              }
              results.dispatchedReminders++;
            }
          }
        }
      }
    }
  } catch (err) {
    console.error('[PMS Reminders Job Error]:', err);
    results.errors.push(err.message);
  }

  return results;
};

// Helper: Fetch HR role IDs
const getHrRoleIds = async (companyId) => {
  const Role = require('../../user/role.model');
  const roles = await Role.find({
    companyId,
    name: { $in: ['HR', 'HR Manager', 'HR Admin'] },
    isActive: true,
  }).select('_id').lean();
  return roles.map((r) => r._id);
};

// Helper: Fetch Admin role IDs
const getAdminRoleIds = async (companyId) => {
  const Role = require('../../user/role.model');
  const roles = await Role.find({
    companyId,
    name: { $in: ['Admin', 'SuperAdmin', 'Managing Director', 'CEO'] },
    isActive: true,
  }).select('_id').lean();
  return roles.map((r) => r._id);
};

module.exports = {
  runPmsRemindersJob,
  wasReminderRecentlySent,
};
