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
const generateToken = () => crypto.randomBytes(32).toString('hex');           // 64-char hex
const hashToken     = (t) => crypto.createHash('sha256').update(t).digest('hex');
const generateOTP   = () => Math.floor(100000 + Math.random() * 900000).toString(); // 6-digit

// ── Rate limiters (relaxed in dev, strict in production) ──────────────────
const isDev = process.env.NODE_ENV !== 'production';
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, max: isDev ? 100 : 10, standardHeaders: true, legacyHeaders: false,
  message: { success: false, message: 'Too many login attempts. Try again in 15 minutes.' },
});
const forgotLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, max: isDev ? 50 : 5, standardHeaders: true, legacyHeaders: false,
  message: { success: false, message: 'Too many password reset requests. Try again in 1 hour.' },
});
const otpLimiter = rateLimit({
  windowMs: 10 * 60 * 1000, max: isDev ? 50 : 5, standardHeaders: true, legacyHeaders: false,
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
    // ── Secret key guard ───────────────────────────────────────────────────
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
  return res.status(403).json({
    success: false,
    message: 'Super admin already exists'
  });
}
    // ── Prevent duplicate email ────────────────────────────────────────────
    // const existingEmail = await User.findOne({ email }).lean();
    // if (existingEmail)
    //   return res.status(409).json({ success: false, message: 'Email already exists' });

    // ── Prevent duplicate empId ────────────────────────────────────────────
    const existingEmpId = await User.findOne({ emp_id: empId }).lean();
    if (existingEmpId)
      return res.status(409).json({ success: false, message: 'Employee ID already exists' });

    // ── Create super_admin ─────────────────────────────────────────────────
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
    const user = await User.findOne({ email, is_active: 1 }).lean();

    // Account lockout check
    if (user && user.login_locked_until && new Date(user.login_locked_until) > new Date()) {
      return res.status(423).json({ success: false, message: 'Account temporarily locked. Try again later.' });
    }

    let passwordValid = user && bcrypt.compareSync(password, user.password_hash);

    // If MongoDB password fails, try Firebase Auth (first-time setup only — skip if user already
    // changed password via the app, to prevent Firebase from overwriting the new hash).
    if (!passwordValid && user && FIREBASE_API_KEY && !user.pwd_changed_at) {
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
        roleType:         user.role_type        || null,
        department:       user.department,
        managerId:        user.manager_id,
        managerName,      managerEmail,
        phone:            user.phone,
      
       designation:      user.designation      || null,
       hrId:             user.hr_id            || null,
        emailVerified:    user.email_verified   || false,
        phoneVerified:    user.phone_verified   || false,
         faceEnrolled:     user.face_enrolled     || false,  // ← ADD THIS
      facePhotoUrl:     user.profile_photo_path || null,  // ← ADD THIS
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
      { $lookup: { from: 'users', localField: 'hr_id',      foreignField: '_id', as: 'hr'      } },
      { $addFields: {
          manager_name:  { $arrayElemAt: ['$manager.name',  0] },
          manager_email: { $arrayElemAt: ['$manager.email', 0] },
          manager_phone: { $arrayElemAt: ['$manager.phone', 0] },
           hr_name:       { $arrayElemAt: ['$hr.name',       0] },
      hr_email:      { $arrayElemAt: ['$hr.email',      0] },
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
      role:         u.role,
        roleType:         u.role_type        || null,   // ← ADD
  designation:      u.designation      || null,   // ← ADD
      department:       u.department,
      managerId:        u.manager_id,
      managerName:      u.manager_name,
      managerEmail:     u.manager_email,
      managerPhone:     u.manager_phone,
        hrId:             u.hr_id            || null,   // ← ADD
  hrName:           u.hr_name          || null,   // 
      phone:            u.phone,
      emailVerified:    u.email_verified   || false,
      phoneVerified:    u.phone_verified   || false,
       faceEnrolled:     u.face_enrolled    || false,  // ← add
   facePhotoUrl:     u.profile_photo_path || null, // ← add
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
// Uses Firebase to send password reset email (works on Render via HTTPS)
// Falls back to custom token flow if Firebase is not configured
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

    const FRONTEND = process.env.FRONTEND_URL || 'https://monitermark.brptripura.com';
    const resetUrl = `${FRONTEND}/reset-password?token=${rawToken}`;
    await sendMail(user.email, '[BRP AMS] Reset Your Password',
      emailLayout('Password Reset Request', `
        <p style="color:#475569;font-size:14px;line-height:1.6;">
          Hi <strong>${user.name}</strong>, we received a request to reset your AMS password.
        </p>
        <p style="color:#475569;font-size:14px;line-height:1.6;">
          Click the button below. This link expires in <strong>30 minutes</strong>.
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

// ── POST /api/auth/reset-password-otp ─────────────────────────────────
// After user clicks the reset link, the frontend calls this to send an OTP
// to the user's email for additional verification before allowing password change.
router.post('/reset-password-otp', otpLimiter, [
  body('token').notEmpty().withMessage('Reset token is required'),
], validate, async (req, res) => {
  try {
    const { token } = req.body;
    const hashedTok = hashToken(token);

    const user = await User.findOne({
      pwd_reset_token:   hashedTok,
      pwd_reset_expires: { $gt: new Date() },
      is_active: 1,
    }).lean();

    if (!user)
      return res.status(400).json({ success: false, message: 'Reset link is invalid or has expired.' });

    const otp       = generateOTP();
    const hashedOtp = hashToken(otp);
    const expires   = new Date(Date.now() + 5 * 60 * 1000); // 5 min

    await User.findByIdAndUpdate(user._id, {
      $set: { pwd_reset_otp: hashedOtp, pwd_reset_otp_expires: expires }
    });

    await sendMail(user.email, '[BRP AMS] Password Reset OTP',
      emailLayout('Password Reset Verification Code', `
        <p style="color:#475569;font-size:14px;line-height:1.6;">
          Hi <strong>${user.name}</strong>, enter this code to verify your identity before resetting your password.
        </p>
        <div style="text-align:center;margin:28px 0;">
          <span style="font-size:42px;font-weight:900;letter-spacing:14px;color:#0b1e3b;">${otp}</span>
        </div>
        <p style="color:#475569;font-size:13px;text-align:center;">
          This code expires in <strong>5 minutes</strong>.
        </p>
        <p style="color:#dc2626;font-size:12px;">Never share this code with anyone.</p>
      `),
      { type: 'PASSWORD_RESET' }
    );

    res.json({ success: true, message: 'OTP sent to your email' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ── POST /api/auth/reset-password ────────────────────────────────────────
router.post('/reset-password', [
  body('token').notEmpty().withMessage('Reset token is required'),
  body('newPassword')
    .isLength({ min: 8 }).withMessage('Password must be at least 8 characters')
    .matches(/[A-Z]/).withMessage('Must contain at least one uppercase letter')
    .matches(/[0-9]/).withMessage('Must contain at least one number')
    .matches(/[!@#$%^&*(),.?":{}|<>]/).withMessage('Must contain at least one special character'),
], validate, async (req, res) => {
  try {
    const { token, newPassword } = req.body;
    const hashedTok = hashToken(token);

    const user = await User.findOne({
      pwd_reset_token:   hashedTok,
      pwd_reset_expires: { $gt: new Date() },
      is_active: 1,
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
  const FRONTEND = process.env.FRONTEND_URL || 'https://ams-frontend-web-q2lw.onrender.com';

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

    const BACKEND = process.env.BACKEND_URL || 'https://ams-backend-3it1.onrender.com/api';
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