const { Server } = require("socket.io");
const http = require("http");

const PORT = process.env.PORT || 3000;

const httpServer = http.createServer((req, res) => {
  res.writeHead(200);
  res.end("Mingalabar Chat Server is Online!");
});

const io = new Server(httpServer, {
  cors: { origin: "*" },
  pingInterval: 10000,
  pingTimeout: 5000,
});

// --- STATE MANAGEMENT ---
// Maps userId -> roomId
const userRooms = new Map(); 

// Maps userId -> { socketId, name, gender, age, filterGender }
const waitingQueue = new Map(); 

console.log(`🚀 Server starting on port ${PORT}`);

io.on("connection", (socket) => {
  const userId = socket.handshake.query.userId;
  
  if (!userId) {
    console.log("❌ Connection rejected: No userId");
    socket.disconnect();
    return;
  }

  // Join private room for direct signaling
  socket.join(userId);

  // Rejoin logic (Persistence)
  if (userRooms.has(userId)) {
    const roomId = userRooms.get(userId);
    socket.join(roomId);
    socket.emit("match_found", { roomId, isRejoin: true });
  }

  // --- 1. FIND MATCH LOGIC ---
  socket.on("find_match", (userData) => {
    // userData comes from client: { name, gender, age, filterGender, captchaToken }
    
    // Safety: If already in a room, ignore
    if (userRooms.has(userId)) return;

    // Safety: If already waiting, update info but don't duplicate
    if (waitingQueue.has(userId)) {
      waitingQueue.set(userId, { socketId: socket.id, ...userData });
      return;
    }

    console.log(`🔍 User ${userData.name} (${userData.gender}) looking for ${userData.filterGender}`);

    // --- MATCHING ALGORITHM ---
    let matchId = null;

    for (const [candidateId, candidateData] of waitingQueue.entries()) {
      if (candidateId === userId) continue; // Don't match self

      // 1. Do THEY match MY preference?
      // (If I want 'all', anyone matches. If I want 'female', they must be 'female')
      const myPrefMatches = 
        userData.filterGender === 'all' || 
        userData.filterGender === candidateData.gender;
      
      // 2. Do I match THEIR preference?
      const theirPrefMatches = 
        candidateData.filterGender === 'all' || 
        candidateData.filterGender === userData.gender;

      if (myPrefMatches && theirPrefMatches) {
        matchId = candidateId;
        break; // Found a match!
      }
    }

    if (matchId) {
      // --- MATCH FOUND ---
      // 1. Remove both from queue
      waitingQueue.delete(matchId);
      waitingQueue.delete(userId); 

      // 2. Create Room
      const roomId = `room_${userId}_${matchId}`;
      userRooms.set(userId, roomId);
      userRooms.set(matchId, roomId);

      // 3. Join Room
      socket.join(roomId);
      
      // 4. Force Partner to Join (Signal them)
      io.to(matchId).emit("force_join_room", { roomId });

      // 5. Notify Both
      io.to(roomId).emit("match_found", { roomId });
      console.log(`✅ Matched ${userId} with ${matchId}`);

    } else {
      // --- NO MATCH, ADD TO QUEUE ---
      waitingQueue.set(userId, {
        socketId: socket.id,
        ...userData // Store profile data for others to check
      });
    }
  });

  // Handle forced join signal
  socket.on("join_specific_room", ({ roomId }) => {
    socket.join(roomId);
  });

  // --- 2. MESSAGING ---
  socket.on("send_message", (data) => {
    const roomId = userRooms.get(userId);
    if (roomId) {
      socket.to(roomId).emit("receive_message", data);
    }
  });

  // --- 3. SKIPPING ---
  socket.on("skip", () => {
    const roomId = userRooms.get(userId);
    
    // Remove from queue if they were just searching
    waitingQueue.delete(userId);

    if (roomId) {
      // Notify partner
      socket.to(roomId).emit("partner_skipped");
      
      // Clean up BOTH users from the room map
      for (const [key, val] of userRooms.entries()) {
        if (val === roomId) userRooms.delete(key);
      }
      
      // Leave socket room
      socket.leave(roomId);
    }
  });

  // --- 4. DISCONNECT ---
  socket.on("disconnect", () => {
    // Only remove from waiting queue. 
    // We KEEP the room active for a bit in case they reconnect (app switch/internet blip)
    waitingQueue.delete(userId);
  });
});

httpServer.listen(PORT);
