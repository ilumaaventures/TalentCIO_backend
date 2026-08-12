const mongoose = require('mongoose');

const escapeRegex = (value = '') => String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Normalizes email address
 */
const normalizeEmail = (email = '') => String(email || '').trim().toLowerCase();

/**
 * Normalizes mobile number (removes whitespace/dashes)
 */
const normalizeMobile = (mobile = '') => String(mobile || '').trim();

/**
 * Extracts digit-only string from mobile number
 */
const getMobileDigits = (mobile = '') => String(mobile || '').replace(/\D/g, '');

/**
 * Checks if an application by the same applicant exists within the last 3 months.
 * Uses applicantId (logged-in user) first, falls back to email match.
 * If generalOnly=true, only checks general applications (no hiringRequestId).
 * If the record is deleted from the DB, the lock is immediately gone.
 */
const check3MonthApplicationLock = async (email, mobile, applicantId, generalOnly = false) => {
    const PublicApplication = mongoose.model('PublicApplication');

    const threeMonthsAgo = new Date();
    threeMonthsAgo.setMonth(threeMonthsAgo.getMonth() - 3);

    const query = { createdAt: { $gte: threeMonthsAgo } };

    // Prefer applicantId match (most reliable for logged-in users)
    if (applicantId) {
        query.applicantId = applicantId;
    } else {
        const normEmail = normalizeEmail(email);
        if (!normEmail) {
            return { isLocked: false, existingApp: null };
        }
        query.email = normEmail;
    }

    // Only check general applications (unlisted positions), not job-specific ones
    if (generalOnly) {
        query.hiringRequestId = { $exists: false };
    }

    const existingApp = await PublicApplication.findOne(query)
        .sort({ createdAt: -1 })
        .lean();

    if (existingApp) {
        return { isLocked: true, existingApp };
    }

    return { isLocked: false, existingApp: null };
};

/**
 * Attaches last application data (prior submission) for each application in the list.
 */
const attachLastApplicationData = async (apps) => {
    if (!apps) return apps;

    const PublicApplication = mongoose.model('PublicApplication');
    const isArray = Array.isArray(apps);
    const appList = isArray ? apps : [apps];

    if (appList.length === 0) return isArray ? [] : null;

    const emails = Array.from(new Set(appList.map(a => normalizeEmail(a?.email)).filter(Boolean)));
    const mobiles = Array.from(new Set(appList.map(a => normalizeMobile(a?.mobile)).filter(Boolean)));

    const mobileDigitsList = Array.from(new Set(appList.map(a => getMobileDigits(a?.mobile)).filter(d => d.length >= 7)));

    const orConditions = [];
    if (emails.length > 0) {
        orConditions.push({ email: { $in: emails } });
    }
    if (mobiles.length > 0) {
        orConditions.push({ mobile: { $in: mobiles } });
    }
    for (const digits of mobileDigitsList) {
        const last10 = digits.slice(-10);
        orConditions.push({ mobile: new RegExp(`${escapeRegex(last10)}$`) });
    }

    if (orConditions.length === 0) {
        return apps;
    }

    const allRelatedApps = await PublicApplication.find({
        $or: orConditions
    })
    .sort({ createdAt: -1 })
    .lean();

    const processedApps = appList.map(app => {
        const appObj = typeof app.toObject === 'function' ? app.toObject() : { ...app };
        const appEmail = normalizeEmail(appObj.email);
        const appMobile = normalizeMobile(appObj.mobile);
        const appDigits = getMobileDigits(appMobile);
        const appCreatedAt = new Date(appObj.createdAt || Date.now()).getTime();

        const prevApp = allRelatedApps.find(other => {
            if (String(other._id) === String(appObj._id)) return false;
            const otherCreatedAt = new Date(other.createdAt).getTime();
            if (otherCreatedAt >= appCreatedAt) return false;

            const otherEmail = normalizeEmail(other.email);
            const otherMobile = normalizeMobile(other.mobile);
            const otherDigits = getMobileDigits(otherMobile);

            const emailMatch = appEmail && otherEmail && appEmail === otherEmail;
            const mobileMatch = appMobile && otherMobile && appMobile === otherMobile;
            const digitsMatch = appDigits.length >= 7 && otherDigits.length >= 7 && appDigits.slice(-10) === otherDigits.slice(-10);

            return emailMatch || mobileMatch || digitsMatch;
        });

        if (prevApp) {
            appObj.lastApplicationData = {
                _id: prevApp._id,
                desiredPosition: prevApp.desiredPosition,
                candidateName: prevApp.candidateName,
                email: prevApp.email,
                mobile: prevApp.mobile,
                currentCompany: prevApp.currentCompany,
                totalExperienceYears: prevApp.totalExperienceYears,
                currentCTC: prevApp.currentCTC,
                expectedCTC: prevApp.expectedCTC,
                noticePeriod: prevApp.noticePeriod,
                coverNote: prevApp.coverNote,
                resumeUrl: prevApp.resumeUrl,
                source: prevApp.source,
                reviewStatus: prevApp.reviewStatus,
                submittedAt: prevApp.createdAt,
                profileSnapshot: prevApp.profileSnapshot
            };
        } else {
            appObj.lastApplicationData = null;
        }

        return appObj;
    });

    return isArray ? processedApps : processedApps[0];
};

module.exports = {
    check3MonthApplicationLock,
    attachLastApplicationData,
    normalizeEmail,
    normalizeMobile,
    getMobileDigits
};
