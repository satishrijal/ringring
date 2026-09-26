'use strict';
// RingRing tests: store unit tests + live signaling tests over real HTTP/WS.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { WebSocket } = require('ws');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ringring-test-'));
process.env.RINGRING_DB = path.join(tmp, 'test.json');

const { Store } = require('../store');

let passed = 0;
function ok(name, fn) {
  try { fn(); passed++; console.log('  ✓ ' + name); }
  catch (e) { console.error('  ✗ ' + name + '\n    ' + e.message); process.exitCode = 1; }
}
async function okAsync(name, fn) {
  try { await fn(); passed++; console.log('  ✓ ' + name); }
  catch (e) { console.error('  ✗ ' + name + '\n    ' + (e.stack || e.message)); process.exitCode = 1; }
}

console.log('store.js');

{
  const s = new Store(path.join(tmp, 'u1.json'));

  ok('register ok', () => {
    const r = s.register('Alice', 'secret1');
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.username, 'Alice');
  });
  ok('register duplicate (case-insensitive)', () => {
    assert.strictEqual(s.register('alice', 'other').ok, false);
  });
  ok('register bad username rejected', () => {
    assert.strictEqual(s.register('ab', 'secret1').ok, false);
    assert.strictEqual(s.register('has space', 'secret1').ok, false);
  });
  ok('register short password rejected', () => {
    assert.strictEqual(s.register('Bob', '123').ok, false);
  });
  ok('passwords are hashed, not plaintext', () => {
    const u = s.db.users['alice'];
    assert.ok(u.pass && !u.pass.includes('secret1'));
  });
  ok('login ok (case-insensitive)', () => {
    assert.strictEqual(s.verifyLogin('ALICE', 'secret1').ok, true);
  });
  ok('login wrong password fails', () => {
    const r = s.verifyLogin('alice', 'nope');
    assert.strictEqual(r.ok, false);
  });
  ok('login unknown user fails', () => {
    assert.strictEqual(s.verifyLogin('nobody', 'x').ok, false);
  });
  ok('session round-trip', () => {
    const t = s.createSession('Alice');
    assert.strictEqual(s.getSession(t).username, 'Alice');
    s.destroySession(t);
    assert.strictEqual(s.getSession(t), null);
  });
  ok('expired session rejected', () => {
    const t = s.createSession('Alice');
    s.db.sessions[t].createdAt = Date.now() - 8 * 24 * 3600 * 1000;
    assert.strictEqual(s.getSession(t), null);
  });
  ok('bad token rejected', () => {
    assert.strictEqual(s.getSession('bogus'), null);
    assert.strictEqual(s.getSession(null), null);
  });

  s.register('Bob', 'secret2');
  s.register('Cara', 'secret3');

  ok('friend request ok', () => {
    assert.strictEqual(s.sendRequest('Alice', 'Bob').ok, true);
    const b = s.db.users['bob'];
    assert.strictEqual(b.incoming.length, 1);
    assert.strictEqual(b.incoming[0].from, 'alice');
  });
  ok('duplicate request rejected', () => {
    assert.strictEqual(s.sendRequest('Alice', 'Bob').ok, false);
  });
  ok('self request rejected', () => {
    assert.strictEqual(s.sendRequest('Alice', 'Alice').ok, false);
  });
  ok('request to nobody rejected', () => {
    assert.strictEqual(s.sendRequest('Alice', 'Nobody').ok, false);
  });
  ok('accept makes both friends', () => {
    const r = s.respondRequest('Bob', 'Alice', true);
    assert.strictEqual(r.ok, true);
    assert.ok(s.areFriends('alice', 'bob'));
    assert.ok(s.areFriends('bob', 'alice'));
    assert.strictEqual(s.db.users['bob'].incoming.length, 0);
  });
  ok('request to existing friend rejected', () => {
    assert.strictEqual(s.sendRequest('Bob', 'Alice').ok, false);
  });
  ok('reverse request auto-accepts', () => {
    assert.strictEqual(s.sendRequest('Cara', 'Alice').ok, true);
    const r = s.sendRequest('Alice', 'Cara');
    assert.strictEqual(r.ok, true);
    assert.ok(s.areFriends('alice', 'cara'));
  });
  ok('decline removes request, no friendship', () => {
    s.register('Dan', 'secret4');
    s.sendRequest('Dan', 'Alice');
    const r = s.respondRequest('Alice', 'Dan', false);
    assert.strictEqual(r.ok, true);
    assert.ok(!s.areFriends('alice', 'dan'));
    assert.strictEqual(s.respondRequest('Alice', 'Dan', true).ok, false); // gone
  });
  ok('remove friend both ways', () => {
    assert.strictEqual(s.removeFriend('Alice', 'Bob').ok, true);
    assert.ok(!s.areFriends('alice', 'bob'));
    assert.ok(!s.areFriends('bob', 'alice'));
  });
  ok('profile shape', () => {
    const p = s.profile('Alice', new Set(['cara']));
    assert.strictEqual(p.username, 'Alice');
    assert.ok(p.friends.some(f => f.username === 'Cara' && f.online === true));
  });
}

console.log('server.js (live)');

async function live() {
  const { server } = require('../server');
  await new Promise(res => server.listen(0, res));
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;

  const post = async (p, body, token) => {
    const r = await fetch(base + p, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
      body: JSON.stringify(body || {}),
    });
    return r.json();
  };

  // two users, friends
  const ra = await post('/api/register', { username: 'amy', password: 'pw1234' });
  const rb = await post('/api/register', { username: 'ben', password: 'pw1234' });
  const rc = await post('/api/register', { username: 'zed', password: 'pw1234' });
  assert.ok(ra.ok && rb.ok && rc.ok, 'registrations');
  const ta = ra.token, tb = rb.token, tc = rc.token;
  assert.strictEqual((await post('/api/friends/request', { username: 'ben' }, ta)).ok, true);
  assert.strictEqual((await post('/api/friends/respond', { username: 'amy', accept: true }, tb)).ok, true);

  const me = await (await fetch(base + '/api/me', { headers: { Authorization: 'Bearer ' + ta } })).json();
  await okAsync('GET /api/me shows friend', async () => {
    assert.strictEqual(me.ok, true);
    assert.ok(me.friends.some(f => f.username === 'ben'));
  });
  await okAsync('unauthorized without token', async () => {
    const r = await (await fetch(base + '/api/me')).json();
    assert.strictEqual(r.ok, false);
  });

  // sockets
  const wsUrl = t => `ws://127.0.0.1:${port}?token=${t}`;
  const wsa = new WebSocket(wsUrl(ta));
  const wsb = new WebSocket(wsUrl(tb));
  const wsc = new WebSocket(wsUrl(tc));
  await Promise.all([wsa, wsb, wsc].map(w => new Promise((res, rej) => {
    w.on('open', res); w.on('error', rej);
  })));

  const inbox = new Map();
  for (const [name, w] of [['a', wsa], ['b', wsb], ['c', wsc]]) {
    inbox.set(name, []);
    w.on('message', raw => inbox.get(name).push(JSON.parse(raw)));
  }
  const send = (w, m) => w.send(JSON.stringify(m));
  const waitFor = (name, pred, ms = 3000) => new Promise((res, rej) => {
    const box = inbox.get(name);
    const t0 = Date.now();
    const tick = () => {
      const i = box.findIndex(pred);
      if (i !== -1) return res(box.splice(i, 1)[0]);
      if (Date.now() - t0 > ms) return rej(new Error('timeout waiting for message'));
      setTimeout(tick, 25);
    };
    tick();
  });
  const clear = () => inbox.forEach(b => b.length = 0);

  await okAsync('presence: ben sees amy come online', async () => {
    // reconnect amy to trigger a fresh presence broadcast
    wsa.close();
    await new Promise(r => setTimeout(r, 300));
    inbox.get('b').length = 0; // drop the offline notice
    const wsa2 = new WebSocket(wsUrl(ta));
    await new Promise((res, rej) => { wsa2.on('open', res); wsa2.on('error', rej); });
    inbox.set('a', []);
    wsa2.on('message', raw => inbox.get('a').push(JSON.parse(raw)));
    const m = await waitFor('b', x => x.t === 'presence' && x.user === 'amy' && x.online === true);
    assert.strictEqual(m.online, true);
    wsa._r = wsa2;
  });

  await okAsync('chat relays between friends', async () => {
    clear();
    (wsa._r || wsa).send(JSON.stringify({ t: 'chat', to: 'ben', text: 'hello ben' }));
    const m = await waitFor('b', x => x.t === 'chat');
    assert.strictEqual(m.from, 'amy');
    assert.strictEqual(m.text, 'hello ben');
  });

  const A = () => wsa._r || wsa;
  await okAsync('chat blocked to non-friend', async () => {
    clear();
    A().send(JSON.stringify({ t: 'chat', to: 'zed', text: 'sneaky' }));
    await new Promise(r => setTimeout(r, 400));
    assert.ok(!inbox.get('c').some(x => x.t === 'chat'), 'cy got a chat from non-friend');
  });

  await okAsync('full call flow: invite -> accept -> signal -> end', async () => {
    clear();
    A().send(JSON.stringify({ t: 'call', to: 'ben', video: true }));
    const inv = await waitFor('b', x => x.t === 'incoming-call');
    assert.strictEqual(inv.from, 'amy');
    assert.strictEqual(inv.video, true);
    send(wsb, { t: 'call-accept', to: 'amy' });
    const acc = await waitFor('a', x => x.t === 'call-accepted');
    assert.strictEqual(acc.from, 'ben');
    A().send(JSON.stringify({ t: 'signal', to: 'ben', data: { kind: 'offer', sdp: 'fake-offer' } }));
    const sig = await waitFor('b', x => x.t === 'signal');
    assert.strictEqual(sig.data.kind, 'offer');
    send(wsb, { t: 'signal', to: 'amy', data: { kind: 'ice', candidate: 'fake' } });
    await waitFor('a', x => x.t === 'signal');
    A().send(JSON.stringify({ t: 'call-end', to: 'ben' }));
    const end = await waitFor('b', x => x.t === 'call-ended');
    assert.strictEqual(end.from, 'amy');
  });

  await okAsync('decline flow', async () => {
    clear();
    A().send(JSON.stringify({ t: 'call', to: 'ben', video: false }));
    await waitFor('b', x => x.t === 'incoming-call');
    send(wsb, { t: 'call-decline', to: 'amy' });
    const d = await waitFor('a', x => x.t === 'call-declined');
    assert.strictEqual(d.from, 'ben');
  });

  await okAsync('busy: third party cannot barge in', async () => {
    clear();
    A().send(JSON.stringify({ t: 'call', to: 'ben', video: true }));
    await waitFor('b', x => x.t === 'incoming-call');
    // cy is not even ben's friend, but busy check happens on amy first anyway;
    // use a proper busy case: ben tries to call amy back while ringing
    send(wsb, { t: 'call', to: 'amy', video: true });
    const f = await waitFor('b', x => x.t === 'call-failed');
    assert.strictEqual(f.reason, 'busy');
    send(wsb, { t: 'call-decline', to: 'amy' });
    await waitFor('a', x => x.t === 'call-declined');
  });

  await okAsync('offline call fails', async () => {
    clear();
    // amy is not friends with cy, and cy IS online; use a friend who is offline:
    // ben logs out (socket close) then amy calls -> offline
    wsb.close();
    await new Promise(r => setTimeout(r, 300));
    A().send(JSON.stringify({ t: 'call', to: 'ben', video: true }));
    const f = await waitFor('a', x => x.t === 'call-failed');
    assert.strictEqual(f.reason, 'offline');
  });

  await okAsync('signal blocked when not in call', async () => {
    clear();
    const wsb2 = new WebSocket(wsUrl(tb));
    await new Promise((res, rej) => { wsb2.on('open', res); wsb2.on('error', rej); });
    inbox.set('b', []);
    wsb2.on('message', raw => inbox.get('b').push(JSON.parse(raw)));
    A().send(JSON.stringify({ t: 'signal', to: 'ben', data: { kind: 'offer', sdp: 'x' } }));
    await new Promise(r => setTimeout(r, 400));
    assert.ok(!inbox.get('b').some(x => x.t === 'signal'), 'signal leaked without a call');
    wsb2.close();
  });

  [wsa._r || wsa, wsb, wsc].forEach(w => { try { w.close(); } catch (e) {} });
  await new Promise(r => server.close(r));
}

live().then(() => {
  console.log(`\n${passed} passed${process.exitCode ? ' (with failures)' : ''}`);
});
