require('dotenv').config();
const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const http = require('http');
const { Server } = require('socket.io');
const mongoose = require('mongoose');
const connectDB = require('./db');

const app = express();
app.set('trust proxy', 1);

const server = http.createServer(app);
const PORT = process.env.PORT || 5000;
const MAX_SOCKET_CONNECTIONS_PER_IP = Math.max(parseInt(process.env.SOCKET_MAX_CONNECTIONS_PER_IP || '10', 10), 1);
const MAX_SOCKET_ROOMS_PER_SOCKET = Math.max(parseInt(process.env.SOCKET_MAX_ROOMS_PER_SOCKET || '20', 10), 1);
const SOCKET_MAX_HTTP_BUFFER_SIZE = Math.max(parseInt(process.env.SOCKET_MAX_HTTP_BUFFER_SIZE || '1048576', 10), 1024);
const activeSocketCounts = new Map();
const trackedSocketIps = new Map();
const requestTiming = require('./src/middlewares/requestTiming');

const allowedOriginPatterns = [
    /^https?:\/\/localhost(?::\d+)?$/i,
    /^https?:\/\/([a-z0-9-]+\.)+localhost(?::\d+)?$/i,
    /^https:\/\/[a-z0-9-]+\.vercel\.app$/i,
    /^https?:\/\/talentcio\.in$/i,
    /^https?:\/\/www\.talentcio\.in$/i,
    /^https:\/\/([a-z0-9-]+\.)*talentcio\.in$/i,
    /^https:\/\/([a-z0-9-]+\.)*telentcio\.in$/i,
    /^https:\/\/telentcio\.com$/i,
    /^https:\/\/([a-z0-9-]+\.)*onrender\.(?:com|in)$/i
];

const isAllowedOrigin = (origin) => {
    if (!origin) return true;
    return allowedOriginPatterns.some(pattern => pattern.test(origin));
};

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

app.use(cors(corsOptions));
app.use(helmet({
    crossOriginResourcePolicy: false,
    crossOriginOpenerPolicy: false,
}));


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

app.use(requestTiming);
app.use(express.json());

require('./src/models/Permission');
require('./src/models/Role');
require('./src/models/User');
require('./src/models/EmployeeProfile');
require('./src/models/AuditLog');
require('./src/models/Attendance');
require('./src/models/AttendanceDocument');
require('./src/models/Project');
require('./src/models/Timesheet');
require('./src/models/LeaveConfig');
require('./src/models/LeaveBalance');
require('./src/models/LeaveRequest');
require('./src/models/Candidate');
require('./src/models/Applicant');
require('./src/models/PublicApplication');
require('./src/models/HandoffToken');
require('./src/models/InterviewWorkflow');
require('./src/models/Notification');
require('./src/models/Company');
require('./src/models/Plan');
require('./src/models/ActivityLog');
require('./src/models/SuperAdminUser');
require('./src/models/OnboardingEmployee');

const syncPermissions = require('./src/services/permissionSync');
const startEscalationCron = require('./src/services/escalationCron');
const startAutoCheckoutCron = require('./src/services/attendanceAutoCheckoutCron');
const cleanupStaleIndexes = require('./src/services/indexCleanup');

const authRoutes = require('./src/routes/authRoutes');
const attendanceRoutes = require('./src/routes/attendanceRoutes');
const timesheetRoutes = require('./src/routes/timesheetRoutes');
const adminRoutes = require('./src/routes/adminRoutes');
const projectRoutes = require('./src/routes/projectRoutes');
const dashboardRoutes = require('./src/routes/dashboardRoutes');
const holidayRoutes = require('./src/routes/holidayRoutes');
const leaveRoutes = require('./src/routes/leaveRoutes');
const dossierRoutes = require('./src/routes/dossierRoutes');
const talentAcquisitionRoutes = require('./src/routes/talentAcquisitionRoutes');
const candidateRoutes = require('./src/routes/candidateRoutes');
const workflowRoutes = require('./src/routes/workflowRoutes');
const meetingRoutes = require('./src/routes/meetingRoutes');
const helpdeskRoutes = require('./src/routes/helpdeskRoutes');
const interviewWorkflowRoutes = require('./src/routes/interviewWorkflowRoutes');
const notificationRoutes = require('./src/routes/notificationRoutes');
const discussionRoutes = require('./src/routes/discussionRoutes');
const onboardingRoutes = require('./src/routes/onboardingRoutes');
const attendanceDocumentRoutes = require('./src/routes/attendanceDocumentRoutes');
const publicRoutes = require('./src/routes/publicRoutes');

const superAdminAuthRoutes = require('./src/routes/superAdminRoutes');
const companyRoutes = require('./src/routes/companyRoutes');
const globalUserRoutes = require('./src/routes/globalUserRoutes');
const analyticsRoutes = require('./src/routes/analyticsRoutes');
const planRoutes = require('./src/routes/planRoutes');
const superAdminMiscRoutes = require('./src/routes/superAdminMiscRoutes');

const tenantMiddleware = require('./src/middlewares/tenantMiddleware');
const planGuard = require('./src/middlewares/planGuard');
const { globalLimiter } = require('./src/middlewares/rateLimitMiddleware');

const initServer = async () => {
    await connectDB();
    await cleanupStaleIndexes();
    await syncPermissions();
    startEscalationCron(io);
    startAutoCheckoutCron();
};

initServer();

app.use('/api', (req, res, next) => {
    if (req.path.startsWith('/superadmin')) return next();
    globalLimiter(req, res, next);
});

app.use('/api/public', publicRoutes);

app.use('/api', (req, res, next) => {
    if (req.path.startsWith('/superadmin')) return next();
    tenantMiddleware(req, res, (err) => {
        if (err) return next(err);
        planGuard(req, res, next);
    });
});

app.use('/api/auth', authRoutes);
app.use('/api/attendance', attendanceRoutes);
app.use('/api/attendance/attachments', attendanceDocumentRoutes);
app.use('/api/timesheet', timesheetRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/projects', projectRoutes);
app.use('/api/dashboard', dashboardRoutes);
app.use('/api/holidays', holidayRoutes);
app.use('/api/leaves', leaveRoutes);
app.use('/api/dossier', dossierRoutes);
app.use('/api/ta', talentAcquisitionRoutes);
app.use('/api/ta/candidates', candidateRoutes);
app.use('/api/ta/interview-workflows', interviewWorkflowRoutes);
app.use('/api/workflows', workflowRoutes);
app.use('/api/meetings', meetingRoutes);
app.use('/api/helpdesk', helpdeskRoutes);
app.use('/api/notifications', notificationRoutes);
app.use('/api/discussions', discussionRoutes);
app.use('/api/onboarding', onboardingRoutes);

app.use('/api/superadmin/auth', superAdminAuthRoutes);
app.use('/api/superadmin/companies', companyRoutes);
app.use('/api/superadmin/users', globalUserRoutes);
app.use('/api/superadmin/analytics', analyticsRoutes);
app.use('/api/superadmin/plans', planRoutes);
app.use('/api/superadmin', superAdminMiscRoutes);

app.get('/', (req, res) => {
    res.json({ message: 'TalentCio API is running' });
});

server.listen(PORT, () => {
    console.log(`Server & Socket.IO running on port ${PORT}`);
});

process.on('unhandledRejection', (err) => {
    console.log(`Error: ${err.message}`);
});
