const clients = new Map<string, WebSocket>();
const rooms = new Map<string, Set<string>>();

Deno.serve((req) => {
  const upgradeHeader = req.headers.get("upgrade") || "";

  if (upgradeHeader.toLowerCase() !== "websocket") {
    return new Response("This endpoint only supports WebSocket connections", { status: 400 });
  }

  const { socket, response } = Deno.upgradeWebSocket(req);
  let userId: string | null = null;

  socket.onopen = () => {
    console.log("✅ Client connected");
  };

  socket.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data);
      const { type, roomname, idtarget } = data;
      console.log("📨 Received:", data);

      if (!type || typeof type !== "string") {
        socket.send(JSON.stringify({ type: "error", message: "Missing or invalid type" }));
        return;
      }

      if (!userId && type !== "setIdTarget") {
        socket.send(JSON.stringify({ type: "error", message: "User ID not set yet" }));
        return;
      }

      switch (type) {
        case "setIdTarget": {
          userId = idtarget;
          if (!userId || typeof userId !== "string") {
            socket.send(JSON.stringify({ type: "error", message: "Missing or invalid idtarget" }));
            return;
          }
          clients.set(userId, socket);
          console.log(`👤 User registered: ${userId}`);
          break;
        }

        case "joinRoom": {
          if (!roomname || typeof roomname !== "string") return;
          if (!rooms.has(roomname)) {
            rooms.set(roomname, new Set());
          }
          rooms.get(roomname)!.add(userId!);
          console.log(`👥 ${userId} joined room ${roomname}`);
          break;
        }

        case "updateKursi":
        case "removeKursi":
        case "chat":
        case "pointUpdate": {
          if (!roomname || typeof roomname !== "string") return;
          const members = rooms.get(roomname);
          if (!members) return;

          for (const uid of members) {
            const clientSocket = clients.get(uid);
            if (clientSocket && clientSocket.readyState === WebSocket.OPEN) {
              clientSocket.send(event.data);
            }
          }
          break;
        }

        case "private": {
          if (!idtarget || typeof idtarget !== "string") return;

          const targetSocket = clients.get(idtarget);
          if (targetSocket && targetSocket.readyState === WebSocket.OPEN) {
            targetSocket.send(event.data);
          }

          if (userId && clients.get(userId) !== targetSocket) {
            const senderSocket = clients.get(userId);
            if (senderSocket && senderSocket.readyState === WebSocket.OPEN) {
              senderSocket.send(event.data);
            }
          }
          break;
        }

        default:
          socket.send(JSON.stringify({ type: "error", message: `Unknown message type: ${type}` }));
      }
    } catch (err) {
      console.error("❌ Failed to parse message:", err);
      socket.send(JSON.stringify({ type: "error", message: "Invalid JSON format" }));
    }
  };

  socket.onclose = () => {
    if (userId) {
      clients.delete(userId);
      rooms.forEach((userSet, room) => {
        userSet.delete(userId!);
        if (userSet.size === 0) {
          rooms.delete(room);
        }
      });
      console.log(`🔌 Disconnected: ${userId}`);
    }
  };

  socket.onerror = (err) => {
    console.error("⚠️ Socket error:", err);
  };

  return response;
});
