'use strict';
// RingRing account + friends store. JSON file on disk, no database needed.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

function blankDb() {
  return { users: {}, sessions: {}, groups: {}, snaps: {}, streaks: {} };
}

class Store {
  constructor(filePath) {
    this.file = filePath || path.join(__dirname, 'data', 'ringring.json');
    this.db = blankDb();
    this._load();
  }

  _load() {
    try {
      const raw = fs.readFileSync(this.file, 'utf8');
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && parsed.users && parsed.sessions) {
        this.db = parsed;
      }
    } catch (e) {
      // missing or corrupt file -> start fresh
    }
  }

  save() {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify(this.db));
    } catch (e) {
      // best effort; never crash the server over persistence
    }
  }

  // ---------- users ----------

  static validUsername(name) {
    return typeof name === 'string' && /^[a-zA-Z0-9_]{3,20}$/.test(name);
  }

  static validPassword(pw) {
    return typeof pw === 'string' && pw.length >= 4 && pw.length <= 100;
  }

  static hashPassword(pw) {
    const salt = crypto.randomBytes(16).toString('hex');
    const hash = crypto.scryptSync(pw, salt, 64).toString('hex');
    return salt + ':' + hash;
  }

  static checkPassword(pw, stored) {
    const parts = String(stored).split(':');
    if (parts.length !== 2) return false;
    const [salt, hash] = parts;
    const check = crypto.scryptSync(pw, salt, 64).toString('hex');
    const a = Buffer.from(hash, 'hex');
    const b = Buffer.from(check, 'hex');
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  }

  key(name) {
    return String(name).toLowerCase();
  }

  userExists(name) {
    return !!this.db.users[this.key(name)];
  }

  register(name, password) {
    if (!Store.validUsername(name)) return { ok: false, error: 'Username must be 3-20 letters, numbers or _' };
    if (!Store.validPassword(password)) return { ok: false, error: 'Password must be at least 4 characters' };
    const k = this.key(name);
    if (this.db.users[k]) return { ok: false, error: 'That username is taken' };
    this.db.users[k] = {
      name: String(name), // display casing
      pass: Store.hashPassword(password),
      friends: [],
      incoming: [], // friend requests received: [{from, at}]
      outgoing: [], // friend requests sent: [{to, at}]
      createdAt: Date.now(),
    };
    this.save();
    return { ok: true, username: String(name) };
  }

  verifyLogin(name, password) {
    const u = this.db.users[this.key(name)];
    if (!u) return { ok: false, error: 'Wrong username or password' };
    if (!Store.checkPassword(password, u.pass)) return { ok: false, error: 'Wrong username or password' };
    return { ok: true, username: u.name };
  }

  // ---------- sessions ----------

  createSession(username) {
    const token = crypto.randomBytes(32).toString('hex');
    this.db.sessions[token] = { username, createdAt: Date.now() };
    this.save();
    return token;
  }

  getSession(token) {
    if (!token) return null;
    const s = this.db.sessions[token];
    if (!s) return null;
    if (Date.now() - s.createdAt > SESSION_TTL_MS) {
      delete this.db.sessions[token];
      this.save();
      return null;
    }
    // user could theoretically be deleted; guard anyway
    if (!this.db.users[this.key(s.username)]) {
      delete this.db.sessions[token];
      this.save();
      return null;
    }
    return s;
  }

  destroySession(token) {
    if (token && this.db.sessions[token]) {
      delete this.db.sessions[token];
      this.save();
    }
  }

  // ---------- friends ----------

  _get(k) {
    return this.db.users[k];
  }

  areFriends(aKey, bKey) {
    const a = this._get(aKey);
    return !!a && a.friends.includes(bKey);
  }

  sendRequest(fromName, toName) {
    const fk = this.key(fromName);
    const tk = this.key(toName);
    const from = this._get(fk);
    const to = this._get(tk);
    if (!from) return { ok: false, error: 'Sender not found' };
    if (!to) return { ok: false, error: 'No user with that username' };
    if (fk === tk) return { ok: false, error: "You can't add yourself" };
    if (from.friends.includes(tk)) return { ok: false, error: 'You are already friends' };
    if (from.outgoing.some(r => r.to === tk)) return { ok: false, error: 'Request already sent' };
    if (from.incoming.some(r => r.from === tk)) {
      // they already requested us -> just become friends
      return this.respondRequest(fromName, to.name, true);
    }
    const at = Date.now();
    from.outgoing.push({ to: tk, at });
    to.incoming.push({ from: fk, at });
    this.save();
    return { ok: true };
  }

  respondRequest(meName, fromName, accept) {
    const mk = this.key(meName);
    const fk = this.key(fromName);
    const me = this._get(mk);
    const from = this._get(fk);
    if (!me || !from) return { ok: false, error: 'User not found' };
    const idx = me.incoming.findIndex(r => r.from === fk);
    if (idx === -1) return { ok: false, error: 'No request from that user' };
    me.incoming.splice(idx, 1);
    const oIdx = from.outgoing.findIndex(r => r.to === mk);
    if (oIdx !== -1) from.outgoing.splice(oIdx, 1);
    if (accept) {
      if (!me.friends.includes(fk)) me.friends.push(fk);
      if (!from.friends.includes(mk)) from.friends.push(mk);
    }
    this.save();
    return { ok: true, accepted: !!accept };
  }

  removeFriend(meName, friendName) {
    const mk = this.key(meName);
    const fk = this.key(friendName);
    const me = this._get(mk);
    const fr = this._get(fk);
    if (!me || !fr) return { ok: false, error: 'User not found' };
    me.friends = me.friends.filter(f => f !== fk);
    fr.friends = fr.friends.filter(f => f !== mk);
    this.save();
    return { ok: true };
  }

  profile(name, onlineSet) {
    const u = this._get(this.key(name));
    if (!u) return null;
    const selfK = this.key(name);
    const disp = k => {
      const x = this._get(k);
      const st = this.getStreak(selfK, k);
      return { username: x ? x.name : k, online: !!(onlineSet && onlineSet.has(k)), streak: st };
    };
    return {
      username: u.name,
      friends: u.friends.map(disp).sort((a, b) =>
        (b.online - a.online) || a.username.localeCompare(b.username)),
      incoming: u.incoming.map(r => ({ username: this._get(r.from)?.name || r.from, at: r.at })),
      outgoing: u.outgoing.map(r => ({ username: this._get(r.to)?.name || r.to, at: r.at })),
    };
  }

  // ---------- user search ----------

  searchUsers(query, selfKey, limit = 20) {
    const q = String(query || '').trim().toLowerCase();
    if (q.length < 2) return [];
    const out = [];
    for (const k of Object.keys(this.db.users)) {
      if (k === selfKey) continue;
      const u = this.db.users[k];
      if (k.includes(q)) {
        out.push({ username: u.name });
        if (out.length >= limit) break;
      }
    }
    return out;
  }

  // ---------- notifications ----------

  addNotification(toKey, kind, text) {
    const u = this._get(toKey);
    if (!u) return null;
    u.notifications = u.notifications || [];
    const n = {
      id: crypto.randomBytes(8).toString('hex'),
      kind: String(kind).slice(0, 30),
      text: String(text).slice(0, 200),
      at: Date.now(),
      read: false,
    };
    u.notifications.unshift(n);
    u.notifications = u.notifications.slice(0, 50);
    this.save();
    return n;
  }

  getNotifications(key) {
    const u = this._get(key);
    return (u && u.notifications) || [];
  }

  unreadNotificationCount(key) {
    return this.getNotifications(key).filter(n => !n.read).length;
  }

  markNotificationsRead(key) {
    const u = this._get(key);
    if (u && u.notifications) {
      for (const n of u.notifications) n.read = true;
      this.save();
    }
    return { ok: true };
  }

  // ---------- groups ----------

  createGroup(creatorKey, name, memberNames) {
    const creator = this._get(creatorKey);
    if (!creator) return { ok: false, error: 'User not found' };
    name = String(name || '').trim().slice(0, 40);
    if (name.length < 2) return { ok: false, error: 'Group name needs at least 2 characters' };
    const members = new Set([creatorKey]);
    for (const m of memberNames || []) {
      const k = this.key(m);
      if (k === creatorKey) continue;
      const u = this._get(k);
      if (!u) return { ok: false, error: 'No user @' + m };
      if (!creator.friends.includes(k)) return { ok: false, error: '@' + u.name + ' is not your friend' };
      members.add(k);
    }
    if (members.size < 2) return { ok: false, error: 'Add at least one friend' };
    if (members.size > 6) return { ok: false, error: 'Groups are capped at 6 people' };
    this.db.groups = this.db.groups || {};
    const id = crypto.randomBytes(8).toString('hex');
    this.db.groups[id] = { id, name, members: [...members], createdBy: creatorKey, createdAt: Date.now() };
    this.save();
    return { ok: true, group: this.groupView(id, creatorKey) };
  }

  groupView(id, viewerKey) {
    const g = (this.db.groups || {})[id];
    if (!g || !g.members.includes(viewerKey)) return null;
    return {
      id: g.id,
      name: g.name,
      members: g.members.map(k => (this._get(k) || {}).name || k),
      createdAt: g.createdAt,
    };
  }

  userGroups(key) {
    return Object.keys(this.db.groups || {})
      .map(id => this.groupView(id, key))
      .filter(Boolean)
      .sort((a, b) => b.createdAt - a.createdAt);
  }

  leaveGroup(key, id) {
    const g = (this.db.groups || {})[id];
    if (!g || !g.members.includes(key)) return { ok: false, error: 'Group not found' };
    g.members = g.members.filter(m => m !== key);
    if (!g.members.length) delete this.db.groups[id];
    this.save();
    return { ok: true };
  }

  // ---------- streaks (consecutive days with a viewed snap) ----------

  _streakKey(a, b) {
    return [a, b].sort().join('|');
  }

  _dateStr(ts) {
    const d = new Date(ts === undefined ? Date.now() : ts);
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }

  recordStreakDay(aKey, bKey) {
    this.db.streaks = this.db.streaks || {};
    const k = this._streakKey(aKey, bKey);
    const today = this._dateStr();
    const yesterday = this._dateStr(Date.now() - 864e5);
    const s = this.db.streaks[k] || { count: 0, last: '' };
    if (s.last !== today) {
      s.count = (s.last === yesterday) ? s.count + 1 : 1;
      s.last = today;
    }
    this.db.streaks[k] = s;
    this.save();
    return s.count;
  }

  getStreak(aKey, bKey) {
    const s = (this.db.streaks || {})[this._streakKey(aKey, bKey)];
    return s ? { count: s.count, last: s.last } : { count: 0, last: '' };
  }

  // ---------- snaps: one-time photos ----------

  snapsDir() {
    return path.join(path.dirname(this.file), 'snaps');
  }

  createSnap(fromKey, toKey) {
    this.db.snaps = this.db.snaps || {};
    const id = crypto.randomBytes(12).toString('hex');
    this.db.snaps[id] = { id, from: fromKey, to: toKey, at: Date.now(), viewed: false };
    this.save();
    return id;
  }

  getSnap(id) {
    return (this.db.snaps || {})[String(id)] || null;
  }

  mySnaps(toKey) {
    return Object.values(this.db.snaps || {})
      .filter(s => s.to === toKey && !s.viewed)
      .map(s => ({ id: s.id, from: (this._get(s.from) || {}).name || s.from, at: s.at }))
      .sort((a, b) => b.at - a.at);
  }

  // Viewing deletes the snap forever and records a streak day. Returns {ok, from, streak}.
  consumeSnap(id, viewerKey) {
    const s = this.getSnap(id);
    if (!s || s.to !== viewerKey || s.viewed) return { ok: false };
    const fromName = (this._get(s.from) || {}).name || s.from;
    try { fs.unlinkSync(path.join(this.snapsDir(), id + '.jpg')); } catch (e) {}
    delete this.db.snaps[id];
    const streak = this.recordStreakDay(s.from, s.to);
    this.save();
    return { ok: true, from: fromName, streak };
  }

  // Delete unviewed snaps older than maxAgeMs (default 7 days).
  sweepSnaps(maxAgeMs) {
    const cutoff = Date.now() - (maxAgeMs || 7 * 864e5);
    let n = 0;
    for (const [id, s] of Object.entries(this.db.snaps || {})) {
      if (s.at < cutoff) {
        try { fs.unlinkSync(path.join(this.snapsDir(), id + '.jpg')); } catch (e) {}
        delete this.db.snaps[id];
        n++;
      }
    }
    if (n) this.save();
    return n;
  }
}

module.exports = { Store, SESSION_TTL_MS };
