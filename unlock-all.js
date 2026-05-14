/**
 * Clears login lockouts for ALL users and prints their emails + roles.
 * Run: node unlock-all.js
 */
const dns = require('node:dns');
dns.setServers(['8.8.8.8', '1.1.1.1']);
require('dotenv').config();
const mongoose = require('mongoose');

const User = mongoose.model('User', new mongoose.Schema({
  _id: String, emp_id: String, name: String, email: String,
  role: String, is_active: mongoose.Schema.Types.Mixed,
  failed_login_attempts: Number, login_locked_until: Date,
}, { strict: false }));

async function run() {
  await mongoose.connect(process.env.MONGO_URI);
  console.log('Connected.\n');

  const users = await User.find({}).lean();

  console.log('── All users in DB ───────────────────────────');
  for (const u of users) {
    const locked = u.login_locked_until && new Date(u.login_locked_until) > new Date();
    console.log(`[${u.role}] ${u.email}  is_active=${u.is_active}  ${locked ? '🔒 LOCKED' : '✅ ok'}`);
  }

  // Unlock everyone + activate all
  const r = await User.updateMany({}, {
    $set: { failed_login_attempts: 0, login_locked_until: null, is_active: 1 }
  });

  console.log(`\n✅ Unlocked & activated ${r.modifiedCount} users.`);
  console.log('You can now log in with any account.\n');

  await mongoose.disconnect();
}

run().catch(e => { console.error(e.message); process.exit(1); });
