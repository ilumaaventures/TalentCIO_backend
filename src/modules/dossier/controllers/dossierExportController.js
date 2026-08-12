const axios = require('axios');
const { cloudinary } = require('../../../config/cloudinary');
const { extractPublicIdFromUrl } = require('../../../utils/cloudinaryHelper');
const EmployeeProfile = require('../employeeProfile.model');

exports.proxyPdf = async (req, res) => {
    try {
        const { url, download } = req.query;
        console.log('Proxying URL:', url, 'Download:', download);

        if (!url || !url.includes('cloudinary')) {
            return res.status(400).json({ message: 'Invalid or missing Cloudinary URL' });
        }

        const attemptFetch = async (targetUrl) => {
            console.log('Fetching:', targetUrl);
            return axios({
                method: 'GET',
                url: targetUrl,
                responseType: 'stream',
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
                    'Referer': 'https://res.cloudinary.com/'
                },
                validateStatus: (status) => status < 400
            });
        };

        const versionMatch = url.match(/\/upload\/v(\d+)\//);
        const version = versionMatch ? versionMatch[1] : undefined;

        const getSignedUrl = (targetUrl, type) => {
            const publicId = extractPublicIdFromUrl(targetUrl);
            if (!publicId) return null;

            const resourceType = targetUrl.includes('/video/') ? 'video' : (targetUrl.includes('/raw/') ? 'raw' : 'image');
            const extMatch = targetUrl.match(/\.([a-zA-Z0-9]+)(\?|$)/);
            const formatExt = extMatch ? extMatch[1].toLowerCase() : undefined;

            const signedOptions = {
                resource_type: resourceType,
                secure: true,
                sign_url: true,
                type: type,
                version: version
            };
            if (formatExt) {
                signedOptions.format = formatExt;
            }

            return cloudinary.url(publicId, signedOptions);
        };

        const candidates = [];

        candidates.push(url);

        let alternateUrl = null;
        if (url.includes('/image/upload/')) {
            alternateUrl = url.replace('/image/upload/', '/raw/upload/');
        } else if (url.includes('/raw/upload/')) {
            alternateUrl = url.replace('/raw/upload/', '/image/upload/');
        }
        if (alternateUrl) candidates.push(alternateUrl);

        const signedOriginalAuth = getSignedUrl(url, 'authenticated');
        if (signedOriginalAuth) candidates.push(signedOriginalAuth);

        const signedOriginalUpload = getSignedUrl(url, 'upload');
        if (signedOriginalUpload) candidates.push(signedOriginalUpload);

        if (alternateUrl) {
            const signedAlternateAuth = getSignedUrl(alternateUrl, 'authenticated');
            if (signedAlternateAuth) candidates.push(signedAlternateAuth);

            const signedAlternateUpload = getSignedUrl(alternateUrl, 'upload');
            if (signedAlternateUpload) candidates.push(signedAlternateUpload);
        }

        let finalResponse;
        let errors = [];

        for (const candidate of candidates) {
            if (!candidate) continue;
            try {
                const fetchRes = await attemptFetch(candidate);

                const len = fetchRes.headers['content-length'];
                if (len && parseInt(len) === 0) {
                    throw new Error('Empty response body');
                }

                if (fetchRes.status < 400) {
                    finalResponse = fetchRes;
                    break;
                }
            } catch (err) {
                console.warn(`Failed candidate ${candidate}: ${err.message}`);
                errors.push(`${candidate}: ${err.message}`);
            }
        }

        if (!finalResponse) {
            console.error('All proxy attempts failed', errors);
            return res.status(502).json({ message: 'Failed to fetch document', details: errors });
        }

        const contentType = finalResponse.headers['content-type'];
        const contentLength = finalResponse.headers['content-length'];

        if (contentType) res.setHeader('Content-Type', contentType);
        if (contentLength) res.setHeader('Content-Length', contentLength);

        res.setHeader('Content-Disposition', download === 'true' ? 'attachment' : 'inline');

        finalResponse.data.pipe(res);

    } catch (error) {
        console.error('Proxy Pdf Global Error:', error.message);
        res.status(500).json({ message: 'Proxy Server Error', error: error.message });
    }
};

exports.exportHRISExcel = async (req, res) => {
    try {
        const ExcelJS = require('exceljs');
        const workbook = new ExcelJS.Workbook();
        const sheet = workbook.addWorksheet('HRIS Data');

        const query = {
            companyId: req.companyId,
            'hris.status': { $in: ['Pending Approval', 'Approved'] }
        };

        if (req.query.userId) {
            query.user = req.query.userId;
        }

        const profiles = await EmployeeProfile.find(query)
            .sort({ 'hris.submittedAt': -1, 'hris.approvalDate': -1 })
            .select('+identity.aadhaarNumber +identity.panNumber +identity.passportNumber +compensation.bankDetails.accountNumber +compensation.ctc +compensation.uanNumber')
            .populate('user', 'employeeCode firstName lastName email')
            .populate('employment.businessUnit', 'name');

        const formatDate = (date) => date ? new Date(date).toLocaleDateString() : '';

        const sections = [
            {
                title: 'Employee Details',
                columns: [
                    { header: 'Employee Code', key: 'empCode', width: 15 },
                    { header: 'Full Name', key: 'fullName', width: 25 },
                    { header: 'First Name', key: 'firstName', width: 15 },
                    { header: 'Middle Name', key: 'middleName', width: 15 },
                    { header: 'Last Name', key: 'lastName', width: 15 },
                    { header: 'Gender', key: 'gender', width: 10 },
                    { header: 'Date of Birth', key: 'dob', width: 12 },
                    { header: 'Marital Status', key: 'maritalStatus', width: 15 },
                    { header: 'Date of Marriage', key: 'dateOfMarriage', width: 15 },
                    { header: 'Nationality', key: 'nationality', width: 15 },
                    { header: 'Blood Group', key: 'bloodGroup', width: 10 },
                    { header: 'Disability Status', key: 'disabilityStatus', width: 15 },
                    { header: 'Nature of Disability', key: 'disabilityDetails', width: 25 },
                    { header: 'Date of Joining', key: 'joiningDate', width: 12 },
                ]
            },
            {
                title: 'Contact Information',
                columns: [
                    { header: 'Personal Email ID', key: 'personalEmail', width: 25 },
                    { header: 'Mobile Number', key: 'mobile', width: 15 },
                    { header: 'Alternate Mobile Number', key: 'altMobile', width: 15 },
                    { header: 'Emergency Contact Name', key: 'emergencyName', width: 20 },
                    { header: 'Emergency Contact Relationship', key: 'emergencyRelation', width: 15 },
                    { header: 'Emergency Contact Number', key: 'emergencyPhone', width: 15 },
                    { header: 'Emergency Contact Email', key: 'emergencyEmail', width: 25 },
                ]
            },
            {
                title: 'Address Details',
                columns: [
                    { header: 'Present', key: 'currAddrFull', width: 40 },
                    { header: 'Permanent', key: 'permAddrFull', width: 40 },
                    { header: 'Mailing', key: 'mailAddrFull', width: 40 },
                ]
            },
            {
                title: 'Bank Account Details',
                columns: [
                    { header: 'Account Holder Name', key: 'accHolder', width: 20 },
                    { header: 'Bank Name', key: 'bankName', width: 20 },
                    { header: 'Branch Address', key: 'branchAddress', width: 30 },
                    { header: 'Account Number', key: 'accNum', width: 20 },
                    { header: 'IFSC Code', key: 'ifsc', width: 15 },
                    { header: 'UAN', key: 'uan', width: 15 },
                ]
            },
            {
                title: 'Government / Identity Details',
                columns: [
                    { header: 'PAN Number', key: 'pan', width: 15 },
                    { header: 'Aadhaar Number', key: 'aadhaar', width: 15 },
                    { header: 'Passport Number', key: 'passport', width: 15 },
                ]
            },
            {
                title: 'Medical Insurance Details',
                columns: [
                    { header: 'father name', key: 'fatherName', width: 20 },
                    { header: 'father occupation', key: 'fatherOcc', width: 20 },
                    { header: 'mother name', key: 'motherName', width: 20 },
                    { header: 'mother occupation', key: 'motherOcc', width: 20 },
                    { header: 'parents marital status', key: 'famMarital', width: 15 },
                    { header: 'total sibling', key: 'totalSiblings', width: 10 },
                    { header: 'spouse name', key: 'spouseName', width: 20 },
                    { header: 'spouse DOB', key: 'spouseDob', width: 12 },
                    { header: 'childern name', key: 'childNames', width: 25 },
                    { header: 'children DOB', key: 'childDobs', width: 25 },
                ]
            },
            {
                title: 'Educational Qualification',
                columns: [
                    { header: 'college name', key: 'college', width: 20 },
                    { header: 'Course Name', key: 'course', width: 20 },
                    { header: 'University', key: 'university', width: 20 },
                    { header: 'from date', key: 'eduFrom', width: 12 },
                    { header: 'to date', key: 'eduTo', width: 12 },
                    { header: 'Percentage / CGPA', key: 'cgpa', width: 10 },
                ]
            },
            {
                title: 'Work Experience',
                columns: [
                    { header: 'Total Years of Experience', key: 'totalExp', width: 10 },
                    { header: 'Previous Company Name', key: 'prevComp', width: 20 },
                    { header: 'Start Date', key: 'expStart', width: 12 },
                    { header: 'End Date', key: 'expEnd', width: 12 },
                    { header: 'Reason for Leaving', key: 'reasonForLeaving', width: 25 },
                ]
            },
            {
                title: 'Skills',
                columns: [
                    { header: 'Technical Skills', key: 'techSkills', width: 30 },
                    { header: 'Behavioral Skills', key: 'behavSkills', width: 30 },
                    { header: 'Skill you would like to learn', key: 'learnSkills', width: 30 },
                ]
            }
        ];

        let currentColumnIndex = 1;

        const headerRow1 = sheet.getRow(1);
        headerRow1.font = { bold: true, size: 12 };
        headerRow1.alignment = { horizontal: 'center' };

        const headerRow2 = sheet.getRow(2);
        headerRow2.font = { bold: true };
        headerRow2.alignment = { horizontal: 'center', wrapText: true };

        sections.forEach((section) => {
            const startCol = currentColumnIndex;
            const endCol = startCol + section.columns.length - 1;

            sheet.mergeCells(1, startCol, 1, endCol);
            const titleCell = sheet.getCell(1, startCol);
            titleCell.value = section.title;
            titleCell.fill = {
                type: 'pattern',
                pattern: 'solid',
                fgColor: { argb: 'FFD3D3D3' }
            };
            titleCell.border = { top: { style: 'thin' }, left: { style: 'thin' }, bottom: { style: 'thin' }, right: { style: 'thin' } };

            section.columns.forEach((col, colIdx) => {
                const effectiveCol = startCol + colIdx;
                const cell = sheet.getCell(2, effectiveCol);
                cell.value = col.header;

                const column = sheet.getColumn(effectiveCol);
                column.key = col.key;
                column.width = col.width;
            });

            currentColumnIndex = endCol + 2;
        });

        profiles.forEach(p => {
            const merged = p.toObject();
            if (merged.pendingUpdates && p.hris?.status === 'Approved') {
                const pending = merged.pendingUpdates;
                if (pending.personal) merged.personal = { ...(merged.personal || {}), ...pending.personal };
                if (pending.identity) merged.identity = { ...(merged.identity || {}), ...pending.identity };
                if (pending.contact) {
                    const mergedAddresses = [...(merged.contact?.addresses || [])];
                    if (pending.contact.addresses && Array.isArray(pending.contact.addresses)) {
                        pending.contact.addresses.forEach(addr => {
                            const idx = mergedAddresses.findIndex(a => a.type === addr.type);
                            if (idx !== -1) {
                                mergedAddresses[idx] = { ...mergedAddresses[idx], ...addr };
                            } else {
                                mergedAddresses.push(addr);
                            }
                        });
                    }
                    merged.contact = {
                        ...(merged.contact || {}),
                        ...pending.contact,
                        addresses: mergedAddresses
                    };
                }
                if (pending.family) merged.family = { ...(merged.family || {}), ...pending.family };
                if (pending.employment) merged.employment = { ...(merged.employment || {}), ...pending.employment };
                if (pending.compensation) {
                    merged.compensation = {
                        ...(merged.compensation || {}),
                        ...pending.compensation,
                        bankDetails: { ...(merged.compensation?.bankDetails || {}), ...(pending.compensation?.bankDetails || {}) }
                    };
                }
                if (pending.education) merged.education = pending.education;
                if (pending.experience) merged.experience = pending.experience;
                if (pending.skills) merged.skills = pending.skills;
            }

            const getAddr = (type) => merged.contact?.addresses?.find(a => a.type === type) || {};
            const curr = getAddr('Current');
            const perm = getAddr('Permanent');
            const mail = merged.contact?.addresses?.find(a => a.type === 'Mailing') || {};

            let totalExpYears = 0;
            if (merged.experience && merged.experience.length > 0) {
                const msInYear = 1000 * 60 * 60 * 24 * 365.25;
                totalExpYears = merged.experience.reduce((acc, exp) => {
                    const start = exp.startDate ? new Date(exp.startDate) : new Date();
                    const end = exp.endDate ? new Date(exp.endDate) : new Date();
                    return acc + (end - start);
                }, 0) / msInYear;
            }

            const eduCount = merged.education?.length || 0;
            const expCount = merged.experience?.length || 0;
            const childCount = merged.family?.children?.length || 0;
            const maxRows = Math.max(1, eduCount, expCount, childCount);

            for (let i = 0; i < maxRows; i++) {
                const isFirst = i === 0;

                const edu = merged.education?.[i] || {};
                const exp = merged.experience?.[i] || {};
                const child = merged.family?.children?.[i] || {};

                const getDate = (d) => d ? formatDate(d) : '';

                const formatFullAddr = (addr) => {
                    const l1 = addr?.line1 || addr?.street;
                    if (!addr || !l1) return '';
                    const parts = [
                        l1,
                        addr.addressLine2,
                        addr.city,
                        addr.state,
                        addr.country,
                        addr.zipCode,
                        addr.phone ? `Phone: ${addr.phone}` : ''
                    ];
                    return parts.filter(Boolean).join(', ');
                };

                const rowData = {
                    empCode: isFirst ? merged.user?.employeeCode : '',
                    fullName: isFirst ? (merged.personal?.fullName || `${merged.user?.firstName} ${merged.user?.lastName}`.trim()) : '',
                    firstName: isFirst ? merged.user?.firstName : '',
                    middleName: isFirst ? merged.personal?.middleName : '',
                    lastName: isFirst ? merged.user?.lastName : '',
                    gender: isFirst ? merged.personal?.gender : '',
                    dob: isFirst ? formatDate(merged.personal?.dob) : '',
                    maritalStatus: isFirst ? merged.personal?.maritalStatus : '',
                    dateOfMarriage: isFirst ? (merged.personal?.dateOfMarriage ? formatDate(merged.personal?.dateOfMarriage) : '') : '',
                    nationality: isFirst ? merged.personal?.nationality : '',
                    bloodGroup: isFirst ? merged.personal?.bloodGroup : '',
                    disabilityStatus: isFirst ? (merged.personal?.disabilityStatus ? 'Yes' : 'No') : '',
                    disabilityDetails: isFirst ? (merged.personal?.disabilityStatus ? merged.personal?.disabilityDetails : '') : '',
                    joiningDate: isFirst ? formatDate(merged.employment?.joiningDate) : '',

                    personalEmail: isFirst ? merged.contact?.personalEmail : '',
                    mobile: isFirst ? merged.contact?.mobileNumber : '',
                    altMobile: isFirst ? merged.contact?.alternateNumber : '',
                    emergencyName: isFirst ? merged.contact?.emergencyContact?.name : '',
                    emergencyRelation: isFirst ? (merged.contact?.emergencyContact?.relation || '') : '',
                    emergencyPhone: isFirst ? merged.contact?.emergencyContact?.phone : '',
                    emergencyEmail: isFirst ? merged.contact?.emergencyContact?.email : '',

                    currAddrFull: isFirst ? formatFullAddr(curr) : '',
                    permAddrFull: isFirst ? formatFullAddr(perm) : '',
                    mailAddrFull: isFirst ? formatFullAddr(mail) : '',

                    accHolder: isFirst ? (merged.compensation?.bankDetails?.accountHolderName || merged.personal?.fullName || `${merged.user?.firstName} ${merged.user?.lastName}`) : '',
                    bankName: isFirst ? merged.compensation?.bankDetails?.bankName : '',
                    branchAddress: isFirst ? merged.compensation?.bankDetails?.branchAddress : '',
                    accNum: isFirst ? merged.compensation?.bankDetails?.accountNumber : '',
                    ifsc: isFirst ? merged.compensation?.bankDetails?.ifscCode : '',
                    uan: isFirst ? (merged.compensation?.isUanApplicable === true ? (merged.compensation?.uanNumber || '') : 'Not Applicable') : '',

                    pan: isFirst ? merged.identity?.panNumber : '',
                    aadhaar: isFirst ? merged.identity?.aadhaarNumber : '',
                    passport: isFirst ? merged.identity?.passportNumber : '',

                    fatherName: isFirst ? merged.family?.fatherName : '',
                    fatherOcc: isFirst ? merged.family?.fatherOccupation : '',
                    motherName: isFirst ? merged.family?.motherName : '',
                    motherOcc: isFirst ? merged.family?.motherOccupation : '',
                    famMarital: isFirst ? merged.family?.parentsMaritalStatus : '',
                    totalSiblings: isFirst ? merged.family?.totalSiblings : '',
                    spouseName: isFirst ? merged.family?.spouseName : '',
                    spouseDob: isFirst ? formatDate(merged.family?.spouseDob) : '',

                    childNames: child.name || '',
                    childDobs: getDate(child.dob),

                    college: edu.institution || '',
                    course: edu.courseName || edu.degree || '',
                    university: edu.university || '',
                    eduFrom: getDate(edu.fromDate),
                    eduTo: getDate(edu.toDate),
                    cgpa: edu.grade || '',

                    totalExp: isFirst && totalExpYears > 0 ? totalExpYears.toFixed(1) : '',
                    prevComp: exp.companyName || '',
                    expStart: getDate(exp.startDate),
                    expEnd: getDate(exp.endDate),
                    reasonForLeaving: exp.reasonForLeaving || '',

                    techSkills: isFirst ? (merged.skills?.technical?.join(', ') || '') : '',
                    behavSkills: isFirst ? (merged.skills?.behavioral?.join(', ') || '') : '',
                    learnSkills: isFirst ? (merged.skills?.learningInterests?.join(', ') || '') : ''
                };

                sheet.addRow(rowData);
            }
        });

        const exportProfile = req.query.userId && profiles.length === 1 ? profiles[0] : null;
        const exportDisplayName = exportProfile
            ? [
                exportProfile.user?.firstName,
                exportProfile.user?.lastName
            ].filter(Boolean).join(' ').trim()
            : 'Employee_HRIS_Export';
        const safeExportFileName = (exportDisplayName || 'Employee_HRIS_Export')
            .replace(/\s+/g, '_')
            .replace(/[^a-zA-Z0-9_-]/g, '')
            || 'Employee_HRIS_Export';

        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.setHeader('Content-Disposition', `attachment; filename="${safeExportFileName}_HRIS.xlsx"`);

        await workbook.xlsx.write(res);
        res.end();

    } catch (error) {
        console.error('Export Excel Error:', error);
        res.status(500).json({ message: 'Failed to generate Excel' });
    }
};
