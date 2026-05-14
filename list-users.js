/**
 * Lists all users and resets passwords to defaults.
 * Run: node list-users.js
 */
const dns = require('node:dns');
dns.setServers(['8.8.8.8', '1.1.1.1']);
require('dotenv').config();

const mongoose = require('mongoose');
const bcrypt   = require('bcryptjs');

const User = mongoose.model('User', new mongoose.Schema({
  _id: String, emp_id: String, name: String, email: String,
  password_hash: String, role: String,
  is_active: mongoose.Schema.Types.Mixed,
  failed_login_attempts: Number, login_locked_until: Date,
}, { strict: false }));

const PASSWORDS = {
  super_admin: 'SuperAdmin@123',
  admin:       'Admin@123',
  hr:          'Hr@12345',
  manager:     'Manager@123',
  employee:    'Employee@123',
};

async function run() {
  await mongoose.connect(process.env.MONGO_URI);
  console.log('Connected.\n');

  const users = await User.find({}).sort({ role: 1, name: 1 }).lean();

  console.log('══════════════════════════════════════════════════════════');
  console.log('  ALL USERS — CREDENTIALS');
  console.log('══════════════════════════════════════════════════════════\n');

  for (const u of users) {
    const pwd = PASSWORDS[u.role] || 'Pass@123';
    await User.updateOne({ _id: u._id }, {
      $set: {
        password_hash:         bcrypt.hashSync(pwd, 12),
        is_active:             1,
        failed_login_attempts: 0,
        login_locked_until:    null,
      }
    });
    console.log(`Role     : ${u.role}`);
    console.log(`Name     : ${u.name}`);
    console.log(`Email    : ${u.email}`);
    console.log(`Emp ID   : ${u.emp_id}`);
    console.log(`Password : ${pwd}`);
    console.log('──────────────────────────────────────────────────────────');
  }

  console.log(`\n✅ All ${users.length} users unlocked & passwords reset.\n`);
  await mongoose.disconnect();
}

run().catch(e => { console.error(e.message); process.exit(1); });
