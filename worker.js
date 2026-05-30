// worker.js - Cloudflare Worker for WebSocket signaling
export default {
  async fetch(request, env) {
    const upgradeHeader = request.headers.get('Upgrade');
    if (upgradeHeader === 'websocket') {
      return handleWebSocket(request);
    }
    
    const url = new URL(request.url);
    if (url.pathname === '/health') {
      return new Response('OK', { status: 200 });
    }
    
    // Optional: Serve the HTML from worker as well
    if (url.pathname === '/' || url.pathname === '/index.html') {
      return serveHTML();
    }
    
    return new Response('WebSocket server running', { status: 200 });
  }
};

function handleWebSocket(request) {
  const webSocketPair = new WebSocketPair();
  const [client, server] = Object.values(webSocketPair);
  
  server.accept();
  
  const rooms = new Map();
  
  server.addEventListener('message', (event) => {
    try {
      const data = JSON.parse(event.data);
      
      if (data.type === 'join') {
        const roomId = data.roomId;
        const userId = data.userId;
        const userName = data.userName;
        
        if (!rooms.has(roomId)) {
          rooms.set(roomId, { participants: new Map() });
        }
        
        const room = rooms.get(roomId);
        room.participants.set(userId, { ws: server, name: userName });
        
        // Send existing participants to new user
        const existingParticipants = [];
        for (let [pid, p] of room.participants) {
          if (pid !== userId) {
            existingParticipants.push({ id: pid, name: p.name });
          }
        }
        
        server.send(JSON.stringify({
          type: 'welcome',
          participants: existingParticipants
        }));
        
        // Notify others
        for (let [pid, p] of room.participants) {
          if (pid !== userId && p.ws.readyState === 1) {
            p.ws.send(JSON.stringify({
              type: 'user-joined',
              userId: userId,
              userName: userName
            }));
          }
        }
      }
      
      else if (data.type === 'signal') {
        const roomId = data.roomId;
        const targetId = data.targetId;
        
        if (rooms.has(roomId)) {
          const room = rooms.get(roomId);
          const target = room.participants.get(targetId);
          if (target && target.ws.readyState === 1) {
            target.ws.send(JSON.stringify({
              type: 'signal',
              fromId: data.fromId,
              signal: data.signal
            }));
          }
        }
      }
      
      else if (data.type === 'leave') {
        const roomId = data.roomId;
        const userId = data.userId;
        
        if (rooms.has(roomId)) {
          const room = rooms.get(roomId);
          room.participants.delete(userId);
          
          for (let [pid, p] of room.participants) {
            if (p.ws.readyState === 1) {
              p.ws.send(JSON.stringify({
                type: 'user-left',
                userId: userId
              }));
            }
          }
          
          if (room.participants.size === 0) {
            rooms.delete(roomId);
          }
        }
      }
      
    } catch (err) {
      console.error('Error:', err);
    }
  });
  
  server.addEventListener('close', () => {
    // Cleanup on disconnect
    for (let [roomId, room] of rooms) {
      for (let [userId, p] of room.participants) {
        if (p.ws === server) {
          room.participants.delete(userId);
          for (let [pid, p2] of room.participants) {
            if (p2.ws.readyState === 1) {
              p2.ws.send(JSON.stringify({
                type: 'user-left',
                userId: userId
              }));
            }
          }
          if (room.participants.size === 0) rooms.delete(roomId);
          break;
        }
      }
    }
  });
  
  return new Response(null, { status: 101, webSocket: client });
}

async function serveHTML() {
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>HamoudaSpace – Video Meetings</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
    background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
    min-height: 100vh;
    display: flex;
    align-items: center;
    justify-content: center;
  }
  .container {
    background: rgba(255,255,255,0.95);
    border-radius: 20px;
    padding: 40px;
    text-align: center;
    max-width: 500px;
    box-shadow: 0 20px 60px rgba(0,0,0,0.3);
  }
  h1 { color: #333; margin-bottom: 10px; }
  p { color: #666; margin-bottom: 30px; }
  .buttons { display: flex; gap: 15px; justify-content: center; }
  button {
    padding: 12px 24px;
    font-size: 16px;
    border: none;
    border-radius: 10px;
    cursor: pointer;
    transition: transform 0.2s;
  }
  button:hover { transform: scale(1.05); }
  .create { background: #667eea; color: white; }
  .join { background: #48bb78; color: white; }
  input {
    width: 100%;
    padding: 12px;
    margin: 10px 0;
    border: 1px solid #ddd;
    border-radius: 8px;
    font-size: 16px;
  }
  .modal {
    position: fixed;
    top: 0;
    left: 0;
    right: 0;
    bottom: 0;
    background: rgba(0,0,0,0.5);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 1000;
  }
  .modal-content {
    background: white;
    padding: 30px;
    border-radius: 20px;
    width: 90%;
    max-width: 400px;
  }
  .hidden { display: none; }
  .room-header {
    position: fixed;
    top: 0;
    left: 0;
    right: 0;
    background: white;
    padding: 15px;
    box-shadow: 0 2px 10px rgba(0,0,0,0.1);
    display: flex;
    justify-content: space-between;
    z-index: 100;
  }
  .video-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));
    gap: 15px;
    padding: 80px 20px 80px;
    height: 100vh;
  }
  .video-tile {
    background: #1a1a2e;
    border-radius: 15px;
    overflow: hidden;
    position: relative;
    aspect-ratio: 16/9;
  }
  .video-tile video {
    width: 100%;
    height: 100%;
    object-fit: cover;
  }
  .video-label {
    position: absolute;
    bottom: 10px;
    left: 10px;
    background: rgba(0,0,0,0.6);
    color: white;
    padding: 4px 10px;
    border-radius: 20px;
    font-size: 12px;
  }
  .controls {
    position: fixed;
    bottom: 0;
    left: 0;
    right: 0;
    background: white;
    padding: 15px;
    display: flex;
    justify-content: center;
    gap: 15px;
    box-shadow: 0 -2px 10px rgba(0,0,0,0.1);
  }
  .ctrl-btn {
    width: 50px;
    height: 50px;
    border-radius: 50%;
    background: #f0f0f0;
    display: flex;
    align-items: center;
    justify-content: center;
    cursor: pointer;
    transition: all 0.2s;
  }
  .ctrl-btn:hover { background: #e0e0e0; }
  .ctrl-btn.danger { background: #ef4444; color: white; }
  .ctrl-btn.active { background: #48bb78; color: white; }
  .room-code {
    font-family: monospace;
    background: #f0f0f0;
    padding: 5px 10px;
    border-radius: 8px;
    cursor: pointer;
  }
  @media (max-width: 600px) {
    .video-grid { grid-template-columns: 1fr; }
  }
</style>
</head>
<body>
<div id="lobby">
  <div class="container">
    <h1>🎥 HamoudaSpace</h1>
    <p>Video meetings for everyone - no account needed!</p>
    <div class="buttons">
      <button class="create" onclick="showCreateModal()">Create Meeting</button>
      <button class="join" onclick="showJoinModal()">Join Meeting</button>
    </div>
  </div>
</div>

<div id="room" style="display:none">
  <div class="room-header">
    <div><strong id="room-name">Meeting</strong> <span class="room-code" id="room-code" onclick="copyCode()">XXXXXX</span></div>
    <button onclick="leaveRoom()">Leave</button>
  </div>
  <div class="video-grid" id="video-grid"></div>
  <div class="controls">
    <div class="ctrl-btn" id="mic-btn" onclick="toggleMic()">🎤</div>
    <div class="ctrl-btn" id="cam-btn" onclick="toggleCam()">📷</div>
    <div class="ctrl-btn" onclick="toggleScreenShare()">🖥️</div>
    <div class="ctrl-btn danger" onclick="leaveRoom()">🚪</div>
  </div>
</div>

<div id="create-modal" class="modal hidden">
  <div class="modal-content">
    <h3>Create Meeting</h3>
    <input type="text" id="create-room-name" placeholder="Meeting name" />
    <input type="text" id="create-user-name" placeholder="Your name" />
    <div style="display: flex; gap: 10px; margin-top: 20px;">
      <button onclick="closeModal('create-modal')">Cancel</button>
      <button class="create" onclick="createRoom()">Create</button>
    </div>
  </div>
</div>

<div id="join-modal" class="modal hidden">
  <div class="modal-content">
    <h3>Join Meeting</h3>
    <input type="text" id="join-room-code" placeholder="Room code (6 letters)" maxlength="6" style="text-transform:uppercase" />
    <input type="text" id="join-user-name" placeholder="Your name" />
    <div style="display: flex; gap: 10px; margin-top: 20px;">
      <button onclick="closeModal('join-modal')">Cancel</button>
      <button class="join" onclick="joinRoom()">Join</button>
    </div>
  </div>
</div>

<div id="connecting" style="display:none; position:fixed; inset:0; background:rgba(0,0,0,0.8); z-index:1000; display:flex; align-items:center; justify-content:center; flex-direction:column">
  <div style="width:50px;height:50px;border:3px solid #fff;border-top-color:#667eea;border-radius:50%;animation:spin 1s linear infinite"></div>
  <p style="color:white;margin-top:20px">Connecting...</p>
</div>

<style>
  @keyframes spin { to { transform: rotate(360deg); } }
</style>

<script>
const WS_URL = \`wss://\${window.location.host}\`;

let localStream = null;
let peerConnections = new Map();
let ws = null;
let currentRoomId = null;
let currentUserId = null;
let currentUserName = null;

function showToast(msg) { alert(msg); }
function showModal(id) { document.getElementById(id).classList.remove('hidden'); }
function closeModal(id) { document.getElementById(id).classList.add('hidden'); }
function showCreateModal() { showModal('create-modal'); }
function showJoinModal() { showModal('join-modal'); }

function copyCode() {
  navigator.clipboard.writeText(currentRoomId);
  alert('Code copied!');
}

async function createRoom() {
  const roomName = document.getElementById('create-room-name').value.trim();
  const userName = document.getElementById('create-user-name').value.trim();
  if (!roomName || !userName) { alert('Please enter both fields'); return; }
  closeModal('create-modal');
  document.getElementById('connecting').style.display = 'flex';
  
  currentRoomId = Math.random().toString(36).slice(2, 8).toUpperCase();
  currentUserId = 'user_' + Date.now();
  currentUserName = userName;
  
  try {
    localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
    await connectWebSocket(true);
    document.getElementById('lobby').style.display = 'none';
    document.getElementById('room').style.display = 'block';
    document.getElementById('room-name').textContent = roomName;
    document.getElementById('room-code').textContent = currentRoomId;
    addLocalVideo();
    document.getElementById('connecting').style.display = 'none';
  } catch(err) {
    alert('Failed: ' + err.message);
    document.getElementById('connecting').style.display = 'none';
  }
}

async function joinRoom() {
  const roomCode = document.getElementById('join-room-code').value.trim().toUpperCase();
  const userName = document.getElementById('join-user-name').value.trim();
  if (!roomCode || !userName) { alert('Please enter both fields'); return; }
  if (roomCode.length !== 6) { alert('Room code must be 6 characters'); return; }
  closeModal('join-modal');
  document.getElementById('connecting').style.display = 'flex';
  
  currentRoomId = roomCode;
  currentUserId = 'user_' + Date.now();
  currentUserName = userName;
  
  try {
    localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
    await connectWebSocket(false);
    document.getElementById('lobby').style.display = 'none';
    document.getElementById('room').style.display = 'block';
    addLocalVideo();
    document.getElementById('connecting').style.display = 'none';
  } catch(err) {
    alert('Failed to join: ' + err.message);
    document.getElementById('connecting').style.display = 'none';
  }
}

function addLocalVideo() {
  const grid = document.getElementById('video-grid');
  const tile = document.createElement('div');
  tile.className = 'video-tile';
  tile.id = 'video-local';
  tile.innerHTML = \`<video autoplay playsinline muted></video><div class="video-label">\${currentUserName} (you)</div>\`;
  grid.appendChild(tile);
  tile.querySelector('video').srcObject = localStream;
}

function addRemoteVideo(userId, userName) {
  const grid = document.getElementById('video-grid');
  const tile = document.createElement('div');
  tile.className = 'video-tile';
  tile.id = \`video-\${userId}\`;
  tile.innerHTML = \`<video autoplay playsinline></video><div class="video-label">\${userName}</div>\`;
  grid.appendChild(tile);
  return tile.querySelector('video');
}

function removeRemoteVideo(userId) {
  const tile = document.getElementById(\`video-\${userId}\`);
  if (tile) tile.remove();
}

async function connectWebSocket(isHost) {
  return new Promise((resolve, reject) => {
    ws = new WebSocket(WS_URL);
    
    ws.onopen = () => {
      ws.send(JSON.stringify({
        type: 'join',
        roomId: currentRoomId,
        userId: currentUserId,
        userName: currentUserName,
        isHost: isHost
      }));
      resolve();
    };
    
    ws.onmessage = async (event) => {
      const data = JSON.parse(event.data);
      
      if (data.type === 'welcome') {
        for (const p of data.participants) {
          await createPeerConnection(p.id, p.name, true);
        }
      }
      else if (data.type === 'user-joined') {
        await createPeerConnection(data.userId, data.userName, true);
      }
      else if (data.type === 'user-left') {
        const pc = peerConnections.get(data.userId);
        if (pc) { pc.close(); peerConnections.delete(data.userId); }
        removeRemoteVideo(data.userId);
      }
      else if (data.type === 'signal') {
        let pc = peerConnections.get(data.fromId);
        if (!pc) pc = await createPeerConnection(data.fromId, 'User', false);
        
        if (data.signal.sdp) {
          await pc.setRemoteDescription(new RTCSessionDescription(data.signal.sdp));
          if (data.signal.sdp.type === 'offer') {
            const answer = await pc.createAnswer();
            await pc.setLocalDescription(answer);
            ws.send(JSON.stringify({
              type: 'signal',
              roomId: currentRoomId,
              targetId: data.fromId,
              fromId: currentUserId,
              signal: { sdp: answer }
            }));
          }
        } else if (data.signal.candidate) {
          await pc.addIceCandidate(new RTCIceCandidate(data.signal.candidate));
        }
      }
    };
    
    ws.onerror = () => reject(new Error('WebSocket failed'));
  });
}

async function createPeerConnection(userId, userName, isInitiator) {
  const pc = new RTCPeerConnection({
    iceServers: [{ urls: 'stun:stun.l.google.com:19302' }]
  });
  
  if (localStream) {
    localStream.getTracks().forEach(track => pc.addTrack(track, localStream));
  }
  
  pc.onicecandidate = (event) => {
    if (event.candidate && ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({
        type: 'signal',
        roomId: currentRoomId,
        targetId: userId,
        fromId: currentUserId,
        signal: { candidate: event.candidate }
      }));
    }
  };
  
  pc.ontrack = (event) => {
    let video = document.getElementById(\`video-\${userId}\`);
    if (!video) {
      const videoEl = addRemoteVideo(userId, userName);
      videoEl.srcObject = event.streams[0];
    } else {
      video.srcObject = event.streams[0];
    }
  };
  
  peerConnections.set(userId, pc);
  
  if (isInitiator) {
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    ws.send(JSON.stringify({
      type: 'signal',
      roomId: currentRoomId,
      targetId: userId,
      fromId: currentUserId,
      signal: { sdp: offer }
    }));
  }
  
  return pc;
}

function toggleMic() {
  if (localStream) {
    const enabled = localStream.getAudioTracks()[0].enabled;
    localStream.getAudioTracks()[0].enabled = !enabled;
    document.getElementById('mic-btn').classList.toggle('active', !enabled);
  }
}

function toggleCam() {
  if (localStream) {
    const enabled = localStream.getVideoTracks()[0].enabled;
    localStream.getVideoTracks()[0].enabled = !enabled;
    document.getElementById('cam-btn').classList.toggle('active', !enabled);
  }
}

async function toggleScreenShare() {
  if (peerConnections.size === 0) return;
  try {
    const stream = await navigator.mediaDevices.getDisplayMedia({ video: true });
    const videoTrack = stream.getVideoTracks()[0];
    for (let pc of peerConnections.values()) {
      const sender = pc.getSenders().find(s => s.track?.kind === 'video');
      if (sender) sender.replaceTrack(videoTrack);
    }
    videoTrack.onended = () => {
      if (localStream) {
        const camTrack = localStream.getVideoTracks()[0];
        for (let pc of peerConnections.values()) {
          const sender = pc.getSenders().find(s => s.track?.kind === 'video');
          if (sender && camTrack) sender.replaceTrack(camTrack);
        }
      }
    };
  } catch(e) { alert('Screen share cancelled'); }
}

function leaveRoom() {
  if (ws) ws.close();
  peerConnections.forEach(pc => pc.close());
  if (localStream) localStream.getTracks().forEach(t => t.stop());
  document.getElementById('video-grid').innerHTML = '';
  document.getElementById('lobby').style.display = 'flex';
  document.getElementById('room').style.display = 'none';
}
</script>
</body>
</html>`;
  
  return new Response(html, {
    headers: { 'Content-Type': 'text/html' }
  });
}
