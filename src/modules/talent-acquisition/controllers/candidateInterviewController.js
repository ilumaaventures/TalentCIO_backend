const Candidate = require('../model/candidate.model');
const { HiringRequest } = require('../model/hiringRequest.model');
const EmailTemplate = require('../../email/model/emailTemplate.model');
const TAEmailLog = require('../model/taEmailLog.model');
const NotificationService = require('../../../services/notificationService');
const { sendEmailForCompany, getCompanyEmailSettings, pickEmailAccount } = require('../../../services/companyEmailService');
const mongoose = require('mongoose');

const resolveSenderAccountDetails = async (companyId, requestedAccountId = null) => {
    try {
        const emailSettings = await getCompanyEmailSettings(companyId);
        const accountSelection = pickEmailAccount(emailSettings, requestedAccountId);

        if (accountSelection.mode === 'account' && accountSelection.account) {
            return {
                emailAccountId: String(accountSelection.account._id || 'account'),
                emailAccountLabel: accountSelection.account.name || accountSelection.account.fromAddress || `${emailSettings?.companyName || 'Company'} Account`,
                fromAddress: accountSelection.account.fromAddress || '',
                fromName: accountSelection.account.fromName || emailSettings?.companyName || 'Talent Acquisition Team'
            };
        }

        const platformFromAddress = process.env.EMAIL_FROM || process.env.BREVO_SENDER_EMAIL || 'no-reply@talentcio.in';
        return {
            emailAccountId: 'platform',
            emailAccountLabel: 'TalentCIO Platform',
            fromAddress: platformFromAddress,
            fromName: emailSettings?.companyName || 'TalentCIO Platform'
        };
    } catch (e) {
        return {
            emailAccountId: 'platform',
            emailAccountLabel: 'TalentCIO Platform',
            fromAddress: process.env.EMAIL_FROM || 'no-reply@talentcio.in',
            fromName: 'TalentCIO Platform'
        };
    }
};
const { TA_CAPABILITIES, buildAccessibleCandidateQuery } = require('../utils/candidateAccess');
const { ensureCandidateCapability } = require('../utils/candidateAccess');

const sendInterviewScheduleEmails = async ({
    companyId,
    candidate,
    round,
    user,
    cc,
    bcc,
    emailAccountId,
    customSubject,
    customHtmlBody,
    sendCandidateEmail = true,
    sendInterviewerEmail = true
}) => {
    try {
        if (!candidate || !round) return;

        const roleTitle = candidate.hiringRequestId?.roleDetails?.title || candidate.roleTitle || candidate.position || '';

        let template = null;
        if (round.emailTemplateId) {
            template = await EmailTemplate.findOne({ _id: round.emailTemplateId, companyId }).lean();
        }

        const effectiveCc = cc !== undefined ? cc : (round.cc || '');
        const effectiveBcc = bcc !== undefined ? bcc : (round.bcc || '');
        const effectiveEmailAccountId = emailAccountId || round.emailAccountId || undefined;
        const effectiveCustomSubject = customSubject || round.customSubject || undefined;
        const effectiveCustomHtmlBody = customHtmlBody || round.customHtmlBody || undefined;

        let customFieldsHtml = '';
        if (Array.isArray(round.customFields) && round.customFields.length > 0) {
            const validFields = round.customFields.filter(f => f.key && String(f.key).trim());
            if (validFields.length > 0) {
                const rowsHtml = validFields.map(f => `
                    <tr>
                        <td style="padding: 8px 12px; font-weight: bold; color: #334155; border-bottom: 1px solid #e2e8f0; width: 35%;">${f.key}:</td>
                        <td style="padding: 8px 12px; color: #0f172a; border-bottom: 1px solid #e2e8f0;">${f.value || 'N/A'}</td>
                    </tr>
                `).join('');

                customFieldsHtml = `
                    <div style="margin-top: 20px; padding: 16px; background-color: #f8fafc; border-radius: 12px; border: 1px solid #cbd5e1;">
                        <h4 style="margin: 0 0 12px 0; color: #1e293b; font-size: 14px; font-weight: bold;">Interview Details & Additional Information:</h4>
                        <table style="width: 100%; border-collapse: collapse; font-size: 13px;">
                            ${rowsHtml}
                        </table>
                    </div>
                `;
            }
        }

        const scheduledDateFormatted = round.scheduledDate
            ? new Date(round.scheduledDate).toLocaleString('en-US', { dateStyle: 'full', timeStyle: 'short' })
            : 'To Be Confirmed / Scheduled Soon';

        const clientName = candidate.hiringRequestId?.client || candidate.companyName || '';
        const candidateLocation = candidate.currentLocation || candidate.location || candidate.currentCity || candidate.hiringRequestId?.requirements?.location || '';
        const candidatePhone = candidate.mobile || candidate.phone || candidate.phoneNumber || '';
        const candidateDisplayName = candidate.candidateName || [candidate.firstName, candidate.lastName].filter(Boolean).join(' ') || candidate.name || 'Candidate';
        const roundDisplayName = round.levelName || round.name || 'Interview Round';

        const interviewersList = Array.isArray(round.assignedTo) && round.assignedTo.length > 0
            ? round.assignedTo
                .map(u => typeof u === 'object' ? ([u.firstName, u.lastName].filter(Boolean).join(' ') || u.email || 'Interviewer') : String(u))
                .filter(Boolean)
                .join(', ')
            : 'Will be shared prior to session';

        const processTemplate = (text, isBody = false) => {
            if (!text) return '';
            const candFirstName = candidateDisplayName ? candidateDisplayName.split(' ')[0] : 'Candidate';
            const candLastName = candidateDisplayName ? candidateDisplayName.split(' ').slice(1).join(' ') : '';

            let processed = text
                .replace(/\{\{?candidateName\}\}?/gi, candidateDisplayName)
                .replace(/\{\{?fullName\}\}?/gi, candidateDisplayName)
                .replace(/\{\{?firstName\}\}?/gi, candFirstName)
                .replace(/\{\{?lastName\}\}?/gi, candLastName)
                .replace(/\{\{?candidateEmail\}\}?/gi, candidate.email || '')
                .replace(/\{\{?workEmail\}\}?/gi, candidate.email || '')
                .replace(/\{\{?email\}\}?/gi, candidate.email || '')
                .replace(/\{\{?phone\}\}?/gi, candidatePhone || 'N/A')
                .replace(/\{\{?mobile\}\}?/gi, candidatePhone || 'N/A')
                .replace(/\{\{?phoneNumber\}\}?/gi, candidatePhone || 'N/A')
                .replace(/\{\{?roleTitle\}\}?/gi, roleTitle || 'Open Position')
                .replace(/\{\{?jobTitle\}\}?/gi, roleTitle || 'Open Position')
                .replace(/\{\{?designation\}\}?/gi, roleTitle || 'Open Position')
                .replace(/\{\{?roundName\}\}?/gi, roundDisplayName)
                .replace(/\{\{?interviewRound\}\}?/gi, roundDisplayName)
                .replace(/\{\{?scheduledDate\}\}?/gi, scheduledDateFormatted)
                .replace(/\{\{?interviewDate\}\}?/gi, scheduledDateFormatted)
                .replace(/\{\{?interviewTime\}\}?/gi, scheduledDateFormatted)
                .replace(/\{\{?interviewerName\}\}?/gi, interviewersList)
                .replace(/\{\{?clientName\}\}?/gi, clientName || 'Our Company')
                .replace(/\{\{?client\}\}?/gi, clientName || 'Our Company')
                .replace(/\{\{?companyName\}\}?/gi, clientName || 'Our Company')
                .replace(/\{\{?company\}\}?/gi, clientName || 'Our Company')
                .replace(/\{\{?location\}\}?/gi, candidateLocation || 'Online / Virtual')
                .replace(/\{\{?workLocation\}\}?/gi, candidateLocation || 'Online / Virtual')
                .replace(/\{\{?currentDate\}\}?/gi, new Date().toLocaleDateString('en-US', { dateStyle: 'medium' }))
                .replace(/\{\{?currentYear\}\}?/gi, String(new Date().getFullYear()));

            const isOriginalHtml = /<(p|div|table|tr|td|h[1-6]|ul|ol|li|br|strong|b|em|i)\b[^>]*>/i.test(text);

            if (isBody) {
                if (!isOriginalHtml) {
                    processed = processed.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
                    processed = processed.replace(/^(\s*)[\*\-]\s+(.+)$/gm, '$1&bull; $2');
                    processed = processed.replace(/\r\n|\r|\n/g, '<br />');
                }

                const hasCustomFieldsTag = /\{{1,2}(customFields|customFieldsTable|additionalDetails|custom_fields)\}{1,2}/i.test(processed);
                if (hasCustomFieldsTag) {
                    processed = processed.replace(/\{{1,2}(customFields|customFieldsTable|additionalDetails|custom_fields)\}{1,2}/gi, customFieldsHtml);
                } else if (customFieldsHtml) {
                    const signatureRegex = /(<p[^>]*>\s*)?\b(regards|best regards|kind regards|warm regards|thanks\s*&\s*regards|thanks|sincerely)\b([\s\S]*)/i;
                    if (signatureRegex.test(processed)) {
                        processed = processed.replace(signatureRegex, `${customFieldsHtml}<br />$1$2$3`);
                    } else {
                        processed += `<br />${customFieldsHtml}`;
                    }
                }
            } else {
                processed = processed.replace(/\{{1,2}(customFields|customFieldsTable|additionalDetails|custom_fields)\}{1,2}/gi, '');
            }
            return processed;
        };

        const defaultSubject = `Interview Scheduled: ${roundDisplayName} - ${candidateDisplayName}`;
        const defaultCandidateBody = `
            <div style="font-family: Arial, sans-serif; color: #334155; line-height: 1.6; max-width: 600px; margin: 0 auto; padding: 24px; border: 1px solid #e2e8f0; border-radius: 12px; background-color: #ffffff;">
                <h2 style="color: #2563eb; margin-top: 0; font-size: 20px; font-weight: bold;">Interview Invitation</h2>
                <p style="font-size: 15px; margin: 16px 0;">Hello <strong>{{candidateName}}</strong>,</p>
                <p style="font-size: 14px; margin: 12px 0;">We are pleased to inform you that your interview for <strong>{{roundName}}</strong>${roleTitle ? ` for the position of <strong>${roleTitle}</strong>` : ''} has been scheduled.</p>
                <div style="background-color: #f8fafc; border: 1px solid #e2e8f0; border-radius: 8px; padding: 16px; margin: 20px 0;">
                    <table style="width: 100%; border-collapse: collapse; font-size: 14px;">
                        <tr>
                            <td style="padding: 6px 0; color: #64748b; font-weight: 600; width: 35%;">Date & Time:</td>
                            <td style="padding: 6px 0; color: #0f172a; font-weight: 600;">{{scheduledDate}}</td>
                        </tr>
                        <tr>
                            <td style="padding: 6px 0; color: #64748b; font-weight: 600;">Interview Round:</td>
                            <td style="padding: 6px 0; color: #0f172a;">{{roundName}}</td>
                        </tr>
                        <tr>
                            <td style="padding: 6px 0; color: #64748b; font-weight: 600;">Interviewer(s):</td>
                            <td style="padding: 6px 0; color: #0f172a;">{{interviewerName}}</td>
                        </tr>
                        ${candidateLocation ? `
                        <tr>
                            <td style="padding: 6px 0; color: #64748b; font-weight: 600;">Location:</td>
                            <td style="padding: 6px 0; color: #0f172a;">${candidateLocation}</td>
                        </tr>` : ''}
                    </table>
                </div>
                ${customFieldsHtml}
                <p style="margin-top: 24px; font-size: 14px; color: #475569;">If you have any questions or need further details, feel free to reply to this email.</p>
                <p style="margin-top: 20px; font-size: 14px; color: #334155; line-height: 1.5;">
                    Best Regards,<br />
                    <strong>Talent Acquisition Team</strong>
                    ${clientName ? `<br /><span style="color: #64748b; font-size: 12px;">${clientName}</span>` : ''}
                </p>
            </div>
        `;

        const senderAccount = await resolveSenderAccountDetails(companyId, effectiveEmailAccountId);

        // 1. Send Candidate Email
        if (sendCandidateEmail !== false && candidate.email) {
            const rawSubjectText = effectiveCustomSubject || template?.subject;
            const rawBodyText = effectiveCustomHtmlBody || template?.htmlBody;

            const subject = rawSubjectText ? processTemplate(rawSubjectText, false) : defaultSubject;
            const htmlBody = rawBodyText ? processTemplate(rawBodyText, true) : processTemplate(defaultCandidateBody, true);
            let sendSuccess = false;
            let sendError = null;

            try {
                sendSuccess = await sendEmailForCompany({
                    companyId,
                    emailAccountId: effectiveEmailAccountId,
                    to: candidate.email,
                    cc: effectiveCc || undefined,
                    bcc: effectiveBcc || undefined,
                    subject,
                    html: htmlBody,
                    user,
                    throwOnError: true
                });
            } catch (candEmailErr) {
                sendError = candEmailErr;
                console.error('Error sending interview schedule email to candidate:', candEmailErr);
            }

            if (sendSuccess && !sendError) {
                await TAEmailLog.create({
                    companyId,
                    sentBy: user?._id || null,
                    senderEmail: senderAccount.fromAddress,
                    senderName: senderAccount.fromName || [user?.firstName, user?.lastName].filter(Boolean).join(' ') || 'Recruiter',
                    fromAddress: senderAccount.fromAddress,
                    fromName: senderAccount.fromName,
                    emailAccountId: senderAccount.emailAccountId,
                    emailAccountLabel: senderAccount.emailAccountLabel,
                    hiringRequestId: candidate.hiringRequestId?._id || candidate.hiringRequestId || null,
                    hiringRequestTitle: candidate.hiringRequestId?.roleDetails?.title || roleTitle || '',
                    candidateId: candidate._id,
                    recipientName: candidate.candidateName || `${candidate.firstName || ''} ${candidate.lastName || ''}`.trim() || 'Candidate',
                    recipientEmail: candidate.email,
                    cc: String(effectiveCc || ''),
                    bcc: String(effectiveBcc || ''),
                    templateId: template?._id || null,
                    templateName: template?.name || 'Interview Invitation',
                    subject,
                    body: htmlBody,
                    status: 'Sent',
                    sentAt: new Date()
                });

                const lastMailDetails = {
                    sentAt: new Date(),
                    subject,
                    htmlBody,
                    senderEmail: senderAccount.fromAddress || user?.email || '',
                    candidateEmail: candidate.email,
                    cc: String(effectiveCc || ''),
                    bcc: String(effectiveBcc || ''),
                    interviewers: Array.isArray(round.assignedTo) ? round.assignedTo.map(u => ({
                        name: typeof u === 'object' ? ([u.firstName, u.lastName].filter(Boolean).join(' ') || u.email || 'Interviewer') : String(u),
                        email: typeof u === 'object' ? u.email || '' : ''
                    })) : []
                };

                round.mailSent = true;
                round.mailSentAt = new Date();
                round.lastMailDetails = lastMailDetails;

                await Candidate.updateOne(
                    { _id: candidate._id, 'interviewRounds._id': round._id },
                    {
                        $set: {
                            'interviewRounds.$.mailSent': true,
                            'interviewRounds.$.mailSentAt': new Date(),
                            'interviewRounds.$.lastMailDetails': lastMailDetails
                        }
                    }
                );
            } else {
                try {
                    await TAEmailLog.create({
                        companyId,
                        sentBy: user?._id || null,
                        senderEmail: senderAccount.fromAddress,
                        senderName: senderAccount.fromName || [user?.firstName, user?.lastName].filter(Boolean).join(' ') || 'Recruiter',
                        fromAddress: senderAccount.fromAddress,
                        fromName: senderAccount.fromName,
                        emailAccountId: senderAccount.emailAccountId,
                        emailAccountLabel: senderAccount.emailAccountLabel,
                        hiringRequestId: candidate.hiringRequestId?._id || candidate.hiringRequestId || null,
                        hiringRequestTitle: candidate.hiringRequestId?.roleDetails?.title || roleTitle || '',
                        candidateId: candidate._id,
                        recipientName: candidate.candidateName || `${candidate.firstName || ''} ${candidate.lastName || ''}`.trim() || 'Candidate',
                        recipientEmail: candidate.email,
                        cc: String(effectiveCc || ''),
                        bcc: String(effectiveBcc || ''),
                        templateId: template?._id || null,
                        templateName: template?.name || 'Interview Invitation',
                        subject,
                        body: htmlBody,
                        status: 'Failed',
                        errorReason: sendError?.message || 'Email delivery failed',
                        sentAt: new Date()
                    });
                } catch (logErr) {}
            }
        }

        // 2. Send Interviewer(s) Notification
        if (sendInterviewerEmail !== false && Array.isArray(round.assignedTo) && round.assignedTo.length > 0) {
            for (const interviewerObj of round.assignedTo) {
                const email = typeof interviewerObj === 'object' ? interviewerObj.email : null;
                const interviewerName = typeof interviewerObj === 'object'
                    ? ([interviewerObj.firstName, interviewerObj.lastName].filter(Boolean).join(' ') || interviewerObj.email || 'Interviewer')
                    : 'Interviewer';
                if (email) {
                    const subject = `[Interviewer Notice] Interview Scheduled: ${round.levelName || 'Interview Round'} - ${candidate.candidateName}`;
                    const interviewerHtmlBody = `
                        <div style="font-family: Arial, sans-serif; color: #334155; line-height: 1.6; max-width: 600px; margin: 0 auto; padding: 20px; border: 1px solid #e2e8f0; border-radius: 12px;">
                            <h2 style="color: #2563eb; margin-top: 0;">New Interview Assignment</h2>
                            <p>Hello <strong>${interviewerName}</strong>,</p>
                            <p>You have been assigned to conduct an interview for candidate <strong>${candidate.candidateName}</strong> for the round <strong>${round.levelName || 'Interview Round'}</strong> (${roleTitle || 'Role'}).</p>
                            <div style="background: #f1f5f9; padding: 12px 16px; border-radius: 8px; margin: 16px 0;">
                                <p style="margin: 4px 0;"><strong>Candidate:</strong> ${candidate.candidateName} (${candidate.email || 'N/A'})</p>
                                <p style="margin: 4px 0;"><strong>Phone:</strong> ${candidatePhone || 'N/A'}</p>
                                <p style="margin: 4px 0;"><strong>Date & Time:</strong> ${scheduledDateFormatted}</p>
                                <p style="margin: 4px 0;"><strong>Role / Position:</strong> ${roleTitle || 'N/A'}</p>
                                ${candidateLocation ? `<p style="margin: 4px 0;"><strong>Location:</strong> ${candidateLocation}</p>` : ''}
                            </div>
                            ${customFieldsHtml}
                            <p style="margin-top: 20px; color: #64748b; font-size: 12px;">Please log in to your portal to submit evaluation feedback after the interview.</p>
                        </div>
                    `;

                    let intSuccess = false;
                    let intError = null;
                    try {
                        intSuccess = await sendEmailForCompany({
                            companyId,
                            emailAccountId: effectiveEmailAccountId,
                            to: email,
                            subject,
                            html: interviewerHtmlBody,
                            user,
                            throwOnError: true
                        });
                    } catch (intErr) {
                        intError = intErr;
                        console.error('Error sending interviewer schedule email:', intErr);
                    }

                    try {
                        await TAEmailLog.create({
                            companyId,
                            sentBy: user?._id || null,
                            senderEmail: senderAccount.fromAddress,
                            senderName: senderAccount.fromName || [user?.firstName, user?.lastName].filter(Boolean).join(' ') || 'Recruiter',
                            fromAddress: senderAccount.fromAddress,
                            fromName: senderAccount.fromName,
                            emailAccountId: senderAccount.emailAccountId,
                            emailAccountLabel: senderAccount.emailAccountLabel,
                            hiringRequestId: candidate.hiringRequestId?._id || candidate.hiringRequestId || null,
                            hiringRequestTitle: candidate.hiringRequestId?.roleDetails?.title || roleTitle || '',
                            candidateId: candidate._id,
                            recipientName: `[Interviewer] ${interviewerName}`,
                            recipientEmail: email,
                            templateId: template?._id || null,
                            templateName: 'Interviewer Notice',
                            subject,
                            body: interviewerHtmlBody,
                            status: intSuccess && !intError ? 'Sent' : 'Failed',
                            errorReason: intError?.message || (intSuccess ? undefined : 'Delivery failed'),
                            sentAt: new Date()
                        });
                    } catch (logErr) {}
                }
            }
        }
    } catch (err) {
        console.error('Error sending interview schedule email notifications:', err);
    }
};

// Add a new interview round
const addInterviewRound = async (req, res) => {
    try {
        const { id } = req.params;
        const { levelName, assignAfterStage, assignedTo, scheduledDate, phase, customFields, emailTemplateId, emailAccountId, cc, bcc, customSubject, customHtmlBody } = req.body;

        const roundLevelName = String(levelName || 'Round 1').trim() || 'Round 1';

        const candidate = await Candidate.findOne({ _id: id, companyId: req.companyId });
        if (!candidate) {
            return res.status(404).json({ message: 'Candidate not found' });
        }

        const { hasAccess } = await ensureCandidateCapability(candidate, req.companyId, req.user, TA_CAPABILITIES.SCHEDULE_INTERVIEW);
        if (!hasAccess) {
            return res.status(403).json({ message: 'Forbidden: You do not have permission to update this candidate' });
        }

        const FIXED_ASSIGN_AFTER_STAGES = new Set([
            'Total Sourced', 'Interested', 'Interview Scheduled', 'Shortlisted', 'Profile Shared',
            'Selected', 'Rejected', 'On Hold', 'Offer Released', 'Offer Sent', 'Offer Accepted',
            'Joined', 'In Interview', 'Did Not Turn Up', 'Left in between'
        ]);
        const normalizedAssignAfter = String(assignAfterStage || 'Shortlisted').trim();
        const existingRoundNames = new Set(
            (candidate.interviewRounds || []).map((r) => String(r.levelName || '').trim()).filter(Boolean)
        );
        if (normalizedAssignAfter && !FIXED_ASSIGN_AFTER_STAGES.has(normalizedAssignAfter) && !existingRoundNames.has(normalizedAssignAfter)) {
            return res.status(400).json({
                message: `Invalid assignAfterStage: "${normalizedAssignAfter}". Must be a known stage name or an existing round's level name.`
            });
        }

        const newRound = {
            levelName: roundLevelName,
            assignAfterStage: normalizedAssignAfter || 'Shortlisted',
            assignedTo: assignedTo || [],
            status: 'Pending',
            scheduledDate,
            phase: phase || 1,
            customFields: Array.isArray(customFields) ? customFields.filter(f => f.key && String(f.key).trim()) : [],
            emailTemplateId: emailTemplateId || null,
            emailAccountId: emailAccountId || null,
            cc: cc || '',
            bcc: bcc || '',
            customSubject: customSubject || '',
            customHtmlBody: customHtmlBody || ''
        };

        candidate.interviewRounds.push(newRound);
        await candidate.save();

        const savedRound = candidate.interviewRounds[candidate.interviewRounds.length - 1];
        const roundPhase = Number(savedRound?.phase) > 0 ? Number(savedRound.phase) : 1;

        const updatedCandidate = await Candidate.findOne({ _id: id, companyId: req.companyId })
            .populate('hiringRequestId', 'requestId client roleDetails')
            .populate('interviewRounds.assignedTo', 'firstName lastName email')
            .populate('interviewRounds.evaluatedBy', 'firstName lastName');

        const populatedRound = updatedCandidate.interviewRounds[updatedCandidate.interviewRounds.length - 1];

        // Create notification for assigned interviewers and emit real-time updates
        if (assignedTo && assignedTo.length > 0) {
            const io = req.app.get('io');
            const notifications = assignedTo.map(userId => ({
                user: userId,
                companyId: req.companyId,
                preferenceKey: 'interview_assigned',
                title: 'New Interview Assigned',
                message: `You have been assigned to evaluate ${candidate.candidateName} for the ${roundLevelName} round.`,
                type: 'Interview',
                link: `/ta/hiring-request/${candidate.hiringRequestId._id || candidate.hiringRequestId}/candidate/${candidate._id}/view?phase=${roundPhase}`,
                origin: req.headers.origin,
                metadata: {
                    candidateId: candidate._id,
                    roundId: savedRound?._id,
                    hiringRequestId: candidate.hiringRequestId._id || candidate.hiringRequestId,
                    phase: roundPhase
                }
            }));
            await NotificationService.createManyNotifications(io, notifications);

            // Also emit an 'interview_update' event to each assigned user to refresh their list
            assignedTo.forEach(userId => {
                NotificationService.emitToUser(io, userId, 'interview_update', {
                    candidateId: candidate._id,
                    candidateName: candidate.candidateName,
                    roundId: savedRound?._id
                });
            });
        }

        // Send email notifications to Candidate and/or Interviewer(s) only if explicitly requested
        const shouldSendCandidate = req.body.sendCandidateEmail !== undefined 
            ? (req.body.sendCandidateEmail !== false && req.body.sendCandidateEmail !== 'false') 
            : (req.body.sendEmail !== undefined ? (req.body.sendEmail !== false && req.body.sendEmail !== 'false') : false);
        const shouldSendInterviewer = req.body.sendInterviewerEmail !== undefined 
            ? (req.body.sendInterviewerEmail !== false && req.body.sendInterviewerEmail !== 'false') 
            : (req.body.sendEmail !== undefined ? (req.body.sendEmail !== false && req.body.sendEmail !== 'false') : false);

        if (shouldSendCandidate || shouldSendInterviewer) {
            sendInterviewScheduleEmails({
                companyId: req.companyId,
                candidate: updatedCandidate,
                round: populatedRound,
                user: req.user,
                cc,
                bcc,
                emailAccountId,
                customSubject,
                customHtmlBody,
                sendCandidateEmail: shouldSendCandidate,
                sendInterviewerEmail: shouldSendInterviewer
            });
        }

        res.status(201).json({
            message: 'Interview round added successfully',
            round: populatedRound,
            candidate: updatedCandidate
        });
    } catch (error) {
        console.error('Error adding interview round:', error);
        res.status(500).json({ message: 'Server error', error: error.message });
    }
};

// Update an existing interview round
const updateInterviewRound = async (req, res) => {
    try {
        const { id, roundId } = req.params;
        const { levelName, assignAfterStage, assignedTo, scheduledDate, phase, customFields, emailTemplateId, emailAccountId, cc, bcc, sendEmail, sendCandidateEmail, sendInterviewerEmail, status, rating, feedback, evaluatedBy, customSubject, customHtmlBody } = req.body;

        const candidate = await Candidate.findOne({ _id: id, companyId: req.companyId });
        if (!candidate) {
            return res.status(404).json({ message: 'Candidate not found' });
        }

        const { hasAccess } = await ensureCandidateCapability(candidate, req.companyId, req.user, TA_CAPABILITIES.SCHEDULE_INTERVIEW);
        if (!hasAccess) {
            return res.status(403).json({ message: 'Forbidden: You do not have permission to update this candidate' });
        }

        if (roundId === 'phase2-imported-interview') {
            const newRoundLevelName = String(levelName || 'Round 1').trim() || 'Round 1';
            const newRound = {
                levelName: newRoundLevelName,
                assignAfterStage: assignAfterStage || 'Shortlisted',
                assignedTo: Array.isArray(assignedTo) ? assignedTo : (assignedTo ? [assignedTo] : []),
                scheduledDate: scheduledDate || null,
                phase: 2,
                status: status || candidate.phase2InterviewStatus || 'Scheduled',
                feedback: feedback !== undefined ? feedback : (candidate.phase2InterviewerFeedback || ''),
                rating: (rating !== null && rating !== '' && !isNaN(Number(rating))) ? Number(rating) : undefined,
                customFields: Array.isArray(customFields) ? customFields.filter(f => f.key && String(f.key).trim()) : [],
                customSubject: customSubject || '',
                customHtmlBody: customHtmlBody || ''
            };
            if (!Array.isArray(candidate.interviewRounds)) {
                candidate.interviewRounds = [];
            }
            candidate.interviewRounds.push(newRound);
            candidate.phase2InterviewerFeedback = '';
            candidate.phase2InterviewStatus = 'None';
            await candidate.save();

            const updatedCandidate = await Candidate.findOne({ _id: id, companyId: req.companyId })
                .populate('hiringRequestId', 'requestId client roleDetails')
                .populate('interviewRounds.assignedTo', 'firstName lastName email')
                .populate('interviewRounds.evaluatedBy', 'firstName lastName');

            const createdRound = updatedCandidate.interviewRounds[updatedCandidate.interviewRounds.length - 1];
            return res.status(200).json({
                message: 'Phase 2 interview card updated and saved successfully',
                round: createdRound,
                candidate: updatedCandidate
            });
        }

        const round = candidate.interviewRounds.id(roundId);
        if (!round) {
            return res.status(404).json({ message: 'Interview round not found' });
        }

        if (levelName !== undefined) round.levelName = String(levelName).trim() || 'Round 1';
        if (assignAfterStage !== undefined) round.assignAfterStage = assignAfterStage;
        if (assignedTo !== undefined) round.assignedTo = assignedTo;
        if (scheduledDate !== undefined) round.scheduledDate = scheduledDate;
        if (phase !== undefined) round.phase = phase;
        if (customFields !== undefined) round.customFields = Array.isArray(customFields) ? customFields.filter(f => f.key && String(f.key).trim()) : [];
        if (emailTemplateId !== undefined) round.emailTemplateId = emailTemplateId || null;
        if (emailAccountId !== undefined) round.emailAccountId = emailAccountId || null;
        if (cc !== undefined) round.cc = cc || '';
        if (bcc !== undefined) round.bcc = bcc || '';
        if (customSubject !== undefined) round.customSubject = customSubject || '';
        if (customHtmlBody !== undefined) round.customHtmlBody = customHtmlBody || '';

        if (status !== undefined) round.status = status;
        if (rating !== undefined) round.rating = (rating !== null && rating !== '' && !isNaN(Number(rating))) ? Number(rating) : undefined;
        if (feedback !== undefined) round.feedback = feedback;
        if (evaluatedBy !== undefined) round.evaluatedBy = evaluatedBy || req.user._id;
        if (feedback || rating !== undefined || ['Passed', 'Failed', 'Skipped', 'Shortlisted', 'Rejected', 'Did Not Turn Up', 'Did not turn up', 'Left in between', 'Left In Between'].includes(status)) {
            if (!round.evaluatedAt) round.evaluatedAt = new Date();
        }

        await candidate.save();

        const updatedCandidate = await Candidate.findOne({ _id: id, companyId: req.companyId })
            .populate('hiringRequestId', 'requestId client roleDetails')
            .populate('interviewRounds.assignedTo', 'firstName lastName email')
            .populate('interviewRounds.evaluatedBy', 'firstName lastName');

        const updatedRound = updatedCandidate.interviewRounds.id(roundId);

        const io = req.app.get('io');
        // Notify assigned interviewers about the update
        if (updatedRound && updatedRound.assignedTo) {
            updatedRound.assignedTo.forEach(user => {
                const userId = user._id || user;
                NotificationService.emitToUser(io, userId, 'interview_update', {
                    candidateId: updatedCandidate._id,
                    candidateName: updatedCandidate.candidateName,
                    roundId: roundId,
                    type: 'UPDATE'
                });
            });
        }

        // Send email notifications ONLY if explicitly requested via sendEmail flag
        const shouldSendCandidate = sendCandidateEmail !== undefined 
            ? (sendCandidateEmail !== false && sendCandidateEmail !== 'false') 
            : (sendEmail !== undefined ? (sendEmail !== false && sendEmail !== 'false') : true);
        const shouldSendInterviewer = sendInterviewerEmail !== undefined 
            ? (sendInterviewerEmail !== false && sendInterviewerEmail !== 'false') 
            : (sendEmail !== undefined ? (sendEmail !== false && sendEmail !== 'false') : true);

        if (sendEmail && updatedRound && (shouldSendCandidate || shouldSendInterviewer)) {
            sendInterviewScheduleEmails({
                companyId: req.companyId,
                candidate: updatedCandidate,
                round: updatedRound,
                user: req.user,
                cc,
                bcc,
                emailAccountId,
                customSubject: customSubject !== undefined ? customSubject : round.customSubject,
                customHtmlBody: customHtmlBody !== undefined ? customHtmlBody : round.customHtmlBody,
                sendCandidateEmail: shouldSendCandidate,
                sendInterviewerEmail: shouldSendInterviewer
            });
        }

        res.status(200).json({
            message: 'Interview round updated successfully',
            round: updatedRound,
            candidate: updatedCandidate
        });
    } catch (error) {
        console.error('Error updating interview round:', error);
        res.status(500).json({ message: 'Server error', error: error.message });
    }
};

// Send mail explicitly per interview round
const sendInterviewRoundEmail = async (req, res) => {
    try {
        const { id, roundId } = req.params;
        const { emailTemplateId, emailAccountId, cc, bcc, customFields, customSubject, customHtmlBody } = req.body;

        const candidate = await Candidate.findOne({ _id: id, companyId: req.companyId });
        if (!candidate) {
            return res.status(404).json({ message: 'Candidate not found' });
        }

        const { hasAccess } = await ensureCandidateCapability(candidate, req.companyId, req.user, TA_CAPABILITIES.SCHEDULE_INTERVIEW);
        if (!hasAccess) {
            return res.status(403).json({ message: 'Forbidden: You do not have permission to send emails for this candidate' });
        }

        const round = candidate.interviewRounds.id(roundId);
        if (!round) {
            return res.status(404).json({ message: 'Interview round not found' });
        }

        if (emailTemplateId !== undefined) round.emailTemplateId = emailTemplateId || null;
        if (emailAccountId !== undefined) round.emailAccountId = emailAccountId || null;
        if (cc !== undefined) round.cc = cc || '';
        if (bcc !== undefined) round.bcc = bcc || '';
        if (Array.isArray(customFields)) {
            round.customFields = customFields.filter(f => f.key && String(f.key).trim());
        }
        await candidate.save();

        const updatedCandidate = await Candidate.findOne({ _id: id, companyId: req.companyId })
            .populate('hiringRequestId', 'requestId client roleDetails')
            .populate('interviewRounds.assignedTo', 'firstName lastName email')
            .populate('interviewRounds.evaluatedBy', 'firstName lastName');

        const updatedRound = updatedCandidate.interviewRounds.id(roundId);

        const shouldSendCandidate = req.body.sendCandidateEmail !== undefined 
            ? (req.body.sendCandidateEmail !== false && req.body.sendCandidateEmail !== 'false') 
            : (req.body.sendInterviewerEmail === undefined ? true : false);
        const shouldSendInterviewer = req.body.sendInterviewerEmail !== undefined 
            ? (req.body.sendInterviewerEmail !== false && req.body.sendInterviewerEmail !== 'false') 
            : (req.body.sendCandidateEmail === undefined ? true : false);

        await sendInterviewScheduleEmails({
            companyId: req.companyId,
            candidate: updatedCandidate,
            round: updatedRound,
            user: req.user,
            cc: cc !== undefined ? cc : round.cc,
            bcc: bcc !== undefined ? bcc : round.bcc,
            emailAccountId: emailAccountId || round.emailAccountId,
            customSubject,
            customHtmlBody,
            sendCandidateEmail: shouldSendCandidate,
            sendInterviewerEmail: shouldSendInterviewer
        });

        res.status(200).json({
            message: 'Interview round email sent successfully',
            round: updatedRound
        });
    } catch (error) {
        console.error('Error sending interview round email:', error);
        res.status(500).json({ message: 'Failed to send interview round email', error: error.message });
    }
};

// Get preview details of the email for an interview round
const previewInterviewRoundEmail = async (req, res) => {
    try {
        const { id, roundId } = req.params;
        const emailTemplateId = req.query.emailTemplateId || req.body?.emailTemplateId;
        
        let customFieldsInput = req.body?.customFields || null;
        if (!customFieldsInput && req.query.customFields) {
            try {
                customFieldsInput = JSON.parse(req.query.customFields);
            } catch (e) {
                customFieldsInput = null;
            }
        }

        const candidate = await Candidate.findOne({ _id: id, companyId: req.companyId })
            .populate('hiringRequestId', 'requestId client roleDetails')
            .populate('interviewRounds.assignedTo', 'firstName lastName email');

        if (!candidate) {
            return res.status(404).json({ message: 'Candidate not found' });
        }

        const round = candidate.interviewRounds.id(roundId);
        if (!round) {
            return res.status(404).json({ message: 'Interview round not found' });
        }

        const effectiveTemplateId = emailTemplateId || round.emailTemplateId;
        let template = null;
        if (effectiveTemplateId) {
            template = await EmailTemplate.findById(effectiveTemplateId).lean();
        }

        const roleTitle = candidate.hiringRequestId?.roleDetails?.title || candidate.roleTitle || candidate.position || '';
        const clientName = candidate.hiringRequestId?.client || candidate.companyName || '';
        const candidateLocation = candidate.currentLocation || candidate.location || candidate.currentCity || candidate.hiringRequestId?.requirements?.location || '';
        const candidatePhone = candidate.mobile || candidate.phone || candidate.phoneNumber || '';
        const candidateDisplayName = candidate.candidateName || [candidate.firstName, candidate.lastName].filter(Boolean).join(' ') || candidate.name || 'Candidate';
        const roundDisplayName = round.levelName || round.name || 'Interview Round';

        const scheduledDateFormatted = round.scheduledDate
            ? new Date(round.scheduledDate).toLocaleString('en-US', { dateStyle: 'full', timeStyle: 'short' })
            : 'To Be Confirmed / Scheduled Soon';

        const assignedInterviewers = Array.isArray(round.assignedTo) ? round.assignedTo : [];
        const interviewersList = assignedInterviewers.length > 0
            ? assignedInterviewers
                .map(u => typeof u === 'object' ? ([u.firstName, u.lastName].filter(Boolean).join(' ') || u.email || 'Interviewer') : String(u))
                .filter(Boolean)
                .join(', ')
            : 'Will be shared prior to session';

        let customFieldsHtml = '';
        const fieldsToUse = Array.isArray(customFieldsInput) ? customFieldsInput : round.customFields;
        const validFields = Array.isArray(fieldsToUse) ? fieldsToUse.filter(f => f.key && String(f.key).trim()) : [];
        if (validFields.length > 0) {
            const rowsHtml = validFields.map(f => `
                <tr>
                    <td style="padding: 8px 12px; font-weight: bold; color: #334155; border-bottom: 1px solid #e2e8f0; width: 35%;">${f.key}:</td>
                    <td style="padding: 8px 12px; color: #0f172a; border-bottom: 1px solid #e2e8f0;">${f.value || 'N/A'}</td>
                </tr>
            `).join('');

            customFieldsHtml = `
                <div style="margin-top: 20px; padding: 16px; background-color: #f8fafc; border-radius: 12px; border: 1px solid #cbd5e1;">
                    <h4 style="margin: 0 0 12px 0; color: #1e293b; font-size: 14px; font-weight: bold;">Interview Details & Additional Information:</h4>
                    <table style="width: 100%; border-collapse: collapse; font-size: 13px;">
                        ${rowsHtml}
                    </table>
                </div>
            `;
        }

        const processTemplate = (text, isBody = false) => {
            if (!text) return '';
            const candFirstName = candidateDisplayName ? candidateDisplayName.split(' ')[0] : 'Candidate';
            const candLastName = candidateDisplayName ? candidateDisplayName.split(' ').slice(1).join(' ') : '';

            let processed = text
                .replace(/\{\{?candidateName\}\}?/gi, candidateDisplayName)
                .replace(/\{\{?fullName\}\}?/gi, candidateDisplayName)
                .replace(/\{\{?firstName\}\}?/gi, candFirstName)
                .replace(/\{\{?lastName\}\}?/gi, candLastName)
                .replace(/\{\{?candidateEmail\}\}?/gi, candidate.email || '')
                .replace(/\{\{?workEmail\}\}?/gi, candidate.email || '')
                .replace(/\{\{?email\}\}?/gi, candidate.email || '')
                .replace(/\{\{?phone\}\}?/gi, candidatePhone || 'N/A')
                .replace(/\{\{?mobile\}\}?/gi, candidatePhone || 'N/A')
                .replace(/\{\{?phoneNumber\}\}?/gi, candidatePhone || 'N/A')
                .replace(/\{\{?roleTitle\}\}?/gi, roleTitle || 'Open Position')
                .replace(/\{\{?jobTitle\}\}?/gi, roleTitle || 'Open Position')
                .replace(/\{\{?designation\}\}?/gi, roleTitle || 'Open Position')
                .replace(/\{\{?roundName\}\}?/gi, roundDisplayName)
                .replace(/\{\{?interviewRound\}\}?/gi, roundDisplayName)
                .replace(/\{\{?scheduledDate\}\}?/gi, scheduledDateFormatted)
                .replace(/\{\{?interviewDate\}\}?/gi, scheduledDateFormatted)
                .replace(/\{\{?interviewTime\}\}?/gi, scheduledDateFormatted)
                .replace(/\{\{?interviewerName\}\}?/gi, interviewersList)
                .replace(/\{\{?clientName\}\}?/gi, clientName || 'Our Company')
                .replace(/\{\{?client\}\}?/gi, clientName || 'Our Company')
                .replace(/\{\{?companyName\}\}?/gi, clientName || 'Our Company')
                .replace(/\{\{?company\}\}?/gi, clientName || 'Our Company')
                .replace(/\{\{?location\}\}?/gi, candidateLocation || 'Online / Virtual')
                .replace(/\{\{?workLocation\}\}?/gi, candidateLocation || 'Online / Virtual')
                .replace(/\{\{?currentDate\}\}?/gi, new Date().toLocaleDateString('en-US', { dateStyle: 'medium' }))
                .replace(/\{\{?currentYear\}\}?/gi, String(new Date().getFullYear()));

            const isOriginalHtml = /<(p|div|table|tr|td|h[1-6]|ul|ol|li|br|strong|b|em|i)\b[^>]*>/i.test(text);

            if (isBody) {
                if (!isOriginalHtml) {
                    processed = processed.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
                    processed = processed.replace(/^(\s*)[\*\-]\s+(.+)$/gm, '$1&bull; $2');
                    processed = processed.replace(/\r\n|\r|\n/g, '<br />');
                }

                const hasCustomFieldsTag = /\{{1,2}(customFields|customFieldsTable|additionalDetails|custom_fields)\}{1,2}/i.test(processed);
                if (hasCustomFieldsTag) {
                    processed = processed.replace(/\{{1,2}(customFields|customFieldsTable|additionalDetails|custom_fields)\}{1,2}/gi, customFieldsHtml);
                } else if (customFieldsHtml) {
                    const signatureRegex = /(<p[^>]*>\s*)?\b(regards|best regards|kind regards|warm regards|thanks\s*&\s*regards|thanks|sincerely)\b([\s\S]*)/i;
                    if (signatureRegex.test(processed)) {
                        processed = processed.replace(signatureRegex, `${customFieldsHtml}<br />$1$2$3`);
                    } else {
                        processed += `<br />${customFieldsHtml}`;
                    }
                }
            } else {
                processed = processed.replace(/\{{1,2}(customFields|customFieldsTable|additionalDetails|custom_fields)\}{1,2}/gi, '');
            }
            return processed;
        };

        const defaultSubject = `Interview Scheduled: ${roundDisplayName} - ${candidateDisplayName}`;
        const defaultCandidateBody = `
            <div style="font-family: Arial, sans-serif; color: #334155; line-height: 1.6; max-width: 600px; margin: 0 auto; padding: 24px; border: 1px solid #e2e8f0; border-radius: 12px; background-color: #ffffff;">
                <h2 style="color: #2563eb; margin-top: 0; font-size: 20px; font-weight: bold;">Interview Invitation</h2>
                <p style="font-size: 15px; margin: 16px 0;">Hello <strong>{{candidateName}}</strong>,</p>
                <p style="font-size: 14px; margin: 12px 0;">We are pleased to inform you that your interview for <strong>{{roundName}}</strong>${roleTitle ? ` for the position of <strong>${roleTitle}</strong>` : ''} has been scheduled.</p>
                <div style="background-color: #f8fafc; border: 1px solid #e2e8f0; border-radius: 8px; padding: 16px; margin: 20px 0;">
                    <table style="width: 100%; border-collapse: collapse; font-size: 14px;">
                        <tr>
                            <td style="padding: 6px 0; color: #64748b; font-weight: 600; width: 35%;">Date & Time:</td>
                            <td style="padding: 6px 0; color: #0f172a; font-weight: 600;">{{scheduledDate}}</td>
                        </tr>
                        <tr>
                            <td style="padding: 6px 0; color: #64748b; font-weight: 600;">Interview Round:</td>
                            <td style="padding: 6px 0; color: #0f172a;">{{roundName}}</td>
                        </tr>
                        <tr>
                            <td style="padding: 6px 0; color: #64748b; font-weight: 600;">Interviewer(s):</td>
                            <td style="padding: 6px 0; color: #0f172a;">{{interviewerName}}</td>
                        </tr>
                        ${candidateLocation ? `
                        <tr>
                            <td style="padding: 6px 0; color: #64748b; font-weight: 600;">Location:</td>
                            <td style="padding: 6px 0; color: #0f172a;">${candidateLocation}</td>
                        </tr>` : ''}
                    </table>
                </div>
                ${customFieldsHtml}
                <p style="margin-top: 24px; font-size: 14px; color: #475569;">If you have any questions or need further details, feel free to reply to this email.</p>
                <p style="margin-top: 20px; font-size: 14px; color: #334155; line-height: 1.5;">
                    Best Regards,<br />
                    <strong>Talent Acquisition Team</strong>
                    ${clientName ? `<br /><span style="color: #64748b; font-size: 12px;">${clientName}</span>` : ''}
                </p>
            </div>
        `;

        const customSubjectInput = req.body?.customSubject || req.query?.customSubject;
        const customHtmlBodyInput = req.body?.customHtmlBody || req.query?.customHtmlBody;

        const rawSubject = customSubjectInput || template?.subject || defaultSubject;
        const rawBody = customHtmlBodyInput || template?.htmlBody || defaultCandidateBody;

        const subject = processTemplate(rawSubject, false);
        const htmlBody = processTemplate(rawBody, true);

        const interviewerSubject = `[Interviewer Notice] Interview Scheduled: ${round.levelName || 'Interview Round'} - ${candidate.candidateName}`;
        const interviewerHtmlBody = `
            <div style="font-family: Arial, sans-serif; color: #334155; line-height: 1.6; max-width: 600px; margin: 0 auto; padding: 20px; border: 1px solid #e2e8f0; border-radius: 12px;">
                <h2 style="color: #2563eb; margin-top: 0;">New Interview Assignment</h2>
                <p>Hello <strong>${interviewersList}</strong>,</p>
                <p>You have been assigned to conduct an interview for candidate <strong>${candidate.candidateName}</strong> for the round <strong>${round.levelName || 'Interview Round'}</strong> (${roleTitle || 'Role'}).</p>
                <div style="background: #f1f5f9; padding: 12px 16px; border-radius: 8px; margin: 16px 0;">
                    <p style="margin: 4px 0;"><strong>Candidate:</strong> ${candidate.candidateName} (${candidate.email || 'N/A'})</p>
                    <p style="margin: 4px 0;"><strong>Phone:</strong> ${candidatePhone || 'N/A'}</p>
                    <p style="margin: 4px 0;"><strong>Date & Time:</strong> ${scheduledDateFormatted}</p>
                    <p style="margin: 4px 0;"><strong>Role / Position:</strong> ${roleTitle || 'N/A'}</p>
                    ${candidateLocation ? `<p style="margin: 4px 0;"><strong>Location:</strong> ${candidateLocation}</p>` : ''}
                </div>
                ${customFieldsHtml}
                <p style="margin-top: 20px; color: #64748b; font-size: 12px;">Please log in to your portal to submit evaluation feedback after the interview.</p>
            </div>
        `;

        res.status(200).json({
            candidateName: candidate.candidateName,
            candidateEmail: candidate.email,
            interviewers: assignedInterviewers.map(u => ({
                name: typeof u === 'object' ? ([u.firstName, u.lastName].filter(Boolean).join(' ') || u.email || 'Interviewer') : String(u),
                email: typeof u === 'object' ? u.email || '' : ''
            })),
            subject,
            htmlBody,
            rawSubject,
            rawBody,
            interviewerSubject,
            interviewerHtmlBody,
            customFields: validFields,
            scheduledDateFormatted,
            cc: round.cc || '',
            bcc: round.bcc || ''
        });
    } catch (error) {
        console.error('Error previewing interview round email:', error);
        res.status(500).json({ message: 'Failed to preview email', error: error.message });
    }
};

// Delete an interview round
const deleteInterviewRound = async (req, res) => {
    try {
        const { id, roundId } = req.params;

        const candidate = await Candidate.findOne({ _id: id, companyId: req.companyId });
        if (!candidate) {
            return res.status(404).json({ message: 'Candidate not found' });
        }

        const { hasAccess } = await ensureCandidateCapability(candidate, req.companyId, req.user, TA_CAPABILITIES.EDIT);
        if (!hasAccess) {
            return res.status(403).json({ message: 'Forbidden: You do not have permission to update this candidate' });
        }

        const round = candidate.interviewRounds.id(roundId);
        if (!round) {
            return res.status(404).json({ message: 'Interview round not found' });
        }

        candidate.interviewRounds.pull(roundId);
        await candidate.save();

        res.status(200).json({ message: 'Interview round deleted successfully' });
    } catch (error) {
        console.error('Error deleting interview round:', error);
        res.status(500).json({ message: 'Server error', error: error.message });
    }
};

// Get current user's scheduled interviews
const getMyScheduledInterviews = async (req, res) => {
    try {
        const userId = req.user._id;

        const candidates = await Candidate.find(await buildAccessibleCandidateQuery(req.companyId, req.user, {
            'interviewRounds': {
                $elemMatch: {
                    $or: [
                        { assignedTo: userId },
                        { evaluatedBy: userId }
                    ],
                    status: { $in: ['Pending', 'Scheduled', 'Passed', 'Failed'] },
                    scheduledDate: { $type: 'date' }
                }
            }
        }, { capability: TA_CAPABILITIES.EVALUATE_ROUND }))
            .populate('hiringRequestId', 'requestId roleDetails')
            .select('candidateName email mobile interviewRounds hiringRequestId');

        const scheduledInterviews = [];

        candidates.forEach(candidate => {
            candidate.interviewRounds.forEach(round => {
                const hasScheduledDate = Boolean(round.scheduledDate);
                const isAssigned = round.assignedTo.some(id => id.toString() === userId.toString());
                const isEvaluatedByMe = round.evaluatedBy && round.evaluatedBy.toString() === userId.toString();
                if ((isAssigned || isEvaluatedByMe) && hasScheduledDate && ['Pending', 'Scheduled', 'Passed', 'Failed'].includes(round.status)) {
                    scheduledInterviews.push({
                        candidateId: candidate._id,
                        candidateName: candidate.candidateName,
                        candidateEmail: candidate.email,
                        candidateMobile: candidate.mobile,
                        role: candidate.hiringRequestId?.roleDetails?.title || 'Unknown Role',
                        hiringRequestId: candidate.hiringRequestId?._id,
                        roundId: round._id,
                        phase: round.phase || 1,
                        levelName: round.levelName,
                        scheduledDate: round.scheduledDate,
                        status: ['Passed', 'Failed'].includes(round.status) ? round.status : 'Scheduled',
                        rawStatus: round.status
                    });
                }
            });
        });

        scheduledInterviews.sort((a, b) => {
            if (!a.scheduledDate) return 1;
            if (!b.scheduledDate) return -1;
            return new Date(a.scheduledDate) - new Date(b.scheduledDate);
        });

        res.status(200).json(scheduledInterviews);
    } catch (error) {
        console.error('Error fetching user interviews:', error);
        res.status(500).json({ message: 'Server error fetching scheduled interviews', error: error.message });
    }
};

// Evaluate an interview round
const evaluateInterviewRound = async (req, res) => {
    try {
        const { id, roundId } = req.params;
        const { status, feedback, rating, skillRatings } = req.body;

        const validStatuses = ['Passed', 'Failed', 'Skipped', 'Did Not Turn Up', 'Did not turn up', 'Left in between', 'Left In Between'];
        if (!validStatuses.includes(status)) {
            return res.status(400).json({ message: 'Status must be Passed, Failed, Skipped, Did Not Turn Up, or Left in between' });
        }

        if (!feedback) {
            return res.status(400).json({ message: 'Feedback is required for evaluation' });
        }

        const candidate = await Candidate.findOne({ _id: id, companyId: req.companyId });
        if (!candidate) {
            return res.status(404).json({ message: 'Candidate not found' });
        }

        const round = candidate.interviewRounds.id(roundId);
        if (!round) {
            return res.status(404).json({ message: 'Interview round not found' });
        }

        const { hasAccess } = await ensureCandidateCapability(
            candidate,
            req.companyId,
            req.user,
            TA_CAPABILITIES.EVALUATE_ROUND,
            { roundId }
        );
        if (!hasAccess) {
            return res.status(403).json({ message: 'Forbidden: You are not authorized to evaluate this round' });
        }

        const userPermissions = Array.isArray(req.user?.permissions)
            ? req.user.permissions
            : (req.user?.roles || []).flatMap((role) => (role.permissions || []).map((permission) => permission.key));
        const hasSuperApprove = userPermissions.includes('ta.super_approve') || userPermissions.includes('*');
        const isAssigned = round.assignedTo.some(id => (id._id || id).toString() === req.user._id.toString());

        if (!isAssigned && !hasSuperApprove) {
            return res.status(403).json({ message: 'Forbidden: You are not authorized to evaluate this round' });
        }

        round.status = status;
        round.feedback = feedback;
        round.evaluatedBy = req.user._id;
        round.evaluatedAt = new Date();

        if (rating !== undefined && rating !== null && rating !== '') {
            const parsedRating = parseInt(rating, 10);
            if (parsedRating >= 1 && parsedRating <= 10) {
                round.rating = parsedRating;
            }
        } else {
            round.rating = undefined;
        }

        if (skillRatings && Array.isArray(skillRatings)) {
            round.skillRatings = skillRatings.map(sr => ({
                skill: sr.skill,
                rating: sr.rating,
                category: sr.category
            }));

            skillRatings.forEach(newSr => {
                const globalSrIndex = candidate.skillRatings.findIndex(s => s.skill === newSr.skill);
                if (globalSrIndex !== -1) {
                    candidate.skillRatings[globalSrIndex].rating = newSr.rating;
                } else {
                    candidate.skillRatings.push({
                        skill: newSr.skill,
                        rating: newSr.rating,
                        category: newSr.category || 'Additional'
                    });
                }
            });
        }

        await candidate.save();

        const updatedCandidate = await Candidate.findOne({ _id: id, companyId: req.companyId })
            .populate('interviewRounds.assignedTo', 'firstName lastName email')
            .populate('interviewRounds.evaluatedBy', 'firstName lastName');

        const io = req.app.get('io');
        if (updatedCandidate.interviewRounds.id(roundId).assignedTo) {
            updatedCandidate.interviewRounds.id(roundId).assignedTo.forEach(user => {
                const userId = user._id || user;
                NotificationService.emitToUser(io, userId, 'interview_update', {
                    candidateId: updatedCandidate._id,
                    candidateName: updatedCandidate.candidateName,
                    roundId: roundId,
                    type: 'EVALUATED',
                    status: status
                });
            });
        }

        res.status(200).json({
            message: `Round evaluated as ${status}`,
            round: updatedCandidate.interviewRounds.id(roundId),
            candidate: updatedCandidate
        });
    } catch (error) {
        console.error('Error evaluating interview round:', error);
        res.status(500).json({ message: 'Server error', error: error.message });
    }
};

// Bulk schedule interviews
const bulkScheduleInterview = async (req, res) => {
    try {
        const { candidateIds, rounds: reqRounds, levelName, assignedTo, scheduledDate, phase, customFields, emailTemplateId, emailAccountId, cc, bcc, customSubject, customHtmlBody, sendEmail, emailCandidateIds } = req.body;

        if (!Array.isArray(candidateIds) || candidateIds.length === 0) {
            return res.status(400).json({ message: 'At least one candidate must be selected' });
        }

        const validCandidateIds = candidateIds.filter((id) => mongoose.Types.ObjectId.isValid(id));
        if (validCandidateIds.length === 0) {
            return res.status(400).json({ message: 'No valid candidate IDs provided' });
        }

        let roundsToSchedule = [];
        if (Array.isArray(reqRounds) && reqRounds.length > 0) {
            roundsToSchedule = reqRounds.filter(r => r.levelName && String(r.levelName).trim());
        } else if (levelName && String(levelName).trim()) {
            roundsToSchedule = [{
                levelName: String(levelName).trim(),
                assignedTo,
                scheduledDate,
                phase,
                customFields,
                emailTemplateId,
                emailAccountId,
                cc,
                bcc,
                customSubject,
                customHtmlBody,
                sendEmail,
                emailCandidateIds
            }];
        }

        if (roundsToSchedule.length === 0) {
            return res.status(400).json({ message: 'At least one interview round with a valid name is required' });
        }

        const candidates = await Candidate.find({
            _id: { $in: validCandidateIds },
            companyId: req.companyId
        }).populate('hiringRequestId', 'requestId roleDetails');

        if (candidates.length === 0) {
            return res.status(404).json({ message: 'No candidates found for the given IDs' });
        }

        let scheduled = 0;
        const failed = [];
        const scheduledCandidateNames = [];
        const allAssignedUserIds = new Set();

        for (const candidate of candidates) {
            try {
                const { hasAccess } = await ensureCandidateCapability(
                    candidate,
                    req.companyId,
                    req.user,
                    TA_CAPABILITIES.SCHEDULE_INTERVIEW
                );

                if (!hasAccess) {
                    failed.push({
                        candidateId: candidate._id,
                        candidateName: candidate.candidateName,
                        reason: 'Permission denied'
                    });
                    continue;
                }

                for (const roundConfig of roundsToSchedule) {
                    const roundPhase = Number(roundConfig.phase) > 0 ? Number(roundConfig.phase) : 1;
                    const normalizedAssignedTo = Array.isArray(roundConfig.assignedTo)
                        ? roundConfig.assignedTo.filter((id) => mongoose.Types.ObjectId.isValid(id))
                        : [];

                    normalizedAssignedTo.forEach(id => allAssignedUserIds.add(id.toString()));

                    const defaultAnchor = roundPhase === 2 ? 'Shortlisted' : 'Interested';
                    const rawAnchor = String(roundConfig.assignAfterStage || defaultAnchor).trim() || defaultAnchor;
                    const normalizedAnchor = (rawAnchor === 'Interview Scheduled' || !rawAnchor) ? defaultAnchor : rawAnchor;

                    const newRound = {
                        levelName: String(roundConfig.levelName || 'Round 1').trim() || 'Round 1',
                        assignAfterStage: normalizedAnchor,
                        assignedTo: normalizedAssignedTo,
                        status: 'Pending',
                        scheduledDate: roundConfig.scheduledDate || undefined,
                        phase: roundPhase,
                        customFields: Array.isArray(roundConfig.customFields) ? roundConfig.customFields.filter(f => f.key && String(f.key).trim()) : [],
                        emailTemplateId: roundConfig.emailTemplateId || null,
                        emailAccountId: roundConfig.emailAccountId || null,
                        cc: roundConfig.cc || '',
                        bcc: roundConfig.bcc || '',
                        customSubject: roundConfig.customSubject || '',
                        customHtmlBody: roundConfig.customHtmlBody || ''
                    };

                    candidate.interviewRounds.push(newRound);
                    await candidate.save();

                    const updatedCandidate = await Candidate.findOne({ _id: candidate._id, companyId: req.companyId })
                        .populate('hiringRequestId', 'requestId client roleDetails')
                        .populate('interviewRounds.assignedTo', 'firstName lastName email');

                    const savedRound = updatedCandidate.interviewRounds[updatedCandidate.interviewRounds.length - 1];

                    const shouldSendCandidateEmail = roundConfig.sendCandidateEmail !== undefined
                        ? (roundConfig.sendCandidateEmail !== false && roundConfig.sendCandidateEmail !== 'false')
                        : (roundConfig.sendEmail !== false && roundConfig.sendEmail !== 'false');

                    const shouldSendInterviewerEmail = roundConfig.sendInterviewerEmail !== undefined
                        ? (roundConfig.sendInterviewerEmail !== false && roundConfig.sendInterviewerEmail !== 'false')
                        : (roundConfig.sendEmail !== false && roundConfig.sendEmail !== 'false');

                    const isCandidateSelectedForEmail = Array.isArray(roundConfig.emailCandidateIds)
                        ? roundConfig.emailCandidateIds.map(String).includes(String(candidate._id))
                        : true;

                    const effectiveSendCandidate = shouldSendCandidateEmail && isCandidateSelectedForEmail;

                    if (effectiveSendCandidate || shouldSendInterviewerEmail) {
                        sendInterviewScheduleEmails({
                            companyId: req.companyId,
                            candidate: updatedCandidate,
                            round: savedRound,
                            user: req.user,
                            cc: roundConfig.cc,
                            bcc: roundConfig.bcc,
                            emailAccountId: roundConfig.emailAccountId,
                            customSubject: roundConfig.customSubject,
                            customHtmlBody: roundConfig.customHtmlBody,
                            sendCandidateEmail: effectiveSendCandidate,
                            sendInterviewerEmail: shouldSendInterviewerEmail
                        });
                    }
                }

                scheduled += 1;
                scheduledCandidateNames.push(candidate.candidateName);
            } catch (candidateError) {
                failed.push({
                    candidateId: candidate._id,
                    candidateName: candidate.candidateName,
                    reason: candidateError.message || 'Unknown error'
                });
            }
        }

        const assignedUserArray = Array.from(allAssignedUserIds);
        if (assignedUserArray.length > 0 && scheduled > 0) {
            const io = req.app.get('io');
            const notifications = assignedUserArray.map((userId) => ({
                user: userId,
                companyId: req.companyId,
                preferenceKey: 'interview_assigned',
                title: 'New Interviews Assigned',
                message: scheduled === 1
                    ? `You have been assigned to evaluate ${scheduledCandidateNames[0]} for interview rounds.`
                    : `You have been assigned to evaluate ${scheduled} candidates for interview rounds.`,
                type: 'Interview',
                link: '/ta',
                origin: req.headers.origin
            }));

            await NotificationService.createManyNotifications(io, notifications);

            assignedUserArray.forEach((userId) => {
                NotificationService.emitToUser(io, userId, 'interview_update', {
                    type: 'BULK_SCHEDULED',
                    count: scheduled
                });
            });
        }

        res.status(200).json({
            message: `${roundsToSchedule.length} interview round(s) scheduled for ${scheduled} candidate(s)`,
            scheduled,
            failed: failed.length,
            errors: failed
        });
    } catch (error) {
        console.error('Error in bulk interview scheduling:', error);
        res.status(500).json({ message: 'Server error during bulk scheduling', error: error.message });
    }
};

module.exports = {
    addInterviewRound,
    updateInterviewRound,
    deleteInterviewRound,
    sendInterviewRoundEmail,
    previewInterviewRoundEmail,
    getMyScheduledInterviews,
    evaluateInterviewRound,
    bulkScheduleInterview
};
