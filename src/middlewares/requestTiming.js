const requestTiming = (req, res, next) => {
    const start = process.hrtime.bigint();
    res.setHeader('X-Workprobe-Profiler', 'active');

    const originalEnd = res.end;
    res.end = function (...args) {
        const durationMs = Number(process.hrtime.bigint() - start) / 1e6;
        if (!res.headersSent) {
            res.setHeader('X-Response-Time', `${durationMs.toFixed(1)}ms`);
        }
        return originalEnd.apply(this, args);
    };

    res.on('finish', () => {
        const durationMs = Number(process.hrtime.bigint() - start) / 1e6;
        const rounded = durationMs.toFixed(1);

        console.log(`[REQ] ${req.method} ${req.originalUrl} -> ${res.statusCode} in ${rounded}ms`);
    });

    next();
};

module.exports = requestTiming;
