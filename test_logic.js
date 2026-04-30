const mongoose = require('mongoose');
const XLSX = require('xlsx');
const { v4: uuidv4 } = require('uuid');
const { ActivitySchedule, User } = require('./src/models/database');
require('dotenv').config();

async function testInternal() {
  await mongoose.connect(process.env.MONGO_URI);
  console.log('Connected to DB');

  // Simulate Excel Buffer
  const data = [
    ['title', 'description', 'scheduled_date', 'location', 'assigned_emp_id'],
    ['Internal Test', 'Testing logic', '2026-06-20', 'Office', '']
  ];
  const ws = XLSX.utils.aoa_to_sheet(data);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Schedules');
  const buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });

  // Mock Request Logic
  try {
    const workbook = XLSX.read(buffer, { type: 'buffer' });
    const sheet    = workbook.Sheets[workbook.SheetNames[0]];
    const rows     = XLSX.utils.sheet_to_json(sheet, { defval: '' });

    console.log('Rows found:', rows.length);

    const errors   = [];
    const toInsert = [];

    const getVal = (row, keys) => {
      for (const k of keys) {
        if (row[k] !== undefined && row[k] !== '') return String(row[k]).trim();
        const lowerRow = Object.keys(row).reduce((acc, key) => { acc[key.toLowerCase()] = row[key]; return acc; }, {});
        for (const variant of keys) {
           const v = lowerRow[variant.toLowerCase()];
           if (v !== undefined && v !== '') return String(v).trim();
        }
      }
      return '';
    };

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const rowNum = i + 2;

      const title = getVal(row, ['title', 'Title', 'Activity Name', 'Header']);
      const dateRaw = getVal(row, ['scheduled_date', 'Scheduled Date', 'date', 'Date']);
      const location = getVal(row, ['location', 'Location', 'Venue']) || null;
      const description = getVal(row, ['description', 'Description', 'Notes']) || null;
      const assigned_emp_id = getVal(row, ['assigned_emp_id', 'Assigned Emp ID', 'emp_id', 'Employee ID', 'Assign To']);

      console.log(`Processing Row ${rowNum}:`, { title, dateRaw });

      if (!title) { errors.push(`Row ${rowNum}: title is required`); continue; }
      if (!dateRaw) { errors.push(`Row ${rowNum}: scheduled_date is required`); continue; }

      let scheduled_date = dateRaw;
      if (/^\d{5}$/.test(dateRaw)) {
        const jsDate = XLSX.SSF.parse_date_code(Number(dateRaw));
        scheduled_date = `${jsDate.y}-${String(jsDate.m).padStart(2, '0')}-${String(jsDate.d).padStart(2, '0')}`;
      } else if (/^\d{2}[-/]\d{2}[-/]\d{4}$/.test(dateRaw)) {
        const parts = dateRaw.split(/[-/]/);
        scheduled_date = `${parts[2]}-${parts[1].padStart(2, '0')}-${parts[0].padStart(2, '0')}`;
      } else if (!/^\d{4}-\d{2}-\d{2}$/.test(dateRaw)) {
        errors.push(`Row ${rowNum}: Invalid date format (use YYYY-MM-DD)`);
        continue;
      }

      toInsert.push({
        _id: uuidv4(),
        title,
        description,
        scheduled_date,
        location,
        assigned_to: null, // Hardcoded for test
        created_by: 'INTERNAL-TEST', 
        status: 'Pending'
      });
    }

    console.log('To Insert:', toInsert.length);
    console.log('Errors:', errors);

    if (toInsert.length) {
      const res = await ActivitySchedule.insertMany(toInsert);
      console.log('Successfully inserted:', res.length);
    }

  } catch (err) {
    console.error('Logic Error:', err);
  } finally {
    mongoose.disconnect();
  }
}

testInternal();
