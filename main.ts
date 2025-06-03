const clients = new Map<string, WebSocket>();
const rooms = new Map<string, Set<string>>();

Deno.serve(async (req: Request) => {
  const { socket, response } = Deno.upgradeWebSocket(req);
  let userId: string | null = null;

  socket.onopen = () => {
    console.log("Client connected");
  };

  socket.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data);
      const { type, roomname, idtarget } = data;

      if (!type) {
        socket.send(JSON.stringify({ type: "error", message: "Missing type" }));
        return;
      }

      if (!userId && type !== "setIdTarget") {
        socket.send(JSON.stringify({ type: "error", message: "User ID not set" }));
        return;
      }

      switch (type) {
        case "setIdTarget":
          userId = idtarget;
          if (!userId) {
            socket.send(JSON.stringify({ type: "error", message: "Missing idtarget" }));
            return;
          }
          clients.set(userId, socket);
          break;

        case "joinRoom":
          if (!roomname) return;
          if (!rooms.has(roomname)) {
            rooms.set(roomname, new Set());
          }
          rooms.get(roomname)!.add(userId);
          break;

        case "updateKursi":
        case "removeKursi":
        case "chat":
        case "pointUpdate":
          if (!roomname || !rooms.has(roomname)) return;
          rooms.get(roomname)!.forEach((uid) => {
            const client = clients.get(uid);
            if (client) {
              client.send(JSON.stringify(data));
            }
          });
          break;

        case "private":
          if (!idtarget) return;
          const target = clients.get(idtarget);
          if (target) target.send(JSON.stringify(data));
          if (userId && clients.get(userId) !== target) {
            clients.get(userId)?.send(JSON.stringify(data));
          }
          break;

        default:
          socket.send(JSON.stringify({ type: "error", message: "Unknown type" }));
          break;
      }

    } catch {
      socket.send(JSON.stringify({ type: "error", message: "Invalid JSON" }));
    }
  };

  socket.onclose = () => {
    if (userId) {
      clients.delete(userId);
      rooms.forEach((set, room) => {
        set.delete(userId!);
        if (set.size === 0) rooms.delete(room);
      });
    }
  };

  socket.onerror = (err) => {
    console.error("Socket error:", err);
  };

  return response;
});
