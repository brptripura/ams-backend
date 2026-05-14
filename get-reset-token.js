const dns = require('node:dns');
dns.setServers(['8.8.8.8', '1.1.1.1']);
require('dotenv').config();
const mongoose = require('mongoose');
const User = mongoose.model('U', new mongoose.Schema({ _id: String, email: String, pwd_reset_token: String, pwd_reset_expires: Date }, { strict: false }), 'users');
mongoose.connect(process.env.MONGO_URI).then(async () => {
  const u = await User.findOne({ email: 'ajay.s@raminfo.com' }).lean();
  console.log('stored_hash:', u.pwd_reset_token);
  console.log('expires:', u.pwd_reset_expires);
  await mongoose.disconnect();
});
