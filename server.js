require('dotenv').config(); // Load local .env file

const { Server } = require("socket.io");
const http = require("http");
const https = require("https"); // Native Node.js module for API requests

// --- CONFIGURATION & SAFETY CHECKS ---
const PORT = process.env.PORT || 3000;
const ONESIGNAL_APP_ID = process.env.ONESIGNAL_APP_ID;
const ONESIGNAL_API_KEY = process.env.ONESIGNAL_API_KEY;

// Fail-safe: Warn if keys are missing (prevents crashes, but logs the issue)
if (!ONESIGNAL_APP_ID || !ONESIGNAL_API_KEY) {
  console.warn("⚠️  WARNING: OneSignal Keys are missing. Notifications will not be sent.");
  console.warn("   -> Make sure to set ONESIGNAL_APP_ID and ONESIGNAL_API_KEY in Render Environment Variables.");
}

// --- HTTP SERVER ---
const httpServer = http.createServer((req, res) => {
  // Health check for uptime monitors
  if (req.url === '/') {
    res.writeHead(200);
    res.end("Mingalabar Chat Server is Online (v2.4 - Secure)");
  } else {
    res.writeHead(404);
    res.end();
  }
});

// --- SOCKET SERVER CONFIG ---
const io = new Server(httpServer, {
  cors: {
    origin: "*", // Allow connections from any mobile client
    methods: ["GET", "POST"]
  },
  pingInterval: 10000, // Heartbeat every 10s
  pingTimeout: 5000,   // Disconnect if no pong after 5s
});

// --- STATE MANAGEMENT (In-Memory) ---
// Note: In a scaled architecture, these would be moved to Redis.
const userRooms = new Map();         // userId -> roomId
const roomParticipants = new Map();  // roomId -> [userId1, userId2] (O(1) partner lookup)
const waitingQueue = new Map();      // userId -> { socketId, name, gender, age, filterGender }
const userPushTokens = new Map();    // userId -> oneSignalId (Persisted for offline alerts)

console.log(`🚀 Server starting on port ${PORT}`);

// --- CONNECTION LOGIC ---
io.on("connection", (socket) => {
  const userId = socket.handshake.query.userId;
  const oneSignalId = socket.handshake.query.oneSignalId;
  
  if (!userId) {
    console.warn(`[!] Connection rejected: No userId provided by ${socket.id}`);
    socket.disconnect();
    return;
  }

  // 1. Register Push Token (if provided)
  if (oneSignalId && oneSignalId.length > 0) {
    userPushTokens.set(userId, oneSignalId);
  }

  // 2. Join Private Channel (for direct signaling)
  socket.join(userId);

  // 3. Session Recovery (Handle app background/foreground)
  if (userRooms.has(userId)) {
    const roomId = userRooms.get(userId);
    socket.join(roomId);
    // On rejoin, we trust the client's local storage for the partner name
    socket.emit("match_found", { roomId, isRejoin: true });
  }

  // --- EVENT HANDLERS ---

  /**
   * FIND MATCH
   * Matches users based on mutual gender preferences.
   */
  socket.on("find_match", (userData) => {
    // userData: { name, gender, age, filterGender, captchaToken }

    // Validation: If already in a room, ignore search
    if (userRooms.has(userId)) return;

    // Validation: If already in queue, update socket/data but don't duplicate
    if (waitingQueue.has(userId)) {
      waitingQueue.set(userId, { socketId: socket.id, ...userData });
      return;
    }

    let matchId = null;

    // Search Algorithm: O(N) linear scan
    for (const [candidateId, candidateData] of waitingQueue.entries()) {
      if (candidateId === userId) continue;

      // 1. Do THEY match MY preference?
      const matchMyPref = 
        userData.filterGender === 'all' || 
        userData.filterGender === candidateData.gender;
      
      // 2. Do I match THEIR preference?
      const matchTheirPref = 
        candidateData.filterGender === 'all' || 
        candidateData.filterGender === userData.gender;

      if (matchMyPref && matchTheirPref) {
        matchId = candidateId;
        break; 
      }
    }

    if (matchId) {
      // --- MATCH FOUND ---
      
      const partnerData = waitingQueue.get(matchId);
      const partnerSocket = io.sockets.sockets.get(partnerData.socketId);

      // Edge Case: Partner disconnected silently before match was finalized
      if (!partnerSocket) {
        waitingQueue.delete(matchId);
        socket.emit("find_match", userData); // Retry recursively
        return;
      }

      // 1. Cleanup Queue
      waitingQueue.delete(matchId);
      waitingQueue.delete(userId); 

      // 2. Create Room Data
      const roomId = `room_${userId}_${matchId}`;
      userRooms.set(userId, roomId);
      userRooms.set(matchId, roomId);
      roomParticipants.set(roomId, [userId, matchId]); 

      // 3. Atomic Join (Both enter immediately)
      socket.join(roomId);
      partnerSocket.join(roomId);

      // 4. Notify - Send CORRECT names to each person
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
      // --- NO MATCH, QUEUE UP ---
      waitingQueue.set(userId, {
        socketId: socket.id,
        ...userData 
      });
    }
  });

  /**
   * SEND MESSAGE
   * Relays message via socket and triggers Push Notification if needed.
   */
  socket.on("send_message", (data) => {
    const roomId = userRooms.get(userId);
    
    if (roomId) {
      // 1. Fast Path: Send via Socket
      socket.to(roomId).emit("receive_message", data);

      // 2. Slow Path: Push Notification (Fire and forget)
      // We don't await this because we don't want to block the socket loop
      sendNotificationToPartner(roomId, userId, data.text);
    } else {
      // Client thinks they are connected, but server has no record (server restart?)
      socket.emit("partner_skipped");
    }
  });

  /**
   * SKIP / NEXT
   * Ends the current chat session.
   */
  socket.on("skip", () => {
    const roomId = userRooms.get(userId);
    
    // Always ensure user is removed from queue
    waitingQueue.delete(userId);

    if (roomId) {
      // Notify Partner
      socket.to(roomId).emit("partner_skipped");
      
      // Cleanup Memory
      const participants = roomParticipants.get(roomId) || [];
      participants.forEach(pid => userRooms.delete(pid));
      roomParticipants.delete(roomId);
      
      // Leave Socket Room
      socket.leave(roomId);
    }
  });

  /**
   * DISCONNECT
   * Handle cleanup on app close or network loss.
   */
  socket.on("disconnect", () => {
    // Only remove from waiting queue. 
    // We KEEP userRooms active for a grace period to allow reconnects.
    waitingQueue.delete(userId);
  });
});

// --- HELPER: NOTIFICATIONS ---

/**
 * Finds the partner in a room and sends a Push Notification via OneSignal.
 */
function sendNotificationToPartner(roomId, senderId, messageText) {
  if (!ONESIGNAL_APP_ID || !ONESIGNAL_API_KEY) return;

  const participants = roomParticipants.get(roomId);
  if (!participants) return;

  const partnerId = participants.find(id => id !== senderId);
  if (!partnerId) return;

  const partnerToken = userPushTokens.get(partnerId);
  if (!partnerToken) return; // Partner hasn't granted permission or has no token

  // Truncate long messages for privacy/display
  const displayMsg = messageText.length > 100 ? messageText.substring(0, 100) + "..." : messageText;

  const body = JSON.stringify({
    app_id: ONESIGNAL_APP_ID,
    include_player_ids: [partnerToken],
    headings: { en: "New Message" },
    contents: { en: displayMsg },
    // Data payload allows the app to know this is a chat message when opened
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
    // We can ignore the response for performance, or log errors only
    if (res.statusCode >= 400) {
      console.error(`[Push Error] OneSignal returned status: ${res.statusCode}`);
    }
  });

  req.on('error', (e) => {
    console.error("[Push Error] Request failed:", e.message);
  });

  req.write(body);
  req.end();
}

// --- STARTUP ---
httpServer.listen(PORT, () => {
  console.log(`\n>>> Server active on port ${PORT} <<<\n`);
});
```

### 🔒 How to Deploy Securely

1.  **Local Development:**
    * Create a `.env` file in the same folder as `server.js`.
    * Add your keys:
        ```text
        ONESIGNAL_APP_ID=your-real-id
        ONESIGNAL_API_KEY=your-real-key
