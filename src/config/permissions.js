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

    // ONBOARDING
    {
        key: "onboarding.manage",
        module: "ONBOARDING",
        description: "Manage onboarding candidates and details"
    }
];
