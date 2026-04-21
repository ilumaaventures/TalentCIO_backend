const SLOW_REQUEST_THRESHOLD_MS = Math.max(parseInt(process.env.SLOW_REQUEST_THRESHOLD_MS || '1000', 10), 0);

const requestTiming = (req, res, next) => {
    const start = process.hrtime.bigint();

    res.on('finish', () => {
        const durationMs = Number(process.hrtime.bigint() - start) / 1e6;
        // Request logging removed per user request
    });

    next();
};

module.exports = requestTiming;
