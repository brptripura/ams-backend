const axios = require('axios');
const XLSX = require('xlsx');
const FormData = require('form-data');
require('dotenv').config();

async function testApi() {
  const API_BASE = 'http://localhost:10000/api';
  
  try {
    const loginRes = await axios.post(`${API_BASE}/auth/login`, {
      email: 'superadmin@brp.com',
      password: 'Super@123'
    });
    const token = loginRes.data.token;

    const data = [
      ['title', 'description', 'scheduled_date', 'location', 'assigned_emp_id'],
      ['API TEST BULK', 'Testing API', '2026-07-01', 'Remote', '']
    ];
    const ws = XLSX.utils.aoa_to_sheet(data);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Schedules');
    const buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });

    const fd = new FormData();
    fd.append('file', buffer, { filename: 'api_test.xlsx' });
    
    const res = await axios.post(`${API_BASE}/activity-schedule/bulk`, fd, {
      headers: { ...fd.getHeaders(), 'Authorization': `Bearer ${token}` }
    });

    console.log('Result:', {
      success: res.data.success,
      created: res.data.created,
      updated: res.data.updated,
      skipped: res.data.skipped
    });
  } catch (err) {
    console.error('Error:', err.response?.data || err.message);
  }
}
testApi();
