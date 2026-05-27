/**
 * Fix the two users that fail production login
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

const targets = [
  { email: 'ojasjaiiii@gmail.com', pwd: 'Admin@123' },
  { email: 'reddysrr99@gmail.com', pwd: 'Hr@12345' },
];

async function run() {
  await mongoose.connect(process.env.MONGO_URI);
  console.log('Connected\n');

  for (const t of targets) {
    const user = await User.findOne({ email: t.email }).lean();
    if (!user) { console.log(`NOT FOUND: ${t.email}`); continue; }

    console.log(`Found: ${user.name} (${user.role})`);
    console.log(`  email:                  ${user.email}`);
    console.log(`  is_active:              ${JSON.stringify(user.is_active)}  (type: ${typeof user.is_active})`);
    console.log(`  failed_login_attempts:  ${user.failed_login_attempts}`);
    console.log(`  login_locked_until:     ${user.login_locked_until}`);

    // Check if stored password matches what we expect
    const matches = user.password_hash && bcrypt.compareSync(t.pwd, user.password_hash);
    console.log(`  password '${t.pwd}' matches hash: ${matches}`);

    if (!matches) {
      await User.updateOne({ _id: user._id }, {
        $set: {
          password_hash:         bcrypt.hashSync(t.pwd, 12),
          is_active:             1,
          failed_login_attempts: 0,
          login_locked_until:    null,
        }
      });
      console.log(`  ✅ Password RESET to ${t.pwd}`);
    } else {
      await User.updateOne({ _id: user._id }, {
        $set: { is_active: 1, failed_login_attempts: 0, login_locked_until: null }
      });
      console.log(`  ✅ Unlocked (password was already correct)`);
    }
    console.log('');
  }

  await mongoose.disconnect();
  console.log('Done.');
}

run().catch(e => { console.error(e.message); process.exit(1); });
