'use strict';
// RingRing account + friends store. JSON file on disk, no database needed.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

function blankDb() {
  return { users: {}, sessions: {} };
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
    const disp = k => {
      const x = this._get(k);
      return { username: x ? x.name : k, online: !!(onlineSet && onlineSet.has(k)) };
    };
    return {
      username: u.name,
      friends: u.friends.map(disp).sort((a, b) =>
        (b.online - a.online) || a.username.localeCompare(b.username)),
      incoming: u.incoming.map(r => ({ username: this._get(r.from)?.name || r.from, at: r.at })),
      outgoing: u.outgoing.map(r => ({ username: this._get(r.to)?.name || r.to, at: r.at })),
    };
  }
}

module.exports = { Store, SESSION_TTL_MS };
