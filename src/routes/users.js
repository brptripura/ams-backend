const express    = require('express');
const router     = express.Router();
const bcrypt     = require('bcryptjs');
const multer     = require('multer');
const ExcelJS    = require('exceljs');
const { v4: uuidv4 } = require('uuid');
const { body, validationResult } = require('express-validator');
const { User, AttendanceRecord, Notification, AuditLog } = require('../models/database');
const { authenticate, authorize } = require('../middleware/auth');
const { sendMail } = require('../utils/mailer');
const path            = require('path');
const { uploadFile }  = require('../utils/storage');
const { clampLeaveBalance } = require('../utils/leaveBalance');

const uploadMem = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

const escapeHtml = s => String(s ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#039;');

const validate = (req, res, next) => {
  const errs = validationResult(req);
  if (!errs.isEmpty()) return res.status(422).json({ success: false, message: errs.array()[0].msg, errors: errs.array() });
  next();
};

const uploadProfilePhoto = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024 }, // 8 MB
  fileFilter: (req, file, cb) => {
    if (!file.mimetype.startsWith('image/')) return cb(new Error('Only images allowed'));
    const ext = path.extname(file.originalname).toLowerCase();
    if (!['.jpg', '.jpeg', '.png', '.webp'].includes(ext)) return cb(new Error('Only JPG, PNG or WEBP'));
    cb(null, true);
  },
});
 
// ── GET /api/users ────────────────────────────────────────────────────────
router.get('/', authenticate, authorize('manager', 'admin', 'hr', 'super_admin'), async (req, res) => {
  try {
    let users;
    if (['admin', 'hr', 'super_admin'].includes(req.user.role)) {
      users = await User.aggregate([
        { $lookup: { from: 'users', localField: 'manager_id', foreignField: '_id', as: 'manager' } },
        { $lookup: { from: 'users', localField: 'hr_id',      foreignField: '_id', as: 'hr'      } },
        { $addFields: {
    manager_name: { $arrayElemAt: ['$manager.name', 0] },
    hr_name:      { $arrayElemAt: ['$hr.name',      0] },
}},
        
        { $project: { manager: 0, password_hash: 0 } },
        { $sort: { role: 1, name: 1 } },
      ]);
    } else {
      users = await User
        .find({ manager_id: req.user.id })
        .select('-password_hash')
        .sort({ name: 1 })
        .lean();
    }
    res.json({ success: true, data: users.map(formatUser) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ── GET /api/users/managers ───────────────────────────────────────────────
router.get('/managers', authenticate, authorize('manager', 'admin', 'hr', 'super_admin'), async (req, res) => {
  try {
    const managers = await User
      .find({ role: 'manager', is_active: 1 })
      .select('emp_id name email department')
      .lean();
    res.json({ success: true, data: managers.map(m => ({ ...m, id: m._id })) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ── GET /api/users/locations ──────────────────────────────────────────────
router.get('/locations', authenticate, async (req, res) => {
  try {
    const [blocks, districts] = await Promise.all([
      User.distinct('assigned_block',    { assigned_block:    { $ne: null, $exists: true } }),
      User.distinct('assigned_district', { assigned_district: { $ne: null, $exists: true } }),
    ]);
    const locations = [...new Set([...blocks.filter(Boolean), ...districts.filter(Boolean)])].sort();
    res.json({ success: true, data: locations });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ── GET /api/users/employees ──────────────────────────────────────────────
router.get('/employees', authenticate, authorize('manager', 'admin', 'hr', 'super_admin'), async (req, res) => {
  try {
    let filter = { role: 'employee', is_active: 1 };
    if (req.query.manager_id) {
      filter.manager_id = req.query.manager_id;
    } else if (req.user.role === 'manager') {
      filter.manager_id = req.user.id;
    }
    const employees = await User
      .find(filter)
      .select('emp_id name email department assigned_block manager_id')
      .sort({ name: 1 })
      .lean();
    res.json({ success: true, data: employees });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ── GET /api/users/team/attendance-summary ────────────────────────────────
// Must be BEFORE /:id to avoid Express route shadowing
router.get('/team/attendance-summary', authenticate, authorize('manager', 'admin'), async (req, res) => {
  try {
    const today      = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
    const matchStage = req.user.role === 'manager'
      ? { manager_id: req.user.id }
      : { role: 'employee' };

    const summary = await User.aggregate([
      { $match: matchStage },
      {
        $lookup: {
          from:     'attendancerecords',
          let:      { empId: '$_id' },
          pipeline: [{ $match: { $expr: { $and: [
            { $eq: ['$emp_id', '$$empId'] },
            { $or: [
              { $eq: ['$date', today] },
              { $and: [{ $lte: ['$date', today] }, { $gte: ['$end_date', today] }] },
            ]},
          ]}}}],
          as: 'todayRecord',
        },
      },
      {
        $addFields: {
          today_status:       { $arrayElemAt: ['$todayRecord.status',       0] },
          today_duty:         { $arrayElemAt: ['$todayRecord.duty_type',    0] },
          today_leave_status: { $arrayElemAt: ['$todayRecord.leave_status', 0] },
          today_leave_type:   { $arrayElemAt: ['$todayRecord.leave_type',   0] },
          checkin_time:       { $arrayElemAt: ['$todayRecord.checkin_time', 0] },
          checkout_time:      { $arrayElemAt: ['$todayRecord.checkout_time',0] },
        },
      },
      { $project: { password_hash: 0, todayRecord: 0 } },
      { $sort: { name: 1 } },
    ]);

    res.json({ success: true, data: summary });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ── GET /api/users/bulk-upload/template ──────────────────────────────────
// Must be BEFORE /:id
router.get('/bulk-upload/template', authenticate, authorize('super_admin', 'admin'), async (req, res) => {
  try {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Users Template');
    const templateData = [
      ['name', 'email', 'empId', 'password', 'role', 'roleType', 'designation', 'department', 'managerId', 'phone', 'assignedBlock', 'assignedDistrict', 'joiningDate'],
      ['Manager One',  'manager1@brp.com', 'MGR001', 'R@m%Brp@26', 'manager',  'BRP',     '', 'Engineering',    '',       '9876500001', 'Agartala', 'West Tripura', '2024-01-01'],
      ['HR One',       'hr1@brp.com',      'HR001',  'R@m%Brp@26', 'hr',       'HR',      '', 'HR',             '',       '9876500010', 'Agartala', 'West Tripura', '2024-01-01'],
      ['Admin One',    'admin1@brp.com',   'ADM001', 'R@m%Brp@26', 'admin',    '',        '', 'Administration', '',       '9876500020', 'Agartala', 'West Tripura', '2024-01-01'],
      ['Rajesh Kumar', 'rajesh@brp.com',   'EMP001', 'R@m%Brp@26', 'employee', 'ULB BRP', '', 'Engineering',    'MGR001', '9876543210', 'Agartala', 'West Tripura', '2024-06-15'],
    ];
    templateData.forEach(row => ws.addRow(row));
    [16,22,10,12,12,10,14,16,14,13,14,16,14].forEach((w, i) => { ws.getColumn(i + 1).width = w; });

    const rules = wb.addWorksheet('Rules');
    [
      ['Column','Required','Notes'],
      ['name','YES','Full name'],['email','YES','Valid unique email'],
      ['empId','YES','Unique employee ID'],['password','YES*','Min 6 chars. Required for new users only.'],
      ['role','YES','employee, manager, admin, hr, super_admin'],
      ['roleType','NO','BRP, ULB BRP, HR, or Legal'],['joiningDate','NO','YYYY-MM-DD format (e.g. 2024-06-15)'],
      ['designation','NO','Job title'],
      ['department','YES','Department name'],
      ['managerId','NO','Manager emp_id OR full name'],['phone','NO','10-digit mobile'],
      ['assignedBlock','NO','Block name'],['assignedDistrict','NO','District name'],
      ['','',''],['NOTE','','Add manager rows ABOVE employee rows'],
    ].forEach(row => rules.addRow(row));
    [18,10,65].forEach((w, i) => { rules.getColumn(i + 1).width = w; });

    const buf = await wb.xlsx.writeBuffer();
    res.setHeader('Content-Disposition', 'attachment; filename="bulk_upload_template.xlsx"');
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.send(buf);
  } catch (err) {
    res.status(500).json({ success: false, message: 'Template generation failed' });
  }
});

// ── GET /api/users/export-reset-links ────────────────────────────────────
// Generates fresh 24-hour reset links for all active employees/managers/HR
// and returns an Excel file — no SMTP required, admin shares links directly.
router.get('/export-reset-links', authenticate, authorize('super_admin', 'admin'), async (req, res) => {
  try {
    const crypto   = require('crypto');
    const FRONTEND = process.env.FRONTEND_URL || 'https://monitormark.brptripura.com';
    const users    = await User.find({ is_active: 1, role: { $nin: ['super_admin', 'admin'] } })
                               .select('_id name email emp_id role assigned_block assigned_district')
                               .sort({ name: 1 })
                               .lean();

    const rows = [];
    for (const u of users) {
      const rawToken = crypto.randomBytes(32).toString('hex');
      const hashTok  = crypto.createHash('sha256').update(rawToken).digest('hex');
      await User.findByIdAndUpdate(u._id, {
        $set: { pwd_reset_token: hashTok, pwd_reset_expires: new Date(Date.now() + 24 * 60 * 60 * 1000) }
      });
      rows.push({
        name:     u.name,
        emp_id:   u.emp_id,
        email:    u.email,
        role:     u.role,
        block:    u.assigned_block    || '',
        district: u.assigned_district || '',
        reset_link: `${FRONTEND}/reset-password?token=${rawToken}`,
      });
    }

    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Reset Links');
    ws.columns = [
      { header: 'Name',        key: 'name',       width: 28 },
      { header: 'Emp ID',      key: 'emp_id',     width: 14 },
      { header: 'Email',       key: 'email',      width: 32 },
      { header: 'Role',        key: 'role',       width: 12 },
      { header: 'Block',       key: 'block',      width: 20 },
      { header: 'District',    key: 'district',   width: 18 },
      { header: 'Reset Link (valid 24 hrs)', key: 'reset_link', width: 80 },
    ];
    ws.getRow(1).font = { bold: true };
    rows.forEach(r => ws.addRow(r));
    ws.getColumn('reset_link').eachCell((cell, rowNum) => {
      if (rowNum === 1) return;
      cell.value = { text: 'Click to reset', hyperlink: cell.value };
      cell.font  = { color: { argb: 'FF0563C1' }, underline: true };
    });

    const buf = await wb.xlsx.writeBuffer();
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="reset-links-${Date.now()}.xlsx"`);
    res.send(buf);
    console.log(`[ExportResetLinks] Generated ${rows.length} links by ${req.user.emp_id}`);
  } catch (err) {
    console.error('[ExportResetLinks]', err.message);
    res.status(500).json({ success: false, message: err.message });
  }
});

// ── GET /api/users/leave-balances — manager/admin/hr view team leave balances ──
// Must be BEFORE /:id — a GET route with no distinguishing extra path segment
// (like this one and leave-balance-template below) gets shadowed by the
// catch-all GET /:id if it's declared afterwards, because Express matches
// top-to-bottom and "leave-balances" would just get treated as an :id value.
router.get('/leave-balances', authenticate, authorize('manager', 'admin', 'hr', 'super_admin'), async (req, res) => {
  try {
    // Mirror exact same query pattern as GET /users and /team/attendance-summary
    const query = req.user.role === 'manager'
      ? { manager_id: req.user.id }
      : { role: 'employee' };
    const employees = await User.find(query)
      .select('_id name emp_id leave_balance last_accrual_date joining_date auto_leave_enabled block_name role')
      .sort({ name: 1 })
      .lean();
    // For admin/hr views, filter to employees only (managers may have mixed roles in their list)
    const filtered = req.user.role === 'manager'
      ? employees
      : employees.filter(e => e.role === 'employee');
    res.json({ success: true, data: filtered });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ── GET /api/users/leave-balance-template — download Excel template ──
// Must also be BEFORE /:id, same reasoning as above.
router.get('/leave-balance-template', authenticate, authorize('manager', 'admin', 'hr', 'super_admin'), async (req, res) => {
  try {
    const query = req.user.role === 'manager'
      ? { manager_id: req.user.id }
      : { role: 'employee' };
    const allEmps = await User.find(query).select('name emp_id leave_balance').lean();
    const employees = req.user.role === 'manager' ? allEmps : allEmps.filter(e => true);

    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Leave Balances');
    ws.columns = [
      { header: 'Employee Code (emp_id)', key: 'emp_id', width: 24 },
      { header: 'Name (read-only)', key: 'name', width: 28 },
      { header: 'New Balance (0–24, whole days)', key: 'leave_balance', width: 28 },
      { header: 'Reason', key: 'reason', width: 32 },
    ];
    ws.getRow(1).font = { bold: true };
    ws.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE9D8FD' } };

    for (const emp of allEmps) {
      ws.addRow({
        emp_id: emp.emp_id || '',
        name: emp.name || '',
        leave_balance: emp.leave_balance ?? 0,
        reason: '',
      });
    }

    const buf = await wb.xlsx.writeBuffer();
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename="leave_balance_template.xlsx"');
    res.send(buf);
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ── GET /api/users/:id ────────────────────────────────────────────────────
// Includes scan_papers array — used by ReportsPage to show employee scans
router.get('/:id', authenticate, async (req, res) => {
  try {
    // Employees can only fetch their own profile; managers only their team members
    if (req.user.role === 'employee' && req.params.id !== req.user.id) {
      return res.status(403).json({ success: false, message: 'Access denied' });
    }
    if (req.user.role === 'manager' && req.params.id !== req.user.id) {
      const teamCheck = await User.findOne({ _id: req.params.id, manager_id: req.user.id }).select('_id').lean();
      if (!teamCheck) return res.status(403).json({ success: false, message: 'Access denied' });
    }
    const user = await User.findById(req.params.id)
      .select('-password_hash -email_verify_token -pwd_reset_token -phone_otp -login_attempts -login_locked_until')
      .lean();
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });
    res.json({ success: true, data: formatUser(user) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ── POST /api/users ───────────────────────────────────────────────────────
router.post('/', authenticate, authorize('admin', 'super_admin'), [
  body('name').notEmpty().withMessage('Name is required'),
  body('email').isEmail().withMessage('Valid email is required').normalizeEmail({ gmail_remove_dots: false, gmail_remove_subaddress: false, all_lowercase: true }),
  body('empId').notEmpty().withMessage('Employee ID is required'),
  body('role').isIn(['employee', 'manager', 'admin', 'hr', 'super_admin', 'department_portal']).withMessage('Invalid role'),
  body('department').notEmpty().withMessage('Department is required'),
], validate, async (req, res) => {
  try {
    const { name, email, empId, role, department, managerId, hrId, phone, assignedBlock, assignedDistrict, roleType, designation, joiningDate, officeName, reportingOfficerName, reportingOfficerDesignation } = req.body;
    
    if (req.user.role === 'admin' && ['admin', 'super_admin'].includes(role))
      return res.status(403).json({ success: false, message: 'Admins cannot create admin or super admin accounts' });
    
    const existingEmail = await User.findOne({ email }).lean();
    if (existingEmail) return res.status(409).json({ success: false, message: 'Email already exists' });
    
    const existingEmpId = await User.findOne({ emp_id: empId }).lean();
    if (existingEmpId) return res.status(409).json({ success: false, message: 'Employee ID already exists' });
    
    const crypto    = require('crypto');
    const genToken  = () => crypto.randomBytes(32).toString('hex');
    const hashToken = (t) => crypto.createHash('sha256').update(t).digest('hex');
    const rawVerifyToken  = genToken(); 
    const hashedVerifyTok = hashToken(rawVerifyToken);
    const rawResetToken   = genToken(); 
    const hashedResetTok  = hashToken(rawResetToken);
    const tempPassword    = `Tmp@${crypto.randomBytes(8).toString('hex')}`;
    const id = uuidv4();
    
    // ── FIX 1A: Include roleType and designation ──
    await User.create({
      _id: id, 
      emp_id: empId, 
      name, 
      email,
      password_hash: bcrypt.hashSync(tempPassword, 12), 
      role, 
      department,
      manager_id: managerId || null, 
      hr_id: hrId || null,
      phone: phone || null,
      assigned_block: assignedBlock || null, 
      assigned_district: assignedDistrict || null,
      role_type: roleType || null,        // ← FIX: Save roleType
      designation: designation || null,    // ← FIX: Save designation
      joining_date:                  joiningDate                  || null,
      office_name:                   officeName                   || null,
      reporting_officer_name:        reportingOfficerName        || null,
      reporting_officer_designation: reportingOfficerDesignation || null,
      email_verified: false,
      email_verify_token: hashedVerifyTok, 
      email_verify_expires: new Date(Date.now() + 86400000),
      pwd_reset_token: hashedResetTok, 
      pwd_reset_expires: new Date(Date.now() + 86400000),
    });
    
    // Send welcome email with app's own reset link (same SMTP that powers forgot-password)
    const { sendMail } = require('../utils/mailer');
    const FRONTEND  = process.env.FRONTEND_URL || 'https://monitormark.brptripura.com';
    const resetUrl  = `${FRONTEND}/reset-password?token=${rawResetToken}`;

    sendMail(
      email,
      'BRP Attendance System - Your Account is Ready',
      `<!DOCTYPE html><html><head><meta charset="UTF-8"></head>
<body style="margin:0;padding:0;background:#f2f6f8;font-family:Arial,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#f2f6f8;padding:40px 0;">
<tr><td align="center">
<table width="560" cellpadding="0" cellspacing="0"
  style="background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 4px 20px rgba(0,0,0,.08);">
<tr><td style="background:#0b1e3b;padding:28px 32px;">
  <h1 style="margin:0;color:#fff;font-size:22px;font-weight:800;">BRP · AMS</h1>
  <p style="margin:4px 0 0;color:rgba(255,255,255,.6);font-size:13px;">Attendance Management System</p>
</td></tr>
<tr><td style="padding:32px;">
  <h2 style="margin:0 0 16px;color:#0b1e3b;font-size:18px;">Welcome, ${name}! Set Your Password</h2>
  <p style="color:#475569;font-size:14px;line-height:1.6;">
    Your BRP AMS account has been created. Click the button below to set your password and activate your account.
  </p>
  <p style="color:#475569;font-size:14px;line-height:1.6;">
    <strong>Employee ID:</strong> ${empId}<br/>
    <strong>Role:</strong> ${role}
  </p>
  <div style="text-align:center;margin:28px 0;">
    <a href="${resetUrl}"
      style="background:#21879d;color:#fff;padding:14px 32px;border-radius:8px;
             text-decoration:none;font-weight:700;font-size:15px;display:inline-block;">
      Set My Password
    </a>
  </div>
  <p style="color:#94a3b8;font-size:12px;word-break:break-all;">
    Or copy this link: ${resetUrl}
  </p>
  <p style="color:#dc2626;font-size:13px;">
    This link expires in <strong>24 hours</strong>. If you did not expect this email, contact your administrator.
  </p>
  <hr style="border:none;border-top:1px solid #e2e8f0;margin:28px 0;">
  <p style="margin:0;color:#94a3b8;font-size:12px;">Do not reply to this email · BRP AMS Automated System</p>
</td></tr>
</table>
</td></tr></table></body></html>`
    ).catch(err => console.error('[User Create] Welcome email failed:', err.message));

    const user = await User.findById(id).select('-password_hash -email_verify_token -pwd_reset_token -phone_otp -login_attempts -login_locked_until').lean();
    res.status(201).json({ success: true, message: 'User created. Password setup email sent to ' + email, data: formatUser(user) });
  } catch (err) { 
    console.error(err); 
    res.status(500).json({ success: false, message: 'Server error' }); 
  }
});

// ── POST /api/users/reset-all-passwords ──────────────────────────────────
router.post('/reset-all-passwords', authenticate, authorize('super_admin', 'admin'), async (req, res) => {
  try {
    const expiry24h   = req.body?.expiry === '24h';
    const expiryMs    = expiry24h ? 24 * 60 * 60 * 1000 : 30 * 60 * 1000;
    const expiryLabel = expiry24h ? '24 hours' : '30 minutes';

    const crypto  = require('crypto');
    const FRONTEND = process.env.FRONTEND_URL || 'https://monitormark.brptripura.com';

    const users = await User.find({ is_active: 1, role: { $nin: ['super_admin', 'admin'] } }).select('_id name email emp_id role').lean();

    // Respond immediately — bulk send runs in background to avoid Render's 30s request timeout
    res.json({ success: true, message: `Sending password reset emails to ${users.length} users in background (link expires in ${expiryLabel}). Check server logs for results.` });

    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    let sent = 0, failed = 0;
    for (const target of users) {
      try {
        const rawToken  = crypto.randomBytes(32).toString('hex');
        const hashTok   = crypto.createHash('sha256').update(rawToken).digest('hex');
        const tempPass  = `Tmp@${crypto.randomBytes(8).toString('hex')}`;
        await User.findByIdAndUpdate(target._id, { $set: { password_hash: bcrypt.hashSync(tempPass, 12), pwd_reset_token: hashTok, pwd_reset_expires: new Date(Date.now() + expiryMs) } });
        const resetUrl = `${FRONTEND}/reset-password?token=${rawToken}`;
        await sendMail(target.email, 'BRP Attendance System - Password Reset by Admin',
          `<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"></head>
<body style="margin:0;padding:0;background:#f2f6f8;font-family:Arial,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#f2f6f8;padding:40px 0;">
<tr><td align="center">
<table width="560" cellpadding="0" cellspacing="0" style="background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 4px 20px rgba(0,0,0,.08);">
<tr><td style="background:#0b1e3b;padding:28px 32px;">
  <h1 style="margin:0;color:#fff;font-size:22px;font-weight:800;">BRP · AMS</h1>
  <p style="margin:4px 0 0;color:rgba(255,255,255,.6);font-size:13px;">Attendance Management System</p>
</td></tr>
<tr><td style="padding:32px;">
  <h2 style="margin:0 0 16px;color:#0b1e3b;font-size:18px;">Password Reset Request</h2>
  <p style="color:#475569;font-size:14px;line-height:1.6;">Hi <strong>${target.name}</strong>, your password has been reset by an administrator.</p>
  <p style="color:#475569;font-size:14px;line-height:1.6;">Click the button below to set your new password. This link expires in <strong>${expiryLabel}</strong>.</p>
  <div style="text-align:center;margin:28px 0;">
    <a href="${resetUrl}" style="background:#21879d;color:#fff;padding:14px 32px;border-radius:8px;text-decoration:none;font-weight:700;font-size:15px;display:inline-block;">Reset Password</a>
  </div>
  <p style="color:#94a3b8;font-size:12px;word-break:break-all;">Or copy: ${resetUrl}</p>
  <p style="color:#dc2626;font-size:13px;">If you didn't request this, ignore this email. Your password won't change.</p>
  <hr style="border:none;border-top:1px solid #e2e8f0;margin:28px 0;">
  <p style="margin:0;color:#94a3b8;font-size:12px;">Do not reply to this email · BRP AMS Automated System</p>
</td></tr></table></td></tr></table></body></html>`);
        sent++;
        await sleep(400);
      } catch (e) {
        console.error(`[ResetAll] Failed for ${target.email}:`, e.message);
        failed++;
        await sleep(400);
      }
    }
    console.log(`[ResetAll] Done — sent: ${sent}, failed: ${failed}, expiry: ${expiryLabel}`);
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Server error: ' + err.message });
  }
});

// ── POST /api/users/:id/unlock — clear login lockout ────────────────────────
router.post('/:id/unlock', authenticate, authorize('admin', 'super_admin'), async (req, res) => {
  try {
    const target = await User.findById(req.params.id).select('name emp_id login_locked_until failed_login_attempts').lean();
    if (!target) return res.status(404).json({ success: false, message: 'User not found' });
    await User.findByIdAndUpdate(req.params.id, { $set: { login_locked_until: null, failed_login_attempts: 0 } });
    console.log(`[Users] Account unlocked: ${target.emp_id} by ${req.user.emp_id}`);
    res.json({ success: true, message: `${target.name}'s account has been unlocked.` });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ── PUT /api/users/:id/reset-password — must be before PUT /:id ──────────
router.put('/:id/reset-password', authenticate, authorize('admin', 'super_admin'), async (req, res) => {
  try {
    const target = await User.findById(req.params.id).select('-password_hash -email_verify_token -pwd_reset_token -phone_otp -login_attempts -login_locked_until').lean();
    if (!target) return res.status(404).json({ success: false, message: 'User not found' });
    if (String(req.params.id) === String(req.user.id))
      return res.status(400).json({ success: false, message: 'Use profile settings to change your own password' });
    if (req.user.role === 'admin' && ['admin', 'super_admin'].includes(target.role))
      return res.status(403).json({ success: false, message: 'Admins cannot reset passwords for admin or super admin accounts' });
    
    const expiry24h = req.body?.expiry === '24h';
    const expiryMs  = expiry24h ? 24 * 60 * 60 * 1000 : 30 * 60 * 1000;
    const expiryLabel = expiry24h ? '24 hours' : '30 minutes';

    const crypto = require('crypto');
    const rawResetToken  = crypto.randomBytes(32).toString('hex');
    const hashedResetTok = crypto.createHash('sha256').update(rawResetToken).digest('hex');
    const tempPassword   = `Tmp@${crypto.randomBytes(8).toString('hex')}`;

    await User.findByIdAndUpdate(req.params.id, { $set: { password_hash: bcrypt.hashSync(tempPassword, 12), pwd_reset_token: hashedResetTok, pwd_reset_expires: new Date(Date.now() + expiryMs) } });

    const FRONTEND = process.env.FRONTEND_URL || 'https://monitormark.brptripura.com';
    const resetUrl = `${FRONTEND}/reset-password?token=${rawResetToken}`;

    await sendMail(target.email, 'BRP Attendance System - Password Reset by Admin',
      `<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"></head>
<body style="margin:0;padding:0;background:#f2f6f8;font-family:Arial,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#f2f6f8;padding:40px 0;">
<tr><td align="center">
<table width="560" cellpadding="0" cellspacing="0"
  style="background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 4px 20px rgba(0,0,0,.08);">
<tr><td style="background:#0b1e3b;padding:28px 32px;">
  <h1 style="margin:0;color:#fff;font-size:22px;font-weight:800;">BRP · AMS</h1>
  <p style="margin:4px 0 0;color:rgba(255,255,255,.6);font-size:13px;">Attendance Management System</p>
</td></tr>
<tr><td style="padding:32px;">
  <h2 style="margin:0 0 16px;color:#0b1e3b;font-size:18px;">Password Reset Request</h2>
  <p style="color:#475569;font-size:14px;line-height:1.6;">
    Hi <strong>${target.name}</strong>, your password has been reset by an administrator.
  </p>
  <p style="color:#475569;font-size:14px;line-height:1.6;">
    Click the button below to set your new password. This link expires in <strong>${expiryLabel}</strong>.
  </p>
  <div style="text-align:center;margin:28px 0;">
    <a href="${resetUrl}"
      style="background:#21879d;color:#fff;padding:14px 32px;border-radius:8px;
             text-decoration:none;font-weight:700;font-size:15px;display:inline-block;">
      Reset Password
    </a>
  </div>
  <p style="color:#94a3b8;font-size:12px;word-break:break-all;">
    Or copy: ${resetUrl}
  </p>
  <p style="color:#dc2626;font-size:13px;">
    If you didn't request this, ignore this email. Your password won't change.
  </p>
  <hr style="border:none;border-top:1px solid #e2e8f0;margin:28px 0;">
  <p style="margin:0;color:#94a3b8;font-size:12px;">Do not reply to this email · BRP AMS Automated System</p>
</td></tr>
</table>
</td></tr></table></body></html>`);

    try {
      await Notification.create({
        _id: uuidv4(),
        user_id: target._id,
        title: 'Password Reset by Admin',
        message: `Check your email for the reset link (expires in ${expiryLabel}).`,
        type: 'warning',
        is_read: 0
      });
    } catch (_) {}

    res.json({ success: true, message: `Password reset email sent to ${target.name} (${target.email}) — link expires in ${expiryLabel}` });
  } catch (err) { 
    console.error(err); 
    res.status(500).json({ success: false, message: 'Server error: ' + err.message }); 
  }
});

// ── PUT /api/users/:id ────────────────────────────────────────────────────
// Employees can update their own self-service fields; admins/super_admins can update anyone
router.put('/:id', authenticate, async (req, res) => {
  try {
    const isSelf      = String(req.params.id) === String(req.user.id);
    const isAdminUser = ['admin', 'super_admin'].includes(req.user.role);

    // Non-admins can only update their own profile, and only self-service fields
    if (!isAdminUser && !isSelf)
      return res.status(403).json({ success: false, message: 'Insufficient permissions' });

    const user = await User.findById(req.params.id).select('-password_hash -email_verify_token -pwd_reset_token -phone_otp -login_attempts -login_locked_until').lean();
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });

    if (req.user.role === 'admin' && ['admin', 'super_admin'].includes(user.role))
      return res.status(403).json({ success: false, message: 'Admins cannot modify admin or super admin accounts' });

    const { name, email, empId, role, department, managerId, hrId, phone, isActive, assignedBlock, assignedDistrict, roleType, designation, photoUpdateQuota, joiningDate, officeName, reportingOfficerName, reportingOfficerDesignation, checkinGeofenceExempt } = req.body;

    // Self-update: only allow safe personal fields, ignore admin-only fields
    if (!isAdminUser && isSelf) {
      const selfUpdate = {};
      if (phone              !== undefined) selfUpdate.phone                          = phone              || null;
      if (joiningDate        !== undefined) selfUpdate.joining_date                   = joiningDate        || null;
      if (reportingOfficerName        !== undefined) selfUpdate.reporting_officer_name        = reportingOfficerName        || null;
      if (reportingOfficerDesignation !== undefined) selfUpdate.reporting_officer_designation = reportingOfficerDesignation || null;
      const updated = await User.findByIdAndUpdate(req.params.id, { $set: selfUpdate }, { new: true }).lean();
      return res.json({ success: true, user: formatUser(updated) });
    }

    if (req.user.role === 'admin' && role && ['admin', 'super_admin'].includes(role))
      return res.status(403).json({ success: false, message: 'Admins cannot assign admin or super admin roles' });

    // Prevent admin from changing their own role (privilege escalation/de-escalation of own account)
    if (req.user.role === 'admin' && String(req.params.id) === String(req.user.id) && role && role !== user.role)
      return res.status(403).json({ success: false, message: 'Admins cannot change their own role' });

    const newManagerId = managerId !== undefined ? (managerId || null) : user.manager_id;
    const newBlock     = assignedBlock !== undefined ? (assignedBlock || null) : user.assigned_block;
    const newDistrict  = assignedDistrict !== undefined ? (assignedDistrict || null) : user.assigned_district;
    const newIsActive  = isActive !== undefined ? isActive : user.is_active;

    // Validate empId uniqueness if changing
    const newEmpId = empId && empId.trim() ? empId.trim() : user.emp_id;
    if (newEmpId !== user.emp_id) {
      const conflict = await User.findOne({ emp_id: newEmpId, _id: { $ne: user._id } }).lean();
      if (conflict) return res.status(409).json({ success: false, message: `Employee Code "${newEmpId}" is already used by another user.` });
    }

    const update = {
      name: name || user.name,
      email: email || user.email,
      emp_id: newEmpId,
      role: role || user.role,
      department: department || user.department,
      manager_id: newManagerId,
      hr_id: hrId !== undefined ? (hrId || null) : (user.hr_id || null),
      phone: phone !== undefined ? (phone || null) : user.phone,
      is_active: newIsActive,
      assigned_block: newBlock,
      assigned_district: newDistrict,
      role_type: (roleType !== undefined && roleType !== null) ? roleType : user.role_type,
      designation: designation !== undefined ? (designation || null) : user.designation,
      joining_date:                  joiningDate                  !== undefined ? (joiningDate                  || null) : user.joining_date,
      office_name:                   officeName                   !== undefined ? (officeName                   || null) : user.office_name,
      reporting_officer_name:        reportingOfficerName        !== undefined ? (reportingOfficerName        || null) : user.reporting_officer_name,
      reporting_officer_designation: reportingOfficerDesignation !== undefined ? (reportingOfficerDesignation || null) : user.reporting_officer_designation,
      checkin_geofence_exempt: checkinGeofenceExempt !== undefined ? !!checkinGeofenceExempt : !!user.checkin_geofence_exempt,
    };

    // If admin is granting a new photo quota, store it and reset the counter
    const quotaChanged = photoUpdateQuota !== undefined;
    if (quotaChanged) {
      update.photo_update_quota = photoUpdateQuota === null ? null : Number(photoUpdateQuota);
      update.photo_update_count = 0;
    }

    await User.findByIdAndUpdate(req.params.id, { $set: update }, { strict: false });

    // Notify user if photo access was granted (quota is not locked)
    if (quotaChanged && photoUpdateQuota !== null) {
      await Notification.create({
        _id: uuidv4(), user_id: req.params.id,
        title: 'Profile Photo Update Approved',
        message: 'Your profile photo update request has been approved. You can now update your photo from your Profile page.',
        type: 'info', is_read: false,
      }).catch(() => {});
    }
    
    const targetRole = role || user.role;
    if (targetRole === 'employee') {
      const changes = [];
      if (newManagerId !== user.manager_id) {
        if (newManagerId) {
          const mgr = await User.findById(newManagerId).select('name').lean();
          if (mgr) { 
            changes.push(`Reporting Manager assigned: ${mgr.name}`); 
            await Notification.create({ 
              _id: uuidv4(), 
              user_id: newManagerId, 
              title: 'New Team Member Assigned', 
              message: `${user.name} (${user.emp_id}) has been assigned to your team by admin.`, 
              type: 'info', 
              is_read: 0, 
              link: '/manager/team' 
            }); 
          }
        } else { 
          changes.push('Reporting Manager removed'); 
        }
        if (user.manager_id && user.manager_id !== newManagerId) {
          await Notification.create({ 
            _id: uuidv4(), 
            user_id: user.manager_id, 
            title: 'Team Member Reassigned', 
            message: `${user.name} (${user.emp_id}) has been reassigned by admin.`, 
            type: 'warning', 
            is_read: 0, 
            link: '/manager/team' 
          });
        }
      }
      if (newBlock !== user.assigned_block) changes.push(`Block: ${newBlock || 'removed'}`);
      if (newDistrict !== user.assigned_district) changes.push(`District: ${newDistrict || 'removed'}`);
      if (newIsActive !== user.is_active) changes.push(newIsActive ? 'Account activated' : 'Account deactivated');
      if (changes.length) {
        await Notification.create({ 
          _id: uuidv4(), 
          user_id: user._id, 
          title: 'Your Profile Has Been Updated', 
          message: `Admin has updated your profile — ${changes.join(', ')}.`, 
          type: 'info', 
          is_read: 0, 
          link: '/profile' 
        });
      }
    }
    
    const updated = await User.findById(req.params.id).select('-password_hash -email_verify_token -pwd_reset_token -phone_otp -login_attempts -login_locked_until').lean();
    res.json({ success: true, message: 'User updated', data: formatUser(updated) });
  } catch (err) { 
    console.error(err); 
    res.status(500).json({ success: false, message: 'Server error' }); 
  }
});

// ── DELETE /api/users/:id ─────────────────────────────────────────────────
router.delete('/:id', authenticate, authorize('admin', 'super_admin'), async (req, res) => {
  try {
    if (req.params.id === req.user.id) return res.status(400).json({ success: false, message: 'Cannot delete yourself' });
    if (req.user.role === 'admin') {
      const target = await User.findById(req.params.id).select('role').lean();
      if (target && ['admin', 'super_admin'].includes(target.role))
        return res.status(403).json({ success: false, message: 'Admins cannot delete admin or super admin accounts' });
    }
    const deleted = await User.findByIdAndDelete(req.params.id);
    if (!deleted) return res.status(404).json({ success: false, message: 'User not found' });
    res.json({ success: true, message: 'User deleted successfully' });
  } catch (err) { 
    console.error(err); 
    res.status(500).json({ success: false, message: 'Server error' }); 
  }
});

// ── POST /api/users/request-assignment ───────────────────────────────────
router.post('/request-assignment', authenticate, authorize('employee'), [
  body('type').isIn(['manager', 'block', 'photo', 'location', 'role_type', 'district', 'hr', 'coordinates']).withMessage('Invalid request type'),
  body('note').optional().trim(),
], validate, async (req, res) => {
  try {
    const { type, note } = req.body;
    const emp    = await User.findById(req.user.id).select('name emp_id email assigned_block').lean();
    const admins = await User.find({ role: 'admin', is_active: 1 }).select('_id email').lean();
    const labelMap = {
      manager:     'Manager Assignment',
      block:       'Block Assignment',
      photo:       'Profile Photo Update',
      location:    'Location / Block Change',
      role_type:   'Designation Change',
      district:    'District Assignment',
      hr:          'HR (Competent Authority) Assignment',
      coordinates: `Block Coordinates Correction${emp.assigned_block ? ` (${emp.assigned_block})` : ''}`,
    };
    const label     = labelMap[type] || `${type} Change`;
    const title     = `Request: ${label}`;
    const message   = `${escapeHtml(emp.name)} (${escapeHtml(emp.emp_id)}) has requested: ${escapeHtml(label)}.${note ? ` Note: ${escapeHtml(note)}` : ''}`;
    const actionMap = { photo: 'photo-update', manager: 'manager-assignment', hr: 'hr-assignment', district: 'district-assignment', block: 'block-assignment', role_type: 'designation-change', location: 'location-change', coordinates: 'coordinates-correction' };
    const action    = actionMap[type] || '';
    const link      = `/admin/users?editUser=${req.user.id}${action ? `&action=${action}` : ''}`;

    if (admins.length) {
      await Notification.insertMany(admins.map(a => ({
        _id: uuidv4(),
        user_id: a._id,
        title,
        message,
        type: 'warning',
        is_read: 0,
        link,
      })));
    }
    
    for (const admin of admins) {
      sendMail(admin.email, `BRP Attendance System - ${title}: ${emp.name}`, `<p>${message}</p><p>Log in to Admin → Users to assign.</p>`);
    }
    
    res.json({ success: true, message: `Request sent to admin${admins.length > 1 ? 's' : ''}.` });
  } catch (err) { 
    console.error(err); 
    res.status(500).json({ success: false, message: 'Server error' }); 
  }
});

// ── POST /api/users/request-location-change ───────────────────────────────
router.post('/request-location-change', authenticate, authorize('employee'), [
  body('note').optional().trim(),
], validate, async (req, res) => {
  try {
    const { note } = req.body;
    const emp    = await User.findById(req.user.id).select('name emp_id email assigned_block assigned_district').lean();
    const admins = await User.find({ role: 'admin', is_active: 1 }).select('_id email').lean();
    const current = [emp.assigned_block, emp.assigned_district].filter(Boolean).join(' / ') || 'Not assigned';
    const title   = 'Request: Location / Block Change';
    const message = note ? `${escapeHtml(emp.name)} (${escapeHtml(emp.emp_id)}) requests a location change (current: ${escapeHtml(current)}). Note: ${escapeHtml(note)}` : `${escapeHtml(emp.name)} (${escapeHtml(emp.emp_id)}) requests a location change (current: ${escapeHtml(current)}).`;
    
    if (admins.length) {
      await Notification.insertMany(admins.map(a => ({
        _id: uuidv4(),
        user_id: a._id,
        title,
        message,
        type: 'warning',
        is_read: 0,
        link: `/admin/users?editUser=${req.user.id}&action=location-change`,
      })));
    }
    
    for (const admin of admins) {
      sendMail(admin.email, `BRP Attendance System - ${title}: ${emp.name}`, `<p>${message}</p>`);
    }
    
    res.json({ success: true, message: 'Location change request sent to admin.' });
  } catch (err) { 
    console.error(err); 
    res.status(500).json({ success: false, message: 'Server error' }); 
  }
});

// ── Bulk upload helpers ───────────────────────────────────────────────────

// Decode HTML entities that Excel / ExcelJS sometimes introduces
const decodeHtml = s => s
  .replace(/&amp;/gi, '&').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
  .replace(/&quot;/gi, '"').replace(/&#39;/gi, "'").replace(/&nbsp;/gi, ' ');

// Recursively apply decodeHtml until the string stops changing (handles multiple encodings)
const fullyDecode = s => { let prev; do { prev = s; s = decodeHtml(s); } while (s !== prev); return s; };

// Extract plain text from an ExcelJS cell value (handles richText, formula, hyperlink, Date, plain)
const cellText = v => {
  if (v == null) return '';
  if (v instanceof Date) {
    // Format as YYYY-MM-DD
    const y = v.getFullYear();
    const m = String(v.getMonth() + 1).padStart(2, '0');
    const d = String(v.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }
  if (typeof v === 'object') {
    if (Array.isArray(v.richText)) return v.richText.map(r => r.text || '').join('');
    if (v.result instanceof Date) {
      const d2 = v.result;
      return `${d2.getFullYear()}-${String(d2.getMonth()+1).padStart(2,'0')}-${String(d2.getDate()).padStart(2,'0')}`;
    }
    if (v.text != null)   return String(v.text);
    if (v.result != null) return String(v.result);
  }
  return String(v);
};

// Normalise any common date string to YYYY-MM-DD; returns null if unrecognised
const parseDate = s => {
  if (!s) return null;
  s = s.trim();
  // Already YYYY-MM-DD
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  // DD.MM.YYYY  or  DD/MM/YYYY  or  DD-MM-YYYY
  const m = s.match(/^(\d{1,2})[.\-\/](\d{1,2})[.\-\/](\d{4})$/);
  if (m) return `${m[3]}-${m[2].padStart(2,'0')}-${m[1].padStart(2,'0')}`;
  return null;
};

// Map any column header variant to a canonical field name
const normalizeHdr = s => s.toLowerCase().replace(/[\s_\-().]+/g, '');
const HDR_MAP = {
  empid: 'empId', employeeid: 'empId', empcode: 'empId', agencyempcode: 'empId', code: 'empId',
  name: 'name', fullname: 'name', employeename: 'name', resourcename: 'name',
  email: 'email', emailid: 'email', emailaddress: 'email',
  password: 'password', pwd: 'password',
  role: 'role', userrole: 'role',
  department: 'department', dept: 'department',
  phone: 'phone', mobile: 'phone', phonenumber: 'phone', mobilenumber: 'phone', contact: 'phone',
  block: 'block', assignedblock: 'block',
  district: 'district', assigneddistrict: 'district',
  roletype: 'roleType', type: 'roleType',
  designation: 'designation',
  joiningdate: 'joiningDate', joindate: 'joiningDate', doj: 'joiningDate',
  manager: 'managerRef', managername: 'managerRef', managerid: 'managerRef', managerempid: 'managerRef',
};

// ── POST /api/users/bulk-upload ───────────────────────────────────────────
router.post('/bulk-upload', authenticate, authorize('super_admin', 'admin'), uploadMem.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ success: false, message: 'Excel file required' });
  try {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(req.file.buffer);
    const ws = wb.worksheets[0];

    // Build canonical header index
    const canonHeaders = [];
    const rows = [];
    ws.eachRow((row, rowNum) => {
      const vals = row.values.slice(1).map(v => fullyDecode(cellText(v).trim()));
      if (rowNum === 1) {
        vals.forEach((v, i) => { canonHeaders[i] = HDR_MAP[normalizeHdr(v)] || null; });
      } else {
        const obj = {};
        canonHeaders.forEach((h, i) => { if (h) obj[h] = vals[i] ?? ''; });
        if (Object.values(obj).some(v => v !== '')) rows.push(obj);
      }
    });
    if (!rows.length) return res.status(400).json({ success: false, message: 'Empty spreadsheet' });

    const VALID_ROLES = ['employee', 'manager', 'admin', 'hr', 'super_admin', 'department_portal'];
    const results = { created: 0, updated: 0, skipped: 0, errors: [] };

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const rowNum = i + 2;

      const empId      = (row['empId']      || '').trim();
      const name       = (row['name']       || '').trim();
      const email      = (row['email']      || '').trim().toLowerCase();
      const password   = (row['password']   || '').trim();
      const role       = (row['role']       || 'employee').trim().toLowerCase();
      const dept       = (row['department'] || '').trim() || 'Field Operation';
      const phone      = (row['phone']      || '').trim() || null;
      const block      = (row['block']      || '').trim() || null;
      const district   = (row['district']   || '').trim() || null;
      const roleType   = (row['roleType']   || '').trim() || null;
      const designation= (row['designation']|| '').trim() || null;
      const joiningDate= parseDate((row['joiningDate'] || '').trim());
      const managerRef = (row['managerRef'] || '').trim() || null;

      // Only these 5 fields are mandatory
      const missing = [];
      if (!empId)    missing.push('EmpId');
      if (!name)     missing.push('Name');
      if (!email)    missing.push('Email');
      if (!block)    missing.push('assignedBlock');
      if (!district) missing.push('assignedDistrict');
      if (missing.length) {
        results.errors.push({ row: rowNum, reason: `Missing required field(s): ${missing.join(', ')}` });
        results.skipped++;
        continue;
      }
      if (!VALID_ROLES.includes(role)) {
        results.errors.push({ row: rowNum, reason: `Invalid role "${role}" — must be one of: employee, manager, admin, hr` });
        results.skipped++;
        continue;
      }
      if (req.user.role === 'admin' && ['admin', 'super_admin'].includes(role)) {
        results.errors.push({ row: rowNum, reason: 'Admins cannot create or assign admin/super_admin roles' });
        results.skipped++;
        continue;
      }
      
      let managerId = null;
      if (managerRef) {
        const safeRef = managerRef.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const mgr = await User.findOne({ $or: [{ emp_id: managerRef }, { name: { $regex: new RegExp(`^${safeRef}$`, 'i') } }], is_active: 1 }).lean();
        if (mgr) { 
          managerId = mgr._id; 
        } else { 
          results.errors.push({ row: rowNum, reason: `Manager "${managerRef}" not found — created without manager` }); 
        }
      }
      
      const existing = await User.findOne({ $or: [{ emp_id: empId }, { email }] }).lean();
      if (existing) {
        const update = { 
          name, 
          email, 
          role, 
          department: dept, 
          phone, 
          manager_id: managerId || existing.manager_id || null, 
          assigned_block: block, 
          assigned_district: district,
          role_type: roleType,           // ← FIX: Support update
          designation: designation,       // ← FIX: Support update
          joining_date: joiningDate
        };
        if (password && password.length >= 6) update.password_hash = bcrypt.hashSync(password, 12);
        await User.findByIdAndUpdate(existing._id, { $set: update });
        results.updated++;
      } else {
        const crypto = require('crypto');
        let passwordHash;
        let setupTokenRaw = null;

        if (password && password.length >= 6) {
          passwordHash = bcrypt.hashSync(password, 10);
        } else {
          // No password supplied — generate temp + send setup email
          const tempPass = `Tmp@${crypto.randomBytes(8).toString('hex')}`;
          passwordHash   = bcrypt.hashSync(tempPass, 12);
          setupTokenRaw  = crypto.randomBytes(32).toString('hex');
        }

        const hashedSetupTok = setupTokenRaw
          ? crypto.createHash('sha256').update(setupTokenRaw).digest('hex')
          : null;

        const newId = uuidv4();
        await User.create({
          _id: newId,
          emp_id: empId,
          name,
          email,
          password_hash: passwordHash,
          role,
          department: dept,
          manager_id: managerId || null,
          phone,
          assigned_block: block,
          assigned_district: district,
          role_type: roleType,
          designation: designation,
          joining_date: joiningDate,
          is_active: 1,
          email_verified: true,
          phone_verified: true,
          ...(hashedSetupTok ? { pwd_reset_token: hashedSetupTok, pwd_reset_expires: new Date(Date.now() + 86400000) } : {}),
        });

        if (setupTokenRaw) {
          const FRONTEND = process.env.FRONTEND_URL || 'https://monitormark.brptripura.com';
          const resetUrl = `${FRONTEND}/reset-password?token=${setupTokenRaw}`;
          sendMail(
            email,
            'BRP Attendance System - Your Account is Ready',
            `<!DOCTYPE html><html><head><meta charset="UTF-8"></head>
<body style="margin:0;padding:0;background:#f2f6f8;font-family:Arial,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#f2f6f8;padding:40px 0;">
<tr><td align="center">
<table width="560" cellpadding="0" cellspacing="0"
  style="background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 4px 20px rgba(0,0,0,.08);">
<tr><td style="background:#0b1e3b;padding:28px 32px;">
  <h1 style="margin:0;color:#fff;font-size:22px;font-weight:800;">BRP · AMS</h1>
  <p style="margin:4px 0 0;color:rgba(255,255,255,.6);font-size:13px;">Attendance Management System</p>
</td></tr>
<tr><td style="padding:32px;">
  <h2 style="margin:0 0 16px;color:#0b1e3b;font-size:18px;">Welcome, ${name}! Set Your Password</h2>
  <p style="color:#475569;font-size:14px;line-height:1.6;">
    Your BRP AMS account has been created. Click the button below to set your password and activate your account.
  </p>
  <p style="color:#475569;font-size:14px;line-height:1.6;">
    <strong>Employee ID:</strong> ${empId}<br/>
    <strong>Role:</strong> ${role}
  </p>
  <div style="text-align:center;margin:28px 0;">
    <a href="${resetUrl}"
      style="background:#21879d;color:#fff;padding:14px 32px;border-radius:8px;
             text-decoration:none;font-weight:700;font-size:15px;display:inline-block;">
      Set My Password
    </a>
  </div>
  <p style="color:#94a3b8;font-size:12px;word-break:break-all;">
    Or copy this link: ${resetUrl}
  </p>
  <p style="color:#dc2626;font-size:13px;">
    This link expires in <strong>24 hours</strong>. If you did not expect this email, contact your administrator.
  </p>
  <hr style="border:none;border-top:1px solid #e2e8f0;margin:28px 0;">
  <p style="margin:0;color:#94a3b8;font-size:12px;">Do not reply to this email · BRP AMS Automated System</p>
</td></tr>
</table>
</td></tr></table></body></html>`
          ).catch(err => console.error(`[Bulk Upload] Setup email failed for ${email}:`, err.message));
        }

        results.created++;
      }
    }
    
    res.json({ success: true, message: `Bulk upload complete — ${results.created} created, ${results.updated} updated, ${results.skipped} skipped`, data: results });
  } catch (err) { 
    console.error('Bulk upload error:', err); 
    res.status(500).json({ success: false, message: 'Server error: ' + err.message }); 
  }
});

// ── POST /api/users/profile-photo ─────────────────────────────────────────
router.post(
  '/profile-photo',
  authenticate,
  authorize('employee', 'manager', 'admin', 'hr', 'super_admin'),
  uploadProfilePhoto.single('photo'),
  async (req, res) => {
    try {
      if (!req.file) {
        return res.status(400).json({ success: false, message: 'No photo provided' });
      }
 
      const user = await User.findById(req.user.id)
        .select('profile_photo_path profile_photo_uploaded role photo_update_quota photo_update_count')
        .lean();

      const isAdminRole  = ['admin', 'super_admin'].includes(req.user.role);
      const isFirstUpload = !user?.profile_photo_path;

      if (!isFirstUpload && !isAdminRole) {
        // Quota check: null = locked, 0 = unlimited, N = allow N updates
        const quota = user?.photo_update_quota ?? null;
        const used  = user?.photo_update_count  ?? 0;
        if (quota === null || (quota > 0 && used >= quota)) {
          return res.status(409).json({
            success: false,
            message: 'Profile photo update not permitted. Please raise a request to update your photo.',
            locked:  true,
          });
        }
      }

      const _pExt  = path.extname(req.file.originalname).replace('.', '') || 'jpg';
      const _pName = `${(req.user.name || 'unknown').replace(/\s+/g,'_').replace(/[^a-zA-Z0-9_-]/g,'')}_${String(req.user.emp_id || req.user.id).replace(/[^a-zA-Z0-9_-]/g,'')}_profile.${_pExt}`;
      const photoPath = await uploadFile(
        req.file.buffer,
        `ams/users/${req.user.emp_id || req.user.id}/profile`,
        req.file.originalname,
        req.file.mimetype,
        _pName,
      );

      const updateFields = {
        profile_photo_path:     photoPath,
        profile_photo_uploaded: new Date(),
        face_enrolled:          true,
      };
      // Increment usage counter for non-admin updates (not the first upload)
      if (!isFirstUpload && !isAdminRole) {
        updateFields.photo_update_count = (user?.photo_update_count ?? 0) + 1;
      }

      await User.findByIdAndUpdate(req.user.id, { $set: updateFields }, { strict: false });

      await AuditLog.create({
        _id: uuidv4(), user_id: req.user.id,
        action: 'PROFILE_PHOTO_UPLOAD',
        entity_type: 'user', entity_id: req.user.id,
        new_value: isFirstUpload ? 'Profile photo enrolled' : 'Profile photo updated',
      });

      res.status(201).json({
        success:  true,
        message:  isFirstUpload ? 'Profile photo uploaded successfully.' : 'Profile photo updated successfully.',
        photoPath,
      });
    } catch (err) {
      console.error('[ProfilePhoto]', err);
      res.status(500).json({ success: false, message: err.message || 'Server error' });
    }
  },
);
 
// ── (Optional) Admin-only force-reset for fraud/re-enrollment ────────────
// DELETE /api/users/:id/profile-photo   (admin / super_admin only)
router.delete(
  '/:id/profile-photo',
  authenticate,
  authorize('admin', 'super_admin'),
  async (req, res) => {
    try {
      await User.findByIdAndUpdate(req.params.id, {
        $set: { profile_photo_path: null, profile_photo_uploaded: null, face_enrolled: false },
      }, { strict: false });

      await AuditLog.create({
        _id: uuidv4(), user_id: req.user.id,
        action: 'PROFILE_PHOTO_RESET',
        entity_type: 'user', entity_id: req.params.id,
        new_value: 'Profile photo reset by admin',
      });

      // Notify the user so they know they can now upload a new photo
      await Notification.create({
        _id: uuidv4(), user_id: req.params.id,
        title: 'Profile Photo Update Approved',
        message: 'Your profile photo update request has been approved. You can now upload a new photo from your Profile page.',
        type: 'info', is_read: false,
      }).catch(() => {});

      res.json({ success: true, message: 'Profile photo reset. Employee may now re-enroll.' });
    } catch (err) {
      console.error('[ProfilePhotoReset]', err);
      res.status(500).json({ success: false, message: 'Server error' });
    }
  },
);

// ── Format helper ─────────────────────────────────────────────────────────
function formatUser(u) {
  // ── Normalize scan_papers to grouped-by-month array format ───────────
  // Each month entry: { month, monthLabel, files: [{ path, fileName, fileIndex, uploadedAt }] }
  const rawPapers = Array.isArray(u.scan_papers) ? u.scan_papers : [];
  const papersByMonth = {};
  rawPapers.forEach(s => {
    if (!s.month || !s.path) return;
    if (!papersByMonth[s.month]) {
      papersByMonth[s.month] = {
        month:      s.month,
        monthLabel: s.month_label || s.month,
        files:      [],
      };
    }
    papersByMonth[s.month].files.push({
      path:       s.path,
      fileName:   s.file_name   || `Scan_${s.month}_${s.file_index ?? papersByMonth[s.month].files.length + 1}`,
      fileIndex:  s.file_index  ?? papersByMonth[s.month].files.length,
      uploadedAt: s.uploaded_at || null,
    });
  });
  // Sort files within each month by fileIndex
  Object.values(papersByMonth).forEach(m => {
    m.files.sort((a, b) => a.fileIndex - b.fileIndex);
  });
  
  return {
    id:               u._id || u.id,
    empId:            u.emp_id,
    name:             u.name,
    email:            u.email,
    role:             u.role,
    roleType:         u.role_type || null,      // ← FIX: Include roleType
    designation:      u.designation || null,     // ← FIX: Include designation
    joiningDate:                  u.joining_date                  || null,
    officeName:                   u.office_name                   || null,
    reportingOfficerName:        u.reporting_officer_name        || null,
    reportingOfficerDesignation: u.reporting_officer_designation || null,
    department:       fullyDecode(u.department || ''),
    managerId:        u.manager_id,
    hrId:             u.hr_id     || null,
    hrName:           u.hr_name    || null,   // ← ADD
    managerName:      u.manager_name || null,
    phone:            u.phone,
    isActive:         !!u.is_active,
    createdAt:        u.created_at,
    assignedBlock:    u.assigned_block,
    assignedDistrict: u.assigned_district,
    allocatedEmployeeIds: (u.allocated_employee_ids || []).map(String),
    // ── New grouped scan papers ─────────────────────────────────────
    // Shape: { "2026-04": { month, monthLabel, files: [...] }, ... }
    scan_papers:         papersByMonth,
    // ── Raw array also returned for server-side processing ──────────
    scan_papers_raw:     rawPapers,
    // ── Legacy fields ───────────────────────────────────────────────
    scan_paper_path:     u.scan_paper_path     || null,
    scan_paper_uploaded: u.scan_paper_uploaded || null,
    face_enrolled:       u.face_enrolled          || false,
    faceEnrolled:           u.face_enrolled           || false,
    facePhotoUrl:           u.profile_photo_path      || null,
    profile_photo_uploaded: u.profile_photo_uploaded  || null,
    photoUpdateQuota:       u.photo_update_quota       ?? null,
    photoUpdateCount:       u.photo_update_count       ?? 0,
    loginLockedUntil:       u.login_locked_until       || null,
    failedLoginAttempts:    u.failed_login_attempts    ?? 0,
    checkinGeofenceExempt:  !!u.checkin_geofence_exempt,
  };
}

// ── PATCH /api/users/:id/leave-balance — adjust leave balance (manager scoped to own team) ──
router.patch('/:id/leave-balance', authenticate, authorize('manager', 'admin', 'hr', 'super_admin'), async (req, res) => {
  try {
    const { delta, reason, set } = req.body; // delta = +/-N, or set = exact value
    const query = req.user.role === 'manager'
      ? { _id: req.params.id, manager_id: req.user.id }
      : { _id: req.params.id };
    const emp = await User.findOne(query);
    if (!emp) return res.status(404).json({ success: false, message: 'Employee not found or not your team member' });

    let newBalance;
    if (set !== undefined && set !== null && set !== '') {
      newBalance = clampLeaveBalance(Number(set));
      await User.findByIdAndUpdate(req.params.id, { $set: { leave_balance: newBalance } });
    } else if (delta !== undefined) {
      newBalance = clampLeaveBalance((emp.leave_balance || 0) + Number(delta));
      await User.findByIdAndUpdate(req.params.id, { $set: { leave_balance: newBalance } });
    } else {
      return res.status(400).json({ success: false, message: 'Provide delta or set' });
    }

    // Audit log
    await AuditLog.create({
      user_id: req.user.id, action: 'leave_balance_adjust',
      details: `${emp.name} (${emp.emp_id}): balance ${emp.leave_balance} → ${newBalance}. Reason: ${reason || 'manual'}`,
    }).catch(() => {});

    res.json({ success: true, data: { leave_balance: newBalance } });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ── PATCH /api/users/:id/allocated-employees — Super Admin picks which
// employees a department_portal account can see. Admin-only, and only
// meaningful for a target user with role:'department_portal'. ─────────────
router.patch('/:id/allocated-employees', authenticate, authorize('admin', 'super_admin'), async (req, res) => {
  try {
    const { employeeIds } = req.body;
    if (!Array.isArray(employeeIds)) return res.status(400).json({ success: false, message: 'employeeIds must be an array' });

    const target = await User.findById(req.params.id).select('role').lean();
    if (!target) return res.status(404).json({ success: false, message: 'User not found' });
    if (target.role !== 'department_portal') {
      return res.status(400).json({ success: false, message: 'Employee allocation only applies to Department Portal accounts' });
    }

    const validIds = await User.find({ _id: { $in: employeeIds }, role: 'employee' }, '_id').lean();
    const cleanIds = validIds.map(e => String(e._id));

    await User.findByIdAndUpdate(req.params.id, { $set: { allocated_employee_ids: cleanIds } });
    res.json({ success: true, data: { allocated_employee_ids: cleanIds } });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ── POST /api/users/bulk-leave-balance — bulk adjust all team members ──
router.post('/bulk-leave-balance', authenticate, authorize('admin', 'hr', 'super_admin'), async (req, res) => {
  try {
    const { delta, set, reason } = req.body;
    const query = req.user.role === 'manager'
      ? { manager_id: req.user.id }
      : { role: 'employee' };
    const allEmps = await User.find(query).select('_id leave_balance name emp_id role').lean();
    const employees = req.user.role === 'manager' ? allEmps : allEmps.filter(e => e.role === 'employee');

    const updates = [];
    for (const emp of employees) {
      let newBalance;
      if (set !== undefined && set !== null && set !== '') {
        newBalance = clampLeaveBalance(Number(set));
      } else if (delta !== undefined) {
        newBalance = clampLeaveBalance((emp.leave_balance || 0) + Number(delta));
      } else continue;
      updates.push({ updateOne: { filter: { _id: emp._id }, update: { $set: { leave_balance: newBalance } } } });
    }
    if (updates.length) await User.bulkWrite(updates);

    await AuditLog.create({
      user_id: req.user.id, action: 'bulk_leave_balance_adjust',
      details: `Bulk ${delta !== undefined ? `delta ${delta}` : `set ${set}`} for ${employees.length} employees. Reason: ${reason || 'bulk'}`,
    }).catch(() => {});

    res.json({ success: true, data: { updated: updates.length } });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ── POST /api/users/bulk-leave-balance-excel — import Excel to set balances ──
router.post('/bulk-leave-balance-excel', authenticate, authorize('manager', 'admin', 'hr', 'super_admin'), uploadMem.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ success: false, message: 'No file uploaded' });

    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(req.file.buffer);
    const ws = wb.worksheets[0];

    // Build emp_id → _id map scoped to this manager's team (or all employees)
    const scopeQuery = req.user.role === 'manager'
      ? { manager_id: req.user.id }
      : { role: 'employee' };
    const allEmps = await User.find(scopeQuery).select('_id emp_id leave_balance name role').lean();
    const empMap = {};
    for (const e of allEmps) {
      if (e.emp_id) empMap[e.emp_id.trim().toLowerCase()] = e;
    }

    const updates = [];
    const errors  = [];
    let rowNum = 1;
    ws.eachRow((row, rn) => {
      if (rn === 1) return; // skip header
      rowNum = rn;
      const empId   = String(row.getCell(1).value || '').trim();
      const newBal  = row.getCell(3).value;
      const reason  = String(row.getCell(4).value || '').trim() || 'Excel import';

      if (!empId) return;
      const emp = empMap[empId.toLowerCase()];
      if (!emp) { errors.push(`Row ${rn}: emp_id "${empId}" not found in team`); return; }
      if (newBal === null || newBal === '' || isNaN(Number(newBal))) {
        errors.push(`Row ${rn}: invalid balance value "${newBal}"`); return;
      }
      const balance = clampLeaveBalance(Number(newBal));
      updates.push({ emp, balance, reason });
    });

    if (updates.length === 0) {
      return res.status(400).json({ success: false, message: 'No valid rows found', errors });
    }

    const bulkOps = updates.map(({ emp, balance }) => ({
      updateOne: { filter: { _id: emp._id }, update: { $set: { leave_balance: balance } } },
    }));
    await User.bulkWrite(bulkOps);

    const auditDetails = updates.map(u => `${u.emp.name}(${u.emp.emp_id}):${u.balance}`).join(', ');
    await AuditLog.create({
      user_id: req.user.id, action: 'bulk_leave_balance_excel',
      details: `Excel import set balances for ${updates.length} employees. ${auditDetails}`,
    }).catch(() => {});

    res.json({ success: true, data: { updated: updates.length, errors } });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;