module.exports = [
    // USER MANAGEMENT
    {
        key: "user.create",
        module: "USER",
        description: "Create new users"
    },
    {
        key: "user.read",
        module: "USER",
        description: "View user details"
    },
    {
        key: "user.update",
        module: "USER",
        description: "Update user details"
    },
    {
        key: "user.delete",
        module: "USER",
        description: "Deactivate or delete users"
    },
    {
        key: "user.impersonate",
        module: "USER",
        description: "Switch into another user's account within this workspace (impersonation)"
    },

    // ROLE MANAGEMENT
    {
        key: "role.create",
        module: "ROLE",
        description: "Create new roles"
    },
    {
        key: "role.read",
        module: "ROLE",
        description: "View roles and permissions"
    },
    {
        key: "role.update",
        module: "ROLE",
        description: "Update roles and permissions"
    },

    // TIMESHEET
    {
        key: "timesheet.submit",
        module: "TIMESHEET",
        description: "Submit own timesheets"
    },
    {
        key: "timesheet.approve",
        module: "TIMESHEET",
        description: "Approve submitted timesheets"
    },
    {
        key: "timesheet.export",
        module: "TIMESHEET",
        description: "Export timesheet reports"
    },
    {
        key: "timesheet.view",
        module: "TIMESHEET",
        description: "View timesheet and attendance of all users"
    },
    {
        key: "timesheet.update_others",
        module: "TIMESHEET",
        description: "Update timesheet entries for other users"
    },

    // ATTENDANCE
    {
        key: "attendance.clock_in",
        module: "ATTENDANCE",
        description: "Clock in and out"
    },
    {
        key: "attendance.view",
        module: "ATTENDANCE",
        description: "View entire Attendance Tab and Export"
    },
    {
        key: "attendance.approve",
        module: "ATTENDANCE",
        description: "Approve manual attendance requests"
    },
    {
        key: "attendance.export",
        module: "ATTENDANCE",
        description: "Export attendance reports"
    },
    {
        key: "attendance.update_self",
        module: "ATTENDANCE",
        description: "Edit own attendance time (Regularization)"
    },
    {
        key: "attendance.update_others",
        module: "ATTENDANCE",
        description: "Update attendance of other users"
    },
    {
        key: "attendance.update_future",
        module: "ATTENDANCE",
        description: "Create, update, or delete attendance and timesheet records for future dates"
    },

    // PROJECT MANAGEMENT
    // --- PROJECT MANAGEMENT: BUSINESS UNITS ---
    {
        key: "business_unit.create",
        module: "PROJECT",
        description: "Create business units"
    },
    {
        key: "business_unit.read",
        module: "PROJECT",
        description: "View business units"
    },
    {
        key: "business_unit.update",
        module: "PROJECT",
        description: "Update business units"
    },

    // --- PROJECT MANAGEMENT: CLIENTS ---
    {
        key: "client.create",
        module: "PROJECT",
        description: "Create clients"
    },
    {
        key: "client.read",
        module: "PROJECT",
        description: "View clients"
    },
    {
        key: "client.update",
        module: "PROJECT",
        description: "Update clients"
    },

    // --- PROJECT MANAGEMENT: PROJECTS ---
    {
        key: "project.create",
        module: "PROJECT",
        description: "Create projects"
    },
    {
        key: "project.read",
        module: "PROJECT",
        description: "View projects"
    },
    {
        key: "project.view_assigned",
        module: "PROJECT",
        description: "View only assigned projects"
    },
    {
        key: "project.view_team",
        module: "PROJECT",
        description: "View projects of direct reports"
    },
    {
        key: "project.hierarchy",
        module: "PROJECT",
        description: "View Project Hierarchy"
    },
    {
        key: "project.view_work_logs",
        module: "PROJECT",
        description: "View Work Logs & Progress in Hierarchy"
    },
    {
        key: "project.update",
        module: "PROJECT",
        description: "Update projects"
    },
    {
        key: "project.delete",
        module: "PROJECT",
        description: "Delete projects"
    },
    {
        key: "module.delete",
        module: "PROJECT",
        description: "Delete modules"
    },
    {
        key: "project.export_report",
        module: "PROJECT",
        description: "Export project reports"
    },

    // --- PROJECT MANAGEMENT: TASKS ---
    {
        key: "task.create",
        module: "PROJECT",
        description: "Create tasks"
    },
    {
        key: "task.read", // Added for consistency, though usually implies viewing project details
        module: "PROJECT",
        description: "View tasks"
    },
    {
        key: "task.update",
        module: "PROJECT",
        description: "Update tasks"
    },
    {
        key: "task.delete",
        module: "PROJECT",
        description: "Delete tasks"
    },

    // EMPLOYEE DOSSIER
    {
        key: "dossier.edit",
        module: "DOSSIER",
        description: "Edit employee dossier details"
    },
    {
        key: "dossier.edit.sensitive",
        module: "DOSSIER",
        description: "Edit sensitive dossier details (Identity, Employment)"
    },
    {
        key: "dossier.approve",
        module: "DOSSIER",
        description: "Approve HRIS changes"
    },
    {
        key: "dossier.verify_documents",
        module: "DOSSIER",
        description: "Verify and approve employee documents"
    },
    {
        key: "dossier.view",
        module: "DOSSIER",
        description: "View other employees' dossiers"
    },
    {
        key: "dossier.export",
        module: "DOSSIER",
        description: "Export employee dossier details"
    },
    {
        key: "dossier.profile_photo.upload",
        module: "DOSSIER",
        description: "Allow uploading profile photo from local storage (otherwise forces direct camera capture)"
    },
    {
        key: "dossier.bypass_completeness_gate",
        module: "DOSSIER",
        description: "Bypass the mandatory dossier completeness check — allows performing attendance, timesheet, and leave actions even when dossier is incomplete"
    },
    {
        key: "employee.revision.view.self",
        module: "DOSSIER",
        description: "View own revised details and effective-dated revision history"
    },
    {
        key: "employee.revision.view.others",
        module: "DOSSIER",
        description: "View other employees' revised details and effective-dated revision history"
    },
    {
        key: "employee.revision.create",
        module: "DOSSIER",
        description: "Create and schedule new effective-dated revisions for employees"
    },
    {
        key: "employee.revision.update",
        module: "DOSSIER",
        description: "Edit revision details (reason, notes, effective date, field changes)"
    },
    {
        key: "employee.revision.cancel",
        module: "DOSSIER",
        description: "Cancel scheduled employee revisions"
    },
    {
        key: "employee.revision.manage",
        module: "DOSSIER",
        description: "Full management access to create, edit, and cancel employee revisions"
    },

    // TALENT ACQUISITION (TA)
    {
        key: "ta.view",
        module: "TA",
        description: "View all hiring requests and candidates globally"
    },
    {
        key: "ta.create",
        module: "TA",
        description: "Create new hiring requests and candidates"
    },
    {
        key: "ta.edit",
        module: "TA",
        description: "Edit hiring requests and candidates"
    },
    {
        key: "ta.delete",
        module: "TA",
        description: "Delete hiring requests and candidates"
    },
    {
        key: "ta.hiring_request.manage",
        module: "TA",
        description: "Approve, reject, or close hiring requests"
    },
    {
        key: "ta.super_approve",
        module: "TA",
        description: "Force approve or reject any hiring request regardless of workflow assignment"
    },
    {
        key: "ta.email_template.manage",
        module: "TA",
        description: "Create, edit, and archive TA email templates"
    },
    {
        key: "ta.mass_mail",
        module: "TA",
        description: "Send mass email to TA candidates"
    },
    {
        key: "ta.bulk_transfer",
        module: "TA",
        description: "Bulk transfer candidates across requisitions"
    },
    {
        key: "ta.analytics.global",
        module: "TA",
        description: "View performance analytics for the entire TA module"
    },
    {
        key: "ta.analytics.assigned",
        module: "TA",
        description: "View analytics for assigned or explicitly shared TA requisitions"
    },
    {
        key: "ta.candidate.view",
        module: "TA",
        description: "View candidates through requisition or interviewer access rules"
    },
    {
        key: "ta.requisition.view.client_name",
        module: "TA",
        description: "View confidential client names on TA requisitions"
    },
    {
        key: "ta.candidate.sensitive.view",
        module: "TA",
        description: "View sensitive candidate personal details such as email and mobile"
    },
    {
        key: "ta.candidate.edit",
        module: "TA",
        description: "Edit candidate records for accessible requisitions"
    },
    {
        key: "ta.interview.evaluate",
        module: "TA",
        description: "Evaluate assigned interview rounds, update candidate decisions, and view feedback for candidates assigned to them"
    },
    {
        key: "ta.candidate.make_decision",
        module: "TA",
        description: "Make hiring decisions for accessible requisitions"
    },
    {
        key: "ta.candidate.transfer",
        module: "TA",
        description: "Transfer candidates across requisitions or into onboarding"
    },
    {
        key: "ta.candidate.manage.assigned",
        module: "TA",
        description: "Manage assigned TA candidates with view, create, update, and delete access"
    },
    {
        key: "ta.candidate.manage.all",
        module: "TA",
        description: "Manage all TA candidates with workspace-wide access"
    },
    {
        key: "ta.config.view",
        module: "TA",
        description: "View TA workflows, templates, and access settings in read-only mode"
    },
    {
        key: "ta.config.edit",
        module: "TA",
        description: "Create, edit, and manage TA workflows, templates, and access settings"
    },
    {
        key: "ta.resume.download",
        module: "TA",
        description: "Download candidate resumes for accessible requisitions"
    },
    {
        key: "ta.interview.feedback.view_all",
        module: "TA",
        description: "View all interviewer feedback on accessible candidates"
    },
    {
        key: "ta.manage",
        module: "TA",
        description: "Manage TA approvals, workflows, templates, access settings, publishing, and analytics"
    },
    {
        key: "ta.requisition.read",
        module: "TA",
        description: "View TA requisitions you can access"
    },
    {
        key: "ta.requisition.create",
        module: "TA",
        description: "Create TA requisitions"
    },
    {
        key: "ta.requisition.update",
        module: "TA",
        description: "Edit TA requisitions you can access"
    },
    {
        key: "ta.requisition.delete",
        module: "TA",
        description: "Delete TA requisitions you can access"
    },
    {
        key: "ta.requisition.view.budget",
        module: "TA",
        description: "View budget and compensation range details on accessible requisitions"
    },
    {
        key: "ta.requisition.manage.assigned",
        module: "TA",
        description: "Manage assigned TA requisitions with view, create, update, and delete access"
    },
    {
        key: "ta.requisition.manage.all",
        module: "TA",
        description: "Manage all TA requisitions with workspace-wide access"
    },
    // DISCUSSIONS
    {
        key: "discussion.read",
        module: "DISCUSSION",
        description: "View discussions"
    },
    {
        key: "discussion.create",
        module: "DISCUSSION",
        description: "Create discussions"
    },
    {
        key: "announcement.manage",
        module: "ANNOUNCEMENT",
        description: "Create, publish, edit, and delete internal announcements"
    },
    {
        key: "announcement.react",
        module: "ANNOUNCEMENT",
        description: "React to announcements (Like, Celebrate, Support)"
    },
    {
        key: "announcement.comment",
        module: "ANNOUNCEMENT",
        description: "Comment on announcements"
    },
    {
        key: "announcement.reactions.view",
        module: "ANNOUNCEMENT",
        description: "View announcement reaction history and who reacted"
    },
    {
        key: "announcement.community.birthdays.view",
        module: "ANNOUNCEMENT",
        description: "View the Today's Birthdays section in announcements"
    },
    {
        key: "announcement.community.work_anniversaries.view",
        module: "ANNOUNCEMENT",
        description: "View the Work Anniversaries section in announcements"
    },
    {
        key: "announcement.community.new_joiners.view",
        module: "ANNOUNCEMENT",
        description: "View the New Joiners section in announcements"
    },
    {
        key: "bin.view",
        module: "SYSTEM",
        description: "View recycle bin items"
    },
    {
        key: "bin.restore",
        module: "SYSTEM",
        description: "Restore items from recycle bin"
    },
    {
        key: "bin.permanent_delete",
        module: "SYSTEM",
        description: "Permanently delete items from recycle bin"
    },
    {
        key: "settings.email.view",
        module: "SETTINGS",
        description: "View company email settings"
    },
    {
        key: "settings.email.manage",
        module: "SETTINGS",
        description: "Manage company email settings"
    },
    {
        key: "settings.notification.view",
        module: "SETTINGS",
        description: "View company notification settings"
    },
    {
        key: "settings.notification.manage",
        module: "SETTINGS",
        description: "Manage company notification settings"
    },
    {
        key: "settings.company.view",
        module: "SETTINGS",
        description: "View company settings and branding"
    },
    {
        key: "settings.company.manage",
        module: "SETTINGS",
        description: "Manage company settings and branding"
    },

    // ONBOARDING
    {
        key: "onboarding.manage",
        module: "ONBOARDING",
        description: "Manage onboarding candidates and details"
    },
    {
        key: "onboarding.view",
        module: "ONBOARDING",
        description: "View onboarding candidates and dashboard details"
    },
    {
        key: "onboarding.document.review",
        module: "ONBOARDING",
        description: "Review, approve, and flag onboarding documents"
    },
    {
        key: "onboarding.document.request",
        module: "ONBOARDING",
        description: "Request onboarding documents and send onboarding communications"
    },
    {
        key: "onboarding.credential.manage",
        module: "ONBOARDING",
        description: "Manage onboarding credentials, deadlines, and extension handling"
    },
    {
        key: "onboarding.complete",
        module: "ONBOARDING",
        description: "Complete onboarding and transfer candidates to active employees"
    },

    // OFFBOARDING
    {
        key: "offboarding.read",
        module: "OFFBOARDING",
        description: "View offboarding records and dashboard stats"
    },
    {
        key: "offboarding.create",
        module: "OFFBOARDING",
        description: "Initiate employee offboarding records"
    },
    {
        key: "offboarding.update",
        module: "OFFBOARDING",
        description: "Update offboarding progress, documents, and completion"
    },
    {
        key: "hr_email.send",
        module: "HR",
        description: "Send HR emails to active employees and save attachments to dossiers"
    },

    // PAYROLL / SALARY CALCULATOR
    {
        key: "payroll.calculator.view",
        module: "PAYROLL",
        description: "Access and use the interactive Salary Calculator simulator"
    },
    {
        key: "payroll.config.manage",
        module: "PAYROLL",
        description: "Create, update, and manage company payroll configurations (salary components, tax rates, EPF/ESI limits)"
    },
    {
        key: "payroll.salary.view",
        module: "PAYROLL",
        description: "Access and view employee salary details and snapshots"
    },
    {
        key: "payroll.salary.manage",
        module: "PAYROLL",
        description: "Create, update, and manage employee salary revisions and snapshots"
    },
    {
        key: "payroll.salary.view.self",
        module: "PAYROLL",
        description: "Access and view own salary details and payslips in the dossier"
    },

    // LEAVE
    {
        key: "leave.config.manage",
        module: "LEAVE",
        description: "Create, update, and delete leave policies (leave types, accrual rules, carry-forward settings)"
    },
    {
        key: "dashboard.view",
        module: "SYSTEM",
        description: "View main dashboard"
    },

    // ORGANIZATION STRUCTURE
    {
        key: "department.create",
        module: "ORGANIZATION",
        description: "Create departments"
    },
    {
        key: "department.read",
        module: "ORGANIZATION",
        description: "View departments"
    },
    {
        key: "department.update",
        module: "ORGANIZATION",
        description: "Update departments"
    },
    {
        key: "department.delete",
        module: "ORGANIZATION",
        description: "Delete/archive departments"
    },
    {
        key: "designation.create",
        module: "ORGANIZATION",
        description: "Create designations"
    },
    {
        key: "designation.read",
        module: "ORGANIZATION",
        description: "View designations"
    },
    {
        key: "designation.update",
        module: "ORGANIZATION",
        description: "Update designations"
    },
    {
        key: "designation.delete",
        module: "ORGANIZATION",
        description: "Delete/archive designations"
    },
    {
        key: "org_chart.view",
        module: "ORGANIZATION",
        description: "View the organization chart"
    },
    {
        key: "org_chart.manage",
        module: "ORGANIZATION",
        description: "Edit reporting lines from the org chart"
    },
    {
        key: "business_unit.delete",
        module: "ORGANIZATION",
        description: "Delete business units"
    }
];

