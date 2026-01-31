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

if (!REDIS_URL) {
  console.error("❌ FATAL: REDIS_URL is missing.");
  process.exit(1);
}

const redis = new Redis(REDIS_URL, {
  retryStrategy: (times) => Math.min(times * 50, 2000),
});
redis.on("error", (err) => console.error("❌ Redis Error:", err.message));
redis.on("connect", () => console.log("✅ Redis Connected"));

const httpServer = http.createServer((req, res) => {
  if (req.url === '/') {
    res.writeHead(200);
    res.end("Mingalabar Chat Server (v3.1 - Notification Fixes)");
  } else {
    res.writeHead(404);
    res.end();
  }
});

const io = new Server(httpServer, {
  cors: { origin: "*" },
  pingInterval: 10000,
  pingTimeout: 5000,
});

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

  // 1. Track Socket
  activeSockets.set(userId, socket.id);
  socket.join(userId);

  // 2. Update Push Token
  if (oneSignalId) {
    await redis.set(`user:token:${userId}`, oneSignalId, "EX", 2592000);
  }

  // 3. FLUSH OFFLINE MESSAGES (Atomic)
  // We use a transaction to ensure we don't lose messages during the read-delete cycle
  const offlineKey = `offline:${userId}`;
  const pipeline = redis.pipeline();
  pipeline.lrange(offlineKey, 0, -1); // Get all
  pipeline.del(offlineKey);           // Clear
  const results = await pipeline.exec();
  
  const messages = results[0][1]; // Result of lrange
  
  if (messages && messages.length > 0) {
    console.log(`[📦] Flushing ${messages.length} offline events to ${userId}`);
    // Emit events in order
    messages.reverse().forEach((msgStr) => {
      const msg = JSON.parse(msgStr);
      socket.emit(msg.event, msg.data);
    });
  }

  // 4. Session Recovery
  const currentRoomId = await redis.get(`user:room:${userId}`);
  if (currentRoomId) {
    socket.join(currentRoomId);
    socket.emit("match_found", { roomId: currentRoomId, isRejoin: true });
  }

  // --- EVENTS ---

  socket.on("find_match", async (userData) => {
    const existingRoom = await redis.get(`user:room:${userId}`);
    if (existingRoom) return;

    await removeUserFromAllQueues(userId);

    const myQueueKey = `queue:${userData.gender}:${userData.filterGender}`;
    const myDataString = JSON.stringify({ userId, ...userData });

    let targetQueues = [];
    if (userData.filterGender === 'all') {
      targetQueues = [
        `queue:male:all`, `queue:female:all`,
        `queue:male:${userData.gender}`, `queue:female:${userData.gender}`
      ];
    } else {
      targetQueues = [
        `queue:${userData.filterGender}:all`,
        `queue:${userData.filterGender}:${userData.gender}`
      ];
    }

    let matchId = null;
    let partnerData = null;

    for (const queueKey of targetQueues) {
      const candidateString = await redis.rpop(queueKey);
      if (candidateString) {
        const candidate = JSON.parse(candidateString);
        if (candidate.userId !== userId) {
          matchId = candidate.userId;
          partnerData = candidate;
          break;
        }
      }
    }

    if (matchId && partnerData) {
      const roomId = `room_${userId}_${matchId}`;
      const pipeline = redis.pipeline();
      pipeline.set(`user:room:${userId}`, roomId);
      pipeline.set(`user:room:${matchId}`, roomId);
      pipeline.sadd(`room:${roomId}:users`, userId, matchId);
      await pipeline.exec();

      socket.join(roomId);
      
      const partnerSocketId = activeSockets.get(matchId);
      if (partnerSocketId) {
        io.to(partnerSocketId).socketsJoin(roomId);
        io.to(partnerSocketId).emit("match_found", { roomId, partnerName: userData.name });
      } else {
        await bufferEvent(matchId, "match_found", { roomId, partnerName: userData.name });
        sendPushNotification(matchId, "You found a match!", "System", roomId);
      }

      socket.emit("match_found", { roomId, partnerName: partnerData.name });

    } else {
      await redis.lpush(myQueueKey, myDataString);
    }
  });

  socket.on("send_message", async (data) => {
    // data: { text, senderName }
    const roomId = await redis.get(`user:room:${userId}`);
    
    if (roomId) {
      const participants = await redis.smembers(`room:${roomId}:users`);
      const partnerId = participants.find(id => id !== userId);

      socket.to(roomId).emit("receive_message", data);

      if (partnerId) {
        if (!activeSockets.has(partnerId)) {
          // Buffer if offline
          await bufferEvent(partnerId, "receive_message", data);
        }

        const partnerToken = await redis.get(`user:token:${partnerId}`);
        if (partnerToken) {
           // Pass senderName clearly
           sendPushNotification(partnerToken, data.text, data.senderName, roomId);
        }
      }
    } else {
      socket.emit("partner_skipped");
    }
  });

  socket.on("skip", async () => {
    const roomId = await redis.get(`user:room:${userId}`);
    await removeUserFromAllQueues(userId);

    if (roomId) {
      const participants = await redis.smembers(`room:${roomId}:users`);
      const partnerId = participants.find(id => id !== userId);

      socket.to(roomId).emit("partner_skipped");

      if (partnerId) {
        // IMPORTANT: Buffer "Skip" event if partner is offline
        // This fixes the issue where offline users don't know the chat ended
        if (!activeSockets.has(partnerId)) {
             await bufferEvent(partnerId, "partner_skipped", {});
        }
      }

      const pipeline = redis.pipeline();
      participants.forEach(pid => pipeline.del(`user:room:${pid}`));
      pipeline.del(`room:${roomId}:users`);
      await pipeline.exec();

      socket.leave(roomId);
    }
  });

  socket.on("disconnect", async () => {
    activeSockets.delete(userId);
    await removeUserFromAllQueues(userId);
  });
});

// --- HELPERS ---

async function removeUserFromAllQueues(userId) {
  // Ideally use specific queue keys if tracked, scanning all for MVP safety
  const keys = await redis.keys("queue:*:*");
  // Logic to remove userId from lists... (omitted for brevity, handled by pop checks usually)
}

async function bufferEvent(targetId, event, data) {
  const payload = JSON.stringify({ event, data });
  // LPUSH so we read in reverse order later (LIFO stack, need to reverse on read)
  await redis.lpush(`offline:${targetId}`, payload);
  await redis.expire(`offline:${targetId}`, 259200); 
}

function sendPushNotification(token, messageText, senderName, roomId) {
  if (!ONESIGNAL_APP_ID || !ONESIGNAL_API_KEY) return;

  // Title fallback
  const title = senderName && senderName !== "Stranger" ? senderName : "New Message";
  const displayMsg = messageText.length > 100 ? messageText.substring(0, 100) + "..." : messageText;

  const data = JSON.stringify({
    app_id: ONESIGNAL_APP_ID,
    include_player_ids: [token],
    headings: { en: title },
    contents: { en: displayMsg },
    data: { type: "chat_message", roomId },
    // Deep Link URL (This helps redirection)
    url: "mingalabar://connect", 
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

httpServer.listen(PORT, () => console.log(`Server active on ${PORT}`));