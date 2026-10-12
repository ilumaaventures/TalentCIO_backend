const Candidate = require('../../model/candidate.model');
const { HiringRequest, HRRAuditLog } = require('../../model/hiringRequest.model');
const TAEmailLog = require('../../model/taEmailLog.model');
const Client = require('../../../client/client.model');
const Company = require('../../../company/company.model');
const { sendEmailForCompany, getCompanyEmailSettings, pickEmailAccount } = require('../../../../services/companyEmailService');
const { uploadBufferToCloudinary } = require('../../../../config/cloudinary');
const { isProfileSharedCandidate } = require('../../utils/candidateAccess');
const multer = require('multer');

const shareCandidateAttachmentUpload = multer({
    storage: multer.memoryStorage(),
    limits: {
        fileSize: 25 * 1024 * 1024 // 25 MB max individual file size
    },
    fileFilter: (req, file, cb) => {
        const allowedExtensions = ['pdf', 'zip', 'doc', 'docx'];
        const ext = (file.originalname || '').split('.').pop().toLowerCase();
        if (!allowedExtensions.includes(ext)) {
            return cb(new Error(`Unsupported file type (.${ext}). Only PDF (.pdf), ZIP (.zip), and Microsoft Word (.doc, .docx) are allowed.`));
        }
        cb(null, true);
    }
});

/**
 * Check if candidate is currently in Phase 2
 */
const isCandidateInPhase2 = (candidate) => {
    if (!candidate) return false;

    // 1. Explicit dynamic phase order
    if (Number(candidate.currentPhaseOrder) === 2) {
        return true;
    }

    // 2. Profile shared flags
    if (candidate.profileShared === true || candidate.isProfileShared === true || candidate.profileSharedAt) {
        return true;
    }

    // 3. Phase 1 decisions that advance to Phase 2
    if (candidate.decision === 'Shortlisted' || candidate.decision === 'Profile Shared' || candidate.decision === 'Selected') {
        return true;
    }

    // 4. Phase 2 decisions or interview status
    if ((candidate.phase2Decision && candidate.phase2Decision !== 'None') ||
        (candidate.phase2InterviewStatus && candidate.phase2InterviewStatus !== 'None') ||
        candidate.phase2InterviewerFeedback) {
        return true;
    }

    // 5. Interview rounds in Phase 2
    if (Array.isArray(candidate.interviewRounds) && candidate.interviewRounds.some(r => Number(r.phaseOrder || r.phase || r.roundNumber) === 2)) {
        return true;
    }

    const hasPhase1Dropped = ['Rejected', 'Did Not Turn Up', 'Left in between'].includes(candidate.decision);
    if (hasPhase1Dropped) return false;

    return isProfileSharedCandidate(candidate);
};

/**
 * Format field values for candidate profile columns
 */
const formatCandidateFieldValue = (candidate, fieldKey) => {
    switch (fieldKey) {
        case 'candidateName':
            return candidate.candidateName || '—';
        case 'expectedCTC':
            if (candidate.expectedCTC !== undefined && candidate.expectedCTC !== null && candidate.expectedCTC !== '') {
                const val = Number(candidate.expectedCTC);
                return !isNaN(val) ? `₹ ${val.toLocaleString('en-IN')} LPA` : String(candidate.expectedCTC);
            }
            return '—';
        case 'currentCTC':
            if (candidate.currentCTC !== undefined && candidate.currentCTC !== null && candidate.currentCTC !== '') {
                const val = Number(candidate.currentCTC);
                return !isNaN(val) ? `₹ ${val.toLocaleString('en-IN')} LPA` : String(candidate.currentCTC);
            }
            return '—';
        case 'noticePeriod':
            return candidate.noticePeriod ? `${candidate.noticePeriod} Days` : '—';
        case 'currentLocation':
            return candidate.currentLocation || '—';
        case 'totalExperience':
            return candidate.totalExperience !== undefined && candidate.totalExperience !== null && candidate.totalExperience !== ''
                ? `${candidate.totalExperience} Yrs`
                : '—';
        case 'relevantExperience':
            return candidate.relevantExperience !== undefined && candidate.relevantExperience !== null && candidate.relevantExperience !== ''
                ? `${candidate.relevantExperience} Yrs`
                : '—';
        case 'currentCompany':
            return candidate.currentCompany || '—';
        case 'preferredLocation':
            return candidate.preferredLocation || '—';
        case 'qualification':
            return candidate.qualification || '—';
        case 'tatToJoin':
            return candidate.tatToJoin ? `${candidate.tatToJoin} Days` : '—';
        case 'mustHaveSkills':
            if (Array.isArray(candidate.mustHaveSkills)) {
                return candidate.mustHaveSkills.map(s => typeof s === 'object' ? s.skill : s).filter(Boolean).join(', ') || '—';
            }
            return candidate.mustHaveSkills || '—';
        case 'niceToHaveSkills':
            if (Array.isArray(candidate.niceToHaveSkills)) {
                return candidate.niceToHaveSkills.map(s => typeof s === 'object' ? s.skill : s).filter(Boolean).join(', ') || '—';
            }
            return candidate.niceToHaveSkills || '—';
        case 'inHandOffer':
            return candidate.inHandOffer ? `Yes (${candidate.offerCompany || ''} - ₹${candidate.offerCTC || ''} LPA)` : 'No';
        case 'preference':
            return candidate.preference || '—';
        case 'email':
            return candidate.email || '—';
        case 'mobile':
            return candidate.mobile || '—';
        default:
            return candidate[fieldKey] !== undefined && candidate[fieldKey] !== null ? String(candidate[fieldKey]) : '—';
    }
};

/**
 * Format Excel-style grid HTML table of candidates for email clients (Gmail, Outlook compatible)
 * Columns = selected candidate fields
 * Rows = each selected candidate
 */
const generateCandidatesExcelHtmlTable = (candidates, selectedColumns) => {
    if (!Array.isArray(candidates) || candidates.length === 0 || !Array.isArray(selectedColumns) || selectedColumns.length === 0) {
        return '';
    }

    const headerThs = selectedColumns.map(col => `
        <th style="padding: 10px 14px; text-align: left; font-size: 13px; font-weight: 700; color: #1e293b; background-color: #f1f5f9; border: 1px solid #cbd5e1; white-space: nowrap;">
            ${col.label || col.key}
        </th>
    `).join('');

    const rowsHtml = candidates.map((cand, idx) => {
        const rowBg = idx % 2 === 0 ? '#ffffff' : '#f8fafc';
        const tds = selectedColumns.map(col => {
            const val = formatCandidateFieldValue(cand, col.key);
            const isName = col.key === 'candidateName';
            return `
                <td style="padding: 10px 14px; font-size: 13px; color: ${isName ? '#0f172a' : '#334155'}; font-weight: ${isName ? '600' : '400'}; border: 1px solid #cbd5e1; vertical-align: middle;">
                    ${String(val).replace(/\n/g, '<br/>')}
                </td>
            `;
        }).join('');

        return `
            <tr style="background-color: ${rowBg};">
                <td style="padding: 10px 12px; text-align: center; font-size: 12px; font-weight: 600; color: #64748b; border: 1px solid #cbd5e1; vertical-align: middle;">
                    ${idx + 1}
                </td>
                ${tds}
            </tr>
        `;
    }).join('');

    return `
        <table style="width: 100%; border-collapse: collapse; margin: 20px 0; border: 1px solid #94a3b8; font-family: Calibri, 'Segoe UI', Arial, sans-serif; font-size: 13px;">
            <thead>
                <tr>
                    <th style="padding: 10px 12px; text-align: center; font-size: 13px; font-weight: 700; color: #1e293b; background-color: #e2e8f0; border: 1px solid #cbd5e1; width: 42px;">
                        #
                    </th>
                    ${headerThs}
                </tr>
            </thead>
            <tbody>
                ${rowsHtml}
            </tbody>
        </table>
    `;
};

/**
 * Backward compatibility single-candidate 2-column table
 */
const generateCandidateDetailsHtmlTable = (selectedFields) => {
    if (!Array.isArray(selectedFields) || selectedFields.length === 0) {
        return '';
    }

    const rowsHtml = selectedFields.map((field, idx) => {
        const bgColor = idx % 2 === 0 ? '#ffffff' : '#f8fafc';
        const label = String(field.label || field.key || '').trim();
        const value = String(field.value !== undefined && field.value !== null && field.value !== '' ? field.value : '—').trim();

        return `
            <tr style="background-color: ${bgColor}; border-bottom: 1px solid #e2e8f0;">
                <td style="padding: 10px 14px; font-weight: 600; color: #334155; font-size: 13px; width: 38%; vertical-align: top; border-right: 1px solid #e2e8f0;">
                    ${label}
                </td>
                <td style="padding: 10px 14px; color: #0f172a; font-size: 13px; vertical-align: top;">
                    ${value.replace(/\n/g, '<br/>')}
                </td>
            </tr>
        `;
    }).join('');

    return `
        <table style="width: 100%; max-width: 640px; border-collapse: collapse; margin: 18px 0; border: 1px solid #cbd5e1; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;">
            <thead>
                <tr style="background-color: #0f172a; color: #ffffff;">
                    <th style="padding: 11px 14px; text-align: left; font-size: 13px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.05em; width: 38%;">Candidate Detail</th>
                    <th style="padding: 11px 14px; text-align: left; font-size: 13px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.05em;">Information</th>
                </tr>
            </thead>
            <tbody>
                ${rowsHtml}
            </tbody>
        </table>
    `;
};

/**
 * Parse recipient strings (handles comma/semicolon/newline-delimited emails)
 */
const parseEmailList = (input) => {
    if (!input) return [];
    if (Array.isArray(input)) {
        return input.map(e => String(e).trim()).filter(e => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e));
    }
    return String(input)
        .split(/[,;\n\r]+/)
        .map(e => e.trim())
        .filter(e => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e));
};

/**
 * Share Candidate Details with Client via Email (Phase 2 Only)
 * Supports single candidate or multiple candidates formatted as an Excel-type table
 */
const shareCandidateWithClient = async (req, res) => {
    try {
        const {
            to,
            cc,
            bcc,
            subject,
            emailBodyIntro,
            emailBodyOutro,
            customHtmlBody,
            selectedFields: rawSelectedFields,
            emailAccountId,
            candidateIds: rawCandidateIds
        } = req.body;

        // Resolve candidate IDs from body or params
        let targetCandidateIds = [];
        if (rawCandidateIds) {
            try {
                const parsed = typeof rawCandidateIds === 'string' ? JSON.parse(rawCandidateIds) : rawCandidateIds;
                if (Array.isArray(parsed)) targetCandidateIds = parsed.filter(Boolean);
            } catch (e) { }
        }
        if (targetCandidateIds.length === 0) {
            const singleId = req.params.id || req.params.candidateId;
            if (singleId && singleId !== 'share-with-client') {
                targetCandidateIds = [singleId];
            }
        }

        if (targetCandidateIds.length === 0) {
            return res.status(400).json({ message: 'At least one candidate must be selected to share with client.' });
        }

        const effectiveCompanyId = req.companyId || req.user?.companyId;

        const candidates = await Candidate.find({ _id: { $in: targetCandidateIds } })
            .populate('hiringRequestId')
            .populate('uploadedBy', 'firstName lastName email');

        if (!candidates || candidates.length === 0) {
            return res.status(404).json({ message: 'No candidates found for the specified IDs.' });
        }

        // 1. Strict Phase 2 Access Guard for all selected candidates
        const phase2Candidates = candidates.filter(isCandidateInPhase2);
        if (phase2Candidates.length === 0) {
            return res.status(400).json({
                message: 'None of the selected candidates are in Phase 2. Sharing details with client is only permitted for candidates in Phase 2.'
            });
        }

        const firstCandidate = phase2Candidates[0];
        const candidateCompanyId = firstCandidate.companyId || effectiveCompanyId;

        // 2. Validate Recipients
        const toEmails = parseEmailList(to);
        if (toEmails.length === 0) {
            return res.status(400).json({ message: 'A valid client recipient email address (To) is required.' });
        }

        const ccEmails = parseEmailList(cc);
        const bccEmails = parseEmailList(bcc);

        const defaultSubject = phase2Candidates.length === 1
            ? `Candidate Profile – ${firstCandidate.candidateName}`
            : `Candidate Profiles (${phase2Candidates.length}) – ${firstCandidate.hiringRequestId?.roleDetails?.title || 'Open Position'}`;

        const emailSubject = String(subject || defaultSubject).trim();
        if (!emailSubject) {
            return res.status(400).json({ message: 'Email subject is required.' });
        }

        // Parse selected fields
        let selectedFields = [];
        try {
            selectedFields = typeof rawSelectedFields === 'string' ? JSON.parse(rawSelectedFields) : (rawSelectedFields || []);
        } catch (e) {
            selectedFields = [];
        }

        if (!Array.isArray(selectedFields) || selectedFields.length === 0) {
            return res.status(400).json({ message: 'Please select at least one candidate detail to share with the client.' });
        }

        // 3. Attachment validation
        const files = req.files || [];
        const rawTotalBytes = files.reduce((sum, f) => sum + (f.size || 0), 0);
        const MAX_BYTES = 25 * 1024 * 1024; // 25 MB

        const estimatedEncodedBytes = Math.ceil(rawTotalBytes * 1.37);
        if (rawTotalBytes > MAX_BYTES || estimatedEncodedBytes > MAX_BYTES) {
            return res.status(400).json({
                message: 'The total attachment size exceeds 25 MB. Gmail and other email providers may reject this email due to attachment encoding overhead. Please remove some files before sending.'
            });
        }

        const allowedExts = ['pdf', 'zip', 'doc', 'docx'];
        for (const file of files) {
            const ext = (file.originalname || '').split('.').pop().toLowerCase();
            if (!allowedExts.includes(ext)) {
                return res.status(400).json({
                    message: `File "${file.originalname}" has an unsupported format (.${ext}). Only PDF, ZIP, and Word (.doc, .docx) files are supported.`
                });
            }
        }

        // 4. Construct Email Body (Normal body format without logo banner)
        const excelTableHtml = generateCandidatesExcelHtmlTable(phase2Candidates, selectedFields);

        const introHtml = emailBodyIntro ? `<p style="margin-bottom: 16px; white-space: pre-wrap;">${String(emailBodyIntro).replace(/\n/g, '<br/>')}</p>` : '';
        const outroHtml = emailBodyOutro ? `<p style="margin-top: 20px; white-space: pre-wrap;">${String(emailBodyOutro).replace(/\n/g, '<br/>')}</p>` : '';

        const fullHtml = `
            <div style="font-family: Arial, sans-serif; font-size: 14px; line-height: 1.6; color: #1e293b; max-width: 900px; padding: 6px 0;">
                ${introHtml || `<p style="margin-bottom: 16px;">Dear Client,<br/><br/>Please find the profile details of the shortlisted candidate${phase2Candidates.length > 1 ? 's' : ''} in the table below for your review:</p>`}
                ${excelTableHtml}
                ${outroHtml || `<p style="margin-top: 20px;">Please review the profile${phase2Candidates.length > 1 ? 's' : ''} and let us know your feedback or preferred interview slots.<br/><br/>Best regards,<br/><strong>Talent Acquisition Team</strong></p>`}
            </div>
        `;

        // 5. Prepare attachments immediately for fast delivery
        const emailAttachments = files.map(file => ({
            filename: file.originalname,
            content: file.buffer,
            contentType: file.mimetype
        }));

        const loggedAttachments = files.map(file => ({
            filename: file.originalname,
            url: '',
            path: '',
            contentType: file.mimetype,
            size: file.size
        }));

        // 6. Send Email via Company Email Service (brandEmail: false -> NO LOGO / clean normal body)
        const sendSuccess = await sendEmailForCompany({
            companyId: candidateCompanyId,
            emailAccountId: (emailAccountId && emailAccountId !== 'platform') ? emailAccountId : undefined,
            to: toEmails.join(', '),
            cc: ccEmails.length > 0 ? ccEmails.join(', ') : undefined,
            bcc: bccEmails.length > 0 ? bccEmails.join(', ') : undefined,
            subject: emailSubject,
            html: fullHtml,
            attachments: emailAttachments,
            brandEmail: false, // NO LOGO BANNER - Clean normal body format
            throwOnError: true
        });

        if (!sendSuccess) {
            return res.status(500).json({ message: 'Email service was unable to send the email. Please check your sender account settings.' });
        }

        // 7. Update Candidate Records
        const sharedCandidateIds = phase2Candidates.map(c => c._id);
        const candidateEmailsStr = phase2Candidates.map(c => c.email).filter(Boolean).join(', ');

        await Candidate.updateMany(
            { _id: { $in: sharedCandidateIds } },
            {
                $set: {
                    profileShared: true,
                    lastMailDetails: {
                        sentAt: new Date(),
                        subject: emailSubject,
                        htmlBody: fullHtml,
                        senderEmail: req.user?.email || '',
                        candidateEmail: candidateEmailsStr,
                        cc: ccEmails.join(', '),
                        bcc: bccEmails.join(', '),
                        interviewers: []
                    }
                }
            }
        );

        // 8. Resolve Sender Details for Logging
        let emailAccountLabel = 'TalentCIO Platform';
        let fromAddress = process.env.EMAIL_FROM || 'no-reply@talentcio.in';
        let fromName = 'Talent Acquisition Team';

        try {
            const emailSettings = await getCompanyEmailSettings(candidateCompanyId);
            const selection = pickEmailAccount(emailSettings, emailAccountId);
            if (selection.mode === 'account' && selection.account) {
                emailAccountLabel = selection.account.name || selection.account.fromAddress || 'Custom Sender';
                fromAddress = selection.account.fromAddress || fromAddress;
                fromName = selection.account.fromName || fromName;
            }
        } catch { }

        // 9. Create TAEmailLog Entry
        const hiringRequest = firstCandidate.hiringRequestId;
        const hiringRequestTitle = hiringRequest?.roleDetails?.title || hiringRequest?.positionName || 'Requisition';
        const candidateNames = phase2Candidates.map(c => c.candidateName).join(', ');

        const emailLog = new TAEmailLog({
            companyId: candidateCompanyId,
            recipientType: 'client',
            sentBy: req.user?._id,
            senderEmail: fromAddress,
            senderName: fromName,
            fromAddress,
            fromName,
            emailAccountId: emailAccountId || 'platform',
            emailAccountLabel,
            hiringRequestId: firstCandidate.hiringRequestId?._id || firstCandidate.hiringRequestId,
            hiringRequestTitle,
            candidateId: firstCandidate._id,
            recipientName: firstCandidate.hiringRequestId?.client || 'Client',
            recipientEmail: toEmails[0],
            cc: ccEmails.join(', '),
            bcc: bccEmails.join(', '),
            templateName: 'Share Candidate Profile with Client (Excel Table)',
            subject: emailSubject,
            body: fullHtml,
            status: 'Sent',
            attachments: loggedAttachments,
            sentAt: new Date()
        });
        await emailLog.save();

        // 10. Audit Log
        try {
            await HRRAuditLog.create({
                hiringRequestId: firstCandidate.hiringRequestId?._id || firstCandidate.hiringRequestId,
                companyId: candidateCompanyId,
                action: 'CANDIDATE_SHARED_WITH_CLIENT',
                performedBy: req.user?._id,
                resourceType: 'Candidate',
                resourceId: firstCandidate._id,
                candidateId: firstCandidate._id,
                details: {
                    to: toEmails,
                    cc: ccEmails,
                    bcc: bccEmails,
                    subject: emailSubject,
                    candidateCount: phase2Candidates.length,
                    candidateNames,
                    fieldsShared: selectedFields.map(f => f.label || f.key),
                    attachmentsCount: files.length,
                    logId: emailLog._id
                }
            });
        } catch (auditErr) {
            console.warn('Failed to record HRRAuditLog for sharing candidate:', auditErr.message);
        }

        // Asynchronously upload attachments to Cloudinary in the background for archival
        if (files.length > 0) {
            setImmediate(async () => {
                for (const file of files) {
                    try {
                        const cloudUrl = await uploadBufferToCloudinary(file.buffer, file.originalname, 'client_share_attachments');
                        if (cloudUrl) {
                            await TAEmailLog.updateOne(
                                { _id: emailLog._id, 'attachments.filename': file.originalname },
                                { $set: { 'attachments.$.url': cloudUrl, 'attachments.$.path': cloudUrl } }
                            ).catch(() => { });
                        }
                    } catch (err) {
                        // Background archival error ignored
                    }
                }
            });
        }

        return res.status(200).json({
            success: true,
            message: `Profile details for ${phase2Candidates.length} candidate${phase2Candidates.length > 1 ? 's' : ''} successfully shared with ${toEmails.join(', ')}`,
            candidateCount: phase2Candidates.length,
            emailLogId: emailLog._id
        });

    } catch (error) {
        console.error('Error sharing candidate details with client:', error);
        return res.status(500).json({
            message: error.message || 'Failed to share candidate details with client.',
            error: error.message
        });
    }
};

module.exports = {
    shareCandidateAttachmentUpload,
    shareCandidateWithClient,
    isCandidateInPhase2,
    generateCandidateDetailsHtmlTable
};
