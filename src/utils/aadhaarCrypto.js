'use strict';
/**
 * aadhaarCrypto.js
 * AES-256-GCM encryption for Aadhaar numbers (UIDAI compliance).
 * Full number is NEVER stored in plaintext — only the AES-256-GCM
 * ciphertext is persisted. Decryption is only for internal audit.
 *
 * Packing format: iv(12 bytes) | authTag(16 bytes) | ciphertext
 * Encoded as base64url to be MongoDB-safe.
 *
 * Key derivation: SHA-256(AADHAAR_ENC_KEY || JWT_SECRET)
 * → 32-byte key suitable for AES-256
 */

const crypto = require('crypto');

const _key = () =>
  crypto
    .createHash('sha256')
    .update(process.env.AADHAAR_ENC_KEY || process.env.JWT_SECRET || 'change-me-in-production')
    .digest(); // 32-byte Buffer

/**
 * encrypt(plaintext) → base64url string
 * Packs: iv(12) | authTag(16) | ciphertext
 */
function encrypt(plaintext) {
  const iv     = crypto.randomBytes(12);   // 96-bit IV — optimal for GCM
  const cipher = crypto.createCipheriv('aes-256-gcm', _key(), iv);
  const enc    = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  const tag    = cipher.getAuthTag();      // 16-byte GCM auth tag
  return Buffer.concat([iv, tag, enc]).toString('base64url');
}

/**
 * decrypt(packed) → plaintext string
 * Reverses the iv(12) | authTag(16) | ciphertext packing.
 */
function decrypt(packed) {
  const buf     = Buffer.from(packed, 'base64url');
  const iv      = buf.slice(0, 12);
  const tag     = buf.slice(12, 28);
  const enc     = buf.slice(28);
  const decipher = crypto.createDecipheriv('aes-256-gcm', _key(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(enc), decipher.final()]).toString('utf8');
}

/**
 * mask(aadhaarNumber) → "XXXX-XXXX-1234"
 * For display/storage in non-sensitive fields.
 */
function mask(aadhaarNumber) {
  const s = String(aadhaarNumber).replace(/\D/g, '');
  return `XXXX-XXXX-${s.slice(-4)}`;
}

module.exports = { encrypt, decrypt, mask };
