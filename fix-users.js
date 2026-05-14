/**
 * One-shot fix: re-activate all users and ensure passwords are set.
 * Run: node fix-users.js
 * Safe to run multiple times (idempotent).
 */

const dns = require('node:dns');
dns.setServers(['8.8.8.8', '1.1.1.1']);
require('dotenv').config();
const mongoose = require('mongoose');
const bcrypt   = require('bcryptjs');

const MONGO_URI = process.env.MONGO_URI;
if (!MONGO_URI) { console.error('MONGO_URI not set'); process.exit(1); }

const userSchema = new mongoose.Schema({
  _id:               String,
  emp_id:            String,
  name:              String,
  email:             String,
  password_hash:     String,
  role:              String,
  is_active:         mongoose.Schema.Types.Mixed,
  failed_login_attempts: Number,
  login_locked_until:    Date,
}, { strict: false });

const User = mongoose.model('User', userSchema);

const DEFAULT_PASS = 'Pass@123';
const HASH         = bcrypt.hashSync(DEFAULT_PASS, 12);

async function run() {
  await mongoose.connect(MONGO_URI);
  console.log('Connected to MongoDB\n');

  const users = await User.find({}).lean();
  console.log(`Found ${users.length} users total\n`);

  let fixed = 0, skipped = 0;

  for (const u of users) {
    const updates = {};
    const reasons = [];

    // 1. Fix is_active — set to 1 (numeric) for everyone
    if (u.is_active !== 1) {
      updates.is_active = 1;
      reasons.push(`is_active: ${JSON.stringify(u.is_active)} → 1`);
    }

    // 2. Clear account lockout
    if (u.failed_login_attempts > 0 || u.login_locked_until) {
      updates.failed_login_attempts = 0;
      updates.login_locked_until    = null;
      reasons.push('cleared lockout');
    }

    // 3. Fix missing password hash (shouldn't happen, but just in case)
    if (!u.password_hash || u.password_hash.trim() === '') {
      updates.password_hash = HASH;
      reasons.push(`set password to ${DEFAULT_PASS}`);
    }

    if (Object.keys(updates).length > 0) {
      await User.updateOne({ _id: u._id }, { $set: updates });
      console.log(`✅ FIXED  [${u.role}] ${u.email} — ${reasons.join(', ')}`);
      fixed++;
    } else {
      console.log(`   OK     [${u.role}] ${u.email}`);
      skipped++;
    }
  }

  console.log(`\n─────────────────────────────`);
  console.log(`Fixed:   ${fixed}`);
  console.log(`Already OK: ${skipped}`);
  console.log(`\nAll active users can now log in.`);
  console.log(`Default password for any user without one: ${DEFAULT_PASS}`);

  await mongoose.disconnect();
}

run().catch(err => { console.error(err); process.exit(1); });
