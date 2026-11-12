module.exports = [
    {
        "key": "user.create",
        "module": "USER",
        "description": "Create new users"
    },
    {
        "key": "user.read",
        "module": "USER",
        "description": "View user details"
    },
    {
        "key": "user.update",
        "module": "USER",
        "description": "Update user details"
    },
    {
        "key": "user.delete",
        "module": "USER",
        "description": "Deactivate or delete users"
    },
    {
        "key": "user.impersonate",
        "module": "USER",
        "description": "Switch into another user's account within this workspace (impersonation)"
    },
    {
        "key": "role.create",
        "module": "ROLE",
        "description": "Create new roles"
    },
    {
        "key": "role.read",
        "module": "ROLE",
        "description": "View roles and permissions"
    },
    {
        "key": "role.update",
        "module": "ROLE",
        "description": "Update roles and permissions"
    },
    {
        "key": "timesheet.submit",
        "module": "TIMESHEET",
        "description": "Submit own timesheets"
    },
    {
        "key": "timesheet.approve",
        "module": "TIMESHEET",
        "description": "Approve submitted timesheets"
    },
    {
        "key": "timesheet.export",
        "module": "TIMESHEET",
        "description": "Export timesheet reports"
    },
    {
        "key": "timesheet.view",
        "module": "TIMESHEET",
        "description": "View timesheet and attendance of all users"
    },
    {
        "key": "timesheet.view_assigned",
        "module": "TIMESHEET",
        "description": "View timesheet and attendance of assigned users only"
    },
    {
        "key": "timesheet.update_others",
        "module": "TIMESHEET",
        "description": "Update timesheet entries for other users"
    },
    {
        "key": "attendance.clock_in",
        "module": "ATTENDANCE",
        "description": "Clock in and out"
    },
    {
        "key": "attendance.view",
        "module": "ATTENDANCE",
        "description": "View entire Attendance Tab and Export"
    },
    {
        "key": "attendance.approve",
        "module": "ATTENDANCE",
        "description": "Approve manual attendance requests"
    },
    {
        "key": "attendance.export",
        "module": "ATTENDANCE",
        "description": "Export attendance reports"
    },
    {
        "key": "attendance.update_self",
        "module": "ATTENDANCE",
        "description": "Edit own attendance time (Regularization)"
    },
    {
        "key": "attendance.update_others",
        "module": "ATTENDANCE",
        "description": "Update attendance of other users"
    },
    {
        "key": "attendance.update_future",
        "module": "ATTENDANCE",
        "description": "Create, update, or delete attendance and timesheet records for future dates"
    },
    {
        "key": "business_unit.create",
        "module": "PROJECT",
        "description": "Create business units"
    },
    {
        "key": "business_unit.read",
        "module": "PROJECT",
        "description": "View business units"
    },
    {
        "key": "business_unit.update",
        "module": "PROJECT",
        "description": "Update business units"
    },
    {
        "key": "client.create",
        "module": "PROJECT",
        "description": "Create clients"
    },
    {
        "key": "client.read",
        "module": "PROJECT",
        "description": "View clients"
    },
    {
        "key": "client.update",
        "module": "PROJECT",
        "description": "Update clients"
    },
    {
        "key": "project.create",
        "module": "PROJECT",
        "description": "Create projects"
    },
    {
        "key": "project.read",
        "module": "PROJECT",
        "description": "View projects"
    },
    {
        "key": "project.view_assigned",
        "module": "PROJECT",
        "description": "View only assigned projects"
    },
    {
        "key": "project.view_team",
        "module": "PROJECT",
        "description": "View projects of direct reports"
    },
    {
        "key": "project.userperformance.view",
        "module": "PROJECT",
        "description": "View performance of all users (Note: requires user.read permission to take effect)"
    },
    {
        "key": "project.hierarchy",
        "module": "PROJECT",
        "description": "View Project Hierarchy"
    },
    {
        "key": "project.view_work_logs",
        "module": "PROJECT",
        "description": "View Work Logs & Progress in Hierarchy"
    },
    {
        "key": "project.update",
        "module": "PROJECT",
        "description": "Update projects"
    },
    {
        "key": "project.delete",
        "module": "PROJECT",
        "description": "Delete projects"
    },
    {
        "key": "module.delete",
        "module": "PROJECT",
        "description": "Delete modules"
    },
    {
        "key": "project.export_report",
        "module": "PROJECT",
        "description": "Export project reports"
    },
    {
        "key": "task.create",
        "module": "PROJECT",
        "description": "Create tasks"
    },
    {
        "key": "task.read",
        "module": "PROJECT",
        "description": "View tasks"
    },
    {
        "key": "task.update",
        "module": "PROJECT",
        "description": "Update tasks"
    },
    {
        "key": "task.delete",
        "module": "PROJECT",
        "description": "Delete tasks"
    },
    {
        "key": "dossier.edit",
        "module": "DOSSIER",
        "description": "Edit employee dossier details"
    },
    {
        "key": "dossier.edit.sensitive",
        "module": "DOSSIER",
        "description": "Edit sensitive dossier details (Identity, Employment)"
    },
    {
        "key": "dossier.approve",
        "module": "DOSSIER",
        "description": "Approve HRIS changes"
    },
    {
        "key": "dossier.verify_documents",
        "module": "DOSSIER",
        "description": "Verify and approve employee documents"
    },
    {
        "key": "dossier.view",
        "module": "DOSSIER",
        "description": "View other employees' dossiers"
    },
    {
        "key": "dossier.export",
        "module": "DOSSIER",
        "description": "Export employee dossier details"
    },
    {
        "key": "dossier.profile_photo.upload",
        "module": "DOSSIER",
        "description": "Allow uploading profile photo from local storage (otherwise forces direct camera capture)"
    },
    {
        "key": "dossier.bypass_completeness_gate",
        "module": "DOSSIER",
        "description": "Bypass the mandatory dossier completeness check — allows performing attendance, timesheet, and leave actions even when dossier is incomplete"
    },
    {
        "key": "employee.revision.view.self",
        "module": "DOSSIER",
        "description": "View own revised details and effective-dated revision history"
    },
    {
        "key": "employee.revision.view.others",
        "module": "DOSSIER",
        "description": "View other employees' revised details and effective-dated revision history"
    },
    {
        "key": "employee.revision.create",
        "module": "DOSSIER",
        "description": "Create and schedule new effective-dated revisions for employees"
    },
    {
        "key": "employee.revision.update",
        "module": "DOSSIER",
        "description": "Edit revision details (reason, notes, effective date, field changes)"
    },
    {
        "key": "employee.revision.cancel",
        "module": "DOSSIER",
        "description": "Cancel scheduled employee revisions"
    },
    {
        "key": "employee.revision.manage",
        "module": "DOSSIER",
        "description": "Full management access to create, edit, and cancel employee revisions"
    },
    {
        "key": "ta.view",
        "module": "TA",
        "description": "View all hiring requests and candidates globally"
    },
    {
        "key": "ta.create",
        "module": "TA",
        "description": "Create new hiring requests and candidates"
    },
    {
        "key": "ta.edit",
        "module": "TA",
        "description": "Edit hiring requests and candidates"
    },
    {
        "key": "ta.delete",
        "module": "TA",
        "description": "Delete hiring requests and candidates"
    },
    {
        "key": "ta.hiring_request.manage",
        "module": "TA",
        "description": "Approve, reject, or close hiring requests"
    },
    {
        "key": "ta.super_approve",
        "module": "TA",
        "description": "Force approve or reject any hiring request regardless of workflow assignment"
    },
    {
        "key": "ta.email_template.manage",
        "module": "TA",
        "description": "Create, edit, and archive TA email templates"
    },
    {
        "key": "ta.mass_mail",
        "module": "TA",
        "description": "Send mass email to TA candidates"
    },
    {
        "key": "ta.bulk_transfer",
        "module": "TA",
        "description": "Bulk transfer candidates across requisitions"
    },
    {
        "key": "ta.analytics.global",
        "module": "TA",
        "description": "View performance analytics for the entire TA module"
    },
    {
        "key": "ta.analytics.assigned",
        "module": "TA",
        "description": "View analytics for assigned or explicitly shared TA requisitions"
    },
    {
        "key": "ta.candidate.view",
        "module": "TA",
        "description": "View candidates through requisition or interviewer access rules"
    },
    {
        "key": "ta.requisition.view.client_name",
        "module": "TA",
        "description": "View confidential client names on TA requisitions"
    },
    {
        "key": "ta.candidate.sensitive.view",
        "module": "TA",
        "description": "View sensitive candidate personal details such as email and mobile"
    },
    {
        "key": "ta.candidate.edit",
        "module": "TA",
        "description": "Edit candidate records for accessible requisitions"
    },
    {
        "key": "ta.interview.evaluate",
        "module": "TA",
        "description": "Evaluate assigned interview rounds, update candidate decisions, and view feedback for candidates assigned to them"
    },
    {
        "key": "ta.candidate.make_decision",
        "module": "TA",
        "description": "Make hiring decisions for accessible requisitions"
    },
    {
        "key": "ta.candidate.transfer",
        "module": "TA",
        "description": "Transfer candidates across requisitions or into onboarding"
    },
    {
        "key": "ta.candidate.manage.assigned",
        "module": "TA",
        "description": "Manage assigned TA candidates with view, create, update, and delete access"
    },
    {
        "key": "ta.candidate.manage.all",
        "module": "TA",
        "description": "Manage all TA candidates with workspace-wide access"
    },
    {
        "key": "ta.config.view",
        "module": "TA",
        "description": "View TA workflows, templates, and access settings in read-only mode"
    },
    {
        "key": "ta.config.edit",
        "module": "TA",
        "description": "Create, edit, and manage TA workflows, templates, and access settings"
    },
    {
        "key": "ta.resume.download",
        "module": "TA",
        "description": "Download candidate resumes for accessible requisitions"
    },
    {
        "key": "ta.interview.feedback.view_all",
        "module": "TA",
        "description": "View all interviewer feedback on accessible candidates"
    },
    {
        "key": "ta.manage",
        "module": "TA",
        "description": "Manage TA approvals, workflows, templates, access settings, publishing, and analytics"
    },
    {
        "key": "ta.requisition.read",
        "module": "TA",
        "description": "View TA requisitions you can access"
    },
    {
        "key": "ta.requisition.create",
        "module": "TA",
        "description": "Create TA requisitions"
    },
    {
        "key": "ta.requisition.update",
        "module": "TA",
        "description": "Edit TA requisitions you can access"
    },
    {
        "key": "ta.requisition.delete",
        "module": "TA",
        "description": "Delete TA requisitions you can access"
    },
    {
        "key": "ta.requisition.view.budget",
        "module": "TA",
        "description": "View budget and compensation range details on accessible requisitions"
    },
    {
        "key": "ta.requisition.manage.assigned",
        "module": "TA",
        "description": "Manage assigned TA requisitions with view, create, update, and delete access"
    },
    {
        "key": "ta.requisition.manage.all",
        "module": "TA",
        "description": "Manage all TA requisitions with workspace-wide access"
    },
    {
        "key": "ta.client.manage",
        "module": "TA",
        "description": "Invite, manage, and configure client portal user accounts"
    },
    {
        "key": "ta.client.visibility.configure",
        "module": "TA",
        "description": "Configure per-requisition client portal visibility and candidate access gating"
    },
    {
        "key": "ta.client.portal.view_as",
        "module": "TA",
        "description": "Preview and view requisitions and candidates as a client portal user"
    },
    {
        "key": "discussion.read",
        "module": "DISCUSSION",
        "description": "View discussions"
    },
    {
        "key": "discussion.create",
        "module": "DISCUSSION",
        "description": "Create discussions"
    },
    {
        "key": "discussion.view_all",
        "module": "DISCUSSION",
        "description": "View all discussions and filter by creator"
    },
    {
        "key": "announcement.manage",
        "module": "ANNOUNCEMENT",
        "description": "Create, publish, edit, and delete internal announcements"
    },
    {
        "key": "announcement.react",
        "module": "ANNOUNCEMENT",
        "description": "React to announcements (Like, Celebrate, Support)"
    },
    {
        "key": "announcement.comment",
        "module": "ANNOUNCEMENT",
        "description": "Comment on announcements"
    },
    {
        "key": "announcement.reactions.view",
        "module": "ANNOUNCEMENT",
        "description": "View announcement reaction history and who reacted"
    },
    {
        "key": "announcement.community.birthdays.view",
        "module": "ANNOUNCEMENT",
        "description": "View the Today's Birthdays section in announcements"
    },
    {
        "key": "announcement.community.work_anniversaries.view",
        "module": "ANNOUNCEMENT",
        "description": "View the Work Anniversaries section in announcements"
    },
    {
        "key": "announcement.community.new_joiners.view",
        "module": "ANNOUNCEMENT",
        "description": "View the New Joiners section in announcements"
    },
    {
        "key": "bin.view",
        "module": "SYSTEM",
        "description": "View recycle bin items"
    },
    {
        "key": "bin.restore",
        "module": "SYSTEM",
        "description": "Restore items from recycle bin"
    },
    {
        "key": "bin.permanent_delete",
        "module": "SYSTEM",
        "description": "Permanently delete items from recycle bin"
    },
    {
        "key": "settings.email.view",
        "module": "SETTINGS",
        "description": "View company email settings"
    },
    {
        "key": "settings.email.manage",
        "module": "SETTINGS",
        "description": "Manage company email settings"
    },
    {
        "key": "settings.notification.view",
        "module": "SETTINGS",
        "description": "View company notification settings"
    },
    {
        "key": "settings.notification.manage",
        "module": "SETTINGS",
        "description": "Manage company notification settings"
    },
    {
        "key": "settings.company.view",
        "module": "SETTINGS",
        "description": "View company settings and branding"
    },
    {
        "key": "settings.company.manage",
        "module": "SETTINGS",
        "description": "Manage company settings and branding"
    },
    {
        "key": "onboarding.manage",
        "module": "ONBOARDING",
        "description": "Manage onboarding candidates and details"
    },
    {
        "key": "onboarding.view",
        "module": "ONBOARDING",
        "description": "View onboarding candidates and dashboard details"
    },
    {
        "key": "onboarding.document.review",
        "module": "ONBOARDING",
        "description": "Review, approve, and flag onboarding documents"
    },
    {
        "key": "onboarding.document.request",
        "module": "ONBOARDING",
        "description": "Request onboarding documents and send onboarding communications"
    },
    {
        "key": "onboarding.credential.manage",
        "module": "ONBOARDING",
        "description": "Manage onboarding credentials, deadlines, and extension handling"
    },
    {
        "key": "onboarding.complete",
        "module": "ONBOARDING",
        "description": "Complete onboarding and transfer candidates to active employees"
    },
    {
        "key": "offboarding.read",
        "module": "OFFBOARDING",
        "description": "View offboarding records and dashboard stats"
    },
    {
        "key": "offboarding.create",
        "module": "OFFBOARDING",
        "description": "Initiate employee offboarding records"
    },
    {
        "key": "offboarding.update",
        "module": "OFFBOARDING",
        "description": "Update offboarding progress, documents, and completion"
    },
    {
        "key": "hr_email.send",
        "module": "HR",
        "description": "Send HR emails to active employees and save attachments to dossiers"
    },
    {
        "key": "payroll.calculator.view",
        "module": "PAYROLL",
        "description": "Access and use the interactive Salary Calculator simulator"
    },
    {
        "key": "payroll.config.manage",
        "module": "PAYROLL",
        "description": "Create, update, and manage company payroll configurations (salary components, tax rates, EPF/ESI limits)"
    },
    {
        "key": "payroll.salary.view",
        "module": "PAYROLL",
        "description": "Access and view employee salary details and snapshots"
    },
    {
        "key": "payroll.salary.manage",
        "module": "PAYROLL",
        "description": "Create, update, and manage employee salary revisions and snapshots"
    },
    {
        "key": "payroll.salary.view.self",
        "module": "PAYROLL",
        "description": "Access and view own salary details and payslips in the dossier"
    },
    {
        "key": "payroll.payslip.view",
        "module": "PAYROLL",
        "description": "Access and view own Payroll & Payslip on My Space and download payslips"
    },
    {
        "key": "leave.config.manage",
        "module": "LEAVE",
        "description": "Create, update, and delete leave policies (leave types, accrual rules, carry-forward settings)"
    },
    {
        "key": "leave.view",
        "module": "LEAVE",
        "description": "View employee leave requests, balances, and history"
    },
    {
        "key": "leave.view_all",
        "module": "LEAVE",
        "description": "View company-wide leave requests and team approvals"
    },
    {
        "key": "leave.approve",
        "module": "LEAVE",
        "description": "Approve or reject employee leave requests"
    },
    {
        "key": "leave.manage",
        "module": "LEAVE",
        "description": "Full administrative management of company leave requests, policies, and balances"
    },
    {
        "key": "meeting.read",
        "module": "MEETINGS",
        "description": "View meetings and minutes of meetings"
    },
    {
        "key": "meeting.create",
        "module": "MEETINGS",
        "description": "Create and schedule meetings and minutes of meetings"
    },
    {
        "key": "meeting.edit",
        "module": "MEETINGS",
        "description": "Edit and update meeting details and minutes"
    },
    {
        "key": "meeting.delete",
        "module": "MEETINGS",
        "description": "Delete meetings and move to bin"
    },
    {
        "key": "meeting.manage",
        "module": "MEETINGS",
        "description": "Full administrative management of meetings and minutes"
    },
    {
        "key": "dashboard.view",
        "module": "SYSTEM",
        "description": "View main dashboard"
    },
    {
        "key": "department.create",
        "module": "ORGANIZATION",
        "description": "Create departments"
    },
    {
        "key": "department.read",
        "module": "ORGANIZATION",
        "description": "View departments"
    },
    {
        "key": "department.update",
        "module": "ORGANIZATION",
        "description": "Update departments"
    },
    {
        "key": "department.delete",
        "module": "ORGANIZATION",
        "description": "Delete/archive departments"
    },
    {
        "key": "designation.create",
        "module": "ORGANIZATION",
        "description": "Create designations"
    },
    {
        "key": "designation.read",
        "module": "ORGANIZATION",
        "description": "View designations"
    },
    {
        "key": "designation.update",
        "module": "ORGANIZATION",
        "description": "Update designations"
    },
    {
        "key": "designation.delete",
        "module": "ORGANIZATION",
        "description": "Delete/archive designations"
    },
    {
        "key": "org_chart.view",
        "module": "ORGANIZATION",
        "description": "View the organization chart"
    },
    {
        "key": "org_chart.manage",
        "module": "ORGANIZATION",
        "description": "Edit reporting lines from the org chart"
    },
    {
        "key": "business_unit.delete",
        "module": "ORGANIZATION",
        "description": "Delete business units"
    },
    {
        "key": "crm.view",
        "module": "CRM",
        "description": "Access Sales CRM workspace and cockpit"
    },
    {
        "key": "crm.leads.read",
        "module": "CRM",
        "description": "View assigned or owned CRM leads"
    },
    {
        "key": "crm.leads.read_all",
        "module": "CRM",
        "description": "View all CRM leads across the organization (unrestricted)"
    },
    {
        "key": "crm.leads.create",
        "module": "CRM",
        "description": "Capture and create new leads"
    },
    {
        "key": "crm.leads.update",
        "module": "CRM",
        "description": "Update and qualify leads"
    },
    {
        "key": "crm.leads.delete",
        "module": "CRM",
        "description": "Delete or disqualify leads"
    },
    {
        "key": "crm.leads.convert",
        "module": "CRM",
        "description": "Convert qualified leads into deals, contacts, and accounts"
    },
    {
        "key": "crm.deals.read",
        "module": "CRM",
        "description": "View sales opportunities and pipeline board"
    },
    {
        "key": "crm.deals.create",
        "module": "CRM",
        "description": "Create new opportunities and deals"
    },
    {
        "key": "crm.deals.update",
        "module": "CRM",
        "description": "Move stages and update deal terms"
    },
    {
        "key": "crm.deals.delete",
        "module": "CRM",
        "description": "Delete opportunities"
    },
    {
        "key": "crm.pipelines.read",
        "module": "CRM",
        "description": "View sales pipelines and stage configurations"
    },
    {
        "key": "crm.pipelines.manage",
        "module": "CRM",
        "description": "Configure sales pipelines, stages, and probability rules"
    },
    {
        "key": "crm.contacts.read",
        "module": "CRM",
        "description": "View client and stakeholder contacts"
    },
    {
        "key": "crm.contacts.manage",
        "module": "CRM",
        "description": "Create, edit, and manage client contacts"
    },
    {
        "key": "crm.accounts.read",
        "module": "CRM",
        "description": "View B2B company accounts and profiles"
    },
    {
        "key": "crm.accounts.manage",
        "module": "CRM",
        "description": "Create, edit, and manage B2B company accounts"
    },
    {
        "key": "crm.activities.read",
        "module": "CRM",
        "description": "View sales activity timeline and interaction history"
    },
    {
        "key": "crm.activities.create",
        "module": "CRM",
        "description": "Log sales activities, notes, and interactions"
    },
    {
        "key": "crm.tasks.read",
        "module": "CRM",
        "description": "View CRM tasks, reminders, and sales calendar"
    },
    {
        "key": "crm.tasks.manage",
        "module": "CRM",
        "description": "Create, update, and complete CRM tasks and schedule meetings"
    },
    {
        "key": "crm.followups.read",
        "module": "CRM",
        "description": "View scheduled follow-ups and overdue alerts"
    },
    {
        "key": "crm.followups.manage",
        "module": "CRM",
        "description": "Schedule, complete, and reschedule follow-up reminders"
    },
    {
        "key": "crm.communication.read",
        "module": "CRM",
        "description": "View sales communication history (Email, WhatsApp, Calls)"
    },
    {
        "key": "crm.communication.send",
        "module": "CRM",
        "description": "Send outbound emails, WhatsApp messages, and log sales calls"
    },
    {
        "key": "crm.growth.read",
        "module": "CRM",
        "description": "View sequences and marketing campaign performance"
    },
    {
        "key": "crm.growth.manage",
        "module": "CRM",
        "description": "Configure sales drip sequences, enroll leads, and launch campaigns"
    },
    {
        "key": "crm.workflows.read",
        "module": "CRM",
        "description": "View CRM automation workflows"
    },
    {
        "key": "crm.workflows.manage",
        "module": "CRM",
        "description": "Create, edit, and toggle CRM workflow automations"
    },
    {
        "key": "crm.forecast.read",
        "module": "CRM",
        "description": "View sales revenue forecasts and quota targets"
    },
    {
        "key": "crm.forecast.manage",
        "module": "CRM",
        "description": "Set sales quota targets and revenue projections"
    },
    {
        "key": "crm.commissions.read",
        "module": "CRM",
        "description": "View sales commission earnings and leaderboard"
    },
    {
        "key": "crm.commissions.manage",
        "module": "CRM",
        "description": "Manage sales commission rules, approvals, and payroll sync"
    },
    {
        "key": "crm.analytics.read",
        "module": "CRM",
        "description": "View CRM analytics dashboards, conversion funnels, and reports"
    },
    {
        "key": "crm.territories.read",
        "module": "CRM",
        "description": "View sales territories and rep assignments"
    },
    {
        "key": "crm.territories.manage",
        "module": "CRM",
        "description": "Create and manage sales territories and routing rules"
    },
    {
        "key": "crm.ai.use",
        "module": "CRM",
        "description": "Use AI Sales Copilot and generate opportunity risk insights"
    },
    {
        "key": "crm.data.import",
        "module": "CRM",
        "description": "Import and view own imported CRM database records"
    },
    {
        "key": "crm.data.view_all",
        "module": "CRM",
        "description": "View all imported database records across all users (unrestricted)"
    },
    {
        "key": "crm.data.export",
        "module": "CRM",
        "description": "Export CRM records and analytics reports"
    },
    {
        "key": "crm.data.merge",
        "module": "CRM",
        "description": "Deduplicate and merge CRM records"
    },
    {
        "key": "crm.admin",
        "module": "CRM",
        "description": "Full administration: CRM settings, custom fields, audit logs, and configurations"
    },
    {
        "key": "pms.view",
        "module": "PERFORMANCE",
        "description": "View PMS Dashboard, team performance, and appraisals"
    },
    {
        "key": "pms.cycle.manage",
        "module": "PERFORMANCE",
        "description": "Create, edit, activate, close, and reopen performance cycles"
    },
    {
        "key": "pms.kra.manage",
        "module": "PERFORMANCE",
        "description": "Create, edit, and assign KRA templates and weightages"
    },
    {
        "key": "pms.kpi.manage",
        "module": "PERFORMANCE",
        "description": "Configure KPI definitions, target rules, and verify achievements"
    },
    {
        "key": "pms.goal.create",
        "module": "PERFORMANCE",
        "description": "Set and update individual and team goals"
    },
    {
        "key": "pms.goal.approve",
        "module": "PERFORMANCE",
        "description": "Approve or reject employee goals"
    },
    {
        "key": "pms.self_review.submit",
        "module": "PERFORMANCE",
        "description": "Submit self-appraisals and evidence"
    },
    {
        "key": "pms.manager_review.submit",
        "module": "PERFORMANCE",
        "description": "Complete and submit manager evaluations and ratings"
    },
    {
        "key": "pms.feedback_360.manage",
        "module": "PERFORMANCE",
        "description": "Nominate, approve, and collect 360-degree peer feedback"
    },
    {
        "key": "pms.calibration.manage",
        "module": "PERFORMANCE",
        "description": "Access calibration session, moderate ratings, and adjust scores"
    },
    {
        "key": "pms.ratings.publish",
        "module": "PERFORMANCE",
        "description": "Publish final performance appraisals to employees"
    },
    {
        "key": "pms.pip.manage",
        "module": "PERFORMANCE",
        "description": "Initiate and track Performance Improvement Plans (PIP)"
    },
    {
        "key": "pms.dev_plan.manage",
        "module": "PERFORMANCE",
        "description": "Create and track Employee Development Plans"
    },
    {
        "key": "pms.continuous_feedback.use",
        "module": "PERFORMANCE",
        "description": "Give and receive continuous feedback and schedule 1-on-1s"
    },
    {
        "key": "pms.reports.view",
        "module": "PERFORMANCE",
        "description": "View performance analytics and export reports"
    },
    {
        "key": "pms.department_head.review",
        "module": "PERFORMANCE",
        "description": "Review and approve appraisals as Department Head"
    },
    {
        "key": "pms.hr.evaluate",
        "module": "PERFORMANCE",
        "description": "Evaluate, calibrate, and approve appraisals as HR"
    },
    {
        "key": "pms.approval.final",
        "module": "PERFORMANCE",
        "description": "Perform final approval before rating publication"
    },
    {
        "key": "pms.admin",
        "module": "PERFORMANCE",
        "description": "Full PMS administration: settings, rating scales, and audit trail"
    },
    {
        "key": "pms.view.all",
        "module": "PERFORMANCE",
        "description": "View all users, team evaluations, feedback, and ratings across the entire company"
    },
    {
        "key": "pms.can.edit.all",
        "module": "PERFORMANCE",
        "description": "Full management: give feedback & ratings to any user, calibrate scores, and configure approval workflows"
    },
    {
        "key": "pms.manage.team",
        "module": "PERFORMANCE",
        "description": "Manage team: evaluate direct reports, give feedback and ratings to team members"
    },
    {
        "key": "pms.view.only",
        "module": "PERFORMANCE",
        "description": "View own performance: view own ratings, feedback, assigned KRAs/KPIs, and kudos"
    },
    {
        "key": "attendance.view_others",
        "module": "ATTENDANCE",
        "description": "View other employees' attendance records"
    },
    {
        "key": "attendance.view_all",
        "module": "ATTENDANCE",
        "description": "View all company attendance records"
    },
    {
        "key": "dossier.view.sensitive",
        "module": "DOSSIER",
        "description": "View sensitive employee identity, background, and bank details"
    },
    {
        "key": "employee.revision.edit",
        "module": "DOSSIER",
        "description": "Edit scheduled employee revisions (alias for update)"
    },
    {
        "key": "employee.revision.delete",
        "module": "DOSSIER",
        "description": "Cancel or remove employee revisions (alias for cancel)"
    },
    {
        "key": "discussion.edit",
        "module": "DISCUSSION",
        "description": "Edit discussion topics and notes"
    },
    {
        "key": "discussion.delete",
        "module": "DISCUSSION",
        "description": "Delete discussion topics and notes"
    },
    {
        "key": "discussion.read_all",
        "module": "DISCUSSION",
        "description": "View all organization discussions"
    },
    {
        "key": "org.chart.view",
        "module": "ORGANIZATION",
        "description": "View the organization chart (alias for org_chart.view)"
    },
    {
        "key": "org.chart.manage",
        "module": "ORGANIZATION",
        "description": "Edit reporting lines from the org chart (alias for org_chart.manage)"
    },
    {
        "key": "ta.read",
        "module": "TA",
        "description": "View Talent Acquisition dashboard and analytics"
    },
    {
        "key": "ta.client.view",
        "module": "TA",
        "description": "View client accounts and information in TA"
    },
    {
        "key": "ta.client.confidential.view",
        "module": "TA",
        "description": "View confidential client and billing data in TA"
    },
    {
        "key": "ta.schedule_interview",
        "module": "TA",
        "description": "Schedule candidate interview rounds"
    },
    {
        "key": "ta.config.access",
        "module": "TA",
        "description": "Access TA configuration, stages, and settings"
    },
    {
        "key": "ta.analytics.requisition",
        "module": "TA",
        "description": "View hiring requisition analytics"
    },
    {
        "key": "ta.offer.create",
        "module": "TA",
        "description": "Create candidate offer letters"
    },
    {
        "key": "ta.offer.view",
        "module": "TA",
        "description": "View candidate offer letters"
    },
    {
        "key": "ta.offer.approve",
        "module": "TA",
        "description": "Approve candidate offer letters"
    },
    {
        "key": "ta.offer.revoke",
        "module": "TA",
        "description": "Revoke candidate offer letters"
    },
    {
        "key": "crm.manage",
        "module": "CRM",
        "description": "Full management access to Sales CRM"
    },
    {
        "key": "crm.leads.manage",
        "module": "CRM",
        "description": "Create, update, and manage CRM leads"
    },
    {
        "key": "pms.analytics.view",
        "module": "PERFORMANCE",
        "description": "View performance analytics and reporting metrics (alias)"
    },
    {
        "key": "reimbursement.new_claim",
        "module": "REIMBURSEMENT",
        "description": "Submit personal reimbursement claims"
    },
    {
        "key": "reimbursement.view_all",
        "module": "REIMBURSEMENT",
        "description": "View all company reimbursement claims"
    },
    {
        "key": "reimbursement.approval",
        "module": "REIMBURSEMENT",
        "description": "Approve or reject employee reimbursement claims"
    },
    {
        "key": "reimbursement.manage",
        "module": "REIMBURSEMENT",
        "description": "Full reimbursement management and category configuration"
    },
    {
        "key": "reimbursement.mark_paid",
        "module": "REIMBURSEMENT",
        "description": "Mark approved reimbursement claims as paid / reimbursed"
    },
    {
        "key": "ess_document.published",
        "module": "ESS_DOCUMENT",
        "description": "View published company ESS documents and policies"
    },
    {
        "key": "ess_document.manage",
        "module": "ESS_DOCUMENT",
        "description": "Manage, upload, and publish company ESS documents"
    },
    {
        "key": "ess_document.create",
        "module": "ESS_DOCUMENT",
        "description": "Upload new company ESS documents"
    },
    {
        "key": "ess_document.delete",
        "module": "ESS_DOCUMENT",
        "description": "Delete company ESS documents"
    },
    {
        "key": "helpdesk.manage",
        "module": "HELPDESK",
        "description": "Full helpdesk administration and SLA configuration"
    },
    {
        "key": "helpdesk.view_all",
        "module": "HELPDESK",
        "description": "View all company helpdesk tickets"
    },
    {
        "key": "helpdesk.resolve",
        "module": "HELPDESK",
        "description": "Resolve and respond to assigned tickets"
    },
    {
        "key": "helpdesk.types.manage",
        "module": "HELPDESK",
        "description": "Manage query types, routing rules, and escalation workflows"
    },
    {
        "key": "helpdesk.analytics.view",
        "module": "HELPDESK",
        "description": "View helpdesk resolution analytics and SLA metrics"
    },
    {
        "key": "timesheet.create",
        "module": "TIMESHEET",
        "description": "Create and log personal timesheets"
    },
    {
        "key": "ta.candidate.create",
        "module": "TA",
        "description": "Create candidate profiles and applications"
    },
    {
        "key": "ta.interview.schedule",
        "module": "TA",
        "description": "Schedule candidate interview rounds"
    },
    {
        "key": "reimbursement.status_update",
        "module": "REIMBURSEMENT",
        "description": "Update status of reimbursement claims"
    },
    {
        "key": "ta.application.read",
        "module": "TA",
        "description": "View job applications"
    },
    {
        "key": "ta.application.create",
        "module": "TA",
        "description": "Create job applications"
    },
    {
        "key": "ta.application.update",
        "module": "TA",
        "description": "Update job applications"
    },
    {
        "key": "ta.application.delete",
        "module": "TA",
        "description": "Delete job applications"
    },
    {
        "key": "ta.application.manage.assigned",
        "module": "TA",
        "description": "Manage assigned job applications"
    },
    {
        "key": "ta.application.manage.all",
        "module": "TA",
        "description": "Manage all job applications"
    },
    {
        "key": "ta.candidate.view.client_name",
        "module": "TA",
        "description": "View client names on candidate profiles"
    },
    {
        "key": "ta.candidate.view.pii",
        "module": "TA",
        "description": "View candidate personally identifiable information"
    },
    {
        "key": "ta.candidate.resume.download",
        "module": "TA",
        "description": "Download candidate resumes"
    },
    {
        "key": "ta.candidate.evaluate_round",
        "module": "TA",
        "description": "Submit candidate evaluation scorecards"
    },
    {
        "key": "ta.config.manage",
        "module": "TA",
        "description": "Full configuration of recruitment pipeline and stages"
    },
    {
        "key": "employee.revision.view",
        "module": "DOSSIER",
        "description": "View employee revision records"
    }
];
