const { AsyncLocalStorage } = require('async_hooks');
const fs = require('fs');
const path = require('path');
const util = require('util');

const contextStore = new AsyncLocalStorage();

// Ensure logs directory exists
const LOGS_DIR = path.join(__dirname, '..', '..', 'logs');
try {
    if (!fs.existsSync(LOGS_DIR)) {
        fs.mkdirSync(LOGS_DIR, { recursive: true });
    }
} catch (err) {
    process.stderr.write(`[LOGGER WARNING] Log directory creation failed (probably read-only filesystem): ${err.message}\n`);
}

// Log files paths
const COMBINED_LOG_PATH = path.join(LOGS_DIR, 'combined.log');
const ERROR_LOG_PATH = path.join(LOGS_DIR, 'error.log');

const MAX_LOG_SIZE_BYTES = 20 * 1024 * 1024; // 20 MB

const appendToFile = (filePath, content) => {
    fs.appendFile(filePath, content + '\n', (err) => {
        if (err) {
            // Silently absorb write failures to avoid infinite loop crashes or console spam
        }
    });
};

// Rotate current file into .backup (overwriting previous backup)
const rotateLogFile = (filePath, callback) => {
    const backupPath = filePath + '.backup';
    fs.unlink(backupPath, () => {
        // Even if backup doesn't exist, we proceed to rename the current file
        fs.rename(filePath, backupPath, (renameErr) => {
            if (renameErr) {
                // Fallback: if rename fails, truncate the file
                fs.writeFile(filePath, '', callback);
            } else {
                callback();
            }
        });
    });
};

// Helper to write to files asynchronously in background with a 20MB backup rotation limit
const writeLogToFile = (filePath, content) => {
    try {
        fs.stat(filePath, (err, stats) => {
            if (err) {
                if (err.code === 'ENOENT') {
                    appendToFile(filePath, content);
                }
                return;
            }

            if (stats.size > MAX_LOG_SIZE_BYTES) {
                // Over 20MB: rotate current file to backup, then write to fresh file
                rotateLogFile(filePath, () => {
                    appendToFile(filePath, `[LOGGER INFO] Log file rotated. Previous log saved to ${path.basename(filePath)}.backup\n` + content);
                });
            } else {
                appendToFile(filePath, content);
            }
        });
    } catch (e) {
        // Safe catch-all
    }
};

const formatTimestamp = () => {
    const d = new Date();
    // Use Intl.DateTimeFormat to force IST (Asia/Kolkata) timezone formatting
    const parts = new Intl.DateTimeFormat('en-US', {
        timeZone: 'Asia/Kolkata',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hourCycle: 'h23'
    }).formatToParts(d);

    const partMap = {};
    for (const part of parts) {
        partMap[part.type] = part.value;
    }

    const ms = String(d.getMilliseconds()).padStart(3, '0');
    return `${partMap.year}-${partMap.month}-${partMap.day} ${partMap.hour}:${partMap.minute}:${partMap.second}.${ms}`;
};

// Formats a message with context information
const formatLog = (level, message, ...args) => {
    const timestamp = formatTimestamp();
    const store = contextStore.getStore();

    let reqId = '[SYSTEM]';
    let userContext = 'Anonymous';
    let companyContext = '';

    if (store) {
        reqId = `[${store.requestId}]`;

        // Dynamically extract context from the Express request object
        const req = store.req;
        if (req) {
            if (req.user) {
                const email = req.user.email || 'no-email';
                const empCode = req.user.employeeCode ? `|${req.user.employeeCode}` : '';
                userContext = `${email}${empCode}`;
            } else if (req.superAdmin) {
                userContext = `superAdmin:${req.superAdmin.email}`;
            } else if (req.applicant) {
                userContext = `applicant:${req.applicant.email}`;
            } else if (req.payrollIntegration) {
                userContext = `payroll-sync`;
            }

            const companyId = req.companyId || (req.company?._id) || (req.user?.companyId);
            const companyName = req.company?.name;
            if (companyId) {
                companyContext = ` [${companyName || companyId}]`;
            }
        }
    }

    // Format message string if args are passed (like util.format)
    let formattedMsg = typeof message === 'string' ? message : util.inspect(message);
    if (args.length > 0) {
        formattedMsg = util.format(message, ...args);
    }

    return `${timestamp} [${level.toUpperCase()}] ${reqId} [${userContext}]${companyContext} ${formattedMsg}`;
};

// Override stdout/stderr console methods
const originalLog = console.log;
const originalInfo = console.info;
const originalWarn = console.warn;
const originalError = console.error;

const customConsole = {
    log: (msg, ...args) => {
        const formatted = formatLog('info', msg, ...args);
        originalLog(formatted);
        writeLogToFile(COMBINED_LOG_PATH, formatted);
    },
    info: (msg, ...args) => {
        const formatted = formatLog('info', msg, ...args);
        originalInfo(formatted);
        writeLogToFile(COMBINED_LOG_PATH, formatted);
    },
    warn: (msg, ...args) => {
        const formatted = formatLog('warn', msg, ...args);
        originalWarn(formatted);
        writeLogToFile(COMBINED_LOG_PATH, formatted);
    },
    error: (msg, ...args) => {
        const formatted = formatLog('error', msg, ...args);
        originalError(formatted);
        writeLogToFile(COMBINED_LOG_PATH, formatted);
        writeLogToFile(ERROR_LOG_PATH, formatted);
    }
};

// Helper to init the global overrides
const initializeLogger = () => {
    console.log = customConsole.log;
    console.info = customConsole.info;
    console.warn = customConsole.warn;
    console.error = customConsole.error;
};

// Middleware to bind context
const redactKeys = ['password', 'token', 'newPassword', 'currentPassword', 'confirmPassword', 'secret', 'cv', 'file', 'authorization', 'cookie', 'pin', 'cvv', 'cardNumber'];

const redact = (obj) => {
    if (!obj || typeof obj !== 'object') return obj;
    if (Array.isArray(obj)) {
        return obj.map(item => redact(item));
    }
    const redacted = {};
    for (const [key, value] of Object.entries(obj)) {
        const lowerKey = key.toLowerCase();
        if (redactKeys.some(rk => lowerKey.includes(rk))) {
            redacted[key] = '[REDACTED]';
        } else if (typeof value === 'object') {
            redacted[key] = redact(value);
        } else {
            redacted[key] = value;
        }
    }
    return redacted;
};

const SLOW_REQUEST_THRESHOLD_MS = Math.max(parseInt(process.env.SLOW_REQUEST_THRESHOLD_MS || '1000', 10), 0);

const EXCLUDED_KEYWORDS = [
    'verify-workspace',
    'profile',
    'bootstrap'
];

const shouldLogRequest = (req) => {
    const url = req.originalUrl.split('?')[0]; // strip query string
    return !EXCLUDED_KEYWORDS.some(keyword => url.includes(keyword));
};

const loggerMiddleware = (req, res, next) => {
    // Generate a simple unique short request ID
    const requestId = Math.random().toString(36).substring(2, 8).toUpperCase();
    const start = process.hrtime.bigint();
    const clientIp = req.headers['x-forwarded-for'] || req.ip || req.socket.remoteAddress || 'unknown';

    // Store reference that we can mutate later
    const store = {
        requestId,
        clientIp,
        req
    };

    contextStore.run(store, () => {
        const isExcluded = !shouldLogRequest(req);

        // Redact request body for logging
        const redactedBody = req.body && Object.keys(req.body).length > 0 ? JSON.stringify(redact(req.body)) : null;
        const queryParams = req.query && Object.keys(req.query).length > 0 ? JSON.stringify(req.query) : null;

        const inboundMsg = `Inbound: ${req.method} ${req.originalUrl} - IP: ${clientIp} - Query: ${queryParams || '{}'} - Body: ${redactedBody || '{}'}`;

        // Only log inbound request immediately if it's not excluded
        if (!isExcluded) {
            console.log(inboundMsg);
        }

        res.on('finish', () => {
            const durationMs = Number(process.hrtime.bigint() - start) / 1e6;

            // If the route was excluded but failed, print the cached inbound details first
            if (isExcluded && res.statusCode >= 400) {
                console.log(inboundMsg);
            }

            // Log outbound request if it's not excluded OR if it failed (status >= 400)
            if (!isExcluded || res.statusCode >= 400) {
                console.log(`Outbound: ${req.method} ${req.originalUrl} - Status: ${res.statusCode} (${res.statusMessage || ''}) - Time: ${durationMs.toFixed(2)}ms`);
            }

            if (SLOW_REQUEST_THRESHOLD_MS > 0 && durationMs > SLOW_REQUEST_THRESHOLD_MS) {
                console.warn(`[SLOW] ${req.method} ${req.originalUrl} — ${durationMs.toFixed(1)}ms`);
            }
        });

        next();
    });
};

module.exports = {
    contextStore,
    initializeLogger,
    loggerMiddleware
};
