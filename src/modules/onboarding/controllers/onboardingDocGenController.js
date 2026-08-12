const OnboardingEmployee = require('../model/onboardingEmployee.model');
const Company = require('../../company/company.model');
const PizZip = require('pizzip');
const Docxtemplater = require('docxtemplater');
const path = require('path');
const { getTemplateContent } = require('./onboardingSettingsController');
const { formatDate, formatCurrency } = require('../utils/onboardingHelpers');

const getSalaryBreakups = async (employee) => {
    const breakups = {};
    if (!employee.salary || !employee.salary.annualCTC) return breakups;

    try {
        const PayrollConfig = require('../../payroll/payrollConfig.model');
        const { processCalculatedSalary, buildPayrollSnapshot } = require('../../payroll/payrollMath');
        const config = await PayrollConfig.findOne({ companyId: employee.companyId });
        if (config) {
            const annualCTC = parseFloat(String(employee.salary.annualCTC).replace(/[^0-9.]/g, '')) || 0;
            const monthlyCTC = annualCTC / 12;

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
    return breakups;
};

const preprocessDocxXml = (xmlString) => {
    return xmlString.replace(/<w:p(?: [^>]*)?>([\s\S]*?)<\/w:p>/g, (paragraphHtml) => {
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

const getPopulatedDocumentBuffer = async (employee, company, templateUrl, defaultPath = null) => {
    const content = await getTemplateContent(templateUrl, defaultPath);
    const zip = new PizZip(content);

    try {
        let docXml = zip.file('word/document.xml').asText();

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

        if (docXml.includes('{@employee_signature}')) {
            const _eSignNameRaw = employee.offerDeclaration?.eSignName;
            const _eSignTypeRaw = employee.offerDeclaration?.eSignType;
            const _eSignValueRaw = employee.offerDeclaration?.eSignValue;
            let inlineRunXml = '';

            if (employee.offerDeclaration?.isComplete && _eSignNameRaw) {
                if (_eSignTypeRaw === 'drawn' && _eSignValueRaw && _eSignValueRaw.startsWith('data:image/png;base64,')) {
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

                        const _drawingXml = `
                            <w:drawing>
                                <wp:inline xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" distT="0" distB="0" distL="0" distR="0">
                                    <wp:extent cx="1371600" cy="457200"/>
                                    <wp:docPr id="999" name="Candidate Signature"/>
                                    <wp:cNvGraphicFramePr>
                                        <a:graphicFrameLocks noChangeAspect="1"/>
                                    </wp:cNvGraphicFramePr>
                                    <a:graphic>
                                        <a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">
                                            <pic:pic>
                                                <pic:nvPicPr>
                                                    <pic:cNvPr id="999" name="candidate_signature.png"/>
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
                        inlineRunXml = `<w:r>${_drawingXml}</w:r>`;
                    } catch (_drawErr) {
                        console.error('Error building drawn signature for inline injection:', _drawErr.message);
                        inlineRunXml = `<w:r><w:rPr><w:rFonts w:ascii="${fontName}" w:hAnsi="${fontName}" w:cs="${fontName}"/></w:rPr><w:t xml:space="preserve"> ${_eSignNameRaw}</w:t></w:r>`;
                    }
                } else {
                    inlineRunXml = `<w:r><w:rPr><w:rFonts w:ascii="${fontName}" w:hAnsi="${fontName}" w:cs="${fontName}"/></w:rPr><w:t xml:space="preserve"> ${_eSignNameRaw}</w:t></w:r>`;
                }
            } else {
                inlineRunXml = `<w:r><w:rPr><w:color w:val="94A3B8"/></w:rPr><w:t xml:space="preserve"> (Pending Signature)</w:t></w:r>`;
            }

            docXml = docXml.replace(/<w:p( [^>]*)?>[\s\S]*?<\/w:p>/g, (paragraphXml) => {
                if (!paragraphXml.includes('employee_signature') &&
                    !paragraphXml.includes('employee_signa') &&
                    !paragraphXml.includes('signature')) return paragraphXml;

                const elements = [];
                const elementRegex = /(<w:pPr>[\s\S]*?<\/w:pPr>|<w:r(?:\s[^>]*)?>[\s\S]*?<\/w:r>|<[^>]+>)/g;
                let match;
                while ((match = elementRegex.exec(paragraphXml)) !== null) {
                    const rawXml = match[0];
                    const runTextMatch = rawXml.match(/<w:r(?:\s[^>]*)?>([\s\S]*?)<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>([\s\S]*?)<\/w:r>/);
                    if (runTextMatch) {
                        elements.push({
                            type: 'text_run',
                            rawXml,
                            rPr: rawXml.match(/<w:rPr>([\s\S]*?)<\/w:rPr>/)?.[0] || '',
                            text: runTextMatch[2]
                        });
                    } else {
                        elements.push({
                            type: 'other',
                            rawXml
                        });
                    }
                }

                let fullText = '';
                const textRunIndices = [];
                const textElements = elements.filter(el => el.type === 'text_run');
                if (textElements.length === 0) return paragraphXml;

                for (let i = 0; i < elements.length; i++) {
                    const el = elements[i];
                    if (el.type === 'text_run') {
                        for (let j = 0; j < el.text.length; j++) {
                            textRunIndices.push({ elIndex: i, charIndex: j });
                        }
                        fullText += el.text;
                    }
                }

                const tag = '{@employee_signature}';
                const tagStart = fullText.indexOf(tag);
                if (tagStart === -1) return paragraphXml;

                const tagEnd = tagStart + tag.length;

                const affectedElIndices = new Set();
                for (let idx = tagStart; idx < tagEnd; idx++) {
                    affectedElIndices.add(textRunIndices[idx].elIndex);
                }
                const affectedElIndicesArr = Array.from(affectedElIndices).sort((a, b) => a - b);

                const firstElIndex = affectedElIndicesArr[0];
                const firstEl = elements[firstElIndex];
                const startInRun = textRunIndices[tagStart].charIndex;
                const prefix = firstEl.text.slice(0, startInRun);

                const lastElIndex = affectedElIndicesArr[affectedElIndicesArr.length - 1];
                const lastEl = elements[lastElIndex];
                const endInRun = textRunIndices[tagEnd - 1].charIndex + 1;
                const suffix = lastEl.text.slice(endInRun);

                for (const elIdx of affectedElIndicesArr) {
                    elements[elIdx].text = '';
                }

                const rPr = firstEl.rPr;
                let newRawXml = '';
                if (prefix) {
                    newRawXml += `<w:r>${rPr}<w:t xml:space="preserve">${prefix}</w:t></w:r>`;
                }
                newRawXml += inlineRunXml;
                if (suffix) {
                    newRawXml += `<w:r>${rPr}<w:t xml:space="preserve">${suffix}</w:t></w:r>`;
                }
                firstEl.rawXml = newRawXml;

                for (let i = 1; i < affectedElIndicesArr.length; i++) {
                    elements[affectedElIndicesArr[i]].rawXml = '';
                }

                return elements.map(el => {
                    if (el.type === 'text_run' && el.text !== '') {
                        return `<w:r>${el.rPr}<w:t xml:space="preserve">${el.text}</w:t></w:r>`;
                    }
                    return el.rawXml;
                }).join('');
            });
        }

        docXml = preprocessDocxXml(docXml);
        zip.file('word/document.xml', docXml);
    } catch (e) {
        console.error('Error pre-processing document.xml:', e.message);
    }

    const eSignName = employee.offerDeclaration?.eSignName;
    const employeeSignatureInline = (employee.offerDeclaration?.isComplete && eSignName)
        ? eSignName
        : '(Pending Signature)';

    const doc = new Docxtemplater(zip, {
        paragraphLoop: true,
        linebreaks: true,
        nullGetter: () => '—'
    });

    const fullName = employee.personalDetails?.fullName || `${employee.firstName} ${employee.lastName}`.trim();
    const hrUser = employee.createdBy || {};
    const permAddr = employee.personalDetails?.permanentAddress || employee.personalDetails?.currentAddress || {};

    const salaryBreakups = await getSalaryBreakups(employee);

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
            declaration_date: formatDate(new Date()),
            employee_signature_name: fullName,
            employee_signature_inline: employeeSignatureInline,
            employee_signature_date: employee.offerDeclaration?.eSignDate ? formatDate(employee.offerDeclaration.eSignDate) : '—',
            employee_signature_ip: employee.offerDeclaration?.eSignIp || '—',
            current_date: new Date().toLocaleDateString('en-US', { month: 'long', day: '2-digit', year: 'numeric', timeZone: 'Asia/Kolkata' }),
            ...salaryBreakups
        });
    } catch (err) {
        console.error('Docxtemplater rendering error details:', err);
        throw err;
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

        const buffer = await getPopulatedDocumentBuffer(
            employee,
            company,
            company?.settings?.onboarding?.offerLetterTemplateUrl,
            path.join(__dirname, '../../../templates/offer_letter_template.docx')
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

        const buffer = await getPopulatedDocumentBuffer(
            employee,
            company,
            company?.settings?.onboarding?.declarationTemplateUrl,
            path.join(__dirname, '../../../templates/declaration_template.docx')
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

        const template = company.settings.onboarding.dynamicTemplates.find(t => t._id.toString() === templateId);
        if (!template) return res.status(404).json({ message: 'Template not found' });

        const buffer = await getPopulatedDocumentBuffer(employee, company, template.url);

        const candidateName = `${employee.firstName}_${employee.lastName || ''}`.replace(/[^a-zA-Z0-9]/g, '_').replace(/_+/g, '_').trim();
        const safeName = template.name.replace(/[^a-zA-Z0-9\s]/g, '').replace(/\s+/g, '_');
        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
        res.setHeader('Content-Disposition', `inline; filename=${candidateName}_${safeName}.docx`);
        res.send(buffer);
    } catch (error) {
        console.error('Error generating dynamic template preview:', error);
        res.status(500).json({ message: 'Failed to generate document', error: error.message });
    }
};
