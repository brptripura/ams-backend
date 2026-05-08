const dns = require('node:dns');
dns.setServers(['8.8.8.8', '1.1.1.1']);
require('dotenv').config();

if (!process.env.JWT_SECRET || process.env.JWT_SECRET.length < 32) {
  console.error('FATAL: JWT_SECRET must be set and at least 32 characters');
  process.exit(1);
}
if (!process.env.MONGO_URI) {
  console.error('FATAL: MONGO_URI environment variable is required');
  process.exit(1);
}

const express       = require('express');
const cors          = require('cors');
const helmet        = require('helmet');
const morgan        = require('morgan');
const rateLimit     = require('express-rate-limit');
const mongoSanitize = require('express-mongo-sanitize');
const cron          = require('node-cron');

const app  = express();
const PORT = process.env.PORT;

app.set('trust proxy', 1);

// ── Security & Middleware ─────────────────────────────────────────────────
app.use(helmet({
  crossOriginResourcePolicy: { policy: 'cross-origin' },
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", "data:", "blob:"],
      connectSrc: ["'self'"],
      fontSrc: ["'self'"],
      objectSrc: ["'none'"],
      mediaSrc: ["'self'"],
      frameSrc: ["'none'"],
    },
  },
  hsts: { maxAge: 31536000, includeSubDomains: true, preload: true },
  referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
  noSniff: true,
  xssFilter: true,
  hidePoweredBy: true,
  frameguard: { action: 'deny' },
}));

// Build the allowed-origins list from env + hardcoded known URLs.
// All historical Render service URLs are included so old deployments still work.
const ALLOWED_ORIGINS = new Set([
  // Current URLs (always allowed)
  'https://brp-mobile.onrender.com',
  'https://ams-frontend-web.onrender.com',
  'https://ams-frontend-web-niuz.onrender.com',
  // Historical backend URLs (kept so any outstanding JWT/cookie sessions still work)
  'https://ams-backend-3it1.onrender.com',
  'https://ams-backend-1-yvgm.onrender.com',
  // From env (takes effect after Render redeploy)
  process.env.FRONTEND_URL,
  process.env.BACKEND_URL,
  // Local dev
  'http://localhost:3000',
  'http://localhost:3001',
  'http://localhost:4001',
  'http://localhost:10000',
  'capacitor://localhost',
  'http://localhost',
  'https://localhost',
].filter(Boolean));

app.use(cors({
  origin: (origin, cb) => {
    // allow requests with no origin (mobile apps, curl, Postman)
    if (!origin) return cb(null, true);

    // allow any localhost / 127.0.0.1 (local dev)
    if (origin.startsWith('http://localhost') || origin.startsWith('http://127.0.0.1')) {
      return cb(null, true);
    }

    // allow any *.onrender.com subdomain that belongs to this project
    // (covers any future Render service URLs automatically)
    if (origin.endsWith('.onrender.com')) {
      return cb(null, true);
    }

    // allow explicitly listed origins
    if (ALLOWED_ORIGINS.has(origin)) {
      return cb(null, true);
    }

    console.warn('[CORS] Blocked origin:', origin);
    return cb(new Error('Not allowed by CORS'));
  },
  credentials: true,
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization", "X-Requested-With"],
  exposedHeaders: ["Content-Disposition"],
}));
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains; preload');
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  next();
});
app.use(morgan('dev'));
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));
app.use("/uploads", express.static("uploads"));
app.use((req, res, next) => {
  if (req.body) req.body = mongoSanitize.sanitize(req.body, { replaceWith: '_' });
  if (req.query && typeof req.query === 'object') {
    for (const key of Object.keys(req.query)) {
      if (typeof req.query[key] === 'string') {
        req.query[key] = req.query[key].replace(/[$]/g, '');
      }
    }
  }
  next();
});

const limiter = rateLimit({ windowMs: 2 * 60 * 1000, max: 200, standardHeaders: true, legacyHeaders: false });
app.use('/api/', limiter);

// ── Models ────────────────────────────────────────────────────────────────
const { connectionPromise, AttendanceRecord, User, Notification, RevokedToken } = require('./src/models/database');
const { v4: uuidv4 } = require('uuid');

// ─────────────────────────────────────────────────────────────────────────────
// CRON 1 — Midnight IST (00:05): Mark unchecked-out records as missed-checkout
//
// Finds any Draft attendance record from YESTERDAY or earlier that has a
// check-in but NO check-out, and converts it to:
//   status           = 'Pending'
//   is_missed_checkout = true
//
// This places it in the manager's queue so they can approve/reject it.
// The employee is BLOCKED from checking in again until the manager acts.
// ─────────────────────────────────────────────────────────────────────────────
cron.schedule('5 0 * * *', async () => {
  console.log('[MissedCheckout Cron] Running at midnight IST...');
  try {
    const todayIST = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });

    // Find all Draft records from BEFORE today that have check-in but no check-out
    const unchecked = await AttendanceRecord.find({
      date:          { $lt: todayIST },   // strictly before today
      status:        'Draft',
      checkin_time:  { $ne: null },
      checkout_time: null,
    }).lean();

    console.log(`[MissedCheckout Cron] Found ${unchecked.length} unchecked-out record(s) to process.`);

    for (const record of unchecked) {
      // Mark as missed-checkout and move to Pending for manager review
      await AttendanceRecord.findByIdAndUpdate(record._id, {
        $set: {
          status:             'Pending',
          is_missed_checkout: true,
          checkout_remarks:   'Employee did not check out. Requires manager approval.',
          submitted_at:       new Date(),
        },
      });

      // Notify the employee
      await Notification.create({
        _id:               uuidv4(),
        user_id:           record.emp_id,
        title:             '⚠️ Missed Check-Out',
        message:           `You forgot to check out on ${record.date}. Your attendance has been sent to your manager for review. You cannot check in until they approve or reject it.`,
        type:              'warning',
        related_record_id: record._id,
        link:              '/employee/history',
      });

      // Notify the manager
      if (record.manager_id) {
        const emp = await User.findById(record.emp_id).select('name').lean();
        await Notification.create({
          _id:               uuidv4(),
          user_id:           record.manager_id,
          title:             '🔔 Missed Check-Out — Action Required',
          message:           `${emp?.name || 'An employee'} did not check out on ${record.date} (checked in at ${record.checkin_time}). Please review and approve or reject.`,
          type:              'warning',
          related_record_id: record._id,
          link:              '/manager/queue',
        });
      }

      await require('./src/models/database').AuditLog?.create?.({
        _id:         uuidv4(),
        user_id:     record.emp_id,
        action:      'MISSED_CHECKOUT_AUTO_FLAGGED',
        entity_type: 'attendance',
        entity_id:   record._id,
      }).catch(() => {}); // non-fatal
    }

    console.log(`[MissedCheckout Cron] Done — ${unchecked.length} record(s) flagged.`);
  } catch (err) {
    console.error('[MissedCheckout Cron] Error:', err.message);
  }
}, {
  timezone: 'Asia/Kolkata',
});

// ─────────────────────────────────────────────────────────────────────────────
// CRON 2 — Hourly reminder (18:00–23:00 IST): Remind employees to check out
//
// Sends a notification reminder only — does NOT flag or block anyone.
// The midnight cron above handles the actual flagging.
// ─────────────────────────────────────────────────────────────────────────────
cron.schedule('0 18-23 * * *', async () => {
  console.log('[MissedCheckout Reminder] Cron triggered');
  try {
    const todayIST = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });

    const unchecked = await AttendanceRecord.find({
      date:          todayIST,
      status:        'Draft',
      checkin_time:  { $ne: null },
      checkout_time: null,
    }).lean();

    console.log(`[MissedCheckout Reminder] ${unchecked.length} employees still not checked out for ${todayIST}`);

    for (const record of unchecked) {
      const checkinDT    = new Date(`${record.date}T${record.checkin_time}:00+05:30`);
      const nowIST       = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
      const hoursElapsed = (nowIST - checkinDT) / 3600000;

      if (hoursElapsed < 6) continue;

      // Throttle — don't spam more than once every 2 hours
      const recentNotif = await Notification.findOne({
        user_id:    record.emp_id,
        type:       'checkout_reminder',
        created_at: { $gte: new Date(Date.now() - 2 * 60 * 60 * 1000) },
      }).lean();

      if (recentNotif) continue;

      await Notification.create({
        _id:               uuidv4(),
        user_id:           record.emp_id,
        title:             '⏰ Please Check Out',
        message:           `You checked in at ${record.checkin_time} and haven't checked out yet. Check out before midnight to avoid a missed-checkout flag.`,
        type:              'checkout_reminder',
        related_record_id: record._id,
        link:              '/employee/attendance',
      });

      if (record.manager_id) {
        const emp = await User.findById(record.emp_id).select('name').lean();
        await Notification.create({
          _id:               uuidv4(),
          user_id:           record.manager_id,
          title:             '⚠️ Employee Not Checked Out',
          message:           `${emp?.name || 'An employee'} checked in at ${record.checkin_time} on ${record.date} but has not checked out yet (${Math.floor(hoursElapsed)}h elapsed).`,
          type:              'warning',
          related_record_id: record._id,
          link:              '/manager/queue',
        });
      }
    }

    console.log('[MissedCheckout Reminder] Done');
  } catch (err) {
    console.error('[MissedCheckout Reminder] Error:', err.message);
  }
}, {
  timezone: 'Asia/Kolkata',
});

// ── Revoked-token pruning ─────────────────────────────────────────────────
const pruneRevokedTokens = async () => {
  try {
    const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000);
    await RevokedToken.deleteMany({ revoked_at: { $lt: cutoff } });
  } catch (err) {
    console.error('Token prune error:', err.message);
  }
};

connectionPromise.then(async () => {
  pruneRevokedTokens();
  setInterval(pruneRevokedTokens, 60 * 60 * 1000);
  require('./src/utils/mailer');

  // Process any Draft records missed while server was down (Render sleep)
  try {
    const todayIST = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
    const missed = await AttendanceRecord.find({
      date:          { $lt: todayIST },
      status:        'Draft',
      checkout_time: null,
      duty_type:     { $ne: 'Leave' },
    }).lean();

    if (missed.length > 0) {
      console.log(`[Startup] Found ${missed.length} Draft records from previous days — auto-processing…`);
      for (const record of missed) {
        const checkinDT  = new Date(`${record.date}T${record.checkin_time}:00+05:30`);
        const checkoutDT = new Date(`${record.date}T23:58:00+05:30`);
        const workedHrs  = Math.max(0, Math.round(((checkoutDT - checkinDT) / 3600000) * 100) / 100);

        await AttendanceRecord.findByIdAndUpdate(record._id, {
          $set: {
            checkout_time:    '23:58',
            status:           'Approved',
            submitted_at:     new Date(),
            is_auto_checkout: true,
            checkout_remarks: 'Auto checkout — server was offline during scheduled run',
            worked_hours:     workedHrs > 0 ? workedHrs : null,
            leave_type:       workedHrs < 4 ? 'Half Day' : null,
            leave_status:     workedHrs < 4 ? 'Pending'  : null,
          },
        });

        if (record.manager_id) {
          const emp = await User.findById(record.emp_id).select('name').lean();
          await Notification.create({
            _id:               uuidv4(),
            user_id:           record.manager_id,
            title:             'Missed Auto Checkout',
            message:           `${emp?.name || 'Employee'} was auto-checked out (server recovery) on ${record.date}.`,
            type:              'warning',
            related_record_id: record._id,
          });
        }
      }
      console.log(`[Startup] Auto-processed ${missed.length} missed Draft records`);
    }
  } catch (err) {
    console.error('[Startup] Missed checkout recovery error:', err.message);
  }
});
// ── Routes ────────────────────────────────────────────────────────────────
const attendanceRouter = require('./src/routes/attendance');
app.use('/api/auth',              require('./src/routes/auth'));
app.use('/api/attendance',        attendanceRouter);
app.use('/api/users',             require('./src/routes/users'));
app.use('/api/reports',           require('./src/routes/reports'));
app.use('/api/notifications',     require('./src/routes/notifications'));
app.use('/api/activity',          require('./src/routes/activity'));
app.use('/api/activity-schedule', require('./src/routes/activity-schedule'));
app.use('/api/msme',              require('./src/routes/msme'));
app.use('/api/custom-options',    require('./src/routes/custom-options'));

// Health check — version bump triggers Render redeploy detection
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    version: '1.2.0',
    msmeUnfiltered: true,  // confirms MSME route no longer filters by block for employees
  });
});


// ── Error Handler ─────────────────────────────────────────────────────────
app.use((err, req, res, next) => {
  console.error(err.stack);
  if (err.code === 'LIMIT_FILE_SIZE')
    return res.status(400).json({ success: false, message: 'File too large (max 5MB)' });
  const isProd = process.env.NODE_ENV === 'production';
  const message = isProd ? 'Internal server error' : (err.message || 'Internal server error');
  res.status(err.status || 500).json({ success: false, message });
});

app.listen(PORT, () => {
  console.log(`\n🚀 BRP Attendance API running on http://localhost:${PORT}`);
  console.log(`📊 Health: http://localhost:${PORT}/api/health`);
  console.log(`\nRun 'npm run seed' to populate demo data\n`);
});

module.exports = app;