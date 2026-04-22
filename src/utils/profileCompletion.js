const SECTIONS = {
    basicInfo: {
        label: 'Basic Info',
        maxPoints: 15,
        icon: 'User',
        check: (applicant) => {
            let score = 0;
            if (applicant.firstName && applicant.lastName) score += 3;
            if (applicant.mobile) score += 2;
            if (applicant.headline) score += 4;
            if (applicant.currentCity) score += 3;
            if (applicant.jobSearchStatus) score += 3;
            return Math.min(score, 15);
        }
    },
    summary: {
        label: 'Career Summary',
        maxPoints: 10,
        icon: 'FileText',
        check: (applicant) => {
            if (applicant.summary && applicant.summary.trim().length >= 50) return 10;
            if (applicant.summary) return 5;
            return 0;
        }
    },
    workExperience: {
        label: 'Work Experience',
        maxPoints: 25,
        icon: 'Briefcase',
        check: (applicant) => {
            if (!applicant.workExperience?.length) return 0;
            const base = Math.min(applicant.workExperience.length * 10, 20);
            const hasDescription = applicant.workExperience.some((item) => item.description && item.description.length > 30);
            return Math.min(base + (hasDescription ? 5 : 0), 25);
        }
    },
    education: {
        label: 'Education',
        maxPoints: 15,
        icon: 'GraduationCap',
        check: (applicant) => {
            if (!applicant.education?.length) return 0;
            return Math.min(applicant.education.length * 8, 15);
        }
    },
    skills: {
        label: 'Skills',
        maxPoints: 15,
        icon: 'Zap',
        check: (applicant) => {
            if (!applicant.skills?.length) return 0;
            if (applicant.skills.length >= 5) return 15;
            return applicant.skills.length * 3;
        }
    },
    compensation: {
        label: 'Compensation & Availability',
        maxPoints: 10,
        icon: 'DollarSign',
        check: (applicant) => {
            let score = 0;
            if (applicant.currentCTC !== undefined && applicant.currentCTC !== null) score += 3;
            if (applicant.expectedCTC !== undefined && applicant.expectedCTC !== null) score += 3;
            if (applicant.noticePeriod !== undefined && applicant.noticePeriod !== null) score += 4;
            return score;
        }
    },
    resume: {
        label: 'Resume',
        maxPoints: 5,
        icon: 'Upload',
        check: (applicant) => applicant.resumeUrl ? 5 : 0
    },
    links: {
        label: 'Online Presence',
        maxPoints: 5,
        icon: 'Link',
        check: (applicant) => {
            let score = 0;
            if (applicant.linkedinUrl) score += 3;
            if (applicant.githubUrl || applicant.portfolioUrl) score += 2;
            return Math.min(score, 5);
        }
    }
};

exports.computeProfileCompletion = (applicant) => {
    let total = 0;
    const sections = {};

    for (const [key, section] of Object.entries(SECTIONS)) {
        const earned = section.check(applicant);
        total += earned;
        sections[key] = {
            label: section.label,
            icon: section.icon,
            earned,
            max: section.maxPoints,
            pct: Math.round((earned / section.maxPoints) * 100),
            complete: earned === section.maxPoints
        };
    }

    return {
        score: Math.round(total),
        sections
    };
};
