const express    = require('express');
const router     = express.Router();
const multer     = require('multer');
const cloudinary = require('cloudinary').v2;
const { authenticate: protect } = require('../middleware/auth');
const { User, MonthlyReport } = require('../models/database');
const { employeeFolderPath } = require('../config/cloudinary');
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key:    process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype !== 'application/pdf') {
      const err = new Error('Only PDF files are accepted');
      err.status = 400;
      return cb(err);
    }
    cb(null, true);
  },
});

const uploadToCloudinary = (buffer, options) =>
  new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(options, (err, result) => err ? reject(err) : resolve(result));
    stream.end(buffer);
  });

const currentMonthKey = () => {
  const n = new Date();
  return `${n.getFullYear()}-${String(n.getMonth() + 1).padStart(2, '0')}`;
};

// Simple, safe folder label built straight from the user — no external helper needed.
// const safeSegment = (v) => String(v || '').trim().replace(/[^a-zA-Z0-9_-]/g, '_');
// const employeeFolder = (userId, empId) => safeSegment(empId) || safeSegment(userId);

// ── GET /api/monthly-report — full history, own or (role-gated) another user's ──
router.get('/', protect, async (req, res) => {
  try {
    const { user_id } = req.query;
    let targetUserId = req.user.id;

    if (user_id && user_id !== req.user.id) {
      // Only manager/hr/admin/super_admin may view someone else's reports —
      // and they are always viewing an EMPLOYEE's uploads (view-only, they never upload their own).
      if (req.user.role === 'employee') {
        return res.status(403).json({ success: false, message: 'Forbidden' });
      }
      if (req.user.role === 'manager') {
        const member = await User.findOne({ _id: user_id, manager_id: req.user.id });
        if (!member) return res.status(403).json({ success: false, message: 'Not your team member' });
      }
      targetUserId = user_id;
    }

    // No limit, no cap — full history, every month, every year.
    const reports = await MonthlyReport.find({ user_id: targetUserId }).sort({ month_key: -1 });
    res.json({ success: true, data: reports });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});


// ── POST /api/monthly-report/upload — EMPLOYEES ONLY ─────────────────────
router.post('/upload', protect, upload.single('file'), async (req, res) => {
  try {
    if (req.user.role !== 'employee') {
      return res.status(403).json({ success: false, message: 'Only employees can upload monthly reports' });
    }

    const { month_key } = req.body;
    if (!month_key) return res.status(400).json({ success: false, message: 'month_key required' });
    if (!/^\d{4}-\d{2}$/.test(month_key)) {
      return res.status(400).json({ success: false, message: 'Invalid month_key — expected YYYY-MM' });
    }
    if (!req.file) return res.status(400).json({ success: false, message: 'No file uploaded' });

    // Employees upload only for the current month (no backdating)
    if (month_key !== currentMonthKey()) {
      return res.status(403).json({ success: false, message: 'You can only upload the current month\'s report' });
    }

    const existing = await MonthlyReport.findOne({ user_id: req.user.id, month_key });
    if (existing) return res.status(409).json({ success: false, message: 'Already uploaded for this month' });

    const isImage = req.file.mimetype.startsWith('image/');
    const isPdf   = req.file.mimetype === 'application/pdf';

    const currentUser = await User.findById(req.user.id).select('emp_id name').lean();
    const folderPath  = employeeFolderPath(currentUser?.emp_id, req.user.id);
    const _empName    = (currentUser?.name || req.user.name || 'unknown').replace(/\s+/g,'_').replace(/[^a-zA-Z0-9_-]/g,'');
    const _empId      = String(currentUser?.emp_id || req.user.id).replace(/[^a-zA-Z0-9_-]/g,'');

    const result = await uploadToCloudinary(req.file.buffer, {
      folder:          `${folderPath}/monthly_reports`,
      resource_type:   (isImage || isPdf) ? 'image' : 'raw',
      public_id:       `${_empName}_${_empId}_monthly_report_${month_key}`,
      use_filename:    false,
      unique_filename: false,
    });

    const report = await MonthlyReport.create({
      user_id:     req.user.id,
      month_key,
      file_name:   req.file.originalname,
      file_type:   req.file.mimetype,
      file_url:    result.secure_url,
      public_id:   result.public_id,
      uploaded_at: new Date(),
      expires_at:  null, // never auto-deleted — kept forever
    });

    res.json({ success: true, data: report });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ── DELETE /api/monthly-report/:id — employee's own uploads, CURRENT MONTH ONLY ──
// Mirrors the upload rule: an employee may only touch (upload OR delete) the
// report for the month that is currently active. Older months are locked.
router.delete('/:id', protect, async (req, res) => {
  try {
    if (req.user.role !== 'employee') {
      return res.status(403).json({ success: false, message: 'Only employees can delete their own reports' });
    }
    const report = await MonthlyReport.findOne({ _id: req.params.id, user_id: req.user.id });
    if (!report) return res.status(404).json({ success: false, message: 'Not found' });

    if (report.month_key !== currentMonthKey()) {
      return res.status(403).json({ success: false, message: 'You can only delete the current month\'s report' });
    }

    if (report.public_id) {
      await cloudinary.uploader.destroy(report.public_id, {
        resource_type: report.file_type?.startsWith('image/') ? 'image' : 'raw',
      });
    }
    await report.deleteOne();
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;