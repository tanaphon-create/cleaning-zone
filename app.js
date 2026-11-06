(() => {
  'use strict';
  const CFG = window.CZ_CONFIG || {};
  const DEMO = !CFG.API_URL;
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];
  const esc = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const SKEY = 'cz_session';

  const state = {
    session: loadSession(), data: null, zoneId: localGet('cz_zone') || '', tab: 'home',
    date: todayIso(), draft: null, draftKey: '', dirty: false, cq: '', hq: '', onlyAbsent: false,
    sum: { q: '', view: 'all', sort: 'no' }, adminZone: '', users: null, calMonth: todayIso().slice(0, 7), duty: null,
  };
  // แถว studentId = MARK ในชีต Checks = "เขตนี้เช็ควันนี้แล้ว" (ใช้รู้ว่าวันที่ทุกคนมาก็เช็คแล้ว)
  const MARK = '_';
  // สถานะรายวัน: เฉพาะ "ไม่ทำเขต" ที่คิดค่าปรับ — มาทำ / ขาดเรียน / ลา ไม่เก็บเงิน
  const ST = {
    present: { l: 'มาทำ', cls: 'st-present' },
    skip: { l: 'ไม่ทำเขต', cls: 'st-skip' },
    absent: { l: 'ขาดเรียน', cls: 'st-absent' },
    leave: { l: 'ลา', cls: 'st-leave' },
  };

  /* ================= API ================= */
  async function api(action, payload = {}) {
    const body = { action, token: state.session && state.session.token, ...payload };
    let r;
    if (DEMO) r = demo(body);
    else {
      // text/plain = ไม่ต้องทำ CORS preflight ซึ่ง Apps Script ไม่รองรับ
      const res = await fetch(CFG.API_URL, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify(body) });
      r = await res.json();
    }
    if (!r.ok) {
      if (r.error === 'SESSION_EXPIRED') { setSession(null); render(); throw new Error('หมดเวลาการเข้าสู่ระบบ กรุณาเข้าสู่ระบบใหม่'); }
      throw new Error(r.error || 'เกิดข้อผิดพลาด');
    }
    return r.data;
  }

  /* ============ โหมดทดลอง: จำลองหลังบ้านไว้ในเบราว์เซอร์ ============ */
  function demo(b) {
    const KEY = 'cz_demo_v4';
    let db; try { db = JSON.parse(localStorage.getItem(KEY)); } catch (_) { /* ไม่มี storage */ }
    if (!db) db = demoSeed();
    const save = () => { try { localStorage.setItem(KEY, JSON.stringify(db)); } catch (_) { /* ไม่มี storage */ } };
    const uid = () => Math.random().toString(36).slice(2, 10);
    const me = () => {
      const u = db.users.find(x => x.username === db.sessions[b.token]);
      if (!u) throw new Error('SESSION_EXPIRED');
      if (!u.active) throw new Error('บัญชีนี้ถูกปิดใช้งาน');
      return { username: u.username, name: u.name, role: u.role, zoneIds: u.zoneIds };
    };
    const admin = () => { const m = me(); if (m.role !== 'admin') throw new Error('เฉพาะผู้ดูแลระบบเท่านั้น'); return m; };
    const zoneOk = (m, z) => { if (m.role !== 'admin' && !m.zoneIds.includes(z)) throw new Error('บัญชีนี้ไม่มีสิทธิ์ในเขตนี้'); };
    const h = {
      login() {
        const u = db.users.find(x => x.username === String(b.username || '').trim().toLowerCase());
        if (!u || !u.active || u.password !== b.password) throw new Error('ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง');
        const token = uid() + uid(); db.sessions[token] = u.username;
        return { token, username: u.username, name: u.name, role: u.role, zoneIds: u.zoneIds };
      },
      logout() { delete db.sessions[b.token]; return true; },
      publicData() {
        if (db.settings.publicView === false) throw new Error('PUBLIC_OFF');
        const mask = !!db.settings.maskNames;
        return {
          me: null, settings: db.settings, sets: db.sets || [], dutyDays: db.dutyDays || [], zones: db.zones.filter(z => z.active),
          students: db.students.map(x => ({ ...x, lastName: mask && x.lastName ? x.lastName.charAt(0) + '.' : x.lastName })),
          checks: db.checks.map(c => ({ ...c, by: '' })), opening: db.opening, late: db.late || [],
          payments: db.payments.filter(p => p.status !== 'void').map(p => ({ id: p.id, studentId: p.studentId, zoneId: p.zoneId, date: p.date, kind: p.kind, amount: p.amount, status: p.status })),
        };
      },
      changePassword() {
        const u = db.users.find(x => x.username === me().username);
        if (u.password !== b.oldPassword) throw new Error('รหัสผ่านเดิมไม่ถูกต้อง');
        if (String(b.newPassword || '').length < 6) throw new Error('รหัสผ่านต้องยาวอย่างน้อย 6 ตัวอักษร');
        u.password = b.newPassword; return true;
      },
      data() {
        const m = me(), can = (z) => m.role === 'admin' || m.zoneIds.includes(z);
        return {
          me: m, settings: db.settings, sets: (db.sets || []).filter(x => can(x.zoneId)), dutyDays: (db.dutyDays || []).filter(d => !d.zoneId || can(d.zoneId)), zones: db.zones.filter(z => can(z.id)), students: db.students.filter(s => can(s.zoneId)),
          checks: db.checks.filter(c => can(c.zoneId)), opening: db.opening.filter(o => can(o.zoneId)), late: (db.late || []).filter(l => can(l.zoneId)), payments: db.payments.filter(p => can(p.zoneId)),
        };
      },
      saveChecks() {
        const m = me(); zoneOk(m, b.zoneId);
        db.checks = db.checks.filter(c => !(c.zoneId === b.zoneId && c.date === b.date));
        const add = b.marks.filter(x => x.status !== 'present' || x.roomAbsent).map(x => ({ zoneId: b.zoneId, date: b.date, studentId: x.studentId,
          status: x.status, zoneAbsent: x.status === 'skip', roomAbsent: !!x.roomAbsent, source: 'web', by: m.name }));
        db.checks.push(...add, { zoneId: b.zoneId, date: b.date, studentId: MARK, zoneAbsent: false, roomAbsent: false, source: 'web', by: m.name });
        return { saved: add.length };
      },
      addPayment() {
        const m = me(), st = db.students.find(s => s.id === b.studentId); if (!st) throw new Error('ไม่พบนักเรียน'); zoneOk(m, st.zoneId);
        if (!(Number(b.amount) > 0)) throw new Error('จำนวนเงินไม่ถูกต้อง');
        const row = { id: uid(), studentId: st.id, zoneId: st.zoneId, date: b.date, kind: b.kind === 'room' ? 'room' : 'zone', amount: Math.round(Number(b.amount)),
          note: b.note || '', byName: m.name, createdAt: new Date().toISOString(), status: 'active', voidByName: '' };
        db.payments.push(row); return row;
      },
      voidPayment() { const m = me(), p = db.payments.find(x => x.id === b.id); if (!p) throw new Error('ไม่พบรายการ'); zoneOk(m, p.zoneId); p.status = 'void'; p.voidByName = m.name; return true; },
      saveZone() {
        admin(); if (!String(b.name || '').trim()) throw new Error('กรุณาใส่ชื่อเขต');
        const z = db.zones.find(x => x.id === b.id);
        if (z) { Object.assign(z, { name: b.name.trim(), active: b.active !== false }); return { id: z.id }; }
        const id = uid(); db.zones.push({ id, name: b.name.trim(), sort: db.zones.length + 1, active: true }); return { id };
      },
      saveStudents() {
        admin(); let added = 0, updated = 0;
        b.students.forEach(s => {
          if (!s.firstName) return;
          const v = { no: Number(s.no) || 0, code: cleanCode(s.code), prefix: s.prefix || '', firstName: s.firstName, lastName: s.lastName || '' };
          const r = s.id && db.students.find(x => x.id === s.id);
          if (r) { Object.assign(r, v); updated++; } else { db.students.push({ id: uid(), zoneId: b.zoneId, active: true, ...v }); added++; }
        });
        const dup = dupCode(db.students); if (dup) throw new Error(dup);
        return { added, updated };
      },
      setStudentActive() { admin(); const s = db.students.find(x => x.id === b.id); if (s) s.active = b.active !== false; return true; },
      importZone() {
        admin(); const z = b.zone;
        if (db.zones.some(x => x.name === z.name)) throw new Error('มีเขตชื่อ "' + z.name + '" อยู่แล้ว');
        const zoneId = uid(); db.zones.push({ id: zoneId, name: z.name, sort: db.zones.length + 1, active: true });
        let checks = 0;
        z.students.forEach(s => {
          const id = uid();
          db.students.push({ id, zoneId, no: s.no, code: cleanCode(s.code), prefix: s.prefix, firstName: s.firstName, lastName: s.lastName, active: true });
          db.opening.push({ studentId: id, zoneId, asOf: z.asOf, zoneDue: s.zoneDue, roomDue: s.roomDue });
          s.absentDates.forEach(d => { db.checks.push({ zoneId, date: d, studentId: id, status: 'skip', zoneAbsent: true, roomAbsent: false, source: 'import', by: 'ระบบเดิม' }); checks++; });
        });
        return { zoneId, students: z.students.length, checks };
      },
      saveRoster() {
        const m = me(); zoneOk(m, b.zoneId);
        const sets = b.sets.map((x, i) => ({ id: x.id || uid(), zoneId: b.zoneId, name: x.name || 'เซ็ต ' + (i + 1), days: x.days || '', sort: i + 1 }));
        db.sets = (db.sets || []).filter(x => x.zoneId !== b.zoneId).concat(sets);
        const ids = new Set(sets.map(x => x.id)), as = {}; b.assign.forEach(a => { as[a.studentId] = a; });
        db.students.forEach(st => {
          if (st.zoneId !== b.zoneId) return;
          if (as[st.id]) { st.setId = ids.has(as[st.id].setId) ? as[st.id].setId : ''; st.days = as[st.id].days || ''; }
          else if (st.setId && !ids.has(st.setId)) st.setId = '';
        });
        return { sets: sets.length };
      },
      saveDutyDays() {
        const z = String(b.zoneId || ''), m = z ? me() : admin(); if (z) zoneOk(m, z);
        db.dutyDays = (db.dutyDays || []).filter(d => (d.zoneId || '') !== z).concat([...new Set(b.dates)].sort().map(date => ({ date, zoneId: z })));
        return { count: b.dates.length };
      },
      saveSettings() {
        admin();
        db.settings = { zoneFine: Number(b.settings.zoneFine) || 0, roomFine: Number(b.settings.roomFine) || 0, checkDays: b.settings.checkDays,
          publicView: !!b.settings.publicView, maskNames: !!b.settings.maskNames };
        return db.settings;
      },
      listUsers() { admin(); return db.users.map(u => ({ username: u.username, name: u.name, role: u.role, zoneIds: u.zoneIds, active: u.active })); },
      saveUser() {
        const m = admin(), username = String(b.username || '').trim().toLowerCase();
        if (!/^[a-z0-9._-]{3,30}$/.test(username)) throw new Error('ชื่อผู้ใช้ใช้ a-z 0-9 . _ - ยาว 3–30 ตัว');
        const u = db.users.find(x => x.username === username), v = { name: b.name, role: b.role === 'admin' ? 'admin' : 'head', zoneIds: b.zoneIds || [] };
        if (u) {
          if (username === m.username && (v.role !== 'admin' || b.active === false)) throw new Error('ลดสิทธิ์หรือปิดบัญชีของตัวเองไม่ได้');
          Object.assign(u, v, { active: b.active !== false }); return true;
        }
        if (String(b.password || '').length < 6) throw new Error('รหัสผ่านต้องยาวอย่างน้อย 6 ตัวอักษร');
        db.users.push({ username, password: b.password, active: true, ...v }); return true;
      },
      resetPassword() { admin(); const u = db.users.find(x => x.username === b.username); if (!u) throw new Error('ไม่พบผู้ใช้'); u.password = b.newPassword; return true; },
    };
    try {
      if (!h[b.action]) throw new Error('ไม่รู้จักคำสั่ง');
      const data = h[b.action](); save();
      return { ok: true, data: JSON.parse(JSON.stringify(data)) };
    } catch (e) { return { ok: false, error: e.message }; }
  }

  function demoSeed() {
    const names = ['นายกิตติ ใจดี', 'นายธนา มั่นคง', 'นางสาวพิมพ์ชนก แสงทอง', 'นายวรเมธ สุขใจ', 'นางสาวอรอุมา ศรีสวัสดิ์',
      'นายภูมิ รักเรียน', 'นางสาวณัฐธิดา บุญมา', 'นายปกรณ์ ทองดี', 'นายชยพล วงศ์ใหญ่', 'นางสาวกัญญา มีสุข'];
    const students = names.map((n, i) => ({ id: 's' + i, zoneId: 'z1', no: i + 1, code: String(41201 + i * 3), ...splitName(n), active: true }));
    const checks = [], d = new Date();
    for (let k = 1; k <= 12; k++) {
      const t = new Date(d); t.setDate(d.getDate() - k);
      if (t.getDay() === 0 || t.getDay() === 6) continue;
      students.forEach((s, i) => {
        const v = (i * 7 + k * 3) % 9, status = v === 0 ? 'skip' : v === 4 && k % 2 ? 'leave' : v === 5 && k % 3 === 0 ? 'absent' : 'present';
        const room = status === 'skip' && (i + k) % 4 === 0;
        if (status !== 'present' || room) checks.push({ zoneId: 'z1', date: iso(t), studentId: s.id, status, zoneAbsent: status === 'skip', roomAbsent: room, source: 'web', by: 'หัวหน้าเขต ตัวอย่าง' });
      });
      checks.push({ zoneId: 'z1', date: iso(t), studentId: MARK, status: 'present', zoneAbsent: false, roomAbsent: false, source: 'web', by: 'หัวหน้าเขต ตัวอย่าง' });
    }
    return {
      users: [
        { username: 'admin', password: 'admin1234', name: 'ครูผู้ดูแล', role: 'admin', zoneIds: [], active: true },
        { username: 'head1', password: 'demo1234', name: 'หัวหน้าเขต ตัวอย่าง', role: 'head', zoneIds: ['z1'], active: true },
      ],
      sessions: {}, settings: { zoneFine: 10, roomFine: 10, checkDays: '1,2,3,4,5', publicView: true, maskNames: false }, dutyDays: [],
      zones: [{ id: 'z1', name: 'ตัวอย่าง: หน้าอาคาร 1', sort: 1, active: true }],
      students, checks, opening: [], payments: [],
      late: checks.filter((c, i) => c.status === 'skip' && i % 2 === 0).map((c, i) => ({ zoneId: 'z1', studentId: c.studentId, date: c.date, time: '08:0' + (i % 10) })),
    };
  }

  /* ================= ตัวช่วย ================= */
  function iso(d) { return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); }
  function todayIso() { return iso(new Date()); }
  const parseIso = (s) => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
  const addDays = (s, n) => { const d = parseIso(s); d.setDate(d.getDate() + n); return iso(d); };
  const thDate = (s, opt = {}) => parseIso(s).toLocaleDateString('th-TH', { day: 'numeric', month: 'short', year: '2-digit', ...opt });
  const shortDate = (s) => { const d = parseIso(s); return d.getDate() + '/' + (d.getMonth() + 1); };
  const baht = (n) => Number(n || 0).toLocaleString('th-TH') + ' บาท';
  const fullName = (s) => (s.prefix || '') + s.firstName + (s.lastName ? ' ' + s.lastName : '');
  const cleanCode = (v) => String(v == null ? '' : v).replace(/[^0-9A-Za-z]/g, '').slice(0, 20);
  const dupCode = (list) => {
    const seen = {};
    for (const s of list) {
      if (!s.code) continue;
      if (seen[s.code]) return 'เลขประจำตัว ' + s.code + ' ซ้ำกัน: ' + seen[s.code] + ' และ ' + fullName(s);
      seen[s.code] = fullName(s);
    }
    return '';
  };
  // ค้นหาด้วย ชื่อ/นามสกุล (ไม่สนช่องว่าง) เลขที่ หรือเลขประจำตัว
  const plain = (t) => String(t || '').replace(/\s+/g, '').toLowerCase();
  const matchQ = (s, q) => {
    q = String(q || '').trim(); if (!q) return true;
    if (/^\d+$/.test(q)) return String(s.no) === q || (!!s.code && s.code.includes(q) && (q.length >= 3 || s.code === q));
    return plain(fullName(s)).includes(plain(q)) || plain(s.code).includes(plain(q));
  };
  // มาโรงเรียนสาย (หลัง 07:50): วันที่เป็นสีเหลือง
  const lateAt = (sid, dt) => (state.data.lateIdx[sid] || {})[dt] || '';
  const lateDate = (sid, dt, text) => { const t = lateAt(sid, dt); return t ? `<span class="late" title="มาโรงเรียน ${t} น. (สาย)">${text}</span>` : text; };
  const codeTag = (s) => s.code ? `<span class="code-tag">${esc(s.code)}</span>` : '';
  function splitName(n) {
    const t = String(n).replace(/\s+/g, ' ').trim();
    const m = t.match(/^(เด็กชาย|เด็กหญิง|นางสาว|ด\.ช\.|ด\.ญ\.|น\.ส\.|นาย|นาง)\s*(.*)$/);
    const rest = m ? m[2] : t, i = rest.indexOf(' ');
    const last = i < 0 ? '' : rest.slice(i + 1).trim();
    return { prefix: m ? m[1] : '', firstName: i < 0 ? rest : rest.slice(0, i), lastName: last === '-' ? '' : last };
  }
  function localGet(k) { try { return localStorage.getItem(k); } catch (_) { return null; } }
  function localSet(k, v) { try { localStorage.setItem(k, v); } catch (_) { /* ไม่มี storage */ } }
  function loadSession() { try { return JSON.parse(sessionStorage.getItem(SKEY)); } catch (_) { return null; } }
  function setSession(s) {
    state.session = s; state.data = null; state.duty = null; state.dutyZone = null; state.users = null; state.roster = null;
    try { if (s) sessionStorage.setItem(SKEY, JSON.stringify(s)); else sessionStorage.removeItem(SKEY); } catch (_) { /* ไม่มี storage */ }
  }
  let toastT;
  function toast(msg, bad) {
    const t = $('#toast'); t.textContent = msg; t.className = 'show' + (bad ? ' bad' : '');
    clearTimeout(toastT); toastT = setTimeout(() => { t.className = ''; }, 2800);
  }
  async function busy(btn, fn) {
    const old = btn && btn.innerHTML;
    if (btn) { btn.disabled = true; btn.textContent = 'กำลังบันทึก…'; }
    try { return await fn(); } catch (e) { toast(e.message, true); return undefined; } finally { if (btn) { btn.disabled = false; btn.innerHTML = old; } }
  }
  const canEdit = () => !!(state.session && state.data && state.data.me);
  const isAdmin = () => canEdit() && state.data.me.role === 'admin';
  const zones = () => state.data.zones.filter(z => z.active || isAdmin()).sort((a, b) => a.sort - b.sort || a.name.localeCompare(b.name, 'th'));
  const zoneName = (id) => (state.data.zones.find(z => z.id === id) || {}).name || '';
  const studentsOf = (zoneId, all) => state.data.students.filter(s => s.zoneId === zoneId && (all || s.active)).sort((a, b) => a.no - b.no);

  /* ================= คำนวณยอด ================= */
  function ledger(zoneId) {
    const set = state.data.settings, out = {};
    studentsOf(zoneId, true).forEach(s => { out[s.id] = { s, open: null, zoneFine: 0, roomFine: 0, zonePaid: 0, roomPaid: 0, absent: [], room: [], leave: [], miss: [] }; });
    state.data.opening.forEach(o => { if (out[o.studentId]) out[o.studentId].open = o; });
    state.data.checks.forEach(c => {
      const r = out[c.studentId]; if (!r) return;
      if (c.status === 'skip') r.absent.push(c.date);
      else if (c.status === 'leave') r.leave.push(c.date);
      else if (c.status === 'absent') r.miss.push(c.date);
      if (c.roomAbsent) r.room.push(c.date);
      // ข้อมูลจากระบบเดิมรวมอยู่ในยอดยกมาแล้ว — คิดค่าปรับเฉพาะที่เช็คในเว็บนี้หลังวันยกยอด
      if (c.source === 'import' || (r.open && c.date <= r.open.asOf)) return;
      if (c.status === 'skip') r.zoneFine += set.zoneFine;
      if (c.roomAbsent) r.roomFine += set.roomFine;
    });
    state.data.payments.forEach(p => {
      const r = out[p.studentId]; if (!r || p.status === 'void') return;
      if (p.kind === 'room') r.roomPaid += p.amount; else r.zonePaid += p.amount;
    });
    Object.values(out).forEach(r => {
      r.zoneDue = (r.open ? r.open.zoneDue : 0) + r.zoneFine - r.zonePaid;
      r.roomDue = (r.open ? r.open.roomDue : 0) + r.roomFine - r.roomPaid;
    });
    return out;
  }

  /* ================= หน้าจอ ================= */
  async function render() {
    const app = $('#app');
    // ไม่ได้เข้าสู่ระบบ = ดูข้อมูลอย่างเดียว (ถ้าครูเปิดให้ดูสาธารณะ) · ลงข้อมูล/แก้ไขต้องเข้าสู่ระบบ
    if (!state.session && state.showLogin) return renderLogin(app);
    if (!state.data) {
      const cached = readCache();
      if (cached) { state.data = prepData(cached); setTimeout(refreshInBackground, 0); }
    }
    if (!state.data) {
      app.innerHTML = '<div class="loading">กำลังโหลดข้อมูล…</div>';
      try { await reload(); } catch (e) {
        if (!state.session) { state.showLogin = true; state.publicOff = e.message === 'PUBLIC_OFF'; return renderLogin(app); }
        app.innerHTML = '<div class="loading">' + esc(e.message) + '<br><br><button class="btn" data-act="logout">ออกจากระบบ</button></div>'; return;
      }
    }
    const zs = zones();
    if (!zs.some(z => z.id === state.zoneId)) state.zoneId = zs[0] ? zs[0].id : '';
    const tabs = [['home', 'ภาพรวม'], ['check', 'เช็คเขต'], ['summary', 'สรุปยอด']];
    if (canEdit()) tabs.push(['days', 'วันทำเขต']);
    if (isAdmin()) tabs.push(['admin', 'ตั้งค่า']);
    if (!tabs.some(t => t[0] === state.tab)) state.tab = 'home';
    app.innerHTML = `
      <header class="topbar">
        <div class="topbar-in">
          <div class="brand"><div class="brand-mark">${checkSvg()}</div><span>${esc(CFG.APP_NAME)}<small class="hide-sm">${esc(CFG.SCHOOL_NAME)}</small></span></div>
          <div class="spacer"></div><span id="sync" class="sync" hidden>กำลังอัปเดต…</span>
          ${(state.tab === 'check' || state.tab === 'summary') && zs.length ? `<select class="select-zone" id="zone" aria-label="เลือกเขต">${zs.map(z => `<option value="${esc(z.id)}" ${z.id === state.zoneId ? 'selected' : ''}>${esc(z.name)}</option>`).join('')}</select>` : ''}
          ${canEdit() ? `<button class="btn icon" data-act="menu" aria-label="บัญชีผู้ใช้" title="${esc(state.data.me.name)}">${userSvg()}</button>`
            : '<button class="btn primary sm" data-act="show-login">เข้าสู่ระบบ</button>'}
        </div>
        <nav class="tabs" aria-label="เมนู">${tabs.map(([k, l]) => `<button class="tab" data-tab="${k}" ${state.tab === k ? 'aria-current="page"' : ''}>${l}</button>`).join('')}</nav>
      </header>
      <main id="main"></main>`;
    const main = $('#main');
    if (!zs.length && state.tab !== 'admin') {
      main.innerHTML = `<div class="card empty">${isAdmin() ? 'ยังไม่มีเขต — ไปที่ "ตั้งค่า" เพื่อเพิ่มเขตหรือนำเข้าข้อมูลจากระบบเดิม' : canEdit() ? 'บัญชีนี้ยังไม่ได้รับมอบหมายเขต กรุณาติดต่อครูผู้ดูแล' : 'ยังไม่มีข้อมูลเขต'}</div>`;
      return;
    }
    if (state.tab === 'home') renderHome(main);
    else if (state.tab === 'days') { main.innerHTML = '<section class="card" id="roster-card"></section><section class="card" id="duty-card"></section>'; renderRosterCard(); renderDutyCard(); }
    else if (state.tab === 'check') renderCheck(main);
    else if (state.tab === 'summary') renderSummary(main);
    else renderAdmin(main);
  }

  /* ---------- วันที่ต้องเช็ค / สถานะการเช็ค ---------- */
  // วันทำเขตที่ครูสร้างไว้ ถ้ายังไม่สร้างเลย ใช้วันในสัปดาห์จากการตั้งค่า
  // วันทำเขตของเขต: วันของเขตเอง > ค่าเริ่มต้นทุกเขต > (ว่าง = ใช้วันในสัปดาห์จากการตั้งค่า)
  const ownDays = (zoneId) => state.data.dutyDays.filter(d => (d.zoneId || '') === zoneId).map(d => d.date).sort();
  const daysOf = (zoneId) => { const own = zoneId ? ownDays(zoneId) : []; return own.length ? own : ownDays(''); };
  const isCheckDay = (dt, zoneId) => { const list = daysOf(zoneId); return list.length ? list.includes(dt)
    : String(state.data.settings.checkDays || '').split(',').includes(String(parseIso(dt).getDay())); };
  // วันที่ต้องเช็คย้อนหลัง n วัน (รวมวันนี้ ถ้าวันนี้เป็นวันเช็ค)
  function recentCheckDays(n, zoneId) {
    const today = todayIso(), list = daysOf(zoneId);
    if (list.length) return list.filter(d => d <= today).slice(-n);
    const out = []; let d = today;
    for (let i = 0; out.length < n && i < 60; i++, d = addDays(d, -1)) if (isCheckDay(d, zoneId)) out.push(d);
    return out.reverse();
  }
  // วันทำเขตถัดไป/ก่อนหน้า (ถ้ายังไม่สร้างวันทำเขต เลื่อนทีละวัน)
  function stepDay(dt, n, zoneId) {
    const list = daysOf(zoneId);
    if (!list.length) return addDays(dt, n);
    const next = n > 0 ? list.find(d => d > dt) : list.filter(d => d < dt).pop();
    return next || addDays(dt, n);
  }
  /* ---------- เซ็ตเวร / วันของแต่ละคน ---------- */
  const WD = ['อา', 'จ', 'อ', 'พ', 'พฤ', 'ศ', 'ส'];
  const setsOf = (zoneId) => state.data.sets.filter(x => x.zoneId === zoneId).sort((a, b) => a.sort - b.sort);
  const daysText = (days) => days ? days.split(',').map(d => WD[d]).join(' ') : 'ทุกวัน';
  // วันในสัปดาห์ที่คนนี้ต้องทำเขต: วันของตัวเอง > วันของเซ็ต > ทุกวันทำเขต ('' )
  function studentDays(s) {
    if (s.days) return s.days;
    const set = s.setId && state.data.sets.find(x => x.id === s.setId);
    return set ? set.days : '';
  }
  function dutyLabel(s) {
    const set = s.setId && state.data.sets.find(x => x.id === s.setId);
    if (s.days) return 'วัน ' + daysText(s.days);
    return set ? set.name + (set.days ? ' (' + daysText(set.days) + ')' : '') : '';
  }
  const onDuty = (s, dt) => { const d = studentDays(s); return !d || d.split(',').includes(String(parseIso(dt).getDay())); };

  function checkedDates(zoneId) {
    const s = new Set();
    state.data.checks.forEach(c => { if (c.zoneId === zoneId) s.add(c.date); });
    return s;
  }
  function dayInfo(zoneId, dt) {
    const rows = state.data.checks.filter(c => c.zoneId === zoneId && c.date === dt);
    const st = (k) => rows.filter(c => c.status === k && c.studentId !== MARK).length;
    return { done: rows.length > 0, zone: st('skip'), leave: st('leave'), miss: st('absent'),
      room: rows.filter(c => c.roomAbsent && c.studentId !== MARK).length, by: rows.length ? rows[rows.length - 1].by : '' };
  }
  function weekStrip(zoneId, current) {
    const done = checkedDates(zoneId);
    return `<div class="strip" role="list">${recentCheckDays(7, zoneId).map(dt => {
      const ok = done.has(dt), d = parseIso(dt);
      return `<button role="listitem" class="sday ${ok ? 'ok' : 'miss'} ${dt === current ? 'cur' : ''}" data-act="goto-check" data-zone="${esc(zoneId)}" data-date="${dt}"
        title="${esc(thDate(dt, { weekday: 'long' }))} · ${ok ? 'เช็คแล้ว' : 'ยังไม่เช็ค'}">
        <small>${d.toLocaleDateString('th-TH', { weekday: 'short' })}</small><b>${d.getDate()}</b><i>${ok ? '✓' : '!'}</i></button>`;
    }).join('')}</div>`;
  }

  /* ---------- ภาพรวม ---------- */
  function homeResults() {
    const q = state.hq.trim();
    if (!q || (/^\d+$/.test(q) ? q.length < 3 : plain(q).length < 2)) return q ? '<p class="sub" style="margin:6px 0 0">พิมพ์อย่างน้อย 3 ตัวเลข หรือ 2 ตัวอักษร</p>' : '';
    const zs = new Set(zones().map(z => z.id));
    const hits = state.data.students.filter(s => zs.has(s.zoneId) && (/^\d+$/.test(q) ? !!s.code && s.code.includes(q) : matchQ(s, q)));
    if (!hits.length) return '<p class="sub" style="margin:6px 0 0">ไม่พบนักเรียน</p>';
    return `<ul class="find-list">${hits.slice(0, 12).map(s => {
      const r = ledger(s.zoneId)[s.id], due = r ? Math.max(0, r.zoneDue) + Math.max(0, r.roomDue) : 0;
      return `<li><button data-act="student" data-id="${esc(s.id)}"><span class="grow"><b>${esc(fullName(s))}</b>${codeTag(s)}<small>${esc(zoneName(s.zoneId))} · เลขที่ ${s.no || '-'} · ไม่ทำเขต ${r ? r.absent.length : 0} วัน</small></span>
        <span class="money ${due > 0 ? 'due' : ''}">${due > 0 ? 'ค้าง ' + baht(due) : 'ไม่ค้าง'}</span></button></li>`;
    }).join('')}</ul>${hits.length > 12 ? `<p class="sub" style="margin:6px 0 0">และอีก ${hits.length - 12} คน · พิมพ์ให้ละเอียดขึ้น</p>` : ''}`;
  }

  function renderHome(main) {
    const zs = zones().filter(z => z.active), today = todayIso();
    const cards = zs.map(z => {
      const L = Object.values(ledger(z.id)), info = dayInfo(z.id, today), done = checkedDates(z.id);
      const missing = recentCheckDays(10, z.id).filter(dt => dt < today && !done.has(dt));
      return { z, info, missing, checkToday: isCheckDay(today, z.id), n: studentsOf(z.id).length,
        due: L.reduce((a, r) => a + Math.max(0, r.zoneDue) + Math.max(0, r.roomDue), 0), owing: L.filter(r => r.zoneDue > 0 || r.roomDue > 0).length };
    });
    const due = cards.filter(c => c.checkToday), doneN = due.filter(c => c.info.done).length;
    main.innerHTML = `
      <p class="greet">${canEdit() ? 'สวัสดี ' + esc(state.data.me.name) : 'ผลการเช็คเขต (ดูอย่างเดียว)'} · ${esc(thDate(today, { weekday: 'long', month: 'long', year: 'numeric' }))}</p>
      <section class="card find-card">
        <label class="f">ค้นหานักเรียน (ทุกเขต)<input id="h-q" inputmode="search" placeholder="พิมพ์เลขประจำตัว หรือชื่อ" value="${esc(state.hq)}" autocomplete="off"></label>
        <div id="h-res">${homeResults()}</div>
      </section>
      <div class="totals">
        <div class="total"><span>เช็ควันนี้แล้ว</span><b class="${doneN < due.length ? 'money due' : ''}">${due.length ? `${doneN} / ${due.length} เขต` : 'วันนี้ไม่ต้องเช็ค'}</b></div>
        <div class="total"><span>ไม่ทำเขตวันนี้</span><b>${cards.reduce((a, c) => a + c.info.zone, 0)} คน</b></div>
        <div class="total"><span>ยอดค้างรวมทุกเขต</span><b class="money due">${baht(cards.reduce((a, c) => a + c.due, 0))}</b></div>
      </div>
      ${cards.map(c => `
        <section class="card zone-card">
          <div class="row" style="align-items:flex-start">
            <div class="grow"><h2>${esc(c.z.name)}</h2>
              <p class="sub" style="margin:0">${c.n} คน · ยังค้างจ่าย ${c.owing} คน รวม <b class="money due">${baht(c.due)}</b></p></div>
            <span class="status ${c.info.done ? 'ok' : c.checkToday ? 'miss' : 'off'}">${c.info.done ? '✓ เช็ควันนี้แล้ว' : c.checkToday ? 'ยังไม่เช็ควันนี้' : 'วันนี้ไม่ต้องเช็ค'}</span>
          </div>
          ${c.info.done ? `<p class="sub" style="margin:8px 0 0">วันนี้ไม่ทำเขต <b>${c.info.zone}</b> · ลา <b>${c.info.leave}</b> · ขาดเรียน <b>${c.info.miss}</b> · ขาดเวรห้อง <b>${c.info.room}</b>${c.info.by ? ' · บันทึกโดย ' + esc(c.info.by) : ''}</p>` : ''}
          <div style="margin-top:10px">${weekStrip(c.z.id, '')}</div>
          ${c.missing.length ? `<div class="warn">ยังไม่ได้เช็ค ${c.missing.length} วัน: ${c.missing.map(dt => `<button class="linkbtn" data-act="goto-check" data-zone="${esc(c.z.id)}" data-date="${dt}">${shortDate(dt)}</button>`).join(' ')}</div>` : ''}
          <div class="row" style="margin-top:12px">
            <button class="btn primary grow" data-act="goto-check" data-zone="${esc(c.z.id)}" data-date="${today}">${!canEdit() ? 'ดูผลวันนี้' : c.info.done ? 'แก้ไขการเช็ควันนี้' : 'เช็ควันนี้'}</button>
            <button class="btn grow" data-act="goto-sum" data-zone="${esc(c.z.id)}">ดูยอดค้าง</button>
          </div>
        </section>`).join('') || '<div class="card empty">ยังไม่มีเขต</div>'}`;
    $('#h-q').addEventListener('input', (e) => { state.hq = e.target.value; $('#h-res').innerHTML = homeResults(); });
  }

  // จำข้อมูลล่าสุดไว้ในเครื่อง: เปิดเว็บแล้วเห็นทันที แล้วค่อยอัปเดตจากเซิร์ฟเวอร์เบื้องหลัง
  const cacheKey = () => 'cz_cache_' + (state.session ? state.session.username : 'public');
  function readCache() { if (DEMO) return null; try { return JSON.parse(localGet(cacheKey())); } catch (_) { return null; } }
  function clearCaches() { try { Object.keys(localStorage).filter(k => k.startsWith('cz_cache_') && k !== 'cz_cache_public').forEach(k => localStorage.removeItem(k)); } catch (_) { /* ไม่มี storage */ } }
  async function reload() {
    const d = await api(state.session ? 'data' : 'publicData');
    if (!DEMO) localSet(cacheKey(), JSON.stringify(d));
    state.data = prepData(d);
  }
  function prepData(d) {
    d.dutyDays = d.dutyDays || [];
    d.sets = d.sets || [];
    d.late = d.late || [];
    d.lateIdx = {};
    d.late.forEach(l => { (d.lateIdx[l.studentId] = d.lateIdx[l.studentId] || {})[l.date] = l.time; });
    d.checks.forEach(c => { if (!ST[c.status]) c.status = c.zoneAbsent ? 'skip' : 'present'; });
    return d;
  }
  let refreshing = false;
  function refreshInBackground() {
    if (refreshing) return; refreshing = true;
    const bar = $('#sync'); if (bar) bar.hidden = false;
    reload().then(() => {
      // ไม่วาดหน้าใหม่ระหว่างที่กำลังเช็ค/พิมพ์ หรือเปิดหน้าต่างอยู่ (ข้อมูลใหม่ใช้ครั้งถัดไป)
      if (!state.dirty && !$('#modal').open && !(document.activeElement && /INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName))) render();
    }).catch(e => {
      if (e.message === 'PUBLIC_OFF' && !state.session) { state.data = null; state.showLogin = true; state.publicOff = true; render(); }
    }).finally(() => { refreshing = false; const b = $('#sync'); if (b) b.hidden = true; });
  }

  function renderLogin(app) {
    app.innerHTML = `
      <div class="login"><div class="card">
        <div class="brand-mark" style="width:48px;height:48px;border-radius:13px">${checkSvg(26)}</div>
        <h1>${esc(CFG.APP_NAME)}</h1>
        <p class="sub" style="margin:0">${esc(CFG.SCHOOL_NAME)} · เข้าสู่ระบบเพื่อลงข้อมูลหรือแก้ไข (ครูและหัวหน้าเขต)</p>
        <form id="login-form">
          <label class="f">ชื่อผู้ใช้<input name="username" autocomplete="username" autocapitalize="off" required></label>
          <label class="f">รหัสผ่าน<input name="password" type="password" autocomplete="current-password" required></label>
          <div class="err" id="login-err"></div>
          <button class="btn primary" type="submit">เข้าสู่ระบบ</button>
          ${state.publicOff ? '' : '<button class="btn" type="button" data-act="back-public">← กลับไปดูข้อมูล (ไม่ต้องเข้าสู่ระบบ)</button>'}
        </form>
        ${DEMO ? '<div class="demo-note"><b>โหมดทดลอง</b> ข้อมูลเก็บในเครื่องนี้เท่านั้น<br>ครู: admin / admin1234 · หัวหน้าเขต: head1 / demo1234</div>' : ''}
      </div></div>`;
    $('#login-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const f = e.target, btn = $('button', f);
      btn.disabled = true; btn.textContent = 'กำลังตรวจสอบ…'; $('#login-err').textContent = '';
      try {
        const s = await api('login', { username: f.username.value, password: f.password.value });
        setSession(s); state.showLogin = false; render();
      } catch (err) { $('#login-err').textContent = err.message; btn.disabled = false; btn.textContent = 'เข้าสู่ระบบ'; }
    });
  }

  /* ---------- เช็คเขต ---------- */
  function loadDraft() {
    const key = state.zoneId + '|' + state.date;
    if (state.draftKey === key && state.draft) return;
    const d = {};
    state.data.checks.forEach(c => {
      if (c.zoneId === state.zoneId && c.date === state.date && c.studentId !== MARK) d[c.studentId] = { status: c.status, room: !!c.roomAbsent };
    });
    state.draft = d; state.draftKey = key; state.dirty = false;
  }
  const stOf = (id) => (state.draft[id] && state.draft[id].status) || 'present';
  function setDraft(id, patch) {
    const m = Object.assign({ status: 'present', room: false }, state.draft[id], patch);
    if (m.status === 'present' && !m.room) delete state.draft[id]; else state.draft[id] = m;
    state.dirty = true;
  }

  function renderCheck(main) {
    loadDraft();
    const ro = !canEdit(), dis = ro ? 'disabled' : '';
    const d = state.draft, L = ledger(state.zoneId), everyone = studentsOf(state.zoneId);
    const all = everyone.filter(s => onDuty(s, state.date) || d[s.id]), off = everyone.filter(s => !all.includes(s));
    const count = (k) => all.filter(s => stOf(s.id) === k).length;
    const nRoom = all.filter(s => d[s.id] && d[s.id].room).length;
    const info = dayInfo(state.zoneId, state.date);
    const q = state.cq.trim();
    const list = all.filter(s => matchQ(s, q) && (!state.onlyAbsent || stOf(s.id) !== 'present' || (d[s.id] && d[s.id].room)));
    main.innerHTML = `
      <section class="card">
        <div class="datebar">
          <button class="btn icon" data-act="day" data-n="-1" aria-label="วันทำเขตก่อนหน้า">‹</button>
          <input type="date" id="check-date" value="${esc(state.date)}" max="${todayIso()}" aria-label="วันที่เช็ค">
          <button class="btn icon" data-act="day" data-n="1" aria-label="วันทำเขตถัดไป" ${state.date >= todayIso() ? 'disabled' : ''}>›</button>
        </div>
        <p class="hint" style="text-align:center;margin-top:6px">${esc(thDate(state.date, { weekday: 'long', month: 'long', year: 'numeric' }))}${state.date === todayIso() ? ' · วันนี้' : ''}
          · <b class="${info.done ? 'ok-text' : 'bad-text'}">${info.done ? 'เช็คแล้ว' : 'ยังไม่เช็ค'}</b></p>
        <div style="margin-top:10px">${weekStrip(state.zoneId, state.date)}</div>
        ${isCheckDay(state.date, state.zoneId) ? '' : '<div class="warn">วันนี้ไม่ใช่วันทำเขต (ยังบันทึกได้ถ้าจำเป็น)</div>'}
        <div class="stats stats4">
          <div class="stat"><b>${count('present')}<small class="of">/${all.length}</small></b><span>มาทำ</span></div>
          <div class="stat bad"><b>${count('skip')}</b><span>ไม่ทำเขต</span></div>
          <div class="stat leave"><b>${count('leave') + count('absent')}</b><span>ลา / ขาดเรียน</span></div>
          <div class="stat room"><b>${nRoom}</b><span>ขาดเวรห้อง</span></div>
        </div>
      </section>
      <section class="card" style="padding:10px 12px 6px">
        <div class="row" style="margin-bottom:4px">
          <input id="c-q" class="grow" style="flex:1 1 140px" placeholder="ค้นหาชื่อ / เลขที่ / เลขประจำตัว" inputmode="search" value="${esc(state.cq)}" aria-label="ค้นหานักเรียน">
          <button class="btn sm ${state.onlyAbsent ? 'primary' : ''}" data-act="only-absent" aria-pressed="${state.onlyAbsent}">เฉพาะคนไม่มา</button>
        </div>
        <p class="hint" style="margin:4px 0 2px">${ro ? 'ดูอย่างเดียว · ครูหรือหัวหน้าเขตเข้าสู่ระบบเพื่อลงข้อมูล · ลา ขาดเรียน มาทำ ไม่เสียเงิน' : `แตะชื่อ = ไม่ทำเขต`} ${ro ? '' : ` (ปรับ ${state.data.settings.zoneFine} บาท) · แตะป้ายสถานะ = เลือก ลา / ขาดเรียน · ลา ขาดเรียน มาทำ ไม่เสียเงิน`}</p>
        ${list.length ? `<ul class="list">${list.map(s => {
          const st = stOf(s.id), room = d[s.id] && d[s.id].room, r = L[s.id], owe = r ? Math.max(0, r.zoneDue) + Math.max(0, r.roomDue) : 0;
          return `<li class="stu ${ST[st].cls}">
            <button class="stu-main" ${dis} data-mark="zone" data-id="${esc(s.id)}" aria-label="${esc(fullName(s))}: ${ST[st].l} (แตะเพื่อสลับ มาทำ/ไม่ทำเขต)">
              <span class="no">${s.no || ''}</span>
              <span class="name">${esc(fullName(s))}<small>${[lateAt(s.id, state.date) ? `<span class="late">มาสาย ${esc(lateAt(s.id, state.date))}</span>` : '', s.code ? 'เลขประจำตัว ' + esc(s.code) : '', dutyLabel(s), r && r.absent.length ? `ไม่ทำเขตสะสม ${r.absent.length} วัน` : '', owe ? `ค้าง ${baht(owe)}` : ''].filter(Boolean).join(' · ')}</small></span>
            </button>
            <button class="chip st ${ST[st].cls}" ${dis} data-act="pick-status" data-id="${esc(s.id)}" aria-label="เปลี่ยนสถานะ">${ST[st].l}${ro ? '' : '<small>▾</small>'}</button>
            <button class="chip room ${room ? 'on' : ''}" ${dis} data-mark="room" data-id="${esc(s.id)}" aria-pressed="${!!room}">ห้อง<small>${room ? 'ขาด' : 'มา'}</small></button>
          </li>`;
        }).join('')}</ul>` : `<div class="empty">${all.length ? 'ไม่พบนักเรียนตามที่ค้นหา' : everyone.length ? 'วันนี้ไม่มีใครมีเวร' : 'เขตนี้ยังไม่มีรายชื่อนักเรียน'}</div>`}
        ${off.length ? `<details class="offduty"><summary>ไม่มีเวรวันนี้ ${off.length} คน (ไม่ต้องเช็ค ไม่เสียเงิน)</summary>
          <ul class="list">${off.map(s => `<li class="stu off"><span class="no">${s.no || ''}</span><span class="name">${esc(fullName(s))}<small>${esc(dutyLabel(s))}</small></span></li>`).join('')}</ul></details>` : ''}
      </section>
      ${ro ? `<div class="savebar"><div class="savebar-in">
        <span class="grow muted" style="font-size:13px;line-height:1.3">${info.done ? 'เช็คแล้ว' : 'ยังไม่ได้เช็ควันนี้'}<br>ลงข้อมูลต้องเข้าสู่ระบบ</span>
        ${info.done ? '<button class="btn" data-act="copy-day">คัดลอกสรุป</button>' : ''}
        <button class="btn primary" data-act="show-login">เข้าสู่ระบบ</button>
      </div></div>` : `<div class="savebar"><div class="savebar-in">
        <span class="grow muted" style="font-size:13px;line-height:1.3">${state.dirty ? '<span class="dot"></span> ยังไม่ได้บันทึก' : info.done ? 'บันทึกแล้ว' + (info.by ? '<br>โดย ' + esc(info.by) : '') : 'ยังไม่ได้เช็ควันนี้'}</span>
        ${!state.dirty && info.done ? '<button class="btn" data-act="copy-day">คัดลอกสรุป</button>' : '<button class="btn" data-act="all-present">ทุกคนมา</button>'}
        <button class="btn primary" data-act="save-checks" ${state.dirty || !info.done ? '' : 'disabled'}>${info.done ? 'บันทึก' : 'บันทึกการเช็ค'}</button>
      </div></div>`}`;
    $('#check-date').addEventListener('change', (e) => { if (e.target.value && confirmLeave()) { state.date = e.target.value; render(); } else e.target.value = state.date; });
    $('#c-q').addEventListener('input', (e) => { state.cq = e.target.value; renderCheck(main); const el = $('#c-q'); el.focus(); el.setSelectionRange(el.value.length, el.value.length); });
  }

  function pickStatus(id) {
    const s = state.data.students.find(x => x.id === id), cur = stOf(id);
    modal(`<h2>${esc(fullName(s))}</h2><p class="sub">${esc(thDate(state.date, { weekday: 'long' }))} · เลือกสถานะการทำเขต</p>
      <div class="st-pick">${Object.keys(ST).map(k => `<button class="btn ${ST[k].cls} ${k === cur ? 'cur' : ''}" data-act="set-status" data-id="${esc(id)}" data-v="${k}">
        ${ST[k].l}<small>${k === 'skip' ? 'ปรับ ' + state.data.settings.zoneFine + ' บาท' : 'ไม่เสียเงิน'}</small></button>`).join('')}</div>
      <div class="modal-actions"><button class="btn" data-act="close">ยกเลิก</button></div>`);
  }

  // ข้อความสรุปวันเดียว สำหรับวางใน LINE กลุ่ม
  function dayText() {
    const d = state.draft, all = studentsOf(state.zoneId).filter(s => onDuty(s, state.date) || d[s.id]);
    const line = (s) => `  ${s.no}. ${fullName(s)}`;
    const group = (k, label) => { const g = all.filter(s => stOf(s.id) === k); return g.length ? `${label} ${g.length} คน\n${g.map(line).join('\n')}` : ''; };
    const r = all.filter(s => d[s.id] && d[s.id].room);
    return [`สรุปเช็คเขต ${zoneName(state.zoneId)}`, thDate(state.date, { weekday: 'long', month: 'long', year: 'numeric' }),
      `มาทำ ${all.filter(s => stOf(s.id) === 'present').length}/${all.length} คน (คนที่มีเวรวันนี้)`,
      group('skip', 'ไม่ทำเขต') || 'ไม่ทำเขต: ไม่มี', group('leave', 'ลา'), group('absent', 'ขาดเรียน'),
      r.length ? `ขาดเวรห้อง ${r.length} คน\n${r.map(line).join('\n')}` : ''].filter(Boolean).join('\n');
  }

  function confirmLeave() {
    if (!state.dirty) return true;
    if (!confirm('ยังไม่ได้บันทึกการเช็ควันนี้ ต้องการทิ้งการเปลี่ยนแปลงไหม?')) return false;
    state.dirty = false; state.draftKey = ''; return true;
  }

  async function saveChecks(btn) {
    const marks = Object.entries(state.draft).filter(([, m]) => m.status !== 'present' || m.room).map(([id, m]) => ({ studentId: id, status: m.status, roomAbsent: !!m.room }));
    const ok = await busy(btn, () => api('saveChecks', { zoneId: state.zoneId, date: state.date, marks }));
    if (ok === undefined) return;
    const me = state.data.me.name;
    state.data.checks = state.data.checks.filter(c => !(c.zoneId === state.zoneId && c.date === state.date))
      .concat(marks.map(m => ({ zoneId: state.zoneId, date: state.date, studentId: m.studentId, status: m.status, zoneAbsent: m.status === 'skip', roomAbsent: m.roomAbsent, source: 'web', by: me })),
        [{ zoneId: state.zoneId, date: state.date, studentId: MARK, status: 'present', zoneAbsent: false, roomAbsent: false, source: 'web', by: me }]);
    state.dirty = false; state.draftKey = '';
    toast('บันทึกการเช็ค ' + thDate(state.date) + ' แล้ว');
    render();
  }

  /* ---------- สรุปยอดค้าง ---------- */
  function renderSummary(main) {
    const L = ledger(state.zoneId), sum = state.sum, set = state.data.settings;
    const q = sum.q.trim();
    const base = Object.values(L).filter(r => r.s.active || r.zoneDue || r.roomDue);
    const owes = (r) => r.zoneDue > 0 || r.roomDue > 0;
    const cnt = { all: base.length, owing: base.filter(owes).length, clear: base.filter(r => !owes(r)).length };
    const rows = base.filter(r => matchQ(r.s, q))
      .filter(r => sum.view === 'all' || (sum.view === 'owing' ? owes(r) : !owes(r)));
    const tot = (r) => Math.max(0, r.zoneDue) + Math.max(0, r.roomDue);
    if (sum.sort === 'due') rows.sort((a, b) => tot(b) - tot(a) || a.s.no - b.s.no);
    else if (sum.sort === 'absent') rows.sort((a, b) => b.absent.length - a.absent.length || a.s.no - b.s.no);
    const tz = rows.reduce((a, r) => a + Math.max(0, r.zoneDue), 0), tr = rows.reduce((a, r) => a + Math.max(0, r.roomDue), 0);
    main.innerHTML = `
      <div class="totals">
        <div class="total"><span>ค่าเขตค้างรวม</span><b class="money due">${baht(tz)}</b></div>
        <div class="total"><span>ค่าห้องค้างรวม</span><b class="money due">${baht(tr)}</b></div>
        <div class="total"><span>นักเรียนที่ยังค้าง</span><b>${cnt.owing} <small class="muted" style="font-size:14px">/ ${cnt.all} คน</small></b></div>
      </div>
      <section class="card">
        <div class="filters no-print">
          <label class="f f-q">ค้นหา<input id="s-q" placeholder="ชื่อ / เลขที่ / เลขประจำตัว" value="${esc(sum.q)}"></label>
        </div>
        <div class="row no-print" style="margin-bottom:10px">
          <div class="segs grow">${[['all', 'ทั้งหมด'], ['owing', 'ยังค้าง'], ['clear', 'จ่ายครบ']].map(([k, l]) =>
            `<button class="segbtn" data-act="sum-view" data-v="${k}" aria-pressed="${sum.view === k}">${l} <span>${cnt[k]}</span></button>`).join('')}</div>
          <select id="s-sort" aria-label="เรียงลำดับ" style="width:auto">
            <option value="no" ${sum.sort === 'no' ? 'selected' : ''}>เรียงตามเลขที่</option>
            <option value="due" ${sum.sort === 'due' ? 'selected' : ''}>ค้างมาก → น้อย</option>
            <option value="absent" ${sum.sort === 'absent' ? 'selected' : ''}>ขาดมาก → น้อย</option>
          </select>
        </div>
        <div class="row no-print" style="margin-bottom:6px">
          <span class="sub grow" style="margin:0">แตะชื่อเพื่อดูประวัติ · <span class="late">วันที่สีเหลือง</span> = มาโรงเรียนสาย (หลัง 07:50) · ยอดค้าง = ยอดยกมา + ค่าปรับ (เขต ${set.zoneFine} / ห้อง ${set.roomFine} บาทต่อครั้ง) − ที่จ่ายแล้ว</span>
          <button class="btn sm" data-act="csv">⬇ CSV</button>
          <button class="btn sm" data-act="print">พิมพ์</button>
        </div>
        <div class="table-wrap"><table class="sum-table">
          <thead><tr><th class="num">เลขที่</th><th>นักเรียน</th><th class="num">ค้างค่าเขต</th><th class="num">ค้างค่าห้อง</th><th>วันที่ไม่ทำเขตทั้งหมด</th><th></th></tr></thead>
          <tbody>${rows.length ? rows.map(r => {
            const ds = r.absent.slice().sort(), rs = r.room.slice().sort();
            const nl = r.leave.length, nm = r.miss.length;
            const clear = r.zoneDue <= 0 && r.roomDue <= 0;
            return `<tr class="${clear ? 'paid-up' : ''}">
              <td class="num c-hide">${r.s.no || ''}</td>
              <td class="c-name"><button class="linkbtn name-link" data-act="student" data-id="${esc(r.s.id)}">${esc(fullName(r.s))}</button>${codeTag(r.s)}${r.s.active ? '' : ' <span class="badge gray">ย้ายออก</span>'}</td>
              <td class="num c-due" data-l="ค่าเขต"><span class="money ${r.zoneDue > 0 ? 'due' : ''}">${baht(r.zoneDue)}</span></td>
              <td class="num c-due ${r.roomDue ? '' : 'c-zero'}" data-l="ค่าห้อง"><span class="money ${r.roomDue > 0 ? 'due' : ''}">${r.roomDue ? baht(r.roomDue) : '–'}</span></td>
              <td class="c-dates"><div class="dates">${ds.length ? `<b>${ds.length} วัน</b> · ${ds.map(dt => lateDate(r.s.id, dt, shortDate(dt))).join(', ')}` : '–'}${rs.length ? `<br><span style="color:var(--room)">ขาดเวรห้อง ${rs.length} วัน · ${rs.map(shortDate).join(', ')}</span>` : ''}${nl || nm ? `<br><span class="muted">ลา ${nl} · ขาดเรียน ${nm} วัน (ไม่เสียเงิน)</span>` : ''}</div></td>
              <td class="c-act">${canEdit() ? `<button class="btn sm" data-act="pay" data-id="${esc(r.s.id)}">รับเงิน</button>` : ''}</td>
            </tr>`;
          }).join('') : '<tr><td colspan="6" class="empty">ไม่พบนักเรียน</td></tr>'}</tbody>
        </table></div>
      </section>`;
    const upd = (k) => (e) => { sum[k] = e.target.value; renderSummary(main); const el = $('#s-' + k); if (k === 'q') { el.focus(); el.setSelectionRange(el.value.length, el.value.length); } };
    $('#s-q').addEventListener('input', upd('q'));
    $('#s-sort').addEventListener('change', upd('sort'));
  }

  /* ---------- ประวัติรายคน ---------- */
  function openStudent(studentId) {
    const s = state.data.students.find(x => x.id === studentId); if (!s) return;
    const r = ledger(s.zoneId)[studentId], set = state.data.settings;
    const pays = state.data.payments.filter(p => p.studentId === studentId && p.status !== 'void').sort((a, b) => b.date.localeCompare(a.date));
    const byMonth = {};
    state.data.checks.filter(c => c.studentId === studentId && (c.status !== 'present' || c.roomAbsent)).forEach(c => {
      const k = c.date.slice(0, 7); (byMonth[k] = byMonth[k] || []).push(c);
    });
    const nz = r.zoneFine / (set.zoneFine || 1), nr = r.roomFine / (set.roomFine || 1);
    const line = (label, z, rm, cls = '') => `<tr class="${cls}"><td>${label}</td><td class="num">${z}</td><td class="num">${rm}</td></tr>`;
    modal(`
      <h2>${esc(fullName(s))}</h2>
      <p class="sub">เลขที่ ${s.no || '-'}${s.code ? ' · เลขประจำตัว <b>' + esc(s.code) + '</b>' : ''} · ${esc(zoneName(s.zoneId))}<br>ไม่ทำเขต ${r.absent.length} · ขาดเวรห้อง ${r.room.length} · ลา ${r.leave.length} · ขาดเรียน ${r.miss.length} วัน${Object.keys(state.data.lateIdx[s.id] || {}).length ? ` · <span class="late">มาสาย ${Object.keys(state.data.lateIdx[s.id]).length} วัน</span>` : ''}</p>
      <table class="calc"><thead><tr><th></th><th class="num">ค่าเขต</th><th class="num">ค่าห้อง</th></tr></thead><tbody>
        ${r.open ? line('ยอดยกมา (' + esc(thDate(r.open.asOf)) + ')', baht(r.open.zoneDue), baht(r.open.roomDue)) : ''}
        ${line(`ค่าปรับใหม่`, `${nz} × ${set.zoneFine} = ${baht(r.zoneFine)}`, `${nr} × ${set.roomFine} = ${baht(r.roomFine)}`)}
        ${line('จ่ายแล้ว', '− ' + baht(r.zonePaid), '− ' + baht(r.roomPaid))}
        ${line('<b>คงค้าง</b>', `<b class="money ${r.zoneDue > 0 ? 'due' : ''}">${baht(r.zoneDue)}</b>`, `<b class="money ${r.roomDue > 0 ? 'due' : ''}">${baht(r.roomDue)}</b>`, 'sum-line')}
      </tbody></table>
      <h3 style="margin:16px 0 6px;font-size:14px">วันที่ไม่ได้มาทำเขตทั้งหมด (${Object.values(byMonth).reduce((n, l) => n + l.length, 0)} วัน)</h3>
      ${Object.keys(byMonth).length ? `<div class="hist">${Object.keys(byMonth).sort().reverse().map(k => `
        <h4>${parseIso(k + '-01').toLocaleDateString('th-TH', { month: 'long', year: 'numeric' })} <span class="muted">· ${byMonth[k].length} วัน</span></h4>
        <ol>${byMonth[k].sort((x, y) => y.date.localeCompare(x.date)).map(c => `<li>
          <span class="h-date">${lateDate(s.id, c.date, esc(thDate(c.date, { weekday: 'short', month: 'short', year: 'numeric' })))}${lateAt(s.id, c.date) ? `<small class="late-t">มาสาย ${esc(lateAt(s.id, c.date))} น.</small>` : ''}</span>
          <span class="h-tags">${c.status !== 'present' ? `<span class="dchip ${ST[c.status].cls}">${esc(ST[c.status].l)}${c.status === 'skip' && !(c.source === 'import' || (r.open && c.date <= r.open.asOf)) ? ' · ' + baht(set.zoneFine) : ''}</span>` : ''}${c.roomAbsent ? `<span class="dchip room">ขาดเวรห้อง</span>` : ''}</span>
          <small class="muted">${c.source === 'import' ? 'ระบบเดิม' : c.by ? 'โดย ' + esc(c.by) : ''}</small></li>`).join('')}</ol>`).join('')}</div>` : '<p class="muted">มาทำเขตครบทุกวัน</p>'}
      ${pays.length ? `<h3 style="margin:16px 0 0;font-size:14px">การจ่ายเงิน</h3><ul class="pay-list">${pays.map(p => `<li><span class="grow">${esc(thDate(p.date))} · ${p.kind === 'room' ? 'ค่าห้อง' : 'ค่าเขต'}</span><b>${baht(p.amount)}</b></li>`).join('')}</ul>` : ''}
      <div class="modal-actions" style="margin-top:16px"><button class="btn" data-act="close">ปิด</button>${canEdit() ? `<button class="btn primary" data-act="pay" data-id="${esc(studentId)}">รับเงิน</button>` : ''}</div>`);
  }

  function exportCsv() {
    const L = ledger(state.zoneId);
    const rows = [['เลขที่', 'เลขประจำตัว', 'ชื่อ-นามสกุล', 'ยอดยกมาค่าเขต', 'ยอดยกมาค่าห้อง', 'ค่าปรับเขต(ใหม่)', 'ค่าปรับห้อง(ใหม่)', 'จ่ายค่าเขต', 'จ่ายค่าห้อง', 'ค้างค่าเขต', 'ค้างค่าห้อง', 'ไม่ทำเขต(วัน)', 'ลา(วัน)', 'ขาดเรียน(วัน)', 'วันที่ไม่ทำเขต']];
    Object.values(L).forEach(r => rows.push([r.s.no, r.s.code || '', fullName(r.s), r.open ? r.open.zoneDue : 0, r.open ? r.open.roomDue : 0, r.zoneFine, r.roomFine,
      r.zonePaid, r.roomPaid, r.zoneDue, r.roomDue, r.absent.length, r.leave.length, r.miss.length, r.absent.sort().join(' ')]));
    const csv = '﻿' + rows.map(r => r.map(v => '"' + String(v).replace(/"/g, '""') + '"').join(',')).join('\n');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
    a.download = 'ยอดค้าง-' + zoneName(state.zoneId) + '-' + todayIso() + '.csv';
    a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  function openPay(studentId) {
    const r = ledger(state.zoneId)[studentId]; if (!r) return;
    const pays = state.data.payments.filter(p => p.studentId === studentId).sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
    const kind = r.zoneDue > 0 || r.roomDue <= 0 ? 'zone' : 'room';
    modal(`
      <h2>รับเงิน: ${esc(fullName(r.s))}</h2>
      <p class="sub">ค้างค่าเขต <b class="money due">${baht(r.zoneDue)}</b> · ค้างค่าห้อง <b class="money due">${baht(r.roomDue)}</b>
      ${r.open ? `<br>ยอดยกมาจากระบบเดิม ณ ${esc(thDate(r.open.asOf))}: เขต ${baht(r.open.zoneDue)} · ห้อง ${baht(r.open.roomDue)}` : ''}</p>
      <form id="pay-form">
        <div class="seg">
          <label><input type="radio" name="kind" value="zone" ${kind === 'zone' ? 'checked' : ''}><span>ค่าเขต</span></label>
          <label><input type="radio" name="kind" value="room" ${kind === 'room' ? 'checked' : ''}><span>ค่าห้อง</span></label>
        </div>
        <div class="row">
          <label class="f grow">จำนวนเงิน (บาท)<input name="amount" type="number" inputmode="numeric" min="1" step="1" required value="${Math.max(0, kind === 'zone' ? r.zoneDue : r.roomDue) || ''}"></label>
          <label class="f grow">วันที่รับ<input name="date" type="date" required value="${todayIso()}" max="${todayIso()}"></label>
        </div>
        <label class="f">หมายเหตุ<input name="note" maxlength="200" placeholder="ไม่บังคับ"></label>
        <div class="modal-actions"><button type="button" class="btn" data-act="close">ปิด</button><button class="btn primary" type="submit">บันทึกการรับเงิน</button></div>
      </form>
      ${pays.length ? `<h3 style="margin:18px 0 0;font-size:14px">ประวัติการจ่าย</h3><ul class="pay-list">${pays.map(p => `
        <li class="${p.status === 'void' ? 'void' : ''}"><span class="grow">${esc(thDate(p.date))} · ${p.kind === 'room' ? 'ค่าห้อง' : 'ค่าเขต'} <b>${baht(p.amount)}</b><br><small class="muted">รับโดย ${esc(p.byName)}${p.note ? ' · ' + esc(p.note) : ''}${p.status === 'void' ? ' · ยกเลิกโดย ' + esc(p.voidByName) : ''}</small></span>
        ${p.status === 'void' ? '' : `<button class="btn sm danger" data-act="void-pay" data-id="${esc(p.id)}" data-sid="${esc(studentId)}">ยกเลิก</button>`}</li>`).join('')}</ul>` : ''}`);
    const f = $('#pay-form');
    f.addEventListener('change', (e) => { if (e.target.name === 'kind') f.amount.value = Math.max(0, e.target.value === 'zone' ? r.zoneDue : r.roomDue) || ''; });
    f.addEventListener('submit', async (e) => {
      e.preventDefault();
      const row = await busy($('button[type=submit]', f), () => api('addPayment', { studentId, kind: f.kind.value, amount: f.amount.value, date: f.date.value, note: f.note.value }));
      if (!row) return;
      state.data.payments.push(row); closeModal(); toast('บันทึกรับเงิน ' + baht(row.amount) + ' แล้ว'); render();
    });
  }

  /* ---------- จัดการระบบ (ผู้ดูแล) ---------- */
  function renderAdmin(main) {
    const zs = zones();
    if (!zs.some(z => z.id === state.adminZone)) state.adminZone = zs[0] ? zs[0].id : '';
    const set = state.data.settings, days = String(set.checkDays).split(',');
    const zid = state.adminZone, list = zid ? studentsOf(zid, true) : [];
    main.innerHTML = `<div class="admin-grid">
      <section class="card">
        <h2>เขตและรายชื่อนักเรียน</h2>
        <p class="sub">เลือกเขตเพื่อแก้ไขรายชื่อ</p>
        <div class="zone-list">${zs.map(z => `<button class="zone-pill" data-act="admin-zone" data-id="${esc(z.id)}" aria-pressed="${z.id === zid}">${esc(z.name)}${z.active ? '' : ' (ปิด)'}</button>`).join('')}
          <button class="zone-pill" data-act="new-zone">+ เพิ่มเขต</button></div>
        ${zid ? `
          <div class="row" style="margin-bottom:10px">
            <span class="grow"><b>${esc(zoneName(zid))}</b> · ${list.filter(s => s.active).length} คน</span>
            <button class="btn sm" data-act="rename-zone">แก้ชื่อเขต</button>
          </div>
          <div class="table-wrap"><table class="edit-table">
            <thead><tr><th>เลขที่</th><th>เลขประจำตัว</th><th>คำนำหน้า</th><th>ชื่อ</th><th>นามสกุล</th><th></th></tr></thead>
            <tbody>${list.map(s => `<tr data-sid="${esc(s.id)}" style="${s.active ? '' : 'opacity:.5'}">
              <td class="w-no"><input name="no" type="number" value="${s.no || ''}" aria-label="เลขที่"></td>
              <td class="w-code"><input name="code" inputmode="numeric" maxlength="20" value="${esc(s.code || '')}" aria-label="เลขประจำตัว ${esc(fullName(s))}"></td>
              <td class="w-pre"><input name="prefix" value="${esc(s.prefix)}" aria-label="คำนำหน้า"></td>
              <td><input name="firstName" value="${esc(s.firstName)}" aria-label="ชื่อ"></td>
              <td><input name="lastName" value="${esc(s.lastName)}" aria-label="นามสกุล"></td>
              <td><button class="btn sm" data-act="toggle-stu" data-id="${esc(s.id)}" data-on="${s.active}">${s.active ? 'ย้ายออก' : 'คืนสถานะ'}</button></td>
            </tr>`).join('')}</tbody>
          </table></div>
          <div class="row" style="margin-top:10px"><button class="btn sm" data-act="renumber">เรียงเลขที่ใหม่ 1–${list.filter(s => s.active).length}</button><span class="grow"></span><button class="btn primary sm" data-act="save-stu">บันทึกการแก้ไขรายชื่อ</button></div>
          <details style="margin-top:14px"><summary style="cursor:pointer;font-weight:600">เพิ่มนักเรียนหลายคน</summary>
            <p class="sub" style="margin-top:8px">วางรายชื่อ บรรทัดละคน: <code>เลขที่ เลขประจำตัว ชื่อ นามสกุล</code> เช่น <code>12 41235 นายสมชาย ใจดี</code> (เลขประจำตัวไม่ใส่ก็ได้ · คัดลอกจาก Excel ได้)</p>
            <textarea id="bulk" placeholder="1 41201 นายสมชาย ใจดี&#10;2 41204 นางสาวสมหญิง รักเรียน"></textarea>
            <div class="row" style="margin-top:8px"><span class="grow"></span><button class="btn sm" data-act="bulk-add">เพิ่มรายชื่อ</button></div>
          </details>
          <details style="margin-top:10px" ${list.some(s => s.active && !s.code) ? 'open' : ''}><summary style="cursor:pointer;font-weight:600">ใส่เลขประจำตัวให้รายชื่อเดิม${list.some(s => s.active && !s.code) ? ` <span class="badge">ยังไม่มีเลข ${list.filter(s => s.active && !s.code).length} คน</span>` : ''}</summary>
            <p class="sub" style="margin-top:8px">วางบรรทัดละคน จับคู่ด้วยชื่อหรือเลขที่ เช่น <code>41235 นายสมชาย ใจดี</code> หรือ <code>12 41235</code> (เลขที่ เลขประจำตัว) · ระบบจะเติมลงตารางด้านบนให้ตรวจก่อน แล้วค่อยกดบันทึก</p>
            <textarea id="bulk-code" placeholder="41201 นายสมชาย ใจดี&#10;2 41204"></textarea>
            <div class="row" style="margin-top:8px"><span class="grow"></span><button class="btn sm" data-act="fill-codes">เติมเลขประจำตัวลงตาราง</button></div>
          </details>` : '<div class="empty">ยังไม่มีเขต</div>'}
      </section>

      <section class="card">
        <h2>นำเข้าข้อมูลจากระบบเดิม</h2>
        <p class="sub">เลือกไฟล์ <code>*_raw.json</code> ที่ดึงมาจากเว็บเดิม ระบบจะสร้างเขตใหม่พร้อมรายชื่อ ยอดค้างยกมา และประวัติวันที่ขาด (ไม่คิดค่าปรับซ้ำ)</p>
        <input type="file" id="import-file" accept=".json,application/json">
        <div id="import-preview"></div>
      </section>

      <section class="card">
        <h2>ตั้งค่า</h2>
        <form id="set-form" style="display:grid;gap:12px;margin-top:10px">
          <div class="form-grid">
            <label class="f">ค่าปรับขาดทำเขต (บาท/ครั้ง)<input name="zoneFine" type="number" min="0" value="${set.zoneFine}"></label>
            <label class="f">ค่าปรับขาดเวรห้อง (บาท/ครั้ง)<input name="roomFine" type="number" min="0" value="${set.roomFine}"></label>
          </div>
          <div><div class="f" style="margin-bottom:6px;font-size:13px;color:var(--muted)">วันในสัปดาห์ที่ต้องเช็ค (ใช้เมื่อยังไม่ได้สร้างวันทำเขตในแท็บ "วันทำเขต")</div>
            <div class="check-row">${['อา.', 'จ.', 'อ.', 'พ.', 'พฤ.', 'ศ.', 'ส.'].map((l, i) => `<label><input type="checkbox" name="day" value="${i}" ${days.includes(String(i)) ? 'checked' : ''}>${l}</label>`).join('')}</div></div>
          <div class="check-row" style="flex-direction:column;gap:8px">
            <label><input type="checkbox" name="publicView" ${set.publicView !== false ? 'checked' : ''}> เปิดให้ทุกคนดูผลการเช็คและยอดค้างได้โดยไม่ต้องเข้าสู่ระบบ (ดูอย่างเดียว)</label>
            <label><input type="checkbox" name="maskNames" ${set.maskNames ? 'checked' : ''}> ซ่อนนามสกุลในหน้าที่ดูโดยไม่เข้าสู่ระบบ (เช่น สมชาย ใ.)</label>
          </div>
          <div><button class="btn primary sm" type="submit">บันทึกการตั้งค่า</button></div>
        </form>
      </section>

      <section class="card">
        <div class="row"><h2 class="grow">ผู้ใช้งาน</h2><button class="btn sm" data-act="new-user">+ เพิ่มผู้ใช้</button></div>
        <p class="sub">ครู (ผู้ดูแล) เห็นทุกเขต · หัวหน้าเขตเช็คและรับเงินได้เฉพาะเขตที่ได้รับมอบหมาย</p>
        <div id="users">${state.users ? usersTable() : '<div class="loading">กำลังโหลด…</div>'}</div>
      </section>
    </div>`;
    $('#set-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const f = e.target, checkDays = $$('input[name=day]:checked', f).map(x => x.value).join(',');
      const s = await busy($('button[type=submit]', f), () => api('saveSettings', { settings: { zoneFine: f.zoneFine.value, roomFine: f.roomFine.value, checkDays,
        publicView: f.publicView.checked, maskNames: f.maskNames.checked } }));
      if (s) {
        state.data.settings = { zoneFine: Number(s.zoneFine), roomFine: Number(s.roomFine), checkDays: s.checkDays,
          publicView: s.publicView === true || s.publicView === '1', maskNames: s.maskNames === true || s.maskNames === '1' };
        toast('บันทึกการตั้งค่าแล้ว');
      }
    });
    $('#import-file').addEventListener('change', onImportFile);
    if (!state.users) api('listUsers').then(u => { state.users = u; const el = $('#users'); if (el) el.innerHTML = usersTable(); }).catch(e => toast(e.message, true));
  }

  /* ---------- เซ็ตเวร + วันรายคน ---------- */
  const dayChips = (days, act, attrs) => `<span class="wd">${[1, 2, 3, 4, 5, 6, 0].map(d => {
    const on = days.split(',').includes(String(d));
    return `<button type="button" class="wdc ${on ? 'on' : ''}" data-act="${act}" data-d="${d}" ${attrs} aria-pressed="${on}">${WD[d]}</button>`;
  }).join('')}</span>`;
  const toggleDay = (days, d) => { const set = new Set(days ? days.split(',') : []); if (set.has(d)) set.delete(d); else set.add(d); return [...set].sort().join(','); };

  function renderRosterCard() {
    const box = $('#roster-card'); if (!box) return;
    const zs = zones().filter(z => z.active);
    if (!zs.length) { box.innerHTML = '<div class="empty">ยังไม่มีเขต</div>'; return; }
    if (!zs.some(z => z.id === state.rosterZone)) state.rosterZone = zs.some(z => z.id === state.zoneId) ? state.zoneId : zs[0].id;
    const zid = state.rosterZone, list = studentsOf(zid);
    if (!state.roster || state.roster.zoneId !== zid) {
      const assign = {};
      list.forEach(x => { assign[x.id] = { setId: x.setId || '', days: x.days || '', custom: !!x.days }; });
      state.roster = { zoneId: zid, sets: setsOf(zid).map(x => ({ id: x.id, name: x.name, days: x.days })), assign, dirty: false };
    }
    const R = state.roster;
    const members = (id) => list.filter(x => !R.assign[x.id].custom && R.assign[x.id].setId === id).length;
    box.innerHTML = `
      <h2>เซ็ตเวรและวันของแต่ละคน</h2>
      <p class="sub">แบ่งนักเรียนเป็นเซ็ต แต่ละเซ็ตทำเขตเฉพาะวันที่เลือก หรือกำหนดวันให้รายคน · คนที่ไม่มีเซ็ตทำทุกวันทำเขต · วันที่ไม่มีเวร ไม่ต้องเช็คและไม่เสียเงิน</p>
      ${zs.length > 1 ? `<label class="f" style="margin-bottom:10px">เขต<select id="roster-zone">${zs.map(z => `<option value="${esc(z.id)}" ${z.id === zid ? 'selected' : ''}>${esc(z.name)}</option>`).join('')}</select></label>` : `<p style="margin:0 0 10px"><b>${esc(zs[0].name)}</b></p>`}
      <h3>เซ็ต</h3>
      ${R.sets.length ? `<ul class="set-list">${R.sets.map((x, i) => `<li>
        <input class="set-name" data-i="${i}" value="${esc(x.name)}" aria-label="ชื่อเซ็ต" maxlength="60">
        ${dayChips(x.days, 'set-day', `data-i="${i}"`)}
        <span class="muted set-n">${members(x.id)} คน</span>
        <button class="btn sm danger" data-act="set-del" data-i="${i}" aria-label="ลบเซ็ต">ลบ</button></li>`).join('')}</ul>`
        : '<p class="muted" style="margin:0 0 8px">ยังไม่มีเซ็ต — ทุกคนทำทุกวันทำเขต</p>'}
      <div class="row" style="margin:8px 0 16px">
        <button class="btn sm" data-act="set-add">+ เพิ่มเซ็ต</button>
        <button class="btn sm" data-act="set-week">สร้างเซ็ต จ.–ศ. (5 เซ็ต)</button>
        ${R.sets.length ? '<button class="btn sm" data-act="set-auto">แบ่งนักเรียนอัตโนมัติตามเลขที่</button>' : ''}
      </div>
      <h3>นักเรียน (${list.length} คน)</h3>
      <ul class="roster">${list.map(x => {
        const a = R.assign[x.id], v = a.custom ? '__custom' : a.setId;
        return `<li><span class="no">${x.no || ''}</span><span class="name">${esc(fullName(x))}</span>
          <select class="r-sel" data-sid="${esc(x.id)}" aria-label="เซ็ตของ ${esc(fullName(x))}">
            <option value="" ${v === '' ? 'selected' : ''}>ทุกวัน</option>
            ${R.sets.map(z => `<option value="${esc(z.id)}" ${v === z.id ? 'selected' : ''}>${esc(z.name)}</option>`).join('')}
            <option value="__custom" ${v === '__custom' ? 'selected' : ''}>กำหนดวันเอง…</option>
          </select>
          ${a.custom ? `<span class="r-days">${dayChips(a.days, 'stu-day', `data-sid="${esc(x.id)}"`)}</span>` : ''}</li>`;
      }).join('')}</ul>
      <div class="row" style="margin-top:12px">
        <span class="grow muted" style="font-size:13px">${R.dirty ? '<span class="dot"></span> ยังไม่บันทึก' : ''}</span>
        <button class="btn primary" data-act="save-roster" ${R.dirty ? '' : 'disabled'}>บันทึกเซ็ตเวร</button>
      </div>`;
    const z = $('#roster-zone');
    if (z) z.addEventListener('change', (e) => {
      if (R.dirty && !confirm('ยังไม่ได้บันทึกเซ็ตเวร ต้องการทิ้งการเปลี่ยนแปลงไหม?')) { e.target.value = zid; return; }
      state.rosterZone = e.target.value; state.roster = null; renderRosterCard();
    });
    $$('.set-name', box).forEach(inp => inp.addEventListener('change', (e) => { R.sets[Number(e.target.dataset.i)].name = e.target.value.trim(); R.dirty = true; renderRosterCard(); }));
    $$('.r-sel', box).forEach(sel => sel.addEventListener('change', (e) => {
      const a = R.assign[e.target.dataset.sid], v = e.target.value;
      if (v === '__custom') { a.custom = true; const st = R.sets.find(x => x.id === a.setId); a.days = a.days || (st ? st.days : ''); }
      else { a.custom = false; a.days = ''; a.setId = v; }
      R.dirty = true; renderRosterCard();
    }));
  }

  async function rosterAction(act, t) {
    const R = state.roster; if (!R) return;
    if (act === 'set-day') { const x = R.sets[Number(t.dataset.i)]; x.days = toggleDay(x.days, t.dataset.d); }
    else if (act === 'stu-day') { const a = R.assign[t.dataset.sid]; a.days = toggleDay(a.days, t.dataset.d); }
    else if (act === 'set-add') R.sets.push({ id: 'n' + Math.random().toString(36).slice(2, 9), name: 'เซ็ต ' + (R.sets.length + 1), days: '' });
    else if (act === 'set-del') {
      const x = R.sets[Number(t.dataset.i)];
      if (!confirm('ลบ "' + x.name + '"? นักเรียนในเซ็ตนี้จะกลับไปทำทุกวัน')) return;
      R.sets.splice(Number(t.dataset.i), 1);
      Object.values(R.assign).forEach(a => { if (a.setId === x.id) a.setId = ''; });
    } else if (act === 'set-week') {
      if (R.sets.length && !confirm('แทนที่เซ็ตเดิมด้วย 5 เซ็ต (จันทร์–ศุกร์)?')) return;
      R.sets = ['จันทร์', 'อังคาร', 'พุธ', 'พฤหัสบดี', 'ศุกร์'].map((n, i) => ({ id: 'n' + Math.random().toString(36).slice(2, 9), name: 'เซ็ตวัน' + n, days: String(i + 1) }));
      Object.values(R.assign).forEach(a => { a.setId = ''; });
    } else if (act === 'set-auto') {
      const list = studentsOf(R.zoneId).filter(x => !R.assign[x.id].custom), k = R.sets.length;
      if (!confirm('แบ่ง ' + list.length + ' คน เป็น ' + k + ' เซ็ตเท่า ๆ กันตามเลขที่? (คนที่กำหนดวันเองไม่เปลี่ยน)')) return;
      const per = Math.ceil(list.length / k);
      list.forEach((x, i) => { R.assign[x.id].setId = R.sets[Math.min(k - 1, Math.floor(i / per))].id; });
    } else if (act === 'save-roster') {
      const assign = Object.entries(R.assign).map(([studentId, a]) => ({ studentId, setId: a.custom ? '' : a.setId, days: a.custom ? a.days : '' }));
      const r = await busy(t, () => api('saveRoster', { zoneId: R.zoneId, sets: R.sets, assign }));
      if (!r) return;
      await reload(); state.roster = null; state.draftKey = ''; toast('บันทึกเซ็ตเวรแล้ว'); return renderRosterCard();
    }
    R.dirty = true; renderRosterCard();
  }

  /* ---------- ปฏิทินวันทำเขต ---------- */
  function renderDutyCard() {
    const box = $('#duty-card'); if (!box) return;
    const zs = zones().filter(z => z.active);
    // ครูเลือก "ทุกเขต (ค่าเริ่มต้น)" ได้ · หัวหน้าเขตแก้เฉพาะเขตของตัวเอง
    const opts = (isAdmin() ? [{ id: '', name: 'ทุกเขต (ค่าเริ่มต้น)' }] : []).concat(zs);
    if (state.dutyZone == null || !opts.some(o => o.id === state.dutyZone)) state.dutyZone = isAdmin() ? '' : (opts.some(o => o.id === state.zoneId) ? state.zoneId : (opts[0] || {}).id);
    if (state.dutyZone == null) { box.innerHTML = '<div class="empty">บัญชีนี้ยังไม่ได้รับมอบหมายเขต</div>'; return; }
    const zid = state.dutyZone, own = ownDays(zid), def = ownDays('');
    const savedList = zid && !own.length ? def : own;   // เขตที่ยังไม่มีวันของตัวเอง เริ่มจากค่าเริ่มต้น
    if (!state.duty || state.duty.key !== zid) state.duty = { key: zid, set: new Set(savedList) };
    const D = state.duty.set, ym = state.calMonth, first = parseIso(ym + '-01');
    const dirty = D.size !== savedList.length || savedList.some(d => !D.has(d));
    const days = new Date(first.getFullYear(), first.getMonth() + 1, 0).getDate();
    const cells = [];
    for (let i = 0; i < first.getDay(); i++) cells.push('<span></span>');
    for (let n = 1; n <= days; n++) {
      const dt = ym + '-' + String(n).padStart(2, '0'), on = D.has(dt), wd = parseIso(dt).getDay();
      cells.push(`<button class="cday ${on ? 'on' : ''} ${wd === 0 || wd === 6 ? 'wkend' : ''} ${dt === todayIso() ? 'today' : ''}" data-act="cal-day" data-date="${dt}" aria-pressed="${on}" aria-label="${esc(thDate(dt, { weekday: 'long' }))}">${n}</button>`);
    }
    const inMonth = [...D].filter(d => d.startsWith(ym)).length;
    const note = !zid ? 'ใช้กับทุกเขตที่หัวหน้าเขตยังไม่ได้กำหนดวันเอง'
      : own.length ? 'เขตนี้ใช้วันทำเขตของตัวเอง' : def.length ? 'ตอนนี้ใช้วันเดียวกับทุกเขต — แก้แล้วบันทึก จะเป็นวันของเขตนี้โดยเฉพาะ' : 'ยังไม่ได้กำหนด — ตอนนี้ใช้ทุก จ.–ศ.';
    box.innerHTML = `
      <div class="row"><h2 class="grow">วันทำเขต</h2><span class="badge">${inMonth} วันในเดือนนี้</span></div>
      <p class="sub">แตะวันที่เพื่อเลือก/ยกเลิก · วันหยุด ปิดภาค หรือมีกิจกรรม ให้แตะยกเลิกออก</p>
      ${opts.length > 1 ? `<label class="f" style="margin-bottom:6px">กำหนดวันของ<select id="duty-zone">${opts.map(o => `<option value="${esc(o.id)}" ${o.id === zid ? 'selected' : ''}>${esc(o.name)}</option>`).join('')}</select></label>`
        : `<p style="margin:0 0 6px"><b>${esc(opts[0].name)}</b></p>`}
      <p class="hint" style="margin:0 0 10px">${note}</p>
      <div class="row cal-nav">
        <button class="btn icon" data-act="cal-month" data-n="-1" aria-label="เดือนก่อน">‹</button>
        <b class="grow" style="text-align:center">${first.toLocaleDateString('th-TH', { month: 'long', year: 'numeric' })}</b>
        <button class="btn icon" data-act="cal-month" data-n="1" aria-label="เดือนถัดไป">›</button>
      </div>
      <div class="cal">${['อา', 'จ', 'อ', 'พ', 'พฤ', 'ศ', 'ส'].map(w => `<span class="cw">${w}</span>`).join('')}${cells.join('')}</div>
      <div class="row" style="margin-top:12px">
        <button class="btn sm" data-act="cal-weekdays">เลือก จ.–ศ. ทั้งเดือน</button>
        <button class="btn sm" data-act="cal-clear">ล้างเดือนนี้</button>
        ${zid && own.length && def.length ? '<button class="btn sm" data-act="cal-reset">ใช้วันเดียวกับทุกเขต</button>' : ''}
      </div>
      <div class="row" style="margin-top:10px">
        <span class="grow muted" style="font-size:13px">${dirty ? '<span class="dot"></span> ยังไม่บันทึก' : ''}</span>
        <button class="btn primary" data-act="save-duty" ${dirty ? '' : 'disabled'}>บันทึกวันทำเขต</button>
      </div>`;
    $('#duty-zone') && $('#duty-zone').addEventListener('change', (e) => {
      if (dirty && !confirm('ยังไม่ได้บันทึกวันทำเขต ต้องการทิ้งการเปลี่ยนแปลงไหม?')) { e.target.value = zid; return; }
      state.dutyZone = e.target.value; state.duty = null; renderDutyCard();
    });
  }

  function usersTable() {
    return `<div class="table-wrap"><table><thead><tr><th>ชื่อผู้ใช้</th><th>ชื่อ</th><th>บทบาท / เขต</th><th></th></tr></thead><tbody>${state.users.map(u => `
      <tr style="${u.active ? '' : 'opacity:.5'}"><td>${esc(u.username)}</td><td>${esc(u.name)}</td>
      <td>${u.role === 'admin' ? '<span class="badge">ครูผู้ดูแล</span>' : `<span class="badge gray">หัวหน้าเขต</span> ${esc(u.zoneIds.map(zoneName).filter(Boolean).join(', ') || '— ยังไม่ได้มอบหมาย')}`}${u.active ? '' : ' · ปิดใช้งาน'}</td>
      <td class="num"><button class="btn sm" data-act="edit-user" data-id="${esc(u.username)}">แก้ไข</button></td></tr>`).join('')}</tbody></table></div>`;
  }

  function userForm(u) {
    const isNew = !u; u = u || { username: '', name: '', role: 'head', zoneIds: [], active: true };
    modal(`
      <h2>${isNew ? 'เพิ่มผู้ใช้' : 'แก้ไขผู้ใช้: ' + esc(u.username)}</h2>
      <form id="user-form">
        ${isNew ? '<label class="f">ชื่อผู้ใช้ (ภาษาอังกฤษ)<input name="username" required pattern="[a-zA-Z0-9._\\-]{3,30}" autocapitalize="off"></label>' : ''}
        <label class="f">ชื่อที่แสดง<input name="name" required value="${esc(u.name)}"></label>
        <div class="seg">
          <label><input type="radio" name="role" value="head" ${u.role !== 'admin' ? 'checked' : ''}><span>หัวหน้าเขต</span></label>
          <label><input type="radio" name="role" value="admin" ${u.role === 'admin' ? 'checked' : ''}><span>ครูผู้ดูแล</span></label>
        </div>
        <div><div style="font-size:13px;color:var(--muted);margin-bottom:6px">เขตที่รับผิดชอบ (หัวหน้าเขต)</div>
          <div class="check-row">${zones().map(z => `<label><input type="checkbox" name="zone" value="${esc(z.id)}" ${u.zoneIds.includes(z.id) ? 'checked' : ''}>${esc(z.name)}</label>`).join('') || '<span class="muted">ยังไม่มีเขต</span>'}</div></div>
        ${isNew ? '<label class="f">รหัสผ่านเริ่มต้น (อย่างน้อย 6 ตัว)<input name="password" type="text" minlength="6" required autocomplete="off"></label>'
          : `<label class="check-row"><label><input type="checkbox" name="active" ${u.active ? 'checked' : ''}> เปิดใช้งานบัญชี</label></label>
             <label class="f">ตั้งรหัสผ่านใหม่ (เว้นว่างถ้าไม่เปลี่ยน)<input name="newPassword" type="text" minlength="6" autocomplete="off"></label>`}
        <div class="modal-actions"><button type="button" class="btn" data-act="close">ยกเลิก</button><button class="btn primary" type="submit">บันทึก</button></div>
      </form>`);
    const f = $('#user-form');
    f.addEventListener('submit', async (e) => {
      e.preventDefault();
      const ok = await busy($('button[type=submit]', f), async () => {
        await api('saveUser', { username: isNew ? f.username.value : u.username, name: f.name.value, role: f.role.value,
          zoneIds: $$('input[name=zone]:checked', f).map(x => x.value), active: isNew ? true : f.active.checked, password: isNew ? f.password.value : undefined });
        if (!isNew && f.newPassword.value) await api('resetPassword', { username: u.username, newPassword: f.newPassword.value });
        return true;
      });
      if (!ok) return;
      state.users = await api('listUsers'); closeModal(); toast('บันทึกผู้ใช้แล้ว'); render();
    });
  }

  // แปลงไฟล์ raw JSON ที่ดึงจากระบบเดิม → ข้อมูลนำเข้า
  let importData = null;
  async function onImportFile(e) {
    const file = e.target.files[0], box = $('#import-preview'); importData = null;
    if (!file) { box.innerHTML = ''; return; }
    try {
      const raw = JSON.parse(await file.text());
      if (!raw.zoneName || !Array.isArray(raw.rows) || !/^\d{4}-\d{2}-\d{2}$/.test(raw.rangeFrom || '')) throw new Error('รูปแบบไฟล์ไม่ถูกต้อง');
      const y0 = Number(raw.rangeFrom.slice(0, 4)), m0 = Number(raw.rangeFrom.slice(5, 7));
      const num = (s) => Number(String(s).replace(/[^\d]/g, '')) || 0;
      const students = raw.rows.map(([no, name, zoneDue, roomDue, dates, code]) => ({
        no: Number(no) || 0, code: cleanCode(code), ...splitName(name), zoneDue: num(zoneDue), roomDue: num(roomDue),
        absentDates: String(dates || '').split(',').map(x => x.trim()).filter(x => /^\d{1,2}\/\d{1,2}$/.test(x)).map(x => {
          const [d, m] = x.split('/').map(Number);
          return (m < m0 ? y0 + 1 : y0) + '-' + String(m).padStart(2, '0') + '-' + String(d).padStart(2, '0');
        }),
      }));
      importData = { name: raw.zoneName, asOf: raw.rangeTo || raw.capturedAt, students };
      const nd = students.reduce((a, s) => a + s.absentDates.length, 0);
      box.innerHTML = `<div class="warn" style="background:var(--brand-soft);color:var(--ink)">
        <b>${esc(importData.name)}</b> · นักเรียน ${students.length} คน · วันที่ขาด ${nd} รายการ<br>
        ยอดยกมา ณ ${esc(thDate(importData.asOf))}: ค่าเขต ${baht(students.reduce((a, s) => a + s.zoneDue, 0))} · ค่าห้อง ${baht(students.reduce((a, s) => a + s.roomDue, 0))}
        <div style="margin-top:8px"><button class="btn primary sm" data-act="do-import">นำเข้าเป็นเขตใหม่</button></div></div>`;
    } catch (err) { box.innerHTML = '<div class="warn">' + esc(err.message) + '</div>'; }
  }

  /* ---------- modal ---------- */
  function modal(html) { $('#modal-body').innerHTML = html; const m = $('#modal'); if (!m.open) m.showModal(); }
  function closeModal() { const m = $('#modal'); if (m.open) m.close(); }

  /* ================= เหตุการณ์ ================= */
  document.addEventListener('click', async (e) => {
    const t = e.target.closest('[data-act],[data-tab],[data-mark]'); if (!t) return;
    if (t.dataset.tab) { if (t.dataset.tab !== state.tab && confirmLeave()) { state.tab = t.dataset.tab; location.hash = state.tab; render(); } return; }
    if (t.dataset.mark) {
      if (!canEdit()) return;
      const id = t.dataset.id;
      if (t.dataset.mark === 'room') setDraft(id, { room: !(state.draft[id] && state.draft[id].room) });
      else setDraft(id, { status: stOf(id) === 'skip' ? 'present' : 'skip' });
      renderCheck($('#main')); return;
    }
    const act = t.dataset.act;
    if (act === 'close') return closeModal();
    if (act === 'show-login') { if (!confirmLeave()) return; state.showLogin = true; closeModal(); window.scrollTo(0, 0); return render(); }
    if (act === 'back-public') { state.showLogin = false; return render(); }
    if ((act === 'pick-status' || act === 'set-status' || act === 'pay' || act === 'save-checks' || act === 'all-present') && !canEdit()) return;
    if (act === 'pick-status') return pickStatus(t.dataset.id);
    if (act === 'set-status') { setDraft(t.dataset.id, { status: t.dataset.v }); closeModal(); return renderCheck($('#main')); }
    if (act === 'goto-check' || act === 'goto-sum') {
      if (!confirmLeave()) return;
      state.zoneId = t.dataset.zone; localSet('cz_zone', state.zoneId);
      if (t.dataset.date) state.date = t.dataset.date;
      state.tab = act === 'goto-check' ? 'check' : 'summary'; location.hash = state.tab; window.scrollTo(0, 0); return render();
    }
    if (act === 'only-absent') { state.onlyAbsent = !state.onlyAbsent; return renderCheck($('#main')); }
    if (act === 'copy-day') {
      const txt = dayText();
      try { await navigator.clipboard.writeText(txt); toast('คัดลอกสรุปแล้ว วางใน LINE ได้เลย'); }
      catch (_) { modal(`<h2>สรุปวันนี้</h2><p class="sub">กดค้างเพื่อคัดลอก</p><textarea readonly style="min-height:220px">${esc(txt)}</textarea><div class="modal-actions"><button class="btn" data-act="close">ปิด</button></div>`); }
      return;
    }
    if (act === 'sum-view') { state.sum.view = t.dataset.v; return renderSummary($('#main')); }
    if (act === 'student') return openStudent(t.dataset.id);
    if (act === 'logout') { try { await api('logout'); } catch (_) { /* ไม่เป็นไร */ } clearCaches(); setSession(null); closeModal(); return render(); }
    if (act === 'menu') {
      const me = state.data.me;
      return modal(`<h2>${esc(me.name)}</h2><p class="sub">${esc(me.username)} · ${me.role === 'admin' ? 'ครูผู้ดูแล' : 'หัวหน้าเขต'}${DEMO ? ' · โหมดทดลอง' : ''}</p>
        <form id="pw-form"><label class="f">รหัสผ่านเดิม<input name="old" type="password" required autocomplete="current-password"></label>
        <label class="f">รหัสผ่านใหม่ (อย่างน้อย 6 ตัว)<input name="nw" type="password" minlength="6" required autocomplete="new-password"></label>
        <div class="modal-actions"><button type="button" class="btn danger" data-act="logout">ออกจากระบบ</button><span class="grow"></span><button class="btn primary" type="submit">เปลี่ยนรหัสผ่าน</button></div></form>`);
      return bindPw();
    }
    if (act === 'day') { if (confirmLeave()) { state.date = stepDay(state.date, Number(t.dataset.n), state.zoneId); if (state.date > todayIso()) state.date = todayIso(); render(); } return; }
    if (act === 'all-present') { studentsOf(state.zoneId).forEach(s => { delete state.draft[s.id]; }); state.dirty = true; return renderCheck($('#main')); }
    if (act === 'save-checks') return saveChecks(t);
    if (act === 'pay') return openPay(t.dataset.id);
    if (act === 'void-pay') {
      if (!confirm('ยกเลิกรายการรับเงินนี้?')) return;
      const ok = await busy(t, () => api('voidPayment', { id: t.dataset.id }));
      if (ok === undefined) return;
      const p = state.data.payments.find(x => x.id === t.dataset.id); if (p) { p.status = 'void'; p.voidByName = state.data.me.name; }
      openPay(t.dataset.sid); return render();
    }
    if (act === 'csv') return exportCsv();
    if (act === 'print') return window.print();
    if (act === 'admin-zone') { state.adminZone = t.dataset.id; return render(); }
    if (act === 'new-zone' || act === 'rename-zone') {
      const z = act === 'rename-zone' ? state.data.zones.find(x => x.id === state.adminZone) : null;
      const name = prompt(z ? 'ชื่อเขตใหม่' : 'ชื่อเขตที่จะเพิ่ม เช่น หน้าอาคาร 1', z ? z.name : '');
      if (!name || !name.trim()) return;
      const r = await busy(null, () => api('saveZone', { id: z ? z.id : '', name, sort: z ? z.sort : 0, active: true }));
      if (!r) return; await reload(); state.adminZone = r.id; toast('บันทึกเขตแล้ว'); return render();
    }
    if (act === 'save-stu') {
      const students = $$('tr[data-sid]').map(tr => ({ id: tr.dataset.sid, no: $('[name=no]', tr).value, code: cleanCode($('[name=code]', tr).value), prefix: $('[name=prefix]', tr).value.trim(),
        firstName: $('[name=firstName]', tr).value.trim(), lastName: $('[name=lastName]', tr).value.trim() }));
      if (students.some(s => !s.firstName)) return toast('ชื่อนักเรียนห้ามว่าง', true);
      const ids = new Set(students.map(s => s.id));
      const dup = dupCode(students.concat(state.data.students.filter(s => !ids.has(s.id))));
      if (dup) return toast(dup, true);
      const r = await busy(t, () => api('saveStudents', { zoneId: state.adminZone, students }));
      if (!r) return; await reload(); toast('บันทึกรายชื่อแล้ว'); return render();
    }
    if (act === 'bulk-add') {
      const lines = $('#bulk').value.split('\n').map(l => l.trim()).filter(Boolean);
      const students = lines.map(l => {
        const m = l.match(/^(\d+)[\s.,\t]+(?:(\d{3,})[\s,\t]+)?(.+)$/);
        if (!m) return { no: 0, code: '', ...splitName(l) };
        // ตัวเลขตัวเดียวที่ยาว 4 หลักขึ้นไป = เลขประจำตัว (ไม่ใช่เลขที่)
        const one = !m[2] && m[1].length >= 4;
        return { no: one ? 0 : Number(m[1]), code: one ? m[1] : (m[2] || ''), ...splitName(m[3]) };
      });
      const dup = dupCode(students.concat(state.data.students));
      if (dup) return toast(dup, true);
      if (!students.length) return toast('ยังไม่ได้วางรายชื่อ', true);
      const r = await busy(t, () => api('saveStudents', { zoneId: state.adminZone, students }));
      if (!r) return; await reload(); toast('เพิ่ม ' + r.added + ' คนแล้ว'); return render();
    }
    if (act === 'renumber') {
      // เรียงตามเลขที่เดิม (คนที่ย้ายออกไม่นับ) แล้วใส่ 1, 2, 3 … ลงตาราง ให้ตรวจก่อนกดบันทึก
      const rows = $$('tr[data-sid]').filter(tr => (state.data.students.find(x => x.id === tr.dataset.sid) || {}).active)
        .sort((a, b) => (Number($('[name=no]', a).value) || 9999) - (Number($('[name=no]', b).value) || 9999));
      rows.forEach((tr, i) => { const inp = $('[name=no]', tr); if (inp.value !== String(i + 1)) { inp.value = i + 1; inp.classList.add('filled'); } });
      return toast('เรียงเลขที่ 1–' + rows.length + ' แล้ว — ตรวจแล้วกด "บันทึกการแก้ไขรายชื่อ"');
    }
    if (act === 'fill-codes') {
      const rows = $$('tr[data-sid]'), stu = (tr) => state.data.students.find(x => x.id === tr.dataset.sid);
      const bare = (s) => plain(s.firstName + s.lastName);
      let ok = 0; const miss = [];
      $('#bulk-code').value.split('\n').map(l => l.trim()).filter(Boolean).forEach(l => {
        const nums = l.match(/\d+/g) || [], text = l.replace(/\d+/g, ' ').replace(/[.,\t]/g, ' ').trim();
        const code = nums.filter(n => n.length >= 3).pop();
        if (!code) { miss.push(l); return; }
        let tr = null;
        if (text) { const nm = splitName(text), key = plain(nm.firstName + nm.lastName); tr = rows.find(x => bare(stu(x)) === key) || rows.find(x => bare(stu(x)).startsWith(plain(nm.firstName))); }
        if (!tr) { const no = nums.find(n => n !== code && n.length <= 3); if (no) tr = rows.find(x => $('[name=no]', x).value === no); }
        if (!tr) { miss.push(l); return; }
        const inp = $('[name=code]', tr); inp.value = code; inp.classList.add('filled'); ok++;
      });
      if (!ok) return toast('ไม่พบรายชื่อที่ตรงกัน' + (miss.length ? ': ' + miss.slice(0, 3).join(' / ') : ''), true);
      return toast('เติมแล้ว ' + ok + ' คน' + (miss.length ? ' · ไม่พบ ' + miss.length + ' บรรทัด (' + miss.slice(0, 2).join(' / ') + ')' : '') + ' — ตรวจแล้วกด "บันทึกการแก้ไขรายชื่อ"', !!miss.length);
    }
    if (act === 'toggle-stu') {
      const on = t.dataset.on === 'true';
      if (on && !confirm('ย้ายนักเรียนคนนี้ออกจากเขต? (ประวัติและยอดค้างยังเก็บไว้)')) return;
      const r = await busy(t, () => api('setStudentActive', { id: t.dataset.id, active: !on }));
      if (r === undefined) return; await reload(); return render();
    }
    if (act === 'do-import') {
      if (!importData || !confirm('นำเข้า "' + importData.name + '" (' + importData.students.length + ' คน) เป็นเขตใหม่?')) return;
      const r = await busy(t, () => api('importZone', { zone: importData }));
      if (!r) return; importData = null; await reload(); state.adminZone = r.zoneId;
      toast('นำเข้าแล้ว: ' + r.students + ' คน, วันที่ขาด ' + r.checks + ' รายการ'); return render();
    }
    if (['set-day', 'stu-day', 'set-add', 'set-del', 'set-week', 'set-auto', 'save-roster'].includes(act)) return rosterAction(act, t);
    if (act === 'cal-month') { const d = parseIso(state.calMonth + '-01'); d.setMonth(d.getMonth() + Number(t.dataset.n)); state.calMonth = iso(d).slice(0, 7); return renderDutyCard(); }
    if (act === 'cal-day') { const D = state.duty.set; if (D.has(t.dataset.date)) D.delete(t.dataset.date); else D.add(t.dataset.date); return renderDutyCard(); }
    if (act === 'cal-weekdays' || act === 'cal-clear') {
      const ym = state.calMonth, first = parseIso(ym + '-01'), n = new Date(first.getFullYear(), first.getMonth() + 1, 0).getDate();
      for (let i = 1; i <= n; i++) {
        const dt = ym + '-' + String(i).padStart(2, '0'), wd = parseIso(dt).getDay();
        if (act === 'cal-clear') state.duty.set.delete(dt); else if (wd > 0 && wd < 6) state.duty.set.add(dt);
      }
      return renderDutyCard();
    }
    if (act === 'save-duty' || act === 'cal-reset') {
      const zoneId = state.dutyZone || '';
      if (act === 'cal-reset' && !confirm('ลบวันทำเขตของเขตนี้ แล้วกลับไปใช้วันเดียวกับทุกเขต?')) return;
      const dates = act === 'cal-reset' ? [] : [...state.duty.set].sort();
      const r = await busy(t, () => api('saveDutyDays', { zoneId, dates }));
      if (!r) return;
      state.data.dutyDays = state.data.dutyDays.filter(d => (d.zoneId || '') !== zoneId).concat(dates.map(date => ({ date, zoneId })));
      state.duty = null; toast(act === 'cal-reset' ? 'กลับไปใช้วันเดียวกับทุกเขตแล้ว' : 'บันทึกวันทำเขตแล้ว (' + dates.length + ' วัน)'); return renderDutyCard();
    }
    if (act === 'new-user') return userForm(null);
    if (act === 'edit-user') return userForm(state.users.find(u => u.username === t.dataset.id));
  });

  function bindPw() {
    const f = $('#pw-form');
    f.addEventListener('submit', async (e) => {
      e.preventDefault();
      const ok = await busy($('button[type=submit]', f), () => api('changePassword', { oldPassword: f.old.value, newPassword: f.nw.value }));
      if (ok) { closeModal(); toast('เปลี่ยนรหัสผ่านแล้ว'); }
    });
  }

  document.addEventListener('change', (e) => {
    if (e.target.id === 'zone') {
      if (!confirmLeave()) { e.target.value = state.zoneId; return; }
      state.zoneId = e.target.value; localSet('cz_zone', state.zoneId); render();
    }
  });
  window.addEventListener('beforeunload', (e) => { if (state.dirty) { e.preventDefault(); e.returnValue = ''; } });

  function checkSvg(s = 18) { return `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>`; }
  function userSvg() { return '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><circle cx="12" cy="8" r="4"/><path d="M4 20c1.5-4 4.5-6 8-6s6.5 2 8 6" stroke-linecap="round"/></svg>'; }

  const h = location.hash.slice(1);
  if (['home', 'check', 'summary', 'days', 'admin'].includes(h)) state.tab = h;
  render();
})();
