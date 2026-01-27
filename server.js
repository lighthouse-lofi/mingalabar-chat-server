const { Server } = require("socket.io");
const http = require("http");

// --- CONFIGURATION ---
const PORT = process.env.PORT || 3000;

// --- HTTP SERVER ---
const httpServer = http.createServer((req, res) => {
  // Health check endpoint for Render/Uptime monitors
  if (req.url === '/') {
    res.writeHead(200);
    res.end("Mingalabar Chat Server is Online (v2.0)");
  } else {
    res.writeHead(404);
    res.end();
  }
});

// --- SOCKET SERVER CONFIG ---
const io = new Server(httpServer, {
  cors: {
    origin: "*", // Allow connections from any mobile app source
    methods: ["GET", "POST"]
  },
  pingInterval: 10000, // Send heartbeat every 10s
  pingTimeout: 5000,   // Disconnect if no response after 5s
});

// --- IN-MEMORY STATE ---
// Best for single-instance deployments (Render Free/Starter, DigitalOcean Droplet)

// Maps userId -> roomId
// Tracks which room a user is currently active in.
const userRooms = new Map(); 

// Maps userId -> { socketId, name, gender, age, filterGender }
// Tracks users actively looking for a match.
const waitingQueue = new Map(); 

console.log(`🚀 Server starting on port ${PORT}`);

// --- CONNECTION HANDLER ---
io.on("connection", (socket) => {
  // 1. AUTHENTICATION (Simplified)
  // In a real app, verify a JWT token here.
  const userId = socket.handshake.query.userId;
  
  if (!userId) {
    console.warn(`[!] Connection rejected: No userId from ${socket.id}`);
    socket.disconnect();
    return;
  }

  // console.log(`[+] User connected: ${userId} (${socket.id})`);

  // Join a private channel based on userId.
  // This allows us to signal this user even if they change socket IDs (reconnect).
  socket.join(userId);

  // 2. SESSION RECOVERY
  // If the user was in a room, puts them back in.
  if (userRooms.has(userId)) {
    const roomId = userRooms.get(userId);
    socket.join(roomId);
    socket.emit("match_found", { roomId, isRejoin: true });
    // console.log(`[~] User ${userId} rejoined room ${roomId}`);
  }

  // --- EVENTS ---

  /**
   * FIND MATCH
   * The core matching logic. Matches based on mutual gender filtering.
   */
  socket.on("find_match", (userData) => {
    // userData: { name, gender, age, filterGender, captchaToken }

    // If user is already in a room, they shouldn't be searching.
    if (userRooms.has(userId)) return;

    // Update queue entry with latest socket ID (handles quick reconnects)
    // We strictly use .set() to ensure data is fresh.
    if (waitingQueue.has(userId)) {
      waitingQueue.set(userId, { socketId: socket.id, ...userData });
      return;
    }

    // console.log(`[?] Search: ${userData.name} (${userData.gender}) -> ${userData.filterGender}`);

    let matchId = null;

    // ITERATE QUEUE to find a mutual match
    for (const [candidateId, candidateData] of waitingQueue.entries()) {
      // Don't match self
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
        break; // Stop looking, found one.
      }
    }

    if (matchId) {
      // --- MATCH FOUND ---
      
      // 1. Get Candidate Data
      const partnerData = waitingQueue.get(matchId);
      
      // 2. Critical Check: Is the partner's socket still valid?
      const partnerSocket = io.sockets.sockets.get(partnerData.socketId);

      if (!partnerSocket) {
        // Partner disconnected silently (zombie). Remove them and retry.
        waitingQueue.delete(matchId);
        socket.emit("find_match", userData); // Recursive retry for self
        return;
      }

      // 3. Remove both from Queue
      waitingQueue.delete(matchId);
      waitingQueue.delete(userId); 

      // 4. Create & Persist Room
      const roomId = `room_${userId}_${matchId}`;
      userRooms.set(userId, roomId);
      userRooms.set(matchId, roomId);

      // 5. ATOMIC JOIN (The Fix for Race Conditions)
      // Force both sockets into the room immediately.
      socket.join(roomId);
      partnerSocket.join(roomId);

      // 6. Notify Room
      io.to(roomId).emit("match_found", { 
        roomId, 
        partnerName: partnerData.name // Optional: Send name if not anonymous
      });
      
      console.log(`[✅] Matched: ${userId} <--> ${matchId}`);

    } else {
      // --- NO MATCH, ADD TO QUEUE ---
      waitingQueue.set(userId, {
        socketId: socket.id,
        ...userData 
      });
    }
  });

  /**
   * SEND MESSAGE
   * Relays message to the room.
   */
  socket.on("send_message", (data) => {
    const roomId = userRooms.get(userId);
    if (roomId) {
      // Broadcast to everyone in room EXCEPT sender (optimized bandwidth)
      socket.to(roomId).emit("receive_message", data);
    } else {
      // Edge Case: User sent message but room is dead
      socket.emit("partner_skipped");
    }
  });

  /**
   * SKIP / NEXT
   * User wants to end the chat.
   */
  socket.on("skip", () => {
    const roomId = userRooms.get(userId);
    
    // Always remove from queue to be safe
    waitingQueue.delete(userId);

    if (roomId) {
      // 1. Notify Partner
      socket.to(roomId).emit("partner_skipped");
      
      // 2. Cleanup Memory (Remove both users from room map)
      // We iterate to find the partner ID. 
      // (Optimization: In Redis architecture, we would store partner ID directly)
      for (const [key, val] of userRooms.entries()) {
        if (val === roomId) userRooms.delete(key);
      }
      
      // 3. Cleanup Socket
      // We leave the room so we don't get ghost messages
      socket.leave(roomId);
      
      // console.log(`[XX] Room closed by ${userId}`);
    }
  });

  /**
   * DISCONNECT
   * Handle app close or network loss.
   */
  socket.on("disconnect", () => {
    // 1. Remove from Waiting Queue immediately
    if (waitingQueue.has(userId)) {
      waitingQueue.delete(userId);
    }

    // Note: We DO NOT remove from 'userRooms' immediately.
    // This allows for a "grace period" if the user briefly loses internet
    // or switches apps. The 'skip' logic handles permanent closure.
    
    // Optional: Notify partner "Partner paused..." via 'partner_disconnected' event
    // if you want to show a grey status dot.
    
    // console.log(`[-] User disconnected: ${userId}`);
  });
});

// --- START SERVER ---
httpServer.listen(PORT, () => {
  console.log(`\n>>> Server active at http://localhost:${PORT} <<<\n`);
});
```

### Deployment Instructions
Since you are using Render + GitHub:
1.  Save this content into your local `server.js`.
2.  Open your terminal in that folder.
3.  Run:
    ```bash
    git add server.js
    git commit -m "Update server logic to professional standard"
    git push
