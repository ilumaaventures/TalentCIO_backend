const mongoose = require('mongoose');
const axios = require('axios');
const jwt = require('jsonwebtoken');
const Plan = require('../models/Plan');
const Applicant = require('../models/Applicant');
const User = require('../models/User');
const Company = require('../models/Company');
const HandoffToken = require('../models/HandoffToken');
const { HiringRequest } = require('../models/HiringRequest');
const PublicApplication = require('../models/PublicApplication');
const { sendEmail, sendOTPEmail } = require('../services/emailService');
const { computeProfileCompletion } = require('../utils/profileCompletion');

const DEMO_REQUEST_RECIPIENT = process.env.DEMO_REQUEST_EMAIL || 'ilumaaventures@gmail.com';
const GOOGLE_OAUTH_CLIENT_ID_FALLBACK = '485252065297-kuf4ijabspu0manp3jvkdvlmsjjqa5th.apps.googleusercontent.com';
const GOOGLE_OAUTH_CLIENT_IDS = Array.from(new Set([
    process.env.GOOGLE_OAUTH_CLIENT_ID,
    process.env.GOOGLE_CLIENT_ID,
    GOOGLE_OAUTH_CLIENT_ID_FALLBACK
].filter(Boolean)));
const generateApplicantToken = (id, tokenVersion = 0) =>
    jwt.sign({ id, tokenVersion, type: 'applicant' }, process.env.JWT_SECRET, { expiresIn: '30d' });
const APPLICANT_SAFE_SELECT = '-password -emailOtp -emailOtpExpires -resetOtp -resetOtpExpires -tokenVersion';

const escapeRegex = (value = '') => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const splitFullName = (fullName = '') => {
    const parts = String(fullName || '').trim().split(/\s+/).filter(Boolean);

    if (!parts.length) {
        return { firstName: 'Google', lastName: 'Applicant' };
    }

    if (parts.length === 1) {
        return { firstName: parts[0], lastName: 'Applicant' };
    }

    return {
        firstName: parts[0],
        lastName: parts.slice(1).join(' ')
    };
};

const buildApplicantAuthPayload = (applicant) => ({
    _id: applicant._id,
    firstName: applicant.firstName,
    lastName: applicant.lastName,
    email: applicant.email,
    mobile: applicant.mobile,
    currentCTC: applicant.currentCTC,
    expectedCTC: applicant.expectedCTC,
    noticePeriod: applicant.noticePeriod,
    resumeUrl: applicant.resumeUrl,
    resumePublicId: applicant.resumePublicId,
    profilePhotoUrl: applicant.profilePhotoUrl,
    authProvider: applicant.authProvider || 'local',
    isEmailVerified: applicant.isEmailVerified
});

const verifyGoogleCredential = async (idToken) => {
    const token = String(idToken || '').trim();

    if (!token) {
        throw new Error('Google credential is required.');
    }

    const { data } = await axios.get('https://oauth2.googleapis.com/tokeninfo', {
        params: { id_token: token },
        timeout: 10000
    });

    if (!data?.sub || !data?.email) {
        throw new Error('Google account details are incomplete.');
    }

    if (String(data.email_verified).toLowerCase() !== 'true') {
        throw new Error('Google email is not verified.');
    }

    if (GOOGLE_OAUTH_CLIENT_IDS.length && !GOOGLE_OAUTH_CLIENT_IDS.includes(data.aud)) {
        throw new Error('Google client ID does not match this application.');
    }

    return {
        googleId: data.sub,
        email: String(data.email).trim().toLowerCase(),
        fullName: data.name || '',
        givenName: data.given_name || '',
        familyName: data.family_name || '',
        picture: data.picture || ''
    };
};

const buildPublicJobsQuery = ({ location, type, department, search }) => {
    const query = {
        isPublic: true,
        status: 'Approved'
    };

    if (location) {
        query['requirements.location'] = location;
    }

    if (type) {
        query['roleDetails.employmentType'] = type;
    }

    if (department) {
        query['roleDetails.department'] = {
            $regex: escapeRegex(department),
            $options: 'i'
        };
    }

    if (search) {
        const regex = { $regex: escapeRegex(search), $options: 'i' };
        query.$or = [
            { 'roleDetails.title': regex },
            { 'roleDetails.department': regex },
            { client: regex }
        ];
    }

    return query;
};

const maskConfidentialClient = (job) => {
    if (!job) {
        return job;
    }

    if (!job.clientConfidential) {
        return job;
    }

    return {
        ...job,
        client: 'Confidential Client'
    };
};

const isResourceGatewayEnabledForCompany = (company) => (
    Boolean(company?.settings?.careers?.enableResourceGatewayPublishing)
);

const normalizeStringList = (values = [], maxItems = null) => {
    const normalized = Array.isArray(values)
        ? values
            .map((value) => String(value || '').trim())
            .filter(Boolean)
        : [];

    return maxItems ? normalized.slice(0, maxItems) : normalized;
};

const normalizeSkills = (skills = []) => (
    Array.isArray(skills)
        ? skills
            .map((skill) => ({
                name: String(skill?.name || '').trim(),
                level: skill?.level || 'Intermediate'
            }))
            .filter((skill) => skill.name)
        : []
);

const normalizeLanguages = (languages = []) => (
    Array.isArray(languages)
        ? languages
            .map((language) => ({
                language: String(language?.language || '').trim(),
                proficiency: language?.proficiency || 'Professional'
            }))
            .filter((language) => language.language)
        : []
);

const normalizeOtherLinks = (otherLinks = []) => (
    Array.isArray(otherLinks)
        ? otherLinks
            .map((link) => ({
                label: String(link?.label || '').trim(),
                url: String(link?.url || '').trim()
            }))
            .filter((link) => link.label && link.url)
            .slice(0, 3)
        : []
);

const parseOptionalNumber = (value) => {
    if (value === undefined || value === null || value === '') {
        return undefined;
    }

    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
};

const calculateTotalExperienceYears = (workExperience = []) => {
    const ranges = workExperience
        .map((item) => {
            if (!item?.startYear) return null;

            const startMonth = Math.min(Math.max(Number(item.startMonth) || 1, 1), 12);
            const startIndex = (Number(item.startYear) * 12) + (startMonth - 1);

            let endYear = item.isCurrent ? new Date().getFullYear() : Number(item.endYear);
            let endMonth = item.isCurrent ? (new Date().getMonth() + 1) : Number(item.endMonth || 12);

            if (!endYear || endYear < Number(item.startYear)) {
                endYear = Number(item.startYear);
                endMonth = startMonth;
            }

            const endIndex = (endYear * 12) + (Math.min(Math.max(endMonth || 1, 1), 12) - 1);
            return [startIndex, Math.max(startIndex, endIndex)];
        })
        .filter(Boolean)
        .sort((left, right) => left[0] - right[0]);

    if (!ranges.length) {
        return 0;
    }

    const merged = [];
    for (const range of ranges) {
        const previous = merged[merged.length - 1];
        if (!previous || range[0] > previous[1] + 1) {
            merged.push([...range]);
        } else {
            previous[1] = Math.max(previous[1], range[1]);
        }
    }

    const totalMonths = merged.reduce((sum, [start, end]) => sum + ((end - start) + 1), 0);
    return Math.round((totalMonths / 12) * 10) / 10;
};

const buildProfileSnapshot = (applicant) => ({
    firstName: applicant.firstName,
    lastName: applicant.lastName,
    email: applicant.email,
    mobile: applicant.mobile,
    headline: applicant.headline,
    summary: applicant.summary,
    currentCity: applicant.currentCity,
    currentState: applicant.currentState,
    currentCountry: applicant.currentCountry,
    willingToRelocate: applicant.willingToRelocate,
    preferredLocations: applicant.preferredLocations || [],
    preferredJobTypes: applicant.preferredJobTypes || [],
    preferredDepartments: applicant.preferredDepartments || [],
    jobSearchStatus: applicant.jobSearchStatus,
    currentCTC: applicant.currentCTC,
    expectedCTC: applicant.expectedCTC,
    noticePeriod: applicant.noticePeriod,
    totalExperienceYears: applicant.totalExperienceYears,
    skills: applicant.skills || [],
    languages: applicant.languages || [],
    linkedinUrl: applicant.linkedinUrl,
    githubUrl: applicant.githubUrl,
    portfolioUrl: applicant.portfolioUrl,
    otherLinks: applicant.otherLinks || [],
    resumeUrl: applicant.resumeUrl,
    resumeFileName: applicant.resumeFileName,
    resumeUpdatedAt: applicant.resumeUpdatedAt,
    profilePhotoUrl: applicant.profilePhotoUrl,
    profileCompletionScore: applicant.profileCompletionScore,
    workExperience: (applicant.workExperience || []).map((item) => ({
        jobTitle: item.jobTitle,
        companyName: item.companyName,
        employmentType: item.employmentType,
        location: item.location,
        locationType: item.locationType,
        startMonth: item.startMonth,
        startYear: item.startYear,
        endMonth: item.endMonth,
        endYear: item.endYear,
        isCurrent: item.isCurrent,
        description: item.description,
        skills: item.skills || []
    })),
    education: (applicant.education || []).map((item) => ({
        degree: item.degree,
        fieldOfStudy: item.fieldOfStudy,
        institution: item.institution,
        grade: item.grade,
        startYear: item.startYear,
        endYear: item.endYear,
        isCurrent: item.isCurrent,
        description: item.description
    })),
    certifications: (applicant.certifications || []).map((item) => ({
        name: item.name,
        issuingOrganization: item.issuingOrganization,
        issueMonth: item.issueMonth,
        issueYear: item.issueYear,
        expiryMonth: item.expiryMonth,
        expiryYear: item.expiryYear,
        doesNotExpire: item.doesNotExpire,
        credentialId: item.credentialId,
        credentialUrl: item.credentialUrl
    }))
});

const getApplicantWithCompletion = async (applicantId) => {
    const applicant = await Applicant.findById(applicantId).select(APPLICANT_SAFE_SELECT).lean();
    if (!applicant) {
        return null;
    }

    const completion = computeProfileCompletion(applicant);
    if (applicant.profileCompletionScore !== completion.score) {
        await Applicant.findByIdAndUpdate(applicantId, { profileCompletionScore: completion.score });
        applicant.profileCompletionScore = completion.score;
    }

    return { applicant, completion };
};

const issueFirstLoginOtp = async (user) => {
    const otpCode = Math.floor(100000 + Math.random() * 900000).toString();
    user.otp = otpCode;
    user.otpExpires = Date.now() + 10 * 60 * 1000;
    await user.save();

    sendOTPEmail(user.email, otpCode, user.firstName).catch((error) => {
        console.error('[COMPANY LOGIN] Failed to send first-login OTP:', error.message);
    });
};

exports.getPublicPlans = async (req, res) => {
    try {
        const plans = await Plan.find({ isActive: true }).sort({ price: 1, createdAt: 1 }).lean();
        res.json({ plans });
    } catch (error) {
        console.error('Failed to fetch public plans:', error);
        res.status(500).json({ message: 'Failed to fetch plans' });
    }
};

exports.createDemoRequest = async (req, res) => {
    try {
        const {
            name,
            company,
            email,
            phone,
            teamSize,
            message,
            interestedModules = []
        } = req.body;

        if (!name || !email || !company) {
            return res.status(400).json({ message: 'Name, email, and company are required' });
        }

        console.log('[DEMO REQUEST]', {
            name,
            company,
            email,
            phone,
            teamSize,
            interestedModules: Array.isArray(interestedModules) ? interestedModules : [],
            message,
            at: new Date()
        });

        const submittedAt = new Date();
        const modulesList = Array.isArray(interestedModules) && interestedModules.length
            ? interestedModules.join(', ')
            : 'Not specified';

        const html = `
            <div style="font-family: Arial, sans-serif; max-width: 680px; margin: 0 auto; padding: 24px; border: 1px solid #e5e7eb; border-radius: 12px; color: #0f172a;">
                <h2 style="margin: 0 0 12px; color: #115cb9;">New TalentCIO Demo Request</h2>
                <p style="margin: 0 0 20px; color: #475569;">A new demo request was submitted from the TalentCIO marketing site.</p>

                <table style="width: 100%; border-collapse: collapse;">
                    <tr><td style="padding: 8px 0; font-weight: 700; width: 180px;">Name</td><td style="padding: 8px 0;">${name}</td></tr>
                    <tr><td style="padding: 8px 0; font-weight: 700;">Company</td><td style="padding: 8px 0;">${company}</td></tr>
                    <tr><td style="padding: 8px 0; font-weight: 700;">Email</td><td style="padding: 8px 0;">${email}</td></tr>
                    <tr><td style="padding: 8px 0; font-weight: 700;">Phone</td><td style="padding: 8px 0;">${phone || 'Not provided'}</td></tr>
                    <tr><td style="padding: 8px 0; font-weight: 700;">Team Size</td><td style="padding: 8px 0;">${teamSize || 'Not specified'}</td></tr>
                    <tr><td style="padding: 8px 0; font-weight: 700;">Interested Modules</td><td style="padding: 8px 0;">${modulesList}</td></tr>
                    <tr><td style="padding: 8px 0; font-weight: 700;">Submitted At</td><td style="padding: 8px 0;">${submittedAt.toLocaleString('en-IN')}</td></tr>
                </table>

                <div style="margin-top: 20px; padding: 16px; background: #f8fafc; border-radius: 10px;">
                    <div style="font-weight: 700; margin-bottom: 8px;">Message</div>
                    <div style="white-space: pre-wrap; color: #334155;">${message || 'No message provided'}</div>
                </div>
            </div>
        `;

        const text = [
            'New TalentCIO Demo Request',
            `Name: ${name}`,
            `Company: ${company}`,
            `Email: ${email}`,
            `Phone: ${phone || 'Not provided'}`,
            `Team Size: ${teamSize || 'Not specified'}`,
            `Interested Modules: ${modulesList}`,
            `Submitted At: ${submittedAt.toISOString()}`,
            '',
            'Message:',
            message || 'No message provided'
        ].join('\n');

        const sent = await sendEmail({
            to: DEMO_REQUEST_RECIPIENT,
            subject: `New Demo Request from ${name} (${company})`,
            html,
            text
        });

        if (!sent) {
            return res.status(500).json({ message: 'Failed to submit demo request' });
        }

        res.json({ message: 'Demo request received. We will contact you shortly!' });
    } catch (error) {
        console.error('Failed to submit demo request:', error);
        res.status(500).json({ message: 'Failed to submit demo request' });
    }
};

exports.getPublicJobs = async (req, res) => {
    try {
        const pageNumber = Math.max(parseInt(req.query.page, 10) || 1, 1);
        const limitNumber = Math.max(parseInt(req.query.limit, 10) || 12, 1);
        const query = buildPublicJobsQuery(req.query);

        const total = await HiringRequest.countDocuments(query);
        const jobs = await HiringRequest.find(query)
            .select('requestId roleDetails requirements hiringDetails client clientConfidential companyId createdAt publicJobTitle publicJobDescription')
            .populate('companyId', 'name settings.logo subdomain industry country')
            .sort({ createdAt: -1 })
            .skip((pageNumber - 1) * limitNumber)
            .limit(limitNumber)
            .lean();

        res.json({
            jobs: jobs.map(maskConfidentialClient),
            total,
            page: pageNumber,
            totalPages: Math.ceil(total / limitNumber)
        });
    } catch (error) {
        console.error('Failed to fetch public jobs:', error);
        res.status(500).json({ message: 'Failed to fetch jobs' });
    }
};

exports.getResourceGatewayJobs = async (req, res) => {
    try {
        const pageNumber = Math.max(parseInt(req.query.page, 10) || 1, 1);
        const limitNumber = Math.max(parseInt(req.query.limit, 10) || 12, 1);
        const query = {
            ...buildPublicJobsQuery(req.query),
            isResourceGatewayPublic: true
        };

        const allEligibleJobs = await HiringRequest.find(query)
            .select('requestId roleDetails requirements hiringDetails client clientConfidential companyId createdAt publicJobTitle publicJobDescription isResourceGatewayPublic')
            .populate('companyId', 'name settings.logo subdomain industry country settings.careers')
            .sort({ createdAt: -1 })
            .lean();

        const jobs = allEligibleJobs.filter((job) => isResourceGatewayEnabledForCompany(job.companyId));
        const total = jobs.length;
        const paginatedJobs = jobs
            .slice((pageNumber - 1) * limitNumber, pageNumber * limitNumber)
            .map(maskConfidentialClient);

        res.json({
            jobs: paginatedJobs,
            total,
            page: pageNumber,
            totalPages: Math.ceil(total / limitNumber)
        });
    } catch (error) {
        console.error('Failed to fetch Resource Gateway jobs:', error);
        res.status(500).json({ message: 'Failed to fetch Resource Gateway jobs' });
    }
};

exports.getPublicJobById = async (req, res) => {
    try {
        const { id } = req.params;

        if (!mongoose.isValidObjectId(id)) {
            return res.status(400).json({ message: 'Invalid job ID' });
        }

        const job = await HiringRequest.findOne({
            _id: id,
            isPublic: true,
            status: 'Approved'
        })
            .populate('companyId', 'name settings.logo subdomain industry country')
            .lean();

        if (!job) {
            return res.status(404).json({ message: 'Job not found or no longer available' });
        }

        res.json({ job: maskConfidentialClient(job) });
    } catch (error) {
        console.error('Failed to fetch public job:', error);
        res.status(500).json({ message: 'Failed to fetch job' });
    }
};

exports.getResourceGatewayJobById = async (req, res) => {
    try {
        const { id } = req.params;

        if (!mongoose.isValidObjectId(id)) {
            return res.status(400).json({ message: 'Invalid job ID' });
        }

        const job = await HiringRequest.findOne({
            _id: id,
            isPublic: true,
            isResourceGatewayPublic: true,
            status: 'Approved'
        })
            .populate('companyId', 'name settings.logo subdomain industry country settings.careers')
            .lean();

        if (!job || !isResourceGatewayEnabledForCompany(job.companyId)) {
            return res.status(404).json({ message: 'Job not found or no longer available on Resource Gateway' });
        }

        res.json({ job: maskConfidentialClient(job) });
    } catch (error) {
        console.error('Failed to fetch Resource Gateway job:', error);
        res.status(500).json({ message: 'Failed to fetch Resource Gateway job' });
    }
};

exports.applyToJob = async (req, res) => {
    try {
        const { id } = req.params;

        if (!mongoose.isValidObjectId(id)) {
            return res.status(400).json({ message: 'Invalid job ID' });
        }

        const job = await HiringRequest.findOne({
            _id: id,
            isPublic: true,
            status: 'Approved'
        }).select('companyId');

        if (!job) {
            return res.status(404).json({ message: 'This position is no longer accepting applications' });
        }

        const {
            candidateName,
            email,
            mobile,
            currentCTC,
            expectedCTC,
            noticePeriod,
            coverNote,
            useProfileResume,
            profileResumeUrl,
            profileResumePublicId
        } = req.body;

        if (!candidateName?.trim() || !email?.trim() || !mobile?.trim()) {
            return res.status(400).json({ message: 'Name, email, and mobile are required' });
        }

        let resumeUrl = '';
        let resumePublicId = '';

        if (useProfileResume === 'true') {
            if (!profileResumeUrl) {
                return res.status(400).json({ message: 'Profile resume URL is missing.' });
            }

            resumeUrl = profileResumeUrl;
            resumePublicId = profileResumePublicId || '';
        } else {
            if (!req.file?.path) {
                return res.status(400).json({ message: 'Resume is required' });
            }

            resumeUrl = req.file.path;
            resumePublicId = req.file.filename || req.file.path;
        }

        const normalizedEmail = req.applicant?.email || String(email).trim().toLowerCase();
        const existingApplication = await PublicApplication.exists({
            hiringRequestId: job._id,
            email: normalizedEmail
        });

        if (existingApplication) {
            return res.status(409).json({ message: 'You have already applied for this position.' });
        }

        let profileSnapshot = null;
        if (req.applicant?._id) {
            const applicantProfile = await Applicant.findById(req.applicant._id).lean();
            if (applicantProfile) {
                profileSnapshot = buildProfileSnapshot(applicantProfile);
            }
        }

        const application = new PublicApplication({
            hiringRequestId: job._id,
            companyId: job.companyId,
            applicantId: req.applicant?._id || undefined,
            candidateName: String(candidateName).trim(),
            email: normalizedEmail,
            mobile: String(mobile).trim(),
            currentCTC: currentCTC ? Number(currentCTC) : undefined,
            expectedCTC: expectedCTC ? Number(expectedCTC) : undefined,
            noticePeriod: noticePeriod ? Number(noticePeriod) : undefined,
            coverNote: coverNote?.trim() || '',
            resumeUrl,
            resumePublicId,
            source: 'Public Job Board',
            profileSnapshot: profileSnapshot || undefined
        });

        await application.save();

        res.json({ message: 'Application submitted successfully! The team will review your profile.' });
    } catch (error) {
        if (error?.code === 11000) {
            return res.status(409).json({ message: 'You have already applied for this position.' });
        }

        console.error('Failed to submit public application:', error);
        res.status(500).json({ message: 'Failed to submit application' });
    }
};

exports.applicantRegister = async (req, res) => {
    try {
        const { firstName, lastName, email, password, mobile } = req.body;

        if (!firstName?.trim() || !lastName?.trim() || !email?.trim() || !password) {
            return res.status(400).json({ message: 'First name, last name, email, and password are required.' });
        }

        if (password.length < 8) {
            return res.status(400).json({ message: 'Password must be at least 8 characters.' });
        }

        const normalizedEmail = email.trim().toLowerCase();
        const existingApplicant = await Applicant.findOne({ email: normalizedEmail }).lean();
        if (existingApplicant) {
            return res.status(409).json({ message: 'An account with this email already exists. Please login.' });
        }

        const otp = Math.floor(100000 + Math.random() * 900000).toString();
        const applicant = new Applicant({
            firstName: firstName.trim(),
            lastName: lastName.trim(),
            email: normalizedEmail,
            mobile: mobile?.trim() || '',
            password,
            isEmailVerified: false,
            emailOtp: otp,
            emailOtpExpires: Date.now() + 10 * 60 * 1000
        });

        await applicant.save();

        sendEmail({
            to: applicant.email,
            subject: 'Verify your TalentCIO account',
            html: `
                <div style="font-family: Arial, sans-serif; max-width: 600px; margin: auto; padding: 24px; border: 1px solid #e2e8f0; border-radius: 12px;">
                    <h2 style="color: #115cb9; margin-bottom: 8px;">Welcome to TalentCIO Jobs, ${applicant.firstName}!</h2>
                    <p style="color: #475569;">Use the code below to verify your email address. It expires in 10 minutes.</p>
                    <div style="text-align: center; margin: 32px 0;">
                        <span style="font-size: 36px; font-weight: bold; letter-spacing: 8px; color: #0f172a; background: #f1f5f9; padding: 12px 24px; border-radius: 8px; border: 1px solid #cbd5e1;">${otp}</span>
                    </div>
                    <p style="color: #94a3b8; font-size: 13px;">If you did not create this account, you can ignore this email.</p>
                    <hr style="border: none; border-top: 1px solid #e2e8f0; margin: 24px 0;">
                    <p style="text-align: center; color: #94a3b8; font-size: 12px;">&copy; 2026 TalentCIO. All rights reserved.</p>
                </div>
            `
        })
            .then((sent) => {
                if (!sent) {
                    console.error('[APPLICANT EMAIL] Verification OTP send failed: sendEmail returned false');
                }
            })
            .catch((error) => {
                console.error('[APPLICANT EMAIL] Verification OTP send failed:', error.message);
            });

        res.status(201).json({
            message: 'Account created. Please check your email for a 6-digit verification code.',
            email: applicant.email
        });
    } catch (error) {
        if (error?.code === 11000) {
            return res.status(409).json({ message: 'An account with this email already exists.' });
        }

        console.error('[APPLICANT REGISTER]', error);
        res.status(500).json({ message: 'Registration failed. Please try again.' });
    }
};

exports.applicantVerifyEmail = async (req, res) => {
    try {
        const { email, otp } = req.body;

        if (!email || !otp) {
            return res.status(400).json({ message: 'Email and OTP are required.' });
        }

        const applicant = await Applicant.findOne({ email: email.trim().toLowerCase() });
        if (!applicant) {
            return res.status(404).json({ message: 'Account not found.' });
        }

        if (applicant.isEmailVerified) {
            return res.status(200).json({ message: 'Email already verified. Please login.' });
        }

        if (!applicant.emailOtp || applicant.emailOtp !== otp.trim()) {
            return res.status(400).json({ message: 'Invalid OTP.' });
        }

        if (!applicant.emailOtpExpires || applicant.emailOtpExpires < Date.now()) {
            return res.status(400).json({ message: 'OTP has expired. Please request a new one.' });
        }

        applicant.isEmailVerified = true;
        applicant.emailOtp = null;
        applicant.emailOtpExpires = null;
        await applicant.save();

        const token = generateApplicantToken(applicant._id, applicant.tokenVersion);
        res.json({
            message: 'Email verified successfully!',
            token,
            applicant: {
                _id: applicant._id,
                firstName: applicant.firstName,
                lastName: applicant.lastName,
                email: applicant.email,
                mobile: applicant.mobile,
                isEmailVerified: applicant.isEmailVerified
            }
        });
    } catch (error) {
        console.error('[APPLICANT VERIFY EMAIL]', error);
        res.status(500).json({ message: 'Verification failed.' });
    }
};

exports.applicantResendVerification = async (req, res) => {
    try {
        const { email } = req.body;
        const applicant = await Applicant.findOne({ email: email?.trim().toLowerCase() });

        if (!applicant) {
            return res.status(404).json({ message: 'Account not found.' });
        }

        if (applicant.isEmailVerified) {
            return res.status(400).json({ message: 'Email is already verified.' });
        }

        const otp = Math.floor(100000 + Math.random() * 900000).toString();
        applicant.emailOtp = otp;
        applicant.emailOtpExpires = Date.now() + 10 * 60 * 1000;
        await applicant.save();

        sendEmail({
            to: applicant.email,
            subject: 'Your new TalentCIO verification code',
            html: `
                <div style="font-family: Arial, sans-serif; max-width: 600px; margin: auto; padding: 24px; border: 1px solid #e2e8f0; border-radius: 12px;">
                    <h2 style="color: #115cb9;">New Verification Code</h2>
                    <p style="color: #475569;">Hi ${applicant.firstName}, here is your new verification code:</p>
                    <div style="text-align: center; margin: 32px 0;">
                        <span style="font-size: 36px; font-weight: bold; letter-spacing: 8px; color: #0f172a; background: #f1f5f9; padding: 12px 24px; border-radius: 8px; border: 1px solid #cbd5e1;">${otp}</span>
                    </div>
                    <p style="color: #94a3b8; font-size: 13px;">Valid for 10 minutes.</p>
                </div>
            `
        })
            .then((sent) => {
                if (!sent) {
                    console.error('[APPLICANT EMAIL] Resend OTP failed: sendEmail returned false');
                }
            })
            .catch((error) => {
                console.error('[APPLICANT EMAIL] Resend OTP failed:', error.message);
            });

        res.json({ message: 'A new verification code has been sent to your email.' });
    } catch (error) {
        res.status(500).json({ message: 'Failed to resend verification.' });
    }
};

exports.applicantLogin = async (req, res) => {
    try {
        const { email, password } = req.body;

        if (!email || !password) {
            return res.status(400).json({ message: 'Email and password are required.' });
        }

        const applicant = await Applicant.findOne({ email: email.trim().toLowerCase() });
        if (applicant?.authProvider === 'google' && !applicant.password) {
            return res.status(400).json({
                message: 'This account uses Google sign-in. Continue with Google or reset your password.'
            });
        }

        if (!applicant || !(await applicant.matchPassword(password))) {
            return res.status(401).json({ message: 'Invalid email or password.' });
        }

        if (!applicant.isEmailVerified) {
            return res.status(403).json({
                message: 'Please verify your email before logging in.',
                needsVerification: true,
                email: applicant.email
            });
        }

        const token = generateApplicantToken(applicant._id, applicant.tokenVersion);
        res.json({
            token,
            applicant: buildApplicantAuthPayload(applicant)
        });
    } catch (error) {
        console.error('[APPLICANT LOGIN]', error);
        res.status(500).json({ message: 'Login failed.' });
    }
};

exports.applicantGoogleLogin = async (req, res) => {
    try {
        const googleProfile = await verifyGoogleCredential(req.body.credential);

        let applicant = await Applicant.findOne({
            $or: [
                { email: googleProfile.email },
                { googleId: googleProfile.googleId }
            ]
        });

        const resolvedName = splitFullName(googleProfile.fullName);
        const firstName = googleProfile.givenName || resolvedName.firstName;
        const lastName = googleProfile.familyName || resolvedName.lastName;
        let created = false;

        if (applicant && applicant.googleId && applicant.googleId !== googleProfile.googleId) {
            return res.status(409).json({
                message: 'A different Google account is already linked to this applicant profile.'
            });
        }

        if (!applicant) {
            applicant = new Applicant({
                firstName,
                lastName,
                email: googleProfile.email,
                authProvider: 'google',
                googleId: googleProfile.googleId,
                isEmailVerified: true,
                profilePhotoUrl: googleProfile.picture || undefined
            });
            created = true;
        } else {
            if (!applicant.firstName && firstName) {
                applicant.firstName = firstName;
            }

            if (!applicant.lastName && lastName) {
                applicant.lastName = lastName;
            }

            if (!applicant.googleId) {
                applicant.googleId = googleProfile.googleId;
            }

            if (!applicant.profilePhotoUrl && googleProfile.picture) {
                applicant.profilePhotoUrl = googleProfile.picture;
            }

            if (!applicant.isEmailVerified) {
                applicant.isEmailVerified = true;
            }

            if (!applicant.authProvider) {
                applicant.authProvider = 'local';
            }

            applicant.emailOtp = null;
            applicant.emailOtpExpires = null;
        }

        await applicant.save();

        const token = generateApplicantToken(applicant._id, applicant.tokenVersion);
        res.json({
            message: created ? 'Account created successfully with Google.' : 'Signed in with Google.',
            token,
            applicant: buildApplicantAuthPayload(applicant)
        });
    } catch (error) {
        if (axios.isAxiosError(error)) {
            console.error('[APPLICANT GOOGLE LOGIN] Google verification failed:', error.response?.data || error.message);
            return res.status(401).json({ message: 'Google sign-in could not be verified.' });
        }

        console.error('[APPLICANT GOOGLE LOGIN]', error);
        res.status(400).json({ message: error.message || 'Google sign-in failed.' });
    }
};

exports.applicantForgotPassword = async (req, res) => {
    try {
        const { email } = req.body;
        const applicant = await Applicant.findOne({ email: email?.trim().toLowerCase() });

        if (!applicant) {
            return res.json({ message: 'If an account with that email exists, a reset code has been sent.' });
        }

        const otp = Math.floor(100000 + Math.random() * 900000).toString();
        applicant.resetOtp = otp;
        applicant.resetOtpExpires = Date.now() + 10 * 60 * 1000;
        await applicant.save();

        sendEmail({
            to: applicant.email,
            subject: 'Reset your TalentCIO password',
            html: `
                <div style="font-family: Arial, sans-serif; max-width: 600px; margin: auto; padding: 24px; border: 1px solid #e2e8f0; border-radius: 12px;">
                    <h2 style="color: #115cb9;">Password Reset Request</h2>
                    <p style="color: #475569;">Hi ${applicant.firstName}, use this code to reset your password:</p>
                    <div style="text-align: center; margin: 32px 0;">
                        <span style="font-size: 36px; font-weight: bold; letter-spacing: 8px; color: #0f172a; background: #f1f5f9; padding: 12px 24px; border-radius: 8px; border: 1px solid #cbd5e1;">${otp}</span>
                    </div>
                    <p style="color: #94a3b8; font-size: 13px;">This code expires in 10 minutes. If you did not request a password reset, ignore this email.</p>
                </div>
            `
        })
            .then((sent) => {
                if (!sent) {
                    console.error('[APPLICANT EMAIL] Reset OTP failed: sendEmail returned false');
                }
            })
            .catch((error) => {
                console.error('[APPLICANT EMAIL] Reset OTP failed:', error.message);
            });

        res.json({ message: 'If an account with that email exists, a reset code has been sent.' });
    } catch (error) {
        res.status(500).json({ message: 'Failed to send reset email.' });
    }
};

exports.applicantResetPassword = async (req, res) => {
    try {
        const { email, otp, newPassword } = req.body;

        if (!email || !otp || !newPassword) {
            return res.status(400).json({ message: 'Email, OTP, and new password are required.' });
        }

        if (newPassword.length < 8) {
            return res.status(400).json({ message: 'Password must be at least 8 characters.' });
        }

        const applicant = await Applicant.findOne({ email: email.trim().toLowerCase() });
        if (!applicant) {
            return res.status(404).json({ message: 'Account not found.' });
        }

        if (!applicant.resetOtp || applicant.resetOtp !== otp.trim()) {
            return res.status(400).json({ message: 'Invalid or expired reset code.' });
        }

        if (!applicant.resetOtpExpires || applicant.resetOtpExpires < Date.now()) {
            return res.status(400).json({ message: 'Reset code has expired. Request a new one.' });
        }

        applicant.password = newPassword;
        applicant.resetOtp = null;
        applicant.resetOtpExpires = null;
        applicant.tokenVersion = (applicant.tokenVersion || 0) + 1;
        await applicant.save();

        res.json({ message: 'Password reset successfully. Please login with your new password.' });
    } catch (error) {
        res.status(500).json({ message: 'Password reset failed.' });
    }
};

exports.applicantGetMe = async (req, res) => {
    res.json({ applicant: req.applicant });
};

exports.applicantGetProfile = async (req, res) => {
    try {
        const profileData = await getApplicantWithCompletion(req.applicant._id);
        if (!profileData) {
            return res.status(404).json({ message: 'Profile not found' });
        }

        res.json(profileData);
    } catch (error) {
        console.error('[APPLICANT PROFILE]', error);
        res.status(500).json({ message: 'Failed to fetch profile' });
    }
};

exports.applicantUpdateBasic = async (req, res) => {
    try {
        const update = {};
        const simpleFields = [
            'firstName',
            'lastName',
            'mobile',
            'headline',
            'currentCity',
            'currentState',
            'currentCountry',
            'jobSearchStatus'
        ];

        simpleFields.forEach((field) => {
            if (req.body[field] !== undefined) {
                update[field] = req.body[field];
            }
        });

        if (req.body.willingToRelocate !== undefined) {
            update.willingToRelocate = Boolean(req.body.willingToRelocate);
        }
        if (req.body.preferredLocations !== undefined) {
            update.preferredLocations = normalizeStringList(req.body.preferredLocations, 3);
        }
        if (req.body.preferredJobTypes !== undefined) {
            update.preferredJobTypes = normalizeStringList(req.body.preferredJobTypes);
        }
        if (req.body.preferredDepartments !== undefined) {
            update.preferredDepartments = normalizeStringList(req.body.preferredDepartments);
        }
        if (req.body.totalExperienceYears !== undefined) {
            update.totalExperienceYears = parseOptionalNumber(req.body.totalExperienceYears) ?? 0;
        }

        await Applicant.findByIdAndUpdate(req.applicant._id, { $set: update }, { runValidators: true });
        const profileData = await getApplicantWithCompletion(req.applicant._id);
        res.json({ ...profileData, message: 'Basic info updated.' });
    } catch (error) {
        console.error('[APPLICANT BASIC UPDATE]', error);
        res.status(500).json({ message: 'Update failed.' });
    }
};

exports.applicantUpdateSummary = async (req, res) => {
    try {
        await Applicant.findByIdAndUpdate(
            req.applicant._id,
            { $set: { summary: req.body.summary || '' } },
            { runValidators: true }
        );
        const profileData = await getApplicantWithCompletion(req.applicant._id);
        res.json({ ...profileData, message: 'Summary updated.' });
    } catch (error) {
        console.error('[APPLICANT SUMMARY UPDATE]', error);
        res.status(500).json({ message: 'Update failed.' });
    }
};

exports.applicantUpdateCompensation = async (req, res) => {
    try {
        const update = {};
        if (req.body.currentCTC !== undefined) update.currentCTC = parseOptionalNumber(req.body.currentCTC);
        if (req.body.expectedCTC !== undefined) update.expectedCTC = parseOptionalNumber(req.body.expectedCTC);
        if (req.body.noticePeriod !== undefined) update.noticePeriod = parseOptionalNumber(req.body.noticePeriod);

        await Applicant.findByIdAndUpdate(req.applicant._id, { $set: update }, { runValidators: true });
        const profileData = await getApplicantWithCompletion(req.applicant._id);
        res.json({ ...profileData, message: 'Compensation updated.' });
    } catch (error) {
        console.error('[APPLICANT COMPENSATION UPDATE]', error);
        res.status(500).json({ message: 'Update failed.' });
    }
};

exports.applicantUpdateLinks = async (req, res) => {
    try {
        const update = {};
        ['linkedinUrl', 'githubUrl', 'portfolioUrl'].forEach((field) => {
            if (req.body[field] !== undefined) {
                update[field] = req.body[field];
            }
        });
        if (req.body.otherLinks !== undefined) {
            update.otherLinks = normalizeOtherLinks(req.body.otherLinks);
        }

        await Applicant.findByIdAndUpdate(req.applicant._id, { $set: update }, { runValidators: true });
        const profileData = await getApplicantWithCompletion(req.applicant._id);
        res.json({ ...profileData, message: 'Links updated.' });
    } catch (error) {
        console.error('[APPLICANT LINKS UPDATE]', error);
        res.status(500).json({ message: 'Update failed.' });
    }
};

exports.applicantUpdateSkills = async (req, res) => {
    try {
        if (!Array.isArray(req.body.skills)) {
            return res.status(400).json({ message: 'Skills must be an array.' });
        }

        await Applicant.findByIdAndUpdate(
            req.applicant._id,
            { $set: { skills: normalizeSkills(req.body.skills) } },
            { runValidators: true }
        );
        const profileData = await getApplicantWithCompletion(req.applicant._id);
        res.json({ ...profileData, message: 'Skills updated.' });
    } catch (error) {
        console.error('[APPLICANT SKILLS UPDATE]', error);
        res.status(500).json({ message: 'Update failed.' });
    }
};

exports.applicantUpdateLanguages = async (req, res) => {
    try {
        await Applicant.findByIdAndUpdate(
            req.applicant._id,
            { $set: { languages: normalizeLanguages(req.body.languages) } },
            { runValidators: true }
        );
        const profileData = await getApplicantWithCompletion(req.applicant._id);
        res.json({ ...profileData, message: 'Languages updated.' });
    } catch (error) {
        console.error('[APPLICANT LANGUAGES UPDATE]', error);
        res.status(500).json({ message: 'Update failed.' });
    }
};

exports.applicantAddExperience = async (req, res) => {
    try {
        const experienceEntry = {
            jobTitle: req.body.jobTitle,
            companyName: req.body.companyName,
            employmentType: req.body.employmentType || 'Full-time',
            location: req.body.location || '',
            locationType: req.body.locationType || 'Onsite',
            startMonth: parseOptionalNumber(req.body.startMonth),
            startYear: parseOptionalNumber(req.body.startYear),
            endMonth: req.body.isCurrent ? undefined : parseOptionalNumber(req.body.endMonth),
            endYear: req.body.isCurrent ? undefined : parseOptionalNumber(req.body.endYear),
            isCurrent: Boolean(req.body.isCurrent),
            description: req.body.description || '',
            skills: normalizeStringList(req.body.skills)
        };

        if (!experienceEntry.jobTitle || !experienceEntry.companyName || !experienceEntry.startYear) {
            return res.status(400).json({ message: 'Job title, company, and start year are required.' });
        }

        const applicant = await Applicant.findById(req.applicant._id);
        applicant.workExperience.push(experienceEntry);
        applicant.totalExperienceYears = calculateTotalExperienceYears(applicant.workExperience);
        await applicant.save();

        const profileData = await getApplicantWithCompletion(req.applicant._id);
        res.json({ ...profileData, message: 'Experience added.' });
    } catch (error) {
        console.error('[APPLICANT EXPERIENCE ADD]', error);
        res.status(500).json({ message: 'Failed to add experience.' });
    }
};

exports.applicantUpdateExperience = async (req, res) => {
    try {
        const applicant = await Applicant.findById(req.applicant._id);
        const experienceEntry = applicant?.workExperience.id(req.params.expId);

        if (!applicant || !experienceEntry) {
            return res.status(404).json({ message: 'Experience entry not found.' });
        }

        const fields = ['jobTitle', 'companyName', 'employmentType', 'location', 'locationType', 'description'];
        fields.forEach((field) => {
            if (req.body[field] !== undefined) {
                experienceEntry[field] = req.body[field];
            }
        });

        ['startMonth', 'startYear', 'endMonth', 'endYear'].forEach((field) => {
            if (req.body[field] !== undefined) {
                experienceEntry[field] = parseOptionalNumber(req.body[field]);
            }
        });

        if (req.body.isCurrent !== undefined) {
            experienceEntry.isCurrent = Boolean(req.body.isCurrent);
            if (experienceEntry.isCurrent) {
                experienceEntry.endMonth = undefined;
                experienceEntry.endYear = undefined;
            }
        }
        if (req.body.skills !== undefined) {
            experienceEntry.skills = normalizeStringList(req.body.skills);
        }

        applicant.totalExperienceYears = calculateTotalExperienceYears(applicant.workExperience);
        await applicant.save();

        const profileData = await getApplicantWithCompletion(req.applicant._id);
        res.json({ ...profileData, message: 'Experience updated.' });
    } catch (error) {
        console.error('[APPLICANT EXPERIENCE UPDATE]', error);
        res.status(500).json({ message: 'Failed to update experience.' });
    }
};

exports.applicantDeleteExperience = async (req, res) => {
    try {
        const applicant = await Applicant.findById(req.applicant._id);
        if (!applicant) {
            return res.status(404).json({ message: 'Profile not found.' });
        }

        const experienceEntry = applicant.workExperience.id(req.params.expId);
        if (!experienceEntry) {
            return res.status(404).json({ message: 'Experience entry not found.' });
        }

        experienceEntry.deleteOne();
        applicant.totalExperienceYears = calculateTotalExperienceYears(applicant.workExperience);
        await applicant.save();

        const profileData = await getApplicantWithCompletion(req.applicant._id);
        res.json({ ...profileData, message: 'Experience deleted.' });
    } catch (error) {
        console.error('[APPLICANT EXPERIENCE DELETE]', error);
        res.status(500).json({ message: 'Failed to delete experience.' });
    }
};

exports.applicantAddEducation = async (req, res) => {
    try {
        if (!req.body.degree || !req.body.institution) {
            return res.status(400).json({ message: 'Degree and institution are required.' });
        }

        await Applicant.findByIdAndUpdate(
            req.applicant._id,
            {
                $push: {
                    education: {
                        degree: req.body.degree,
                        fieldOfStudy: req.body.fieldOfStudy || '',
                        institution: req.body.institution,
                        grade: req.body.grade || '',
                        startYear: parseOptionalNumber(req.body.startYear),
                        endYear: req.body.isCurrent ? undefined : parseOptionalNumber(req.body.endYear),
                        isCurrent: Boolean(req.body.isCurrent),
                        description: req.body.description || ''
                    }
                }
            },
            { runValidators: true }
        );

        const profileData = await getApplicantWithCompletion(req.applicant._id);
        res.json({ ...profileData, message: 'Education added.' });
    } catch (error) {
        console.error('[APPLICANT EDUCATION ADD]', error);
        res.status(500).json({ message: 'Failed to add education.' });
    }
};

exports.applicantUpdateEducation = async (req, res) => {
    try {
        const applicant = await Applicant.findById(req.applicant._id);
        const educationEntry = applicant?.education.id(req.params.eduId);

        if (!applicant || !educationEntry) {
            return res.status(404).json({ message: 'Education entry not found.' });
        }

        ['degree', 'fieldOfStudy', 'institution', 'grade', 'description'].forEach((field) => {
            if (req.body[field] !== undefined) {
                educationEntry[field] = req.body[field];
            }
        });

        ['startYear', 'endYear'].forEach((field) => {
            if (req.body[field] !== undefined) {
                educationEntry[field] = parseOptionalNumber(req.body[field]);
            }
        });

        if (req.body.isCurrent !== undefined) {
            educationEntry.isCurrent = Boolean(req.body.isCurrent);
            if (educationEntry.isCurrent) {
                educationEntry.endYear = undefined;
            }
        }

        await applicant.save();
        const profileData = await getApplicantWithCompletion(req.applicant._id);
        res.json({ ...profileData, message: 'Education updated.' });
    } catch (error) {
        console.error('[APPLICANT EDUCATION UPDATE]', error);
        res.status(500).json({ message: 'Failed to update education.' });
    }
};

exports.applicantDeleteEducation = async (req, res) => {
    try {
        const applicant = await Applicant.findById(req.applicant._id);
        const educationEntry = applicant?.education.id(req.params.eduId);

        if (!applicant || !educationEntry) {
            return res.status(404).json({ message: 'Education entry not found.' });
        }

        educationEntry.deleteOne();
        await applicant.save();

        const profileData = await getApplicantWithCompletion(req.applicant._id);
        res.json({ ...profileData, message: 'Education deleted.' });
    } catch (error) {
        console.error('[APPLICANT EDUCATION DELETE]', error);
        res.status(500).json({ message: 'Failed to delete education.' });
    }
};

exports.applicantAddCertification = async (req, res) => {
    try {
        if (!req.body.name) {
            return res.status(400).json({ message: 'Certification name is required.' });
        }

        await Applicant.findByIdAndUpdate(
            req.applicant._id,
            {
                $push: {
                    certifications: {
                        name: req.body.name,
                        issuingOrganization: req.body.issuingOrganization || '',
                        issueMonth: parseOptionalNumber(req.body.issueMonth),
                        issueYear: parseOptionalNumber(req.body.issueYear),
                        expiryMonth: req.body.doesNotExpire ? undefined : parseOptionalNumber(req.body.expiryMonth),
                        expiryYear: req.body.doesNotExpire ? undefined : parseOptionalNumber(req.body.expiryYear),
                        doesNotExpire: Boolean(req.body.doesNotExpire),
                        credentialId: req.body.credentialId || '',
                        credentialUrl: req.body.credentialUrl || ''
                    }
                }
            },
            { runValidators: true }
        );

        const profileData = await getApplicantWithCompletion(req.applicant._id);
        res.json({ ...profileData, message: 'Certification added.' });
    } catch (error) {
        console.error('[APPLICANT CERTIFICATION ADD]', error);
        res.status(500).json({ message: 'Failed to add certification.' });
    }
};

exports.applicantUpdateCertification = async (req, res) => {
    try {
        const applicant = await Applicant.findById(req.applicant._id);
        const certificationEntry = applicant?.certifications.id(req.params.certId);

        if (!applicant || !certificationEntry) {
            return res.status(404).json({ message: 'Certification entry not found.' });
        }

        ['name', 'issuingOrganization', 'credentialId', 'credentialUrl'].forEach((field) => {
            if (req.body[field] !== undefined) {
                certificationEntry[field] = req.body[field];
            }
        });

        ['issueMonth', 'issueYear', 'expiryMonth', 'expiryYear'].forEach((field) => {
            if (req.body[field] !== undefined) {
                certificationEntry[field] = parseOptionalNumber(req.body[field]);
            }
        });

        if (req.body.doesNotExpire !== undefined) {
            certificationEntry.doesNotExpire = Boolean(req.body.doesNotExpire);
            if (certificationEntry.doesNotExpire) {
                certificationEntry.expiryMonth = undefined;
                certificationEntry.expiryYear = undefined;
            }
        }

        await applicant.save();
        const profileData = await getApplicantWithCompletion(req.applicant._id);
        res.json({ ...profileData, message: 'Certification updated.' });
    } catch (error) {
        console.error('[APPLICANT CERTIFICATION UPDATE]', error);
        res.status(500).json({ message: 'Failed to update certification.' });
    }
};

exports.applicantDeleteCertification = async (req, res) => {
    try {
        const applicant = await Applicant.findById(req.applicant._id);
        const certificationEntry = applicant?.certifications.id(req.params.certId);

        if (!applicant || !certificationEntry) {
            return res.status(404).json({ message: 'Certification entry not found.' });
        }

        certificationEntry.deleteOne();
        await applicant.save();

        const profileData = await getApplicantWithCompletion(req.applicant._id);
        res.json({ ...profileData, message: 'Certification deleted.' });
    } catch (error) {
        console.error('[APPLICANT CERTIFICATION DELETE]', error);
        res.status(500).json({ message: 'Failed to delete certification.' });
    }
};

exports.applicantUploadResume = async (req, res) => {
    try {
        if (!req.file?.path) {
            return res.status(400).json({ message: 'No file uploaded.' });
        }

        await Applicant.findByIdAndUpdate(
            req.applicant._id,
            {
                $set: {
                    resumeUrl: req.file.path,
                    resumePublicId: req.file.filename || req.file.path,
                    resumeFileName: req.file.originalname || 'resume',
                    resumeUpdatedAt: new Date()
                }
            }
        );

        const profileData = await getApplicantWithCompletion(req.applicant._id);
        res.json({ ...profileData, message: 'Resume uploaded successfully.' });
    } catch (error) {
        console.error('[APPLICANT RESUME UPLOAD]', error);
        res.status(500).json({ message: 'Failed to upload resume.' });
    }
};

exports.applicantUploadPhoto = async (req, res) => {
    try {
        if (!req.file?.path) {
            return res.status(400).json({ message: 'No file uploaded.' });
        }

        await Applicant.findByIdAndUpdate(
            req.applicant._id,
            {
                $set: {
                    profilePhotoUrl: req.file.path,
                    profilePhotoPublicId: req.file.filename || req.file.path
                }
            }
        );

        const profileData = await getApplicantWithCompletion(req.applicant._id);
        res.json({ ...profileData, message: 'Profile photo updated.' });
    } catch (error) {
        console.error('[APPLICANT PHOTO UPLOAD]', error);
        res.status(500).json({ message: 'Failed to upload photo.' });
    }
};

exports.applicantGetMyApplications = async (req, res) => {
    try {
        const applications = await PublicApplication.find({ email: req.applicant.email })
            .sort({ createdAt: -1 })
            .populate({
                path: 'hiringRequestId',
                select: 'roleDetails requirements hiringDetails client companyId requestId isPublic status',
                populate: {
                    path: 'companyId',
                    select: 'name settings.logo subdomain'
                }
            });

        res.json({ applications });
    } catch (error) {
        console.error('[APPLICANT MY APPLICATIONS]', error);
        res.status(500).json({ message: 'Failed to fetch your applications.' });
    }
};

exports.companyLogin = async (req, res) => {
    try {
        const { companyIdentifier, email, password } = req.body;

        if (!companyIdentifier?.trim() || !email?.trim() || !password) {
            return res.status(400).json({
                message: 'Company name, email, and password are required.'
            });
        }

        const normalizedIdentifier = companyIdentifier.trim();
        const normalizedEmail = email.trim().toLowerCase();

        let company = await Company.findOne({
            subdomain: normalizedIdentifier.toLowerCase()
        }).lean();

        if (!company) {
            company = await Company.findOne({
                name: {
                    $regex: new RegExp(`^${escapeRegex(normalizedIdentifier)}$`, 'i')
                }
            }).lean();
        }

        if (!company?.subdomain) {
            return res.status(401).json({ message: 'Invalid company, email, or password.' });
        }

        const user = await User.findOne({
            companyId: company._id,
            email: normalizedEmail,
            isActive: { $ne: false }
        });

        if (!user || !(await user.matchPassword(password))) {
            return res.status(401).json({ message: 'Invalid company, email, or password.' });
        }

        if (user.isPasswordResetRequired) {
            await issueFirstLoginOtp(user);
            return res.json({
                subdomain: company.subdomain,
                companyName: company.name,
                email: user.email,
                passwordResetRequired: true,
                message: 'Password reset required on first login. An OTP has been sent to your email.'
            });
        }

        const handoff = await HandoffToken.create({
            userId: user._id,
            companyId: company._id,
            subdomain: company.subdomain
        });

        res.json({
            subdomain: company.subdomain,
            handoffToken: handoff.token,
            companyName: company.name
        });
    } catch (error) {
        console.error('[COMPANY LOGIN]', error);
        res.status(500).json({ message: 'Login failed. Please try again.' });
    }
};

exports.exchangeHandoffToken = async (req, res) => {
    try {
        const { token, subdomain } = req.body;

        if (!token || !subdomain) {
            return res.status(400).json({ message: 'Token and subdomain are required.' });
        }

        const normalizedSubdomain = String(subdomain).trim().toLowerCase();
        const now = new Date();

        const handoff = await HandoffToken.findOneAndUpdate(
            {
                token,
                used: false,
                subdomain: normalizedSubdomain,
                expiresAt: { $gte: now }
            },
            { $set: { used: true } },
            { new: true }
        );

        if (!handoff) {
            const existingToken = await HandoffToken.findOne({ token }).lean();

            if (!existingToken || existingToken.expiresAt < now || existingToken.used) {
                return res.status(401).json({
                    message: 'This login link has already been used or has expired. Please login again.',
                    expired: true
                });
            }

            return res.status(401).json({ message: 'Invalid login token.' });
        }

        const user = await User.findById(handoff.userId)
            .select('_id email firstName lastName roles companyId tokenVersion isActive isPasswordResetRequired');

        if (!user || user.isActive === false) {
            return res.status(401).json({ message: 'Account not found or deactivated.' });
        }

        if (user.isPasswordResetRequired) {
            await issueFirstLoginOtp(user);
            return res.status(403).json({
                message: 'Password reset required on first login. An OTP has been sent to your email.',
                passwordResetRequired: true,
                email: user.email,
                subdomain: normalizedSubdomain
            });
        }

        const jwtToken = jwt.sign(
            { id: user._id, tokenVersion: user.tokenVersion || 0 },
            process.env.JWT_SECRET,
            { expiresIn: process.env.JWT_EXPIRE || '7d' }
        );

        res.json({
            token: jwtToken,
            user: {
                _id: user._id,
                email: user.email,
                firstName: user.firstName,
                lastName: user.lastName,
                roles: user.roles,
                companyId: user.companyId
            }
        });
    } catch (error) {
        console.error('[HANDOFF EXCHANGE]', error);
        res.status(500).json({ message: 'Login exchange failed.' });
    }
};
