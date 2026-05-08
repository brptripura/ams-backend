/**
 * Reads MSME List - address.xlsx and bulk-updates the `address` field
 * on every existing msme_masters record (matched by udyam_number).
 */
require('dotenv').config();
const mongoose = require('mongoose');
const XLSX     = require('xlsx');

async function main() {
  await mongoose.connect(process.env.MONGO_URI);
  console.log('✅ Connected to MongoDB\n');

  const col = mongoose.connection.db.collection('msme_masters');
  const wb  = XLSX.readFile('C:/Users/DELL/Downloads/MSME List - address.xlsx');

  let updated = 0, notFound = 0, noAddr = 0;
  const BATCH = 500;
  let ops = [];

  const flush = async () => {
    if (!ops.length) return;
    const res = await col.bulkWrite(ops, { ordered: false });
    updated  += res.modifiedCount;
    notFound += ops.length - res.modifiedCount;
    ops = [];
  };

  for (const sheetName of wb.SheetNames) {
    const ws   = wb.Sheets[sheetName];
    const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });

    // Detect column indices from header
    const header = rows[0].map(c => String(c).toLowerCase().trim());
    let udyamCol = 0, addrCol = 3;
    header.forEach((h, i) => {
      if (h.includes('udyam') || h.includes('udyog')) udyamCol = i;
      if (h === 'address' || h.includes('address'))  addrCol  = i;
    });

    for (const row of rows.slice(1)) {
      const udyam   = String(row[udyamCol] || '').trim().toUpperCase();
      const address = String(row[addrCol]  || '').replace(/\r?\n/g, ' ').trim();

      if (!udyam || !/^UDYAM-/i.test(udyam)) continue;
      if (!address) { noAddr++; continue; }

      ops.push({
        updateOne: {
          filter: { udyam_number: udyam },
          update: { $set: { address } },
        }
      });

      if (ops.length >= BATCH) await flush();
    }
    console.log(`  Sheet "${sheetName}" processed`);
  }

  await flush(); // remaining

  console.log(`\n✅ Address update complete`);
  console.log(`   Updated  : ${updated}`);
  console.log(`   Not found: ${notFound}`);
  console.log(`   No addr  : ${noAddr}`);

  // Verify a sample
  const sample = await col.findOne({ address: { $ne: null, $exists: true } });
  console.log('\nSample record with address:');
  console.log(' Name   :', sample?.msme_name);
  console.log(' Address:', sample?.address);

  await mongoose.disconnect();
}

main().catch(e => { console.error(e); process.exit(1); });
