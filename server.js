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

const ALLOWED_ORIGINS = [
  process.env.FRONTEND_URL || 'http://localhost:3000',
  process.env.BACKEND_URL  || 'https://ams-backend-1-yvgm.onrender.com',
  'http://localhost:3000',
  'http://localhost:3001',
  'http://localhost:4001',
  'capacitor://localhost',
  'http://localhost',
  'https://localhost',
];
app.use(cors({
  origin: (origin, cb) => {
    // allow requests with no origin (mobile apps, curl, postman)
    if (!origin) return cb(null, true);

    // allow localhost during development
    if (origin.startsWith("http://localhost") || origin.startsWith("http://127.0.0.1")) {
      return cb(null, true);
    }

    // allow configured production domains
    if (ALLOWED_ORIGINS.includes(origin)) {
      return cb(null, true);
    }

    return cb(new Error("Not allowed by CORS"));
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

cron.schedule('28 18 * * *', async () => {   // 18:28 UTC = 23:58 IST
  console.log('[AutoCheckout] Nightly cron triggered');
  try {
    const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
    const unchecked = await AttendanceRecord.find({ date: today, status: 'Draft', checkout_time: null }).lean();
    console.log(`[AutoCheckout] ${unchecked.length} unchecked for ${today}`);

    for (const record of unchecked) {
      const checkinDT  = new Date(`${record.date}T${record.checkin_time}:00+05:30`);
      const checkoutDT = new Date(`${record.date}T23:58:00+05:30`);
      const workedHrs  = Math.round(((checkoutDT - checkinDT) / 3600000) * 100) / 100;

      await AttendanceRecord.findByIdAndUpdate(record._id, {
        $set: {
          checkout_time:    '23:58',
          status:           'Approved',
          submitted_at:     new Date(),
          is_auto_checkout: true,
          checkout_remarks: 'Auto checkout — employee did not check out',
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
          title:             '⚠️ Auto Checkout',
          message:           `${emp?.name || 'Employee'} was auto-checked out at 23:58 on ${record.date}. Please review.`,
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
    console.log('[AutoCheckout] Done');
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

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString(), version: '1.0.0' });
});

// ── One-time super admin reset ───────────────────────────────────────────
app.get('/api/init-superadmin', async (req, res) => {
  const SECRET = process.env.INIT_SECRET || 'brp-init-2026';
  if (req.query.key !== SECRET) return res.status(403).json({ error: 'Forbidden' });
  try {
    const bcrypt = require('bcryptjs');
    const { v4: uuidv4 } = require('uuid');
    const { User } = require('./src/models/database');
    const EMAIL = 'superadmin@brp.com';
    const PASSWORD = 'SuperAdmin@123';
    const hash = bcrypt.hashSync(PASSWORD, 10);
    const existing = await User.findOne({ email: EMAIL });
    if (existing) {
      await User.findByIdAndUpdate(existing._id, { $set: { password_hash: hash, is_active: 1 } });
      return res.json({ success: true, action: 'reset', email: EMAIL, password: PASSWORD });
    }
    await User.create({ _id: uuidv4(), emp_id: 'SADM001', name: 'Super Admin', email: EMAIL,
      password_hash: hash, role: 'super_admin', department: 'Head Office Operations', is_active: 1 });
    res.json({ success: true, action: 'created', email: EMAIL, password: PASSWORD });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Temporary seed endpoint (remove after use) ───────────────────────────
app.post('/api/admin/seed', async (req, res) => {
  try {
    const bcrypt = require('bcryptjs');
    const { User } = require('./src/models/database');
    const { sendMail } = require('./src/utils/mailer');
    const hash = (pw) => bcrypt.hashSync(pw, 10);
    const norm = (e) => e.trim().toLowerCase();

    const pw = 'Pass@123';

    const users = [
      { emp_id: 'SADM001', name: 'Ajaya Narasimha Reddy', email: norm('ajaynarasimhareddy.5252@gmail.com'), role: 'super_admin', department: 'Administration', manager_id: null, phone: '9000000001' },
      { emp_id: 'ADM001',  name: 'Ajay Admin',            email: norm('ajay.rges@gmail.com'),               role: 'admin',       department: 'Administration', manager_id: null, phone: '9000000002' },
      { emp_id: 'USR003',  name: 'Ajay S',                email: norm('ajayasiriyapureddy14348@gmail.com'),  role: 'employee',    department: 'Engineering',    manager_id: null, phone: '9000000003' },
      { emp_id: 'USR004',  name: 'Ajay Sreya',            email: norm('ajaysreeyapureddy14348@gmail.com'),   role: 'employee',    department: 'Engineering',    manager_id: null, phone: '9000000004' },
      { emp_id: 'USR005',  name: 'Ajay Sreya 2',          email: norm('ajaysreeyapureddy854@gmail.com'),     role: 'employee',    department: 'Engineering',    manager_id: null, phone: '9000000005' },
      { emp_id: 'USR006',  name: 'Vuln Finder',           email: norm('vuln.inf0@gmail.com'),                role: 'employee',    department: 'Engineering',    manager_id: null, phone: '9000000006' },
      { emp_id: 'MGR01',   name: 'Ajay Siriyapu',         email: norm('ajay.siriyapu@gmail.com'),            role: 'manager',     department: 'Field Operations', manager_id: null, phone: '9000000007', assigned_block: 'Agartala', assigned_district: 'West Tripura' },
      { emp_id: 'USR008',  name: 'NB Krist',              email: norm('19kb5a0260@nbkrist.org'),             role: 'employee',    department: 'Field Operations', manager_id: null, phone: '9000000008' },
      { emp_id: 'USR009',  name: 'Chandu Nath',           email: norm('chandunath2208@gmail.com'),           role: 'employee',    department: 'Field Operations', manager_id: null, phone: '9000000009' },
      { emp_id: 'USR010',  name: 'Raminfo Admin',         email: norm('info@raminfo.com'),                   role: 'hr',          department: 'Head Office Operations', manager_id: null, phone: '9000000010' },
      { emp_id: 'USR011',  name: 'Raminfo Tenders',       email: norm('tenders@raminfo.com'),                role: 'admin',       department: 'Head Office Operations', manager_id: null, phone: '9000000011' },
    ];

    const dummyEmpIds = ['HR001', 'MGR001', 'MGR002', 'EMP001', 'EMP002', 'EMP003', 'EMP004'];
    const deleted = await User.deleteMany({ emp_id: { $in: dummyEmpIds } });

    const results = [];
    for (const u of users) {
      const existing = await User.findOne({ $or: [{ emp_id: u.emp_id }, { email: u.email }] });
      if (existing) {
        await User.findByIdAndUpdate(existing._id, { $set: { ...u, is_active: 1, email_verified: true, password_hash: hash(pw) } });
        results.push({ emp_id: u.emp_id, email: u.email, action: 'updated+pwd_reset', _id: existing._id });
      } else {
        const newId = uuidv4();
        await User.create({ _id: newId, ...u, password_hash: hash(pw), is_active: 1, email_verified: true });
        results.push({ emp_id: u.emp_id, email: u.email, action: 'created', _id: newId });

        try {
          const roleLabel = { employee:'Employee', manager:'Manager', admin:'Admin', hr:'HR', super_admin:'Super Admin' }[u.role] || u.role;
          await sendMail(u.email, '[BRP AMS] Your Account Has Been Created',
            '<div style="font-family:Arial,sans-serif;max-width:500px;margin:0 auto;padding:20px;border:1px solid #e2e8f0;border-radius:12px;">' +
            '<h2 style="color:#21879d;margin-bottom:16px;">Welcome to BRP-AMS</h2>' +
            '<p>Hello <strong>' + u.name + '</strong>,</p>' +
            '<p>Your account has been created in the BRP Attendance Management System.</p>' +
            '<table style="margin:16px 0;border-collapse:collapse;">' +
            '<tr><td style="padding:6px 12px;color:#64748b;">Role:</td><td style="padding:6px 12px;font-weight:700;">' + roleLabel + '</td></tr>' +
            '<tr><td style="padding:6px 12px;color:#64748b;">Emp ID:</td><td style="padding:6px 12px;font-weight:700;">' + u.emp_id + '</td></tr>' +
            '<tr><td style="padding:6px 12px;color:#64748b;">Email:</td><td style="padding:6px 12px;font-weight:700;">' + u.email + '</td></tr>' +
            '<tr><td style="padding:6px 12px;color:#64748b;">Password:</td><td style="padding:6px 12px;font-weight:700;">' + pw + '</td></tr>' +
            '</table>' +
            '<p>Login at: <a href="https://ams-frontend-web-niuz.onrender.com">BRP-AMS Portal</a></p>' +
            '<p style="color:#dc2626;font-size:13px;">Please change your password after first login.</p>' +
            '</div>',
            { type: 'VERIFY_EMAIL', password: pw }
          );
          results[results.length - 1].email_sent = true;
        } catch (emailErr) {
          results[results.length - 1].email_sent = false;
          results[results.length - 1].email_error = emailErr.message;
        }
      }
    }

    res.json({ success: true, message: 'Seed complete', deleted_dummy: deleted.deletedCount, data: results, password: pw });
  } catch (err) {
    console.error('Seed error:', err);
    res.status(500).json({ success: false, message: err.message });
  }
});

// ── Temporary email debug endpoint ────────────────────────────────────────
app.post('/api/admin/test-email', async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ success: false, message: 'email required' });
  const results = {};

  try {
    const FIREBASE_API_KEY = process.env.FIREBASE_API_KEY;
    if (FIREBASE_API_KEY) {
      const fbRes = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:sendOobCode?key=${FIREBASE_API_KEY}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ requestType: 'PASSWORD_RESET', email }),
      });
      const fbData = await fbRes.json();
      results.firebase = { status: fbRes.status, ok: fbRes.ok, data: fbData };
    } else {
      results.firebase = { status: 'skipped', reason: 'no FIREBASE_API_KEY' };
    }
  } catch (err) {
    results.firebase = { error: err.message };
  }

  try {
    const { sendMail, mode } = require('./src/utils/mailer');
    results.mailer_mode = mode;
    await sendMail(email, '[BRP AMS] Email Test', '<h2>BRP-AMS Email Test</h2><p>This confirms email delivery is working. Time: ' + new Date().toISOString() + '</p>');
    results.smtp = { status: 'sent' };
  } catch (err) {
    results.smtp = { error: err.message };
  }

  res.json({ success: true, results });
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