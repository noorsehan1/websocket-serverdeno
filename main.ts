// ===== Import =====
import { serve } from "https://deno.land/std@0.201.0/http/server.ts";

// ===== Constants & Types =====
const roomList = [
  "Chill Zone", "Catch Up", "Casual Vibes", "Lounge Talk", "Easy Talk",
  "Friendly Corner", "The Hangout", "Relax & Chat", "Just Chillin", "The Chatter Room"
] as const;

type RoomName = typeof roomList[number];
const allRooms = new Set<RoomName>(roomList);
const MAX_SEATS = 35;
const clients = new Set<WebSocketWithRoom>();

interface SeatInfo {
  noimageUrl: string;
  namauser: string;
  color: string;
  itembawah: number;
  itematas: number;
  vip: boolean;
  viptanda: number;
  points: Array<{ x: number; y: number; fast: number }>;
  lockTime?: number;
}

interface WebSocketWithRoom extends WebSocket {
  roomname?: RoomName;
  idtarget?: string;
  numkursi?: Set<number>;
}

const userToSeat: Map<string, { room: RoomName; seat: number }> = new Map();
const roomSeats: Map<RoomName, Map<number, SeatInfo>> = new Map();

// ===== Initialize Seats =====
for (const room of allRooms) {
  const seatMap = new Map<number, SeatInfo>();
  for (let i = 1; i <= MAX_SEATS; i++) seatMap.set(i, createEmptySeat());
  roomSeats.set(room, seatMap);
}

// ===== Utilities =====
function createEmptySeat(): SeatInfo {
  return { noimageUrl: "", namauser: "", color: "", itembawah: 0, itematas: 0, vip: false, viptanda: 0, points: [] };
}
function resetSeat(info: SeatInfo) { Object.assign(info, createEmptySeat()); }
function safeSend(ws: WebSocketWithRoom, msg: any) {
  try {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
    else clients.delete(ws);
  } catch { clients.delete(ws); }
}
function assertValidRoom(room: any): room is RoomName {
  if (!allRooms.has(room)) throw new Error("Unknown room: " + room);
  return true;
}
function broadcastToRoom(room: RoomName, msg: any) {
  for (const c of [...clients]) if (c.roomname === room) safeSend(c, msg);
}
function getJumlahRoom(): Record<RoomName, number> {
  const cnt = Object.fromEntries(roomList.map(r => [r, 0])) as Record<RoomName, number>;
  for (const room of allRooms) {
    const seatMap = roomSeats.get(room)!;
    for (const info of seatMap.values()) if (info.namauser && !info.namauser.startsWith("__LOCK__")) cnt[room]++;
  }
  return cnt;
}
function broadcastRoomUserCount(room: RoomName) {
  broadcastToRoom(room, ["roomUserCount", room, getJumlahRoom()[room] || 0]);
}

// ===== Buffers =====
const pointUpdateBuffer = new Map<RoomName, Map<number, Array<{ x: number; y: number; fast: number }>>>();
const updateKursiBuffer = new Map<RoomName, Map<number, SeatInfo>>();
const chatMessageBuffer = new Map<RoomName, Array<any>>();
const privateMessageBuffer = new Map<string, Array<any>>();

function flushPrivateMessageBuffer() {
  for (const [idtarget, messages] of privateMessageBuffer) {
    for (const c of clients) if (c.idtarget === idtarget) messages.forEach(m => safeSend(c, m));
    messages.length = 0;
  }
}
function flushChatBuffer() {
  for (const [room, messages] of chatMessageBuffer) {
    messages.forEach(m => broadcastToRoom(room, m));
    messages.length = 0;
  }
}
function flushPointUpdates() {
  for (const [room, seatMap] of pointUpdateBuffer) {
    for (const [seat, points] of seatMap) {
      points.forEach(p => broadcastToRoom(room, ["pointUpdated", room, seat, p.x, p.y, p.fast]));
      points.length = 0;
    }
  }
}
function flushKursiUpdates() {
  for (const [room, seatMap] of updateKursiBuffer) {
    const updates: Array<[number, Omit<SeatInfo, "points">]> = [];
    for (const [seat, info] of seatMap) {
      const { points, ...rest } = info;
      updates.push([seat, rest]);
    }
    if (updates.length > 0) {
      broadcastToRoom(room, ["kursiBatchUpdate", room, updates]);
      seatMap.clear();
    }
  }
}

// ===== Current Number =====
let currentNumber = 1;
setInterval(() => {
  currentNumber = currentNumber < 6 ? currentNumber + 1 : 1;
  for (const c of [...clients]) safeSend(c, ["currentNumber", currentNumber]);
}, 15 * 60 * 1000);

// ===== Locks =====
function cleanExpiredLocks() {
  const now = Date.now();
  for (const room of allRooms) {
    const seatMap = roomSeats.get(room)!;
    for (const [seat, info] of seatMap) {
      if (info.namauser.startsWith("__LOCK__") && info.lockTime && now - info.lockTime > 10000) {
        resetSeat(info);
        broadcastToRoom(room, ["removeKursi", room, seat]);
        broadcastRoomUserCount(room);
      }
    }
  }
}

// ===== Helpers =====
function lockSeat(room: RoomName, ws: WebSocketWithRoom): number | null {
  const seatMap = roomSeats.get(room)!;
  if (!ws.idtarget) return null;
  for (let i = 1; i <= MAX_SEATS; i++) {
    const kursi = seatMap.get(i)!;
    if (kursi.namauser === "") {
      kursi.namauser = "__LOCK__" + ws.idtarget;
      kursi.lockTime = Date.now();
      return i;
    }
  }
  return null;
}
function cleanupBuffers(ws: WebSocketWithRoom) {
  if (ws.idtarget) { privateMessageBuffer.delete(ws.idtarget); userToSeat.delete(ws.idtarget); }
}

// ===== Periodic Flush =====
setInterval(() => {
  flushPointUpdates();
  flushKursiUpdates();
  flushChatBuffer();
  flushPrivateMessageBuffer();
  cleanExpiredLocks();
}, 100);

// ===== Event Handlers =====
function handleMessage(ws: WebSocketWithRoom, dataStr: string) {
  try {
    const data = JSON.parse(dataStr);
    if (!Array.isArray(data)) return;
    const [evt, ...args] = data;
    switch (evt) {
      case "setIdTarget": ws.idtarget = args[0]; safeSend(ws, ["setIdTargetAck", ws.idtarget]); break;
      case "ping": if (args[0] && ws.idtarget === args[0]) safeSend(ws, ["pong"]); break;
      case "getAllRoomsUserCount":
        safeSend(ws, ["allRoomsUserCount", roomList.map(r => [r, getJumlahRoom()[r]])]);
        break;
      case "getCurrentNumber": safeSend(ws, ["currentNumber", currentNumber]); break;
      case "joinRoom":
        try { assertValidRoom(args[0]); } catch { return; }
        const newRoom = args[0]; const foundSeat = lockSeat(newRoom, ws);
        if (foundSeat === null) return safeSend(ws, ["roomFull", newRoom]);
        ws.roomname = newRoom; ws.numkursi = new Set([foundSeat]);
        safeSend(ws, ["numberKursiSaya", foundSeat]);
        broadcastRoomUserCount(newRoom);
        break;
      case "chat":
        if (!chatMessageBuffer.has(args[0])) chatMessageBuffer.set(args[0], []);
        chatMessageBuffer.get(args[0])!.push(["chat", ...args]);
        break;
      default: safeSend(ws, ["error", "Unknown event"]); break;
    }
  } catch (err) { console.error("Error handling message:", err); }
}

// ===== Serve WebSocket =====
serve((req) => {
  const upgrade = req.headers.get("upgrade") || "";
  if (upgrade.toLowerCase() !== "websocket") return new Response("Expected websocket", { status: 400 });

  const { socket, response } = Deno.upgradeWebSocket(req);
  const ws = socket as WebSocketWithRoom;
  clients.add(ws);

  ws.onopen = () => { ws.numkursi = new Set<number>(); console.log("Client connected"); };
  ws.onmessage = (ev) => handleMessage(ws, ev.data);
  ws.onclose = () => {
    try {
      if (ws.roomname && ws.numkursi) {
        const seatMap = roomSeats.get(ws.roomname)!;
        for (const seat of ws.numkursi) { resetSeat(seatMap.get(seat)!); broadcastToRoom(ws.roomname, ["removeKursi", ws.roomname, seat]); }
        broadcastRoomUserCount(ws.roomname);
      }
      cleanupBuffers(ws);
    } finally {
      clients.delete(ws);
      ws.numkursi?.clear();
      ws.roomname = undefined;
    }
  };

  return response;
});
