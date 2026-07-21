/**
 * dossierCompleteness.js
 * Pure utility — no DB calls.
 * Inspects an EmployeeProfile document and returns:
 *   { isComplete: boolean, missingSections: string[] }
 */

const MANDATORY_FIELDS = [
    // Personal
    { section: 'Personal Info',      label: 'First Name',              check: (p) => Boolean(p?.personal?.firstName?.trim()) },
    { section: 'Personal Info',      label: 'Last Name',               check: (p) => Boolean(p?.personal?.lastName?.trim()) },
    { section: 'Personal Info',      label: 'Date of Birth',           check: (p) => Boolean(p?.personal?.dob) },
    { section: 'Personal Info',      label: 'Gender',                  check: (p) => Boolean(p?.personal?.gender) },

    // Contact
    { section: 'Contact Details',    label: 'Mobile Number',           check: (p) => Boolean(p?.contact?.mobileNumber?.trim()) },
    { section: 'Contact Details',    label: 'Personal Email',          check: (p) => Boolean(p?.contact?.personalEmail?.trim()) },

    // Employment
    { section: 'Employment Details', label: 'Department',              check: (p) => Boolean(p?.employment?.department?.trim()) },
    { section: 'Employment Details', label: 'Joining Date',            check: (p) => Boolean(p?.employment?.joiningDate) },

    // Identity
    { section: 'Identity Details',   label: 'Aadhaar Card Number',     check: (p) => Boolean(p?.identity?.aadhaarNumber?.trim()) },
    { section: 'Identity Details',   label: 'PAN Card Number',         check: (p) => Boolean(p?.identity?.panNumber?.trim()) },

    // Emergency Contact
    { section: 'Emergency Contact',  label: 'Emergency Contact Name',  check: (p) => Boolean(p?.contact?.emergencyContact?.name?.trim()) },
    { section: 'Emergency Contact',  label: 'Emergency Contact Phone', check: (p) => Boolean(p?.contact?.emergencyContact?.phone?.trim()) },

    // Mandatory Documents
    { section: 'Mandatory Documents', label: 'Aadhaar Card (Front)',   check: (p) => p?.documents?.some(d => d?.title?.toLowerCase() === 'aadhaar card (front)' && !d?.isDeleted) },
    { section: 'Mandatory Documents', label: 'Aadhaar Card (Back)',    check: (p) => p?.documents?.some(d => d?.title?.toLowerCase() === 'aadhaar card (back)' && !d?.isDeleted) },
    { section: 'Mandatory Documents', label: 'Pan Card',               check: (p) => p?.documents?.some(d => d?.title?.toLowerCase() === 'pan card' && !d?.isDeleted) },
    { section: 'Mandatory Documents', label: 'Recent Photograph',      check: (p) => p?.documents?.some(d => d?.title?.toLowerCase() === 'recent passport-size photograph' && !d?.isDeleted) },
    { section: 'Mandatory Documents', label: 'Live Photograph',       check: (p) => p?.documents?.some(d => d?.title?.toLowerCase() === 'live photograph' && !d?.isDeleted) },
    { section: 'Mandatory Documents', label: '10th Marksheet / Cert',  check: (p) => p?.documents?.some(d => d?.title?.toLowerCase() === '10th marksheet / certificate' && !d?.isDeleted) },
    { section: 'Mandatory Documents', label: '12th Marksheet / Cert',  check: (p) => p?.documents?.some(d => d?.title?.toLowerCase() === '12th marksheet / certificate' && !d?.isDeleted) },
    { section: 'Mandatory Documents', label: 'Graduation Certificate', check: (p) => p?.documents?.some(d => d?.title?.toLowerCase() === 'graduation marksheet / certificate' && !d?.isDeleted) },
];

/**
 * @param {object} employeeProfile  A plain EmployeeProfile document (lean / toObject)
 * @returns {{ isComplete: boolean, missingSections: string[], missingFields: {section:string, label:string}[] }}
 */
const checkDossierCompleteness = (employeeProfile) => {
    // Check if HRIS details form has been submitted/declared for approval
    const hrisSubmitted = employeeProfile?.hris?.isDeclared === true ||
                          ['Pending Approval', 'Approved'].includes(employeeProfile?.hris?.status);

    // Check if documents have been submitted for approval
    const docsSubmitted = ['Submitted', 'Approved'].includes(employeeProfile?.documentSubmissionStatus);

    // If both are submitted/approved, unlock immediately!
    if (hrisSubmitted && docsSubmitted) {
        return {
            isComplete: true,
            missingSections: [],
            missingFields: []
        };
    }

    const missingFields = MANDATORY_FIELDS.filter((field) => !field.check(employeeProfile));

    if (!hrisSubmitted) {
        missingFields.push({
            section: 'Submission Required',
            label: 'Submit Dossier details for approval'
        });
    }

    if (!docsSubmitted) {
        missingFields.push({
            section: 'Submission Required',
            label: 'Submit Mandatory Documents for approval'
        });
    }

    const missingSections = [...new Set(missingFields.map((f) => f.section))];
    return {
        isComplete:      missingFields.length === 0,
        missingSections,
        missingFields:   missingFields.map((f) => ({ section: f.section, label: f.label }))
    };
};

module.exports = { checkDossierCompleteness };
