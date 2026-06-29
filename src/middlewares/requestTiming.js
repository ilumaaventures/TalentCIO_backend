const SLOW_REQUEST_THRESHOLD_MS = Math.max(parseInt(process.env.SLOW_REQUEST_THRESHOLD_MS || '1000', 10), 0);

const requestTiming = (req, res, next) => {
    const start = process.hrtime.bigint();

    res.on('finish', () => {
        const durationMs = Number(process.hrtime.bigint() - start) / 1e6;
        if (SLOW_REQUEST_THRESHOLD_MS > 0 && durationMs > SLOW_REQUEST_THRESHOLD_MS) {
            console.warn(`[SLOW] ${req.method} ${req.originalUrl} — ${durationMs.toFixed(1)}ms`);
        }
    });

    next();
};

module.exports = requestTiming;
