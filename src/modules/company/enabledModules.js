const LEGACY_PROJECT_MODULE_ID = 'projectManagement';
const PROJECTS_MODULE_ID = 'projects';
const BUSINESS_UNITS_MODULE_ID = 'businessUnits';
const CLIENTS_MODULE_ID = 'clients';

const ALL_COMPANY_MODULES = [
    { id: 'attendance', label: 'Attendance', icon: 'Clock' },
    { id: 'leaves', label: 'Leaves', icon: 'Calendar' },
    { id: 'holidays', label: 'Holidays', icon: 'CalendarDays' },
    { id: 'timesheet', label: 'Timesheet', icon: 'FileText' },
    { id: 'talentAcquisition', label: 'Talent Acquisition', icon: 'Users' },
    { id: 'helpdesk', label: 'Helpdesk', icon: 'MessageSquare' },
    { id: 'meetingsOfMinutes', label: 'Minutes of Meeting', icon: 'BookOpen' },
    { id: BUSINESS_UNITS_MODULE_ID, label: 'Business Units', icon: 'Building' },
    { id: CLIENTS_MODULE_ID, label: 'Clients', icon: 'Building2' },
    { id: PROJECTS_MODULE_ID, label: 'Projects', icon: 'Briefcase' },
    { id: 'employeeDossier', label: 'Employee Dossier', icon: 'Folder' },
    { id: 'userManagement', label: 'User Management', icon: 'UserCog' },
    { id: 'onboarding', label: 'Onboarding', icon: 'UserPlus' },
    { id: 'offboarding', label: 'Offboarding', icon: 'LogOut' },
    { id: 'hrEmail', label: 'Send HR Email', icon: 'Mail' },
    { id: 'announcements', label: 'Announcements', icon: 'Megaphone' },
    { id: 'reimbursements', label: 'Reimbursements', icon: 'Receipt' },
    { id: 'essDocuments', label: 'Company Documents', icon: 'FileStack' },
    { id: 'organization', label: 'Organization Structure', icon: 'Network' },
    { id: 'mySpace', label: 'My Space', icon: 'LayoutGrid' }
];

const normalizeEnabledModules = (moduleIds = []) => {
    const normalizedIds = new Set(
        (Array.isArray(moduleIds) ? moduleIds : [])
            .map((moduleId) => String(moduleId || '').trim())
            .filter(Boolean)
    );

    if (normalizedIds.has(LEGACY_PROJECT_MODULE_ID)) {
        normalizedIds.add(BUSINESS_UNITS_MODULE_ID);
        normalizedIds.add(CLIENTS_MODULE_ID);
        normalizedIds.add(PROJECTS_MODULE_ID);
        normalizedIds.delete(LEGACY_PROJECT_MODULE_ID);
    }

    if (normalizedIds.has(PROJECTS_MODULE_ID)) {
        normalizedIds.add(BUSINESS_UNITS_MODULE_ID);
        normalizedIds.add(CLIENTS_MODULE_ID);
    }

    if (normalizedIds.has('ess')) {
        normalizedIds.add('mySpace');
    }

    return Array.from(normalizedIds);
};

const hasEnabledModule = (moduleIds = [], targetModuleId = '') => {
    const normalizedIds = normalizeEnabledModules(moduleIds);

    if (targetModuleId === LEGACY_PROJECT_MODULE_ID) {
        return normalizedIds.includes(PROJECTS_MODULE_ID);
    }

    if (targetModuleId === 'ess') {
        return normalizedIds.includes('mySpace') || normalizedIds.includes('ess');
    }

    if (targetModuleId === 'leave' || targetModuleId === 'leaves') {
        return normalizedIds.includes('leaves') || normalizedIds.includes('leave');
    }

    return normalizedIds.includes(targetModuleId);
};

const filterPermissionsByEnabledModules = (permissions = [], enabledModules = []) => {
    const enabled = new Set(normalizeEnabledModules(enabledModules));

    return permissions.filter((perm) => {
        const key = String(perm?.key || '');

        if (key.startsWith('attendance.')) return enabled.has('attendance');
        if (key.startsWith('leave.')) return enabled.has('leaves');
        if (key.startsWith('holiday.')) return enabled.has('holidays');
        if (key.startsWith('timesheet.')) return enabled.has('timesheet');
        if (key.startsWith('ta.')) return enabled.has('talentAcquisition');
        if (key.startsWith('helpdesk.')) return enabled.has('helpdesk');
        if (key.startsWith('discussion.')) return enabled.has('meetingsOfMinutes');
        if (key.startsWith('business_unit.')) return enabled.has('businessUnits');
        if (key.startsWith('org_chart.')) return enabled.has('organization');
        if (key.startsWith('client.')) return enabled.has('clients');
        if (key.startsWith('project.') || key.startsWith('module.') || key.startsWith('task.')) return enabled.has('projects');
        if (key.startsWith('dossier.') || key.startsWith('employee.revision.')) return enabled.has('employeeDossier');
        if (key.startsWith('user.') || key.startsWith('role.')) return enabled.has('userManagement');
        if (key.startsWith('onboarding.')) return enabled.has('onboarding');
        if (key.startsWith('offboarding.')) return enabled.has('offboarding');
        if (key.startsWith('hr_email.')) return enabled.has('hrEmail');
        if (key.startsWith('announcement.')) return enabled.has('announcements');
        if (key.startsWith('reimbursement.')) return enabled.has('reimbursements');
        if (key.startsWith('ess_document.')) return enabled.has('essDocuments');
        if (key.startsWith('my_space.') || key.startsWith('ess.')) return enabled.has('mySpace');

        return true;
    });
};

module.exports = {
    ALL_COMPANY_MODULES,
    BUSINESS_UNITS_MODULE_ID,
    CLIENTS_MODULE_ID,
    LEGACY_PROJECT_MODULE_ID,
    PROJECTS_MODULE_ID,
    hasEnabledModule,
    normalizeEnabledModules,
    filterPermissionsByEnabledModules
};
