/**
 * Script to generate .docx template files with {placeholder} syntax.
 * Run once: node scripts/generateTemplates.js
 */
const fs = require('fs');
const path = require('path');
const PizZip = require('pizzip');
const Docxtemplater = require('docxtemplater');

const templatesDir = path.join(__dirname, '..', 'templates');
if (!fs.existsSync(templatesDir)) {
  fs.mkdirSync(templatesDir, { recursive: true });
}

/**
 * Create a minimal .docx with the given text content.
 * The text uses {placeholder} syntax that docxtemplater will fill in.
 */
function createTemplate(filename, textContent) {
  // A minimal valid .docx file is a ZIP containing specific XML files.
  // We'll create one from scratch using PizZip.
  const zip = new PizZip();

  // [Content_Types].xml
  zip.file('[Content_Types].xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
  <Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
</Types>`);

  // _rels/.rels
  zip.file('_rels/.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`);

  // word/_rels/document.xml.rels
  zip.file('word/_rels/document.xml.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`);

  // word/styles.xml - basic styles
  zip.file('word/styles.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:style w:type="paragraph" w:styleId="Normal" w:default="1">
    <w:name w:val="Normal"/>
    <w:rPr><w:sz w:val="22"/><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri"/></w:rPr>
  </w:style>
  <w:style w:type="paragraph" w:styleId="Heading1">
    <w:name w:val="heading 1"/>
    <w:pPr><w:jc w:val="center"/></w:pPr>
    <w:rPr><w:b/><w:sz w:val="32"/><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri"/></w:rPr>
  </w:style>
  <w:style w:type="paragraph" w:styleId="Heading2">
    <w:name w:val="heading 2"/>
    <w:rPr><w:b/><w:sz w:val="26"/><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri"/></w:rPr>
  </w:style>
</w:styles>`);

  // Convert text content to Word XML paragraphs
  const paragraphs = textContent.split('\n').map(line => {
    const trimmed = line.trim();
    if (!trimmed) {
      return '<w:p><w:r><w:t xml:space="preserve"> </w:t></w:r></w:p>';
    }

    let style = '';
    let text = trimmed;

    // Heading detection
    if (trimmed.startsWith('# ')) {
      style = '<w:pPr><w:pStyle w:val="Heading1"/></w:pPr>';
      text = trimmed.substring(2);
    } else if (trimmed.startsWith('## ')) {
      style = '<w:pPr><w:pStyle w:val="Heading2"/></w:pPr>';
      text = trimmed.substring(3);
    } else if (trimmed.startsWith('---')) {
      // Horizontal rule as a centered line
      return `<w:p><w:pPr><w:jc w:val="center"/></w:pPr><w:r><w:rPr><w:sz w:val="18"/></w:rPr><w:t xml:space="preserve">────────────────────────────────────────────────────────</w:t></w:r></w:p>`;
    }

    // Bold detection: **text**
    const parts = [];
    const regex = /\*\*(.*?)\*\*/g;
    let lastIndex = 0;
    let match;
    while ((match = regex.exec(text)) !== null) {
      if (match.index > lastIndex) {
        parts.push({ text: text.substring(lastIndex, match.index), bold: false });
      }
      parts.push({ text: match[1], bold: true });
      lastIndex = match.index + match[0].length;
    }
    if (lastIndex < text.length) {
      parts.push({ text: text.substring(lastIndex), bold: false });
    }
    if (parts.length === 0) {
      parts.push({ text, bold: false });
    }

    const runs = parts.map(p => {
      const rPr = p.bold ? '<w:rPr><w:b/></w:rPr>' : '';
      // Escape XML special chars
      const escaped = p.text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      return `<w:r>${rPr}<w:t xml:space="preserve">${escaped}</w:t></w:r>`;
    }).join('');

    return `<w:p>${style}${runs}</w:p>`;
  }).join('\n');

  // word/document.xml
  zip.file('word/document.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    ${paragraphs}
    <w:sectPr>
      <w:pgSz w:w="12240" w:h="15840"/>
      <w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/>
    </w:sectPr>
  </w:body>
</w:document>`);

  const buffer = zip.generate({ type: 'nodebuffer' });
  const filePath = path.join(templatesDir, filename);
  fs.writeFileSync(filePath, buffer);
  console.log(`✅ Created: ${filePath}`);
}

// ==========================================
// OFFER LETTER TEMPLATE
// ==========================================
const offerLetterContent = `June 30, 2025

{employee_full_name}
{employee_address}

**Subject: Appointment-cum-Employment Letter**

Dear {employee_full_name},

Greetings from Resource Gateway Consulting Pvt. Ltd. (Resource Gateway)!

We are pleased to confirm your appointment at Resource Gateway Consulting Pvt. Ltd. (Resource Gateway), and welcome you to our organization. You will be deputed at one of our esteemed client locations as per project requirements.

Please find below the terms and conditions of your appointment:

## 1. Designation & Reporting

Your designation is **"{designation}"**, and you will report to the designated Manager or Team Lead assigned by Client/Resource Gateway.

## 2. Date of Joining

Your joining date is **{joining_date}**

## 3. Compensation

Your total compensation details have been outlined in the attached Annexure A – Compensation Structure. Taxes will be deducted as per applicable laws.

Note: Your compensation is subject to periodic review and may be revised based on your performance and company policy.

## 4. Place of Work

Your primary work location is **Bangalore(Hybrid for now, may change in future as per project requirement)**. However, you may be required to travel or relocate based on project/client needs.

## 5. Working Hours

Your working hours will be as per client requirements and the timings policy governed by the client

## 6. Probation Period

You will be on a probation period of **{probation_period}** from your date of joining. Your performance will be reviewed during this period, and upon successful completion, your employment will be confirmed in writing.

## 7. Leave Policy
You will be eligible for 1.5 days of leave per month, accrued on a monthly basis.
We believe in maintaining a healthy work-life balance and encourage you to take time off when needed. At the same time, the first 3 to 6 months in your role are an important phase for learning, collaboration, and getting fully integrated into the team. We therefore encourage you to plan your leave accordingly and, as far as possible, minimize time off during this period.
We completely understand that personal or unforeseen situations may arise. In such instances, or for any planned leave, we request you to seek prior written approval from your reporting manager and keep the HR team informed, so that work can be managed smoothly.

## 8. Company Asset Usage and Return Policy

During the course of your employment, Resource Gateway will allocate certain company assets such as laptops, accessories, mobile phones, and other IT peripherals for official use. All employees who are provided with company-owned equipment are responsible for maintaining and returning the items in good condition.

These assets are provided solely for official use and must be returned:
- Upon resignation/termination
- On internal transfer where the asset is no longer required
- Upon specific request by the company

Failure to return the equipment or damage beyond reasonable wear and tear may lead to recovery of costs from final settlement or legal action.

## 9. Confidentiality, Non-Disclosure & Data Protection

You shall not, during or after your employment with Resource Gateway, either directly or indirectly, disclose, communicate, or use any proprietary or confidential information related to Resource Gateway or its clients, including but not limited to:


- Business strategies and plans
- Client and project information
- Technical and financial data
- Source code, documentation, processes, designs, algorithms, and system architecture
- Any personal data, sensitive or otherwise, accessed or processed in the course of employment


Client Data Confidentiality: As part of your assignment with clients, you acknowledge and agree that all client data, communications, technology, and project details are the exclusive and confidential property of the client. You are expected to comply with both Resource Gateway and client's confidentiality and data protection standards, as applicable.

This clause shall be effective throughout your term of employment and shall survive post-termination.


## 10. Intellectual Property (IP) Rights

All work products-including source code, designs, documentation, data, reports, or materials-developed by you solely or jointly with others during your employment (whether at Resource Gateway or at client location), using company resources or within work hours, shall be the sole and exclusive property of Resource Gateway or client, as applicable.

You hereby assign all related intellectual property rights to Resource Gateway and agree to execute necessary documentation to support this assignment. You also affirm that your work will not infringe on any third-party IP rights.

## 11. Code of Conduct

You are expected to maintain the highest standards of professional ethics, discipline, integrity, and conduct in all interactions with colleagues, clients, vendors, and stakeholders.

You are also required to adhere to the Code of Conduct and all policies of Resource Gateway as well as those of the clients during your assignment at the client site.

## 12. Termination of Employment

During probation, either party may terminate this employment in written by giving a 30 days notice or salary in lieu thereof. ("Salary" will be considered as basic salary)

Post-confirmation, a notice period of two (2) months in writing or salary in lieu is required from either party, unless mutually agreed otherwise in writing. ("Salary" will be considered as basic salary)

All terminations must be documented in writing. You are required to return all company property and settle any dues prior to your final exit.

## 13. Governing Law
This appointment letter and your employment shall be governed by and construed in accordance with the laws of [Gurugram Jurisdiction, e.g., Republic of India].

## 14. Policy Changes

Resource Gateway reserves the right to modify, amend, or discontinue any policies or terms of employment at its sole discretion, as required by business or legal circumstances.


---

**Declaration by Employee**

I hereby declare that:

1. I have no pending legal, criminal, or civil proceedings against me or any member of my immediate family.
2. I have not undergone any major surgery in the recent past and am not currently suffering from any chronic or communicable disease.
3. I will disclose any relevant personal or medical information, if applicable, in the attached Annexure B.

I confirm that the above information is true to the best of my knowledge, and I understand that providing false information can lead to termination of my employment without notice.

**Employee Acknowledgment**

I, **{employee_full_name}**, have read and understood the terms and conditions outlined in this letter, including those related to confidentiality, company property, and intellectual property, and accept the appointment on the stated terms.

**Name:** {employee_full_name}
**Signature:** _______________________
**Date:** ___________________________

**For Resource Gateway Consulting Pvt. Ltd.**

**{hr_name}** – Authorized Signatory 

---

# Annexure A - Compensation Structure

**Annexure A**

| Components | Monthly Salary |
| --- | --- |
| **Basic** | {basic_salary} |
| **HRA** | {hra} |
| **Special Allowance** | {special_allowance} |
| **Monthly Gross** | {monthly_gross} |

**Allowances**
| Components | Monthly |
| --- | --- |
| Meal Allowance | 1100 |
| Leave Travel Allowance(LTA)* | 4.81% of Basic |
| Broadband Allowance | 1000 |

**Benefits**
| Components | Monthly |
| --- | --- |
| Employee Provident Fund(EPF)**- Company's Contribution | 1800 |
| Insurance Premium*** | 2000 |

**Monthly CTC:** {monthly_ctc}
**Annual CTC:** {annual_ctc}

*Payable in March
**Provident Fund (PF):
Company's PF registration is underway. Once active, both you and the Company will contribute equally each month as per statutory guidelines.
*** Insurance Coverage:
You will be covered under our Group Insurance Policy as per company norms. For details on coverage or benefits, please connect with the Talent Management Team.

---

# Annexure B – Declaration of Legal/Medical Information

If you have any disclosures to make regarding legal proceedings or medical conditions, please provide details below. If not applicable, please write 'N/A'.

1. Legal/Criminal/Civil Proceedings (if any): _____________________________________________

2. Major Surgeries / Medical Conditions (if any): _________________________________________

**Signature:** _______________________
**Date:** ___________________________
`;

// ==========================================
// DECLARATION TEMPLATE
// ==========================================
const declarationContent = `# Resource Gateway Consulting Pvt. Ltd.
# Employee Declaration Form

**Date:** {declaration_date}

**Employee Name:** {employee_full_name}
**Employee ID:** {employee_id}
**Designation:** {designation}
**Department:** {department}
**Date of Joining:** {joining_date}

---

## Declaration

I, **{employee_full_name}**, hereby declare that:

**1. Personal Information**
All personal information, educational qualifications, and professional experience details provided by me during the pre-onboarding process are true, correct, and complete to the best of my knowledge and belief. I understand that any falsification, misrepresentation, or omission of facts may result in immediate termination of my employment.

**2. Legal Proceedings**
I declare that there are no pending legal, criminal, or civil proceedings against me in any court of law. If any such proceedings arise during my employment, I shall immediately notify the Company.

**3. Medical Declaration**
I declare that I am in good physical and mental health. I have not undergone any major surgery, and I do not suffer from any chronic disease that may affect my ability to perform my duties. If applicable, I have disclosed all relevant medical information in Annexure B.

**4. Previous Employment**
I have been relieved from my previous employer(s) and there are no outstanding obligations, non-compete restrictions, or contractual obligations that would prevent me from joining or performing my duties at Resource Gateway Consulting Pvt. Ltd.

**5. Confidentiality**
I acknowledge and agree to maintain strict confidentiality regarding all proprietary information, trade secrets, client information, and business strategies of the Company that I may come across during my employment.

**6. Company Policies**
I agree to abide by all rules, regulations, and policies of the Company as communicated from time to time. I understand that violation of any company policy may lead to disciplinary action, including termination.

**7. Background Verification**
I hereby authorize Resource Gateway Consulting Pvt. Ltd. to conduct background verification checks on me, including but not limited to criminal record checks, previous employment verification, and educational qualification verification.

---

## Employee Signature

**Full Name:** {employee_full_name}
**Signature:** {employee_signature_name}
**Date:** {declaration_date}
**Place:** {work_location}

---

## For Office Use Only

**Verified by:** {hr_name}
**Designation:** {hr_designation}
**Date:** ___________

---

**Confidential — Resource Gateway Consulting Pvt. Ltd.**`;

// Generate both templates
createTemplate('offer_letter_template.docx', offerLetterContent);
createTemplate('declaration_template.docx', declarationContent);

console.log('\n🎉 All templates generated successfully!');
