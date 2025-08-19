// deno-lint-ignore-file no-explicit-any
import { serve } from "https://deno.land/std@0.201.0/http/server.ts";

// ====== Konstanta & Tipe ======
const roomList = [
  "Chill Zone", "Catch Up", "Casual Vibes", "Lounge Talk", "Easy Talk",
  "Friendly Corner", "The Hangout", "Vibe Spot", "Talk Hub", "Relaxed Chat"
] as const;

type RoomName = typeof roomList[number];
const MAX_SEATS = 50;

interface SeatInfo {
  noimageUrl: string;
  namauser: string;
  color: string;
  itembawah: string;
  itematas: string;
  vip: string;
  viptanda: string;
  points: number;
  lockTime?: number;
}

interface WebSocketWithRoom extends WebSocket {
  room?: RoomName;
  userId?: string;
  targetId?: string;
}

const clients = new Set<WebSocketWithRoom>();
const userToSeat = new Map<string, { room: RoomName; seat: number }>();
const roomSeats = new Map<RoomName, Map<number, SeatInfo>>();

// ====== Utilitas ======
function createEmptySeat(): SeatInfo {
  return {
    noimageUrl: "", namauser: "", color: "",
    itembawah: "", itematas: "",
    vip: "", viptanda: "", points: 0
  };
}

function resetSeat(room: RoomName, seat: number) {
  roomSeats.get(room)?.set(seat, createEmptySeat());
}

function safeSend(ws: WebSocket, data: any) {
  try {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(data));
    }
  } catch {
    clients.delete(ws as WebSocketWithRoom);
  }
}

function assertValidRoom(room: string): asserts room is RoomName {
  if (!roomList.includes(room as RoomName)) throw new Error("Invalid room");
}

function broadcastToRoom(room: RoomName, msg: any) {
  for (const client of [...clients]) {
    if (client.room === room) safeSend(client, msg);
  }
}

function getJumlahRoom(room: RoomName) {
  let count = 0;
  for (const client of clients) if (client.room === room) count++;
  return count;
}

function broadcastRoomUserCount() {
  const counts = roomList.map(r => ({ room: r, jumlah: getJumlahRoom(r) }));
  for (const client of [...clients]) {
    safeSend(client, { type: "allRoomsUserCount", counts });
  }
}

function handleGetAllRoomsUserCount(ws: WebSocketWithRoom) {
  const counts = roomList.map(r => ({ room: r, jumlah: getJumlahRoom(r) }));
  safeSend(ws, { type: "allRoomsUserCount", counts });
}

// ====== Buffers ======
const pointUpdateBuffer = new Map<string, number>();
const updateKursiBuffer = new Map<string, any[]>();
const chatMessageBuffer = new Map<string, any[]>();
const privateMessageBuffer = new Map<string, any[]>();

function flushPrivateMessageBuffer() {
  for (const [targetId, messages] of privateMessageBuffer) {
    for (const client of clients) {
      if (client.userId === targetId) {
        for (const msg of messages) safeSend(client, msg);
      }
    }
  }
  privateMessageBuffer.clear();
}

function flushChatBuffer() {
  for (const [room, messages] of chatMessageBuffer) {
    for (const client of clients) {
      if (client.room === room) {
        for (const msg of messages) safeSend(client, msg);
      }
    }
  }
  chatMessageBuffer.clear();
}

function flushPointUpdates() {
  if (pointUpdateBuffer.size === 0) return;
  const updates = [...pointUpdateBuffer.entries()].map(([key, points]) => {
    const [room, seat] = key.split(":");
    return { room, seat: Number(seat), points };
  });
  for (const client of clients) safeSend(client, { type: "pointUpdates", updates });
  pointUpdateBuffer.clear();
}

function flushKursiUpdates() {
  for (const [room, updates] of updateKursiBuffer) {
    for (const client of clients) {
      if (client.room === room) safeSend(client, { type: "kursiUpdates", updates });
    }
  }
  updateKursiBuffer.clear();
}

// ====== Interval & Locks ======
let currentNumber = 0;
const maxNumber = 100;
const intervalMillis = 10 * 1000;

setInterval(() => {
  currentNumber = (currentNumber % maxNumber) + 1;
  for (const client of clients) safeSend(client, { type: "currentNumber", value: currentNumber });
}, intervalMillis);

function cleanExpiredLocks() {
  const now = Date.now();
  for (const [room, seats] of roomSeats) {
    for (const [seat, info] of seats) {
      if (info.lockTime && now - info.lockTime > 10000) {
        resetSeat(room, seat);
        broadcastToRoom(room, { type: "kursiUpdate", seat, data: createEmptySeat() });
      }
    }
  }
}

function lockSeat(room: RoomName, seat: number) {
  roomSeats.get(room)?.get(seat)!.lockTime = Date.now();
}

function cleanupBuffers() {
  pointUpdateBuffer.clear();
  updateKursiBuffer.clear();
  chatMessageBuffer.clear();
  privateMessageBuffer.clear();
}

setInterval(() => {
  flushPrivateMessageBuffer();
  flushChatBuffer();
  flushPointUpdates();
  flushKursiUpdates();
  cleanExpiredLocks();
}, 100);

// ====== Event Handlers ======
function handleSetIdTarget(ws: WebSocketWithRoom, msg: any) {
  ws.userId = msg.userId;
  ws.targetId = msg.targetId;
}

function handlePing(ws: WebSocketWithRoom) {
  safeSend(ws, { type: "pong" });
}

function handleJoinRoom(ws: WebSocketWithRoom, msg: any) {
  try {
    assertValidRoom(msg.room);
    ws.room = msg.room;
    ws.userId = msg.userId;

    if (!roomSeats.has(msg.room)) {
      const seats = new Map<number, SeatInfo>();
      for (let i = 0; i < MAX_SEATS; i++) seats.set(i, createEmptySeat());
      roomSeats.set(msg.room, seats);
    }
    const seats = [...(roomSeats.get(msg.room)?.entries() ?? [])];
    safeSend(ws, { type: "initialState", seats });
    broadcastRoomUserCount();
  } catch {
    safeSend(ws, { type: "error", message: "Invalid room" });
  }
}

function handleChat(ws: WebSocketWithRoom, msg: any) {
  if (!ws.room) return;
  const arr = chatMessageBuffer.get(ws.room) || [];
  arr.push({ type: "chat", namauser: msg.namauser, text: msg.text });
  chatMessageBuffer.set(ws.room, arr);
}

function handleUpdatePoint(msg: any) {
  const key = `${msg.room}:${msg.seat}`;
  pointUpdateBuffer.set(key, msg.points);
  roomSeats.get(msg.room)?.get(msg.seat)!.points = msg.points;
}

function handleRemoveKursi(msg: any) {
  assertValidRoom(msg.room);
  resetSeat(msg.room, msg.seat);
  broadcastToRoom(msg.room, { type: "kursiUpdate", seat: msg.seat, data: createEmptySeat() });
}

function handleUpdateKursi(msg: any) {
  assertValidRoom(msg.room);
  const seats = roomSeats.get(msg.room)!;
  seats.set(msg.seat, msg.data);
  lockSeat(msg.room, msg.seat);
  const arr = updateKursiBuffer.get(msg.room) || [];
  arr.push({ seat: msg.seat, data: msg.data });
  updateKursiBuffer.set(msg.room, arr);
}

function handleSendNotif(msg: any) {
  for (const client of clients) safeSend(client, { type: "notif", message: msg.message });
}

function handlePrivate(ws: WebSocketWithRoom, msg: any) {
  if (!ws.userId || !ws.targetId) return;
  const arr = privateMessageBuffer.get(ws.targetId) || [];
  arr.push({ type: "private", from: ws.userId, text: msg.text });
  privateMessageBuffer.set(ws.targetId, arr);
}

function handleIsUserOnline(ws: WebSocketWithRoom, msg: any) {
  const isOnline = [...clients].some(c => c.userId === msg.userId);
  safeSend(ws, { type: "isUserOnline", userId: msg.userId, online: isOnline });
}

// ====== WebSocket Server ======
serve((req) => {
  if (req.headers.get("upgrade") !== "websocket") return new Response("not websocket", { status: 400 });
  const { socket, response } = Deno.upgradeWebSocket(req);
  const ws = socket as WebSocketWithRoom;

  ws.onopen = () => clients.add(ws);

  ws.onmessage = (ev) => {
    try {
      const msg = JSON.parse(ev.data);
      switch (msg.type) {
        case "setIdTarget": handleSetIdTarget(ws, msg); break;
        case "ping": handlePing(ws); break;
        case "getAllRoomsUserCount": handleGetAllRoomsUserCount(ws); break;
        case "getCurrentNumber": safeSend(ws, { type: "currentNumber", value: currentNumber }); break;
        case "joinRoom": handleJoinRoom(ws, msg); break;
        case "chat": handleChat(ws, msg); break;
        case "updatePoint": handleUpdatePoint(msg); break;
        case "removeKursiAndPoint": handleRemoveKursi(msg); break;
        case "updateKursi": handleUpdateKursi(msg); break;
        case "sendnotif": handleSendNotif(msg); break;
        case "private": handlePrivate(ws, msg); break;
        case "isUserOnline": handleIsUserOnline(ws, msg); break;
        default: console.warn("Unknown message type:", msg.type);
      }
    } catch (err) {
      console.error("Message error:", err);
    }
  };

  ws.onclose = () => {
    clients.delete(ws);
    if (ws.room && ws.userId) {
      for (const [seat, info] of roomSeats.get(ws.room) ?? []) {
        if (info.namauser === ws.userId) {
          resetSeat(ws.room, seat);
          broadcastToRoom(ws.room, { type: "kursiUpdate", seat, data: createEmptySeat() });
        }
      }
    }
    broadcastRoomUserCount();
    cleanupBuffers();
  };

  return response;
});

console.log("✅ WebSocket server running on :80");
