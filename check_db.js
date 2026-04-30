const mongoose = require('mongoose');
const { ActivitySchedule } = require('./src/models/database');
require('dotenv').config();

async function check() {
  await mongoose.connect(process.env.MONGO_URI);
  const stats = await ActivitySchedule.aggregate([
    { $group: { _id: '$status', count: { $sum: 1 } } }
  ]);
  console.log('Status Counts:', stats);

  const pending = await ActivitySchedule.find({ status: 'Pending' }).lean();
  console.log('Pending Examples:', pending.map(s => ({ title: s.title, assigned_to: s.assigned_to })));
  
  mongoose.disconnect();
}
check();
