const OnboardingEmployee = require('../model/onboardingEmployee.model');
const Company = require('../../company/company.model');
const PizZip = require('pizzip');
const Docxtemplater = require('docxtemplater');
const path = require('path');
const mammoth = require('mammoth');
const { getTemplateContent, updateDocxWithText } = require('./onboardingSettingsController');
const { formatDate, formatCurrency, buildSalaryTableXml, preprocessDocxXml } = require('../utils/onboardingHelpers');

const getSalaryBreakups = async (employee) => {
    const breakups = {};
    if (!employee || !employee.salary) return breakups;

    const rawAnnual = employee.salary.annualCTC;
    const rawMonthly = employee.salary.monthlyCTC || employee.salary.flatSalary;
    let annualCTC = parseFloat(String(rawAnnual || 0).replace(/[^0-9.]/g, '')) || 0;
    let monthlyCTC = parseFloat(String(rawMonthly || 0).replace(/[^0-9.]/g, '')) || 0;

    if (!annualCTC && monthlyCTC > 0) annualCTC = monthlyCTC * 12;
    if (!monthlyCTC && annualCTC > 0) monthlyCTC = annualCTC / 12;

    if (annualCTC <= 0 && monthlyCTC <= 0) {
        breakups['salary_table'] = '';
        breakups['salaryTable'] = '';
        return breakups;
    }

    try {
        const PayrollConfig = require('../../payroll/payrollConfig.model');
        const { processCalculatedSalary, buildPayrollSnapshot } = require('../../payroll/payrollMath');
        const config = await PayrollConfig.findOne({ companyId: employee.companyId });
        if (config) {
            const { master } = processCalculatedSalary(employee.salary || {}, config, annualCTC, monthlyCTC);
            if (master) {
                const earningsList = [];
                const comps = config.salaryComponents && config.salaryComponents.length > 0 ? config.salaryComponents : [];

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
                breakups['earnings_breakdown'] = earningsList;

                const contributionsList = [];
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
                if (master.insurance > 0) {
                    contributionsList.push({
                        name: 'Corporate Health Insurance',
                        monthly: formatCurrency(master.insurance),
                        annual: formatCurrency(master.insurance * 12)
                    });
                }
                if (master.employerNPS > 0) {
                    contributionsList.push({
                        name: 'Employer NPS Contribution',
                        monthly: formatCurrency(master.employerNPS),
                        annual: formatCurrency(master.employerNPS * 12)
                    });
                }
                breakups['contributions_breakdown'] = contributionsList;

                const source = employee.salary || {};
                const payroll = buildPayrollSnapshot(source, config, {
                    workingDays: config.defaultWorkingDays,
                    paidDays: config.defaultWorkingDays,
                }, {}, new Date().getMonth() + 1, new Date().getFullYear());

                const deductionsList = [];
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
                    if (payroll.deductions.lwfEmployee > 0) {
                        deductionsList.push({
                            name: 'LWF Employee Share',
                            monthly: formatCurrency(payroll.deductions.lwfEmployee),
                            annual: formatCurrency(payroll.deductions.lwfEmployee * 12)
                        });
                    }
                    if (payroll.deductions.professionalTax > 0) {
                        deductionsList.push({
                            name: 'Professional Tax (PT)',
                            monthly: formatCurrency(payroll.deductions.professionalTax),
                            annual: formatCurrency(payroll.deductions.professionalTax * 12)
                        });
                    }
                    if (payroll.deductions.tds > 0) {
                        deductionsList.push({
                            name: 'Income Tax (TDS)',
                            monthly: formatCurrency(payroll.deductions.tds),
                            annual: formatCurrency(payroll.deductions.tds * 12)
                        });
                    }
                }
                breakups['deductions_breakdown'] = deductionsList;

                const allComponentsList = [];
                earningsList.forEach(item => allComponentsList.push({ ...item, category: 'Earnings' }));
                contributionsList.forEach(item => allComponentsList.push({ ...item, category: 'Employer Contributions' }));
                deductionsList.forEach(item => allComponentsList.push({ ...item, category: 'Employee Deductions' }));
                breakups['all_components'] = allComponentsList;

                // Totals for table
                const totalMonthlyGross = master.totalEarnings || monthlyCTC;
                const totalAnnualGross = totalMonthlyGross * 12;

                const totalMonthlyContrib = (master.pfEmployer || 0) + (master.esiEmployer || 0) + (master.gratuity || 0) + (master.lwfEmployer || 0) + (master.insurance || 0) + (master.employerNPS || 0);
                const totalAnnualContrib = totalMonthlyContrib * 12;

                const totalMonthlyDeductions = (payroll?.deductions?.pfEmployee || 0) + (payroll?.deductions?.esiEmployee || 0) + (payroll?.deductions?.lwfEmployee || 0) + (payroll?.deductions?.professionalTax || 0) + (payroll?.deductions?.tds || 0);
                const totalAnnualDeductions = totalMonthlyDeductions * 12;

                const netMonthly = master.netTakeHome || Math.max(0, totalMonthlyGross - totalMonthlyDeductions);
                const netAnnual = netMonthly * 12;

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
                breakups['salary_table'] = salaryTableXml;
                breakups['salaryTable'] = salaryTableXml;
                breakups['salarytable'] = salaryTableXml;

                if (master.earningsMap) {
                    Object.entries(master.earningsMap).forEach(([id, val]) => {
                        breakups[id] = formatCurrency(val);
                        breakups[`${id}_annual`] = formatCurrency(val * 12);

                        const cleanId = id.replace(/([A-Z])/g, '_$1').toLowerCase();
                        breakups[cleanId] = formatCurrency(val);
                        breakups[`${cleanId}_annual`] = formatCurrency(val * 12);
                        if (!cleanId.endsWith('_allowance')) {
                            breakups[`${cleanId}_allowance`] = formatCurrency(val);
                            breakups[`${cleanId}_allowance_annual`] = formatCurrency(val * 12);
                        }
                    });
                }

                breakups['basic_salary'] = formatCurrency(master.basicMaster);
                breakups['basic_salary_annual'] = formatCurrency(master.basicMaster * 12);
                breakups['hra'] = formatCurrency(master.hraMaster);
                breakups['hra_annual'] = formatCurrency(master.hraMaster * 12);
                breakups['special_allowance'] = formatCurrency(master.specialAllowance);
                breakups['special_allowance_annual'] = formatCurrency(master.specialAllowance * 12);
            }
        }
    } catch (err) {
        console.error('Error computing dynamic onboarding salary breakups:', err);
    }

    // Fallback if no table was built yet (e.g. no PayrollConfig)
    if (!breakups['salary_table'] && (annualCTC > 0 || monthlyCTC > 0)) {
        const basic = Math.round(monthlyCTC * 0.5);
        const hra = Math.round(basic * 0.5);
        const special = Math.max(0, monthlyCTC - basic - hra);
        const fallbackEarnings = [
            { name: 'Basic Salary', monthly: formatCurrency(basic), annual: formatCurrency(basic * 12) },
            { name: 'House Rent Allowance (HRA)', monthly: formatCurrency(hra), annual: formatCurrency(hra * 12) },
            { name: 'Special Allowance', monthly: formatCurrency(special), annual: formatCurrency(special * 12) }
        ];
        const fallbackTotals = {
            monthlyGross: formatCurrency(monthlyCTC),
            annualGross: formatCurrency(annualCTC),
            monthlyCTC: formatCurrency(monthlyCTC),
            annualCTC: formatCurrency(annualCTC),
            monthlyNet: formatCurrency(monthlyCTC),
            annualNet: formatCurrency(annualCTC)
        };
        const fallbackTable = buildSalaryTableXml(fallbackEarnings, [], [], fallbackTotals);
        breakups['salary_table'] = fallbackTable;
        breakups['salaryTable'] = fallbackTable;
        breakups['salarytable'] = fallbackTable;
    }

    return breakups;
};

const getPopulatedDocumentBuffer = async (employee, company, templateUrl, defaultPath = null) => {
    const content = Buffer.isBuffer(templateUrl) ? templateUrl : await getTemplateContent(templateUrl, defaultPath);
    const zip = new PizZip(content);

    const fullName = employee.personalDetails?.fullName || `${employee.firstName} ${employee.lastName || ''}`.trim() || employee.firstName || 'Candidate';
    const _eSignNameRaw = employee.offerDeclaration?.eSignName?.trim() || fullName;
    const _eSignValueRaw = employee.offerDeclaration?.eSignValue;
    const _eSignTypeRaw = employee.offerDeclaration?.eSignType || (_eSignValueRaw?.startsWith('data:image') ? 'drawn' : 'typed');
    const isSigned = Boolean(employee.offerDeclaration?.isComplete || employee.offerStatus === 'Accepted' || employee.status === 'Submitted');

    const SIG_TOKEN = '__CANDIDATE_SIG_TOKEN_PLACEHOLDER__';

    try {
        let docXml = zip.file('word/document.xml').asText();
        docXml = preprocessDocxXml(docXml);

        // Normalize all signature tags to {employee_signature} so Docxtemplater treats them
        // as standard text placeholders rather than trying (and failing) rawxml whole-paragraph replacement
        docXml = docXml.replace(/\{@employee_signature\}/g, '{employee_signature}');
        docXml = docXml.replace(/\{@candidate_signature\}/g, '{employee_signature}');
        docXml = docXml.replace(/\{@signature\}/g, '{employee_signature}');
        docXml = docXml.replace(/\{candidate_signature\}/g, '{employee_signature}');
        docXml = docXml.replace(/\{signature\}/g, '{employee_signature}');

        const _eSignStyleRaw = employee.offerDeclaration?.eSignStyle || '';
        let fontName = 'Calibri';
        if (_eSignStyleRaw.includes('Brush Script MT')) {
            fontName = 'Brush Script MT';
        } else if (_eSignStyleRaw.includes('Lucida Handwriting')) {
            fontName = 'Lucida Handwriting';
        } else if (_eSignStyleRaw.includes('Segoe Print')) {
            fontName = 'Segoe Print';
        } else if (_eSignStyleRaw.includes('Courier New')) {
            fontName = 'Courier New';
        }

        try {
            let fontTableXml = zip.file('word/fontTable.xml').asText();
            if (!fontTableXml.includes(`w:name="${fontName}"`)) {
                const fontTag = `<w:font w:name="${fontName}"/>`;
                fontTableXml = fontTableXml.replace('</fonts>', `${fontTag}</fonts>`);
                zip.file('word/fontTable.xml', fontTableXml);
            }
        } catch (ftErr) {
            console.error('Error updating fontTable.xml:', ftErr.message);
        }

        // If candidate drew their signature, inject the PNG into the DOCX zip package
        if (isSigned && _eSignTypeRaw === 'drawn' && _eSignValueRaw && _eSignValueRaw.includes('base64,')) {
            try {
                const _base64Data = _eSignValueRaw.split(';base64,').pop();
                zip.file('word/media/candidate_signature.png', Buffer.from(_base64Data, 'base64'));

                try {
                    let contentTypesXml = zip.file('[Content_Types].xml').asText();
                    if (!contentTypesXml.includes('Extension="png"')) {
                        const pngType = `<Default Extension="png" ContentType="image/png"/>`;
                        contentTypesXml = contentTypesXml.replace('</Types>', `${pngType}</Types>`);
                        zip.file('[Content_Types].xml', contentTypesXml);
                    }
                } catch (ctErr) {
                    console.error('Error updating Content_Types.xml:', ctErr.message);
                }

                let relsXml = zip.file('word/_rels/document.xml.rels').asText();
                if (!relsXml.includes('Target="media/candidate_signature.png"')) {
                    const signatureRel = `<Relationship Id="rIdSignature" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/candidate_signature.png"/>`;
                    relsXml = relsXml.replace('</Relationships>', `${signatureRel}</Relationships>`);
                    zip.file('word/_rels/document.xml.rels', relsXml);
                }
            } catch (imgErr) {
                console.error('Error injecting signature image into DOCX package:', imgErr.message);
            }
        }

        zip.file('word/document.xml', docXml);
    } catch (e) {
        console.error('Error pre-processing document.xml:', e.message);
    }

    const doc = new Docxtemplater(zip, {
        paragraphLoop: true,
        linebreaks: true,
        nullGetter: () => '—'
    });

    const hrUser = employee.createdBy || {};
    const permAddr = employee.personalDetails?.permanentAddress || employee.personalDetails?.currentAddress || {};
    const salaryBreakups = await getSalaryBreakups(employee);

    const eSignDateEffective = employee.offerDeclaration?.eSignDate || (isSigned ? (employee.updatedAt || employee.submittedAt || new Date()) : null);

    try {
        doc.render({
            offer_date: formatDate(employee.offerDate || new Date()),
            employee_full_name: fullName,
            employee_first_name: employee.firstName,
            employee_last_name: employee.lastName,
            employee_id: employee.tempEmployeeId,
            designation: employee.designation || '—',
            department: employee.department || '—',
            joining_date: formatDate(employee.joiningDate),
            work_location: employee.workLocation || '—',
            probation_period: employee.probationPeriod || '6 months',
            probationPeriod: employee.probationPeriod || '6 months',
            annual_ctc: formatCurrency(employee.salary?.annualCTC),
            annual_salary: formatCurrency(employee.salary?.annualCTC),
            basic_salary: formatCurrency(employee.salary?.basic),
            hra: formatCurrency(employee.salary?.hra),
            special_allowance: formatCurrency(employee.salary?.specialAllowance),
            monthly_gross: formatCurrency(employee.salary?.monthlyGross),
            monthly_ctc: formatCurrency(employee.salary?.monthlyCTC),
            employee_address: [permAddr.line1, permAddr.line2].filter(Boolean).join(', ') || employee.address || '—',
            employee_city: permAddr.city || '—',
            hr_name: hrUser.firstName ? `${hrUser.firstName} ${hrUser.lastName || ''}`.trim() : 'Authorized Signatory',
            hr_designation: hrUser.designation || 'HR Manager',
            signatory: hrUser.firstName ? `${hrUser.firstName} ${hrUser.lastName || ''}`.trim() : 'Authorized Signatory',
            signatory_name: hrUser.firstName ? `${hrUser.firstName} ${hrUser.lastName || ''}`.trim() : 'Authorized Signatory',
            signatory_designation: hrUser.designation || 'HR Manager',
            authorized_signatory: hrUser.firstName ? `${hrUser.firstName} ${hrUser.lastName || ''}`.trim() : 'Authorized Signatory',
            company_name: company?.name || 'ILUMAA Ventures Pvt. Ltd.',
            declaration_date: formatDate(new Date()),
            employee_signature_name: _eSignNameRaw || fullName,
            candidate_signature_name: _eSignNameRaw || fullName,
            employee_signature: SIG_TOKEN,
            candidate_signature: SIG_TOKEN,
            signature: SIG_TOKEN,
            employee_signature_inline: SIG_TOKEN,
            employee_signature_date: eSignDateEffective ? formatDate(eSignDateEffective) : '—',
            signature_date: eSignDateEffective ? formatDate(eSignDateEffective) : '—',
            signed_date: eSignDateEffective ? formatDate(eSignDateEffective) : '—',
            employee_signature_ip: employee.offerDeclaration?.eSignIp || '—',
            date: eSignDateEffective ? formatDate(eSignDateEffective) : formatDate(new Date()),
            current_date: new Date().toLocaleDateString('en-US', { month: 'long', day: '2-digit', year: 'numeric', timeZone: 'Asia/Kolkata' }),
            ...salaryBreakups
        });
    } catch (err) {
        console.error('Docxtemplater rendering error details:', err);
        throw err;
    }

    // Post-rendering: cleanly inject the inline drawing / formatted run at the <w:r> level.
    // In OpenXML, <w:drawing> must reside directly inside a <w:r> element, never inside a <w:t> text node.
    try {
        let renderedDocXml = doc.getZip().file('word/document.xml').asText();

        if (renderedDocXml.includes(SIG_TOKEN)) {
            const _eSignStyleRaw = employee.offerDeclaration?.eSignStyle || '';
            let fontName = 'Calibri';
            if (_eSignStyleRaw.includes('Brush Script MT')) {
                fontName = 'Brush Script MT';
            } else if (_eSignStyleRaw.includes('Lucida Handwriting')) {
                fontName = 'Lucida Handwriting';
            } else if (_eSignStyleRaw.includes('Segoe Print')) {
                fontName = 'Segoe Print';
            } else if (_eSignStyleRaw.includes('Courier New')) {
                fontName = 'Courier New';
            }

            let sigDrawingCount = 900;
            const getInlineRunXml = () => {
                if (isSigned && (_eSignValueRaw || _eSignNameRaw)) {
                    if (_eSignTypeRaw === 'drawn' && _eSignValueRaw && _eSignValueRaw.includes('base64,')) {
                        const id = ++sigDrawingCount;
                        const _drawingXml = `
                            <w:drawing>
                                <wp:inline xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" distT="0" distB="0" distL="0" distR="0">
                                    <wp:extent cx="1371600" cy="457200"/>
                                    <wp:docPr id="${id}" name="Candidate Signature ${id}"/>
                                    <wp:cNvGraphicFramePr>
                                        <a:graphicFrameLocks noChangeAspect="1"/>
                                    </wp:cNvGraphicFramePr>
                                    <a:graphic>
                                        <a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">
                                            <pic:pic>
                                                <pic:nvPicPr>
                                                    <pic:cNvPr id="${id}" name="candidate_signature.png"/>
                                                    <pic:cNvPicPr/>
                                                </pic:nvPicPr>
                                                <pic:blipFill>
                                                    <a:blip r:embed="rIdSignature"/>
                                                    <a:stretch>
                                                        <a:fillRect/>
                                                    </a:stretch>
                                                </pic:blipFill>
                                                <pic:spPr>
                                                    <a:xfrm>
                                                        <a:off x="0" y="0"/>
                                                        <a:ext cx="1371600" cy="457200"/>
                                                    </a:xfrm>
                                                    <a:prstGeom prst="rect">
                                                        <a:avLst/>
                                                    </a:prstGeom>
                                                </pic:spPr>
                                            </pic:pic>
                                        </a:graphicData>
                                    </a:graphic>
                                </wp:inline>
                            </w:drawing>
                        `.trim().replace(/\s+/g, ' ');
                        return `<w:r>${_drawingXml}</w:r>`;
                    } else {
                        return `<w:r><w:rPr><w:rFonts w:ascii="${fontName}" w:hAnsi="${fontName}" w:cs="${fontName}"/></w:rPr><w:t xml:space="preserve"> ${_eSignNameRaw}</w:t></w:r>`;
                    }
                } else {
                    return `<w:r><w:rPr><w:color w:val="94A3B8"/></w:rPr><w:t xml:space="preserve"> (Pending Signature)</w:t></w:r>`;
                }
            };

            const rRegex = /<w:r(?:\s[^>]*)?>([\s\S]*?)<\/w:r>/g;
            renderedDocXml = renderedDocXml.replace(rRegex, (fullRun) => {
                if (!fullRun.includes(SIG_TOKEN)) return fullRun;

                const rPrMatch = fullRun.match(/<w:rPr>[\s\S]*?<\/w:rPr>/);
                const rPr = rPrMatch ? rPrMatch[0] : '';

                const tMatch = fullRun.match(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/);
                if (!tMatch) return fullRun;

                const fullText = tMatch[1];
                const parts = fullText.split(SIG_TOKEN);

                let newRuns = '';
                for (let i = 0; i < parts.length; i++) {
                    if (parts[i]) {
                        newRuns += `<w:r>${rPr}<w:t xml:space="preserve">${parts[i]}</w:t></w:r>`;
                    }
                    if (i < parts.length - 1) {
                        newRuns += getInlineRunXml();
                    }
                }
                return newRuns;
            });

            doc.getZip().file('word/document.xml', renderedDocXml);
        }
    } catch (postErr) {
        console.error('Error in post-render signature injection:', postErr.message);
    }

    return doc.getZip().generate({ type: 'nodebuffer' });
};

exports.getPopulatedDocumentBuffer = getPopulatedDocumentBuffer;

exports.generateOfferLetter = async (req, res) => {
    try {
        const [employee, company] = await Promise.all([
            OnboardingEmployee.findOne({ _id: req.params.id, companyId: req.companyId })
                .populate('createdBy', 'firstName lastName designation')
                .lean(),
            Company.findById(req.companyId).select('settings.onboarding').lean()
        ]);

        if (!employee) return res.status(404).json({ message: 'Employee not found' });

        const customTpl = employee.customTemplates?.find(t => 
            t.templateId === 'offerLetter' || 
            /offer/i.test(t.name)
        );
        const dynamicOffer = company?.settings?.onboarding?.dynamicTemplates?.find(t => 
            /offer/i.test(t.name)
        );
        const offerUrl = customTpl?.url || employee.offerLetterUrl || company?.settings?.onboarding?.offerLetterTemplateUrl || dynamicOffer?.url;
        if (!offerUrl) {
            return res.status(404).json({ message: 'Offer letter template not found. Please upload a template in Template Settings.' });
        }

        const buffer = await getPopulatedDocumentBuffer(
            employee,
            company,
            offerUrl
        );

        const hrUser = employee.createdBy || {};
        const fullName = employee.personalDetails?.fullName || `${employee.firstName} ${employee.lastName}`.trim();

        await OnboardingEmployee.findByIdAndUpdate(employee._id, {
            letterGenerated: true,
            letterGeneratedAt: new Date(),
            $push: {
                auditLog: {
                    $each: [{ action: 'OFFER_LETTER_GENERATED', details: `Offer letter generated by ${hrUser.firstName || 'Admin'}` }],
                    $slice: -50
                }
            }
        });

        const safeName = fullName.replace(/[^a-zA-Z0-9\s]/g, '').replace(/\s+/g, '_');
        res.setHeader('Content-Disposition', `attachment; filename=OfferLetter_${safeName}.docx`);
        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
        res.send(buffer);

    } catch (error) {
        console.error('Error generating offer letter:', error);
        res.status(500).json({ message: 'Failed to generate offer letter', error: error.message });
    }
};

exports.generateDeclaration = async (req, res) => {
    try {
        const [employee, company] = await Promise.all([
            OnboardingEmployee.findOne({ _id: req.params.id, companyId: req.companyId })
                .populate('createdBy', 'firstName lastName designation')
                .lean(),
            Company.findById(req.companyId).select('settings.onboarding').lean()
        ]);

        if (!employee) return res.status(404).json({ message: 'Employee not found' });

        const customTpl = employee.customTemplates?.find(t => 
            t.templateId === 'declaration' || 
            /declaration/i.test(t.name)
        );
        const dynamicDecl = company?.settings?.onboarding?.dynamicTemplates?.find(t => 
            /declaration/i.test(t.name)
        );
        const declUrl = customTpl?.url || company?.settings?.onboarding?.declarationTemplateUrl || dynamicDecl?.url;
        if (!declUrl) {
            return res.status(404).json({ message: 'Declaration template not found. Please upload a template in Template Settings.' });
        }

        const buffer = await getPopulatedDocumentBuffer(
            employee,
            company,
            declUrl
        );

        const hrUser = employee.createdBy || {};
        const fullName = employee.personalDetails?.fullName || `${employee.firstName} ${employee.lastName}`.trim();

        await OnboardingEmployee.findByIdAndUpdate(employee._id, {
            $push: {
                auditLog: {
                    $each: [{ action: 'DECLARATION_GENERATED', details: `Declaration generated by ${hrUser.firstName || 'Admin'}` }],
                    $slice: -50
                }
            }
        });

        const safeName = fullName.replace(/[^a-zA-Z0-9\s]/g, '').replace(/\s+/g, '_');
        res.setHeader('Content-Disposition', `attachment; filename=Declaration_${safeName}.docx`);
        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
        res.send(buffer);

    } catch (error) {
        console.error('Error generating declaration:', error);
        res.status(500).json({ message: 'Failed to generate declaration', error: error.message });
    }
};

exports.generateDynamicTemplate = async (req, res) => {
    try {
        const { id, templateId } = req.params;
        const [employee, company] = await Promise.all([
            OnboardingEmployee.findOne({ _id: id, companyId: req.companyId })
                .populate('createdBy', 'firstName lastName designation')
                .lean(),
            Company.findById(req.companyId).select('settings.onboarding').lean()
        ]);

        if (!employee) return res.status(404).json({ message: 'Employee not found' });

        const normId = (templateId || '').trim();
        const normClean = normId.replace(/[\s_-]+/g, '').toLowerCase();

        const customTpl = employee.customTemplates?.find(t => 
            t.templateId === normId || 
            (t._id && t._id.toString() === normId) || 
            t.name === normId ||
            t.name?.toLowerCase() === normId.toLowerCase() ||
            (normClean && t.name?.replace(/[\s_-]+/g, '').toLowerCase() === normClean) ||
            (/offer/i.test(normId) && /offer/i.test(t.name))
        );
        const dynamicTemplates = company.settings?.onboarding?.dynamicTemplates || [];
        const template = dynamicTemplates.find(t => 
            (t._id && t._id.toString() === normId) || 
            (t.id && t.id.toString() === normId) ||
            t.name === normId ||
            t.name?.toLowerCase() === normId.toLowerCase() ||
            (normClean && t.name?.replace(/[\s_-]+/g, '').toLowerCase() === normClean) ||
            (/offer/i.test(normId) && /offer/i.test(t.name)) ||
            (/declaration/i.test(normId) && /declaration/i.test(t.name)) ||
            (/loi/i.test(normId) && /loi/i.test(t.name)) ||
            (/^cl$/i.test(normId) && /^cl$/i.test(t.name))
        );
        let templateUrl = customTpl?.url || template?.url;
        if (!templateUrl && (/offer/i.test(normId) || normClean === 'offerletter')) {
            templateUrl = employee.offerLetterUrl || company?.settings?.onboarding?.offerLetterTemplateUrl;
        }
        if (!templateUrl && (/declaration/i.test(normId) || normClean === 'declaration')) {
            templateUrl = company?.settings?.onboarding?.declarationTemplateUrl;
        }
        if (!templateUrl && (normId === 'undefined' || normId === 'null' || !normId)) {
            const activeTpl = dynamicTemplates.find(t => !t.isDeleted && t.url);
            if (activeTpl) {
                templateUrl = activeTpl.url;
            } else if (employee.offerLetterUrl || company?.settings?.onboarding?.offerLetterTemplateUrl) {
                templateUrl = employee.offerLetterUrl || company?.settings?.onboarding?.offerLetterTemplateUrl;
            }
        }
        if (!templateUrl) return res.status(404).json({ message: 'Template not found' });

        const buffer = await getPopulatedDocumentBuffer(employee, company, templateUrl);

        const candidateName = `${employee.firstName}_${employee.lastName || ''}`.replace(/[^a-zA-Z0-9]/g, '_').replace(/_+/g, '_').trim();
        const docName = customTpl?.name || template?.name || 'Document';
        const safeName = docName.replace(/[^a-zA-Z0-9\s]/g, '').replace(/\s+/g, '_');
        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
        res.setHeader('Content-Disposition', `inline; filename=${candidateName}_${safeName}.docx`);
        res.send(buffer);
    } catch (error) {
        console.error('Error generating dynamic template preview:', error);
        res.status(500).json({ message: 'Failed to generate document', error: error.message });
    }
};

exports.generateCandidatePreviewBuffer = async (req, res) => {
    try {
        const { id, templateId } = req.params;
        const { content } = req.body || {};

        const [employee, company] = await Promise.all([
            OnboardingEmployee.findOne({ _id: id, companyId: req.companyId })
                .populate('createdBy', 'firstName lastName designation')
                .lean(),
            Company.findById(req.companyId).select('settings.onboarding').lean()
        ]);

        if (!employee) return res.status(404).json({ message: 'Employee not found' });

        const normId = (templateId || '').trim();
        const normClean = normId.replace(/[\s_-]+/g, '').toLowerCase();

        const customTpl = employee.customTemplates?.find(t => 
            t.templateId === normId || 
            (t._id && t._id.toString() === normId) || 
            t.name === normId ||
            t.name?.toLowerCase() === normId.toLowerCase() ||
            (normClean && t.name?.replace(/[\s_-]+/g, '').toLowerCase() === normClean) ||
            (/offer/i.test(normId) && /offer/i.test(t.name))
        );
        const dynamicTemplates = company.settings?.onboarding?.dynamicTemplates || [];
        const template = dynamicTemplates.find(t => 
            (t._id && t._id.toString() === normId) || 
            (t.id && t.id.toString() === normId) ||
            t.name === normId || 
            t.name?.toLowerCase() === normId.toLowerCase() ||
            (normClean && t.name?.replace(/[\s_-]+/g, '').toLowerCase() === normClean) ||
            (/offer/i.test(normId) && /offer/i.test(t.name)) ||
            (/declaration/i.test(normId) && /declaration/i.test(t.name)) ||
            (/loi/i.test(normId) && /loi/i.test(t.name)) ||
            (/^cl$/i.test(normId) && /^cl$/i.test(t.name))
        );
        let templateUrl = customTpl?.url || template?.url;
        if (!templateUrl && (/offer/i.test(normId) || normClean === 'offerletter')) {
            templateUrl = employee.offerLetterUrl || company?.settings?.onboarding?.offerLetterTemplateUrl;
        }
        if (!templateUrl && (/declaration/i.test(normId) || normClean === 'declaration')) {
            templateUrl = company?.settings?.onboarding?.declarationTemplateUrl;
        }
        if (!templateUrl && (normId === 'undefined' || normId === 'null' || !normId)) {
            const activeTpl = dynamicTemplates.find(t => !t.isDeleted && t.url);
            if (activeTpl) {
                templateUrl = activeTpl.url;
            } else if (employee.offerLetterUrl || company?.settings?.onboarding?.offerLetterTemplateUrl) {
                templateUrl = employee.offerLetterUrl || company?.settings?.onboarding?.offerLetterTemplateUrl;
            }
        }
        if (!templateUrl) return res.status(404).json({ message: 'Template not found' });

        let inputDoc = templateUrl;
        if (content && typeof content === 'string' && content.trim()) {
            const rawBaseBuffer = await getTemplateContent(templateUrl);
            const { value: rawContent } = await mammoth.extractRawText({ buffer: Buffer.from(rawBaseBuffer) });
            const normalize = (s) => (s || '').replace(/\r\n/g, '\n').replace(/^[ \t]+$/gm, '').replace(/\n{3,}/g, '\n\n').trim();
            const isChanged = normalize(content) !== normalize(rawContent);

            if (isChanged) {
                inputDoc = updateDocxWithText(Buffer.from(rawBaseBuffer), content);
            } else {
                inputDoc = Buffer.from(rawBaseBuffer);
            }
        }

        const buffer = await getPopulatedDocumentBuffer(employee, company, inputDoc);

        const candidateName = `${employee.firstName}_${employee.lastName || ''}`.replace(/[^a-zA-Z0-9]/g, '_').replace(/_+/g, '_').trim();
        const docName = customTpl?.name || template?.name || 'Document';
        const safeName = docName.replace(/[^a-zA-Z0-9\s]/g, '').replace(/\s+/g, '_');
        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
        res.setHeader('Content-Disposition', `inline; filename=${candidateName}_${safeName}_preview.docx`);
        res.send(buffer);
    } catch (error) {
        console.error('Error generating candidate dynamic template preview buffer:', error);
        res.status(500).json({ message: 'Failed to generate preview', error: error.message });
    }
};
