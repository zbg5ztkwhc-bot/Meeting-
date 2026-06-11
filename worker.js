// Cloudflare Worker — serves the app HTML and proxies Cloudflare RealtimeKit REST API.
export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === '/health') {
      return new Response('OK', { status: 200 });
    }

    if (url.pathname.startsWith('/api/rtk/')) {
      return handleRTK(request, env, url);
    }

    // Serve the app for all other GET requests
    if (request.method === 'GET') {
      return new Response(HTML, {
        headers: { 'Content-Type': 'text/html; charset=utf-8' }
      });
    }

    return new Response('Not found', { status: 404 });
  }
};

function rtkBase(env) {
  return `https://api.cloudflare.com/client/v4/accounts/${env.REALTIMEKIT_ACCOUNT_ID}/realtime/kit/${env.REALTIMEKIT_APP_ID}`;
}

function rtkHeaders(env) {
  return {
    'Authorization': `Bearer ${env.REALTIMEKIT_API_TOKEN}`,
    'Content-Type':  'application/json'
  };
}

async function handleRTK(request, env, url) {
  const cors = corsHeaders(request);

  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: cors });
  }

  if (!env.REALTIMEKIT_API_TOKEN) {
    return Response.json(
      { error: 'REALTIMEKIT_API_TOKEN is not configured.' },
      { status: 503, headers: cors }
    );
  }

  const path = url.pathname.replace('/api/rtk', '');

  try {
    if (request.method === 'GET'  && path === '/debug')  return await debugRTK(env, cors);
    if (request.method === 'POST' && path === '/create') return await createMeeting(request, env, cors);
    if (request.method === 'POST' && path === '/join')   return await joinMeeting(request, env, cors);
  } catch (err) {
    return Response.json({ error: err.message }, { status: 500, headers: cors });
  }

  return Response.json({ error: 'Not found' }, { status: 404, headers: cors });
}

// Extract a value from either Cloudflare API format (result.x) or Dyte format (data.x)
function pick(json, key) {
  return json?.result?.[key] ?? json?.data?.[key];
}

function assertSuccess(json, label) {
  const ok = json?.success ?? (json?.data !== undefined);
  if (!ok) {
    const msg = json?.errors?.[0]?.message ?? json?.message ?? JSON.stringify(json);
    throw new Error(`${label}: ${msg}`);
  }
}

async function debugRTK(env, cors) {
  const base = rtkBase(env);
  const headers = rtkHeaders(env);

  // Attempt to list meetings (GET) so we get a real response without side effects
  const res = await fetch(`${base}/meetings`, { method: 'GET', headers });
  const text = await res.text();
  let parsed;
  try { parsed = JSON.parse(text); } catch { parsed = null; }

  return Response.json({
    status: res.status,
    base,
    raw: text.slice(0, 2000),
    parsed
  }, { headers: cors });
}

async function safeJson(res, label) {
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch {
    throw new Error(`${label} returned non-JSON (HTTP ${res.status}): ${text.slice(0, 500)}`);
  }
  return json;
}

async function createMeeting(request, env, cors) {
  const { title, userName } = await request.json();

  // 1. Create the meeting
  const meetRes  = await fetch(`${rtkBase(env)}/meetings`, {
    method: 'POST',
    headers: rtkHeaders(env),
    body: JSON.stringify({ title })
  });
  const meetJson = await safeJson(meetRes, 'Create meeting');
  assertSuccess(meetJson, 'Create meeting');

  const meetingId = pick(meetJson, 'id');
  if (!meetingId) throw new Error('No meeting ID in response: ' + JSON.stringify(meetJson));

  // 2. Add the host as a participant and receive their auth token
  const partRes  = await fetch(`${rtkBase(env)}/meetings/${meetingId}/participants`, {
    method: 'POST',
    headers: rtkHeaders(env),
    body: JSON.stringify({
      name:                  userName,
      presetName:            env.REALTIMEKIT_PRESET_NAME || 'group_call_host',
      custom_participant_id: crypto.randomUUID()
    })
  });
  const partJson = await safeJson(partRes, 'Add participant');
  assertSuccess(partJson, 'Add participant');

  const token = pick(partJson, 'token');
  if (!token) throw new Error('No token in response: ' + JSON.stringify(partJson));

  return Response.json({ meetingId, token }, { headers: cors });
}

async function joinMeeting(request, env, cors) {
  const { meetingId, userName } = await request.json();

  const partRes  = await fetch(`${rtkBase(env)}/meetings/${meetingId}/participants`, {
    method: 'POST',
    headers: rtkHeaders(env),
    body: JSON.stringify({
      name:                  userName,
      presetName:            env.REALTIMEKIT_PRESET_NAME || 'group_call_host',
      custom_participant_id: crypto.randomUUID()
    })
  });
  const partJson = await safeJson(partRes, 'Join meeting');
  assertSuccess(partJson, 'Join meeting');

  const token = pick(partJson, 'token');
  if (!token) throw new Error('No token in response: ' + JSON.stringify(partJson));

  return Response.json({ token }, { headers: cors });
}

function corsHeaders(request) {
  const origin = request?.headers?.get('Origin') ?? '*';
  return {
    'Access-Control-Allow-Origin':  origin,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Vary': 'Origin'
  };
}


const HTML = `
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0, user-scalable=no, viewport-fit=cover" />
<meta name="apple-mobile-web-app-capable" content="yes" />
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />
<title>HamoudaSpace · Video Meetings</title>

<!-- Firebase (room code ↔ RealtimeKit meeting ID mapping) -->
<script src="https://www.gstatic.com/firebasejs/10.8.0/firebase-app-compat.js"></script>
<script src="https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore-compat.js"></script>

<!-- Cloudflare RealtimeKit SDK (exposes RealtimeKitClient global) -->
<script src="https://cdn.jsdelivr.net/npm/@cloudflare/realtimekit@latest/dist/browser.js"></script>

<!-- Cloudflare RealtimeKit UI Kit (registers <rtk-meeting> web component) -->
<script type="module">
  import { defineCustomElements } from 'https://cdn.jsdelivr.net/npm/@cloudflare/realtimekit-ui@latest/loader/index.es2017.js';
  defineCustomElements();
</script>

<style>
* { margin:0; padding:0; box-sizing:border-box; }
:root {
  --bg-dark:#05070c; --bg-card:#12161f; --bg-soft:#1a1f2c;
  --border-dim:#2a2f3e; --text-primary:#eef2ff; --text-secondary:#9ca3af;
  --accent:#3b82f6; --accent-hover:#2563eb; --danger:#ef4444;
}
html { height:100%; overflow:hidden; -webkit-overflow-scrolling:touch; }
body { height:100%; overflow:hidden; font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif; background:var(--bg-dark); color:var(--text-primary); }
.hidden { display:none !important; }
.btn { padding:12px 24px; border-radius:40px; font-weight:600; border:none; cursor:pointer; font-size:16px; transition:opacity .15s; }
.btn:disabled { opacity:.5; cursor:not-allowed; }
.btn-primary { background:var(--accent); color:#fff; }
.btn-primary:hover:not(:disabled) { background:var(--accent-hover); }
.btn-secondary { background:var(--bg-card); color:var(--text-primary); border:1px solid var(--border-dim); }
.btn-secondary:hover:not(:disabled) { background:#1c2030; }

/* Lobby */
#view-lobby { display:flex; flex-direction:column; height:100vh; height:100dvh; overflow-y:auto; background:radial-gradient(circle at 20% 30%,#0f121c,#020408); }
.lobby-header { padding:16px 20px; padding-top:max(16px,env(safe-area-inset-top)); display:flex; justify-content:space-between; align-items:center; background:rgba(10,12,18,.7); backdrop-filter:blur(12px); border-bottom:1px solid var(--border-dim); flex-wrap:wrap; gap:10px; }
.logo-area { display:flex; gap:12px; align-items:center; }
.logo-icon { width:44px; height:44px; background:var(--accent); border-radius:14px; display:flex; align-items:center; justify-content:center; font-size:24px; }
.lobby-actions { display:flex; gap:10px; }
.lobby-main { max-width:700px; margin:40px auto; padding:20px; text-align:center; }
.hero h1 { font-size:1.8rem; margin-bottom:12px; }
.hero p { font-size:14px; color:var(--text-secondary); }
.action-cards { display:flex; gap:16px; justify-content:center; margin-top:32px; flex-wrap:wrap; }
.card { background:var(--bg-card); padding:24px; border-radius:28px; width:220px; border:1px solid var(--border-dim); }
.card h3 { margin-bottom:16px; }
.card button { width:100%; padding:10px; font-size:14px; }
.info-box { margin-top:30px; padding:16px; background:rgba(59,130,246,.1); border-radius:20px; font-size:12px; text-align:left; color:var(--text-secondary); }
.error-box { margin-top:20px; padding:14px 18px; background:rgba(239,68,68,.12); border:1px solid rgba(239,68,68,.3); border-radius:16px; font-size:13px; color:#f87171; }

/* Modals */
.modal-backdrop { position:fixed; inset:0; background:rgba(0,0,0,.85); backdrop-filter:blur(6px); display:flex; align-items:center; justify-content:center; z-index:600; padding:20px; }
.modal-card { background:var(--bg-card); border-radius:28px; padding:28px; width:90%; max-width:350px; }
.modal-title { font-size:20px; font-weight:600; margin-bottom:20px; }
.modal-card input { width:100%; margin-bottom:12px; background:var(--bg-soft); border:1px solid var(--border-dim); border-radius:14px; padding:12px 14px; color:white; font-size:15px; outline:none; transition:border-color .2s; }
.modal-card input:focus { border-color:var(--accent); }
.modal-error { color:#f87171; font-size:12px; margin-bottom:10px; min-height:16px; }
.modal-footer { display:flex; justify-content:flex-end; gap:12px; margin-top:8px; }

/* Loading */
.overlay { position:fixed; inset:0; background:rgba(0,0,0,.92); display:flex; align-items:center; justify-content:center; z-index:700; flex-direction:column; gap:16px; }
.spinner { width:40px; height:40px; border:3px solid #2a3048; border-top-color:var(--accent); border-radius:50%; animation:spin .8s linear infinite; }
.overlay-msg { color:var(--text-secondary); font-size:14px; }
@keyframes spin { to { transform:rotate(360deg); } }

/* Room — full-screen RealtimeKit meeting */
#view-room { position:fixed; inset:0; z-index:100; }

/* Floating room-code chip */
#roomChip {
  position:absolute; top:max(12px,env(safe-area-inset-top)); left:50%;
  transform:translateX(-50%); z-index:200;
  background:rgba(0,0,0,.55); backdrop-filter:blur(10px);
  padding:5px 14px; border-radius:30px;
  display:flex; align-items:center; gap:8px;
  pointer-events:auto; white-space:nowrap;
}
#roomChip .label { font-size:10px; color:rgba(255,255,255,.5); }
#roomChip .code  { font-family:monospace; font-size:13px; letter-spacing:2px; cursor:pointer; }
#roomChip .hint  { font-size:10px; color:rgba(255,255,255,.35); }

/* Toast */
.toast { position:fixed; bottom:calc(80px + env(safe-area-inset-bottom)); left:50%; transform:translateX(-50%); background:#1e2030; border:1px solid var(--border-dim); padding:8px 20px; border-radius:40px; z-index:800; font-size:12px; white-space:nowrap; pointer-events:none; animation:toastAnim 2.8s ease forwards; }
@keyframes toastAnim { 0%{opacity:0;transform:translateX(-50%) translateY(8px)} 12%{opacity:1;transform:translateX(-50%) translateY(0)} 80%{opacity:1} 100%{opacity:0} }
</style>
</head>
<body>

<!-- ── Lobby ─────────────────────────────────────────────────────────────── -->
<div id="view-lobby">
  <div class="lobby-header">
    <div class="logo-area">
      <div class="logo-icon">🎥</div>
      <div>
        <strong>HamoudaSpace</strong>
        <div style="font-size:10px;color:var(--text-secondary)">Powered by Cloudflare RealtimeKit</div>
      </div>
    </div>
    <div class="lobby-actions">
      <button class="btn btn-secondary" onclick="openModal('join')">🔗 Join</button>
      <button class="btn btn-primary"   onclick="openModal('create')">✨ New Meeting</button>
    </div>
  </div>
  <div class="lobby-main">
    <div class="hero">
      <h1>Video Meetings That Work</h1>
      <p>Powered by Cloudflare RealtimeKit · Encrypted WebRTC · Works on all browsers</p>
    </div>
    <div class="action-cards">
      <div class="card"><h3>Start a Meeting</h3><button class="btn btn-primary"   onclick="openModal('create')">Create Room</button></div>
      <div class="card"><h3>Join a Meeting</h3> <button class="btn btn-secondary" onclick="openModal('join')">Enter Code</button></div>
    </div>
    <div id="lobbyError" class="error-box hidden"></div>
    <div class="info-box">
      <strong>How it works:</strong> Create a room and share the 6-letter code.
      Media is relayed through Cloudflare's global network — fully encrypted,
      works on Chrome, Firefox, Safari, Edge, and all mobile browsers.
    </div>
  </div>
</div>

<!-- ── Room (Cloudflare RealtimeKit prebuilt UI) ──────────────────────── -->
<div id="view-room" class="hidden">
  <div id="roomChip">
    <span class="label">Room</span>
    <span class="code" id="roomCodeDisplay" onclick="copyCode()"></span>
    <span class="hint">· tap to copy</span>
  </div>
  <rtk-meeting id="rtkEl" show-setup-screen="true" style="width:100%;height:100%;display:block;"></rtk-meeting>
</div>

<!-- ── Create modal ───────────────────────────────────────────────────── -->
<div id="createModal" class="modal-backdrop hidden">
  <div class="modal-card">
    <div class="modal-title">New Meeting</div>
    <input id="createRoomName" placeholder="Meeting name"      maxlength="50" />
    <input id="createUserName" placeholder="Your display name" maxlength="30" />
    <div id="createError" class="modal-error"></div>
    <div class="modal-footer">
      <button class="btn btn-secondary" onclick="closeModals()">Cancel</button>
      <button class="btn btn-primary"   id="createBtn" onclick="doCreate()">Create</button>
    </div>
  </div>
</div>

<!-- ── Join modal ─────────────────────────────────────────────────────── -->
<div id="joinModal" class="modal-backdrop hidden">
  <div class="modal-card">
    <div class="modal-title">Join Meeting</div>
    <input id="joinCode"     placeholder="6-letter room code" maxlength="6" style="text-transform:uppercase;letter-spacing:3px" />
    <input id="joinUserName" placeholder="Your display name"  maxlength="30" />
    <div id="joinError" class="modal-error"></div>
    <div class="modal-footer">
      <button class="btn btn-secondary" onclick="closeModals()">Cancel</button>
      <button class="btn btn-primary"   id="joinBtn" onclick="doJoin()">Join</button>
    </div>
  </div>
</div>

<!-- ── Loading overlay ───────────────────────────────────────────────── -->
<div id="loadingOverlay" class="overlay hidden">
  <div class="spinner"></div>
  <div class="overlay-msg" id="overlayMsg">Starting…</div>
</div>

<script>
'use strict';

// ─── Firebase (room code ↔ RealtimeKit meeting ID) ────────────────────────────
firebase.initializeApp({
  apiKey:            'AIzaSyCra3IgsAaQlf3INjRn04DdX3KWwb8zdlo',
  authDomain:        'hamoudaspace-meetingapp.firebaseapp.com',
  projectId:         'hamoudaspace-meetingapp',
  storageBucket:     'hamoudaspace-meetingapp.firebasestorage.app',
  messagingSenderId: '9931981197',
  appId:             '1:9931981197:web:716e61223950d3d39c7dc4'
});
const db = firebase.firestore();

// ─── State ────────────────────────────────────────────────────────────────────
let roomCode = '';

// ─── Utilities ────────────────────────────────────────────────────────────────
function genCode() { return Math.random().toString(36).slice(2,8).toUpperCase(); }

function toast(msg) {
  document.querySelectorAll('.toast').forEach(t => t.remove());
  const t = document.createElement('div');
  t.className = 'toast'; t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 3200);
}
function showLoading(msg) {
  document.getElementById('overlayMsg').textContent = msg || 'Please wait…';
  document.getElementById('loadingOverlay').classList.remove('hidden');
}
function hideLoading() { document.getElementById('loadingOverlay').classList.add('hidden'); }

function showLobbyErr(msg) {
  const el = document.getElementById('lobbyError');
  el.textContent = '⚠️ ' + msg; el.classList.remove('hidden');
}
function hideLobbyErr() { document.getElementById('lobbyError').classList.add('hidden'); }

// ─── Modals ───────────────────────────────────────────────────────────────────
function openModal(type) {
  document.getElementById('createError').textContent = '';
  document.getElementById('joinError').textContent   = '';
  document.getElementById('createModal').classList.toggle('hidden', type !== 'create');
  document.getElementById('joinModal').classList.toggle('hidden',   type !== 'join');
  setTimeout(() => {
    (type === 'create'
      ? document.getElementById('createRoomName')
      : document.getElementById('joinCode'))?.focus();
  }, 60);
}
function closeModals() {
  document.getElementById('createModal').classList.add('hidden');
  document.getElementById('joinModal').classList.add('hidden');
}

// ─── Start the RealtimeKit meeting in the room view ───────────────────────────
async function startMeeting(authToken, code) {
  roomCode = code;
  showLoading('Connecting to meeting…');

  try {
    console.log('[RTK] RealtimeKitClient =', typeof RealtimeKitClient);
    console.log('[RTK] authToken (first 40 chars) =', authToken?.slice(0, 40));

    const meeting = await RealtimeKitClient.init({
      baseURI: 'realtime.cloudflare.com',
      authToken,
    });

    console.log('[RTK] init resolved, meeting =', meeting);

    // Ensure camera and mic are enabled after joining
    meeting.self.on('roomJoined', async () => {
      try {
        if (!meeting.self.videoEnabled)  await meeting.self.enableVideo();
        if (!meeting.self.audioEnabled)  await meeting.self.enableAudio();
      } catch(e) {
        console.warn('[RTK] Could not enable media:', e.message);
      }
    });

    document.getElementById('rtkEl').meeting = meeting;

    document.getElementById('roomCodeDisplay').textContent = code;
    document.getElementById('view-lobby').classList.add('hidden');
    document.getElementById('view-room').classList.remove('hidden');
    hideLoading();

    const backToLobby = () => {
      document.getElementById('view-room').classList.add('hidden');
      document.getElementById('view-lobby').classList.remove('hidden');
      roomCode = '';
    };
    meeting.self.on('roomLeft',        backToLobby);
    meeting.meta?.on?.('meetingEnded', backToLobby);
  } catch (err) {
    console.error('[RTK] startMeeting error:', err);
    hideLoading();
    showLobbyErr('Meeting error: ' + err.message);
  }
}

// ─── Create room ──────────────────────────────────────────────────────────────
async function doCreate() {
  const rn = document.getElementById('createRoomName').value.trim();
  const un = document.getElementById('createUserName').value.trim();
  document.getElementById('createError').textContent = '';
  if (!rn || !un) {
    document.getElementById('createError').textContent = 'Please fill in both fields.';
    return;
  }

  document.getElementById('createBtn').disabled = true;
  closeModals();
  hideLobbyErr();
  showLoading('Creating meeting…');

  let data;
  try {
    const res = await fetch('/api/rtk/create', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: rn, userName: un })
    });
    data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Server error');
  } catch(e) {
    hideLoading();
    showLobbyErr(e.message);
    document.getElementById('createBtn').disabled = false;
    return;
  }

  const code = genCode();

  try {
    await db.collection('rooms').doc(code).set({
      name:      rn,
      rtkRoomId: data.meetingId,
      createdAt: firebase.firestore.FieldValue.serverTimestamp()
    });
  } catch(e) {
    hideLoading();
    showLobbyErr('Could not save room: ' + e.message);
    document.getElementById('createBtn').disabled = false;
    return;
  }

  await startMeeting(data.token, code);
  toast('Room created! Share code: ' + code);
  document.getElementById('createBtn').disabled = false;
}

// ─── Join room ────────────────────────────────────────────────────────────────
async function doJoin() {
  const code = document.getElementById('joinCode').value.toUpperCase().replace(/[^A-Z0-9]/g, '');
  const un   = document.getElementById('joinUserName').value.trim();
  document.getElementById('joinError').textContent = '';
  if (!code || code.length !== 6 || !un) {
    document.getElementById('joinError').textContent = 'Enter a valid 6-letter code and your name.';
    return;
  }

  document.getElementById('joinBtn').disabled = true;
  closeModals();
  hideLobbyErr();
  showLoading('Looking up room…');

  let roomDoc;
  try {
    roomDoc = await db.collection('rooms').doc(code).get();
  } catch(e) {
    hideLoading();
    showLobbyErr('Connection error: ' + e.message);
    document.getElementById('joinBtn').disabled = false;
    return;
  }

  if (!roomDoc.exists) {
    hideLoading();
    showLobbyErr('Room not found. Double-check the code.');
    document.getElementById('joinBtn').disabled = false;
    return;
  }

  const { rtkRoomId } = roomDoc.data();
  showLoading('Joining meeting…');

  let data;
  try {
    const res = await fetch('/api/rtk/join', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ meetingId: rtkRoomId, userName: un })
    });
    data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Server error');
  } catch(e) {
    hideLoading();
    showLobbyErr(e.message);
    document.getElementById('joinBtn').disabled = false;
    return;
  }

  await startMeeting(data.token, code);
  toast('Joined · ' + code);
  document.getElementById('joinBtn').disabled = false;
}

// ─── Clipboard ────────────────────────────────────────────────────────────────
function copyCode() {
  if (!roomCode) return;
  navigator.clipboard?.writeText(roomCode)
    .then(() => toast('Code copied!'))
    .catch(() => {});
}

// ─── Input wiring ─────────────────────────────────────────────────────────────
document.getElementById('joinCode').addEventListener('input', e => {
  e.target.value = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '');
});
['createRoomName', 'createUserName'].forEach(id =>
  document.getElementById(id).addEventListener('keydown', e => { if (e.key === 'Enter') doCreate(); })
);
['joinCode', 'joinUserName'].forEach(id =>
  document.getElementById(id).addEventListener('keydown', e => { if (e.key === 'Enter') doJoin(); })
);

// ─── Auto-join from ?join=XXXXXX ─────────────────────────────────────────────
const autoCode = new URLSearchParams(location.search).get('join');
if (autoCode?.length === 6) {
  document.getElementById('joinCode').value = autoCode.toUpperCase();
  openModal('join');
  toast('Enter your name to join');
}
</script>
</body>
</html>
`;
