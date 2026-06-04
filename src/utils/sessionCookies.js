const MAIN_SESSION_COOKIE_NAME = 'talentcio_session';

const parseCookies = (cookieHeader = '') => (
    String(cookieHeader || '')
        .split(';')
        .map((entry) => entry.trim())
        .filter(Boolean)
        .reduce((cookies, entry) => {
            const separatorIndex = entry.indexOf('=');
            if (separatorIndex === -1) {
                return cookies;
            }

            const key = entry.slice(0, separatorIndex).trim();
            const value = entry.slice(separatorIndex + 1).trim();
            cookies[key] = decodeURIComponent(value);
            return cookies;
        }, {})
);

const getCookieValue = (req, cookieName) => {
    const cookies = parseCookies(req?.headers?.cookie || '');
    return cookies[cookieName] || '';
};

const getTokenFromRequest = (req, cookieName = MAIN_SESSION_COOKIE_NAME) => {
    if (req?.headers?.authorization?.startsWith('Bearer ')) {
        return req.headers.authorization.split(' ')[1];
    }

    return getCookieValue(req, cookieName);
};

const isSecureRequest = (req) => {
    const forwardedProto = String(req?.headers?.['x-forwarded-proto'] || '').split(',')[0].trim().toLowerCase();
    if (forwardedProto === 'https') {
        return true;
    }

    if (req?.secure) {
        return true;
    }

    const origin = String(req?.headers?.origin || '');
    return origin.startsWith('https://');
};

const getCookieOptions = (req, maxAgeMs = null) => {
    const secure = isSecureRequest(req);
    const options = {
        httpOnly: true,
        secure,
        sameSite: secure ? 'none' : 'lax',
        path: '/',
    };

    if (typeof maxAgeMs === 'number') {
        options.maxAge = maxAgeMs;
    }

    return options;
};

const setSessionCookie = (res, req, token, {
    cookieName = MAIN_SESSION_COOKIE_NAME,
    maxAgeMs = 7 * 24 * 60 * 60 * 1000,
} = {}) => {
    res.cookie(cookieName, token, getCookieOptions(req, maxAgeMs));
};

const clearSessionCookie = (res, req, cookieName = MAIN_SESSION_COOKIE_NAME) => {
    res.clearCookie(cookieName, getCookieOptions(req));
};

module.exports = {
    MAIN_SESSION_COOKIE_NAME,
    clearSessionCookie,
    getCookieValue,
    getCookieOptions,
    getTokenFromRequest,
    setSessionCookie,
};
