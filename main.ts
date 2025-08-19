import { serve } from "https://deno.land/std@0.201.0/http/server.ts";

// ====== KV Init ======
const kv = await Deno.openKv();

// ===== Constants & Types =====
const roomList = [
  "Chill Zone",
  "Catch Up",
  "Casual Vibes",
  "Lounge Talk",
  "Easy Talk",
  "Friendly Corner",
  "The Hangout",
  "Relax & Chat",
  "Just Chillin",
  "The Chatter Room"
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

// ===== Local Cache =====
const userToSeat: Map<string, { room: RoomName; seat: number }> = new Map();
const roomSeats: Map<RoomName, Map<number, SeatInfo>> = new Map();
for (const room of allRooms) {
  const seatMap = new Map<number, SeatInfo>();
  for (let i = 1; i <= MAX_SEATS; i++) seatMap.set(i, createEmptySeat());
  roomSeats.set(room, seatMap);
}

// ===== Restore seats from KV at startup =====
for (const room of allRooms) {
  for await (const entry of kv.list({ prefix: ["seat", room] })) {
    const [, , seat] = entry.key as [string, RoomName, number];
    roomSeats.get(room)!.set(seat, entry.value as SeatInfo);
  }
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
const chatMessageBuffer: Map<RoomName, Array<any>> = new Map();
const privateMessageBuffer: Map<string, Array<any>> = new Map();

// ===== Current Number =====
let currentNumber = 1;
const maxNumber = 6;
const intervalMillis = 15 * 60 * 1000;
setInterval(() => {
  currentNumber = currentNumber < maxNumber ? currentNumber + 1 : 1;
  for (const c of [...clients]) safeSend(c, ["currentNumber", currentNumber]);
}, intervalMillis);

// ===== Locks =====
function cleanExpiredLocks() {
  const now = Date.now();
  for (const room of allRooms) {
    const seatMap = roomSeats.get(room)!;
    for (const [seat, info] of seatMap) {
      if (info.namauser.startsWith("__LOCK__") && info.lockTime && now - info.lockTime > 10000) {
        resetSeat(info);
        kv.delete(["seat", room, seat]);
        broadcastToRoom(room, ["removeKursi", room, seat]);
        broadcastRoomUserCount(room);
      }
    }
  }
}

// ===== Seat Utilities =====
async function lockSeat(room: RoomName, ws: WebSocketWithRoom): Promise<number | null> {
  const seatMap = roomSeats.get(room)!;
  if (!ws.idtarget) return null;
  for (let i = 1; i <= MAX_SEATS; i++) {
    const kursi = seatMap.get(i)!;
    if (!kursi.namauser) {
      kursi.namauser = "__LOCK__" + ws.idtarget;
      kursi.lockTime = Date.now();
      await kv.set(["seat", room, i], kursi);
      return i;
    }
  }
  return null;
}
function cleanupBuffers(ws: WebSocketWithRoom) {
  if (ws.idtarget) {
    privateMessageBuffer.delete(ws.idtarget);
    userToSeat.delete(ws.idtarget);
  }
}

// ===== Handlers =====
function handleSetIdTarget(ws: WebSocketWithRoom, id: string) {
  ws.idtarget = id;
  safeSend(ws, ["setIdTargetAck", ws.idtarget]);
}
function handlePing(ws: WebSocketWithRoom, pingId: string) {
  if (pingId && ws.idtarget === pingId) safeSend(ws, ["pong"]);
}
async function handleJoinRoom(ws: WebSocketWithRoom, newRoom: RoomName) {
  try { assertValidRoom(newRoom); } catch { return safeSend(ws, ["error", `Unknown room: ${newRoom}`]); }
  const foundSeat = await lockSeat(newRoom, ws);
  if (foundSeat === null) return safeSend(ws, ["roomFull", newRoom]);

  ws.roomname = newRoom;
  ws.numkursi = new Set([foundSeat]);
  safeSend(ws, ["numberKursiSaya", foundSeat]);
  if (ws.idtarget) userToSeat.set(ws.idtarget, { room: newRoom, seat: foundSeat });

  // restore kursi dari KV
  const allSeats: any = {};
  for await (const entry of kv.list({ prefix: ["seat", newRoom] })) {
    const [, , seat] = entry.key as [string, RoomName, number];
    const info = entry.value as SeatInfo;
    if (info.namauser && !info.namauser.startsWith("__LOCK__")) {
      const { points, ...rest } = info;
      allSeats[seat] = rest;
    }
  }
  safeSend(ws, ["allUpdateKursiList", newRoom, allSeats]);
  broadcastRoomUserCount(newRoom);
}
function handleChat(ws: WebSocketWithRoom, room: RoomName, url: string, user: string, msg: string, c1: string, c2: string) {
  if (!chatMessageBuffer.has(room)) chatMessageBuffer.set(room, []);
  const out = ["chat", room, url, user, msg, c1, c2];
  chatMessageBuffer.get(room)!.push(out);
  broadcastToRoom(room, out);
}
async function handleUpdateKursi(ws: WebSocketWithRoom, room: RoomName, seat: number, noimageUrl: string, namauser: string, color: string, itembawah: number, itematas: number, vip: boolean, viptanda: number) {
  const seatInfo: SeatInfo = { noimageUrl, namauser, color, itembawah, itematas, vip, viptanda, points: [] };
  roomSeats.get(room)!.set(seat, seatInfo);
  await kv.set(["seat", room, seat], seatInfo);
  broadcastToRoom(room, ["kursiBatchUpdate", room, [[seat, seatInfo]]]);
  broadcastRoomUserCount(room);
}
function handleSendNotif(ws: WebSocketWithRoom, id: string, url: string, user: string, desc: string) {
  const out = ["notif", url, user, desc, Date.now()];
  for (const c of [...clients]) if (c.idtarget === id) safeSend(c, out);
}
function handlePrivate(ws: WebSocketWithRoom, idt: string, url: string, msg: string, sender: string) {
  const out = ["private", idt, url, msg, Date.now(), sender];
  if (!privateMessageBuffer.has(idt)) privateMessageBuffer.set(idt, []);
  privateMessageBuffer.get(idt)!.push(out);
  for (const c of clients) if (c.idtarget === idt) safeSend(c, out);
}
function handleIsUserOnline(ws: WebSocketWithRoom, target: string, tanda?: string) {
  const online = Array.from(clients).some(c => c.idtarget === target);
  safeSend(ws, ["userOnlineStatus", target, online, tanda ?? ""]);
}
function handleMessage(ws: WebSocketWithRoom, dataStr: string) {
  try {
    const data = JSON.parse(dataStr);
    const [evt, ...args] = data;
    switch (evt) {
      case "setIdTarget": handleSetIdTarget(ws, ...args); break;
      case "ping": handlePing(ws, ...args); break;
      case "joinRoom": handleJoinRoom(ws, ...args); break;
      case "chat": handleChat(ws, ...args); break;
      case "updateKursi": handleUpdateKursi(ws, ...args); break;
      case "sendnotif": handleSendNotif(ws, ...args); break;
      case "private": handlePrivate(ws, ...args); break;
      case "isUserOnline": handleIsUserOnline(ws, ...args); break;
      case "getCurrentNumber": safeSend(ws, ["currentNumber", currentNumber]); break;
      default: safeSend(ws, ["error", "Unknown event"]); break;
    }
  } catch (err) { console.error("Error handling:", err, "raw:", dataStr); }
}

// ===== Serve =====
serve((req) => {
  const upgrade = req.headers.get("upgrade") || "";
  if (upgrade.toLowerCase() !== "websocket") return new Response("Expected websocket", { status: 400 });
  const { socket, response } = Deno.upgradeWebSocket(req);
  const ws = socket as WebSocketWithRoom;
  clients.add(ws);

  ws.onopen = () => { ws.numkursi = new Set<number>(); console.log("Client connected"); };
  ws.onmessage = (ev) => handleMessage(ws, ev.data);
  ws.onclose = () => {
    if (ws.roomname && ws.numkursi) {
      const seatMap = roomSeats.get(ws.roomname)!;
      for (const seat of ws.numkursi) {
        resetSeat(seatMap.get(seat)!);
        kv.delete(["seat", ws.roomname, seat]);
        broadcastToRoom(ws.roomname, ["removeKursi", ws.roomname, seat]);
      }
      broadcastRoomUserCount(ws.roomname);
    }
    cleanupBuffers(ws);
    clients.delete(ws);
  };
  return response;
});
