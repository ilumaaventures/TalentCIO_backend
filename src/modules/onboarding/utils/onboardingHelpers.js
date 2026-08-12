const Candidate = require('../../talent-acquisition/model/candidate.model');
const NotificationService = require('../../../services/notificationService');

const syncTADecision = async (employee, decision) => {
    if (!employee) return;
    try {
        let query = null;
        if (employee.candidateId) {
            query = { _id: employee.candidateId, companyId: employee.companyId };
        } else if (employee.email) {
            query = { email: employee.email, companyId: employee.companyId };
        }
        if (query) {
            await Candidate.findOneAndUpdate(query, { phase3Decision: decision });
        }
    } catch (err) {
        console.error('[syncTADecision] Failed to sync TA decision:', err.message);
    }
};

const generateTempPassword = (length = 10) => {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
    let password = '';
    for (let i = 0; i < length; i++) {
        password += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return password;
};

const formatDate = (date) => {
    if (!date) return '';
    return new Date(date).toLocaleDateString('en-IN', { day: '2-digit', month: 'long', year: 'numeric', timeZone: 'Asia/Kolkata' });
};

const formatCurrency = (val) => {
    if (!val) return '—';
    const num = parseFloat(String(val).replace(/[^0-9.]/g, ''));
    if (isNaN(num)) return val;
    return '₹ ' + num.toLocaleString('en-IN');
};

const DEFAULT_PRE_ONBOARDING_EMAIL_SUBJECT = 'Action Required: Complete Your Pre-Onboarding';
const DEFAULT_PRE_ONBOARDING_EMAIL_BODY = `
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:600px; margin:0 auto; border:1px solid #e2e8f0; border-radius:12px; background:#ffffff;">
        <tr>
            <td style="padding:0;">
                <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#0f172a;">
                    <tr>
                        <td align="center" style="padding:32px 24px 28px;">
                            <div style="display:inline-block; background:#334155; color:#dbeafe; padding:8px 16px; border-radius:999px; font-size:12px; letter-spacing:1px; text-transform:uppercase; font-weight:600;">
                                Pre-Onboarding Portal
                            </div>
                            <div style="height:20px; line-height:20px; font-size:20px;">&nbsp;</div>
                            <div style="color:#ffffff; font-size:22px; line-height:28px; font-weight:700;">
                                Action Required
                            </div>
                            <div style="height:12px; line-height:12px; font-size:12px;">&nbsp;</div>
                            <div style="max-width:460px; margin:0 auto; color:#cbd5e1; font-size:14px; line-height:24px;">
                                Complete your pending onboarding tasks and upload the requested information before your joining date.
                            </div>
                        </td>
                    </tr>
                </table>
            </td>
        </tr>
        <tr>
            <td style="padding:32px;">
                <div style="color:#0f172a; font-size:18px; line-height:28px; font-weight:600; margin:0 0 12px;">
                    Hello {{firstName}},
                </div>
                <div style="color:#475569; font-size:14px; line-height:26px; margin:0 0 28px;">
                    Your HR team has shared a few onboarding requirements that need your attention. Please review the items below and complete them through your employee portal.
                </div>
                <div style="margin-bottom:22px;">{{credentialsSection}}</div>
                <div style="margin-bottom:22px;">{{requestedSectionsBlock}}</div>
                <div style="margin-bottom:22px;">{{requestedDocumentsBlock}}</div>
                <div style="margin-bottom:22px;">{{sharedFilesBlock}}</div>
                <div style="margin-bottom:30px;">{{deadlineBlock}}</div>
                <div style="text-align:center; margin-top:28px;">{{portalButton}}</div>
            </td>
        </tr>
        <tr>
            <td style="background:#f1f5f9; padding:16px; text-align:center; border-top:1px solid #e2e8f0;">
                <div style="margin:0 0 8px; color:#0f172a; font-size:14px; font-weight:600;">TalentCio</div>
                <div style="margin:0; color:#94a3b8; font-size:12px;">&copy; {{currentYear}} TalentCio. All rights reserved.</div>
            </td>
        </tr>
    </table>
`;

const resolveNotificationEmailDelivery = async (companyId, preferenceKey, requestedEmailAccountId = '') => {
    const preference = await NotificationService.getEmailPreferenceForEvent(
        companyId,
        preferenceKey,
        requestedEmailAccountId
    );

    return {
        shouldSendEmail: preference.shouldSendEmail,
        emailAccountId: preference.emailAccountId
    };
};

const ONBOARDING_LAYOUT_PLACEHOLDERS = [
    'credentialsSection',
    'requestedSectionsBlock',
    'requestedDocumentsBlock',
    'sharedFilesBlock',
    'deadlineBlock',
    'portalButton',
    'currentYear'
];

const stripHtml = (html = '') => String(html || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
const LEGACY_EXPERIENCE_CERTIFICATE_LABEL = 'Experience Certificate';
const CURRENT_EXPERIENCE_CERTIFICATE_LABEL = 'Previous Experience Certificate';

const normalizeOnboardingExperienceCertificateLabels = async (employee) => {
    if (!employee) return employee;

    let changed = false;

    if (Array.isArray(employee.documents)) {
        const hasCharacterCertificate = employee.documents.some(doc => doc?.type === 'character_certificate');
        if (!hasCharacterCertificate) {
            employee.documents.push({
                type: 'character_certificate',
                label: 'Character Certificate',
                status: 'Pending'
            });
            changed = true;
        }

        const hasLivePhoto = employee.documents.some(doc => doc?.type === 'live_photo');
        if (!hasLivePhoto) {
            employee.documents.push({
                type: 'live_photo',
                label: 'Live Photograph',
                status: 'Pending',
                requireLivePhoto: true
            });
            changed = true;
        }

        employee.documents.forEach((doc) => {
            if (doc && !doc.type) {
                doc.type = 'custom_file';
                changed = true;
            }
            if (doc?.type === 'experience_certificate' && doc.label === LEGACY_EXPERIENCE_CERTIFICATE_LABEL) {
                doc.label = CURRENT_EXPERIENCE_CERTIFICATE_LABEL;
                changed = true;
            }
        });
    }

    if (Array.isArray(employee.requestedDocuments)) {
        employee.requestedDocuments.forEach((doc) => {
            if (doc?.label === LEGACY_EXPERIENCE_CERTIFICATE_LABEL) {
                doc.label = CURRENT_EXPERIENCE_CERTIFICATE_LABEL;
                changed = true;
            }
        });
    }

    if (employee.selectionDraft && Array.isArray(employee.selectionDraft.documents)) {
        employee.selectionDraft.documents = employee.selectionDraft.documents.map((label) => {
            if (label === LEGACY_EXPERIENCE_CERTIFICATE_LABEL) {
                changed = true;
                return CURRENT_EXPERIENCE_CERTIFICATE_LABEL;
            }

            return label;
        });
    }

    if (changed && typeof employee.save === 'function') {
        await employee.save();
    }

    return employee;
};

const getUniqueDocumentLabel = (existingDocs = [], baseLabel = 'Document') => {
    const trimmedBaseLabel = String(baseLabel || 'Document').trim() || 'Document';
    const lastDotIndex = trimmedBaseLabel.lastIndexOf('.');
    const hasExtension = lastDotIndex > 0 && lastDotIndex < trimmedBaseLabel.length - 1;
    const fileName = hasExtension ? trimmedBaseLabel.slice(0, lastDotIndex) : trimmedBaseLabel;
    const fileExtension = hasExtension ? trimmedBaseLabel.slice(lastDotIndex) : '';

    const existingLabels = new Set((existingDocs || []).map((doc) => String(doc?.label || '').trim()).filter(Boolean));
    if (!existingLabels.has(trimmedBaseLabel)) {
        return trimmedBaseLabel;
    }

    let counter = 2;
    let nextLabel = `${fileName} (${counter})${fileExtension}`;
    while (existingLabels.has(nextLabel)) {
        counter += 1;
        nextLabel = `${fileName} (${counter})${fileExtension}`;
    }

    return nextLabel;
};

const buildPreOnboardingTemplateData = ({
    employee,
    companyName,
    taContactName,
    portalUrl,
    deadlineText,
    credentialsSection = '',
    requestedSectionsBlock = '',
    requestedDocumentsBlock = '',
    sharedFilesBlock = '',
    deadlineBlock = '',
    portalButton = ''
}) => {
    const fullName = `${employee.firstName || ''} ${employee.lastName || ''}`.trim() || 'Team Member';

    return {
        firstName: employee.firstName || 'Team Member',
        lastName: employee.lastName || '',
        fullName,
        candidateName: fullName,
        email: employee.email || '',
        tempPassword: employee.tempPassword || '',
        portalUrl: portalUrl || '',
        companyName: companyName || 'Our Company',
        jobTitle: employee.designation || 'Team Member',
        joiningDate: formatDate(employee.joiningDate),
        location: employee.workLocation || 'Office',
        department: employee.department || 'General',
        employmentType: employee.employmentType || 'Full Time',
        designation: employee.designation || 'Team Member',
        taContactName: taContactName || 'HR Team',
        deadlineText: deadlineText || '',
        credentialsSection,
        requestedSectionsBlock,
        requestedDocumentsBlock,
        sharedFilesBlock,
        deadlineBlock,
        portalButton,
        currentYear: String(new Date().getFullYear())
    };
};

module.exports = {
    syncTADecision,
    generateTempPassword,
    formatDate,
    formatCurrency,
    DEFAULT_PRE_ONBOARDING_EMAIL_SUBJECT,
    DEFAULT_PRE_ONBOARDING_EMAIL_BODY,
    resolveNotificationEmailDelivery,
    ONBOARDING_LAYOUT_PLACEHOLDERS,
    stripHtml,
    LEGACY_EXPERIENCE_CERTIFICATE_LABEL,
    CURRENT_EXPERIENCE_CERTIFICATE_LABEL,
    normalizeOnboardingExperienceCertificateLabels,
    getUniqueDocumentLabel,
    buildPreOnboardingTemplateData
};
