const express = require('express');
const router  = express.Router();
const { v4: uuidv4 } = require('uuid');
const { CustomOption } = require('../models/database');
const { authenticate } = require('../middleware/auth');

// ── GET /api/custom-options?category=xxx ──────────────────────────────────
// Returns all custom option values for the given category (shared across all users)
router.get('/', authenticate, async (req, res) => {
  try {
    const { category } = req.query;
    if (!category) return res.json({ success: true, data: [] });
    const opts = await CustomOption.find({ category })
      .sort({ createdAt: 1 })
      .lean();
    res.json({ success: true, data: opts.map(o => o.value) });
  } catch (err) {
    console.error('[GET /custom-options]', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ── POST /api/custom-options ───────────────────────────────────────────────
// Saves a new custom option value for a given category
router.post('/', authenticate, async (req, res) => {
  try {
    const { category, value } = req.body;
    if (!category || !value || !value.trim()) {
      return res.status(400).json({ success: false, message: 'category and value are required' });
    }
    try {
      await CustomOption.create({
        _id:      uuidv4(),
        category: category.trim(),
        value:    value.trim(),
        added_by: req.user.id || req.user._id,
      });
    } catch (err) {
      // Duplicate key — value already exists for this category, that's fine
      if (err.code !== 11000) throw err;
    }
    res.status(201).json({ success: true });
  } catch (err) {
    console.error('[POST /custom-options]', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

module.exports = router;
