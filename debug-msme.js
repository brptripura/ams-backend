require('dotenv').config();
const mongoose = require('mongoose');

async function main() {
  await mongoose.connect(process.env.MONGO_URI);
  console.log('Connected to MongoDB\n');

  const db = mongoose.connection.db;
  const col = db.collection('msme_masters'); // auto-pluralized by Mongoose

  // Total count
  const total = await col.countDocuments();
  console.log('Total MSME documents:', total);

  // Count with is_active: true (boolean)
  const activeTrue = await col.countDocuments({ is_active: true });
  console.log('is_active === true (boolean):', activeTrue);

  // Count with is_active: 1 (number)
  const active1 = await col.countDocuments({ is_active: 1 });
  console.log('is_active === 1 (number):', active1);

  // Count with no is_active field
  const noField = await col.countDocuments({ is_active: { $exists: false } });
  console.log('is_active field missing:', noField);

  // Count with is_active: null
  const activeNull = await col.countDocuments({ is_active: null });
  console.log('is_active === null:', activeNull);

  // Sample 3 docs to see actual shape
  console.log('\nSample documents (first 3):');
  const samples = await col.find({}).limit(3).toArray();
  samples.forEach((s, i) => {
    console.log(`\n[${i+1}] ${s.msme_name}`);
    console.log('    is_active:', s.is_active, '(type:', typeof s.is_active + ')');
    console.log('    district:', s.district, '| block_name:', s.block_name);
  });

  await mongoose.disconnect();
  console.log('\nDone.');
}

main().catch(e => { console.error(e); process.exit(1); });
