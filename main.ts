import { serve } from "https://deno.land/std@0.201.0/http/server.ts";

// ===== Constants & Types =====
const kv = await Deno.openKv();
const INSTANCE_ID = crypto.randomUUID();

const roomList = [
  "Chill Zone","Catch Up","Casual Vibes","Lounge Talk","Easy Talk",
  "Friendly Corner","The Hangout","Relax & Chat","Just Chillin","The Chatter Room"
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
  for (let i = 1; i <= MAX_SEATS; i++) {
    seatMap.set(i, createEmptySeat());
  }
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
    for (const info of roomSeats.get(room)!.values()) {
      if (info.namauser && !info.namauser.startsWith("__LOCK__")) cnt[room]++;
    }
  }
  return cnt;
}
function broadcastRoomUserCount(room: RoomName) {
  broadcastToRoom(room, ["roomUserCount", room, getJumlahRoom()[room] || 0]);
}

// ===== Buffers =====
const pointUpdateBuffer: Map<RoomName, Map<number, Array<{ x: number; y: number; fast: number }>>> = new Map();
const updateKursiBuffer: Map<RoomName, Map<number, SeatInfo>> = new Map();
const chatMessageBuffer: Map<RoomName, Array<any>> = new Map();
const privateMessageBuffer: Map<string, Array<any>> = new Map();

function flushPrivateMessageBuffer() {
  for (const [idt, msgs] of privateMessageBuffer) {
    for (const c of clients) if (c.idtarget === idt) msgs.forEach(m => safeSend(c, m));
    msgs.length = 0;
  }
}
function flushChatBuffer() {
  for (const [room, msgs] of chatMessageBuffer) {
    msgs.forEach(m => broadcastToRoom(room, m));
    msgs.length = 0;
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

// ===== KV Helpers =====
async function kvSetSeat(room: RoomName, seat: number, info: SeatInfo) {
  await kv.set(["room", room, "seat", seat], { origin: INSTANCE_ID, seat: info });
}
async function kvDeleteSeat(room: RoomName, seat: number) {
  await kv.delete(["room", room, "seat", seat]);
  await kv.delete(["room", room, "seat", seat, "lastPoint"]);
}
async function kvSetPoint(room: RoomName, seat: number, p: { x: number; y: number; fast: number }) {
  await kv.set(["room", room, "seat", seat, "lastPoint"], { origin: INSTANCE_ID, p });
}
async function kvSetChat(room: RoomName, chatSnap: any) {
  await kv.set(["room", room, "chat", Date.now(), crypto.randomUUID()], { origin: INSTANCE_ID, payload: chatSnap });
}
async function kvSetPrivate(idt: string, data: any) {
  await kv.set(["private", idt, Date.now(), crypto.randomUUID()], { origin: INSTANCE_ID, payload: data });
}
async function kvSetNotif(idt: string, data: any) {
  await kv.set(["notif", idt, Date.now(), crypto.randomUUID()], { origin: INSTANCE_ID, payload: data });
}

// ===== Current Number =====
let currentNumber = 1;
setInterval(() => {
  currentNumber = currentNumber < 6 ? currentNumber + 1 : 1;
  for (const c of [...clients]) safeSend(c, ["currentNumber", currentNumber]);
}, 15 * 60 * 1000);

// ===== Locks & Cleanup =====
function cleanExpiredLocks() {
  const now = Date.now();
  for (const room of allRooms) {
    for (const [seat, info] of roomSeats.get(room)!) {
      if (info.namauser.startsWith("__LOCK__") && info.lockTime && now - info.lockTime > 10000) {
        resetSeat(info);
        broadcastToRoom(room, ["removeKursi", room, seat]);
        broadcastRoomUserCount(room);
      }
    }
  }
}
function cleanupBuffers(ws: WebSocketWithRoom) {
  if (ws.idtarget) {
    privateMessageBuffer.delete(ws.idtarget);
    userToSeat.delete(ws.idtarget);
  }
}

// ===== Periodic Flush =====
setInterval(() => {
  try {
    flushPointUpdates();
    flushKursiUpdates();
    flushChatBuffer();
    flushPrivateMessageBuffer();
    cleanExpiredLocks();
  } catch (err) { console.error("Error in periodic flush:", err); }
}, 100);

// ===== Event Handlers =====
function handleJoinRoom(ws: WebSocketWithRoom, newRoom: RoomName) {
  try { assertValidRoom(newRoom); } catch { return safeSend(ws, ["error", `Unknown room: ${newRoom}`]); }

  // lock seat
  const seatMap = roomSeats.get(newRoom)!;
  let foundSeat: number | null = null;
  if (ws.idtarget) {
    for (let i = 1; i <= MAX_SEATS; i++) {
      const kursi = seatMap.get(i)!;
      if (!kursi.namauser) {
        kursi.namauser = "__LOCK__" + ws.idtarget;
        kursi.lockTime = Date.now();
        foundSeat = i;
        kvSetSeat(newRoom, i, kursi);
        break;
      }
    }
  }
  if (!foundSeat) return safeSend(ws, ["roomFull", newRoom]);

  if (ws.roomname && ws.numkursi) {
    for (const s of ws.numkursi) {
      resetSeat(roomSeats.get(ws.roomname)!.get(s)!);
      kvDeleteSeat(ws.roomname, s);
      broadcastToRoom(ws.roomname, ["removeKursi", ws.roomname, s]);
    }
    broadcastRoomUserCount(ws.roomname);
  }

  ws.roomname = newRoom;
  ws.numkursi = new Set([foundSeat]);
  safeSend(ws, ["numberKursiSaya", foundSeat]);
  if (ws.idtarget) userToSeat.set(ws.idtarget, { room: newRoom, seat: foundSeat });

  const allPoints: any[] = [];
  const meta: Record<number, Omit<SeatInfo, "points">> = {};
  for (const [seat, info] of seatMap) {
    for (const p of info.points) allPoints.push({ seat, ...p });
    if (info.namauser && !info.namauser.startsWith("__LOCK__")) {
      const { points, ...rest } = info;
      meta[seat] = rest;
    }
  }
  safeSend(ws, ["allPointsList", newRoom, allPoints]);
  safeSend(ws, ["allUpdateKursiList", newRoom, meta]);
  broadcastRoomUserCount(newRoom);
}
function handleChat(ws: WebSocketWithRoom, room: RoomName, ...rest: any[]) {
  assertValidRoom(room);
  const chatSnap = ["chat", room, ...rest];
  if (!chatMessageBuffer.has(room)) chatMessageBuffer.set(room, []);
  chatMessageBuffer.get(room)!.push(chatSnap);
  kvSetChat(room, chatSnap);
}
function handleUpdatePoint(ws: WebSocketWithRoom, room: RoomName, seat: number, x: number, y: number, fast: number) {
  assertValidRoom(room);
  const si = roomSeats.get(room)!.get(seat)!;
  si.points.push({ x, y, fast });
  if (!pointUpdateBuffer.has(room)) pointUpdateBuffer.set(room, new Map());
  if (!pointUpdateBuffer.get(room)!.has(seat)) pointUpdateBuffer.get(room)!.set(seat, []);
  pointUpdateBuffer.get(room)!.get(seat)!.push({ x, y, fast });
  kvSetPoint(room, seat, { x, y, fast });
}
function handleRemoveKursi(ws: WebSocketWithRoom, room: RoomName, seat: number) {
  assertValidRoom(room);
  resetSeat(roomSeats.get(room)!.get(seat)!);
  kvDeleteSeat(room, seat);
  broadcastToRoom(room, ["removeKursi", room, seat]);
  broadcastRoomUserCount(room);
}
function handleUpdateKursi(ws: WebSocketWithRoom, room: RoomName, seat: number, ...rest: any[]) {
  assertValidRoom(room);
  const seatInfo: SeatInfo = { noimageUrl: rest[0], namauser: rest[1], color: rest[2], itembawah: rest[3], itematas: rest[4], vip: rest[5], viptanda: rest[6], points: [] };
  roomSeats.get(room)!.set(seat, seatInfo);
  if (!updateKursiBuffer.has(room)) updateKursiBuffer.set(room, new Map());
  updateKursiBuffer.get(room)!.set(seat, seatInfo);
  kvSetSeat(room, seat, seatInfo);
  broadcastRoomUserCount(room);
}
function handleSendNotif(ws: WebSocketWithRoom, idt: string, ...rest: any[]) {
  const notifData = ["notif", ...rest, Date.now()];
  kvSetNotif(idt, notifData);
  for (const c of [...clients]) if (c.idtarget === idt) safeSend(c, notifData);
}
function handlePrivate(ws: WebSocketWithRoom, idt: string, ...rest: any[]) {
  const out = ["private", idt, ...rest, Date.now()];
  kvSetPrivate(idt, out);
  safeSend(ws, out);
  if (!privateMessageBuffer.has(idt)) privateMessageBuffer.set(idt, []);
  privateMessageBuffer.get(idt)!.push(out);
}

// ===== Dispatcher =====
function handleMessage(ws: WebSocketWithRoom, dataStr: string) {
  try {
    const [evt, ...args] = JSON.parse(dataStr);
    switch (evt) {
      case "setIdTarget": ws.idtarget = args[0]; safeSend(ws, ["setIdTargetAck", ws.idtarget]); break;
      case "ping": if (args[0] && ws.idtarget === args[0]) safeSend(ws, ["pong"]); break;
      case "getAllRoomsUserCount": safeSend(ws, ["allRoomsUserCount", Object.entries(getJumlahRoom())]); break;
      case "getCurrentNumber": safeSend(ws, ["currentNumber", currentNumber]); break;
      case "joinRoom": handleJoinRoom(ws, ...args); break;
      case "chat": handleChat(ws, ...args); break;
      case "updatePoint": handleUpdatePoint(ws, ...args); break;
      case "removeKursiAndPoint": handleRemoveKursi(ws, ...args); break;
      case "updateKursi": handleUpdateKursi(ws, ...args); break;
      case "sendnotif": handleSendNotif(ws, ...args); break;
      case "private": handlePrivate(ws, ...args); break;
      default: safeSend(ws, ["error", "Unknown event"]);
    }
  } catch (err) { console.error("Error handling message:", err, "raw:", dataStr); }
}

// ===== KV Watcher =====
;(async () => {
  for await (const events of kv.watch([["room"], ["private"], ["notif"]])) {
    for (const e of events) {
      const key = e.key as (string|number)[];
      const val = e.value as any;
      if (!val || val.origin === INSTANCE_ID) continue;

      if (key[0] === "room" && key[2] === "seat" && typeof key[3] === "number") {
        roomSeats.get(key[1] as RoomName)!.set(key[3] as number, (val.seat ?? val) as SeatInfo);
        broadcastRoomUserCount(key[1] as RoomName);
      }
      if (key[0] === "room" && key[4] === "lastPoint") {
        const p = val.p;
        broadcastToRoom(key[1] as RoomName, ["pointUpdated", key[1], key[3], p.x, p.y, p.fast]);
      }
      if (key[0] === "room" && key[2] === "chat") {
        broadcastToRoom(key[1] as RoomName, val.payload);
      }
      if (key[0] === "private") {
        for (const c of clients) if (c.idtarget === key[1]) safeSend(c, val.payload);
      }
      if (key[0] === "notif") {
        for (const c of clients) if (c.idtarget === key[1]) safeSend(c, val.payload);
      }
    }
  }
})();

// ===== Serve =====
serve((req) => {
  const upgrade = req.headers.get("upgrade") || "";
  if (upgrade.toLowerCase() !== "websocket") return new Response("Expected websocket", { status: 400 });

  const { socket, response } = Deno.upgradeWebSocket(req);
  const ws = socket as WebSocketWithRoom;
  clients.add(ws);

  ws.onopen = () => { ws.numkursi = new Set(); console.log("Client connected"); };
  ws.onmessage = (ev) => handleMessage(ws, ev.data);
  ws.onclose = () => {
    if (ws.roomname && ws.numkursi) {
      for (const s of ws.numkursi) {
        resetSeat(roomSeats.get(ws.roomname)!.get(s)!);
        kvDeleteSeat(ws.roomname, s);
        broadcastToRoom(ws.roomname, ["removeKursi", ws.roomname, s]);
      }
      broadcastRoomUserCount(ws.roomname);
    }
    cleanupBuffers(ws);
    clients.delete(ws);
    ws.numkursi?.clear();
    ws.roomname = undefined;
    console.log("❌ Disconnected:", ws.idtarget ?? "(unknown)");
  };

  return response;
});
