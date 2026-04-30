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

    // 2. Create XLSX
    const data = [
      ['EmpId', 'Name', 'Email', 'Password', 'Role', 'Department', 'Phone', 'Block', 'District'],
      ['TEST001', 'Test User', 'test@example.com', 'Pass@123', 'employee', 'Engineering', '1234567890', 'Block A', 'District 1']
    ];
    const ws = XLSX.utils.aoa_to_sheet(data);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Sheet1');
    const buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });

    // 3. Upload
    console.log('Uploading...');
    const fd = new FormData();
    fd.append('file', buffer, { filename: 'test.xlsx' });
    
    const uploadRes = await axios.post(`${API_BASE}/users/bulk-upload`, fd, {
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
