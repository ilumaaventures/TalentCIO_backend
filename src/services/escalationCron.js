const cron = require('node-cron');
const HelpdeskQuery = require('../models/HelpdeskQuery');
const User = require('../models/User');
const Role = require('../models/Role');
const Company = require('../models/Company');
const NotificationService = require('./notificationService');
const { calculateWorkHours } = require('./helpdeskUtils');

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
            const pendingQueries = await HelpdeskQuery.find({
                status: { $in: ['New', 'In Progress'] }
            })
                .select('queryId subject queryType assignedTo raisedBy companyId createdAt originalAssignee')
                .populate({
                    path: 'queryType',
                    select: 'enableEscalation escalationDays escalationPerson'
                })
                .sort({ createdAt: 1 })
                .limit(ESCALATION_BATCH_SIZE);

            if (pendingQueries.length === 0) {
                return;
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
                    const companyKey = query.companyId?.toString();
                    const escalationDays = (qType && qType.enableEscalation && qType.escalationDays)
                        ? qType.escalationDays
                        : DEFAULT_ESCALATION_DAYS;
                    const thresholdHours = escalationDays * 24;
                    const weeklyOff = weeklyOffByCompany.get(companyKey) || DEFAULT_WEEKLY_OFF;
                    const workHoursElapsed = calculateWorkHours(query.createdAt, now, weeklyOff);

                    if (workHoursElapsed < thresholdHours) {
                        continue;
                    }

                    const oldAssignee = query.assignedTo ? query.assignedTo.toString() : null;
                    console.log(`[CRON] Escalating Query ${query.queryId} (${workHoursElapsed.toFixed(2)} hours old, Threshold: ${thresholdHours}h)`);

                    query.status = 'Escalated';
                    query.escalatedAt = now;

                    let commentText = `[SYSTEM] This query has been automatically escalated because it exceeded the ${thresholdHours}-hour SLA.`;
                    let newAssignee = null;

                    if (qType && qType.enableEscalation && qType.escalationPerson) {
                        newAssignee = qType.escalationPerson;
                        if (!query.originalAssignee && query.assignedTo) {
                            query.originalAssignee = query.assignedTo;
                        }
                        query.assignedTo = newAssignee;
                        commentText += ' It has been re-assigned to the designated escalation contact.';
                    } else {
                        commentText += ' Admins please review.';
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
                        title: 'Query Escalated',
                        message: `Your query "${query.subject}" has been escalated due to SLA timeout.`,
                        type: 'Alert',
                        link: `/helpdesk/${query._id}`
                    });

                    if (newAssignee && newAssignee.toString() !== oldAssignee) {
                        notificationsData.push({
                            user: newAssignee,
                            companyId: query.companyId,
                            title: 'Escalated Query Assigned',
                            message: `An escalated query "${query.subject}" has been assigned to you.`,
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
