const express  = require('express');
const router   = express.Router();
const multer   = require('multer');
const path     = require('path');
const XLSX     = require('xlsx');
const PDFDocument = require('pdfkit');
const { uploadFile } = require('../utils/storage');
const { v4: uuidv4 } = require('uuid');
const { ActivitySchedule, ScheduleDocument, User } = require('../models/database');
const { authenticate, authorize } = require('../middleware/auth');

// For completion attachments (memory storage -> Cloudinary)
const uploadAttach = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024, files: 10 },
  fileFilter: (req, file, cb) => {
    const allowed = /jpeg|jpg|png|gif|pdf|doc|docx|xlsx/;
    if (allowed.test(path.extname(file.originalname).toLowerCase())) cb(null, true);
    else cb(new Error('File type not allowed'));
  },
});

// Bulk upload config
const uploadBulk = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024, files: 1 },
  fileFilter: (req, file, cb) => {
    const allowed = /xlsx|xls|csv/;
    if (allowed.test(path.extname(file.originalname).toLowerCase())) cb(null, true);
    else cb(new Error('Only Excel (.xlsx/.xls) or CSV files allowed'));
  }
});

// ── PDF REPORT ───────────────────────────────────────────────────────────
router.get('/report/pdf', authenticate, async (req, res) => {
  try {
    const { filter } = req.query;
    const query = {};

    if (filter === 'monthly') {
      const now = new Date();
      const start = new Date(now.getFullYear(), now.getMonth(), 1);
      const end = new Date(now.getFullYear(), now.getMonth() + 1, 0);
      query.scheduled_date = {
        $gte: start.toISOString().slice(0, 10),
        $lte: end.toISOString().slice(0, 10),
      };
    }

    const activities = await ActivitySchedule.find(query).lean();
    const doc = new PDFDocument({ margin: 30 });

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'attachment; filename=activities.pdf');

    doc.pipe(res);
    doc.fontSize(18).text('Activity Report', { align: 'center' });
    doc.moveDown();

    if (!activities.length) {
      doc.fontSize(12).text('No activities found');
    } else {
      activities.forEach((a, i) => {
        doc.fontSize(12)
          .text(`${i + 1}. ${a.title || '-'}`)
          .text(`Location: ${a.location || '-'}`)
          .text(`Date: ${a.scheduled_date || '-'}`)
          .text(`Status: ${a.status || '-'}`)
          .moveDown();
      });
    }

    doc.end();
  } catch (err) {
    console.error('PDF export error:', err);
    res.status(500).json({ success: false, message: 'PDF export failed' });
  }
});

// ── LIST schedules ───────────────────────────────────────────────────────
router.get('/', authenticate, async (req, res) => {
  try {
    const schedules = await ActivitySchedule.find()
      .sort({ scheduled_date: 1, created_at: -1 })
      .lean();

    const userIds = new Set();
    schedules.forEach(s => {
      if (s.created_by)   userIds.add(s.created_by);
      if (s.assigned_to)  userIds.add(s.assigned_to);
      if (s.assigned_by)  userIds.add(s.assigned_by);
      if (s.manager_id)   userIds.add(s.manager_id);
      if (s.initiated_by) userIds.add(s.initiated_by);
      if (s.completed_by) userIds.add(s.completed_by);
    });

    const users = await User.find({ _id: { $in: [...userIds] } })
      .select('_id name emp_id role')
      .lean();
    const userMap = {};
    users.forEach(u => { userMap[u._id] = { name: u.name, emp_id: u.emp_id, role: u.role }; });

    const completedIds = schedules.filter(s => s.status === 'Completed').map(s => s._id);
    const docs = completedIds.length
      ? await ScheduleDocument.find({ schedule_id: { $in: completedIds } }).lean()
      : [];
    const docsMap = {};
    docs.forEach(d => {
      if (!docsMap[d.schedule_id]) docsMap[d.schedule_id] = [];
      docsMap[d.schedule_id].push(d);
    });

    const rl = (r) => ({ employee:'Employee', manager:'Manager', admin:'Admin', hr:'HR', super_admin:'Super Admin' }[r] || '');
    const result = schedules.map(s => {
      const assignerUser = userMap[s.assigned_by] || userMap[s.created_by];
      return {
        ...s,
        id:                s._id,
        created_by_name:   userMap[s.created_by]?.name   || null,
        assigned_to_name:  s.employee_name || userMap[s.assigned_to]?.name  || null,
        assigned_to_empid: userMap[s.assigned_to]?.emp_id || null,
        assigned_by_name:  s.assigned_by_name || (assignerUser ? `${assignerUser.name} (${rl(assignerUser.role)})` : null),
        assigned_by_empid: assignerUser?.emp_id || null,
        manager_name:      s.manager_name || userMap[s.manager_id]?.name   || null,
        manager_empid:     userMap[s.manager_id]?.emp_id  || null,
        initiated_by_name: userMap[s.initiated_by]?.name || null,
        completed_by_name: userMap[s.completed_by]?.name || null,
        documents:         docsMap[s._id] || [],
      };
    });

    res.json({ success: true, data: result });
  } catch (err) {
    console.error('Schedule fetch error:', err);
    res.status(500).json({ success: false, message: 'Failed to fetch schedules' });
  }
});

// ── CREATE schedule ─────────────────────────────────────────────────────
router.post('/', authenticate, authorize('manager', 'admin', 'hr', 'super_admin'), async (req, res) => {
  try {
    const { title, description, scheduled_date, location, assigned_emp_id, assigned_to: assignedToId, manager_id } = req.body;
    if (!title?.trim())      return res.status(422).json({ success: false, message: 'Title is required' });
    if (!scheduled_date)     return res.status(422).json({ success: false, message: 'Scheduled date is required' });

    let assigned_to = null;
    let employee_name = null;

    if (assigned_emp_id) {
      const emp = await User.findOne({ emp_id: assigned_emp_id }).lean();
      if (!emp) return res.status(404).json({ success: false, message: `Employee ${assigned_emp_id} not found` });
      assigned_to = emp._id;
      employee_name = emp.name;
    } else if (assignedToId) {
      const emp = await User.findById(assignedToId).lean();
      if (!emp) return res.status(404).json({ success: false, message: 'Assigned employee not found' });
      assigned_to = emp._id;
      employee_name = emp.name;
    }

    const creator = await User.findById(req.user.id).select('name role emp_id').lean();
    const roleLabel = { employee:'Employee', manager:'Manager', admin:'Admin', hr:'HR', super_admin:'Super Admin' }[creator?.role] || '';
    const assignedByName = creator ? `${creator.name} (${roleLabel})` : null;

    const schedule = await ActivitySchedule.create({
      _id:              uuidv4(),
      title:            title.trim(),
      description:      description?.trim() || null,
      scheduled_date,
      location:         location?.trim() || null,
      assigned_to,
      employee_name,
      created_by:       req.user.id,
      assigned_by:      req.user.id,
      assigned_by_name: assignedByName,
      manager_id:       manager_id || null,
    });

    res.status(201).json({ success: true, data: schedule });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: err.message });
  }
});

// ── BULK UPLOAD ──────────────────────────────────────────────────────────
router.post('/bulk',
  authenticate,
  authorize('manager', 'admin', 'hr', 'super_admin'),
  uploadBulk.single('file'),
  async (req, res) => {
    if (!req.file)
      return res.status(400).json({ success: false, message: 'No file uploaded' });

    try {
      const workbook = XLSX.read(req.file.buffer, { type: 'buffer' });
      const sheet    = workbook.Sheets[workbook.SheetNames[0]];
      const rows     = XLSX.utils.sheet_to_json(sheet, { defval: '' });

      if (!rows.length)
        return res.status(422).json({ success: false, message: 'Excel file is empty' });

      const errors = [];
      const toInsert = [];

      for (let i = 0; i < rows.length; i++) {
        const row = rows[i];
        const rowNum = i + 2;

        const title = String(row['Title'] || '').trim();
        const description = String(row['Description'] || '').trim() || null;
        const dateRaw = String(row['Scheduled Date'] || '').trim();
        const location = String(row['Location'] || '').trim() || null;
        const manager = String(row['Manager'] || '').trim() || null;
        const assigned_emp_id = String(row['Assigned To (Employee)'] || '').trim() || null;
        const assigned_by = String(row['Assigned By'] || '').trim() || null;

        if (!title) { errors.push(`Row ${rowNum}: Title required`); continue; }
        if (!dateRaw) { errors.push(`Row ${rowNum}: Scheduled Date required`); continue; }
        if (!/^\d{4}-\d{2}-\d{2}$/.test(dateRaw)) { errors.push(`Row ${rowNum}: date must be YYYY-MM-DD`); continue; }

        let assigned_to = null;
        let employee_name = null;

        if (assigned_emp_id) {
          const emp = await User.findOne({ emp_id: assigned_emp_id }).lean();
          if (!emp) { errors.push(`Row ${rowNum}: employee not found`); continue; }
          assigned_to = emp._id;
          employee_name = emp.name;
        }

        toInsert.push({
          _id: uuidv4(),
          title,
          description,
          scheduled_date: dateRaw,
          location,
          assigned_to,
          employee_name,
          manager_name: manager || req.user.name,
          assigned_by: assigned_by || req.user.name,
          created_by: req.user.id
        });
      }

      let inserted = [];
      if (toInsert.length) {
        inserted = await ActivitySchedule.insertMany(toInsert);
      }

      res.json({
        success: true,
        inserted: inserted.length,
        skipped: errors.length,
        errors,
        message: `${inserted.length} schedule(s) created`
      });
    } catch (err) {
      console.error(err);
      res.status(500).json({ success: false, message: 'Failed to parse file: ' + err.message });
    }
  }
);

// ── COMPLETE schedule ────────────────────────────────────────────────────
router.put('/:id/complete', authenticate, uploadAttach.array('attachments', 10), async (req, res) => {
  try {
    const schedule = await ActivitySchedule.findById(req.params.id);
    if (!schedule) return res.status(404).json({ success: false, message: 'Schedule not found' });
    if (schedule.status === 'Completed')
      return res.status(409).json({ success: false, message: 'Schedule already completed' });

    const { work_description, remarks } = req.body;

    schedule.status           = 'Completed';
    schedule.completed_by     = req.user.id;
    schedule.completed_at     = new Date();
    schedule.work_description = work_description?.trim() || null;
    schedule.remarks          = remarks?.trim() || null;
    await schedule.save();

    // Save attachments to Cloudinary
    if (req.files?.length) {
      const urls = await Promise.all(
        req.files.map(f => uploadFile(f.buffer, 'ams/schedule-docs', f.originalname, f.mimetype))
      );
      await ScheduleDocument.insertMany(urls.map((url, i) => ({
        _id:         uuidv4(),
        schedule_id: schedule._id,
        file_path:   url,
        file_name:   req.files[i].originalname,
        file_type:   req.files[i].mimetype,
      })));
    }

    const documents = await ScheduleDocument.find({ schedule_id: schedule._id }).lean();

    res.json({
      success: true,
      data: { ...schedule.toObject(), id: schedule._id, documents }
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ── DELETE schedule ──────────────────────────────────────────────────────
router.delete('/:id',
  authenticate,
  authorize('manager', 'admin', 'hr', 'super_admin'),
  async (req, res) => {
    try {
      const schedule = await ActivitySchedule.findById(req.params.id);
      if (!schedule)
        return res.status(404).json({ success: false, message: 'Schedule not found' });

      await ScheduleDocument.deleteMany({ schedule_id: req.params.id });
      await schedule.deleteOne();

      res.json({ success: true, message: 'Schedule deleted' });
    } catch (err) {
      res.status(500).json({ success: false, message: 'Server error' });
    }
  }
);

module.exports = router;
