require('dotenv').config();
const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const http = require('http');
const { Server } = require('socket.io');
const mongoose = require('mongoose');
const connectDB = require('./db');

const app = express();
// Trust the first proxy (Render) so rate limiting uses correct client IPs
app.set('trust proxy', 1);
const server = http.createServer(app);

// CORS — smart pattern-based, covers all envs: Vercel, custom domains, localhost, Render
const isAllowedOrigin = (origin) => {
    if (!origin) return true; // server-to-server / Postman / curl
    try {
        const { hostname } = new URL(origin);
        return (
            hostname === 'localhost' ||
            hostname.endsWith('.localhost') ||           // ilumaa.localhost
            hostname.endsWith('.vercel.app') ||          // *.vercel.app (all Vercel deployments)
            hostname.endsWith('.talentcio.in') ||       // ilumaa.talentcio.com
            hostname === 'talentcio.in' ||
            hostname.endsWith('.telentcio.in') ||       // (typo variant in use)
            hostname === 'telentcio.com' ||
            hostname.endsWith('.onrender.in')           // inter-service on Render
        );
    } catch {
        return false;
    }
};

app.use((req, res, next) => {
    const origin = req.headers.origin;
    if (isAllowedOrigin(origin)) {
        // Echo back the exact origin so credentials work when needed
        res.setHeader('Access-Control-Allow-Origin', origin || '*');
        if (origin) res.setHeader('Vary', 'Origin');
    }
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, PATCH, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-tenant-id, Accept, Cache-Control, Pragma, X-Requested-With');
    res.setHeader('Access-Control-Allow-Credentials', 'true');

    if (req.method === 'OPTIONS') {
        return res.status(204).end();
    }
    next();
});

// Helmet — after CORS, with cross-origin policies disabled to avoid header conflicts
app.use(helmet({
    crossOriginResourcePolicy: false,
    crossOriginOpenerPolicy: false,
}));


// sample added comment for checking the CI/CD line 59 server.js file 
// sample line 2 for checking again

// Setup Socket.IO
const io = new Server(server, {
    cors: {
        origin: function (origin, callback) {
            callback(null, true);
        },
        credentials: true,
        methods: ["GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS"]
    }
});

// Expose io to routes
app.set('io', io);

// Socket Event Listeners
io.on('connection', (socket) => {
    // console.log(`User connected to socket: ${socket.id}`);

    // Join a private room for the user to receive targeted notifications
    socket.on('join_user_room', (userId) => {
        if (userId) {
            socket.join(userId.toString());
            // console.log(`Socket ${socket.id} joined personal room ${userId}`);
        }
    });

    // Join a specific query room for real-time ticket updates
    socket.on('join_query', (queryId) => {
        socket.join(queryId);
        // console.log(`Socket ${socket.id} joined room ${queryId}`);
    });

    socket.on('disconnect', () => {
        // console.log(`User disconnected from socket: ${socket.id}`);
    });
});

const PORT = process.env.PORT || 5000;

// Middleware
app.use(express.json());

// Models (Register Schemas)
require('./src/models/Permission');
require('./src/models/Role');
require('./src/models/User');
require('./src/models/EmployeeProfile');
require('./src/models/AuditLog');
require('./src/models/Attendance');
require('./src/models/Project');
require('./src/models/Project');
require('./src/models/Timesheet');
require('./src/models/LeaveConfig');
require('./src/models/LeaveBalance');
require('./src/models/LeaveRequest');
require('./src/models/Candidate');
require('./src/models/InterviewWorkflow');
require('./src/models/Notification');
require('./src/models/Company');
require('./src/models/Plan');
require('./src/models/ActivityLog');
require('./src/models/SuperAdminUser');
require('./src/models/OnboardingEmployee');

// Services
const syncPermissions = require('./src/services/permissionSync');
const startEscalationCron = require('./src/services/escalationCron');
const startAutoCheckoutCron = require('./src/services/attendanceAutoCheckoutCron');
const cleanupStaleIndexes = require('./src/services/indexCleanup');

// Routes
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

// Super Admin Routes
const superAdminAuthRoutes = require('./src/routes/superAdminRoutes');
const companyRoutes = require('./src/routes/companyRoutes');
const globalUserRoutes = require('./src/routes/globalUserRoutes');
const analyticsRoutes = require('./src/routes/analyticsRoutes');
const planRoutes = require('./src/routes/planRoutes');
const superAdminMiscRoutes = require('./src/routes/superAdminMiscRoutes');

// Multi-tenant & Licensing Middleware
const tenantMiddleware = require('./src/middlewares/tenantMiddleware');
const planGuard = require('./src/middlewares/planGuard');
const { globalLimiter } = require('./src/middlewares/rateLimitMiddleware');

// Database Connection & Init
const initServer = async () => {
    await connectDB();
    await cleanupStaleIndexes();
    await syncPermissions();
    startEscalationCron(io); // Start the background Helpdesk escalation job
    startAutoCheckoutCron(); // Start the background auto-checkout job
};
initServer();

// Mount Routes (Tenant-Facing)
app.use('/api', (req, res, next) => {
    if (req.path.startsWith('/superadmin')) return next();
    globalLimiter(req, res, next);
});

app.use('/api', (req, res, next) => {
    if (req.path.startsWith('/superadmin')) return next();
    tenantMiddleware(req, res, (err) => {
        if (err) return next(err);
        planGuard(req, res, next);
    });
});

app.use('/api/auth', authRoutes);
app.use('/api/attendance', attendanceRoutes);
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

// Super Admin API Namespace
app.use('/api/superadmin/auth', superAdminAuthRoutes);
app.use('/api/superadmin/companies', companyRoutes);
app.use('/api/superadmin/users', globalUserRoutes);
app.use('/api/superadmin/analytics', analyticsRoutes);
app.use('/api/superadmin/plans', planRoutes);
app.use('/api/superadmin', superAdminMiscRoutes);

app.get('/', (req, res) => {
    res.json({ message: 'TalentCio API is running' });
});

// Start Server
server.listen(PORT, () => {
    console.log(`Server & Socket.IO running on port ${PORT}`);
});

// Handle unhandled promise rejections
process.on('unhandledRejection', (err, promise) => {
    console.log(`Error: ${err.message}`);
    // Close server & exit process
    // server.close(() => process.exit(1));
});
