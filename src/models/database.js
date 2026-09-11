const mongoose = require('mongoose');

const MONGO_URI = process.env.MONGO_URI;
if (!MONGO_URI) {
  console.error('FATAL: MONGO_URI environment variable is required');
  process.exit(1);
}
// ── Schemas ───────────────────────────────────────────────────────────────

const userSchema = new mongoose.Schema({
  _id:               { type: String },
  emp_id:            { type: String, unique: true, required: true },
  name:              { type: String, required: true },
  email:             { type: String, unique: true, required: true },
  password_hash:     { type: String, required: true },
  role:              { type: String, enum: ['employee', 'manager', 'admin', 'hr', 'super_admin', 'department_portal'], required: true },
  role_type:         { type: String, default: null },
  department:        { type: String, required: true },
  manager_id:        { type: String, ref: 'User', default: null },
 designation:  { type: String, default: null },
 hr_id:        { type: String, default: null },
  phone:             { type: String, default: null },
  is_active:         { type: Number, default: 1 },
  assigned_block:    { type: String, default: null },
  assigned_district: { type: String, default: null },
  // Only meaningful for role:'department_portal' — the specific employees
  // this dept-portal account is allowed to see, set by Super Admin.
  allocated_employee_ids: [{ type: String, ref: 'User' }],
  // ── Email verification ───────────────────────────────────────────────
  email_verified:       { type: Boolean, default: false },
  email_verify_token:   { type: String,  default: null },  // hashed token
  email_verify_expires: { type: Date,    default: null },
  // ── Password reset ───────────────────────────────────────────────────
  pwd_reset_token:      { type: String,  default: null },  // hashed token
  pwd_reset_expires:    { type: Date,    default: null },
  // ── Password reset OTP ───────────────────────────────────────────────
  pwd_reset_otp:        { type: String,  default: null },  // hashed OTP
  pwd_reset_otp_expires:{ type: Date,    default: null },
  // ── Password changed timestamp (for global logout) ─────────────────
  pwd_changed_at:       { type: Date,    default: null },
  // ── Phone OTP ────────────────────────────────────────────────────────
  phone_otp:              { type: String,  default: null },  // hashed OTP
  phone_otp_expires:      { type: Date,    default: null },
  phone_otp_attempts:     { type: Number,  default: 0 },
  phone_otp_locked_until: { type: Date,    default: null },
  phone_verified:         { type: Boolean, default: false },
  // ── Account lockout ─────────────────────────────────────────────────
  failed_login_attempts: { type: Number, default: 0 },
  login_locked_until:    { type: Date, default: null },
  // ── Session management ───────────────────────────────────────────────
  active_session_jti:    { type: String, default: null },
// ── Profile Photo ─────────────────────────────────────────────────────────
profile_photo_path:      { type: String, default: null },  // Cloudinary URL
profile_photo_uploaded:  { type: Date,   default: null },  // when first uploaded
photo_update_quota:      { type: Number, default: null },  // null=locked, 0=unlimited, N=allowed N updates
photo_update_count:      { type: Number, default: 0    },  // how many updates used so far
  // Legacy single-scan fields kept for backwards compat
  scan_paper_path:     { type: String, default: null },
  scan_paper_uploaded: { type: String, default: null },
  face_enrolled: { type: Boolean, default: false },
  joining_date:                  { type: String, default: null },
  office_name:                   { type: String, default: null },
  reporting_officer_name:        { type: String, default: null },
  reporting_officer_designation: { type: String, default: null },
  // ── Leave management ─────────────────────────────────────────────────
  // Whole days only (0, 1, 2, ... 24) — enforced in application code via
  // clampLeaveBalance() in attendance.js/users.js since most writes here use
  // findByIdAndUpdate/bulkWrite, which skip Mongoose validators by default;
  // min/max still documents the intended range and guards any .save() path.
  leave_balance:       { type: Number,  default: 0, min: 0, max: 24 },
  auto_leave_enabled:  { type: Boolean, default: true },
  last_accrual_date:   { type: String,  default: null }, // YYYY-MM-DD of last accrual run
  is_permitted:        { type: Boolean, default: false },
  // Admin/super_admin-only override: skips the check-in location restriction
  // (Office Duty's 200m-of-block, On Duty's district-wide check) entirely,
  // for the few employees who genuinely need to check in from anywhere —
  // e.g. no fixed base. Everyone else keeps the normal geofence.
  checkin_geofence_exempt: { type: Boolean, default: false },
}, { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' } });

userSchema.index({ manager_id: 1 });
userSchema.index({ role: 1 });
userSchema.index({ is_active: 1 });

// ─────────────────────────────────────────────────────────────────────────────
// ATTENDANCE RECORD
// selfie_path          → Cloudinary URL (checkin photo)
// checkout_selfie_path → Cloudinary URL (checkout photo)
// reapply_docs         → Array of Cloudinary URLs
// ─────────────────────────────────────────────────────────────────────────────
const attendanceRecordSchema = new mongoose.Schema({
  _id:                  { type: String },
  emp_id:               { type: String, ref: 'User', required: true },
  date:                 { type: String, required: true },
  end_date:             { type: String, default: null },
  duty_type:            { type: String, enum: ['Office Duty', 'On Duty', 'On Duty Away', 'Leave'], required: true },
  sector:               { type: String, default: null },
  description:          { type: String, default: null },
  status:               { type: String, enum: ['Draft', 'Pending', 'Approved', 'Rejected'], default: 'Draft' },
  // ── Cloudinary URLs ──────────────────────────────────────────────────────
  selfie_path:          { type: String, default: null }, // Cloudinary secure URL
  checkout_selfie_path: { type: String, default: null }, // Cloudinary secure URL
  // ────────────────────────────────────────────────────────────────────────
  latitude:             { type: Number, default: null },
  longitude:            { type: Number, default: null },
  location_address:     { type: String, default: null },
  checkin_time:         { type: String, default: null },
  checkout_time:        { type: String, default: null },
  checkin_lat:          { type: Number, default: null },
  checkin_lng:          { type: Number, default: null },
  // GPS coordinates are client-supplied and spoofable — this is a
  // best-effort, non-blocking corroboration signal (coarse IP geolocation
  // vs. the reported GPS) so a manager/admin can review a mismatch instead
  // of the check-in being silently trusted with no independent signal.
  location_flagged:     { type: Boolean, default: false },
  location_flag_reason: { type: String, default: null },
  checkout_lat:         { type: Number, default: null },
  checkout_lng:         { type: Number, default: null },
  manager_id:           { type: String, ref: 'User', default: null },
  manager_remark:       { type: String, default: null },
  admin_remark:         { type: String, default: null },
  actioned_by:          { type: String, ref: 'User', default: null },
  actioned_at:          { type: Date, default: null },
  submitted_at:         { type: Date, default: null },
  worked_hours:         { type: Number, default: null },
  is_auto_checkout:     { type: Boolean, default: false },
  checkout_remarks:     { type: String, default: null },
  leave_type:           { type: String, enum: ['Casual Leave', 'Half Day', 'Emergency Leave', 'Urgent Leave', 'Planned Leave', null], default: null },
  attendance_type:      { type: String, enum: ['Regular', 'Irregular', 'Partial', 'Permitted', null], default: null },
  leave_reason:         { type: String, default: null },
  leave_status:         { type: String, enum: ['Pending', 'Approved', 'Rejected', null], default: null },
  reapply_reason:       { type: String, default: null },
  reapply_docs:         { type: [String], default: [] }, // Array of Cloudinary URLs
  reapplied_at:         { type: Date, default: null },
  hr_override:          { type: Boolean, default: false },
  hr_remark:            { type: String, default: null },
  hr_actioned_by:       { type: String, ref: 'User', default: null },
  hr_actioned_at:       { type: Date, default: null },
  overridden_by:        { type: String, enum: ['hr', 'super_admin', null], default: null },
  override_remark:      { type: String, default: null },
 face_verification_status: {
  type: String,
  enum: [
    'pending', 'processing',
    'verified', 'error',
    null
  ],
  default: null
},
face_confidence:    { type: Number, default: null },
checkout_face_verification_status: {
  type: String,
  enum: ['verified', 'error', null],   // ✅ 'mismatch' removed — mismatches are now blocked before save, never persisted
  default: null
},
checkout_face_confidence: { type: Number, default: null },
  is_missed_checkout:       { type: Boolean, default: false },
  is_lop:                   { type: Boolean, default: false }, // true when any part of this leave is LOP (lop_days > 0)
  paid_days:                { type: Number,  default: 0 }, // days actually deducted from leave_balance at application time
  lop_days:                 { type: Number,  default: 0 }, // days beyond available balance — Loss of Pay, never deducted
  // 15–20 min and is surfaced to employee / manager / super_admin / hr.
  late_checkout_reason:         { type: String, default: null },
  late_checkout_requested_at:   { type: Date,   default: null },
  late_checkout_extended_until: { type: Date,   default: null },
signed_reports: [{
    path:        String,
    name:        String,
    month:       String,   // "YYYY-MM"
    month_label: String,   // "April 2026"
    uploaded_at: Date,
    uploaded_by: String,   // user _id
  }],

  // ── BDO-Signed Leave Letter ──────────────────────────────────────────
  signed_leave_path:        { type: String, default: null }, // Cloudinary secure URL
  signed_leave_public_id:   { type: String, default: null }, // for Cloudinary deletion
  signed_leave_name:        { type: String, default: null }, // original filename
  signed_leave_uploaded_at: { type: Date,   default: null },
  signed_leave_uploaded_by: { type: String, default: null },
}, { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' } });

attendanceRecordSchema.index({ emp_id: 1, date: 1 }, { unique: true });
attendanceRecordSchema.index({ date: 1 });
attendanceRecordSchema.index({ status: 1 });
attendanceRecordSchema.index({ manager_id: 1 });
attendanceRecordSchema.index({ manager_id: 1, status: 1 });
attendanceRecordSchema.index({ date: 1, status: 1 });

// ─────────────────────────────────────────────────────────────────────────────

const notificationSchema = new mongoose.Schema({
  _id:               { type: String },
  user_id:           { type: String, ref: 'User', required: true },
  title:             { type: String, required: true },
  message:           { type: String, required: true },
  type:              { type: String, enum: ['info', 'success', 'warning', 'error'], default: 'info' },
  is_read:           { type: Number, default: 0 },
  related_record_id: { type: String, ref: 'AttendanceRecord', default: null },
  link:              { type: String, default: null },
}, { timestamps: { createdAt: 'created_at', updatedAt: false } });

notificationSchema.index({ user_id: 1 });
notificationSchema.index({ user_id: 1, is_read: 1 });

const auditLogSchema = new mongoose.Schema({
  _id:         { type: String },
  user_id:     { type: String, ref: 'User', required: true },
  action:      { type: String, required: true },
  entity_type: { type: String, default: null },
  entity_id:   { type: String, default: null },
  old_value:   { type: String, default: null },
  new_value:   { type: String, default: null },
  ip_address:  { type: String, default: null },
}, { timestamps: { createdAt: 'created_at', updatedAt: false } });

auditLogSchema.index({ entity_type: 1, entity_id: 1 });
auditLogSchema.index({ user_id: 1 });
auditLogSchema.index({ created_at: 1 });

const revokedTokenSchema = new mongoose.Schema({
  _id:        { type: String },
  revoked_at: { type: Date, default: Date.now },
});

const activitySchema = new mongoose.Schema({
  _id:               { type: String },
  user_id:           { type: String, ref: 'User', required: true },
  msme_name:         { type: String, required: true },
  udyam_number:      { type: String, default: null },
  // Legacy fields kept for backwards compatibility
  sector:            { type: String, default: null },
  support_type:      { type: String, default: null },
  // New hierarchical activity classification
  activity_type:     { type: String, default: null },
  sub_activity:      { type: String, default: null },
  // MSME address (auto-filled from master when available)
  msme_address:      { type: String, default: null },
  district:          { type: String, default: null },
  block_name:        { type: String, required: true },
  latitude:          { type: Number, default: null },
  longitude:         { type: Number, default: null },
  location_address:  { type: String, default: null },
  activity_date:     { type: String, required: true },
  remarks:           { type: String, default: null },
  // Resolution & outcome fields
  resolved_solution: { type: String, default: null },
  end_results:       { type: String, default: null },
  resource_type:     { type: String, default: null }, // 'image' | 'raw'
 
  // ── NEW: reliable activity classification (used by the monthly-category PDF) ──
  // 'Office Duty' | 'On Duty' — top-level duty selector the employee picked
  duty_type:         { type: String, enum: ['Office Duty', 'On Duty', null], default: null },
  // which form screen produced this record — the single source of truth for
  // categorisation. Extend this enum whenever a new form screen is added.
  form_type:         {
    type: String,
    enum: ['msme_visit', 'training', 'training_self', 'govt_office', 'office_duty', 'field_visit', null],
    default: null,
  },
  // Tag → Sub-tag cascade (Office Duty / Field Visit / Training Self forms)
  tag:               { type: String, default: null },
  sub_tag:           { type: String, default: null },
  // Free-text description — required for "Others" sub-tags and all
  // Training Self entries
  description:       { type: String, default: null },
}, { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' } });
 
activitySchema.index({ user_id: 1 });
activitySchema.index({ activity_date: 1 });
activitySchema.index({ block_name: 1 });
activitySchema.index({ sector: 1 });
activitySchema.index({ activity_date: 1, block_name: 1 });
activitySchema.index({ form_type: 1 });

// MSME Master — pre-loaded list of registered MSMEs per block
const msmeMasterSchema = new mongoose.Schema({
  _id:          { type: String },
  msme_name:    { type: String, required: true },
  udyam_number: { type: String, required: true, unique: true },
  sector:       { type: String, default: null },
  block_name:   { type: String, required: true },
  district:     { type: String, required: true },
  address:      { type: String, default: null },   // Full address from Udyam registration
  owner_name:   { type: String, default: null },
  contact:      { type: String, default: null },
  latitude:     { type: Number, default: null },
  longitude:    { type: Number, default: null },
  nic_code:     { type: String, default: null },
  is_active:    { type: Boolean, default: true },
}, { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' }, collection: 'msme_masters' });

msmeMasterSchema.index({ block_name: 1 });
msmeMasterSchema.index({ district: 1 });
msmeMasterSchema.index({ sector: 1 });
msmeMasterSchema.index({ is_active: 1 });

// ─────────────────────────────────────────────────────────────────────────────
// MSME PROPOSALS — new MSMEs submitted by employees for admin review
// ─────────────────────────────────────────────────────────────────────────────
const msmePropSchema = new mongoose.Schema({
  _id:          { type: String },
  msme_name:    { type: String, required: true },
  address:      { type: String, default: null },
  city:         { type: String, default: null },
  pincode:      { type: String, default: null },
  state:        { type: String, default: null },
  district:     { type: String, default: null },
  block_name:   { type: String, default: null },
  latitude:     { type: Number, default: null },
  longitude:    { type: Number, default: null },
  udyam_number: { type: String, default: null }, // filled by the proposing employee, optional
  sector:       { type: String, default: null }, // filled by the proposing employee, optional
  proposed_by:  { type: String, default: null }, // emp_id
  status:       { type: String, enum: ['pending', 'approved', 'rejected'], default: 'pending' },
}, { timestamps: true, collection: 'msme_proposals' });

const MsmeProposal = mongoose.model('MsmeProposal', msmePropSchema);

// ─────────────────────────────────────────────────────────────────────────────
// ACTIVITY DOCUMENT
// file_path  → Cloudinary secure URL (was: local filename like act_userid_123.jpg)
// public_id  → Cloudinary public_id for deletion (NEW field)
// ─────────────────────────────────────────────────────────────────────────────
const activityDocumentSchema = new mongoose.Schema({
  _id:         { type: String },
  activity_id: { type: String, ref: 'Activity', required: true },
  file_path:   { type: String, required: true }, // Cloudinary secure URL
  file_name:   { type: String, required: true }, // original filename
  file_type:   { type: String, default: null  }, // mimetype
  public_id:   { type: String, default: null  }, // ← NEW: Cloudinary public_id for deletion
  resource_type: { type: String }, // 'image' | 'raw'
}, { timestamps: { createdAt: 'created_at', updatedAt: false } });

activityDocumentSchema.index({ activity_id: 1 });

// ─────────────────────────────────────────────────────────────────────────────
// ACTIVITY SCHEDULE
// ─────────────────────────────────────────────────────────────────────────────
const activityScheduleSchema = new mongoose.Schema({
  _id:              { type: String },
  title:            { type: String, required: true },
  description:      { type: String, default: null },
  scheduled_date:   { type: String, required: true },
  location:         { type: String, default: null },
  assigned_to:      { type: String, ref: 'User', default: null },
  manager_id:       { type: String, ref: 'User', default: null },
  created_by:       { type: String, ref: 'User', required: true },
  assigned_by:      { type: String, ref: 'User', default: null }, // who assigned this activity
  assigned_by_name: { type: String, default: null },               // quick-display name
  manager_id:       { type: String, ref: 'User', default: null }, // selected manager
  status:           { type: String, enum: ['Pending', 'Initiated', 'Completed'], default: 'Pending' },
  initiated_by:     { type: String, ref: 'User', default: null },
  initiated_at:     { type: Date, default: null },
  completed_by:     { type: String, ref: 'User', default: null },
  completed_at:     { type: Date, default: null },
  work_description: { type: String, default: null },
  remarks:          { type: String, default: null },
}, { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' } });

activityScheduleSchema.index({ scheduled_date: 1 });
activityScheduleSchema.index({ status: 1 });
activityScheduleSchema.index({ assigned_to: 1 });
activityScheduleSchema.index({ created_by: 1 });
activityScheduleSchema.index({ manager_id: 1 });

// ─────────────────────────────────────────────────────────────────────────────
// SCHEDULE DOCUMENT
// file_path  → Cloudinary secure URL (was: schedule/sched_userid_123.jpg)
// public_id  → Cloudinary public_id for deletion (NEW field)
// ─────────────────────────────────────────────────────────────────────────────
const scheduleDocumentSchema = new mongoose.Schema({
  _id:         { type: String },
  schedule_id: { type: String, ref: 'ActivitySchedule', required: true },
  file_path:   { type: String, required: true }, // Cloudinary secure URL
  file_name:   { type: String, required: true }, // original filename
  file_type:   { type: String, default: null  }, // mimetype
  public_id:   { type: String, default: null  }, // ← NEW: Cloudinary public_id for deletion
  resource_type: { type: String }, // 'image' | 'raw'
}, { timestamps: { createdAt: 'created_at', updatedAt: false } });

scheduleDocumentSchema.index({ schedule_id: 1 });
const monthlyReportSchema = new mongoose.Schema({
  user_id:     { type: String, ref: 'User', required: true },
  month_key:   { type: String, required: true },      // "2026-06"
  file_name:   { type: String, required: true },
  file_type:   { type: String, default: null },
  file_url:    { type: String, required: true },      // Cloudinary URL
  public_id:   { type: String, default: null },       // for Cloudinary deletion
  uploaded_at: { type: Date, default: Date.now },
  // expires_at removed — reports are kept forever, deletion is manual only (see DELETE routes)
}, { timestamps: { createdAt: 'created_at', updatedAt: false } });

monthlyReportSchema.index({ user_id: 1, month_key: 1 }, { unique: true });

// ── Models ────────────────────────────────────────────────────────────────

const User             = mongoose.model('User',             userSchema);
const AttendanceRecord = mongoose.model('AttendanceRecord', attendanceRecordSchema);
const Notification     = mongoose.model('Notification',     notificationSchema);
const AuditLog         = mongoose.model('AuditLog',         auditLogSchema);
const RevokedToken     = mongoose.model('RevokedToken',     revokedTokenSchema);
const Activity         = mongoose.model('Activity',         activitySchema);
const ActivityDocument = mongoose.model('ActivityDocument', activityDocumentSchema);
const ActivitySchedule = mongoose.model('ActivitySchedule', activityScheduleSchema);
const ScheduleDocument = mongoose.model('ScheduleDocument', scheduleDocumentSchema);
const MsmeMaster       = mongoose.model('MsmeMaster',       msmeMasterSchema);
const MonthlyReport    = mongoose.model('MonthlyReport',    monthlyReportSchema);
// ── Custom Dropdown Options (shared across all users) ─────────────────────
const customOptionSchema = new mongoose.Schema({
  _id:      { type: String },
  category: { type: String, required: true, index: true },  // e.g. 'ams_custom_activity_types'
  value:    { type: String, required: true },
  added_by: { type: String, ref: 'User', default: null },
}, { timestamps: true });
customOptionSchema.index({ category: 1, value: 1 }, { unique: true });
const CustomOption = mongoose.model('CustomOption', customOptionSchema);

// ── Custom Blocks (admin-managed, merged with hardcoded base list) ─────────
const customBlockSchema = new mongoose.Schema({
  district:   { type: String, required: true },
  block_name: { type: String, required: true },
  added_by:   { type: String, ref: 'User', default: null },
  // Check-in geofence center for this block. Null until an admin sets it —
  // check-in geofencing is skipped for a block with no coordinates.
  latitude:   { type: Number, default: null },
  longitude:  { type: Number, default: null },
}, { timestamps: true });
customBlockSchema.index({ district: 1, block_name: 1 }, { unique: true });
const CustomBlock = mongoose.model('CustomBlock', customBlockSchema);

// ── Department Master ──────────────────────────────────────────────────────
const customDepartmentSchema = new mongoose.Schema({
  name:     { type: String, required: true, unique: true },
  added_by: { type: String, ref: 'User', default: null },
}, { timestamps: { createdAt: 'created_at', updatedAt: false } });

const CustomDepartment = mongoose.model('CustomDepartment', customDepartmentSchema);

// ── Geocode Cache ─────────────────────────────────────────────────────────
const geoCacheSchema = new mongoose.Schema({
  key:     { type: String, unique: true, required: true }, // "lat2dp,lng2dp"
  payload: { type: mongoose.Schema.Types.Mixed, required: true },
}, { timestamps: { createdAt: 'created_at', updatedAt: false } });

const GeoCache = mongoose.model('GeoCache', geoCacheSchema);

// ── Holiday Master ────────────────────────────────────────────────────────
const holidaySchema = new mongoose.Schema({
  date:     { type: String, required: true, unique: true }, // 'YYYY-MM-DD' — unique already creates the index
  name:     { type: String, required: true },
  type:     { type: String, enum: ['public', 'state', 'restricted'], default: 'public' },
  added_by: { type: String, ref: 'User', default: null },
}, { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' } });
// NOTE: no explicit schema.index({ date: 1 }) — unique:true above already creates it
const Holiday = mongoose.model('Holiday', holidaySchema);

// ── ODA (On-Duty Away) Requests ────────────────────────────────────────────
const odaRequestSchema = new mongoose.Schema({
  _id:           { type: String },
  emp_id:        { type: String, ref: 'User', required: true },
  from_date:     { type: String, required: true },   // 'YYYY-MM-DD'
  to_date:       { type: String, required: true },   // 'YYYY-MM-DD'
  duty_type:     { type: String, enum: ['Training', 'Head Office Visit', 'District Meeting', 'Election Duty', 'Other'], required: true },
  district:      { type: String, required: true }, // geofence for the ODA duration is restricted to this district
  location_name: { type: String, required: true },
  reason:        { type: String, required: true },
  status:        { type: String, enum: ['pending', 'approved', 'rejected'], default: 'pending' },
  approved_by:   { type: String, ref: 'User', default: null },
  admin_remark:  { type: String, default: null },
  actioned_at:   { type: Date, default: null },
}, { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' } });
odaRequestSchema.index({ emp_id: 1, status: 1 });
odaRequestSchema.index({ from_date: 1, to_date: 1 });
odaRequestSchema.index({ status: 1 });
const ODARequest = mongoose.model('ODARequest', odaRequestSchema);

// ── Connect ───────────────────────────────────────────────────────────────

const connectionPromise = mongoose.connect(MONGO_URI, {
  maxPoolSize:             100,
  minPoolSize:               5,
  serverSelectionTimeoutMS: 8000,
  socketTimeoutMS:          45000,
  connectTimeoutMS:         10000,
  heartbeatFrequencyMS:     10000,
  retryWrites:               true,
  retryReads:                true,
})
  .then(() => console.log('✅ MongoDB Atlas connected (pool: 5–100)'))
  .catch(err => { console.error('❌ MongoDB connection error:', err); process.exit(1); });

module.exports = {
  User,
  AttendanceRecord,
  Notification,
  AuditLog,
  RevokedToken,
  Activity,
  ActivityDocument,
  MsmeMaster,
  MsmeProposal,
  CustomOption,
  CustomBlock,
  connectionPromise,
  ActivitySchedule,
  ScheduleDocument,
  GeoCache,
  CustomDepartment,
  ODARequest,
  MonthlyReport,
  Holiday,
};