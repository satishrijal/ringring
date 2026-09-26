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
      '<div class="friend-name">' + escapeHtml(f.username) + '</div>' +
      (unread[f.username] ? '<div class="badge">' + unread[f.username] + '</div>' : '') +
      '<div class="dot' + (f.online ? ' online' : '') + '"></div>' +
      '<button class="btn-icon" data-call="audio" title="Voice call"' + (f.online ? '' : ' disabled style="opacity:.3"') + '>📞</button>' +
      '<button class="btn-icon" data-call="video" title="Video call"' + (f.online ? '' : ' disabled style="opacity:.3"') + '>🎥</button>';
    row.querySelector('.friend-name').onclick = () => openChat(f.username);
    row.querySelector('.avatar').onclick = () => openChat(f.username);
    const [bAudio, bVideo] = [row.querySelector('[data-call=audio]'), row.querySelector('[data-call=video]')];
    bAudio.onclick = e => { e.stopPropagation(); startCall(f.username, false); };
    bVideo.onclick = e => { e.stopPropagation(); startCall(f.username, true); };
    list.appendChild(row);
  }
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
  connectWs();
  // keep the socket warm on mobile
  setInterval(() => send({ t: 'ping' }), 25000);
}

boot();
