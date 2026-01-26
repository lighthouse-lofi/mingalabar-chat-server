const { Server } = require("socket.io");
const http = require("http");

const PORT = process.env.PORT || 3000;

const httpServer = http.createServer((req, res) => {
  res.writeHead(200);
  res.end("Mingalabar Chat Server is Running!");
});

const io = new Server(httpServer, {
  cors: {
    origin: "*", 
  },
});

// STATE
const waitingQueue = new Set(); 
const activeChats = new Map(); 

io.on("connection", (socket) => {
  console.log("User connected:", socket.id);

  socket.on("find_match", () => {
    // Logic to remove from current chat if exists
    if (activeChats.has(socket.id)) leaveRoom(socket);
    if (waitingQueue.has(socket.id)) return;

    if (waitingQueue.size > 0) {
      const [partnerId] = waitingQueue;
      waitingQueue.delete(partnerId);

      const partnerSocket = io.sockets.sockets.get(partnerId);

      if (!partnerSocket) {
        socket.emit("find_match"); 
        return;
      }

      const roomId = `room_${socket.id}_${partnerId}`;
      socket.join(roomId);
      partnerSocket.join(roomId);

      activeChats.set(socket.id, roomId);
      activeChats.set(partnerId, roomId);

      io.to(roomId).emit("match_found", { roomId });
    } else {
      waitingQueue.add(socket.id);
    }
  });

  socket.on("send_message", (data) => {
    const roomId = activeChats.get(socket.id);
    if (roomId) {
      socket.to(roomId).emit("receive_message", data);
    }
  });

  socket.on("skip", () => {
    const roomId = activeChats.get(socket.id);
    if (roomId) {
      socket.to(roomId).emit("partner_skipped");
      leaveRoom(socket);
    }
  });

  socket.on("disconnect", () => {
    if (waitingQueue.has(socket.id)) waitingQueue.delete(socket.id);
    const roomId = activeChats.get(socket.id);
    if (roomId) {
      socket.to(roomId).emit("partner_disconnected");
      activeChats.delete(socket.id);
    }
  });

  const leaveRoom = (userSocket) => {
    const roomId = activeChats.get(userSocket.id);
    if (roomId) {
      userSocket.leave(roomId);
      activeChats.delete(userSocket.id);
    }
  };
});

httpServer.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
