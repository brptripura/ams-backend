/**
 * Run this script to reset OR create the super admin account.
 * Usage:  node reset-superadmin.js
 */
require('dotenv').config();
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const { User, connectionPromise } = require('./src/models/database');

const EMAIL    = 'superadmin@brp.com';
const PASSWORD = 'SuperAdmin@123';
const EMP_ID   = 'SADM001';
const NAME     = 'Super Admin';

async function run() {
  await connectionPromise;

  const existing = await User.findOne({ email: EMAIL }).lean();

  if (existing) {
    // Reset password only
    await User.findByIdAndUpdate(existing._id, {
      $set: {
        password_hash: bcrypt.hashSync(PASSWORD, 10),
        is_active: 1,
      },
    });
    console.log(`✅ Password reset for existing super admin: ${EMAIL}`);
  } else {
    // Create fresh super admin
    await User.create({
      _id:           uuidv4(),
      emp_id:        EMP_ID,
      name:          NAME,
      email:         EMAIL,
      password_hash: bcrypt.hashSync(PASSWORD, 10),
      role:          'super_admin',
      department:    'Head Office Operations',
      is_active:     1,
    });
    console.log(`✅ Super admin created: ${EMAIL}`);
  }

  console.log('\n🔑 Login credentials:');
  console.log(`   Email    : ${EMAIL}`);
  console.log(`   Password : ${PASSWORD}`);

  process.exit(0);
}

run().catch(err => { console.error(err); process.exit(1); });
