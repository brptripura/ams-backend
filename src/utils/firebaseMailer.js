/**
 * Firebase-based email delivery.
 *
 * Uses Firebase Auth REST API (HTTPS, port 443) to send emails.
 * This works on Render free-tier where SMTP ports are blocked.
 *
 * IMPORTANT: Firebase only sends emails to users that EXIST in Firebase Auth.
 * Every send function ensures the user exists first (creates if needed).
 *
 * Only requires FIREBASE_API_KEY (web API key from Firebase Console).
 */

const crypto = require('crypto');

const FIREBASE_API_KEY = process.env.FIREBASE_API_KEY;
const FIREBASE_REST    = 'https://identitytoolkit.googleapis.com/v1';

// Shadow password for Firebase-only users (not used for actual auth)
const SHADOW_PWD_PREFIX = 'FbShadow@';
const getShadowPassword = (email) =>
  SHADOW_PWD_PREFIX + crypto.createHash('sha256').update(email + 'brp-ams-salt').digest('hex').slice(0, 20);

if (FIREBASE_API_KEY) {
  console.log('[Firebase Mailer] ✅ FIREBASE_API_KEY configured — email delivery via Firebase Auth REST API');
} else {
  console.warn('[Firebase Mailer] ⚠️  FIREBASE_API_KEY not set — Firebase email delivery disabled');
}

// ── Helper: call Firebase Auth REST API ─────────────────────────────────────
async function firebasePost(endpoint, body) {
  const url = `${FIREBASE_REST}/${endpoint}?key=${FIREBASE_API_KEY}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) {
    const msg = data?.error?.message || `Firebase API error ${res.status}`;
    console.error(`[Firebase] ❌ ${endpoint}:`, msg);
    throw new Error(msg);
  }
  return data;
}

// ── Ensure a Firebase Auth user exists ──────────────────────────────────────
// Firebase ONLY sends emails to registered users. This creates one if needed.
async function ensureFirebaseUser(email, password) {
  const pwd = password || getShadowPassword(email);

  // Step 1: Try to create the user (fastest path for new users)
  try {
    const signUp = await firebasePost('accounts:signUp', {
      email,
      password: pwd,
      returnSecureToken: true,
    });
    console.log(`[Firebase] ✅ Created shadow user: ${email}`);
    return { idToken: signUp.idToken, isNew: true };
  } catch (err) {
    if (err.message !== 'EMAIL_EXISTS') throw err;
  }

  // Step 2: User exists — try signing in with our shadow password
  try {
    const signIn = await firebasePost('accounts:signInWithPassword', {
      email,
      password: pwd,
      returnSecureToken: true,
    });
    return { idToken: signIn.idToken, isNew: false };
  } catch (err) {
    if (err.message === 'INVALID_LOGIN_CREDENTIALS') {
      // User exists with a different password (created manually or with temp password)
      // Try the provided password
      if (password && password !== pwd) {
        try {
          const signIn2 = await firebasePost('accounts:signInWithPassword', {
            email,
            password,
            returnSecureToken: true,
          });
          return { idToken: signIn2.idToken, isNew: false };
        } catch (_) { /* fall through */ }
      }
      console.log(`[Firebase] User exists but password mismatch: ${email} — will use PASSWORD_RESET`);
      return { idToken: null, isNew: false, exists: true };
    }
    throw err;
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
//  PUBLIC API
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Send a password reset email via Firebase.
 * ALWAYS ensures the user exists in Firebase Auth first.
 */
async function sendPasswordResetEmail(email, password) {
  if (!FIREBASE_API_KEY) throw new Error('FIREBASE_API_KEY not configured');

  // Ensure user exists — Firebase silently skips non-existent users
  await ensureFirebaseUser(email, password);

  console.log(`[Firebase] Sending PASSWORD_RESET → ${email}`);
  const result = await firebasePost('accounts:sendOobCode', {
    requestType: 'PASSWORD_RESET',
    email,
  });
  console.log(`[Firebase] ✅ Password reset email queued for ${email}`);
  return result;
}

/**
 * Send an email verification email via Firebase.
 * Creates user if needed, then sends verification.
 */
async function sendVerificationEmail(email, password) {
  if (!FIREBASE_API_KEY) throw new Error('FIREBASE_API_KEY not configured');

  console.log(`[Firebase] Sending VERIFY_EMAIL → ${email}`);
  const authData = await ensureFirebaseUser(email, password);

  if (authData?.idToken) {
    try {
      const result = await firebasePost('accounts:sendOobCode', {
        requestType: 'VERIFY_EMAIL',
        idToken: authData.idToken,
      });
      console.log(`[Firebase] ✅ Verification email sent to ${email}`);
      return result;
    } catch (err) {
      console.log(`[Firebase] VERIFY_EMAIL failed, falling back to PASSWORD_RESET: ${err.message}`);
    }
  }

  // Fallback: send password reset instead (still delivers an email to the user)
  console.log(`[Firebase] Falling back to PASSWORD_RESET for: ${email}`);
  const result = await firebasePost('accounts:sendOobCode', {
    requestType: 'PASSWORD_RESET',
    email,
  });
  console.log(`[Firebase] ✅ Fallback reset email sent to ${email}`);
  return result;
}

/**
 * Create a Firebase Auth user (shadow user for email delivery).
 * Call this when admin creates a new user.
 */
async function createFirebaseUser(email, password) {
  if (!FIREBASE_API_KEY) return null;

  try {
    const result = await firebasePost('accounts:signUp', {
      email,
      password: password || getShadowPassword(email),
      returnSecureToken: true,
    });
    console.log(`[Firebase] ✅ Created user: ${email}`);
    return result;
  } catch (err) {
    if (err.message === 'EMAIL_EXISTS') {
      console.log(`[Firebase] User already exists: ${email}`);
      return null;
    }
    throw err;
  }
}

module.exports = {
  sendPasswordResetEmail,
  sendVerificationEmail,
  createFirebaseUser,
  ensureFirebaseUser,
};