const express = require('express');
const router  = express.Router();
const multer  = require('multer');
const path    = require('path');
const { v4: uuidv4 } = require('uuid');
const { uploadFile } = require('../utils/storage');
const { query, body, validationResult } = require('express-validator');
const ExcelJS = require('exceljs');
const { Activity, ActivityDocument, User, AttendanceRecord } = require('../models/database');
const { authenticate, authorize } = require('../middleware/auth');

const upload = multer({
  storage:    multer.memoryStorage(),
  limits:     { fileSize: 10 * 1024 * 1024, files: 10 },
  fileFilter: (req, file, cb) => {
    const allowed = /jpeg|jpg|png|gif|pdf|doc|docx|xlsx/;
    if (allowed.test(path.extname(file.originalname).toLowerCase())) cb(null, true);
    else cb(new Error('File type not allowed'));
  },
});

const UDYAM_RE = /^UDYAM-[A-Z]{2}-\d{2}-\d{7}$/;

// NOTE: msme_name / block_name stay required because every form screen
// (including the new Office Duty / Field Visit / Training Self ones)
// always synthesizes a msme_name label and a block_name client-side —
// see ActivityCapture.js handleSubmit().
const activityValidators = [
  body('msme_name').trim().notEmpty().withMessage('MSME name required'),
  body('udyam_number').optional({ nullable: true, checkFalsy: true }).matches(UDYAM_RE).withMessage('Format: UDYAM-XX-00-0000000'),
  body('activity_type').optional().trim(),
  body('sub_activity').optional().trim(),
  body('msme_address').optional().trim(),
  body('resolved_solution').optional().trim(),
  body('end_results').optional().trim(),
  // Legacy fields — kept optional for backwards compatibility
  body('sector').optional().trim(),
  body('support_type').optional().trim(),
  body('district').optional().trim(),
  body('block_name').trim().notEmpty().withMessage('Block name required'),
  body('activity_date').isISO8601().toDate(),
  // ── NEW classification fields ──
  body('duty_type').optional({ nullable: true, checkFalsy: true }).isIn(['Office Duty', 'On Duty']).withMessage('Invalid duty type'),
  body('form_type').optional({ nullable: true, checkFalsy: true })
    .isIn(['msme_visit', 'training', 'training_self', 'govt_office', 'office_duty', 'field_visit'])
    .withMessage('Invalid form type'),
  body('tag').optional().trim(),
  body('sub_tag').optional().trim(),
  body('description').optional().trim(),
];

const validate = (req, res, next) => {
  const errs = validationResult(req);
  if (!errs.isEmpty()) return res.status(422).json({ success: false, errors: errs.array() });
  next();
};

const dateRangeFromFilter = (filter, startDate, endDate) => {
  if (startDate && endDate) return { start: startDate, end: endDate };
  // Use IST (Asia/Kolkata) so date boundaries match what employees see on their devices
  const istNow = new Date().toLocaleString('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' });
  // en-CA gives YYYY-MM-DD format directly
  const today = istNow.replace(/\//g, '-');
  const [yyyy, mm] = today.split('-');
  if (filter === 'weekly') {
    const d = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
    d.setDate(d.getDate() - 7);
    const w = d.toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' }).replace(/\//g, '-');
    return { start: w, end: today };
  }
  if (filter === 'biweekly') {
    const d = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
    d.setDate(d.getDate() - 14);
    const w = d.toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' }).replace(/\//g, '-');
    return { start: w, end: today };
  }
  return { start: `${yyyy}-${mm}-01`, end: today };
};

// ── POST /api/activity ─────────────────────────────────────────────────
router.post('/', authenticate, upload.array('documents', 10), activityValidators, validate, async (req, res) => {
  try {
    const {
      msme_name, udyam_number, district, block_name, latitude, longitude, location_address, activity_date,
      activity_type, sub_activity, msme_address, resolved_solution, end_results,
      remarks, sector, support_type,
      // ── NEW classification fields ──
      duty_type, form_type, tag, sub_tag, description,
    } = req.body;
    const id = uuidv4();
    await Activity.create({
      _id: id, user_id: req.user.id, msme_name, udyam_number, district: district || null, block_name,
      activity_type:     activity_type     || null,
      sub_activity:      sub_activity      || null,
      msme_address:      msme_address      || null,
      resolved_solution: resolved_solution || null,
      end_results:       end_results       || null,
      // legacy
      sector:            sector            || null,
      support_type:      support_type      || null,
      latitude:          latitude          || null,
      longitude:         longitude         || null,
      location_address:  location_address  || null,
      activity_date:     typeof activity_date === 'string' ? activity_date.slice(0, 10) : activity_date.toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' }).replace(/\//g, '-'),
      remarks:           remarks           || null,
      resource_type: 'auto',
      // ── NEW ──
      duty_type:         duty_type   || null,
      form_type:         form_type   || null,
      tag:               tag         || null,
      sub_tag:           sub_tag     || null,
      description:       description || null,
    });

    if (req.files?.length) {
      const empName = (req.user.name || 'unknown').replace(/\s+/g, '_').replace(/[^a-zA-Z0-9_-]/g, '');
      const empId   = String(req.user.emp_id || req.user.id || 'NOID').replace(/[^a-zA-Z0-9_-]/g, '');
      const uploaded = await Promise.all(
        req.files.map((f, idx) => {
          const ext      = path.extname(f.originalname).replace('.', '') || 'bin';
          const docName  = `${empName}_${empId}_activity_doc_${idx + 1}_${Date.now()}.${ext}`;
          return uploadFile(f.buffer, `ams/users/${req.user.emp_id || req.user.id}/activity-docs`, f.originalname, f.mimetype, docName);
        })
      );
      await ActivityDocument.insertMany(uploaded.map((url, i) => ({
        _id:         uuidv4(),
        activity_id: id,
        file_path:   url,
        file_name:   req.files[i].originalname,
        file_type:   req.files[i].mimetype,
      })));
    }
    res.status(201).json({ success: true, data: { id } });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ── GET /api/activity ──────────────────────────────────────────────────
router.get('/', authenticate, [
  query('filter').optional().isIn(['weekly', 'biweekly', 'monthly', 'custom', 'all']), // ← add 'all'
  query('startDate').optional().isISO8601(),
  query('endDate').optional().isISO8601(),
  query('block').optional().trim(),
  query('sector').optional().trim(),
  query('support_type').optional().trim(),
  query('form_type').optional().trim(),
  query('user_id').optional().trim(),
  query('manager_id').optional().trim(),
], validate, authorize('admin', 'manager', 'hr', 'employee'), async (req, res) => {
  try {
    const { filter = 'monthly', startDate, endDate, block, sector, support_type, form_type, user_id, manager_id, limit = 100, offset = 0 } = req.query;

    const safeParam = /^[a-zA-Z0-9 \-\/]*$/;
    if (block && !safeParam.test(block))
      return res.status(400).json({ success: false, message: 'Invalid block parameter' });
    if (sector && !safeParam.test(sector))
      return res.status(400).json({ success: false, message: 'Invalid sector parameter' });
    if (support_type && !safeParam.test(support_type))
      return res.status(400).json({ success: false, message: 'Invalid support_type parameter' });

    const matchFilter = {};
    let start = 'All', end = 'All';
    if (filter !== 'all') {
      ({ start, end } = dateRangeFromFilter(filter, startDate, endDate));
      matchFilter.activity_date = { $gte: start, $lte: end };
    }

    if (req.user.role === 'employee') {
      // Some old records store user_id as emp_id (legacy), new ones use UUID _id
      // Search both so nothing is missed
      const ids = [req.user.id, req.user.emp_id].filter(Boolean);
      matchFilter.user_id = ids.length === 1 ? ids[0] : { $in: ids };
    } else if (req.user.role === 'manager') {
      const teamMembers = await User.find({ manager_id: req.user.id, is_active: 1 }, { _id: 1, emp_id: 1 }).lean();
      if (teamMembers.length === 0)
        return res.json({ success: true, data: [], total: 0, start, end });
      // Include both UUID _id and emp_id for each team member (legacy support)
      const memberIds = teamMembers.flatMap(m => [String(m._id), m.emp_id].filter(Boolean));
      matchFilter.user_id = { $in: memberIds };
    }
    if (block)        matchFilter.block_name   = block;
    if (sector)       matchFilter.sector       = sector;
    if (support_type) matchFilter.support_type = support_type;
    if (form_type)    matchFilter.form_type    = form_type;
    if (user_id && ['admin', 'hr', 'super_admin'].includes(req.user.role)) matchFilter.user_id = user_id;

    let total;
    let rows;

    if (manager_id) {
      const pipeline = [
        { $match: matchFilter },
        { $lookup: { from: 'users', localField: 'user_id', foreignField: '_id', as: 'user' } },
        { $unwind: '$user' },
        { $match: { 'user.manager_id': manager_id } },
        { $facet: {
            metadata: [{ $count: 'total' }],
            data: [
              { $addFields: { user_name: '$user.name', emp_id: '$user.emp_id' } },
              { $lookup: { from: 'activitydocuments', localField: '_id', foreignField: 'activity_id', as: 'docs' } },
              { $addFields: { doc_count: { $size: '$docs' } } },
              { $project: { user: 0, docs: 0 } },
              { $sort: { activity_date: -1, created_at: -1 } },
              { $skip: Number(offset) },
              { $limit: Number(limit) },
            ],
        }},
      ];
      const results = await Activity.aggregate(pipeline);
      total = results[0].metadata[0]?.total || 0;
      rows  = results[0].data;
    } else {
      total = await Activity.countDocuments(matchFilter);
      rows  = await Activity.aggregate([
        { $match: matchFilter },
        { $lookup: { from: 'users',             localField: 'user_id', foreignField: '_id', as: 'user' } },
        { $lookup: { from: 'activitydocuments', localField: '_id',     foreignField: 'activity_id', as: 'docs' } },
        { $addFields: {
            user_name: { $arrayElemAt: ['$user.name',   0] },
            emp_id:    { $arrayElemAt: ['$user.emp_id', 0] },
            doc_count: { $size: '$docs' },
        }},
        { $project: { user: 0, docs: 0 } },
        { $sort: { activity_date: -1, created_at: -1 } },
        { $skip: Number(offset) },
        { $limit: Number(limit) },
      ]);
    }
    res.json({ success: true, data: rows, total, start, end });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ── GET /api/activity/:id ──────────────────────────────────────────────
router.get('/:id', authenticate, async (req, res) => {
  try {
    const rows = await Activity.aggregate([
      { $match: { _id: req.params.id } },
     { $lookup: { from: 'users', localField: 'assigned_to',  foreignField: '_id', as: 'assignee' } },
{ $lookup: { from: 'users', localField: 'created_by',   foreignField: '_id', as: 'creator'  } },
{ $lookup: { from: 'users', localField: 'manager_id',   foreignField: '_id', as: 'mgr'      } },
{ $addFields: {
    assigned_to_name:   { $arrayElemAt: ['$assignee.name',   0] },
    assigned_to_emp_id: { $arrayElemAt: ['$assignee.emp_id', 0] },
    created_by_name:    { $arrayElemAt: ['$creator.name',    0] },
    created_by_role:    { $arrayElemAt: ['$creator.role',    0] },
    manager_name:       { $arrayElemAt: ['$mgr.name',        0] },
    manager_emp_id:     { $arrayElemAt: ['$mgr.emp_id',      0] },
}},
{ $project: { assignee: 0, creator: 0, mgr: 0 } },
    ]);
    if (!rows.length) return res.status(404).json({ success: false, message: 'Not found' });
    const row = rows[0];
    if (req.user.role === 'employee' && row.user_id !== req.user.id)
      return res.status(403).json({ success: false, message: 'Forbidden' });
    if (req.user.role === 'manager') {
      const member = await User.findOne({ _id: row.user_id, manager_id: req.user.id }).lean();
      if (!member) return res.status(403).json({ success: false, message: 'Forbidden' });
    }
    const docs = await ActivityDocument.find({ activity_id: row._id }).lean();
    res.json({ success: true, data: { ...row, documents: docs } });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ── GET /api/activity/stats/heatmap ───────────────────────────────────
router.get('/stats/heatmap', authenticate, authorize('admin', 'manager', 'hr'), [
  query('filter').optional().isIn(['weekly', 'biweekly', 'monthly']),
  query('startDate').optional().isISO8601(),
  query('endDate').optional().isISO8601(),
], validate, async (req, res) => {
  try {
    const { filter = 'monthly', startDate, endDate } = req.query;
    const { start, end } = dateRangeFromFilter(filter, startDate, endDate);
    const rows = await Activity.aggregate([
      { $match: { activity_date: { $gte: start, $lte: end } } },
      { $group: { _id: '$activity_date', count: { $sum: 1 } } },
      { $project: { _id: 0, date: '$_id', count: 1 } },
      { $sort: { date: 1 } },
    ]);
    res.json({ success: true, data: rows, start, end });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ── GET /api/activity/stats/block-wise ────────────────────────────────
router.get('/stats/block-wise', authenticate, authorize('admin', 'manager', 'hr'), [
  query('filter').optional().isIn(['weekly', 'biweekly', 'monthly']),
  query('startDate').optional().isISO8601(),
  query('endDate').optional().isISO8601(),
], validate, async (req, res) => {
  try {
    const { filter = 'monthly', startDate, endDate } = req.query;
    const { start, end } = dateRangeFromFilter(filter, startDate, endDate);
    const rows = await Activity.aggregate([
      { $match: { activity_date: { $gte: start, $lte: end } } },
      { $group: {
        _id: '$block_name', total: { $sum: 1 },
        incubation:    { $sum: { $cond: [{ $eq: ['$support_type', 'Incubation']    }, 1, 0] } },
        market_linkage:{ $sum: { $cond: [{ $eq: ['$support_type', 'Market Linkage']}, 1, 0] } },
        advisory:      { $sum: { $cond: [{ $eq: ['$support_type', 'Advisory']      }, 1, 0] } },
        user_ids:      { $addToSet: '$user_id' },
        msme_names:    { $addToSet: '$msme_name' },
      }},
      { $project: {
        _id: 0, block_name: '$_id', total: 1, incubation: 1, market_linkage: 1, advisory: 1,
        active_users: { $size: '$user_ids' }, unique_msme: { $size: '$msme_names' },
      }},
      { $sort: { total: -1 } },
    ]);
    res.json({ success: true, data: rows, start, end });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ── GET /api/activity/stats/my ────────────────────────────────────────
router.get('/stats/my', authenticate, [
  query('startDate').optional().isISO8601(),
  query('endDate').optional().isISO8601(),
], validate, async (req, res) => {
  try {
    const { startDate, endDate } = req.query;
    const { start, end } = dateRangeFromFilter('monthly', startDate, endDate);

    const completed = await Activity.countDocuments({
      user_id: req.user.id,
      activity_date: { $gte: start, $lte: end },
    });

    const pending = 0; // placeholder — see NOTE above
    const TARGET  = 4; // matches /stats/compliance threshold
    const performance = `${Math.min(100, Math.round((completed / TARGET) * 100))}%`;

    res.json({ success: true, data: { completed, pending, performance }, start, end });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ── GET /api/activity/stats/compliance ───────────────────────────────
router.get('/stats/compliance', authenticate, authorize('admin', 'manager', 'hr'), async (req, res) => {
  try {
    const now        = new Date();
    const monthStart = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`;
    const monthEnd   = now.toISOString().slice(0, 10);
    const rows = await User.aggregate([
      { $match: { role: 'employee', is_active: 1 } },
      { $lookup: {
        from: 'activities', let: { uid: '$_id' },
        pipeline: [{ $match: { $expr: { $and: [
          { $eq:  ['$user_id',       '$$uid'    ] },
          { $gte: ['$activity_date', monthStart ] },
          { $lte: ['$activity_date', monthEnd   ] },
        ]}}}],
        as: 'activities',
      }},
      { $project: {
        emp_id: 1, name: 1, department: 1,
        activity_count: { $size: '$activities' },
        compliance_status: { $cond: [{ $gte: [{ $size: '$activities' }, 4] }, 'Compliant', 'Non-Compliant'] },
      }},
      { $sort: { activity_count: -1 } },
    ]);
    res.json({ success: true, data: rows, month: monthStart.slice(0, 7) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ── GET /api/activity/report/excel ────────────────────────────────────
router.get('/report/excel', authenticate, authorize('admin', 'manager', 'employee', 'hr', 'super_admin'), [
  query('filter').optional().isIn(['weekly', 'biweekly', 'monthly', 'custom']),
  query('startDate').optional().isISO8601(),
  query('endDate').optional().isISO8601(),
], validate, async (req, res) => {
  try {
    const { filter = 'monthly', startDate, endDate } = req.query;
    let start, end;
const matchFilter = {};
if (startDate && endDate) {
  // Explicit custom range always wins, regardless of filter value
  start = startDate;
  end   = endDate;
  matchFilter.activity_date = { $gte: start, $lte: end };
} else if (filter !== 'all') {
  ({ start, end } = dateRangeFromFilter(filter));
  matchFilter.activity_date = { $gte: start, $lte: end };
} else {
  start = 'All'; end = 'All';
}
    if (req.user.role === 'employee') {
      matchFilter.user_id = req.user.id;
    } else if (req.user.role === 'manager') {
      const teamMembers = await User.find({ manager_id: req.user.id, is_active: 1 }).distinct('_id');
      matchFilter.user_id = { $in: teamMembers };
    }

    const rows = await Activity.aggregate([
      { $match: matchFilter },
      { $lookup: { from: 'users',             localField: 'user_id', foreignField: '_id', as: 'user' } },
      { $lookup: { from: 'activitydocuments', localField: '_id',     foreignField: 'activity_id', as: 'docs' } },
      { $addFields: {
          emp_id:    { $arrayElemAt: ['$user.emp_id', 0] },
          user_name: { $arrayElemAt: ['$user.name',   0] },
          doc_count: { $size: '$docs' },
      }},
      { $sort: { activity_date: -1 } },
    ]);

   const excelRows = rows.map(a => ({
  'Date':                  a.activity_date        || '',
  'Emp ID':                a.emp_id               || '',
  'Officer Name':          a.user_name            || '',
  'Duty Type':             a.duty_type            || '',
  'Category':              a.form_type            || '',
  'Name':                  a.msme_name            || '',
  'Activity Type': a.activity_type || a.sector || '',
  'Sub Activity':          a.sub_activity         || a.support_type  || '',
  'District':              a.district             || '',
  'MSME Address':          a.msme_address         || '',
  'Resolution / Solution': a.resolved_solution    || '',
  'End Results':           a.end_results || a.description || '',
  'Description':           a.description          || '',
  'Remarks':               a.remarks              || '',
  'Attachments':           a.doc_count            || 0,
}));

    const wb = new ExcelJS.Workbook();

    // ── Main sheet ──
    const ws = wb.addWorksheet('Activities');
    const mainWidths = [12,10,20,12,14,28,22,25,16,30,35,35,30,35,12];
    if (excelRows.length > 0) {
      const headers = Object.keys(excelRows[0]);
      ws.addRow(headers);
      excelRows.forEach(r => ws.addRow(headers.map(h => r[h])));
      headers.forEach((_, i) => { ws.getColumn(i + 1).width = mainWidths[i] || 15; });
    }

    // ── Block summary sheet ──
    const blockRows = await Activity.aggregate([
      { $match: matchFilter },
      { $group: {
        _id:   '$block_name',
        total: { $sum: 1 },
        unique_msme: { $addToSet: '$msme_name' },
        awareness:         { $sum: { $cond: [{ $eq: ['$activity_type', 'Awareness & Outreach']       }, 1, 0] } },
        financial_support: { $sum: { $cond: [{ $eq: ['$activity_type', 'Financial Support']           }, 1, 0] } },
        market_linkage:    { $sum: { $cond: [{ $eq: ['$activity_type', 'Market Linkage']              }, 1, 0] } },
        capacity_building: { $sum: { $cond: [{ $eq: ['$activity_type', 'Capacity Building']           }, 1, 0] } },
        documentation:     { $sum: { $cond: [{ $eq: ['$activity_type', 'Documentation & Registration']}, 1, 0] } },
        advisory:          { $sum: { $cond: [{ $eq: ['$activity_type', 'Advisory & Consulting']       }, 1, 0] } },
      }},
      { $project: {
        _id: 0,
        'Block / ULB':            '$_id',
        'Total Activities':       '$total',
        'Unique MSMEs':           { $size: '$unique_msme' },
        'Awareness & Outreach':   '$awareness',
        'Financial Support':      '$financial_support',
        'Market Linkage':         '$market_linkage',
        'Capacity Building':      '$capacity_building',
        'Documentation & Reg':    '$documentation',
        'Advisory & Consulting':  '$advisory',
      }},
      { $sort: { 'Total Activities': -1 } },
    ]);
    const wsBlock = wb.addWorksheet('Block Summary');
    const blockWidths = [24,16,14,20,18,16,18,20,22];
    if (blockRows.length > 0) {
      const bHeaders = Object.keys(blockRows[0]);
      wsBlock.addRow(bHeaders);
      blockRows.forEach(r => wsBlock.addRow(bHeaders.map(h => r[h])));
      bHeaders.forEach((_, i) => { wsBlock.getColumn(i + 1).width = blockWidths[i] || 15; });
    }

    // ── NEW: Category summary sheet — one row per form_type/category ──
    const categoryRows = await Activity.aggregate([
      { $match: matchFilter },
      { $group: { _id: '$form_type', total: { $sum: 1 } } },
      { $project: { _id: 0, 'Category': { $ifNull: ['$_id', 'Uncategorised (legacy)'] }, 'Total Activities': '$total' } },
      { $sort: { 'Total Activities': -1 } },
    ]);
    const wsCategory = wb.addWorksheet('Category Summary');
    if (categoryRows.length > 0) {
      const cHeaders = Object.keys(categoryRows[0]);
      wsCategory.addRow(cHeaders);
      categoryRows.forEach(r => wsCategory.addRow(cHeaders.map(h => r[h])));
      cHeaders.forEach((_, i) => { wsCategory.getColumn(i + 1).width = 24; });
    }

    const buf = await wb.xlsx.writeBuffer();
    const filename = (startDate && endDate)
  ? `activities_${start}_${end}.xlsx`
  : (filter === 'all' ? 'activities_all.xlsx' : `activities_${start}_${end}.xlsx`);
    res.setHeader('Content-Disposition', `attachment; filename=${filename}`);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.send(buf);
  } catch (err) {
    console.error('EXCEL ERROR:', err.message, err.stack);
    if (!res.headersSent) res.status(500).json({ success: false, message: err.message });
  }
});
// ── GET /api/activity/report/pdf ──────────────────────────────────────
router.get('/report/pdf', authenticate, authorize('admin', 'manager', 'employee', 'hr', 'super_admin'), [
  query('filter').optional().isIn(['weekly', 'biweekly', 'monthly', 'custom']),
  query('startDate').optional().isISO8601(),
  query('endDate').optional().isISO8601(),
], validate, async (req, res) => {
  try {
    const PDFDocument = require('pdfkit');
    const { filter = 'monthly', startDate, endDate } = req.query;
   let start, end;
const matchFilter = {};
if (startDate && endDate) {
  // Explicit custom range always wins, regardless of filter value
  start = startDate;
  end   = endDate;
  matchFilter.activity_date = { $gte: start, $lte: end };
} else if (filter !== 'all') {
  ({ start, end } = dateRangeFromFilter(filter));
  matchFilter.activity_date = { $gte: start, $lte: end };
} else {
  start = 'All'; end = 'All';
}
    if (req.user.role === 'employee') {
      matchFilter.user_id = req.user.id;
    } else if (req.user.role === 'manager') {
      const teamMembers = await User.find({ manager_id: req.user.id, is_active: 1 }).distinct('_id');
      matchFilter.user_id = { $in: teamMembers };
    }

    const rows = await Activity.aggregate([
      { $match: matchFilter },
      { $lookup: { from: 'users', localField: 'user_id', foreignField: '_id', as: 'user' } },
      { $addFields: {
          officer:  { $arrayElemAt: ['$user.name',   0] },
          emp_code: { $arrayElemAt: ['$user.emp_id', 0] },
      }},
      { $project: { user: 0 } },
      { $sort: { activity_date: 1 } },
      { $limit: 500 },
    ]);

    const fmtDDMMYYYY = iso => {
      if (!iso || iso === 'All') return iso || '—';
      const [y, m, d] = String(iso).slice(0, 10).split('-');
      return `${d}-${m}-${y}`;
    };
    const _now = new Date(new Date().getTime() + 5.5 * 60 * 60 * 1000);
    const generatedDate = `${String(_now.getUTCDate()).padStart(2,'0')}-${String(_now.getUTCMonth()+1).padStart(2,'0')}-${_now.getUTCFullYear()}`;
    const pdfFilename = filter === 'all'
      ? 'activity_report_all.pdf'
      : `activity_report_${start}_${end}.pdf`;

    // ── Group rows into weekly bands ─────────────────────────────────
    const BAND_DEFS = [
      { label: 'Week 1',  test: d => d >= 1  && d <= 7  },
      { label: 'Week 2',  test: d => d >= 8  && d <= 14 },
      { label: 'Week 3',  test: d => d >= 15 && d <= 21 },
      { label: 'Week 4',  test: d => d >= 22 && d <= 28 },
      { label: 'Week 5',  test: d => d >= 29             },
    ];
    const bandedRows = BAND_DEFS.map(b => ({
      label: b.label,
      rows:  rows.filter(r => {
        const day = parseInt((r.activity_date || '').slice(8, 10), 10);
        return b.test(day);
      }),
    })).filter(b => b.rows.length > 0);

    const doc = new PDFDocument({ margin: 0, size: 'A3', layout: 'landscape' });
    res.setHeader('Content-Disposition', `attachment; filename=${pdfFilename}`);
    res.setHeader('Content-Type', 'application/pdf');
    doc.pipe(res);

    const PAGE_W = 1190.55, PAGE_H = 841.89, MARGIN = 28;
    const BLUE   = '#1a6aa5', BLUE_H = '#155a8a', BLUE_ALT = '#e8f2fb';
    const BAND_BG = '#dbeafe', BAND_FG = '#1e3a8a';
    const WHITE  = '#ffffff', BORDER = '#c8dff0', TEXT_DARK = '#0f1e3d', TEXT_MED = '#4a5568';
const cols  = [75, 60, 100, 180, 120, 120, 180, 180, 140];
const heads = ['Date', 'Emp ID', 'Officer', 'Name', 'Activity Type', 'Sub Activity', 'Resolution / Solution', 'End Results', 'Remarks'];

const ROW_H = 24, HEAD_H = 28, BAND_H = 16;
    const tableW = cols.reduce((s, c) => s + c, 0);

    const drawHeader = (yPos) => {
      doc.rect(MARGIN, yPos, tableW, HEAD_H).fill(BLUE_H);
      let x = MARGIN;
      doc.fillColor(WHITE).fontSize(7).font('Helvetica-Bold');
      heads.forEach((h, i) => {
        doc.text(h, x + 3, yPos + 9, { width: cols[i] - 5, lineBreak: false });
        x += cols[i];
      });
    };

    const drawBorders = (yPos, rowH) => {
      doc.moveTo(MARGIN, yPos + rowH).lineTo(MARGIN + tableW, yPos + rowH)
        .strokeColor(BORDER).lineWidth(0.3).stroke();
      let vx = MARGIN;
      cols.forEach((w) => {
        doc.moveTo(vx, yPos).lineTo(vx, yPos + rowH).strokeColor(BORDER).lineWidth(0.25).stroke();
        vx += w;
      });
      doc.moveTo(vx, yPos).lineTo(vx, yPos + rowH).strokeColor(BORDER).lineWidth(0.25).stroke();
    };

    const drawBandSeparator = (yPos, label, count) => {
      doc.rect(MARGIN, yPos, tableW, BAND_H).fill(BAND_BG);
      doc.fillColor(BAND_FG).fontSize(7.5).font('Helvetica-Bold')
        .text(`${label}  (${count} record${count !== 1 ? 's' : ''})`, MARGIN + 6, yPos + 4, { width: tableW - 12, lineBreak: false });
      doc.moveTo(MARGIN, yPos + BAND_H).lineTo(MARGIN + tableW, yPos + BAND_H)
        .strokeColor('#93c5fd').lineWidth(0.5).stroke();
    };

    // ── Page 1 banner ──
    doc.rect(0, 0, PAGE_W, 56).fill(BLUE);
    doc.fillColor(WHITE).fontSize(16).font('Helvetica-Bold')
      .text('BRP — Activity Report', MARGIN, 10, { width: PAGE_W - MARGIN * 2, align: 'center' });
    const sub = `Period: ${start === 'All' ? 'All Time' : `${fmtDDMMYYYY(start)} to ${fmtDDMMYYYY(end)}`}  ·  Generated: ${generatedDate}  ·  Total Records: ${rows.length}`;
    doc.fontSize(8.5).font('Helvetica')
      .text(sub, MARGIN, 34, { width: PAGE_W - MARGIN * 2, align: 'center' });

    let y = 64;
    drawHeader(y);
    y += HEAD_H;

    const tableStartY = y;

    doc.font('Helvetica').fontSize(7);
    let altIdx = 0;

    bandedRows.forEach(({ label, rows: bRows }) => {
      // Band separator — ensure it fits, else new page
      if (y + BAND_H + ROW_H > PAGE_H - 60) {
        doc.addPage({ size: 'A3', layout: 'landscape', margin: 0 });
        y = 20;
        drawHeader(y);
        y += HEAD_H;
        doc.font('Helvetica').fontSize(7);
        altIdx = 0;
      }
      drawBandSeparator(y, label, bRows.length);
      y += BAND_H;
      bRows.forEach(r => {
        const longFields = [r.msme_name || '', r.resolved_solution || '', r.end_results || '', r.remarks || ''];
        const maxLen = Math.max(0, ...longFields.map(f => f.length));
        const extra = maxLen > 70 ? 30 : maxLen > 34 ? 14 : 0;
        const thisRowH = ROW_H + extra;

        if (y + thisRowH > PAGE_H - 60) {
          doc.addPage({ size: 'A3', layout: 'landscape', margin: 0 });
          y = 20;
          drawHeader(y);
          y += HEAD_H;
          doc.font('Helvetica').fontSize(7);
          altIdx = 0;
        }

        doc.rect(MARGIN, y, tableW, thisRowH).fill(altIdx % 2 === 0 ? WHITE : BLUE_ALT);

const vals = [
  fmtDDMMYYYY(r.activity_date), r.emp_code || '', r.officer || '',
  r.msme_name || '',
 r.activity_type || r.sector || '',
  r.sub_activity || r.support_type || '',
  r.resolved_solution || '', r.end_results || r.description || '', r.remarks || '—',
];

        let cx = MARGIN;
        doc.fillColor(TEXT_DARK);
        vals.forEach((v, i) => {
          doc.text(String(v), cx + 3, y + 6, {
            width: cols[i] - 5, height: thisRowH - 6,
            ellipsis: true, lineBreak: thisRowH > ROW_H,
          });
          cx += cols[i];
        });

        drawBorders(y, thisRowH);
        y += thisRowH;
        altIdx++;
      });
    });

    // Outer border
    doc.rect(MARGIN, tableStartY - HEAD_H, tableW, y - (tableStartY - HEAD_H))
      .strokeColor(BLUE).lineWidth(0.8).stroke();

    // ── Acknowledgment section ────────────────────────────────────────
    const ACK_H = 72;
    if (y + ACK_H > PAGE_H - 20) {
      doc.addPage({ size: 'A3', layout: 'landscape', margin: 0 });
      y = 20;
    } else {
      y += 16;
    }

    doc.rect(MARGIN, y, tableW, ACK_H).fill('#f8fafc').strokeColor('#cbd5e1').lineWidth(0.5).stroke();
    doc.fillColor(TEXT_DARK).fontSize(8).font('Helvetica-Bold')
      .text('Acknowledgment', MARGIN + 10, y + 8);
    const sigY = y + 26;
    const sigCols = [tableW * 0.35, tableW * 0.30, tableW * 0.35];
    const sigLabels = ['Prepared by (Employee)', 'Verified by (Manager)', 'Approved by (HR / Admin)'];
    let sx = MARGIN + 10;
    sigLabels.forEach((lbl, i) => {
      doc.fillColor(TEXT_MED).fontSize(7).font('Helvetica').text(lbl, sx, sigY);
      doc.moveTo(sx, sigY + 22).lineTo(sx + sigCols[i] - 20, sigY + 22)
        .strokeColor('#94a3b8').lineWidth(0.5).stroke();
      doc.fillColor('#94a3b8').fontSize(6.5).text('Signature & Date', sx, sigY + 26);
      sx += sigCols[i];
    });

    // Page footer
    doc.fillColor(TEXT_MED).fontSize(7.5).font('Helvetica')
      .text(
        `BRP Activity Management System  ·  ${generatedDate}  ·  Confidential`,
        MARGIN, PAGE_H - 16, { width: PAGE_W - MARGIN * 2, align: 'center' },
      );

    doc.end();
  } catch (err) {
    console.error('PDF ERROR:', err.message, err.stack);
    if (!res.headersSent) res.status(500).json({ success: false, message: err.message });
  }
});
module.exports = router;