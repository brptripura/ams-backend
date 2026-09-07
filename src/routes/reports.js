
'use strict';

const express  = require('express');
const router   = express.Router();
const ExcelJS  = require('exceljs');
const PDFDoc   = require('pdfkit');
const { PDFDocument: MergePDFDocument, StandardFonts, rgb } = require('pdf-lib');
const mongoose = require('mongoose');
const { AttendanceRecord, User, Holiday } = require('../models/database');
const { fmt12h } = require('../utils/time');
const { authenticate, authorize } = require('../middleware/auth');
const https = require('https');
const _geocodeCache = new Map(); // "lat,lng" (4dp) -> address string

const _roundCoord = n => Math.round(Number(n) * 10000) / 10000; // ~11m precision, good cache hit rate

const reverseGeocode = (lat, lng) => new Promise(resolve => {
  if (lat == null || lng == null || isNaN(lat) || isNaN(lng)) return resolve('');
  const rLat = _roundCoord(lat), rLng = _roundCoord(lng);
  const key = `${rLat},${rLng}`;
  if (_geocodeCache.has(key)) return resolve(_geocodeCache.get(key));

  const url = `https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${rLat}&lon=${rLng}&zoom=17&addressdetails=0`;
  const req = https.get(url, { headers: { 'User-Agent': 'RAMP-AMS/1.0 (attendance reports)' }, timeout: 4000 }, resp => {
    let data = '';
    resp.on('data', c => data += c);
    resp.on('end', () => {
      try {
        const parsed = JSON.parse(data);
        const addr = parsed?.display_name || '';
        _geocodeCache.set(key, addr);
        resolve(addr);
      } catch { resolve(''); }
    });
  });
  req.on('error', () => resolve(''));
  req.on('timeout', () => { req.destroy(); resolve(''); });
});
const buildLocationText = async (storedAddress, lat, lng) => {
  const hasCoords = lat != null && lng != null && !isNaN(lat) && !isNaN(lng);
  const coordStr  = hasCoords ? `${Number(lat).toFixed(5)}, ${Number(lng).toFixed(5)}` : '';

  // If the stored address already looks like real text (not just numbers/coords), use it.
  const looksLikeRawCoords = storedAddress && /^-?\d+\.\d+,\s*-?\d+\.\d+$/.test(storedAddress.trim());
  let addressText = (storedAddress && !looksLikeRawCoords) ? storedAddress.trim() : '';

  if (!addressText && hasCoords) {
    addressText = await reverseGeocode(lat, lng);
  }

  if (addressText && coordStr) return `${addressText} (${coordStr})`;
  if (addressText)             return addressText;
  if (coordStr)                return coordStr;
  return '';
};
const isLocationUnresolved = addr => {
  const s = String(addr || '').trim();
  if (!s) return true;
  if (/^fetching/i.test(s)) return true;
  if (/^location unavailable$/i.test(s)) return true;
  if (/^gps unavailable$/i.test(s)) return true;
  if (/^-?\d+\.\d+,\s*-?\d+\.\d+$/.test(s)) return true; // "12.97160, 77.59460"
  return false;
};
const locationFetchingDates = (recs, empIdStr) => {
  const today = todayIST();
  return [...new Set(
    recs.filter(r =>
      String(r.emp_id) === empIdStr &&
      r.checkin_time &&
      r.date < today &&   // ← skip today; employee may still be mid-shift
      ['Office Duty', 'On Duty', 'On Duty Away'].includes(r.duty_type) &&
      isLocationUnresolved(r.location_address)
    ).map(r => r.date)
  )].sort();
};
// ── IST helpers ───────────────────────────────────────────────────────────────
const IST      = 'Asia/Kolkata';
const todayIST = () => new Date().toLocaleDateString('en-CA', { timeZone: IST });
const toObjId  = id => { try { return new mongoose.Types.ObjectId(String(id)); } catch { return id; } };

const expandDates = (start, end) => {
  const out = [];
  let cur = new Date(start+'T00:00:00+05:30');
  const fin = new Date(end +'T00:00:00+05:30');
  while (cur <= fin) {
    out.push(cur.toLocaleDateString('en-CA', { timeZone: IST }));
    cur.setDate(cur.getDate()+1);
  }
  return out;
};

const HOLIDAYS_MMDD = new Set([
  '01-14','01-23','01-26','03-04','03-21','04-03','04-14','04-15','04-21',
  '05-01','05-26','05-27','06-26','07-22','08-04','08-15','08-19','08-26',
  '09-04','10-02','10-17','10-19','10-20','10-21','10-22','10-23','10-26',
  '11-09','12-25',
]);
const RESTRICTED_MMDD = new Set([
  '01-01','03-03','03-25','03-31','06-20','07-16','08-12','08-28',
  '09-11','09-18','11-11','11-24','12-03','12-24',
]);

// Dynamic holiday cache from the admin-managed Holiday collection (refreshed
// hourly), falling back to the static list only when the cache is cold —
// same pattern as attendance.js's isLeaveNonWorking, so reports stay in sync
// with whatever holidays are actually configured instead of a fixed list.
let _repHolCache = null;
let _repHolCacheAt = 0;
const refreshRepHolCache = async () => {
  try {
    const rows = await Holiday.find({}, { date: 1, _id: 0 }).lean();
    _repHolCache = new Set(rows.map(h => h.date));
    _repHolCacheAt = Date.now();
  } catch { /* keep using static */ }
};
refreshRepHolCache();

const isHoliday = iso => {
  if (_repHolCache && Date.now() - _repHolCacheAt < 3600000) return _repHolCache.has(iso);
  refreshRepHolCache().catch(() => {});
  const mmdd = iso.substring(5);
  return HOLIDAYS_MMDD.has(mmdd) || RESTRICTED_MMDD.has(mmdd);
};

// const getNthSaturday = iso => {
//   const d = new Date(iso + 'T00:00:00+05:30');
//   if (d.getDay() !== 6) return 0;
//   let count = 0;
//   for (let i = 1; i <= d.getDate(); i++) {
//     if (new Date(d.getFullYear(), d.getMonth(), i).getDay() === 6) count++;
//   }
//   return count;
// };

// const isNonWorkingDay = iso => {
//   const dow = new Date(iso + 'T00:00:00+05:30').getDay();
//   if (dow === 0) return true;                          // Sunday
//   if (dow === 6) return true;
//   return false;
// };

// ── Timezone-safe date component helpers ───────────────────────────────
// iso is always "YYYY-MM-DD" (already IST-normalized by expandDates/etc).
// NEVER call Date#getDate()/getDay()/getFullYear() on a Date built from
// an ISO+offset string without {timeZone:IST} — those getters read the
// SERVER's local clock, not IST, and silently drift by a day on a host
// that isn't set to Asia/Kolkata (e.g. any UTC cloud server).
const isoParts = iso => iso.split('-').map(Number);           // [YYYY, MM, DD]
const isoDay   = iso => isoParts(iso)[2];
const isoYear  = iso => isoParts(iso)[0];
const isoDow   = iso => {                                     // 0=Sun..6=Sat, timezone-independent
  const [y, m, d] = isoParts(iso);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
};

const isNonWorkingDay = iso => {
  const dow = isoDow(iso);
  return dow === 0 || dow === 6;                               // Sunday or Saturday
};
const isWeekend = iso => isNonWorkingDay(iso); // kept for PDF total WO count
const dayNum    = iso => isoDay(iso);
const monAbbr   = iso => new Date(iso+'T00:00:00+05:30').toLocaleDateString('en-IN',{timeZone:IST,month:'short'});
const dayAbbr   = iso => new Date(iso+'T00:00:00+05:30').toLocaleDateString('en-IN',{timeZone:IST,weekday:'short'});
const ordinal   = n   => { const s=['th','st','nd','rd'],v=n%100; return n+(s[(v-20)%10]||s[v]||s[0]); };
const colLetter = n   => { let s='',c=n; while(c>0){s=String.fromCharCode(65+(c-1)%26)+s;c=Math.floor((c-1)/26);} return s; };

// 0-based position of targetISO among the WORKING days (not WO/H) starting
// from startISO, exclusive of targetISO itself. Used to split a partially-
// paid leave's date range into its paid ('L') and unpaid ('LOP') days —
// paid_days/lop_days on the record are working-day counts (see
// leaveDayUnits() in attendance.js), and the matrix only ever calls toCode()
// for working days to begin with (WO/H are assigned before toCode() runs),
// so this index lines up with that count exactly.
const workingDayIndexInRange = (startISO, targetISO) => {
  let idx = 0;
  let cur = new Date(startISO + 'T00:00:00+05:30');
  const tgt = new Date(targetISO + 'T00:00:00+05:30');
  while (cur < tgt) {
    const iso = cur.toLocaleDateString('en-CA', { timeZone: IST });
    if (!isNonWorkingDay(iso) && !isHoliday(iso)) idx++;
    cur.setDate(cur.getDate() + 1);
  }
  return idx;
};

/**
 * toCode — determines cell code for one attendance record
 */
// ── reports.js  ·  toCode() ───────────────────────────────────────────────
// UPDATED LOGIC (see also excel/PDF summary + legend below, which mirror this):
//   • Pending leave → 'LA' (Leave Applied), regardless of balance — the
//     manager hasn't decided yet, so it's neither counted as Leave nor LOP.
//   • Approved leave → 'L' for its paid days, 'LOP' for any days beyond what
//     balance covered (paid_days/lop_days, set at application time — POST
//     /apply-leave's balance-check logic). A day's L-vs-LOP split within the
//     leave is by position in the range: the first paid_days working days
//     are 'L', the rest are 'LOP'.
//   • Rejected leave with no re-check-in → 'LOP' throughout (never became a
//     real leave, so none of it counts as paid).
//   • Rejected leave WITH a re-check-in → falls through to normal attendance
//     (the employee actually came in after the rejection).
const toCode = (rec, assignedBlock, assignedDistrict, iso) => {
  if (!rec) return 'A';

  // ── Leave records ──────────────────────────────────────────────────────────
  const isLeave = rec.duty_type === 'Leave' || (rec.leave_type && String(rec.leave_type).trim());
  if (isLeave) {
    const ls = rec.leave_status || rec.status || 'Pending';

    if (ls === 'Pending') return 'LA';

    if (ls === 'Approved') {
      // paid_days is undefined (not 0) on records from before partial-LOP
      // support existed — treat those as fully paid rather than guessing.
      if (rec.lop_days > 0 && rec.paid_days != null && iso) {
        const dayIdx = workingDayIndexInRange(rec.date, iso);
        return dayIdx >= rec.paid_days ? 'LOP' : 'L';
      }
      return 'L';
    }

    if (ls === 'Rejected' && !(rec.checkin_time || rec.checkinTime)) return 'LOP';
    // Rejected WITH a re-check-in → falls through to normal attendance below.
  }

  // ── Regular attendance ─────────────────────────────────────────────────────
  if (rec.status === 'Rejected') return 'A';

  // duty_type drives P vs OD.
  const dutyType = (rec.duty_type || '').trim();

  // On Duty Away filed without a pre-approved ODA request sits Pending until
  // the manager acts on it (see POST /checkin's odaPending branch) — blank
  // until then, same convention as a Pending leave, rather than counting as
  // OD before it's actually approved.
  if (dutyType === 'On Duty Away' && rec.status === 'Pending') return '';

  if (dutyType === 'On Duty' || dutyType === 'On Duty Away') return 'OD';

  // Office Duty (or blank/unknown) — check-in is geofenced to the employee's
  // assigned block already (POST /checkin rejects a check-in more than 200m
  // away), so a resolved check-in here is always at the assigned workplace.
  // No further location-text verification needed — the old LOC_ERR fallback
  // (address text didn't match / GPS failed) is retired for the same reason.
  return 'P';
};
// ══════════════════════════════════════════════════════════════════════════════
//  GET /api/reports/export
//  Attendance matrix export (Excel / PDF)
//  Supports:  empId, managerId  query params for HR / super_admin filtered downloads
// ══════════════════════════════════════════════════════════════════════════════
router.get('/export',
  authenticate,
  authorize('super_admin','admin','hr','manager','employee'),
  async (req, res) => {
  try {
    const { format='excel', empId, managerId } = req.query;
    const role = req.user.role;
    let { startDate, endDate } = req.query;

    if (!startDate||!endDate)
      return res.status(400).json({success:false,message:'startDate and endDate are required'});

    // Future/today dates are allowed — they render as blank (or WO/H) in the
    // matrix below since attendance hasn't happened yet, rather than being cut off.
    if (startDate > endDate)
      return res.status(400).json({success:false,message:'Start date must be on or before end date.'});

    const dates      = expandDates(startDate, endDate);
    const totalDays  = dates.length;
 const woCount    = dates.filter(isNonWorkingDay).length;
    const holCount   = dates.filter(d => !isNonWorkingDay(d) && isHoliday(d)).length;
    // ── Employee list ──────────────────────────────────────────────────────────
    // Priority: employee (own) → specific empId → managerId team → manager (own team) → all
    let employees = [];

    const EMP_SELECT = '_id name emp_id created_at assigned_block assigned_district role_type designation';

    if (role === 'employee') {
      // Always own record only
      const me = await User.findById(req.user.id)
        .select(EMP_SELECT).lean();
      if (me) employees = [me];

    } else if (empId && String(empId).trim() !== '') {
      // Specific employee selected in dropdown — a manager may only pull a
      // report for their own reportee, never an arbitrary employee id.
      const specificFilter = role === 'manager'
        ? { _id: toObjId(empId), manager_id: toObjId(req.user.id) }
        : { _id: toObjId(empId) };
      const specific = await User.findOne(specificFilter)
        .select(EMP_SELECT).lean();
      if (specific) employees = [specific];
      else return res.status(404).json({success:false,message:'Selected employee not found'});

    } else if (managerId && String(managerId).trim() !== '') {
      // Manager's entire team selected (HR / super_admin / admin use-case)
      employees = await User.find({ manager_id:toObjId(managerId), is_active:{$ne:false} })
        .select(EMP_SELECT).sort({emp_id:1}).lean();

    } else if (role === 'manager') {
      // Manager viewing own team
      employees = await User.find({ manager_id:toObjId(req.user.id), is_active:{$ne:false} })
        .select(EMP_SELECT).sort({emp_id:1}).lean();

    } else {
      // admin / hr / super_admin — all employees
      employees = await User.find({ role:'employee', is_active:{$ne:false} })
        .select(EMP_SELECT).sort({emp_id:1}).lean();
    }

    if (!employees.length)
      return res.status(404).json({success:false,message:'No employees found'});

    // ── Manager / Reporting Officer name for signature ──────────────────────────
    let managerName = '';
    if (role === 'manager') {
      const mgr = await User.findById(req.user.id).select('name').lean();
      managerName = mgr?.name || '';
    } else if (role === 'employee') {
      // FIX: employee's own download must show their Reporting Officer
      // (set on the employee's profile page), NOT the assigned BRP manager.
      const emp = await User.findById(req.user.id)
        .select('reporting_officer_name reporting_officer_designation').lean();
      managerName = emp?.reporting_officer_name
        ? (emp.reporting_officer_designation
            ? `${emp.reporting_officer_designation}. ${emp.reporting_officer_name}`
            : emp.reporting_officer_name)
        : '';
    } else if (managerId && String(managerId).trim() !== '') {
      // HR/super_admin filtered by a specific manager — show that manager's name
      const mgr = await User.findById(toObjId(managerId)).select('name').lean();
      managerName = mgr?.name || '';
    }
    // admin/hr/super_admin without manager filter → no single manager; leave blank

    // ── Attendance records ─────────────────────────────────────────────────────
    // NOTE: intentionally NOT filtering by `status` here (unlike some other
    // routes in this file) — this matrix needs every record for every day
    // regardless of its status, since toCode() below already classifies each
    // cell correctly from the record's own status/leave_status (LA/L/LOP/A/
    // P/OD). Filtering the query by status made a Pending leave (or one that
    // had just been Approved) vanish from the query entirely whenever the
    // report was requested with a status filter other than 'All' — the cell
    // then had no record at all and fell back to 'A' (Absent), even though
    // the leave was genuinely pending/approved.
    // A multi-day leave/OD record is stored once, dated at its START day —
    // filtering purely on `date >= startDate` misses a leave that started
    // before the requested range but still spans into it (e.g. a leave
    // starting Aug 31 covering Sept 1-3, requested with startDate=Sept 1
    // would otherwise vanish from the query and those days would wrongly
    // read as Absent). Pull in anything whose span OVERLAPS the range.
    const recFilter = {
      emp_id: {$in:employees.map(e=>e._id)},
      date:   {$lte:endDate},
      $or: [
        { end_date: null, date: {$gte:startDate} },
        { end_date: {$gte:startDate} },
      ],
    };
    const rawRecs = await AttendanceRecord.find(recFilter).sort({date:1}).lean();

    // Build index — prefer real check-in records over rejected leave records for the same date.
    // A multi-day leave (duty_type:'Leave' with end_date set) is stored as ONE record whose
    // `date` field is only the start day — index it at every day in [date, end_date], not just
    // the start, or every day after the first silently reads as Absent in the matrix below.
   const recIdx = {};
for (const r of rawRecs) {
  const eid = String(r.emp_id);
  if (!recIdx[eid]) recIdx[eid] = {};

  const isMultiDayLeave =
    (r.duty_type === 'Leave' || (r.leave_type && String(r.leave_type).trim())) &&
    r.end_date && r.end_date > r.date;

  const spanDates = isMultiDayLeave ? expandDates(r.date, r.end_date) : [r.date];

  spanDates.forEach(d => {
    const existing = recIdx[eid][d];
    const existingIsRejectedLeave =
      existing &&
      (existing.duty_type === 'Leave' || (existing.leave_type && String(existing.leave_type).trim())) &&
      (existing.leave_status === 'Rejected' || existing.status === 'Rejected');
    if (!existing || existingIsRejectedLeave) {
      recIdx[eid][d] = r;
    }
  });
}

    // ── Build cell matrix ──────────────────────────────────────────────────────
    const todayReport = todayIST();
    const matrix = employees.map(emp => {
      const joinDate = emp.created_at
        ? new Date(emp.created_at).toLocaleDateString('en-CA', { timeZone: IST })
        : null;
      const ab = emp.assigned_block    || null;
      const ad = emp.assigned_district || null;

    return {
        emp,
        cells: dates.map(iso => {
          if (isNonWorkingDay(iso))           return 'WO'; // Sunday or 2nd/4th Sat
          if (isHoliday(iso))                 return 'H';  // public holiday
          if (iso > todayReport)              return '';   // future — hasn't happened yet
          if (joinDate && iso < joinDate)     return '';   // pre-join → blank
          const rec = recIdx[String(emp._id)]?.[iso];
          return toCode(rec, ab, ad, iso);
        }),
      };
    });
       const rangeTitle =
      `for the period ${ordinal(isoDay(startDate))} ` +
      `${monAbbr(startDate)}- ${isoYear(startDate)} To ` +
      `${ordinal(isoDay(endDate))} ${new Date(endDate+'T00:00:00+05:30').toLocaleDateString('en-IN',{timeZone:IST,month:'long'})} ${isoYear(endDate)}`;

    // ══════════════════════════════════════════════════════════════════════════
    //  EXCEL
    // ══════════════════════════════════════════════════════════════════════════
    if (format==='excel') {
      const wb = new ExcelJS.Workbook(); wb.creator='RAMP AMS'; wb.calcProperties = { fullCalcOnLoad: true };

      const FILL_RED  = {type:'pattern',pattern:'solid',fgColor:{argb:'FFFF4444'}};
      const FILL_WO   = {type:'pattern',pattern:'solid',fgColor:{argb:'FFBDD7EE'}};
      const FILL_WHT  = {type:'pattern',pattern:'solid',fgColor:{argb:'FFFFFFFF'}};
      const FILL_ALT  = {type:'pattern',pattern:'solid',fgColor:{argb:'FFF7F7F7'}};
      const FILL_SUBH = {type:'pattern',pattern:'solid',fgColor:{argb:'FFE8EDF4'}};
const FILL_HOL  = {type:'pattern',pattern:'solid',fgColor:{argb:'FFFFF3CD'}};
      const FILL_LOP  = {type:'pattern',pattern:'solid',fgColor:{argb:'FF991B1B'}}; // darker than plain L/A red — matches the LOP summary column's color
      const FILL_LA   = {type:'pattern',pattern:'solid',fgColor:{argb:'FFFDE68A'}}; // amber — "awaiting decision", distinct from paid L / unpaid LOP
      const codeFill = (code, rf) => {
        if (code==='LOP')           return FILL_LOP;
        if (code==='LA')            return FILL_LA;
        if (code==='L'||code==='A') return FILL_RED;
        if (code==='WO')            return FILL_WO;
        if (code==='H')             return FILL_HOL;
        return rf;
      };
    const TH  = ()=>({style:'thin',  color:{argb:'FFCCCCCC'}});
      const MED = ()=>({style:'medium',color:{argb:'FF999999'}});
      const CBDR = {top:TH(),bottom:TH(),left:TH(),right:TH()};
      const mc  = (ws,r1,c1,r2,c2)=>ws.mergeCells({top:r1,left:c1,bottom:r2,right:c2});
      const outerBorder = (ws,r1,c1,r2,c2)=>{
        for(let r=r1;r<=r2;r++) for(let c=c1;c<=c2;c++)
          ws.getCell(r,c).border={
            top:   r===r1?MED():TH(), bottom:r===r2?MED():TH(),
            left:  c===c1?MED():TH(), right: c===c2?MED():TH(),
          };
      };
  const buildSheet = (ws, empList, sheetTitle, mgrName,hCount=0) => {
        const LAST = 4+dates.length;

        // ── Rows 1-3: header ──────────────────────────────────────────────────
        mc(ws,1,2,1,LAST);
        Object.assign(ws.getCell(1,2),{value:'Attendance details of BRP',font:{bold:true,size:13,name:'Calibri'},alignment:{horizontal:'center',vertical:'center'}});
        ws.getRow(1).height=24;

        mc(ws,2,2,2,LAST);
        Object.assign(ws.getCell(2,2),{value:rangeTitle,font:{bold:true,size:11,name:'Calibri'},alignment:{horizontal:'center',vertical:'center'}});
        ws.getRow(2).height=18;

        const half=2+Math.floor(dates.length/2);
        mc(ws,3,2,3,half-1);
        Object.assign(ws.getCell(3,2),{value:'Location Name: Tripura',font:{bold:true,size:10,name:'Calibri'},alignment:{horizontal:'left',vertical:'center'}});
        mc(ws,3,half,3,LAST);
        Object.assign(ws.getCell(3,half),{value:'Project Name: Block Resource Person',font:{bold:true,size:10,name:'Calibri'},alignment:{horizontal:'left',vertical:'center'}});
        ws.getRow(3).height=16;

        // ── Row 4: column headers ─────────────────────────────────────────────
        ws.getRow(4).height=38;
        ws.getColumn(2).width=9; ws.getColumn(3).width=16; ws.getColumn(4).width=14;
        const HF={bold:true,size:9,color:{argb:'FF3366FF'},name:'Calibri'};
        const setHdr=(col,val)=>{
          const c=ws.getCell(4,col); c.value=val; c.font=HF; c.fill=FILL_WHT; c.border=CBDR;
          c.alignment={horizontal:'center',vertical:'center',wrapText:col>4};
          ws.getColumn(col).width=col===2?9:col===3?16:col===4?14:4.2;
        };
        setHdr(2,'Emp code'); setHdr(3,'Employee Name'); setHdr(4,'Designation');
        dates.forEach((iso,i)=>setHdr(5+i,`${dayNum(iso)}\n${dayAbbr(iso)}\n${monAbbr(iso)}`));

        // ── Data rows ─────────────────────────────────────────────────────────
        empList.forEach(({emp,cells},idx)=>{
          const rowN=5+idx; ws.getRow(rowN).height=15;
          const rf=idx%2===0?FILL_WHT:FILL_ALT;
          const c2=ws.getCell(rowN,2); c2.value=emp.emp_id; c2.border=CBDR; c2.fill=rf; c2.alignment={horizontal:'center',vertical:'center',wrapText:false}; c2.font={size:10,name:'Calibri'}; c2.protection={locked:true};
          const c3=ws.getCell(rowN,3); c3.value=emp.name;   c3.border=CBDR; c3.fill=rf; c3.alignment={horizontal:'left',  vertical:'center',wrapText:false}; c3.font={size:10,name:'Calibri'}; c3.protection={locked:true};
          const c4=ws.getCell(rowN,4); c4.value=emp.role_type||emp.designation||''; c4.border=CBDR; c4.fill=rf; c4.alignment={horizontal:'center',vertical:'center',wrapText:false}; c4.font={size:9,name:'Calibri'}; c4.protection={locked:true};
         cells.forEach((code,i)=>{
            const c=ws.getCell(rowN,5+i); c.border=CBDR;
            c.alignment={horizontal:'center',vertical:'center',wrapText:false};
            c.fill=codeFill(code,rf); c.protection={locked:true};

            c.value = code;
            c.font = {bold:!!code,size:code==='LOP'?7:9,name:'Calibri',color:{argb:(code==='L'||code==='A'||code==='LOP')?'FFFFFFFF':'FF000000'}};
          });
        });

        // ── Legend ────────────────────────────────────────────────────────────
        const legendRow=5+empList.length+1; ws.getRow(legendRow).height=14;
       const FILL_AMB = {type:'pattern',pattern:'solid',fgColor:{argb:'FFFFF3CD'}};
        const legendItems = [
         {code:'P',label:'Present (assigned location)',isRed:false},
         {code:'OD',label:'On Duty (other Tripura location)',isRed:false},
         {code:'H',label:'Public Holiday',isRed:false,isAmber:true},
         {code:'LA',label:'Leave Applied (awaiting approval)',isLa:true},
         {code:'L',label:'Leave (paid)',isRed:true},
         {code:'LOP',label:'Leave without Pay',isLop:true},
         {code:'A',label:'Absent',isRed:true},
         {code:'WO',label:'Week Off',isRed:false},
        ];
        legendItems.forEach(({code,label,isRed,isAmber,isLop,isLa},i)=>{
          const cc=ws.getCell(legendRow,5+i*2);
          cc.border=CBDR;
          cc.alignment={horizontal:'center',vertical:'center'};
          cc.value=code; cc.fill=isLop?FILL_LOP:isLa?FILL_LA:isRed?FILL_RED:isAmber?FILL_AMB:FILL_WHT;
          cc.font={bold:true,size:8,name:'Calibri',color:{argb:(isRed||isLop)?'FFFFFFFF':isAmber?'FFD97706':isLa?'FF92400E':'FF000000'}};
          ws.getCell(legendRow,5+i*2+1).value=label;
          ws.getCell(legendRow,5+i*2+1).font={size:8,name:'Calibri',italic:true};
        });
        // A leave application shows LA until the manager decides — L if
        // approved, LOP if rejected. A blank cell (not WO/H) now only means
        // an unapproved On Duty Away check-in, a future date, or a day
        // before the employee joined.
        const legendNoteRow = legendRow + 1;
        ws.getRow(legendNoteRow).height = 12;
        mc(ws, legendNoteRow, 5, legendNoteRow, LAST);
        Object.assign(ws.getCell(legendNoteRow, 5), {
          value: 'Blank cell (not WO/H) = unapproved On Duty Away, a future date, or before joining. A leave application shows LA until the manager decides — L if approved, LOP if rejected.',
          font: { size: 8, italic: true, color: { argb: 'FF64748B' }, name: 'Calibri' },
          alignment: { horizontal: 'left', vertical: 'center' },
        });
        // ── Summary ───────────────────────────────────────────────────────────
        const fDC=colLetter(5), lDC=colLetter(4+dates.length);
        let r=legendRow+2; const SR=r;
        ws.getColumn(2).width=28; ws.getColumn(3).width=12;
        const TF={bold:true,size:11,color:{argb:'FFC00000'},name:'Calibri'};
        const LF={bold:true,size:10,color:{argb:'FF1F3864'},name:'Calibri'};

        mc(ws,r,2,r,3);
        Object.assign(ws.getCell(r,2),{value:sheetTitle,fill:FILL_WHT,font:TF,alignment:{horizontal:'center',vertical:'center'}});
        ws.getRow(r).height=18;

        const sumRow=(label,value)=>{
          r++; ws.getRow(r).height=16;
          Object.assign(ws.getCell(r,2),{value:label,fill:FILL_WHT,font:LF,alignment:{horizontal:'left',vertical:'center'}});
          const vc=ws.getCell(r,3);
          const isF=typeof value==='string'&&value.startsWith('=');
          vc.value=isF?{formula:value.slice(1)}:value;
          vc.fill=FILL_WHT; vc.font=LF; vc.alignment={horizontal:'center',vertical:'center'}; vc.protection={locked:true};
        };

        sumRow('No of Total Days',totalDays);
        sumRow('No of Weekoff (WO)',woCount);
        sumRow('No of Holidays (H)',hCount);
        sumRow('No of Working Days',totalDays-woCount-hCount);

        if(empList.length===1){
  const er=5;
  const empIdStr = String(empList[0].emp._id);

  // Pull this employee's leave-type records for the date range
  const empLeaveRecs = rawRecs.filter(r =>
    String(r.emp_id) === empIdStr &&
    (r.duty_type === 'Leave' || (r.leave_type && String(r.leave_type).trim()))
  );

  const byType = t => empLeaveRecs.filter(r => String(r.leave_type||'').toLowerCase().includes(t));
  const halfDayRecs   = byType('half');
  const emergencyRecs = byType('emergency');
  const casualRecs    = byType('casual');
  const pendingRecs   = empLeaveRecs.filter(r => (r.leave_status || r.status || 'Pending') === 'Pending');

  // Working-day span of a leave record — mirrors the matrix cell logic
  // above (WO/H checked before the leave record, so those days render as
  // WO/H, not L). A record's own `date` field is only the START day; a
  // multi-day leave needs every day in [date, end_date] counted, not 1.
  const leaveDaySpan = r => {
    if (!r.end_date || r.end_date <= r.date) return 1;
    return expandDates(r.date, r.end_date).filter(d => !isNonWorkingDay(d) && !isHoliday(d)).length;
  };
  const sumDays = recs => recs.reduce((s, r) => s + leaveDaySpan(r), 0);

  // Effective leave days: matches toCode()'s L logic, half-day counts as 0.5/day
  const effectiveLeaves = empLeaveRecs.reduce((sum, r) => {
    const ls = r.leave_status || r.status || 'Pending';
    if (ls === 'Pending') return sum;
    const isHalf = String(r.leave_type||'').toLowerCase().includes('half');
    const hasCheckin = r.checkin_time || r.checkinTime;
    const days = leaveDaySpan(r) * (isHalf ? 0.5 : 1);
    if (ls === 'Approved') return sum + days; // approved leave always counts (matches toCode's unconditional 'L')
    if (ls === 'Rejected') return hasCheckin ? sum : sum + days;
    return sum;
  }, 0);
  sumRow('No of Present / worked (P+OD)', `=COUNTIF(${fDC}${er}:${lDC}${er},"P")+COUNTIF(${fDC}${er}:${lDC}${er},"OD")`);
  sumRow('No of Leaves (L)', `=COUNTIF(${fDC}${er}:${lDC}${er},"L")`);
  sumRow('No of LOP', `=COUNTIF(${fDC}${er}:${lDC}${er},"LOP")`);
  sumRow('No of Half Day Leaves (each = 0.5 day)', sumDays(halfDayRecs));
  sumRow('No of Emergency Leaves', sumDays(emergencyRecs));
  sumRow('No of Casual Leaves', sumDays(casualRecs));
  sumRow('Total Effective Leaves', effectiveLeaves);
  sumRow('No of Absent (A)', `=COUNTIF(${fDC}${er}:${lDC}${er},"A")`);
  sumRow('No of Leave Applied / Pending (LA)', pendingRecs.length);
  // 📍 Location Pending — manager/admin/hr/super_admin visibility only,
  if (role !== 'employee') {
    const locDates = locationFetchingDates(rawRecs, empIdStr);
    sumRow('📍 Location Fetching (days)', locDates.length);
    if (locDates.length) {
      r++; ws.getRow(r).height = 26;
      mc(ws, r, 2, r, 3);
      Object.assign(ws.getCell(r, 2), {
        value: `📍 ${locDates.join(', ')}`,
        fill: FILL_WHT,
        font: { size: 8, italic: true, color: { argb: 'FF64748B' }, name: 'Calibri' },
        alignment: { horizontal: 'left', vertical: 'center', wrapText: true },
      });
    }
  }
        } else {
          // ── Table header row ────────────────────────────────────────────────
          // Column order: Employee, Present, Absent, Week Off, Holidays,
          // Leaves, LOP, Total Month Days, [Location].
          r++; ws.getRow(r).height = 17;
          ws.getColumn(2).width = 32; ws.getColumn(3).width = 14; // Employee Name — was clipping longer names
          ws.getColumn(4).width = 14; ws.getColumn(5).width = 14;
          ws.getColumn(6).width = 12; ws.getColumn(7).width = 12;
          ws.getColumn(8).width = 12; ws.getColumn(9).width = 16;
          if (role !== 'employee') ws.getColumn(10).width = 70; // Location Pending dates list — wide enough for a long comma-separated date list to wrap onto just 1-2 lines instead of many

          const headerCols = [
            ['Employee Name','FF1F3864'], ['Present / Worked','FF047857'], ['No of Absent','FFB91C1C'],
            ['Week Off','FF2563EB'], ['Holidays','FFD97706'],
            ['No of Leaves','FFB45309'], ['LOP','FF991B1B'],
            ['Total Month Days (P+A+WO+H+LA+L+LOP)','FF1F3864'],
          ];
          if (role !== 'employee') headerCols.push(['📍 Location Fetching','FF0369A1']);

          headerCols.forEach(([hdr, argb], i) => {
            const c = ws.getCell(r, 2 + i);
            c.value = hdr; c.fill = FILL_SUBH; c.border = CBDR;
            c.font = { bold: true, size: 10, color: { argb }, name: 'Calibri' };
            c.alignment = { horizontal: 'center', vertical: 'center', wrapText: true };
          });

          // ── One row per employee ────────────────────────────────────────────
          empList.forEach(({ emp }, idx) => {
            r++; ws.getRow(r).height = role !== 'employee' ? 32 : 15; // taller — date list may wrap onto 2+ lines
            const rf  = idx % 2 === 0 ? FILL_WHT : FILL_ALT;
            const er  = 5 + idx;
            const rowNum = r;

            const cn = ws.getCell(r, 2);
            cn.value = emp.name; cn.fill = rf; cn.border = CBDR;
            cn.font = { size: 10, name: 'Calibri' };
            cn.alignment = { horizontal: 'left', vertical: 'center', wrapText: true };

            const cp = ws.getCell(r, 3);
            cp.value = { formula: `COUNTIF(${fDC}${er}:${lDC}${er},"P")+COUNTIF(${fDC}${er}:${lDC}${er},"OD")` };
            cp.fill = rf; cp.border = CBDR;
            cp.font = { bold: true, size: 10, name: 'Calibri', color: { argb: 'FF047857' } };
            cp.alignment = { horizontal: 'center', vertical: 'center' };
            cp.protection = { locked: true };

            const ca = ws.getCell(r, 4);
            ca.value = { formula: `COUNTIF(${fDC}${er}:${lDC}${er},"A")` };
            ca.fill = rf; ca.border = CBDR;
            ca.font = { bold: true, size: 10, name: 'Calibri', color: { argb: 'FFB91C1C' } };
            ca.alignment = { horizontal: 'center', vertical: 'center' };
            ca.protection = { locked: true };

            const cwo = ws.getCell(r, 5);
            cwo.value = { formula: `COUNTIF(${fDC}${er}:${lDC}${er},"WO")` };
            cwo.fill = rf; cwo.border = CBDR;
            cwo.font = { bold: true, size: 10, name: 'Calibri', color: { argb: 'FF2563EB' } };
            cwo.alignment = { horizontal: 'center', vertical: 'center' };
            cwo.protection = { locked: true };

            const chol = ws.getCell(r, 6);
            chol.value = { formula: `COUNTIF(${fDC}${er}:${lDC}${er},"H")` };
            chol.fill = rf; chol.border = CBDR;
            chol.font = { bold: true, size: 10, name: 'Calibri', color: { argb: 'FFD97706' } };
            chol.alignment = { horizontal: 'center', vertical: 'center' };
            chol.protection = { locked: true };

            const empIdStr = String(emp._id);

            const cl = ws.getCell(r, 7);
            cl.value = { formula: `COUNTIF(${fDC}${er}:${lDC}${er},"L")` };
            cl.fill = rf; cl.border = CBDR;
            cl.font = { bold: true, size: 10, name: 'Calibri', color: { argb: 'FFB45309' } };
            cl.alignment = { horizontal: 'center', vertical: 'center' };
            cl.protection = { locked: true };

            // LOP has its own grid cell code ('LOP', see toCode()) for a
            // partially-paid leave's unpaid days — counted the same way as
            // every other column here, and guaranteed not to overlap with
            // Leaves ('L') or Pending (blank) since each day gets exactly
            // one code.
            const clop = ws.getCell(r, 8);
            clop.value = { formula: `COUNTIF(${fDC}${er}:${lDC}${er},"LOP")` };
            clop.fill = rf; clop.border = CBDR;
            clop.font = { bold: true, size: 10, name: 'Calibri', color: { argb: 'FF991B1B' } };
            clop.alignment = { horizontal: 'center', vertical: 'center' };
            clop.protection = { locked: true };

            // Total Month Days = every column in this table, PLUS a Pending
            // leave ('LA') and a blank cell (unapproved On Duty Away, a
            // future date, or before joining — see toCode()), both counted
            // inline here since neither is shown as its own column. Each
            // day maps to exactly one of P/OD/A/WO/H/L/LOP/LA/blank, so this
            // always equals the period's day count.
            const ctot = ws.getCell(r, 9);
            ctot.value = { formula: `C${rowNum}+D${rowNum}+E${rowNum}+F${rowNum}+G${rowNum}+H${rowNum}+COUNTIF(${fDC}${er}:${lDC}${er},"LA")+COUNTIF(${fDC}${er}:${lDC}${er},"")` };
            ctot.fill = rf; ctot.border = CBDR;
            ctot.font = { bold: true, size: 10, name: 'Calibri', color: { argb: 'FF1F3864' } };
            ctot.alignment = { horizontal: 'center', vertical: 'center' };
            ctot.protection = { locked: true };

            // 📍 Location Pending — dates list, staff-only column.
            if (role !== 'employee') {
              const locDates = locationFetchingDates(rawRecs, empIdStr);
              const cloc = ws.getCell(r, 10);
              cloc.value = locDates.length ? `📍 ${locDates.join(', ')}` : '—';
              cloc.fill = rf; cloc.border = CBDR;
              cloc.font = { size: 8.5, italic: !!locDates.length, name: 'Calibri', color: { argb: locDates.length ? 'FF0369A1' : 'FF94A3B8' } };
              cloc.alignment = { horizontal: 'left', vertical: 'center', wrapText: true };
            }
          });
        }

        outerBorder(ws, SR, 2, r, role !== 'employee' ? 10 : 9);
        // ── Signatures ────────────────────────────────────────────────────────
        r+=3; ws.getRow(r).height=20;

        if (role === 'employee') {
          // Employee download: Employee sign (left) + Manager sign (right)
          ws.getCell(r,2).value='Employee Sign:';
          ws.getCell(r,2).font={bold:true,size:10,name:'Calibri',color:{argb:'FF1F3864'}};
          mc(ws,r,3,r,6);
          const empSigCell=ws.getCell(r,3);
          empSigCell.value='';
          empSigCell.alignment={horizontal:'center',vertical:'bottom'};
          empSigCell.border={bottom:{style:'medium',color:{argb:'FF1F3864'}}};

          ws.getCell(r,8).value='Reporting Officer Sign:';
          ws.getCell(r,8).font={bold:true,size:15,name:'Calibri',color:{argb:'FF1F3864'}};
          mc(ws,r,12,r,13);
          const mgrSigCell=ws.getCell(r,12);
          mgrSigCell.value=mgrName?`(${mgrName})`:'';
          mgrSigCell.font={italic:true,size:10,name:'Calibri',color:{argb:'FF555555'}};
          mgrSigCell.alignment={horizontal:'center',vertical:'bottom'};
          mgrSigCell.border={bottom:{style:'medium',color:{argb:'FF1F3864'}}};
        }
        // Manager / HR / super_admin / admin: no signature row on exported sheet

        ws.views=[{state:'frozen',xSplit:4,ySplit:4}];
        ws.pageSetup={
          paperSize:9, orientation:'landscape',
          fitToPage:true, fitToWidth:1, fitToHeight:0,
          printTitlesRow:'$1:$4',
          margins:{left:0.2,right:0.2,top:0.4,bottom:0.4,header:0.2,footer:0.2},
        };
      if (role === 'employee') {
  ws.protect('BRP-READONLY',{
    selectLockedCells:true,selectUnlockedCells:true,
    formatCells:false,insertRows:false,insertColumns:false,
    deleteRows:false,deleteColumns:false,sort:false,
  });
}
      };

      if(role==='employee'){
        buildSheet(wb.addWorksheet('My Attendance'),matrix,`${matrix[0]?.emp.name} Summary`,managerName,holCount);
      } else {
        const allName =role==='manager'?'Team Report':'All emp Reports';
        const allTitle=role==='manager'?'Team Summary':'Total Summary';
        buildSheet(wb.addWorksheet(allName),matrix,allTitle,managerName,holCount);
        const usedSheetNames = new Set([allName]);
        matrix.forEach(({emp,cells})=>{
          let name=(emp.name||'Employee').replace(/[:\\/?*[\]]/g,'').trim().substring(0,26) || 'Employee';
          // Sheet names must be unique — two employees can share the same
          // (or same-after-sanitizing) name, which would otherwise crash
          // wb.addWorksheet() mid-export and abort the whole file.
          if (usedSheetNames.has(name)) {
            const suffix = `_${(emp.emp_id||emp._id||'').toString().slice(-4)}`;
            name = `${name.substring(0,31-suffix.length)}${suffix}`;
          }
          usedSheetNames.add(name);
          buildSheet(wb.addWorksheet(name),[{emp,cells}],`${emp.name} Summary`,managerName,holCount);
        });
      }

      const fnamePrefix = matrix.length === 1
        ? `${(matrix[0].emp.name||'').replace(/[^a-zA-Z0-9]+/g,'_').replace(/^_+|_+$/g,'')}_${matrix[0].emp.emp_id||''}_`
        : '';
      res.setHeader('Content-Type','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition',`attachment; filename="${fnamePrefix}BRP_Attendance_${startDate}_to_${endDate}.xlsx"`);
      res.setHeader('Access-Control-Expose-Headers', 'Content-Disposition');
      await wb.xlsx.write(res);
      return res.end();
    }

    // ══════════════════════════════════════════════════════════════════════════
    //  PDF
    // ══════════════════════════════════════════════════════════════════════════
    if(format==='pdf'){
      const doc=new PDFDoc({size:'A3',layout:'landscape',margins:{top:28,bottom:28,left:28,right:28},autoFirstPage:true});
      res.setHeader('Content-Type','application/pdf');
      res.setHeader('Content-Disposition',`attachment; filename="BRP_Attendance_${startDate}_to_${endDate}.pdf"`);
      res.setHeader('Access-Control-Expose-Headers', 'Content-Disposition');
      doc.pipe(res);
      doc.lineWidth(0.5); // light grid lines throughout — table borders were invisible before, don't overcorrect to heavy

      const PW=doc.page.width,PH=doc.page.height,ML=28;
      const CC=52,CN=130,CD=64,CT=40;
      const CHUNK=31; // days per row — a full month fits on one line; longer ranges still wrap to a new row/page beyond that
      const dW=Math.max(11,(PW-56-CC-CN-CD-CT)/CHUNK);
      const RH=24; // tall enough for a two-line employee name to wrap without spilling into the row below
      const xC=ML,xN=ML+CC,xDes=xN+CN,xD=xDes+CD,xT=xD+CHUNK*dW,tW=xT+CT-ML;

      const addPage=()=>doc.addPage({size:'A3',layout:'landscape',margins:{top:28,bottom:28,left:28,right:28}});

      // Manual truncation — measured against the real font metrics, so it can't
      // silently wrap onto a second line the way relying on ellipsis:true can.
      const truncateToWidth=(str,maxWidth,font='Helvetica-Bold',size=7)=>{
        doc.font(font).fontSize(size);
        if (doc.widthOfString(str) <= maxWidth) return str;
        let s = str;
        while (s.length > 1 && doc.widthOfString(s+'…') > maxWidth) s = s.slice(0,-1);
        return s+'…';
      };

      const drawTitle=y=>{
        doc.rect(ML,y,tW,20).fillAndStroke('#FFF','#AAA');
        doc.fillColor('#000').fontSize(12).font('Helvetica-Bold').text('Attendance details of BRP',ML,y+5,{width:tW,align:'center'});
        doc.rect(ML,y+20,tW,14).fillAndStroke('#FFF','#AAA');
        doc.fillColor('#161515').fontSize(8).font('Helvetica').text(rangeTitle,ML,y+23,{width:tW,align:'center'});
        doc.rect(ML,y+34,tW,12).fillAndStroke('#FFF','#AAA');
        doc.fillColor('#000').fontSize(7).font('Helvetica-Bold')
           .text('Location: Tripura',ML+4,y+37).text('Project: Block Resource Person',ML+tW/2,y+37);
        return y+46;
      };

      const HRH = 32;   // taller header row to fit day-num + weekday + month
      const drawColHdr=(y,chunkDates,totalLabel)=>{
        [[xC,CC,'Emp code'],[xN,CN,'Employee Name'],[xDes,CD,'Designation']].forEach(([x,w,l])=>{
          doc.rect(x,y,w,HRH).fillAndStroke('#FFF','#AAA');
          doc.fillColor('#3366FF').fontSize(7).font('Helvetica-Bold')
             .text(l,x+2,y+(HRH-9)/2,{width:w-4,align:'center'});
        });
        chunkDates.forEach((iso,i)=>{
          const x=xD+i*dW;
          doc.rect(x,y,dW,HRH).fillAndStroke('#FFF','#AAA');
          doc.fillColor('#3366FF').fontSize(6).font('Helvetica-Bold')
             .text(String(dayNum(iso)),x+1,y+3,{width:dW-2,align:'center'});
          doc.fillColor('#555').fontSize(5).font('Helvetica')
             .text(dayAbbr(iso),x+1,y+11,{width:dW-2,align:'center'});
          doc.fillColor('#888').fontSize(5).font('Helvetica')
             .text(monAbbr(iso),x+1,y+19,{width:dW-2,align:'center'});
        });
        // Short last chunk (< CHUNK days) — fill the remaining columns so the grid stays a fixed width
        for(let i=chunkDates.length;i<CHUNK;i++) doc.rect(xD+i*dW,y,dW,HRH).fillAndStroke('#F5F5F5','#AAA');
        doc.rect(xT,y,CT,HRH).fillAndStroke('#FFF','#AAA');
        doc.fillColor('#3366FF').fontSize(7).font('Helvetica-Bold')
           .text(totalLabel,xT+2,y+(HRH-9)/2,{width:CT-4,align:'center'});
        return y+HRH;
      };

      const chunks=[];
      for(let i=0;i<dates.length;i+=CHUNK) chunks.push(dates.slice(i,i+CHUNK));

      // Group employees into fixed-size page batches, sized to exactly how
      // many rows fit under one title+header on a page (title is always 46pt
      // per drawTitle(), header is HRH). Batching by employee FIRST and
      // day-chunk SECOND (rather than the other way around) means one
      // employee batch's entire month — every day-chunk — completes across
      // consecutive pages before the next batch of employees begins, instead
      // of every employee's first day-chunk being scattered across a run of
      // pages, then the SAME employees' second day-chunk showing up much
      // later after every other employee's first chunk has already printed.
      const TITLE_H = 46;
      const rowsPerPage = Math.max(1, Math.floor((PH-60-(ML+TITLE_H+HRH))/RH));
      const employeeGroups=[];
      for(let i=0;i<matrix.length;i+=rowsPerPage) employeeGroups.push(matrix.slice(i,i+rowsPerPage));

      let y;
      let firstPage=true;
      employeeGroups.forEach(empGroup=>{
        chunks.forEach((chunkDates,ci)=>{
          if(firstPage){
            y=drawTitle(ML);firstPage=false;
          }else if(ci===0){
            // Start of a new employee batch — always a fresh page, so one
            // batch's chunks never trail onto a page a previous batch left
            // partly filled (this is what fixes batches landing on
            // out-of-order pages).
            addPage();y=drawTitle(28);
          }else if(y+HRH+empGroup.length*RH>PH-60){
            // Moving to the next chunk WITHIN the same batch — only break if
            // it won't actually fit. A full batch (sized to fill a page for
            // one chunk) will always fail this and get its own page per
            // chunk, same as before; a small batch (e.g. a single employee's
            // own report) keeps every chunk on the same page instead of
            // wasting a nearly-blank page per chunk.
            addPage();y=drawTitle(28);
          }
          y=drawColHdr(y,chunkDates,'Subtotal');
          empGroup.forEach(({emp,cells},idx)=>{
            // Safety net only — rowsPerPage is sized to always fit, so this
            // should never actually fire.
            if(y+RH>PH-60){addPage();y=drawTitle(28);y=drawColHdr(y,chunkDates,'Subtotal');}
            const bg=idx%2===0?'#F9F9F9':'#FFF';
            doc.rect(ML,y,tW,RH).fillAndStroke(bg,'#CCC');
            // Vertical dividers between Emp code / Name / Designation — the
            // header row already has these per-column, but the data rows only
            // draw one wide background stripe with no internal separators.
            doc.lineWidth(0.5).strokeColor('#DDD');
            [xN,xDes,xD].forEach(x=>doc.moveTo(x,y).lineTo(x,y+RH).stroke());
            doc.lineWidth(0.5);
            doc.fillColor('#000').fontSize(7).font('Helvetica-Bold').text(emp.emp_id||'',xC+2,y+7,{width:CC-4,align:'center'});
            doc.font('Helvetica-Bold').fontSize(7).text(emp.name,xN+2,y+3,{width:CN-4,height:RH-4});
            doc.font('Helvetica-Bold').fontSize(6.5).text(truncateToWidth(emp.role_type||emp.designation||'',CD-4,'Helvetica-Bold',6.5),xDes+2,y+8,{width:CD-4,align:'center',lineBreak:false});
            const chunkCells=cells.slice(ci*CHUNK,ci*CHUNK+chunkDates.length);
            let pres=0;
            chunkCells.forEach((code,i)=>{
              const x=xD+i*dW;
              const isLOP=code==='LOP'; // darker than plain L/A — matches the LOP summary column's color
              const isLA=code==='LA'; // amber — "awaiting decision", distinct from paid L / unpaid LOP
              const isRed=code==='L'||code==='A';
              const cellBg=isLOP?'#991B1B':isLA?'#FDE68A':isRed?'#FF4444':code==='WO'?'#BDD7EE':code==='H'?'#FFF3CD':bg;
              doc.rect(x,y,dW,RH).fillAndStroke(cellBg,'#CCC');
              if(code){
                // 'LOP'/'LA' are 2-3 characters — a smaller size than the
                // other (1-2 char) codes so they still fit the narrow column.
                doc.fillColor((isRed||isLOP)?'#FFFFFF':isLA?'#92400E':code==='H'?'#D97706':'#000000').fontSize(isLOP?4.5:isLA?5:6).font('Helvetica-Bold')
                   .text(code,x+1,y+8,{width:dW-2,align:'center'});
              }
              if(code==='P'||code==='OD') pres++;
            });
            for(let i=chunkCells.length;i<CHUNK;i++) doc.rect(xD+i*dW,y,dW,RH).fillAndStroke('#F5F5F5','#CCC');
            doc.rect(xT,y,CT,RH).fillAndStroke('#FFF','#AAA');
            doc.fillColor('#000').fontSize(7).font('Helvetica-Bold').text(String(pres),xT+2,y+7,{width:CT-4,align:'center'});
            y+=RH;
          });
        });
      });

      // Legend — separated from the table with its own rule line + gap
      y+=10; if(y+20>PH-80){addPage();y=40;}
      doc.moveTo(ML,y-4).lineTo(ML+tW,y-4).lineWidth(0.75).strokeColor('#CBD5E1').stroke();
      y+=4;
      let lx=ML;
      [{code:'P',label:'Present (assigned location)',red:false},
       {code:'OD',label:'On Duty (other Tripura location)',red:false},
       {code:'LA',label:'Leave Applied (awaiting approval)',la:true},
       {code:'L',label:'Leave (paid)',red:true},
       {code:'LOP',label:'Leave without Pay',lop:true},
       {code:'A',label:'Absent',red:true},
       {code:'WO',label:'Week Off',red:false},
      ].forEach(({code,label,red,lop,la})=>{
        const bw=code==='LOP'?22:code==='LA'?18:14,lw=115;
        doc.rect(lx,y,bw,10).fillAndStroke(lop?'#991B1B':la?'#FDE68A':red?'#FF4444':'#FFFFFF','#999');
        doc.fillColor((red||lop)?'#FFFFFF':la?'#92400E':'#000000').fontSize(lop?5.5:la?5.5:6).font('Helvetica-Bold').text(code,lx+1,y+2,{width:bw-2,align:'center'});
        doc.fillColor('#333').fontSize(7).font('Helvetica').text(label,lx+bw+2,y+1,{width:lw,lineBreak:false,ellipsis:true});
        lx+=bw+lw+10;
      });
      // Same blank-cell explanation as the Excel legend note — given its own
      // clear row below the legend so it never collides with legend labels.
      y+=16;
      doc.fillColor('#64748B').fontSize(6.5).font('Helvetica-Oblique')
         .text('Blank cell (not WO/H) = unapproved On Duty Away, a future date, or before joining. A leave application shows LA until the manager decides — L if approved, LOP if rejected.', ML, y, { width: tW });
      y+=18;

      // Summary
      y+=4; if(y+130>PH-60){addPage();y=40;}
      const SW=240,SRH=16,SX=ML; let sy=y;
      const pdfRow=(label,value,type='row',rowH=SRH)=>{
        if(type==='title'){doc.rect(SX,sy,SW,rowH).fillAndStroke('#FFF','#000'); doc.fillColor('#C00000').fontSize(10).font('Helvetica-Bold').text(label,SX+4,sy+5,{width:SW-8,align:'center'});}
        else if(type==='sub'){doc.rect(SX,sy,SW,rowH).fillAndStroke('#E8EDF4','#000'); doc.fillColor('#1F3864').fontSize(9).font('Helvetica-Bold').text(label,SX,sy+3,{width:SW,align:'center'});}
        else{
          doc.rect(SX,sy,SW*0.72,rowH).fillAndStroke('#FFF','#000');
          doc.rect(SX+SW*0.72,sy,SW*0.28,rowH).fillAndStroke('#FFF','#000');
          doc.fillColor('#1F3864').fontSize(9).font('Helvetica-Bold').text(label,SX+4,sy+3,{width:SW*0.68});
          if(value!==undefined) doc.text(String(value),SX+SW*0.72,sy+3,{width:SW*0.26,align:'center'});
        }
        sy+=rowH;
      };
      // Title row gets extra height — the employee's full name + "Summary" often
      // wraps to two lines at this width, and the fixed SRH was too short for that.
      const summaryTitle=role==='employee'?`${matrix[0]?.emp.name} Summary`:role==='manager'?'Team Summary':'Total Summary';
      pdfRow(summaryTitle,undefined,'title',34);
      pdfRow('No of Total Days',totalDays);
      pdfRow('No of Weekoff (WO)',woCount);
      pdfRow('No of Holidays (H)',holCount);
      pdfRow('No of Working Days',totalDays-woCount-holCount);

      if (matrix.length === 1) {
        
  const cells   = matrix[0].cells;
  const empIdStr = String(matrix[0].emp._id);

  const empLeaveRecs = rawRecs.filter(r =>
    String(r.emp_id) === empIdStr &&
    (r.duty_type === 'Leave' || (r.leave_type && String(r.leave_type).trim()))
  );
  const byType = t => empLeaveRecs.filter(r => String(r.leave_type||'').toLowerCase().includes(t));
  const halfDayRecs   = byType('half');
  const emergencyRecs = byType('emergency');
  const casualRecs    = byType('casual');
  const pendingRecs   = empLeaveRecs.filter(r => (r.leave_status || r.status || 'Pending') === 'Pending');
  // Working-day span of a leave record (mirrors the reports matrix's own
  // WO/H-before-L precedence) — a record's `date` is only the START day,
  // so a multi-day leave needs every day in [date, end_date] counted.
  const leaveDaySpan = r => {
    if (!r.end_date || r.end_date <= r.date) return 1;
    return expandDates(r.date, r.end_date).filter(d => !isNonWorkingDay(d) && !isHoliday(d)).length;
  };
  const sumDays = recs => recs.reduce((s, r) => s + leaveDaySpan(r), 0);
  const effectiveLeaves = empLeaveRecs.reduce((sum, r) => {
    const ls = r.leave_status || r.status || 'Pending';
    if (ls === 'Pending') return sum;
    const isHalf = String(r.leave_type||'').toLowerCase().includes('half');
    const hasCheckin = r.checkin_time || r.checkinTime;
    const days = leaveDaySpan(r) * (isHalf ? 0.5 : 1);
    if (ls === 'Approved') return sum + days; // approved leave always counts (matches toCode's unconditional 'L')
    if (ls === 'Rejected') return hasCheckin ? sum : sum + days;
    return sum;
  }, 0);

  pdfRow('No of Present / worked (P+OD)', cells.filter(c => c==='P'||c==='OD').length);
  pdfRow('No of Leaves (L)',               cells.filter(c => c==='L').length);
  pdfRow('No of LOP',                      cells.filter(c => c==='LOP').length);
  pdfRow('No of Half Day Leaves (each = 0.5 day)', sumDays(halfDayRecs), 'row', 26);
  pdfRow('No of Emergency Leaves',                 sumDays(emergencyRecs));
  pdfRow('No of Casual Leaves',                    sumDays(casualRecs));
  pdfRow('Total Effective Leaves',                 effectiveLeaves);
  pdfRow('No of Absent (A)',               cells.filter(c => c==='A').length);
  pdfRow('No of Leave Applied / Pending (LA)',      pendingRecs.length);
    if (role !== 'employee') {
    const locDates = locationFetchingDates(rawRecs, empIdStr);
    pdfRow('Location Fetching (days)', locDates.length);
    if (locDates.length) {
      sy += 2;
      const px = SX + 4, py = sy + 6;
      doc.save().fillColor('#DC2626');
      doc.circle(px, py - 3, 3.2).fill();
      doc.moveTo(px - 2.2, py - 3).lineTo(px + 2.2, py - 3).lineTo(px, py + 3.5).fill();
      doc.restore();
      doc.fillColor('#64748B').fontSize(7).font('Helvetica-Oblique')
         .text(locDates.join(', '), SX + 12, sy, { width: SW - 12 });
      sy += 16;
    }
  }
} else {
  sy++;
  // Column order: Employee, Present, Absent, Week Off, Holidays, Leaves,
  // LOP, Total Month Days, [Location Fetching].
  // Wider than the summary-rows box (SW/SRH) above, and its own taller row
  // height (TROW) — Employee Name and Location Fetching both need real room:
  // a full name and a comma-separated list of pending-location dates were
  // both getting clipped by the old, narrower columns.
  const TW   = role !== 'employee' ? SW * 3.1 : SW * 2.1;
  const TROW = role !== 'employee' ? 28 : SRH; // taller — Location Fetching's wrapped text needs it
  const C0 = TW * (role !== 'employee' ? 0.18 : 0.24); // Employee
  const C1 = TW * (role !== 'employee' ? 0.08 : 0.10); // Present
  const C2 = TW * (role !== 'employee' ? 0.08 : 0.10); // Absent
  const C3 = TW * (role !== 'employee' ? 0.08 : 0.10); // Week Off
  const C4 = TW * (role !== 'employee' ? 0.08 : 0.10); // Holidays
  const C5 = TW * (role !== 'employee' ? 0.08 : 0.10); // Leaves
  const C6 = TW * (role !== 'employee' ? 0.07 : 0.10); // LOP
  const C7 = TW * (role !== 'employee' ? 0.11 : 0.16); // Total Month Days
  const C8 = role !== 'employee' ? TW * 0.24 : 0;       // Location Pending dates

  const drawSummaryHeader = (yy) => {
    doc.rect(SX,                     yy, C0, TROW).fillAndStroke('#E8EDF4','#000');
    doc.rect(SX+C0,                   yy, C1, TROW).fillAndStroke('#D1FAE5','#000');
    doc.rect(SX+C0+C1,                yy, C2, TROW).fillAndStroke('#FEE2E2','#000');
    doc.rect(SX+C0+C1+C2,             yy, C3, TROW).fillAndStroke('#DBEAFE','#000');
    doc.rect(SX+C0+C1+C2+C3,          yy, C4, TROW).fillAndStroke('#FEF3C7','#000');
    doc.rect(SX+C0+C1+C2+C3+C4,       yy, C5, TROW).fillAndStroke('#FEF3C7','#000');
    doc.rect(SX+C0+C1+C2+C3+C4+C5,    yy, C6, TROW).fillAndStroke('#FEE2E2','#000');
    doc.rect(SX+C0+C1+C2+C3+C4+C5+C6, yy, C7, TROW).fillAndStroke('#E8EDF4','#000');
    if (role !== 'employee') doc.rect(SX+C0+C1+C2+C3+C4+C5+C6+C7, yy, C8, TROW).fillAndStroke('#E0F2FE','#000');
    doc.fillColor('#1F3864').fontSize(8).font('Helvetica-Bold').text('Employee',   SX+4,    yy+(TROW-9)/2, {width:C0-8});
    doc.fillColor('#047857').fontSize(8).font('Helvetica-Bold').text('Present',    SX+C0,   yy+(TROW-9)/2, {width:C1,align:'center'});
    doc.fillColor('#B91C1C').fontSize(8).font('Helvetica-Bold').text('Absent',     SX+C0+C1,yy+(TROW-9)/2,{width:C2,align:'center'});
    doc.fillColor('#2563EB').fontSize(8).font('Helvetica-Bold').text('Week Off',   SX+C0+C1+C2,yy+(TROW-9)/2,{width:C3,align:'center'});
    doc.fillColor('#D97706').fontSize(8).font('Helvetica-Bold').text('Holidays',   SX+C0+C1+C2+C3,yy+(TROW-9)/2,{width:C4,align:'center'});
    doc.fillColor('#B45309').fontSize(8).font('Helvetica-Bold').text('Leaves',     SX+C0+C1+C2+C3+C4,yy+(TROW-9)/2,{width:C5,align:'center'});
    doc.fillColor('#991B1B').fontSize(8).font('Helvetica-Bold').text('LOP',        SX+C0+C1+C2+C3+C4+C5,yy+(TROW-9)/2,{width:C6,align:'center'});
    doc.fillColor('#1F3864').fontSize(7).font('Helvetica-Bold').text('Total Month Days', SX+C0+C1+C2+C3+C4+C5+C6+2, yy+(TROW-9)/2, {width:C7-4,align:'center'});
    if (role !== 'employee') doc.fillColor('#0369A1').fontSize(8).font('Helvetica-Bold').text('Location Fetching', SX+C0+C1+C2+C3+C4+C5+C6+C7, yy+(TROW-9)/2, {width:C8,align:'center'});
    return yy + TROW;
  };

  sy = drawSummaryHeader(sy);

  matrix.forEach(({ emp, cells }, idx) => {
    if (sy + TROW > PH - 60) {
      doc.addPage({ size:'A3', layout:'landscape', margins:{top:28,bottom:28,left:28,right:28} });
      sy = drawSummaryHeader(40);
    }
    const bg = idx % 2 === 0 ? '#FFFFFF' : '#F7F7F7';
    doc.rect(SX,                     sy, C0, TROW).fillAndStroke(bg,'#CCCCCC');
    doc.rect(SX+C0,                   sy, C1, TROW).fillAndStroke(bg,'#CCCCCC');
    doc.rect(SX+C0+C1,                sy, C2, TROW).fillAndStroke(bg,'#CCCCCC');
    doc.rect(SX+C0+C1+C2,             sy, C3, TROW).fillAndStroke(bg,'#CCCCCC');
    doc.rect(SX+C0+C1+C2+C3,          sy, C4, TROW).fillAndStroke(bg,'#CCCCCC');
    doc.rect(SX+C0+C1+C2+C3+C4,       sy, C5, TROW).fillAndStroke(bg,'#CCCCCC');
    doc.rect(SX+C0+C1+C2+C3+C4+C5,    sy, C6, TROW).fillAndStroke(bg,'#CCCCCC');
    doc.rect(SX+C0+C1+C2+C3+C4+C5+C6, sy, C7, TROW).fillAndStroke(bg,'#CCCCCC');
    if (role !== 'employee') doc.rect(SX+C0+C1+C2+C3+C4+C5+C6+C7, sy, C8, TROW).fillAndStroke(bg,'#CCCCCC');

    const pres = cells.filter(c => c==='P'||c==='OD').length;
    const abs  = cells.filter(c => c==='A').length;
    const wo   = cells.filter(c => c==='WO').length;
    const hol  = cells.filter(c => c==='H').length;
    const lv   = cells.filter(c => c==='L').length;
    // LOP has its own grid cell code ('LOP', see toCode()), counted the
    // same way as every other column here — disjoint from Leaves ('L') and
    // Pending ('LA'), so the total below always adds up cleanly.
    const lop  = cells.filter(c => c==='LOP').length;
    // Pending leave ('LA') and a genuinely blank cell (unapproved On Duty
    // Away, a future date, or before joining — see toCode()) aren't shown
    // as their own columns here, but both still need to count toward
    // Total Month Days.
    const la   = cells.filter(c => c==='LA').length;
    const pend = cells.filter(c => c==='').length;
    const empIdStr = String(emp._id);
    const monthDays = pres + abs + wo + hol + lv + lop + la + pend; // every day in the period, exactly once

    // Employee name gets the taller row height too, so a name that wraps to
    // a second line (like "Ajaya Narasimha Reddy Siriyapureddy") isn't cut
    // off — no ellipsis/lineBreak:false here, unlike before.
    doc.fillColor('#1F3864').fontSize(8.5).font('Helvetica-Bold').text(emp.name,      SX+4,   sy+3,{width:C0-8,height:TROW-4});
    doc.fillColor('#047857').fontSize(9  ).font('Helvetica-Bold').text(String(pres),  SX+C0,  sy+3,{width:C1,align:'center'});
    doc.fillColor('#B91C1C').fontSize(9  ).font('Helvetica-Bold').text(String(abs),   SX+C0+C1,sy+3,{width:C2,align:'center'});
    doc.fillColor('#2563EB').fontSize(9  ).font('Helvetica-Bold').text(String(wo),    SX+C0+C1+C2,sy+3,{width:C3,align:'center'});
    doc.fillColor('#D97706').fontSize(9  ).font('Helvetica-Bold').text(String(hol),   SX+C0+C1+C2+C3,sy+3,{width:C4,align:'center'});
    doc.fillColor('#B45309').fontSize(9  ).font('Helvetica-Bold').text(String(lv),    SX+C0+C1+C2+C3+C4,sy+3,{width:C5,align:'center'});
    doc.fillColor('#991B1B').fontSize(9  ).font('Helvetica-Bold').text(String(lop),   SX+C0+C1+C2+C3+C4+C5,sy+3,{width:C6,align:'center'});
    doc.fillColor('#1F3864').fontSize(9  ).font('Helvetica-Bold').text(String(monthDays), SX+C0+C1+C2+C3+C4+C5+C6,sy+3,{width:C7,align:'center'});

    if (role !== 'employee') {
      const locDates = locationFetchingDates(rawRecs, empIdStr);
      // Wrapped (not truncated to one ellipsized line) — the wider column
      // plus taller row gives real room for a handful of dates; ellipsis
      // only kicks in if the list is still too long for even that.
      doc.fillColor(locDates.length ? '#0369A1' : '#94A3B8').fontSize(6.5).font(locDates.length ? 'Helvetica-Oblique' : 'Helvetica')
         .text(locDates.length ? locDates.join(', ') : '—', SX+C0+C1+C2+C3+C4+C5+C6+C7+3, sy+3, {width:C8-6, height:TROW-4, ellipsis:true});
    }
    sy += TROW;
  });
  // Formula didn't fit in the header cell above — spelled out here instead.
  sy += 3;
  doc.fillColor('#64748B').fontSize(6.5).font('Helvetica-Oblique')
     .text('Total Month Days = Present + Absent + Week Off + Holidays + Leave Applied (LA) + Leaves + LOP.', SX, sy, { width: TW });
  sy += 12;
}

      // Signatures (employee download only)
      sy+=24; if(sy+30>PH-28){addPage();sy=40;}
      const sigLineW=140;
if (role === 'employee') {
  // Employee Sign
  doc.fillColor('#1F3864').fontSize(12).font('Helvetica-Bold').text('Employee Sign:', ML, sy);
  doc.moveTo(ML + 110, sy + 12).lineTo(ML + 110 + sigLineW, sy + 12).stroke('#999');

  // Reporting Officer block — CSS matched to reference layout
  const roX = ML + 110 + sigLineW + 80;
  doc.fillColor('#1F3864').fontSize(12).font('Helvetica-Bold').text('Reporting Officer:', roX, sy);

  const lineGap = 30;
  let ry = sy + lineGap;

  // Name/Designation — thin grey line, value (if known) sits above the line
  doc.fillColor('#3B6EA5').fontSize(9).font('Helvetica').text('Name/Designation:', roX, ry);
  if (managerName) {
    doc.fillColor('#333').fontSize(10).font('Helvetica-Oblique')
       .text(managerName, roX + 100, ry - 9, { width: sigLineW });
  }
  doc.moveTo(roX + 100, ry + 9).lineTo(roX + 100 + sigLineW, ry + 9).stroke('#999');

  ry += lineGap + 10;
  doc.fillColor('#3B6EA5').fontSize(9).font('Helvetica').text('Signature & Stamp:', roX, ry);
  doc.moveTo(roX + 100, ry + 9).lineTo(roX + 100 + sigLineW, ry + 9).stroke('#1F3864');

  ry += lineGap + 10;
  doc.fillColor('#3B6EA5').fontSize(9).font('Helvetica').text('Date:', roX, ry);
  doc.moveTo(roX + 100, ry + 9).lineTo(roX + 100 + sigLineW * 0.55, ry + 9).stroke('#999');
}

      doc.end();
      return;
    }

    res.status(400).json({success:false,message:'format must be excel or pdf'});
  } catch(err){
    console.error('[ReportsExport]',err);
    res.status(500).json({success:false,message:'Export failed',error:err.message});
  }
});

// ══════════════════════════════════════════════════════════════════════════════
//  GET /api/reports/signed-attendance-merge — combines every employee's
//  manager-signed monthly report (individually re-uploaded via
//  POST /api/attendance/upload-signed-report, see User.signed_reports) into
//  ONE PDF, employees ordered by Employee ID, instead of downloading and
//  assembling each one by hand.
// ══════════════════════════════════════════════════════════════════════════════
router.get('/signed-attendance-merge',
  authenticate,
  authorize('super_admin', 'admin', 'hr', 'manager'),
  async (req, res) => {
  try {
    const { month, managerId } = req.query;
    const role = req.user.role;
    if (!month || !/^\d{4}-\d{2}$/.test(month))
      return res.status(400).json({ success: false, message: 'Valid month (YYYY-MM) is required' });

    const EMP_SELECT = '_id name emp_id signed_reports';
    let employees = [];
    if (managerId && String(managerId).trim() !== '') {
      employees = await User.find({ manager_id: toObjId(managerId), is_active: { $ne: false } }).select(EMP_SELECT).lean();
    } else if (role === 'manager') {
      employees = await User.find({ manager_id: toObjId(req.user.id), is_active: { $ne: false } }).select(EMP_SELECT).lean();
    } else {
      employees = await User.find({ role: 'employee', is_active: { $ne: false } }).select(EMP_SELECT).lean();
    }

    // Numeric-safe ascending Employee ID order — plain string sort would put
    // "1968" after "23423" (lexicographic), so parse to int where possible.
    employees.sort((a, b) => {
      const aId = parseInt(a.emp_id, 10), bId = parseInt(b.emp_id, 10);
      if (!isNaN(aId) && !isNaN(bId)) return aId - bId;
      return String(a.emp_id || '').localeCompare(String(b.emp_id || ''));
    });

    const withReport = employees
      .map(emp => ({ emp, report: (emp.signed_reports || []).find(r => r.month === month) }))
      .filter(x => x.report);

    if (!withReport.length)
      return res.status(404).json({ success: false, message: `No signed reports have been uploaded for ${month}` });

    const merged = await MergePDFDocument.create();
    const font   = await merged.embedFont(StandardFonts.HelveticaBold);
    const missing = [];
    const A4 = [595.28, 841.89];

    for (const { emp, report } of withReport) {
      try {
        const resp = await fetch(report.path);
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const bytes = Buffer.from(await resp.arrayBuffer());
        const mime  = resp.headers.get('content-type') || '';

        if (mime.includes('pdf') || /\.pdf($|\?)/i.test(report.path)) {
          const src   = await MergePDFDocument.load(bytes, { ignoreEncryption: true });
          const pages = await merged.copyPages(src, src.getPageIndices());
          pages.forEach(p => merged.addPage(p));
        } else {
          // JPG/PNG scan — page around it so the merged file stays one
          // consistent PDF instead of mixing raw image bytes into pages.
          const image = mime.includes('png') ? await merged.embedPng(bytes) : await merged.embedJpg(bytes);
          const page  = merged.addPage(A4);
          const { width: pw, height: ph } = page.getSize();
          const margin = 30, labelH = 24;
          const maxW = pw - margin * 2, maxH = ph - margin * 2 - labelH;
          const scale = Math.min(maxW / image.width, maxH / image.height, 1);
          const w = image.width * scale, h = image.height * scale;
          page.drawText(`${emp.emp_id || ''} — ${emp.name}`, { x: margin, y: ph - margin, size: 11, font, color: rgb(0.12, 0.22, 0.39) });
          page.drawImage(image, { x: (pw - w) / 2, y: ph - labelH - margin - h, width: w, height: h });
        }
      } catch (e) {
        missing.push(`${emp.emp_id || ''} ${emp.name} — ${e.message}`);
      }
    }

    if (missing.length) {
      const page = merged.addPage(A4);
      page.drawText('Could not merge the following signed reports:', { x: 40, y: 800, size: 12, font, color: rgb(0.6, 0.1, 0.1) });
      missing.forEach((line, i) => page.drawText(line, { x: 40, y: 775 - i * 16, size: 10, font }));
    }

    const outBytes = await merged.save();
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="Signed_Attendance_${month}.pdf"`);
    res.setHeader('Access-Control-Expose-Headers', 'Content-Disposition');
    res.send(Buffer.from(outBytes));
  } catch (err) {
    console.error('[SignedAttendanceMerge]', err);
    res.status(500).json({ success: false, message: 'Failed to merge signed reports', error: err.message });
  }
});

// ══════════════════════════════════════════════════════════════════════════════
//  GET /api/reports/leave-export
// ══════════════════════════════════════════════════════════════════════════════
router.get('/leave-export',
  authenticate,
  authorize('super_admin', 'admin', 'hr', 'manager', 'employee'),
  async (req, res) => {
  try {
    const { format = 'excel', status, empId } = req.query;
    const role = req.user.role;
    let { startDate, endDate } = req.query;

    if (!startDate || !endDate)
      return res.status(400).json({ success: false, message: 'startDate and endDate are required' });

    // NO cap to yesterday for leave reports — leaves are complete records
    if (startDate > endDate)
      return res.status(400).json({ success: false, message: 'startDate must be before or equal to endDate' });

    // ── Employee scope ─────────────────────────────────────────────────────────
    let employees = [];

    if (role === 'employee') {
      const me = await User.findById(req.user.id).select('_id name emp_id').lean();
      if (me) employees = [me];

    } else if (empId && String(empId).trim() !== '') {
      const specificFilter = role === 'manager'
        ? { _id: toObjId(empId), manager_id: toObjId(req.user.id) }
        : { _id: toObjId(empId) };
      const specific = await User.findOne(specificFilter).select('_id name emp_id').lean();
      if (specific) employees = [specific];
      else return res.status(404).json({ success: false, message: 'Selected employee not found' });

    } else if (role === 'manager') {
      employees = await User.find({ manager_id: toObjId(req.user.id), is_active: { $ne: false } })
        .select('_id name emp_id').sort({ emp_id: 1 }).lean();

    } else {
      employees = await User.find({ role: 'employee', is_active: { $ne: false } })
        .select('_id name emp_id').sort({ emp_id: 1 }).lean();
    }

    if (!employees.length)
      return res.status(404).json({ success: false, message: 'No employees found' });

    // ── Fetch records ──────────────────────────────────────────────────────────
       // ── Fetch records ──────────────────────────────────────────────────────────
    const allRecs = await AttendanceRecord.find({
      date:   { $gte: startDate, $lte: endDate },
      emp_id: { $in: employees.map(e => e._id) },
    }).sort({ date: 1 }).lean();

    const todayISO = todayIST();

    const isMissedCheckoutRec = r =>
      r.is_missed_checkout === true ||
      (r.status === 'Draft' && r.checkin_time && !r.checkout_time && r.date < todayISO);

    const isLeaveRec = r =>
      r.duty_type === 'Leave' || (r.leave_type && String(r.leave_type).trim() !== '');

    const isMissedReport = status === 'Missed Check-out';

    const combinedRecs = allRecs.filter(r => isLeaveRec(r) || isMissedCheckoutRec(r));

    let filtered;
    if (isMissedReport) {
      filtered = combinedRecs.filter(isMissedCheckoutRec);
    } else if (status && status !== 'All') {
      filtered = combinedRecs.filter(r =>
        isMissedCheckoutRec(r) ? r.status === status : r.leave_status === status
      );
    } else {
      filtered = combinedRecs.filter(isLeaveRec); // leave-only for the default/"All" leave view
    }

    const empMap = {};
    for (const e of employees) empMap[String(e._id)] = e;

    const overrideLabel = r => {
      if (!r.hr_override) return '';
      const who = r.overridden_by === 'super_admin' ? 'Super Admin' : r.overridden_by === 'hr' ? 'HR' : '';
      const remark = (r.override_remark || r.hr_remark || '').replace(/^\[(HR|Super Admin) Override\]\s*/i, '').trim();
      return who ? `${who}${remark ? `: ${remark}` : ''}` : remark;
    };

    const rows = isMissedReport
  ? await Promise.all(filtered.map(async r => ({
      empCode:         empMap[String(r.emp_id)]?.emp_id || '',
      empName:         empMap[String(r.emp_id)]?.name   || '',
      date:            r.date || '',
      checkinTime:     r.checkin_time || '',
      locationCheckin: await buildLocationText(r.location_address, r.latitude ?? r.checkin_lat, r.longitude ?? r.checkin_lng),
      managerAction:   r.status || 'Pending',
      managerRemark:   (r.manager_remark || r.checkout_remarks || '').replace(/^\[(HR|Super Admin) Override\]\s*/i, '').trim(),
      override:        overrideLabel(r),
    })))
      : filtered.map(r => {
          const startD   = r.date || '';
          const endD     = r.end_date || startD;
          const dayCount = (startD && endD && endD !== startD)
            ? Math.round((new Date(endD) - new Date(startD)) / 86400000) + 1
            : 1;
          return {
            empCode:       empMap[String(r.emp_id)]?.emp_id || '',
            empName:       empMap[String(r.emp_id)]?.name   || '',
            startDate:     startD,
            endDate:       endD !== startD ? endD : '',
            days:          String(dayCount),
            leaveType:     r.leave_type     || '',
            status:        r.leave_status   || r.status || '',
            reason:        r.leave_reason   || '',
            managerRemark: r.manager_remark || '',
            hrOverride:    r.hr_override    ? 'Yes' : 'No',
            hrRemark:      r.hr_remark      || '',
          };
        });

        const rangeLabel =
      `${ordinal(isoDay(startDate))} ${monAbbr(startDate)} ${isoYear(startDate)}` +
      ` To ` +
      `${ordinal(isoDay(endDate))} ${new Date(endDate+'T00:00:00+05:30').toLocaleDateString('en-IN', { timeZone: IST, month: 'long' })} ${isoYear(endDate)}`;

    const reportLabel = isMissedReport ? 'Missed Check-out Report' : 'Leave Report';
    const reportTitle = employees.length === 1
      ? `${reportLabel} – ${employees[0].name} (${employees[0].emp_id || '—'})`
      : `${reportLabel} – BRP (Block Resource Person)`;

    const statusOf = r => isMissedReport ? r.managerAction : r.status;
    const approved = rows.filter(r => statusOf(r) === 'Approved').length;
    const rejected = rows.filter(r => statusOf(r) === 'Rejected').length;
    const pending  = rows.filter(r => statusOf(r) === 'Pending').length;

    // ══════════════════════════════════════════════════════════════════════════
    //  EXCEL
    // ══════════════════════════════════════════════════════════════════════════
    if (format === 'excel') {
      const wb = new ExcelJS.Workbook(); wb.creator = 'RAMP AMS'; wb.calcProperties = { fullCalcOnLoad: true };
      const ws = wb.addWorksheet(isMissedReport ? 'Missed Checkout Report' : 'Leave Report');

      const FILL_HDR     = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1F3864' } };
      const FILL_SUB     = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE8EDF4' } };
      const FILL_EVEN    = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFFFFF' } };
      const FILL_ODD     = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF7F7F7' } };
      const FILL_APPROVE = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFD1FAE5' } };
      const FILL_REJECT  = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFEE2E2' } };
      const FILL_PENDING = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFF9C4' } };
      const CBDR = {
        top:    { style: 'thin', color: { argb: 'FFCCCCCC' } },
        bottom: { style: 'thin', color: { argb: 'FFCCCCCC' } },
        left:   { style: 'thin', color: { argb: 'FFCCCCCC' } },
        right:  { style: 'thin', color: { argb: 'FFCCCCCC' } },
      };

      const COLS = isMissedReport ? [
        { key: 'empCode',         header: 'Emp Code',                  width: 12 },
        { key: 'empName',         header: 'Emp Name',                  width: 22 },
        { key: 'date',            header: 'Date',                      width: 14 },
        { key: 'checkinTime',     header: 'Check-in Time',             width: 14, group: true },
        { key: 'locationCheckin', header: 'Location Check-in',         width: 42, group: true },
        { key: 'managerAction',   header: 'Manager Action',            width: 16 },
        { key: 'managerRemark',   header: 'Manager Remark',            width: 28 },
        { key: 'override',        header: 'Override (Name & Remark)',  width: 34 },
      ] : [
        { key: 'empCode',       header: 'Emp Code',      width: 12 },
        { key: 'empName',       header: 'Employee Name', width: 22 },
        { key: 'startDate',     header: 'From Date',     width: 14 },
        { key: 'endDate',       header: 'To Date',       width: 14 },
        { key: 'days',          header: 'Days',          width:  7 },
        { key: 'leaveType',     header: 'Leave Type',    width: 18 },
        { key: 'status',        header: 'Status',        width: 14 },
        { key: 'reason',        header: 'Reason',        width: 32 },
        { key: 'managerRemark', header: 'Manager Remark',width: 28 },
        { key: 'hrOverride',    header: 'HR Override',   width: 13 },
        { key: 'hrRemark',      header: 'HR Remark',     width: 28 },
      ];
      const NC = COLS.length;

      ws.mergeCells(1, 1, 1, NC);
      Object.assign(ws.getCell(1, 1), {
        value: reportTitle,
        font:  { bold: true, size: 14, color: { argb: 'FFFFFFFF' }, name: 'Calibri' },
        fill:  FILL_HDR,
        alignment: { horizontal: 'center', vertical: 'center' },
      });
      ws.getRow(1).height = 26;

      ws.mergeCells(2, 1, 2, NC);
      Object.assign(ws.getCell(2, 1), {
        value: `Period: ${rangeLabel}`,
        font:  { bold: true, size: 11, color: { argb: 'FF1F3864' }, name: 'Calibri' },
        fill:  FILL_SUB,
        alignment: { horizontal: 'center', vertical: 'center' },
      });
      ws.getRow(2).height = 18;

      ws.mergeCells(3, 1, 3, NC);
      Object.assign(ws.getCell(3, 1), {
        value: `Total: ${rows.length}   |   Approved: ${approved}   |   Rejected: ${rejected}   |   Pending: ${pending}`,
        font:  { size: 10, italic: true, color: { argb: 'FF444444' }, name: 'Calibri' },
        fill:  FILL_SUB,
        alignment: { horizontal: 'center', vertical: 'center' },
      });
      ws.getRow(3).height = 15;

      let headerRow = 4;

      if (isMissedReport) {
        ws.getRow(4).height = 16;
        ws.getRow(5).height = 16;

        const groupIdxs = COLS.reduce((arr, c, i) => c.group ? [...arr, i + 1] : arr, []);

        COLS.forEach((col, i) => {
          const colIdx = i + 1;
          ws.getColumn(colIdx).width = col.width;
          if (!col.group) {
            ws.mergeCells(4, colIdx, 5, colIdx);
            const c = ws.getCell(4, colIdx);
            c.value = col.header;
            c.font  = { bold: true, size: 10, color: { argb: 'FFFFFFFF' }, name: 'Calibri' };
            c.fill  = FILL_HDR;
            c.border = CBDR;
            c.alignment = { horizontal: 'center', vertical: 'center' };
            ws.getCell(5, colIdx).border = CBDR;
          }
        });

        if (groupIdxs.length) {
          const gStart = groupIdxs[0], gEnd = groupIdxs[groupIdxs.length - 1];
          ws.mergeCells(4, gStart, 4, gEnd);
          Object.assign(ws.getCell(4, gStart), {
            value: 'Missed Check-out ',
            font:  { bold: true, size: 10, color: { argb: 'FFFFFFFF' }, name: 'Calibri' },
            fill:  FILL_HDR,
            border: CBDR,
            alignment: { horizontal: 'center', vertical: 'center' },
          });
          groupIdxs.forEach(colIdx => {
            const col = COLS[colIdx - 1];
            const c = ws.getCell(5, colIdx);
            c.value = col.header;
            c.font  = { bold: true, size: 9, color: { argb: 'FF1F3864' }, name: 'Calibri' };
            c.fill  = FILL_SUB;
            c.border = CBDR;
            c.alignment = { horizontal: 'center', vertical: 'center' };
          });
        }
        headerRow = 5;
      } else {
        ws.getRow(4).height = 18;
        COLS.forEach((col, i) => {
          ws.getColumn(i + 1).width = col.width;
          const c = ws.getCell(4, i + 1);
          c.value = col.header;
          c.font  = { bold: true, size: 10, color: { argb: 'FFFFFFFF' }, name: 'Calibri' };
          c.fill  = FILL_HDR;
          c.border = CBDR;
          c.alignment = { horizontal: 'center', vertical: 'center' };
        });
      }

      const dataStart = headerRow + 1;

      if (rows.length === 0) {
        ws.mergeCells(dataStart, 1, dataStart, NC);
        Object.assign(ws.getCell(dataStart, 1), {
          value: isMissedReport
            ? 'No missed check-out records found for the selected period and filters.'
            : 'No leave records found for the selected period and filters.',
          font: { italic: true, size: 10, color: { argb: 'FF888888' } },
          alignment: { horizontal: 'center', vertical: 'center' },
        });
        ws.getRow(dataStart).height = 18;
      } else {
        rows.forEach((row, idx) => {
          const rowN = dataStart + idx;
          ws.getRow(rowN).height = 15;
          const sv = statusOf(row);
          let rowFill = idx % 2 === 0 ? FILL_EVEN : FILL_ODD;
          if      (sv === 'Approved') rowFill = FILL_APPROVE;
          else if (sv === 'Rejected') rowFill = FILL_REJECT;
          else if (sv === 'Pending')  rowFill = FILL_PENDING;

          const centerKeys = isMissedReport
            ? ['empCode', 'date', 'checkinTime', 'managerAction']
            : ['empCode', 'status', 'hrOverride', 'days', 'startDate', 'endDate'];
          const wrapKeys = isMissedReport
            ? ['locationCheckin', 'managerRemark', 'override']
            : ['reason', 'managerRemark', 'hrRemark'];

          COLS.forEach((col, i) => {
            const c = ws.getCell(rowN, i + 1);
            c.value  = row[col.key] || '';
            c.fill   = rowFill;
            c.border = CBDR;
            c.font   = { size: 9, name: 'Calibri' };
            c.alignment = {
              horizontal: centerKeys.includes(col.key) ? 'center' : 'left',
              vertical:   'center',
              wrapText:   wrapKeys.includes(col.key),
            };
          });

          const statusColIdx = isMissedReport
            ? COLS.findIndex(c => c.key === 'managerAction') + 1
            : COLS.findIndex(c => c.key === 'status') + 1;
          if (statusColIdx > 0) {
            const sc = ws.getCell(rowN, statusColIdx);
            const statusColor = sv === 'Approved' ? 'FF047857' : sv === 'Rejected' ? 'FFB91C1C' : 'FFB45309';
            sc.font = { bold: true, size: 9, name: 'Calibri', color: { argb: statusColor } };
          }
        });
      }

      ws.views = [{ state: 'frozen', xSplit: 2, ySplit: headerRow }];
      ws.autoFilter = { from: { row: headerRow, column: 1 }, to: { row: headerRow, column: NC } };
      ws.pageSetup = {
        paperSize: 9, orientation: 'landscape',
        fitToPage: true, fitToWidth: 1, fitToHeight: 0,
        printTitlesRow: `$1:$${headerRow}`,
        margins: { left: 0.3, right: 0.3, top: 0.4, bottom: 0.4, header: 0.2, footer: 0.2 },
      };

      const fname = isMissedReport
        ? `Missed_Checkout_Report_${startDate}_to_${endDate}.xlsx`
        : `Leave_Report_${startDate}_to_${endDate}.xlsx`;

      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition', `attachment; filename="${fname}"`);
      res.setHeader('Access-Control-Expose-Headers', 'Content-Disposition');
      await wb.xlsx.write(res);
      return res.end();
    }

    // ══════════════════════════════════════════════════════════════════════════
    //  PDF
    // ══════════════════════════════════════════════════════════════════════════
    if (format === 'pdf') {
      const doc = new PDFDoc({
        size: 'A3', layout: 'landscape',
        margins: { top: 28, bottom: 28, left: 28, right: 28 },
        autoFirstPage: true,
      });
      const fname = isMissedReport
        ? `Missed_Checkout_Report_${startDate}_to_${endDate}.pdf`
        : `Leave_Report_${startDate}_to_${endDate}.pdf`;
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="${fname}"`);
      res.setHeader('Access-Control-Expose-Headers', 'Content-Disposition');
      doc.pipe(res);

      const ML      = 28;
      const usableW = doc.page.width - ML * 2;

      const colDefs = isMissedReport ? [
        { key: 'empCode',         header: 'Emp Code',                 w: 48  },
        { key: 'empName',         header: 'Emp Name',                 w: 100 },
        { key: 'date',            header: 'Date',                     w: 60  },
        { key: 'checkinTime',     header: 'Check-in Time',            w: 70,  group: true },
        { key: 'locationCheckin', header: 'Location Check-in',        w: 440, group: true },
        { key: 'managerAction',   header: 'Manager Action',           w: 75  },
        { key: 'managerRemark',   header: 'Manager Remark',           w: 140 },
        { key: 'override',        header: 'Override (Name & Remark)', w: 160 },
      ] : [
        { key: 'empCode',       header: 'Emp Code',       w: 48  },
        { key: 'empName',       header: 'Employee Name',  w: 105 },
        { key: 'startDate',     header: 'From Date',      w: 58  },
        { key: 'endDate',       header: 'To Date',        w: 58  },
        { key: 'days',          header: 'Days',           w: 28  },
        { key: 'leaveType',     header: 'Leave Type',     w: 75  },
        { key: 'status',        header: 'Status',         w: 62  },
        { key: 'reason',        header: 'Reason',         w: 130 },
        { key: 'managerRemark', header: 'Manager Remark', w: 120 },
        { key: 'hrOverride',    header: 'HR Override',    w: 48  },
        { key: 'hrRemark',      header: 'HR Remark',      w: 105 },
      ];

      const totalW = colDefs.reduce((a, c) => a + c.w, 0);
      const cw = colDefs.map(c => (c.w / totalW) * usableW);
      const RH = 14, HRH = 16, GROUP_RH = 14;
      let y = ML;

      const drawPageHeader = (yy) => {
        doc.rect(ML, yy, usableW, 20).fill('#1F3864');
        doc.fillColor('#FFFFFF').fontSize(11).font('Helvetica-Bold')
           .text(reportTitle, ML, yy + 5, { width: usableW, align: 'center' });
        yy += 20;
        doc.rect(ML, yy, usableW, 13).fill('#E8EDF4').stroke('#CCCCCC');
        doc.fillColor('#1F3864').fontSize(8).font('Helvetica')
           .text(
             `Period: ${rangeLabel}   |   Total: ${rows.length}   Approved: ${approved}   Rejected: ${rejected}   Pending: ${pending}`,
             ML + 4, yy + 3, { width: usableW - 8, align: 'center' }
           );
        yy += 13;

        if (isMissedReport) {
          doc.rect(ML, yy, usableW, GROUP_RH).fill('#1F3864').stroke('#AAAAAA');
          let gx = ML, groupStartX = null, groupW = 0;
          colDefs.forEach((c, i) => {
            if (c.group) { if (groupStartX === null) groupStartX = gx; groupW += cw[i]; }
            gx += cw[i];
          });
          if (groupStartX !== null) {
            doc.fillColor('#FFFFFF').fontSize(7.5).font('Helvetica-Bold')
               .text('Missed Check-out (Date Range)', groupStartX, yy + 3, { width: groupW, align: 'center' });
          }
          yy += GROUP_RH;
        }

        let cx = ML;
        colDefs.forEach((c, i) => {
          doc.rect(cx, yy, cw[i], HRH).fill('#1F3864').stroke('#AAAAAA');
          doc.fillColor('#FFFFFF').fontSize(6.5).font('Helvetica-Bold')
             .text(c.header, cx + 2, yy + 4, { width: cw[i] - 4, align: 'center' });
          cx += cw[i];
        });
        return yy + HRH;
      };

      y = drawPageHeader(y);

      if (rows.length === 0) {
        doc.rect(ML, y, usableW, RH).fill('#FFFFFF').stroke('#CCCCCC');
        doc.fillColor('#888888').fontSize(8).font('Helvetica-Oblique')
           .text(
             isMissedReport
               ? 'No missed check-out records found for the selected period and filters.'
               : 'No leave records found for the selected period and filters.',
             ML, y + 3, { width: usableW, align: 'center' }
           );
      } else {
        const statusKey = isMissedReport ? 'managerAction' : 'status';
        const centerKeys = isMissedReport
          ? ['empCode', 'date', 'checkinTime', 'managerAction']
          : ['empCode', 'status', 'hrOverride', 'days', 'startDate', 'endDate'];

        rows.forEach((row, idx) => {
          if (y + RH > doc.page.height - 40) {
            doc.addPage({ size: 'A3', layout: 'landscape', margins: { top: 28, bottom: 28, left: 28, right: 28 } });
            y = drawPageHeader(28);
          }
          const sv = row[statusKey];
          const bg =
            sv === 'Approved' ? '#D1FAE5' :
            sv === 'Rejected' ? '#FEE2E2' :
            sv === 'Pending'  ? '#FFF9C4' :
            (idx % 2 === 0 ? '#FFFFFF' : '#F9F9F9');

          doc.rect(ML, y, usableW, RH).fill(bg).stroke('#DDDDDD');
          let cx = ML;
          colDefs.forEach((c, i) => {
            const val = String(row[c.key] || '');
            const isCenter = centerKeys.includes(c.key);
            const textColor = c.key === statusKey
              ? (sv === 'Approved' ? '#047857' : sv === 'Rejected' ? '#B91C1C' : '#B45309')
              : '#000000';
            doc.rect(cx, y, cw[i], RH).stroke('#DDDDDD');
            doc.fillColor(textColor).fontSize(6)
               .font(c.key === statusKey ? 'Helvetica-Bold' : 'Helvetica')
               .text(val, cx + 2, y + 3, { width: cw[i] - 4, align: isCenter ? 'center' : 'left', lineBreak: false, ellipsis: true });
            cx += cw[i];
          });
          y += RH;
        });
      }

      doc.end();
      return;
    }

    res.status(400).json({ success: false, message: 'format must be excel or pdf' });
  } catch (err) {
    console.error('[LeaveExport]', err);
    res.status(500).json({ success: false, message: 'Leave export failed', error: err.message });
  }
});

// ── dashboard-stats ───────────────────────────────────────────────────────────
router.get('/dashboard-stats', authenticate, async (req,res)=>{
  try{
    const today=new Date().toISOString().split('T')[0];
    const thisMonth=today.substring(0,7);
    const empFilter={};
    if(req.user.role==='employee')     empFilter.emp_id    =toObjId(req.user.id);
    else if(req.user.role==='manager') empFilter.manager_id=toObjId(req.user.id);
    const monthStart=`${thisMonth}-01`;
    const [year,month]=thisMonth.split('-').map(Number);
    const nextMonth=month===12?`${year+1}-01-01`:`${year}-${String(month+1).padStart(2,'0')}-01`;
    const monthlyResult=await AttendanceRecord.aggregate([
      {$match:{date:{$gte:monthStart,$lt:nextMonth},...empFilter}},
      {$group:{_id:null,total:{$sum:1},approved:{$sum:{$cond:[{$eq:['$status','Approved']},1,0]}},pending:{$sum:{$cond:[{$eq:['$status','Pending']},1,0]}},rejected:{$sum:{$cond:[{$eq:['$status','Rejected']},1,0]}},on_duty:{$sum:{$cond:[{$eq:['$duty_type','On Duty']},1,0]}}}},
      {$project:{_id:0}},
    ]);
    const monthly=monthlyResult[0]||{total:0,approved:0,pending:0,rejected:0,on_duty:0};
    const sevenDaysAgo=new Date(); sevenDaysAgo.setDate(sevenDaysAgo.getDate()-7);
    const trend=await AttendanceRecord.aggregate([
      {$match:{date:{$gte:sevenDaysAgo.toISOString().split('T')[0]},...empFilter}},
      {$group:{_id:'$date',count:{$sum:1},approved:{$sum:{$cond:[{$eq:['$status','Approved']},1,0]}}}},
      {$project:{_id:0,date:'$_id',count:1,approved:1}},
      {$sort:{date:1}},
    ]);
    res.json({success:true,data:{monthly,trend}});
  }catch(err){
    res.status(500).json({success:false,message:'Server error',error:err.message});
  }
});
// ══════════════════════════════════════════════════════════════════════════════
//  GET /api/reports/daily-log-export
//  Single-employee daily log: Date | Check-In | Check-Out | Total Time | Duty Type | Leave Type
//  status: 'All' | 'Today Check-in' | 'Pending' | 'Approved' | 'Rejected'  (mirrors the queue tabs)
//
//  Check-In colour rule:  before 10:00 AM → green (good) | at/after 10:00 AM → red (late)
//  Check-Out colour rule: before 4:00 PM  → red (early)  | at/after 5:30 PM  → green (good)
//                         between 4:00–5:30 PM → neutral (no fill)
// ══════════════════════════════════════════════════════════════════════════════
router.get('/daily-log-export',
  authenticate,
  authorize('super_admin','admin','hr','manager','employee'),
  async (req, res) => {
  try {
    const { format='excel', empId, status='All' } = req.query;
    let { startDate, endDate } = req.query;
    const role = req.user.role;

    const targetEmpId = role === 'employee' ? req.user.id : empId;
    if (!targetEmpId)
      return res.status(400).json({success:false,message:'empId is required'});

    const empFilter = role === 'manager'
      ? { _id: toObjId(targetEmpId), manager_id: toObjId(req.user.id) }
      : { _id: toObjId(targetEmpId) };
    const emp = await User.findOne(empFilter)
      .select('_id name emp_id assigned_block assigned_district role_type designation')
      .lean();
    if (!emp) return res.status(404).json({success:false,message:'Employee not found'});

    // "Today Check-in" tab forces the date range to today
    if (status === 'Today Check-in') startDate = endDate = todayIST();
    if (!startDate || !endDate)
      return res.status(400).json({success:false,message:'startDate and endDate are required'});

    // Same overlap fix as the main /export route above — a multi-day leave
    // dated at its START day would otherwise vanish from the query (and its
    // in-range days wrongly read as Absent) whenever that start day falls
    // before the requested window.
    const recFilter = {
      emp_id: emp._id,
      date:   {$lte:endDate},
      $or: [
        { end_date: null, date: {$gte:startDate} },
        { end_date: {$gte:startDate} },
      ],
    };
    if (status && !['All','Today Check-in'].includes(status)) recFilter.status = status;

   let recs = await AttendanceRecord.find(recFilter).sort({date:1}).lean();
if (status === 'Today Check-in') {
  recs = recs.filter(r =>
    r.checkin_time || r.checkinTime || r.check_in_time || r.checkIn
  );
}
const expandedRecs = [];
for (const r of recs) {
  const isMultiDayLeave =
    (r.duty_type === 'Leave' || (r.leave_type && String(r.leave_type).trim())) &&
    r.end_date && r.end_date > r.date;
  if (!isMultiDayLeave) { expandedRecs.push(r); continue; }
  expandDates(r.date, r.end_date).forEach(d => {
    if (d < startDate || d > endDate) return; // stay within the requested window
    expandedRecs.push({ ...r, date: d });
  });
}
recs = expandedRecs.sort((a, b) => a.date.localeCompare(b.date));

    // ── Safe time parsing: handles ISO datetime, plain "HH:mm", epoch, or Date ──
    const parseDateTime = (dateStr, timeVal) => {
      if (!timeVal) return null;
      if (timeVal instanceof Date) return isNaN(timeVal) ? null : timeVal;
      if (typeof timeVal === 'number') {
        const d = new Date(timeVal);
        return isNaN(d) ? null : d;
      }
      if (typeof timeVal === 'string') {
        // Full ISO date/datetime string
        if (/^\d{4}-\d{2}-\d{2}/.test(timeVal) || timeVal.includes('T')) {
          const d = new Date(timeVal);
          return isNaN(d) ? null : d;
        }
        // Plain "HH:mm" or "HH:mm:ss" — combine with the record's own date
        const m = timeVal.match(/^(\d{1,2}):(\d{2})(:(\d{2}))?/);
        if (m && dateStr) {
          const d = new Date(`${dateStr}T${m[1].padStart(2,'0')}:${m[2]}:${m[4]||'00'}+05:30`);
          return isNaN(d) ? null : d;
        }
      }
      return null;
    };

    const fmtHM   = mins => `${Math.floor(mins/60)}h ${mins%60}m`;
    // 12h to match the app's other exports/screens (see fmt12h() in attendance.js).
    const timeStr = d => d ? d.toLocaleTimeString('en-IN',{timeZone:IST,hour:'2-digit',minute:'2-digit',hour12:true}) : '';

    // Threshold buckets — matches the legend (Check-In: 10 AM · Check-Out: 4 PM / 5:30 PM)
    const CHECKIN_CUTOFF = 10*60;         // 10:00 AM in minutes
    const CHECKOUT_EARLY = 16*60;         // 4:00 PM
    const CHECKOUT_FULL  = 17*60 + 30;    // 5:30 PM
    const minsOfDay = d => d.getHours()*60 + d.getMinutes();

    const checkinStatus = d => {
      if (!d) return null;
      return minsOfDay(d) < CHECKIN_CUTOFF ? 'good' : 'late'; // green / red
    };
    const checkoutStatus = d => {
      if (!d) return null;
      const m = minsOfDay(d);
      if (m < CHECKOUT_EARLY) return 'early';   // red
      if (m >= CHECKOUT_FULL) return 'good';    // green
      return null;                              // neutral, between 4–5:30
    };

    const rows = recs.map(r => {
      const ciRaw = r.checkin_time ?? r.checkinTime ?? r.check_in_time ?? r.checkIn;
      const coRaw = r.checkout_time ?? r.checkoutTime ?? r.check_out_time ?? r.checkOut;
      const ci = parseDateTime(r.date, ciRaw);
      const co = parseDateTime(r.date, coRaw);

      let total = '';
      let coDisplay = '';
      if (ci && co) {
        const mins = Math.round((co - ci) / 60000);
        total = mins > 0 ? fmtHM(mins) : '';
        coDisplay = timeStr(co);
      } else if (ci && !co) {
        coDisplay = 'Missed';
      }

      return {
        date: r.date,
        checkin: ci ? timeStr(ci) : '',
        checkout: coDisplay,
        total,
        dutyType: r.duty_type || '',
        leaveType: r.leave_type || '',
        missedCheckout: !!(ci && !co),
        checkinFlag:  checkinStatus(ci),
        checkoutFlag: co ? checkoutStatus(co) : null,
      };
    });

    const workingDays    = rows.filter(r => r.dutyType==='Office Duty' || r.dutyType==='On Duty').length;
    // Holidays are DB-driven (Holiday collection via isHoliday()), never a
    // per-record duty_type flag — no code path ever writes duty_type:'holiday',
    // so the old `recs.filter(...duty_type==='holiday')` here always returned 0.
    // Count actual calendar holidays in the requested window instead, same
    // convention as the /export route's holCount.
    const holidays = expandDates(startDate, endDate).filter(d => !isNonWorkingDay(d) && isHoliday(d)).length;
    // Only count leave that's actually confirmed — a Pending or Rejected
    // leave application isn't a "day off", it just looked like one until
    // this filter was added (matches the Approved-gated logic everywhere
    // else in this file, e.g. toCode()).
    const leaves            = recs.filter(r =>
      (r.duty_type==='Leave' || (r.leave_type && String(r.leave_type).trim())) &&
      (r.leave_status || r.status) === 'Approved'
    ).length;
    const missedCheckout  = rows.filter(r => r.missedCheckout).length;
    const absent            = recs.filter(r => (r.duty_type||'').toLowerCase()==='absent' ||
                              (r.status==='Rejected' && !(r.checkin_time||r.checkinTime||r.check_in_time||r.checkIn))).length;
    const totalDays         = rows.length;
    const approved           = recs.filter(r => (r.leave_status||r.status)==='Approved').length;
    const pending             = recs.filter(r => (r.leave_status||r.status)==='Pending').length;
    const rejected             = recs.filter(r => (r.leave_status||r.status)==='Rejected').length;

    const headerLine = [emp.emp_id, emp.name, emp.assigned_district, emp.assigned_block]
      .filter(Boolean).join('  |  ');

    // ── Filename helper — used by both formats ────────────────────────────
    const sanitize = s => String(s||'').trim().replace(/[^a-zA-Z0-9]+/g,'_').replace(/^_+|_+$/g,'');
    const rangePart = status === 'Today Check-in' ? sanitize(startDate) : `${startDate}_to_${endDate}`;
    const fnameBase = `${sanitize(emp.name)}${emp.emp_id?'_'+sanitize(emp.emp_id):''}_${sanitize(status)}_${rangePart}`;

    // ══════════════════════════════════════════════════════════════════════
    //  EXCEL
    // ══════════════════════════════════════════════════════════════════════
    if (format === 'excel') {
      const wb = new ExcelJS.Workbook(); wb.creator='RAMP AMS'; wb.calcProperties = { fullCalcOnLoad: true };
      const ws = wb.addWorksheet('Daily Log');

      const NAVY   = {type:'pattern',pattern:'solid',fgColor:{argb:'FF1F3864'}};
      const LBLUE  = {type:'pattern',pattern:'solid',fgColor:{argb:'FFDCE6F1'}};
      const GREEN  = {type:'pattern',pattern:'solid',fgColor:{argb:'FF375623'}};
      const GREEN2 = {type:'pattern',pattern:'solid',fgColor:{argb:'FFA9D18E'}};
      const FILL_GOOD = {type:'pattern',pattern:'solid',fgColor:{argb:'FFD1FAE5'}};
      const FILL_LATE = {type:'pattern',pattern:'solid',fgColor:{argb:'FFFEE2E2'}};
      const COLOR_GOOD = 'FF047857';
      const COLOR_LATE = 'FFB91C1C';
      const CBDR = {
        top:{style:'thin',color:{argb:'FFCCCCCC'}}, bottom:{style:'thin',color:{argb:'FFCCCCCC'}},
        left:{style:'thin',color:{argb:'FFCCCCCC'}}, right:{style:'thin',color:{argb:'FFCCCCCC'}},
      };

     const COLS = ['Date','Check-In','Check-Out','Total Time','Duty Type','Leave Type'];

// Row 1 — employee info banner
ws.mergeCells(1,1,1,COLS.length);
Object.assign(ws.getCell(1,1),{
  value:headerLine,
  font:{bold:true,size:12,color:{argb:'FFFFFFFF'}},
  fill:NAVY,
  alignment:{horizontal:'left',vertical:'center'},
});
ws.getRow(1).height=22;

// Row 2 — filter/period line
ws.mergeCells(2,1,2,COLS.length);
Object.assign(ws.getCell(2,1),{
  value: `Filter: ${status}   |   Period: ${status==='Today Check-in' ? startDate : `${startDate} to ${endDate}`}`,
  font:{italic:true,size:9,color:{argb:'FF555555'}},
  alignment:{horizontal:'left',vertical:'center'},
});
ws.getRow(2).height=15;

// Row 3 — column headers (THIS is the block that must run, once, for ALL 6 columns)
COLS.forEach((h,i)=>{
  const c=ws.getCell(3,i+1);
  c.value = h;
  c.font  = {bold:true,size:10,color:{argb:'FF1F3864'}};
  c.fill  = LBLUE;
  c.border = CBDR;
  c.alignment = {horizontal:'center',vertical:'center'};
  ws.getColumn(i+1).width = i===0?12:i===3?12:16;
});

// Data rows start at row 4
rows.forEach((r,idx)=>{
  const rn=4+idx;
        [r.date,r.checkin,r.checkout,r.total,r.dutyType,r.leaveType].forEach((v,i)=>{
          const c=ws.getCell(rn,i+1);
          c.value=v||''; c.border=CBDR; c.font={size:10};
          c.alignment={horizontal:i===0?'left':'center',vertical:'center'};

          // Column 2 (index 1) = Check-In, Column 3 (index 2) = Check-Out
          if (i===1 && r.checkinFlag) {
            c.fill = r.checkinFlag==='good' ? FILL_GOOD : FILL_LATE;
            c.font = {size:10, bold:true, color:{argb: r.checkinFlag==='good' ? COLOR_GOOD : COLOR_LATE}};
          }
          if (i===2 && r.checkoutFlag) {
            c.fill = r.checkoutFlag==='good' ? FILL_GOOD : FILL_LATE;
            c.font = {size:10, bold:true, color:{argb: r.checkoutFlag==='good' ? COLOR_GOOD : COLOR_LATE}};
          }
        });
      });

      let r = 4+rows.length+1;
      ws.mergeCells(r,1,r,COLS.length);
      Object.assign(ws.getCell(r,1),{
        value:`Working Days: ${workingDays}  |  Holidays: ${holidays}  |  Leaves: ${leaves}  |  Missed Checkout: ${missedCheckout}  |  Absent: ${absent}  |  Total: ${totalDays} days`,
        font:{bold:true,size:10,color:{argb:'FFFFFFFF'}}, fill:GREEN, alignment:{horizontal:'left',vertical:'center'},
      });
      ws.getRow(r).height=18;

      r++;
      ws.mergeCells(r,1,r,COLS.length);
      Object.assign(ws.getCell(r,1),{
        value:`Approved: ${approved}  |  Pending: ${pending}  |  Rejected: ${rejected}`,
        font:{bold:true,size:10,color:{argb:'FF1F3864'}}, fill:GREEN2, alignment:{horizontal:'left',vertical:'center'},
      });
      ws.getRow(r).height=18;

      res.setHeader('Content-Type','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition',`attachment; filename="${fnameBase}.xlsx"`);
      res.setHeader('Access-Control-Expose-Headers','Content-Disposition');
      await wb.xlsx.write(res);
      return res.end();
    }

    // ══════════════════════════════════════════════════════════════════════
    //  PDF
    // ══════════════════════════════════════════════════════════════════════
    if (format === 'pdf') {
      const doc = new PDFDoc({size:'A4',layout:'portrait',margins:{top:30,bottom:30,left:30,right:30}});
      res.setHeader('Content-Type','application/pdf');
      res.setHeader('Content-Disposition',`attachment; filename="${fnameBase}.pdf"`);
      res.setHeader('Access-Control-Expose-Headers','Content-Disposition');
      doc.pipe(res);

      const ML=30, PW=doc.page.width-60;
      doc.rect(ML,ML,PW,22).fill('#1F3864');
      doc.fillColor('#FFFFFF').fontSize(11).font('Helvetica-Bold').text(headerLine,ML+6,ML+6,{width:PW-12});

      let y = ML+22;
      doc.fillColor('#555555').fontSize(8).font('Helvetica-Oblique')
         .text(`Filter: ${status}   |   Period: ${status==='Today Check-in' ? startDate : `${startDate} to ${endDate}`}`,ML,y+3,{width:PW});
      y += 16;

      const colX=[ML, ML+70, ML+150, ML+230, ML+310, ML+410];
      const colW=[70,80,80,80,100,80];
      doc.rect(ML,y,PW,16).fill('#DCE6F1').stroke('#AAAAAA');
      ['Date','Check-In','Check-Out','Total Time','Duty Type','Leave Type'].forEach((h,i)=>{
        doc.fillColor('#1F3864').fontSize(8).font('Helvetica-Bold').text(h,colX[i]+2,y+4,{width:colW[i]-4,align:'center'});
      });
      y+=16;
      rows.forEach((r,idx)=>{
        if (y+14>doc.page.height-100){doc.addPage();y=30;}
        doc.rect(ML,y,PW,14).fill(idx%2===0?'#FFFFFF':'#F7F7F7').stroke('#DDDDDD');
        [r.date,r.checkin,r.checkout,r.total,r.dutyType,r.leaveType].forEach((v,i)=>{
          let color = '#000000';
          if (i===1 && r.checkinFlag)  color = r.checkinFlag==='good'  ? '#047857' : '#B91C1C';
          if (i===2 && r.checkoutFlag) color = r.checkoutFlag==='good' ? '#047857' : '#B91C1C';
          doc.fillColor(color).fontSize(7.5).font(color==='#000000' ? 'Helvetica' : 'Helvetica-Bold')
             .text(String(v||''),colX[i]+2,y+3,{width:colW[i]-4,align:i===0?'left':'center',lineBreak:false,ellipsis:true});
        });
        y+=14;
      });

      y+=6;
      doc.rect(ML,y,PW,18).fill('#375623');
      doc.fillColor('#FFFFFF').fontSize(8).font('Helvetica-Bold')
         .text(`Working Days: ${workingDays}  |  Holidays: ${holidays}  |  Leaves: ${leaves}  |  Missed Checkout: ${missedCheckout}  |  Absent: ${absent}  |  Total: ${totalDays} days`,ML+6,y+5,{width:PW-12});
      y+=18;
      doc.rect(ML,y,PW,18).fill('#A9D18E');
      doc.fillColor('#1F3864').fontSize(8).font('Helvetica-Bold')
         .text(`Approved: ${approved}  |  Pending: ${pending}  |  Rejected: ${rejected}`,ML+6,y+5,{width:PW-12});

      doc.end();
      return;
    }

    res.status(400).json({success:false,message:'format must be excel or pdf'});
  } catch(err){
    console.error('[DailyLogExport]',err);
    res.status(500).json({success:false,message:'Export failed',error:err.message});
  }
});
// ══════════════════════════════════════════════════════════════════════════════
//  GET /api/reports/late-checkout          (preview — powers the "View" button)
//  GET /api/reports/late-checkout-export   (excel / pdf download)
//  "Late check-out" = checkout_time >= 18:30 (6:30 PM IST)
// ══════════════════════════════════════════════════════════════════════════════
const LATE_CHECKOUT_CUTOFF = '18:30';

const resolveLateCheckoutEmployees = async (req) => {
  const role = req.user.role;
  const { empId, managerId } = req.query;
  const EMP_SELECT = '_id name emp_id';
  let employees = [];

  if (role === 'employee') {
    const me = await User.findById(req.user.id).select(EMP_SELECT).lean();
    if (me) employees = [me];
  } else if (empId && String(empId).trim() !== '') {
    const specificFilter = role === 'manager'
      ? { _id: toObjId(empId), manager_id: toObjId(req.user.id) }
      : { _id: toObjId(empId) };
    const specific = await User.findOne(specificFilter).select(EMP_SELECT).lean();
    if (specific) employees = [specific];
  } else if (managerId && String(managerId).trim() !== '') {
    employees = await User.find({ manager_id: toObjId(managerId), is_active: { $ne: false } })
      .select(EMP_SELECT).sort({ emp_id: 1 }).lean();
  } else if (role === 'manager') {
    employees = await User.find({ manager_id: toObjId(req.user.id), is_active: { $ne: false } })
      .select(EMP_SELECT).sort({ emp_id: 1 }).lean();
  } else {
    employees = await User.find({ role: 'employee', is_active: { $ne: false } })
      .select(EMP_SELECT).sort({ emp_id: 1 }).lean();
  }
  return employees;
};

const buildLateCheckoutRows = async ({ startDate, endDate, employees }) => {
  const recs = await AttendanceRecord.find({
    date:          { $gte: startDate, $lte: endDate },
    emp_id:        { $in: employees.map(e => e._id) },
    checkout_time: { $ne: null, $gte: LATE_CHECKOUT_CUTOFF },
  }).sort({ date: 1 }).lean();

  const empMap = {};
  for (const e of employees) empMap[String(e._id)] = e;

  return Promise.all(recs.map(async r => {
    const emp        = empMap[String(r.emp_id)];
    const checkinLoc  = await buildLocationText(r.location_address, r.latitude, r.longitude);
    const checkoutLoc = await buildLocationText(r.checkout_location_address, r.checkout_lat, r.checkout_lng);
    return {
      empCode:  emp?.emp_id || '',
      empName:  emp?.name   || '',
      date:     r.date,
      checkinLocationTime:  r.checkin_time
        ? `${checkinLoc || 'Address not captured'} (${fmt12h(r.checkin_time)})`
        : (checkinLoc || ''),
      checkoutLocationTime: r.checkout_time
        ? `${checkoutLoc || 'Address not captured'} (${fmt12h(r.checkout_time)})`
        : (checkoutLoc || ''),
      reason: (r.late_checkout_reason && r.late_checkout_reason.trim()) || 'No reason provided',
    };
  }));
};

router.get('/late-checkout',
  authenticate,
  authorize('super_admin','admin','hr','manager','employee'),
  async (req, res) => {
  try {
    const { startDate, endDate } = req.query;
    if (!startDate || !endDate)
      return res.status(400).json({ success:false, message:'startDate and endDate are required' });

    const employees = await resolveLateCheckoutEmployees(req);
    if (!employees.length)
      return res.status(404).json({ success:false, message:'No employees found' });

    const rows = await buildLateCheckoutRows({ startDate, endDate, employees });
    res.json({ success:true, data: rows, count: rows.length });
  } catch (err) {
    console.error('[LateCheckoutView]', err);
    res.status(500).json({ success:false, message:'Failed to load late check-out records', error: err.message });
  }
});

router.get('/late-checkout-export',
  authenticate,
  authorize('super_admin','admin','hr','manager','employee'),
  async (req, res) => {
  try {
    const { format = 'excel', empId } = req.query;
    const { startDate, endDate } = req.query;
    if (!startDate || !endDate)
      return res.status(400).json({ success:false, message:'startDate and endDate are required' });

    const employees = await resolveLateCheckoutEmployees(req);
    if (!employees.length)
      return res.status(404).json({ success:false, message:'No employees found' });

    const rows = await buildLateCheckoutRows({ startDate, endDate, employees });

        const rangeLabel =
      `${ordinal(isoDay(startDate))} ${monAbbr(startDate)} ${isoYear(startDate)}` +
      ` To ` +
      `${ordinal(isoDay(endDate))} ${new Date(endDate+'T00:00:00+05:30').toLocaleDateString('en-IN',{timeZone:IST,month:'long'})} ${isoYear(endDate)}`;

    const sanitize = s => String(s||'').trim().replace(/[^a-zA-Z0-9]+/g,'_').replace(/^_+|_+$/g,'');
    const singleEmp = employees.length === 1
      ? employees[0]
      : (empId ? employees.find(e => String(e._id) === String(empId)) : null);
    const fnameBase = singleEmp
      ? `${sanitize(singleEmp.name)}_${sanitize(singleEmp.emp_id)}_LateCheckout_${startDate}_to_${endDate}`
      : `BRP_LateCheckout_${startDate}_to_${endDate}`;

    if (format === 'excel') {
      const wb = new ExcelJS.Workbook(); wb.creator = 'RAMP AMS'; wb.calcProperties = { fullCalcOnLoad: true };
      const ws = wb.addWorksheet('Late Check-out');

      const NAVY = { type:'pattern', pattern:'solid', fgColor:{ argb:'FF1F3864' } };
      const HDR  = { type:'pattern', pattern:'solid', fgColor:{ argb:'FFDCE6F1' } };
      const EVEN = { type:'pattern', pattern:'solid', fgColor:{ argb:'FFFFFFFF' } };
      const ODD  = { type:'pattern', pattern:'solid', fgColor:{ argb:'FFF7F7F7' } };
      const CBDR = {
        top:{style:'thin',color:{argb:'FFCCCCCC'}}, bottom:{style:'thin',color:{argb:'FFCCCCCC'}},
        left:{style:'thin',color:{argb:'FFCCCCCC'}}, right:{style:'thin',color:{argb:'FFCCCCCC'}},
      };

      const COLS = [
        { header:'Emp Name',                     width:22 },
        { header:'Emp ID',                       width:14 },
        { header:'Check-in Location with Time',  width:46 },
        { header:'Check-out Location with Time', width:46 },
        { header:'Reason (Employee Response)',   width:38 },
      ];

      ws.mergeCells(1,1,1,COLS.length);
      Object.assign(ws.getCell(1,1), {
        value: `Late Check-out — ${rangeLabel}`,
        font:  { bold:true, size:13, color:{argb:'FFFFFFFF'} },
        fill:  NAVY,
        alignment: { horizontal:'center', vertical:'center' },
      });
      ws.getRow(1).height = 24;

      COLS.forEach((c,i)=>{
        ws.getColumn(i+1).width = c.width;
        const cell = ws.getCell(2,i+1);
        cell.value = c.header; cell.fill = HDR; cell.border = CBDR;
        cell.font  = { bold:true, size:10, color:{argb:'FF1F3864'} };
        cell.alignment = { horizontal:'center', vertical:'center', wrapText:true };
      });
      ws.getRow(2).height = 20;

      if (!rows.length) {
        ws.mergeCells(3,1,3,COLS.length);
        Object.assign(ws.getCell(3,1), {
          value: 'No late check-out records found for the selected period and filters.',
          font: { italic:true, size:10, color:{argb:'FF888888'} },
          alignment: { horizontal:'center', vertical:'center' },
        });
      } else {
        rows.forEach((r,idx)=>{
          const rn = 3+idx;
          const rf = idx%2===0 ? EVEN : ODD;
          [r.empName, r.empCode, r.checkinLocationTime, r.checkoutLocationTime, r.reason].forEach((v,i)=>{
            const c = ws.getCell(rn,i+1);
            c.value = v || ''; c.fill = rf; c.border = CBDR;
            c.font  = { size:9 };
            c.alignment = { horizontal: i<2?'center':'left', vertical:'center', wrapText: i>=2 };
          });
        });
      }

      ws.views = [{ state:'frozen', ySplit:2 }];
      ws.pageSetup = {
        paperSize:9, orientation:'landscape', fitToPage:true, fitToWidth:1, fitToHeight:0,
        printTitlesRow:'$1:$2',
        margins:{left:0.3,right:0.3,top:0.4,bottom:0.4,header:0.2,footer:0.2},
      };

      res.setHeader('Content-Type','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition',`attachment; filename="${fnameBase}.xlsx"`);
      res.setHeader('Access-Control-Expose-Headers','Content-Disposition');
      await wb.xlsx.write(res);
      return res.end();
    }

    if (format === 'pdf') {
      const doc = new PDFDoc({ size:'A3', layout:'landscape', margins:{top:28,bottom:28,left:28,right:28}, autoFirstPage:true });
      res.setHeader('Content-Type','application/pdf');
      res.setHeader('Content-Disposition',`attachment; filename="${fnameBase}.pdf"`);
      res.setHeader('Access-Control-Expose-Headers','Content-Disposition');
      doc.pipe(res);

      const ML = 28;
      const usableW = doc.page.width - ML*2;
      const colDefs = [
        { key:'empName',              header:'Emp Name',                     w:0.14 },
        { key:'empCode',               header:'Emp ID',                       w:0.08 },
        { key:'checkinLocationTime',  header:'Check-in Location with Time',  w:0.34 },
        { key:'checkoutLocationTime', header:'Check-out Location with Time', w:0.34 },
        { key:'reason',               header:'Reason (Employee Response)',   w:0.10 },
      ];
      const cw = colDefs.map(c => c.w*usableW);
      const HRH = 18, RH = 20;

      const drawHeader = (yy) => {
        doc.rect(ML,yy,usableW,20).fill('#1F3864');
        doc.fillColor('#FFFFFF').fontSize(11).font('Helvetica-Bold')
           .text(`Late Check-out — ${rangeLabel}`, ML, yy+5, { width:usableW, align:'center' });
        yy += 20;
        let cx = ML;
        colDefs.forEach((c,i)=>{
          doc.rect(cx,yy,cw[i],HRH).fill('#DCE6F1').stroke('#AAAAAA');
          doc.fillColor('#1F3864').fontSize(8).font('Helvetica-Bold')
             .text(c.header, cx+3, yy+4, { width:cw[i]-6, align:'center' });
          cx += cw[i];
        });
        return yy+HRH;
      };

      let y = drawHeader(ML);

      if (!rows.length) {
        doc.rect(ML,y,usableW,RH).fill('#FFFFFF').stroke('#CCCCCC');
        doc.fillColor('#888888').fontSize(9).font('Helvetica-Oblique')
           .text('No late check-out records found for the selected period and filters.', ML, y+5, { width:usableW, align:'center' });
        y += RH;
      } else {
        rows.forEach((r, idx) => {
  const cellValues = [r.empName, r.empCode, r.checkinLocationTime, r.checkoutLocationTime, r.reason];

  // Measure how tall each cell's wrapped text will be, take the max
  doc.fontSize(7).font('Helvetica');
  let rowH = RH; // minimum height
  colDefs.forEach((c, i) => {
    const h = doc.heightOfString(String(cellValues[i] || ''), {
      width: cw[i] - 6,
      align: i < 2 ? 'center' : 'left',
    });
    rowH = Math.max(rowH, h + 8); // +8 padding (4 top + 4 bottom)
  });

  if (y + rowH > doc.page.height - 40) {
    doc.addPage({ size: 'A3', layout: 'landscape', margins: { top: 28, bottom: 28, left: 28, right: 28 } });
    y = drawHeader(28);
  }

  const bg = idx % 2 === 0 ? '#FFFFFF' : '#F7F7F7';
  doc.rect(ML, y, usableW, rowH).fill(bg).stroke('#DDDDDD');
  let cx = ML;
  cellValues.forEach((v, i) => {
    doc.rect(cx, y, cw[i], rowH).stroke('#DDDDDD');
    doc.fillColor('#000000').fontSize(7).font('Helvetica')
       .text(String(v || ''), cx + 3, y + 4, { width: cw[i] - 6, align: i < 2 ? 'center' : 'left' });
    cx += cw[i];
  });
  y += rowH;
});
      }

      doc.end();
      return;
    }

    res.status(400).json({ success:false, message:'format must be excel or pdf' });
  } catch (err) {
    console.error('[LateCheckoutExport]', err);
    res.status(500).json({ success:false, message:'Late check-out export failed', error: err.message });
  }
});
module.exports = router;