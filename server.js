require('dotenv').config();
const { initializeLogger, loggerMiddleware } = require('./src/common/utils/logger');
initializeLogger();

const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const compression = require('compression');
const http = require('http');
const { Server } = require('socket.io');
const mongoose = require('mongoose');
const connectDB = require('./db');

const app = express();
app.set('trust proxy', 1);

const server = http.createServer(app);
const PORT = process.env.PORT || 5000;
const SERVER_REQUEST_TIMEOUT_MS = Math.max(parseInt(process.env.SERVER_REQUEST_TIMEOUT_MS || '40000', 10), 1000);
const SERVER_HEADERS_TIMEOUT_MS = Math.max(parseInt(process.env.SERVER_HEADERS_TIMEOUT_MS || '41000', 10), SERVER_REQUEST_TIMEOUT_MS + 1000);
const SERVER_KEEP_ALIVE_TIMEOUT_MS = Math.max(parseInt(process.env.SERVER_KEEP_ALIVE_TIMEOUT_MS || '40000', 10), 1000);
const MAX_SOCKET_CONNECTIONS_PER_IP = Math.max(parseInt(process.env.SOCKET_MAX_CONNECTIONS_PER_IP || '10', 10), 1);
const MAX_SOCKET_ROOMS_PER_SOCKET = Math.max(parseInt(process.env.SOCKET_MAX_ROOMS_PER_SOCKET || '20', 10), 1);
const SOCKET_MAX_HTTP_BUFFER_SIZE = Math.max(parseInt(process.env.SOCKET_MAX_HTTP_BUFFER_SIZE || '1048576', 10), 1024);
const activeSocketCounts = new Map();
const trackedSocketIps = new Map();

server.requestTimeout = SERVER_REQUEST_TIMEOUT_MS;
server.headersTimeout = SERVER_HEADERS_TIMEOUT_MS;
server.keepAliveTimeout = SERVER_KEEP_ALIVE_TIMEOUT_MS;
server.setTimeout(SERVER_REQUEST_TIMEOUT_MS);

const allowedOriginPatterns = [
    /^https?:\/\/localhost(?::\d+)?$/i,
    /^https?:\/\/127\.0\.0\.1(?::\d+)?$/i,
    /^https?:\/\/([a-z0-9-]+\.)+localhost(?::\d+)?$/i,
    /^https?:\/\/[a-z0-9-]+\.vercel\.app$/i,
    /^https?:\/\/talentcio\.in$/i,
    /^https?:\/\/www\.talentcio\.in$/i,
    /^https?:\/\/([a-z0-9-]+\.)*talentcio\.in$/i,
    /^https?:\/\/([a-z0-9-]+\.)*telentcio\.in$/i,
    /^https?:\/\/resourcegateway\.in$/i,
    /^https?:\/\/www\.resourcegateway\.in$/i,
    /^https?:\/\/([a-z0-9-]+\.)*resourcegateway\.in$/i,
    /^https?:\/\/telentcio\.com$/i,
    /^https?:\/\/([a-z0-9-]+\.)*onrender\.(?:com|in)$/i
];

const isAllowedOrigin = (origin) => {
    if (!origin) return true;
    return allowedOriginPatterns.some(pattern => pattern.test(origin));
};

const LOCAL_UNLIMITED_TIMEOUT_PATTERNS = [
    /^https?:\/\/localhost:5174$/i,
    /^https?:\/\/127\.0\.0\.1:5174$/i
];

const hasLocalUnlimitedTimeoutOrigin = (value) => (
    typeof value === 'string'
    && LOCAL_UNLIMITED_TIMEOUT_PATTERNS.some((pattern) => pattern.test(value.trim()))
);

const shouldDisableRequestTimeout = (req) => (
    hasLocalUnlimitedTimeoutOrigin(req.headers.origin)
    || hasLocalUnlimitedTimeoutOrigin(req.headers.referer)
);

const corsOptions = {
    origin(origin, callback) {
        if (isAllowedOrigin(origin)) {
            return callback(null, true);
        }

        return callback(new Error('Not allowed by CORS'));
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'x-tenant-id', 'Accept', 'Cache-Control', 'Pragma', 'X-Requested-With']
};

const getSocketClientIp = (socket) => {
    const forwardedFor = socket.handshake.headers['x-forwarded-for'];
    if (typeof forwardedFor === 'string' && forwardedFor.trim()) {
        return forwardedFor.split(',')[0].trim();
    }

    return socket.handshake.address || 'unknown';
};

const path = require('path');

app.use(cors(corsOptions));
app.use(helmet({
    crossOriginResourcePolicy: false,
    crossOriginOpenerPolicy: false,
}));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// MED-7: Gzip compression — reduces JSON response payloads by 50-80%
app.use(compression({
    threshold: 1024, // only compress responses larger than 1 KB
    filter: (req, res) => {
        if (req.headers['x-no-compression']) return false;
        return compression.filter(req, res);
    }
}));

app.use((req, res, next) => {
    if (shouldDisableRequestTimeout(req)) {
        req.setTimeout(0);
        res.setTimeout(0);
        if (req.socket) {
            req.socket.setTimeout(0);
        }
    }

    next();
});

// DEPLOY MARKER v4 – requireAttachment fix – 2026-04-20

// Setup Socket.IO
const io = new Server(server, {
    cors: {
        origin(origin, callback) {
            if (isAllowedOrigin(origin)) {
                return callback(null, true);
            }

            return callback(new Error('Not allowed by CORS'));
        },
        credentials: true,
        methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS']
    },
    serveClient: false,
    maxHttpBufferSize: SOCKET_MAX_HTTP_BUFFER_SIZE,
    pingTimeout: 60000,
    pingInterval: 25000
});

io.use((socket, next) => {
    const ip = getSocketClientIp(socket);
    const currentConnections = activeSocketCounts.get(ip) || 0;

    if (currentConnections >= MAX_SOCKET_CONNECTIONS_PER_IP) {
        return next(new Error('Too many socket connections from this IP'));
    }

    activeSocketCounts.set(ip, currentConnections + 1);
    trackedSocketIps.set(socket.id, ip);
    return next();
});

app.set('io', io);

io.on('connection', (socket) => {
    const joinRoomIfAllowed = (roomId) => {
        const normalizedRoomId = typeof roomId === 'string'
            ? roomId.trim()
            : String(roomId || '').trim();

        if (!mongoose.isValidObjectId(normalizedRoomId)) {
            return;
        }

        if (socket.rooms.has(normalizedRoomId)) {
            return;
        }

        if ((socket.rooms.size - 1) >= MAX_SOCKET_ROOMS_PER_SOCKET) {
            socket.emit('socket_error', { message: 'Socket room limit reached' });
            return;
        }

        socket.join(normalizedRoomId);
    };

    socket.on('join_user_room', (userId) => {
        joinRoomIfAllowed(userId);
    });

    socket.on('join_query', (queryId) => {
        joinRoomIfAllowed(queryId);
    });

    socket.on('disconnect', () => {
        const ip = trackedSocketIps.get(socket.id);
        if (!ip) return;

        const remainingConnections = Math.max((activeSocketCounts.get(ip) || 1) - 1, 0);
        if (remainingConnections === 0) {
            activeSocketCounts.delete(ip);
        } else {
            activeSocketCounts.set(ip, remainingConnections);
        }

        trackedSocketIps.delete(socket.id);
    });
});

app.use(express.json());
app.use(loggerMiddleware);

require('./src/modules/user/permission.model');
require('./src/modules/user/role.model');
require('./src/modules/user/user.model');
require('./src/modules/dossier/employeeProfile.model');
require('./src/modules/system/auditLog.model');
require('./src/modules/attendance/attendance.model');
require('./src/modules/attendance/attendanceDocument.model');
require('./src/modules/project/project.model');
require('./src/modules/timesheet/timesheet.model');
require('./src/modules/leave/leaveConfig.model');
require('./src/modules/leave/leaveBalance.model');
require('./src/modules/leave/leaveRequest.model');
require('./src/modules/talent-acquisition/candidate.model');
require('./src/modules/email/emailTemplate.model');
require('./src/modules/auth/applicant.model');
require('./src/modules/talent-acquisition/publicApplication.model');
require('./src/modules/auth/handoffToken.model');
require('./src/modules/talent-acquisition/interviewWorkflow.model');
require('./src/modules/notification/notification.model');
require('./src/modules/company/company.model');
require('./src/modules/plan/plan.model');
require('./src/modules/system/activityLog.model');
require('./src/modules/auth/superAdminUser.model');
require('./src/modules/onboarding/onboardingEmployee.model');
require('./src/modules/talent-acquisition/phaseTemplate.model');
require('./src/modules/announcement/announcement.model');
require('./src/modules/offboarding/offboardingRecord.model');
require('./src/modules/email/hrEmailLog.model');

const syncPermissions = require('./src/services/permissionSync');
const startAutoCheckoutCron = require('./src/modules/attendance/attendanceAutoCheckout.cron');
const cleanupStaleIndexes = require('./src/services/indexCleanup');
const { startBinAutoPurgeCron } = require('./src/modules/bin/binAutoPurge.cron');
const startAnnouncementScheduler = require('./src/modules/announcement/announcement.scheduler');
const startEscalationCron = require('./src/modules/helpdesk/escalation.cron');

const apiRoutes = require('./src/routes');

const initServer = async () => {
    await connectDB();
    await cleanupStaleIndexes();
    await syncPermissions();
    startEscalationCron(io);
    startAutoCheckoutCron();
    startBinAutoPurgeCron();
    startAnnouncementScheduler(io);

    server.listen(PORT, () => {
        console.log(`Server & Socket.IO running on port ${PORT}`);
    });
};

app.use('/api', apiRoutes);

app.get('/', (req, res) => {
    res.json({ message: 'TalentCio API is running' });
});

initServer().catch((error) => {
    console.error('[SERVER INIT] Failed to start server:', error.message);
    process.exit(1);
});

process.on('unhandledRejection', (err) => {
    console.log(`Error: ${err.message}`);
});

const gracefulShutdown = (signal) => {
    console.log(`[SERVER] ${signal} received. Closing server on port ${PORT}...`);
    server.close(() => {
        console.log('[SERVER] HTTP server closed cleanly.');
        if (signal === 'SIGUSR2') {
            process.kill(process.pid, 'SIGUSR2');
        } else {
            process.exit(0);
        }
    });
};

process.once('SIGUSR2', () => gracefulShutdown('SIGUSR2'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));

