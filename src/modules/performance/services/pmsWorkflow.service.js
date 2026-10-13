const mongoose = require('mongoose');
const PmsSetting = require('../models/pmsSetting.model');
const User = require('../../user/user.model');
const Department = require('../../organization/models/department.model');

const DEFAULT_WORKFLOW_STAGES = [
  {
    key: 'self_review',
    label: 'Self-Appraisal',
    assigneeType: 'employee',
    order: 1,
    isRequired: true,
    canEditRatings: false,
  },
  {
    key: 'manager_review',
    label: 'Reporting Manager Review',
    assigneeType: 'reporting_manager',
    order: 2,
    isRequired: true,
    canEditRatings: true,
  },
  {
    key: 'hr_evaluation',
    label: 'HR Evaluation & Calibration',
    assigneeType: 'hr_group',
    order: 3,
    isRequired: true,
    canEditRatings: true,
  },
  {
    key: 'final_approval',
    label: 'Final Leadership Approval',
    assigneeType: 'company_admin',
    order: 4,
    isRequired: true,
    canEditRatings: false,
  },
  {
    key: 'published',
    label: 'Rating Published',
    assigneeType: 'system',
    order: 5,
    isRequired: true,
    canEditRatings: false,
  },
];

/**
 * Fetch company's configured approval stages or default pipeline
 */
const getCompanyWorkflow = async (companyId) => {
  const setting = await PmsSetting.findOne({ companyId }).lean();
  if (setting?.approvalWorkflow?.stages && setting.approvalWorkflow.stages.length > 0) {
    const sorted = [...setting.approvalWorkflow.stages].sort((a, b) => (a.order || 0) - (b.order || 0));
    return {
      stages: sorted,
      allowRevisions: setting.approvalWorkflow.allowRevisions !== false,
      rejectionBehavior: setting.approvalWorkflow.rejectionBehavior || 'return_to_employee',
    };
  }
  return {
    stages: DEFAULT_WORKFLOW_STAGES,
    allowRevisions: true,
    rejectionBehavior: 'return_to_employee',
  };
};

/**
 * Determine the next workflow stage
 */
const getNextWorkflowStage = (currentStageKey, stages) => {
  const currentIndex = stages.findIndex((s) => s.key === currentStageKey);
  if (currentIndex === -1) {
    return stages[1] || stages[0];
  }
  for (let i = currentIndex + 1; i < stages.length; i++) {
    if (stages[i].isRequired) {
      return stages[i];
    }
  }
  return stages[stages.length - 1]; // e.g. published
};

/**
 * Helper to check if a user is an admin or super admin
 */
const isUserAdminOrSuper = (user) => {
  const roles = Array.isArray(user?.roles) ? user.roles : [];
  return (
    roles.some((r) => {
      const name = typeof r === 'string' ? r : r?.name;
      const lower = String(name || '').toLowerCase();
      return lower.includes('admin') || lower === 'system admin';
    }) ||
    user?.permissions?.includes('*') ||
    user?.permissions?.includes('admin') ||
    user?.permissions?.includes('pms.admin')
  );
};

/**
 * Helper to check if user has HR permissions
 */
const isUserHr = (user) => {
  const roles = Array.isArray(user?.roles) ? user.roles : [];
  return (
    isUserAdminOrSuper(user) ||
    roles.some((r) => {
      const name = typeof r === 'string' ? r : r?.name;
      return String(name || '').toLowerCase().includes('hr');
    }) ||
    user?.permissions?.includes('pms.hr.evaluate') ||
    user?.permissions?.includes('pms.calibration.manage')
  );
};

/**
 * Check if user is eligible to act on a specific workflow stage
 * Strictly enforces Separation of Duties and Reporting Scope
 */
const isUserAuthorizedForStage = async ({ user, appraisal, stageKey, companyId }) => {
  const employeeIdStr = String(appraisal.employeeId?._id || appraisal.employeeId);
  const userIdStr = String(user._id);

  // CRITICAL: Separation of duties — An employee can NEVER evaluate, calibrate, or approve their own appraisal
  if (employeeIdStr === userIdStr && stageKey !== 'self_review') {
    return {
      authorized: false,
      reason: 'Separation of duties: You cannot review or approve your own appraisal.',
    };
  }

  // Stage 1: Self Review
  if (stageKey === 'self_review') {
    const isOwner = employeeIdStr === userIdStr;
    const isAdmin = isUserAdminOrSuper(user);
    if (isOwner || isAdmin) {
      return { authorized: true };
    }
    return { authorized: false, reason: 'Only the assigned employee can complete self-appraisal.' };
  }

  // Stage 2: Reporting Manager Review
  if (stageKey === 'manager_review') {
    const directManagerId = String(appraisal.managerId?._id || appraisal.managerId);
    if (directManagerId === userIdStr) {
      return { authorized: true };
    }

    // Check review delegation
    if (appraisal.delegation?.isDelegated && String(appraisal.delegation.delegatedTo) === userIdStr) {
      if (!appraisal.delegation.validUntil || new Date(appraisal.delegation.validUntil) >= new Date()) {
        return { authorized: true, note: 'Authorized via active review delegation' };
      }
      return { authorized: false, reason: 'Review delegation has expired.' };
    }

    // Check if employee has this user in their reportingManagers list
    if (mongoose.Types.ObjectId.isValid(employeeIdStr)) {
      const empUser = await User.findById(employeeIdStr).select('reportingManagers').lean();
      const isReportingManager = (empUser?.reportingManagers || []).some((m) => String(m) === userIdStr);
      if (isReportingManager) {
        return { authorized: true };
      }
    }

    if (isUserHr(user)) {
      return { authorized: true, note: 'HR/Admin override' };
    }

    return { authorized: false, reason: 'Only the assigned reporting manager or authorized HR can complete manager review.' };
  }

  // Stage 3: Department Head Review
  if (stageKey === 'department_head_review') {
    if (mongoose.Types.ObjectId.isValid(employeeIdStr)) {
      const empUser = await User.findById(employeeIdStr).select('departmentRef department').lean();
      if (empUser?.departmentRef && mongoose.Types.ObjectId.isValid(empUser.departmentRef)) {
        const dept = await Department.findById(empUser.departmentRef).select('head').lean();
        if (dept?.head && String(dept.head) === userIdStr) {
          return { authorized: true };
        }
      }
    }

    if (user?.permissions?.includes('pms.department_head.review') || isUserHr(user)) {
      return { authorized: true };
    }

    return { authorized: false, reason: 'Only the designated department head or authorized administrator can complete department review.' };
  }

  // Stage 4: HR Evaluation & Calibration
  if (stageKey === 'hr_evaluation') {
    if (isUserHr(user)) {
      return { authorized: true };
    }
    return { authorized: false, reason: 'HR evaluation requires HR evaluation or PMS administrator permissions.' };
  }

  // Stage 5: Final Leadership Approval
  if (stageKey === 'final_approval') {
    if (user?.permissions?.includes('pms.approval.final') || isUserAdminOrSuper(user)) {
      return { authorized: true };
    }
    return { authorized: false, reason: 'Final approval requires final approval or Company Admin permissions.' };
  }

  // Stage 6: Published
  if (stageKey === 'published') {
    if (user?.permissions?.includes('pms.ratings.publish') || isUserAdminOrSuper(user)) {
      return { authorized: true };
    }
    return { authorized: false, reason: 'Publishing ratings requires PMS publishing or Company Admin permissions.' };
  }

  return { authorized: false, reason: 'Unrecognized workflow stage.' };
};

/**
 * Filter confidential ratings and comments on backend before sending JSON to client
 */
const sanitizeAppraisalForUser = ({ appraisal, user, minResponsesForDisclosure = 3 }) => {
  if (!appraisal) return null;
  const isDoc = typeof appraisal.toObject === 'function';
  const data = isDoc ? appraisal.toObject() : JSON.parse(JSON.stringify(appraisal));

  const employeeIdStr = String(data.employeeId?._id || data.employeeId);
  const userIdStr = String(user._id);
  const isOwner = employeeIdStr === userIdStr;
  const isHrOrAdmin = isUserHr(user);

  // If the requester is the employee and review is not published yet:
  // Scrub unapproved/in-progress manager comments, calibration, and final score
  if (isOwner && !isHrOrAdmin && !data.isPublished) {
    if (data.managerAppraisal) {
      data.managerAppraisal.overallComments = '(Visible after final approval & publication)';
      data.managerAppraisal.strengths = '(Visible after publication)';
      data.managerAppraisal.areasOfImprovement = '(Visible after publication)';
      // Hide manager individual score ratings until published
      if (Array.isArray(data.managerAppraisal.kraRatings)) {
        data.managerAppraisal.kraRatings = data.managerAppraisal.kraRatings.map((k) => ({
          ...k,
          managerRating: null,
          managerComments: null,
        }));
      }
      if (Array.isArray(data.managerAppraisal.kpiRatings)) {
        data.managerAppraisal.kpiRatings = data.managerAppraisal.kpiRatings.map((k) => ({
          ...k,
          managerRating: null,
          managerComments: null,
        }));
      }
      if (Array.isArray(data.managerAppraisal.goalRatings)) {
        data.managerAppraisal.goalRatings = data.managerAppraisal.goalRatings.map((g) => ({
          ...g,
          managerRating: null,
          managerComments: null,
        }));
      }
      if (Array.isArray(data.managerAppraisal.competencyRatings)) {
        data.managerAppraisal.competencyRatings = data.managerAppraisal.competencyRatings.map((c) => ({
          ...c,
          managerRating: null,
          managerComments: null,
        }));
      }
    }

    if (data.departmentHeadEvaluation) {
      data.departmentHeadEvaluation = { status: 'Pending publication' };
    }
    if (data.hrEvaluation) {
      data.hrEvaluation = { status: 'Pending publication' };
    }
    if (data.calibration) {
      data.calibration = null;
    }
    if (data.scores) {
      data.scores = {
        ...data.scores,
        managerOverallScore: null,
        calculatedFinalScore: null,
        normalizedScore: null,
        ratingBand: '(Pending publication)',
      };
    }
  }

  // Anonymize peer reviews
  const submittedPeersCount = (data.peerReviews || []).filter((p) => p.status === 'submitted').length;
  const hidePeerIdentities = !isHrOrAdmin && (isOwner || submittedPeersCount < minResponsesForDisclosure);

  if (hidePeerIdentities && Array.isArray(data.peerReviews)) {
    data.peerReviews = data.peerReviews.map((pr) => {
      if (pr.isAnonymous || isOwner || submittedPeersCount < minResponsesForDisclosure) {
        return {
          ...pr,
          reviewerId: null,
        };
      }
      return pr;
    });
  }

  return data;
};

module.exports = {
  DEFAULT_WORKFLOW_STAGES,
  getCompanyWorkflow,
  getNextWorkflowStage,
  isUserAdminOrSuper,
  isUserHr,
  isUserAuthorizedForStage,
  sanitizeAppraisalForUser,
};
