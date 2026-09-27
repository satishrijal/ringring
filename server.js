'use strict';
// RingRing server: account API + WebSocket signaling for presence, calls, chat.
// Run: npm start   (PORT env, default 3000)
const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');
const { Store } = require('./store');

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');
const store = new Store(process.env.RINGRING_DB);

// ---- live state ----
const sockets = new Map(); // userKey -> ws
const calls = new Map();   // userKey -> { peer: userKey, state: 'ringing'|'active', video: bool }
const groupRooms = new Map(); // groupId -> Set(userKey) currently in the live call

// ---- helpers ----
function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', c => { data += c; if (data.length > 1e6) req.destroy(); });
    req.on('end', () => {
      if (!data) return resolve({});
      try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

function bearerToken(req) {
  const h = req.headers['authorization'] || '';
  const m = h.match(/^Bearer (.+)$/);
  return m ? m[1] : null;
}

function authedUser(req, allowQueryToken) {
  let s = store.getSession(bearerToken(req));
  if (!s && allowQueryToken) {
    // the one-time snap photo loads through an <img> tag, which can't set
    // headers — so only that endpoint also accepts ?token=
    try {
      s = store.getSession(new URL(req.url, 'http://x').searchParams.get('token'));
    } catch (e) {}
  }
  return s ? s.username : null;
}

// simple per-IP rate limit for auth endpoints
const rl = new Map();
function rateLimited(ip, limit, windowMs) {
  const now = Date.now();
  const e = rl.get(ip) || { n: 0, reset: now + windowMs };
  if (now > e.reset) { e.n = 0; e.reset = now + windowMs; }
  e.n++;
  rl.set(ip, e);
  return e.n > limit;
}

function wsSend(ws, obj) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj));
}

function userKey(name) { return String(name).toLowerCase(); }

function notifyFriendsOf(username, msg) {
  const k = userKey(username);
  const u = store.db.users[k];
  if (!u) return;
  for (const f of u.friends) {
    const ws = sockets.get(f);
    if (ws) wsSend(ws, msg);
  }
}

function endCallFor(k, reason) {
  const c = calls.get(k);
  if (!c) return;
  const peer = c.peer;
  calls.delete(k);
  if (calls.get(peer) && calls.get(peer).peer === k) calls.delete(peer);
  const pws = sockets.get(peer);
  if (pws) wsSend(pws, { t: 'call-ended', from: store.db.users[k]?.name || k, reason: reason || 'ended' });
}

function leaveGroupRoom(k, gid) {
  const room = groupRooms.get(gid);
  if (!room || !room.has(k)) return;
  room.delete(k);
  const name = store.db.users[k]?.name || k;
  for (const o of room) {
    const ows = sockets.get(o);
    if (ows) wsSend(ows, { t: 'group-peer-left', groupId: gid, user: name });
  }
  if (!room.size) groupRooms.delete(gid);
}

function leaveAllGroupRooms(k) {
  for (const gid of [...groupRooms.keys()]) leaveGroupRoom(k, gid);
}

function pushNotification(toKey, kind, text) {
  const n = store.addNotification(toKey, kind, text);
  if (!n) return;
  const tws = sockets.get(toKey);
  if (tws) wsSend(tws, { t: 'notification', n });
}

// ---- HTTP API ----
async function handleApi(req, res) {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
  const ip = req.socket.remoteAddress || 'unknown';

  if (req.method === 'POST' && (p === '/api/register' || p === '/api/login')) {
    if (rateLimited(ip, 20, 60 * 1000)) return sendJson(res, 429, { ok: false, error: 'Too many attempts, slow down' });
    let body;
    try { body = await readBody(req); } catch (e) { return sendJson(res, 400, { ok: false, error: 'Bad request' }); }
    const { username, password } = body;
    if (p === '/api/register') {
      const r = store.register(username, password);
      if (!r.ok) return sendJson(res, 400, r);
      const token = store.createSession(r.username);
      return sendJson(res, 200, { ok: true, token, username: r.username });
    }
    const r = store.verifyLogin(username, password);
    if (!r.ok) return sendJson(res, 401, r);
    const token = store.createSession(r.username);
    return sendJson(res, 200, { ok: true, token, username: r.username });
  }

  const pathOnly = p;
  const isSnapPhoto = req.method === 'GET' && pathOnly.startsWith('/api/snaps/') && pathOnly.endsWith('/photo');
  const me = authedUser(req, isSnapPhoto);
  if (!me) return sendJson(res, 401, { ok: false, error: 'Not logged in' });
  const mk = userKey(me);

  if (req.method === 'POST' && p === '/api/logout') {
    store.destroySession(bearerToken(req));
    const ws = sockets.get(mk);
    if (ws) ws.close(4000, 'logged out');
    return sendJson(res, 200, { ok: true });
  }

  if (req.method === 'GET' && p === '/api/me') {
    const online = new Set(sockets.keys());
    return sendJson(res, 200, { ok: true, ...store.profile(me, online) });
  }

  if (req.method === 'POST' && p === '/api/friends/request') {
    let body;
    try { body = await readBody(req); } catch (e) { return sendJson(res, 400, { ok: false, error: 'Bad request' }); }
    const r = store.sendRequest(me, body.username || '');
    if (!r.ok) return sendJson(res, 400, r);
    // live nudge so the other side sees the request instantly
    const targetKey = userKey(body.username || '');
    const tws = sockets.get(targetKey);
    if (tws) wsSend(tws, { t: 'friend-request', from: me });
    pushNotification(targetKey, 'friend-request', '@' + me + ' sent you a friend request');
    return sendJson(res, 200, { ok: true });
  }

  if (req.method === 'POST' && p === '/api/friends/respond') {
    let body;
    try { body = await readBody(req); } catch (e) { return sendJson(res, 400, { ok: false, error: 'Bad request' }); }
    const r = store.respondRequest(me, body.username || '', !!body.accept);
    if (!r.ok) return sendJson(res, 400, r);
    const requesterKey = userKey(body.username || '');
    const tws = sockets.get(requesterKey);
    if (tws) wsSend(tws, { t: 'friend-update' });
    if (r.accepted) pushNotification(requesterKey, 'friend-accept', '@' + me + ' accepted your friend request 🎉');
    else pushNotification(requesterKey, 'friend-decline', '@' + me + ' declined your friend request');
    return sendJson(res, 200, { ok: true, accepted: r.accepted });
  }

  if (req.method === 'POST' && p === '/api/friends/remove') {
    let body;
    try { body = await readBody(req); } catch (e) { return sendJson(res, 400, { ok: false, error: 'Bad request' }); }
    const r = store.removeFriend(me, body.username || '');
    if (!r.ok) return sendJson(res, 400, r);
    const tws = sockets.get(userKey(body.username || ''));
    if (tws) wsSend(tws, { t: 'friend-update' });
    return sendJson(res, 200, { ok: true });
  }

  // ---- user search ----
  if (req.method === 'GET' && p === '/api/users/search') {
    const q = url.searchParams.get('q') || '';
    const results = store.searchUsers(q, mk, 20);
    const meU = store.db.users[mk];
    const online = new Set(sockets.keys());
    return sendJson(res, 200, {
      ok: true,
      users: results.map(r => {
        const k = userKey(r.username);
        let status = 'none';
        if (meU.friends.includes(k)) status = 'friend';
        else if (meU.incoming.some(x => x.from === k)) status = 'incoming';
        else if (meU.outgoing.some(x => x.to === k)) status = 'outgoing';
        return { username: r.username, online: online.has(k), status };
      }),
    });
  }

  // ---- notifications ----
  if (req.method === 'GET' && p === '/api/notifications') {
    return sendJson(res, 200, {
      ok: true,
      notifications: store.getNotifications(mk),
      unread: store.unreadNotificationCount(mk),
    });
  }

  if (req.method === 'POST' && p === '/api/notifications/read') {
    store.markNotificationsRead(mk);
    return sendJson(res, 200, { ok: true });
  }

  // ---- groups ----
  if (req.method === 'POST' && p === '/api/groups') {
    let body;
    try { body = await readBody(req); } catch (e) { return sendJson(res, 400, { ok: false, error: 'Bad request' }); }
    const r = store.createGroup(mk, body.name, body.members);
    if (!r.ok) return sendJson(res, 400, r);
    const g = store.db.groups[r.group.id];
    for (const m of g.members) {
      if (m === mk) continue;
      pushNotification(m, 'group-invite', '@' + me + ' added you to the group "' + g.name + '" 👥');
    }
    // tell online members to refresh their group list
    for (const m of g.members) {
      const mws = sockets.get(m);
      if (mws) wsSend(mws, { t: 'groups-changed' });
    }
    return sendJson(res, 200, { ok: true, group: r.group });
  }

  if (req.method === 'GET' && p === '/api/groups') {
    return sendJson(res, 200, { ok: true, groups: store.userGroups(mk) });
  }

  if (req.method === 'POST' && p === '/api/groups/leave') {
    let body;
    try { body = await readBody(req); } catch (e) { return sendJson(res, 400, { ok: false, error: 'Bad request' }); }
    const r = store.leaveGroup(mk, String(body.id || ''));
    if (!r.ok) return sendJson(res, 400, r);
    leaveGroupRoom(mk, String(body.id || ''));
    return sendJson(res, 200, { ok: true });
  }

  // ---- snaps: one-time photos ----
  if (req.method === 'POST' && p === '/api/snaps') {
    let body;
    try { body = await readBody(req); } catch (e) { return sendJson(res, 400, { ok: false, error: 'Bad request' }); }
    const toK = userKey(body.to || '');
    if (!store.areFriends(mk, toK)) return sendJson(res, 400, { ok: false, error: 'You can only snap friends' });
    const photo = String(body.photo || '');
    if (!photo.startsWith('data:image/jpeg;base64,')) return sendJson(res, 400, { ok: false, error: 'Photo must be a JPEG' });
    if (photo.length > 2000000) return sendJson(res, 400, { ok: false, error: 'Photo too big (2MB max)' });
    const id = store.createSnap(mk, toK);
    try {
      fs.mkdirSync(store.snapsDir(), { recursive: true });
      fs.writeFileSync(path.join(store.snapsDir(), id + '.jpg'), Buffer.from(photo.slice('data:image/jpeg;base64,'.length), 'base64'));
    } catch (e) {
      return sendJson(res, 500, { ok: false, error: 'Could not save photo' });
    }
    const tws = sockets.get(toK);
    if (tws) wsSend(tws, { t: 'snap', id, from: me });
    pushNotification(toK, 'snap', '@' + me + ' sent you a 👻 snap — view it once before it\'s gone!');
    return sendJson(res, 200, { ok: true, id });
  }

  if (req.method === 'GET' && p === '/api/snaps') {
    return sendJson(res, 200, { ok: true, snaps: store.mySnaps(mk) });
  }

  // Serve a snap photo exactly once: reading it deletes it forever.
  if (req.method === 'GET' && p.startsWith('/api/snaps/') && p.endsWith('/photo')) {
    const parts = p.split('/');
    const id = parts[3] || '';
    const s = store.getSnap(id);
    if (!s || s.to !== mk || s.viewed) {
      return sendJson(res, 404, { ok: false, error: 'Gone — snaps can only be viewed once 👻' });
    }
    let bytes = null;
    try { bytes = fs.readFileSync(path.join(store.snapsDir(), id + '.jpg')); } catch (e) {}
    const fromKey = s.from;
    const consumed = store.consumeSnap(id, mk);
    if (!consumed.ok || !bytes) {
      return sendJson(res, 404, { ok: false, error: 'Gone — snaps can only be viewed once 👻' });
    }
    const fws = sockets.get(fromKey);
    if (fws) wsSend(fws, { t: 'snap-viewed', id, by: me, streak: consumed.streak });
    res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Content-Length': bytes.length, 'Cache-Control': 'no-store' });
    return res.end(bytes);
  }

  return sendJson(res, 404, { ok: false, error: 'Not found' });
}

// ---- static files ----
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.mp3': 'audio/mpeg' };

function serveStatic(req, res) {
  let rel = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (rel === '/') rel = '/index.html';
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
}

// ---- WebSocket signaling ----
function handleSocket(ws, username) {
  const k = userKey(username);
  // one socket per user: drop the older one
  const old = sockets.get(k);
  if (old && old !== ws) { try { old.close(4001, 'new session'); } catch (e) {} }
  sockets.set(k, ws);
  notifyFriendsOf(username, { t: 'presence', user: store.db.users[k].name, online: true });

  ws.on('message', raw => {
    let m;
    try { m = JSON.parse(raw); } catch (e) { return; }
    if (!m || typeof m.t !== 'string') return;

    const toKey = userKey(m.to || '');
    const peerWs = () => sockets.get(toKey);
    const isFriend = toKey && store.areFriends(k, toKey);

    switch (m.t) {
      case 'ping':
        wsSend(ws, { t: 'pong' });
        break;

      case 'chat': {
        if (!isFriend || typeof m.text !== 'string') break;
        const text = m.text.slice(0, 2000);
        if (!text.trim()) break;
        const tws = peerWs();
        if (tws) wsSend(tws, { t: 'chat', from: store.db.users[k].name, text, at: Date.now() });
        break;
      }

      case 'call': {
        if (!isFriend) { wsSend(ws, { t: 'call-failed', to: m.to, reason: 'not-friends' }); break; }
        if (toKey === k) { wsSend(ws, { t: 'call-failed', to: m.to, reason: 'self' }); break; }
        if (calls.has(k) || calls.has(toKey)) { wsSend(ws, { t: 'call-failed', to: m.to, reason: 'busy' }); break; }
        const tws = peerWs();
        if (!tws) { wsSend(ws, { t: 'call-failed', to: m.to, reason: 'offline' }); break; }
        const video = m.video !== false;
        calls.set(k, { peer: toKey, state: 'ringing', video });
        calls.set(toKey, { peer: k, state: 'ringing', video });
        wsSend(tws, { t: 'incoming-call', from: store.db.users[k].name, video });
        break;
      }

      case 'call-cancel': {
        const c = calls.get(k);
        if (c && c.state === 'ringing') {
          const peer = c.peer;
          calls.delete(k); calls.delete(peer);
          const pws = sockets.get(peer);
          if (pws) wsSend(pws, { t: 'call-cancelled', from: store.db.users[k].name });
        }
        break;
      }

      case 'call-accept': {
        const c = calls.get(k);
        if (!c || c.state !== 'ringing' || c.peer !== toKey) break;
        c.state = 'active';
        const pc = calls.get(toKey);
        if (pc) pc.state = 'active';
        const pws = peerWs();
        if (pws) wsSend(pws, { t: 'call-accepted', from: store.db.users[k].name, video: c.video });
        break;
      }

      case 'call-decline': {
        const c = calls.get(k);
        if (!c || c.peer !== toKey) break;
        const peer = c.peer;
        calls.delete(k); calls.delete(peer);
        const pws = sockets.get(peer);
        if (pws) wsSend(pws, { t: 'call-declined', from: store.db.users[k].name });
        break;
      }

      case 'signal': {
        const c = calls.get(k);
        if (!c || c.peer !== toKey || !m.data || typeof m.data.kind !== 'string') break;
        const pws = peerWs();
        if (pws) wsSend(pws, { t: 'signal', from: store.db.users[k].name, data: m.data });
        break;
      }

      case 'call-end': {
        endCallFor(k, 'ended');
        break;
      }

      // ---------- group calls (small mesh rooms) ----------
      case 'group-call': {
        const gid = String(m.groupId || '');
        const g = (store.db.groups || {})[gid];
        if (!g || !g.members.includes(k)) break;
        let room = groupRooms.get(gid);
        if (!room) { room = new Set(); groupRooms.set(gid, room); }
        room.add(k);
        const fromName = store.db.users[k].name;
        for (const mem of g.members) {
          if (mem === k) continue;
          const mws = sockets.get(mem);
          if (mws) wsSend(mws, { t: 'group-incoming', groupId: gid, groupName: g.name, from: fromName, video: m.video !== false });
        }
        break;
      }

      case 'group-join': {
        const gid = String(m.groupId || '');
        const g = (store.db.groups || {})[gid];
        const room = groupRooms.get(gid);
        if (!g || !g.members.includes(k) || !room) { wsSend(ws, { t: 'group-join-failed', groupId: gid }); break; }
        const others = [...room].filter(x => x !== k);
        room.add(k);
        wsSend(ws, {
          t: 'group-peers', groupId: gid, groupName: g.name, video: m.video !== false,
          peers: others.map(x => store.db.users[x]?.name || x),
        });
        const myName = store.db.users[k].name;
        for (const o of others) {
          const ows = sockets.get(o);
          if (ows) wsSend(ows, { t: 'group-peer-joined', groupId: gid, user: myName });
        }
        break;
      }

      case 'group-signal': {
        const gid = String(m.groupId || '');
        const room = groupRooms.get(gid);
        const sigTo = userKey(m.to || '');
        if (!room || !room.has(k) || !room.has(sigTo) || !m.data || typeof m.data.kind !== 'string') break;
        const tws = sockets.get(sigTo);
        if (tws) wsSend(tws, { t: 'group-signal', groupId: gid, from: store.db.users[k].name, data: m.data });
        break;
      }

      case 'group-leave': {
        leaveGroupRoom(k, String(m.groupId || ''));
        break;
      }
    }
  });

  const cleanup = () => {
    if (sockets.get(k) === ws) {
      sockets.delete(k);
      if (calls.has(k)) endCallFor(k, 'disconnect');
      leaveAllGroupRooms(k);
      notifyFriendsOf(username, { t: 'presence', user: store.db.users[k]?.name || username, online: false });
    }
  };
  ws.on('close', cleanup);
  ws.on('error', () => {});
}

// ---- server ----
const server = http.createServer((req, res) => {
  if (req.url.startsWith('/api/')) return handleApi(req, res);
  return serveStatic(req, res);
});

const wss = new WebSocketServer({ server });
wss.on('connection', (ws, req) => {
  let token = null;
  try { token = new URL(req.url, 'http://x').searchParams.get('token'); } catch (e) {}
  const s = store.getSession(token);
  if (!s) { ws.close(4401, 'unauthorized'); return; }
  handleSocket(ws, s.username);
});

if (require.main === module) {
  server.listen(PORT, () => console.log(`RingRing live on :${PORT}`));
  // expired unviewed snaps are meant to disappear — sweep hourly
  setInterval(() => { try { store.sweepSnaps(); } catch (e) {} }, 60 * 60 * 1000).unref();
}

module.exports = { server, store, sockets, calls, groupRooms, handleSocket };
