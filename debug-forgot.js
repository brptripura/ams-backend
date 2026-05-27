const dns = require('node:dns');
dns.setServers(['8.8.8.8','1.1.1.1']);
require('dotenv').config();

const mongoose = require('mongoose');
const crypto = require('crypto');

async function test() {
  await mongoose.connect(process.env.MONGO_URI);
  const User = mongoose.model('UserDebug', new mongoose.Schema({}, { strict: false }), 'users');

  const email = 'ajay.s@raminfo.com';
  const user = await User.findOne({ email, is_active: { $ne: 0 } }).lean();
  console.log('User found:', user ? user.name + ' (' + user.role + ')' : 'NOT FOUND');

  if (!user) { await mongoose.disconnect(); return; }

  const generateToken = () => crypto.randomBytes(32).toString('hex');
  const hashToken = (t) => crypto.createHash('sha256').update(t).digest('hex');

  const rawToken = generateToken();
  const hashedTok = hashToken(rawToken);
  const expires = new Date(Date.now() + 30 * 60 * 1000);

  await User.findByIdAndUpdate(user._id, {
    $set: { pwd_reset_token: hashedTok, pwd_reset_expires: expires }
  });
  console.log('Token stored OK');

  // Test the gmail relay
  const GMAIL_RELAY_URL = process.env.GMAIL_RELAY_URL;
  console.log('GMAIL_RELAY_URL set:', !!GMAIL_RELAY_URL);
  const FRONTEND = process.env.FRONTEND_URL || 'https://ams-frontend-web-niuz.onrender.com';
  const resetUrl = FRONTEND + '/reset-password?token=' + rawToken;

  try {
    const res = await fetch(GMAIL_RELAY_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        to: email,
        subject: '[BRP AMS] Reset Your Password',
        html: '<p>Hi ' + user.name + ', click: <a href="' + resetUrl + '">Reset Password</a></p>'
      }),
      redirect: 'follow'
    });
    const text = await res.text();
    console.log('Email relay response:', text);
  } catch (e) {
    console.error('Email relay error:', e.message);
  }

  await mongoose.disconnect();
}

test().catch(e => {
  console.error('FATAL ERROR:', e.message);
  console.error(e.stack);
  process.exit(1);
});
