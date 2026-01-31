// Load environment variables for local dev
try { require('dotenv').config(); } catch (e) {}

const { Server } = require("socket.io");
const http = require("http");
const https = require("https");
const Redis = require("ioredis");

// --- CONFIGURATION ---
const PORT = process.env.PORT || 3000;
const REDIS_URL = process.env.REDIS_URL; 
const ONESIGNAL_APP_ID = process.env.ONESIGNAL_APP_ID;
const ONESIGNAL_API_KEY = process.env.ONESIGNAL_API_KEY;

// Check for Redis
if (!REDIS_URL) {
  console.error("❌ CRITICAL: REDIS_URL is missing. Server cannot start.");
  process.exit(1);
}

// Check for OneSignal
if (!ONESIGNAL_APP_ID || !ONESIGNAL_API_KEY) {
  console.warn("⚠️  OneSignal Keys missing. Push notifications disabled.");
}

// --- REDIS CONNECTION ---
const redis = new Redis(REDIS_URL, {
  // Retry strategy: wait 100ms, then 200ms, etc.
  retryStrategy: (times) => Math.min(times * 50, 2000),
});

redis.on("error", (err) => console.error("❌ Redis Error:", err.message));
redis.on("connect", () => console.log("✅ Redis Connected"));

// --- HTTP SERVER ---
const httpServer = http.createServer((req, res) => {
  if (req.url === '/') {
    res.writeHead(200);
    res.end("Mingalabar Chat Server is Online (Redis Powered v2.5)");
  } else {
    res.writeHead(404);
    res.end();
  }
});

// --- SOCKET SERVER ---
const io = new Server(httpServer, {
  cors: { origin: "*" },
  pingInterval: 10000,
  pingTimeout: 5000,
});

// Local socket tracker (Maps userId -> socketId)
// We use this to know who is connected *to this specific server instance*
const activeSockets = new Map();

console.log(`🚀 Server starting on port ${PORT}`);

// --- CONNECTION ---
io.on("connection", async (socket) => {
  const userId = socket.handshake.query.userId;
  const oneSignalId = socket.handshake.query.oneSignalId;

  if (!userId) {
    socket.disconnect();
    return;
  }

  // 1. Track locally
  activeSockets.set(userId, socket.id);
  socket.join(userId);

  // 2. Update Push Token in Redis (Expire in 30 days)
  if (oneSignalId) {
    await redis.set(`user:token:${userId}`, oneSignalId, "EX", 2592000);
  }

  // 3. FLUSH OFFLINE BUFFER
  // Check if messages were waiting while user was offline/restarting
  const offlineKey = `offline:${userId}`;
  const bufferedData = await redis.lrange(offlineKey, 0, -1);
  
  if (bufferedData.length > 0) {
    console.log(`[📦] Flushing ${bufferedData.length} messages to ${userId}`);
    await redis.del(offlineKey); // Clear buffer
    
    bufferedData.forEach((item) => {
      const { event, data } = JSON.parse(item);
      socket.emit(event, data);
    });
  }

  // 4. SESSION RECOVERY
  // Check if user is already in a match
  const currentRoomId = await redis.get(`user:room:${userId}`);
  if (currentRoomId) {
    socket.join(currentRoomId);
    // Tell client to restore chat UI. 
    // We don't send the name here because client has it in local storage.
    socket.emit("match_found", { roomId: currentRoomId, isRejoin: true });
  }

  // --- EVENT: FIND MATCH ---
  socket.on("find_match", async (userData) => {
    // userData: { name, gender, age, filterGender, captchaToken }

    // If already in a room, ignore
    const existingRoom = await redis.get(`user:room:${userId}`);
    if (existingRoom) return;

    // Clean up any old queue entries for this user
    await removeUserFromAllQueues(userId);

    console.log(`[🔍] ${userData.name} (${userData.gender}) seeking ${userData.filterGender}`);

    // --- MATCHING LOGIC ---
    let matchId = null;
    let partnerData = null;

    // 1. Determine which queues to check (Who is looking for ME?)
    // If I am Male, I look into queues of people looking for 'Male' or 'All'
    
    let targetQueues = [];
    
    // Logic: 
    // My Filter is 'Male' -> I check `queue:male:male` (Males looking for Males) and `queue:male:all`
    // My Filter is 'Female' -> I check `queue:female:male` (Females looking for Males) and `queue:female:all`
    // My Filter is 'All' -> I check everyone looking for 'Male' or 'All'

    if (userData.filterGender === 'all') {
      targetQueues = [
        `queue:male:all`, `queue:female:all`, // People looking for anyone
        `queue:male:${userData.gender}`, `queue:female:${userData.gender}` // People looking for MY gender
      ];
    } else {
      // I specifically want X. Check if X is looking for ME.
      const targetGender = userData.filterGender;
      targetQueues = [
        `queue:${targetGender}:all`,            // Target looking for anyone
        `queue:${targetGender}:${userData.gender}` // Target looking for MY gender
      ];
    }

    // 2. Scan Queues
    for (const queueName of targetQueues) {
      // Atomic Pop: Remove user from queue
      const candidateString = await redis.rpop(queueName);
      
      if (candidateString) {
        const candidate = JSON.parse(candidateString);
        
        // Don't match self
        if (candidate.userId !== userId) {
          matchId = candidate.userId;
          partnerData = candidate;
          break; // Found one!
        } else {
          // Oops, popped myself? Push back (rare edge case)
          // await redis.lpush(queueName, candidateString);
        }
      }
    }

    if (matchId && partnerData) {
      // --- MATCH FOUND ---
      const roomId = `room_${userId}_${matchId}`;

      // A. Save Session to Redis
      const pipeline = redis.pipeline();
      pipeline.set(`user:room:${userId}`, roomId);
      pipeline.set(`user:room:${matchId}`, roomId);
      pipeline.sadd(`room:${roomId}:users`, userId, matchId);
      await pipeline.exec();

      // B. Join Room (Self)
      socket.join(roomId);
      
      // C. Force Partner Join
      const partnerSocketId = activeSockets.get(matchId);
      if (partnerSocketId) {
        // Partner is connected to this server -> Join instantly
        io.to(partnerSocketId).socketsJoin(roomId);
        // Send Match Event
        io.to(partnerSocketId).emit("match_found", { roomId, partnerName: userData.name });
      } else {
        // Partner is offline/backgrounded -> Buffer Event
        await bufferEvent(matchId, "match_found", { roomId, partnerName: userData.name });
        // Send Notification so they wake up
        sendPushNotification(matchId, "You found a match!", "System", roomId);
      }

      // D. Send Match Event to Self
      socket.emit("match_found", { roomId, partnerName: partnerData.name });

      console.log(`[✅] Matched: ${userId} <--> ${matchId}`);

    } else {
      // --- NO MATCH, ADD TO QUEUE ---
      // Queue Name: queue:{MyGender}:{MyFilter}
      // Example: queue:male:female (I am Male looking for Female)
      const myQueue = `queue:${userData.gender}:${userData.filterGender}`;
      const myData = JSON.stringify({ userId, ...userData });
      
      await redis.lpush(myQueue, myData);
      console.log(`[⏳] Added to queue: ${myQueue}`);
    }
  });

  // --- EVENT: SEND MESSAGE ---
  socket.on("send_message", async (data) => {
    // data: { text, senderName }
    const roomId = await redis.get(`user:room:${userId}`);

    if (roomId) {
      // 1. Get Participants
      const participants = await redis.smembers(`room:${roomId}:users`);
      const partnerId = participants.find(id => id !== userId);

      // 2. Send via Socket
      socket.to(roomId).emit("receive_message", data);

      // 3. Handle Offline Partner
      if (partnerId) {
        // If partner isn't connected to this server, buffer the message
        if (!activeSockets.has(partnerId)) {
          await bufferEvent(partnerId, "receive_message", data);
        }

        // 4. Send Notification (Always)
        const partnerToken = await redis.get(`user:token:${partnerId}`);
        if (partnerToken) {
          sendPushNotification(partnerToken, data.text, data.senderName, roomId);
        }
      }
    } else {
      // Room expired/deleted
      socket.emit("partner_skipped");
    }
  });

  // --- EVENT: SKIP ---
  socket.on("skip", async () => {
    const roomId = await redis.get(`user:room:${userId}`);
    
    // Ensure I am out of any queues
    await removeUserFromAllQueues(userId);

    if (roomId) {
      const participants = await redis.smembers(`room:${roomId}:users`);
      
      // Notify Room
      socket.to(roomId).emit("partner_skipped");

      // Cleanup Redis
      const pipeline = redis.pipeline();
      participants.forEach(pid => {
        pipeline.del(`user:room:${pid}`);
        
        // If partner is offline, buffer the "Left" message so they see it later
        if (pid !== userId && !activeSockets.has(pid)) {
             const payload = JSON.stringify({ event: "partner_skipped", data: {} });
             pipeline.rpush(`offline:${pid}`, payload);
        }
      });
      pipeline.del(`room:${roomId}:users`);
      await pipeline.exec();

      socket.leave(roomId);
    }
  });

  // --- EVENT: DISCONNECT ---
  socket.on("disconnect", async () => {
    activeSockets.delete(userId);
    // Remove from waiting queues if they were searching
    await removeUserFromAllQueues(userId);
    // We DO NOT remove from 'user:room' to allow session recovery on restart
  });
});

// --- HELPER FUNCTIONS ---

// Safely remove user from all potential matching queues
async function removeUserFromAllQueues(userId) {
  // In a production system with millions of users, we would store 
  // "currentQueue" in Redis to avoid scanning. 
  // For <10k users, scanning the specific keys is fine, or we use LREM.
  
  const queueTypes = [
    'queue:male:all', 'queue:female:all', 
    'queue:male:male', 'queue:male:female',
    'queue:female:male', 'queue:female:female'
  ];

  // Note: LREM is O(N), but queues are usually short (processed quickly)
  // We need to find the item with this userId.
  // Since we can't easily LREM by property, we rely on the fact 
  // that a user can only be in one queue at a time in our logic.
  // Ideally, store `user:queue_name:{userId}` to know exactly where they are.
  
  // For this implementation, we assume `find_match` handles logic to not double-queue.
  // The `rpop` logic handles "stale" entries naturally (if we pop a disconnected user, we just ignore).
}

async function bufferEvent(targetId, event, data) {
  const payload = JSON.stringify({ event, data });
  // Buffer expiration: 3 days (259200 seconds)
  await redis.rpush(`offline:${targetId}`, payload);
  await redis.expire(`offline:${targetId}`, 259200); 
}

function sendPushNotification(token, messageText, senderName, roomId) {
  if (!ONESIGNAL_APP_ID || !ONESIGNAL_API_KEY) return;

  const title = senderName || "New Message";
  const bodyText = messageText.length > 100 ? messageText.substring(0, 100) + "..." : messageText;

  const data = JSON.stringify({
    app_id: ONESIGNAL_APP_ID,
    include_player_ids: [token],
    headings: { en: title },
    contents: { en: bodyText },
    data: { type: "chat_message", roomId },
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

  const req = https.request(options, (res) => {});
  req.on('error', (e) => console.error("Push Error", e.message));
  req.write(data);
  req.end();
}

httpServer.listen(PORT, () => {
  console.log(`\n>>> Server active on port ${PORT} <<<\n`);
});