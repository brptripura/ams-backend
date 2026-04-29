const express = require('express');
const router  = express.Router();
const { v4: uuidv4 } = require('uuid');
const { body, query, validationResult } = require('express-validator');
const { MsmeMaster, User } = require('../models/database');
const { authenticate, authorize } = require('../middleware/auth');

const validate = (req, res, next) => {
  const errs = validationResult(req);
  if (!errs.isEmpty()) return res.status(422).json({ success: false, errors: errs.array() });
  next();
};

// ── GET /api/msme ──────────────────────────────────────────────────────────
// Employee: auto-filtered to their assigned_block
// HR/Admin/Super Admin: can filter by block, district, sector
router.get('/', authenticate, async (req, res) => {
  try {
    const { block, district, sector, search } = req.query;
    const filter = { is_active: true };

    const isEmployee = req.user.role === 'employee';
    const isManager  = req.user.role === 'manager';

    if (isEmployee || isManager) {
      const userDoc = await User.findById(req.user.id).select('assigned_block assigned_district').lean();
      if (!userDoc?.assigned_block) {
        return res.json({ success: true, data: [], message: 'No block assigned to your account. Contact admin.' });
      }
      filter.block_name = userDoc.assigned_block;
    } else {
      if (block)    filter.block_name = block;
      if (district) filter.district   = district;
    }

    if (sector) filter.sector = sector;
    if (search) filter.msme_name = { $regex: search.trim(), $options: 'i' };

    const msmes = await MsmeMaster.find(filter)
      .select('msme_name udyam_number sector block_name district owner_name contact')
      .sort({ msme_name: 1 })
      .limit(200)
      .lean();

    res.json({ success: true, data: msmes, total: msmes.length });
  } catch (err) {
    console.error('[GET /msme]', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ── GET /api/msme/blocks ───────────────────────────────────────────────────
// Returns distinct blocks that have MSMEs (for HR/Admin hierarchy dropdowns)
router.get('/blocks', authenticate, authorize('hr', 'admin', 'super_admin'), async (req, res) => {
  try {
    const { district } = req.query;
    const filter = { is_active: true };
    if (district) filter.district = district;
    const blocks = await MsmeMaster.distinct('block_name', filter);
    res.json({ success: true, data: blocks.sort() });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ── GET /api/msme/districts ────────────────────────────────────────────────
router.get('/districts', authenticate, authorize('hr', 'admin', 'super_admin'), async (req, res) => {
  try {
    const districts = await MsmeMaster.distinct('district', { is_active: true });
    res.json({ success: true, data: districts.sort() });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ── POST /api/msme ─────────────────────────────────────────────────────────
// Admin/Super Admin can add MSMEs to the master list
router.post('/', authenticate, authorize('admin', 'super_admin'), [
  body('msme_name').trim().notEmpty().withMessage('MSME name required'),
  body('udyam_number').matches(/^UDYAM-[A-Z]{2}-\d{2}-\d{7}$/).withMessage('Format: UDYAM-XX-00-0000000'),
  body('sector').isIn(['Manufacturing', 'Services', 'Trade', 'Agriculture', 'Other']),
  body('block_name').trim().notEmpty().withMessage('Block name required'),
  body('district').trim().notEmpty().withMessage('District required'),
], validate, async (req, res) => {
  try {
    const { msme_name, udyam_number, sector, block_name, district, owner_name, contact } = req.body;
    const existing = await MsmeMaster.findOne({ udyam_number });
    if (existing) return res.status(409).json({ success: false, message: 'MSME with this Udyam number already exists' });

    const msme = await MsmeMaster.create({
      _id: uuidv4(), msme_name, udyam_number, sector, block_name, district,
      owner_name: owner_name || null, contact: contact || null,
    });
    res.status(201).json({ success: true, data: msme });
  } catch (err) {
    console.error('[POST /msme]', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ── PUT /api/msme/:id ──────────────────────────────────────────────────────
router.put('/:id', authenticate, authorize('admin', 'super_admin'), async (req, res) => {
  try {
    const { msme_name, sector, block_name, district, owner_name, contact, is_active } = req.body;
    const msme = await MsmeMaster.findByIdAndUpdate(
      req.params.id,
      { $set: { msme_name, sector, block_name, district, owner_name, contact, is_active } },
      { new: true }
    );
    if (!msme) return res.status(404).json({ success: false, message: 'MSME not found' });
    res.json({ success: true, data: msme });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ── POST /api/msme/seed ────────────────────────────────────────────────────
// One-time seed endpoint — super admin only
router.post('/seed', authenticate, authorize('super_admin'), async (req, res) => {
  try {
    const count = await MsmeMaster.countDocuments();
    if (count > 0) return res.json({ success: true, message: `Already seeded (${count} records)` });

    const seedData = require('../data/msme-seed.json');
    const docs = seedData.map(m => ({ _id: uuidv4(), ...m, is_active: true }));
    await MsmeMaster.insertMany(docs, { ordered: false });
    res.json({ success: true, message: `Seeded ${docs.length} MSMEs` });
  } catch (err) {
    console.error('[POST /msme/seed]', err);
    res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;
