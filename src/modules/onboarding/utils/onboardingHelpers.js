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

const escapeXml = (unsafe) => {
    if (!unsafe) return '';
    return String(unsafe)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&apos;');
};

const buildSalaryTableXml = (earnings = [], contributions = [], deductions = [], totals = {}) => {
    // Clean, simple, professional formal palette (no bright colors)
    const headerFill = 'F1F5F9'; // Subtle neutral grey for header
    const sectionFill = 'F8FAFC'; // Very light neutral grey for section divider
    const totalFill = 'FFFFFF'; // Clean white for rows and totals
    const textColor = '000000'; // Standard formal black text
    const borderColor = 'CBD5E1'; // Standard clean table border

    const makeCell = ({ text, align = 'left', isBold = false, fill = '', colSpan = 1 }) => {
        const shdXml = fill ? `<w:shd w:val="clear" w:color="auto" w:fill="${fill}"/>` : '';
        const gridSpanXml = colSpan > 1 ? `<w:gridSpan w:val="${colSpan}"/>` : '';
        const bXml = isBold ? '<w:b/>' : '';
        const jcXml = align !== 'left' ? `<w:jc w:val="${align}"/>` : '<w:jc w:val="left"/>';

        return `
            <w:tc>
                <w:tcPr>
                    ${gridSpanXml}
                    ${shdXml}
                    <w:tcMar>
                        <w:top w:w="120" w:type="dxa"/>
                        <w:bottom w:w="120" w:type="dxa"/>
                        <w:left w:w="160" w:type="dxa"/>
                        <w:right w:w="160" w:type="dxa"/>
                    </w:tcMar>
                </w:tcPr>
                <w:p>
                    <w:pPr>${jcXml}</w:pPr>
                    <w:r>
                        <w:rPr>${bXml}<w:color w:val="${textColor}"/><w:sz w:val="20"/></w:rPr>
                        <w:t xml:space="preserve">${escapeXml(text)}</w:t>
                    </w:r>
                </w:p>
            </w:tc>
        `.trim();
    };

    const makeRow = (cells, isHeader = false) => {
        const trPr = isHeader ? '<w:trPr><w:tblHeader/></w:trPr>' : '';
        return `<w:tr>${trPr}${cells.join('')}</w:tr>`;
    };

    const rows = [];

    // Header Row (Simple neutral header, bold black text)
    rows.push(makeRow([
        makeCell({ text: 'Salary Component', align: 'left', isBold: true, fill: headerFill }),
        makeCell({ text: 'Monthly (₹)', align: 'right', isBold: true, fill: headerFill }),
        makeCell({ text: 'Annual (₹)', align: 'right', isBold: true, fill: headerFill })
    ], true));

    // Section A: Earnings & Allowances
    rows.push(makeRow([
        makeCell({ text: 'A. EARNINGS & ALLOWANCES', align: 'left', isBold: true, fill: sectionFill, colSpan: 3 })
    ]));

    (earnings || []).forEach(item => {
        rows.push(makeRow([
            makeCell({ text: item.name, align: 'left' }),
            makeCell({ text: item.monthly, align: 'right' }),
            makeCell({ text: item.annual, align: 'right' })
        ]));
    });

    if (totals.monthlyGross || totals.annualGross) {
        rows.push(makeRow([
            makeCell({ text: 'Total Gross Earnings', align: 'left', isBold: true, fill: totalFill }),
            makeCell({ text: totals.monthlyGross, align: 'right', isBold: true, fill: totalFill }),
            makeCell({ text: totals.annualGross, align: 'right', isBold: true, fill: totalFill })
        ]));
    }

    // Section B: Employer Contributions & Benefits
    if (contributions && contributions.length > 0) {
        rows.push(makeRow([
            makeCell({ text: 'B. EMPLOYER CONTRIBUTIONS & BENEFITS', align: 'left', isBold: true, fill: sectionFill, colSpan: 3 })
        ]));

        contributions.forEach(item => {
            rows.push(makeRow([
                makeCell({ text: item.name, align: 'left' }),
                makeCell({ text: item.monthly, align: 'right' }),
                makeCell({ text: item.annual, align: 'right' })
            ]));
        });

        if (totals.monthlyContributions || totals.annualContributions) {
            rows.push(makeRow([
                makeCell({ text: 'Total Employer Contributions', align: 'left', isBold: true, fill: totalFill }),
                makeCell({ text: totals.monthlyContributions, align: 'right', isBold: true, fill: totalFill }),
                makeCell({ text: totals.annualContributions, align: 'right', isBold: true, fill: totalFill })
            ]));
        }
    }

    // Total Cost to Company (CTC)
    if (totals.monthlyCTC || totals.annualCTC) {
        rows.push(makeRow([
            makeCell({ text: 'Total Cost to Company', align: 'left', isBold: true, fill: totalFill }),
            makeCell({ text: totals.monthlyCTC, align: 'right', isBold: true, fill: totalFill }),
            makeCell({ text: totals.annualCTC, align: 'right', isBold: true, fill: totalFill })
        ]));
    }

    // Section C: Employee Deductions
    if (deductions && deductions.length > 0) {
        rows.push(makeRow([
            makeCell({ text: 'C. EMPLOYEE DEDUCTIONS', align: 'left', isBold: true, fill: sectionFill, colSpan: 3 })
        ]));

        deductions.forEach(item => {
            rows.push(makeRow([
                makeCell({ text: item.name, align: 'left' }),
                makeCell({ text: item.monthly, align: 'right' }),
                makeCell({ text: item.annual, align: 'right' })
            ]));
        });

        if (totals.monthlyDeductions || totals.annualDeductions) {
            rows.push(makeRow([
                makeCell({ text: 'Total Deductions', align: 'left', isBold: true, fill: totalFill }),
                makeCell({ text: totals.monthlyDeductions, align: 'right', isBold: true, fill: totalFill }),
                makeCell({ text: totals.annualDeductions, align: 'right', isBold: true, fill: totalFill })
            ]));
        }
    }

    // Net Take-Home Pay
    if (totals.monthlyNet || totals.annualNet) {
        rows.push(makeRow([
            makeCell({ text: 'Net Take-Home Pay', align: 'left', isBold: true, fill: totalFill }),
            makeCell({ text: totals.monthlyNet, align: 'right', isBold: true, fill: totalFill }),
            makeCell({ text: totals.annualNet, align: 'right', isBold: true, fill: totalFill })
        ]));
    }

    return `
        <w:tbl>
            <w:tblPr>
                <w:tblW w:w="5000" w:type="pct"/>
                <w:jc w:val="center"/>
                <w:tblBorders>
                    <w:top w:val="single" w:sz="4" w:space="0" w:color="${borderColor}"/>
                    <w:left w:val="single" w:sz="4" w:space="0" w:color="${borderColor}"/>
                    <w:bottom w:val="single" w:sz="4" w:space="0" w:color="${borderColor}"/>
                    <w:right w:val="single" w:sz="4" w:space="0" w:color="${borderColor}"/>
                    <w:insideH w:val="single" w:sz="4" w:space="0" w:color="${borderColor}"/>
                    <w:insideV w:val="single" w:sz="4" w:space="0" w:color="${borderColor}"/>
                </w:tblBorders>
                <w:tblCellMar>
                    <w:top w:w="100" w:type="dxa"/>
                    <w:bottom w:w="100" w:type="dxa"/>
                    <w:left w:w="150" w:type="dxa"/>
                    <w:right w:w="150" w:type="dxa"/>
                </w:tblCellMar>
            </w:tblPr>
            <w:tblGrid>
                <w:gridCol w:w="5000"/>
                <w:gridCol w:w="2500"/>
                <w:gridCol w:w="2500"/>
            </w:tblGrid>
            ${rows.join('')}
        </w:tbl>
    `.trim().replace(/\s+/g, ' ');
};

const preprocessDocxXml = (xmlString) => {
    if (!xmlString || typeof xmlString !== 'string') return xmlString;

    // Normalize {salary_table} without @ to {@salary_table} so users don't break templates
    let normalized = xmlString.replace(/\{salary_table\}/g, '{@salary_table}');

    return normalized.replace(/<w:p(?: [^>]*)?>([\s\S]*?)<\/w:p>/g, (paragraphHtml) => {
        if (paragraphHtml.includes('{@')) {
            const rawTagMatch = paragraphHtml.match(/({@[a-zA-Z0-9_]+})/);
            if (rawTagMatch) {
                const tag = rawTagMatch[1];
                const pPrMatch = paragraphHtml.match(/<w:pPr>[\s\S]*?<\/w:pPr>/);
                const pPr = pPrMatch ? pPrMatch[0] : '';
                let cleanedHtml = paragraphHtml.replace(tag, '');

                let hasActualText = false;
                const tMatches = [...cleanedHtml.matchAll(/<w:t(?: [^>]*)?>([\s\S]*?)<\/w:t>/g)];
                tMatches.forEach(match => {
                    if (match[1].trim() !== '') {
                        hasActualText = true;
                    }
                });

                if (!hasActualText) {
                    return `<w:p>${pPr}<w:r><w:t>${tag}</w:t></w:r></w:p>`;
                }

                return `${cleanedHtml}<w:p>${pPr}<w:r><w:t>${tag}</w:t></w:r></w:p>`;
            }
        }
        return paragraphHtml;
    });
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
    buildPreOnboardingTemplateData,
    buildSalaryTableXml,
    preprocessDocxXml
};
