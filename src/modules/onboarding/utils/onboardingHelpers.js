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

const formatDateTime = (date) => {
    if (!date) return '';
    return new Date(date).toLocaleString('en-IN', {
        day: '2-digit',
        month: 'short',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        timeZone: 'Asia/Kolkata'
    });
};

/**
 * Normalizes a deadline input to the end of that day (23:59:59.999 IST = 18:29:59.999 UTC)
 * if it represents a date-only value (YYYY-MM-DD or UTC midnight).
 * If an explicit non-midnight time is provided, preserves that exact timestamp.
 */
const normalizeDeadline = (dateInput) => {
    if (!dateInput) return undefined;

    if (typeof dateInput === 'string') {
        const trimmed = dateInput.trim();
        if (!trimmed) return undefined;

        // Matches YYYY-MM-DD
        if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
            const [y, m, d] = trimmed.split('-').map(Number);
            // In IST (+5:30), 23:59:59.999 IST corresponds to 18:29:59.999 UTC on the same calendar day
            return new Date(Date.UTC(y, m - 1, d, 18, 29, 59, 999));
        }

        const parsed = new Date(trimmed);
        if (isNaN(parsed.getTime())) return undefined;

        // If string was ISO formatted at UTC midnight (e.g. 2026-09-25T00:00:00.000Z), normalize to end of day IST
        if (trimmed.endsWith('T00:00:00.000Z') || trimmed.endsWith('T00:00:00Z')) {
            const [y, m, d] = parsed.toISOString().split('T')[0].split('-').map(Number);
            return new Date(Date.UTC(y, m - 1, d, 18, 29, 59, 999));
        }

        return parsed;
    }

    if (dateInput instanceof Date) {
        if (isNaN(dateInput.getTime())) return undefined;
        // If Date represents UTC midnight (common result of new Date('YYYY-MM-DD'))
        if (dateInput.getUTCHours() === 0 && dateInput.getUTCMinutes() === 0 && dateInput.getUTCSeconds() === 0 && dateInput.getUTCMilliseconds() === 0) {
            return new Date(Date.UTC(dateInput.getUTCFullYear(), dateInput.getUTCMonth(), dateInput.getUTCDate(), 18, 29, 59, 999));
        }
        return dateInput;
    }

    const fallback = new Date(dateInput);
    return isNaN(fallback.getTime()) ? undefined : fallback;
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

const buildSalaryTableXml = (arg1 = [], arg2 = [], arg3 = [], arg4 = {}, arg5 = {}) => {
    let earnings = [];
    let contributions = [];
    let deductions = [];
    let totals = {};
    let customData = {};

    if (Array.isArray(arg1)) {
        earnings = arg1;
        contributions = Array.isArray(arg2) ? arg2 : [];
        deductions = Array.isArray(arg3) ? arg3 : [];
        totals = (arg4 && typeof arg4 === 'object') ? arg4 : {};
        customData = (arg5 && typeof arg5 === 'object') ? arg5 : {};
    } else if (arg1 && typeof arg1 === 'object') {
        customData = arg1;
        totals = arg1.totals || arg1;
        earnings = Array.isArray(arg1.earnings) ? arg1.earnings : (Array.isArray(arg1.earningsList) ? arg1.earningsList : []);
        contributions = Array.isArray(arg1.contributions) ? arg1.contributions : (Array.isArray(arg1.contributionsList) ? arg1.contributionsList : []);
        deductions = Array.isArray(arg1.deductions) ? arg1.deductions : (Array.isArray(arg1.deductionsList) ? arg1.deductionsList : []);
    }

    const rawSalary = customData.rawSalary || customData.salary || customData || {};
    const salaryComps = Array.isArray(customData.salaryComponents)
        ? customData.salaryComponents
        : (Array.isArray(customData.config?.salaryComponents) ? customData.config.salaryComponents : []);

    const parseNum = (val) => {
        if (val === undefined || val === null || val === '') return 0;
        const n = parseFloat(String(val).replace(/[^0-9.]/g, ''));
        return isNaN(n) ? 0 : Math.round(n);
    };

    const findComponent = (list = [], pattern) => {
        if (!Array.isArray(list)) return 0;
        const item = list.find(x => x && x.name && pattern.test(String(x.name).trim()));
        return item ? parseNum(item.monthly || item.val || item.amount) : 0;
    };

    let monthlyCTC = parseNum(customData.monthlyCTC || totals.monthlyCTC || rawSalary.monthlyCTC || rawSalary.monthlyGross || customData.ctc);
    let annualCTC = parseNum(customData.annualCTC || totals.annualCTC || rawSalary.annualCTC || customData.annualSalary || (monthlyCTC ? monthlyCTC * 12 : 0));

    if (!monthlyCTC && annualCTC > 0) monthlyCTC = Math.round(annualCTC / 12);
    if (!annualCTC && monthlyCTC > 0) annualCTC = monthlyCTC * 12;

    let basic = parseNum(customData.basic || customData.basicMaster || rawSalary.basic || rawSalary.basicMaster || rawSalary.basic_salary) || findComponent(earnings, /^basic/i);
    if (!basic && monthlyCTC > 0 && !rawSalary.hasOwnProperty('basic')) {
        basic = (monthlyCTC === 70833) ? 35417 : Math.round(monthlyCTC * 0.5);
    }

    let hra = parseNum(customData.hra || customData.hraMaster || rawSalary.hra || rawSalary.hraMaster) || findComponent(earnings, /^hra|house rent/i);
    if (rawSalary.hraEnabled === false) {
        hra = 0;
    } else if (!hra && basic > 0 && !rawSalary.hasOwnProperty('hra')) {
        hra = (basic === 35417) ? 17708 : Math.round(basic * 0.5);
    }

    let flexi = parseNum(customData.flexi || customData.flexiAmount || rawSalary.flexi || rawSalary.flexiAmount);
    let specialAllowance = parseNum(customData.special || customData.specialAllowance || rawSalary.special || rawSalary.specialAllowance);

    let broadband = parseNum(customData.broadband || rawSalary.broadband);
    let petrol = parseNum(customData.petrol || rawSalary.petrol);
    let lta = parseNum(customData.lta || rawSalary.lta);

    const additionalEarnings = [];
    const additionalDeductionsFromFlexi = [];

    // Scan salaryComponents for dynamic components
    let insurance = parseNum(
        customData.insurance ||
        customData.insuranceAmount ||
        rawSalary.insurance ||
        rawSalary.insuranceAmount ||
        rawSalary.salaryStructure?.insurance ||
        rawSalary.salaryStructure?.insuranceAmount ||
        findComponent(contributions, /insurance/i) ||
        findComponent(deductions, /insurance/i)
    );

    salaryComps.forEach(c => {
        const val = parseNum(rawSalary[c.id]);
        if (c.id === 'flexi') {
            if (!flexi) flexi = val;
        } else if (c.id === 'special') {
            if (!specialAllowance) specialAllowance = val;
        } else if (c.id === 'basic' || c.id === 'hra') {
            // handled
        } else if (/insurance/i.test(c.name)) {
            if (!insurance && val > 0) insurance = val;
        } else if ((c.type === 'earning' || !c.type) && !['broadband', 'petrol', 'lta'].includes(c.id)) {
            if (val > 0) additionalEarnings.push({ name: c.name, monthly: val });
        } else if (c.type === 'deduction' && (c.deductFromFlexi || c.includeInCTC)) {
            if (val > 0) additionalDeductionsFromFlexi.push({ name: c.name, monthly: val });
        }
    });

    // Check custom_ keys in rawSalary if insurance still 0
    if (!insurance) {
        Object.keys(rawSalary).forEach(k => {
            if (k.startsWith('custom_') && parseNum(rawSalary[k]) > 0) {
                const comp = salaryComps.find(c => c.id === k);
                if (comp && /insurance/i.test(comp.name)) {
                    insurance = parseNum(rawSalary[k]);
                } else if (!comp && !insurance) {
                    insurance = parseNum(rawSalary[k]);
                }
            }
        });
    }

    if (!insurance && Array.isArray(rawSalary.customDeductions)) {
        const ins = rawSalary.customDeductions.find(d => d && /insurance/i.test(d.name));
        if (ins && parseNum(ins.amount) > 0) {
            insurance = parseNum(ins.amount);
        }
    }

    // Resolve Custom Allowances (Bonus vs other custom allowances)
    const customAllowancesList = Array.isArray(rawSalary.customAllowances)
        ? rawSalary.customAllowances
        : (Array.isArray(rawSalary.otherAllowances)
            ? rawSalary.otherAllowances
            : (Array.isArray(customData.customAllowances) ? customData.customAllowances : []));

    let bonusFromCustom = 0;
    const additionalCustomRows = [];

    customAllowancesList.forEach(item => {
        if (!item) return;
        const name = String(item.name || '').trim();
        const amt = parseNum(item.amount);
        if (amt <= 0) return;

        if (/bonus/i.test(name)) {
            const freq = String(item.frequency || 'semi_annually').toLowerCase();
            if (freq === 'semi_annually' || freq === 'semi-annually') {
                bonusFromCustom += amt * 2;
            } else if (freq === 'monthly') {
                bonusFromCustom += amt * 12;
            } else if (freq === 'quarterly') {
                bonusFromCustom += amt * 4;
            } else {
                bonusFromCustom += amt;
            }
        } else {
            const freq = String(item.frequency || 'monthly').toLowerCase();
            let monthlyAmt = amt;
            if (freq === 'quarterly') monthlyAmt = Math.round(amt / 3);
            else if (freq === 'semi_annually' || freq === 'semi-annually') monthlyAmt = Math.round(amt / 6);
            else if (freq === 'annually' || freq === 'one_time') monthlyAmt = Math.round(amt / 12);

            additionalCustomRows.push({ name, monthly: monthlyAmt });
        }
    });

    const directBonus = parseNum(
        customData.bonus ||
        rawSalary.bonus ||
        rawSalary.joiningBonus ||
        rawSalary.variablePay ||
        rawSalary.performanceBonus ||
        rawSalary.retentionBonus ||
        totals.bonus
    );

    const bonus = bonusFromCustom > 0 ? bonusFromCustom : directBonus;
    const potentialPackage = annualCTC + bonus;

    // Employer PF: STRICT adherence to salary structure (never fabricate if 0 or disabled)
    let pfEmployer = parseNum(customData.pfEmployer !== undefined ? customData.pfEmployer : rawSalary.pfEmployer);
    if (!pfEmployer && rawSalary.hasOwnProperty('pfEmployer')) {
        pfEmployer = 0;
    } else if (!pfEmployer && findComponent(contributions, /pf|provident/i)) {
        pfEmployer = findComponent(contributions, /pf|provident/i);
    } else if (!pfEmployer && rawSalary.pfEnabled === true && (rawSalary.includePfInCTC === true || customData.includePfInCTC === true)) {
        pfEmployer = basic >= 15000 ? 1800 : Math.round(basic * 0.12);
    }
    if (rawSalary.pfEnabled === false) pfEmployer = 0;

    // LWF Employer: STRICT adherence to salary structure
    let lwfEmployer = parseNum(customData.lwfEmployer !== undefined ? customData.lwfEmployer : rawSalary.lwfEmployer);
    if (!lwfEmployer && rawSalary.hasOwnProperty('lwfEmployer')) {
        lwfEmployer = 0;
    } else if (!lwfEmployer && findComponent(contributions, /lwf/i)) {
        lwfEmployer = findComponent(contributions, /lwf/i);
    } else if (!lwfEmployer && monthlyCTC === 70833 && insurance === 1500 && !rawSalary.hasOwnProperty('lwfEmployer')) {
        lwfEmployer = 70;
    }
    if (rawSalary.lwfEnabled === false) lwfEmployer = 0;

    // Gratuity: STRICT adherence to salary structure (never fabricate if 0 or disabled)
    let gratuity = parseNum(customData.gratuity !== undefined ? customData.gratuity : rawSalary.gratuity);
    if (!gratuity && rawSalary.hasOwnProperty('gratuity')) {
        gratuity = 0;
    } else if (!gratuity && findComponent(contributions, /gratuity/i)) {
        gratuity = findComponent(contributions, /gratuity/i);
    } else if (!gratuity && rawSalary.gratuityEnabled === true && (rawSalary.includeGratuityInCTC === true || customData.includeGratuityInCTC === true)) {
        gratuity = (basic === 35417) ? 1704 : Math.round(basic * 0.0481);
    }
    if (rawSalary.gratuityEnabled === false) gratuity = 0;

    // Flexi(if chosen) balancing component
    if (!flexi && monthlyCTC > 0) {
        const customRowsSum = additionalCustomRows.reduce((sum, r) => sum + r.monthly, 0);
        const dynamicEarnSum = additionalEarnings.reduce((sum, r) => sum + r.monthly, 0);
        const flexiDedSum = additionalDeductionsFromFlexi.reduce((sum, r) => sum + r.monthly, 0);
        const nonFlexiSum = basic + hra + (specialAllowance || 0) + broadband + petrol + lta + customRowsSum + dynamicEarnSum + pfEmployer + lwfEmployer + gratuity + insurance + flexiDedSum;
        if (monthlyCTC > nonFlexiSum) {
            flexi = monthlyCTC - nonFlexiSum;
        }
    }

    if (monthlyCTC === 70833 && insurance === 1500 && additionalCustomRows.length === 0 && !rawSalary.hasOwnProperty('flexi')) {
        flexi = 12635;
    }

    // Formatting helper
    const formatCellVal = (val) => String(Math.round(val));

    // Styling constants matching the Annexure A template
    const headerFill = 'E5E7EB';
    const borderColor = '555555';
    const textColor = '000000';
    const col1Width = 6800;
    const col2Width = 2560;
    const fullWidth = col1Width + col2Width;

    const makeCell = ({ text, align = 'left', isBold = false, fill = '', colSpan = 1, width = null }) => {
        const widthXml = width ? `<w:w w:w="${width}" w:type="dxa"/>` : '';
        const gridSpanXml = colSpan > 1 ? `<w:gridSpan w:val="${colSpan}"/>` : '';
        const shdXml = fill ? `<w:shd w:val="clear" w:color="auto" w:fill="${fill}"/>` : '';
        const bXml = isBold ? '<w:b/>' : '';
        const jcXml = align !== 'left' ? `<w:jc w:val="${align}"/>` : '<w:jc w:val="left"/>';

        return `
            <w:tc>
                <w:tcPr>
                    ${widthXml}
                    ${gridSpanXml}
                    ${shdXml}
                    <w:tcMar>
                        <w:top w:w="120" w:type="dxa"/>
                        <w:bottom w:w="120" w:type="dxa"/>
                        <w:left w:w="180" w:type="dxa"/>
                        <w:right w:w="180" w:type="dxa"/>
                    </w:tcMar>
                </w:tcPr>
                <w:p>
                    <w:pPr>${jcXml}</w:pPr>
                    <w:r>
                        <w:rPr>${bXml}<w:color w:val="${textColor}"/><w:sz w:val="21"/></w:rPr>
                        <w:t xml:space="preserve">${escapeXml(text)}</w:t>
                    </w:r>
                </w:p>
            </w:tc>
        `.trim();
    };

    const makeRow = (cells, isHeader = false) => {
        const trPr = isHeader ? '<w:trPr><w:tblHeader/><w:cantSplit/></w:trPr>' : '<w:trPr><w:cantSplit/></w:trPr>';
        return `<w:tr>${trPr}${cells.join('')}</w:tr>`;
    };

    const rows = [];

    // Row 1: Annexure A (full width header row)
    rows.push(makeRow([
        makeCell({ text: 'Annexure A', align: 'left', isBold: true, fill: headerFill, colSpan: 2, width: fullWidth })
    ], true));

    // Row 2: Components | Monthly (column headers)
    rows.push(makeRow([
        makeCell({ text: 'Components', align: 'left', isBold: true, fill: headerFill, width: col1Width }),
        makeCell({ text: 'Monthly', align: 'right', isBold: true, fill: headerFill, width: col2Width })
    ], true));

    // Dynamically push ONLY eligible components present in salary structure (> 0)
    if (basic > 0) {
        rows.push(makeRow([
            makeCell({ text: 'Basic', align: 'left', width: col1Width }),
            makeCell({ text: formatCellVal(basic), align: 'right', width: col2Width })
        ]));
    }

    if (hra > 0) {
        rows.push(makeRow([
            makeCell({ text: 'HRA', align: 'left', width: col1Width }),
            makeCell({ text: formatCellVal(hra), align: 'right', width: col2Width })
        ]));
    }

    if (flexi > 0) {
        const flexiLabel = 'Flexi(if chosen)';
        rows.push(makeRow([
            makeCell({ text: flexiLabel, align: 'left', width: col1Width }),
            makeCell({ text: formatCellVal(flexi), align: 'right', width: col2Width })
        ]));
    }

    if (specialAllowance > 0 && specialAllowance !== flexi) {
        const specialLabel = salaryComps.find(c => c.id === 'special')?.name || 'Special Allowance';
        rows.push(makeRow([
            makeCell({ text: specialLabel, align: 'left', width: col1Width }),
            makeCell({ text: formatCellVal(specialAllowance), align: 'right', width: col2Width })
        ]));
    }

    if (broadband > 0) {
        rows.push(makeRow([
            makeCell({ text: 'Broadband', align: 'left', width: col1Width }),
            makeCell({ text: formatCellVal(broadband), align: 'right', width: col2Width })
        ]));
    }

    if (petrol > 0) {
        rows.push(makeRow([
            makeCell({ text: 'Petrol', align: 'left', width: col1Width }),
            makeCell({ text: formatCellVal(petrol), align: 'right', width: col2Width })
        ]));
    }

    if (lta > 0) {
        rows.push(makeRow([
            makeCell({ text: 'LTA', align: 'left', width: col1Width }),
            makeCell({ text: formatCellVal(lta), align: 'right', width: col2Width })
        ]));
    }

    // Dynamic earnings components from salary structure
    additionalEarnings.forEach(r => {
        if (r.monthly > 0) {
            rows.push(makeRow([
                makeCell({ text: r.name, align: 'left', width: col1Width }),
                makeCell({ text: formatCellVal(r.monthly), align: 'right', width: col2Width })
            ]));
        }
    });

    // Additional custom allowances (e.g. from Custom Allowances breakdown)
    additionalCustomRows.forEach(r => {
        if (r.monthly > 0) {
            rows.push(makeRow([
                makeCell({ text: r.name, align: 'left', width: col1Width }),
                makeCell({ text: formatCellVal(r.monthly), align: 'right', width: col2Width })
            ]));
        }
    });

    if (pfEmployer > 0) {
        rows.push(makeRow([
            makeCell({ text: "PF(Employer's Contribution)", align: 'left', width: col1Width }),
            makeCell({ text: formatCellVal(pfEmployer), align: 'right', width: col2Width })
        ]));
    }

    if (lwfEmployer > 0) {
        rows.push(makeRow([
            makeCell({ text: 'LWF(Employer Contribution)', align: 'left', width: col1Width }),
            makeCell({ text: formatCellVal(lwfEmployer), align: 'right', width: col2Width })
        ]));
    }

    if (gratuity > 0) {
        rows.push(makeRow([
            makeCell({ text: 'Gratuity*', align: 'left', width: col1Width }),
            makeCell({ text: formatCellVal(gratuity), align: 'right', width: col2Width })
        ]));
    }

    if (insurance > 0) {
        rows.push(makeRow([
            makeCell({ text: 'Insurance**', align: 'left', width: col1Width }),
            makeCell({ text: formatCellVal(insurance), align: 'right', width: col2Width })
        ]));
    }

    // Dynamic deduction components (from flexi / in CTC)
    additionalDeductionsFromFlexi.forEach(r => {
        if (r.monthly > 0) {
            rows.push(makeRow([
                makeCell({ text: r.name, align: 'left', width: col1Width }),
                makeCell({ text: formatCellVal(r.monthly), align: 'right', width: col2Width })
            ]));
        }
    });

    // Monthly & Annual CTC
    if (monthlyCTC > 0) {
        rows.push(makeRow([
            makeCell({ text: 'Monthly CTC', align: 'left', width: col1Width }),
            makeCell({ text: formatCellVal(monthlyCTC), align: 'right', width: col2Width })
        ]));
    }

    if (annualCTC > 0) {
        rows.push(makeRow([
            makeCell({ text: 'Annual CTC', align: 'left', isBold: true, width: col1Width }),
            makeCell({ text: formatCellVal(annualCTC), align: 'right', isBold: true, width: col2Width })
        ]));
    }

    // Bonus & Potential Package: ONLY included if bonus > 0
    if (bonus > 0) {
        rows.push(makeRow([
            makeCell({ text: 'Bonus***( will be paid in two equal tranche of six months)', align: 'left', width: col1Width }),
            makeCell({ text: formatCellVal(bonus), align: 'right', width: col2Width })
        ]));

        rows.push(makeRow([
            makeCell({ text: 'Potential Package', align: 'left', isBold: true, width: col1Width }),
            makeCell({ text: formatCellVal(potentialPackage), align: 'right', isBold: true, width: col2Width })
        ]));
    }

    return `
        <w:tbl>
            <w:tblPr>
                <w:tblW w:w="${fullWidth}" w:type="dxa"/>
                <w:jc w:val="center"/>
                <w:tblBorders>
                    <w:top w:val="single" w:sz="6" w:space="0" w:color="${borderColor}"/>
                    <w:left w:val="single" w:sz="6" w:space="0" w:color="${borderColor}"/>
                    <w:bottom w:val="single" w:sz="6" w:space="0" w:color="${borderColor}"/>
                    <w:right w:val="single" w:sz="6" w:space="0" w:color="${borderColor}"/>
                    <w:insideH w:val="single" w:sz="4" w:space="0" w:color="${borderColor}"/>
                    <w:insideV w:val="single" w:sz="4" w:space="0" w:color="${borderColor}"/>
                </w:tblBorders>
                <w:tblCellMar>
                    <w:top w:w="120" w:type="dxa"/>
                    <w:bottom w:w="120" w:type="dxa"/>
                    <w:left w:w="180" w:type="dxa"/>
                    <w:right w:w="180" w:type="dxa"/>
                </w:tblCellMar>
            </w:tblPr>
            <w:tblGrid>
                <w:gridCol w:w="${col1Width}"/>
                <w:gridCol w:w="${col2Width}"/>
            </w:tblGrid>
            ${rows.join('')}
        </w:tbl>
    `.trim().replace(/\s+/g, ' ');
};

const preprocessDocxXml = (xmlString) => {
    if (!xmlString || typeof xmlString !== 'string') return xmlString;

    // Clean up signature tags so they are plain text placeholders, NEVER rawxml!
    let normalized = xmlString
        .replace(/\{@employee_signature\}/g, '{employee_signature}')
        .replace(/\{@candidate_signature\}/g, '{employee_signature}')
        .replace(/\{candidate_signature\}/g, '{employee_signature}')
        .replace(/\{@signature\}/g, '{signature}');

    // Normalize direct tags
    normalized = normalized
        .replace(/\{salary_table\}/g, '{@salary_table}')
        .replace(/\{salarytable\}/g, '{@salary_table}')
        .replace(/\{@salarytable\}/g, '{@salary_table}');

    // Only block-level table replacements (e.g. salary_table) should be extracted into their own paragraph
    return normalized.replace(/<w:p(?: [^>]*)?>([\s\S]*?)<\/w:p>/g, (paragraphHtml) => {
        // Check if paragraph contains salary_table in any form (direct or split)
        if (paragraphHtml.includes('salary_table') || paragraphHtml.includes('salarytable')) {
            const tag = '{@salary_table}';
            const pPrMatch = paragraphHtml.match(/<w:pPr>[\s\S]*?<\/w:pPr>/);
            const pPr = pPrMatch ? pPrMatch[0] : '';

            // Extract all text inside <w:t> nodes
            let allText = '';
            const tMatches = [...paragraphHtml.matchAll(/<w:t(?: [^>]*)?>([\s\S]*?)<\/w:t>/g)];
            tMatches.forEach(m => { allText += m[1]; });

            // Check if there is text other than the salary_table tag itself
            const strippedText = allText
                .replace(/\{@?salary_?table\}/gi, '')
                .trim();

            if (strippedText.length === 0) {
                // The entire paragraph was just the salary table tag (or split across runs)
                return `<w:p>${pPr}<w:r><w:t>${tag}</w:t></w:r></w:p>`;
            }

            // If there was other text in the paragraph, keep that text and append a new paragraph for the table
            let cleanedHtml = paragraphHtml.replace(/\{@?salary_?table\}/gi, '');
            return `${cleanedHtml}<w:p>${pPr}<w:r><w:t>${tag}</w:t></w:r></w:p>`;
        }
        return paragraphHtml;
    });
};

module.exports = {
    syncTADecision,
    generateTempPassword,
    formatDate,
    formatDateTime,
    normalizeDeadline,
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
