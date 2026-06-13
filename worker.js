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
    if (request.method === 'GET'  && path === '/debug')   return await debugRTK(env, cors);
    if (request.method === 'GET'  && path === '/presets') return await listPresets(env, cors);
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

async function listPresets(env, cors) {
  const res = await fetch(`${rtkBase(env)}/presets`, { method: 'GET', headers: rtkHeaders(env) });
  const text = await res.text();
  let parsed;
  try { parsed = JSON.parse(text); } catch { parsed = null; }
  return Response.json({ status: res.status, raw: text.slice(0, 3000), parsed }, { headers: cors });
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

<script src="https://www.gstatic.com/firebasejs/10.8.0/firebase-app-compat.js"></script>
<script src="https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore-compat.js"></script>
<script src="https://cdn.jsdelivr.net/npm/@cloudflare/realtimekit@latest/dist/browser.js"></script>

<style>
/* ── Reset & tokens ────────────────────────────────────────────────────────── */
* { margin:0; padding:0; box-sizing:border-box; }
:root {
  --bg-dark:#05070c; --bg-card:#12161f; --bg-soft:#1a1f2c;
  --border:#2a2f3e; --text:#eef2ff; --muted:#9ca3af;
  --blue:#3b82f6; --blue2:#2563eb; --red:#ef4444;
}
html { height:100%; overflow:hidden; position:relative; -webkit-overflow-scrolling:touch; }
body { height:100%; overflow:hidden; position:relative;
  font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;
  background:var(--bg-dark); color:var(--text); }
.hidden { display:none !important; }

/* ── Lobby ─────────────────────────────────────────────────────────────────── */
#view-lobby { display:flex; flex-direction:column; height:100vh; height:100dvh; overflow-y:auto;
  background:radial-gradient(circle at 20% 30%,#0f121c,#020408); }
.lobby-header { padding:16px 20px; padding-top:max(16px,env(safe-area-inset-top));
  display:flex; justify-content:space-between; align-items:center;
  background:rgba(10,12,18,.7); backdrop-filter:blur(12px);
  border-bottom:1px solid var(--border); flex-wrap:wrap; gap:10px; }
.logo-area { display:flex; gap:12px; align-items:center; }
.logo-icon { width:44px; height:44px; background:var(--blue); border-radius:14px;
  display:flex; align-items:center; justify-content:center; font-size:24px; }
.lobby-actions { display:flex; gap:10px; }
.lobby-main { max-width:700px; margin:40px auto; padding:20px; text-align:center; }
.hero h1 { font-size:1.8rem; margin-bottom:12px; }
.hero p  { font-size:14px; color:var(--muted); }
.action-cards { display:flex; gap:16px; justify-content:center; margin-top:32px; flex-wrap:wrap; }
.card { background:var(--bg-card); padding:24px; border-radius:28px; width:220px; border:1px solid var(--border); }
.card h3 { margin-bottom:16px; }
.card button { width:100%; padding:10px; font-size:14px; }
.info-box  { margin-top:30px; padding:16px; background:rgba(59,130,246,.1); border-radius:20px; font-size:12px; text-align:left; color:var(--muted); }
.error-box { margin-top:20px; padding:14px 18px; background:rgba(239,68,68,.12);
  border:1px solid rgba(239,68,68,.3); border-radius:16px; font-size:13px; color:#f87171; }
.btn { padding:12px 24px; border-radius:40px; font-weight:600; border:none; cursor:pointer; font-size:16px; transition:opacity .15s; }
.btn:disabled { opacity:.5; cursor:not-allowed; }
.btn-primary   { background:var(--blue); color:#fff; }
.btn-primary:hover:not(:disabled) { background:var(--blue2); }
.btn-secondary { background:var(--bg-card); color:var(--text); border:1px solid var(--border); }
.btn-secondary:hover:not(:disabled) { background:#1c2030; }

/* ── Modals ─────────────────────────────────────────────────────────────────── */
.modal-backdrop { position:fixed; inset:0; background:rgba(0,0,0,.85); backdrop-filter:blur(6px);
  display:flex; align-items:center; justify-content:center; z-index:600; padding:20px; }
.modal-card { background:var(--bg-card); border-radius:28px; padding:28px; width:90%; max-width:350px; }
.modal-title { font-size:20px; font-weight:600; margin-bottom:20px; }
.modal-card input { width:100%; margin-bottom:12px; background:var(--bg-soft); border:1px solid var(--border);
  border-radius:14px; padding:12px 14px; color:white; font-size:15px; outline:none; transition:border-color .2s; }
.modal-card input:focus { border-color:var(--blue); }
.modal-error { color:#f87171; font-size:12px; margin-bottom:10px; min-height:16px; }
.modal-footer { display:flex; justify-content:flex-end; gap:12px; margin-top:8px; }

/* ── Loading overlay ─────────────────────────────────────────────────────────── */
.overlay { position:fixed; inset:0; background:rgba(0,0,0,.92); display:flex; align-items:center;
  justify-content:center; z-index:700; flex-direction:column; gap:16px; }
.spinner { width:40px; height:40px; border:3px solid #2a3048; border-top-color:var(--blue); border-radius:50%; animation:spin .8s linear infinite; }
.overlay-msg { color:var(--muted); font-size:14px; }
@keyframes spin { to { transform:rotate(360deg); } }

/* ── Toast ───────────────────────────────────────────────────────────────────── */
.toast { position:fixed; bottom:calc(80px + env(safe-area-inset-bottom)); left:50%; transform:translateX(-50%);
  background:#1e2030; border:1px solid var(--border); padding:8px 20px; border-radius:40px; z-index:800;
  font-size:12px; white-space:nowrap; pointer-events:none; animation:toastAnim 2.8s ease forwards; }
@keyframes toastAnim {
  0%{opacity:0;transform:translateX(-50%) translateY(8px)}
  12%{opacity:1;transform:translateX(-50%) translateY(0)}
  80%{opacity:1} 100%{opacity:0} }

/* ════════════════════════════════════════════════════════════════════════════
   ROOM  (position:absolute because iOS Safari breaks position:fixed when
          overflow:hidden is set on body — body has position:relative above)
   ════════════════════════════════════════════════════════════════════════════ */
#view-room {
  position:absolute; inset:0; z-index:100;
  display:flex; flex-direction:column;
  background:#000;
}

/* ── Setup screen ──────────────────────────────────────────────────────────── */
#setupScreen {
  flex:1; display:flex; flex-direction:column; align-items:center; justify-content:center;
  gap:20px; padding:24px; background:linear-gradient(180deg,#080a10 0%,#0a0c16 100%);
}
.preview-frame {
  width:100%; max-width:360px; border-radius:20px; overflow:hidden;
  background:#111; aspect-ratio:4/3; position:relative; box-shadow:0 0 0 1px rgba(255,255,255,.08);
}
#previewVid {
  width:100%; height:100%; object-fit:cover; display:block;
  transform:scaleX(-1);
}
.preview-status {
  position:absolute; bottom:10px; left:50%; transform:translateX(-50%);
  background:rgba(0,0,0,.72); color:#fff; padding:4px 14px; border-radius:20px;
  font-size:12px; white-space:nowrap; backdrop-filter:blur(4px);
}
#setupStatus { color:var(--muted); font-size:14px; text-align:center; min-height:20px; }
#joinNowBtn {
  width:100%; max-width:300px; padding:16px;
  border-radius:40px; background:var(--blue); color:#fff;
  font-size:18px; font-weight:700; border:none; cursor:pointer;
  transition:background .15s, opacity .15s;
}
#joinNowBtn:disabled { opacity:.5; cursor:not-allowed; }
#joinNowBtn:not(:disabled):hover { background:var(--blue2); }
.btn-back {
  background:none; border:none; color:var(--muted); font-size:13px;
  cursor:pointer; padding:8px 16px;
}

/* ── Call screen ───────────────────────────────────────────────────────────── */
#callScreen { flex:1; display:flex; flex-direction:column; overflow:hidden; background:#0a0a0f; }

/* iOS audio unlock banner */
#audioUnlockBar {
  background:rgba(220,38,38,.92); color:#fff; text-align:center;
  padding:11px 16px; font-size:14px; font-weight:600; cursor:pointer; flex-shrink:0;
  letter-spacing:.01em;
}

/* Video grid */
#videoGrid {
  flex:1; display:flex; flex-wrap:wrap; gap:3px; padding:3px;
  overflow:hidden; align-content:stretch; align-items:stretch;
  background:#000;
}

/* Participant tile */
.vtile {
  position:relative; border-radius:12px; overflow:hidden;
  background:#131320; display:flex; align-items:center; justify-content:center;
  flex-grow:1; flex-shrink:1; min-height:80px;
  transition:flex-basis .2s;
}
.vtile video {
  position:absolute; inset:0; width:100%; height:100%;
  object-fit:cover; display:block;
}
.vtile.self-tile video { transform:scaleX(-1); }

/* Avatar shown when camera is off */
.vavatar {
  width:64px; height:64px; border-radius:50%;
  background:var(--blue); display:flex; align-items:center; justify-content:center;
  font-size:28px; font-weight:700; color:#fff; z-index:1; flex-shrink:0;
  text-transform:uppercase;
}

/* Name label */
.vname {
  position:absolute; bottom:8px; left:8px; z-index:3;
  background:rgba(0,0,0,.68); color:#fff;
  padding:3px 10px; border-radius:14px; font-size:11px; font-weight:600;
  max-width:calc(100% - 16px); overflow:hidden; text-overflow:ellipsis; white-space:nowrap;
  backdrop-filter:blur(4px);
}
/* "You" badge on self tile */
.vtile.self-tile .vname::after { content:' · You'; opacity:.7; }

/* Call controls */
#callControls {
  display:flex; align-items:center; justify-content:center; gap:20px;
  padding:16px; padding-bottom:max(16px,env(safe-area-inset-bottom));
  background:rgba(5,5,10,.96); flex-shrink:0; border-top:1px solid rgba(255,255,255,.06);
}
.ctrl-btn {
  width:58px; height:58px; border-radius:50%; border:none; cursor:pointer;
  font-size:24px; background:#1f2336; color:#fff;
  display:flex; align-items:center; justify-content:center;
  transition:background .15s; flex-shrink:0;
}
.ctrl-btn.off  { background:#7f1d1d; }
.ctrl-end      { background:var(--red); }
.ctrl-end:hover { background:#dc2626; }
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
        <div style="font-size:10px;color:var(--muted)">Powered by Cloudflare RealtimeKit</div>
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

<!-- ── Room ───────────────────────────────────────────────────────────────── -->
<div id="view-room" class="hidden">

  <!-- Pre-call: camera preview before joining -->
  <div id="setupScreen" class="hidden">
    <div class="preview-frame">
      <video id="previewVid" autoplay muted playsinline webkit-playsinline></video>
      <div class="preview-status" id="previewStatusBadge">Camera preview</div>
    </div>
    <div id="setupStatus">Starting camera…</div>
    <button id="joinNowBtn" onclick="joinNow()" disabled>Join Meeting</button>
    <button class="btn-back" onclick="leaveCall()">← Back to lobby</button>
  </div>

  <!-- In-call: video grid + controls -->
  <div id="callScreen" class="hidden">
    <div id="audioUnlockBar" class="hidden" onclick="unlockAudio()">
      🔇 Tap here to enable audio
    </div>
    <div id="videoGrid"></div>
    <div id="callControls">
      <button id="micBtn" class="ctrl-btn" onclick="toggleMic()" title="Mute/unmute">🎙️</button>
      <button id="camBtn" class="ctrl-btn" onclick="toggleCam()" title="Camera on/off">📹</button>
      <button class="ctrl-btn ctrl-end"  onclick="leaveCall()"  title="Leave">📵</button>
    </div>
  </div>

</div>

<!-- ── Create modal ───────────────────────────────────────────────────────── -->
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

<!-- ── Join modal ─────────────────────────────────────────────────────────── -->
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

<!-- ── Loading overlay ───────────────────────────────────────────────────── -->
<div id="loadingOverlay" class="overlay hidden">
  <div class="spinner"></div>
  <div class="overlay-msg" id="overlayMsg">Please wait…</div>
</div>

<script>
'use strict';

// ─── Firebase ─────────────────────────────────────────────────────────────────
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
let roomCode      = '';
let activeMeeting = null;
let pendingToken  = null;
let localStream   = null;

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

function setSetupStatus(msg) {
  document.getElementById('setupStatus').textContent = msg;
}

// ─── View switching ───────────────────────────────────────────────────────────
function showLobby() {
  document.getElementById('view-lobby').classList.remove('hidden');
  document.getElementById('view-room').classList.add('hidden');
  document.getElementById('setupScreen').classList.add('hidden');
  document.getElementById('callScreen').classList.add('hidden');
}
function showSetup() {
  document.getElementById('view-lobby').classList.add('hidden');
  document.getElementById('view-room').classList.remove('hidden');
  document.getElementById('setupScreen').classList.remove('hidden');
  document.getElementById('callScreen').classList.add('hidden');
}
function showCall() {
  document.getElementById('setupScreen').classList.add('hidden');
  document.getElementById('callScreen').classList.remove('hidden');
}

// ─── Cleanup & go home ────────────────────────────────────────────────────────
function cleanupAndGoHome() {
  localStream?.getTracks().forEach(t => t.stop());
  localStream   = null;
  activeMeeting = null;
  pendingToken  = null;
  roomCode      = '';
  document.getElementById('videoGrid').innerHTML = '';
  document.getElementById('previewVid').srcObject = null;
  document.getElementById('audioUnlockBar').classList.add('hidden');
  showLobby();
}

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

// ─── Video element factory ────────────────────────────────────────────────────
function makeVideo(muted) {
  const v = document.createElement('video');
  v.autoplay    = true;
  v.playsInline = true;
  v.setAttribute('playsinline', '');
  v.setAttribute('webkit-playsinline', '');
  if (muted) v.muted = true;
  return v;
}

// ─── Participant tile factory ─────────────────────────────────────────────────
function makeTile(id, name, isSelf) {
  const tile = document.createElement('div');
  tile.id        = 'tile-' + id;
  tile.className = 'vtile' + (isSelf ? ' self-tile' : '');

  const avatar = document.createElement('div');
  avatar.className   = 'vavatar';
  avatar.textContent = (name || '?')[0];

  const label = document.createElement('div');
  label.className   = 'vname';
  label.textContent = name || (isSelf ? 'You' : 'Guest');

  tile.appendChild(avatar);
  tile.appendChild(label);
  return tile;
}

// ─── Grid layout ──────────────────────────────────────────────────────────────
function updateGridLayout() {
  const grid  = document.getElementById('videoGrid');
  const tiles = [...grid.querySelectorAll('.vtile')];
  const n     = tiles.length;
  if (n === 0) return;
  const cols = n === 1 ? 1 : n <= 4 ? 2 : 3;
  const gap  = 3;
  const pct  = (100 / cols).toFixed(3);
  tiles.forEach(t => {
    t.style.flexBasis = `calc(${pct}% - ${gap}px)`;
    t.style.maxWidth  = `calc(${pct}% - ${gap}px)`;
  });
}

// ─── Setup screen — camera preview before joining ─────────────────────────────
async function startMeeting(authToken, code) {
  roomCode     = code;
  pendingToken = authToken;
  activeMeeting = null;

  hideLoading();
  showSetup();
  document.getElementById('joinNowBtn').disabled = true;
  setSetupStatus('Starting camera…');

  try {
    localStream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'user' },
      audio: true,
    });
    const preview = document.getElementById('previewVid');
    preview.srcObject = localStream;
    preview.play().catch(() => {});
    setSetupStatus('Ready — tap Join to enter the meeting');
    document.getElementById('joinNowBtn').disabled = false;
  } catch (e) {
    setSetupStatus('⚠️ Camera error: ' + e.message);
  }
}

// ─── Join the meeting ─────────────────────────────────────────────────────────
async function joinNow() {
  if (!pendingToken) return;
  document.getElementById('joinNowBtn').disabled = true;

  // Stop preview stream so SDK can open the camera cleanly during join()
  localStream?.getTracks().forEach(t => t.stop());
  localStream = null;
  document.getElementById('previewVid').srcObject = null;

  // ── 1. Init SDK ──────────────────────────────────────────────────────────
  showLoading('Connecting…');
  let meeting;
  try {
    meeting = await RealtimeKitClient.init({
      authToken: pendingToken,
      baseURI:   'realtime.cloudflare.com',
      defaults: {
        audio: true,
        video: true,
      },
    });
  } catch (e) {
    hideLoading();
    document.getElementById('joinNowBtn').disabled = false;
    setSetupStatus('⚠️ Connection error: ' + e.message);
    localStream = null;
    return;
  }

  activeMeeting = meeting;
  pendingToken  = null;

  // ── 2. Wire all event listeners BEFORE join() ────────────────────────────
  meeting.self.on('roomLeft', cleanupAndGoHome);
  meeting.meta?.on?.('meetingEnded', () => activeMeeting?.leaveRoom?.());

  // iOS audio autoplay blocked → show unlock banner
  meeting.self.on('autoplayError', () => {
    document.getElementById('audioUnlockBar').classList.remove('hidden');
  });

  // Build self tile now so it's ready immediately after join
  const grid      = document.getElementById('videoGrid');
  const selfTile  = makeTile('self', meeting.self.name || 'You', true);
  const selfVideo = makeVideo(true); // muted self-view
  selfTile.insertBefore(selfVideo, selfTile.firstChild);

  // Remote participant handler
  function addParticipant(p) {
    if (document.getElementById('tile-' + p.id)) return;

    const tile  = makeTile(p.id, p.name || 'Guest', false);
    const video = makeVideo(false);
    const audio = document.createElement('audio');
    audio.autoplay = true;

    tile.insertBefore(video, tile.firstChild);
    tile.appendChild(audio);
    grid.appendChild(tile);

    // SDK manages video track updates automatically via registerVideoElement
    p.registerVideoElement(video);

    // Audio: manual because SDK doesn't manage <audio> elements
    function applyAudio(enabled, track) {
      audio.srcObject = enabled && track ? new MediaStream([track]) : null;
      if (enabled && track) audio.play().catch(() => {});
    }
    applyAudio(p.audioEnabled, p.audioTrack);
    p.on('audioUpdate', ({ audioEnabled, audioTrack }) => applyAudio(audioEnabled, audioTrack));
  }

  meeting.participants.active.on('participantJoined', (p) => {
    addParticipant(p);
    updateGridLayout();
  });
  meeting.participants.active.on('participantLeft', (p) => {
    document.getElementById('tile-' + p.id)?.remove();
    updateGridLayout();
  });

  // ── 3. Join room ─────────────────────────────────────────────────────────
  showLoading('Joining…');
  try {
    await meeting.join();
  } catch (e) {
    hideLoading();
    activeMeeting = null;
    document.getElementById('joinNowBtn').disabled = false;
    setSetupStatus('⚠️ Join error: ' + e.message);
    showSetup();
    return;
  }

  // ── 4. Show call screen ───────────────────────────────────────────────────
  showCall();
  hideLoading();
  document.getElementById('audioUnlockBar').classList.add('hidden');

  // Append self tile and let SDK fill its video element
  grid.appendChild(selfTile);
  // registerVideoElement tells the SDK to keep this element's srcObject
  // in sync with the self video track (handles initial + future updates)
  meeting.self.registerVideoElement(selfVideo);

  // Add participants already in the room when we joined
  (meeting.participants.active.toArray?.() ?? []).forEach(p => addParticipant(p));

  updateGridLayout();
}

// ─── Unlock audio on iOS (call after user tap) ────────────────────────────────
function unlockAudio() {
  activeMeeting?.self?.playAudio?.();
  document.getElementById('audioUnlockBar').classList.add('hidden');
}

// ─── Mic toggle ───────────────────────────────────────────────────────────────
function toggleMic() {
  if (!activeMeeting) return;
  const btn = document.getElementById('micBtn');
  if (activeMeeting.self.audioEnabled) {
    activeMeeting.self.disableAudio();
    btn.textContent = '🔇'; btn.classList.add('off');
  } else {
    activeMeeting.self.enableAudio();
    btn.textContent = '🎙️'; btn.classList.remove('off');
  }
}

// ─── Camera toggle ────────────────────────────────────────────────────────────
function toggleCam() {
  if (!activeMeeting) return;
  const btn = document.getElementById('camBtn');
  if (activeMeeting.self.videoEnabled) {
    activeMeeting.self.disableVideo();
    btn.textContent = '🚫'; btn.classList.add('off');
  } else {
    activeMeeting.self.enableVideo();
    btn.textContent = '📹'; btn.classList.remove('off');
  }
}

// ─── Leave call ───────────────────────────────────────────────────────────────
function leaveCall() {
  if (activeMeeting) {
    activeMeeting.leaveRoom?.();
  } else {
    // From setup screen before joining
    localStream?.getTracks().forEach(t => t.stop());
    localStream  = null;
    pendingToken = null;
    roomCode     = '';
    showLobby();
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
  } catch (e) {
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
  } catch (e) {
    hideLoading();
    showLobbyErr('Could not save room: ' + e.message);
    document.getElementById('createBtn').disabled = false;
    return;
  }

  await startMeeting(data.token, code);
  toast('Room created! Code: ' + code);
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
  } catch (e) {
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
  } catch (e) {
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
['createRoomName','createUserName'].forEach(id =>
  document.getElementById(id).addEventListener('keydown', e => { if (e.key==='Enter') doCreate(); })
);
['joinCode','joinUserName'].forEach(id =>
  document.getElementById(id).addEventListener('keydown', e => { if (e.key==='Enter') doJoin(); })
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
