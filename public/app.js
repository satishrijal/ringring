'use strict';
/* RingRing client: auth, friends, chat, WebRTC calls */

const $ = id => document.getElementById(id);
const api = {
  token: localStorage.getItem('rr_token') || null,
  async call(path, opts = {}) {
    const res = await fetch(path, {
      ...opts,
      headers: { 'Content-Type': 'application/json', ...(this.token ? { Authorization: 'Bearer ' + this.token } : {}), ...(opts.headers || {}) },
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok && res.status === 401) { this.logout(); }
    return data;
  },
  logout() {
    this.token = null;
    localStorage.removeItem('rr_token');
    location.reload();
  },
};

let ME = null;                 // my username
let FRIENDS = [];              // [{username, online}]
let INCOMING = [];
let ws = null;
let chatPeer = null;           // username currently chatting with
let unread = {};               // username -> count
let chatLog = {};              // username -> [{me, text}]

/* ---------------- auth ---------------- */
let mode = 'login';
function setMode(m) {
  mode = m;
  $('tab-login').classList.toggle('active', m === 'login');
  $('tab-register').classList.toggle('active', m === 'register');
  $('auth-go').textContent = m === 'login' ? 'Log in' : 'Sign up';
  $('auth-error').textContent = '';
}
$('tab-login').onclick = () => setMode('login');
$('tab-register').onclick = () => setMode('register');

async function doAuth() {
  const username = $('auth-user').value.trim();
  const password = $('auth-pass').value;
  $('auth-error').textContent = '';
  if (!username || !password) { $('auth-error').textContent = 'Enter a username and password'; return; }
  const r = await api.call(mode === 'login' ? '/api/login' : '/api/register', {
    method: 'POST', body: JSON.stringify({ username, password }),
  });
  if (!r.ok) { $('auth-error').textContent = r.error || 'Something went wrong'; return; }
  api.token = r.token;
  localStorage.setItem('rr_token', r.token);
  boot();
}
$('auth-go').onclick = doAuth;
$('auth-pass').addEventListener('keydown', e => { if (e.key === 'Enter') doAuth(); });
$('auth-user').addEventListener('keydown', e => { if (e.key === 'Enter') doAuth(); });

$('btn-logout').onclick = async () => {
  try { await api.call('/api/logout', { method: 'POST' }); } catch (e) {}
  api.logout();
};

/* ---------------- websocket ---------------- */
function connectWs() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(proto + '://' + location.host + '?token=' + encodeURIComponent(api.token));
  ws.onopen = () => { ws.send(JSON.stringify({ t: 'ping' })); };
  ws.onclose = () => {
    // try to reconnect unless we logged out
    if (api.token) setTimeout(connectWs, 3000);
  };
  ws.onmessage = ev => {
    let m;
    try { m = JSON.parse(ev.data); } catch (e) { return; }
    onServerMsg(m);
  };
}
function send(m) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(m)); }

/* ---------------- main view ---------------- */
async function refreshMe() {
  const r = await api.call('/api/me');
  if (!r.ok) return;
  ME = r.username;
  FRIENDS = r.friends;
  INCOMING = r.incoming;
  $('me-name').textContent = '@' + ME;
  renderFriends();
  renderRequests();
}

function renderFriends() {
  const list = $('friends-list');
  const online = FRIENDS.filter(f => f.online).length;
  $('online-count').textContent = online ? `(${online} online)` : '';
  if (!FRIENDS.length) {
    list.innerHTML = '<div class="empty">No friends yet — add someone above 👆</div>';
    return;
  }
  list.innerHTML = '';
  for (const f of FRIENDS) {
    const row = document.createElement('div');
    row.className = 'friend-row';
    row.innerHTML =
      '<div class="avatar">👤</div>' +
      '<div class="friend-name">' + escapeHtml(f.username) + streakBadge(f) + '</div>' +
      (unread[f.username] ? '<div class="badge">' + unread[f.username] + '</div>' : '') +
      '<div class="dot' + (f.online ? ' online' : '') + '"></div>' +
      '<button class="btn-icon" data-snap="1" title="Send a one-time photo">👻</button>' +
      '<button class="btn-icon" data-call="audio" title="Voice call"' + (f.online ? '' : ' disabled style="opacity:.3"') + '>📞</button>' +
      '<button class="btn-icon" data-call="video" title="Video call"' + (f.online ? '' : ' disabled style="opacity:.3"') + '>🎥</button>';
    row.querySelector('.friend-name').onclick = () => openChat(f.username);
    row.querySelector('.avatar').onclick = () => openChat(f.username);
    const [bAudio, bVideo] = [row.querySelector('[data-call=audio]'), row.querySelector('[data-call=video]')];
    bAudio.onclick = e => { e.stopPropagation(); startCall(f.username, false); };
    bVideo.onclick = e => { e.stopPropagation(); startCall(f.username, true); };
    row.querySelector('[data-snap]').onclick = e => { e.stopPropagation(); sendSnapTo(f.username); };
    list.appendChild(row);
  }
}

// 🔥 streak badge: only when the streak is still alive (today or yesterday)
function dateStr(ts) {
  const d = new Date(ts === undefined ? Date.now() : ts);
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}
function streakBadge(f) {
  if (!f.streak || !f.streak.count) return '';
  const t = dateStr(), y = dateStr(Date.now() - 864e5);
  if (f.streak.last === t || f.streak.last === y) return ' <span class="streak" title="Snap streak">🔥' + f.streak.count + '</span>';
  return '';
}

function renderRequests() {
  const sec = $('requests');
  const list = $('requests-list');
  if (!INCOMING.length) { sec.classList.add('hidden'); return; }
  sec.classList.remove('hidden');
  list.innerHTML = '';
  for (const r of INCOMING) {
    const row = document.createElement('div');
    row.className = 'req-row';
    row.innerHTML = '<div class="avatar">👤</div><div class="friend-name">' + escapeHtml(r.username) + '</div>' +
      '<div class="req-btns"><button class="req-accept">Accept</button><button class="req-decline">Decline</button></div>';
    row.querySelector('.req-accept').onclick = () => respondRequest(r.username, true);
    row.querySelector('.req-decline').onclick = () => respondRequest(r.username, false);
    list.appendChild(row);
  }
}

async function respondRequest(username, accept) {
  await api.call('/api/friends/respond', { method: 'POST', body: JSON.stringify({ username, accept }) });
  refreshMe();
}

$('add-go').onclick = async () => {
  const username = $('add-input').value.trim();
  $('add-error').textContent = '';
  if (!username) return;
  const r = await api.call('/api/friends/request', { method: 'POST', body: JSON.stringify({ username }) });
  if (!r.ok) { $('add-error').textContent = r.error || 'Could not send request'; return; }
  $('add-input').value = '';
  toast('Request sent to @' + username);
  refreshMe();
};

function toast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.remove('hidden');
  clearTimeout(t._h);
  t._h = setTimeout(() => t.classList.add('hidden'), 2500);
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/* ---------------- chat ---------------- */
function openChat(username) {
  chatPeer = username;
  unread[username] = 0;
  $('chat-name').textContent = '@' + username;
  const f = FRIENDS.find(x => x.username === username);
  $('chat-online').className = 'dot' + (f && f.online ? ' online' : '');
  $('chat-panel').classList.remove('hidden');
  renderChat();
  renderFriends();
  setTimeout(() => $('chat-input').focus(), 50);
}
$('chat-back').onclick = () => { chatPeer = null; $('chat-panel').classList.add('hidden'); };
$('chat-audio').onclick = () => { if (chatPeer) { $('chat-panel').classList.add('hidden'); startCall(chatPeer, false); } };
$('chat-video').onclick = () => { if (chatPeer) { $('chat-panel').classList.add('hidden'); startCall(chatPeer, true); } };

function renderChat() {
  const box = $('chat-messages');
  box.innerHTML = '';
  const log = chatLog[chatPeer] || [];
  for (const m of log) {
    const d = document.createElement('div');
    d.className = 'msg ' + (m.me ? 'me' : 'them');
    d.textContent = m.text;
    box.appendChild(d);
  }
  box.scrollTop = box.scrollHeight;
}

function sendChat() {
  const inp = $('chat-input');
  const text = inp.value.trim();
  if (!text || !chatPeer) return;
  send({ t: 'chat', to: chatPeer, text });
  (chatLog[chatPeer] = chatLog[chatPeer] || []).push({ me: true, text });
  inp.value = '';
  renderChat();
}
$('chat-send').onclick = sendChat;
$('chat-input').addEventListener('keydown', e => { if (e.key === 'Enter') sendChat(); });

/* ---------------- calls (WebRTC) ---------------- */
const PC_CONFIG = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }, { urls: 'stun:stun1.l.google.com:19302' }] };
const call = { pc: null, stream: null, peer: null, isCaller: false, wantVideo: true, timerH: null, startTs: 0, audioCtx: null, ringH: null };

function showCallUI(peer, video) {
  $('call').classList.remove('hidden');
  $('call-peer-name').textContent = '@' + peer;
  $('call-status').textContent = 'Connecting…';
  $('call-timer').textContent = '';
  $('remote-video').style.display = video ? '' : 'none';
  $('remote-audio-only').classList.toggle('hidden', video);
  $('call-camera').style.display = video ? '' : 'none';
}

function startTimer() {
  call.startTs = Date.now();
  clearInterval(call.timerH);
  call.timerH = setInterval(() => {
    const s = Math.floor((Date.now() - call.startTs) / 1000);
    $('call-timer').textContent = String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0');
  }, 1000);
}

function stopRingtone() {
  clearInterval(call.ringH); call.ringH = null;
  if (call.audioCtx) { call.audioCtx.close().catch(() => {}); call.audioCtx = null; }
}

function playRingtone() {
  try {
    stopRingtone();
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    call.audioCtx = ctx;
    let on = true;
    const beep = () => {
      if (!on) return;
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.connect(g); g.connect(ctx.destination);
      o.frequency.value = 440; o.type = 'sine';
      g.gain.setValueAtTime(0.25, ctx.currentTime);
      g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.4);
      o.start(); o.stop(ctx.currentTime + 0.45);
      setTimeout(() => {
        if (!on) return;
        const o2 = ctx.createOscillator(), g2 = ctx.createGain();
        o2.connect(g2); g2.connect(ctx.destination);
        o2.frequency.value = 480; o2.type = 'sine';
        g2.gain.setValueAtTime(0.25, ctx.currentTime);
        g2.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.4);
        o2.start(); o2.stop(ctx.currentTime + 0.45);
      }, 500);
    };
    beep();
    call.ringH = setInterval(() => { if (on) beep(); }, 2200);
    call._ringOn = () => on;
    call._ringOff = () => { on = false; };
  } catch (e) {}
}

async function makePeerConnection() {
  const pc = new RTCPeerConnection(PC_CONFIG);
  pc.onicecandidate = e => {
    if (e.candidate) send({ t: 'signal', to: call.peer, data: { kind: 'ice', candidate: e.candidate } });
  };
  pc.ontrack = e => {
    const v = $('remote-video');
    v.srcObject = e.streams[0];
    if (call.wantVideo) {
      v.style.display = '';
      $('remote-audio-only').classList.add('hidden');
    }
  };
  pc.onconnectionstatechange = () => {
    if (pc.connectionState === 'connected') { $('call-status').textContent = ''; startTimer(); }
    else if (pc.connectionState === 'failed') { toast('Connection failed — network blocked?'); hangUp(false); }
  };
  return pc;
}

async function startCall(username, video) {
  if (call.pc) { toast('Already in a call'); return; }
  call.peer = username; call.isCaller = true; call.wantVideo = video;
  send({ t: 'call', to: username, video });
  showCallUI(username, video);
  $('call-status').textContent = 'Ringing…';
  playRingtone();
}

async function onCallAccepted(video) {
  stopRingtone();
  try {
    call.stream = await navigator.mediaDevices.getUserMedia({ video: call.wantVideo, audio: true });
  } catch (e) { toast('Camera/mic blocked — check permissions'); hangUp(true); return; }
  $('local-video').srcObject = call.stream;
  call.pc = await makePeerConnection();
  call.stream.getTracks().forEach(t => call.pc.addTrack(t, call.stream));
  const offer = await call.pc.createOffer();
  await call.pc.setLocalDescription(offer);
  send({ t: 'signal', to: call.peer, data: { kind: 'offer', sdp: offer } });
  $('call-status').textContent = 'Connecting…';
}

async function onIncomingCall(from, video) {
  if (call.pc) { send({ t: 'call-decline', to: from }); return; } // auto-busy
  call.peer = from; call.isCaller = false; call.wantVideo = video;
  $('incoming-name').textContent = '@' + from;
  $('incoming-type').textContent = video ? 'Video call…' : 'Voice call…';
  $('incoming-video').style.display = video ? '' : 'none';
  $('incoming').classList.remove('hidden');
  playRingtone();
}

async function acceptCall(withVideo) {
  stopRingtone();
  $('incoming').classList.add('hidden');
  try {
    call.stream = await navigator.mediaDevices.getUserMedia({ video: withVideo, audio: true });
  } catch (e) { toast('Camera/mic blocked — check permissions'); send({ t: 'call-decline', to: call.peer }); call.peer = null; return; }
  $('local-video').srcObject = call.stream;
  call.pc = await makePeerConnection();
  call.stream.getTracks().forEach(t => call.pc.addTrack(t, call.stream));
  send({ t: 'call-accept', to: call.peer });
  showCallUI(call.peer, call.wantVideo);
  $('call-status').textContent = 'Connecting…';
  // camera button hidden if we answered audio-only
  $('call-camera').style.display = withVideo ? '' : 'none';
}

$('incoming-video').onclick = () => acceptCall(true);
$('incoming-audio').onclick = () => acceptCall(false);
$('incoming-decline').onclick = () => {
  stopRingtone();
  $('incoming').classList.add('hidden');
  send({ t: 'call-decline', to: call.peer });
  call.peer = null;
};

async function onSignal(from, data) {
  if (!call.pc) return;
  try {
    if (data.kind === 'offer') {
      await call.pc.setRemoteDescription(new RTCSessionDescription(data.sdp));
      const answer = await call.pc.createAnswer();
      await call.pc.setLocalDescription(answer);
      send({ t: 'signal', to: call.peer, data: { kind: 'answer', sdp: answer } });
    } else if (data.kind === 'answer') {
      await call.pc.setRemoteDescription(new RTCSessionDescription(data.sdp));
    } else if (data.kind === 'ice' && data.candidate) {
      await call.pc.addIceCandidate(new RTCIceCandidate(data.candidate));
    }
  } catch (e) {}
}

function hangUp(notify = true) {
  if (notify && call.peer) send({ t: 'call-end', to: call.peer });
  cleanupCall();
  if (notify) toast('Call ended');
}

function cleanupCall() {
  stopRingtone();
  clearInterval(call.timerH);
  if (call.pc) { try { call.pc.close(); } catch (e) {} call.pc = null; }
  if (call.stream) { call.stream.getTracks().forEach(t => t.stop()); call.stream = null; }
  $('remote-video').srcObject = null;
  $('local-video').srcObject = null;
  call.peer = null; call.isCaller = false;
  $('call').classList.add('hidden');
  $('incoming').classList.add('hidden');
  $('call-camera').style.display = '';
  $('call-mute').classList.remove('off');
  $('call-camera').classList.remove('off');
  $('call-mute').textContent = '🎤';
  $('call-camera').textContent = '📷';
}

$('call-hangup').onclick = () => hangUp(true);
$('call-mute').onclick = () => {
  if (!call.stream) return;
  const track = call.stream.getAudioTracks()[0];
  if (!track) return;
  track.enabled = !track.enabled;
  $('call-mute').classList.toggle('off', !track.enabled);
  $('call-mute').textContent = track.enabled ? '🎤' : '🔇';
};
$('call-camera').onclick = () => {
  if (!call.stream) return;
  const track = call.stream.getVideoTracks()[0];
  if (!track) return;
  track.enabled = !track.enabled;
  $('call-camera').classList.toggle('off', !track.enabled);
  $('call-camera').textContent = track.enabled ? '📷' : '🚫';
};
// caller cancelling while ringing = hang up button
// (call overlay doubles as the ringing screen for the caller)

/* ---------------- server messages ---------------- */
function onServerMsg(m) {
  switch (m.t) {
    case 'presence': {
      const f = FRIENDS.find(x => x.username === m.user);
      if (f) { f.online = m.online; renderFriends(); }
      if (chatPeer === m.user) {
        const fr = FRIENDS.find(x => x.username === m.user);
        $('chat-online').className = 'dot' + (fr && fr.online ? ' online' : '');
      }
      break;
    }
    case 'friend-request':
    case 'friend-update':
      refreshMe();
      if (m.t === 'friend-request') toast('New friend request from @' + m.from);
      break;
    case 'chat': {
      (chatLog[m.from] = chatLog[m.from] || []).push({ me: false, text: m.text });
      if (chatPeer === m.from) renderChat();
      else { unread[m.from] = (unread[m.from] || 0) + 1; renderFriends(); toast('@' + m.from + ': ' + m.text.slice(0, 40)); }
      break;
    }
    case 'incoming-call':
      onIncomingCall(m.from, m.video !== false);
      break;
    case 'call-accepted':
      onCallAccepted(m.video !== false);
      break;
    case 'call-declined':
      stopRingtone(); cleanupCall(); toast('@' + m.from + ' declined');
      break;
    case 'call-failed': {
      stopRingtone(); cleanupCall();
      const why = { offline: 'is offline', busy: 'is busy', 'not-friends': 'is not your friend', self: '??' }[m.reason] || 'failed';
      toast('Call failed — ' + why);
      break;
    }
    case 'call-cancelled':
      stopRingtone(); cleanupCall(); toast('Call cancelled');
      break;
    case 'call-ended':
      cleanupCall(); toast('Call ended');
      break;
    case 'signal':
      onSignal(m.from, m.data);
      break;
  }
}

/* ---------------- boot ---------------- */
async function boot() {
  if (!api.token) {
    $('view-auth').classList.remove('hidden');
    return;
  }
  const r = await api.call('/api/me');
  if (!r.ok) { // bad token
    api.token = null;
    localStorage.removeItem('rr_token');
    $('view-auth').classList.remove('hidden');
    return;
  }
  $('view-auth').classList.add('hidden');
  $('view-main').classList.remove('hidden');
  await refreshMe();
  await refreshNotifs();
  await refreshGroups();
  await refreshSnaps();
  connectWs();
  // keep the socket warm on mobile
  setInterval(() => send({ t: 'ping' }), 25000);
}

boot();

/* ================================================================
   NEW FEATURES: search, notifications, groups, group calls, snaps
   ================================================================ */

/* ---------------- notifications ---------------- */
let NOTIFS = [];

function timeAgo(at) {
  const s = Math.floor((Date.now() - at) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return Math.floor(s / 60) + 'm ago';
  if (s < 86400) return Math.floor(s / 3600) + 'h ago';
  return Math.floor(s / 86400) + 'd ago';
}

async function refreshNotifs() {
  const r = await api.call('/api/notifications');
  if (!r.ok) return;
  NOTIFS = r.notifications;
  const c = $('bell-count');
  if (r.unread > 0) { c.textContent = r.unread > 9 ? '9+' : r.unread; c.classList.remove('hidden'); }
  else c.classList.add('hidden');
  renderNotifs();
}

function renderNotifs() {
  const box = $('notif-list');
  box.innerHTML = NOTIFS.length ? '' : '<div class="empty">Nothing yet</div>';
  for (const n of NOTIFS.slice(0, 20)) {
    const d = document.createElement('div');
    d.className = 'notif' + (n.read ? '' : ' unread');
    d.innerHTML = '<div>' + escapeHtml(n.text) + '</div><div class="notif-at">' + timeAgo(n.at) + '</div>';
    box.appendChild(d);
  }
}

$('bell').onclick = async () => {
  const p = $('notif-panel');
  p.classList.toggle('hidden');
  if (!p.classList.contains('hidden')) {
    try { await api.call('/api/notifications/read', { method: 'POST' }); } catch (e) {}
    refreshNotifs();
  }
};

/* ---------------- user search ---------------- */
let searchT = null;
$('search-go').onclick = doSearch;
$('search-input').addEventListener('input', () => { clearTimeout(searchT); searchT = setTimeout(doSearch, 400); });
$('search-input').addEventListener('keydown', e => { if (e.key === 'Enter') doSearch(); });

async function doSearch() {
  const q = $('search-input').value.trim();
  const box = $('search-results');
  if (q.length < 2) { box.innerHTML = q ? '<div class="empty">Type at least 2 letters</div>' : ''; return; }
  const r = await api.call('/api/users/search?q=' + encodeURIComponent(q));
  if (!r.ok) return;
  box.innerHTML = '';
  if (!r.users.length) { box.innerHTML = '<div class="empty">No one found for "' + escapeHtml(q) + '"</div>'; return; }
  for (const u of r.users) {
    const row = document.createElement('div');
    row.className = 'friend-row';
    let action = '';
    if (u.status === 'none') action = '<button class="req-accept">Add</button>';
    else if (u.status === 'friend') action = '<span class="muted">✓ friends</span>';
    else if (u.status === 'incoming') action = '<span class="muted">check requests ↑</span>';
    else action = '<span class="muted">requested</span>';
    row.innerHTML = '<div class="avatar">👤</div><div class="friend-name">' + escapeHtml(u.username) + '</div>' +
      '<div class="dot' + (u.online ? ' online' : '') + '"></div>' + action;
    const btn = row.querySelector('.req-accept');
    if (btn) btn.onclick = async () => {
      const rr = await api.call('/api/friends/request', { method: 'POST', body: JSON.stringify({ username: u.username }) });
      if (rr.ok) { toast('Request sent to @' + u.username); doSearch(); refreshMe(); }
      else toast(rr.error || 'Could not send request');
    };
    box.appendChild(row);
  }
}

/* ---------------- groups ---------------- */
let GROUPS = [];

async function refreshGroups() {
  const r = await api.call('/api/groups');
  if (!r.ok) return;
  GROUPS = r.groups;
  const list = $('groups-list');
  list.innerHTML = GROUPS.length ? '' : '<div class="empty">No groups yet — make one 👆</div>';
  for (const g of GROUPS) {
    const row = document.createElement('div');
    row.className = 'friend-row';
    row.innerHTML = '<div class="avatar">👥</div>' +
      '<div class="friend-name">' + escapeHtml(g.name) +
      '<div class="muted small">' + g.members.map(escapeHtml).join(', ') + '</div></div>' +
      '<button class="btn-icon" data-gcall="audio" title="Group voice call">📞</button>' +
      '<button class="btn-icon" data-gcall="video" title="Group video call">🎥</button>';
    row.querySelector('[data-gcall=audio]').onclick = () => startGroupCall(g.id, false);
    row.querySelector('[data-gcall=video]').onclick = () => startGroupCall(g.id, true);
    list.appendChild(row);
  }
}

$('group-new').onclick = () => {
  const form = $('group-form');
  form.classList.toggle('hidden');
  if (form.classList.contains('hidden')) return;
  const pick = $('group-pick');
  pick.innerHTML = FRIENDS.length ? '' : '<div class="empty">Add friends first</div>';
  for (const f of FRIENDS) {
    const lab = document.createElement('label');
    lab.className = 'pick-row';
    lab.innerHTML = '<input type="checkbox" value="' + escapeHtml(f.username) + '"> ' + escapeHtml(f.username);
    pick.appendChild(lab);
  }
  $('group-name').value = '';
};
$('group-cancel').onclick = () => $('group-form').classList.add('hidden');
$('group-create').onclick = async () => {
  const name = $('group-name').value.trim();
  const members = [...document.querySelectorAll('#group-pick input:checked')].map(i => i.value);
  if (name.length < 2) { toast('Give the group a name'); return; }
  if (!members.length) { toast('Pick at least one friend'); return; }
  const r = await api.call('/api/groups', { method: 'POST', body: JSON.stringify({ name, members }) });
  if (!r.ok) { toast(r.error || 'Could not create group'); return; }
  $('group-form').classList.add('hidden');
  toast('Group "' + name + '" created 👥');
  refreshGroups();
};

/* ---------------- group calls (mesh WebRTC) ---------------- */
const gcall = { id: null, name: '', video: true, stream: null, peers: new Map(), isJoiner: false };

function showGroupUI() {
  $('gcall').classList.remove('hidden');
  $('gcall-name').textContent = '👥 ' + gcall.name;
  $('gcall-status').textContent = 'Waiting for others to join…';
  renderGroupGrid();
}

function renderGroupGrid() {
  const grid = $('gcall-grid');
  grid.innerHTML = '';
  // local tile
  const me = document.createElement('div');
  me.className = 'gtile';
  me.innerHTML = '<video autoplay playsinline muted></video><div class="gname">you</div>';
  me.querySelector('video').srcObject = gcall.stream;
  grid.appendChild(me);
  for (const [, p] of gcall.peers) {
    const d = document.createElement('div');
    d.className = 'gtile';
    d.id = 'gtile-' + p.key;
    d.innerHTML = '<video autoplay playsinline></video><div class="gname">' + escapeHtml(p.name) + '</div>';
    if (p.stream) d.querySelector('video').srcObject = p.stream;
    grid.appendChild(d);
  }
  const n = gcall.peers.size + 1;
  grid.style.gridTemplateColumns = n <= 2 ? '1fr' : '1fr 1fr';
}

function setupGroupPc(pc, peerKey, peerName) {
  pc.onicecandidate = e => {
    if (e.candidate) send({ t: 'group-signal', groupId: gcall.id, to: peerName, data: { kind: 'ice', candidate: e.candidate } });
  };
  pc.ontrack = e => {
    const p = gcall.peers.get(peerKey);
    if (p) {
      p.stream = e.streams[0];
      const tile = document.querySelector('#gtile-' + peerKey + ' video');
      if (tile) tile.srcObject = e.streams[0];
    }
    $('gcall-status').textContent = '';
  };
  pc.onconnectionstatechange = () => {
    if (pc.connectionState === 'failed') hangUpGroupPeer(peerKey);
  };
}

async function groupPeerOffer(peerName) {
  const peerKey = peerName.toLowerCase();
  if (gcall.peers.has(peerKey)) return;
  const pc = new RTCPeerConnection(PC_CONFIG);
  gcall.peers.set(peerKey, { pc, name: peerName, key: peerKey, stream: null });
  setupGroupPc(pc, peerKey, peerName);
  gcall.stream.getTracks().forEach(t => pc.addTrack(t, gcall.stream));
  try {
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    send({ t: 'group-signal', groupId: gcall.id, to: peerName, data: { kind: 'offer', sdp: offer } });
  } catch (e) {}
  renderGroupGrid();
}

async function onGroupSignal(from, data) {
  const peerKey = from.toLowerCase();
  let p = gcall.peers.get(peerKey);
  try {
    if (data.kind === 'offer') {
      if (!p) {
        const pc = new RTCPeerConnection(PC_CONFIG);
        p = { pc, name: from, key: peerKey, stream: null };
        gcall.peers.set(peerKey, p);
        setupGroupPc(pc, peerKey, from);
        gcall.stream.getTracks().forEach(t => pc.addTrack(t, gcall.stream));
        renderGroupGrid();
      }
      await p.pc.setRemoteDescription(new RTCSessionDescription(data.sdp));
      const answer = await p.pc.createAnswer();
      await p.pc.setLocalDescription(answer);
      send({ t: 'group-signal', groupId: gcall.id, to: from, data: { kind: 'answer', sdp: answer } });
    } else if (data.kind === 'answer' && p) {
      await p.pc.setRemoteDescription(new RTCSessionDescription(data.sdp));
    } else if (data.kind === 'ice' && p && data.candidate) {
      await p.pc.addIceCandidate(new RTCIceCandidate(data.candidate));
    }
  } catch (e) {}
}

function hangUpGroupPeer(peerKey) {
  const p = gcall.peers.get(peerKey);
  if (!p) return;
  try { p.pc.close(); } catch (e) {}
  gcall.peers.delete(peerKey);
  if (gcall.id) renderGroupGrid();
}

async function startGroupCall(groupId, video) {
  if (gcall.id || call.pc) { toast('Already in a call'); return; }
  const g = GROUPS.find(x => x.id === groupId);
  if (!g) return;
  gcall.id = groupId; gcall.name = g.name; gcall.video = video; gcall.isJoiner = false;
  try {
    gcall.stream = await navigator.mediaDevices.getUserMedia({ video, audio: true });
  } catch (e) { toast('Camera/mic blocked — check permissions'); gcall.id = null; return; }
  playRingtone();
  showGroupUI();
  send({ t: 'group-call', groupId, video });
  setTimeout(() => { if (gcall.id === groupId) stopRingtone(); }, 15000);
}

async function joinGroupCall(groupId, groupName, video) {
  if (gcall.id || call.pc) { toast('Already in a call'); return; }
  gcall.id = groupId; gcall.name = groupName; gcall.video = video; gcall.isJoiner = true;
  $('gincoming').classList.add('hidden');
  try {
    gcall.stream = await navigator.mediaDevices.getUserMedia({ video, audio: true });
  } catch (e) { toast('Camera/mic blocked — check permissions'); gcall.id = null; return; }
  showGroupUI();
  send({ t: 'group-join', groupId, video });
}

function leaveGroupCall(notify = true) {
  if (notify && gcall.id) send({ t: 'group-leave', groupId: gcall.id });
  stopRingtone();
  for (const [, p] of gcall.peers) { try { p.pc.close(); } catch (e) {} }
  gcall.peers.clear();
  if (gcall.stream) { gcall.stream.getTracks().forEach(t => t.stop()); gcall.stream = null; }
  gcall.id = null; gcall.name = '';
  $('gcall').classList.add('hidden');
  $('gincoming').classList.add('hidden');
  $('gcall-mute').classList.remove('off'); $('gcall-mute').textContent = '🎤';
  $('gcall-camera').classList.remove('off'); $('gcall-camera').textContent = '📷';
}

$('gcall-hangup').onclick = () => { leaveGroupCall(true); toast('Left the group call'); };
$('gcall-mute').onclick = () => {
  if (!gcall.stream) return;
  const track = gcall.stream.getAudioTracks()[0];
  if (!track) return;
  track.enabled = !track.enabled;
  $('gcall-mute').classList.toggle('off', !track.enabled);
  $('gcall-mute').textContent = track.enabled ? '🎤' : '🔇';
};
$('gcall-camera').onclick = () => {
  if (!gcall.stream) return;
  const track = gcall.stream.getVideoTracks()[0];
  if (!track) return;
  track.enabled = !track.enabled;
  $('gcall-camera').classList.toggle('off', !track.enabled);
  $('gcall-camera').textContent = track.enabled ? '📷' : '🚫';
};

let gIncomingInfo = null;
$('gincoming-decline').onclick = () => { $('gincoming').classList.add('hidden'); gIncomingInfo = null; };
$('gincoming-join').onclick = () => {
  if (!gIncomingInfo) return;
  const { groupId, groupName, video } = gIncomingInfo;
  gIncomingInfo = null;
  joinGroupCall(groupId, groupName, video);
};

/* ---------------- snaps: one-time photos ---------------- */
const snapInput = document.createElement('input');
snapInput.type = 'file';
snapInput.accept = 'image/*';
let snapTarget = null;

function sendSnapTo(username) {
  snapTarget = username;
  snapInput.click();
}
$('chat-snap').onclick = () => { if (chatPeer) sendSnapTo(chatPeer); };

snapInput.onchange = async () => {
  const f = snapInput.files[0];
  snapInput.value = '';
  if (!f || !snapTarget) return;
  const target = snapTarget;
  snapTarget = null;
  try {
    toast('Sending snap…');
    const dataUrl = await resizeImage(f, 1280);
    const r = await api.call('/api/snaps', { method: 'POST', body: JSON.stringify({ to: target, photo: dataUrl }) });
    if (r.ok) toast('👻 Snap sent to @' + target);
    else toast(r.error || 'Snap failed');
  } catch (e) { toast('Could not read that photo'); }
};

function resizeImage(file, maxDim) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      let w = img.width, h = img.height;
      const s = Math.min(1, maxDim / Math.max(w, h));
      w = Math.max(1, Math.round(w * s)); h = Math.max(1, Math.round(h * s));
      const c = document.createElement('canvas');
      c.width = w; c.height = h;
      c.getContext('2d').drawImage(img, 0, 0, w, h);
      URL.revokeObjectURL(url);
      resolve(c.toDataURL('image/jpeg', 0.8));
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('bad image')); };
    img.src = url;
  });
}

async function refreshSnaps() {
  const r = await api.call('/api/snaps');
  if (!r.ok) return;
  const list = $('snaps-list');
  list.innerHTML = r.snaps.length ? '' : '<div class="empty">No new snaps — send one with 👻</div>';
  for (const s of r.snaps) {
    const row = document.createElement('div');
    row.className = 'friend-row snap-row';
    row.innerHTML = '<div class="avatar">👻</div>' +
      '<div class="friend-name">' + escapeHtml(s.from) + '<div class="muted small">tap to view once · ' + timeAgo(s.at) + '</div></div>';
    row.onclick = () => viewSnap(s);
    list.appendChild(row);
  }
}

let snapTimerH = null;
function viewSnap(s) {
  const v = $('snap-view');
  const img = $('snap-img');
  v.classList.remove('hidden');
  v.onclick = closeSnap;
  img.onerror = () => { toast('That snap is gone 👻'); closeSnap(); };
  // loading this URL deletes the snap on the server — it can never load twice
  img.src = '/api/snaps/' + s.id + '/photo?token=' + encodeURIComponent(api.token);
  let left = 10;
  $('snap-timer').textContent = left;
  clearInterval(snapTimerH);
  snapTimerH = setInterval(() => {
    left--;
    if (left <= 0) closeSnap();
    else $('snap-timer').textContent = left;
  }, 1000);
}
function closeSnap() {
  clearInterval(snapTimerH);
  snapTimerH = null;
  $('snap-view').classList.add('hidden');
  $('snap-img').removeAttribute('src');
  refreshSnaps();
  refreshMe(); // streak may have changed
}

/* ---------------- new server messages ---------------- */
const _onServerMsg = onServerMsg;
onServerMsg = function (m) {
  switch (m.t) {
    case 'notification':
      refreshNotifs();
      toast(m.n ? m.n.text : 'New notification');
      break;
    case 'groups-changed':
      refreshGroups();
      break;
    case 'snap':
      toast('👻 New snap from @' + m.from);
      refreshSnaps();
      refreshNotifs();
      break;
    case 'snap-viewed':
      toast('👻 @' + m.by + ' viewed your snap' + (m.streak > 1 ? ' — 🔥 streak ' + m.streak : ''));
      refreshMe();
      break;
    case 'group-incoming':
      if (gcall.id || call.pc) break; // busy — ignore
      gIncomingInfo = { groupId: m.groupId, groupName: m.groupName, video: m.video !== false };
      $('gincoming-name').textContent = m.groupName;
      $('gincoming-type').textContent = '@' + m.from + ' started a ' + (m.video !== false ? 'video' : 'voice') + ' call…';
      $('gincoming').classList.remove('hidden');
      playRingtone();
      setTimeout(() => {
        if (gIncomingInfo && gIncomingInfo.groupId === m.groupId) {
          $('gincoming').classList.add('hidden');
          gIncomingInfo = null;
          stopRingtone();
        }
      }, 30000);
      break;
    case 'group-peers':
      // I joined: offer to everyone already in the room
      stopRingtone();
      for (const peer of m.peers || []) groupPeerOffer(peer);
      if (!(m.peers || []).length) $('gcall-status').textContent = 'Waiting for others to join…';
      else $('gcall-status').textContent = '';
      break;
    case 'group-peer-joined':
      toast('👥 @' + m.user + ' joined');
      if (!gcall.peers.has(m.user.toLowerCase())) {
        // they will offer to me; add a placeholder tile meanwhile
        const pc = new RTCPeerConnection(PC_CONFIG);
        if (gcall.stream) gcall.stream.getTracks().forEach(t => pc.addTrack(t, gcall.stream));
        gcall.peers.set(m.user.toLowerCase(), { pc, name: m.user, key: m.user.toLowerCase(), stream: null });
        setupGroupPc(pc, m.user.toLowerCase(), m.user);
        renderGroupGrid();
      }
      $('gcall-status').textContent = '';
      break;
    case 'group-signal':
      if (m.groupId === gcall.id) onGroupSignal(m.from, m.data);
      break;
    case 'group-peer-left':
      hangUpGroupPeer(m.user.toLowerCase());
      toast('👥 @' + m.user + ' left');
      break;
    case 'group-join-failed':
      stopRingtone();
      leaveGroupCall(false);
      toast('That group call already ended');
      break;
    default:
      _onServerMsg(m);
  }
};
