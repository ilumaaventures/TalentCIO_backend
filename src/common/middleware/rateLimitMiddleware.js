const rateLimit = require('express-rate-limit');

/**
 * Check if the request is originating from localhost or running in development
 */
const isLocalhost = (req) => {
    // Automatically skip in non-production environments
    if (process.env.NODE_ENV !== 'production' || process.env.DISABLE_RATE_LIMIT === 'true') {
        return true;
    }

    // Check for loopback IP & localhost headers
    const ip = req.ip || req.socket?.remoteAddress || req.connection?.remoteAddress || '';
    const isLoopbackIp = ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';

    const host = (req.headers.host || req.hostname || '').toLowerCase();
    const origin = (req.headers.origin || req.headers.referer || '').toLowerCase();
    const isLocalHostHeader = host.includes('localhost') || host.includes('127.0.0.1') ||
                              origin.includes('localhost') || origin.includes('127.0.0.1');

    return isLoopbackIp && isLocalHostHeader;
};

/**
 * Global rate limiter: Applies to all API routes
 * Limits each IP to 5000 requests per 15 minutes (bypassed on localhost)
 */
const globalLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 5000,
    skip: isLocalhost,
    message: {
        message: 'Too many requests from this IP, please try again after 15 minutes'
    },
    standardHeaders: true, // Return rate limit info in the `RateLimit-*` headers
    legacyHeaders: false, // Disable the `X-RateLimit-*` headers
});

/**
 * Strict rate limiter: Specifically for Auth routes (Login, Register, OTP)
 * Limits each IP to 10 attempts per 15 minutes (bypassed on localhost)
 */
const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 10,
    skip: isLocalhost,
    message: {
        message: 'Too many login attempts, please try again after 15 minutes'
    },
    standardHeaders: true,
    legacyHeaders: false,
});

module.exports = {
    globalLimiter,
    authLimiter,
    isLocalhost
};
