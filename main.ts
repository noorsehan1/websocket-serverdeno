import { serve } from "https://deno.land/std@0.201.0/http/server.ts";

interface WebSocketWithRoom extends WebSocket {
  roomname?: string;
  idtarget?: string;
  numkursi?: number;
}

const clients = new Set<WebSocketWithRoom>();

// Daftar room statis, bisa ganti sesuai kebutuhan
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
        case "setIdTarget": {
          const userid = data[1];
          ws.idtarget = userid;
          console.log(`User setIdTarget: ${userid}`);
          ws.send(JSON.stringify(["setIdTargetAck", userid]));
          break;
        }

        case "joinRoom": {
          const newRoom = data[1];

          if (ws.roomname && typeof ws.numkursi === "number") {
            const disconnectMsg = ["userDisconnected", ws.roomname, ws.numkursi];
            broadcastToRoom(ws.roomname, disconnectMsg);
            broadcastRoomUserCount(ws.roomname); // update old room
          }

          ws.roomname = newRoom;
          ws.numkursi = undefined;

          console.log(`User joined room: ${newRoom}`);
          broadcastRoomUserCount(newRoom); // update new room
          break;
        }

        case "updateKursi": {
          const roomname = data[1];
          const numkursi = data[2];
          ws.roomname = roomname;
          ws.numkursi = numkursi;
          broadcastToRoom(roomname, data);
          broadcastRoomUserCount(roomname);
          break;
        }

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

        case "chat":
        case "pointUpdate": {
          const roomname = data[1];
          broadcastToRoom(roomname, data);
          break;
        }

        case "private": {
          const idtarget = data[1];
          const noimageUrl = data[2];
          const messageData = data[3];
          const sender = data[4];

          const timestamp = Date.now();
          const msgToSend = [
            "private",
            noimageUrl,
            messageData,
            timestamp,
            sender,
          ];

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

        case "isUserOnline": {
          const targetId = data[1];
          let isOnline = false;
          for (const client of clients) {
            if (client.idtarget === targetId) {
              isOnline = true;
              break;
            }
          }
          ws.send(JSON.stringify(["userOnlineStatus", targetId, isOnline]));
          break;
        }

        case "getAllRoomsUserCount": {
          const counts = getJumlahRoom();
          ws.send(JSON.stringify(["allRoomsUserCount", counts]));
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
    if (ws.roomname && typeof ws.numkursi === "number") {
      const disconnectMsg = ["userDisconnected", ws.roomname, ws.numkursi];
      broadcastToRoom(ws.roomname, disconnectMsg);
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

function broadcastToRoom(roomname: string, message: any[]) {
  for (const client of clients) {
    if (client.roomname === roomname) {
      client.send(JSON.stringify(message));
    }
  }
}

function getJumlahRoom(): Record<string, number> {
  const countMap: Record<string, number> = {};

  // Init semua room dengan 0
  for (const r of allRooms) {
    countMap[r] = 0;
  }

  // Hitung user per room berdasarkan clients
  for (const client of clients) {
    if (client.roomname && client.numkursi !== undefined) {
      countMap[client.roomname] = (countMap[client.roomname] || 0) + 1;
    }
  }

  return countMap;
}

// ✅ Tambahan baru: broadcast jumlah user di satu room ke user dalam room itu saja
function broadcastRoomUserCount(roomname: string) {
  const count = getJumlahRoom()[roomname];
  const message = ["roomUserCount", roomname, count];

  for (const client of clients) {
    if (client.roomname === roomname) {
      client.send(JSON.stringify(message));
    }
  }
}


function getAllNumKursiInRoom(roomname: string): number[] {
  const kursiList: number[] = [];
  for (const client of clients) {
    if (client.roomname === roomname && client.numkursi !== undefined) {
      kursiList.push(client.numkursi);
    }
  }
  return kursiList;
}

