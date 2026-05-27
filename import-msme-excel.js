/**
 * import-msme-excel.js
 * Run: node import-msme-excel.js
 *
 * Reads the multi-sheet MSME List.xlsx and bulk-upserts into MongoDB.
 * Requires MONGO_URI in .env or as env var.
 */

require('dotenv').config();
const mongoose = require('mongoose');
const XLSX     = require('xlsx');
const { v4: uuidv4 } = require('uuid');
const path     = require('path');

const XLSX_FILE = path.resolve('C:/Users/DELL/Downloads/MSME List.xlsx');
const MONGO_URI = process.env.MONGO_URI;
if (!MONGO_URI) { console.error('FATAL: MONGO_URI not set'); process.exit(1); }

// ── Schema (inline, avoids loading full app) ─────────────────────────────────
const msmeMasterSchema = new mongoose.Schema({
  _id:          { type: String },
  msme_name:    { type: String, required: true },
  udyam_number: { type: String, required: true, unique: true },
  sector:       { type: String, default: null },
  block_name:   { type: String, required: true },
  district:     { type: String, required: true },
  address:      { type: String, default: null },
  owner_name:   { type: String, default: null },
  contact:      { type: String, default: null },
  latitude:     { type: Number, default: null },
  longitude:    { type: Number, default: null },
  nic_code:     { type: String, default: null },
  is_active:    { type: Boolean, default: true },
}, { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' } });

const DISTRICT_BLOCKS = {
  'Khowai':       ['Kalyanpur','Khowai','Mungiakami','Padmabil','Teliamura','Tulashikhar','Khowai Municipal Council','Teliamura Municipal Council'],
  'Unakoti':      ['Chandipur','Gournagar','Kumarghat','Pecharthal','Kumarghat Municipal Council','Kailasahar Municipal Council'],
  'North Tripura':['Kalacherra','Laljuri','Jubrajnagar','Kadamtala','Dasda','Jampui Hills','Panisagar','Damcherra','Dharmanagar Municipal Council','Panisagar Nagar Panchayat'],
  'Dhalai':       ['Ambassa','Ganganagar','Salema','Durgachowmuhani','Dumburnagar','Raishyabari','Manu','Chawmanu','Ambassa Municipal Council','Kamalpur Nagar Panchayat'],
  'Sepahijala':   ['Bishalgarh','Boxanagar','Charilam','Jampuijala','Nalchar','Mohanbhog','Kathalia','Bishalgarh Municipal Council','Melaghar Municipal Council','Sonamura Nagar Panchayat'],
  'Gomati':       ['Matabari','Tepania','Killa','Kakraban','Amarpur','Ompi','Karbook','Silachhari','Udaipur Municipal Council','Amarpur Nagar Panchayat'],
  'South Tripura':['Hrishyamukh','Rajnagar','Bharat Chandra Nagar','Jolaibari','Bokafa','Satchand','Rupaichari','Poangbari','Belonia Municipal Council','Santirbazar Municipal Council','Sabroom Nagar Panchayat'],
  'West Tripura': ['Bamutia','Jirania','Belbari','Lefunga','Mandai','Dukli','Hezamara','Mohanpur','Old Agartala','Mohanpur Municipal Council','Ranirbazar Municipal Council','Jirania Nagar Panchayat','Agartala Municipal Council (North Zone)','Agartala Municipal Council (South Zone)','Agartala Municipal Council (East Zone)','Agartala Municipal Council (Central Zone)'],
};

const SHEET_DISTRICT_MAP = {
  'DHALAI':         'Dhalai',
  'GOMATI':         'Gomati',
  'KHOWAI':         'Khowai',
  'NORTH TRIPURA':  'North Tripura',
  'SEPAHIJALA':     'Sepahijala',
  'SOUTH TRIPURA':  'South Tripura',
  'UNAKOTI':        'Unakoti',
  'WEST TRIPURA':   'West Tripura',
};

const ALL_BLOCKS = Object.entries(DISTRICT_BLOCKS).flatMap(([district, blocks]) =>
  blocks.map(b => ({ block: b, district, lower: b.toLowerCase() }))
);

// Extract + normalise block from address string
function extractBlock(address, district) {
  if (!address) return null;
  const m = address.match(/Block\s*:-\s*([^,\n]+)/i);
  if (!m) return null;
  const raw = m[1].replace(/\r?\n/g, ' ').trim();
  const rawL = raw.toLowerCase();

  const districtBlocks = DISTRICT_BLOCKS[district] || [];

  // 1. Exact match within district first
  for (const b of districtBlocks) {
    if (b.toLowerCase() === rawL) return b;
  }
  // 2. Partial match within district
  for (const b of districtBlocks) {
    const coreL = b.toLowerCase().replace(/ municipal council.*/, '').replace(/ nagar panchayat.*/, '');
    if (rawL.includes(coreL) && coreL.length > 3) return b;
    if (coreL.includes(rawL) && rawL.length > 3)  return b;
  }
  // 3. Cross-district exact
  for (const { block } of ALL_BLOCKS) {
    if (block.toLowerCase() === rawL) return block;
  }
  // 4. AMC zone variants
  const amcZone = rawL.includes('north') ? 'North Zone' :
                  rawL.includes('south') ? 'South Zone' :
                  rawL.includes('east')  ? 'East Zone'  :
                  rawL.includes('central') ? 'Central Zone' : null;
  if (amcZone) return `Agartala Municipal Council (${amcZone})`;
  if (rawL.includes('agartala') || rawL.includes(' amc')) return 'Agartala Municipal Council (North Zone)';
  return null; // Skip if can't match
}

function nicToSector(activityDetail) {
  try {
    const json = activityDetail.replace(/&quot;/g, '"');
    const parsed = JSON.parse(json);
    const nic = String(parsed[0]?.NIC5DigitId || '');
    const prefix = parseInt(nic.substring(0, 2), 10);
    if (prefix >= 1  && prefix <= 9)  return 'Agriculture';
    if (prefix >= 10 && prefix <= 33) return 'Manufacturing';
    if (prefix >= 45 && prefix <= 47) return 'Trade';
    if (prefix >= 49 && prefix <= 82) return 'Services';
    return 'Other';
  } catch { return 'Other'; }
}

// Clean address: remove redundant label noise, keep meaningful parts
function cleanAddress(raw) {
  if (!raw) return null;
  return raw
    .replace(/Flat No:-\s*/gi, '')
    .replace(/Building:-\s*/gi, '')
    .replace(/Road\/Street:-\s*/gi, '')
    .replace(/Village\/Town:-\s*/gi, '')
    .replace(/Block:-\s*/gi, 'Block: ')
    .replace(/City:-\s*/gi, '')
    .replace(/,\s*,/g, ',')
    .replace(/^,\s*/, '')
    .replace(/,\s*$/, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

async function run() {
  console.log('Connecting to MongoDB…');
  await mongoose.connect(MONGO_URI, { serverSelectionTimeoutMS: 15000 });
  console.log('Connected.');

  const MsmeMaster = mongoose.model('MsmeMaster', msmeMasterSchema, 'msme_masters');

  console.log(`Reading ${XLSX_FILE}…`);
  const wb = XLSX.readFile(XLSX_FILE);
  console.log(`Sheets: ${wb.SheetNames.join(', ')}`);

  let totalInserted = 0, totalUpdated = 0, totalSkipped = 0;

  for (const sheetName of wb.SheetNames) {
    const district = SHEET_DISTRICT_MAP[sheetName.toUpperCase().trim()];
    if (!district) { console.log(`  Skipping unknown sheet: ${sheetName}`); continue; }

    const ws   = wb.Sheets[sheetName];
    const rows = XLSX.utils.sheet_to_json(ws, { defval: '' });
    console.log(`\n[${sheetName}] district=${district}  rows=${rows.length}`);

    const BATCH = 500;
    let inserted = 0, updated = 0, skipped = 0;

    for (let i = 0; i < rows.length; i += BATCH) {
      const batch = rows.slice(i, i + BATCH);
      const ops   = [];

      for (const row of batch) {
        const udyam    = String(row.UdyogAadharNo || '').trim().toUpperCase();
        const name     = String(row.EnterpriseName || '').trim();
        const rawAddr  = String(row.Address || '').replace(/\r?\n/g, ' ').trim();
        const activity = String(row.ActivityDetail || '');
        const lat      = parseFloat(row.Latitude)  || null;
        const lng      = parseFloat(row.Longitude) || null;

        if (!udyam || !name) { skipped++; continue; }
        if (!/^UDYAM-/i.test(udyam)) { skipped++; continue; }

        const block  = extractBlock(rawAddr, district);
        if (!block) { skipped++; continue; }   // drop rows whose block can't be mapped

        const sector  = nicToSector(activity);
        const address = cleanAddress(rawAddr);
        const nicCode = (() => {
          try {
            const parsed = JSON.parse(activity.replace(/&quot;/g, '"'));
            return String(parsed[0]?.NIC5DigitId || null);
          } catch { return null; }
        })();

        ops.push({
          updateOne: {
            filter: { udyam_number: udyam },
            update: {
              $setOnInsert: { _id: uuidv4() },
              $set: { msme_name: name, udyam_number: udyam, sector, block_name: block, district, address, latitude: lat, longitude: lng, nic_code: nicCode, is_active: true },
            },
            upsert: true,
          },
        });
      }

      if (ops.length) {
        const result = await MsmeMaster.bulkWrite(ops, { ordered: false });
        inserted += result.upsertedCount;
        updated  += result.modifiedCount;
      }
    }

    skipped += rows.length - inserted - updated - skipped;
    console.log(`  inserted=${inserted}  updated=${updated}  skipped=${skipped}`);
    totalInserted += inserted;
    totalUpdated  += updated;
    totalSkipped  += skipped;
  }

  console.log(`\n✅ DONE  total_inserted=${totalInserted}  total_updated=${totalUpdated}  total_skipped=${totalSkipped}`);
  await mongoose.disconnect();
}

run().catch(err => { console.error('FATAL:', err); process.exit(1); });
