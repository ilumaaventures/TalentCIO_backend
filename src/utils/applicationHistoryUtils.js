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
 * Checks if an application with the same email OR phone number exists within the last 3 months.
 */
const check3MonthApplicationLock = async (email, mobile) => {
    const PublicApplication = mongoose.model('PublicApplication');

    const normEmail = normalizeEmail(email);
    const rawMobile = normalizeMobile(mobile);
    const mobileDigits = getMobileDigits(rawMobile);

    const threeMonthsAgo = new Date();
    threeMonthsAgo.setMonth(threeMonthsAgo.getMonth() - 3);

    const conditions = [];

    if (normEmail) {
        conditions.push({ email: normEmail });
    }

    if (rawMobile) {
        conditions.push({ mobile: rawMobile });
    }

    if (mobileDigits.length >= 7) {
        // Match trailing 10 digits in case of country code variations
        const last10Digits = mobileDigits.slice(-10);
        conditions.push({ mobile: new RegExp(`${escapeRegex(last10Digits)}$`) });
    }

    if (conditions.length === 0) {
        return { isLocked: false, existingApp: null };
    }

    const existingApp = await PublicApplication.findOne({
        $or: conditions,
        createdAt: { $gte: threeMonthsAgo }
    }).sort({ createdAt: -1 }).lean();

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
