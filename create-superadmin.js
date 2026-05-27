const dns = require('node:dns');
dns.setServers(['8.8.8.8', '1.1.1.1']);
require('dotenv').config();

const mongoose = require('mongoose');
const bcrypt   = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');

const User = mongoose.model('User', new mongoose.Schema({
  _id: String, emp_id: String, name: String, email: String,
  password_hash: String, role: String, department: String,
  is_active: mongoose.Schema.Types.Mixed,
  email_verified: Boolean, phone_verified: Boolean,
}, { strict: false }));

async function run() {
  await mongoose.connect(process.env.MONGO_URI);

  // Check if super admin already exists
  const existing = await User.findOne({ role: 'super_admin' }).lean();
  if (existing) {
    console.log('Super admin already exists:', existing.email);
    // Reset password anyway
    await User.updateOne({ _id: existing._id }, {
      $set: {
        password_hash: bcrypt.hashSync('SuperAdmin@123', 12),
        is_active: 1,
        failed_login_attempts: 0,
        login_locked_until: null,
      }
    });
    console.log('✅ Password reset to SuperAdmin@123');
    await mongoose.disconnect();
    return;
  }

  // Create super admin
  await User.create({
    _id:            uuidv4(),
    emp_id:         'SADM001',
    name:           'Super Admin',
    email:          'superadmin@brp.com',
    password_hash:  bcrypt.hashSync('SuperAdmin@123', 12),
    role:           'super_admin',
    department:     'Administration',
    is_active:      1,
    email_verified: true,
    phone_verified: true,
  });

  console.log('\n✅ Super Admin created successfully!\n');
  console.log('  Email    : superadmin@brp.com');
  console.log('  Password : SuperAdmin@123');
  console.log('  Role     : super_admin\n');

  await mongoose.disconnect();
}

run().catch(e => { console.error(e.message); process.exit(1); });
