const express        = require('express');
const router         = express.Router();
const multer         = require('multer');
const { uploadFile } = require('../utils/storage');
const { v4: uuidv4 } = require('uuid');
const { body, validationResult } = require('express-validator');
const { AttendanceRecord, User, Notification, AuditLog, CustomBlock, ODARequest } = require('../models/database');
const { clampLeaveBalance, roundHalfDay } = require('../utils/leaveBalance');
const { fmt12h } = require('../utils/time');
const { authenticate, authorize }                         = require('../middleware/auth');
const { sendMail }                                        = require('../utils/mailer');
const path = require('path');
const { employeeFolderPath } = require('../config/cloudinary');
// ── File-naming helper ───────────────────────────────────────────────────
const makeDocName = (user, docType, ext = '') => {
  const name  = (user.name || 'unknown').replace(/\s+/g, '_').replace(/[^a-zA-Z0-9_-]/g, '');
  const empId = String(user.emp_id || user.id || 'NOID').replace(/[^a-zA-Z0-9_-]/g, '');
  const ts    = Date.now();
  return `${name}_${empId}_${docType}_${ts}${ext ? '.' + ext.replace(/^\./, '') : ''}`;
};

// ── IST helpers ───────────────────────────────────────────────────────────
const istDateStr    = () => new Date().toLocaleDateString('en-CA',  { timeZone: 'Asia/Kolkata' });
const istTimeStr    = () => new Date().toLocaleTimeString('en-GB',  { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hour12: false }).substring(0, 5);
const istMonthStr   = () => new Date().toLocaleDateString('en-CA',  { timeZone: 'Asia/Kolkata' }).substring(0, 7);
const istMonthLabel = () => new Date().toLocaleDateString('en-IN',  { timeZone: 'Asia/Kolkata', month: 'long', year: 'numeric' });
// ── HTML entity decoder (handles multiple encodings like &amp;amp;) ────────
const _decodeHtml  = s => String(s ?? '').replace(/&amp;/gi,'&').replace(/&lt;/gi,'<').replace(/&gt;/gi,'>').replace(/&quot;/gi,'"').replace(/&#39;/gi,"'");

// ── Check-in geofence: how far (meters) a check-in can be from the
// employee's assigned block's coordinates. Skipped entirely if the block
// has no coordinates set yet (admin hasn't configured it) or the employee
// has no assigned_block.
const CHECKIN_GEOFENCE_METERS = 200;
// On Duty check-in is allowed anywhere in the employee's assigned district —
// there's no stored district polygon, so this approximates "in the district"
// as being within this radius of ANY block belonging to that district (using
// the same CustomBlock coordinates the Office Duty geofence already relies
// on). 15km comfortably covers gaps between block centers within one district
// without opening the door to a check-in from a different district entirely.
const ON_DUTY_DISTRICT_GEOFENCE_METERS = 15000;
const haversineMeters = (lat1, lon1, lat2, lon2) => {
  const R = 6371000; // Earth radius, meters
  const toRad = d => d * Math.PI / 180;
  const dLat = toRad(lat2 - lat1), dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
};
const _fullyDecode = s => { let p; do { p = s; s = _decodeHtml(s); } while (s !== p); return s; };

// ── Coarse IP-geolocation corroboration for check-in GPS ───────────────────
// The client-supplied lat/lng that the geofence check above relies on is
// fully spoofable (just edit the request body) — this is a second,
// independent signal that's much harder to fake at the same time (it'd
// require also routing the request through a Tripura-based proxy/VPN).
// Deliberately non-blocking: IP geolocation is coarse and unreliable for
// mobile carrier NAT — a mismatch only sets a review flag, never rejects
// the check-in, so no legitimate employee ever gets locked out by it.
const http  = require('http');
const IP_GEO_MISMATCH_KM = 150;

const clientIp = (req) => {
  const fwd = req.headers['x-forwarded-for'];
  const ip  = (fwd ? fwd.split(',')[0].trim() : req.ip || req.socket?.remoteAddress || '');
  return ip.replace(/^::ffff:/, ''); // strip IPv4-mapped-IPv6 prefix
};

const ipGeolocate = (ip) => new Promise(resolve => {
  if (!ip || ip === '127.0.0.1' || ip === '::1' || /^(10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.)/.test(ip)) {
    return resolve(null); // private/local IP — nothing to check (dev/behind-LB edge cases)
  }
  const req = http.get(`http://ip-api.com/json/${encodeURIComponent(ip)}?fields=status,lat,lon,countryCode`, { timeout: 2500 }, resp => {
    let data = '';
    resp.on('data', c => data += c);
    resp.on('end', () => {
      try {
        const parsed = JSON.parse(data);
        resolve(parsed.status === 'success' ? parsed : null);
      } catch { resolve(null); }
    });
  });
  req.on('error', () => resolve(null));
  req.on('timeout', () => { req.destroy(); resolve(null); });
});

// Fire-and-forget — called AFTER the check-in response is already sent, so
// this never adds latency to the employee's check-in. Looks up the block's
// coordinates itself so the caller doesn't need to thread them through.
const flagCheckinIfIpMismatch = async (recordId, req, assignedBlockName) => {
  try {
    const geo = await ipGeolocate(clientIp(req));
    if (!geo) return; // lookup unavailable/failed — don't flag on missing data
    if (geo.countryCode && geo.countryCode !== 'IN') {
      await AttendanceRecord.findByIdAndUpdate(recordId, {
        $set: { location_flagged: true, location_flag_reason: `Request IP resolved outside India (${geo.countryCode}) while GPS claimed Tripura` },
      });
      return;
    }
    if (!assignedBlockName || geo.lat == null || geo.lon == null) return;
    const block = await CustomBlock.findOne({ block_name: assignedBlockName }).select('latitude longitude').lean();
    if (block?.latitude == null || block?.longitude == null) return;
    const km = haversineMeters(geo.lat, geo.lon, block.latitude, block.longitude) / 1000;
    if (km > IP_GEO_MISMATCH_KM) {
      await AttendanceRecord.findByIdAndUpdate(recordId, {
        $set: { location_flagged: true, location_flag_reason: `Request IP location is ~${Math.round(km)}km from the assigned block despite GPS matching it` },
      });
    }
  } catch (err) { console.error('[CheckIn] IP geolocation flag failed:', err.message); }
};

// ── Holiday / working-day helpers ────────────────────────────────────────
const LEAVE_HOLIDAYS_MMDD = new Set([
  '01-14','01-23','01-26','03-04','03-21','04-03','04-14','04-15','04-21',
  '05-01','05-26','05-27','06-26','07-22','08-04','08-15','08-19','08-26',
  '09-04','10-02','10-17','10-19','10-20','10-21','10-22','10-23','10-26',
  '11-09','12-25',
  '01-01','03-03','03-25','03-31','06-20','07-16','08-12','08-28',
  '09-11','09-18','11-11','11-24','12-03','12-24',
]);
// Dynamic holiday cache from DB (refreshed hourly, falls back to static list)
let _attHolCache = null;
let _attHolCacheAt = 0;
const refreshAttHolCache = async () => {
  try {
    const { Holiday } = require('../models/database');
    const rows = await Holiday.find({}, { date: 1, _id: 0 }).lean();
    _attHolCache = new Set(rows.map(h => h.date));
    _attHolCacheAt = Date.now();
  } catch { /* keep using static */ }
};
refreshAttHolCache();

const isLeaveNonWorking = iso => {
  const [y, m, d] = iso.split('-').map(Number);
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay(); // timezone-independent day-of-week
  if (dow === 0 || dow === 6) return true;
  if (_attHolCache && Date.now() - _attHolCacheAt < 3600000)
    return _attHolCache.has(iso);
  refreshAttHolCache().catch(() => {});
  return LEAVE_HOLIDAYS_MMDD.has(iso.substring(5));
};
const countWorkingDays = (startISO, endISO) => {
  let count = 0;
  const cur = new Date(startISO + 'T00:00:00+05:30');
  const fin = new Date(endISO   + 'T00:00:00+05:30');
  while (cur <= fin) {
    const iso = cur.toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
    if (!isLeaveNonWorking(iso)) count++;
    cur.setDate(cur.getDate() + 1);
  }
  return count || 1;
};
// Leave-balance cost of a request, in days. 'Half Day' has been removed as a
// leave type — every leave now costs a full working day, so this is just
// countWorkingDays(); kept as a named wrapper since callers already read as
// "day cost of this leave request".
const leaveDayUnits = (leaveType, startISO, endISO) => countWorkingDays(startISO, endISO);
const addDays = (isoDate, n) => {
  const d = new Date(isoDate + 'T00:00:00+05:30');
  d.setDate(d.getDate() + n);
  return d.toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
};

// ── Slug helper for folder names (e.g. "Krishna Kumar" → "krishna-kumar") ──
const slugify = (str = '') =>
  String(str)
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'user';
// ── Multer — selfie images ────────────────────────────────────────────────
const upload = multer({
  storage: multer.memoryStorage(),
  limits:  { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (!file.mimetype.startsWith('image/')) return cb(new Error('Only images allowed'));
    const ext = path.extname(file.originalname).toLowerCase();
    const ok  = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp'];
    if (!ok.includes(ext)) return cb(new Error('Invalid file extension'));
    const map = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.gif': 'image/gif', '.webp': 'image/webp', '.bmp': 'image/bmp' };
    if (map[ext] && map[ext] !== file.mimetype) return cb(new Error('File extension does not match file type'));
    cb(null, true);
  },
});

// ── Multer — reapply supporting documents (images + PDFs + Office docs) ──
const REAPPLY_EXT_MIME = {
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
  '.gif': 'image/gif',  '.webp': 'image/webp',
  '.pdf': 'application/pdf',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.xls': 'application/vnd.ms-excel',
};
const reapplyUpload = multer({
  storage: multer.memoryStorage(),
  limits:  { fileSize: 10 * 1024 * 1024, files: 10 },
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (!REAPPLY_EXT_MIME[ext]) return cb(new Error('File type not allowed'));
    const expectedMime = REAPPLY_EXT_MIME[ext];
    if (file.mimetype !== expectedMime) return cb(new Error('File extension does not match file type'));
    cb(null, true);
  },
});


// ── Multer — scan documents ───────────────────────────────────────────────
const uploadScan = multer({
  storage: multer.memoryStorage(),
  limits:  { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ok = ['image/jpeg', 'image/png', 'image/webp', 'image/bmp', 'application/pdf'];
    if (!ok.includes(file.mimetype)) return cb(new Error('Only JPG, PNG, WEBP or PDF accepted'));
    cb(null, true);
  },
});

const uploadSignedReport = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ok = ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'];
    if (!ok.includes(file.mimetype)) return cb(new Error('Only JPG, PNG, WEBP or PDF accepted'));
    cb(null, true);
  },
});

// ── Notification helper ───────────────────────────────────────────────────
const notify = async (userId, title, message, type = 'info', recordId = null, link = null) =>
  Notification.create({ _id: uuidv4(), user_id: userId, title, message, type, related_record_id: recordId, link });

// Formats a record's date for display — a plain day, or "D1 to D2" when a
// multi-day leave's end_date extends past its (start-only) date field.
const recordDateLabel = (record) =>
  (record.end_date && record.end_date > record.date) ? `${record.date} to ${record.end_date}` : record.date;

// Finds the AttendanceRecord (if any) that already "covers" a given date
// for this employee — either its own `date` field equals that day, or the
// day falls inside a multi-day record's [date, end_date] span. A plain
// `findOne({emp_id, date})` only catches an exact same-day match and misses
// every day after a multi-day leave's first day, letting an employee check
// in (or an admin apply/mark a conflicting record) on a day they already
// have an approved/pending leave covering.
const findRecordCoveringDate = (empId, dateStr) =>
  AttendanceRecord.findOne({
    emp_id: empId,
    $or: [
      { date: dateStr },
      { date: { $lte: dateStr }, end_date: { $gte: dateStr } },
    ],
  }).lean();

// Same idea, but for checking a NEW [startDate, endDate] request against
// existing records — used when the thing being created is itself a range
// (a multi-day leave application), where checking only the new request's
// start day would miss an existing record that conflicts with day 2+ of
// the new range. Two ranges [a1,a2] and [b1,b2] overlap iff a1<=b2 && b1<=a2;
// an existing single-day record (end_date null) is treated as [date,date].
const findOverlappingRecord = (empId, startDate, endDate) =>
  AttendanceRecord.findOne({
    emp_id: empId,
    date: { $lte: endDate },
    $or: [
      { end_date: { $gte: startDate } },
      { end_date: null, date: { $gte: startDate } },
    ],
  }).lean();

// A leave that was rejected and the employee never actually checked in —
// functionally "didn't happen", so unlike a Pending/Approved leave or real
// attendance, it's safe to let another action (checkin, admin mark-present)
// claim that specific day instead of blocking on it.
const isRejectedNoCheckinLeave = (rec) =>
  !!rec && (rec.duty_type === 'Leave' || (rec.leave_type && String(rec.leave_type).trim())) &&
  (rec.leave_status === 'Rejected' || rec.status === 'Rejected') &&
  !(rec.checkin_time || rec.checkinTime);

// Frees a single `date` out of a covering record's [date, end_date] span
// WITHOUT touching `date` itself — the caller creates/updates its own
// record for that day separately. Only ever called on a rejected-no-
// checkin leave (see isRejectedNoCheckinLeave); a single-day record is
// simply deleted (nothing left to preserve), an edge day shrinks the range
// forward/backward, and a day strictly inside the range splits the record
// in two so both the days before and after `date` keep their rejected-
// leave history instead of silently losing it.
const carveOutDate = async (record, date) => {
  const isSingleDay = !record.end_date || record.end_date <= record.date;
  if (isSingleDay) {
    await AttendanceRecord.findByIdAndDelete(record._id);
    return;
  }
  if (date === record.date) {
    await AttendanceRecord.findByIdAndUpdate(record._id, { $set: { date: addDays(date, 1) } });
    return;
  }
  if (date === record.end_date) {
    await AttendanceRecord.findByIdAndUpdate(record._id, { $set: { end_date: addDays(date, -1) } });
    return;
  }
  // date is strictly inside the range — split into a "before" piece (kept
  // on the original record) and an "after" piece (a new cloned record).
  const afterStart = addDays(date, 1);
  const afterEnd = record.end_date;
  await AttendanceRecord.findByIdAndUpdate(record._id, { $set: { end_date: addDays(date, -1) } });
  const clone = { ...record };
  delete clone._id;
  clone.date = afterStart;
  clone.end_date = afterEnd;
  await AttendanceRecord.create({ _id: uuidv4(), ...clone });
};

// ── Shared tail for admin attendance-correction endpoints (regularize,
// manual-checkout, …): notify the employee, write the audit log, respond. ──
const finishAdminCorrection = async (req, res, record, { notifyTitle, notifyMsg, auditAction, auditNewValue, auditOldValue, successMsg }) => {
  await notify(record.emp_id, notifyTitle, notifyMsg, 'success', record._id, '/employee/history');
  await AuditLog.create({
    _id: uuidv4(), user_id: req.user.id, action: auditAction,
    entity_type: 'attendance', entity_id: record._id,
    old_value: auditOldValue ?? record.status, new_value: auditNewValue,
  });
  const updated = await AttendanceRecord.findById(record._id).lean();
  res.json({ success: true, message: successMsg, data: formatRecord(updated) });
};

// ── Aggregation pipeline helper ───────────────────────────────────────────
const recordListPipeline = (match, sort, skip, limit) => [
  { $match: match },
  { $lookup: { from: 'users', localField: 'emp_id',      foreignField: '_id', as: 'emp'             } },
  { $lookup: { from: 'users', localField: 'manager_id',  foreignField: '_id', as: 'manager'         } },
  { $lookup: { from: 'users', localField: 'actioned_by', foreignField: '_id', as: 'actioned_by_user' } },
  { $addFields: {
    emp_name:          { $arrayElemAt: ['$emp.name',               0] },
    emp_code:          { $arrayElemAt: ['$emp.emp_id',             0] },
    department:        { $arrayElemAt: ['$emp.department',         0] },
    emp_face_photo:    { $arrayElemAt: ['$emp.facePhotoUrl',       0] },
    emp_profile_photo: { $arrayElemAt: ['$emp.profile_photo_path', 0] },
    manager_name:      { $arrayElemAt: ['$manager.name',           0] },
    actioned_by_name:  { $arrayElemAt: ['$actioned_by_user.name',  0] },
  }},
  { $project: { emp: 0, manager: 0, actioned_by_user: 0 } },
  { $sort: sort },
  { $skip: skip },
  { $limit: limit },
];

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/attendance
// ─────────────────────────────────────────────────────────────────────────────
router.get('/', authenticate, async (req, res) => {
  try {
    const { status, startDate, endDate, empId, onlyLeaves } = req.query;
    const page   = Math.max(1, parseInt(req.query.page)  || 1);
    const limit  = Math.min(100, Math.max(1, parseInt(req.query.limit) || 20));
    const offset = (page - 1) * limit;
    const match  = {};

    if (req.user.role === 'employee')
      match.emp_id = req.user.id;
    else if (req.user.role === 'manager') {
      if (empId) {
        const emp = await User.findOne({ _id: empId, manager_id: req.user.id }).lean();
        if (!emp) return res.status(403).json({ success: false, message: 'Not your team member' });
        match.emp_id = empId;
      } else {
        const teamMembers = await User.find({ manager_id: req.user.id }).select('_id').lean();
        match.emp_id = { $in: teamMembers.map(m => m._id) };
      }
    } else if (['admin', 'hr', 'super_admin'].includes(req.user.role)) {
      if (empId) match.emp_id = empId;
    }

    const todayIST = istDateStr();
    const andConds = [];

    // onlyLeaves=true → leave applications OR missed-checkout records
    // (flagged by the midnight cron, or a Draft the cron hasn't reached
    // yet), so the Leaves page's "Missed Check-out" column has data.
    if (onlyLeaves === 'true') {
      andConds.push({
        $or: [
          { leave_type: { $ne: null } },
          { is_missed_checkout: true },
          { status: 'Draft', checkin_time: { $ne: null }, checkout_time: null, date: { $lt: todayIST } },
        ],
      });
    }

    if (status) {
      const isManagerOrAdmin = ['manager', 'admin', 'hr', 'super_admin'].includes(req.user.role);
      if (status === 'Pending' && isManagerOrAdmin) {
        andConds.push({
          $or: [
            { status: 'Pending' },
            { status: 'Draft', date: { $lt: todayIST }, checkin_time: { $ne: null }, checkout_time: null },
          ],
        });
      } else if (status === 'Missed Check-out') {
  andConds.push({
    $or: [
      { is_missed_checkout: true, checkout_time: null },              // ✅ still actually missing
      { status: 'Draft', checkin_time: { $ne: null }, checkout_time: null, date: { $lt: todayIST } },
    ],
  });
} else if (onlyLeaves === 'true') {
        andConds.push({ $or: [{ leave_status: status }, { is_missed_checkout: true, status } ] });
      } else {
        match.status = status;
      }
    }

    if (startDate) match.date = { ...match.date, $gte: startDate };
    if (endDate)   match.date = { ...match.date, $lte: endDate };

    if (andConds.length) match.$and = andConds;

    const total   = await AttendanceRecord.countDocuments(match);
    const records = await AttendanceRecord.aggregate(
      recordListPipeline(match, { date: -1, created_at: -1 }, offset, limit)
    );

    const formatted = records.map(r => {
      const rec = formatRecord(r);
      if (r.status === 'Draft' && r.date < todayIST && r.checkin_time && !r.checkout_time) {
        rec.isMissedCheckout = true;
        rec.status           = 'Pending';
        rec.checkoutRemarks  = rec.checkoutRemarks || 'Employee did not check out. Requires manager approval.';
      }
      return rec;
    });

    res.json({ success: true, data: formatted, pagination: { total, page, limit, pages: Math.ceil(total / limit) } });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/attendance/today
// ─────────────────────────────────────────────────────────────────────────────
router.get('/today', authenticate, async (req, res) => {
  try {
    const today = istDateStr();

    // Check for an unresolved missed check-out from a previous day BEFORE
    // returning today's record — the employee is blocked from acting on
    // today until their manager approves/rejects the old one.
    const sevenDaysAgo = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
    const sevenDaysAgoStr = sevenDaysAgo.toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });

   const prevRecord = await AttendanceRecord.findOne({
  emp_id:       req.user.id,
  date:         { $gte: sevenDaysAgoStr, $lt: today },
  checkin_time: { $ne: null },
  status:       { $in: ['Pending', 'Draft'] },   // ✅ drop 'Approved'
}).sort({ date: -1 }).lean();

if (prevRecord && !prevRecord.checkout_time) {
  const isUnresolvedMissed =
    (prevRecord.is_missed_checkout === true && prevRecord.status === 'Pending') || // ✅ only while still pending
    (prevRecord.status === 'Draft' && prevRecord.date < today);
  if (isUnresolvedMissed) {
    return res.status(403).json({
      success: false,
      message: `You did not check out on ${prevRecord.date}. You cannot check in until your manager approves or rejects that missed check-out.`,
      blockedByMissedCheckout: {
        recordId:    prevRecord._id,
        date:        prevRecord.date,
        checkinTime: prevRecord.checkin_time,
      },
    });
  }
}

    const rows = await AttendanceRecord.aggregate([
      { $match: { emp_id: req.user.id, date: today } },
      { $lookup: { from: 'users', localField: 'emp_id', foreignField: '_id', as: 'emp' } },
      { $addFields: { emp_name: { $arrayElemAt: ['$emp.name', 0] }, emp_code: { $arrayElemAt: ['$emp.emp_id', 0] } } },
      { $project: { emp: 0 } },
    ]);
    res.json({
      success: true,
      data: rows.length ? formatRecord(rows[0]) : null,
    });
  } catch (err) { console.error(err); res.status(500).json({ success: false, message: 'Server error' }); }
});

// ─────────────────────────────────────────────────────────────────────────────
// ─────────────────────────────────────────────────────────────────────────────
// GET /api/attendance/today-checkin-status
// Returns today's check-in status map { [emp_id]: { checkedIn, checkedOut,
// checkinTime, checkoutTime, status } } for admin/hr/super_admin/manager.
// Used by the admin Users page to show live check-in badges.
// ─────────────────────────────────────────────────────────────────────────────
router.get('/today-checkin-status', authenticate, authorize('admin', 'hr', 'super_admin', 'manager'), async (req, res) => {
  try {
    // Accept an optional ?date=YYYY-MM-DD for historical reports;
    // default to today (IST) when not supplied or invalid.
    const requestedDate = req.query.date;
    const isValidDate   = requestedDate && /^\d{4}-\d{2}-\d{2}$/.test(requestedDate);
    const today = isValidDate ? requestedDate : istDateStr();

    let empFilter = {};
    if (req.user.role === 'manager') {
      const team = await User.find({ manager_id: req.user.id }).select('_id').lean();
      empFilter = { emp_id: { $in: team.map(m => String(m._id)) } };
    }

    const leaveFilter = {
      $or: [
        { date: today, end_date: null },
        { date: { $lte: today }, end_date: { $gte: today } },
      ],
    };
    const [records, approvedLeaves, pendingLeaves] = await Promise.all([
      // duty_type != 'Leave' — a record converted to leave (see PUT
      // /convert-to-leave) keeps its original checkin_time/checkout_time
      // for audit history, so without this exclusion it would still match
      // here and show as "Checked Out" instead of falling through to the
      // approvedLeaves/pendingLeaves queries below where it now belongs.
      AttendanceRecord.find(
        { date: today, checkin_time: { $ne: null }, duty_type: { $ne: 'Leave' }, ...empFilter },
        'emp_id checkin_time checkout_time status attendance_type leave_type is_missed_checkout'
      ).lean(),
      AttendanceRecord.find(
        { duty_type: 'Leave', leave_status: 'Approved', ...leaveFilter, ...empFilter },
        'emp_id leave_type paid_days is_lop'
      ).lean(),
      AttendanceRecord.find(
        { duty_type: 'Leave', leave_status: 'Pending', ...leaveFilter, ...empFilter },
        'emp_id leave_type'
      ).lean(),
    ]);

    const statusMap = {};
    records.forEach(r => {
      statusMap[String(r.emp_id)] = {
        recordId:        r._id,
        checkedIn:       true,
        checkedOut:      !!r.checkout_time,
        checkinTime:      r.checkin_time  || null,
        checkoutTime:     r.checkout_time || null,
        status:           r.status,
        attendanceType:   r.attendance_type || null,
        leaveType:        r.leave_type      || null,
        isMissedCheckout: r.is_missed_checkout === true,
      };
    });
    approvedLeaves.forEach(r => {
      const uid = String(r.emp_id);
      if (!statusMap[uid]) statusMap[uid] = { onLeave: true, leaveType: r.leave_type || 'Leave', recordId: r._id, paidDays: r.paid_days ?? 0, isLop: !!r.is_lop };
    });
    pendingLeaves.forEach(r => {
      const uid = String(r.emp_id);
      if (!statusMap[uid]) statusMap[uid] = { pendingLeave: true, leaveType: r.leave_type || 'Leave' };
    });

    res.json({ success: true, data: statusMap });
  } catch (err) {
    console.error('[TodayCheckinStatus]', err.message);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});
// GET /api/attendance/:id
// ─────────────────────────────────────────────────────────────────────────────
router.get('/:id', authenticate, async (req, res) => {
  try {
    const rows = await AttendanceRecord.aggregate([
      { $match: { _id: req.params.id } },
      { $lookup: { from: 'users', localField: 'emp_id',      foreignField: '_id', as: 'emp'             } },
      { $lookup: { from: 'users', localField: 'manager_id',  foreignField: '_id', as: 'manager'         } },
      { $lookup: { from: 'users', localField: 'actioned_by', foreignField: '_id', as: 'actioned_by_user'} },
      { $addFields: {
        emp_name:          { $arrayElemAt: ['$emp.name',               0] },
        emp_code:          { $arrayElemAt: ['$emp.emp_id',             0] },
        department:        { $arrayElemAt: ['$emp.department',         0] },
        emp_phone:         { $arrayElemAt: ['$emp.phone',              0] },
       // both aggregation pipelines (recordListPipeline + GET /:id)
emp_face_photo: { $arrayElemAt: ['$emp.profile_photo_path', 0] },
        emp_profile_photo: { $arrayElemAt: ['$emp.profile_photo_path', 0] },
        manager_name:      { $arrayElemAt: ['$manager.name',           0] },
        manager_email:     { $arrayElemAt: ['$manager.email',          0] },
        actioned_by_name:  { $arrayElemAt: ['$actioned_by_user.name',  0] },
      }},
      { $project: { emp: 0, manager: 0, actioned_by_user: 0 } },
    ]);
    if (!rows.length) return res.status(404).json({ success: false, message: 'Record not found' });
    const record = rows[0];
    if (req.user.role === 'employee' && record.emp_id !== req.user.id) return res.status(403).json({ success: false, message: 'Access denied' });
    if (req.user.role === 'manager'  && record.manager_id !== req.user.id) return res.status(403).json({ success: false, message: 'Access denied' });
    res.json({ success: true, data: formatRecord(record) });
  } catch (err) { console.error(err); res.status(500).json({ success: false, message: 'Server error' }); }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/attendance/checkin
// ─────────────────────────────────────────────────────────────────────────────
// router.post('/checkin', authenticate, authorize('employee'), upload.single('selfie'), [
//   body('dutyType').isIn(['Office Duty', 'On Duty', 'On Duty Away']),
//   body('latitude').isFloat(),
//   body('longitude').isFloat(),
// ], async (req, res) => {
//   const errors = validationResult(req);
//   if (!errors.isEmpty()) return res.status(400).json({ success: false, errors: errors.array() });

//   try {
//     const today = istDateStr();

//     // Block if the most recent past attendance (within last 7 days) has no activity
//     const sevenDaysAgo = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
//     sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
//     const sevenDaysAgoStr = sevenDaysAgo.toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });

//     const prevRecord = await AttendanceRecord.findOne({
//       emp_id:       req.user.id,
//       date:         { $gte: sevenDaysAgoStr, $lt: today },
//       checkin_time: { $ne: null },
//       status:       { $in: ['Approved', 'Pending', 'Draft'] },
//     }).sort({ date: -1 }).lean();

//     // ── Block check-in if the previous day's missed check-out is still
//     // unresolved (Pending manager review, or a Draft that the midnight
//     // cron hasn't flagged yet). Once the manager approves or rejects it,
//     // status moves to 'Approved' / 'Rejected' and this no longer matches.
//     if (prevRecord && !prevRecord.checkout_time) {
//       const isUnresolvedMissed =
//         prevRecord.is_missed_checkout === true ||
//         (prevRecord.status === 'Draft' && prevRecord.date < today);
//       if (isUnresolvedMissed) {
//         return res.status(403).json({
//           success: false,
//           message: `You did not check out on ${prevRecord.date}. You cannot check in until your manager approves or rejects that missed check-out.`,
//           blockedByMissedCheckout: {
//             recordId:     prevRecord._id,
//             date:         prevRecord.date,
//             checkinTime:  prevRecord.checkin_time,
//           },
//         });
//       }
//     }

//     const existing = await AttendanceRecord.findOne({ emp_id: req.user.id, date: today }).lean();
//     let existingRejectedLeaveId = null;
//     if (existing) {
//       const isRejectedLeave =
//         (existing.duty_type === 'Leave' || (existing.leave_type && existing.leave_type.trim())) &&
//         (existing.leave_status === 'Rejected' || existing.status === 'Rejected') &&
//         !existing.checkin_time;
//       if (!isRejectedLeave) {
//         return res.status(409).json({ success: false, message: 'Attendance already recorded for today' });
//       }
//       existingRejectedLeaveId = existing._id;
//     }

//     if (!req.file) {
//       return res.status(400).json({ success: false, message: 'Selfie is required for check-in.' });
//     }
//     // attendance.js — checkin
// const currentUserInfo = await User.findById(req.user.id).select('name profile_photo_path').lean();
// const faceResult = await verifyFace(req.file.buffer, currentUserInfo?.profile_photo_path, req.file.mimetype);
// if (!faceResult.match) {
//   return res.status(400).json({
//     success:        false,
//     faceVerifyError: true,
//     faceConfidence: faceResult.confidence,
//     message:        faceResult.reason,
//   });
// }
//     const { dutyType, sector, description, latitude, longitude, locationAddress, capturedAt, capturedDate } = req.body;

//     if (dutyType === 'On Duty' && !sector)
//       return res.status(400).json({ success: false, message: 'Sector is required for On Duty' });

//     const currentUser = await User.findById(req.user.id).select('manager_id name').lean();
//     const managerId   = currentUser?.manager_id || null;

//     // Always use server-generated time; ignore client-supplied values to prevent backdating
//     const checkinTime = istTimeStr();
//     const checkinDate = today;

//     // Upload selfie immediately
//     const _selfieExt = path.extname(req.file.originalname).replace('.', '') || 'jpg';
//     const selfiePath = await uploadFile(req.file.buffer, `ams/users/${req.user.emp_id || req.user.id}/selfies`, req.file.originalname, req.file.mimetype, makeDocName(req.user, 'checkin_selfie', _selfieExt));

//     let id = uuidv4();
//     const checkinFields = {
//       emp_id: req.user.id, date: checkinDate, duty_type: dutyType, sector: sector || null,
//       description: description || '', status: 'Draft', selfie_path: selfiePath,
//       latitude: parseFloat(latitude), longitude: parseFloat(longitude),
//       location_address: locationAddress || '', checkin_time: checkinTime,
//       checkin_lat: parseFloat(latitude), checkin_lng: parseFloat(longitude),
//       manager_id: managerId,
//       leave_type: null, leave_reason: null, leave_status: null, end_date: null,
//       checkout_time: null, worked_hours: null, submitted_at: null,
//       actioned_by: null, actioned_at: null, manager_remark: null,
//       hr_override: false, hr_remark: null, override_remark: null,
//       overridden_by: null, hr_actioned_at: null,
//       is_missed_checkout: false, checkout_remarks: null,
//      face_verification_status: 'verified',
//   face_confidence:          faceResult.confidence,
//     };

//     if (existingRejectedLeaveId) {
//       await AttendanceRecord.findByIdAndUpdate(existingRejectedLeaveId, { $set: checkinFields });
//       id = existingRejectedLeaveId;
//     } else {
//       await AttendanceRecord.create({ _id: id, ...checkinFields });
//     }

//     await AuditLog.create({ _id: uuidv4(), user_id: req.user.id, action: 'CHECKIN', entity_type: 'attendance', entity_id: id });
//     const record = await AttendanceRecord.findById(id).lean();

//     res.status(201).json({
//       success:             true,
//       message:             'Check-in recorded!',
//       verificationPending: false,
//       data:                formatRecord(record),
//     });

//   } catch (err) {
//     // Only reached if an error occurs BEFORE res.status(201) was sent
//     if (!res.headersSent) {
//       console.error('[CheckIn] Error:', err.message || err);
//       res.status(500).json({ success: false, message: 'Server error' });
//     } else {
//       console.error('[CheckIn] Post-response error (non-fatal):', err.message || err);
//     }
//   }
// });
router.post('/checkin', authenticate, authorize('employee'), upload.single('selfie'), [
  body('dutyType').isIn(['Office Duty', 'On Duty', 'On Duty Away']),
  body('latitude').isFloat(),
  body('longitude').isFloat(),
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ success: false, errors: errors.array() });

  try {
    const today = istDateStr();

    const sevenDaysAgo = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
    const sevenDaysAgoStr = sevenDaysAgo.toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });

   const prevRecord = await AttendanceRecord.findOne({
  emp_id:       req.user.id,
  date:         { $gte: sevenDaysAgoStr, $lt: today },
  checkin_time: { $ne: null },
  status:       { $in: ['Pending', 'Draft'] },   // ✅ drop 'Approved'
}).sort({ date: -1 }).lean();

if (prevRecord && !prevRecord.checkout_time) {
  const isUnresolvedMissed =
    (prevRecord.is_missed_checkout === true && prevRecord.status === 'Pending') || // ✅ only while still pending
    (prevRecord.status === 'Draft' && prevRecord.date < today);
  if (isUnresolvedMissed) {
    return res.status(403).json({
      success: false,
      message: `You did not check out on ${prevRecord.date}. You cannot check in until your manager approves or rejects that missed check-out.`,
      blockedByMissedCheckout: {
        recordId:     prevRecord._id,
        date:         prevRecord.date,
        checkinTime:  prevRecord.checkin_time,
      },
    });
  }
}

    const existing = await findRecordCoveringDate(req.user.id, today);
    if (existing) {
      // A rejected leave the employee never checked in for didn't actually
      // happen — free up just today (splitting the record if it's a multi-
      // day range, e.g. a rejected 4-day leave where today is day 3) so the
      // employee can still check in, without losing the rejected-leave
      // history on the OTHER days of that range.
      if (isRejectedNoCheckinLeave(existing)) {
        await carveOutDate(existing, today);
      } else {
        return res.status(409).json({ success: false, message: 'Attendance already recorded for today' });
      }
    }

    if (!req.file) {
      return res.status(400).json({ success: false, message: 'Selfie is required for check-in.' });
    }

    const currentUserInfo = await User.findById(req.user.id).select('manager_id name email profile_photo_path assigned_block assigned_district checkin_geofence_exempt').lean();

    if (!currentUserInfo?.profile_photo_path) {
      return res.status(400).json({
        success: false,
        message: 'No profile photo enrolled. Go to My Profile to upload your face photo.',
      });
    }

    const { dutyType, sector, description, latitude, longitude, locationAddress } = req.body;
    const lat = parseFloat(latitude), lng = parseFloat(longitude);

    if (dutyType === 'On Duty' && !sector)
      return res.status(400).json({ success: false, message: 'Sector is required for On Duty' });

    // On Duty requires a filled-in purpose/location description (the client
    // pre-fills a template — this just guards against submitting it blank
    // or untouched) — see ON_DUTY_DESCRIPTION_MIN_LEN below.
    if (dutyType === 'On Duty' && (!description || description.trim().length < 15)) {
      return res.status(400).json({ success: false, message: 'Please describe the purpose and location of your visit for On Duty check-in.' });
    }
    // On Duty Away also needs a reason — it's what the manager sees when
    // deciding whether to approve an unplanned away check-in (see odaPending below).
    if (dutyType === 'On Duty Away' && (!description || !description.trim())) {
      return res.status(400).json({ success: false, message: 'Please provide a reason for On Duty Away check-in.' });
    }

    if (['Office Duty', 'On Duty'].includes(dutyType) && (!Number.isFinite(lat) || !Number.isFinite(lng))) {
      return res.status(400).json({ success: false, message: 'A valid GPS location is required to check in.' });
    }

    // checkin_geofence_exempt is an admin/super_admin-only per-employee
    // override (see users.js PUT /:id) — for the few people who genuinely
    // need to check in from anywhere, skips both location restrictions
    // below entirely rather than weakening the block/district config that
    // still applies to everyone else.
    const geofenceExempt = currentUserInfo?.checkin_geofence_exempt === true;

    // Office Duty — hard-restricted to the employee's assigned block. A
    // missing assigned_block or missing block coordinates used to silently
    // skip this check (letting Office Duty check in from anywhere); now it
    // blocks the check-in instead, since "restricted to the office" is the
    // whole point of this duty type.
    if (dutyType === 'Office Duty' && !geofenceExempt) {
      if (!currentUserInfo?.assigned_block) {
        return res.status(403).json({ success: false, message: 'No block is assigned to your profile — contact admin before checking in as Office Duty.' });
      }
      const block = await CustomBlock.findOne({ block_name: currentUserInfo.assigned_block }).select('latitude longitude').lean();
      if (block?.latitude == null || block?.longitude == null) {
        return res.status(403).json({ success: false, message: `Your assigned block (${currentUserInfo.assigned_block}) has no GPS coordinates configured yet — contact admin.` });
      }
      const distance = haversineMeters(lat, lng, block.latitude, block.longitude);
      if (distance > CHECKIN_GEOFENCE_METERS) {
        return res.status(403).json({
          success: false,
          message: `You are ${Math.round(distance)}m from ${currentUserInfo.assigned_block} — check-in is only allowed within ${CHECKIN_GEOFENCE_METERS}m of your assigned block.`,
        });
      }
    }

    // On Duty — allowed anywhere in the employee's assigned district (see
    // ON_DUTY_DISTRICT_GEOFENCE_METERS). Skipped if no district is assigned
    // or the district has no blocks with coordinates yet, same "don't block
    // on missing admin setup" fallback as before for this duty type.
    if (dutyType === 'On Duty' && !geofenceExempt && currentUserInfo?.assigned_district) {
      const districtBlocks = await CustomBlock.find({
        district: currentUserInfo.assigned_district,
        latitude: { $ne: null }, longitude: { $ne: null },
      }).select('latitude longitude').lean();
      if (districtBlocks.length) {
        const nearestMeters = Math.min(...districtBlocks.map(b => haversineMeters(lat, lng, b.latitude, b.longitude)));
        if (nearestMeters > ON_DUTY_DISTRICT_GEOFENCE_METERS) {
          return res.status(403).json({
            success: false,
            message: `You appear to be outside your assigned district (${currentUserInfo.assigned_district}) — On Duty check-in is only allowed within it.`,
          });
        }
      }
    }

    // On Duty Away — no GPS restriction (it's an away visit by definition).
    // If the employee already has an admin-approved ODA request covering
    // today, this check-in proceeds normally like any other duty type. If
    // not, it's still allowed, but is filed as a pending approval for the
    // employee's manager instead of counting immediately — see checkinFields
    // below and the manager-notification block after the record is created.
    let odaPending = false;
    if (dutyType === 'On Duty Away') {
      const approvedOda = await ODARequest.findOne({
        emp_id: req.user.id, status: 'approved',
        from_date: { $lte: today }, to_date: { $gte: today },
      }).lean();
      odaPending = !approvedOda;
    }

    const managerId = currentUserInfo?.manager_id || null;
    const checkinTime = istTimeStr();
    const checkinDate = today;

    const _selfieExt = path.extname(req.file.originalname).replace('.', '') || 'jpg';
    const selfiePath = await uploadFile(req.file.buffer, `ams/users/${req.user.emp_id || req.user.id}/selfies`, req.file.originalname, req.file.mimetype, makeDocName(req.user, 'checkin_selfie', _selfieExt));

    let id = uuidv4();
    const checkinFields = {
      emp_id: req.user.id, date: checkinDate, duty_type: dutyType, sector: sector || null,
      description: description || '', status: odaPending ? 'Pending' : 'Draft', selfie_path: selfiePath,
      latitude: parseFloat(latitude), longitude: parseFloat(longitude),
      location_address: locationAddress || '', checkin_time: checkinTime,
      checkin_lat: parseFloat(latitude), checkin_lng: parseFloat(longitude),
      manager_id: managerId,
      leave_type: null, leave_reason: null, leave_status: null, end_date: null,
      checkout_time: null, worked_hours: null, submitted_at: null,
      actioned_by: null, actioned_at: null, manager_remark: null,
      hr_override: false, hr_remark: null, override_remark: null,
      overridden_by: null, hr_actioned_at: null,
      is_missed_checkout: false, checkout_remarks: null,
      face_verification_status: 'processing',
      face_confidence: null,
      face_retake_count: 0,
      face_retake_reason: null,
    };

    await AttendanceRecord.create({ _id: id, ...checkinFields });

    await AuditLog.create({ _id: uuidv4(), user_id: req.user.id, action: 'CHECKIN', entity_type: 'attendance', entity_id: id });
    const record = await AttendanceRecord.findById(id).lean();

    // Face verification (TF) removed — selfie is still captured/stored, not
    // matched. It was the root cause of repeated OOM crash-restarts on
    // Render (WASM tensor allocation exhausting the container's memory),
    // whether run synchronously or in the background as above.
    res.status(201).json({
      success:             true,
      message:             odaPending ? 'Check-in submitted — pending your manager\'s approval.' : 'Check-in recorded!',
      verificationPending: false,
      managerApprovalPending: odaPending,
      data:                formatRecord(record),
    });

    // On Duty Away without a pre-approved ODA — notify + email the manager
    // so they can approve/reject it from the same Queue they already use
    // for leave/missed-checkout, same pattern as apply-leave above.
    if (odaPending && managerId) {
      notify(managerId, 'On Duty Away — Approval Needed',
        `${currentUserInfo.name} checked in as On Duty Away today (${checkinDate}) without a pre-approved ODA request: ${description}`,
        'warning', id, '/manager/leaves').catch(() => {});
      User.findById(managerId).select('email name').then(manager => {
        if (manager?.email) {
          sendMail(manager.email, `[AMS] On Duty Away Approval Needed – ${currentUserInfo.name} (${checkinDate})`,
            `<p>Hi ${manager.name},</p><p><strong>${currentUserInfo.name}</strong> checked in as <strong>On Duty Away</strong> today (<strong>${checkinDate}</strong>) without a pre-approved ODA request.</p><p><strong>Reason:</strong> ${description}</p>`
          ).catch(err => console.error('[CheckIn] ODA-pending manager email failed:', err.message));
        }
      }).catch(() => {});
    }

    // Late-login email — fire-and-forget, doesn't block the response
    if (checkinTime > '10:00' && currentUserInfo?.email) {
      sendMail(
        currentUserInfo.email, '[AMS] ⚠️ Late Check-In Recorded',
        `<p>Hi ${currentUserInfo.name || 'there'},</p>
         <p style="font-size:15px;"><strong style="color:#DC2626;">Your check-in today (${checkinDate}) has been recorded as LATE — at ${fmt12h(checkinTime)}, after the 10:00 AM cutoff.</strong></p>
         <p>This late check-in is visible to your manager. Please ensure you check in before 10:00 AM going forward.</p>`
      ).catch(err => console.error('[CheckIn] Late-login email failed:', err.message));
    }

    // GPS is client-supplied and spoofable — corroborate with a coarse IP
    // geolocation, fire-and-forget so it never delays the response. Flags
    // the record for review only; never blocks or rejects the check-in.
    flagCheckinIfIpMismatch(id, req, currentUserInfo?.assigned_block).then(async () => {
      const flagged = await AttendanceRecord.findById(id).select('location_flagged location_flag_reason').lean();
      if (flagged?.location_flagged && currentUserInfo?.manager_id) {
        await notify(
          currentUserInfo.manager_id,
          '⚠️ Check-in location flagged for review',
          `${currentUserInfo.name}'s check-in on ${checkinDate} was flagged: ${flagged.location_flag_reason}`,
          'warning', id, '/manager/leaves'
        ).catch(() => {});
      }
    }).catch(() => {});

  } catch (err) {
    if (!res.headersSent) {
      console.error('[CheckIn] Error:', err.message || err);
      res.status(500).json({ success: false, message: 'Server error' });
    } else {
      console.error('[CheckIn] Post-response error (non-fatal):', err.message || err);
    }
  }
});
// ─────────────────────────────────────────────────────────────────────────────
// DELETE /:id/cancel-checkin
// ─────────────────────────────────────────────────────────────────────────────
router.delete('/:id/cancel-checkin', authenticate, authorize('employee', 'super_admin'), async (req, res) => {
  try {
    const ownerFilter = req.user.role === 'super_admin'
      ? { _id: req.params.id }
      : { _id: req.params.id, emp_id: req.user.id };
    const record = await AttendanceRecord.findOne(ownerFilter).lean();
    if (!record)             return res.status(404).json({ success: false, message: 'Record not found' });
    if (record.status !== 'Draft') return res.status(400).json({ success: false, message: 'Only Draft records can be deleted' });
    if (record.checkout_time)      return res.status(400).json({ success: false, message: 'Already checked out — cannot delete' });

    const deleted = await AttendanceRecord.deleteOne({ _id: req.params.id });
    console.log('[CancelCheckin] deleteOne result:', deleted);

    try {
      await AuditLog.create({
        _id: uuidv4(), user_id: req.user.id, action: 'CANCEL_CHECKIN',
        entity_type: 'attendance', entity_id: req.params.id,
        old_value: record.status, new_value: 'DELETED',
      });
    } catch (auditErr) {
      console.error('[CancelCheckin] AuditLog failed (non-fatal):', auditErr.message);
    }

    res.json({ success: true, message: 'Check-in deleted. Employee can check in again.' });
  } catch (err) {
    console.error('[CancelCheckin] Error:', err);
    res.status(500).json({ success: false, message: err.message || 'Server error' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// PUT /api/attendance/:id/retake-face
// ─────────────────────────────────────────────────────────────────────────────
router.put('/:id/retake-face', authenticate, authorize('employee'), upload.single('selfie'), async (req, res) => {
  try {
    const record = await AttendanceRecord.findOne({ _id: req.params.id, emp_id: req.user.id }).lean();
    if (!record) return res.status(404).json({ success: false, message: 'Record not found' });
    if (!req.file)
      return res.status(400).json({ success: false, message: 'Selfie is required.' });

    const _rtExt = path.extname(req.file.originalname).replace('.', '') || 'jpg';
    const newSelfiePath = await uploadFile(req.file.buffer, `ams/users/${req.user.emp_id || req.user.id}/selfies`, req.file.originalname, req.file.mimetype, makeDocName(req.user, 'retake_selfie', _rtExt));

   // Face verification (TF) removed — retake just replaces the stored selfie.
const retakeResult = { match: true, confidence: 0 };
await AttendanceRecord.findByIdAndUpdate(req.params.id, {
  $set: { face_verification_status: 'verified', face_confidence: retakeResult.confidence, selfie_path: newSelfiePath },
});

    const updated = await AttendanceRecord.findById(req.params.id).lean();

    res.json({
      success:       true,
      message:       'Selfie updated.',
      retakePending: false,
      data:          formatRecord(updated),
    });

  } catch (err) {
    if (!res.headersSent) {
      console.error('[RetakeFace] Error:', err.message || err);
      res.status(500).json({ success: false, message: 'Server error' });
    }
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// PUT /api/attendance/:id/late-checkout-reason
// ─────────────────────────────────────────────────────────────────────────────
router.put('/:id/late-checkout-reason', authenticate, authorize('employee'), [
  body('reason').trim().notEmpty().withMessage('A reason is required'),
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ success: false, errors: errors.array() });
  try {
    const record = await AttendanceRecord.findOne({ _id: req.params.id, emp_id: req.user.id }).lean();
    if (!record)              return res.status(404).json({ success: false, message: 'Record not found' });
    if (record.checkout_time) return res.status(409).json({ success: false, message: 'Already checked out' });

    const { reason } = req.body;
    const now = new Date();
    // Extend by 2 hours (within the requested 15–20 min window)
   const extendedUntil = new Date(now.getTime() + 2 * 60 * 60 * 1000);

    const updated = await AttendanceRecord.findByIdAndUpdate(record._id, {
      $set: {
        late_checkout_reason:         reason,
        late_checkout_requested_at:   now,
        late_checkout_extended_until: extendedUntil,
      },
    }, { new: true }).lean();

    if (record.manager_id) {
      const emp = await User.findById(req.user.id).select('name').lean();
      await notify(
        record.manager_id,
        '🕕 Late Check-Out Reason',
        `${emp?.name || 'An employee'} will check out late today: "${reason}"`,
        'info', record._id, '/manager/leaves'
      );
    }
    // Also surface to admin-level roles (super_admin, hr) per the visibility rule
    const overseers = await User.find({ role: { $in: ['super_admin', 'hr'] }, is_active: { $ne: 0 } }).select('_id').lean();
    for (const o of overseers) {
      await notify(o._id, '🕕 Late Check-Out Reason', `${req.user.name || 'An employee'} will check out late today: "${reason}"`, 'info', record._id, '/admin/attendance');
    }

    await AuditLog.create({
      _id: uuidv4(), user_id: req.user.id, action: 'LATE_CHECKOUT_REASON',
      entity_type: 'attendance', entity_id: record._id, new_value: reason,
    });

    res.json({ success: true, message: 'Reason saved. Checkout window extended by 45 minutes.', data: formatRecord(updated) });
  } catch (err) { console.error(err); res.status(500).json({ success: false, message: 'Server error' }); }
});

// ─────────────────────────────────────────────────────────────────────────────
// PUT /api/attendance/:id/checkout
// ─────────────────────────────────────────────────────────────────────────────
router.put('/:id/checkout', authenticate, authorize('employee'), upload.single('checkoutSelfie'), async (req, res) => {
  try {
    const isEmergency = req.body.emergency === 'true' || req.body.emergency === true;
    const record = await AttendanceRecord.findOne({ _id: req.params.id, emp_id: req.user.id }).lean();
    if (!record)               return res.status(404).json({ success: false, message: 'Record not found' });
    if (record.checkout_time)  return res.status(409).json({ success: false, message: 'Already checked out' });
    // No status guard here on purpose. An "On Duty Away" check-in without a
    // pre-approved ODA request is filed status:'Pending' immediately at
    // check-in (see odaPending in /checkin) so the manager can review the
    // away-duty justification independently of the day's checkout. Once the
    // manager approves/rejects that justification the record flips straight
    // to Approved/Rejected — even though checkout_time is still null (the
    // same can happen via a face-verification manager review, or an HR
    // override applied to a still-open Draft record). A status check here
    // used to permanently block those employees from ever checking out for
    // the day. checkout_time===null (just confirmed above) is the only
    // invariant that matters — the block below always recomputes `status`
    // from hours worked, so it's safe to proceed from any prior status.
// ── Face verification on checkout selfie ────────────────────────────────
// ── Face verification on checkout selfie — runs in background below ────
if (!req.file) {
  return res.status(400).json({ success: false, message: 'Checkout selfie is required.' });
}
// Face verification (TF) removed — checkout selfie still captured/stored,
// not matched. It was the root cause of repeated OOM crash-restarts on
// Render, especially here where it ran synchronously and blocked the
// request while allocating tensors.
const checkoutFaceResult = { match: true, confidence: 0 };
    const now             = new Date();
    const checkinDateTime = new Date(`${record.date}T${record.checkin_time}:00+05:30`);
    const capturedAtBody  = req.body?.capturedAt;
    const timeRe          = /^\d{2}:\d{2}$/;
    const effectiveNow    = (capturedAtBody && timeRe.test(capturedAtBody))
      ? (() => { const d = new Date(`${record.date}T${capturedAtBody}:00+05:30`); return d <= now ? d : now; })()
      : now;

    const hoursElapsed = (effectiveNow - checkinDateTime) / 3600000;

    // Enforce 4-hour minimum unless emergency
    if (!isEmergency && hoursElapsed < 4) {
      const remaining = 4 - hoursElapsed;
      const h = Math.floor(remaining);
      const m = Math.floor((remaining - h) * 60);
      return res.status(400).json({
        success: false,
        message: `Check-out locked for ${h}h ${m}m more (minimum 4 hours after check-in).`,
        hoursRemaining: remaining,
      });
    }
 const today = istDateStr();
    const nowIST = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
    const isAfterCutoff = nowIST.getHours() > 18 || (nowIST.getHours() === 18 && nowIST.getMinutes() >= 31);
    if (record.date === today && isAfterCutoff && !record.late_checkout_reason) {
      return res.status(400).json({
        success: false,
        message: 'A late check-out reason is required after 6:30 PM. Please submit a reason first.',
      });
    }
    // Require a human-readable text address on checkout, not just raw
    // GPS coordinates — the frontend should reverse-geocode via /api/geocode
    // and send the resolved string as `locationAddress`.
    if (!req.body.locationAddress || !String(req.body.locationAddress).trim()) {
      return res.status(400).json({ success: false, message: 'Check-out address is required. Please allow location access so we can resolve your address.' });
    }
    if (record.is_missed_checkout) {
  const { latitude, longitude, locationAddress, capturedAt } = req.body;

  let checkoutTime = istTimeStr();
  let workedHours  = Math.round(hoursElapsed * 100) / 100;
  if (capturedAt && timeRe.test(capturedAt)) {
    const capturedDT = new Date(`${record.date}T${capturedAt}:00+05:30`);
    if (capturedDT <= now) {
      checkoutTime = capturedAt;
      workedHours  = Math.round(((capturedDT - checkinDateTime) / 3600000) * 100) / 100;
    }
  }

  const checkoutSelfiePath = req.file
    ? await uploadFile(req.file.buffer, `ams/users/${req.user.emp_id || req.user.id}/selfies`, req.file.originalname, req.file.mimetype, makeDocName(req.user, 'checkout_selfie', path.extname(req.file.originalname).replace('.', '') || 'jpg'))
    : null;

  const missedUpdate = {
    checkout_time:             checkoutTime,
    checkout_lat:              parseFloat(latitude)  || record.latitude,
    checkout_lng:              parseFloat(longitude) || record.longitude,
    checkout_location_address: locationAddress || record.location_address,
    checkout_selfie_path:      checkoutSelfiePath,
    worked_hours:              workedHours,
    submitted_at:              now,
    checkout_remarks: `Employee checked out after ${workedHours.toFixed(1)} hours. Requires manager approval.`,
     checkout_face_verification_status: 'verified',              // ✅ known good, already checked
  checkout_face_confidence:          checkoutFaceResult.confidence,  // ✅
  };

  const updatedMissed = await AttendanceRecord.findOneAndUpdate(
    { _id: record._id, checkout_time: null },
    { $set: missedUpdate },
    { new: true }
  ).lean();

  if (!updatedMissed) {
    return res.status(409).json({ success: false, message: 'Already checked out.' });
  }

  if (record.manager_id) {
    const emp = await User.findById(req.user.id).select('name').lean();
    await notify(record.manager_id, '🔔 Missed Check-Out — Action Required',
      `${emp?.name || 'An employee'} has now checked out for ${record.date} (worked ${workedHours.toFixed(1)}h). Please review and approve or reject.`,
      'warning', record._id, '/manager/leaves');
  }

  return res.json({
    success: true,
    message: 'Checked out. Submitted for manager approval.',
    autoApproved: false,
    data: formatRecord(updatedMissed),
  });
}

    // ── Determine leave type ────────────────────────────────────────────
    // >= 7 hours → full day, needs manager review
    // <  7 hours → Emergency Leave, needs manager review ('Half Day' removed
    //   as a leave type — every leave is now a full day; hoursElapsed/the
    //   4-hour minimum-checkout lock above are untouched)
    // (No auto-approve shortcut — every checkout requires manager review.)
    let leaveType = hoursElapsed >= 7 ? null : 'Emergency Leave';

   const { latitude, longitude, locationAddress, capturedAt, lateReason, leaveReason } = req.body;

    let checkoutTime = istTimeStr();
    let workedHours  = Math.round(hoursElapsed * 100) / 100;
    if (capturedAt && timeRe.test(capturedAt)) {
      const capturedDT = new Date(`${record.date}T${capturedAt}:00+05:30`);
      if (capturedDT <= now) {
        checkoutTime = capturedAt;
        workedHours  = Math.round(((capturedDT - checkinDateTime) / 3600000) * 100) / 100;
      }
    }
if (leaveType && !String(leaveReason || '').trim()) {
  return res.status(400).json({
    success: false,
    message: `Please provide a reason for checking out early (${leaveType}).`,
  });
}
    const checkoutFaceConfidence = 0;

    const checkoutSelfiePath = req.file
      ? await uploadFile(req.file.buffer, `ams/users/${req.user.emp_id || req.user.id}/selfies`, req.file.originalname, req.file.mimetype, makeDocName(req.user, 'checkout_selfie', path.extname(req.file.originalname).replace('.', '') || 'jpg'))
      : null;

    // ── Attendance type classification ────────────────────────────────────
    const empUser = await User.findById(req.user.id).select('is_permitted').lean();
    const isPermitted = empUser?.is_permitted === true;
    const toMins = t => { const [h, m] = (t || '00:00').split(':').map(Number); return h * 60 + m; };
    const ciMins = toMins(record.checkin_time);
    const coMins = toMins(checkoutTime);
    let attendance_type;
    if (isPermitted) {
      attendance_type = ciMins >= 600 ? 'Irregular' : (coMins >= 900 && coMins <= 960 ? 'Regular' : 'Partial');
    } else if (ciMins < 600 && coMins >= 1020) {
      attendance_type = 'Regular';
    } else if (ciMins >= 600 && coMins < 1020) {
      attendance_type = 'Irregular';
    } else {
      attendance_type = 'Partial';
    }

    const updateFields = {
      checkout_time:             checkoutTime,
      checkout_lat:              parseFloat(latitude)  || record.latitude,
      checkout_lng:              parseFloat(longitude) || record.longitude,
      checkout_location_address: locationAddress || record.location_address,
      checkout_selfie_path:      checkoutSelfiePath,
      submitted_at:              now,
      worked_hours:              workedHours,
      leave_type:                leaveType,
      leave_reason:               leaveType ? leaveReason.trim() : null,
      leave_status:              leaveType ? 'Pending' : null,
      attendance_type,
  checkout_face_verification_status: 'verified',              // ✅
  checkout_face_confidence:          checkoutFaceResult.confidence,  // ✅
    };

    // Employee declined the 6:30pm "check out now?" prompt and gave a
    // reason instead — record it so it's visible in History/Team to the
    // employee, manager, super_admin and hr.
    if (lateReason && String(lateReason).trim()) {
      updateFields.late_checkout_reason       = String(lateReason).trim();
      updateFields.late_checkout_requested_at = now;
    }

    const lateSuffix = updateFields.late_checkout_reason ? ` — Late check-out with reason: ${updateFields.late_checkout_reason}` : '';

    // 7+ hours worked → auto-approved, no manager review needed. Under 7
    // hours (Half Day / Emergency Leave) still requires manager review.
    const isFullDay = hoursElapsed >= 7;
    updateFields.status = isFullDay ? 'Approved' : 'Pending';
    updateFields.manager_remark = isFullDay
      ? `Worked ${workedHours.toFixed(1)} hours — auto-approved (full day)${lateSuffix}`
      : `Worked ${workedHours.toFixed(1)} hours${lateSuffix}`;
    if (isFullDay) {
      updateFields.actioned_at = now;
    }

        const updated = await AttendanceRecord.findOneAndUpdate(
          { _id: record._id, checkout_time: null },
          { $set: updateFields },
          { new: true }
        ).lean();

        if (!updated) {
          return res.status(409).json({
            success: false,
            message: 'This record was already auto-checked-out by the system. Please refresh and check your attendance history.',
          });
        }

        if (isFullDay) {
          await notify(
            record.emp_id,
            '✅ Attendance Approved',
            `Your attendance for ${record.date} (${workedHours.toFixed(1)} hrs) was auto-approved.`,
            'success', record._id, '/employee/history'
          );
        } else if (record.manager_id) {
          const emp = await User.findById(req.user.id).select('name').lean();
          const hoursLabel = `Emergency Leave (${workedHours.toFixed(1)} hrs)`;
          await notify(
            record.manager_id,
            'New Attendance Pending',
            `${emp.name}'s attendance for ${record.date} is pending approval — ${hoursLabel}`,
            'warning', record._id, '/manager/leaves'
          );
        }

        await AuditLog.create({
          _id: uuidv4(), user_id: req.user.id,
          action: 'CHECKOUT',
          entity_type: 'attendance', entity_id: record._id,
        });

        res.json({
          success:             true,
          message:             isFullDay ? 'Checked out and auto-approved' : 'Checked out and submitted for approval',
          autoApproved:        isFullDay,
          data:                formatRecord(updated),
        });

        // Early-logout email — fire-and-forget, doesn't block the response
        if (checkoutTime < '17:00') {
          User.findById(req.user.id).select('name email').lean().then(u => {
            if (u?.email) {
              sendMail(
                u.email, '[AMS] Early Check-Out Recorded',
                `<p>Hi ${u.name || 'there'},</p><p>Your check-out today (${record.date}) was recorded at <strong>${fmt12h(checkoutTime)}</strong>, before the 5:00 PM cutoff.</p>`
              ).catch(err => console.error('[CheckOut] Early-logout email failed:', err.message));
            }
          }).catch(() => {});
        }

      } catch (err) { console.error(err); res.status(500).json({ success: false, message: 'Server error' }); }
    });
    

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/attendance/apply-leave
// ─────────────────────────────────────────────────────────────────────────────
router.post('/apply-leave', authenticate, authorize('employee'), [
  body('date').isDate().withMessage('Valid start date required'),
  body('endDate').optional().isDate(),
  body('leaveType').isIn(['Casual Leave', 'Emergency Leave', 'Urgent Leave', 'Planned Leave']),
  body('reason').notEmpty(),
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ success: false, errors: errors.array() });
  try {
    const { date, endDate, leaveType, reason } = req.body;
    const finalEndDate = endDate || date;
    if (finalEndDate < date) return res.status(400).json({ success: false, message: 'End date must be on or after start date' });

    const todayISO = istDateStr();

    // ── Per-type date window validation ────────────────────────────────
    const allowedWindows = {
      'Urgent Leave': { minOffset: 0,   maxOffset: 3,  minMsg: 'Urgent Leave can only be applied starting today', maxMsg: 'Urgent Leave can only be applied up to 3 days ahead' },
      'Casual Leave': { minOffset: -30, maxOffset: 7,  minMsg: 'Casual Leave cannot be applied more than 30 days in the past', maxMsg: 'Casual Leave can only be applied up to 7 days in advance' },
      'Planned Leave':{ minOffset: 7,   maxOffset: 90, minMsg: 'Planned Leave must start at least 7 days from today', maxMsg: 'Planned Leave can only be planned up to 90 days in advance' },
      'Emergency Leave':{ minOffset: -30, maxOffset: 7, minMsg: 'Leave cannot be applied more than 30 days in the past', maxMsg: 'Leave can only be applied up to 7 days in advance' },
    };
    const win = allowedWindows[leaveType];
    const minAllowed = addDays(todayISO, win.minOffset);
    const maxAllowed = addDays(todayISO, win.maxOffset);
    if (date < minAllowed) return res.status(400).json({ success: false, message: win.minMsg });
    if (finalEndDate > maxAllowed) return res.status(400).json({ success: false, message: win.maxMsg });

    const currentUser = await User.findById(req.user.id).select('manager_id name leave_balance auto_leave_enabled').lean();
    const managerId   = currentUser?.manager_id;

    const existing = await findOverlappingRecord(req.user.id, date, finalEndDate);
    if (existing) return res.status(409).json({ success: false, message: `A record already exists for ${recordDateLabel(existing)} that overlaps this request.` });

    const isMultiDay = finalEndDate !== date;
    const dayCount   = countWorkingDays(date, finalEndDate); // for display/messaging only
    const dayUnits   = leaveDayUnits(leaveType, date, finalEndDate); // for balance math — Half Day = 0.5
    const id = uuidv4();

    // ── Leave balance & partial-LOP logic ────────────────────────────────
    // Deduct whatever balance is available (down to 0) and mark only the
    // remaining shortfall as LOP — e.g. balance=1, requesting 3 days uses
    // the 1 available day and marks 2 as LOP, rather than voiding the
    // whole request's balance use just because it doesn't fully cover it.
    const balance = currentUser?.leave_balance ?? 0;
    const autoEnabled = currentUser?.auto_leave_enabled !== false;
    const paidDays = autoEnabled ? Math.min(balance, dayUnits) : 0;
    const lopDays  = roundHalfDay(dayUnits - paidDays);
    const isLOP    = lopDays > 0;
    const leaveNote = !isLOP ? '' : paidDays > 0
      ? ` (${paidDays} day${paidDays !== 1 ? 's' : ''} balance, ${lopDays} day${lopDays !== 1 ? 's' : ''} LOP)`
      : ' (LOP — insufficient balance)';

    await AttendanceRecord.create({
      _id: id, emp_id: req.user.id, date, end_date: isMultiDay ? finalEndDate : null,
      duty_type: 'Leave', status: 'Pending', manager_id: managerId,
      leave_type: leaveType, leave_reason: reason + leaveNote, leave_status: 'Pending',
      is_lop: isLOP, paid_days: paidDays, lop_days: lopDays, submitted_at: new Date(),
    });

    if (paidDays > 0) {
      await User.findByIdAndUpdate(req.user.id, { $set: { leave_balance: clampLeaveBalance(balance - paidDays) } });
    }
    await AuditLog.create({ _id: uuidv4(), user_id: req.user.id, action: 'APPLY_LEAVE', entity_type: 'attendance', entity_id: id, new_value: leaveType });

    const dateRange = isMultiDay ? `${date} to ${finalEndDate}` : date;
    const leaveEmailBody = `<p><strong>${currentUser.name}</strong> has applied for <strong>${leaveType}</strong> ${isMultiDay ? `from <strong>${date}</strong> to <strong>${finalEndDate}</strong> (${dayCount} days)` : `on <strong>${date}</strong>`}.</p><p><strong>Reason:</strong> ${reason}</p>`;

    if (managerId) {
      await notify(managerId, `${leaveType} Request`,
        `${currentUser.name} applied for ${leaveType} (${dayCount} day${dayCount !== 1 ? 's' : ''}) — ${dateRange}: ${reason}`,
        'warning', id, '/manager/leaves');
      const manager = await User.findById(managerId).select('email name').lean();
      if (manager?.email) {
        sendMail(manager.email, `[AMS] ${leaveType} Request – ${currentUser.name} (${dateRange})`,
          `<p>Hi ${manager.name},</p>${leaveEmailBody}`);
      }
    }

    // Also email all admins
    const admins = await User.find({ role: 'admin', is_active: { $ne: false } }).select('email name').lean();
    admins.forEach(admin => {
      if (admin.email) {
        sendMail(admin.email, `[AMS] ${leaveType} Request – ${currentUser.name} (${dateRange})`,
          `<p>Hi ${admin.name},</p>${leaveEmailBody}`);
      }
    });

    const isTodayInRange = todayISO >= date && todayISO <= finalEndDate;
    const record = await AttendanceRecord.findById(id).lean();
    res.status(201).json({
      success: true,
      message: `${leaveType} submitted for ${dayCount} day${dayCount !== 1 ? 's' : ''}`,
      count: dayCount,
      todayRecord: isTodayInRange ? formatRecord(record) : null,
    });
  } catch (err) { console.error(err); res.status(500).json({ success: false, message: 'Server error' }); }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/attendance/manager-apply-leave
// Manager (or admin) adds a leave directly on behalf of a team member —
// created already Approved (the manager IS the approver), not Pending,
// since there's no one else to review it. Employee is notified + emailed.
// ─────────────────────────────────────────────────────────────────────────────
router.post('/manager-apply-leave', authenticate, authorize('manager', 'admin'), [
  body('empId').trim().notEmpty().withMessage('Employee is required'),
  body('date').isDate().withMessage('Valid start date required'),
  body('endDate').optional().isDate(),
  body('leaveType').isIn(['Casual Leave', 'Emergency Leave', 'Urgent Leave', 'Planned Leave']),
  body('reason').notEmpty(),
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ success: false, errors: errors.array() });
  try {
    const { empId, date, endDate, leaveType, reason } = req.body;
    const finalEndDate = endDate || date;
    if (finalEndDate < date) return res.status(400).json({ success: false, message: 'End date must be on or after start date' });

    const emp = await User.findOne({ _id: empId, role: 'employee' }).select('manager_id name email leave_balance auto_leave_enabled').lean();
    if (!emp) return res.status(404).json({ success: false, message: 'Employee not found' });
    if (req.user.role === 'manager' && String(emp.manager_id) !== String(req.user.id)) {
      return res.status(403).json({ success: false, message: 'Not your team member' });
    }

    const existing = await findOverlappingRecord(empId, date, finalEndDate);
    if (existing) return res.status(409).json({ success: false, message: `${emp.name} already has a record for ${recordDateLabel(existing)} that overlaps this request.` });

    const isMultiDay = finalEndDate !== date;
    const dayCount   = countWorkingDays(date, finalEndDate); // for display/messaging only
    const dayUnits   = leaveDayUnits(leaveType, date, finalEndDate);
    const id = uuidv4();

    // forceLop: admin/manager explicitly marks this LOP regardless of
    // balance (the optional "LOP" checkbox) — otherwise partial LOP applies
    // automatically once balance runs out. See apply-leave for the rationale.
    const forceLop = req.body.forceLop === true || req.body.forceLop === 'true';
    const balance = emp.leave_balance ?? 0;
    const autoEnabled = emp.auto_leave_enabled !== false;
    const paidDays = forceLop ? 0 : (autoEnabled ? Math.min(balance, dayUnits) : 0);
    const lopDays  = roundHalfDay(dayUnits - paidDays);
    const isLOP    = lopDays > 0;
    const leaveNote = !isLOP ? '' : paidDays > 0
      ? ` (${paidDays} day${paidDays !== 1 ? 's' : ''} balance, ${lopDays} day${lopDays !== 1 ? 's' : ''} LOP)`
      : ' (LOP — insufficient balance)';

    await AttendanceRecord.create({
      _id: id, emp_id: empId, date, end_date: isMultiDay ? finalEndDate : null,
      duty_type: 'Leave', status: 'Approved', manager_id: emp.manager_id || null,
      leave_type: leaveType, leave_reason: reason + leaveNote, leave_status: 'Approved',
      is_lop: isLOP, paid_days: paidDays, lop_days: lopDays, submitted_at: new Date(),
      actioned_by: req.user.id, actioned_at: new Date(),
      manager_remark: `Added by ${req.user.role === 'admin' ? 'Admin' : 'Manager'}: ${reason}`,
    });

    if (paidDays > 0) {
      await User.findByIdAndUpdate(empId, { $set: { leave_balance: clampLeaveBalance(balance - paidDays) } });
    }
    await AuditLog.create({ _id: uuidv4(), user_id: req.user.id, action: 'MANAGER_ADD_LEAVE', entity_type: 'attendance', entity_id: id, new_value: leaveType });

    const dateRange = isMultiDay ? `${date} to ${finalEndDate}` : date;
    await notify(empId, `${leaveType} Added ✓`,
      `Your manager added ${leaveType} for you (${dayCount} day${dayCount !== 1 ? 's' : ''}) — ${dateRange}: ${reason}`,
      'success', id, '/employee/history');
    if (emp.email) {
      sendMail(emp.email, `[AMS] ${leaveType} Added on Your Behalf`,
        `<p>Hi ${emp.name},</p><p>Your manager added <strong>${leaveType}</strong> for you ${isMultiDay ? `from <strong>${date}</strong> to <strong>${finalEndDate}</strong> (${dayCount} days)` : `on <strong>${date}</strong>`}.</p><p><strong>Reason:</strong> ${reason}</p>`
      ).catch(err => console.error('[ManagerApplyLeave] Employee email failed:', err.message));
    }

    const record = await AttendanceRecord.findById(id).lean();
    res.status(201).json({
      success: true,
      message: `${leaveType} added for ${emp.name} (${dayCount} day${dayCount !== 1 ? 's' : ''})`,
      data: formatRecord(record),
    });
  } catch (err) { console.error(err); res.status(500).json({ success: false, message: 'Server error' }); }
});

// ─────────────────────────────────────────────────────────────────────────────
// DELETE /api/attendance/:id/cancel-leave  (employee only, Pending leaves only)
// ─────────────────────────────────────────────────────────────────────────────
router.delete('/:id/cancel-leave', authenticate, authorize('employee'), async (req, res) => {
  try {
    const record = await AttendanceRecord.findOne({ _id: req.params.id, emp_id: req.user.id }).lean();
    if (!record) return res.status(404).json({ success: false, message: 'Leave record not found' });
    if (record.duty_type !== 'Leave') return res.status(400).json({ success: false, message: 'This record is not a leave request' });
    if (record.leave_status === 'Approved') return res.status(403).json({ success: false, message: 'Cannot cancel an approved leave' });
    if (record.leave_status === 'Rejected') return res.status(400).json({ success: false, message: 'This leave has already been rejected' });

    await AttendanceRecord.findByIdAndDelete(record._id);
    await AuditLog.create({ _id: uuidv4(), user_id: req.user.id, action: 'CANCEL_LEAVE', entity_type: 'attendance', entity_id: record._id, new_value: record.leave_type });

    // Restore whatever was actually deducted at application time. paid_days
    // is undefined (not 0) on records created before this field existed —
    // fall back to the old full-refund behavior for those legacy records
    // only; a real 0 means an already-tracked request that never touched
    // balance (fully LOP).
    const refundDays = record.paid_days != null
      ? record.paid_days
      : (!record.is_lop ? countWorkingDays(record.date, record.end_date || record.date) : 0);
    if (refundDays > 0) {
      const empBalance = await User.findById(req.user.id).select('leave_balance').lean();
      await User.findByIdAndUpdate(req.user.id, { $set: { leave_balance: clampLeaveBalance((empBalance?.leave_balance ?? 0) + refundDays) } });
    }

    const emp = await User.findById(req.user.id).select('name').lean();
    const cancelBody = `<p><strong>${emp?.name}</strong> has cancelled their <strong>${record.leave_type}</strong> leave request for <strong>${record.date}</strong>.</p>`;

    if (record.manager_id) {
      await notify(record.manager_id, 'Leave Cancelled', `${emp?.name} cancelled their ${record.leave_type} for ${record.date}`, 'info', null, '/manager/leaves');
      const manager = await User.findById(record.manager_id).select('email name').lean();
      if (manager?.email) sendMail(manager.email, `[AMS] Leave Cancelled – ${emp?.name}`, `<p>Hi ${manager.name},</p>${cancelBody}`);
    }
    const admins = await User.find({ role: { $in: ['admin', 'hr'] }, is_active: { $ne: false } }).select('_id email name').lean();
    for (const a of admins) {
      await notify(a._id, 'Leave Cancelled', `${emp?.name} cancelled their ${record.leave_type} for ${record.date}`, 'info', null, '/admin/attendance');
      if (a.email) sendMail(a.email, `[AMS] Leave Cancelled – ${emp?.name}`, `<p>Hi ${a.name},</p>${cancelBody}`);
    }

    res.json({ success: true, message: 'Leave request cancelled successfully' });
  } catch (err) { console.error(err); res.status(500).json({ success: false, message: 'Server error' }); }
});

// ─────────────────────────────────────────────────────────────────────────────
// PUT /api/attendance/:id/approve
// ─────────────────────────────────────────────────────────────────────────────
router.put('/:id/approve', authenticate, authorize('manager', 'admin'), async (req, res) => {
  try {
    const today = istDateStr();
    const { remark } = req.body;
    const record = await AttendanceRecord.findById(req.params.id).lean();
    if (!record) return res.status(404).json({ success: false, message: 'Record not found' });

 const isMissedDraft = record.status === 'Draft' && record.checkin_time && !record.checkout_time && record.date < today;

    if (req.user.role === 'admin' && (record.is_missed_checkout || isMissedDraft) && record.status === 'Pending') {
      return res.status(403).json({ success: false, message: 'Manager must act on this missed check-out first.' });
    }

    if (req.user.role === 'manager') {
      const emp = await User.findOne({ _id: record.emp_id, manager_id: req.user.id }).lean();
      if (!emp) return res.status(403).json({ success: false, message: 'Not your team member' });

      const isFaceReview   = record.face_verification_status === 'manager_review';
      if (!['Pending', 'Rejected'].includes(record.status) && !isMissedDraft && !isFaceReview)
        return res.status(400).json({ success: false, message: 'Cannot approve in current state' });

      if (isMissedDraft) {
        await AttendanceRecord.findByIdAndUpdate(record._id, {
          $set: { is_missed_checkout: true, status: 'Pending', checkout_remarks: 'Employee did not check out. Requires manager approval.' },
        });
      }
    }

    // Missed check-out approvals ALWAYS require a manager remark — this
    // applies to manager AND admin overrides, per the mandatory-remark rule.
    if ((record.is_missed_checkout || isMissedDraft) && !String(remark || '').trim()) {
      return res.status(400).json({ success: false, message: 'A remark is required to approve a missed check-out.' });
    }

    const isAdmin = req.user.role === 'admin';
    const update  = { status: 'Approved', manager_remark: remark || '', actioned_by: req.user.id, actioned_at: new Date() };
    if (isAdmin) update.admin_remark = remark || '';
    if (record.leave_type) update.leave_status = 'Approved';
    if (record.face_verification_status === 'manager_review') update.face_verification_status = 'manager_approved';

    await AttendanceRecord.findByIdAndUpdate(record._id, { $set: update });

    // `record` was fetched before the isMissedDraft branch above set
    // is_missed_checkout:true, so it's stale for that flag — combine with
    // isMissedDraft so the notification/email below reflect what actually
    // happened, not the record's pre-update state.
    const isMissedCheckoutRecord = record.is_missed_checkout || isMissedDraft;
    const notifTitle = isMissedCheckoutRecord ? 'Missed Check-Out Approved ✓' : record.leave_type ? 'Leave Approved ✓' : 'Attendance Approved ✓';
    const notifMsg   = isMissedCheckoutRecord
      ? `Your missed check-out on ${record.date} has been approved by your manager. You may check in again.`
      : record.leave_type ? `Your ${record.leave_type} for ${recordDateLabel(record)} has been approved.` : `Your attendance for ${record.date} has been approved.`;

    await notify(record.emp_id, notifTitle, notifMsg, 'success', record._id, '/employee/history');

    if (record.leave_type || isMissedCheckoutRecord) {
      const empUser = await User.findById(record.emp_id).select('email name').lean();
      if (empUser?.email) {
        const subject = record.leave_type ? `[AMS] ${record.leave_type} Approved` : '[AMS] Missed Check-Out Approved';
        const body = record.leave_type
          ? `<p>Hi ${empUser.name},</p><p>Your <strong>${record.leave_type}</strong> for <strong>${recordDateLabel(record)}</strong> has been <strong style="color:#16a34a">approved</strong>.</p>`
          : `<p>Hi ${empUser.name},</p><p>Your missed check-out on <strong>${record.date}</strong> has been <strong style="color:#16a34a">approved</strong> by your manager. You may check in again.</p>`;
        sendMail(empUser.email, subject, body).catch(err => console.error('[Approve] Employee email failed:', err.message));
      }
    }

    await AuditLog.create({
      _id: uuidv4(), user_id: req.user.id,
      action: isAdmin ? 'ADMIN_OVERRIDE_APPROVE' : 'APPROVE',
      entity_type: 'attendance', entity_id: record._id,
      old_value: record.status, new_value: 'Approved',
    });

    const updated = await AttendanceRecord.findById(record._id).lean();
    res.json({ success: true, message: 'Approved', data: formatRecord(updated) });
  } catch (err) { console.error(err); res.status(500).json({ success: false, message: 'Server error' }); }
});

// ─────────────────────────────────────────────────────────────────────────────
// PUT /api/attendance/:id/reject
// ─────────────────────────────────────────────────────────────────────────────
router.put('/:id/reject', authenticate, authorize('manager', 'admin'), [
  body('remark').notEmpty().withMessage('Rejection reason is required'),
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ success: false, errors: errors.array() });
  try {
    const { remark } = req.body;
    const record = await AttendanceRecord.findById(req.params.id).lean();
    if (!record) return res.status(404).json({ success: false, message: 'Record not found' });
    if (req.user.role === 'manager') {
      const empCheck = await User.findOne({ _id: record.emp_id, manager_id: req.user.id }).lean();
      if (!empCheck) return res.status(403).json({ success: false, message: 'Not your team member' });
    }

    const today = istDateStr();
    const isFaceReviewRecord = record.face_verification_status === 'manager_review';
    const isMissedDraft = record.status === 'Draft' && record.checkin_time && !record.checkout_time && record.date < today;

    if (req.user.role === 'admin' && (record.is_missed_checkout || isMissedDraft) && record.status === 'Pending') {
      return res.status(403).json({ success: false, message: 'Manager must act on this missed check-out first.' });
    }

    // A manager acts on a given record exactly ONCE. Block re-rejecting
    // something already Approved/Rejected (mirrors the guard on /approve),
    // so a stray double-tap or a stale page can't fire the same decision
    // twice and re-notify the employee repeatedly.
    if (req.user.role === 'manager' && !['Pending'].includes(record.status) && !isMissedDraft && !isFaceReviewRecord) {
      return res.status(400).json({ success: false, message: 'This record has already been actioned.' });
    }

    if (!isFaceReviewRecord && isMissedDraft) {
      await AttendanceRecord.findByIdAndUpdate(record._id, {
        $set: { is_missed_checkout: true, status: 'Pending', checkout_remarks: 'Employee did not check out. Requires manager approval.' },
      });
    }

    const update = { status: 'Rejected', manager_remark: remark, actioned_by: req.user.id, actioned_at: new Date() };
    if (record.leave_type) update.leave_status = 'Rejected';
    if (record.face_verification_status === 'manager_review') update.face_verification_status = 'manager_rejected';
    await AttendanceRecord.findByIdAndUpdate(record._id, { $set: update });

    // Restore whatever was actually deducted at application time — see the
    // matching comment in DELETE /:id/cancel-leave for the legacy-record fallback.
    if (record.leave_type) {
      const refundDays = record.paid_days != null
        ? record.paid_days
        : (!record.is_lop ? countWorkingDays(record.date, record.end_date || record.date) : 0);
      if (refundDays > 0) {
        const empBalance = await User.findById(record.emp_id).select('leave_balance').lean();
        await User.findByIdAndUpdate(record.emp_id, { $set: { leave_balance: clampLeaveBalance((empBalance?.leave_balance ?? 0) + refundDays) } });
      }
    }

    const isFaceReject = record.face_verification_status === 'manager_review';
    // Same staleness issue as /approve — record was fetched before the
    // isMissedDraft branch set is_missed_checkout:true.
    const isMissedCheckoutRecord = record.is_missed_checkout || isMissedDraft;
    const notifTitle = isFaceReject ? 'Check-In Rejected ✗' : isMissedCheckoutRecord ? 'Missed Check-Out Rejected ✗' : record.leave_type ? 'Leave Rejected ✗' : 'Attendance Rejected ✗';
    const notifMsg   = isFaceReject
      ? `Your check-in for ${record.date} was rejected by your manager: ${remark}`
      : isMissedCheckoutRecord
        ? `Your missed check-out on ${record.date} was rejected: ${remark}. You may check in again.`
        : record.leave_type ? `Your ${record.leave_type} for ${recordDateLabel(record)} was rejected: ${remark}` : `Your attendance for ${record.date} was rejected: ${remark}`;

    await notify(record.emp_id, notifTitle, notifMsg, 'error', record._id, '/employee/history');

    if (record.leave_type || isMissedCheckoutRecord) {
      const empUser = await User.findById(record.emp_id).select('email name').lean();
      if (empUser?.email) {
        const subject = record.leave_type ? `[AMS] ${record.leave_type} Rejected` : '[AMS] Missed Check-Out Rejected';
        const body = record.leave_type
          ? `<p>Hi ${empUser.name},</p><p>Your <strong>${record.leave_type}</strong> for <strong>${recordDateLabel(record)}</strong> has been <strong style="color:#dc2626">rejected</strong>.</p><p><strong>Reason:</strong> ${remark}</p>`
          : `<p>Hi ${empUser.name},</p><p>Your missed check-out on <strong>${record.date}</strong> was <strong style="color:#dc2626">rejected</strong> by your manager.</p><p><strong>Reason:</strong> ${remark}</p><p>You may check in again.</p>`;
        sendMail(empUser.email, subject, body).catch(err => console.error('[Reject] Employee email failed:', err.message));
      }
    }

    await AuditLog.create({ _id: uuidv4(), user_id: req.user.id, action: 'REJECT', entity_type: 'attendance', entity_id: record._id, old_value: record.status, new_value: 'Rejected' });
    res.json({ success: true, message: 'Rejected' });
  } catch (err) { console.error(err); res.status(500).json({ success: false, message: 'Server error' }); }
});

// ─────────────────────────────────────────────────────────────────────────────
// PUT /api/attendance/:id/regularize
// Admin-only manual correction for a day left Partial/Irregular/Emergency
// Leave/Half Day because the employee couldn't check in/out on time (e.g.
// during a server outage). Marks the day Regular/Approved with an audit trail.
// Also covers a raw unresolved missed check-out (checkin set, no checkout,
// never yet classified) as an alternative to /manual-checkout — in that case
// a check-out time is required to compute worked_hours.
// ─────────────────────────────────────────────────────────────────────────────
router.put('/:id/regularize', authenticate, authorize('admin'), [
  body('remark').trim().notEmpty().withMessage('A remark is required to regularize attendance'),
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ success: false, errors: errors.array() });
  try {
    const { remark, checkoutTime } = req.body;
    const record = await AttendanceRecord.findById(req.params.id).lean();
    if (!record) return res.status(404).json({ success: false, message: 'Record not found' });

    const isMissedCheckout = !!record.checkin_time && !record.checkout_time &&
      (record.is_missed_checkout === true || record.status === 'Draft');
    const isRegularizable =
      ['Partial', 'Irregular'].includes(record.attendance_type) ||
      ['Emergency Leave', 'Half Day'].includes(record.leave_type) ||
      isMissedCheckout;
    if (!isRegularizable) {
      return res.status(400).json({ success: false, message: 'Only Partial, Irregular, Emergency Leave, Half Day, or an unresolved Missed Check-out record can be regularized.' });
    }

    const update = {
      status:          'Approved',
      attendance_type: 'Regular',
      leave_type:       null,
      leave_status:      null,
      admin_remark:     remark,
      manager_remark:  `Regularized by Admin: ${remark}`,
      actioned_by:      req.user.id,
      actioned_at:      new Date(),
    };

    if (isMissedCheckout) {
      const timeRe = /^\d{2}:\d{2}$/;
      const finalCheckoutTime = (checkoutTime && timeRe.test(checkoutTime)) ? checkoutTime : istTimeStr();
      const checkinDateTime  = new Date(`${record.date}T${record.checkin_time}:00+05:30`);
      const checkoutDateTime = new Date(`${record.date}T${finalCheckoutTime}:00+05:30`);
      if (checkoutDateTime < checkinDateTime) {
        return res.status(400).json({ success: false, message: 'Check-out time cannot be before check-in time' });
      }
      update.checkout_time = finalCheckoutTime;
      update.worked_hours  = Math.round(((checkoutDateTime - checkinDateTime) / 3600000) * 100) / 100;
    }
    await AttendanceRecord.findByIdAndUpdate(record._id, { $set: update });

    await finishAdminCorrection(req, res, record, {
      notifyTitle:   '✅ Attendance Regularized',
      notifyMsg:     `Your attendance for ${record.date} has been manually regularized by Admin: ${remark}`,
      auditAction:   'ADMIN_REGULARIZE',
      auditNewValue: 'Approved',
      successMsg:    'Attendance regularized',
    });
  } catch (err) { console.error(err); res.status(500).json({ success: false, message: 'Server error' }); }
});

// ─────────────────────────────────────────────────────────────────────────────
// PUT /api/attendance/:id/manual-checkout
// Admin-only — completes a record stuck with no check-out (e.g. a missed
// check-out that only got approved as-is, leaving checkout_time null
// forever) by setting an actual check-out time on the employee's behalf.
// No selfie/GPS required — this is an administrative override, not a
// self-service check-out. Immediately resolves the record so the employee
// can check in normally again.
// ─────────────────────────────────────────────────────────────────────────────
router.put('/:id/manual-checkout', authenticate, authorize('admin'), [
  body('remark').trim().notEmpty().withMessage('A remark is required for a manual check-out'),
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ success: false, errors: errors.array() });
  try {
    const { remark, checkoutTime } = req.body;
    const record = await AttendanceRecord.findById(req.params.id).lean();
    if (!record) return res.status(404).json({ success: false, message: 'Record not found' });
    if (record.checkout_time) return res.status(409).json({ success: false, message: 'Already checked out' });
    if (!record.checkin_time) return res.status(400).json({ success: false, message: 'Cannot check out a record with no check-in' });

    const timeRe = /^\d{2}:\d{2}$/;
    const finalCheckoutTime = (checkoutTime && timeRe.test(checkoutTime)) ? checkoutTime : istTimeStr();

    const checkinDateTime  = new Date(`${record.date}T${record.checkin_time}:00+05:30`);
    const checkoutDateTime = new Date(`${record.date}T${finalCheckoutTime}:00+05:30`);
    if (checkoutDateTime < checkinDateTime) {
      return res.status(400).json({ success: false, message: 'Check-out time cannot be before check-in time' });
    }
    const workedHours = Math.round(((checkoutDateTime - checkinDateTime) / 3600000) * 100) / 100;

    const update = {
      checkout_time:    finalCheckoutTime,
      worked_hours:      workedHours,
      status:            'Approved',
      admin_remark:      remark,
      checkout_remarks: `Manually checked out by Admin: ${remark}`,
      actioned_by:       req.user.id,
      actioned_at:       new Date(),
      submitted_at:      new Date(),
    };
    const updated = await AttendanceRecord.findOneAndUpdate(
      { _id: record._id, checkout_time: null },
      { $set: update },
      { new: true }
    ).lean();
    if (!updated) return res.status(409).json({ success: false, message: 'Already checked out.' });

    await finishAdminCorrection(req, res, record, {
      notifyTitle:   '✅ Check-Out Completed by Admin',
      notifyMsg:     `Your check-out for ${record.date} was completed by Admin at ${finalCheckoutTime} (worked ${workedHours.toFixed(1)}h): ${remark}. You may check in again.`,
      auditAction:   'ADMIN_MANUAL_CHECKOUT',
      auditOldValue: 'no checkout',
      auditNewValue: finalCheckoutTime,
      successMsg:    'Check-out completed',
    });
  } catch (err) { console.error(err); res.status(500).json({ success: false, message: 'Server error' }); }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/attendance/mark-present
// Admin-only — for a day with NO attendance record at all (employee never
// checked in, e.g. during a server outage), OR a single-day Leave record
// being corrected back to present (refunds any balance it had deducted).
// Creates a Regular/Approved record on the employee's behalf. Distinct from
// /regularize, which only fixes an *existing* Partial/Irregular/Emergency record.
// ─────────────────────────────────────────────────────────────────────────────
router.post('/mark-present', authenticate, authorize('admin'), [
  body('empId').trim().notEmpty().withMessage('Employee is required'),
  body('date').matches(/^\d{4}-\d{2}-\d{2}$/).withMessage('A valid date is required'),
  body('remark').trim().notEmpty().withMessage('A remark is required to mark attendance present'),
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ success: false, errors: errors.array() });
  try {
    const { empId, date, remark } = req.body;
    const today = istDateStr();
    if (date > today) return res.status(400).json({ success: false, message: 'Cannot mark a future date present' });

    const employee = await User.findById(empId).select('manager_id name').lean();
    if (!employee) return res.status(404).json({ success: false, message: 'Employee not found' });

    const existing = await findRecordCoveringDate(empId, date);
    if (existing) {
      const isSingleDayLeave = existing.duty_type === 'Leave' && !(existing.end_date && existing.end_date > existing.date);
      // A rejected leave the employee never checked in for didn't actually
      // happen — free up just this day (splitting the record if it's a
      // multi-day range) instead of blocking the admin from correcting it.
      if (isRejectedNoCheckinLeave(existing)) {
        await carveOutDate(existing, date);
      } else if (isSingleDayLeave) {
        // Correcting an already-marked leave day back to present — refund
        // whatever balance was deducted for it, then free the day the same
        // way carveOutDate does for a single-day record (delete; the
        // create() below adds the fresh Present record in its place).
        if (existing.paid_days > 0) {
          const empBalance = await User.findById(empId).select('leave_balance').lean();
          await User.findByIdAndUpdate(empId, { $set: { leave_balance: clampLeaveBalance((empBalance?.leave_balance ?? 0) + existing.paid_days) } });
        }
        await AttendanceRecord.findByIdAndDelete(existing._id);
      } else if (existing.duty_type === 'Leave') {
        return res.status(409).json({ success: false, message: `${recordDateLabel(existing)} is part of a multi-day leave — convert that day individually via Convert to Leave first, then mark it present.` });
      } else {
        return res.status(409).json({ success: false, message: `A record already exists for ${recordDateLabel(existing)} covering this day — use Regularize or Check Out instead.` });
      }
    }

    const timeRe = /^\d{2}:\d{2}$/;
    const checkinTime  = (req.body.checkinTime  && timeRe.test(req.body.checkinTime))  ? req.body.checkinTime  : '09:00';
    const checkoutTime = (req.body.checkoutTime && timeRe.test(req.body.checkoutTime)) ? req.body.checkoutTime : '18:00';
    const checkinDateTime  = new Date(`${date}T${checkinTime}:00+05:30`);
    const checkoutDateTime = new Date(`${date}T${checkoutTime}:00+05:30`);
    if (checkoutDateTime < checkinDateTime) {
      return res.status(400).json({ success: false, message: 'Check-out time cannot be before check-in time' });
    }
    const workedHours = Math.round(((checkoutDateTime - checkinDateTime) / 3600000) * 100) / 100;

    const id = uuidv4();
    await AttendanceRecord.create({
      _id: id, emp_id: empId, date, duty_type: 'Office Duty',
      status: 'Approved', attendance_type: 'Regular',
      checkin_time: checkinTime, checkout_time: checkoutTime, worked_hours: workedHours,
      manager_id: employee.manager_id || null,
      admin_remark: remark,
      checkout_remarks: `Marked present by Admin (no check-in recorded): ${remark}`,
      actioned_by: req.user.id, actioned_at: new Date(), submitted_at: new Date(),
    });
    const record = await AttendanceRecord.findById(id).lean();

    await finishAdminCorrection(req, res, record, {
      notifyTitle:   '✅ Attendance Marked Present by Admin',
      notifyMsg:     `Your attendance for ${date} was marked present by Admin: ${remark}`,
      auditAction:   'ADMIN_MARK_PRESENT',
      auditOldValue: 'no record',
      auditNewValue: 'Approved',
      successMsg:    'Attendance marked present',
    });
  } catch (err) { console.error(err); res.status(500).json({ success: false, message: 'Server error' }); }
});

// ─────────────────────────────────────────────────────────────────────────────
// PUT /api/attendance/convert-to-leave
// ─────────────────────────────────────────────────────────────────────────────
router.put('/convert-to-leave', authenticate, authorize('admin'), [
  body('empId').trim().notEmpty().withMessage('Employee is required'),
  body('startDate').isDate().withMessage('Valid start date required'),
  body('endDate').optional().isDate(),
  body('leaveType').isIn(['Casual Leave', 'Emergency Leave', 'Urgent Leave', 'Planned Leave']),
  body('reason').trim().notEmpty().withMessage('A reason is required'),
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ success: false, errors: errors.array() });
  try {
    const { empId, startDate, leaveType, reason } = req.body;
    const endDate = req.body.endDate || startDate;
    const today = istDateStr();
    const forceLop = req.body.forceLop === true || req.body.forceLop === 'true';
    if (endDate < startDate) return res.status(400).json({ success: false, message: 'End date must be on or after start date' });
    if (endDate > today) return res.status(400).json({ success: false, message: 'Cannot convert a future date' });

    const employee = await User.findById(empId).select('manager_id name leave_balance auto_leave_enabled').lean();
    if (!employee) return res.status(404).json({ success: false, message: 'Employee not found' });

    let balance = employee.leave_balance ?? 0;
    const autoEnabled = employee.auto_leave_enabled !== false;

    const convertedDates = [];
    const skipped = [];
    let cur = startDate;
    while (cur <= endDate) {
      const rec = await findRecordCoveringDate(empId, cur);
      if (!rec) { skipped.push(`${cur} (no record)`); cur = addDays(cur, 1); continue; }
      const isAlreadyLeave = rec.duty_type === 'Leave' || (rec.leave_type && String(rec.leave_type).trim());
      if (isAlreadyLeave) { skipped.push(`${cur} (already a leave)`); cur = addDays(cur, 1); continue; }
      const isMultiDay = rec.end_date && rec.end_date > rec.date;
      if (isMultiDay) { skipped.push(`${cur} (part of a multi-day record — convert that day individually)`); cur = addDays(cur, 1); continue; }

      const dayUnits = leaveDayUnits(leaveType, cur, cur);
      const paidDays = forceLop ? 0 : (autoEnabled ? Math.min(balance, dayUnits) : 0);
      const lopDays  = roundHalfDay(dayUnits - paidDays);
      balance = clampLeaveBalance(balance - paidDays);

      await AttendanceRecord.findByIdAndUpdate(rec._id, {
        $set: {
          duty_type: 'Leave', leave_type: leaveType, leave_reason: reason,
          leave_status: 'Approved', status: 'Approved',
          is_lop: lopDays > 0, paid_days: paidDays, lop_days: lopDays,
          admin_remark: `Converted from attendance to ${leaveType} by Admin: ${reason}`,
          actioned_by: req.user.id, actioned_at: new Date(),
        },
      });
      convertedDates.push(cur);
      cur = addDays(cur, 1);
    }

    if (convertedDates.length === 0) {
      return res.status(400).json({ success: false, message: `Nothing to convert — ${skipped.join('; ') || 'no records found in that range'}.` });
    }

    if (autoEnabled) {
      await User.findByIdAndUpdate(empId, { $set: { leave_balance: balance } });
    }

    const dateRangeLabel = convertedDates.length > 1 ? `${convertedDates[0]} to ${convertedDates[convertedDates.length - 1]}` : convertedDates[0];
    await notify(empId, `Attendance Corrected to ${leaveType}`,
      `Your attendance for ${dateRangeLabel} was corrected to ${leaveType} by Admin: ${reason}`,
      'info', null, '/employee/history');
    const empUser = await User.findById(empId).select('email name').lean();
    if (empUser?.email) {
      sendMail(empUser.email, `[AMS] Attendance Corrected to ${leaveType}`,
        `<p>Hi ${empUser.name},</p><p>Your attendance for <strong>${dateRangeLabel}</strong> was corrected to <strong>${leaveType}</strong> by an administrator.</p><p><strong>Reason:</strong> ${reason}</p>`
      ).catch(err => console.error('[ConvertToLeave] Employee email failed:', err.message));
    }

    await AuditLog.create({
      _id: uuidv4(), user_id: req.user.id, action: 'ADMIN_CONVERT_TO_LEAVE',
      entity_type: 'attendance', new_value: `${leaveType} for ${dateRangeLabel} (${convertedDates.length} day${convertedDates.length !== 1 ? 's' : ''})`,
    });

    res.json({
      success: true,
      message: `Converted ${convertedDates.length} day(s) to ${leaveType}${skipped.length ? ` — skipped: ${skipped.join('; ')}` : ''}`,
      data: { converted: convertedDates.length, convertedDates, skipped },
    });
  } catch (err) { console.error(err); res.status(500).json({ success: false, message: 'Server error' }); }
});

// ─────────────────────────────────────────────────────────────────────────────
// PUT /api/attendance/:id/convert-to-lop
// Admin-only — a day that's ALREADY a Leave record (approved or pending) is
// converted to LOP: refunds whatever balance it had deducted (paid_days),
// then marks the full day as LOP. leave_type is left as-is so it's still
// clear what kind of leave this was, just now unpaid.
// ─────────────────────────────────────────────────────────────────────────────
router.put('/:id/convert-to-lop', authenticate, authorize('admin'), [
  body('reason').trim().notEmpty().withMessage('A reason is required'),
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ success: false, errors: errors.array() });
  try {
    const { reason } = req.body;
    const record = await AttendanceRecord.findById(req.params.id).lean();
    if (!record) return res.status(404).json({ success: false, message: 'Record not found' });
    if (record.duty_type !== 'Leave') return res.status(400).json({ success: false, message: 'This is not a leave record' });
    if (record.is_lop && (record.paid_days ?? 0) === 0) {
      return res.status(400).json({ success: false, message: 'This record is already fully LOP' });
    }

    const fullDays = countWorkingDays(record.date, record.end_date || record.date);
    if (record.paid_days > 0) {
      const employee = await User.findById(record.emp_id).select('leave_balance').lean();
      await User.findByIdAndUpdate(record.emp_id, {
        $set: { leave_balance: clampLeaveBalance((employee?.leave_balance ?? 0) + record.paid_days) },
      });
    }

    await AttendanceRecord.findByIdAndUpdate(record._id, {
      $set: {
        is_lop: true, paid_days: 0, lop_days: fullDays,
        admin_remark: `Converted to LOP by Admin: ${reason}`,
        actioned_by: req.user.id, actioned_at: new Date(),
      },
    });

    const updated = await AttendanceRecord.findById(record._id).lean();
    await notify(record.emp_id, `${record.leave_type || 'Leave'} Converted to LOP`,
      `Your ${record.leave_type || 'leave'} for ${recordDateLabel(updated)} was converted to Loss of Pay by Admin: ${reason}`,
      'warning', record._id, '/employee/history');
    const empUser = await User.findById(record.emp_id).select('email name').lean();
    if (empUser?.email) {
      sendMail(empUser.email, `[AMS] Leave Converted to LOP`,
        `<p>Hi ${empUser.name},</p><p>Your <strong>${record.leave_type || 'leave'}</strong> for <strong>${recordDateLabel(updated)}</strong> was converted to <strong>Loss of Pay</strong> by an administrator.</p><p><strong>Reason:</strong> ${reason}</p>`
      ).catch(err => console.error('[ConvertToLOP] Employee email failed:', err.message));
    }

    await AuditLog.create({
      _id: uuidv4(), user_id: req.user.id, action: 'ADMIN_CONVERT_TO_LOP',
      entity_type: 'attendance', entity_id: record._id,
      old_value: `paid_days: ${record.paid_days ?? 0}`, new_value: `LOP: ${fullDays}`,
    });

    res.json({ success: true, message: 'Converted to LOP', data: formatRecord(updated) });
  } catch (err) { console.error(err); res.status(500).json({ success: false, message: 'Server error' }); }
});

// ─────────────────────────────────────────────────────────────────────────────
// PUT /api/attendance/:id/convert-lop-to-leave
// Admin-only — reverse of convert-to-lop: a day that's currently LOP (fully
// or partially) is re-costed against the employee's CURRENT balance, same
// split logic as a fresh leave application (paid up to what's available,
// remainder stays LOP).
// ─────────────────────────────────────────────────────────────────────────────
router.put('/:id/convert-lop-to-leave', authenticate, authorize('admin'), [
  body('reason').trim().notEmpty().withMessage('A reason is required'),
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ success: false, errors: errors.array() });
  try {
    const { reason } = req.body;
    const record = await AttendanceRecord.findById(req.params.id).lean();
    if (!record) return res.status(404).json({ success: false, message: 'Record not found' });
    if (record.duty_type !== 'Leave') return res.status(400).json({ success: false, message: 'This is not a leave record' });
    if (!record.is_lop) return res.status(400).json({ success: false, message: 'This record is not LOP' });

    const fullDays = countWorkingDays(record.date, record.end_date || record.date);
    const employee = await User.findById(record.emp_id).select('leave_balance auto_leave_enabled').lean();
    const balance = employee?.leave_balance ?? 0;
    const autoEnabled = employee?.auto_leave_enabled !== false;
    // Refund whatever this record currently has deducted first, so the
    // re-split below always starts from the employee's TRUE available
    // balance (not double-counting what this same record already took).
    const trueBalance = clampLeaveBalance(balance + (record.paid_days ?? 0));
    const newPaidDays = autoEnabled ? Math.min(trueBalance, fullDays) : 0;
    const newLopDays  = roundHalfDay(fullDays - newPaidDays);

    await User.findByIdAndUpdate(record.emp_id, {
      $set: { leave_balance: clampLeaveBalance(trueBalance - newPaidDays) },
    });
    await AttendanceRecord.findByIdAndUpdate(record._id, {
      $set: {
        is_lop: newLopDays > 0, paid_days: newPaidDays, lop_days: newLopDays,
        admin_remark: `Converted to Leave by Admin: ${reason}`,
        actioned_by: req.user.id, actioned_at: new Date(),
      },
    });

    const updated = await AttendanceRecord.findById(record._id).lean();
    await notify(record.emp_id, `LOP Converted to ${record.leave_type || 'Leave'}`,
      `Your Loss of Pay for ${recordDateLabel(updated)} was converted to ${record.leave_type || 'leave'} by Admin: ${reason}`,
      'success', record._id, '/employee/history');
    const empUser = await User.findById(record.emp_id).select('email name').lean();
    if (empUser?.email) {
      sendMail(empUser.email, `[AMS] LOP Converted to Leave`,
        `<p>Hi ${empUser.name},</p><p>Your <strong>Loss of Pay</strong> for <strong>${recordDateLabel(updated)}</strong> was converted to <strong>${record.leave_type || 'leave'}</strong> by an administrator.</p><p><strong>Reason:</strong> ${reason}</p>`
      ).catch(err => console.error('[ConvertLopToLeave] Employee email failed:', err.message));
    }

    await AuditLog.create({
      _id: uuidv4(), user_id: req.user.id, action: 'ADMIN_CONVERT_LOP_TO_LEAVE',
      entity_type: 'attendance', entity_id: record._id,
      old_value: `LOP: ${record.lop_days ?? fullDays}`, new_value: `paid_days: ${newPaidDays}, lop_days: ${newLopDays}`,
    });

    res.json({ success: true, message: newLopDays > 0 ? `Converted — ${newPaidDays} day(s) paid, ${newLopDays} day(s) still LOP (insufficient balance)` : 'Converted to Leave', data: formatRecord(updated) });
  } catch (err) { console.error(err); res.status(500).json({ success: false, message: 'Server error' }); }
});

// ─────────────────────────────────────────────────────────────────────────────
// PUT /api/attendance/:id/hr-override
// ─────────────────────────────────────────────────────────────────────────────
router.put('/:id/hr-override', authenticate, authorize('hr', 'super_admin'), async (req, res) => {
  try {
    const { remark } = req.body;
    if (!remark?.trim()) return res.status(400).json({ success: false, message: 'Override remark is required' });
    const rec = await AttendanceRecord.findById(req.params.id).lean();
    if (!rec) return res.status(404).json({ success: false, message: 'Record not found' });

    if (rec.status === 'Pending') {
      return res.status(400).json({ success: false, message: 'Override is only available after the manager has approved or rejected this record.' });
    }

    const role = req.user.role;
    if (rec.overridden_by && rec.overridden_by !== role)
      return res.status(403).json({ success: false, message: `Already overridden by ${rec.overridden_by === 'hr' ? 'HR' : 'Super Admin'}.`, overridden_by: rec.overridden_by });

    const newStatus = rec.status === 'Approved' ? 'Rejected' : 'Approved';
    await AttendanceRecord.findByIdAndUpdate(req.params.id, {
      $set: {
        status: newStatus, hr_override: true,
        hr_remark: `[${role === 'super_admin' ? 'Super Admin' : 'HR'} Override] ${remark.trim()}`,
        override_remark: remark.trim(), overridden_by: role, hr_actioned_at: new Date(),
        ...(rec.leave_type ? { leave_status: newStatus } : {}),
      },
    });
    await notify(rec.emp_id, `Record ${newStatus} by ${role === 'hr' ? 'HR' : 'Super Admin'}`,
      `Your ${rec.leave_type ? 'leave' : 'attendance'} for ${rec.date} was ${newStatus.toLowerCase()} via override.`,
      newStatus === 'Approved' ? 'success' : 'error', rec._id, '/employee/history');
    await AuditLog.create({ _id: uuidv4(), user_id: req.user.id, action: `HR_OVERRIDE_${newStatus.toUpperCase()}`, entity_type: 'attendance', entity_id: rec._id, old_value: rec.status, new_value: newStatus });
    res.json({ success: true, message: `Overridden to ${newStatus}` });
  } catch (err) { console.error('[HROverride]', err); res.status(500).json({ success: false, message: err.message }); }
});

// ─────────────────────────────────────────────────────────────────────────────
// PUT /api/attendance/:id/leave-request
// ─────────────────────────────────────────────────────────────────────────────
router.put('/:id/leave-request', authenticate, authorize('employee'), [
  body('leaveType').isIn(['Casual Leave', 'Emergency Leave', 'Urgent Leave', 'Planned Leave']),
  body('reason').notEmpty(),
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ success: false, errors: errors.array() });
  try {
    const { leaveType, reason } = req.body;
    const record = await AttendanceRecord.findOne({ _id: req.params.id, emp_id: req.user.id }).lean();
    if (!record) return res.status(404).json({ success: false, message: 'Record not found' });
    if (!record.checkout_time) return res.status(400).json({ success: false, message: 'Must checkout before requesting leave' });
    if (record.leave_type) return res.status(409).json({ success: false, message: 'Leave already requested' });

    await AttendanceRecord.findByIdAndUpdate(record._id, { $set: { leave_type: leaveType, leave_reason: reason, leave_status: 'Pending' } });

    if (record.manager_id) {
      const emp = await User.findById(req.user.id).select('name email').lean();
      await notify(record.manager_id, `${leaveType} Request`, `${emp.name} requested ${leaveType} for ${record.date}: ${reason}`, 'warning', record._id, '/manager/leaves');
      const manager = await User.findById(record.manager_id).select('email name').lean();
      if (manager?.email) {
        await sendMail(manager.email, `[AMS] ${leaveType} Request – ${emp.name}`,
          `<p>Hi ${manager.name},</p><p><strong>${emp.name}</strong> submitted a <strong>${leaveType}</strong> for <strong>${record.date}</strong>.</p><p><strong>Reason:</strong> ${reason}</p><p><strong>Worked:</strong> ${record.worked_hours ?? '—'} hrs</p>`);
      }
    }
    await AuditLog.create({ _id: uuidv4(), user_id: req.user.id, action: 'LEAVE_REQUEST', entity_type: 'attendance', entity_id: record._id, new_value: leaveType });
    const updated = await AttendanceRecord.findById(record._id).lean();
    res.json({ success: true, message: 'Leave request submitted', data: formatRecord(updated) });
  } catch (err) { console.error(err); res.status(500).json({ success: false, message: 'Server error' }); }
});

// ─────────────────────────────────────────────────────────────────────────────
// PUT /api/attendance/:id/edit-leave  — employee edits a pending leave after submission
// ─────────────────────────────────────────────────────────────────────────────
router.put('/:id/edit-leave', authenticate, authorize('employee'), [
  body('leaveType').optional().isIn(['Casual Leave', 'Emergency Leave', 'Urgent Leave', 'Planned Leave']),
  body('reason').optional().notEmpty(),
  body('endDate').optional().isDate(),
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ success: false, errors: errors.array() });
  try {
    const { leaveType, reason, endDate } = req.body;
    const record = await AttendanceRecord.findOne({ _id: req.params.id, emp_id: req.user.id, duty_type: 'Leave' }).lean();
    if (!record) return res.status(404).json({ success: false, message: 'Leave record not found' });
    if (record.leave_status !== 'Pending') return res.status(400).json({ success: false, message: 'Only pending leaves can be edited' });

    const updates = { leave_edited_at: new Date() };
    if (leaveType) updates.leave_type = leaveType;
    if (reason)    updates.leave_reason = reason;
    if (endDate)   updates.end_date = endDate;

    await AttendanceRecord.findByIdAndUpdate(record._id, { $set: updates });

    const emp = await User.findById(req.user.id).select('name manager_id').lean();
    const effectiveType = leaveType || record.leave_type;
    const newReason     = reason    || record.leave_reason;

    const body2 = `<p><strong>${emp.name}</strong> edited their <strong>${effectiveType}</strong> leave for <strong>${record.date}</strong>.</p><p><strong>Updated Reason:</strong> ${newReason}</p>`;

    if (record.manager_id) {
      await notify(record.manager_id, 'Leave Edited', `${emp.name} edited their ${effectiveType} for ${record.date}`, 'warning', record._id, '/manager/leaves');
      const manager = await User.findById(record.manager_id).select('email name').lean();
      if (manager?.email) sendMail(manager.email, `[AMS] Leave Edited – ${emp.name}`, `<p>Hi ${manager.name},</p>${body2}`);
    }
    const admins = await User.find({ role: 'admin', is_active: { $ne: false } }).select('email name').lean();
    admins.forEach(a => { if (a.email) sendMail(a.email, `[AMS] Leave Edited – ${emp.name}`, `<p>Hi ${a.name},</p>${body2}`); });

    await AuditLog.create({ _id: uuidv4(), user_id: req.user.id, action: 'EDIT_LEAVE', entity_type: 'attendance', entity_id: record._id, new_value: JSON.stringify(updates) });
    const updated = await AttendanceRecord.findById(record._id).lean();
    res.json({ success: true, message: 'Leave updated', data: formatRecord(updated) });
  } catch (err) { console.error(err); res.status(500).json({ success: false, message: 'Server error' }); }
});

// ─────────────────────────────────────────────────────────────────────────────
// PUT /api/attendance/:id/reapply
// ─────────────────────────────────────────────────────────────────────────────
router.put('/:id/reapply', authenticate, authorize('employee'), reapplyUpload.array('reapplyDocs', 10), async (req, res) => {
  try {
    const { reason } = req.body;
    if (!reason?.trim()) return res.status(400).json({ success: false, message: 'Reason is required' });
    const record = await AttendanceRecord.findOne({ _id: req.params.id, emp_id: req.user.id }).lean();
    if (!record) return res.status(404).json({ success: false, message: 'Record not found' });
    if (record.status !== 'Rejected') return res.status(400).json({ success: false, message: 'Only rejected records can be re-applied' });

    const docPaths = await Promise.all((req.files || []).map((f, idx) => {
      const ext = path.extname(f.originalname).replace('.', '') || 'bin';
      return uploadFile(f.buffer, `ams/users/${req.user.emp_id || req.user.id}/reapply-docs`, f.originalname, f.mimetype, makeDocName(req.user, `reapply_doc_${idx + 1}`, ext));
    }));
    await AttendanceRecord.findByIdAndUpdate(record._id, {
      $set: { status: 'Pending', manager_remark: null, reapply_reason: reason.trim(), reapply_docs: docPaths, reapplied_at: new Date(), submitted_at: new Date() },
    });

    if (record.manager_id) {
      const emp = await User.findById(req.user.id).select('name email').lean();
      await notify(record.manager_id, 'Re-application Submitted', `${emp.name} re-submitted attendance for ${record.date}: ${reason}`, 'info', record._id, '/manager/leaves');
      const manager = await User.findById(record.manager_id).select('email name').lean();
      if (manager?.email) {
        await sendMail(manager.email, `[AMS] Re-application – ${emp.name} (${record.date})`,
          `<p>Hi ${manager.name},</p><p><strong>${emp.name}</strong> re-submitted attendance for <strong>${record.date}</strong>.</p><p><strong>Reason:</strong> ${reason}</p><p><strong>Docs:</strong> ${docPaths.length} file(s)</p>`);
      }
    }
    await AuditLog.create({ _id: uuidv4(), user_id: req.user.id, action: 'REAPPLY', entity_type: 'attendance', entity_id: record._id, new_value: reason });
    const updated = await AttendanceRecord.findById(record._id).lean();
    res.json({ success: true, message: 'Re-application submitted', data: formatRecord(updated) });
  } catch (err) { console.error(err); res.status(500).json({ success: false, message: 'Server error' }); }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/attendance/stats/summary
// ─────────────────────────────────────────────────────────────────────────────
router.get('/stats/summary', authenticate, async (req, res) => {
  try {
    const { startDate, endDate, empId } = req.query;
    const match = {};
    if (req.user.role === 'employee') match.emp_id = req.user.id;
    else if (req.user.role === 'manager') {
      if (empId) {
        const emp = await User.findOne({ _id: empId, manager_id: req.user.id }).lean();
        if (!emp) return res.status(403).json({ success: false, message: 'Not your team member' });
        match.emp_id = empId;
      } else {
        const teamMembers = await User.find({ manager_id: req.user.id }).select('_id').lean();
        match.emp_id = { $in: teamMembers.map(m => m._id) };
      }
    }
    if (startDate) match.date = { ...match.date, $gte: startDate };
    if (endDate)   match.date = { ...match.date, $lte: endDate };

    const result = await AttendanceRecord.aggregate([
      { $match: match },
      { $group: {
        _id: null,
        total:           { $sum: 1 },
        approved:        { $sum: { $cond: [{ $eq: ['$status', 'Approved']           }, 1, 0] } },
        pending:         { $sum: { $cond: [{ $eq: ['$status', 'Pending']            }, 1, 0] } },
        rejected:        { $sum: { $cond: [{ $eq: ['$status', 'Rejected']           }, 1, 0] } },
        draft:           { $sum: { $cond: [{ $eq: ['$status', 'Draft']              }, 1, 0] } },
        missed_checkout: { $sum: { $cond: [{ $eq: ['$is_missed_checkout', true]     }, 1, 0] } },
        on_duty:         { $sum: { $cond: [{ $eq: ['$duty_type', 'On Duty']         }, 1, 0] } },
        office_duty:     { $sum: { $cond: [{ $eq: ['$duty_type', 'Office Duty']     }, 1, 0] } },
        
        casual_leave:    { $sum: { $cond: [{ $eq: ['$leave_type', 'Casual Leave']   }, 1, 0] } },
        half_day:        { $sum: { $cond: [{ $eq: ['$leave_type', 'Half Day']       }, 1, 0] } },
        emergency_leave: { $sum: { $cond: [{ $eq: ['$leave_type', 'Emergency Leave']}, 1, 0] } },
        total_leaves:    { $sum: { $cond: [{ $ne:  ['$leave_type', null]            }, 1, 0] } },
        lop_count:       { $sum: { $cond: [{ $eq: ['$status', 'Rejected']           }, 1, 0] } },
      }},
      { $project: { _id: 0 } },
    ]);
    const stats = result[0] || { total:0, approved:0, pending:0, rejected:0, draft:0, missed_checkout:0, on_duty:0, office_duty:0, casual_leave:0, half_day:0, emergency_leave:0, total_leaves:0, lop_count:0 };
    res.json({ success: true, data: stats });
  } catch (err) { console.error(err); res.status(500).json({ success: false, message: 'Server error' }); }
});

// ─────────────────────────────────────────────────────────────────────────────
// Scan upload / delete endpoints
// ─────────────────────────────────────────────────────────────────────────────
router.post('/upload-scan', authenticate, authorize('employee'), uploadScan.single('scan'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ success: false, message: 'No file provided' });
    const day      = istDateStr();
    const dayLabel = new Date().toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'long', year: 'numeric' });
    const currentUser = await User.findById(req.user.id).select('scan_papers').lean();
    const arr         = currentUser?.scan_papers || [];
    const existing    = Array.isArray(arr) ? arr.filter(s => (s.day || s.date) === day) : (arr[day]?.files || []);
    if (existing.length >= 3) return res.status(400).json({ success: false, message: 'Max 2 files already uploaded for today.' });
    const fileIndex = existing.length;
    const _scanExt = path.extname(req.file.originalname).replace('.', '') || 'pdf';
    const scanPath  = await uploadFile(req.file.buffer, `ams/users/${req.user.emp_id || req.user.id}/scans`, req.file.originalname, req.file.mimetype, makeDocName(req.user, `scan_${day}`, _scanExt));
    await User.findByIdAndUpdate(req.user.id, {
      $push: { scan_papers: { path: scanPath, day, day_label: dayLabel, file_name: req.file.originalname, file_index: fileIndex, uploaded_at: new Date() } },
    }, { strict: false });
    res.json({ success: true, scanPath, day, dayLabel, fileIndex, totalForDay: fileIndex + 1 });
  } catch (err) { console.error(err); res.status(500).json({ success: false, message: 'Server error' }); }
});

router.delete('/clear-scan', authenticate, authorize('employee'), async (req, res) => {
  try {
    const dayParam  = req.query.day || req.query.month || null;
    const fileIndex = req.query.fileIndex !== undefined ? parseInt(req.query.fileIndex, 10) : undefined;
    const u   = await User.findById(req.user.id).select('scan_papers').lean();
    const arr = u?.scan_papers || [];
    if (!Array.isArray(arr)) {
      await User.findByIdAndUpdate(req.user.id, { $set: { scan_papers: [] } }, { strict: false });
      return res.json({ success: true });
    }
    let updated;
    if (dayParam && fileIndex !== undefined)
      updated = arr.filter(s => !((s.day === dayParam || s.date === dayParam || s.month === dayParam) && s.file_index === fileIndex));
    else if (dayParam)
      updated = arr.filter(s => s.day !== dayParam && s.date !== dayParam && s.month !== dayParam);
    else
      updated = [];
    await User.findByIdAndUpdate(req.user.id, { $set: { scan_papers: updated } }, { strict: false });
    res.json({ success: true });
  } catch (err) { console.error(err); res.status(500).json({ success: false, message: 'Server error' }); }
});

// ─────────────────────────────────────────────────────────────────────────────
// Signed reports endpoints
// ────────────────────────────────────────────────────────────────────────────
router.post('/upload-signed-report', authenticate, uploadSignedReport.single('signedReport'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ success: false, message: 'No file provided' });
    const { month } = req.body;
    if (!month || !/^\d{4}-\d{2}$/.test(month)) return res.status(400).json({ success: false, message: 'Valid month (YYYY-MM) is required' });
    let targetEmpId = req.user.id;
    if (['admin', 'super_admin'].includes(req.user.role) && req.body.empId) {
      targetEmpId = req.body.empId;
    } else if (['manager', 'hr'].includes(req.user.role) && req.body.empId) {
      const empCheck = await User.findOne({ _id: req.body.empId, manager_id: req.user.id }).select('_id').lean();
      if (!empCheck) return res.status(403).json({ success: false, message: 'Access denied: employee not in your team' });
      targetEmpId = req.body.empId;
    }
    if (req.user.role === 'employee') {
      const existingUser = await User.findById(targetEmpId).select('signed_reports').lean();
      if ((existingUser?.signed_reports || []).some(r => r.month === month))
        return res.status(409).json({ success: false, message: `A signed report has already been uploaded for ${month}. Contact your admin to replace it.` });
    }
    const monthLabel = new Date(`${month}-01`).toLocaleDateString('en-IN', { month: 'long', year: 'numeric', timeZone: 'Asia/Kolkata' });
    const targetUser  = await User.findById(targetEmpId).select('emp_id name').lean();
    const folderPath  = employeeFolderPath(targetUser?.emp_id, targetEmpId);
    const _srExt      = path.extname(req.file.originalname).replace('.', '') || 'pdf';
    const _srName     = `${(targetUser?.name || 'unknown').replace(/\s+/g,'_').replace(/[^a-zA-Z0-9_-]/g,'')}_${targetUser?.emp_id || targetEmpId}_signed_report_${month}`;
    const signedPath  = await uploadFile(req.file.buffer, `${folderPath}/signed-reports`, req.file.originalname, req.file.mimetype, `${_srName}.${_srExt}`);
    // const entry = { path: signedPath, name: req.file.originalname, month, month_label: monthLabel, uploaded_at: new Date(), uploaded_by: req.user.id };
    // const cutoff = new Date(); cutoff.setMonth(cutoff.getMonth() - 3);
    // await User.findByIdAndUpdate(targetEmpId, { $pull: { signed_reports: { uploaded_at: { $lt: cutoff } } } }, { strict: false });
    // await User.findByIdAndUpdate(targetEmpId, { $push: { signed_reports: entry } }, { strict: false });
    const entry = { path: signedPath, name: req.file.originalname, month, month_label: monthLabel, uploaded_at: new Date(), uploaded_by: req.user.id };
await User.findByIdAndUpdate(targetEmpId, { $push: { signed_reports: entry } }, { strict: false });
    if (req.user.role === 'employee') {
      const emp = await User.findById(req.user.id).select('name manager_id').lean();
      if (emp?.manager_id) await notify(emp.manager_id, 'Signed Report Uploaded', `${emp.name} uploaded the signed attendance report for ${monthLabel}.`, 'info', null, '/manager/reports');
    }
    await AuditLog.create({ _id: uuidv4(), user_id: req.user.id, action: 'UPLOAD_SIGNED_REPORT', entity_type: 'user', entity_id: targetEmpId, new_value: `${month} signed report` });
    res.status(201).json({ success: true, message: `Signed report uploaded for ${monthLabel}`, path: signedPath, month, monthLabel });
  } catch (err) { console.error('[upload-signed-report]', err); res.status(500).json({ success: false, message: 'Server error' }); }
});

router.delete('/signed-reports/:empId/:month', authenticate, authorize('employee', 'manager', 'admin', 'hr', 'super_admin'), async (req, res) => {
  try {
    const { empId, month } = req.params;
    if (!/^\d{4}-\d{2}$/.test(month)) return res.status(400).json({ success: false, message: 'Invalid month format (YYYY-MM)' });

    if (req.user.role === 'employee' && req.user.id !== empId) {
      return res.status(403).json({ success: false, message: 'Not authorized to delete this report' });
    }

    const emp = await User.findById(empId).select('signed_reports manager_id name').lean();
    if (!emp) return res.status(404).json({ success: false, message: 'Employee not found' });
    if (req.user.role === 'manager' && emp.manager_id !== req.user.id)
      return res.status(403).json({ success: false, message: "Not authorized to delete this employee's report" });

    const { path: pathToDelete } = req.query; // optional — deletes just one file if given
    const updated = pathToDelete
      ? (emp.signed_reports || []).filter(r => !(r.month === month && r.path === pathToDelete))
      : (emp.signed_reports || []).filter(r => r.month !== month);

    await User.findByIdAndUpdate(empId, { $set: { signed_reports: updated } }, { strict: false });
    await AuditLog.create({ _id: uuidv4(), user_id: req.user.id, action: 'DELETE_SIGNED_REPORT', entity_type: 'user', entity_id: empId, old_value: month });
    res.json({ success: true, message: `Signed report deleted` });
  } catch (err) { console.error(err); res.status(500).json({ success: false, message: 'Server error' }); }
});

router.get('/signed-reports/:empId', authenticate, async (req, res) => {
  try {
    const isOwnRequest = req.user.id === req.params.empId;
    if (!isOwnRequest && !['manager', 'admin', 'hr', 'super_admin'].includes(req.user.role))
      return res.status(403).json({ success: false, message: 'Access denied' });
    if (!isOwnRequest && req.user.role === 'manager') {
      const teamCheck = await User.findOne({ _id: req.params.empId, manager_id: req.user.id }).select('_id').lean();
      if (!teamCheck) return res.status(403).json({ success: false, message: 'Access denied: employee not in your team' });
    }
    const emp = await User.findById(req.params.empId).select('signed_reports name emp_id').lean();
    if (!emp) return res.status(404).json({ success: false, message: 'Employee not found' });
    const reports = (emp.signed_reports || [])
      .slice()
      .sort((a, b) => new Date(b.uploaded_at) - new Date(a.uploaded_at))
      .map(r => ({ path: r.path, name: r.name, month: r.month, monthLabel: r.month_label, uploadedAt: r.uploaded_at, uploadedBy: r.uploaded_by }));
    res.json({ success: true, data: reports });
  } catch (err) { console.error(err); res.status(500).json({ success: false, message: 'Server error' }); }
});

// ─────────────────────────────────────────────────────────────────────────────
// Format helper
// ─────────────────────────────────────────────────────────────────────────────
function formatRecord(r) {
  return {
    id:                       r._id || r.id,
    empId:                    r.emp_id,
    empName:                  r.emp_name,
    empCode:                  r.emp_code,
    department:               _fullyDecode(r.department || ''),
    date:                     r.date,
    endDate:                  r.end_date   || null,
    dutyType:                 r.duty_type,
    sector:                   r.sector,
    description:              r.description,
    status:                   r.status,
    selfiePath:               r.selfie_path,
    latitude:                 r.latitude,
    longitude:                r.longitude,
    locationAddress:          r.location_address,
    checkinTime:              r.checkin_time,
    checkoutTime:             r.checkout_time,
    checkoutSelfiePath:       r.checkout_selfie_path,
    checkoutLat:              r.checkout_lat,
    checkoutLng:              r.checkout_lng,
    checkoutLocationAddress:  r.checkout_location_address,
    locationFlagged:          r.location_flagged === true,
    locationFlagReason:       r.location_flag_reason || null,
    managerId:                r.manager_id,
    managerName:              r.manager_name,
    managerRemark:            r.manager_remark ? r.manager_remark.replace(/^\[(HR|Super Admin) Override\]\s*/i, '').trim() : '',
    adminRemark:              r.admin_remark,
    actionedBy:               r.actioned_by,
    actionedByName:           r.actioned_by_name,
    actionedAt:               r.actioned_at,
    submittedAt:              r.submitted_at,
    createdAt:                r.created_at,
    workedHours:              r.worked_hours,
    isMissedCheckout:         r.is_missed_checkout || false,
    checkoutRemarks:          r.checkout_remarks,
    isAutoCheckout:           r.is_auto_checkout || false,
    lateCheckoutReason:       r.late_checkout_reason || null,
    lateCheckoutRequestedAt:  r.late_checkout_requested_at || null,
    leaveType:                r.leave_type,
    leaveReason:              r.leave_reason,
    leaveStatus:              r.leave_status,
    reapplyReason:            r.reapply_reason,
    reapplyDocs:              r.reapply_docs  || [],
    reappliedAt:              r.reapplied_at,
    hrOverride:               r.hr_override   || false,
    hrRemark:                 r.hr_remark     || '',
    overrideRemark:           r.override_remark || '',
    overriddenBy:             r.overridden_by || null,
    hrActionedBy:             r.hr_actioned_by || null,
    hrActionedAt:             r.hr_actioned_at || null,
       faceVerificationStatus:   r.face_verification_status || null,
    faceConfidence:           r.face_confidence ?? null,
    faceRetakeCount:          r.face_retake_count || 0,
    faceRetakeReason:         r.face_retake_reason || null,
        checkoutFaceVerificationStatus: r.checkout_face_verification_status || null,
    checkoutFaceConfidence:         r.checkout_face_confidence ?? null,
    empProfilePhoto:          r.emp_face_photo || r.emp_profile_photo || null,
    attendanceType:           r.attendance_type || null,
  };
}

module.exports = router;