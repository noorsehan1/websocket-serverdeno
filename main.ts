// server.ts
import { serve } from "https://deno.land/std@0.201.0/http/server.ts";

interface WebSocketWithRoom extends WebSocket {
  roomname?: string;
  idtarget?: string;
  numkursi?: number;
}

const clients = new Set<WebSocketWithRoom>();

// Daftar room statis
const allRooms = new Set([
  "room1",
  "room2",
  "room3",
  "room4",
  "room5",
]);

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
        // 1) Set ID target untuk private chat
        case "setIdTarget": {
          const userid = data[1];
          ws.idtarget = userid;
          console.log(`User setIdTarget: ${userid}`);
          ws.send(JSON.stringify(["setIdTargetAck", userid]));
          break;
        }

        // 2) Join a room
        case "joinRoom": {
          const newRoom = data[1];

          // Jika sebelumnya sudah di room lain: broadcast disconnection & update count
          if (ws.roomname && typeof ws.numkursi === "number") {
            broadcastToRoom(ws.roomname, ["userDisconnected", ws.roomname, ws.numkursi]);
            broadcastRoomUserCount(ws.roomname);
          }

          ws.roomname = newRoom;
          ws.numkursi = undefined;

          console.log(`User joined room: ${newRoom}`);
          broadcastRoomUserCount(newRoom);

          // Kirim list kursi yang sudah terisi ke user baru
          const kursiList = getAllNumKursiInRoom(newRoom);
          ws.send(JSON.stringify(["numKursiList", newRoom, kursiList]));
          break;
        }

        // 3) Update kursi (occupy)
        case "updateKursi": {
          const roomname = data[1];
          const numkursi = data[2];
          ws.roomname = roomname;
          ws.numkursi = numkursi;
          broadcastToRoom(roomname, data);
          broadcastRoomUserCount(roomname);
          break;
        }

        // 4) Remove kursi (free)
        case "removeKursi": {
          const roomname = data[1];
          const numkursi = data[2];
          if (ws.roomname === roomname && ws.numkursi === numkursi) {
            ws.numkursi = undefined;
          }
          broadcastToRoom(roomname, data);
          broadcastRoomUserCount(roomname);
          break;
        }

        // 5) Chat & point update (dibroadcast saja)
        case "chat":
        case "pointUpdate": {
          const roomname = data[1];
          broadcastToRoom(roomname, data);
          break;
        }

        // 6) Private message
        case "private": {
          const idtarget = data[1];
          const noimageUrl = data[2];
          const messageData = data[3];
          const sender = data[4];
          const timestamp = Date.now();
          const msgToSend = ["private", noimageUrl, messageData, timestamp, sender];

          let sent = false;
          for (const client of clients) {
            if (client.idtarget === idtarget) {
              client.send(JSON.stringify(msgToSend));
              sent = true;
              break;
            }
          }
          if (!sent && ws.idtarget) {
            ws.send(JSON.stringify(["privateFailed", idtarget, "User not online"]));
          }
          break;
        }

        // 7) Cek status online user lain
        case "isUserOnline": {
          const targetId = data[1];
          const isOnline = Array.from(clients).some(c => c.idtarget === targetId);
          ws.send(JSON.stringify(["userOnlineStatus", targetId, isOnline]));
          break;
        }

        // 8) Minta semua room user count
        case "getAllRoomsUserCount": {
          handleGetAllRoomsUserCount(ws);
          break;
        }

        // 9) Minta list kursi terisi dalam satu room
        case "getAllNumKursi": {
          const roomname = data[1];
          const kursiList = getAllNumKursiInRoom(roomname);
          ws.send(JSON.stringify(["numKursiList", roomname, kursiList]));
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
    // Broadcast jika user disconnect sambil duduk di kursi
    if (ws.roomname && typeof ws.numkursi === "number") {
      broadcastToRoom(ws.roomname, ["userDisconnected", ws.roomname, ws.numkursi]);
      broadcastRoomUserCount(ws.roomname);
    }
    clients.delete(ws);
    console.log("Client disconnected");
  };

  ws.onerror = (err) => {
    console.error("WebSocket error:", err);
  };

  return response;
});

/** Kirim message ke semua client di satu room */
function broadcastToRoom(roomname: string, message: any[]) {
  for (const client of clients) {
    if (client.roomname === roomname) {
      client.send(JSON.stringify(message));
    }
  }
}

/** Hitung jumlah user per room */
function getJumlahRoom(): Record<string, number> {
  const countMap: Record<string, number> = {};
  for (const r of allRooms) {
    countMap[r] = 0;
  }
  for (const client of clients) {
    if (client.roomname && client.numkursi !== undefined) {
      countMap[client.roomname]++;
    }
  }
  return countMap;
}

/** Kirim roomUserCount hanya ke client di room tersebut */
function broadcastRoomUserCount(roomname: string) {
  const count = getJumlahRoom()[roomname] ?? 0;
  const msg = ["roomUserCount", roomname, count];
  for (const client of clients) {
    if (client.roomname === roomname) {
      client.send(JSON.stringify(msg));
    }
  }
}

/** Ambil semua kursi (numkursi) yang terisi di room */
function getAllNumKursiInRoom(roomname: string): number[] {
  return Array.from(clients)
    .filter(c => c.roomname === roomname && c.numkursi !== undefined)
    .map(c => c.numkursi as number);
}

/** Handler untuk getAllRoomsUserCount */
function handleGetAllRoomsUserCount(ws: WebSocketWithRoom) {
  const counts = getJumlahRoom();
  ws.send(JSON.stringify(["allRoomsUserCount", counts]));
}
