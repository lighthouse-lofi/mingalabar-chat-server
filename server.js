const { Server } = require("socket.io");
const http = require("http");

// --- CONFIGURATION ---
const PORT = process.env.PORT || 3000;

// --- HTTP SERVER ---
const httpServer = http.createServer((req, res) => {
  if (req.url === '/') {
    res.writeHead(200);
    res.end("Mingalabar Chat Server is Online (v2.1)");
  } else {
    res.writeHead(404);
    res.end();
  }
});

// --- SOCKET SERVER CONFIG ---
const io = new Server(httpServer, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  },
  pingInterval: 10000,
  pingTimeout: 5000,
});

// --- STATE MANAGEMENT ---
const userRooms = new Map(); 
// Maps userId -> { socketId, name, gender, age, filterGender }
const waitingQueue = new Map(); 

console.log(`🚀 Server starting on port ${PORT}`);

// --- CONNECTION HANDLER ---
io.on("connection", (socket) => {
  const userId = socket.handshake.query.userId;
  
  if (!userId) {
    console.warn(`[!] Connection rejected: No userId from ${socket.id}`);
    socket.disconnect();
    return;
  }

  // Join a private channel for this specific user
  socket.join(userId);

  // SESSION RECOVERY
  if (userRooms.has(userId)) {
    const roomId = userRooms.get(userId);
    socket.join(roomId);
    // On rejoin, we don't send the name because the client remembers it.
    socket.emit("match_found", { roomId, isRejoin: true });
  }

  // --- EVENTS ---

  /**
   * FIND MATCH
   */
  socket.on("find_match", (userData) => {
    // userData: { name, gender, age, filterGender, captchaToken }

    if (userRooms.has(userId)) return;

    // Update queue info (handle quick reconnects)
    if (waitingQueue.has(userId)) {
      waitingQueue.set(userId, { socketId: socket.id, ...userData });
      return;
    }

    let matchId = null;

    // ITERATE QUEUE
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

      if (!partnerSocket) {
        waitingQueue.delete(matchId);
        socket.emit("find_match", userData); // Retry
        return;
      }

      // Remove from Queue
      waitingQueue.delete(matchId);
      waitingQueue.delete(userId); 

      // Create Room
      const roomId = `room_${userId}_${matchId}`;
      userRooms.set(userId, roomId);
      userRooms.set(matchId, roomId);

      // Join Room
      socket.join(roomId);
      partnerSocket.join(roomId);

      // --- CRITICAL FIX HERE ---
      // Send DIFFERENT names to each user.
      
      // 1. Tell the Partner (matchId) they matched with Me (userData.name)
      io.to(matchId).emit("match_found", { 
        roomId, 
        partnerName: userData.name 
      });

      // 2. Tell Me (socket) I matched with the Partner (partnerData.name)
      socket.emit("match_found", { 
        roomId, 
        partnerName: partnerData.name 
      });
      
      console.log(`[✅] Matched: ${userId} (${userData.name}) <--> ${matchId} (${partnerData.name})`);

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
   */
  socket.on("send_message", (data) => {
    const roomId = userRooms.get(userId);
    if (roomId) {
      socket.to(roomId).emit("receive_message", data);
    } else {
      socket.emit("partner_skipped");
    }
  });

  /**
   * SKIP
   */
  socket.on("skip", () => {
    const roomId = userRooms.get(userId);
    waitingQueue.delete(userId);

    if (roomId) {
      socket.to(roomId).emit("partner_skipped");
      
      // Cleanup room map
      for (const [key, val] of userRooms.entries()) {
        if (val === roomId) userRooms.delete(key);
      }
      
      socket.leave(roomId);
    }
  });

  /**
   * DISCONNECT
   */
  socket.on("disconnect", () => {
    waitingQueue.delete(userId);
  });
});

httpServer.listen(PORT, () => {
  console.log(`\n>>> Server active on port ${PORT} <<<\n`);
});
