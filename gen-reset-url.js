/**
 * Generate a reset token and print the URL to test the GET form
 */
const dns = require('node:dns');
dns.setServers(['8.8.8.8', '1.1.1.1']);
require('dotenv').config();
const mongoose = require('mongoose');
const crypto = require('crypto');
const User = mongoose.model('U2', new mongoose.Schema({ _id: String, email: String, name: String, role: String, is_active: mongoose.Schema.Types.Mixed }, { strict: false }), 'users');

mongoose.connect(process.env.MONGO_URI).then(async () => {
  const user = await User.findOne({ email: 'ajay.s@raminfo.com' }).lean();
  const rawToken = crypto.randomBytes(32).toString('hex');
  const hashedTok = crypto.createHash('sha256').update(rawToken).digest('hex');
  const expires = new Date(Date.now() + 30 * 60 * 1000);
  await User.findByIdAndUpdate(user._id, { $set: { pwd_reset_token: hashedTok, pwd_reset_expires: expires } });
  console.log('\n✅ Token generated');
  console.log('Raw token:', rawToken);
  console.log('\nTest URL (local):');
  console.log(`http://localhost:10000/api/auth/reset-password?token=${rawToken}`);
  console.log('\nTest URL (production):');
  console.log(`https://brp-mobile.onrender.com/api/auth/reset-password?token=${rawToken}`);
  await mongoose.disconnect();
});
