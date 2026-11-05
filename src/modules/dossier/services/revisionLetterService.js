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

    if (config) {
        try {
            const calculated = processCalculatedSalary(salaryData, config, annualCTC, monthlyCTC);
            if (calculated && calculated.master) {
                const master = calculated.master;
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

                if (master.pfEmployer > 0) {
                    contributionsList.push({
                        name: 'PF Employer Contribution',
                        monthly: formatCurrency(master.pfEmployer),
                        annual: formatCurrency(master.pfEmployer * 12)
                    });
                }
                if (master.esiEmployer > 0) {
                    contributionsList.push({
                        name: 'ESI Employer Contribution',
                        monthly: formatCurrency(master.esiEmployer),
                        annual: formatCurrency(master.esiEmployer * 12)
                    });
                }
                if (master.gratuity > 0) {
                    contributionsList.push({
                        name: 'Gratuity Provision',
                        monthly: formatCurrency(master.gratuity),
                        annual: formatCurrency(master.gratuity * 12)
                    });
                }
                if (master.lwfEmployer > 0) {
                    contributionsList.push({
                        name: 'LWF Employer Share',
                        monthly: formatCurrency(master.lwfEmployer),
                        annual: formatCurrency(master.lwfEmployer * 12)
                    });
                }

                const payroll = buildPayrollSnapshot(salaryData, config, {
                    workingDays: config.defaultWorkingDays || 26,
                    paidDays: config.defaultWorkingDays || 26
                }, {}, new Date().getMonth() + 1, new Date().getFullYear());

                if (payroll && payroll.deductions) {
                    if (payroll.deductions.pfEmployee > 0) {
                        deductionsList.push({
                            name: 'PF Employee Contribution',
                            monthly: formatCurrency(payroll.deductions.pfEmployee),
                            annual: formatCurrency(payroll.deductions.pfEmployee * 12)
                        });
                    }
                    if (payroll.deductions.esiEmployee > 0) {
                        deductionsList.push({
                            name: 'ESI Employee Contribution',
                            monthly: formatCurrency(payroll.deductions.esiEmployee),
                            annual: formatCurrency(payroll.deductions.esiEmployee * 12)
                        });
                    }
                    if (payroll.deductions.professionalTax > 0) {
                        deductionsList.push({
                            name: 'Professional Tax (PT)',
                            monthly: formatCurrency(payroll.deductions.professionalTax),
                            annual: formatCurrency(payroll.deductions.professionalTax * 12)
                        });
                    }
                    if (payroll.deductions.lwfEmployee > 0) {
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

    const salaryTableXml = buildSalaryTableXml(earningsList, contributionsList, deductionsList, totals);

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
    let targetUrl = null;

    if (requestedTemplateId && requestedTemplateId !== 'default') {
        const found = (company?.settings?.onboarding?.dynamicTemplates || []).find(
            t => String(t._id) === String(requestedTemplateId)
        );
        if (found && found.url) targetUrl = found.url;
    }

    if (!targetUrl) {
        const dynamicRevision = (company?.settings?.onboarding?.dynamicTemplates || []).find(
            t => /offer|revision|restructure/i.test(t.name)
        );
        if (dynamicRevision && dynamicRevision.url) {
            targetUrl = dynamicRevision.url;
        } else if (company?.settings?.onboarding?.offerLetterTemplateUrl) {
            targetUrl = company.settings.onboarding.offerLetterTemplateUrl;
        }
    }

    if (targetUrl && targetUrl.startsWith('http')) {
        try {
            const resp = await axios.get(targetUrl, { responseType: 'arraybuffer', timeout: 10000 });
            return Buffer.from(resp.data);
        } catch (e) {
            console.warn(`Failed to fetch remote template from ${targetUrl}, falling back to built-in template:`, e.message);
        }
    }

    // Built-in fallback
    const fallbackPath = path.join(__dirname, '../templates/defaultRevisionLetter.docx');
    if (fs.existsSync(fallbackPath)) {
        return fs.readFileSync(fallbackPath);
    }

    throw new Error('No template document found and fallback template is unavailable.');
};

/**
 * Generates the populated DOCX buffer for an employee revision
 */
const generateRevisionLetterBuffer = async ({ user, profile, revision, company, config, templateId = null }) => {
    const rawTemplateBuffer = await getTemplateBuffer(company, templateId);
    const zip = new PizZip(rawTemplateBuffer);

    let docXml = zip.file('word/document.xml').asText();
    docXml = preprocessDocxXml(docXml);
    zip.file('word/document.xml', docXml);

    const doc = new Docxtemplater(zip, {
        paragraphLoop: true,
        linebreaks: true,
        nullGetter: () => '—'
    });

    const salaryData = revision?.metadata?.salaryBreakup || profile?.compensation?.salaryBreakup || profile?.compensation || {};
    const breakupDetails = computeSalaryBreakupDetails(salaryData, config);

    const fullName = `${user.firstName || ''} ${user.lastName || ''}`.trim() || 'Employee';
    const effectiveDateStr = formatDate(revision?.effectiveDate || new Date());
    const hrUser = revision?.createdBy || {};
    const hrName = hrUser.firstName ? `${hrUser.firstName} ${hrUser.lastName || ''}`.trim() : 'Authorized Signatory';

    doc.render({
        company_name: company?.name || 'Company',
        offer_date: effectiveDateStr,
        effective_date: effectiveDateStr,
        employee_full_name: fullName,
        employee_first_name: user.firstName || 'Employee',
        employee_last_name: user.lastName || '',
        employee_id: user.employeeCode || '—',
        employee_code: user.employeeCode || '—',
        designation: profile?.employment?.designation || user.designation || '—',
        department: profile?.employment?.department || user.department || '—',
        work_location: profile?.employment?.workLocation || user.workLocation || '—',
        joining_date: formatDate(profile?.employment?.joiningDate || user.joiningDate),
        annual_ctc: formatCurrency(breakupDetails.annualCTC),
        annual_salary: formatCurrency(breakupDetails.annualCTC),
        monthly_gross: formatCurrency(breakupDetails.monthlyGross),
        monthly_ctc: formatCurrency(breakupDetails.monthlyCTC),
        basic_salary: formatCurrency(breakupDetails.basicVal),
        hra: formatCurrency(breakupDetails.hraVal),
        special_allowance: formatCurrency(breakupDetails.specialVal),
        revision_reason: revision?.reason || 'Compensation Restructuring',
        reason_for_revision: revision?.reason || 'Compensation Restructuring',
        net_take_home: formatCurrency(breakupDetails.netMonthly),
        monthly_net: formatCurrency(breakupDetails.netMonthly),
        annual_net: formatCurrency(breakupDetails.totals?.annualNet || breakupDetails.netMonthly * 12),
        annual_gross: formatCurrency(breakupDetails.totals?.annualGross || breakupDetails.monthlyGross * 12),
        total_employer_contributions: formatCurrency(breakupDetails.totals?.monthlyContributions || 0),
        total_deductions: formatCurrency(breakupDetails.totals?.monthlyDeductions || 0),
        current_date: formatDate(new Date()),
        hr_name: hrName,
        authorized_signatory: hrName,
        signatory: hrName,
        salary_table: breakupDetails.salaryTableXml,
        salaryTable: breakupDetails.salaryTableXml,
        earnings_breakdown: breakupDetails.earningsList || [],
        contributions_breakdown: breakupDetails.contributionsList || [],
        deductions_breakdown: breakupDetails.deductionsList || [],
        all_components: [
            ...(breakupDetails.earningsList || []).map(e => ({ category: 'Earnings', ...e })),
            ...(breakupDetails.contributionsList || []).map(c => ({ category: 'Employer Contributions', ...c })),
            ...(breakupDetails.deductionsList || []).map(d => ({ category: 'Employee Deductions', ...d }))
        ]
    });

    return doc.getZip().generate({ type: 'nodebuffer', compression: 'DEFLATE' });
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

    const profile = await EmployeeProfile.findOne({ user: user._id, companyId });
    if (!profile) throw new Error('Employee dossier profile not found');

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
    const effectiveDateLabel = revision?.effectiveDate ? format(new Date(revision.effectiveDate), 'yyyyMMdd') : format(new Date(), 'yyyyMMdd');
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
        buffer: docxBuffer
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

