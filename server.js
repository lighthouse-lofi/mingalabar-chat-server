require('dotenv').config(); 

const { Server } = require("socket.io");
const http = require("http");
const https = require("https"); 

// --- CONFIGURATION ---
const PORT = process.env.PORT || 3000;
const ONESIGNAL_APP_ID = process.env.ONESIGNAL_APP_ID;
const ONESIGNAL_API_KEY = process.env.ONESIGNAL_API_KEY;

// Fail-safe logging
if (!ONESIGNAL_APP_ID || !ONESIGNAL_API_KEY) {
  console.warn("⚠️  OneSignal Keys missing. Notifications will not work.");
}

// --- HTTP SERVER ---
const httpServer = http.createServer((req, res) => {
  if (req.url === '/') {
    res.writeHead(200);
    res.end("Mingalabar Chat Server is Online (v2.4)");
  } else {
    res.writeHead(404);
    res.end();
  }
});

// --- SOCKET SERVER ---
const io = new Server(httpServer, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  },
  pingInterval: 10000, 
  pingTimeout: 5000,   
});

// --- STATE ---
const userRooms = new Map();         
const roomParticipants = new Map();  
const waitingQueue = new Map();      
const userPushTokens = new Map();    

console.log(`🚀 Server starting on port ${PORT}`);

// --- CONNECTION ---
io.on("connection", (socket) => {
  const userId = socket.handshake.query.userId;
  const oneSignalId = socket.handshake.query.oneSignalId;
  
  if (!userId) {
    console.warn(`[!] Connection rejected: No userId from ${socket.id}`);
    socket.disconnect();
    return;
  }

  // 1. Store Push Token
  if (oneSignalId && oneSignalId.length > 0) {
    userPushTokens.set(userId, oneSignalId);
  }

  // 2. Join Private Channel
  socket.join(userId);

  // 3. Session Recovery
  if (userRooms.has(userId)) {
    const roomId = userRooms.get(userId);
    socket.join(roomId);
    socket.emit("match_found", { roomId, isRejoin: true });
  }

  // --- EVENTS ---

  socket.on("find_match", (userData) => {
    if (userRooms.has(userId)) return;

    if (waitingQueue.has(userId)) {
      waitingQueue.set(userId, { socketId: socket.id, ...userData });
      return;
    }

    let matchId = null;

    for (const [candidateId, candidateData] of waitingQueue.entries()) {
      if (candidateId === userId) continue;

      const matchMyPref = 
        userData.filterGender === 'all' || 
        userData.filterGender === candidateData.gender;
      
      const matchTheirPref = 
        candidateData.filterGender === 'all' || 
        candidateData.filterGender === userData.gender;

      if (matchMyPref && matchTheirPref) {
        matchId = candidateId;
        break; 
      }
    }

    if (matchId) {
      const partnerData = waitingQueue.get(matchId);
      const partnerSocket = io.sockets.sockets.get(partnerData.socketId);

      if (!partnerSocket) {
        waitingQueue.delete(matchId);
        socket.emit("find_match", userData); 
        return;
      }

      waitingQueue.delete(matchId);
      waitingQueue.delete(userId); 

      const roomId = `room_${userId}_${matchId}`;
      userRooms.set(userId, roomId);
      userRooms.set(matchId, roomId);
      roomParticipants.set(roomId, [userId, matchId]); 

      socket.join(roomId);
      partnerSocket.join(roomId);

      io.to(matchId).emit("match_found", { 
        roomId, 
        partnerName: userData.name 
      });
      socket.emit("match_found", { 
        roomId, 
        partnerName: partnerData.name 
      });
      
      console.log(`[✅] Matched: ${userId} <--> ${matchId}`);

    } else {
      waitingQueue.set(userId, {
        socketId: socket.id,
        ...userData 
      });
    }
  });

  socket.on("send_message", (data) => {
    const roomId = userRooms.get(userId);
    if (roomId) {
      socket.to(roomId).emit("receive_message", data);
      
      // Send Push Notification
      sendNotificationToPartner(roomId, userId, data.text);
    } else {
      socket.emit("partner_skipped");
    }
  });

  socket.on("skip", () => {
    const roomId = userRooms.get(userId);
    waitingQueue.delete(userId);

    if (roomId) {
      socket.to(roomId).emit("partner_skipped");
      
      const participants = roomParticipants.get(roomId) || [];
      participants.forEach(pid => userRooms.delete(pid));
      roomParticipants.delete(roomId);
      
      socket.leave(roomId);
    }
  });

  socket.on("disconnect", () => {
    waitingQueue.delete(userId);
  });
});

// --- HELPER: OneSignal ---
function sendNotificationToPartner(roomId, senderId, messageText) {
  if (!ONESIGNAL_APP_ID || !ONESIGNAL_API_KEY) return;

  const participants = roomParticipants.get(roomId);
  if (!participants) return;

  const partnerId = participants.find(id => id !== senderId);
  if (!partnerId) return;

  const partnerToken = userPushTokens.get(partnerId);
  if (!partnerToken) return;

  const displayMsg = messageText.length > 100 ? messageText.substring(0, 100) + "..." : messageText;

  const data = JSON.stringify({
    app_id: ONESIGNAL_APP_ID,
    include_player_ids: [partnerToken],
    headings: { en: "New Message" },
    contents: { en: displayMsg },
    data: { type: "chat_message", roomId: roomId },
    android_group: "chat_messages",
    ios_badgeType: "Increase",
    ios_badgeCount: 1
  });

  const options = {
    hostname: "onesignal.com",
    port: 443,
    path: "/api/v1/notifications",
    method: "POST",
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Authorization": `Basic ${ONESIGNAL_API_KEY}`
    }
  };

  const req = https.request(options, (res) => {
    if (res.statusCode >= 400) {
      console.error(`[Push Error] Status: ${res.statusCode}`);
    }
  });

  req.on('error', (e) => {
    console.error("[Push Error]", e.message);
  });

  req.write(data);
  req.end();
}

httpServer.listen(PORT, () => {
  console.log(`\n>>> Server active on port ${PORT} <<<\n`);
});
