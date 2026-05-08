/**
 * Clears ALL existing MSME data and reimports from the new Excel.
 * New format: UdyogAadharNo | EnterpriseName | DISTRICT_NAME
 */
require('dotenv').config();
const mongoose = require('mongoose');
const XLSX     = require('xlsx');
const { v4: uuidv4 } = require('uuid');

const DISTRICT_MAP = {
  'WEST TRIPURA':  'West Tripura',
  'EAST TRIPURA':  'Gomati',
  'SOUTH TRIPURA': 'South Tripura',
  'NORTH TRIPURA': 'North Tripura',
  'DHALAI':        'Dhalai',
  'GOMATI':        'Gomati',
  'KHOWAI':        'Khowai',
  'SEPAHIJALA':    'Sepahijala',
  'UNAKOTI':       'Unakoti',
};

function normalizeDistrict(raw) {
  return DISTRICT_MAP[(raw || '').toUpperCase().trim()] || raw;
}

async function main() {
  await mongoose.connect(process.env.MONGO_URI);
  console.log('✅ Connected to MongoDB\n');

  const col = mongoose.connection.db.collection('msme_masters');

  // ── Step 1: Delete all existing MSME records ──────────────────────────
  const { deletedCount } = await col.deleteMany({});
  console.log(`🗑️  Deleted ${deletedCount} existing MSME records\n`);

  // ── Step 2: Read Excel ────────────────────────────────────────────────
  const wb   = XLSX.readFile('C:/Users/DELL/Downloads/MSME List - Copy.xlsx');
  const docs = [];
  let skipped = 0;

  for (const sheetName of wb.SheetNames) {
    const ws   = wb.Sheets[sheetName];
    const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });

    // Find header row
    let headerIdx = 0;
    let udyamCol = 0, nameCol = 1, distCol = 2;
    for (let i = 0; i < Math.min(3, rows.length); i++) {
      const h = rows[i].map(c => String(c).toLowerCase().trim());
      if (h.some(x => x.includes('udyam') || x.includes('udyog'))) {
        headerIdx = i;
        h.forEach((x, idx) => {
          if (x.includes('udyam') || x.includes('udyog')) udyamCol = idx;
          // 'district_name' also contains 'name' — only use 'name' if 'district' is NOT in the header
          if (x.includes('enterprise') || (x.includes('name') && !x.includes('district'))) nameCol = idx;
          if (x.includes('district'))                           distCol  = idx;
        });
        break;
      }
    }

    for (const row of rows.slice(headerIdx + 1)) {
      const udyam    = String(row[udyamCol] || '').trim().toUpperCase();
      const name     = String(row[nameCol]  || '').trim();
      const distRaw  = String(row[distCol]  || '').trim();

      if (!udyam || !name || !/^UDYAM-/i.test(udyam)) { skipped++; continue; }

      const district = normalizeDistrict(distRaw || sheetName);

      docs.push({
        _id:          uuidv4(),
        msme_name:    name,
        udyam_number: udyam,
        sector:       'Other',
        block_name:   district,   // use district as block_name placeholder
        district:     district,
        is_active:    true,
      });
    }
    console.log(`  Sheet "${sheetName}": ${rows.length - headerIdx - 1} rows processed`);
  }

  // Deduplicate by udyam_number
  const seen = new Set();
  const unique = docs.filter(d => {
    if (seen.has(d.udyam_number)) return false;
    seen.add(d.udyam_number);
    return true;
  });

  // ── Step 3: Insert all ────────────────────────────────────────────────
  if (unique.length > 0) {
    await col.insertMany(unique, { ordered: false });
  }

  console.log(`\n✅ Import complete`);
  console.log(`   Inserted : ${unique.length}`);
  console.log(`   Skipped  : ${skipped}`);
  console.log(`   Total DB : ${await col.countDocuments()}`);

  await mongoose.disconnect();
}

main().catch(e => { console.error(e); process.exit(1); });
