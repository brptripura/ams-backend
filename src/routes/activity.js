const express = require('express');
const router  = express.Router();
const multer  = require('multer');
const path    = require('path');
const { v4: uuidv4 } = require('uuid');
const { uploadFile } = require('../utils/storage');
const { query, body, validationResult } = require('express-validator');
const { Activity, ActivityDocument, User } = require('../models/database');
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

const activityValidators = [
  body('msme_name').trim().notEmpty().withMessage('MSME name required'),
  body('udyam_number').matches(UDYAM_RE).withMessage('Format: UDYAM-XX-00-0000000'),
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
];

const validate = (req, res, next) => {
  const errs = validationResult(req);
  if (!errs.isEmpty()) return res.status(422).json({ success: false, errors: errs.array() });
  next();
};

const dateRangeFromFilter = (filter, startDate, endDate) => {
  if (startDate && endDate) return { start: startDate, end: endDate };
  const now = new Date();
  const pad = (d) => d.toISOString().slice(0, 10);
  if (filter === 'weekly') {
    const d = new Date(now); d.setDate(d.getDate() - 7);
    return { start: pad(d), end: pad(now) };
  }
  if (filter === 'biweekly') {
    const d = new Date(now); d.setDate(d.getDate() - 14);
    return { start: pad(d), end: pad(now) };
  }
  return { start: `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`, end: pad(now) };
};

// ── POST /api/activity ─────────────────────────────────────────────────
router.post('/', authenticate, upload.array('documents', 10), activityValidators, validate, async (req, res) => {
  try {
    const {
      msme_name, udyam_number, district, block_name, latitude, longitude, location_address, activity_date,
      activity_type, sub_activity, msme_address, resolved_solution, end_results,
      remarks, sector, support_type,
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
      activity_date:     typeof activity_date === 'string' ? activity_date : activity_date.toISOString().slice(0, 10),
      remarks:           remarks           || null,
      resource_type: 'auto',
    });

    if (req.files?.length) {
      const uploaded = await Promise.all(
        req.files.map(f => uploadFile(f.buffer, 'ams/activity-docs', f.originalname, f.mimetype))
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
  query('filter').optional().isIn(['weekly', 'biweekly', 'monthly']),
  query('startDate').optional().isISO8601(),
  query('endDate').optional().isISO8601(),
  query('block').optional().trim(),
  query('sector').optional().trim(),
  query('support_type').optional().trim(),
  query('user_id').optional().trim(),
  query('manager_id').optional().trim(),
], validate, authorize('admin', 'manager', 'hr', 'employee'), async (req, res) => {
  try {
    const { filter = 'monthly', startDate, endDate, block, sector, support_type, user_id, manager_id, limit = 100, offset = 0 } = req.query;

    const safeParam = /^[a-zA-Z0-9 \-\/]*$/;
    if (block && !safeParam.test(block))
      return res.status(400).json({ success: false, message: 'Invalid block parameter' });
    if (sector && !safeParam.test(sector))
      return res.status(400).json({ success: false, message: 'Invalid sector parameter' });
    if (support_type && !safeParam.test(support_type))
      return res.status(400).json({ success: false, message: 'Invalid support_type parameter' });

    const { start, end } = dateRangeFromFilter(filter, startDate, endDate);
    const matchFilter = { activity_date: { $gte: start, $lte: end } };

    if (req.user.role === 'employee') {
      matchFilter.user_id = req.user.id;
    } else if (req.user.role === 'manager') {
      const teamMembers = await User.find({ manager_id: req.user.id, is_active: 1 }, { _id: 1 }).lean();
      if (teamMembers.length === 0)
        return res.json({ success: true, data: [], total: 0, start, end });
      matchFilter.user_id = { $in: teamMembers.map(m => String(m._id)) };
    }
    if (block)        matchFilter.block_name   = block;
    if (sector)       matchFilter.sector       = sector;
    if (support_type) matchFilter.support_type = support_type;
    if (user_id) matchFilter.user_id = user_id;

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
  query('filter').optional().isIn(['weekly', 'biweekly', 'monthly', 'all']),
  query('startDate').optional().isISO8601(),
  query('endDate').optional().isISO8601(),
], validate, async (req, res) => {
  try {
    const XLSX = require('xlsx');
    const { filter = 'monthly', startDate, endDate } = req.query;
    const matchFilter = {};
    if (filter !== 'all') {
      ({ start, end } = dateRangeFromFilter(filter, startDate, endDate));
      matchFilter.activity_date = { $gte: start, $lte: end };
    } else {
      start = 'All'; end = 'All';
    }
    // In report/excel and report/pdf routes, replace:
if (req.user.role === 'employee') {
  matchFilter.user_id = req.user.id;
} else if (req.user.role === 'manager') {
  const teamMembersExcel = await User.find(
    { manager_id: req.user.id, is_active: 1 }
  ).distinct('_id');
  matchFilter.user_id = { $in: teamMembersExcel };
}
    // hr / super_admin / admin: see all

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
      'Date': a.activity_date, 'Emp ID': a.emp_id, 'Officer Name': a.user_name,
      'MSME Name': a.msme_name, 'Udyam No': a.udyam_number, 'Sector': a.sector,
      'Support Type': a.support_type, 'Block': a.block_name,
      'Location': a.location_address, 'Remarks': a.remarks, 'Docs': a.doc_count,
    }));
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(excelRows), 'Activities');
    const blockRows = await Activity.aggregate([
      { $match: matchFilter },
      { $group: {
        _id: '$block_name', total: { $sum: 1 },
        awareness:         { $sum: { $cond: [{ $eq: ['$support_type', 'Awareness']         }, 1, 0] } },
        marketing_linkage: { $sum: { $cond: [{ $eq: ['$support_type', 'Marketing Linkage'] }, 1, 0] } },
        loan_facilitation: { $sum: { $cond: [{ $eq: ['$support_type', 'Loan Facilitation'] }, 1, 0] } },
        training_workshop: { $sum: { $cond: [{ $eq: ['$support_type', 'Training/Workshop'] }, 1, 0] } },
        advisory_other:    { $sum: { $cond: [{ $eq: ['$support_type', 'Advisory/Other']    }, 1, 0] } },
      }},
      { $project: { _id: 0, 'Block': '$_id', 'Total': '$total', 'Awareness': '$awareness',
        'Marketing Linkage': '$marketing_linkage', 'Loan Facilitation': '$loan_facilitation',
        'Training/Workshop': '$training_workshop', 'Advisory/Other': '$advisory_other' } },
      { $sort: { Total: -1 } },
    ]);
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(blockRows), 'Block Summary');
    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    const filename = filter === 'all' ? 'activities_all.xlsx' : `activities_${start}_${end}.xlsx`;
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
  query('filter').optional().isIn(['weekly', 'biweekly', 'monthly', 'all']),
  query('startDate').optional().isISO8601(),
  query('endDate').optional().isISO8601(),
], validate, async (req, res) => {
  try {
    const PDFDocument = require('pdfkit');
    const { filter = 'monthly', startDate, endDate } = req.query;
    const matchFilter = {};
    if (filter !== 'all') {
      ({ start, end } = dateRangeFromFilter(filter, startDate, endDate));
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
      { $sort: { activity_date: -1 } },
      { $limit: 500 },
    ]);
    const generatedDate = new Date().toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', year: 'numeric' });
    const pdfFilename   = filter === 'all' ? 'activity_report_all.pdf' : `activity_report_${matchFilter.activity_date?.$gte}_${matchFilter.activity_date?.$lte}.pdf`;

    const doc     = new PDFDocument({ margin: 0, size: 'A4', layout: 'landscape' });
    res.setHeader('Content-Disposition', `attachment; filename=${pdfFilename}`);
    res.setHeader('Content-Type', 'application/pdf');
    doc.pipe(res);

    const PAGE_W = 841.89, PAGE_H = 595.28, MARGIN = 30;
    const BLUE = '#1a6aa5', BLUE_H = '#155a8a', ROW_ALT = '#f0f6fb', WHITE = '#ffffff', BORDER = '#d0e4f0';

    doc.rect(0, 0, PAGE_W, 72).fill(BLUE);
    doc.fillColor(WHITE).fontSize(20).font('Helvetica-Bold').text('BRP — Activity Report', MARGIN, 14, { width: PAGE_W - MARGIN * 2, align: 'center' });
    const subtitle = `Period: ${filter === 'all' ? 'All Time' : filter.charAt(0).toUpperCase() + filter.slice(1)}  ·  Generated: ${generatedDate}  ·  Total: ${rows.length}`;
    doc.fontSize(10).font('Helvetica').text(subtitle, MARGIN, 42, { width: PAGE_W - MARGIN * 2, align: 'center' });

    const cols   = [68, 52, 80, 110, 105, 80, 90, 75, 112];
    const heads  = ['Date', 'Emp ID', 'Officer', 'MSME Name', 'Udyam No', 'Sector', 'Support Type', 'Block', 'Remarks'];
    const ROW_H  = 22, HEAD_H = 26;
    let y = 82;

    const drawHead = (yPos) => {
      let x = MARGIN;
      doc.rect(MARGIN, yPos, PAGE_W - MARGIN * 2, HEAD_H).fill(BLUE_H);
      doc.fillColor(WHITE).fontSize(8).font('Helvetica-Bold');
      heads.forEach((h, i) => { doc.text(h, x + 4, yPos + 8, { width: cols[i] - 6 }); x += cols[i]; });
    };
    drawHead(y);
    y += HEAD_H;

    doc.font('Helvetica').fontSize(7.5);
    rows.forEach((r, idx) => {
      if (y + ROW_H > PAGE_H - 20) {
        doc.addPage({ size: 'A4', layout: 'landscape', margin: 0 });
        y = 20;
        drawHead(y);
        y += HEAD_H;
        doc.font('Helvetica').fontSize(7.5);
      }
      doc.rect(MARGIN, y, PAGE_W - MARGIN * 2, ROW_H).fill(idx % 2 === 0 ? WHITE : ROW_ALT);
      doc.moveTo(MARGIN, y + ROW_H).lineTo(PAGE_W - MARGIN, y + ROW_H).strokeColor(BORDER).lineWidth(0.4).stroke();

      const vals = [r.activity_date || '', r.emp_code || '', r.officer || '', r.msme_name || '', r.udyam_number || '', r.sector || '', r.support_type || '', r.block_name || '', r.remarks || '—'];
      let cx = MARGIN;
      doc.fillColor('#1a2744');
      vals.forEach((v, i) => { doc.text(String(v), cx + 4, y + 7, { width: cols[i] - 6, ellipsis: true, lineBreak: false }); cx += cols[i]; });

      let vx = MARGIN;
      cols.forEach((w, i) => {
        if (i > 0) doc.moveTo(vx, y).lineTo(vx, y + ROW_H).strokeColor(BORDER).lineWidth(0.3).stroke();
        vx += w;
      });
      y += ROW_H;
    });

    const tableH = y - 82;
    doc.rect(MARGIN, 82, PAGE_W - MARGIN * 2, tableH).strokeColor(BLUE).lineWidth(0.8).stroke();
    doc.end();
  } catch (err) {
    console.error('PDF ERROR:', err.message, err.stack);
    if (!res.headersSent) res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;