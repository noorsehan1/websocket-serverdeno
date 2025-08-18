import { serve } from "https://deno.land/std@0.201.0/http/server.ts";
import {
  connect,
  type Redis,
} from "https://deno.land/x/redis@v0.32.0/mod.ts";

/**
 * =============================================================
 *  WebSocket Server with Redis-backed, multi-instance state
 *  - Preserves original events, variable names, and logic shape
 *  - Replaces in-memory room/seat state with Redis structures
 *  - Adds Redis Pub/Sub so multiple servers stay in sync
 *  - UPDATED: Supports Redis Cloud via REDIS_URL
 * =============================================================
 */

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
  "The Chatter Room",
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

// REDIS connection info
const REDIS_URL = Deno.env.get("REDIS_URL");
const REDIS_HOST = Deno.env.get("REDIS_HOST") ?? "127.0.0.1";
const REDIS_PORT = Number(Deno.env.get("REDIS_PORT") ?? "6379");
const REDIS_BROADCAST_CHANNEL = Deno.env.get("REDIS_BROADCAST_CHANNEL") ?? "broadcast";
const LOCK_TTL_MS = Number(Deno.env.get("LOCK_TTL_MS") ?? "10000"); // 10s

// ===== Redis Setup (NOW SUPPORTS REDIS_URL) =====
async function connectFromEnv(): Promise<{ redis: Redis; sub: Redis; info: string }> {
  if (REDIS_URL) {
    const u = new URL(REDIS_URL);
    const hostname = u.hostname;
    const port = parseInt(u.port || "6379");
    const password = u.password || undefined;

    const redis = await connect({ hostname, port, password });
    const sub = await connect({ hostname, port, password });
    console.log(`✅ Connected to Redis via REDIS_URL → ${hostname}:${port}`);
    return { redis, sub, info: `${hostname}:${port}` };
  } else {
    const redis = await connect({ hostname: REDIS_HOST, port: REDIS_PORT });
    const sub = await connect({ hostname: REDIS_HOST, port: REDIS_PORT });
    console.log(`✅ Connected to Redis via host/port → ${REDIS_HOST}:${REDIS_PORT}`);
    return { redis, sub, info: `${REDIS_HOST}:${REDIS_PORT}` };
  }
}

const { redis, sub } = await connectFromEnv();

// Fan-in Pub/Sub listener → forward to local sockets
(async () => {
  const listener = await sub.subscribe(REDIS_BROADCAST_CHANNEL);
  for await (const { channel, message } of listener.receive()) {
    if (channel !== REDIS_BROADCAST_CHANNEL) continue;
    try {
      const payload = JSON.parse(message);
      const { room, msg } = payload as { room: RoomName; msg: any };
      if (room && msg) broadcastToRoom(room, msg);
    } catch (_) {
      // ignore bad payload
    }
  }
})();

// ===== Redis Keys Helpers =====
const keySeats = (room: RoomName) => `room:${room}:seats`; // Hash: field=seatNumber, value=JSON SeatInfo
const keySeatLock = (room: RoomName, seat: number) => `room:${room}:seat:${seat}:lock`; // String with PX
const keyUserToSeat = (userId: string) => `user:${userId}:seat`; // JSON { room, seat }

// ===== Utilities =====
function createEmptySeat(): SeatInfo {
  return {
    noimageUrl: "",
    namauser: "",
    color: "",
    itembawah: 0,
    itematas: 0,
    vip: false,
    viptanda: 0,
    points: [],
  };
}

function resetSeatLocal(info: SeatInfo) {
  Object.assign(info, createEmptySeat());
}

function assertValidRoom(room: any): room is RoomName {
  if (!allRooms.has(room)) throw new Error("Unknown room: " + room);
  return true;
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
    try {
      ws.close();
    } catch {}
    clients.delete(ws);
  }
}

function broadcastToRoom(room: RoomName, msg: any) {
  for (const c of [...clients]) {
    if (c.roomname === room) safeSend(c, msg);
  }
}

function broadcastToRoomRedis(room: RoomName, msg: any) {
  // Publish for other instances, and deliver to local sockets
  redis.publish(REDIS_BROADCAST_CHANNEL, JSON.stringify({ room, msg })).catch(() => {});
  broadcastToRoom(room, msg);
}

// ===== Redis Seat Ops =====
async function getSeat(room: RoomName, seat: number): Promise<SeatInfo> {
  const raw = await redis.hget(keySeats(room), String(seat));
  return raw ? (JSON.parse(raw) as SeatInfo) : createEmptySeat();
}

async function setSeat(room: RoomName, seat: number, info: SeatInfo): Promise<void> {
  await redis.hset(keySeats(room), { [String(seat)]: JSON.stringify(info) });
}

async function resetSeatRedis(room: RoomName, seat: number): Promise<void> {
  await setSeat(room, seat, createEmptySeat());
}

async function initSeatsIfMissing(): Promise<void> {
  for (const room of allRooms) {
    const exists = await redis.exists(keySeats(room));
    if (!exists) {
      const payload: Record<string, string> = {};
      for (let i = 1; i <= MAX_SEATS; i++) payload[String(i)] = JSON.stringify(createEmptySeat());
      await redis.hset(keySeats(room), payload);
    }
  }
}
await initSeatsIfMissing();

// ===== Room Counts =====
async function getJumlahRoom(): Promise<Record<RoomName, number>> {
  const cnt = Object.fromEntries(roomList.map((r) => [r, 0])) as Record<RoomName, number>;
  for (const room of allRooms) {
    const hash = await redis.hgetall(keySeats(room));
    for (const v of Object.values(hash)) {
      const info: SeatInfo = JSON.parse(v);
      if (info.namauser && !info.namauser.startsWith("__LOCK__")) cnt[room]++;
    }
  }
  return cnt;
}

async function broadcastRoomUserCount(room: RoomName) {
  const allCounts = await getJumlahRoom();
  const count = allCounts[room] || 0;
  broadcastToRoomRedis(room, ["roomUserCount", room, count]);
}

async function handleGetAllRoomsUserCount(ws: WebSocketWithRoom) {
  const allCounts = await getJumlahRoom();
  const result: Array<[RoomName, number]> = roomList.map((room) => [room, allCounts[room]]);
  safeSend(ws, ["allRoomsUserCount", result]);
}

// ===== Buffers (local) =====
const pointUpdateBuffer: Map<RoomName, Map<number, Array<{ x: number; y: number; fast: number }>>> = new Map();
const updateKursiBuffer: Map<RoomName, Map<number, SeatInfo>> = new Map();
const chatMessageBuffer: Map<RoomName, Array<any>> = new Map();
const privateMessageBuffer: Map<string, Array<any>> = new Map();

function flushPrivateMessageBuffer() {
  for (const [idtarget, messages] of privateMessageBuffer) {
    for (const c of clients) if (c.idtarget === idtarget) messages.forEach((msg) => safeSend(c, msg));
    messages.length = 0;
  }
}

function flushChatBuffer() {
  for (const [room, messages] of chatMessageBuffer) {
    messages.forEach((msg) => broadcastToRoomRedis(room, msg));
    messages.length = 0;
  }
}

function flushPointUpdates() {
  for (const [room, seatMap] of pointUpdateBuffer) {
    for (const [seat, points] of seatMap) {
      points.forEach((p) => broadcastToRoomRedis(room, ["pointUpdated", room, seat, p.x, p.y, p.fast]));
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
      broadcastToRoomRedis(room, ["kursiBatchUpdate", room, updates]);
      seatMap.clear();
    }
  }
}

// ===== Current Number =====
let currentNumber = 1;
const maxNumber = 6;
const intervalMillis = 15 * 60 * 1000;

setInterval(() => {
  currentNumber = currentNumber < maxNumber ? currentNumber + 1 : 1;
  for (const c of [...clients]) safeSend(c, ["currentNumber", currentNumber]);
}, intervalMillis);

// ===== Locks (Redis) =====
async function cleanExpiredLocks() {
  // We treat seats with namauser starting with __LOCK__ and stale lockTime as expired
  const now = Date.now();
  for (const room of allRooms) {
    const hash = await redis.hgetall(keySeats(room));
    for (let seat = 1; seat <= MAX_SEATS; seat++) {
      const raw = hash[String(seat)];
      if (!raw) continue;
      const info: SeatInfo = JSON.parse(raw);
      if (info.namauser?.startsWith("__LOCK__") && info.lockTime && now - info.lockTime > LOCK_TTL_MS) {
        await resetSeatRedis(room, seat);
        broadcastToRoomRedis(room, ["removeKursi", room, seat]);
        await broadcastRoomUserCount(room);
      }
    }
  }
}

// Redis-based seat lock using SET NX PX to avoid races across instances
async function lockSeat(room: RoomName, idtarget: string): Promise<number | null> {
  // if user already has a seat in this room and seat empty, reuse it
  const remembered = await redis.get(keyUserToSeat(idtarget));
  if (remembered) {
    try {
      const { room: savedRoom, seat } = JSON.parse(remembered) as { room: RoomName; seat: number };
      if (savedRoom === room) {
        const current = await getSeat(room, seat);
        if (!current.namauser) return seat;
      }
    } catch {}
  }

  for (let i = 1; i <= MAX_SEATS; i++) {
    const lockKey = keySeatLock(room, i);
    // Try obtain lock with TTL
    const ok = await redis.set(lockKey, idtarget, { nx: true, px: LOCK_TTL_MS });
    if (ok) {
      const seatInfo = await getSeat(room, i);
      if (!seatInfo.namauser) {
        const now = Date.now();
        seatInfo.namauser = "__LOCK__" + idtarget;
        seatInfo.lockTime = now;
        await setSeat(room, i, seatInfo);
        await redis.set(keyUserToSeat(idtarget), JSON.stringify({ room, seat: i }));
        return i;
      } else {
        // someone else filled it; release lock key
        await redis.del(lockKey);
      }
    }
  }
  return null;
}

async function cleanupBuffers(ws: WebSocketWithRoom) {
  if (ws.idtarget) {
    privateMessageBuffer.delete(ws.idtarget);
    userToSeat.delete(ws.idtarget);
    // do not delete Redis user mapping here; it is overwritten on join
  }
}

// ===== Periodic Flush =====
setInterval(() => {
  try {
    flushPointUpdates();
    flushKursiUpdates();
    flushChatBuffer();
    flushPrivateMessageBuffer();
  } catch (err) {
    console.error("Error in periodic flush:", err);
  }
}, 100);

setInterval(() => {
  cleanExpiredLocks().catch((e) => console.error("cleanExpiredLocks error:", e));
}, 1000);

// ===== Event Handlers (async wrappers) =====
function handleSetIdTarget(ws: WebSocketWithRoom, id: string) {
  ws.idtarget = id;
  safeSend(ws, ["setIdTargetAck", ws.idtarget]);
}

function handlePing(ws: WebSocketWithRoom, pingId: string) {
  if (pingId && ws.idtarget === pingId) safeSend(ws, ["pong"]);
}

async function handleJoinRoom(ws: WebSocketWithRoom, newRoom: RoomName) {
  try {
    assertValidRoom(newRoom);
  } catch {
    return safeSend(ws, ["error", `Unknown room: ${newRoom}`]);
  }

  if (!ws.idtarget) return safeSend(ws, ["error", "Missing idtarget"]);

  const foundSeat = await lockSeat(newRoom, ws.idtarget);
  if (foundSeat === null) return safeSend(ws, ["roomFull", newRoom]);

  if (ws.roomname && ws.numkursi) {
    const oldRoom = ws.roomname;
    for (const s of ws.numkursi) {
      await resetSeatRedis(oldRoom, s);
      broadcastToRoomRedis(oldRoom, ["removeKursi", oldRoom, s]);
    }
    await broadcastRoomUserCount(oldRoom);
  }

  ws.roomname = newRoom;
  ws.numkursi = new Set([foundSeat]);
  safeSend(ws, ["numberKursiSaya", foundSeat]);
  if (ws.idtarget) {
    userToSeat.set(ws.idtarget, { room: newRoom, seat: foundSeat });
    await redis.set(keyUserToSeat(ws.idtarget), JSON.stringify({ room: newRoom, seat: foundSeat }));
  }

  // collect existing points & meta for this room
  const allPoints: any[] = [];
  const meta: Record<number, Omit<SeatInfo, "points">> = {};
  const hash = await redis.hgetall(keySeats(newRoom));
  for (let seat = 1; seat <= MAX_SEATS; seat++) {
    const raw = hash[String(seat)];
    const info: SeatInfo = raw ? JSON.parse(raw) : createEmptySeat();
    for (const p of info.points) allPoints.push({ seat, ...p });
    if (info.namauser && !info.namauser.startsWith("__LOCK__")) {
      const { points, ...rest } = info;
      (meta as any)[seat] = rest;
    }
  }

  safeSend(ws, ["allPointsList", newRoom, allPoints]);
  safeSend(ws, ["allUpdateKursiList", newRoom, meta]);
  await broadcastRoomUserCount(newRoom);
}

function handleChat(
  ws: WebSocketWithRoom,
  roomname: RoomName,
  noImageURL: string,
  username: string,
  message: string,
  usernameColor: string,
  chatTextColor: string,
) {
  try {
    assertValidRoom(roomname);
  } catch {
    return safeSend(ws, ["error", "Invalid room for chat"]);
  }

  if (!chatMessageBuffer.has(roomname)) chatMessageBuffer.set(roomname, []);
  chatMessageBuffer.get(roomname)!.push(["chat", roomname, noImageURL, username, message, usernameColor, chatTextColor]);
}

async function handleUpdatePoint(
  ws: WebSocketWithRoom,
  room: RoomName,
  seat: number,
  x: number,
  y: number,
  fast: number,
) {
  try {
    assertValidRoom(room);
  } catch {
    return safeSend(ws, ["error", `Unknown room: ${room}`]);
  }
  if (typeof x !== "number" || typeof y !== "number" || typeof fast !== "number") return;

  const seatInfo = await getSeat(room, seat);
  seatInfo.points.push({ x, y, fast });
  await setSeat(room, seat, seatInfo);

  if (!pointUpdateBuffer.has(room)) pointUpdateBuffer.set(room, new Map());
  const roomBuffer = pointUpdateBuffer.get(room)!;
  if (!roomBuffer.has(seat)) roomBuffer.set(seat, []);
  roomBuffer.get(seat)!.push({ x, y, fast });
}

async function handleRemoveKursi(ws: WebSocketWithRoom, room: RoomName, seat: number) {
  try {
    assertValidRoom(room);
  } catch {
    return safeSend(ws, ["error", `Unknown room: ${room}`]);
  }

  await resetSeatRedis(room, seat);
  for (const c of clients) c.numkursi?.delete(seat);
  broadcastToRoomRedis(room, ["removeKursi", room, seat]);
  await broadcastRoomUserCount(room);
}

async function handleUpdateKursi(
  ws: WebSocketWithRoom,
  room: RoomName,
  seat: number,
  noimageUrl: string,
  namauser: string,
  color: string,
  itembawah: number,
  itematas: number,
  vip: boolean,
  viptanda: number,
) {
  try {
    assertValidRoom(room);
  } catch {
    return safeSend(ws, ["error", `Unknown room: ${room}`]);
  }

  const seatInfo: SeatInfo = { noimageUrl, namauser, color, itembawah, itematas, vip, viptanda, points: [] };
  if (!updateKursiBuffer.has(room)) updateKursiBuffer.set(room, new Map());
  updateKursiBuffer.get(room)!.set(seat, seatInfo);
  await setSeat(room, seat, seatInfo);
  await broadcastRoomUserCount(room);
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
}

function handleIsUserOnline(ws: WebSocketWithRoom, target: string, tanda?: string) {
  const online = Array.from(clients).some((c) => c.idtarget === target);
  safeSend(ws, ["userOnlineStatus", target, online, tanda ?? ""]);
}

async function handleMessage(ws: WebSocketWithRoom, dataStr: string) {
  try {
    const data = JSON.parse(dataStr);
    if (!Array.isArray(data) || data.length === 0) return safeSend(ws, ["error", "Invalid message format"]);
    const [evt, ...args] = data;
    switch (evt) {
      case "setIdTarget":
        handleSetIdTarget(ws, ...(args as [string]));
        break;
      case "ping":
        handlePing(ws, ...(args as [string]));
        break;
      case "getAllRoomsUserCount":
        await handleGetAllRoomsUserCount(ws);
        break;
      case "getCurrentNumber":
        safeSend(ws, ["currentNumber", currentNumber]);
        break;
      case "joinRoom":
        await handleJoinRoom(ws, ...(args as [RoomName]));
        break;
      case "chat":
        handleChat(ws, ...(args as [RoomName, string, string, string, string, string]));
        break;
      case "updatePoint":
        await handleUpdatePoint(ws, ...(args as [RoomName, number, number, number, number]));
        break;
      case "removeKursiAndPoint":
        await handleRemoveKursi(ws, ...(args as [RoomName, number]));
        break;
      case "updateKursi":
        await handleUpdateKursi(
          ws,
          ...(args as [RoomName, number, string, string, string, number, number, boolean, number])
        );
        break;
      case "sendnotif":
        handleSendNotif(ws, ...(args as [string, string, string, string]));
        break;
      case "private":
        handlePrivate(ws, ...(args as [string, string, string, string]));
        break;
      case "isUserOnline":
        handleIsUserOnline(ws, ...(args as [string, string?]));
        break;
      default:
        safeSend(ws, ["error", "Unknown event"]);
        break;
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

    ws.onopen = () => {
      ws.numkursi = new Set<number>();
      console.log("Client connected");
    };
    ws.onmessage = (ev) => {
      handleMessage(ws, ev.data);
    };
    ws.onclose = async () => {
      try {
        console.log("❌ User disconnected:", ws.idtarget ?? "(unknown)");
        if (ws.roomname && ws.numkursi) {
          for (const s of ws.numkursi) {
            await resetSeatRedis(ws.roomname, s);
            broadcastToRoomRedis(ws.roomname, ["removeKursi", ws.roomname, s]);
          }
          await broadcastRoomUserCount(ws.roomname);
        }
        await cleanupBuffers(ws);
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