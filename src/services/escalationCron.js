const cron = require('node-cron');
const HelpdeskQuery = require('../models/HelpdeskQuery');
const User = require('../models/User');
const Company = require('../models/Company');
const NotificationService = require('./notificationService');
const { calculateWorkHours } = require('./helpdeskUtils');

const startEscalationCron = (io) => {
    // Run every hour
    cron.schedule('0 * * * *', async () => {
        // console.log('[CRON] Running Helpdesk Escalation check...');
        try {
            const pendingQueries = await HelpdeskQuery.find({
                status: { $in: ['New', 'In Progress'] }
            }).populate('queryType');

            const now = new Date();

            for (const query of pendingQueries) {
                // Determine the threshold and company settings
                const qType = query.queryType;

                // Find a system admin for comment attribution within this company
                const systemAdmin = await User.findOne({ companyId: query.companyId, 'roles.name': 'Admin' }).lean();
                const escalationDays = (qType && qType.enableEscalation && qType.escalationDays) ? qType.escalationDays : 2;
                const thresholdHours = escalationDays * 24;

                const company = await Company.findById(query.companyId).lean();
                const weeklyOff = company?.settings?.attendance?.weeklyOff || ['Saturday', 'Sunday'];
                
                const workHoursElapsed = calculateWorkHours(query.createdAt, now, weeklyOff);

                if (workHoursElapsed >= thresholdHours) {
                    const oldAssignee = query.assignedTo;
                    console.log(`[CRON] Escalating Query ${query.queryId} (${workHoursElapsed.toFixed(2)} hours old, Threshold: ${thresholdHours}h)`);

                    query.status = 'Escalated';
                    query.escalatedAt = now;

                    let commentText = `[SYSTEM] This query has been automatically escalated because it exceeded the ${thresholdHours}-hour SLA.`;

                    // Check if there is a custom escalation person to reassign to
                    let newAssignee = null;
                    if (qType && qType.enableEscalation && qType.escalationPerson) {
                        newAssignee = qType.escalationPerson;
                        if (!query.originalAssignee) {
                            query.originalAssignee = query.assignedTo;
                        }
                        query.assignedTo = newAssignee;
                        commentText += ` It has been re-assigned to the designated escalation contact.`;
                    } else {
                        commentText += ` Admins please review.`;
                    }

                    query.comments.push({
                        user: systemAdmin ? systemAdmin._id : query.raisedBy, // Use admin if found, else fallback to raiser (original hacky behavior)
                        text: commentText,
                        createdAt: now
                    });

                    await query.save();

                    // Notifications
                    if (io) {
                        // Notify the raiser
                        await NotificationService.createNotification(io, {
                            user: query.raisedBy,
                            companyId: query.companyId,
                            title: 'Query Escalated',
                            message: `Your query "${query.subject}" has been escalated due to SLA timeout.`,
                            type: 'Alert',
                            link: `/helpdesk/${query._id}`
                        });

                        // Notify the new assignee (if reassigned)
                        if (newAssignee && newAssignee.toString() !== oldAssignee.toString()) {
                            await NotificationService.createNotification(io, {
                                user: newAssignee,
                                companyId: query.companyId,
                                title: 'Escalated Query Assigned',
                                message: `An escalated query "${query.subject}" has been assigned to you.`,
                                type: 'Alert',
                                link: `/helpdesk/${query._id}`
                            });
                        }
                    }
                }
            }

            // console.log('[CRON] Helpdesk Escalation check completed.');
        } catch (error) {
            console.error('[CRON] Error during escalation check:', error);
        }
    });
};

module.exports = startEscalationCron;
