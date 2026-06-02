const NOTIFICATION_CHANNELS = ['off', 'system', 'email', 'both'];
const NOTIFICATION_EMAIL_SENDER_SOURCES = ['notification', 'default'];

const NOTIFICATION_EVENT_DEFINITIONS = [
    {
        key: 'employee_first_login_otp',
        label: 'Employee first login OTP',
        description: 'Send the first-login OTP when an employee must reset their password.',
        module: 'Authentication',
        defaultChannel: 'email',
        supportedChannels: ['email']
    },
    {
        key: 'leave_request_submitted',
        label: 'Leave request submitted',
        description: 'Notify approvers when an employee submits a leave request.',
        module: 'Leaves',
        defaultChannel: 'system'
    },
    {
        key: 'leave_request_status_updated',
        label: 'Leave request approved or rejected',
        description: 'Notify the employee after a leave request is reviewed.',
        module: 'Leaves',
        defaultChannel: 'both'
    },
    {
        key: 'timesheet_submitted',
        label: 'Timesheet submitted',
        description: 'Notify approvers when a timesheet is submitted.',
        module: 'Timesheet',
        defaultChannel: 'system'
    },
    {
        key: 'timesheet_status_updated',
        label: 'Timesheet approved or rejected',
        description: 'Notify the employee after a timesheet review.',
        module: 'Timesheet',
        defaultChannel: 'both'
    },
    {
        key: 'attendance_regularization_submitted',
        label: 'Attendance regularization submitted',
        description: 'Notify managers when an attendance regularization request is raised.',
        module: 'Attendance',
        defaultChannel: 'system'
    },
    {
        key: 'attendance_regularization_status_updated',
        label: 'Attendance regularization approved or rejected',
        description: 'Notify the employee after a regularization request is reviewed.',
        module: 'Attendance',
        defaultChannel: 'both'
    },
    {
        key: 'attendance_document_submitted',
        label: 'Attendance support document submitted',
        description: 'Notify managers when an attendance support document is uploaded.',
        module: 'Attendance',
        defaultChannel: 'system'
    },
    {
        key: 'attendance_document_status_updated',
        label: 'Attendance support document reviewed',
        description: 'Notify the employee after a support document is approved or rejected.',
        module: 'Attendance',
        defaultChannel: 'both'
    },
    {
        key: 'helpdesk_query_created',
        label: 'Helpdesk query created',
        description: 'Notify assigned teams and the requester when a new helpdesk query is raised.',
        module: 'Helpdesk',
        defaultChannel: 'system'
    },
    {
        key: 'helpdesk_query_status_updated',
        label: 'Helpdesk query status updated',
        description: 'Notify the other party when a helpdesk query changes status.',
        module: 'Helpdesk',
        defaultChannel: 'both'
    },
    {
        key: 'helpdesk_query_comment_added',
        label: 'Helpdesk comment added',
        description: 'Notify the other party when a new helpdesk comment is added.',
        module: 'Helpdesk',
        defaultChannel: 'system'
    },
    {
        key: 'helpdesk_query_escalated',
        label: 'Helpdesk query escalated',
        description: 'Notify users when a helpdesk query is escalated or reassigned.',
        module: 'Helpdesk',
        defaultChannel: 'both'
    },
    {
        key: 'discussion_created',
        label: 'Private discussion created',
        description: 'Notify users when they are added to a new private discussion.',
        module: 'Discussions',
        defaultChannel: 'system'
    },
    {
        key: 'announcement_published',
        label: 'Announcement published',
        description: 'Notify users when a new internal announcement is published for them.',
        module: 'Announcements',
        defaultChannel: 'system'
    },
    {
        key: 'interview_assigned',
        label: 'Interview assigned',
        description: 'Notify interviewers when they are assigned to an interview round.',
        module: 'Talent Acquisition',
        defaultChannel: 'both'
    },
    {
        key: 'hiring_request_approval_requested',
        label: 'Hiring request approval needed',
        description: 'Notify approvers when a hiring request reaches their approval step.',
        module: 'Talent Acquisition',
        defaultChannel: 'both'
    },
    {
        key: 'hiring_request_approved',
        label: 'Hiring request approved',
        description: 'Notify the creator when a hiring request is fully approved.',
        module: 'Talent Acquisition',
        defaultChannel: 'both'
    },
    {
        key: 'candidate_phase_updated',
        label: 'Candidate phase updated',
        description: 'Notify hiring stakeholders when a candidate moves through dynamic phases.',
        module: 'Talent Acquisition',
        defaultChannel: 'system'
    },
    {
        key: 'onboarding_submission_received',
        label: 'Onboarding submission received',
        description: 'Notify HR when a pre-onboarding submission is completed.',
        module: 'Onboarding',
        defaultChannel: 'both'
    },
    {
        key: 'pre_onboarding_email_sent',
        label: 'Pre-onboarding email send',
        description: 'Send the main pre-onboarding email to the candidate.',
        module: 'Onboarding',
        defaultChannel: 'email',
        supportedChannels: ['email']
    },
    {
        key: 'onboarding_custom_file_sent',
        label: 'Onboarding custom file send',
        description: 'Send manually attached onboarding files to the candidate.',
        module: 'Onboarding',
        defaultChannel: 'email',
        supportedChannels: ['email']
    },
    {
        key: 'onboarding_document_reupload_required',
        label: 'Onboarding document re-upload required',
        description: 'Send the re-upload request email when onboarding documents need correction.',
        module: 'Onboarding',
        defaultChannel: 'email',
        supportedChannels: ['email']
    },
    {
        key: 'onboarding_account_ready',
        label: 'Onboarding account ready email',
        description: 'Send the welcome email after onboarding is transferred to an active employee account.',
        module: 'Onboarding',
        defaultChannel: 'email',
        supportedChannels: ['email']
    },
    {
        key: 'ta_mass_mail_sent',
        label: 'TA mass mail send',
        description: 'Send bulk candidate emails from Talent Acquisition.',
        module: 'Talent Acquisition',
        defaultChannel: 'email',
        supportedChannels: ['email']
    }
];

const NOTIFICATION_EVENT_MAP = NOTIFICATION_EVENT_DEFINITIONS.reduce((accumulator, definition) => {
    accumulator[definition.key] = definition;
    return accumulator;
}, {});

const buildDefaultNotificationEvents = () => NOTIFICATION_EVENT_DEFINITIONS.reduce((accumulator, definition) => {
    accumulator[definition.key] = definition.defaultChannel;
    return accumulator;
}, {});

const buildDefaultNotificationEmailSenderSources = () => NOTIFICATION_EVENT_DEFINITIONS.reduce((accumulator, definition) => {
    accumulator[definition.key] = 'notification';
    return accumulator;
}, {});

const buildDefaultNotificationEventEmailSenderAccountIds = () => NOTIFICATION_EVENT_DEFINITIONS.reduce((accumulator, definition) => {
    accumulator[definition.key] = '';
    return accumulator;
}, {});

const isValidNotificationChannel = (value) => NOTIFICATION_CHANNELS.includes(String(value || '').toLowerCase());
const isValidNotificationEmailSenderSource = (value) => NOTIFICATION_EMAIL_SENDER_SOURCES.includes(String(value || '').toLowerCase());

const normalizeNotificationSettings = (settings = {}) => {
    const inputEvents = settings?.events instanceof Map
        ? Object.fromEntries(settings.events.entries())
        : (settings?.events || {});
    const inputEventEmailSenderSources = settings?.eventEmailSenderSources instanceof Map
        ? Object.fromEntries(settings.eventEmailSenderSources.entries())
        : (settings?.eventEmailSenderSources || {});
    const inputEventEmailSenderAccountIds = settings?.eventEmailSenderAccountIds instanceof Map
        ? Object.fromEntries(settings.eventEmailSenderAccountIds.entries())
        : (settings?.eventEmailSenderAccountIds || {});
    const defaultEvents = buildDefaultNotificationEvents();
    const defaultEventEmailSenderSources = buildDefaultNotificationEmailSenderSources();
    const defaultEventEmailSenderAccountIds = buildDefaultNotificationEventEmailSenderAccountIds();
    const normalizedEvents = { ...defaultEvents };
    const normalizedEventEmailSenderSources = { ...defaultEventEmailSenderSources };
    const normalizedEventEmailSenderAccountIds = { ...defaultEventEmailSenderAccountIds };

    Object.keys(defaultEvents).forEach((key) => {
        const supportedChannels = NOTIFICATION_EVENT_MAP[key]?.supportedChannels || NOTIFICATION_CHANNELS;
        const incomingValue = String(inputEvents?.[key] || '').toLowerCase();
        if (isValidNotificationChannel(incomingValue) && supportedChannels.includes(incomingValue)) {
            normalizedEvents[key] = incomingValue;
        }

        const incomingSenderSource = String(inputEventEmailSenderSources?.[key] || '').toLowerCase();
        if (isValidNotificationEmailSenderSource(incomingSenderSource)) {
            normalizedEventEmailSenderSources[key] = incomingSenderSource;
        }

        normalizedEventEmailSenderAccountIds[key] = String(inputEventEmailSenderAccountIds?.[key] || '').trim();
    });

    return {
        emailSenderAccountId: String(settings?.emailSenderAccountId || '').trim(),
        events: normalizedEvents,
        eventEmailSenderSources: normalizedEventEmailSenderSources,
        eventEmailSenderAccountIds: normalizedEventEmailSenderAccountIds
    };
};

module.exports = {
    NOTIFICATION_CHANNELS,
    NOTIFICATION_EMAIL_SENDER_SOURCES,
    NOTIFICATION_EVENT_DEFINITIONS,
    NOTIFICATION_EVENT_MAP,
    buildDefaultNotificationEvents,
    buildDefaultNotificationEmailSenderSources,
    buildDefaultNotificationEventEmailSenderAccountIds,
    isValidNotificationChannel,
    isValidNotificationEmailSenderSource,
    normalizeNotificationSettings
};
