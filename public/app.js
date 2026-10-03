(() => {
const $app = document.getElementById('app');
const ls = (k, v) => { try { if (v === undefined) return localStorage.getItem(k); localStorage.setItem(k, v); } catch (e) { return null; } };
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : 'c' + Math.random().toString(36).slice(2) + Date.now());
let clientId = ls('uno_id'); if (!clientId) { clientId = uid(); ls('uno_id', clientId); }
const pref = { sound: ls('uno_sound') !== '0', vib: ls('uno_vib') !== '0' };
const AVC = ['#e3342f', '#f6c21a', '#2e9e4f', '#2169c9', '#8e44ad', '#e67e22', '#16a6a6', '#d6336c'];
const SHAPES = ['M12 2l3 7 7 .6-5.3 4.7 1.7 7L12 17.5 5.6 21.3l1.7-7L2 9.6 9 9z', 'M13 2L4 14h6l-1 8 9-12h-6z', 'M12 21s-8-5.3-8-11a4.5 4.5 0 018-2.7A4.5 4.5 0 0120 10c0 5.7-8 11-8 11z', 'M20 14.5A8.5 8.5 0 019.5 4a8.5 8.5 0 1010.5 10.5z', 'M3 8l4.5 4L12 5l4.5 7L21 8l-2 11H5z', 'M12 2c1 4 5 6 5 11a5 5 0 01-10 0c0-2 1-3.5 2-4.5 0 2 1 3 2 3 0-4-1-6 1-9.5z'];
const MODES = { single: 'รอบเดียวจบ', 500: 'สะสมถึง 500', rank: 'จัดอันดับ' };
const MODE_DESC = { single: 'คนแรกที่ไพ่หมดมือชนะ จบเกม', 500: 'สะสมคะแนนจากไพ่ในมือคนอื่น ใครถึง 500 ก่อนชนะ', rank: 'ใครไพ่หมดก่อนได้ที่ 1, 2, 3... คนที่เหลือเล่นต่อจนเหลือคนแพ้คนเดียว คนที่จบแล้วดูต่อได้' };
const TURN_TOTAL = 15000;
let profile = { name: ls('uno_name') || '', av: { c: Math.floor(Math.random() * 8), s: Math.floor(Math.random() * 6) }, stats: { games: 0, wins: 0, last: 0 } };
try { const sp = JSON.parse(ls('uno_profile') || 'null'); if (sp) profile = Object.assign(profile, sp, { stats: Object.assign(profile.stats, sp.stats || {}) }); } catch (e) {}
const saveProfile = () => { ls('uno_profile', JSON.stringify(profile)); ls('uno_name', profile.name); };
let name = profile.name;
let roomsList = [], pollT = null, showProfile = false, createForm = { title: '', scoring: 'single', isPublic: true, playLimit: 1 };
const PLAY_LIMITS = { 1: 'ลงทีละ 1 ใบ', 2: 'ลงทีละ 2 ใบ', 3: 'ลงทีละ 3 ใบ', 0: 'ลงจนหมดที่ลงได้' };
const PLAY_LIMIT_KEYS = [1, 2, 3, 0];
let S = null;            // server state
let screen = 'home';     // home | create | browse | queue | lobby | game
let queueInfo = { count: 1, left: null };
let err = '';
let lastFx = 0;
let picking = null;      // cardId awaiting colour choice
const socket = io({ auth: { clientId } });

const COLOR_TH = { red: 'แดง', yellow: 'เหลือง', green: 'เขียว', blue: 'น้ำเงิน' };
const HEX = { red: '#e3342f', yellow: '#f6c21a', green: '#2e9e4f', blue: '#2169c9' };
const $ = (s, r = document) => r.querySelector(s);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// ---------- sound & vibration (synthesised, no files) ----------
let ac = null;
function tone(f, d, type = 'sine', t0 = 0, vol = 0.15, f2) {
  if (!pref.sound) return;
  try {
    ac = ac || new (window.AudioContext || window.webkitAudioContext)();
    if (ac.state === 'suspended') ac.resume();
    const o = ac.createOscillator(), g = ac.createGain(), t = ac.currentTime + t0;
    o.type = type; o.frequency.setValueAtTime(f, t);
    if (f2) o.frequency.exponentialRampToValueAtTime(f2, t + d);
    g.gain.setValueAtTime(vol, t); g.gain.exponentialRampToValueAtTime(0.0001, t + d);
    o.connect(g).connect(ac.destination); o.start(t); o.stop(t + d + 0.02);
  } catch (e) {}
}
function noise(d, vol = 0.12) {
  if (!pref.sound) return;
  try {
    ac = ac || new (window.AudioContext || window.webkitAudioContext)();
    const b = ac.createBuffer(1, ac.sampleRate * d, ac.sampleRate), x = b.getChannelData(0);
    for (let i = 0; i < x.length; i++) x[i] = (Math.random() * 2 - 1) * (1 - i / x.length);
    const s = ac.createBufferSource(), g = ac.createGain(), f = ac.createBiquadFilter();
    f.type = 'bandpass'; f.frequency.value = 2400; g.gain.value = vol; s.buffer = b;
    s.connect(f).connect(g).connect(ac.destination); s.start();
  } catch (e) {}
}
const vib = (p) => { if (pref.vib && navigator.vibrate) try { navigator.vibrate(p); } catch (e) {} };
const SFX = {
  click: () => tone(520, 0.05, 'square', 0, 0.05),
  play: () => { tone(300, 0.07, 'triangle', 0, 0.18, 180); noise(0.06, 0.1); vib(15); },
  draw: () => { noise(0.14, 0.14); vib(10); },
  turn: () => { tone(880, 0.12, 'sine', 0, 0.12); tone(1175, 0.16, 'sine', 0.1, 0.12); vib([40]); },
  skip: () => { tone(420, 0.2, 'sawtooth', 0, 0.08, 120); vib([30, 30, 30]); },
  reverse: () => { tone(300, 0.14, 'triangle', 0, 0.12, 700); tone(700, 0.14, 'triangle', 0.14, 0.12, 300); vib(25); },
  hit: () => { tone(220, 0.22, 'sawtooth', 0, 0.12, 90); noise(0.18, 0.12); vib([90, 40, 90]); },
  wild: () => { [523, 659, 784, 1047].forEach((f, i) => tone(f, 0.1, 'triangle', i * 0.06, 0.12)); vib(25); },
  uno: () => { tone(660, 0.1, 'square', 0, 0.1); tone(880, 0.1, 'square', 0.1, 0.1); tone(1320, 0.22, 'square', 0.2, 0.1); vib([30, 30, 30, 30, 60]); },
  catch: () => { tone(160, 0.3, 'sawtooth', 0, 0.14, 80); vib([60, 40, 120]); },
  win: () => { [523, 659, 784, 1047, 1319].forEach((f, i) => tone(f, 0.22, 'triangle', i * 0.11, 0.15)); vib([80, 50, 80, 50, 200]); },
  lose: () => { tone(330, 0.25, 'triangle', 0, 0.12, 200); tone(200, 0.4, 'triangle', 0.22, 0.12, 120); vib(120); },
  err: () => { tone(150, 0.12, 'square', 0, 0.08); vib([20, 40, 20]); },
};

let tt;
function toast(msg) { const t = $('#toast'); t.textContent = msg; t.classList.add('show'); clearTimeout(tt); tt = setTimeout(() => t.classList.remove('show'), 1800); }
const nameOf = (id) => { const p = S && S.players.find((x) => x.id === id); return p ? (p.id === S.me ? 'คุณ' : p.name) : ''; };

// ---------- socket events ----------
socket.on('state', (s) => {
  S = s;
  screen = s.state === 'lobby' ? 'lobby' : 'game';
  recordStats();
  if (s.fx && s.fx.seq !== lastFx) { const first = lastFx === 0; lastFx = s.fx.seq; if (!first) handleFx(s.fx); }
  render();
});
socket.on('queue:status', (q) => { queueInfo = q; if (screen === 'queue') render(); });
socket.on('queue:matched', () => toast('เจอห้องแล้ว!'));
socket.on('connect_error', () => toast('เชื่อมต่อไม่ได้ กำลังลองใหม่...'));

function handleFx(f) {
  const me = S.me, to = (id) => nameOf(id);
  switch (f.type) {
    case 'start': SFX.wild(); toast('เริ่มเกม!'); break;
    case 'play': SFX.play(); break;
    case 'wild': SFX.wild(); break;
    case 'skip': SFX.skip(); toast(f.target === me ? 'คุณถูกข้ามตา!' : to(f.target) + ' ถูกข้ามตา'); if (f.target === me) vib([60, 40, 60]); break;
    case 'reverse': SFX.reverse(); toast('เปลี่ยนทิศทาง'); break;
    case 'draw': SFX.draw(); break;
    case 'draw2': f.target === me ? (SFX.hit(), toast('คุณจั่ว 2 ใบ')) : (SFX.draw(), toast(to(f.target) + ' จั่ว 2 ใบ')); break;
    case 'wild4': SFX.wild(); break;
    case 'draw4': f.target === me ? (SFX.hit(), toast('คุณจั่ว 4 ใบ')) : (SFX.draw(), toast(to(f.target) + ' จั่ว 4 ใบ')); break;
    case 'challengeWin': SFX.hit(); toast(to(f.by) + ' ท้าทายสำเร็จ! ' + to(f.target) + ' จั่ว 4'); break;
    case 'challengeLose': SFX.hit(); toast(to(f.by) + ' ท้าทายพลาด จั่ว 6 ใบ'); break;
    case 'uno': SFX.uno(); toast(to(f.by) + ' ร้อง UNO!'); break;
    case 'catch':
      SFX.catch();
      if (f.auto) {
        // Auto-penalty: forgot to press UNO in time
        toast(f.target === me ? '⏱️ หมดเวลากด UNO! จั่ว 2 ใบ' : to(f.target) + ' ลืมกด UNO! จั่ว 2 ใบ');
        if (f.target === me) vib([80, 50, 80, 50, 120]);
      } else {
        toast(to(f.by) + ' จับ ' + to(f.target) + ' ได้! จั่ว 2');
      }
      break;
    case 'win': f.by === me ? SFX.win() : SFX.lose(); break;
    case 'timeout': SFX.skip(); toast(to(f.by) + ' หมดเวลา ถูกข้ามตา' + (f.auto ? ' (บอทเล่นแทน)' : '')); if (f.by === me) vib([80, 40, 80]); break;
    case 'finish': if (f.over) { SFX.win(); break; } f.by === me ? SFX.win() : SFX.wild(); toast(to(f.by) + ' จบเกม ได้อันดับที่ ' + f.rank); break;
  }
}

let lastTurn = null;
function maybeTurnSound() {
  if (!S || !S.game) return;
  const mine = S.game.turn === S.me && S.state === 'playing';
  const key = mine ? S.game.turn + ':' + S.round + ':' + S.game.deck + ':' + S.hand.length : null;
  if (mine && key !== lastTurn) { lastTurn = key; if (!S.game.pending || S.game.pending.target === S.me) SFX.turn(); }
  if (!mine) lastTurn = null;
}

const emit = (ev, data, cb) => socket.emit(ev, data, (r) => { if (r && r.error) { SFX.err(); toast(r.error); } cb && cb(r); });

// ---------- views ----------
const MODE_KEYS = ['single', '500', 'rank'];
function avatar(av, size = 36) {
  av = av || { c: 0, s: 0 };
  const fill = av.c === 1 ? '#2a2100' : '#fff';
  return `<span class="av" style="width:${size}px;height:${size}px;background:${AVC[av.c]}"><svg viewBox="0 0 24 24" width="${Math.round(size * 0.58)}" height="${Math.round(size * 0.58)}"><path d="${SHAPES[av.s]}" fill="${fill}"/></svg></span>`;
}
function cardEl(c, cls = '') {
  const sym = { skip: 'ข้าม', reverse: '⇄', draw2: '+2', wild: 'สี', wild4: '+4' }[c.type] || c.value;
  const small = c.type === 'skip' ? ' small' : '';
  return `<div class="card ${c.color}${small} ${cls}" data-id="${c.id}"><span class="k tl">${sym}</span><div class="ov"></div><span class="v">${sym}</span><span class="k br">${sym}</span></div>`;
}
const backEl = (cls = '') => `<div class="card back ${cls}"><div class="ov"></div><span class="v">UNO</span></div>`;
function togglesHtml() {
  return `<div class="toggles"><button class="chip ${pref.sound ? 'on' : ''}" data-t="sound">เสียง: ${pref.sound ? 'เปิด' : 'ปิด'}</button><button class="chip ${pref.vib ? 'on' : ''}" data-t="vib">สั่น: ${pref.vib ? 'เปิด' : 'ปิด'}</button></div>`;
}
function bindToggles() {
  document.querySelectorAll('[data-t]').forEach((b) => (b.onclick = () => {
    const k = b.dataset.t; pref[k] = !pref[k]; ls('uno_' + k, pref[k] ? '1' : '0'); SFX.click(); if (k === 'vib') vib(30); render();
  }));
}
const on = (id, fn) => { const e = $(id); if (e) e.onclick = fn; };
function getName() {
  const el = $('#nm'); const v = (el ? el.value : profile.name).trim().slice(0, 14);
  if (!v) { err = 'ใส่ชื่อก่อนนะ'; SFX.err(); render(); return null; }
  profile.name = name = v; saveProfile(); err = ''; return v;
}
function goto(sc) {
  screen = sc; err = '';
  if (sc === 'browse') { fetchRooms(); clearInterval(pollT); pollT = setInterval(fetchRooms, 3000); }
  render();
}
function fetchRooms() { socket.emit('rooms:list', (l) => { roomsList = l || []; if (screen === 'browse') render(); }); }
function joinRoom(code) { const n = getName(); if (!n) return; SFX.click(); emit('room:join', { name: n, av: profile.av, code }, (r) => { if (r && r.error) { err = r.error; if (screen === 'browse') fetchRooms(); else render(); } }); }

function profileSheet() {
  const st = profile.stats, rate = st.games ? Math.round((st.wins / st.games) * 100) : 0;
  return `<div class="ovl"><div class="sheet">
    <h2>โปรไฟล์</h2>
    <div style="display:flex;justify-content:center">${avatar(profile.av, 72)}</div>
    <div class="swatches">${AVC.map((c, i) => `<button class="sw ${profile.av.c === i ? 'on' : ''}" data-ac="${i}" style="background:${c}"></button>`).join('')}</div>
    <div class="swatches">${SHAPES.map((d, i) => `<button class="sw shp ${profile.av.s === i ? 'on' : ''}" data-as="${i}"><svg viewBox="0 0 24 24" width="22" height="22"><path d="${d}" fill="#fff"/></svg></button>`).join('')}</div>
    <input id="pn" class="field" maxlength="14" value="${esc(profile.name)}" placeholder="ชื่อของคุณ">
    <div class="stats"><div><b>${st.games}</b><span>เล่นทั้งหมด</span></div><div><b>${st.wins}</b><span>ชนะ</span></div><div><b>${rate}%</b><span>อัตราชนะ</span></div><div><b>${st.last}</b><span>บ๊วย</span></div></div>
    <p class="sub" style="font-size:12px;margin:0">สถิติเก็บในเครื่องนี้ ส่วน "บ๊วย" นับเฉพาะโหมดจัดอันดับ</p>
    <button class="btn primary" id="psave">บันทึก</button>
    <button class="btn sm" id="preset">รีเซ็ตสถิติ</button>
  </div></div>`;
}
function bindProfile() {
  const keepName = () => { const v = $('#pn').value.trim().slice(0, 14); if (v) profile.name = name = v; };
  document.querySelectorAll('[data-ac]').forEach((b) => (b.onclick = () => { keepName(); profile.av.c = +b.dataset.ac; saveProfile(); SFX.click(); render(); }));
  document.querySelectorAll('[data-as]').forEach((b) => (b.onclick = () => { keepName(); profile.av.s = +b.dataset.as; saveProfile(); SFX.click(); render(); }));
  on('#psave', () => { keepName(); saveProfile(); showProfile = false; render(); });
  on('#preset', () => { profile.stats = { games: 0, wins: 0, last: 0 }; saveProfile(); render(); });
}

function renderHome() {
  const codeIn = (new URLSearchParams(location.search).get('room') || '').toUpperCase();
  $app.innerHTML = `<div class="screen">
    <div class="logo">UNO</div>
    <div class="row prof"><button class="avbtn" id="prof" aria-label="โปรไฟล์">${avatar(profile.av, 50)}</button><input id="nm" class="field" maxlength="14" placeholder="ใส่ชื่อของคุณ" value="${esc(name)}"></div>
    <button class="btn primary" id="create">สร้างห้อง</button>
    <button class="btn yellow" id="browse">ห้องที่เปิดอยู่</button>
    <div class="row"><input id="code" class="field" maxlength="5" placeholder="รหัสห้อง" value="${esc(codeIn)}" style="text-transform:uppercase;text-align:center;letter-spacing:4px"><button class="btn" id="join">เข้าร่วมด้วยรหัส</button></div>
    <div class="row"><button class="btn" id="rand">จับคู่สุ่ม</button><button class="btn" id="bots">เล่นกับบอท</button></div>
    <div class="err">${esc(err)}</div>
    ${togglesHtml()}
  </div>${showProfile ? profileSheet() : ''}`;
  bindToggles();
  if (showProfile) bindProfile();
  on('#prof', () => { const v = $('#nm').value.trim().slice(0, 14); if (v) profile.name = name = v; showProfile = true; SFX.click(); render(); });
  on('#create', () => { if (getName()) { SFX.click(); goto('create'); } });
  on('#browse', () => { if (getName()) { SFX.click(); goto('browse'); } });
  on('#join', () => { const c = $('#code').value.trim(); if (!c) { err = 'ใส่รหัสห้องก่อน'; SFX.err(); return render(); } joinRoom(c); });
  on('#rand', () => { const n = getName(); if (n) { SFX.click(); screen = 'queue'; queueInfo = { count: 1, left: null }; socket.emit('queue:join', { name: n, av: profile.av }); render(); } });
  on('#bots', () => { const n = getName(); if (!n) return; SFX.click(); emit('room:create', { name: n, av: profile.av, scoring: 'single', isPublic: false }, (r) => { if (r && r.ok) for (let i = 0; i < 3; i++) emit('room:addBot', {}); }); });
}

function renderCreate() {
  const f = createForm;
  $app.innerHTML = `<div class="screen">
    <h2 style="margin:0">สร้างห้อง</h2>
    <input id="ct" class="field" maxlength="24" placeholder="ชื่อห้อง (ไม่ใส่ก็ได้)" value="${esc(f.title)}">
    <div class="seg">${MODE_KEYS.map((m) => `<button class="${f.scoring === m ? 'on' : ''}" data-m="${m}">${MODES[m]}</button>`).join('')}</div>
    <p class="sub" style="min-height:66px">${MODE_DESC[f.scoring]}</p>
    <p class="sub" style="margin:4px 0 2px;font-size:13px;font-weight:600">จำนวนใบที่ลงได้ต่อตา</p>
    <div class="seg">${PLAY_LIMIT_KEYS.map((k) => `<button class="${f.playLimit === k ? 'on' : ''}" data-pl="${k}">${PLAY_LIMITS[k]}</button>`).join('')}</div>
    <button class="chip ${f.isPublic ? 'on' : ''}" id="pub" style="width:100%;padding:10px">${f.isPublic ? 'ห้องสาธารณะ: คนอื่นเห็นในรายการ' : 'ห้องส่วนตัว: เข้าด้วยรหัสหรือลิงก์เท่านั้น'}</button>
    <div class="err">${esc(err)}</div>
    <button class="btn primary" id="go">สร้างห้อง</button>
    <button class="btn sm" id="back">กลับ</button>
  </div>`;
  $('#ct').oninput = (e) => (f.title = e.target.value);
  document.querySelectorAll('[data-m]').forEach((b) => (b.onclick = () => { f.scoring = b.dataset.m; SFX.click(); render(); }));
  document.querySelectorAll('[data-pl]').forEach((b) => (b.onclick = () => { f.playLimit = Number(b.dataset.pl); SFX.click(); render(); }));
  on('#pub', () => { f.isPublic = !f.isPublic; SFX.click(); render(); });
  on('#go', () => { SFX.click(); emit('room:create', { name, av: profile.av, scoring: f.scoring, isPublic: f.isPublic, title: f.title.trim(), playLimit: f.playLimit }); });
  on('#back', () => goto('home'));
}

function renderBrowse() {
  $app.innerHTML = `<div class="screen" style="justify-content:flex-start;padding-top:28px">
    <h2 style="margin:0">ห้องที่เปิดอยู่</h2>
    <div class="plist">${roomsList.length ? roomsList.map((r) => `<div class="pl"><div class="nm"><b>${esc(r.title)}</b><div class="meta">โฮสต์ ${esc(r.host || '')} · ${MODES[r.scoring]} · ${r.count}/10 คน</div></div><button class="btn sm primary" data-j="${r.code}">เข้าร่วม</button></div>`).join('') : '<p class="sub">ยังไม่มีห้องที่เปิดอยู่<br>สร้างห้องแรกได้เลย</p>'}</div>
    <div class="err">${esc(err)}</div>
    <div class="row"><button class="btn" id="rf">รีเฟรช</button><button class="btn yellow" id="mk">สร้างห้อง</button></div>
    <button class="btn sm" id="back">กลับ</button>
  </div>`;
  document.querySelectorAll('[data-j]').forEach((b) => (b.onclick = () => joinRoom(b.dataset.j)));
  on('#rf', () => { SFX.click(); fetchRooms(); });
  on('#mk', () => goto('create'));
  on('#back', () => goto('home'));
}

function renderQueue() {
  $app.innerHTML = `<div class="screen">
    <div class="logo">UNO</div>
    <h2>กำลังหาผู้เล่น...</h2>
    <p class="sub">ในคิว ${queueInfo.count} คน<br>${queueInfo.left != null ? 'เริ่มใน ' + queueInfo.left + ' วินาที' : 'รออีกอย่างน้อย 1 คน'}</p>
    <button class="btn" id="cancel">ยกเลิก</button>
  </div>`;
  on('#cancel', () => { socket.emit('queue:leave'); goto('home'); });
}

function renderLobby() {
  const host = S.hostId === S.me, link = location.origin + '/?room=' + S.code;
  const pl = S.playLimit != null ? S.playLimit : 1;
  $app.innerHTML = `<div class="screen">
    <h2 style="margin:0">${esc(S.title || 'ห้องเกม')}</h2>
    <div class="codebox">${S.code}</div>
    <button class="btn sm" id="cp">คัดลอกลิงก์เชิญ</button>
    <div class="plist">${S.players.map((p) => `<div class="pl">${avatar(p.av, 36)}<div class="nm">${esc(p.name)}${p.id === S.me ? ' (คุณ)' : ''}</div>${p.id === S.hostId ? '<span class="tag">โฮสต์</span>' : ''}${p.bot ? (host ? `<button class="btn sm" data-rm="${p.id}">เอาออก</button>` : '<span class="tag">บอท</span>') : ''}${!p.connected ? '<span class="tag">หลุด</span>' : ''}</div>`).join('')}</div>
    <p class="sub" style="margin:0">${S.players.length}/10 คน · ${MODES[S.scoring]} · ${PLAY_LIMITS[pl]}${S.isPublic ? ' · สาธารณะ' : ' · ส่วนตัว'}</p>
    ${host ? `<p class="sub" style="font-size:13px;margin:0">${MODE_DESC[S.scoring]}</p>
    <div class="row"><button class="btn" id="addbot" ${S.players.length >= 10 ? 'disabled' : ''}>เพิ่มบอท</button><button class="btn" id="mode">โหมด: ${MODES[S.scoring]}</button></div>
    <button class="btn" id="plimit">การ์ดต่อตา: ${PLAY_LIMITS[pl]}</button>
    <button class="btn" id="pubt">${S.isPublic ? 'เปลี่ยนเป็นห้องส่วนตัว' : 'เปลี่ยนเป็นห้องสาธารณะ'}</button>
    <button class="btn primary" id="start">เริ่มเกม</button>` : '<p class="sub">รอโฮสต์เริ่มเกม...</p>'}
    <button class="btn sm" id="leave">ออกจากห้อง</button>
    ${togglesHtml()}
  </div>`;
  bindToggles();
  on('#cp', () => { navigator.clipboard && navigator.clipboard.writeText(link).then(() => toast('คัดลอกแล้ว'), () => toast(link)); });
  document.querySelectorAll('[data-rm]').forEach((b) => (b.onclick = () => emit('room:removeBot', { botId: b.dataset.rm })));
  if (host) {
    on('#addbot', () => { SFX.click(); emit('room:addBot', {}); });
    on('#mode', () => { SFX.click(); emit('room:scoring', { mode: MODE_KEYS[(MODE_KEYS.indexOf(S.scoring) + 1) % 3] }); });
    on('#plimit', () => {
      SFX.click();
      const cur = S.playLimit != null ? S.playLimit : 1;
      const nextLimit = PLAY_LIMIT_KEYS[(PLAY_LIMIT_KEYS.indexOf(cur) + 1) % PLAY_LIMIT_KEYS.length];
      emit('room:playLimit', { limit: nextLimit });
    });
    on('#pubt', () => { SFX.click(); emit('room:public', {}); });
    on('#start', () => { SFX.click(); emit('room:start', {}); });
  }
  on('#leave', leaveRoom);
}
function leaveRoom() { socket.emit('room:leave'); S = null; lastFx = 0; history.replaceState(null, '', '/'); goto('home'); }

function recordStats() {
  if (!S || S.state !== 'gameEnd' || !S.result) return;
  const key = S.code + ':' + S.gameNo;
  if (ls('uno_rec') === key) return;
  ls('uno_rec', key);
  const st = profile.stats, meP = S.players.find((p) => p.id === S.me);
  st.games++;
  if (S.result.mode === 'rank') { if (meP.rank === 1) st.wins++; if (meP.rank === S.players.length) st.last++; }
  else if (S.result.winner === S.me) st.wins++;
  saveProfile();
}

function renderGame() {
  const g = S.game, me = S.me, n = S.players.length;
  const mi = S.players.findIndex((p) => p.id === me), meP = S.players[mi];
  const playing = S.state === 'playing', finished = playing && !!meP.rank;
  const myTurn = playing && g.turn === me;
  const turnP = S.players.find((p) => p.id === g.turn) || meP;
  const playable = new Set(g.playable || []);
  const challengeMe = g.pending && g.pending.target === me;
  let bn, cls = '';
  if (playing && meP.auto) bn = 'บอทกำลังเล่นแทนคุณ';
  else if (finished) { bn = `คุณได้อันดับที่ ${meP.rank} · กำลังดูเกม`; cls = 'fin'; }
  else if (g.pending) { bn = challengeMe ? 'คุณถูกเล่น +4 ท้าทายหรือยอมรับ?' : `${nameOf(g.pending.target)} กำลังตัดสินใจ`; if (challengeMe) cls = 'me'; }
  else if (myTurn) {
    const pl = S.playLimit != null ? S.playLimit : 1;
    const played = g.playsThisTurn || 0;
    if (g.drawn) bn = 'เล่นไพ่ที่จั่ว หรือกดผ่าน';
    else if (played > 0 && pl > 0) bn = `ตาคุณ! ลงแล้ว ${played}/${pl} ใบ`;
    else if (played > 0 && pl === 0) bn = `ตาคุณ! ลงแล้ว ${played} ใบ · ลงต่อหรือจั่ว`;
    else bn = 'ตาคุณ! เลือกไพ่หรือจั่ว';
    cls = 'me';
  }
  else bn = `ตาของ ${turnP.name}`;
  const small = n > 6;
  const seats = [];
  for (let k = 1; k < n; k++) {
    const p = S.players[(mi + k) % n], th = ((90 + (k * 360) / n) * Math.PI) / 180;
    // ขยับจุดศูนย์กลางขึ้น (Y=43) และทำวงรีให้แบนลงในแนวตั้ง (ry=32)
    // เพื่อเว้นที่ว่างด้านล่างให้ปุ่มในมือถือ (แนวตั้ง)
    const x = 50 + 40 * Math.cos(th), y = 43 + 32 * Math.sin(th), turn = playing && g.turn === p.id;
    seats.push(`<div class="seat ${turn ? 'turn' : ''} ${p.connected ? '' : 'off'} ${p.rank ? 'done' : ''}" style="left:${x}%;top:${y}%">
      <div class="aw ${turn ? 't' : ''}">${avatar(p.av, small ? 34 : 42)}${p.rank ? `<i class="rk">${p.rank}</i>` : ''}${p.uno && p.cards === 1 ? '<i class="un">UNO</i>' : ''}</div>
      <div class="sn">${esc(p.name)}</div>
      <div class="sc">${p.rank ? 'จบแล้ว' : p.cards + ' ใบ'}${S.scoring === '500' ? ' · ' + p.score : ''}</div></div>`);
  }
  const showUno = playing && !finished && ((S.hand.length === 2 && myTurn && !meP.uno) || g.vuln === me);
  const showCatch = playing && !finished && g.vuln && g.vuln !== me;
  const hs = $('.hand'), sl = hs ? hs.scrollLeft : 0;
  $app.innerHTML = `<div class="game">
    <div class="banner ${cls}"><div class="bt">${!myTurn && !finished && !g.pending ? avatar(turnP.av, 30) : ''}<span class="bx">${esc(bn)}</span><b id="tsec"></b></div><div class="bar"><i id="tbar"></i></div></div>
    <div class="table">
      ${seats.join('')}
      <div class="mid">
        <div class="pcol">${backEl()}<div class="pile-count">กองจั่ว ${g.deck}</div></div>
        <div id="disc">${cardEl(g.top, 'pop')}</div>
        <div class="pcol"><div class="ring" style="background:${HEX[g.color]}"></div><div class="dir">${COLOR_TH[g.color]}<br><span class="arrow">${g.dir === 1 ? '↻' : '↺'}</span></div></div>
      </div>
    </div>
    <div class="actions">
      ${playing && meP.auto ? '<button class="btn yellow sm" id="back">กลับมาเล่น</button>' : ''}
      ${myTurn && !g.pending && !g.drawn ? '<button class="btn yellow sm" id="draw">จั่วไพ่</button>' : ''}
      ${myTurn && g.drawn ? '<button class="btn sm" id="pass">ผ่าน</button>' : ''}
      ${myTurn && !g.pending && !g.drawn && (g.playsThisTurn || 0) > 0 ? '<button class="btn sm" id="endturn">จบตา</button>' : ''}
      ${(() => {
        if (!showUno) return '';
        const dl = g.vulnDeadline || 0;
        const left = dl > 0 ? Math.max(0, Math.ceil((dl - Date.now()) / 1000)) : 5;
        const urgent = left <= 2;
        return `<button class="btn primary sm uno-btn${urgent ? ' uno-urgent' : ''}" id="uno">UNO! <span class="uno-cd" id="unocd">${dl > 0 ? left + 'วิ' : ''}</span></button>`;
      })()}
      ${showCatch ? '<button class="btn primary sm" id="catch">จับ! ลืมร้อง UNO</button>' : ''}
    </div>
    <div class="mebar ${myTurn ? 'turn' : ''}"><div class="aw ${myTurn ? 't' : ''}">${avatar(meP.av, 38)}</div><div class="mn">${esc(meP.name)}</div><div class="sc">${meP.rank ? 'อันดับ ' + meP.rank : S.hand.length + ' ใบ'}${S.scoring === '500' ? ' · ' + meP.score + ' คะแนน' : ''}</div></div>
    <div class="hand">${S.hand.map((c) => cardEl(c, myTurn && !g.pending ? (playable.has(c.id) ? 'ok' : 'no') : '')).join('')}</div>
  </div>
  ${challengeMe ? `<div class="ovl"><div class="sheet"><h2>${esc(nameOf(g.pending.from))} เล่น +4</h2><p class="sub">ถ้าเขามีไพ่สีเดิมที่เล่นได้อยู่ในมือ เขาจะต้องจั่ว 4 แทน แต่ถ้าพลาด คุณจั่ว 6</p><button class="btn primary" id="ch">ท้าทาย</button><button class="btn" id="ac">ยอมรับ (จั่ว 4)</button></div></div>` : ''}
  ${picking ? `<div class="ovl"><div class="sheet"><h2>เลือกสี</h2><div class="colors">${Object.keys(HEX).map((c) => `<button data-c="${c}" style="background:${HEX[c]}"></button>`).join('')}</div><button class="btn sm" id="cx">ยกเลิก</button></div></div>` : ''}
  ${S.state === 'roundEnd' || S.state === 'gameEnd' ? resultHtml() : ''}`;
  const nh = $('.hand'); if (nh) nh.scrollLeft = sl;
  document.querySelectorAll('.hand .card').forEach((el) => (el.onclick = () => {
    const id = +el.dataset.id, c = S.hand.find((x) => x.id === id);
    if (!myTurn || !playable.has(id)) { SFX.err(); return; }
    if (c.color === 'wild') { picking = id; render(); } else emit('game:play', { cardId: id });
  }));
  on('#draw', () => emit('game:draw'));
  on('#pass', () => emit('game:pass'));
  on('#uno', () => emit('game:uno'));
  on('#catch', () => emit('game:catch'));
  on('#back', () => emit('game:back'));
  on('#endturn', () => emit('game:endTurn'));
  on('#ch', () => emit('game:challenge', { challenge: true }));
  on('#ac', () => emit('game:challenge', { challenge: false }));
  on('#cx', () => { picking = null; render(); });
  document.querySelectorAll('[data-c]').forEach((b) => (b.onclick = () => { const id = picking; picking = null; emit('game:play', { cardId: id, color: b.dataset.c }); }));
  on('#again', () => emit('room:rematch'));
  on('#exit', leaveRoom);
  maybeTurnSound();
}

function resultHtml() {
  const r = S.result, host = S.hostId === S.me;
  let title, sub = '', rows = '';
  if (r.mode === 'rank') {
    const w = S.players.find((p) => p.id === r.winner), l = S.players.find((p) => p.id === r.loser);
    title = r.winner === S.me ? 'คุณได้ที่ 1!' : (r.loser === S.me ? 'คุณแพ้ (บ๊วย)' : 'จบเกม');
    sub = `ที่ 1: ${w ? esc(w.name) : '-'} · แพ้: ${l ? esc(l.name) : '-'}`;
    rows = r.ranking.map((id, i) => { const p = S.players.find((x) => x.id === id); if (!p) return ''; return `<div class="score ${i === 0 ? 'w' : ''} ${id === r.loser ? 'lose' : ''}"><span class="rkn">${i + 1}</span>${avatar(p.av, 28)}<b class="rname">${esc(p.name)}${id === S.me ? ' (คุณ)' : ''}</b>${id === r.loser ? '<em>แพ้</em>' : ''}</div>`; }).join('');
  } else {
    const w = S.players.find((p) => p.id === r.winner);
    title = r.winner === S.me ? 'คุณชนะ!' : (w ? esc(w.name) : '') + ' ชนะ';
    sub = r.gameOver ? 'จบเกม' : 'รอบนี้ได้ ' + r.points + ' คะแนน · รอบถัดไปเริ่มเร็วๆ นี้';
    if (S.scoring === '500' || r.gameOver) rows = [...S.players].sort((a, b) => b.score - a.score).map((p) => `<div class="score ${p.id === r.winner ? 'w' : ''}">${avatar(p.av, 28)}<b class="rname">${esc(p.name)}${p.id === S.me ? ' (คุณ)' : ''}</b><b>${p.score}</b></div>`).join('');
  }
  return `<div class="ovl"><div class="sheet"><h2>${title}</h2><p class="sub" style="margin:0">${sub}</p>${rows}
    ${r.gameOver ? (host ? '<button class="btn primary" id="again">เล่นอีกครั้ง</button>' : '<p class="sub">รอโฮสต์เริ่มใหม่...</p>') + '<button class="btn" id="exit">ออกจากห้อง</button>' : ''}</div></div>`;
}

function render() {
  if (!S && !['queue', 'create', 'browse'].includes(screen)) screen = 'home';
  if (screen !== 'browse' && pollT) { clearInterval(pollT); pollT = null; }
  if (screen === 'home') renderHome();
  else if (screen === 'create') renderCreate();
  else if (screen === 'browse') renderBrowse();
  else if (screen === 'queue') renderQueue();
  else if (screen === 'lobby') renderLobby();
  else renderGame();
}

// turn timer + UNO countdown: update DOM every 150ms without full re-render
setInterval(() => {
  if (!S || !S.game) return;
  const dl = S.game.deadline, left = dl - Date.now();
  const live = S.state === 'playing' && dl > 0 && left > 0;
  const pct = live ? Math.max(0, Math.min(100, (left / TURN_TOTAL) * 100)) : 0;
  const bar = $('#tbar'); if (bar) bar.style.width = pct + '%';
  const sec = $('#tsec'); if (sec) sec.textContent = live ? Math.ceil(left / 1000) + ' วิ' : '';
  document.querySelectorAll('.aw.t').forEach((el) => el.style.setProperty('--p', pct * 3.6 + 'deg'));

  // UNO countdown
  const vdl = S.game.vulnDeadline || 0;
  if (vdl > 0) {
    const vleft = vdl - Date.now();
    const vsec = Math.max(0, Math.ceil(vleft / 1000));
    const cd = $('#unocd'); if (cd) cd.textContent = vsec + 'วิ';
    const unoBtn = $('.uno-btn');
    if (unoBtn) {
      if (vsec <= 2) unoBtn.classList.add('uno-urgent');
      else unoBtn.classList.remove('uno-urgent');
    }
  }
}, 150);

render();
const q = new URLSearchParams(location.search).get('room');
if (q && name) { const go = () => emit('room:join', { name, av: profile.av, code: q }); socket.connected ? go() : socket.once('connect', go); }
})();
