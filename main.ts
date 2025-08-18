// =====================
// IMPORT
// =====================
import { serve } from "https://deno.land/std/http/server.ts";

// =====================
// TYPES & INTERFACES
// =====================
interface WebSocketWithRoom extends WebSocket {
  roomname?: string;
  idtarget?: string;
  userId?: string;
}

interface SeatInfo {
  id: string;
  kursi: number;
  point: number;
}

// =====================
// DATA STRUCTURES
// =====================
const clients = new Set<WebSocketWithRoom>();
const roomSeats = new Map<string, Map<number, SeatInfo>>();
const userToSeat = new Map<string, { room: string; seat: number }>();

const updateKursiBuffer = new Map<string, Map<number, SeatInfo>>();
const pointBuffer = new Map<string, Map<string, number>>();
const chatBuffer = new Map<string, any[]>();

// KV
const kv = await Deno.openKv();

// =====================
// UTILS
// =====================
function broadcastToRoom(room: string, data: any) {
  for (const client of clients) {
    if (client.roomname === room) {
      try {
        client.send(JSON.stringify(data));
      } catch (_) {}
    }
  }
}

function resetSeat(seatInfo: SeatInfo) {
  seatInfo.id = "";
  seatInfo.point = 0;
}

function broadcastRoomUserCount(room: string) {
  let count = 0;
  for (const client of clients) {
    if (client.roomname === room) count++;
  }
  broadcastToRoom(room, ["roomUserCount", room, count]);
}

// =====================
// EVENT HANDLERS
// =====================
async function handleJoinRoom(
  ws: WebSocketWithRoom,
  room: string,
  seat: number,
  userId: string,
) {
  ws.roomname = room;
  ws.userId = userId;
  if (!roomSeats.has(room)) roomSeats.set(room, new Map());
  const seats = roomSeats.get(room)!;

  const seatInfo: SeatInfo = { id: userId, kursi: seat, point: 0 };
  seats.set(seat, seatInfo);
  userToSeat.set(userId, { room, seat });

  await kv.set(["room", room, seat], seatInfo, { expireIn: 30_000 });
  broadcastToRoom(room, ["updateKursi", room, seatInfo]);
  broadcastRoomUserCount(room);
}

async function handleUpdateKursi(ws: WebSocketWithRoom, seat: number, point: number) {
  if (!ws.roomname || !ws.userId) return;
  const room = ws.roomname;
  const seatInfo = roomSeats.get(room)?.get(seat);
  if (!seatInfo) return;

  seatInfo.point = point;
  if (!updateKursiBuffer.has(room)) updateKursiBuffer.set(room, new Map());
  updateKursiBuffer.get(room)!.set(seat, seatInfo);

  await kv.set(["room", room, seat], seatInfo, { expireIn: 30_000 });
}

async function handleRemoveKursiAndPoint(ws: WebSocketWithRoom, seat: number) {
  if (!ws.roomname) return;
  const room = ws.roomname;
  const seatInfo = roomSeats.get(room)?.get(seat);
  if (!seatInfo) return;

  resetSeat(seatInfo);
  roomSeats.get(room)!.delete(seat);
  userToSeat.delete(seatInfo.id);

  if (updateKursiBuffer.has(room)) updateKursiBuffer.get(room)!.delete(seat);
  await kv.delete(["room", room, seat]);

  broadcastToRoom(room, ["removeKursi", room, seat]);
  broadcastRoomUserCount(room);
}

async function handleUpdatePoint(ws: WebSocketWithRoom, point: number) {
  if (!ws.roomname || !ws.userId) return;
  const room = ws.roomname;
  if (!pointBuffer.has(room)) pointBuffer.set(room, new Map());
  pointBuffer.get(room)!.set(ws.userId, point);
  await kv.set(["point", room, ws.userId], point, { expireIn: 30_000 });
}

async function handleChat(ws: WebSocketWithRoom, message: string) {
  if (!ws.roomname || !ws.userId) return;
  const room = ws.roomname;
  const payload = { userId: ws.userId, message, ts: Date.now() };
  if (!chatBuffer.has(room)) chatBuffer.set(room, []);
  chatBuffer.get(room)!.push(payload);

  await kv.set(["chat", room, crypto.randomUUID()], payload, { expireIn: 60_000 });
}

async function handlePrivate(ws: WebSocketWithRoom, targetId: string, message: string) {
  if (!ws.userId) return;
  const payload = { from: ws.userId, to: targetId, message, ts: Date.now() };
  await kv.set(["private", targetId, crypto.randomUUID()], payload, { expireIn: 10_000 });
}

async function handleIsUserOnline(ws: WebSocketWithRoom, targetId: string) {
  const online = await kv.get(["online", targetId]);
  ws.send(JSON.stringify(["isUserOnline", targetId, !!online.value]));
}

// =====================
// PERIODIC FLUSH
// =====================
setInterval(() => {
  // kursi
  for (const [room, seatMap] of updateKursiBuffer.entries()) {
    for (const seatInfo of seatMap.values()) {
      broadcastToRoom(room, ["updateKursi", room, seatInfo]);
    }
    seatMap.clear();
  }
  // point
  for (const [room, points] of pointBuffer.entries()) {
    for (const [userId, point] of points.entries()) {
      broadcastToRoom(room, ["updatePoint", userId, point]);
    }
    points.clear();
  }
  // chat
  for (const [room, chats] of chatBuffer.entries()) {
    for (const chat of chats) broadcastToRoom(room, ["chat", chat]);
    chats.length = 0;
  }
}, 2000);

setInterval(async () => {
  for (const client of clients) {
    if (client.userId) {
      await kv.set(["online", client.userId], true, { expireIn: 20_000 });
    }
  }
}, 10_000);

// =====================
// KV WATCH (REALTIME SYNC)
// =====================
(async () => {
  const roomsIter = kv.watch({ prefix: ["room"] });
  for await (const entries of roomsIter) {
    for (const e of entries) {
      if (e.value) {
        const [_, room, seat] = e.key as [string, string, number];
        broadcastToRoom(room, ["updateKursi", room, e.value]);
      } else {
        const [_, room, seat] = e.key as [string, string, number];
        broadcastToRoom(room, ["removeKursi", room, seat]);
      }
    }
  }
})();

(async () => {
  const pointsIter = kv.watch({ prefix: ["point"] });
  for await (const entries of pointsIter) {
    for (const e of entries) {
      if (e.value) {
        const [_, room, userId] = e.key as [string, string, string];
        broadcastToRoom(room, ["updatePoint", userId, e.value]);
      }
    }
  }
})();

(async () => {
  const chatsIter = kv.watch({ prefix: ["chat"] });
  for await (const entries of chatsIter) {
    for (const e of entries) {
      if (e.value) {
        const [_, room] = e.key as [string, string, string];
        broadcastToRoom(room, ["chat", e.value]);
      }
    }
  }
})();

(async () => {
  const privIter = kv.watch({ prefix: ["private"] });
  for await (const entries of privIter) {
    for (const e of entries) {
      if (e.value) {
        const [_, targetId] = e.key as [string, string, string];
        for (const client of clients) {
          if (client.userId === targetId) {
            try {
              client.send(JSON.stringify(["private", e.value]));
            } catch (_) {}
          }
        }
      }
    }
  }
})();

(async () => {
  const notifIter = kv.watch({ prefix: ["notif"] });
  for await (const entries of notifIter) {
    for (const e of entries) {
      if (e.value) {
        const [_, room] = e.key as [string, string];
        broadcastToRoom(room, ["sendnotif", e.value]);
      }
    }
  }
})();

// =====================
// SERVER
// =====================
serve((req) => {
  if (req.headers.get("upgrade") !== "websocket") {
    return new Response("Not a websocket request");
  }

  const { socket, response } = Deno.upgradeWebSocket(req);
  const ws = socket as WebSocketWithRoom;
  clients.add(ws);

  ws.onmessage = async (event) => {
    try {
      const [type, ...args] = JSON.parse(event.data);
      switch (type) {
        case "setIdTarget":
          ws.idtarget = args[0];
          break;
        case "ping":
          if (ws.userId) {
            await kv.set(["online", ws.userId], true, { expireIn: 20_000 });
          }
          ws.send(JSON.stringify(["pong"]));
          break;
        case "joinRoom":
          await handleJoinRoom(ws, args[0], args[1], args[2]);
          break;
        case "updateKursi":
          await handleUpdateKursi(ws, args[0], args[1]);
          break;
        case "removeKursiAndPoint":
          await handleRemoveKursiAndPoint(ws, args[0]);
          break;
        case "updatePoint":
          await handleUpdatePoint(ws, args[0]);
          break;
        case "chat":
          await handleChat(ws, args[0]);
          break;
        case "private":
          await handlePrivate(ws, args[0], args[1]);
          break;
        case "isUserOnline":
          await handleIsUserOnline(ws, args[0]);
          break;
        case "sendnotif":
          if (ws.roomname) {
            await kv.set(
              ["notif", ws.roomname, crypto.randomUUID()],
              args[0],
              { expireIn: 10_000 },
            );
          }
          break;
      }
    } catch (e) {
      console.error("WS error:", e);
    }
  };

  ws.onclose = async () => {
    clients.delete(ws);
    if (ws.userId && ws.roomname) {
      const seatData = userToSeat.get(ws.userId);
      if (seatData) {
        await kv.delete(["room", seatData.room, seatData.seat]);
        roomSeats.get(seatData.room)?.delete(seatData.seat);
        broadcastToRoom(seatData.room, [
          "removeKursi",
          seatData.room,
          seatData.seat,
        ]);
      }
      await kv.delete(["point", ws.roomname, ws.userId]);
      await kv.delete(["online", ws.userId]);
      userToSeat.delete(ws.userId);
    }
    if (ws.roomname) broadcastRoomUserCount(ws.roomname);
  };

  return response;
});
