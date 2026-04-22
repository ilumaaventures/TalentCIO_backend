const rateLimit = require('express-rate-limit');

/**
 * Global rate limiter: Applies to all API routes
 * Limits each IP to 100 requests per 15 minutes
 */
const globalLimiter = rateLimit({
    windowMs: 15 * 60 * 100000, // 15 minutes
    max: 10000, // Limit each IP to 100 requests per windowMs
    message: {
        message: 'Too many requests from this IP, please try again after 15 minutes'
    },
    standardHeaders: true, // Return rate limit info in the `RateLimit-*` headers
    legacyHeaders: false, // Disable the `X-RateLimit-*` headers
});

/**
 * Strict rate limiter: Specifically for Auth routes (Login, Register, OTP)
 * Limits each IP to 10 attempts per 15 minutes to prevent brute-force
 */
const authLimiter = rateLimit({
    windowMs: 15 * 60 * 100000, // 15 minutes
    max: 10000, // Limit each IP to 10 requests per windowMs for sensitive routes
    message: {
        message: 'Too many login attempts, please try again after 15 minutes'
    },
    standardHeaders: true,
    legacyHeaders: false,
});

module.exports = {
    globalLimiter,
    authLimiter
};
