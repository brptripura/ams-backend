const axios = require('axios');
const XLSX = require('xlsx');
const FormData = require('form-data');

async function test() {
  const API_BASE = 'http://localhost:10000/api';
  
  try {
    // 1. Login
    console.log('Logging in...');
    const loginRes = await axios.post(`${API_BASE}/auth/login`, {
      email: 'superadmin@brp.com',
      password: 'Super@123'
    });
    const token = loginRes.data.token;
    console.log('Login successful');

    // 2. Create XLSX for Schedule
    const data = [
      ['title', 'description', 'scheduled_date', 'location', 'assigned_emp_id'],
      ['Bulk Test 1', 'Test Desc', '2026-05-10', 'Test Loc', '']
    ];
    const ws = XLSX.utils.aoa_to_sheet(data);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Schedules');
    const buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });

    // 3. Upload
    console.log('Uploading Schedule...');
    const fd = new FormData();
    fd.append('file', buffer, { filename: 'schedule_test.xlsx' });
    
    const uploadRes = await axios.post(`${API_BASE}/activity-schedule/bulk`, fd, {
      headers: {
        ...fd.getHeaders(),
        'Authorization': `Bearer ${token}`
      }
    });

    console.log('Upload Result:', JSON.stringify(uploadRes.data, null, 2));

  } catch (err) {
    console.error('Error:', err.response?.data || err.message);
  }
}

test();
