/**
 * ระบบเช็คเขตทำความสะอาด โรงเรียนวังจันทร์วิทยา — ส่วนหลังบ้าน (Google Apps Script + Google Sheets)
 *
 * วิธีติดตั้ง (ละเอียดใน README.md):
 *   1) สร้าง Google Sheet ใหม่ > ส่วนขยาย > Apps Script > วางโค้ดนี้ทั้งหมด
 *   2) แก้ ADMIN_INITIAL_PASSWORD แล้วรันฟังก์ชัน setup หนึ่งครั้ง
 *   3) ทำให้ใช้งานได้ > เว็บแอป · ดำเนินการในฐานะ: ฉัน · ผู้มีสิทธิ์เข้าถึง: ทุกคน > นำ URL ไปใส่ใน config.js
 *
 * หลักการเก็บข้อมูล: ชีต Checks เก็บเฉพาะ "การขาด" (คนที่มาไม่ต้องมีแถว) ข้อมูลจึงเล็ก
 * เว็บโหลดข้อมูลของเขตที่มีสิทธิ์ทั้งหมดครั้งเดียว แล้วคำนวณยอดเงินฝั่งหน้าเว็บ
 */

const ADMIN_USERNAME = 'admin';
const ADMIN_NAME = 'ผู้ดูแลระบบ';
const ADMIN_INITIAL_PASSWORD = 'ChangeMe-2569'; // แก้ก่อนรัน setup

const SPREADSHEET_ID = ''; // ระบบจริง: 1H4bNw_IgxjEf8xBIeKd88k2lWvJBBHpFq07aeYkqHok
let SS_ = null;
const ss_ = () => SS_ || (SS_ = SPREADSHEET_ID ? SpreadsheetApp.openById(SPREADSHEET_ID) : SpreadsheetApp.getActive());

const SESSION_SECONDS = 8 * 60 * 60;
const MAX_FAILED_LOGINS = 5;
const LOCK_SECONDS = 10 * 60;

const H = {
  Zones: ['id', 'name', 'sort', 'active', 'createdAt'],
  // setId = เซ็ตเวรที่สังกัด · days = วันในสัปดาห์ของคนนี้เอง เช่น "1,3" (ว่าง = ใช้วันของเซ็ต / ไม่มีเซ็ต = ทุกวันทำเขต)
  Students: ['id', 'zoneId', 'no', 'prefix', 'firstName', 'lastName', 'active', 'createdAt', 'setId', 'days', 'code'],
  // เซ็ตเวรของแต่ละเขต: days = วันในสัปดาห์ 0=อา … 6=ส คั่นด้วยจุลภาค
  Sets: ['id', 'zoneId', 'name', 'days', 'sort'],
  // status: skip = ไม่มาทำเขต (คิดค่าปรับ) · absent = ขาดเรียน · leave = ลา · present = มาทำ (มีแถวเฉพาะเมื่อขาดเวรห้อง)
  // zoneAbsent = TRUE เมื่อ status = skip (เก็บไว้ให้เข้ากับข้อมูลเก่า) · source: web | import (จากระบบเดิม ไม่คิดค่าปรับซ้ำ)
  Checks: ['zoneId', 'date', 'studentId', 'zoneAbsent', 'roomAbsent', 'source', 'checkedByName', 'checkedAt', 'status'],
  // วันทำเขต: zoneId ว่าง = ค่าเริ่มต้นทุกเขต (ครูกำหนด) · มี zoneId = วันของเขตนั้นโดยเฉพาะ (หัวหน้าเขตกำหนด)
  // เขตที่ไม่มีวันของตัวเองใช้ค่าเริ่มต้น ถ้าไม่มีทั้งคู่ ใช้วันในสัปดาห์จาก Settings.checkDays
  DutyDays: ['date', 'note', 'updatedByName', 'updatedAt', 'zoneId'],
  // ยอดยกมาจากระบบเดิม ณ วันที่ asOf
  Opening: ['studentId', 'zoneId', 'asOf', 'zoneDue', 'roomDue', 'source'],
  // week = วันจันทร์ของสัปดาห์ที่เก็บเงินนี้ (ว่าง = รับเงินทั่วไป/ยอดยกมา)
  Payments: ['id', 'studentId', 'zoneId', 'date', 'kind', 'amount', 'note', 'byName', 'createdAt', 'status', 'voidByName', 'week'],
  // role: admin = ทุกเขต + ตั้งค่า · head = หัวหน้าเขต (เฉพาะ zoneIds คั่นด้วยจุลภาค)
  Users: ['username', 'name', 'role', 'zoneIds', 'salt', 'hash', 'active', 'createdAt'],
  Settings: ['key', 'value'],
  // เวลามาโรงเรียนที่สาย (หลัง 07:50) จากรายงานการมาเรียน
  Late: ['zoneId', 'studentId', 'date', 'time', 'source'],
  // สัปดาห์ที่กด "เริ่มเก็บ" แล้ว (week = วันจันทร์) · ค่าปรับที่เช็คในเว็บคิดเงินเฉพาะสัปดาห์ที่อยู่ในชีตนี้
  // kind: zone = ค่าปรับไม่ทำเขต · room = ค่าห้อง (เก็บทุกคน คนละ roomFine บาทต่อสัปดาห์)
  Weeks: ['zoneId', 'week', 'byName', 'at', 'kind'],
};
const STATUSES = ['present', 'skip', 'absent', 'leave'];
// publicView = 1 เปิดให้ดูข้อมูลโดยไม่ต้องเข้าสู่ระบบ (ดูอย่างเดียว) · maskNames = 1 ซ่อนนามสกุลในหน้าสาธารณะ
// termStart = วันเริ่มนับ "สัปดาห์ที่ 1" ของภาคเรียน (ว่าง = นับจากวันแรกที่มีข้อมูล)
const DEFAULT_SETTINGS = { zoneFine: '10', roomFine: '10', checkDays: '1,2,3,4,5', publicView: '1', maskNames: '0', termStart: '' };

/* ---------- ติดตั้งครั้งแรก (รันซ้ำได้ ไม่ลบข้อมูล) ---------- */
function setup() {
  if (ADMIN_INITIAL_PASSWORD === 'ChangeMe-2569' || ADMIN_INITIAL_PASSWORD.length < 8) {
    throw new Error('กรุณาแก้ ADMIN_INITIAL_PASSWORD เป็นรหัสของคุณเอง (อย่างน้อย 8 ตัว) ก่อนรัน setup');
  }
  const ss = ss_();
  Object.keys(H).forEach(name => {
    const s = ss.getSheetByName(name) || ss.insertSheet(name);
    s.getRange('A:Z').setNumberFormat('@'); // เก็บทุกช่องเป็นข้อความ กันชีตแปลงวันที่เอง
    s.getRange(1, 1, 1, H[name].length).setValues([H[name]]);
    s.setFrozenRows(1);
  });
  const settings = readRows_('Settings');
  Object.keys(DEFAULT_SETTINGS).forEach(k => {
    if (!settings.some(r => r.key === k)) sheet_('Settings').appendRow([k, DEFAULT_SETTINGS[k]]);
  });
  if (!findUser_(ADMIN_USERNAME)) {
    const salt = Utilities.getUuid();
    sheet_('Users').appendRow([ADMIN_USERNAME, ADMIN_NAME, 'admin', '', salt, hash_(salt, ADMIN_INITIAL_PASSWORD), 'true', now_()]);
  }
  Logger.log('ติดตั้งเรียบร้อย ผู้ใช้เริ่มต้น: ' + ADMIN_USERNAME);
}

/* ---------- จุดรับคำขอ ---------- */
function doGet() {
  return json_({ ok: true, data: { service: 'cleaning-zone', time: now_() } });
}

function doPost(e) {
  try {
    const b = JSON.parse(e.postData.contents || '{}');
    const handlers = {
      login: login_, logout: logout_, changePassword: changePassword_, data: data_, publicData: publicData_,
      saveChecks: saveChecks_, addPayment: addPayment_, voidPayment: voidPayment_,
      saveZone: saveZone_, saveStudents: saveStudents_, setStudentActive: setStudentActive_,
      importZone: importZone_, saveRoster: saveRoster_, saveSettings: saveSettings_, saveDutyDays: saveDutyDays_,
      listUsers: listUsers_, saveUser: saveUser_, resetPassword: resetPassword_, setWeek: setWeek_,
    };
    const fn = handlers[b.action];
    if (!fn) throw new Error('ไม่รู้จักคำสั่ง');
    // อ่านข้อมูล: ใช้สำเนาในแคช (เร็ว) · คำสั่งที่เขียนข้อมูล: อ่านจากชีตจริง แล้วล้างแคช
    USE_CACHE_ = READ_ACTIONS.indexOf(b.action) >= 0;
    try { return json_({ ok: true, data: fn(b) }); } finally { if (!USE_CACHE_ && NO_CLEAR.indexOf(b.action) < 0) clearRowsCache_(); }
  } catch (err) {
    return json_({ ok: false, error: String(err.message || err) });
  }
}

/* ---------- ข้อมูลทั้งหมดของเขตที่มีสิทธิ์ ---------- */
function data_(b) {
  return buildData_(requireSession_(b.token));
}

// ดูอย่างเดียว ไม่ต้องเข้าสู่ระบบ: ไม่ส่งชื่อผู้บันทึก/หมายเหตุการรับเงิน และซ่อนนามสกุลถ้าตั้งค่าไว้
function publicData_() {
  const set = settings_();
  if (!set.publicView) throw new Error('PUBLIC_OFF');
  const d = buildData_(null);
  d.zones = d.zones.filter(z => z.active);
  d.checks.forEach(c => { c.by = ''; });
  d.payments = d.payments.filter(p => p.status !== 'void').map(p => ({ id: p.id, studentId: p.studentId, zoneId: p.zoneId, date: p.date, kind: p.kind, amount: p.amount, status: p.status, week: p.week }));
  if (set.maskNames) d.students.forEach(s => { s.lastName = s.lastName ? s.lastName.charAt(0) + '.' : ''; });
  return d;
}

// me = null คือผู้ชมทั่วไป (เห็นทุกเขต)
function buildData_(me) {
  const can = (zoneId) => !me || me.role === 'admin' || me.zoneIds.indexOf(zoneId) >= 0;
  const bool = (v) => String(v).toUpperCase() === 'TRUE';
  return {
    me,
    settings: settings_(),
    dutyDays: readRows_('DutyDays').filter(d => !d.zoneId || can(d.zoneId)).map(d => ({ date: d.date, zoneId: d.zoneId || '' })),
    zones: readRows_('Zones').filter(z => can(z.id)).map(z => ({ id: z.id, name: z.name, sort: Number(z.sort) || 0, active: z.active !== 'false' })),
    students: readRows_('Students').filter(s => can(s.zoneId)).map(s => ({
      id: s.id, zoneId: s.zoneId, no: Number(s.no) || 0, prefix: s.prefix, firstName: s.firstName, lastName: s.lastName, active: s.active !== 'false',
      setId: s.setId || '', days: s.days || '', code: s.code || '',
    })),
    sets: readRows_('Sets').filter(x => can(x.zoneId)).map(x => ({ id: x.id, zoneId: x.zoneId, name: x.name, days: x.days, sort: Number(x.sort) || 0 })),
    checks: readRows_('Checks').filter(c => can(c.zoneId)).map(c => ({
      zoneId: c.zoneId, date: c.date, studentId: c.studentId, zoneAbsent: bool(c.zoneAbsent), roomAbsent: bool(c.roomAbsent),
      status: c.studentId === '_' && c.status === 'partial' ? 'partial' : STATUSES.indexOf(c.status) >= 0 ? c.status : (bool(c.zoneAbsent) ? 'skip' : 'present'),
      source: c.source, by: c.checkedByName,
    })),
    opening: readRows_('Opening').filter(o => can(o.zoneId)).map(o => ({
      studentId: o.studentId, zoneId: o.zoneId, asOf: o.asOf, zoneDue: Number(o.zoneDue) || 0, roomDue: Number(o.roomDue) || 0,
    })),
    weeks: optRows_('Weeks').filter(w => can(w.zoneId)).map(w => ({ zoneId: w.zoneId, week: w.week, kind: w.kind === 'room' ? 'room' : 'zone' })),
    late: optRows_('Late').filter(l => can(l.zoneId)).map(l => ({ studentId: l.studentId, date: l.date, time: l.time })),
    payments: readRows_('Payments').filter(p => can(p.zoneId)).map(p => ({
      id: p.id, studentId: p.studentId, zoneId: p.zoneId, date: p.date, kind: p.kind, amount: Number(p.amount) || 0,
      note: p.note, byName: p.byName, createdAt: p.createdAt, status: p.status || 'active', voidByName: p.voidByName, week: p.week || '',
    })),
  };
}

/* ---------- เช็คเขตรายวัน: แทนที่การขาดทั้งหมดของเขต+วันนั้น ---------- */
function saveChecks_(b) {
  const me = requireSession_(b.token);
  requireZone_(me, b.zoneId);
  if (!isDate_(b.date)) throw new Error('วันที่ไม่ถูกต้อง');
  const ids = new Set(readRows_('Students').filter(s => s.zoneId === b.zoneId).map(s => s.id));
  const marks = (Array.isArray(b.marks) ? b.marks : [])
    .map(m => ({ studentId: m.studentId, status: STATUSES.indexOf(m.status) >= 0 ? m.status : 'present', roomAbsent: !!m.roomAbsent }))
    // partial = บันทึกเฉพาะคนที่เช็คแล้ว (เก็บแถว "มาทำ" ด้วย) คนที่ไม่มีแถว = ยังไม่เช็ค
    .filter(m => ids.has(m.studentId) && (b.partial || m.status !== 'present' || m.roomAbsent));
  return withLock_(() => {
    const keep = readRows_('Checks').filter(c => !(c.zoneId === b.zoneId && c.date === b.date));
    const add = marks.map(m => ({
      zoneId: b.zoneId, date: b.date, studentId: m.studentId, zoneAbsent: m.status === 'skip' ? 'TRUE' : 'FALSE',
      roomAbsent: m.roomAbsent ? 'TRUE' : 'FALSE', source: 'web', checkedByName: me.name, checkedAt: now_(), status: m.status,
    }));
    // แถว studentId "_" = เขตนี้เช็ควันนี้แล้ว (แม้ทุกคนมา)
    add.push({ zoneId: b.zoneId, date: b.date, studentId: '_', zoneAbsent: 'FALSE', roomAbsent: 'FALSE', source: 'web', checkedByName: me.name, checkedAt: now_(), status: b.partial ? 'partial' : '' });
    writeAll_('Checks', keep.concat(add));
    return { saved: add.length };
  });
}

/* ---------- รับชำระเงิน ---------- */
function addPayment_(b) {
  const me = requireSession_(b.token);
  const st = readRows_('Students').find(s => s.id === b.studentId);
  if (!st) throw new Error('ไม่พบนักเรียน');
  requireZone_(me, st.zoneId);
  if (!isDate_(b.date)) throw new Error('วันที่ไม่ถูกต้อง');
  const week = isDate_(b.week) ? b.week : '';
  // items = รับหลายยอดพร้อมกัน (เช่น ค่าเขต + ค่าห้อง ของสัปดาห์เดียวกัน)
  const items = Array.isArray(b.items) ? b.items : [{ kind: b.kind, amount: b.amount }];
  const rows = items.map(it => {
    const amount = Math.round(Number(it.amount));
    if (!(amount > 0) || amount > 100000) throw new Error('จำนวนเงินไม่ถูกต้อง');
    return { id: Utilities.getUuid(), studentId: st.id, zoneId: st.zoneId, date: b.date, kind: it.kind === 'room' ? 'room' : 'zone', amount,
      note: clean_(b.note, 200), byName: me.name, createdAt: now_(), status: 'active', voidByName: '', week };
  });
  if (!rows.length) throw new Error('ไม่มีรายการ');
  return withLock_(() => { appendMany_('Payments', rows); return Array.isArray(b.items) ? rows : rows[0]; });
}

function voidPayment_(b) {
  const me = requireSession_(b.token);
  return withLock_(() => {
    const rows = readRows_('Payments');
    const i = rows.findIndex(p => p.id === b.id);
    if (i < 0) throw new Error('ไม่พบรายการ');
    requireZone_(me, rows[i].zoneId);
    if (rows[i].status === 'void') throw new Error('รายการนี้ยกเลิกแล้ว');
    const cols = H.Payments;
    sheet_('Payments').getRange(i + 2, cols.indexOf('status') + 1, 1, 2).setValues([['void', me.name]]);
    return true;
  });
}

/* ---------- จัดการเขตและนักเรียน (ผู้ดูแล) ---------- */
function saveZone_(b) {
  requireSession_(b.token, 'admin');
  const name = clean_(b.name, 100);
  if (!name) throw new Error('กรุณาใส่ชื่อเขต');
  return withLock_(() => {
    const rows = readRows_('Zones');
    const i = rows.findIndex(z => z.id === b.id);
    if (i >= 0) {
      sheet_('Zones').getRange(i + 2, 2, 1, 3).setValues([[name, String(Number(b.sort) || 0), b.active === false ? 'false' : 'true']]);
      return { id: b.id };
    }
    const id = Utilities.getUuid().slice(0, 8);
    appendObj_('Zones', { id, name, sort: String(Number(b.sort) || rows.length + 1), active: 'true', createdAt: now_() });
    return { id };
  });
}

const code_ = (v) => String(v == null ? '' : v).replace(/[\s-]/g, '').replace(/[^0-9A-Za-z]/g, '').slice(0, 20);
// เลขประจำตัวห้ามซ้ำกันทั้งโรงเรียน (ไม่นับช่องว่าง)
function assertUniqueCodes_(rows) {
  const seen = {};
  rows.forEach(r => {
    if (!r.code) return;
    if (seen[r.code]) throw new Error('เลขประจำตัว ' + r.code + ' ซ้ำกัน: ' + seen[r.code] + ' และ ' + r.firstName + ' ' + r.lastName);
    seen[r.code] = r.firstName + ' ' + r.lastName;
  });
}

// students: [{ id?, no, code, prefix, firstName, lastName }] — มี id = แก้ไข, ไม่มี = เพิ่มใหม่
function saveStudents_(b) {
  requireSession_(b.token, 'admin');
  if (!readRows_('Zones').some(z => z.id === b.zoneId)) throw new Error('ไม่พบเขต');
  const list = Array.isArray(b.students) ? b.students : [];
  return withLock_(() => {
    const rows = readRows_('Students');
    let added = 0, updated = 0;
    list.forEach(s => {
      const v = { no: String(Number(s.no) || 0), code: code_(s.code), prefix: clean_(s.prefix, 20), firstName: clean_(s.firstName, 80), lastName: clean_(s.lastName, 80) };
      if (!v.firstName) return;
      const r = s.id && rows.find(x => x.id === s.id && x.zoneId === b.zoneId);
      if (r) { Object.assign(r, v); updated++; } else {
        rows.push(Object.assign({ id: Utilities.getUuid().slice(0, 12), zoneId: b.zoneId, active: 'true', createdAt: now_() }, v)); added++;
      }
    });
    assertUniqueCodes_(rows);
    writeAll_('Students', rows);
    return { added, updated };
  });
}

function setStudentActive_(b) {
  requireSession_(b.token, 'admin');
  return withLock_(() => {
    const rows = readRows_('Students');
    const i = rows.findIndex(s => s.id === b.id);
    if (i < 0) throw new Error('ไม่พบนักเรียน');
    sheet_('Students').getRange(i + 2, H.Students.indexOf('active') + 1).setValue(b.active === false ? 'false' : 'true');
    return true;
  });
}

// นำเข้าข้อมูลจากระบบเดิม: สร้างเขต + นักเรียน + ยอดยกมา + ประวัติวันที่ขาด (source=import ไม่คิดค่าปรับซ้ำ)
function importZone_(b) {
  const me = requireSession_(b.token, 'admin');
  const z = b.zone || {};
  const name = clean_(z.name, 100);
  if (!name || !Array.isArray(z.students) || !z.students.length) throw new Error('ข้อมูลนำเข้าไม่ครบ');
  if (!isDate_(z.asOf)) throw new Error('วันที่ยอดยกมาไม่ถูกต้อง');
  return withLock_(() => {
    const zones = readRows_('Zones');
    if (zones.some(x => x.name === name)) throw new Error('มีเขตชื่อ "' + name + '" อยู่แล้ว');
    const zoneId = Utilities.getUuid().slice(0, 8);
    appendObj_('Zones', { id: zoneId, name, sort: String(zones.length + 1), active: 'true', createdAt: now_() });
    const students = [], opening = [], checks = [];
    z.students.forEach(s => {
      const id = Utilities.getUuid().slice(0, 12);
      students.push({ id, zoneId, no: String(Number(s.no) || 0), code: code_(s.code), prefix: clean_(s.prefix, 20), firstName: clean_(s.firstName, 80),
        lastName: clean_(s.lastName, 80), active: 'true', createdAt: now_() });
      opening.push({ studentId: id, zoneId, asOf: z.asOf, zoneDue: String(Number(s.zoneDue) || 0), roomDue: String(Number(s.roomDue) || 0), source: 'import' });
      (s.absentDates || []).filter(isDate_).forEach(d => checks.push({ zoneId, date: d, studentId: id, zoneAbsent: 'TRUE', roomAbsent: 'FALSE',
        source: 'import', checkedByName: 'ระบบเดิม', checkedAt: now_(), status: 'skip' }));
    });
    appendMany_('Students', students);
    appendMany_('Opening', opening);
    appendMany_('Checks', checks);
    return { zoneId, students: students.length, checks: checks.length, by: me.name };
  });
}

// แทนที่วันทำเขตของ zoneId ('' = ค่าเริ่มต้นทุกเขต เฉพาะครู) ด้วย dates = ['2026-11-09', ...]
function saveDutyDays_(b) {
  const zoneId = String(b.zoneId || '');
  const me = requireSession_(b.token, zoneId ? null : 'admin');
  if (zoneId) {
    requireZone_(me, zoneId);
    if (!readRows_('Zones').some(z => z.id === zoneId)) throw new Error('ไม่พบเขต');
  }
  const dates = [...new Set((Array.isArray(b.dates) ? b.dates : []).filter(isDate_))].sort();
  if (dates.length > 400) throw new Error('จำนวนวันมากเกินไป');
  return withLock_(() => {
    const keep = readRows_('DutyDays').filter(d => (d.zoneId || '') !== zoneId);
    writeAll_('DutyDays', keep.concat(dates.map(d => ({ date: d, note: '', updatedByName: me.name, updatedAt: now_(), zoneId }))));
    return { count: dates.length };
  });
}

// เซ็ตเวรและวันรายคนของเขต (ครู หรือหัวหน้าเขตนั้น)
// sets: [{ id, name, days }] แทนที่ของเขตทั้งหมด · assign: [{ studentId, setId, days }]
function saveRoster_(b) {
  const me = requireSession_(b.token);
  requireZone_(me, b.zoneId);
  const cleanDays = (d) => [...new Set(String(d || '').split(',').filter(x => /^[0-6]$/.test(x)))].sort().join(',');
  const sets = (Array.isArray(b.sets) ? b.sets : []).slice(0, 30).map((x, i) => ({
    id: /^[a-z0-9]{1,16}$/i.test(x.id) ? x.id : Utilities.getUuid().slice(0, 8), zoneId: b.zoneId,
    name: clean_(x.name, 60) || 'เซ็ต ' + (i + 1), days: cleanDays(x.days), sort: String(i + 1),
  }));
  const setIds = new Set(sets.map(x => x.id));
  const assign = {};
  (Array.isArray(b.assign) ? b.assign : []).forEach(a => { assign[a.studentId] = a; });
  return withLock_(() => {
    writeAll_('Sets', readRows_('Sets').filter(x => x.zoneId !== b.zoneId).concat(sets));
    const rows = readRows_('Students');
    rows.forEach(r => {
      if (r.zoneId !== b.zoneId) return;
      const a = assign[r.id];
      if (a) { r.setId = setIds.has(a.setId) ? a.setId : ''; r.days = cleanDays(a.days); }
      else if (r.setId && !setIds.has(r.setId)) r.setId = '';
    });
    writeAll_('Students', rows);
    return { sets: sets.length };
  });
}

function saveSettings_(b) {
  requireSession_(b.token, 'admin');
  const s = b.settings || {};
  const out = {
    zoneFine: String(Math.max(0, Math.round(Number(s.zoneFine) || 0))),
    roomFine: String(Math.max(0, Math.round(Number(s.roomFine) || 0))),
    checkDays: String(s.checkDays || '').split(',').filter(d => /^[0-6]$/.test(d)).join(','),
    publicView: s.publicView ? '1' : '0',
    maskNames: s.maskNames ? '1' : '0',
    termStart: isDate_(s.termStart) ? s.termStart : '',
  };
  return withLock_(() => { writeAll_('Settings', Object.keys(out).map(k => ({ key: k, value: out[k] }))); return out; });
}

function settings_() {
  const out = Object.assign({}, DEFAULT_SETTINGS);
  readRows_('Settings').forEach(r => { out[r.key] = r.value; });
  return { zoneFine: Number(out.zoneFine) || 0, roomFine: Number(out.roomFine) || 0, checkDays: String(out.checkDays),
    publicView: String(out.publicView) === '1', maskNames: String(out.maskNames) === '1', termStart: isDate_(out.termStart) ? out.termStart : '' };
}

/* ---------- ผู้ใช้ ---------- */
function login_(b) {
  const username = String(b.username || '').trim().toLowerCase();
  const cache = CacheService.getScriptCache();
  const failKey = 'fail_' + username;
  const fails = Number(cache.get(failKey) || 0);
  if (fails >= MAX_FAILED_LOGINS) throw new Error('ใส่รหัสผิดหลายครั้ง กรุณารอ 10 นาทีแล้วลองใหม่');
  const found = findUser_(username);
  if (!found || found.user.active === 'false' || hash_(found.user.salt, String(b.password || '')) !== found.user.hash) {
    cache.put(failKey, String(fails + 1), LOCK_SECONDS);
    throw new Error('ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง');
  }
  cache.remove(failKey);
  const token = Utilities.getUuid() + Utilities.getUuid();
  cache.put('s_' + token, username, SESSION_SECONDS);
  return Object.assign({ token }, profile_(found.user));
}

function logout_(b) { CacheService.getScriptCache().remove('s_' + b.token); return true; }

function changePassword_(b) {
  const me = requireSession_(b.token);
  const found = findUser_(me.username);
  if (hash_(found.user.salt, String(b.oldPassword || '')) !== found.user.hash) throw new Error('รหัสผ่านเดิมไม่ถูกต้อง');
  setPassword_(found.row, b.newPassword);
  return true;
}

function listUsers_(b) {
  requireSession_(b.token, 'admin');
  return readRows_('Users').map(u => Object.assign(profile_(u), { active: u.active !== 'false' }));
}

// สร้างใหม่ (ต้องมี password) หรือแก้ไขชื่อ/บทบาท/เขต/สถานะ
function saveUser_(b) {
  const me = requireSession_(b.token, 'admin');
  const username = String(b.username || '').trim().toLowerCase();
  if (!/^[a-z0-9._-]{3,30}$/.test(username)) throw new Error('ชื่อผู้ใช้ใช้ a-z 0-9 . _ - ยาว 3–30 ตัว');
  const name = clean_(b.name, 80);
  if (!name) throw new Error('กรุณาใส่ชื่อ');
  const role = b.role === 'admin' ? 'admin' : 'head';
  const zoneIds = (Array.isArray(b.zoneIds) ? b.zoneIds : []).map(String).join(',');
  return withLock_(() => {
    const found = findUser_(username);
    if (found) {
      if (username === me.username && (role !== 'admin' || b.active === false)) throw new Error('ลดสิทธิ์หรือปิดบัญชีของตัวเองไม่ได้');
      sheet_('Users').getRange(found.row, 2, 1, 3).setValues([[name, role, zoneIds]]);
      sheet_('Users').getRange(found.row, H.Users.indexOf('active') + 1).setValue(b.active === false ? 'false' : 'true');
      return true;
    }
    checkPassword_(b.password);
    const salt = Utilities.getUuid();
    appendObj_('Users', { username, name, role, zoneIds, salt, hash: hash_(salt, b.password), active: 'true', createdAt: now_() });
    return true;
  });
}

function resetPassword_(b) {
  requireSession_(b.token, 'admin');
  const found = findUser_(String(b.username || '').toLowerCase());
  if (!found) throw new Error('ไม่พบผู้ใช้');
  setPassword_(found.row, b.newPassword);
  CacheService.getScriptCache().remove('fail_' + found.user.username);
  return true;
}

/* ---------- ตัวช่วย ---------- */
function profile_(u) {
  return { username: u.username, name: u.name, role: u.role === 'admin' ? 'admin' : 'head',
    zoneIds: String(u.zoneIds || '').split(',').filter(x => x) };
}

function requireSession_(token, need) {
  const username = token && CacheService.getScriptCache().get('s_' + token);
  if (!username) throw new Error('SESSION_EXPIRED');
  const found = findUser_(username);
  if (!found || found.user.active === 'false') throw new Error('บัญชีนี้ถูกปิดใช้งาน');
  const me = profile_(found.user);
  if (need === 'admin' && me.role !== 'admin') throw new Error('เฉพาะผู้ดูแลระบบเท่านั้น');
  return me;
}

function requireZone_(me, zoneId) {
  if (me.role !== 'admin' && me.zoneIds.indexOf(zoneId) < 0) throw new Error('บัญชีนี้ไม่มีสิทธิ์ในเขตนี้');
}

function findUser_(username) {
  const rows = readRows_('Users');
  const i = rows.findIndex(u => String(u.username).toLowerCase() === username);
  return i < 0 ? null : { user: rows[i], row: i + 2 };
}

function setPassword_(rowNum, password) {
  checkPassword_(password);
  const salt = Utilities.getUuid();
  sheet_('Users').getRange(rowNum, H.Users.indexOf('salt') + 1, 1, 2).setValues([[salt, hash_(salt, password)]]);
}

function checkPassword_(p) {
  if (typeof p !== 'string' || p.length < 6) throw new Error('รหัสผ่านต้องยาวอย่างน้อย 6 ตัวอักษร');
}

function hash_(salt, password) {
  const bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, salt + '|' + password, Utilities.Charset.UTF_8);
  return bytes.map(x => ('0' + (x & 0xff).toString(16)).slice(-2)).join('');
}

// ตัดความยาวและกันข้อความที่ขึ้นต้นด้วย = + - @ ไม่ให้ชีตตีความเป็นสูตร
function clean_(v, max) {
  let s = String(v == null ? '' : v).trim().slice(0, max);
  if (/^[=+\-@]/.test(s)) s = "'" + s;
  return s;
}

const isDate_ = (d) => /^\d{4}-\d{2}-\d{2}$/.test(String(d || ''));
const now_ = () => new Date().toISOString();

function sheet_(name) {
  const s = ss_().getSheetByName(name);
  if (!s) throw new Error('ยังไม่ได้รัน setup');
  return s;
}

// ชีตที่เพิ่มทีหลัง: ถ้ายังไม่มีชีต ถือว่าไม่มีข้อมูล
function optRows_(name) {
  if (USE_CACHE_) return rowsBundle_()[name] || [];
  return ss_().getSheetByName(name) ? readRows_(name) : [];
}

/* ---------- แคชข้อมูลชีต (ลดเวลาโหลดจาก ~4 วินาที เหลือไม่ถึง 1 วินาที) ---------- */
// เก็บทุกชีต (ยกเว้น Users) แบบบีบอัดใน CacheService · ล้างทันทีเมื่อมีการบันทึกผ่านเว็บ
// ถ้าแก้ในชีตเองโดยตรง หน้าเว็บจะเห็นภายใน CACHE_SECONDS หรือรันฟังก์ชัน clearRowsCache_ ในหน้าสคริปต์
const READ_ACTIONS = ['data', 'publicData'];
const NO_CLEAR = ['login', 'logout', 'changePassword', 'listUsers'];
const CACHE_SECONDS = 30 * 60;
const CACHE_KEY = 'rows_v1';
let USE_CACHE_ = false, BUNDLE_ = null;

function rowsBundle_() {
  if (BUNDLE_) return BUNDLE_;
  const c = CacheService.getScriptCache();
  try {
    const n = Number(c.get(CACHE_KEY + '_n'));
    if (n) {
      const keys = Array.from({ length: n }, (_, i) => CACHE_KEY + '_' + i), got = c.getAll(keys);
      if (keys.every(k => got[k])) {
        const blob = Utilities.newBlob(Utilities.base64Decode(keys.map(k => got[k]).join('')), 'application/x-gzip');
        return (BUNDLE_ = JSON.parse(Utilities.ungzip(blob).getDataAsString()));
      }
    }
  } catch (e) { /* แคชเสีย อ่านใหม่ */ }
  const b = {};
  Object.keys(H).filter(k => k !== 'Users').forEach(k => { b[k] = ss_().getSheetByName(k) ? readSheet_(k) : null; });
  try {
    const z = Utilities.base64Encode(Utilities.gzip(Utilities.newBlob(JSON.stringify(b), 'application/json')).getBytes());
    const parts = {}, size = 90000;
    for (let i = 0; i * size < z.length; i++) parts[CACHE_KEY + '_' + i] = z.slice(i * size, (i + 1) * size);
    parts[CACHE_KEY + '_n'] = String(Object.keys(parts).length);
    c.putAll(parts, CACHE_SECONDS);
  } catch (e) { /* ใหญ่เกินแคช ใช้แบบไม่แคช */ }
  return (BUNDLE_ = b);
}

function clearRowsCache_() {
  BUNDLE_ = null;
  CacheService.getScriptCache().remove(CACHE_KEY + '_n');
}

function readRows_(name) {
  if (USE_CACHE_ && name !== 'Users') {
    const rows = rowsBundle_()[name];
    if (!rows) throw new Error('ยังไม่ได้รัน setup');
    return rows;
  }
  return readSheet_(name);
}

function readSheet_(name) {
  const s = sheet_(name), headers = H[name];
  if (s.getLastRow() < 2) return [];
  return s.getRange(2, 1, s.getLastRow() - 1, headers.length).getDisplayValues()
    .map(r => Object.fromEntries(headers.map((h, i) => [h, r[i]])));
}

const toRow_ = (name, o) => H[name].map(h => o[h] == null ? '' : String(o[h]));

// เริ่มเก็บ / เลิกเก็บ ค่าปรับของสัปดาห์ (หัวหน้าเขตของเขตนั้น หรือครูผู้ดูแล)
function setWeek_(b) {
  const me = requireSession_(b.token);
  requireZone_(me, b.zoneId);
  if (!isDate_(b.week)) throw new Error('สัปดาห์ไม่ถูกต้อง');
  const kind = b.kind === 'room' ? 'room' : 'zone';
  const same = (w) => w.zoneId === b.zoneId && w.week === b.week && (w.kind === 'room' ? 'room' : 'zone') === kind;
  return withLock_(() => {
    const ss = ss_();
    if (!ss.getSheetByName('Weeks')) {
      const sh = ss.insertSheet('Weeks'); sh.getRange('A:Z').setNumberFormat('@');
      sh.getRange(1, 1, 1, H.Weeks.length).setValues([H.Weeks]); sh.setFrozenRows(1);
    }
    const rows = readRows_('Weeks'), has = rows.some(same);
    if (b.on && !has) rows.push({ zoneId: b.zoneId, week: b.week, byName: me.name, at: now_(), kind });
    if (!b.on && has) {
      if (readRows_('Payments').some(p => p.zoneId === b.zoneId && p.week === b.week && (p.kind === 'room' ? 'room' : 'zone') === kind && p.status !== 'void')) throw new Error('สัปดาห์นี้รับเงินไปแล้ว ยกเลิกการรับเงินก่อน');
      writeAll_('Weeks', rows.filter(w => !same(w)));
      return { on: false };
    }
    writeAll_('Weeks', rows);
    return { on: true };
  });
}

function appendObj_(name, o) { sheet_(name).appendRow(toRow_(name, o)); }

function appendMany_(name, list) {
  if (!list.length) return;
  const s = sheet_(name);
  s.getRange(s.getLastRow() + 1, 1, list.length, H[name].length).setValues(list.map(o => toRow_(name, o)));
}

// เขียนทับข้อมูลทั้งชีต (ใต้หัวตาราง)
function writeAll_(name, list) {
  const s = sheet_(name), w = H[name].length;
  if (s.getLastRow() > 1) s.getRange(2, 1, s.getLastRow() - 1, w).clearContent();
  if (list.length) s.getRange(2, 1, list.length, w).setValues(list.map(o => toRow_(name, o)));
}

function withLock_(fn) {
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try { return fn(); } finally { lock.releaseLock(); }
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
