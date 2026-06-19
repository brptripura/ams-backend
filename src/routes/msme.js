const express = require('express');
const router  = express.Router();
const { v4: uuidv4 } = require('uuid');
const multer  = require('multer');
const { body, validationResult } = require('express-validator');
const { MsmeMaster, User } = require('../models/database');
const { authenticate, authorize } = require('../middleware/auth');

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 100 * 1024 * 1024 } });

const validate = (req, res, next) => {
  const errs = validationResult(req);
  if (!errs.isEmpty()) return res.status(422).json({ success: false, errors: errs.array() });
  next();
};

// ── Static district → blocks mapping ──────────────────────────────────────
const DISTRICT_BLOCKS = {
  'Khowai': [
    'Kalyanpur','Khowai','Mungiakami','Padmabil','Teliamura','Tulashikhar',
    'Khowai Municipal Council','Teliamura Municipal Council',
  ],
  'Unakoti': [
    'Chandipur','Gournagar','Kumarghat','Pecharthal',
    'Kumarghat Municipal Council','Kailasahar Municipal Council',
  ],
  'North Tripura': [
    'Kalacherra','Laljuri','Jubrajnagar','Kadamtala','Dasda','Jampui Hills','Panisagar','Damcherra',
    'Dharmanagar Municipal Council','Panisagar Nagar Panchayat',
  ],
  'Dhalai': [
    'Ambassa','Ganganagar','Salema','Durgachowmuhani','Dumburnagar','Raishyabari','Manu','Chawmanu',
    'Ambassa Municipal Council','Kamalpur Nagar Panchayat',
  ],
  'Sepahijala': [
    'Bishalgarh','Boxanagar','Charilam','Jampuijala','Nalchar','Mohanbhog','Kathalia',
    'Bishalgarh Municipal Council','Melaghar Municipal Council','Sonamura Nagar Panchayat',
  ],
  'Gomati': [
    'Matabari','Tepania','Killa','Kakraban','Amarpur','Ompi','Karbook','Silachhari',
    'Udaipur Municipal Council','Amarpur Nagar Panchayat',
  ],
  'South Tripura': [
    'Hrishyamukh','Rajnagar','Bharat Chandra Nagar','Jolaibari','Bokafa','Satchand','Rupaichari','Poangbari',
    'Belonia Municipal Council','Santirbazar Municipal Council','Sabroom Nagar Panchayat',
  ],
  'West Tripura': [
    'Bamutia','Jirania','Belbari','Lefunga','Mandai','Dukli','Hezamara','Mohanpur','Old Agartala',
    'Mohanpur Municipal Council','Ranirbazar Municipal Council','Jirania Nagar Panchayat',
    'Agartala Municipal Council (North Zone)','Agartala Municipal Council (South Zone)',
    'Agartala Municipal Council (East Zone)','Agartala Municipal Council (Central Zone)',
  ],
  'Hyderabad': ['Madhapur'],
};

// Flat block list with district info
const ALL_BLOCKS = Object.entries(DISTRICT_BLOCKS).flatMap(([district, blocks]) =>
  blocks.map(b => ({ block: b, district }))
);

// NIC code prefix → sector
function nicToSector(activityDetail) {
  try {
    if (!activityDetail || typeof activityDetail !== 'string') return 'Other';
    const parsed = JSON.parse(activityDetail.replace(/&quot;/g, '"'));
    const nic = String(parsed[0]?.NIC5DigitId || '');
    const prefix = parseInt(nic.substring(0, 2), 10);
    if (prefix >= 1  && prefix <= 9)  return 'Agriculture';
    if (prefix >= 10 && prefix <= 33) return 'Manufacturing';
    if (prefix >= 45 && prefix <= 47) return 'Trade';
    if (prefix >= 49 && prefix <= 82) return 'Services';
    return 'Other';
  } catch { return 'Other'; }
}

// Extract block name from address string: "Block:- BlockName, City:- ..."
function extractBlock(address) {
  if (!address || typeof address !== 'string') return null;
  const m = address.match(/Block\s*:-\s*([^,\n]+)/i);
  if (!m) return null;
  let raw = m[1].replace(/\r?\n/g, ' ').replace(/\s+/g, ' ').trim();

  // Normalize to known blocks (case-insensitive best-match)
  const lower = raw.toLowerCase();
  for (const { block } of ALL_BLOCKS) {
    if (block.toLowerCase() === lower) return block;
  }
  // Partial match
  for (const { block } of ALL_BLOCKS) {
    if (lower.includes(block.toLowerCase()) || block.toLowerCase().includes(lower)) return block;
  }
  // AMC variants → proper names
  const amcMap = {
    'amc': 'Agartala Municipal Council (North Zone)',
    'agartala': 'Agartala Municipal Council (North Zone)',
    'north agartala': 'Agartala Municipal Council (North Zone)',
    'south agartala': 'Agartala Municipal Council (South Zone)',
    'east agartala': 'Agartala Municipal Council (East Zone)',
    'mmc': 'Melaghar Municipal Council',
  };
  for (const [key, val] of Object.entries(amcMap)) {
    if (lower.includes(key)) return val;
  }
  return raw; // Return raw if no match
}

// Normalize district name from Excel to our district names
function normalizeDistrict(excelDistrict) {
  const map = {
    'WEST TRIPURA':   'West Tripura',
    'EAST TRIPURA':   'Gomati',
    'SOUTH TRIPURA':  'South Tripura',
    'NORTH TRIPURA':  'North Tripura',
    'DHALAI':         'Dhalai',
    'GOMATI':         'Gomati',
    'KHOWAI':         'Khowai',
    'SEPAHIJALA':     'Sepahijala',
    'UNAKOTI':        'Unakoti',
  };
  return map[(excelDistrict || '').toUpperCase().trim()] || excelDistrict;
}

// ── GET /api/msme/block-list ───────────────────────────────────────────────
router.get('/block-list', authenticate, (req, res) => {
  res.json({ success: true, data: DISTRICT_BLOCKS });
});

// ── GET /api/msme/debug (NO AUTH — temp diagnostic) ───────────────────────
router.get('/debug', async (req, res) => {
  try {
    const mongoose = require('mongoose');
    const conn     = mongoose.connection;
    const dbHost   = conn.host || 'unknown';
    const dbName   = conn.name || 'unknown';

    const total   = await MsmeMaster.countDocuments();
    const active  = await MsmeMaster.countDocuments({ is_active: true });
    const hyd     = await MsmeMaster.countDocuments({ district: 'Hyderabad', is_active: true });
    const samples = await MsmeMaster.find({ district: 'Hyderabad', is_active: true })
      .select('msme_name block_name district').lean();
    res.json({
      success: true,
      db_host: dbHost,
      db_name: dbName,
      db_total: total,
      db_active: active,
      hyderabad_count: hyd,
      hyderabad_msmes: samples,
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ── GET /api/msme/by-block?block=Ambassa ──────────────────────────────────
// Lightweight endpoint used by ActivityCapture dropdown.
// Returns only name + udyam + address for a single block — fast for mobile.
router.get('/by-block', authenticate, async (req, res) => {
  try {
    const { block } = req.query;
    if (!block) return res.json({ success: true, data: [] });

    const isEmployee = req.user.role === 'employee';
    const isManager  = req.user.role === 'manager';
    if (isEmployee || isManager) {
      const userDoc = await User.findById(req.user.id)
        .select('assigned_block assigned_district').lean();
      let empDistrict = userDoc?.assigned_district;
      if (!empDistrict && userDoc?.assigned_block) {
        for (const [dist, blocks] of Object.entries(DISTRICT_BLOCKS)) {
          if (blocks.includes(userDoc.assigned_block)) { empDistrict = dist; break; }
        }
      }
      if (empDistrict) {
        const allowed = DISTRICT_BLOCKS[empDistrict] || [];
        if (allowed.length && !allowed.includes(block)) {
          return res.json({ success: true, data: [] });
        }
      }
    }

    let msmes = await MsmeMaster.find({ block_name: block, is_active: true })
      .select('msme_name udyam_number block_name district address sector')
      .sort({ msme_name: 1 })
      .lean();

    // Fallback: data was imported at district level — infer district from block and query by district
    if (msmes.length === 0) {
      let districtForBlock = null;
      for (const [dist, blocks] of Object.entries(DISTRICT_BLOCKS)) {
        if (blocks.includes(block)) { districtForBlock = dist; break; }
      }
      if (districtForBlock) {
        msmes = await MsmeMaster.find({ district: districtForBlock, is_active: true })
          .select('msme_name udyam_number block_name district address sector')
          .sort({ msme_name: 1 })
          .lean();
      }
    }

    res.json({ success: true, data: msmes, total: msmes.length });
  } catch (err) {
    console.error('[GET /msme/by-block]', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ── GET /api/msme ──────────────────────────────────────────────────────────
router.get('/', authenticate, async (req, res) => {
  try {
    const { block, district, sector, search } = req.query;
    const filter = { is_active: true };

    const isEmployee = req.user.role === 'employee';
    const isManager  = req.user.role === 'manager';

    if (isEmployee || isManager) {
      const userDoc = await User.findById(req.user.id)
        .select('assigned_block assigned_district').lean();
      let empDistrict = userDoc?.assigned_district;
      if (!empDistrict && userDoc?.assigned_block) {
        for (const [dist, blocks] of Object.entries(DISTRICT_BLOCKS)) {
          if (blocks.includes(userDoc.assigned_block)) { empDistrict = dist; break; }
        }
      }
      if (empDistrict) filter.district = empDistrict;
    } else {
      if (block)    filter.block_name = block;
      if (district) filter.district   = district;
    }

    if (sector) filter.sector = sector;
    if (search) filter.msme_name = { $regex: search.trim(), $options: 'i' };

    const msmes = await MsmeMaster.find(filter)
      .select('msme_name udyam_number block_name district sector address owner_name contact')
      .sort({ msme_name: 1 })
      .limit(5000)
      .lean();

    res.json({ success: true, data: msmes, total: msmes.length });
  } catch (err) {
    console.error('[GET /msme]', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ── GET /api/msme/blocks ───────────────────────────────────────────────────
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

// ── POST /api/msme/bulk-upload ─────────────────────────────────────────────
// Accepts the XLS/HTML file exported from Udyam portal
// UPDATED: Now prioritizes the BLOCK column if present, falls back to address extraction
router.post('/bulk-upload', authenticate, authorize('admin', 'super_admin'), upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ success: false, message: 'No file uploaded' });

  try {
    const ExcelJS = require('exceljs');
    const html = req.file.buffer.toString('latin1');

    // Detect if it's the HTML frameset (not actual data) vs a proper XLS/XLSX
    if (html.includes('frameset') || html.includes('shLink')) {
      return res.status(400).json({
        success: false,
        message: 'Please upload the actual sheet file (sheet001.htm) from inside the Excel folder, not the main .xls frameset file. Or save the Excel as .xlsx format first.',
        hint: 'Open the .xls in Excel → Save As → Excel Workbook (.xlsx), then upload that file.'
      });
    }

    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(req.file.buffer);

    // ── Collect records from ALL sheets ──────────────────────────────────────
    // Your Excel has one sheet per district (DHALAI, GOMATI, KHOWAI, etc.)
    // We iterate every sheet so all ~53k records are imported, not just sheet 1.
    const allRecords = []; // { udyam, name, address, distRaw, activity, lat, lng, blockFromExcel }

    for (const ws of wb.worksheets) {
      const data = [];
      ws.eachRow(row => {
        data.push(row.values.slice(1).map(v => (v instanceof Date ? v.toISOString().split('T')[0] : (v != null ? String(v).trim() : ''))));
      });

      // Detect column positions from the header row of this sheet
      let headerIdx = 0;
      let colMap = {};
      for (let i = 0; i < Math.min(5, data.length); i++) {
        const row = data[i].map(c => String(c).trim().toLowerCase());
        if (row.includes('udyogaadharno') || row.includes('enterprisename') || row.includes('enterprise_name')) {
          headerIdx = i;
          row.forEach((h, idx) => {
            if (h.includes('udyog') || h.includes('udyam'))                          colMap.udyam     = idx;
            if (h.includes('enterprise') || (h.includes('name') && !h.includes('district'))) colMap.name = idx;
            if (h.includes('address'))                                                colMap.address   = idx;
            if (h.includes('district_name') || h === 'district_name' || h === 'district') colMap.district = idx;
            if (h === 'block' || h.includes('block_name') || h.includes('block'))    colMap.block     = idx;
            if (h.includes('activity'))                                               colMap.activity  = idx;
            if (h.includes('latitude'))                                               colMap.lat       = idx;
            if (h.includes('longitude'))                                              colMap.lng       = idx;
          });
          break;
        }
      }

      // If no header detected, fall back: col 0=udyam, 1=name, 2=district, 3=address, 4=block
      if (colMap.udyam == null) {
        colMap = { udyam: 0, name: 1, district: 2, address: 3, block: 4 };
        headerIdx = 0;
      }

      // Use sheet name as district fallback (e.g. sheet "DHALAI" → district "Dhalai")
      const sheetDistrict = normalizeDistrict(sheetName);

      const sheetRows = data.slice(headerIdx + 1).filter(r => r.some(c => c !== ''));
      for (const row of sheetRows) {
        if (!row || !Array.isArray(row)) continue;
        const udyam = String(row[colMap.udyam] ?? '').trim();
        const name  = String(row[colMap.name]  ?? '').trim();
        if (!udyam || !name) continue; // skip blank rows early
        allRecords.push({
          udyam,
          name,
          address:  String(row[colMap.address]  ?? '').replace(/\r?\n/g, ' ').trim(),
          distRaw:  String(row[colMap.district] ?? '').trim() || sheetName,
          activity: String(row[colMap.activity] ?? ''),
          lat:      colMap.lat != null ? parseFloat(row[colMap.lat])  || null : null,
          lng:      colMap.lng != null ? parseFloat(row[colMap.lng])  || null : null,
          blockFromExcel: colMap.block != null ? String(row[colMap.block] ?? '').trim() : null,
          sheetDistrict,
        });
      }
    }

    let inserted = 0, updated = 0, skipped = 0, errors = [];

    const BATCH = 500;
    for (let i = 0; i < allRecords.length; i += BATCH) {
      const batch = allRecords.slice(i, i + BATCH);
      const ops = [];

      for (const { udyam, name, address, distRaw, activity, lat, lng, blockFromExcel, sheetDistrict } of batch) {
        if (!udyam || !name) { skipped++; continue; }
        if (!/^UDYAM-/i.test(udyam)) { skipped++; continue; }

        const safeAddress  = String(address  || '');
        const safeDistRaw  = String(distRaw  || '');
        const safeActivity = String(activity || '');

        // PRIORITY LOGIC FOR BLOCK:
        // 1. Use blockFromExcel if it's provided and not empty
        // 2. Fall back to address extraction
        // 3. Fall back to district name (last resort)
        let block;
        if (blockFromExcel) {
          // Try to match against known blocks
          const lowerBlock = blockFromExcel.toLowerCase();
          const matchedBlock = ALL_BLOCKS.find(b => b.block.toLowerCase() === lowerBlock);
          block = matchedBlock ? matchedBlock.block : blockFromExcel;
        } else {
          // Extract from address if no BLOCK column
          block = extractBlock(safeAddress) || normalizeDistrict(safeDistRaw) || sheetDistrict;
        }

        const district = normalizeDistrict(safeDistRaw) || sheetDistrict;
        const sector   = nicToSector(safeActivity);

        ops.push({
          updateOne: {
            filter: { udyam_number: udyam.toUpperCase() },
            update: { $setOnInsert: { _id: uuidv4() }, $set: { msme_name: name, udyam_number: udyam.toUpperCase(), sector, block_name: block, district, address: address || null, latitude: lat, longitude: lng, is_active: true } },
            upsert: true,
          }
        });
      }

      if (ops.length) {
        const result = await MsmeMaster.bulkWrite(ops, { ordered: false });
        inserted += result.upsertedCount;
        updated  += result.modifiedCount;
      }
    }

    res.json({
      success: true,
      message: `Bulk upload complete`,
      inserted,
      updated,
      skipped,
      total: allRecords.length,
    });
  } catch (err) {
    console.error('[POST /msme/bulk-upload]', err);
    res.status(500).json({ success: false, message: err.message });
  }
});

// ── POST /api/msme/seed ────────────────────────────────────────────────────
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