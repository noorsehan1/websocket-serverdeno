// server.ts
import { serve } from "https://deno.land/std@0.201.0/http/server.ts";

// ===== Deno KV (Realtime Global Ephemeral) =====
const kv = await Deno.openKv();
const serverId = (globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2));

// TTL (ms) untuk data sementara — sesuaikan jika perlu
const TTL = {
  seat: 30_000,    // kursi aktif tersimpan 30s (diperbarui tiap update)
  point: 5_000,    // movement very short
  chat: 20_000,    // chat ephemeral
  private: 30_000, // private message short-lived
  lock: 10_000,    // global lock kursi
  online: 20_000,  // online flag
} as const;

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
  _origin?: string;
}

interface WebSocketWithRoom extends WebSocket {
  roomname?: RoomName;
  idtarget?: string;
  numkursi?: Set<number>;
}

// main in-memory maps
const userToSeat: Map<string, { room: RoomName; seat: number }> = new Map();
const roomSeats: Map<RoomName, Map<number, SeatInfo>> = new Map();

// ===== Initialize Seats (in-memory) =====
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

function resetSeat(info: SeatInfo) {
  Object.assign(info, createEmptySeat());
}

function safeSend(ws: WebSocketWithRoom, msg: any) {
  try {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(msg));
    } else {
      console.warn("⚠️ Skip send, socket not open:", ws.idtarget);
      clients.delete(ws);
    }
  } catch (err) {
    console.error("❌ Failed sending message to", ws.idtarget, ":", err);
    try { ws.close(); } catch {}
    clients.delete(ws);
  }
}

function assertValidRoom(room: any): room is RoomName {
  if (!allRooms.has(room)) throw new Error("Unknown room: " + room);
  return true;
}

function broadcastToRoom(room: RoomName, msg: any) {
  for (const c of [...clients]) { // snapshot to avoid mutation while iterating
    if (c.roomname === room) safeSend(c, msg);
  }
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
const chatMessageBuffer: Map<RoomName, Array<any>> = new Map();
const privateMessageBuffer: Map<string, Array<any>> = new Map();

// flush helpers
function flushPrivateMessageBuffer() {
  for (const [idtarget, messages] of privateMessageBuffer) {
    for (const c of clients) if (c.idtarget === idtarget) messages.forEach(msg => safeSend(c, msg));
    messages.length = 0;
  }
}

function flushChatBuffer() {
  for (const [room, messages] of chatMessageBuffer) {
    messages.forEach(msg => broadcastToRoom(room, msg));
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
      const { points, _origin, ...rest } = info;
      updates.push([seat, rest]);
    }
    if (updates.length > 0) {
      broadcastToRoom(room, ["kursiBatchUpdate", room, updates]);
      seatMap.clear();
    }
  }
}

// ===== Current Number (example ticker) =====
let currentNumber = 1;
const maxNumber = 6;
const intervalMillis = 15 * 60 * 1000;
setInterval(() => {
  currentNumber = currentNumber < maxNumber ? currentNumber + 1 : 1;
  for (const c of [...clients]) safeSend(c, ["currentNumber", currentNumber]);
}, intervalMillis);

// ===== Locks Cleanup (local) =====
function cleanExpiredLocks() {
  const now = Date.now();
  for (const room of allRooms) {
    const seatMap = roomSeats.get(room)!;
    for (const [seat, info] of seatMap) {
      if (info.namauser.startsWith("__LOCK__") && info.lockTime && now - info.lockTime > TTL.lock) {
        resetSeat(info);
        broadcastToRoom(room, ["removeKursi", room, seat]);
        broadcastRoomUserCount(room);
        // also delete KV if exists (best-effort)
        kv.delete(["seat", room, seat]).catch(() => {});
      }
    }
  }
}

// ===== KV Helpers =====
async function kvSetTemp(key: Deno.KvKey, value: unknown, ttlMs: number) {
  await kv.set(key, value, { expireIn: ttlMs });
}
async function kvGet<T>(key: Deno.KvKey): Promise<T | null> {
  const r = await kv.get<T>(key);
  return r.value ?? null;
}
async function kvDelete(key: Deno.KvKey) {
  await kv.delete(key);
}

/**
 * Atomic set-if-not-exists using KV atomic()
 * returns true if set succeeded (key was absent), false otherwise
 */
async function kvSetIfAbsent(key: Deno.KvKey, value: unknown, ttlMs: number): Promise<boolean> {
  const tx = kv.atomic().check({ key, version: null }).set(key, value, { expireIn: ttlMs });
  try {
    const res = await tx.commit();
    return res.ok;
  } catch {
    return false;
  }
}

// ===== Seat & KV-aware Lock Utilities =====
async function lockSeatKV(room: RoomName, ws: WebSocketWithRoom): Promise<number | null> {
  if (!ws.idtarget) return null;

  // if user already has seat recorded in KV, try reuse
  const existing = await kvGet<{ room: RoomName; seat: number }>(["userSeat", ws.idtarget]);
  if (existing && existing.room === room) {
    const seatInfo = await kvGet<SeatInfo>(["seat", room, existing.seat]);
    // if seat exists and held by same id or free, try to acquire lock
    // We'll attempt set-if-absent on lock key
    const ok = await kvSetIfAbsent(["lock", room, existing.seat], { id: ws.idtarget, t: Date.now() }, TTL.lock);
    if (ok) {
      // write a "__LOCK__" placeholder into seat key
      await kvSetTemp(["seat", room, existing.seat], { ...createEmptySeat(), namauser: "__LOCK__" + ws.idtarget, lockTime: Date.now(), _origin: serverId }, TTL.seat);
      await kvSetTemp(["userSeat", ws.idtarget], { room, seat: existing.seat }, TTL.seat);
      return existing.seat;
    }
  }

  // search for empty seat globally by trying to set lock key
  for (let i = 1; i <= MAX_SEATS; i++) {
    const lockKey = ["lock", room, i];
    const ok = await kvSetIfAbsent(lockKey, { id: ws.idtarget, t: Date.now() }, TTL.lock);
    if (!ok) continue;
    // place temporary seat lock
    await kvSetTemp(["seat", room, i], { ...createEmptySeat(), namauser: "__LOCK__" + ws.idtarget, lockTime: Date.now(), _origin: serverId }, TTL.seat);
    await kvSetTemp(["userSeat", ws.idtarget], { room, seat: i }, TTL.seat);
    return i;
  }

  return null;
}

function lockSeatLocal(room: RoomName, ws: WebSocketWithRoom): number | null {
  const seatMap = roomSeats.get(room)!;
  if (!ws.idtarget) return null;

  if (userToSeat.has(ws.idtarget)) {
    const prev = userToSeat.get(ws.idtarget)!;
    if (prev.room === room && seatMap.get(prev.seat)!.namauser === "") return prev.seat;
  }

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
  if (ws.idtarget) {
    privateMessageBuffer.delete(ws.idtarget);
    userToSeat.delete(ws.idtarget);
  }
}

// ===== Periodic Flush (local buffers) =====
setInterval(() => {
  try {
    flushPointUpdates();
    flushKursiUpdates();
    flushChatBuffer();
    flushPrivateMessageBuffer();
    cleanExpiredLocks();
  } catch (err) {
    console.error("Error in periodic flush:", err);
  }
}, 100);

// ===== Event Handlers =====
function handleSetIdTarget(ws: WebSocketWithRoom, id: string) {
  ws.idtarget = id;
  safeSend(ws, ["setIdTargetAck", ws.idtarget]);
}

function handlePing(ws: WebSocketWithRoom, pingId: string) {
  if (pingId && ws.idtarget === pingId) {
    // refresh online flag in KV
    if (ws.idtarget) kvSetTemp(["online", ws.idtarget], { online: true, _origin: serverId }, TTL.online).catch(() => {});
    safeSend(ws, ["pong"]);
  }
}

function handleGetCurrentNumber(ws: WebSocketWithRoom) {
  safeSend(ws, ["currentNumber", currentNumber]);
}

async function handleJoinRoom(ws: WebSocketWithRoom, newRoom: RoomName) {
  try { assertValidRoom(newRoom); } catch { return safeSend(ws, ["error", `Unknown room: ${newRoom}`]); }

  // Try KV-based global lock first (preferred) to avoid double assign
  let foundSeat = await lockSeatKV(newRoom, ws);
  if (foundSeat === null) {
    // fallback to local lock (rare)
    foundSeat = lockSeatLocal(newRoom, ws);
  }
  if (foundSeat === null) return safeSend(ws, ["roomFull", newRoom]);

  // If ws already had a room, cleanup
  if (ws.roomname && ws.numkursi) {
    const oldRoom = ws.roomname;
    for (const s of ws.numkursi) {
      resetSeat(roomSeats.get(oldRoom)!.get(s)!);
      broadcastToRoom(oldRoom, ["removeKursi", oldRoom, s]);
      // also delete KV old seat (best-effort)
      kvDelete(["seat", oldRoom, s]).catch(() => {});
      kvDelete(["lock", oldRoom, s]).catch(() => {});
    }
    broadcastRoomUserCount(oldRoom);
  }

  ws.roomname = newRoom;
  ws.numkursi = new Set([foundSeat]);
  safeSend(ws, ["numberKursiSaya", foundSeat]);
  if (ws.idtarget) userToSeat.set(ws.idtarget, { room: newRoom, seat: foundSeat });

  // Snapshot kursi dari KV to ensure we have latest across regions
  try {
    const iter = kv.list<SeatInfo>({ prefix: ["seat", newRoom] });
    const meta: Record<number, Omit<SeatInfo, "points">> = {};
    const seatMap = roomSeats.get(newRoom)!;
    for await (const { key, value } of iter) {
      const seat = key[2] as number;
      if (!value) continue;
      // ignore origin here
      const { _origin, points, ...rest } = value as any;
      seatMap.set(seat, { points: points ?? [], ...createEmptySeat(), ...(rest as Omit<SeatInfo,"points">) });
      if (rest.namauser && !String(rest.namauser).startsWith("__LOCK__")) {
        meta[seat] = rest;
      }
    }

    // collect points from memory (they may be local)
    const allPoints: any[] = [];
    for (const [seat, info] of seatMap) {
      for (const p of info.points) allPoints.push({ seat, ...p });
    }

    safeSend(ws, ["allPointsList", newRoom, allPoints]);
    safeSend(ws, ["allUpdateKursiList", newRoom, meta]);
    broadcastRoomUserCount(newRoom);
  } catch (err) {
    // on error, still send local snapshot
    const allPoints: any[] = [];
    const meta: Record<number, Omit<SeatInfo, "points">> = {};
    const seatMap = roomSeats.get(newRoom)!;
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
}

function handleChat(ws: WebSocketWithRoom, roomname: RoomName, noImageURL: string, username: string, message: string, usernameColor: string, chatTextColor: string) {
  try { assertValidRoom(roomname); } catch { return safeSend(ws, ["error", "Invalid room for chat"]); }

  if (!chatMessageBuffer.has(roomname)) chatMessageBuffer.set(roomname, []);
  const payload = ["chat", roomname, noImageURL, username, message, usernameColor, chatTextColor];
  chatMessageBuffer.get(roomname)!.push(payload);

  // Publish ke KV (ephemeral) untuk region lain
  kvSetTemp(["chat", roomname, Date.now(), crypto.randomUUID?.() ?? Math.random()], { msg: payload, _origin: serverId }, TTL.chat).catch(() => {});
}

function handleUpdatePoint(ws: WebSocketWithRoom, room: RoomName, seat: number, x: number, y: number, fast: number) {
  try { assertValidRoom(room); } catch { return safeSend(ws, ["error", `Unknown room: ${room}`]); }
  const seatMap = roomSeats.get(room)!;
  const seatInfo = seatMap.get(seat);
  if (!seatInfo) return;
  if (typeof x !== "number" || typeof y !== "number" || typeof fast !== "number") return;

  seatInfo.points.push({ x, y, fast });
  if (!pointUpdateBuffer.has(room)) pointUpdateBuffer.set(room, new Map());
  const roomBuffer = pointUpdateBuffer.get(room)!;
  if (!roomBuffer.has(seat)) roomBuffer.set(seat, []);
  roomBuffer.get(seat)!.push({ x, y, fast });

  // Publish to KV so other regions receive immediate update
  kvSetTemp(["point", room, seat, Date.now(), crypto.randomUUID?.() ?? Math.random()], { x, y, fast, _origin: serverId }, TTL.point).catch(() => {});
}

async function handleRemoveKursiAndPoint(ws: WebSocketWithRoom, room: RoomName, seat: number) {
  try { assertValidRoom(room); } catch { return safeSend(ws, ["error", `Unknown room: ${room}`]); }

  // reset local seat
  resetSeat(roomSeats.get(room)!.get(seat)!);
  for (const c of clients) c.numkursi?.delete(seat);
  // broadcast local
  broadcastToRoom(room, ["removeKursi", room, seat]);
  broadcastRoomUserCount(room);

  // delete from KV (global)
  await kvDelete(["seat", room, seat]).catch(() => {});
  // also remove any lock
  await kvDelete(["lock", room, seat]).catch(() => {});
}

function handleUpdateKursi(ws: WebSocketWithRoom, room: RoomName, seat: number, noimageUrl: string, namauser: string, color: string, itembawah: number, itematas: number, vip: boolean, viptanda: number) {
  try { assertValidRoom(room); } catch { return safeSend(ws, ["error", `Unknown room: ${room}`]); }

  const seatInfo: SeatInfo = { noimageUrl, namauser, color, itembawah, itematas, vip, viptanda, points: [] };
  if (!updateKursiBuffer.has(room)) updateKursiBuffer.set(room, new Map());
  updateKursiBuffer.get(room)!.set(seat, seatInfo);
  roomSeats.get(room)!.set(seat, seatInfo);
  broadcastRoomUserCount(room);

  // Simpan ke KV untuk disebar lintas region (sertakan origin supaya watcher di server asal skip)
  kvSetTemp(["seat", room, seat], { ...seatInfo, _origin: serverId }, TTL.seat).catch(() => {});
}

function handleSendNotif(ws: WebSocketWithRoom, idtarget: string, noimageUrl: string, username: string, deskripsi: string) {
  const notifData = ["notif", noimageUrl, username, deskripsi, Date.now()];
  for (const c of [...clients]) if (c.idtarget === idtarget) safeSend(c, notifData);
}

function handlePrivate(ws: WebSocketWithRoom, idt: string, url: string, msg: string, sender: string) {
  const ts = Date.now();
  const out = ["private", idt, url, msg, ts, sender];
  safeSend(ws, out);
  if (!privateMessageBuffer.has(idt)) privateMessageBuffer.set(idt, []);
  privateMessageBuffer.get(idt)!.push(out);

  // Publish ke KV (ephemeral) untuk region lain
  kvSetTemp(["private", idt, ts, crypto.randomUUID?.() ?? Math.random()], { msg: out, _origin: serverId }, TTL.private).catch(() => {});
}

function handleIsUserOnline(ws: WebSocketWithRoom, target: string, tanda?: string) {
  const online = Array.from(clients).some(c => c.idtarget === target);
  safeSend(ws, ["userOnlineStatus", target, online, tanda ?? ""]);
}

function handleMessage(ws: WebSocketWithRoom, dataStr: string) {
  try {
    const data = JSON.parse(dataStr);
    if (!Array.isArray(data) || data.length === 0) return safeSend(ws, ["error", "Invalid message format"]);
    const [evt, ...args] = data;
    switch (evt) {
      case "setIdTarget": handleSetIdTarget(ws, ...args); break;
      case "ping": handlePing(ws, ...args); break;
      case "getAllRoomsUserCount": handleGetAllRoomsUserCount(ws); break;
      case "getCurrentNumber": handleGetCurrentNumber(ws); break;
      case "joinRoom": void handleJoinRoom(ws, ...args); break;
      case "chat": handleChat(ws, ...args); break;
      case "updatePoint": handleUpdatePoint(ws, ...args); break;
      case "removeKursiAndPoint": void handleRemoveKursiAndPoint(ws, ...args); break;
      case "updateKursi": handleUpdateKursi(ws, ...args); break;
      case "sendnotif": handleSendNotif(ws, ...args); break;
      case "private": handlePrivate(ws, ...args); break;
      case "isUserOnline": handleIsUserOnline(ws, ...args); break;
      default: safeSend(ws, ["error", "Unknown event"]); break;
    }
  } catch (err) { 
    console.error("Error handling message:", err, "raw:", dataStr); 
  }
}

// ===== Serve WebSocket =====
serve((req) => {
  try {
    const upgrade = req.headers.get("upgrade") || "";
    if (upgrade.toLowerCase() !== "websocket") return new Response("Expected websocket", { status: 400 });

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
            // ensure global deletion
            kvDelete(["seat", ws.roomname, seat]).catch(() => {});
            kvDelete(["lock", ws.roomname, seat]).catch(() => {});
          }
          broadcastRoomUserCount(ws.roomname);
        }
        cleanupBuffers(ws);
      } catch (err) {
        console.error("❗ Error on close:", err);
      } finally {
        clients.delete(ws);
        ws.numkursi?.clear();
        ws.roomname = undefined;
      }
    };

    return response;
  } catch (err) {
    console.error("WebSocket upgrade error:", err);
    return new Response("Failed to upgrade websocket", { status: 500 });
  }
});

// ===== KV Watchers (sinkron lintas region) =====
// Watch seat, point, chat, private, online

// Seat watcher: update & delete
(async () => {
  for await (const ev of kv.watch([["seat"]])) {
    for (const entry of ev) {
      const key = entry.key;
      if (key[0] !== "seat") continue;
      const room = key[1] as RoomName;
      const seat = key[2] as number;
      const val: any = entry.value;
      if (!room || typeof seat !== "number") continue;

      if (val) {
        // skip if origin is this server (we already broadcasted locally)
        if (val._origin && val._origin === serverId) continue;

        // update memory + broadcast
        const { _origin, points, ...rest } = val;
        const seatInfo: SeatInfo = { points: points ?? [], ...createEmptySeat(), ...(rest as Omit<SeatInfo, "points">) };
        roomSeats.get(room)!.set(seat, seatInfo);
        broadcastToRoom(room, ["kursiBatchUpdate", room, [[seat, rest]]]);
        broadcastRoomUserCount(room);
      } else {
        // deletion event (key removed) - broadcast removal
        const seatMap = roomSeats.get(room)!;
        const info = seatMap.get(seat);
        if (info) resetSeat(info);
        broadcastToRoom(room, ["removeKursi", room, seat]);
        broadcastRoomUserCount(room);
      }
    }
  }
})();

// Point watcher: siarkan gerakan dari region lain
(async () => {
  for await (const ev of kv.watch([["point"]])) {
    for (const entry of ev) {
      const key = entry.key;
      if (key[0] !== "point") continue;
      const room = key[1] as RoomName;
      const seat = key[2] as number;
      const payload: any = entry.value;
      if (!payload) continue;
      if (payload._origin && payload._origin === serverId) continue;
      broadcastToRoom(room, ["pointUpdated", room, seat, payload.x, payload.y, payload.fast]);
    }
  }
})();

// Chat watcher: publish messages from other regions
(async () => {
  for await (const ev of kv.watch([["chat"]])) {
    for (const entry of ev) {
      const key = entry.key;
      if (key[0] !== "chat") continue;
      const room = key[1] as RoomName;
      const value: any = entry.value;
      if (!value) continue;
      if (value._origin && value._origin === serverId) continue;
      broadcastToRoom(room, value.msg);
    }
  }
})();

// Private message watcher: forward to local client if connected
(async () => {
  for await (const ev of kv.watch([["private"]])) {
    for (const entry of ev) {
      const key = entry.key;
      if (key[0] !== "private") continue;
      const idt = key[1] as string;
      const value: any = entry.value;
      if (!value) continue;
      if (value._origin && value._origin === serverId) continue;
      for (const c of [...clients]) if (c.idtarget === idt) safeSend(c, value.msg);
    }
  }
})();

// Online watcher is optional — mostly we set online flag from pings/interval
// but we can watch "online" prefix to update local representation if needed.
(async () => {
  for await (const ev of kv.watch([["online"]])) {
    for (const entry of ev) {
      // we don't need to rebroadcast online to clients here because
      // isUserOnline reads local clients quickly; but this watcher ensures cross-server awareness if desired.
      // left intentionally minimal to avoid chattiness.
    }
  }
})();

// ===== Periodic KV refresh for online flags (keep-alive) =====
setInterval(() => {
  for (const c of clients) {
    if (c.idtarget) kvSetTemp(["online", c.idtarget], { online: true, _origin: serverId }, TTL.online).catch(() => {});
  }
}, 10_000);

// ===== End of file =====
