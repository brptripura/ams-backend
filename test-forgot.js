/**
 * Test forgot-password endpoint end-to-end
 * Run: node test-forgot.js
 */
const dns = require('node:dns');
dns.setServers(['8.8.8.8', '1.1.1.1']);
require('dotenv').config();

const http = require('http');

function post(path, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request({
      hostname: 'localhost',
      port: 10000,
      path,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data),
      }
    }, res => {
      let raw = '';
      res.on('data', c => raw += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(raw) }); }
        catch { resolve({ status: res.statusCode, body: raw }); }
      });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

async function run() {
  console.log('\n══════ LOGIN TESTS ══════\n');

  const logins = [
    { email: 'ajay.s@raminfo.com',          password: 'SuperAdmin@123', role: 'super_admin' },
    { email: 'ojasjaiiii@gmail.com',         password: 'Admin@123',      role: 'admin' },
    { email: 'tripurabrp@gmail.com',         password: 'Admin@123',      role: 'admin' },
    { email: 'reddysrr99@gmail.com',         password: 'Hr@12345',       role: 'hr' },
    { email: 'cs@raminfo.com',               password: 'Hr@12345',       role: 'hr' },
    { email: 'chandrashekarj@raminfo.com',   password: 'Manager@123',    role: 'manager' },
    { email: 'kondanna@raminfo.com',         password: 'Employee@123',   role: 'employee' },
    { email: 'brptripura@gmail.com',         password: 'Employee@123',   role: 'employee' },
  ];

  for (const u of logins) {
    const r = await post('/api/auth/login', { email: u.email, password: u.password });
    const ok = r.status === 200 && r.body.success;
    console.log(`${ok ? '✅' : '❌'} [${u.role.padEnd(11)}] ${u.email} → ${ok ? 'LOGGED IN' : `FAILED: ${r.body.message}`}`);
  }

  console.log('\n══════ FORGOT PASSWORD TESTS ══════\n');

  const forgotEmails = [
    'ajay.s@raminfo.com',
    'kondanna@raminfo.com',
    'reddysrr99@gmail.com',
  ];

  for (const email of forgotEmails) {
    const r = await post('/api/auth/forgot-password', { email });
    console.log(`${r.status === 200 ? '✅' : '❌'} forgot-password → ${email}: status=${r.status} → ${JSON.stringify(r.body)}`);
  }

  console.log('\nDone.');
}

run().catch(e => { console.error('Fatal:', e.message); process.exit(1); });
