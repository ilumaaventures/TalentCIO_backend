const SLOW_REQUEST_THRESHOLD_MS = Math.max(parseInt(process.env.SLOW_REQUEST_THRESHOLD_MS || '1000', 10), 0);

const requestTiming = (req, res, next) => {
    const start = process.hrtime.bigint();

    res.on('finish', () => {
        const durationMs = Number(process.hrtime.bigint() - start) / 1e6;
        if (durationMs >= SLOW_REQUEST_THRESHOLD_MS || res.statusCode >= 500) {
            console.log(`[REQ] ${req.method} ${req.originalUrl} -> ${res.statusCode} in ${durationMs.toFixed(1)}ms`);
        }
    });

    next();
};

module.exports = requestTiming;
