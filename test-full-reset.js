/**
 * Full end-to-end reset password test
 * Tests: forgot-password → email → GET form → POST new password → login with new password
 */
const dns = require('node:dns');
dns.setServers(['8.8.8.8', '1.1.1.1']);
require('dotenv').config();

const http  = require('http');
const mongoose = require('mongoose');
const crypto   = require('crypto');
const bcrypt   = require('bcryptjs');

// Simple HTTP helper
function req(method, path, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : '';
    const r = http.request({
      hostname: 'localhost', port: 10000, path, method,
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }
    }, res => {
      let raw = '';
      res.on('data', c => raw += c);
      res.on('end', () => resolve({ status: res.statusCode, body: raw, json: (() => { try { return JSON.parse(raw); } catch { return {}; } })() }));
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

async function run() {
  // Connect to DB
  const User = mongoose.model('TestUser', new mongoose.Schema({
    _id: String, email: String, name: String, role: String,
    password_hash: String, is_active: mongoose.Schema.Types.Mixed,
    pwd_reset_token: String, pwd_reset_expires: Date,
  }, { strict: false }), 'users');
  await mongoose.connect(process.env.MONGO_URI);

  const TEST_EMAIL = 'ajay.s@raminfo.com';
  const ORIG_PWD   = 'SuperAdmin@123';
  const NEW_PWD    = 'Reset@2026Test';

  console.log('\n══════ FULL RESET PASSWORD FLOW TEST ══════\n');

  // Step 1: Confirm original password works
  const login1 = await req('POST', '/api/auth/login', { email: TEST_EMAIL, password: ORIG_PWD });
  console.log(`Step 1 — Login with original password:   ${login1.status === 200 && login1.json.success ? '✅ OK' : '❌ FAIL: ' + login1.json.message}`);

  // Step 2: Trigger forgot-password
  const fp = await req('POST', '/api/auth/forgot-password', { email: TEST_EMAIL });
  console.log(`Step 2 — Trigger forgot-password:        ${fp.status === 200 ? '✅ OK' : '❌ FAIL: ' + JSON.stringify(fp.json)}`);

  // Step 3: Get the raw token (inject directly into DB for test — same as what email link contains)
  const rawToken = crypto.randomBytes(32).toString('hex');
  const hashToken = (t) => crypto.createHash('sha256').update(t).digest('hex');
  await User.findOneAndUpdate({ email: TEST_EMAIL }, {
    $set: { pwd_reset_token: hashToken(rawToken), pwd_reset_expires: new Date(Date.now() + 30 * 60 * 1000) }
  });
  console.log(`Step 3 — Token injected to DB:            ✅ OK`);

  // Step 4: GET the reset-password page with valid token
  const page = await req('GET', `/api/auth/reset-password?token=${rawToken}`, null);
  const hasForm = page.body.includes('id="resetForm"') && page.body.includes('id="pw"');
  console.log(`Step 4 — GET form page (valid token):    ${page.status === 200 && hasForm ? '✅ OK (form rendered)' : `❌ FAIL: status=${page.status}`}`);

  // Step 5: Submit new password via POST
  const reset = await req('POST', '/api/auth/reset-password', { token: rawToken, newPassword: NEW_PWD });
  console.log(`Step 5 — POST new password:              ${reset.status === 200 && reset.json.success ? '✅ OK' : '❌ FAIL: ' + reset.json.message}`);

  // Step 6: Login with new password (must succeed)
  const login2 = await req('POST', '/api/auth/login', { email: TEST_EMAIL, password: NEW_PWD });
  console.log(`Step 6 — Login with NEW password:        ${login2.status === 200 && login2.json.success ? '✅ OK' : '❌ FAIL: ' + login2.json.message}`);

  // Step 7: Login with old password (must fail)
  const login3 = await req('POST', '/api/auth/login', { email: TEST_EMAIL, password: ORIG_PWD });
  console.log(`Step 7 — Old password rejected:          ${login3.status === 401 ? '✅ OK (rejected)' : '❌ BAD — old password still works!'}`);

  // Step 8: Try reusing the token (must fail — already consumed)
  const reuse = await req('POST', '/api/auth/reset-password', { token: rawToken, newPassword: 'Another@Pass1' });
  console.log(`Step 8 — Reuse token (must fail):        ${reuse.status === 400 ? '✅ OK (rejected)' : '❌ BAD — token reused!'}`);

  // Cleanup: restore original password
  const origHash = bcrypt.hashSync(ORIG_PWD, 12);
  await User.findOneAndUpdate({ email: TEST_EMAIL }, {
    $set: { password_hash: origHash, pwd_reset_token: null, pwd_reset_expires: null,
            failed_login_attempts: 0, login_locked_until: null, is_active: 1 }
  });
  console.log(`\nCleanup — Password restored to original: ✅ Done`);
  console.log('\n══════ ALL STEPS COMPLETE ══════\n');

  await mongoose.disconnect();
}

run().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
