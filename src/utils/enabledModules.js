const LEGACY_PROJECT_MODULE_ID = 'projectManagement';
const PROJECTS_MODULE_ID = 'projects';
const BUSINESS_UNITS_MODULE_ID = 'businessUnits';
const CLIENTS_MODULE_ID = 'clients';

const ALL_COMPANY_MODULES = [
    { id: 'attendance', label: 'Attendance', icon: 'Clock' },
    { id: 'leaves', label: 'Leaves', icon: 'Calendar' },
    { id: 'timesheet', label: 'Timesheet', icon: 'FileText' },
    { id: 'talentAcquisition', label: 'Talent Acquisition', icon: 'Users' },
    { id: 'helpdesk', label: 'Helpdesk', icon: 'MessageSquare' },
    { id: 'meetingsOfMinutes', label: 'Minutes of Meeting', icon: 'BookOpen' },
    { id: BUSINESS_UNITS_MODULE_ID, label: 'Business Units', icon: 'Building' },
    { id: CLIENTS_MODULE_ID, label: 'Clients', icon: 'Building2' },
    { id: PROJECTS_MODULE_ID, label: 'Projects', icon: 'Briefcase' },
    { id: 'employeeDossier', label: 'Employee Dossier', icon: 'Folder' },
    { id: 'userManagement', label: 'User Management', icon: 'UserCog' }
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

    return Array.from(normalizedIds);
};

const hasEnabledModule = (moduleIds = [], targetModuleId = '') => {
    const normalizedIds = normalizeEnabledModules(moduleIds);

    if (targetModuleId === LEGACY_PROJECT_MODULE_ID) {
        return normalizedIds.includes(PROJECTS_MODULE_ID);
    }

    return normalizedIds.includes(targetModuleId);
};

module.exports = {
    ALL_COMPANY_MODULES,
    BUSINESS_UNITS_MODULE_ID,
    CLIENTS_MODULE_ID,
    LEGACY_PROJECT_MODULE_ID,
    PROJECTS_MODULE_ID,
    hasEnabledModule,
    normalizeEnabledModules
};
