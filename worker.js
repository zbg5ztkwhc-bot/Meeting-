// Cloudflare Worker — serves the app HTML and proxies Cloudflare RealtimeKit REST API.
const RTK_ACCOUNT_ID = 'ab5bdefc1a1abd85f78c1a80ac0db805';
const RTK_APP_ID     = 'c1e04640-67d7-4f7b-83c5-85420c1bb65b';
const RTK_PRESET     = 'group_call_host';

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

function rtkBase() {
  return `https://api.cloudflare.com/client/v4/accounts/${RTK_ACCOUNT_ID}/realtime/kit/${RTK_APP_ID}`;
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
  const base = rtkBase();
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
  const res = await fetch(`${rtkBase()}/presets`, { method: 'GET', headers: rtkHeaders(env) });
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
  const meetRes  = await fetch(`${rtkBase()}/meetings`, {
    method: 'POST',
    headers: rtkHeaders(env),
    body: JSON.stringify({ title })
  });
  const meetJson = await safeJson(meetRes, 'Create meeting');
  assertSuccess(meetJson, 'Create meeting');

  const meetingId = pick(meetJson, 'id');
  if (!meetingId) throw new Error('No meeting ID in response: ' + JSON.stringify(meetJson));

  // 2. Add the host as a participant and receive their auth token
  const partRes  = await fetch(`${rtkBase()}/meetings/${meetingId}/participants`, {
    method: 'POST',
    headers: rtkHeaders(env),
    body: JSON.stringify({
      name:                  userName,
      presetName:            RTK_PRESET,
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

  const partRes  = await fetch(`${rtkBase()}/meetings/${meetingId}/participants`, {
    method: 'POST',
    headers: rtkHeaders(env),
    body: JSON.stringify({
      name:                  userName,
      presetName:            RTK_PRESET,
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
/* ── Reset ──────────────────────────────────────────────────────────────────── */
*, *::before, *::after { margin:0; padding:0; box-sizing:border-box; }

:root {
  --bg:      #0b1220;
  --bg-card: #0f172a;
  --bg-inp:  #1e293b;
  --border:  #334155;
  --text:    #f1f5f9;
  --muted:   #94a3b8;
  --accent:  #2563eb;
  --accent2: #1d4ed8;
  --red:     #ef4444;
  --green:   #4ade80;
}

html, body { height:100%; overflow:hidden; }
body {
  font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;
  background:var(--bg); color:var(--text);
  -webkit-font-smoothing:antialiased;
}
.hidden { display:none !important; }

/* ── Animated tetris grid (from Learnly) ────────────────────────────────────── */
.tetris-grid {
  background-color:var(--bg);
  background-image:
    linear-gradient(to right,  rgba(148,163,184,.12) 1px, transparent 1px),
    linear-gradient(to bottom, rgba(148,163,184,.12) 1px, transparent 1px);
  background-size:32px 32px;
  animation:tetris-pan 30s linear infinite;
}
@keyframes tetris-pan {
  0%   { background-position:0 0; }
  100% { background-position:256px 256px; }
}
@media (prefers-reduced-motion:reduce) { .tetris-grid { animation:none; } }

/* ── Lobby ───────────────────────────────────────────────────────────────────── */
#view-lobby {
  height:100vh; height:100dvh;
  display:flex; flex-direction:column;
  overflow-y:auto; -webkit-overflow-scrolling:touch;
}

.lobby-header {
  padding:18px 24px;
  padding-top:max(18px,env(safe-area-inset-top));
  display:flex; align-items:center; gap:10px;
  border-bottom:1px solid rgba(148,163,184,.12);
}
.logo-icon { font-size:26px; line-height:1; }
.logo-name  { font-size:22px; font-weight:700; letter-spacing:-.5px; color:var(--text); }

.lobby-main {
  flex:1;
  display:flex; flex-direction:column; align-items:center;
  text-align:center;
  padding:48px 20px 60px;
}

.hero-title {
  font-size:clamp(2rem,8vw,3.5rem);
  font-weight:600; line-height:1.18;
  letter-spacing:-.02em;
  color:var(--text);
  max-width:640px;
}
.hero-sub {
  margin-top:16px;
  font-size:16px; color:var(--muted);
  max-width:480px;
}

/* ── Tab panel ───────────────────────────────────────────────────────────────── */
.tab-panel {
  margin-top:40px;
  width:100%; max-width:460px;
  text-align:left;
}

.tab-switcher {
  display:flex; gap:6px;
  background:var(--bg-card);
  padding:4px; width:fit-content; margin:0 auto 20px;
  border:2px solid var(--border);
}
.tab-btn {
  padding:8px 24px; font-size:14px; font-weight:500;
  border:2px solid transparent; cursor:pointer;
  background:transparent; color:var(--muted);
  transition:background .15s, color .15s, border-color .15s;
}
.tab-btn.active {
  background:var(--accent); border-color:var(--accent); color:#fff;
}

.tab-form {
  background:var(--bg-card);
  border:2px solid var(--border);
  padding:24px;
}
.tab-form label {
  display:block; font-size:13px; color:var(--muted); margin-bottom:6px;
}
.tab-form input {
  width:100%; padding:11px 14px;
  background:var(--bg-inp); color:var(--text);
  border:2px solid var(--border);
  font-size:15px; outline:none;
  transition:border-color .15s;
  margin-bottom:16px;
}
.tab-form input:focus { border-color:var(--accent); }
.tab-form input::placeholder { color:var(--muted); }

.tab-form .form-error {
  color:#f87171; font-size:12px; min-height:18px; margin-bottom:8px;
}

.lobby-btn {
  width:100%; padding:13px;
  background:var(--accent); border:2px solid var(--accent);
  color:#fff; font-size:15px; font-weight:600;
  cursor:pointer; transition:background .15s, border-color .15s;
}
.lobby-btn:hover:not(:disabled) { background:var(--accent2); border-color:var(--accent2); }
.lobby-btn:disabled { opacity:.55; cursor:not-allowed; }

/* Error banner below tab panel */
.lobby-error {
  margin-top:16px;
  padding:12px 16px;
  background:rgba(239,68,68,.1); border:1px solid rgba(239,68,68,.3);
  color:#f87171; font-size:13px;
}

/* ── Toast ───────────────────────────────────────────────────────────────────── */
.toast {
  position:fixed; bottom:calc(80px + env(safe-area-inset-bottom));
  left:50%; transform:translateX(-50%);
  background:var(--bg-card); border:1px solid var(--border);
  padding:8px 20px; font-size:12px;
  white-space:nowrap; pointer-events:none; z-index:800;
  animation:toastAnim 2.8s ease forwards;
}
@keyframes toastAnim {
  0%  { opacity:0; transform:translateX(-50%) translateY(8px); }
  12% { opacity:1; transform:translateX(-50%) translateY(0); }
  80% { opacity:1; }
  100%{ opacity:0; }
}

/* ── Loading overlay ──────────────────────────────────────────────────────────── */
.overlay {
  position:fixed; inset:0; background:rgba(0,0,0,.9);
  display:flex; flex-direction:column; align-items:center; justify-content:center;
  gap:18px; z-index:700;
}
.spinner {
  width:40px; height:40px;
  border:3px solid rgba(255,255,255,.1);
  border-top-color:var(--accent);
  border-radius:50%; animation:spin .7s linear infinite;
}
.overlay-msg { color:var(--muted); font-size:14px; }
@keyframes spin { to { transform:rotate(360deg); } }

/* ════════════════════════════════════════════════════════════════════════════
   ROOM  (position:absolute → iOS Safari fix for overflow:hidden + fixed)
   ════════════════════════════════════════════════════════════════════════════ */
#view-room {
  position:absolute; inset:0; z-index:100;
  display:flex; flex-direction:column;
  background:#000;
}

/* ── Setup screen ───────────────────────────────────────────────────────────── */
#setupScreen {
  flex:1; display:flex; flex-direction:column; align-items:center; justify-content:center;
  gap:20px; padding:24px;
  background:var(--bg);
}

.setup-title {
  font-size:22px; font-weight:600; letter-spacing:-.01em; text-align:center;
}

.preview-wrap {
  width:100%; max-width:340px;
  aspect-ratio:4/3; position:relative;
  background:#0a0f1c; overflow:hidden;
  border:2px solid var(--border);
}
#previewVid {
  width:100%; height:100%; object-fit:cover; display:block;
  transform:scaleX(-1);
}
.preview-badge {
  position:absolute; bottom:10px; left:50%; transform:translateX(-50%);
  background:rgba(0,0,0,.75); color:#fff; font-size:11px;
  padding:3px 12px; backdrop-filter:blur(4px);
  white-space:nowrap;
}

#setupStatus { color:var(--muted); font-size:13px; text-align:center; min-height:18px; }

#joinNowBtn {
  width:100%; max-width:300px; padding:15px;
  background:var(--accent); border:2px solid var(--accent);
  color:#fff; font-size:17px; font-weight:700;
  cursor:pointer; transition:background .15s, opacity .15s;
}
#joinNowBtn:not(:disabled):hover { background:var(--accent2); }
#joinNowBtn:disabled { opacity:.5; cursor:not-allowed; }

.btn-back {
  background:none; border:none; color:var(--muted);
  font-size:13px; cursor:pointer; padding:6px 12px;
}
.btn-back:hover { color:var(--text); }

/* ── Call screen ────────────────────────────────────────────────────────────── */
#callScreen { flex:1; display:flex; flex-direction:column; overflow:hidden; background:#0a0a0f; }

#audioUnlockBar {
  background:rgba(220,38,38,.92); color:#fff; text-align:center;
  padding:12px 16px; font-size:14px; font-weight:600;
  cursor:pointer; flex-shrink:0; letter-spacing:.01em;
}

/* Debug bar */
#dbgBar {
  background:rgba(0,0,0,.88); color:var(--green);
  font-size:11px; padding:6px 14px;
  font-family:ui-monospace,monospace; line-height:1.8; flex-shrink:0;
}

/* Video grid */
#videoGrid {
  flex:1; display:flex; flex-wrap:wrap; gap:3px; padding:3px;
  overflow:hidden; align-content:stretch; align-items:stretch;
  background:#000;
}

.vtile {
  position:relative; overflow:hidden;
  background:#0d1017; display:flex; align-items:center; justify-content:center;
  flex-grow:1; flex-shrink:1; min-height:80px;
  transition:flex-basis .2s;
}
.vtile video {
  position:absolute; inset:0; width:100%; height:100%;
  object-fit:cover; display:block;
}
.vtile.self-tile video { transform:scaleX(-1); }

.vavatar {
  width:64px; height:64px; border-radius:50%;
  background:var(--accent); display:flex; align-items:center; justify-content:center;
  font-size:28px; font-weight:700; color:#fff; z-index:1;
  flex-shrink:0; text-transform:uppercase;
}

.vname {
  position:absolute; bottom:8px; left:8px; z-index:3;
  background:rgba(0,0,0,.68); color:#fff;
  padding:3px 10px; font-size:11px; font-weight:600;
  max-width:calc(100% - 16px); overflow:hidden;
  text-overflow:ellipsis; white-space:nowrap;
  backdrop-filter:blur(4px);
}
.vtile.self-tile .vname::after { content:' · You'; opacity:.7; }

/* Call controls */
#callControls {
  display:flex; align-items:center; justify-content:center; gap:20px;
  padding:16px; padding-bottom:max(16px,env(safe-area-inset-bottom));
  background:rgba(5,7,15,.97); flex-shrink:0;
  border-top:1px solid rgba(255,255,255,.06);
}
.ctrl-btn {
  width:58px; height:58px; border-radius:50%; border:none; cursor:pointer;
  font-size:22px; background:#1e2433; color:#fff;
  display:flex; align-items:center; justify-content:center;
  transition:background .15s; flex-shrink:0;
}
.ctrl-btn.off  { background:#7f1d1d; }
.ctrl-end      { background:var(--red); }
.ctrl-end:hover { background:#dc2626; }
.ctrl-btn.share-on { background:#1d4ed8; }
.ctrl-btn.rec-on   { background:#dc2626; animation:recPulse 1.2s ease-in-out infinite; }
@keyframes recPulse { 0%,100%{ opacity:1; } 50%{ opacity:.6; } }
</style>
</head>
<body>

<!-- ══ Lobby ════════════════════════════════════════════════════════════════ -->
<div id="view-lobby" class="tetris-grid">

  <header class="lobby-header">
    <span class="logo-icon">🎥</span>
    <span class="logo-name">HamoudaSpace</span>
  </header>

  <main class="lobby-main">
    <h1 class="hero-title">Simple, secure<br>video meetings</h1>
    <p class="hero-sub">Powered by Cloudflare RealtimeKit · Encrypted WebRTC · Works everywhere</p>

    <div class="tab-panel">
      <!-- Tab switcher -->
      <div class="tab-switcher">
        <button class="tab-btn active" id="tabBtnCreate" onclick="setTab('create')">Create</button>
        <button class="tab-btn"       id="tabBtnJoin"   onclick="setTab('join')">Join</button>
      </div>

      <!-- Create form -->
      <div class="tab-form" id="tab-create">
        <label for="createRoomName">Meeting name</label>
        <input id="createRoomName" placeholder="What's this meeting about?" maxlength="50" />
        <label for="createUserName">Your name</label>
        <input id="createUserName" placeholder="Your display name" maxlength="30" />
        <div id="createError" class="form-error"></div>
        <button class="lobby-btn" id="createBtn" onclick="doCreate()">Start Meeting</button>
      </div>

      <!-- Join form -->
      <div class="tab-form hidden" id="tab-join">
        <label for="joinCode">Room code</label>
        <input id="joinCode" placeholder="6-letter code" maxlength="6"
               style="text-transform:uppercase;letter-spacing:4px;font-size:18px;" />
        <label for="joinUserName">Your name</label>
        <input id="joinUserName" placeholder="Your display name" maxlength="30" />
        <div id="joinError" class="form-error"></div>
        <button class="lobby-btn" id="joinBtn" onclick="doJoin()">Join Meeting</button>
      </div>

      <div id="lobbyError" class="lobby-error hidden"></div>
    </div>
  </main>
</div>

<!-- ══ Room ═════════════════════════════════════════════════════════════════ -->
<div id="view-room" class="hidden">

  <!-- Pre-call camera preview -->
  <div id="setupScreen" class="hidden">
    <div class="setup-title">Ready to join?</div>
    <div class="preview-wrap">
      <video id="previewVid" autoplay muted playsinline webkit-playsinline></video>
      <div class="preview-badge" id="previewStatusBadge">Camera preview</div>
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
    <div id="dbgBar">Initialising…</div>
    <div id="videoGrid"></div>
    <div id="callControls">
      <button id="micBtn"      class="ctrl-btn"           onclick="toggleMic()"    title="Mute/unmute">🎙️</button>
      <button id="camBtn"      class="ctrl-btn"           onclick="toggleCam()"    title="Camera on/off">📹</button>
      <button id="shareBtn"    class="ctrl-btn"           onclick="toggleShare()"  title="Screen share">🖥️</button>
      <button id="recBtn"      class="ctrl-btn"           onclick="toggleRec()"    title="Record">⏺️</button>
      <button id="shareLinkBtn" class="ctrl-btn"          onclick="shareMeeting()" title="Share invite">🔗</button>
      <button class="ctrl-btn ctrl-end"                   onclick="leaveCall()"    title="Leave">📵</button>
    </div>
  </div>

</div>

<!-- ══ Loading overlay ══════════════════════════════════════════════════════ -->
<div id="loadingOverlay" class="overlay hidden">
  <div class="spinner"></div>
  <div class="overlay-msg" id="overlayMsg">Please wait…</div>
</div>

<script>
'use strict';

// Auto-set playsinline on every <video> element including those inside shadow DOM
(function() {
  const _orig = document.createElement.bind(document);
  document.createElement = function(tag, opts) {
    const el = _orig(tag, opts);
    if (typeof tag === 'string' && tag.toLowerCase() === 'video') {
      el.setAttribute('playsinline', '');
      el.setAttribute('webkit-playsinline', '');
      el.playsInline = true;
    }
    return el;
  };
})();

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
let isSharing     = false;
let isRecording   = false;

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
  el.textContent = '⚠️ ' + msg;
  el.classList.remove('hidden');
}
function hideLobbyErr() { document.getElementById('lobbyError').classList.add('hidden'); }

function setSetupStatus(msg) {
  document.getElementById('setupStatus').textContent = msg;
}

// ─── Tab switcher ─────────────────────────────────────────────────────────────
function setTab(tab) {
  document.getElementById('tab-create').classList.toggle('hidden', tab !== 'create');
  document.getElementById('tab-join').classList.toggle('hidden',   tab !== 'join');
  document.getElementById('tabBtnCreate').classList.toggle('active', tab === 'create');
  document.getElementById('tabBtnJoin').classList.toggle('active',   tab === 'join');
  // Focus first input
  setTimeout(() => {
    (tab === 'create'
      ? document.getElementById('createRoomName')
      : document.getElementById('joinCode'))?.focus();
  }, 60);
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
  isSharing   = false;
  isRecording = false;
  showLobby();
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
    t.style.flexBasis = \`calc(\${pct}% - \${gap}px)\`;
    t.style.maxWidth  = \`calc(\${pct}% - \${gap}px)\`;
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

// ─── Debug output — visible on loading overlay, setup screen, and call bar ────
function dbg(msg) {
  document.getElementById('overlayMsg').textContent = msg;
  document.getElementById('setupStatus').textContent = msg;
  const bar = document.getElementById('dbgBar');
  if (bar) bar.innerHTML = msg;
}

// ─── Join the meeting ─────────────────────────────────────────────────────────
async function joinNow() {
  if (!pendingToken) return;
  document.getElementById('joinNowBtn').disabled = true;

  function withTimeout(promise, ms, label) {
    return Promise.race([
      promise,
      new Promise((_, reject) => setTimeout(() => reject(new Error(label + ' timed out after ' + ms/1000 + 's')), ms))
    ]);
  }

  // ── 0. Sanity check ───────────────────────────────────────────────────────
  dbg('Checking SDK…');
  showLoading('Connecting…');
  if (typeof RealtimeKitClient === 'undefined') {
    dbg('❌ RealtimeKitClient not loaded — check network');
    hideLoading();
    document.getElementById('joinNowBtn').disabled = false;
    setSetupStatus('❌ SDK failed to load. Check internet connection and reload.');
    return;
  }

  // ── 1. Init SDK — video:false so we don't compete with preview camera ──────
  dbg('SDK init…');
  let meeting;
  try {
    meeting = await withTimeout(
      RealtimeKitClient.init({
        authToken: pendingToken,
        baseURI:   'realtime.cloudflare.com',
        defaults:  { audio: false, video: false },
      }),
      30000, 'SDK init'
    );
  } catch (e) {
    dbg('❌ Init: ' + (e.message || e));
    hideLoading();
    document.getElementById('joinNowBtn').disabled = false;
    setSetupStatus('⚠️ Init failed: ' + (e.message || e));
    return;
  }
  dbg('SDK ready | joining room…');

  activeMeeting = meeting;
  pendingToken  = null;

  // ── 2. Wire ALL listeners BEFORE join() ───────────────────────────────────
  meeting.self.on('roomLeft', cleanupAndGoHome);
  meeting.meta?.on?.('meetingEnded', () => activeMeeting?.leaveRoom?.());
  meeting.self.on('autoplayError', () => {
    document.getElementById('audioUnlockBar').classList.remove('hidden');
  });

  const grid     = document.getElementById('videoGrid');
  const selfTile = makeTile('self', meeting.self.name || 'You', true);
  const selfVid  = makeVideo(true);
  selfTile.insertBefore(selfVid, selfTile.firstChild);

  meeting.self.on('videoUpdate', ({ videoEnabled, videoTrack }) => {
    dbg('videoUpdate: enabled=' + videoEnabled + ' track=' + !!videoTrack);
    selfVid.srcObject = videoEnabled && videoTrack ? new MediaStream([videoTrack]) : null;
    if (videoEnabled && videoTrack) selfVid.play().catch(() => {});
  });

  meeting.self.on('screenShareUpdate', ({ screenShareEnabled, screenShareTrack }) => {
    isSharing = screenShareEnabled;
    const btn = document.getElementById('shareBtn');
    if (screenShareEnabled) btn?.classList.add('share-on');
    else btn?.classList.remove('share-on');
    const stream = _capturedScreenStream
      ?? screenShareTrack ?? meeting.self.screenShareTrack
      ?? meeting.self.screenShareStream;
    updateScreenTile('self-screen', (meeting.self.name || 'You') + ' · Screen', screenShareEnabled, stream, true);
  });

  function remoteScreenStream(p) {
    return p.screenShareStream
      ?? (p.screenShareTrack ? new MediaStream([p.screenShareTrack]) : null);
  }

  meeting.participants.active.on('screenShareUpdate', (p) => {
    updateScreenTile(p.id + '-screen', (p.name || 'Guest') + ' · Screen', p.screenShareEnabled, remoteScreenStream(p), false);
  });

  function addParticipant(p) {
    if (document.getElementById('tile-' + p.id)) return;
    const tile  = makeTile(p.id, p.name || 'Guest', false);
    const video = makeVideo(false);
    const audio = document.createElement('audio');
    audio.autoplay = true;
    tile.insertBefore(video, tile.firstChild);
    tile.appendChild(audio);
    grid.appendChild(tile);
    function setVid(en, track) {
      video.srcObject = en && track ? new MediaStream([track]) : null;
      if (en && track) video.play().catch(() => {});
    }
    function setAud(en, track) {
      audio.srcObject = en && track ? new MediaStream([track]) : null;
      if (en && track) audio.play().catch(() => {});
    }
    setVid(p.videoEnabled, p.videoTrack);
    setAud(p.audioEnabled, p.audioTrack);
    p.on('videoUpdate', ({ videoEnabled, videoTrack }) => setVid(videoEnabled, videoTrack));
    p.on('audioUpdate', ({ audioEnabled, audioTrack }) => setAud(audioEnabled, audioTrack));
    p.on('screenShareUpdate', () => {
      updateScreenTile(p.id + '-screen', (p.name || 'Guest') + ' · Screen', p.screenShareEnabled, remoteScreenStream(p), false);
    });
    if (p.screenShareEnabled) {
      updateScreenTile(p.id + '-screen', (p.name || 'Guest') + ' · Screen', true, remoteScreenStream(p), false);
    }
    updateGridLayout();
  }

  meeting.participants.active.on('participantJoined', (p) => addParticipant(p));
  meeting.participants.active.on('participantLeft',   (p) => {
    document.getElementById('tile-' + p.id)?.remove();
    document.getElementById('tile-' + p.id + '-screen')?.remove();
    updateGridLayout();
  });

  // ── 3. Join ───────────────────────────────────────────────────────────────
  showLoading('Joining…');
  dbg('Calling meeting.join()…');
  try {
    await withTimeout(meeting.join(), 30000, 'meeting.join');
  } catch (e) {
    dbg('❌ Join: ' + (e.message || e));
    hideLoading();
    activeMeeting = null;
    document.getElementById('joinNowBtn').disabled = false;
    setSetupStatus('⚠️ Join failed: ' + (e.message || e));
    showSetup();
    return;
  }
  dbg('Joined ✓ | enabling camera…');

  // ── 4. Stop preview → enable SDK camera ───────────────────────────────────
  localStream?.getTracks().forEach(t => t.stop());
  localStream = null;
  document.getElementById('previewVid').srcObject = null;

  showCall();
  grid.appendChild(selfTile);
  updateGridLayout();
  hideLoading();

  meeting.self.enableVideo()
    .then(() => dbg('Camera on ✓ | videoEnabled=' + meeting.self.videoEnabled + ' track=' + !!meeting.self.videoTrack))
    .catch(e => {
      dbg('❌ enableVideo: ' + (e.message || e));
      navigator.mediaDevices.getUserMedia({ video: { facingMode:'user' }, audio: false })
        .then(s => { selfVid.srcObject = s; selfVid.play().catch(() => {}); dbg('Fallback cam ✓'); })
        .catch(e2 => dbg('❌ fallback cam: ' + e2.message));
    });

  meeting.self.enableAudio().catch(() => {});
  (meeting.participants.active.toArray?.() ?? []).forEach(p => addParticipant(p));
}

// ─── Unlock audio on iOS ──────────────────────────────────────────────────────
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

// ─── Intercept getDisplayMedia to capture the screen stream the SDK uses ──────
let _capturedScreenStream = null;
(function() {
  const _orig = navigator.mediaDevices.getDisplayMedia?.bind(navigator.mediaDevices);
  if (!_orig) return;
  navigator.mediaDevices.getDisplayMedia = async function(constraints) {
    const stream = await _orig(constraints);
    _capturedScreenStream = stream;
    // When user clicks the browser's "Stop sharing" button
    stream.getVideoTracks()[0]?.addEventListener('ended', () => {
      _capturedScreenStream = null;
      if (isSharing && activeMeeting) {
        activeMeeting.self.disableScreenShare().catch(() => {});
      }
      isSharing = false;
      document.getElementById('shareBtn')?.classList.remove('share-on');
      updateScreenTile('self-screen', '', false, null, true);
    });
    return stream;
  };
})();

// ─── Screen share tile helper ─────────────────────────────────────────────────
function updateScreenTile(id, label, enabled, trackOrStream, muted) {
  const grid = document.getElementById('videoGrid');
  let tile = document.getElementById('tile-' + id);
  if (!enabled || !trackOrStream) {
    tile?.remove();
    updateGridLayout();
    return;
  }
  const stream = (trackOrStream instanceof MediaStream)
    ? trackOrStream
    : new MediaStream([trackOrStream]);
  if (!tile) {
    tile = document.createElement('div');
    tile.id = 'tile-' + id;
    tile.className = 'vtile';
    const vid = makeVideo(!!muted);
    const lbl = document.createElement('div');
    lbl.className = 'vname';
    lbl.textContent = label;
    tile.appendChild(vid);
    tile.appendChild(lbl);
    grid.appendChild(tile);
  }
  const vid = tile.querySelector('video');
  if (vid) { vid.srcObject = stream; vid.play().catch(() => {}); }
  updateGridLayout();
}

// ─── Screen share ────────────────────────────────────────────────────────────
function toggleShare() {
  if (!activeMeeting) return;
  const btn = document.getElementById('shareBtn');
  if (isSharing) {
    activeMeeting.self.disableScreenShare()
      .finally(() => { isSharing = false; btn.classList.remove('share-on'); updateScreenTile('self-screen', '', false, null, true); });
  } else {
    toast('Opening screen picker…');
    activeMeeting.self.enableScreenShare()
      .then(() => {
        isSharing = true;
        btn.classList.add('share-on');
        toast('Screen share started');
        // Use the intercepted stream — most reliable source of the actual track
        const stream = _capturedScreenStream
          ?? (activeMeeting.self.screenShareTrack ? new MediaStream([activeMeeting.self.screenShareTrack]) : null)
          ?? activeMeeting.self.screenShareStream;
        updateScreenTile('self-screen', (activeMeeting.self.name || 'You') + ' · Screen', true, stream, true);
      })
      .catch(e => toast('Screen share failed: ' + (e.message || 'Not supported on this device')));
  }
}

// ─── Recording ───────────────────────────────────────────────────────────────
function toggleRec() {
  if (!activeMeeting) return;
  const btn = document.getElementById('recBtn');
  if (isRecording) {
    activeMeeting.recording.stop().catch(() => {});
    isRecording = false;
    btn.textContent = '⏺️'; btn.classList.remove('rec-on');
  } else {
    activeMeeting.recording.start()
      .then(() => { isRecording = true; btn.textContent = '⏹️'; btn.classList.add('rec-on'); })
      .catch(e => toast('Recording: ' + (e.message || e)));
  }
}

// ─── Share meeting link ───────────────────────────────────────────────────────
function shareMeeting() {
  if (!roomCode) return;
  const url = location.origin + '/?join=' + roomCode;
  if (navigator.share) {
    navigator.share({ title: 'Join my meeting', url }).catch(() => {});
  } else {
    navigator.clipboard?.writeText(url)
      .then(() => toast('Invite link copied!'))
      .catch(() => toast('Room code: ' + roomCode));
  }
}

// ─── Leave call ───────────────────────────────────────────────────────────────
function leaveCall() {
  if (activeMeeting) {
    activeMeeting.leaveRoom?.();
  } else {
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
  setTab('join');
  toast('Enter your name to join');
}
</script>
</body>
</html>

`;
