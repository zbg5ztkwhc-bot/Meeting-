// worker.js - Deploy this to Cloudflare Workers
export default {
  async fetch(request, env) {
    // Handle WebSocket upgrade
    const upgradeHeader = request.headers.get('Upgrade');
    if (upgradeHeader === 'websocket') {
      return handleWebSocket(request);
    }
    
    // Handle HTTP requests
    const url = new URL(request.url);
    if (url.pathname === '/health') {
      return new Response('OK', { status: 200 });
    }
    
    return new Response('WebSocket server running', { status: 200 });
  }
};

function handleWebSocket(request) {
  const webSocketPair = new WebSocketPair();
  const [client, server] = Object.values(webSocketPair);
  
  server.accept();
  
  // Store room data
  const rooms = new Map();
  
  server.addEventListener('message', (event) => {
    try {
      const data = JSON.parse(event.data);
      
      if (data.type === 'join') {
        // User wants to join a room
        const roomId = data.roomId;
        const userId = data.userId;
        const userName = data.userName;
        
        if (!rooms.has(roomId)) {
          rooms.set(roomId, { host: null, participants: new Map() });
        }
        
        const room = rooms.get(roomId);
        
        // Store this connection
        room.participants.set(userId, { 
          ws: server, 
          name: userName,
          isHost: !room.host && data.isHost
        });
        
        if (!room.host && data.isHost) {
          room.host = userId;
        }
        
        // Send existing participants to new user
        const existingParticipants = [];
        for (let [pid, p] of room.participants) {
          if (pid !== userId) {
            existingParticipants.push({ id: pid, name: p.name });
          }
        }
        
        server.send(JSON.stringify({
          type: 'welcome',
          participants: existingParticipants,
          isHost: room.host === userId
        }));
        
        // Notify others about new participant
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
        // Relay signaling data to specific user
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
        // User leaving
        const roomId = data.roomId;
        const userId = data.userId;
        
        if (rooms.has(roomId)) {
          const room = rooms.get(roomId);
          room.participants.delete(userId);
          
          if (room.host === userId) {
            room.host = null;
          }
          
          // Notify others
          for (let [pid, p] of room.participants) {
            if (p.ws.readyState === 1) {
              p.ws.send(JSON.stringify({
                type: 'user-left',
                userId: userId
              }));
            }
          }
          
          // Clean up empty room
          if (room.participants.size === 0) {
            rooms.delete(roomId);
          }
        }
      }
      
    } catch (err) {
      console.error('Error handling message:', err);
    }
  });
  
  server.addEventListener('close', () => {
    // Clean up when connection closes
    for (let [roomId, room] of rooms) {
      let toDelete = null;
      for (let [userId, p] of room.participants) {
        if (p.ws === server) {
          toDelete = userId;
          break;
        }
      }
      if (toDelete) {
        room.participants.delete(toDelete);
        for (let [pid, p] of room.participants) {
          if (p.ws.readyState === 1) {
            p.ws.send(JSON.stringify({
              type: 'user-left',
              userId: toDelete
            }));
          }
        }
        if (room.participants.size === 0) {
          rooms.delete(roomId);
        }
      }
    }
  });
  
  return new Response(null, { status: 101, webSocket: client });
}
