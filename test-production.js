/**
 * Full production test against Render backend
 * Run: node test-production.js
 */
const dns = require('node:dns');
dns.setServers(['8.8.8.8', '1.1.1.1']);

const https = require('https');

function post(host, path, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = https.request({
      hostname: host,
      port: 443,
      path,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data),
      },
      timeout: 30000,
    }, res => {
      let raw = '';
      res.on('data', c => raw += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(raw) }); }
        catch { resolve({ status: res.statusCode, body: raw }); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
    req.write(data);
    req.end();
  });
}

const HOST = 'brp-mobile.onrender.com';

async function run() {
  console.log('\n🌐 PRODUCTION TEST — https://' + HOST + '\n');

  console.log('══════ ALL ROLE LOGIN TESTS ══════\n');

  const logins = [
    { email: 'ajay.s@raminfo.com',                password: 'SuperAdmin@123', role: 'super_admin' },
    { email: 'ojasjaiiii@gmail.com',              password: 'Admin@123',      role: 'admin' },
    { email: 'tripurabrp@gmail.com',              password: 'Admin@123',      role: 'admin' },
    { email: 'ajay.rges@gmail.com',               password: 'Admin@123',      role: 'admin' },
    { email: 'jatibo8221@4heats.com',             password: 'Admin@123',      role: 'admin' },
    { email: 'reddysrr99@gmail.com',              password: 'Hr@12345',       role: 'hr' },
    { email: 'cs@raminfo.com',                    password: 'Hr@12345',       role: 'hr' },
    { email: 'chandrashekarj@raminfo.com',        password: 'Manager@123',    role: 'manager' },
    { email: 'yimah25218@pertok.com',             password: 'Manager@123',    role: 'manager' },
    { email: 'knavya136@gmail.com',               password: 'Manager@123',    role: 'manager' },
    { email: 'kondanna@raminfo.com',              password: 'Employee@123',   role: 'employee' },
    { email: 'brptripura@gmail.com',              password: 'Employee@123',   role: 'employee' },
    { email: 'ajaysreeyapureddy14348@gmail.com',  password: 'Employee@123',   role: 'employee' },
    { email: 'rajaus1026@gmail.com',              password: 'Employee@123',   role: 'employee' },
  ];

  let pass = 0, fail = 0;
  for (const u of logins) {
    try {
      const r = await post(HOST, '/api/auth/login', { email: u.email, password: u.password });
      const ok = r.status === 200 && r.body.success;
      if (ok) pass++; else fail++;
      console.log(`${ok ? '✅' : '❌'} [${u.role.padEnd(11)}] ${u.email.padEnd(40)} → ${ok ? 'OK' : `FAIL: ${r.body.message}`}`);
    } catch (e) {
      fail++;
      console.log(`❌ [${u.role.padEnd(11)}] ${u.email.padEnd(40)} → ERROR: ${e.message}`);
    }
  }
  console.log(`\nLogin results: ${pass} passed, ${fail} failed\n`);

  console.log('══════ FORGOT PASSWORD (email delivery) ══════\n');
  const forgotTests = [
    'ajay.s@raminfo.com',
    'chandrashekarj@raminfo.com',
    'kondanna@raminfo.com',
  ];
  for (const email of forgotTests) {
    try {
      const r = await post(HOST, '/api/auth/forgot-password', { email });
      console.log(`${r.status === 200 ? '✅' : '❌'} forgot-password → ${email}: ${r.body.message || JSON.stringify(r.body)}`);
    } catch (e) {
      console.log(`❌ forgot-password → ${email}: ERROR: ${e.message}`);
    }
  }

  console.log('\n══ Done ══');
}

run().catch(e => { console.error('Fatal:', e.message); process.exit(1); });
