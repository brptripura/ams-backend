const crypto = require('crypto');
const { PasswordResetToken } = require('../models/database');

const resetTokens = {
  async set(token, userId, ttlMs) {
    const expires_at = new Date(Date.now() + ttlMs);
    await PasswordResetToken.updateOne(
      { _id: token },
      { $set: { user_id: String(userId), expires_at } },
      { upsert: true }
    );
  },

  async get(token) {
    const rec = await PasswordResetToken.findById(token).lean();
    if (!rec) return null;
    if (rec.expires_at < new Date()) { await PasswordResetToken.deleteOne({ _id: token }); return null; }
    return { userId: rec.user_id };
  },

  async delete(token) {
    await PasswordResetToken.deleteOne({ _id: token });
  },
};

module.exports = resetTokens;
