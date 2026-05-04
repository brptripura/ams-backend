const express    = require('express');
const router     = express.Router();
const bcrypt     = require('bcryptjs');
const jwt        = require('jsonwebtoken');
const crypto     = require('crypto');
const { v4: uuidv4 } = require('uuid');
const { body, validationResult } = require('express-validator');
const rateLimit  = require('express-rate-limit');
const { User, AuditLog, RevokedToken } = require('../models/database');
const { authenticate } = require('../middleware/auth');
const { sendMail } = require('../utils/mailer');

// ── Secure token helpers ──────────────────────────────────────────────────
const generateToken = () => crypto.randomBytes(32).toString('hex');
const hashToken     = (t) => crypto.createHash('sha256').update(t).digest('hex');
const generateOTP   = () => Math.floor(100000 + Math.random() * 900000).toString();

// ── Rate limiters ─────────────────────────────────────────────────────────
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, max: 10, standardHeaders: true, legacyHeaders: false,
  message: { success: false, message: 'Too many login attempts. Try again in 15 minutes.' },
});
const forgotLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, max: 5, standardHeaders: true, legacyHeaders: false,
  message: { success: false, message: 'Too many password reset requests. Try again in 1 hour.' },
});
const otpLimiter = rateLimit({
  windowMs: 10 * 60 * 1000, max: 5, standardHeaders: true, legacyHeaders: false,
  message: { success: false, message: 'Too many OTP requests. Try again in 10 minutes.' },
});

const validate = (req, res, next) => {
  const e = validationResult(req);
  if (!e.isEmpty()) return res.status(400).json({ success: false, message: e.array()[0].msg });
  next();
};

// ── Branded email layout ──────────────────────────────────────────────────
const emailLayout = (title, bodyHtml) => `
<!DOCTYPE html><html><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1.0"></head>
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
  <h2 style="margin:0 0 16px;color:#0b1e3b;font-size:18px;">${title}</h2>
  ${bodyHtml}
  <hr style="border:none;border-top:1px solid #e2e8f0;margin:28px 0;">
  <p style="margin:0;color:#94a3b8;font-size:12px;">
    Do not reply to this email · BRP AMS Automated System
  </p>
</td></tr>
</table>
</td></tr></table></body></html>`;

// ── Firebase Auth helper (for password sync) ────────────────────────────────
const FIREBASE_API_KEY = process.env.FIREBASE_API_KEY;
const verifyWithFirebase = async (email, password) => {
  if (!FIREBASE_API_KEY) return false;
  try {
    const res = await fetch(
      `https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${FIREBASE_API_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password, returnSecureToken: true }),
      }
    );
    const data = await res.json();
    return res.ok && !!data.idToken;
  } catch { return false; }
};

router.post('/register-super-admin', [
  body('name').trim().notEmpty().withMessage('Name is required'),
  body('email').isEmail().normalizeEmail({ gmail_remove_dots: false, all_lowercase: true }).withMessage('Valid email required'),
  body('empId').trim().notEmpty().withMessage('Employee ID is required'),
  body('password').isLength({ min: 6 }).withMessage('Password must be at least 6 characters'),
  body('department').trim().notEmpty().withMessage('Department is required'),
], validate, async (req, res) => {
  try {
    const secret         = req.headers['x-register-secret'];
    const expectedSecret = process.env.REGISTER_SECRET;

    if (!expectedSecret) {
      return res.status(500).json({ success: false, message: 'REGISTER_SECRET not set in .env' });
    }
    if (!secret || secret !== expectedSecret) {
      return res.status(403).json({ success: false, message: 'Invalid or missing register secret' });
    }

    const { name, email, empId, password, phone, department } = req.body;

    const existingSuperAdmin = await User.findOne({ role: 'super_admin' });
    if (existingSuperAdmin) {
      return res.status(403).json({ success: false, message: 'Super admin already exists' });
    }

    const existingEmpId = await User.findOne({ emp_id: empId }).lean();
    if (existingEmpId)
      return res.status(409).json({ success: false, message: 'Employee ID already exists' });

    const id = uuidv4();
    await User.create({
      _id:           id,
      emp_id:        empId,
      name,
      email,
      password_hash: bcrypt.hashSync(password, 10),
      role:          'super_admin',
      department,
      phone:         phone || null,
      is_active:     1,
      email_verified: true,
      phone_verified: true,
    });

    const user = await User.findById(id).lean();

    res.status(201).json({
      success: true,
      message: 'Super Admin registered successfully',
      data: {
        id:         user._id,
        empId:      user.emp_id,
        name:       user.name,
        email:      user.email,
        role:       user.role,
        department: user.department,
        phone:      user.phone,
      },
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ── POST /api/auth/login ──────────────────────────────────────────────────
router.post('/login', loginLimiter, [
  body('email').isEmail().normalizeEmail({ gmail_remove_dots: false, all_lowercase: true }),
  body('password').notEmpty(),
], validate, async (req, res) => {
  try {
    const { email, password } = req.body;
    // is_active: { $ne: 0 } handles both numeric 1 and boolean true stored in older records
    const user = await User.findOne({ email, is_active: { $ne: 0 } }).lean();

    // Account lockout check
    if (user && user.login_locked_until && new Date(user.login_locked_until) > new Date()) {
      return res.status(423).json({ success: false, message: 'Account temporarily locked. Try again later.' });
    }

    let passwordValid = user && bcrypt.compareSync(password, user.password_hash);

    // If MongoDB password fails, try Firebase Auth (user may have reset password via Firebase)
    if (!passwordValid && user && FIREBASE_API_KEY) {
      const firebaseOk = await verifyWithFirebase(email, password);
      if (firebaseOk) {
        // Password valid in Firebase — sync back to MongoDB + auto-verify email
        console.log(`[Auth] Firebase password sync for: ${email}`);
        const syncUpdate = { password_hash: bcrypt.hashSync(password, 12) };
        // If user set password via Firebase, they proved email ownership = verified
        if (!user.email_verified) {
          syncUpdate.email_verified = true;
          console.log(`[Auth] Auto-verified email for: ${email}`);
        }
        await User.findByIdAndUpdate(user._id, { $set: syncUpdate });
        passwordValid = true;
      }
    }

    if (!user || !passwordValid) {
      // Audit log for failed login
      if (user) {
        await AuditLog.create({ _id: uuidv4(), user_id: user._id, action: 'LOGIN_FAILED', ip_address: req.ip });
        const attempts = (user.failed_login_attempts || 0) + 1;
        const updateFields = { failed_login_attempts: attempts };
        if (attempts >= 5) {
          updateFields.login_locked_until = new Date(Date.now() + 15 * 60 * 1000);
        }
        await User.findByIdAndUpdate(user._id, { $set: updateFields });
      }
      return res.status(401).json({ success: false, message: 'Invalid email or password' });
    }

    // Reset failed login attempts on successful login
    await User.findByIdAndUpdate(user._id, { $set: { failed_login_attempts: 0, login_locked_until: null } });

    const token = jwt.sign(
      { id: user._id, role: user.role, emp_id: user.emp_id },
      process.env.JWT_SECRET,
      { expiresIn: process.env.JWT_EXPIRES_IN || '24h' }
    );

    await AuditLog.create({ _id: uuidv4(), user_id: user._id, action: 'LOGIN', ip_address: req.ip });

    let managerName = null, managerEmail = null;
    if (user.manager_id) {
      const mgr = await User.findById(user.manager_id).select('name email').lean();
      if (mgr) { managerName = mgr.name; managerEmail = mgr.email; }
    }

    res.json({
      success: true, token,
      user: {
        id:               user._id,
        empId:            user.emp_id,
        name:             user.name,
        email:            user.email,
        role:             user.role,
        department:       user.department,
        managerId:        user.manager_id,
        managerName,      managerEmail,
        phone:            user.phone,
        emailVerified:    user.email_verified   || false,
        phoneVerified:    user.phone_verified   || false,
        assignedBlock:    user.assigned_block,
        assignedDistrict: user.assigned_district,
      }
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ── POST /api/auth/logout ─────────────────────────────────────────────────
router.post('/logout', authenticate, async (req, res) => {
  try {
    const tokenHash = crypto.createHash('sha256').update(req.token).digest('hex');
    await RevokedToken.updateOne(
      { _id: tokenHash },
      { $setOnInsert: { _id: tokenHash, revoked_at: new Date() } },
      { upsert: true }
    );
    await AuditLog.create({ _id: uuidv4(), user_id: req.user.id, action: 'LOGOUT', ip_address: req.ip });
    res.json({ success: true, message: 'Logged out successfully' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ── GET /api/auth/me ──────────────────────────────────────────────────────
router.get('/me', authenticate, async (req, res) => {
  try {
    const users = await User.aggregate([
      { $match: { _id: req.user.id } },
      { $lookup: { from: 'users', localField: 'manager_id', foreignField: '_id', as: 'manager' } },
      { $addFields: {
          manager_name:  { $arrayElemAt: ['$manager.name',  0] },
          manager_email: { $arrayElemAt: ['$manager.email', 0] },
          manager_phone: { $arrayElemAt: ['$manager.phone', 0] },
      }},
      { $project: { manager: 0, password_hash: 0, email_verify_token: 0, pwd_reset_token: 0, phone_otp: 0 } },
    ]);

    if (!users.length) return res.status(404).json({ success: false, message: 'User not found' });
    const u = users[0];
    res.json({ success: true, user: {
      id:               u._id,
      empId:            u.emp_id,
      name:             u.name,
      email:            u.email,
      role:             u.role,
      department:       u.department,
      managerId:        u.manager_id,
      managerName:      u.manager_name,
      managerEmail:     u.manager_email,
      managerPhone:     u.manager_phone,
      phone:            u.phone,
      emailVerified:    u.email_verified   || false,
      phoneVerified:    u.phone_verified   || false,
      createdAt:        u.created_at,
      assignedBlock:    u.assigned_block,
      assignedDistrict: u.assigned_district,
    }});
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ── PUT /api/auth/change-password ─────────────────────────────────────────
router.put('/change-password', authenticate, [
  body('currentPassword').notEmpty().withMessage('Current password is required'),
  body('newPassword')
    .isLength({ min: 8 }).withMessage('Password must be at least 8 characters')
    .matches(/[A-Z]/).withMessage('Must contain at least one uppercase letter')
    .matches(/[0-9]/).withMessage('Must contain at least one number')
    .matches(/[!@#$%^&*(),.?":{}|<>]/).withMessage('Must contain at least one special character'),
], validate, async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;
    const user = await User.findById(req.user.id).lean();

    if (!bcrypt.compareSync(currentPassword, user.password_hash))
      return res.status(400).json({ success: false, message: 'Current password is incorrect' });

    if (bcrypt.compareSync(newPassword, user.password_hash))
      return res.status(400).json({ success: false, message: 'New password must differ from current password' });

    await User.findByIdAndUpdate(req.user.id, {
      $set: { password_hash: bcrypt.hashSync(newPassword, 12), pwd_changed_at: new Date() }
    });
    await AuditLog.create({ _id: uuidv4(), user_id: req.user.id, action: 'CHANGE_PASSWORD', ip_address: req.ip });
    res.json({ success: true, message: 'Password changed successfully' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ── POST /api/auth/forgot-password ───────────────────────────────────────
router.post('/forgot-password', forgotLimiter, [
  body('email').isEmail().normalizeEmail({ gmail_remove_dots: false, all_lowercase: true }).withMessage('Valid email required'),
], validate, async (req, res) => {
  try {
    const { email } = req.body;
    const user = await User.findOne({ email, is_active: { $ne: 0 } }).lean();

    // Always same response — prevents email enumeration
    const OK = { success: true, message: 'If that email is registered you will receive a password reset email shortly.' };

    if (!user) return res.json(OK);

    const rawToken  = generateToken();
    const hashedTok = hashToken(rawToken);
    const expires   = new Date(Date.now() + 30 * 60 * 1000); // 30 min

    await User.findByIdAndUpdate(user._id, {
      $set: { pwd_reset_token: hashedTok, pwd_reset_expires: expires }
    });

    // Link always points to THIS backend — no FRONTEND_URL dependency.
    // The GET /api/auth/reset-password route below serves a self-contained HTML form.
    const BACKEND  = (process.env.BACKEND_URL || 'https://brp-mobile.onrender.com').replace(/\/$/, '');
    const resetUrl = `${BACKEND}/api/auth/reset-password?token=${rawToken}`;

    await sendMail(user.email, '[BRP AMS] Reset Your Password',
      emailLayout('Password Reset Request', `
        <p style="color:#475569;font-size:14px;line-height:1.6;">
          Hi <strong>${user.name}</strong>, we received a request to reset your AMS password.
        </p>
        <p style="color:#475569;font-size:14px;line-height:1.6;">
          Click the button below. The link expires in <strong>30 minutes</strong>.
        </p>
        <div style="text-align:center;margin:28px 0;">
          <a href="${resetUrl}"
            style="background:#1E3A8A;color:#fff;padding:14px 32px;border-radius:8px;
                   text-decoration:none;font-weight:700;font-size:15px;display:inline-block;">
            Reset Password
          </a>
        </div>
        <p style="color:#94a3b8;font-size:12px;word-break:break-all;">
          Or copy this link: ${resetUrl}
        </p>
        <p style="color:#dc2626;font-size:13px;">
          If you didn't request this, ignore this email — your password will not change.
        </p>
      `),
      { type: 'PASSWORD_RESET' }
    );

    await AuditLog.create({ _id: uuidv4(), user_id: user._id, action: 'FORGOT_PASSWORD', ip_address: req.ip });
    res.json(OK);
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ── Shared HTML shell for reset-password pages ───────────────────────────
const resetPageShell = (icon, title, bodyHtml) => `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title} — BRP AMS</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{min-height:100vh;display:flex;align-items:center;justify-content:center;
     background:linear-gradient(145deg,#0A1F44 0%,#1E3A8A 60%,#1e40af 100%);
     font-family:Arial,Helvetica,sans-serif;padding:20px}
.card{background:#fff;border-radius:20px;box-shadow:0 24px 64px rgba(0,0,0,.25);
      width:100%;max-width:440px;overflow:hidden}
.hdr{background:linear-gradient(135deg,#1E3A8A,#2563EB);padding:24px 28px;text-align:center}
.hdr-ico{width:52px;height:52px;border-radius:16px;background:rgba(255,255,255,.15);
          display:flex;align-items:center;justify-content:center;margin:0 auto 12px;font-size:24px}
.hdr h1{color:#fff;font-size:19px;font-weight:800;margin:0 0 3px}
.hdr p{color:rgba(255,255,255,.7);font-size:12px;margin:0}
.body{padding:24px 28px}
label{display:block;font-size:11px;font-weight:700;color:#475569;
      text-transform:uppercase;letter-spacing:.5px;margin-bottom:6px;margin-top:14px}
input[type=password],input[type=text]{
  width:100%;border:1.5px solid #e2e8f0;border-radius:10px;
  padding:13px 14px;font-size:15px;color:#0f172a;outline:none;
  font-family:inherit;box-sizing:border-box;-webkit-appearance:none}
input:focus{border-color:#1E3A8A;box-shadow:0 0 0 3px rgba(30,58,138,.12)}
.hint{font-size:11px;color:#64748b;background:#F8FAFC;border-radius:8px;
      padding:10px 12px;margin:14px 0 18px;line-height:1.9}
.hint b{color:#1E3A8A}
.btn-primary{display:block;width:100%;padding:14px;border-radius:10px;border:none;
             font-size:15px;font-weight:700;cursor:pointer;font-family:inherit;
             background:linear-gradient(135deg,#1E3A8A,#2563EB);color:#fff;
             box-shadow:0 4px 14px rgba(30,58,138,.3);margin-top:4px;
             -webkit-appearance:none;text-align:center;text-decoration:none}
.btn-outline{display:block;width:100%;padding:13px;border-radius:10px;
             background:none;color:#1E3A8A;border:1.5px solid #e2e8f0;
             margin-top:10px;text-align:center;font-size:15px;font-weight:700;
             text-decoration:none;font-family:inherit;cursor:pointer;box-sizing:border-box}
.alert-err{background:#FEF2F2;color:#DC2626;border:1px solid #FCA5A5;
           border-radius:10px;padding:12px 14px;font-size:13px;margin-bottom:14px;line-height:1.5}
.center{text-align:center}
.big{font-size:52px;margin-bottom:14px}
.page-title{font-size:18px;font-weight:800;color:#1E3A8A;margin-bottom:8px}
.sub{font-size:14px;color:#64748b;line-height:1.6;margin-bottom:22px}
</style>
</head><body>
<div class="card">
  <div class="hdr">
    <div class="hdr-ico">${icon}</div>
    <h1>${title}</h1>
    <p>BRP Attendance Management System</p>
  </div>
  <div class="body">${bodyHtml}</div>
</div>
</body></html>`;

// ── GET /api/auth/reset-password ─────────────────────────────────────────
// Email links point here. Validates the token, then serves a ZERO-JS pure-HTML
// form. The form POSTs to /api/auth/reset-password-form (urlencoded) which
// returns an HTML success page or redirects back here with ?error=.
// No <script> tags — not blocked by Helmet CSP script-src 'self'.
router.get('/reset-password', async (req, res) => {
  const token    = (req.query.token || '').trim();
  const errorMsg = (req.query.error  || '').trim();
  const FRONTEND = (process.env.FRONTEND_URL  || '').replace(/\/$/, '');
  const BACKEND  = (process.env.BACKEND_URL   || 'https://brp-mobile.onrender.com').replace(/\/$/, '');
  const loginUrl = FRONTEND ? `${FRONTEND}/login` : `${BACKEND}/login`;

  // ── Shared CSS (no JS anywhere) ──────────────────────────────────────
  const page = (icon, title, bodyHtml, status = 200) => {
    res.status(status).send(`<!DOCTYPE html>
<html lang="en"><head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title} — BRP AMS</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{min-height:100vh;display:flex;align-items:center;justify-content:center;
     background:linear-gradient(145deg,#0A1F44 0%,#1E3A8A 60%,#1e40af 100%);
     font-family:Arial,Helvetica,sans-serif;padding:20px}
.card{background:#fff;border-radius:20px;box-shadow:0 24px 64px rgba(0,0,0,.25);
      width:100%;max-width:440px;overflow:hidden}
.hdr{background:linear-gradient(135deg,#1E3A8A,#2563EB);padding:24px 28px;text-align:center}
.hdr-ico{width:52px;height:52px;border-radius:16px;background:rgba(255,255,255,.15);
         display:flex;align-items:center;justify-content:center;margin:0 auto 12px;font-size:24px}
.hdr h1{color:#fff;font-size:19px;font-weight:800;margin:0 0 3px}
.hdr p{color:rgba(255,255,255,.7);font-size:12px;margin:0}
.body{padding:24px 28px}
label{display:block;font-size:11px;font-weight:700;color:#475569;
      text-transform:uppercase;letter-spacing:.5px;margin-bottom:6px;margin-top:16px}
input[type=password]{width:100%;border:1.5px solid #e2e8f0;border-radius:10px;
  padding:13px 14px;font-size:15px;color:#0f172a;outline:none;
  font-family:inherit;-webkit-appearance:none;appearance:none}
input[type=password]:focus{border-color:#1E3A8A;box-shadow:0 0 0 3px rgba(30,58,138,.12)}
.hint{font-size:11px;color:#64748b;background:#F8FAFC;border-radius:8px;
      padding:10px 12px;margin:16px 0 20px;line-height:1.9}
.hint b{color:#1E3A8A}
.btn-primary{display:block;width:100%;padding:14px;border-radius:10px;border:none;
             font-size:15px;font-weight:700;cursor:pointer;font-family:inherit;
             background:linear-gradient(135deg,#1E3A8A,#2563EB);color:#fff;
             box-shadow:0 4px 14px rgba(30,58,138,.3);margin-top:4px;
             -webkit-appearance:none;text-align:center}
.btn-outline{display:block;width:100%;padding:13px;border-radius:10px;background:#fff;
             color:#1E3A8A;border:1.5px solid #e2e8f0;margin-top:10px;text-align:center;
             font-size:15px;font-weight:700;text-decoration:none;box-sizing:border-box}
.alert-err{background:#FEF2F2;color:#DC2626;border:1px solid #FCA5A5;
           border-radius:10px;padding:12px 14px;font-size:13px;margin-bottom:16px;line-height:1.5}
.center{text-align:center}
.big{font-size:52px;margin-bottom:14px}
.page-title{font-size:18px;font-weight:800;color:#1E3A8A;margin-bottom:8px}
.sub{font-size:14px;color:#64748b;line-height:1.6;margin-bottom:22px}
</style>
</head><body>
<div class="card">
  <div class="hdr">
    <div class="hdr-ico">${icon}</div>
    <h1>${title}</h1>
    <p>BRP Attendance Management System</p>
  </div>
  <div class="body">${bodyHtml}</div>
</div>
</body></html>`);
  };

  // ── Token missing ────────────────────────────────────────────────────
  if (!token) {
    return page('❌', 'Invalid Link', `
      <div class="center">
        <div class="big">❌</div>
        <div class="page-title">Link Invalid</div>
        <p class="sub">This password reset link is missing the token.<br>Please request a new one.</p>
        <a href="${loginUrl}" class="btn-primary">← Back to Sign In</a>
      </div>`, 400);
  }

  // ── Validate token in DB ─────────────────────────────────────────────
  let user;
  try {
    user = await User.findOne({
      pwd_reset_token:   hashToken(token),
      pwd_reset_expires: { $gt: new Date() },
      is_active:         { $ne: 0 },
    }).lean();
  } catch (e) {
    console.error('[ResetPage] DB error:', e.message);
  }

  if (!user) {
    return page('⏰', 'Link Expired', `
      <div class="center">
        <div class="big">⏰</div>
        <div class="page-title">Link Expired or Already Used</div>
        <p class="sub">This link expired (valid 30 min) or was already used.<br><br>
        Please request a new one from the Sign In page.</p>
        <a href="${loginUrl}" class="btn-primary">← Back to Sign In</a>
      </div>`, 400);
  }

  // ── Valid token — serve pure-HTML form, zero JavaScript ──────────────
  const safeName = (user.name || '').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const safeToken = token.replace(/[^a-f0-9]/gi, ''); // hex only — safe to embed in value attr
  const errBlock = errorMsg
    ? `<div class="alert-err">⚠️ ${errorMsg.replace(/</g, '&lt;').replace(/>/g, '&gt;')}</div>`
    : '';

  return page('🔐', 'Set New Password', `
    <p style="font-size:14px;color:#64748b;text-align:center;margin-bottom:20px;line-height:1.6">
      Hi <strong style="color:#1E3A8A">${safeName}</strong>, enter your new password below.
    </p>
    ${errBlock}
    <form method="POST" action="${BACKEND}/api/auth/reset-password-form">
      <input type="hidden" name="token" value="${safeToken}">

      <label for="newPassword">New Password <span style="color:#DC2626">*</span></label>
      <input type="password" id="newPassword" name="newPassword"
             placeholder="Min 8 chars · Upper · Number · Symbol" required autocomplete="new-password">

      <label for="confirmPassword" style="margin-top:14px">
        Confirm Password <span style="color:#DC2626">*</span>
      </label>
      <input type="password" id="confirmPassword" name="confirmPassword"
             placeholder="Repeat new password" required autocomplete="new-password">

      <div class="hint">
        <b>Password must have:</b><br>
        ✓ 8+ characters &nbsp;·&nbsp; ✓ Uppercase (A–Z) &nbsp;·&nbsp; ✓ Lowercase (a–z)<br>
        ✓ Number (0–9) &nbsp;·&nbsp; ✓ Symbol (!@#$%^&amp;*)
      </div>

      <button type="submit" class="btn-primary">Reset Password</button>
    </form>
    <a href="${loginUrl}" class="btn-outline">← Back to Sign In</a>
  `);
});

// ── POST /api/auth/reset-password-form ───────────────────────────────────
// Handles the urlencoded form POST from the GET page above.
// No JavaScript needed — validates on server, returns HTML success or redirects
// back to the form with an ?error= query parameter.
router.post('/reset-password-form', express.urlencoded({ extended: false }), async (req, res) => {
  const FRONTEND = (process.env.FRONTEND_URL  || '').replace(/\/$/, '');
  const BACKEND  = (process.env.BACKEND_URL   || 'https://brp-mobile.onrender.com').replace(/\/$/, '');
  const loginUrl = FRONTEND ? `${FRONTEND}/login` : `${BACKEND}/login`;

  const token           = (req.body.token           || '').trim();
  const newPassword     = (req.body.newPassword     || '');
  const confirmPassword = (req.body.confirmPassword || '');

  // Helper: redirect back to form with error message
  const formError = (msg) => {
    const safeMsg = encodeURIComponent(msg);
    const safeToken = encodeURIComponent(token);
    return res.redirect(302, `${BACKEND}/api/auth/reset-password?token=${safeToken}&error=${safeMsg}`);
  };

  // ── Basic validations ────────────────────────────────────────────────
  if (!token)           return formError('Reset token missing. Please use the link from your email.');
  if (!newPassword)     return formError('New password is required.');
  if (newPassword !== confirmPassword) return formError('Passwords do not match. Please try again.');
  if (newPassword.length < 8)          return formError('Password must be at least 8 characters.');
  if (!/[A-Z]/.test(newPassword))      return formError('Password must contain at least one uppercase letter (A-Z).');
  if (!/[a-z]/.test(newPassword))      return formError('Password must contain at least one lowercase letter (a-z).');
  if (!/[0-9]/.test(newPassword))      return formError('Password must contain at least one number (0-9).');
  if (!/[!@#$%^&*()\-_+=\[\]{};':"\\|,.<>\/?`~]/.test(newPassword))
    return formError('Password must contain at least one special character (!@#$%^&*...).');

  // ── Verify token in DB ───────────────────────────────────────────────
  let user;
  try {
    user = await User.findOne({
      pwd_reset_token:   hashToken(token),
      pwd_reset_expires: { $gt: new Date() },
      is_active:         { $ne: 0 },
    }).lean();
  } catch (e) {
    console.error('[ResetForm] DB error:', e.message);
    return formError('Server error. Please try again.');
  }

  if (!user) {
    return formError('This reset link has expired or already been used. Please request a new one.');
  }

  // ── Update password ──────────────────────────────────────────────────
  try {
    await User.findByIdAndUpdate(user._id, {
      $set: {
        password_hash:         bcrypt.hashSync(newPassword, 12),
        pwd_reset_token:       null,
        pwd_reset_expires:     null,
        pwd_reset_otp:         null,
        pwd_reset_otp_expires: null,
        pwd_changed_at:        new Date(),
        failed_login_attempts: 0,
        login_locked_until:    null,
        is_active:             1,
      },
    });
    await AuditLog.create({ _id: uuidv4(), user_id: user._id, action: 'RESET_PASSWORD', ip_address: req.ip });
  } catch (e) {
    console.error('[ResetForm] Update error:', e.message);
    return formError('Server error while saving password. Please try again.');
  }

  // Fire-and-forget confirmation email
  sendMail(user.email, '[BRP AMS] Password Changed',
    emailLayout('Password Changed Successfully', `
      <p style="color:#475569;font-size:14px;line-height:1.6;">
        Hi <strong>${user.name}</strong>, your AMS password was changed successfully.
      </p>
      <p style="color:#dc2626;font-size:13px;">
        If you did not do this, contact your administrator immediately.
      </p>
    `),
    { type: 'PASSWORD_RESET' }
  ).catch(err => console.error('[Auth] Password changed email failed:', err.message));

  // ── Success page ─────────────────────────────────────────────────────
  const safeName = (user.name || '').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  res.send(`<!DOCTYPE html>
<html lang="en"><head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="refresh" content="4;url=${loginUrl}">
<title>Password Reset — BRP AMS</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{min-height:100vh;display:flex;align-items:center;justify-content:center;
     background:linear-gradient(145deg,#0A1F44 0%,#1E3A8A 60%,#1e40af 100%);
     font-family:Arial,Helvetica,sans-serif;padding:20px}
.card{background:#fff;border-radius:20px;box-shadow:0 24px 64px rgba(0,0,0,.25);
      width:100%;max-width:440px;overflow:hidden}
.hdr{background:linear-gradient(135deg,#16a34a,#15803d);padding:24px 28px;text-align:center}
.hdr-ico{width:52px;height:52px;border-radius:16px;background:rgba(255,255,255,.2);
         display:flex;align-items:center;justify-content:center;margin:0 auto 12px;font-size:24px}
.hdr h1{color:#fff;font-size:19px;font-weight:800;margin:0 0 3px}
.hdr p{color:rgba(255,255,255,.75);font-size:12px;margin:0}
.body{padding:28px;text-align:center}
.big{font-size:52px;margin-bottom:16px}
.title{font-size:18px;font-weight:800;color:#15803d;margin-bottom:10px}
.sub{font-size:14px;color:#64748b;line-height:1.6;margin-bottom:24px}
.note{font-size:12px;color:#94a3b8;margin-bottom:20px}
.btn{display:block;width:100%;padding:14px;border-radius:10px;border:none;font-size:15px;
     font-weight:700;cursor:pointer;font-family:inherit;
     background:linear-gradient(135deg,#1E3A8A,#2563EB);color:#fff;
     box-shadow:0 4px 14px rgba(30,58,138,.3);text-decoration:none;text-align:center}
</style>
</head><body>
<div class="card">
  <div class="hdr">
    <div class="hdr-ico">✅</div>
    <h1>Password Reset!</h1>
    <p>BRP Attendance Management System</p>
  </div>
  <div class="body">
    <div class="big">🎉</div>
    <div class="title">All Done, ${safeName}!</div>
    <p class="sub">Your password has been reset successfully.<br>You can now sign in with your new password.</p>
    <p class="note">Redirecting to Sign In automatically in 4 seconds…</p>
    <a href="${loginUrl}" class="btn">Sign In Now →</a>
  </div>
</div>
</body></html>`);
});

// ── POST /api/auth/reset-password-otp ─────────────────────────────────
// Kept for backwards compatibility — just validates the token is still valid
router.post('/reset-password-otp', otpLimiter, [
  body('token').notEmpty().withMessage('Reset token is required'),
], validate, async (req, res) => {
  try {
    const hashedTok = hashToken(req.body.token);
    const user = await User.findOne({
      pwd_reset_token:   hashedTok,
      pwd_reset_expires: { $gt: new Date() },
      is_active: { $ne: 0 },
    }).lean();
    if (!user)
      return res.status(400).json({ success: false, message: 'Reset link is invalid or has expired.' });
    res.json({ success: true, message: 'Token valid' });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ── POST /api/auth/reset-password ────────────────────────────────────────
// Accepts: { token, newPassword }  — no OTP required (token is cryptographically secure + 30-min expiry)
router.post('/reset-password', [
  body('token').notEmpty().withMessage('Reset token is required'),
  body('newPassword')
    .isLength({ min: 8 }).withMessage('Password must be at least 8 characters')
    .matches(/[A-Z]/).withMessage('Must contain at least one uppercase letter')
    .matches(/[0-9]/).withMessage('Must contain at least one number')
    .matches(/[!@#$%^&*()_\-+=@$!%*?&#^,.?":{}|<>]/).withMessage('Must contain at least one special character'),
], validate, async (req, res) => {
  try {
    const { token, newPassword } = req.body;
    const hashedTok = hashToken(token);

    const user = await User.findOne({
      pwd_reset_token:   hashedTok,
      pwd_reset_expires: { $gt: new Date() },
      is_active: { $ne: 0 },
    }).lean();

    if (!user)
      return res.status(400).json({ success: false, message: 'Reset link is invalid or has expired.' });

    await User.findByIdAndUpdate(user._id, {
      $set: {
        password_hash:         bcrypt.hashSync(newPassword, 12),
        pwd_reset_token:       null,
        pwd_reset_expires:     null,
        pwd_reset_otp:         null,
        pwd_reset_otp_expires: null,
        pwd_changed_at:        new Date(),
        failed_login_attempts: 0,
        login_locked_until:    null,
        is_active:             1,
      }
    });
    await AuditLog.create({ _id: uuidv4(), user_id: user._id, action: 'RESET_PASSWORD', ip_address: req.ip });

    // Password changed notification — fire-and-forget
    sendMail(user.email, '[BRP AMS] Password Changed',
      emailLayout('Password Changed Successfully', `
        <p style="color:#475569;font-size:14px;line-height:1.6;">
          Hi <strong>${user.name}</strong>, your AMS password was changed successfully.
        </p>
        <p style="color:#dc2626;font-size:13px;">
          If you did not do this, contact your administrator immediately.
        </p>
      `),
      { type: 'PASSWORD_RESET' }
    ).catch(err => console.error('[Auth] Password changed email failed:', err.message));

    res.json({ success: true, message: 'Password reset successfully. Please log in.' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ── GET /api/auth/verify-email/:token ────────────────────────────────────
// Called when user clicks the verification link in their welcome email.
// Returns a self-contained HTML page — no redirect, no FRONTEND_URL needed.
router.get('/verify-email/:token', async (req, res) => {
  const FRONTEND = process.env.FRONTEND_URL || 'https://ams-frontend-web-niuz.onrender.com';

  const page = (success, title, message) => `<!DOCTYPE html>
<html><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title} — BRP AMS</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{min-height:100vh;display:flex;align-items:center;justify-content:center;
       background:#f2f6f8;font-family:Arial,sans-serif;padding:24px}
  .card{background:#fff;border-radius:16px;box-shadow:0 4px 24px rgba(0,0,0,.1);
        padding:40px 36px;max-width:440px;width:100%;text-align:center}
  .icon{font-size:52px;margin-bottom:20px}
  h1{color:#0b1e3b;font-size:22px;margin-bottom:12px}
  p{color:#475569;font-size:14px;line-height:1.7;margin-bottom:28px}
  a.btn{display:inline-block;background:${success ? '#21879d' : '#64748b'};color:#fff;
        padding:13px 32px;border-radius:10px;text-decoration:none;font-weight:700;font-size:15px}
  a.btn:hover{opacity:.9}
  .brand{color:#0b1e3b;font-size:12px;margin-top:24px;opacity:.5}
</style></head>
<body><div class="card">
  <div class="icon">${success ? '✅' : '❌'}</div>
  <h1>${title}</h1>
  <p>${message}</p>
  <a class="btn" href="${FRONTEND}/login">Go to Login</a>
  <div class="brand">BRP · AMS &nbsp;|&nbsp; Attendance Management System</div>
</div></body></html>`;

  try {
    const hashedTok = hashToken(req.params.token);
    const user = await User.findOne({
      email_verify_token:   hashedTok,
      email_verify_expires: { $gt: new Date() },
    }).lean();

    if (!user) {
      return res.status(400).send(page(false,
        'Link Invalid or Expired',
        'This verification link is no longer valid. It may have already been used or expired (links are valid for 24 hours).<br><br>Please log in and request a new verification email from your profile.'
      ));
    }

    await User.findByIdAndUpdate(user._id, {
      $set: { email_verified: true, email_verify_token: null, email_verify_expires: null }
    });
    await AuditLog.create({ _id: uuidv4(), user_id: user._id, action: 'EMAIL_VERIFIED', ip_address: req.ip });

    const safeName = user.name.replace(/</g, '&lt;').replace(/>/g, '&gt;');
    res.send(page(true,
      'Email Verified!',
      `Your email has been verified successfully, <strong>${safeName}</strong>.<br><br>Your account is now active. Click below to sign in.`
    ));
  } catch (err) {
    console.error(err);
    res.status(500).send(page(false, 'Server Error', 'Something went wrong. Please try again later.'));
  }
});

// ── POST /api/auth/resend-verification ───────────────────────────────────
router.post('/resend-verification', authenticate, async (req, res) => {
  try {
    const user = await User.findById(req.user.id).lean();
    if (!user)           return res.status(404).json({ success: false, message: 'User not found' });
    if (user.email_verified) return res.json({ success: true, message: 'Email already verified' });

    const rawToken  = generateToken();
    const hashedTok = hashToken(rawToken);
    const expires   = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24h

    await User.findByIdAndUpdate(user._id, {
      $set: { email_verify_token: hashedTok, email_verify_expires: expires }
    });

    const BACKEND = process.env.BACKEND_URL || 'https://brp-mobile.onrender.com';
    const verifyUrl = `${BACKEND}/api/auth/verify-email/${rawToken}`;
    await sendMail(user.email, '[BRP AMS] Verify Your Email',
      emailLayout('Verify Your Email Address', `
        <p style="color:#475569;font-size:14px;line-height:1.6;">
          Hi <strong>${user.name}</strong>, please verify your email address by clicking below.
        </p>
        <div style="text-align:center;margin:28px 0;">
          <a href="${verifyUrl}"
            style="background:#21879d;color:#fff;padding:14px 32px;border-radius:8px;
                   text-decoration:none;font-weight:700;font-size:15px;display:inline-block;">
            Verify Email
          </a>
        </div>
        <p style="color:#94a3b8;font-size:12px;">This link expires in 24 hours.</p>
      `),
      { type: 'VERIFY_EMAIL' }
    );
    res.json({ success: true, message: 'Verification email sent' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ── POST /api/auth/send-phone-otp ─────────────────────────────────────────
// Sends a 6-digit OTP to the user's registered email
// (Replace sendMail with Twilio SMS when you add a SIM/Twilio account)
router.post('/send-phone-otp', otpLimiter, authenticate, async (req, res) => {
  try {
    const user = await User.findById(req.user.id).lean();
    if (!user)        return res.status(404).json({ success: false, message: 'User not found' });
    if (!user.phone)  return res.status(400).json({ success: false, message: 'No phone on your account. Update your profile first.' });
    if (user.phone_verified) return res.json({ success: true, message: 'Phone already verified' });

    const otp       = generateOTP();
    const hashed    = hashToken(otp);
    const expires   = new Date(Date.now() + 10 * 60 * 1000); // 10 min

    await User.findByIdAndUpdate(user._id, {
      $set: { phone_otp: hashed, phone_otp_expires: expires }
    });

    await sendMail(user.email, '[BRP AMS] Your Verification Code',
      emailLayout('Phone Verification Code', `
        <p style="color:#475569;font-size:14px;line-height:1.6;">
          Hi <strong>${user.name}</strong>, your verification code for phone number <strong>${user.phone}</strong> is:
        </p>
        <div style="text-align:center;margin:28px 0;">
          <span style="font-size:42px;font-weight:900;letter-spacing:14px;color:#0b1e3b;">${otp}</span>
        </div>
        <p style="color:#475569;font-size:13px;text-align:center;">
          This code expires in <strong>10 minutes</strong>.
        </p>
        <p style="color:#dc2626;font-size:12px;">Never share this code with anyone.</p>
      `),
      { type: 'VERIFY_EMAIL' }
    );

    res.json({ success: true, message: 'OTP sent to your registered email' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ── POST /api/auth/verify-phone-otp ──────────────────────────────────────
router.post('/verify-phone-otp', authenticate, [
  body('otp').isLength({ min: 6, max: 6 }).isNumeric().withMessage('OTP must be 6 digits'),
], validate, async (req, res) => {
  try {
    const user = await User.findById(req.user.id).lean();
    if (!user?.phone_otp || !user?.phone_otp_expires)
      return res.status(400).json({ success: false, message: 'No pending OTP. Request a new one.' });

    if (new Date() > user.phone_otp_expires)
      return res.status(400).json({ success: false, message: 'OTP expired. Request a new one.' });

    if (hashToken(req.body.otp) !== user.phone_otp)
      return res.status(400).json({ success: false, message: 'Invalid OTP' });

    await User.findByIdAndUpdate(user._id, {
      $set: { phone_verified: true, phone_otp: null, phone_otp_expires: null }
    });
    await AuditLog.create({ _id: uuidv4(), user_id: user._id, action: 'PHONE_VERIFIED', ip_address: req.ip });
    res.json({ success: true, message: 'Phone verified successfully' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

module.exports = router;