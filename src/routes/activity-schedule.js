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

const uploadAttach = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024, files: 10 },
  fileFilter: (req, file, cb) => {
    const allowed = /jpeg|jpg|png|gif|pdf|doc|docx|xlsx/;
    if (allowed.test(path.extname(file.originalname).toLowerCase())) cb(null, true);
    else cb(new Error('File type not allowed'));
  },
});

const uploadBulk = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024, files: 1 },
  fileFilter: (req, file, cb) => {
    const allowed = /xlsx|xls|csv/;
    if (allowed.test(path.extname(file.originalname).toLowerCase())) cb(null, true);
    else cb(new Error('Only Excel (.xlsx/.xls) or CSV files allowed'));
  },
});

const rl = (r) => ({ employee: 'Employee', manager: 'Manager', admin: 'Admin', hr: 'HR', super_admin: 'Super Admin' }[r] || '');

// ── PDF REPORT ───────────────────────────────────────────────────────────
router.get('/report/pdf', authenticate, async (req, res) => {
  try {
    const { filter } = req.query;
    const query = {};

    if (filter === 'monthly') {
      const now = new Date();
      const start = new Date(now.getFullYear(), now.getMonth(), 1);
      const end   = new Date(now.getFullYear(), now.getMonth() + 1, 0);
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

// ── EXPORT Excel ──────────────────────────────────────────────────────────
router.get('/export', authenticate, authorize('manager', 'admin', 'hr', 'super_admin'), async (req, res) => {
  try {
    const { status, date_from, date_to, assigned_to, created_by } = req.query;
    const filter = {};

    if (status)      filter.status     = status;
    if (created_by)  filter.created_by = created_by;
    if (assigned_to) filter.$or = [
      { assigned_to: assigned_to },
      { initiated_by: assigned_to },
      { completed_by: assigned_to },
    ];
    if (date_from || date_to) {
      filter.scheduled_date = {};
      if (date_from) filter.scheduled_date.$gte = date_from;
      if (date_to)   filter.scheduled_date.$lte = date_to;
    }

    const schedules = await ActivitySchedule.find(filter).sort({ scheduled_date: 1, created_at: -1 }).lean();

    const userIds = new Set();
    schedules.forEach(s => {
      [s.created_by, s.assigned_to, s.initiated_by, s.completed_by].forEach(id => { if (id) userIds.add(id); });
    });
    const users = await User.find({ _id: { $in: [...userIds] } }).select('_id name emp_id').lean();
    const userMap = {};
    users.forEach(u => { userMap[u._id] = { name: u.name, emp_id: u.emp_id }; });

    const data = schedules.map(s => ({
      'Title':            s.title,
      'Description':      s.description || '',
      'Status':           s.status,
      'Scheduled Date':   s.scheduled_date,
      'Location':         s.location || '',
      'Assigned To':      userMap[s.assigned_to]?.name   || '',
      'Assigned Emp ID':  userMap[s.assigned_to]?.emp_id || '',
      'Created By':       userMap[s.created_by]?.name    || '',
      'Initiated By':     userMap[s.initiated_by]?.name  || '',
      'Initiated At':     s.initiated_at ? new Date(s.initiated_at).toLocaleString() : '',
      'Completed By':     userMap[s.completed_by]?.name  || '',
      'Completed At':     s.completed_at ? new Date(s.completed_at).toLocaleString() : '',
      'Work Description': s.work_description || '',
      'Remarks':          s.remarks || '',
    }));

    const ws = XLSX.utils.json_to_sheet(data);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Activity Reports');
    ws['!cols'] = [
      { wch: 25 }, { wch: 30 }, { wch: 12 }, { wch: 15 }, { wch: 20 },
      { wch: 20 }, { wch: 15 }, { wch: 20 }, { wch: 20 }, { wch: 22 },
      { wch: 20 }, { wch: 22 }, { wch: 35 }, { wch: 20 },
    ];
    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    res.setHeader('Content-Disposition', `attachment; filename="activity_reports_${Date.now()}.xlsx"`);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.send(buf);
  } catch (err) {
    console.error('GET /activity-schedule/export error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ── EXPORT PDF ────────────────────────────────────────────────────────────
router.get('/export-pdf', authenticate, authorize('manager', 'admin', 'hr', 'super_admin'), async (req, res) => {
  try {
    const { status, date_from, date_to, assigned_to, created_by } = req.query;
    const filter = {};

    if (status)      filter.status     = status;
    if (created_by)  filter.created_by = created_by;
    if (assigned_to) filter.$or = [
      { assigned_to: assigned_to },
      { initiated_by: assigned_to },
      { completed_by: assigned_to },
    ];
    if (date_from || date_to) {
      filter.scheduled_date = {};
      if (date_from) filter.scheduled_date.$gte = date_from;
      if (date_to)   filter.scheduled_date.$lte = date_to;
    }

    const schedules = await ActivitySchedule.find(filter).sort({ scheduled_date: 1, created_at: -1 }).lean();

    const userIds = new Set();
    schedules.forEach(s => {
      [s.created_by, s.assigned_to, s.initiated_by, s.completed_by].forEach(id => { if (id) userIds.add(id); });
    });
    const users = await User.find({ _id: { $in: [...userIds] } }).select('_id name emp_id').lean();
    const userMap = {};
    users.forEach(u => { userMap[u._id] = { name: u.name, emp_id: u.emp_id }; });

    const doc = new PDFDocument({ margin: 30, size: 'A4', layout: 'landscape' });
    res.setHeader('Content-Disposition', `attachment; filename="activity_reports_${Date.now()}.pdf"`);
    res.setHeader('Content-Type', 'application/pdf');
    doc.pipe(res);

    doc.fontSize(16).font('Helvetica-Bold').text('BRP — Activity Schedule Report', { align: 'center' });
    doc.fontSize(10).font('Helvetica').text(`Status Filter: ${status || 'All'} | Generated: ${new Date().toLocaleString()}`, { align: 'center' });
    doc.moveDown(1);

    const colWidths = [120, 80, 80, 80, 100, 120, 150];
    const headers   = ['Title', 'Date', 'Status', 'Assigned To', 'Completed By', 'Completed At', 'Work Desc'];
    let x = 30, y = doc.y;

    doc.fontSize(9).font('Helvetica-Bold');
    headers.forEach((h, i) => { doc.text(h, x, y, { width: colWidths[i], ellipsis: true }); x += colWidths[i]; });
    doc.moveTo(30, y + 15).lineTo(760, y + 15).stroke();
    y += 25;
    doc.font('Helvetica').fontSize(8);

    schedules.forEach(s => {
      if (y > 500) {
        doc.addPage({ layout: 'landscape', margin: 30 });
        y = 30; x = 30;
        doc.fontSize(9).font('Helvetica-Bold');
        headers.forEach((h, i) => { doc.text(h, x, y, { width: colWidths[i], ellipsis: true }); x += colWidths[i]; });
        doc.moveTo(30, y + 15).lineTo(760, y + 15).stroke();
        y += 25;
        doc.font('Helvetica').fontSize(8);
      }
      x = 30;
      [
        s.title, s.scheduled_date, s.status,
        userMap[s.assigned_to]?.name  || 'All',
        userMap[s.completed_by]?.name || '-',
        s.completed_at ? new Date(s.completed_at).toLocaleString() : '-',
        s.work_description || '-',
      ].forEach((v, i) => {
        doc.text(String(v), x, y, { width: colWidths[i] - 5, ellipsis: true });
        x += colWidths[i];
      });
      y += 20;
      doc.moveTo(30, y - 5).lineTo(760, y - 5).strokeColor('#f0f0f0').stroke();
    });

    doc.end();
  } catch (err) {
    console.error('GET /activity-schedule/export-pdf error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ── TEMPLATE download ────────────────────────────────────────────────────
router.get('/template', authenticate, authorize('manager', 'admin', 'hr', 'super_admin'), (req, res) => {
  const ws = XLSX.utils.aoa_to_sheet([
    ['title', 'description', 'scheduled_date', 'location', 'assigned_emp_id'],
    ['Block Visit - Araria', 'Awareness camp for MSMEs', '2025-04-10', 'Araria Block', 'EMP001'],
    ['Training Workshop',    'Loan facilitation training', '2025-04-15', 'District HQ', ''],
  ]);
  ws['!cols'] = [{ wch: 30 }, { wch: 40 }, { wch: 18 }, { wch: 25 }, { wch: 18 }];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Schedules');
  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  res.setHeader('Content-Disposition', 'attachment; filename="schedule_template.xlsx"');
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.send(buf);
});

// ── LIST schedules ────────────────────────────────────────────────────────
router.get('/', authenticate, async (req, res) => {
  try {
    const schedules = await ActivitySchedule.find()
      .sort({ scheduled_date: 1, created_at: -1 })
      .lean();

    const userIds = new Set();
    schedules.forEach(s => {
      [s.created_by, s.assigned_to, s.assigned_by, s.manager_id, s.initiated_by, s.completed_by]
        .forEach(id => { if (id) userIds.add(id); });
    });

    const users = await User.find({ _id: { $in: [...userIds] } })
      .select('_id name emp_id role manager_id')
      .lean();

    const managerIds = new Set();
    users.forEach(u => { if (u.manager_id) managerIds.add(u.manager_id); });
    const missingMgrIds = [...managerIds].filter(id => !userIds.has(id));
    if (missingMgrIds.length) {
      const extraMgrs = await User.find({ _id: { $in: missingMgrIds } }).select('_id name emp_id').lean();
      users.push(...extraMgrs);
    }

    const userMap = {};
    users.forEach(u => { userMap[u._id] = { name: u.name, emp_id: u.emp_id, role: u.role, manager_id: u.manager_id }; });
    users.forEach(u => {
      if (u.manager_id && userMap[u.manager_id]) {
        userMap[u._id].manager_name = userMap[u.manager_id].name;
      }
    });

    const completedIds = schedules.filter(s => s.status === 'Completed').map(s => s._id);
    const docs = completedIds.length
      ? await ScheduleDocument.find({ schedule_id: { $in: completedIds } }).lean()
      : [];
    const docsMap = {};
    docs.forEach(d => {
      if (!docsMap[d.schedule_id]) docsMap[d.schedule_id] = [];
      docsMap[d.schedule_id].push(d);
    });

    const result = schedules.map(s => {
      const assignerUser = userMap[s.assigned_by] || userMap[s.created_by];
      return {
        ...s,
        id:                s._id,
        created_by_name:   userMap[s.created_by]?.name    || null,
        assigned_to_name:  s.employee_name || userMap[s.assigned_to]?.name  || null,
        assigned_to_empid: userMap[s.assigned_to]?.emp_id || null,
        assigned_by_name:  s.assigned_by_name || (assignerUser ? `${assignerUser.name} (${rl(assignerUser.role)})` : null),
        assigned_by_empid: assignerUser?.emp_id || null,
        manager_name:      s.manager_name || userMap[s.assigned_to]?.manager_name || userMap[s.manager_id]?.name || null,
        manager_empid:     userMap[s.manager_id]?.emp_id  || null,
        initiated_by_name: userMap[s.initiated_by]?.name  || null,
        completed_by_name: userMap[s.completed_by]?.name  || null,
        documents:         docsMap[s._id] || [],
      };
    });

    res.json({ success: true, data: result });
  } catch (err) {
    console.error('GET /activity-schedule error:', err);
    res.status(500).json({ success: false, message: 'Failed to fetch schedules' });
  }
});

// ── Employee's completed schedules ────────────────────────────────────────
router.get('/my-completed', authenticate, async (req, res) => {
  try {
    const schedules = await ActivitySchedule.find({ completed_by: req.user.id })
      .sort({ completed_at: -1 })
      .lean();

    const ids  = schedules.map(s => s._id);
    const docs = ids.length
      ? await ScheduleDocument.find({ schedule_id: { $in: ids } }).lean()
      : [];
    const docsMap = {};
    docs.forEach(d => {
      if (!docsMap[d.schedule_id]) docsMap[d.schedule_id] = [];
      docsMap[d.schedule_id].push(d);
    });

    res.json({ success: true, data: schedules.map(s => ({ ...s, documents: docsMap[s._id] || [] })) });
  } catch (err) {
    console.error('GET /my-completed error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ── CREATE schedule ───────────────────────────────────────────────────────
router.post('/', authenticate, authorize('manager', 'admin', 'hr', 'super_admin'), async (req, res) => {
  try {
    const { title, description, scheduled_date, location, assigned_emp_id, assigned_to: assignedToId, manager_id } = req.body;
    if (!title?.trim())  return res.status(422).json({ success: false, message: 'Title is required' });
    if (!scheduled_date) return res.status(422).json({ success: false, message: 'Scheduled date is required' });

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
    const assignedByName = creator ? `${creator.name} (${rl(creator.role)})` : null;

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

// ── BULK UPLOAD ───────────────────────────────────────────────────────────
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

      const getVal = (row, keys) => {
        const lowerRow = Object.keys(row).reduce((acc, key) => { acc[key.toLowerCase()] = row[key]; return acc; }, {});
        for (const k of keys) {
          const v = lowerRow[k.toLowerCase()];
          if (v !== undefined && v !== '') return String(v).trim();
        }
        return '';
      };

      for (let i = 0; i < rows.length; i++) {
        const row    = rows[i];
        const rowNum = i + 2;
        try {
          const title            = getVal(row, ['title', 'Title', 'Activity Name', 'Activity', 'Subject', 'Name']);
          const dateRaw          = getVal(row, ['scheduled_date', 'Scheduled Date', 'date', 'Date', 'Due Date', 'Target Date']);
          const location         = getVal(row, ['location', 'Location', 'Venue', 'Place', 'Address']) || null;
          const description      = getVal(row, ['description', 'Description', 'Notes', 'Details']) || null;
          const assigned_emp_id  = getVal(row, ['assigned_emp_id', 'Assigned To (Employee)', 'emp_id', 'Employee ID', 'Assignee']);

          if (!title)   { errors.push(`Row ${rowNum}: Title required`); continue; }
          if (!dateRaw) { errors.push(`Row ${rowNum}: Scheduled Date required`); continue; }

          let scheduled_date = String(dateRaw).trim().replace(/[/\s]/g, '-');
          if (/^\d{5}$/.test(dateRaw)) {
            const jsDate = XLSX.SSF.parse_date_code(Number(dateRaw));
            scheduled_date = `${jsDate.y}-${String(jsDate.m).padStart(2, '0')}-${String(jsDate.d).padStart(2, '0')}`;
          } else if (/^\d{1,2}-\d{1,2}-\d{4}$/.test(scheduled_date)) {
            const parts = scheduled_date.split('-');
            scheduled_date = `${parts[2]}-${parts[1].padStart(2, '0')}-${parts[0].padStart(2, '0')}`;
          } else if (!/^\d{4}-\d{1,2}-\d{1,2}$/.test(scheduled_date)) {
            const d = new Date(dateRaw);
            if (!isNaN(d.getTime())) scheduled_date = d.toISOString().split('T')[0];
            else { errors.push(`Row ${rowNum}: Invalid date "${dateRaw}" (use YYYY-MM-DD or DD-MM-YYYY)`); continue; }
          }

          let assigned_to = null;
          let employee_name = null;
          if (assigned_emp_id) {
            const emp = await User.findOne({ emp_id: { $regex: new RegExp(`^${assigned_emp_id}$`, 'i') } }).lean();
            if (!emp) errors.push(`Row ${rowNum}: Employee "${assigned_emp_id}" not found — creating unassigned`);
            else { assigned_to = emp._id; employee_name = emp.name; }
          }

          toInsert.push({ _id: uuidv4(), title, description, scheduled_date, location, assigned_to, employee_name, created_by: req.user.id });
        } catch (rowErr) {
          errors.push(`Row ${rowNum}: ${rowErr.message}`);
        }
      }

      let inserted = [];
      if (toInsert.length) inserted = await ActivitySchedule.insertMany(toInsert);

      res.json({
        success:  true,
        inserted: inserted.length,
        skipped:  errors.length,
        errors,
        message:  `${inserted.length} schedule(s) created`,
      });
    } catch (err) {
      console.error(err);
      res.status(500).json({ success: false, message: 'Failed to parse file: ' + err.message });
    }
  }
);

// ── INITIATE schedule ─────────────────────────────────────────────────────
router.put('/:id/initiate', authenticate, async (req, res) => {
  try {
    const schedule = await ActivitySchedule.findById(req.params.id);
    if (!schedule) return res.status(404).json({ success: false, message: 'Schedule not found' });
    if (schedule.status !== 'Pending')
      return res.status(409).json({ success: false, message: 'Schedule is already initiated or completed' });

    const assignedTo      = String(schedule.assigned_to || '').toLowerCase().trim();
    const currentUserId   = String(req.user.id || '').toLowerCase().trim();
    const isUnassigned    = !assignedTo || assignedTo === 'null' || assignedTo === 'undefined';

    if (!isUnassigned && assignedTo !== currentUserId)
      return res.status(403).json({ success: false, message: 'This schedule is assigned to another employee' });

    schedule.status       = 'Initiated';
    schedule.initiated_by = req.user.id;
    schedule.initiated_at = new Date();
    await schedule.save();

    res.json({ success: true, data: { ...schedule.toObject(), id: schedule._id } });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ── COMPLETE schedule ─────────────────────────────────────────────────────
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
    res.json({ success: true, data: { ...schedule.toObject(), id: schedule._id, documents } });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ── DELETE schedule ───────────────────────────────────────────────────────
router.delete('/:id',
  authenticate,
  authorize('manager', 'admin', 'hr', 'super_admin'),
  async (req, res) => {
    try {
      const schedule = await ActivitySchedule.findById(req.params.id);
      if (!schedule) return res.status(404).json({ success: false, message: 'Schedule not found' });
      await ScheduleDocument.deleteMany({ schedule_id: req.params.id });
      await schedule.deleteOne();
      res.json({ success: true, message: 'Schedule deleted' });
    } catch (err) {
      res.status(500).json({ success: false, message: 'Server error' });
    }
  }
);

module.exports = router;
