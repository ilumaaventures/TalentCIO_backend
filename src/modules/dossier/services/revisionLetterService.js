const fs = require('fs');
const path = require('path');
const axios = require('axios');
const PizZip = require('pizzip');
const Docxtemplater = require('docxtemplater');
const User = require('../../user/user.model');
const EmployeeProfile = require('../employeeProfile.model');
const EmployeeRevision = require('../employeeRevision.model');
const Company = require('../../company/company.model');
const PayrollConfig = require('../../payroll/payrollConfig.model');
const HREmailLog = require('../../email/model/hrEmailLog.model');
const { cloudinary } = require('../../../config/cloudinary');
const { sendEmailForCompany } = require('../../../services/companyEmailService');
const { processCalculatedSalary, buildPayrollSnapshot } = require('../../payroll/payrollMath');
const {
    formatDate,
    formatCurrency,
    buildSalaryTableXml,
    preprocessDocxXml
} = require('../../onboarding/utils/onboardingHelpers');

/**
 * Upload a document buffer to Cloudinary in the employee dossier folder
 */
const formatDateLabel = (d) => {
    try {
        const date = d ? new Date(d) : new Date();
        const y = date.getFullYear();
        const m = String(date.getMonth() + 1).padStart(2, '0');
        const day = String(date.getDate()).padStart(2, '0');
        return `${y}${m}${day}`;
    } catch {
        return 'revision';
    }
};

const uploadBufferToCloudinary = async (buffer, folder, filename) => {
    return new Promise((resolve, reject) => {
        const stream = cloudinary.uploader.upload_stream(
            {
                folder,
                resource_type: 'raw',
                public_id: filename
            },
            (error, uploaded) => {
                if (error) {
                    console.error('Cloudinary upload error:', error);
                    return reject(error);
                }
                resolve(uploaded);
            }
        );
        stream.end(buffer);
    });
};

/**
 * Resolves the salary breakups and builds the Word XML salary table for an active employee
 */
const computeSalaryBreakupDetails = (salaryData = {}, config = null) => {
    const rawAnnual = salaryData.annualCTC || salaryData.ctc || 0;
    const rawMonthly = salaryData.monthlyCTC || (rawAnnual ? Math.round(Number(rawAnnual) / 12) : 0);
    const annualCTC = parseFloat(String(rawAnnual || 0).replace(/[^0-9.]/g, '')) || 0;
    const monthlyCTC = parseFloat(String(rawMonthly || 0).replace(/[^0-9.]/g, '')) || 0;

    const earningsList = [];
    const contributionsList = [];
    const deductionsList = [];

    let totalMonthlyGross = monthlyCTC;
    let totalAnnualGross = annualCTC;
    let totalMonthlyContrib = 0;
    let totalAnnualContrib = 0;
    let totalMonthlyDeductions = 0;
    let totalAnnualDeductions = 0;
    let netMonthly = monthlyCTC;
    let netAnnual = annualCTC;
    let basicVal = Math.round(monthlyCTC * 0.5);
    let hraVal = Math.round(basicVal * 0.5);
    let specialVal = Math.max(0, monthlyCTC - basicVal - hraVal);
    let master = null;

    if (config) {
        try {
            const calculated = processCalculatedSalary(salaryData, config, annualCTC, monthlyCTC);
            if (calculated && calculated.master) {
                master = calculated.master;
                const comps = Array.isArray(config.salaryComponents) ? config.salaryComponents : [];

                const getEarningVal = (cId) => {
                    if (master.earningsMap && master.earningsMap[cId] !== undefined) return master.earningsMap[cId];
                    if (cId === 'basic') return master.basicMaster || 0;
                    if (cId === 'hra') return master.hraMaster || 0;
                    if (cId === 'special') return master.specialAllowance || 0;
                    return 0;
                };

                comps.filter(c => c.type === 'earning').forEach(c => {
                    const val = getEarningVal(c.id);
                    if (c.id === 'basic' || c.id === 'hra' || val > 0) {
                        earningsList.push({
                            name: c.name || c.id,
                            monthly: formatCurrency(val),
                            annual: formatCurrency(val * 12)
                        });
                    }
                });

                const prefs = config.displayPreferences || {};

                if (prefs.showEmployerStatutory !== false) {
                    if (prefs.showPFEmployer !== false && master.pfEmployer > 0) {
                        contributionsList.push({
                            name: 'PF Employer Contribution',
                            monthly: formatCurrency(master.pfEmployer),
                            annual: formatCurrency(master.pfEmployer * 12)
                        });
                    }
                    if (prefs.showESIEmployer !== false && master.esiEmployer > 0) {
                        contributionsList.push({
                            name: 'ESI Employer Contribution',
                            monthly: formatCurrency(master.esiEmployer),
                            annual: formatCurrency(master.esiEmployer * 12)
                        });
                    }
                    if (prefs.showGratuity !== false && master.gratuity > 0) {
                        contributionsList.push({
                            name: 'Gratuity Provision',
                            monthly: formatCurrency(master.gratuity),
                            annual: formatCurrency(master.gratuity * 12)
                        });
                    }
                    if (prefs.showLWFEmployer !== false && master.lwfEmployer > 0) {
                        contributionsList.push({
                            name: 'LWF Employer Share',
                            monthly: formatCurrency(master.lwfEmployer),
                            annual: formatCurrency(master.lwfEmployer * 12)
                        });
                    }
                }

                const payroll = buildPayrollSnapshot(salaryData, config, {
                    workingDays: config.defaultWorkingDays || 26,
                    paidDays: config.defaultWorkingDays || 26
                }, {}, new Date().getMonth() + 1, new Date().getFullYear());

                if (prefs.showEmployeeDeductions !== false && payroll && payroll.deductions) {
                    if (prefs.showPFEmployee !== false && payroll.deductions.pfEmployee > 0) {
                        deductionsList.push({
                            name: 'PF Employee Contribution',
                            monthly: formatCurrency(payroll.deductions.pfEmployee),
                            annual: formatCurrency(payroll.deductions.pfEmployee * 12)
                        });
                    }
                    if (prefs.showESIEmployee !== false && payroll.deductions.esiEmployee > 0) {
                        deductionsList.push({
                            name: 'ESI Employee Contribution',
                            monthly: formatCurrency(payroll.deductions.esiEmployee),
                            annual: formatCurrency(payroll.deductions.esiEmployee * 12)
                        });
                    }
                    if (prefs.showProfessionalTax !== false && payroll.deductions.professionalTax > 0) {
                        deductionsList.push({
                            name: 'Professional Tax (PT)',
                            monthly: formatCurrency(payroll.deductions.professionalTax),
                            annual: formatCurrency(payroll.deductions.professionalTax * 12)
                        });
                    }
                    if (prefs.showLWFEmployee !== false && payroll.deductions.lwfEmployee > 0) {
                        deductionsList.push({
                            name: 'LWF Employee Share',
                            monthly: formatCurrency(payroll.deductions.lwfEmployee),
                            annual: formatCurrency(payroll.deductions.lwfEmployee * 12)
                        });
                    }
                }

                totalMonthlyGross = master.totalEarnings || monthlyCTC;
                totalAnnualGross = totalMonthlyGross * 12;

                totalMonthlyContrib = (master.pfEmployer || 0) + (master.esiEmployer || 0) + (master.gratuity || 0) + (master.lwfEmployer || 0);
                totalAnnualContrib = totalMonthlyContrib * 12;

                totalMonthlyDeductions = (payroll?.deductions?.pfEmployee || 0) + (payroll?.deductions?.esiEmployee || 0) + (payroll?.deductions?.professionalTax || 0) + (payroll?.deductions?.lwfEmployee || 0);
                totalAnnualDeductions = totalMonthlyDeductions * 12;

                netMonthly = master.netTakeHome || Math.max(0, totalMonthlyGross - totalMonthlyDeductions);
                netAnnual = netMonthly * 12;

                basicVal = master.basicMaster || basicVal;
                hraVal = master.hraMaster || hraVal;
                specialVal = master.specialAllowance || specialVal;
            }
        } catch (err) {
            console.error('Error computing salary table breakup:', err);
        }
    }

    if (earningsList.length === 0) {
        earningsList.push(
            { name: 'Basic Salary', monthly: formatCurrency(basicVal), annual: formatCurrency(basicVal * 12) },
            { name: 'House Rent Allowance (HRA)', monthly: formatCurrency(hraVal), annual: formatCurrency(hraVal * 12) },
            { name: 'Special Allowance', monthly: formatCurrency(specialVal), annual: formatCurrency(specialVal * 12) }
        );
    }

    const totals = {
        monthlyGross: formatCurrency(totalMonthlyGross),
        annualGross: formatCurrency(totalAnnualGross),
        monthlyContributions: formatCurrency(totalMonthlyContrib),
        annualContributions: formatCurrency(totalAnnualContrib),
        monthlyCTC: formatCurrency(monthlyCTC),
        annualCTC: formatCurrency(annualCTC),
        monthlyDeductions: formatCurrency(totalMonthlyDeductions),
        annualDeductions: formatCurrency(totalAnnualDeductions),
        monthlyNet: formatCurrency(netMonthly),
        annualNet: formatCurrency(netAnnual)
    };

    const rawSal = salaryData || {};
    const isNonStructured = rawSal.useSalaryComponents === false || rawSal.payType === 'flat' || rawSal.payType === 'hourly';

    const parseN = (val) => {
        if (val === undefined || val === null || val === '') return 0;
        const n = parseFloat(String(val).replace(/[^0-9.]/g, ''));
        return isNaN(n) ? 0 : Math.round(n);
    };

    const tableData = {
        config: config,
        salaryComponents: config?.salaryComponents || [],
        useSalaryComponents: !isNonStructured,
        rawSalary: rawSal,
        customAllowances: rawSal.customAllowances || rawSal.otherAllowances || [],
        basic: isNonStructured ? parseN(rawSal.flatSalary || rawSal.basic || monthlyCTC) : parseN(rawSal.basic || basicVal),
        hra: isNonStructured ? 0 : parseN(rawSal.hra || hraVal),
        flexi: isNonStructured ? 0 : parseN(rawSal.flexi || rawSal.flexiAmount || master?.flexi || 0),
        specialAllowance: isNonStructured ? 0 : parseN(rawSal.special || rawSal.specialAllowance || specialVal || 0),
        broadband: isNonStructured ? 0 : parseN(rawSal.broadband || master?.broadband || 0),
        petrol: isNonStructured ? 0 : parseN(rawSal.petrol || master?.petrol || 0),
        lta: isNonStructured ? 0 : parseN(rawSal.lta || master?.lta || 0),
        pfEmployer: isNonStructured ? 0 : parseN(rawSal.pfEmployer !== undefined ? rawSal.pfEmployer : (master?.pfEmployer || 0)),
        lwfEmployer: isNonStructured ? 0 : parseN(rawSal.lwfEmployer !== undefined ? rawSal.lwfEmployer : (master?.lwfEmployer || 0)),
        gratuity: isNonStructured ? 0 : parseN(rawSal.gratuity !== undefined ? rawSal.gratuity : (master?.gratuity || 0)),
        insurance: isNonStructured ? 0 : parseN(rawSal.insurance || rawSal.insuranceAmount || master?.insurance || 0),
        monthlyCTC: monthlyCTC,
        annualCTC: annualCTC,
        bonus: parseN(rawSal.bonus ?? rawSal.joiningBonus ?? rawSal.variablePay ?? 0)
    };
    const salaryTableXml = buildSalaryTableXml(earningsList, contributionsList, deductionsList, totals, tableData);

    return {
        annualCTC,
        monthlyCTC,
        basicVal,
        hraVal,
        specialVal,
        monthlyGross: totalMonthlyGross,
        netMonthly,
        earningsList,
        contributionsList,
        deductionsList,
        totals,
        salaryTableXml
    };
};

/**
 * Loads the template content from URL or local default
 */
const getTemplateBuffer = async (company, requestedTemplateId = null) => {
    // If explicitly requested 'default', load the built-in professional template directly!
    if (requestedTemplateId === 'default') {
        const fallbackPath = path.join(__dirname, '../templates/defaultRevisionLetter.docx');
        if (fs.existsSync(fallbackPath)) {
            return {
                buffer: fs.readFileSync(fallbackPath),
                name: 'Built-in Professional Revision Offer Letter',
                isCustom: false
            };
        }
    }

    let targetUrl = null;
    let templateName = 'Custom Revision Letter';

    if (requestedTemplateId && requestedTemplateId !== 'default') {
        if (requestedTemplateId === 'company_offer' && company?.settings?.onboarding?.offerLetterTemplateUrl) {
            targetUrl = company.settings.onboarding.offerLetterTemplateUrl;
            templateName = 'Company Default Offer Letter';
        } else {
            const found = (company?.settings?.onboarding?.dynamicTemplates || []).find(
                t => String(t._id) === String(requestedTemplateId)
            );
            if (found && found.url) {
                targetUrl = found.url;
                templateName = found.name || 'Custom Dynamic Template';
            }
        }
    }

    // Only if NO template was explicitly requested, look for a custom revision/restructure template
    if (!requestedTemplateId && !targetUrl) {
        const dynamicRevision = (company?.settings?.onboarding?.dynamicTemplates || []).find(
            t => /revision|restructure/i.test(t.name)
        );
        if (dynamicRevision && dynamicRevision.url) {
            targetUrl = dynamicRevision.url;
            templateName = dynamicRevision.name;
        }
    }

    if (targetUrl && targetUrl.startsWith('http')) {
        try {
            const resp = await axios.get(targetUrl, { responseType: 'arraybuffer', timeout: 10000 });
            return {
                buffer: Buffer.from(resp.data),
                name: templateName,
                isCustom: true,
                url: targetUrl
            };
        } catch (e) {
            console.warn(`Failed to fetch remote template from ${targetUrl}, falling back to built-in template:`, e.message);
        }
    }

    // Built-in fallback
    const fallbackPath = path.join(__dirname, '../templates/defaultRevisionLetter.docx');
    if (fs.existsSync(fallbackPath)) {
        return {
            buffer: fs.readFileSync(fallbackPath),
            name: 'Built-in Professional Revision Offer Letter',
            isCustom: false
        };
    }

    throw new Error('No template document found and fallback template is unavailable.');
};

/**
 * Builds data dictionary for letter rendering
 */
const buildRevisionLetterData = ({ user, profile, revision, company, config }) => {
    const salaryData = revision?.metadata?.salaryBreakup || profile?.compensation?.salaryBreakup || profile?.compensation || {};
    const breakupDetails = computeSalaryBreakupDetails(salaryData, config);

    const fullName = `${user.firstName || ''} ${user.lastName || ''}`.trim() || 'Employee';
    const effectiveDateStr = formatDate(revision?.effectiveDate || new Date());
    const hrUser = revision?.createdBy || {};
    const hrName = hrUser.firstName ? `${hrUser.firstName} ${hrUser.lastName || ''}`.trim() : 'Authorized Signatory';
    const hrDesignation = hrUser.designation || 'Human Resources';

    const empPermAddr = profile?.personalDetails?.permanentAddress || profile?.personalDetails?.currentAddress || {};
    const addressStr = [empPermAddr.line1, empPermAddr.line2].filter(Boolean).join(', ') || profile?.address || '—';
    const cityStr = empPermAddr.city || '—';

    const renderData = {
        company_name: company?.name || 'Company',
        company_email: company?.email || '—',
        company_website: company?.website || '—',
        offer_date: effectiveDateStr,
        effective_date: effectiveDateStr,
        employee_full_name: fullName,
        employee_first_name: user.firstName || 'Employee',
        employee_last_name: user.lastName || '',
        employee_id: user.employeeCode || profile?.employment?.employeeId || '—',
        employee_code: user.employeeCode || profile?.employment?.employeeId || '—',
        designation: profile?.employment?.designation || user.designation || '—',
        department: profile?.employment?.department || user.department || '—',
        work_location: profile?.employment?.workLocation || user.workLocation || '—',
        joining_date: formatDate(profile?.employment?.joiningDate || user.joiningDate),
        probation_period: profile?.employment?.probationPeriod || 'Confirmed',
        probationPeriod: profile?.employment?.probationPeriod || 'Confirmed',
        employee_address: addressStr,
        employee_city: cityStr,
        employee_email: user.email || profile?.contact?.workEmail || '—',
        employee_phone: user.phone || profile?.personalDetails?.phone || '—',
        annual_ctc: formatCurrency(breakupDetails.annualCTC),
        annual_salary: formatCurrency(breakupDetails.annualCTC),
        monthly_gross: formatCurrency(breakupDetails.monthlyGross),
        monthly_ctc: formatCurrency(breakupDetails.monthlyCTC),
        basic_salary: formatCurrency(breakupDetails.basicVal),
        basic: formatCurrency(breakupDetails.basicVal),
        hra: formatCurrency(breakupDetails.hraVal),
        special_allowance: formatCurrency(breakupDetails.specialVal),
        revision_reason: revision?.reason || 'Annual Appraisal & Hike',
        reason_for_revision: revision?.reason || 'Annual Appraisal & Hike',
        net_take_home: formatCurrency(breakupDetails.netMonthly),
        monthly_net: formatCurrency(breakupDetails.netMonthly),
        annual_net: formatCurrency(breakupDetails.totals?.annualNet || breakupDetails.netMonthly * 12),
        annual_gross: formatCurrency(breakupDetails.totals?.annualGross || breakupDetails.monthlyGross * 12),
        total_employer_contributions: formatCurrency(breakupDetails.totals?.monthlyContributions || 0),
        total_deductions: formatCurrency(breakupDetails.totals?.monthlyDeductions || 0),
        current_date: formatDate(new Date()),
        date: effectiveDateStr,
        hr_name: hrName,
        authorized_signatory: hrName,
        signatory: hrName,
        signatory_name: hrName,
        signatory_designation: hrDesignation,
        hr_designation: hrDesignation,
        employee_signature: fullName,
        employee_signature_name: fullName,
        candidate_signature: fullName,
        signature: hrName,
        salary_table: breakupDetails.salaryTableXml,
        salaryTable: breakupDetails.salaryTableXml,
        salarytable: breakupDetails.salaryTableXml,
        annexure_a: breakupDetails.salaryTableXml,
        annexureA: breakupDetails.salaryTableXml,
        compensation_table: breakupDetails.salaryTableXml,
        earnings_breakdown: breakupDetails.earningsList || [],
        contributions_breakdown: breakupDetails.contributionsList || [],
        deductions_breakdown: breakupDetails.deductionsList || [],
        all_components: [
            ...(breakupDetails.earningsList || []).map(e => ({ category: 'Earnings', ...e })),
            ...(breakupDetails.contributionsList || []).map(c => ({ category: 'Employer Contributions', ...c })),
            ...(breakupDetails.deductionsList || []).map(d => ({ category: 'Employee Deductions', ...d }))
        ]
    };

    if (config && config.salaryComponents) {
        config.salaryComponents.forEach(c => {
            const val = salaryData[c.id] || 0;
            const formatted = formatCurrency(val);
            renderData[c.id] = formatted;
            renderData[`${c.id}_annual`] = formatCurrency(val * 12);
            const cleanId = c.id.replace(/([A-Z])/g, '_$1').toLowerCase();
            renderData[cleanId] = formatted;
            renderData[`${cleanId}_annual`] = formatCurrency(val * 12);
            if (!cleanId.endsWith('_allowance')) {
                renderData[`${cleanId}_allowance`] = formatted;
                renderData[`${cleanId}_allowance_annual`] = formatCurrency(val * 12);
            }
        });
    }

    return { renderData, breakupDetails };
};

/**
 * Pure helper to render DOCX with Docxtemplater
 */
const renderDocxZip = (rawBuffer, renderData) => {
    const zip = new PizZip(rawBuffer);
    let docXml = zip.file('word/document.xml').asText();
    docXml = preprocessDocxXml(docXml);
    zip.file('word/document.xml', docXml);

    const doc = new Docxtemplater(zip, {
        paragraphLoop: true,
        linebreaks: true,
        nullGetter: (part) => {
            if (part && part.module === 'rawxml') return '';
            return '—';
        }
    });

    doc.render(renderData);
    return doc.getZip().generate({ type: 'nodebuffer', compression: 'DEFLATE' });
};

/**
 * Generates the populated DOCX buffer for an employee revision
 */
const generateRevisionLetterBuffer = async ({ user, profile, revision, company, config, templateId = null }) => {
    const templateInfo = await getTemplateBuffer(company, templateId);
    const { renderData, breakupDetails } = buildRevisionLetterData({ user, profile, revision, company, config });

    try {
        const buffer = renderDocxZip(templateInfo.buffer, renderData);
        buffer.usedTemplateName = templateInfo.name;
        buffer.fallbackUsed = false;
        buffer.breakupDetails = breakupDetails;
        return buffer;
    } catch (renderErr) {
        const errorDetails = (renderErr.properties?.errors || [])
            .map(e => e.properties?.explanation || e.message)
            .filter(Boolean);
        const detailedMsg = errorDetails.length > 0 ? errorDetails.join('; ') : (renderErr.message || 'Template syntax error');
        console.warn(`[RevisionLetter] Failed to render template "${templateInfo.name}": ${detailedMsg}`);

        // If a custom template failed, FALL BACK to the built-in default template so employee letter generation NEVER fails!
        if (templateInfo.isCustom) {
            console.warn('[RevisionLetter] Automatically falling back to built-in defaultRevisionLetter.docx...');
            try {
                const fallbackPath = path.join(__dirname, '../templates/defaultRevisionLetter.docx');
                if (fs.existsSync(fallbackPath)) {
                    const fallbackBuffer = fs.readFileSync(fallbackPath);
                    const buffer = renderDocxZip(fallbackBuffer, renderData);
                    buffer.usedTemplateName = 'Built-in Professional Revision Offer Letter';
                    buffer.fallbackUsed = true;
                    buffer.warning = `Custom template "${templateInfo.name}" had syntax errors (${detailedMsg}). Generated using standard professional template.`;
                    buffer.breakupDetails = breakupDetails;
                    return buffer;
                }
            } catch (fallbackErr) {
                console.error('[RevisionLetter] Built-in fallback also failed:', fallbackErr);
            }
        }

        const enhancedError = new Error(detailedMsg);
        enhancedError.name = 'TemplateRenderError';
        enhancedError.details = errorDetails;
        throw enhancedError;
    }
};

/**
 * Generate and dispatch (email + dossier save) for a single employee
 */
const generateAndDispatchRevisionLetter = async ({
    userId,
    revisionId = null,
    companyId,
    hrUserId,
    options = {}
}) => {
    const user = await User.findOne({ _id: userId, companyId });
    if (!user) throw new Error('Employee not found');

    const fullName = `${user.firstName || ''} ${user.lastName || ''}`.trim() || 'Employee';

    let profile = await EmployeeProfile.findOne({ user: user._id, companyId });
    if (!profile) {
        profile = new EmployeeProfile({
            user: user._id,
            companyId,
            personal: {
                firstName: user.firstName,
                lastName: user.lastName || ''
            },
            employment: {
                designation: user.designation || 'Employee',
                department: user.department || 'General',
                joiningDate: user.joiningDate || new Date()
            },
            compensation: user.compensation || {}
        });
    }

    const company = await Company.findById(companyId);
    const config = await PayrollConfig.findOne({ companyId });

    let revision = null;
    if (revisionId) {
        revision = await EmployeeRevision.findOne({ _id: revisionId, companyId, employeeId: user._id });
    }
    if (!revision) {
        revision = await EmployeeRevision.findOne({ companyId, employeeId: user._id, status: { $in: ['active', 'scheduled'] } })
            .sort({ effectiveDate: -1, createdAt: -1 });
    }

    const docxBuffer = await generateRevisionLetterBuffer({
        user,
        profile,
        revision,
        company,
        config,
        templateId: options.templateId || null
    });

    const safeName = `${user.firstName}_${user.lastName || ''}`.replace(/[^a-zA-Z0-9]/g, '_').replace(/_+/g, '_').trim();
    const effectiveDateLabel = formatDateLabel(revision?.effectiveDate);
    const filename = `Revised_Offer_Letter_${safeName}_${effectiveDateLabel}.docx`;

    let fileUrl = '';
    const shouldSaveToDossier = options.saveToDossier !== false;
    const shouldSendEmail = options.sendEmail !== false;

    // 1. Upload to Cloudinary & Save to Dossier
    if (process.env.CLOUDINARY_CLOUD_NAME) {
        try {
            const uploaded = await uploadBufferToCloudinary(
                docxBuffer,
                `talentcio/${companyId}/dossier/${user._id}`,
                `${filename.replace(/\.docx$/, '')}_${Date.now()}.docx`
            );
            fileUrl = uploaded.secure_url;

            if (shouldSaveToDossier) {
                profile.documents = profile.documents || [];
                profile.documents.push({
                    category: 'Offer Letter',
                    title: `Revised Offer Letter - ${formatDate(revision?.effectiveDate || new Date())}`,
                    fileName: filename,
                    url: fileUrl,
                    uploadDate: new Date(),
                    verificationStatus: 'Verified',
                    uploadedBy: hrUserId || user._id
                });
                await profile.save();
            }
        } catch (uploadErr) {
            console.error('Failed to upload revision letter to Cloudinary:', uploadErr);
        }
    }

    // 2. Dispatch Email
    let emailSent = false;
    let emailError = null;

    if (shouldSendEmail) {
        const recipientEmail = String(profile?.contact?.workEmail || profile?.contact?.personalEmail || user.email || '').trim();
        if (recipientEmail) {
            const effectiveFormatted = formatDate(revision?.effectiveDate || new Date());
            const annualCtcFormatted = formatCurrency(revision?.metadata?.salaryBreakup?.annualCTC || profile.compensation?.ctc * 12 || 0);

            const emailSubject = options.emailSubject || `Revised Offer Letter & Compensation Restructure - ${company?.name || 'Company'}`;
            const emailHtml = options.emailBody || `
                <div style="font-family: Arial, sans-serif; font-size: 14px; color: #1e293b; line-height: 1.6;">
                    <p>Dear <strong>${user.firstName}</strong>,</p>
                    <p>We are pleased to inform you that your compensation structure with <strong>${company?.name || 'our company'}</strong> has been revised effective from <strong>${effectiveFormatted}</strong>.</p>
                    <div style="margin: 20px 0; padding: 16px; background-color: #f8fafc; border-left: 4px solid #2563eb; border-radius: 4px;">
                        <p style="margin: 0 0 8px;"><strong>Revised Annual CTC:</strong> ${annualCtcFormatted}</p>
                        <p style="margin: 0;"><strong>Reason:</strong> ${revision?.reason || 'Company Compensation Restructuring'}</p>
                    </div>
                    <p>Please find attached your official <strong>Revised Offer Letter</strong> containing the complete salary breakdown and benefits annexure.</p>
                    <p>If you have any questions regarding your updated compensation, please reach out to the HR department.</p>
                    <p style="margin-top: 24px;">Warm regards,<br/><strong>Human Resources</strong><br/>${company?.name || ''}</p>
                </div>
            `;

            try {
                await sendEmailForCompany({
                    companyId,
                    emailAccountId: options.emailAccountId,
                    to: recipientEmail,
                    subject: emailSubject,
                    html: emailHtml,
                    attachments: [
                        {
                            filename,
                            content: docxBuffer,
                            contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
                        }
                    ]
                });

                emailSent = true;

                await HREmailLog.create({
                    companyId,
                    sentBy: hrUserId || user._id,
                    recipientUserId: user._id,
                    recipientEmail,
                    subject: emailSubject,
                    body: emailHtml,
                    type: 'general',
                    templateName: 'Revised Offer Letter',
                    attachments: [{ filename, url: fileUrl }],
                    dossierCategory: 'Offer Letter',
                    dossierSaved: shouldSaveToDossier && Boolean(fileUrl),
                    sentAt: new Date(),
                    notes: `Revised offer letter generated for revision effective ${effectiveFormatted}`
                });
            } catch (err) {
                console.error(`Failed to send revision email to ${recipientEmail}:`, err);
                emailError = err.message;
            }
        } else {
            emailError = 'No valid email address found for employee';
        }
    }

    return {
        success: true,
        employeeId: user._id,
        name: fullName,
        filename,
        fileUrl,
        emailSent,
        emailError,
        buffer: docxBuffer,
        fallbackUsed: docxBuffer?.fallbackUsed || false,
        warning: docxBuffer?.warning || null
    };
};

/**
 * Bulk generate and dispatch letters for multiple employees
 */
const bulkGenerateAndDispatchRevisionLetters = async ({
    employeeIds = [],
    companyId,
    hrUserId,
    options = {}
}) => {
    const results = {
        total: employeeIds.length,
        successCount: 0,
        failCount: 0,
        details: []
    };

    for (const empId of employeeIds) {
        try {
            const res = await generateAndDispatchRevisionLetter({
                userId: empId,
                companyId,
                hrUserId,
                options
            });
            results.successCount++;
            results.details.push({
                employeeId: empId,
                name: res.name,
                success: true,
                emailSent: res.emailSent,
                fileUrl: res.fileUrl
            });
        } catch (err) {
            console.error(`Bulk revision letter failed for employee ${empId}:`, err);
            results.failCount++;
            results.details.push({
                employeeId: empId,
                success: false,
                message: err.message
            });
        }
    }

    return results;
};

module.exports = {
    generateRevisionLetterBuffer,
    generateAndDispatchRevisionLetter,
    bulkGenerateAndDispatchRevisionLetters,
    getTemplateBuffer
};

