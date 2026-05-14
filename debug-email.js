/**
 * Debug exactly what happens in the forgot-password route
 * Run: node debug-email.js
 */
const dns = require('node:dns');
dns.setServers(['8.8.8.8', '1.1.1.1']);
require('dotenv').config();

// Wait for connection
process.env.MONGO_URI = process.env.MONGO_URI;

// Load the actual models and mailer to test
const mongoose = require('mongoose');

async function run() {
  try {
    await mongoose.connect(process.env.MONGO_URI);
    console.log('✅ DB connected');

    // Import the actual models and mailer like the server does
    const { User, AuditLog } = require('./src/models/database');
    const { sendMail } = require('./src/utils/mailer');

    const email = 'ajay.s@raminfo.com';
    const user = await User.findOne({ email, is_active: { $ne: 0 } }).lean();
    console.log('✅ User found:', user ? `${user.name} (${user.role})` : 'NOT FOUND');

    if (!user) {
      await mongoose.disconnect();
      return;
    }

    const crypto = require('crypto');
    const { v4: uuidv4 } = require('uuid');
    const generateToken = () => crypto.randomBytes(32).toString('hex');
    const hashToken = (t) => crypto.createHash('sha256').update(t).digest('hex');

    const rawToken  = generateToken();
    const hashedTok = hashToken(rawToken);
    const expires   = new Date(Date.now() + 30 * 60 * 1000);

    await User.findByIdAndUpdate(user._id, {
      $set: { pwd_reset_token: hashedTok, pwd_reset_expires: expires }
    });
    console.log('✅ Token stored in DB');

    const FRONTEND = process.env.FRONTEND_URL || 'https://ams-frontend-web-niuz.onrender.com';
    const resetUrl = `${FRONTEND}/reset-password?token=${rawToken}`;
    console.log('Reset URL:', resetUrl);

    console.log('📧 Calling sendMail...');
    try {
      const result = await sendMail(
        user.email,
        '[BRP AMS] Reset Your Password',
        `<p>Hi ${user.name}, <a href="${resetUrl}">Reset Password</a></p>`,
        { type: 'PASSWORD_RESET' }
      );
      console.log('✅ sendMail succeeded:', result ? 'has result' : 'no result (ok)');
    } catch (emailErr) {
      console.error('❌ sendMail THREW:', emailErr.message);
      console.error(emailErr.stack);
    }

    console.log('📝 Creating AuditLog...');
    try {
      await AuditLog.create({
        _id: uuidv4(),
        user_id: user._id,
        action: 'FORGOT_PASSWORD',
        ip_address: '127.0.0.1'
      });
      console.log('✅ AuditLog created');
    } catch (auditErr) {
      console.error('❌ AuditLog THREW:', auditErr.message);
      console.error(auditErr.stack);
    }

  } catch (err) {
    console.error('❌ Fatal error:', err.message);
    console.error(err.stack);
  } finally {
    setTimeout(() => mongoose.disconnect().then(() => process.exit(0)), 500);
  }
}

run();
