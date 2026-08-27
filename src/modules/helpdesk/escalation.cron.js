const cron = require('node-cron');
const HelpdeskQuery = require('./helpdeskQuery.model');
const User = require('../../modules/user/user.model');
const Role = require('../../modules/user/role.model');
const Company = require('../company/company.model');
const NotificationService = require('../../services/notificationService');
const { calculateWorkHours } = require('./helpdesk.utils');

const DEFAULT_WEEKLY_OFF = ['Saturday', 'Sunday'];
const DEFAULT_ESCALATION_DAYS = 2;
const ESCALATION_BATCH_SIZE = Math.max(parseInt(process.env.HELPDESK_ESCALATION_BATCH_SIZE || '50', 10), 1);
const CRON_TIMEZONE = process.env.CRON_TIMEZONE || 'Asia/Kolkata';

let escalationJobRunning = false;

const getUniqueCompanyIds = (queries) => (
    [...new Set(
        queries
            .map(query => query.companyId?.toString())
            .filter(Boolean)
    )]
);

const loadWeeklyOffByCompany = async (companyIds) => {
    if (companyIds.length === 0) return new Map();

    const companies = await Company.find({ _id: { $in: companyIds } })
        .select('_id settings.attendance.weeklyOff')
        .lean();

    return new Map(
        companies.map(company => [
            company._id.toString(),
            company?.settings?.attendance?.weeklyOff || DEFAULT_WEEKLY_OFF
        ])
    );
};

const loadAdminByCompany = async (companyIds) => {
    if (companyIds.length === 0) return new Map();

    const adminRoles = await Role.find({
        companyId: { $in: companyIds },
        name: { $in: ['Admin', 'System'] },
        isActive: true
    })
        .select('_id companyId')
        .lean();

    const adminRoleIds = adminRoles.map(role => role._id);
    if (adminRoleIds.length === 0) return new Map();

    const admins = await User.find({
        companyId: { $in: companyIds },
        roles: { $in: adminRoleIds },
        isActive: true
    })
        .select('_id companyId createdAt')
        .sort({ createdAt: 1 })
        .lean();

    const adminByCompany = new Map();
    for (const admin of admins) {
        const companyKey = admin.companyId?.toString();
        if (companyKey && !adminByCompany.has(companyKey)) {
            adminByCompany.set(companyKey, admin._id);
        }
    }

    return adminByCompany;
};

const startEscalationCron = (io) => {
    // Run every hour
    cron.schedule('0 * * * *', async () => {
        if (escalationJobRunning) {
            console.warn('[CRON] Skipping helpdesk escalation run because the previous cycle is still active.');
            return;
        }

        escalationJobRunning = true;

        try {
            let hasMore = true;
            let lastSeenId = null;

            while (hasMore) {
            const queryFilter = {
                status: { $in: ['New', 'In Progress', 'Escalated'] }
            };
            if (lastSeenId) {
                queryFilter._id = { $gt: lastSeenId };
            }

            const pendingQueries = await HelpdeskQuery.find(queryFilter)
                .select('queryId subject queryType assignedTo raisedBy companyId createdAt originalAssignee comments currentEscalationLevel escalationHistory status')
                .populate({
                    path: 'queryType',
                    select: 'enableEscalation escalationDays escalationPerson escalationLevels',
                    populate: [
                        { path: 'escalationLevels.escalationPerson', select: 'firstName lastName email' },
                        { path: 'escalationPerson', select: 'firstName lastName email' }
                    ]
                })
                .sort({ _id: 1 })
                .limit(ESCALATION_BATCH_SIZE);

            if (pendingQueries.length === 0) {
                hasMore = false;
                break;
            }

            lastSeenId = pendingQueries[pendingQueries.length - 1]._id;
            if (pendingQueries.length < ESCALATION_BATCH_SIZE) {
                hasMore = false;
            }

            const now = new Date();
            const companyIds = getUniqueCompanyIds(pendingQueries);
            const [weeklyOffByCompany, adminByCompany] = await Promise.all([
                loadWeeklyOffByCompany(companyIds),
                loadAdminByCompany(companyIds)
            ]);
            const notificationsData = [];

            for (const query of pendingQueries) {
                try {
                    const qType = query.queryType;
                    if (!qType || !qType.enableEscalation) {
                        continue;
                    }

                    const companyKey = query.companyId?.toString();
                    const weeklyOff = weeklyOffByCompany.get(companyKey) || DEFAULT_WEEKLY_OFF;
                    const workHoursElapsed = calculateWorkHours(query.createdAt, now, weeklyOff);

                    // Build and sort normalized escalation levels
                    let levels = [];
                    if (Array.isArray(qType.escalationLevels) && qType.escalationLevels.length > 0) {
                        levels = [...qType.escalationLevels].sort((a, b) => a.level - b.level);
                    } else if (qType.escalationPerson) {
                        levels = [{
                            level: 1,
                            escalationDays: qType.escalationDays || DEFAULT_ESCALATION_DAYS,
                            escalationPerson: qType.escalationPerson
                        }];
                    }

                    if (levels.length === 0) {
                        continue;
                    }

                    const currentLevel = query.currentEscalationLevel || (query.status === 'Escalated' ? 1 : 0);
                    const nextLevel = levels.find(lvl => lvl.level > currentLevel);

                    // If already at or past highest configured level, nothing more to escalate
                    if (!nextLevel) {
                        continue;
                    }

                    const escalationDays = nextLevel.escalationDays || DEFAULT_ESCALATION_DAYS;
                    const thresholdHours = escalationDays * 24;

                    if (workHoursElapsed < thresholdHours) {
                        continue;
                    }

                    const oldAssignee = query.assignedTo ? query.assignedTo.toString() : null;
                    const newAssigneeDoc = nextLevel.escalationPerson;
                    const newAssignee = newAssigneeDoc?._id || newAssigneeDoc;
                    const newAssigneeName = newAssigneeDoc?.firstName
                        ? `${newAssigneeDoc.firstName} ${newAssigneeDoc.lastName || ''}`.trim()
                        : 'Designated Escalation Contact';

                    console.log(`[CRON] Escalating Query ${query.queryId} to Level ${nextLevel.level} (${workHoursElapsed.toFixed(2)} hours old, Threshold: ${thresholdHours}h)`);

                    query.status = 'Escalated';
                    query.currentEscalationLevel = nextLevel.level;
                    query.escalatedAt = now;

                    let commentText = `[SYSTEM] This query has been automatically escalated to Level ${nextLevel.level} because it exceeded the ${thresholdHours}-hour work SLA.`;

                    if (newAssignee) {
                        if (!query.originalAssignee && query.assignedTo) {
                            query.originalAssignee = query.assignedTo;
                        }
                        query.assignedTo = newAssignee;
                        commentText += ` It has been re-assigned to ${newAssigneeName}.`;
                    } else {
                        commentText += ' Admins please review.';
                    }

                    if (!Array.isArray(query.escalationHistory)) {
                        query.escalationHistory = [];
                    }

                    query.escalationHistory.push({
                        level: nextLevel.level,
                        escalatedFrom: oldAssignee,
                        escalatedTo: newAssignee,
                        escalatedAt: now,
                        reason: `Exceeded Level ${nextLevel.level} SLA threshold of ${thresholdHours} work hours`,
                        triggeredBy: 'system'
                    });

                    if (!Array.isArray(query.comments)) {
                        query.comments = [];
                    }

                    query.comments.push({
                        user: adminByCompany.get(companyKey) || query.raisedBy,
                        text: commentText,
                        createdAt: now
                    });

                    await query.save();

                    notificationsData.push({
                        user: query.raisedBy,
                        companyId: query.companyId,
                        preferenceKey: 'helpdesk_query_escalated',
                        title: `Query Escalated (Level ${nextLevel.level})`,
                        message: `Your query "${query.subject}" has been escalated to Level ${nextLevel.level} (${newAssigneeName}) due to SLA timeout.`,
                        type: 'Alert',
                        link: `/helpdesk/${query._id}`
                    });

                    if (newAssignee && newAssignee.toString() !== oldAssignee) {
                        notificationsData.push({
                            user: newAssignee,
                            companyId: query.companyId,
                            preferenceKey: 'helpdesk_query_escalated',
                            title: `Escalated Query Assigned (Level ${nextLevel.level})`,
                            message: `An escalated query (Level ${nextLevel.level}) "${query.subject}" has been assigned to you.`,
                            type: 'Alert',
                            link: `/helpdesk/${query._id}`
                        });
                    }
                } catch (queryError) {
                    console.error(`[CRON] Failed to process query ${query.queryId}:`, queryError);
                }
            }

            if (io && notificationsData.length > 0) {
                await NotificationService.createManyNotifications(io, notificationsData);
            }
            } // end while (hasMore)
        } catch (error) {
            console.error('[CRON] Error during escalation check:', error);
        } finally {
            escalationJobRunning = false;
        }
    }, {
        timezone: CRON_TIMEZONE
    });
};

module.exports = startEscalationCron;
