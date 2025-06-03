import { serve } from "https://deno.land/std@0.201.0/http/server.ts";

interface WebSocketWithRoom extends WebSocket {
  roomname?: string;
  idtarget?: string;
}

const clients = new Set<WebSocketWithRoom>();

serve((req) => {
  const upgrade = req.headers.get("upgrade") || "";
  if (upgrade.toLowerCase() !== "websocket") {
    return new Response("Expected websocket", { status: 400 });
  }

  const { socket, response } = Deno.upgradeWebSocket(req);
  const ws = socket as WebSocketWithRoom;

  clients.add(ws);

  ws.onopen = () => {
    console.log("Client connected");
  };

  ws.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data);
      if (!Array.isArray(data) || data.length === 0) {
        ws.send(JSON.stringify(["error", "Invalid message format"]));
        return;
      }

      const eventType = data[0];

      switch (eventType) {
        case "setIdTarget": {
          const userid = data[1];
          ws.idtarget = userid;
          console.log(`User setIdTarget: ${userid}`);

          // Optional: acknowledge to client
          ws.send(JSON.stringify(["setIdTargetAck", userid]));
          break;
        }

        case "joinRoom": {
          const roomname = data[1];
          ws.roomname = roomname;
          console.log(`User joined room: ${roomname}`);
          break;
        }

        case "updateKursi":
        case "removeKursi":
        case "chat":
        case "pointUpdate": {
          const roomname = data[1];
          console.log(`Broadcasting ${eventType} event to room ${roomname}`);
          broadcastToRoom(roomname, data);
          break;
        }

        case "private": {
          const idtarget = data[1];
          const noimageUrl = data[2];
          const messageData = data[3];
          const sender = data[5];
          const replyToMessageId = data.length > 6 ? data[6] : null;

          // Timestamp dibuat server
         const timestamp = Date.now(); // timestamp dalam milidetik


          const msgToSend = [
            "private",
            noimageUrl,
            messageData,
            timestamp,
            sender,
            replyToMessageId,
          ];

          let sent = false;
          for (const client of clients) {
            if (client.idtarget === idtarget) {
              client.send(JSON.stringify(msgToSend));
              sent = true;
              break;
            }
          }

          if (!sent) {
            // Kirim notifikasi gagal ke pengirim (ws.idtarget = pengirim)
            if (ws.idtarget) {
              ws.send(JSON.stringify(["privateFailed", idtarget, "User not online"]));
            }
          }
          break;
        }

        default: {
          console.log(`Unknown event type: ${eventType}`);
          ws.send(JSON.stringify(["error", "Unknown event type"]));
        }
      }
    } catch (e) {
      console.error("Error parsing message:", e);
      ws.send(JSON.stringify(["error", "Failed to parse message"]));
    }
  };

  ws.onclose = () => {
    clients.delete(ws);
    console.log("Client disconnected");
  };

  ws.onerror = (err) => {
    console.error("WebSocket error:", err);
  };

  return response;
});

function broadcastToRoom(roomname: string, message: any[]) {
  for (const client of clients) {
    if (client.roomname === roomname) {
      client.send(JSON.stringify(message));
    }
  }
}
