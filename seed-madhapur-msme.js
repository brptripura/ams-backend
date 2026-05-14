require('dotenv').config();
const mongoose = require('mongoose');
const { v4: uuidv4 } = require('uuid');

const entries = [
  { name: 'Raminfo Limited',  udyam: 'UDYAM-TS-36-0000001' },
  { name: 'ICollab',          udyam: 'UDYAM-TS-36-0000002' },
  { name: 'Jaaga',            udyam: 'UDYAM-TS-36-0000003' },
  { name: 'App Equal',        udyam: 'UDYAM-TS-36-0000004' },
  { name: 'Isprout',          udyam: 'UDYAM-TS-36-0000005' },
];

async function main() {
  await mongoose.connect(process.env.MONGO_URI);
  console.log('✅ Connected to MongoDB\n');

  const col = mongoose.connection.db.collection('msme_masters');

  let inserted = 0, skipped = 0;

  for (const e of entries) {
    const existing = await col.findOne({ udyam_number: e.udyam });
    if (existing) {
      console.log(`⚠️  Skipped (already exists): ${e.name}`);
      skipped++;
      continue;
    }
    await col.insertOne({
      _id:          uuidv4(),
      msme_name:    e.name,
      udyam_number: e.udyam,
      sector:       'Services',
      block_name:   'Madhapur',
      district:     'Hyderabad',
      is_active:    true,
    });
    console.log(`✅ Inserted: ${e.name}`);
    inserted++;
  }

  console.log(`\nDone — Inserted: ${inserted}, Skipped: ${skipped}`);
  await mongoose.disconnect();
}

main().catch(e => { console.error(e); process.exit(1); });
