const express = require('express');
const router  = express.Router();
const { CustomBlock } = require('../models/database');
const { authenticate, authorize } = require('../middleware/auth');
const { purgeNear } = require('./geocode');

// Base list used ONLY for seeding on first run
const BASE_DISTRICT_BLOCKS = {
  'Dhalai':       ['Ambassa','Chawmanu','Durgachowmuhani','Dumburnagar','Ganganagar','Manu','Raishyabari','Salema','Ambassa Municipal Council','Kamalpur Nagar Panchayat'],
  'Gomati':       ['Amarpur','Kakraban','Karbook','Killa','Matabari','Ompi','Silachhari','Tepania','Amarpur Nagar Panchayat','Udaipur Municipal Council'],
  'Hyderabad':    ['Madhapur'],
  'Khowai':       ['Kalyanpur','Khowai','Mungiakami','Padmabil','Teliamura','Tulashikhar','Khowai Municipal Council','Teliamura Municipal Council'],
  'North Tripura':['Damcherra','Dasda','Jampui Hills','Jubrajnagar','Kadamtala','Kalacherra','Laljuri','Panisagar','Dharmanagar Municipal Council','Panisagar Nagar Panchayat'],
  'Sipahijala':   ['Bishalgarh','Boxanagar','Charilam','Jampuijala','Kathalia','Mohanbhog','Nalchar','Bishalgarh Municipal Council','Melaghar Municipal Council','Sonamura Nagar Panchayat'],
  'South Tripura':['Bharat Chandra Nagar','Bokafa','Hrishyamukh','Jolaibari','Poangbari','Rajnagar','Rupaichari','Satchand','Belonia Municipal Council','Sabroom Nagar Panchayat','Santirbazar Municipal Council'],
  'Unakoti':      ['Chandipur','Gournagar','Kumarghat','Pecharthal','Kailasahar Municipal Council','Kumarghat Municipal Council'],
  'West Tripura': ['Bamutia','Belbari','DIC West','Dukli','Hezamara','Jirania','Lefunga','Mandai','Mohanpur','Old Agartala','Agartala Municipal Council (Central Zone)','Agartala Municipal Council (East Zone)','Agartala Municipal Council (North Zone)','Agartala Municipal Council (South Zone)','Jirania Nagar Panchayat','Mohanpur Municipal Council','Ranirbazar Municipal Council'],
};

const seedIfEmpty = async () => {
  const count = await CustomBlock.countDocuments();
  if (count > 0) return;
  const docs = [];
  for (const [district, blocks] of Object.entries(BASE_DISTRICT_BLOCKS)) {
    for (const b of blocks) {
      docs.push({ district, block_name: b, added_by: null });
    }
  }
  await CustomBlock.insertMany(docs, { ordered: false }).catch(() => {});
};

// GET /api/blocks — all blocks from DB (seeded on first call), grouped by district, sorted A-Z
router.get('/', async (req, res) => {
  try {
    await seedIfEmpty();
    const all = await CustomBlock.find({}).lean();
    const result = {};
    for (const b of all) {
      if (!result[b.district]) result[b.district] = [];
      result[b.district].push({
        _id: b._id, name: b.block_name, isCustom: !!b.added_by,
        latitude: b.latitude ?? null, longitude: b.longitude ?? null,
      });
    }
    for (const d of Object.keys(result)) {
      result[d].sort((a, b) => a.name.localeCompare(b.name));
    }
    res.json({ success: true, blocks: result });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// POST /api/blocks — add a new block (admin / super_admin)
router.post('/', authenticate, authorize('admin', 'super_admin'), async (req, res) => {
  try {
    const { district, block_name, latitude, longitude } = req.body;
    if (!district || !block_name?.trim()) {
      return res.status(400).json({ success: false, message: 'district and block_name required' });
    }
    const trimmed = block_name.trim();
    const exists = await CustomBlock.findOne({ district, block_name: trimmed });
    if (exists) return res.status(409).json({ success: false, message: 'Block already exists in this district' });
    const lat = latitude !== undefined && latitude !== '' ? parseFloat(latitude) : null;
    const lng = longitude !== undefined && longitude !== '' ? parseFloat(longitude) : null;
    const block = await CustomBlock.create({
      district, block_name: trimmed, added_by: req.user._id || req.user.id,
      latitude: Number.isFinite(lat) ? lat : null, longitude: Number.isFinite(lng) ? lng : null,
    });
    if (Number.isFinite(lat) && Number.isFinite(lng)) purgeNear(lat, lng).catch(() => {});
    res.status(201).json({ success: true, block: { _id: block._id, name: block.block_name, district: block.district, isCustom: true, latitude: block.latitude, longitude: block.longitude } });
  } catch (err) {
    if (err.code === 11000) return res.status(409).json({ success: false, message: 'Block already exists' });
    res.status(500).json({ success: false, message: err.message });
  }
});

// PUT /api/blocks/rename-district — rename all blocks under a district (must be before /:id)
router.put('/rename-district', authenticate, authorize('admin', 'super_admin'), async (req, res) => {
  try {
    const { oldDistrict, newDistrict } = req.body;
    if (!oldDistrict?.trim() || !newDistrict?.trim()) {
      return res.status(400).json({ success: false, message: 'oldDistrict and newDistrict required' });
    }
    const trimmed = newDistrict.trim();
    const conflict = await CustomBlock.findOne({ district: trimmed });
    if (conflict && conflict.district !== oldDistrict.trim()) {
      return res.status(409).json({ success: false, message: 'A district with that name already exists' });
    }
    const result = await CustomBlock.updateMany({ district: oldDistrict.trim() }, { $set: { district: trimmed } });
    res.json({ success: true, updated: result.modifiedCount });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// PUT /api/blocks/:id — rename a block and/or set its geofence coordinates
router.put('/:id', authenticate, authorize('admin', 'super_admin'), async (req, res) => {
  try {
    const { block_name, latitude, longitude } = req.body;
    const update = {};
    if (block_name !== undefined) {
      if (!block_name.trim()) return res.status(400).json({ success: false, message: 'block_name required' });
      update.block_name = block_name.trim();
    }
    if (latitude !== undefined || longitude !== undefined) {
      const lat = latitude === '' || latitude === null ? null : parseFloat(latitude);
      const lng = longitude === '' || longitude === null ? null : parseFloat(longitude);
      if ((lat !== null && !Number.isFinite(lat)) || (lng !== null && !Number.isFinite(lng))) {
        return res.status(400).json({ success: false, message: 'latitude/longitude must be numbers' });
      }
      update.latitude  = lat;
      update.longitude = lng;
    }
    if (!Object.keys(update).length) return res.status(400).json({ success: false, message: 'Nothing to update' });

    const before = await CustomBlock.findById(req.params.id).select('latitude longitude').lean();
    const block = await CustomBlock.findByIdAndUpdate(req.params.id, { $set: update }, { new: true });
    if (!block) return res.status(404).json({ success: false, message: 'Block not found' });
    // Coordinates changed — purge cached location names near both the old
    // and new point so upcoming check-ins near here re-geocode fresh instead
    // of returning whatever was cached before this correction.
    if ('latitude' in update || 'longitude' in update) {
      if (Number.isFinite(before?.latitude) && Number.isFinite(before?.longitude)) purgeNear(before.latitude, before.longitude).catch(() => {});
      if (Number.isFinite(block.latitude) && Number.isFinite(block.longitude)) purgeNear(block.latitude, block.longitude).catch(() => {});
    }
    res.json({ success: true, block: { _id: block._id, name: block.block_name, district: block.district, isCustom: !!block.added_by, latitude: block.latitude ?? null, longitude: block.longitude ?? null } });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ── Bulk coordinate import ───────────────────────────────────────────────────
// Admin pastes a table (Block Name / District / Lat / Long) copied from a
// spreadsheet. Names in the wild rarely match stored block_name exactly
// ("Pecharthal RD Block" vs stored "Pecharthal"), so matching strips the
// generic "R.D Block"/"Block" suffix but keeps "Municipal Council"/"Nagar
// Panchayat" (those ARE distinct blocks from their base-name counterpart,
// e.g. "Ambassa" vs "Ambassa Municipal Council" are two separate rows).
const normalizeBlockName = s => String(s || '')
  .toLowerCase()
  .replace(/[.,°'"]/g, '')
  .replace(/\br\.?\s*d\.?\s*block\b/g, '')
  .replace(/\bblock\b/g, '')
  .replace(/\s+/g, ' ')
  .trim();

const normalizeDistrict = s => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();

// Tripura's rough bounding box — flags obviously-wrong coordinates (e.g. a
// copy-paste from a different state) without blocking the import outright.
const TRIPURA_BBOX = { latMin: 22.5, latMax: 24.8, lngMin: 90.8, lngMax: 92.6 };

// Pulls the first decimal-degree number out of a messy pasted value —
// handles "23.831°", "23.831 Degree", plain "23.831". Returns null for
// genuinely unparseable input (DMS notation, dates, garbage) rather than
// guessing — those rows must be entered manually via the per-block editor.
const parseCoord = (raw) => {
  if (raw == null) return null;
  const m = String(raw).match(/-?\d+\.\d+/);
  return m ? parseFloat(m[0]) : null;
};

// POST /api/blocks/bulk-coordinates — dryRun:true previews matches without
// writing; dryRun:false (or omitted) commits every row that matched exactly
// one existing block. Unmatched/ambiguous/unparseable/out-of-bounds rows are
// always skipped and reported back, never guessed at.
router.post('/bulk-coordinates', authenticate, authorize('admin', 'super_admin'), async (req, res) => {
  try {
    const { rows, dryRun } = req.body;
    if (!Array.isArray(rows) || !rows.length) {
      return res.status(400).json({ success: false, message: 'rows array required' });
    }

    const allBlocks = await CustomBlock.find({}).lean();

    const results = rows.map(row => {
      const { blockName, district } = row;
      const lat = parseCoord(row.latitude);
      const lng = parseCoord(row.longitude);
      const base = { input: row };

      if (!blockName?.trim()) return { ...base, status: 'error', reason: 'No block name' };
      if (lat === null || lng === null) return { ...base, status: 'error', reason: 'Could not parse latitude/longitude (not plain decimal degrees)' };
      if (lat < TRIPURA_BBOX.latMin || lat > TRIPURA_BBOX.latMax || lng < TRIPURA_BBOX.lngMin || lng > TRIPURA_BBOX.lngMax) {
        return { ...base, status: 'error', reason: `Coordinates (${lat}, ${lng}) are outside Tripura — looks wrong, not imported` };
      }

      const normName = normalizeBlockName(blockName);
      const normDist = normalizeDistrict(district);

      // Prefer a match within the stated district; fall back to a name-only
      // match anywhere (district field in pasted data is often mistyped).
      let candidates = allBlocks.filter(b => normalizeBlockName(b.block_name) === normName && normalizeDistrict(b.district) === normDist);
      let districtMismatch = false;
      if (!candidates.length) {
        candidates = allBlocks.filter(b => normalizeBlockName(b.block_name) === normName);
        districtMismatch = candidates.length > 0;
      }

      if (!candidates.length) return { ...base, status: 'unmatched', reason: 'No existing block matches this name', lat, lng };
      if (candidates.length > 1) return { ...base, status: 'ambiguous', reason: `Matches ${candidates.length} blocks — too ambiguous to auto-import`, lat, lng };

      const match = candidates[0];
      return {
        ...base, status: 'matched', lat, lng,
        blockId: match._id, matchedName: match.block_name, matchedDistrict: match.district,
        districtMismatch,
        alreadySet: match.latitude != null,
        prevLat: match.latitude ?? null, prevLng: match.longitude ?? null,
      };
    });

    if (!dryRun) {
      const toWrite = results.filter(r => r.status === 'matched');
      await Promise.all(toWrite.map(r =>
        CustomBlock.findByIdAndUpdate(r.blockId, { $set: { latitude: r.lat, longitude: r.lng } })
      ));
      // Purge cached location names near each block's old & new coordinates
      // so upcoming check-ins re-geocode fresh instead of returning what
      // was cached before this import.
      for (const r of toWrite) {
        if (Number.isFinite(r.prevLat) && Number.isFinite(r.prevLng)) purgeNear(r.prevLat, r.prevLng).catch(() => {});
        purgeNear(r.lat, r.lng).catch(() => {});
      }
    }

    const summary = {
      total: results.length,
      matched: results.filter(r => r.status === 'matched').length,
      unmatched: results.filter(r => r.status === 'unmatched').length,
      ambiguous: results.filter(r => r.status === 'ambiguous').length,
      error: results.filter(r => r.status === 'error').length,
    };
    res.json({ success: true, dryRun: !!dryRun, summary, results });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// DELETE /api/blocks/:id — remove any block
router.delete('/:id', authenticate, authorize('admin', 'super_admin'), async (req, res) => {
  try {
    const block = await CustomBlock.findByIdAndDelete(req.params.id);
    if (!block) return res.status(404).json({ success: false, message: 'Block not found' });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;
