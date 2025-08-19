import { serve } from "https://deno.land/std@0.201.0/http/server.ts";

// ===== KV =====
const kv = await Deno.openKv();
const INSTANCE_ID = crypto.randomUUID();

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

// ===== Utilities =====
function createEmptySeat(): SeatInfo {
  return { noimageUrl: "", namauser: "", color: "", itembawah: 0, itematas: 0, vip: false, viptanda: 0, points: [] };
}
function resetSeat(info: SeatInfo) { Object.assign(info, createEmptySeat()); }

function safeSend(ws: WebSocketWithRoom, msg: any) {
  try {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
    else clients.delete(ws);
  } catch { try { ws.close(); } catch {} clients.delete(ws); }
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
    for (const info of seatMap.values()) {
      if (info.namauser && !info.namauser.startsWith("__LOCK__")) cnt[room]++;
    }
  }
  return cnt;
}
function broadcastRoomUserCount(room: RoomName) {
  const count = getJumlahRoom()[room] || 0;
  broadcastToRoom(room, ["roomUserCount", room, count]);
}
function handleGetAllRoomsUserCount(ws: WebSocketWithRoom) {
  const allCounts = getJumlahRoom();
  const result: Array<[RoomName, number]> = roomList.map(room => [room, allCounts[room]]);
  safeSend(ws, ["allRoomsUserCount", result]);
}

// ===== Buffers =====
const pointUpdateBuffer: Map<RoomName, Map<number, Array<{ x: number; y: number; fast: number }>>> = new Map();
const updateKursiBuffer: Map<RoomName, Map<number, SeatInfo>> = new Map();

// ===== Flush Buffers =====
function flushPointUpdates() {
  for (const [room, seatMap] of pointUpdateBuffer) {
    for (const [seat, points] of seatMap) {
      for (const p of points) broadcastToRoom(room, ["pointUpdated", room, seat, p.x, p.y, p.fast]);
      points.length = 0;
    }
  }
}
function flushKursiUpdates() {
  for (const [room, seatMap] of updateKursKursiBuffer) {
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
setInterval(() => { flushPointUpdates(); flushKursiUpdates(); }, 100);

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
setInterval(cleanExpiredLocks, 5000);

// ===== Current Number =====
let currentNumber = 1;
const maxNumber = 6;
const intervalMillis = 15 * 60 * 1000;
setInterval(() => {
  currentNumber = currentNumber < maxNumber ? currentNumber + 1 : 1;
  for (const c of [...clients]) safeSend(c, ["currentNumber", currentNumber]);
}, intervalMillis);

// ===== KV overwrite helpers =====
async function kvSet(key: (string|number)[], payload: any) {
  await kv.set(key, { origin: INSTANCE_ID, payload });
}

// ===== Event Handlers =====
function handleSetIdTarget(ws: WebSocketWithRoom, id: string) {
  ws.idtarget = id;
  safeSend(ws, ["setIdTargetAck", ws.idtarget]);
}
function handlePing(ws: WebSocketWithRoom, pingId: string) {
  if (pingId && ws.idtarget === pingId) safeSend(ws, ["pong"]);
}
function handleJoinRoom(ws: WebSocketWithRoom, newRoom: RoomName) {
  try { assertValidRoom(newRoom); } catch { return safeSend(ws, ["error", `Unknown room: ${newRoom}`]); }
  const seatMap = roomSeats.get(newRoom)!;
  let seat = 0;
  for (let i = 1; i <= MAX_SEATS; i++) if (seatMap.get(i)!.namauser === "") { seat = i; break; }
  if (!seat) return safeSend(ws, ["roomFull", newRoom]);
  seatMap.get(seat)!.namauser = "__LOCK__" + (ws.idtarget ?? "");
  seatMap.get(seat)!.lockTime = Date.now();
  ws.roomname = newRoom;
  ws.numkursi = new Set([seat]);
  safeSend(ws, ["numberKursiSaya", seat]);
  broadcastRoomUserCount(newRoom);
}
async function handleChat(ws: WebSocketWithRoom, room: RoomName, noImageURL: string, username: string, message: string, usernameColor: string, chatTextColor: string) {
  try { assertValidRoom(room); } catch { return safeSend(ws, ["error", "Invalid room for chat"]); }
  const chatSnap = ["chat", room, noImageURL, username, message, usernameColor, chatTextColor] as const;
  await kvSet(["room", room, "chat"], chatSnap); // simpan, broadcast via watcher
}
function handleUpdatePoint(ws: WebSocketWithRoom, room: RoomName, seat: number, x: number, y: number, fast: number) {
  try { assertValidRoom(room); } catch { return safeSend(ws, ["error", "Invalid room for point"]); }
  const seatMap = roomSeats.get(room)!;
  const info = seatMap.get(seat);
  if (!info) return;
  info.points.push({ x, y, fast });
  if (!pointUpdateBuffer.has(room)) pointUpdateBuffer.set(room, new Map());
  const buf = pointUpdateBuffer.get(room)!;
  if (!buf.has(seat)) buf.set(seat, []);
  buf.get(seat)!.push({ x, y, fast });
}
function handleRemoveKursi(ws: WebSocketWithRoom, room: RoomName, seat: number) {
  try { assertValidRoom(room); } catch { return safeSend(ws, ["error", "Invalid room for remove"]); }
  resetSeat(roomSeats.get(room)!.get(seat)!);
  ws.numkursi?.delete(seat);
  broadcastToRoom(room, ["removeKursi", room, seat]);
  broadcastRoomUserCount(room);
}
function handleUpdateKursi(ws: WebSocketWithRoom, room: RoomName, seat: number, noimageUrl: string, namauser: string, color: string, itembawah: number, itematas: number, vip: boolean, viptanda: number) {
  try { assertValidRoom(room); } catch { return safeSend(ws, ["error", "Invalid room for kursi"]); }
  const seatInfo: SeatInfo = { noimageUrl, namauser, color, itembawah, itematas, vip, viptanda, points: [] };
  if (!updateKursiBuffer.has(room)) updateKursiBuffer.set(room, new Map());
  updateKursiBuffer.get(room)!.set(seat, seatInfo);
  roomSeats.get(room)!.set(seat, seatInfo);
  broadcastRoomUserCount(room);
}
async function handlePrivate(ws: WebSocketWithRoom, idt: string, url: string, msg: string, sender: string) {
  const out = ["private", idt, url, msg, Date.now(), sender];
  await kvSet(["private", idt], out);
  safeSend(ws, out);
}
async function handleSendNotif(ws: WebSocketWithRoom, idt: string, noimageUrl: string, username: string, deskripsi: string) {
  const notifData = ["notif", noimageUrl, username, deskripsi, Date.now()];
  await kvSet(["notif", idt], notifData);
}
function handleIsUserOnline(ws: WebSocketWithRoom, target: string, tanda?: string) {
  const online = Array.from(clients).some(c => c.idtarget === target);
  safeSend(ws, ["userOnlineStatus", target, online, tanda ?? ""]);
}

// ===== KV watcher =====
;(async () => {
  for await (const events of kv.watch([["room"], ["private"], ["notif"]])) {
    for (const e of events) {
      const key = e.key as (string|number)[];
      const val = e.value as any;
      if (!val || val.origin === INSTANCE_ID) continue;
      if (key[0] === "room" && key[2] === "chat") broadcastToRoom(key[1] as RoomName, val.payload);
      if (key[0] === "private") for (const c of clients) if (c.idtarget === key[1]) safeSend(c, val.payload);
      if (key[0] === "notif") for (const c of clients) if (c.idtarget === key[1]) safeSend(c, val.payload);
    }
  }
})();

// ===== WebSocket Server =====
serve((req) => {
  if ((req.headers.get("upgrade") || "").toLowerCase() !== "websocket") return new Response("Expected websocket", { status: 400 });
  const { socket, response } = Deno.upgradeWebSocket(req);
  const ws = socket as WebSocketWithRoom;
  clients.add(ws);

  ws.onopen = () => { ws.numkursi = new Set<number>(); console.log("Client connected"); };
  ws.onmessage = (ev) => handleMessage(ws, ev.data);
  ws.onclose = () => {
    try {
      console.log("❌ User disconnected:", ws.idtarget ?? "(unknown)");
      if (ws.roomname && ws.numkursi) {
        const seatMap = roomSeats.get(ws.roomname)!;
        for (const seat of ws.numkursi) {
          resetSeat(seatMap.get(seat)!);
          broadcastToRoom(ws.roomname, ["removeKursi", ws.roomname, seat]);
        }
        broadcastRoomUserCount(ws.roomname);
      }
      if (ws.idtarget) userToSeat.delete(ws.idtarget);
    } finally {
      clients.delete(ws);
      ws.numkursi?.clear();
      ws.roomname = undefined;
    }
  };

  return response;
});

function handleMessage(ws: WebSocketWithRoom, dataStr: string) {
  try {
    const [evt, ...args] = JSON.parse(dataStr);
    switch (evt) {
      case "setIdTarget": handleSetIdTarget(ws, ...args); break;
      case "ping": handlePing(ws, ...args); break;
      case "getAllRoomsUserCount": handleGetAllRoomsUserCount(ws); break;
      case "getCurrentNumber": safeSend(ws, ["currentNumber", currentNumber]); break;
      case "joinRoom": handleJoinRoom(ws, ...args); break;
      case "chat": handleChat(ws, ...args); break;
      case "updatePoint": handleUpdatePoint(ws, ...args); break;
      case "removeKursiAndPoint": handleRemoveKursi(ws, ...args); break;
      case "updateKursi": handleUpdateKursi(ws, ...args); break;
      case "private": handlePrivate(ws, ...args); break;
      case "sendnotif": handleSendNotif(ws, ...args); break;
      case "isUserOnline": handleIsUserOnline(ws, ...args); break;
      default: safeSend(ws, ["error", "Unknown event"]); break;
    }
  } catch (err) { console.error("Error:", err, "raw:", dataStr); }
}
