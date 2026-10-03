const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);
app.use(express.static(path.join(__dirname, 'public')));
app.get('/healthz', (_, res) => res.send('ok'));

const COLORS = ['red', 'yellow', 'green', 'blue'];
const TURN_MS = 15000;
const QUEUE_WAIT_MS = 8000;
const UNO_WINDOW_MS = 5000; // 5 seconds to press UNO before auto-penalty
const rooms = new Map(); // code -> room
const sockets = new Map(); // clientId -> socket
const where = new Map(); // clientId -> room code
let queue = []; // [{id,name}]
let queueSince = null;
let cardSeq = 1;

const rnd = (n) => Math.floor(Math.random() * n);
const av = (a) => ({ c: Math.abs(((a && a.c) | 0)) % 8, s: Math.abs(((a && a.s) | 0)) % 6 });
const shuffle = (a) => { for (let i = a.length - 1; i > 0; i--) { const j = rnd(i + 1); [a[i], a[j]] = [a[j], a[i]]; } return a; };
const BOT_NAMES = ['น้องบอท', 'บอทใจดี', 'เจ้าหมีบอท', 'บอทสายฟ้า', 'พี่บอท', 'บอทเงียบ', 'บอทจอมโกง', 'ลุงบอท', 'บอทขี้เล่น', 'บอทน้อย'];

function buildDeck(decks) {
  const d = [];
  for (let k = 0; k < decks; k++) {
    for (const c of COLORS) {
      d.push({ id: cardSeq++, color: c, type: 'number', value: 0 });
      for (let v = 1; v <= 9; v++) for (let t = 0; t < 2; t++) d.push({ id: cardSeq++, color: c, type: 'number', value: v });
      for (const type of ['skip', 'reverse', 'draw2']) for (let t = 0; t < 2; t++) d.push({ id: cardSeq++, color: c, type: type });
    }
    for (let t = 0; t < 4; t++) { d.push({ id: cardSeq++, color: 'wild', type: 'wild' }); d.push({ id: cardSeq++, color: 'wild', type: 'wild4' }); }
  }
  return shuffle(d);
}
const points = (c) => (c.type === 'number' ? c.value : ['skip', 'reverse', 'draw2'].includes(c.type) ? 20 : 50);

function makeCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  for (;;) { let c = ''; for (let i = 0; i < 5; i++) c += chars[rnd(chars.length)]; if (!rooms.has(c)) return c; }
}
function newRoom(hostId, hostName, scoring = 'single', avatar, isPublic = true, title, playLimit = 1) {
  const code = makeCode();
  const room = { code, hostId, state: 'lobby', scoring, playLimit, isPublic, gameNo: 0, title: String(title || '').trim().slice(0, 24) || ('ห้องของ ' + (hostName || 'ผู้เล่น').slice(0, 14)), players: [], game: null, round: 0, timer: null, catchTimer: null, unoTimer: null, nextTimer: null, fx: null, fxSeq: 0, result: null, cleanup: null };
  rooms.set(code, room);
  addHuman(room, hostId, hostName, avatar);
  return room;
}
function addHuman(room, id, name, avatar) {
  room.players.push({ id, name: (name || 'ผู้เล่น').slice(0, 14), av: av(avatar), bot: false, connected: true, hand: [], score: 0, uno: false, dc: null, rank: null, skips: 0, auto: false });
  where.set(id, room.code);
}
function addBot(room) {
  const used = new Set(room.players.map((p) => p.name));
  const name = BOT_NAMES.find((n) => !used.has(n)) || 'บอท' + rnd(99);
  room.players.push({ id: 'bot_' + cardSeq++, name, av: { c: rnd(8), s: rnd(6) }, bot: true, connected: true, hand: [], score: 0, uno: false, dc: null, rank: null, skips: 0, auto: false });
}
const pIdx = (room, id) => room.players.findIndex((p) => p.id === id);

// ---------- rules ----------
const top = (g) => g.discard[g.discard.length - 1];
function canPlay(card, g, hand) {
  if (card.type === 'wild') return true;
  if (card.type === 'wild4') return !hand.some((c) => c.color === g.color); // original rule: only if no card of current color
  if (card.color === g.color) return true;
  const t = top(g);
  return t.color !== 'wild' && t.type === card.type && (card.type !== 'number' || t.value === card.value);
}
const step = (g, n, from, k = 1) => { let i = from; for (let j = 0; j < k; j++) { do { i = (i + g.dir + n) % n; } while (g.done.has(i)); } return i; };
function drawCards(g, p, k) {
  for (let i = 0; i < k; i++) {
    if (!g.deck.length) {
      const keep = g.discard.pop();
      g.deck = shuffle(g.discard);
      g.discard = [keep];
      if (!g.deck.length) return;
    }
    p.hand.push(g.deck.pop());
  }
  p.uno = false;
}

function startRound(room) {
  clearTimeout(room.nextTimer);
  const n = room.players.length;
  const g = { deck: buildDeck(n > 6 ? 2 : 1), discard: [], dir: 1, turn: 0, color: 'red', pending: null, drawn: null, vuln: null, vulnSeq: 0, vulnDeadline: 0, deadline: 0, done: new Set(), playsThisTurn: 0 };
  room.players.forEach((p) => { p.hand = []; p.uno = false; p.rank = null; p.skips = 0; p.auto = false; });
  room.players.forEach((p) => drawCards(g, p, 7));
  let first;
  do { first = g.deck.pop(); if (first.type === 'wild4') { g.deck.unshift(first); first = null; } } while (!first);
  g.discard.push(first);
  g.color = first.color === 'wild' ? COLORS[rnd(4)] : first.color;
  const starter = room.round % n;
  g.turn = starter;
  if (first.type === 'skip') g.turn = step(g, n, starter);
  else if (first.type === 'reverse') { g.dir = -1; g.turn = n === 2 ? step(g, n, starter) : step(g, n, starter); }
  else if (first.type === 'draw2') { drawCards(g, room.players[starter], 2); g.turn = step(g, n, starter); }
  room.game = g;
  room.state = 'playing';
  room.result = null;
  room.round++;
  fx(room, 'start', {});
  tick(room);
}

function fx(room, type, data) { room.fx = { seq: ++room.fxSeq, type, ...data }; }

function afterTurnChange(room) { tick(room); }

function play(room, idx, cardId, color) {
  const g = room.game, p = room.players[idx], n = room.players.length;
  if (room.state !== 'playing' || g.turn !== idx || g.pending) return 'ไม่ใช่ตาของคุณ';
  const ci = p.hand.findIndex((c) => c.id === cardId);
  if (ci < 0) return 'ไม่พบไพ่ใบนี้';
  const card = p.hand[ci];
  if (g.drawn && g.drawn !== cardId) return 'เล่นได้เฉพาะไพ่ที่เพิ่งจั่ว';
  if (!canPlay(card, g, p.hand.filter((c) => c.id !== cardId))) return 'เล่นไพ่ใบนี้ไม่ได้';
  if (card.color === 'wild' && !COLORS.includes(color)) return 'ต้องเลือกสี';
  const prevColor = g.color;
  p.hand.splice(ci, 1);
  g.discard.push(card);
  g.color = card.color === 'wild' ? color : card.color;
  g.drawn = null;
  g.vuln = null;
  clearTimeout(room.catchTimer);
  if (p.hand.length > 1) p.uno = false;
  let finishing = false;
  if (p.hand.length === 0) {
    if (room.scoring !== 'rank') {
      const nx = step(g, n, idx);
      if (card.type === 'draw2') drawCards(g, room.players[nx], 2);
      if (card.type === 'wild4') drawCards(g, room.players[nx], 4);
      fx(room, 'play', { by: p.id, card: card.type });
      return endRound(room, idx);
    }
    finishing = true;
    p.rank = room.players.filter((x) => x.rank).length + 1;
    g.done.add(idx);
    if (n - g.done.size <= 1) { fx(room, 'finish', { by: p.id, rank: p.rank }); return endRankGame(room); }
  } else if (p.hand.length === 1 && !p.uno) {
    g.vuln = p.id; g.vulnSeq++;
    g.vulnDeadline = Date.now() + UNO_WINDOW_MS;
    scheduleBotCatch(room, g.vulnSeq);
    scheduleAutoUno(room, p.id, g.vulnSeq);
  }
  const next = step(g, n, idx);
  const active = n - g.done.size;

  // Action cards always advance the turn (skip, reverse, draw2, wild4, wild)
  const isActionCard = ['skip', 'reverse', 'draw2', 'wild', 'wild4'].includes(card.type);

  if (card.type === 'skip') { g.turn = step(g, n, idx, 2); g.playsThisTurn = 0; fx(room, 'skip', { by: p.id, target: room.players[next].id }); }
  else if (card.type === 'reverse') {
    g.dir *= -1;
    g.turn = (active === 2 && !finishing) ? idx : step(g, n, idx);
    g.playsThisTurn = 0;
    fx(room, 'reverse', { by: p.id });
  } else if (card.type === 'draw2') {
    drawCards(g, room.players[next], 2);
    g.turn = step(g, n, idx, 2);
    g.playsThisTurn = 0;
    fx(room, 'draw2', { by: p.id, target: room.players[next].id, n: 2 });
  } else if (card.type === 'wild4') {
    if (finishing) {
      drawCards(g, room.players[next], 4); g.turn = step(g, n, idx, 2);
      g.playsThisTurn = 0;
      fx(room, 'draw4', { by: p.id, target: room.players[next].id, n: 4 });
    } else {
      g.pending = { from: idx, target: next, prevColor };
      g.turn = next;
      g.playsThisTurn = 0;
      fx(room, 'wild4', { by: p.id, target: room.players[next].id });
    }
  } else if (card.type === 'wild') {
    g.turn = next;
    g.playsThisTurn = 0;
    fx(room, 'wild', { by: p.id, card: card.type });
  } else {
    // Normal number card — check multi-play limit
    g.playsThisTurn = (g.playsThisTurn || 0) + 1;
    const limit = room.playLimit || 1; // 0 = unlimited
    const hasMore = p.hand.some((c) => canPlay(c, g, p.hand.filter((x) => x.id !== c.id)));
    const limitReached = limit > 0 && g.playsThisTurn >= limit;
    if (!finishing && !limitReached && hasMore) {
      // Stay on this player's turn
      g.turn = idx;
    } else {
      g.turn = next;
      g.playsThisTurn = 0;
    }
    fx(room, 'play', { by: p.id, card: card.type });
  }
  if (finishing) fx(room, 'finish', { by: p.id, rank: p.rank });
  tick(room);
  return null;
}


function draw(room, idx) {
  const g = room.game, p = room.players[idx];
  if (room.state !== 'playing' || g.turn !== idx || g.pending) return 'ไม่ใช่ตาของคุณ';
  if (g.drawn) return 'จั่วไปแล้ว';
  g.vuln = null; clearTimeout(room.catchTimer);
  g.playsThisTurn = 0; // drawing resets multi-play count
  drawCards(g, p, 1);
  const c = p.hand[p.hand.length - 1];
  fx(room, 'draw', { by: p.id, n: 1 });
  if (c && canPlay(c, g, p.hand.filter((x) => x.id !== c.id))) g.drawn = c.id;
  else g.turn = step(g, room.players.length, idx);
  tick(room);
  return null;
}
function pass(room, idx) {
  const g = room.game;
  if (g.turn !== idx || !g.drawn) return 'ผ่านตาไม่ได้';
  g.drawn = null;
  g.playsThisTurn = 0;
  g.turn = step(g, room.players.length, idx);
  tick(room);
  return null;
}
function respondWild4(room, idx, challenge) {
  const g = room.game, n = room.players.length, pd = g.pending;
  if (!pd || pd.target !== idx) return 'ไม่มีอะไรให้ตอบ';
  const from = room.players[pd.from], me = room.players[idx];
  g.pending = null;
  if (challenge) {
    const guilty = from.hand.some((c) => c.color === pd.prevColor);
    if (guilty) { drawCards(g, from, 4); fx(room, 'challengeWin', { by: me.id, target: from.id, n: 4 }); }
    else { drawCards(g, me, 6); g.turn = step(g, n, idx); fx(room, 'challengeLose', { by: me.id, target: from.id, n: 6 }); }
  } else {
    drawCards(g, me, 4); g.turn = step(g, n, idx);
    fx(room, 'draw4', { by: from.id, target: me.id, n: 4 });
  }
  tick(room);
  return null;
}
function callUno(room, idx) {
  const g = room.game, p = room.players[idx];
  if (p.hand.length > 2 || (p.hand.length === 2 && g.turn !== idx)) return 'ยังเรียก UNO ไม่ได้';
  p.uno = true;
  if (g.vuln === p.id) {
    g.vuln = null;
    g.vulnDeadline = 0;
    clearTimeout(room.unoTimer);
    clearTimeout(room.catchTimer);
  }
  fx(room, 'uno', { by: p.id });
  tick(room, true);
  return null;
}
function catchUno(room, idx) {
  const g = room.game;
  if (!g.vuln || room.players[idx].id === g.vuln) return 'ไม่มีใครให้จับ';
  const t = room.players[pIdx(room, g.vuln)];
  drawCards(g, t, 2);
  g.vuln = null;
  g.vulnDeadline = 0;
  clearTimeout(room.unoTimer);
  fx(room, 'catch', { by: room.players[idx].id, target: t.id, n: 2 });
  tick(room, true);
  return null;
}
function scheduleBotCatch(room, seq) {
  clearTimeout(room.catchTimer);
  const bots = room.players.filter((p) => p.bot);
  if (!bots.length) return;
  room.catchTimer = setTimeout(() => {
    const g = room.game;
    if (!g || g.vulnSeq !== seq || !g.vuln) return;
    const b = bots[rnd(bots.length)];
    if (b.id !== g.vuln && Math.random() < 0.6) catchUno(room, pIdx(room, b.id));
  }, 1800 + rnd(1500));
}
function scheduleAutoUno(room, vulnId, seq) {
  clearTimeout(room.unoTimer);
  room.unoTimer = setTimeout(() => {
    const g = room.game;
    if (!g || g.vuln !== vulnId || g.vulnSeq !== seq) return;
    // Auto-penalise: player forgot to press UNO
    const t = room.players.find((p) => p.id === vulnId);
    if (!t) return;
    drawCards(g, t, 2);
    g.vuln = null;
    g.vulnDeadline = 0;
    clearTimeout(room.catchTimer);
    fx(room, 'catch', { by: null, target: t.id, n: 2, auto: true });
    tick(room, true);
  }, UNO_WINDOW_MS);
}

function endRound(room, winIdx) {
  const w = room.players[winIdx];
  const pts = room.players.reduce((s, p) => s + p.hand.reduce((a, c) => a + points(c), 0), 0);
  w.score += pts;
  const gameOver = room.scoring === 'single' || w.score >= 500;
  room.state = gameOver ? 'gameEnd' : 'roundEnd';
  room.result = { mode: room.scoring, winner: w.id, points: pts, gameOver };
  fx(room, 'win', { by: w.id });
  clearTimeout(room.timer);
  broadcast(room);
  if (!gameOver) room.nextTimer = setTimeout(() => room.state === 'roundEnd' && startRound(room), 10000);
  return null;
}

function endRankGame(room) {
  const loser = room.players.find((p) => !p.rank);
  if (loser) loser.rank = room.players.filter((x) => x.rank).length + 1;
  const order = [...room.players].sort((a, b) => a.rank - b.rank);
  room.state = 'gameEnd';
  room.result = { mode: 'rank', gameOver: true, winner: order[0].id, loser: order[order.length - 1].id, ranking: order.map((p) => p.id), points: 0 };
  clearTimeout(room.timer); clearTimeout(room.catchTimer);
  fx(room, 'finish', { by: order[order.length - 1].id, rank: order.length, over: true });
  broadcast(room);
  return null;
}
function timeoutSkip(room, idx) {
  const g = room.game; if (!g || room.state !== 'playing' || g.turn !== idx) return;
  const p = room.players[idx];
  p.skips = (p.skips || 0) + 1;
  if (p.skips >= 2) p.auto = true;
  g.vuln = null;
  if (g.pending) { respondWild4(room, idx, false); }
  else if (g.drawn) { pass(room, idx); }
  else { g.turn = step(g, room.players.length, idx); tick(room, false, true); }
  fx(room, 'timeout', { by: p.id, auto: p.auto });
  broadcast(room);
}

// ---------- bots / timers ----------
function chooseColor(hand) {
  const cnt = {}; hand.forEach((c) => { if (c.color !== 'wild') cnt[c.color] = (cnt[c.color] || 0) + 1; });
  const best = Object.keys(cnt).sort((a, b) => cnt[b] - cnt[a])[0];
  return best || COLORS[rnd(4)];
}
function botAct(room, idx) {
  const g = room.game; if (!g || room.state !== 'playing' || g.turn !== idx) return;
  const p = room.players[idx];
  if (g.pending) return void respondWild4(room, idx, p.bot ? Math.random() < 0.3 : false);
  const rest = (c) => p.hand.filter((x) => x.id !== c.id);
  if (g.drawn) { const c = p.hand.find((x) => x.id === g.drawn); return void finishPlay(room, idx, c); }
  const options = p.hand.filter((c) => canPlay(c, g, rest(c)));
  if (!options.length) return void draw(room, idx);
  const pressure = room.players.some((o, i) => i !== idx && o.hand.length <= 2);
  const score = (c) => (c.color === 'wild' ? (c.type === 'wild4' ? -5 : -3) : (['skip', 'reverse', 'draw2'].includes(c.type) ? (pressure ? 6 : 2) : 1) + p.hand.filter((x) => x.color === c.color).length * 0.3);
  options.sort((a, b) => score(b) - score(a));
  finishPlay(room, idx, options[0]);
}
function finishPlay(room, idx, c) {
  const p = room.players[idx];
  if (p.hand.length === 2 && Math.random() < 0.88) p.uno = true;
  const err = play(room, idx, c.id, c.color === 'wild' ? chooseColor(p.hand.filter((x) => x.id !== c.id)) : null);
  if (err) pass(room, idx);
}
function tick(room, keepTimer) {
  broadcast(room);
  if (room.state !== 'playing') return;
  if (keepTimer) return;
  clearTimeout(room.timer);
  const g = room.game;
  const idx = g.turn, p = room.players[idx];
  const auto = p.bot || !p.connected || p.auto;
  g.deadline = Date.now() + (auto ? 0 : TURN_MS);
  room.timer = setTimeout(() => (auto ? botAct(room, idx) : timeoutSkip(room, idx)), auto ? 900 + rnd(900) : TURN_MS);
  broadcast(room);
}

// ---------- views ----------
function view(room, id) {
  const g = room.game, me = room.players.find((p) => p.id === id);
  const v = {
    code: room.code, state: room.state, scoring: room.scoring, playLimit: room.playLimit, isPublic: room.isPublic, title: room.title, gameNo: room.gameNo, hostId: room.hostId, me: id, round: room.round,
    players: room.players.map((p) => ({ id: p.id, name: p.name, av: p.av, bot: p.bot, connected: p.connected, cards: p.hand.length, score: p.score, uno: p.uno, rank: p.rank, auto: p.auto })),
    result: room.result, fx: room.fx,
  };
  if (g && me) {
    v.hand = me.hand;
    const pl = room.players[g.turn];
    v.game = {
      top: top(g), color: g.color, dir: g.dir, turn: pl.id, deck: g.deck.length, deadline: g.deadline,
      pending: g.pending ? { from: room.players[g.pending.from].id, target: room.players[g.pending.target].id } : null,
      drawn: g.drawn, vuln: g.vuln, vulnDeadline: g.vulnDeadline || 0, playsThisTurn: g.playsThisTurn || 0,
      playable: pl.id === id && !g.pending ? me.hand.filter((c) => (!g.drawn || g.drawn === c.id) && canPlay(c, g, me.hand.filter((x) => x.id !== c.id))).map((c) => c.id) : [],
    };
  }
  return v;
}
function broadcast(room) {
  room.players.forEach((p) => { if (!p.bot) { const s = sockets.get(p.id); if (s) s.emit('state', view(room, p.id)); } });
}

// ---------- room membership ----------
function removePlayer(room, id) {
  const i = pIdx(room, id);
  if (i < 0) return;
  const p = room.players[i];
  clearTimeout(p.dc);
  where.delete(id);
  if (room.state === 'playing' || room.state === 'roundEnd') {
    // replace with bot so the game goes on
    p.bot = true; p.id = 'bot_' + cardSeq++; p.name = p.name + ' (บอท)'; p.connected = true;
    if (room.hostId === id) room.hostId = (room.players.find((x) => !x.bot) || {}).id;
  } else {
    room.players.splice(i, 1);
    if (room.hostId === id) room.hostId = (room.players.find((x) => !x.bot) || {}).id;
  }
  if (!room.players.some((x) => !x.bot)) return destroyRoom(room);
  if (room.state === 'playing') tick(room); else broadcast(room);
}
function destroyRoom(room) {
  clearTimeout(room.timer); clearTimeout(room.catchTimer); clearTimeout(room.unoTimer); clearTimeout(room.nextTimer);
  room.players.forEach((p) => where.delete(p.id));
  rooms.delete(room.code);
}
function leaveQueue(id) { queue = queue.filter((q) => q.id !== id); if (queue.length < 2) queueSince = null; }

setInterval(() => {
  if (queue.length >= 2 && !queueSince) queueSince = Date.now();
  const left = queueSince ? Math.max(0, Math.ceil((QUEUE_WAIT_MS - (Date.now() - queueSince)) / 1000)) : null;
  if (queueSince && (Date.now() - queueSince >= QUEUE_WAIT_MS || queue.length >= 10)) {
    const group = queue.splice(0, 10);
    queueSince = queue.length >= 2 ? Date.now() : null;
    const room = newRoom(group[0].id, group[0].name, 'single', group[0].av, false);
    group.slice(1).forEach((q) => addHuman(room, q.id, q.name, q.av));
    group.forEach((q) => { const s = sockets.get(q.id); if (s) s.emit('queue:matched'); });
    startRound(room);
    return;
  }
  queue.forEach((q) => { const s = sockets.get(q.id); if (s) s.emit('queue:status', { count: queue.length, left }); });
}, 1000);

// ---------- sockets ----------
io.on('connection', (socket) => {
  const id = String(socket.handshake.auth.clientId || '').slice(0, 64);
  if (!id) return socket.disconnect();
  sockets.set(id, socket);
  const code = where.get(id);
  const room = code && rooms.get(code);
  if (room) {
    const p = room.players.find((x) => x.id === id);
    if (p) { p.connected = true; clearTimeout(p.dc); socket.emit('state', view(room, id)); if (room.state === 'playing') tick(room); else broadcast(room); }
  }
  const my = () => rooms.get(where.get(id));
  const act = (fn) => (arg, ack) => {
    const r = my();
    if (r) { const hp = r.players.find((x) => x.id === id); if (hp && r.state === 'playing') { hp.skips = 0; hp.auto = false; } }
    if (typeof arg === 'function') { ack = arg; arg = {}; }
    const err = r ? fn(r, arg || {}) : 'ไม่ได้อยู่ในห้อง';
    if (typeof ack === 'function') ack(err ? { error: err } : { ok: true });
  };
  const leaveAll = () => { leaveQueue(id); const r = my(); if (r) removePlayer(r, id); };

  socket.on('room:create', (d, ack) => {
    leaveAll();
    d = d || {};
    const validLimit = [0, 1, 2, 3].includes(Number(d.playLimit)) ? Number(d.playLimit) : 1;
    const r = newRoom(id, d.name, ['single', '500', 'rank'].includes(d.scoring) ? d.scoring : 'single', d.av, d.isPublic !== false, d.title, validLimit);
    ack && ack({ ok: true, code: r.code }); broadcast(r);
  });
  socket.on('room:join', (d, ack) => {
    const r = rooms.get(String((d && d.code) || '').toUpperCase().trim());
    if (!r) return ack && ack({ error: 'ไม่พบห้องนี้' });
    if (r.players.find((p) => p.id === id)) { broadcast(r); return ack && ack({ ok: true }); }
    if (r.state !== 'lobby') return ack && ack({ error: 'ห้องนี้เริ่มเกมไปแล้ว' });
    if (r.players.length >= 10) return ack && ack({ error: 'ห้องเต็มแล้ว (10 คน)' });
    leaveAll(); addHuman(r, id, d.name, d.av); broadcast(r); ack && ack({ ok: true });
  });
  socket.on('room:leave', () => leaveAll());
  socket.on('room:addBot', act((r) => { if (r.hostId !== id || r.state !== 'lobby') return 'เฉพาะโฮสต์'; if (r.players.length >= 10) return 'ห้องเต็ม'; addBot(r); broadcast(r); }));
  socket.on('room:removeBot', act((r, d) => {
    if (r.hostId !== id || r.state !== 'lobby') return 'เฉพาะโฮสต์';
    const i = r.players.findIndex((p) => p.id === d.botId && p.bot); if (i >= 0) r.players.splice(i, 1); broadcast(r);
  }));
  socket.on('room:scoring', act((r, d) => { if (r.hostId !== id) return 'เฉพาะโฮสต์'; r.scoring = ['500', 'rank'].includes(d.mode) ? d.mode : 'single'; broadcast(r); }));
  socket.on('room:playLimit', act((r, d) => {
    if (r.hostId !== id || r.state !== 'lobby') return 'เฉพาะโฮสต์';
    const valid = [0, 1, 2, 3].includes(Number(d.limit)) ? Number(d.limit) : 1;
    r.playLimit = valid;
    broadcast(r);
  }));
  socket.on('room:public', act((r) => { if (r.hostId !== id) return 'เฉพาะโฮสต์'; r.isPublic = !r.isPublic; broadcast(r); }));
  socket.on('rooms:list', (a, ack) => {
    ack = typeof a === 'function' ? a : ack;
    const list = [...rooms.values()].filter((r) => r.state === 'lobby' && r.isPublic && r.players.length < 10).map((r) => ({ code: r.code, title: r.title, count: r.players.length, scoring: r.scoring, host: (r.players.find((p) => p.id === r.hostId) || {}).name }));
    ack && ack(list);
  });
  socket.on('room:start', act((r) => {
    if (r.hostId !== id) return 'เฉพาะโฮสต์'; if (r.players.length < 2) return 'ต้องมีอย่างน้อย 2 คน (เพิ่มบอทได้)';
    if (r.state !== 'lobby') return 'เริ่มไปแล้ว'; r.players.forEach((p) => (p.score = 0)); r.round = 0; r.gameNo++; startRound(r);
  }));
  socket.on('room:rematch', act((r) => { if (r.hostId !== id || r.state !== 'gameEnd') return 'เฉพาะโฮสต์'; r.state = 'lobby'; r.game = null; r.result = null; r.players.forEach((p) => (p.score = 0)); broadcast(r); }));
  socket.on('queue:join', (d) => { leaveAll(); queue.push({ id, name: ((d && d.name) || 'ผู้เล่น').slice(0, 14), av: av(d && d.av) }); });
  socket.on('queue:leave', () => leaveQueue(id));
  socket.on('game:play', act((r, d) => { const i = pIdx(r, id); const p = r.players[i]; if (p && p.hand.length === 2 && d.uno) p.uno = true; return play(r, i, d.cardId, d.color); }));
  socket.on('game:draw', act((r) => draw(r, pIdx(r, id))));
  socket.on('game:pass', act((r) => pass(r, pIdx(r, id))));
  socket.on('game:endTurn', act((r) => {
    const g = r.game, idx = pIdx(r, id);
    if (!g || r.state !== 'playing' || g.turn !== idx || g.pending || g.drawn) return 'จบตาไม่ได้';
    if ((g.playsThisTurn || 0) === 0) return 'ต้องลงไพ่อย่างน้อย 1 ใบก่อน';
    g.playsThisTurn = 0;
    g.turn = step(g, r.players.length, idx);
    tick(r);
    return null;
  }));
  socket.on('game:challenge', act((r, d) => respondWild4(r, pIdx(r, id), !!d.challenge)));
  socket.on('game:uno', act((r) => callUno(r, pIdx(r, id))));
  socket.on('game:back', act((r) => { broadcast(r); }));
  socket.on('game:catch', act((r) => catchUno(r, pIdx(r, id))));

  socket.on('disconnect', () => {
    if (sockets.get(id) === socket) sockets.delete(id);
    leaveQueue(id);
    const r = my(); if (!r) return;
    const p = r.players.find((x) => x.id === id); if (!p) return;
    p.connected = false;
    p.dc = setTimeout(() => removePlayer(r, id), r.state === 'lobby' ? 30000 : 120000);
    if (r.state === 'playing') tick(r); else broadcast(r);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log('UNO online listening on', PORT));
