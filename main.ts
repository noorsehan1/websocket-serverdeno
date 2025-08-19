// deno-lint-ignore-file no-explicit-any
import { serve } from "https://deno.land/std@0.201.0/http/server.ts";

// ---------- Konstanta & Tipe ----------
const roomList = [
  "Chill Zone",
  "Catch Up",
  "Casual Vibes",
  "Lounge Talk",
  "Easy Talk",
  "Friendly Corner",
  "The Hangout",
] as const;
type RoomName = (typeof roomList)[number];
const MAX_SEATS = 30;

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
}

const clients = new Set<WebSocketWithRoom>();
const userToSeat = new Map<string, { room: RoomName; seat: number }>();
const roomSeats = new Map<RoomName, Map<number, SeatInfo>>();

for (const room of roomList) {
  const seats = new Map<number, SeatInfo>();
  for (let i = 1; i <= MAX_SEATS; i++) {
    seats.set(i, createEmptySeat());
  }
  roomSeats.set(room, seats);
}

// ---------- Utilities ----------
function createEmptySeat(): SeatInfo {
  return {
    noimageUrl: "",
    namauser: "",
    color: "",
    itembawah: "",
    itematas: "",
    vip: "",
    viptanda: "",
    points: 0,
  };
}

function resetSeat(room: RoomName, seat: number) {
  const seatData = roomSeats.get(room)?.get(seat);
  if (seatData) {
    roomSeats.get(room)!.set(seat, createEmptySeat());
  }
}

function safeSend(ws: WebSocket, data: any) {
  try {
    ws.send(JSON.stringify(data));
  } catch {
    clients.delete(ws as WebSocketWithRoom);
    try {
      ws.close();
    } catch {}
  }
}

function assertValidRoom(room: string): asserts room is RoomName {
  if (!roomList.includes(room as RoomName)) {
    throw new Error(`Invalid room: ${room}`);
  }
}

function broadcastToRoom(room: RoomName, data: any) {
  for (const client of [...clients]) {
    if (client.room === room) safeSend(client, data);
  }
}

function getJumlahRoom(room: RoomName): number {
  let count = 0;
  for (const client of clients) {
    if (client.room === room) count++;
  }
  return count;
}

function broadcastRoomUserCount(room: RoomName) {
  const jumlah = getJumlahRoom(room);
  broadcastToRoom(room, { type: "jumlahUser", jumlah });
}

function handleGetAllRoomsUserCount(ws: WebSocket) {
  const result: Record<string, number> = {};
  for (const room of roomList) {
    result[room] = getJumlahRoom(room);
  }
  safeSend(ws, { type: "allRoomsUserCount", data: result });
}

// ---------- Buffers ----------
const pointUpdateBuffer: { room: RoomName; seat: number; points: number }[] = [];
const updateKursiBuffer: {
  room: RoomName;
  seat: number;
  data: SeatInfo;
}[] = [];
const chatMessageBuffer: {
  room: RoomName;
  message: any;
}[] = [];
const privateMessageBuffer: { to: string; message: any }[] = [];

function flushPrivateMessageBuffer() {
  if (!privateMessageBuffer.length) return;
  const copy = [...privateMessageBuffer];
  privateMessageBuffer.length = 0;
  for (const pm of copy) {
    for (const client of [...clients]) {
      if (client.userId === pm.to) safeSend(client, pm.message);
    }
  }
}

function flushChatBuffer() {
  if (!chatMessageBuffer.length) return;
  const copy = [...chatMessageBuffer];
  chatMessageBuffer.length = 0;
  for (const cm of copy) {
    broadcastToRoom(cm.room, cm.message);
  }
}

function flushPointUpdates() {
  if (!pointUpdateBuffer.length) return;
  const grouped: Record<string, Record<number, number>> = {};
  for (const upd of pointUpdateBuffer) {
    grouped[upd.room] ??= {};
    grouped[upd.room][upd.seat] = upd.points;
  }
  pointUpdateBuffer.length = 0;
  for (const room in grouped) {
    broadcastToRoom(room as RoomName, {
      type: "pointUpdates",
      updates: grouped[room],
    });
  }
}

function flushKursiUpdates() {
  if (!updateKursiBuffer.length) return;
  const grouped: Record<string, Record<number, SeatInfo>> = {};
  for (const upd of updateKursiBuffer) {
    grouped[upd.room] ??= {};
    grouped[upd.room][upd.seat] = upd.data;
  }
  updateKursiBuffer.length = 0;
  for (const room in grouped) {
    broadcastToRoom(room as RoomName, {
      type: "kursiUpdates",
      updates: grouped[room],
    });
  }
}

// ---------- Interval & Locks ----------
let currentNumber = 1;
const maxNumber = 100;
const intervalMillis = 10000;

setInterval(() => {
  currentNumber = currentNumber >= maxNumber ? 1 : currentNumber + 1;
}, intervalMillis);

function cleanExpiredLocks() {
  const now = Date.now();
  for (const [room, seats] of roomSeats.entries()) {
    for (const [seat, info] of seats.entries()) {
      if (info.lockTime && now - info.lockTime > 10000) {
        const seatData = roomSeats.get(room)?.get(seat);
        if (seatData) {
          seatData.lockTime = undefined;
        }
      }
    }
  }
}

function lockSeat(room: RoomName, seat: number): boolean {
  const seatData = roomSeats.get(room)?.get(seat);
  if (seatData) {
    if (seatData.lockTime && Date.now() - seatData.lockTime < 10000) return false;
    seatData.lockTime = Date.now();
    return true;
  }
  return false;
}

function cleanupBuffers() {
  pointUpdateBuffer.length = 0;
  updateKursiBuffer.length = 0;
  chatMessageBuffer.length = 0;
  privateMessageBuffer.length = 0;
}

// ---------- Periodic Flush ----------
setInterval(() => {
  flushPrivateMessageBuffer();
  flushChatBuffer();
  flushPointUpdates();
  flushKursiUpdates();
  cleanExpiredLocks();
}, 100);

// ---------- Handlers ----------
function handleSetIdTarget(ws: WebSocketWithRoom, id: string) {
  ws.userId = id;
}

function handlePing(ws: WebSocket) {
  safeSend(ws, { type: "pong" });
}

function handleJoinRoom(ws: WebSocketWithRoom, room: RoomName) {
  ws.room = room;
  broadcastRoomUserCount(room);
}

function handleChat(ws: WebSocketWithRoom, msg: any) {
  if (!ws.room) return;
  chatMessageBuffer.push({ room: ws.room, message: msg });
}

function handleUpdatePoint(msg: any) {
  const targetSeat = roomSeats.get(msg.room)?.get(msg.seat);
  if (targetSeat) {
    targetSeat.points = msg.points;
    pointUpdateBuffer.push({
      room: msg.room,
      seat: msg.seat,
      points: msg.points,
    });
  }
}

function handleRemoveKursi(msg: any) {
  assertValidRoom(msg.room);
  resetSeat(msg.room, msg.seat);
  broadcastToRoom(msg.room, {
    type: "kursiRemoved",
    seat: msg.seat,
  });
}

function handleUpdateKursi(msg: any) {
  assertValidRoom(msg.room);
  if (!lockSeat(msg.room, msg.seat)) return;
  const seatData = roomSeats.get(msg.room)?.get(msg.seat);
  if (seatData) {
    roomSeats.get(msg.room)!.set(msg.seat, msg.data);
    updateKursiBuffer.push({
      room: msg.room,
      seat: msg.seat,
      data: msg.data,
    });
  }
}

function handleSendNotif(msg: any) {
  broadcastToRoom(msg.room, { type: "notif", message: msg.message });
}

function handlePrivate(msg: any) {
  privateMessageBuffer.push({ to: msg.to, message: msg });
}

function handleIsUserOnline(ws: WebSocket, id: string) {
  const online = [...clients].some((c) => c.userId === id);
  safeSend(ws, { type: "isUserOnlineResult", id, online });
}

// ---------- WebSocket Server ----------
serve((req: Request) => {
  const { socket, response } = Deno.upgradeWebSocket(req);
  const ws = socket as WebSocketWithRoom;

  clients.add(ws);

  ws.onopen = () => {
    console.log("New connection");
  };

  ws.onmessage = (event) => {
    try {
      const msg = JSON.parse(event.data);
      switch (msg.type) {
        case "setIdTarget":
          handleSetIdTarget(ws, msg.id);
          break;
        case "ping":
          handlePing(ws);
          break;
        case "getAllRoomsUserCount":
          handleGetAllRoomsUserCount(ws);
          break;
        case "getCurrentNumber":
          safeSend(ws, { type: "currentNumber", number: currentNumber });
          break;
        case "joinRoom":
          handleJoinRoom(ws, msg.room);
          break;
        case "chat":
          handleChat(ws, msg);
          break;
        case "updatePoint":
          handleUpdatePoint(msg);
          break;
        case "removeKursiAndPoint":
          handleRemoveKursi(msg);
          break;
        case "updateKursi":
          handleUpdateKursi(msg);
          break;
        case "sendnotif":
          handleSendNotif(msg);
          break;
        case "private":
          handlePrivate(msg);
          break;
        case "isUserOnline":
          handleIsUserOnline(ws, msg.id);
          break;
      }
    } catch (e) {
      console.error("Failed to handle message:", e);
    }
  };

  ws.onclose = () => {
    clients.delete(ws);
    if (ws.room) {
      broadcastRoomUserCount(ws.room);
      cleanupBuffers();
    }
  };

  return response;
});
