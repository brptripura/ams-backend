const dns = require('node:dns');
dns.setServers(['8.8.8.8', '8.8.4.4']);

require('dotenv').config();
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const { User, AttendanceRecord, Notification, AuditLog, Activity, ActivityDocument, connectionPromise } = require('./src/models/database');

const seed = async () => {
  await connectionPromise;
  console.log('🌱 Seeding database...');

  const hash = (pw) => bcrypt.hashSync(pw, 10);
  const pw = 'R@m%Brp@26';

  // ── IDs ──────────────────────────────────────────────────────────────
  const superAdminId = uuidv4();
  const adminId      = uuidv4();

  // ── Users ─────────────────────────────────────────────────────────────
  await User.insertMany([
    // Super Admin
    { _id: superAdminId, emp_id: 'SADM001', name: 'Super Admin', email: 'ajay.s@raminfo.com', password_hash: hash(pw), role: 'super_admin', department: 'Head Office Operations', manager_id: null, phone: '9000000001' },

    // Admin
    { _id: adminId, emp_id: 'ADM001', name: 'Admin User', email: 'ajay.rges@gmail.com', password_hash: hash(pw), role: 'admin', department: 'Head Office Operations', manager_id: null, phone: '9000000002' },
  ]);


  console.log('✅ Database seeded successfully!');
  console.log('\n📋 Login Credentials (all passwords: R@m%Brp@26)');
  console.log('─────────────────────────────────────────────────');
  console.log('  Super Admin: ajay.s@raminfo.com  (SADM001)');
  console.log('  Admin:        ajay.rges@gmail.com      (ADM001)');

  console.log('─────────────────────────────────────────────────');
};

seed().catch(err => { console.error(err); process.exit(1); });
