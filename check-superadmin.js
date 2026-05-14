const dns = require('node:dns');
dns.setServers(['8.8.8.8', '1.1.1.1']);
require('dotenv').config();
const mongoose = require('mongoose');
const bcrypt   = require('bcryptjs');

const userSchema = new mongoose.Schema({
  _id: String, emp_id: String, name: String, email: String,
  password_hash: String, role: String, is_active: mongoose.Schema.Types.Mixed,
  failed_login_attempts: Number, login_locked_until: Date,
}, { strict: false });
const User = mongoose.model('User', userSchema);

async function run() {
  await mongoose.connect(process.env.MONGO_URI);

  // Find super admin
  const sa = await User.findOne({ role: 'super_admin' }).lean();
  if (!sa) { console.log('NO SUPER ADMIN FOUND'); process.exit(1); }

  console.log('\n── Super Admin ───────────────────────────────');
  console.log('email       :', sa.email);
  console.log('is_active   :', sa.is_active);
  console.log('locked_until:', sa.login_locked_until);
  console.log('failed_tries:', sa.failed_login_attempts);

  const testPasswords = ['SuperAdmin@123', 'Pass@123', 'Admin@123'];
  for (const p of testPasswords) {
    const ok = bcrypt.compareSync(p, sa.password_hash);
    console.log(`password "${p}":`, ok ? '✅ MATCH' : '❌ no match');
  }

  // Fix: unlock + reset password to SuperAdmin@123 + set is_active=1
  const newHash = bcrypt.hashSync('SuperAdmin@123', 12);
  await User.updateOne({ _id: sa._id }, {
    $set: {
      is_active: 1,
      password_hash: newHash,
      failed_login_attempts: 0,
      login_locked_until: null,
    }
  });
  console.log('\n✅ Super admin fixed: is_active=1, password=SuperAdmin@123, lockout cleared');

  // Also fix all other users
  const result = await User.updateMany(
    { role: { $ne: 'super_admin' } },
    { $set: { is_active: 1, failed_login_attempts: 0, login_locked_until: null } }
  );
  console.log(`✅ Fixed ${result.modifiedCount} other users (is_active=1, lockout cleared)`);

  await mongoose.disconnect();
}

run().catch(e => { console.error(e.message); process.exit(1); });
