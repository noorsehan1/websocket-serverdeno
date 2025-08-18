// file: realtime-kv-chat-full.ts
// Full Deno WebSocket server with Deno KV for cross-region realtime sync
// Features:
// - Rooms with seats (MAX_SEATS)
// - Seat locking, update, remove
// - Points (per-seat drawing updates) buffered & synced
// - Chat messages per-room
// - Private messages (persisted to KV for cross-instance delivery, ephemeral)
// - User session keys in KV (ephemeral)
// - KV.watch-based watchers for seats, chat, points, private messages
// - Handlers use the same case/event strings as your original code
//
// Run with Deno (supports Deno.openKv). Example:
//    deno run --allow-net --allow-read --allow-write --unstable realtime-kv-chat-full.ts
//
// Note: In production, ensure your Deno KV backend is available to all instances/regions.

import { serve } from "https://deno.land/std@0.201.0/http/server.ts";

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

// ===== Local mirrors & clients =====
const clients = new Set<WebSocketWithRoom>();
const userToSeat: Map<string, { room: RoomName; seat: number }> = new Map();
const roomSeats: Map<RoomName, Map<number, SeatInfo>> = new Map();

// ===== Initialize local seat maps =====
for (const room of allRooms) {
  const seatMap = new Map<number, SeatInfo>();
  for (let i = 1; i <= MAX_SEATS; i++) {
    seatMap.set(i, createEmptySeat());
  }
  roomSeats.set(room, seatMap);
}

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
    points: []
  };
}

function resetSeat(info: SeatInfo) {
  Object.assign(info, createEmptySeat());
}

function safeSend(ws: WebSocketWithRoom, msg: any) {
  try {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(msg));
    } else {
      clients.delete(ws);
    }
  } catch (err) {
    console.error("safeSend error:", err);
    try { ws.close(); } catch {}
    clients.delete(ws);
  }
}

function assertValidRoom(room: any): room is RoomName {
  if (!allRooms.has(room)) throw new Error("Unknown room: " + room);
  return true;
}

function broadcastToRoom(room: RoomName, msg: any) {
  for (const c of [...clients]) {
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

// ===== Buffers (local) =====
const pointUpdateBuffer: Map<RoomName, Map<number, Array<{ x: number; y: number; fast: number }>>> = new Map();
const updateKursiBuffer: Map<RoomName, Map<number, SeatInfo>> = new Map();
const chatMessageBuffer: Map<RoomName, Array<any>> = new Map();
const privateMessageBuffer: Map<string, Array<any>> = new Map();

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
      const { points, ...rest } = info;
      updates.push([seat, rest]);
    }
    if (updates.length > 0) {
      broadcastToRoom(room, ["kursiBatchUpdate", room, updates]);
      seatMap.clear();
    }
  }
}

// ===== currentNumber periodic broadcast =====
let currentNumber = 1;
const maxNumber = 6;
const intervalMillis = 15 * 60 * 1000;

setInterval(() => {
  currentNumber = currentNumber < maxNumber ? currentNumber + 1 : 1;
  for (const c of [...clients]) safeSend(c, ["currentNumber", currentNumber]);
}, intervalMillis);

// ===== Locks cleaning (local and KV cleanup) =====
function cleanExpiredLocks() {
  const now = Date.now();
  for (const room of allRooms) {
    const seatMap = roomSeats.get(room)!;
    for (const [seat, info] of seatMap) {
      if (info.namauser.startsWith("__LOCK__") && info.lockTime && now - info.lockTime > 10000) {
        resetSeat(info);
        broadcastToRoom(room, ["removeKursi", room, seat]);
        broadcastRoomUserCount(room);
        // ensure kv removal as well
        kv.delete(["room", room, "seat", String(seat)]).catch(err => console.warn("kv delete expired lock err", err));
      }
    }
  }
}

// ===== KV Key helpers =====
function keyRoomSeat(room: RoomName, seat: number) {
  return ["room", room, "seat", String(seat)];
}
function keyRoomChat(room: RoomName, id?: string) {
  return id ? ["room", room, "chat", id] : ["room", room, "chat"];
}
function keyRoomPoints(room: RoomName, seat: number, id?: string) {
  return id ? ["room", room, "points", String(seat), id] : ["room", room, "points", String(seat)];
}
function keyUserSession(id: string) {
  return ["user", id, "session"];
}
function keyPrivate(toId: string, id?: string) {
  return id ? ["private", toId, id] : ["private", toId];
}

// ===== KV helpers (async) =====
async function kvUpdateSeat(room: RoomName, seat: number, info: SeatInfo) {
  try {
    await kv.set(keyRoomSeat(room, seat), info);
  } catch (err) {
    console.error("kvUpdateSeat error:", err);
  }
}

async function kvRemoveSeat(room: RoomName, seat: number) {
  try {
    await kv.delete(keyRoomSeat(room, seat));
  } catch (err) {
    console.error("kvRemoveSeat error:", err);
  }
}

async function kvAddChat(room: RoomName, msg: any) {
  try {
    await kv.set(keyRoomChat(room, crypto.randomUUID()), msg);
  } catch (err) {
    console.error("kvAddChat error:", err);
  }
}

async function kvAddPoint(room: RoomName, seat: number, point: any) {
  try {
    await kv.set(keyRoomPoints(room, seat, `${Date.now()}-${crypto.randomUUID()}`), point);
  } catch (err) {
    console.error("kvAddPoint error:", err);
  }
}

async function kvSaveUserSession(ws: WebSocketWithRoom) {
  if (!ws.idtarget) return;
  try {
    await kv.set(keyUserSession(ws.idtarget), {
      room: ws.roomname ?? null,
      seats: [...(ws.numkursi ?? [])],
      ts: Date.now(),
    });
  } catch (err) {
    console.error("kvSaveUserSession error:", err);
  }
}

async function kvDeleteUserSession(ws: WebSocketWithRoom) {
  if (!ws.idtarget) return;
  try {
    await kv.delete(keyUserSession(ws.idtarget));
    for await (const ent of kv.list({ prefix: ["user", ws.idtarget] })) {
      await kv.delete(ent.key);
    }
  } catch (err) {
    console.error("kvDeleteUserSession error:", err);
  }
}

async function kvAddPrivate(toId: string, fromId: string, msg: any) {
  try {
    await kv.set(keyPrivate(toId, crypto.randomUUID()), { from: fromId, ...msg });
  } catch (err) {
    console.error("kvAddPrivate error:", err);
  }
}

async function kvDeletePrivateForTarget(toId: string) {
  try {
    for await (const ent of kv.list({ prefix: ["private", toId] })) {
      await kv.delete(ent.key);
    }
  } catch (err) {
    console.error("kvDeletePrivateForTarget error:", err);
  }
}

// ===== Seat locking logic (local + KV mark) =====
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

async function lockSeat(room: RoomName, ws: WebSocketWithRoom): Promise<number | null> {
  // first try local quick lock
  const found = lockSeatLocal(room, ws);
  if (found !== null) {
    const seatInfo = roomSeats.get(room)!.get(found)!;
    await kvUpdateSeat(room, found, seatInfo);
    return found;
  }

  // fallback: attempt to scan KV to find empty seat (rare path)
  try {
    for (let i = 1; i <= MAX_SEATS; i++) {
      const key = keyRoomSeat(room, i);
      const res = await kv.get(key);
      if (!res.value) {
        const marker: SeatInfo = { ...createEmptySeat(), namauser: "__LOCK__" + ws.idtarget, lockTime: Date.now() };
        await kv.set(key, marker);
        roomSeats.get(room)!.set(i, marker);
        return i;
      }
    }
  } catch (err) {
    console.error("lockSeat kv fallback error:", err);
  }
  return null;
}

// ===== Cleanup helper =====
function cleanupBuffers(ws: WebSocketWithRoom) {
  if (ws.idtarget) {
    privateMessageBuffer.delete(ws.idtarget);
    userToSeat.delete(ws.idtarget);
  }
}

// ===== Event Handlers =====
async function handleSetIdTarget(ws: WebSocketWithRoom, id: string) {
  ws.idtarget = id;
  await kvSaveUserSession(ws);
  safeSend(ws, ["setIdTargetAck", ws.idtarget]);
}

function handlePing(ws: WebSocketWithRoom, pingId: string) {
  if (pingId && ws.idtarget === pingId) safeSend(ws, ["pong"]);
}

async function handleJoinRoom(ws: WebSocketWithRoom, newRoom: RoomName) {
  try { assertValidRoom(newRoom); } catch { return safeSend(ws, ["error", `Unknown room: ${newRoom}`]); }

  const foundSeat = await lockSeat(newRoom, ws);
  if (foundSeat === null) return safeSend(ws, ["roomFull", newRoom]);

  if (ws.roomname && ws.numkursi) {
    const oldRoom = ws.roomname;
    for (const s of ws.numkursi) {
      resetSeat(roomSeats.get(oldRoom)!.get(s)!);
      kvRemoveSeat(oldRoom, s).catch(console.error);
      broadcastToRoom(oldRoom, ["removeKursi", oldRoom, s]);
    }
    broadcastRoomUserCount(oldRoom);
  }

  ws.roomname = newRoom;
  ws.numkursi = new Set([foundSeat]);
  safeSend(ws, ["numberKursiSaya", foundSeat]);
  if (ws.idtarget) {
    userToSeat.set(ws.idtarget, { room: newRoom, seat: foundSeat });
    await kvSaveUserSession(ws);
  }

  // compose allPoints & meta from local mirror (which should be in sync via kv.watch)
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

async function handleChat(ws: WebSocketWithRoom, roomname: RoomName, noImageURL: string, username: string, message: string, usernameColor: string, chatTextColor: string) {
  try { assertValidRoom(roomname); } catch { return safeSend(ws, ["error", "Invalid room for chat"]); }

  const chatMsg = ["chat", roomname, noImageURL, username, message, usernameColor, chatTextColor, Date.now()];
  kvAddChat(roomname, chatMsg).catch(err => console.error("kvAddChat err", err));

  if (!chatMessageBuffer.has(roomname)) chatMessageBuffer.set(roomname, []);
  chatMessageBuffer.get(roomname)!.push(chatMsg);
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

  kvAddPoint(room, seat, { x, y, fast, ts: Date.now() }).catch(err => console.error("kvAddPoint err", err));
}

async function handleRemoveKursi(ws: WebSocketWithRoom, room: RoomName, seat: number) {
  try { assertValidRoom(room); } catch { return safeSend(ws, ["error", `Unknown room: ${room}`]); }

  resetSeat(roomSeats.get(room)!.get(seat)!);
  for (const c of clients) c.numkursi?.delete(seat);

  await kvRemoveSeat(room, seat).catch(err => console.error("kvRemoveSeat err", err));

  broadcastToRoom(room, ["removeKursi", room, seat]);
  broadcastRoomUserCount(room);
}

async function handleUpdateKursi(ws: WebSocketWithRoom, room: RoomName, seat: number, noimageUrl: string, namauser: string, color: string, itembawah: number, itematas: number, vip: boolean, viptanda: number) {
  try { assertValidRoom(room); } catch { return safeSend(ws, ["error", `Unknown room: ${room}`]); }

  const seatInfo: SeatInfo = { noimageUrl, namauser, color, itembawah, itematas, vip, viptanda, points: [] };
  if (!updateKursiBuffer.has(room)) updateKursiBuffer.set(room, new Map());
  updateKursiBuffer.get(room)!.set(seat, seatInfo);

  roomSeats.get(room)!.set(seat, seatInfo);
  await kvUpdateSeat(room, seat, seatInfo);
  broadcastRoomUserCount(room);
}

function handleSendNotif(ws: WebSocketWithRoom, idtarget: string, noimageUrl: string, username: string, deskripsi: string) {
  const notifData = ["notif", noimageUrl, username, deskripsi, Date.now()];
  for (const c of [...clients]) if (c.idtarget === idtarget) safeSend(c, notifData);
}

async function handlePrivate(ws: WebSocketWithRoom, idt: string, url: string, msg: string, sender: string) {
  const ts = Date.now();
  const out = ["private", idt, url, msg, ts, sender];
  // send to sender immediately
  safeSend(ws, out);
  // store to KV so target can receive across instances
  await kvAddPrivate(idt, sender, { url, msg, ts }).catch(err => console.error("kvAddPrivate err", err));
  // Also buffer locally for immediate delivery if target on same instance
  if (!privateMessageBuffer.has(idt)) privateMessageBuffer.set(idt, []);
  privateMessageBuffer.get(idt)!.push(out);
}

function handleIsUserOnline(ws: WebSocketWithRoom, target: string, tanda?: string) {
  const online = Array.from(clients).some(c => c.idtarget === target);
  safeSend(ws, ["userOnlineStatus", target, online, tanda ?? ""]);
}

async function handleKickUser(ws: WebSocketWithRoom, targetId: string) {
  // Kick: remove user's seats and session from KV and notify their client if connected here
  try {
    // delete session key and any private messages intended for them
    await kvDeleteAllForUserId(targetId);
    await kvDeletePrivateForTarget(targetId);
    // scan all rooms to remove any seats with that id
    for (const room of allRooms) {
      for (let i = 1; i <= MAX_SEATS; i++) {
        try {
          const key = keyRoomSeat(room, i);
          const res = await kv.get(key);
          if (res.value && (res.value as SeatInfo).namauser === targetId) {
            await kv.delete(key);
            // update local mirror
            const info = roomSeats.get(room)!.get(i)!;
            resetSeat(info);
            broadcastToRoom(room, ["removeKursi", room, i]);
            broadcastRoomUserCount(room);
          }
        } catch (err) {
          console.error("kickUser scan err", err);
        }
      }
    }

    // if target connected to this instance, notify & close socket
    for (const c of [...clients]) {
      if (c.idtarget === targetId) {
        safeSend(c, ["kicked", targetId]);
        try { c.close(); } catch {}
      }
    }
  } catch (err) {
    console.error("handleKickUser err", err);
  }
}

async function handleMessage(ws: WebSocketWithRoom, dataStr: string) {
  try {
    const data = JSON.parse(dataStr);
    if (!Array.isArray(data) || data.length === 0) return safeSend(ws, ["error", "Invalid message format"]);
    const [evt, ...args] = data;
    switch (evt) {
      case "setIdTarget": await handleSetIdTarget(ws, ...args); break;
      case "ping": handlePing(ws, ...args); break;
      case "getAllRoomsUserCount": handleGetAllRoomsUserCount(ws); break;
      case "getCurrentNumber": safeSend(ws, ["currentNumber", currentNumber]); break;
      case "joinRoom": await handleJoinRoom(ws, ...args); break;
      case "chat": await handleChat(ws, ...args); break;
      case "updatePoint": handleUpdatePoint(ws, ...args); break;
      case "removeKursiAndPoint": await handleRemoveKursi(ws, ...args); break;
      case "updateKursi": await handleUpdateKursi(ws, ...args); break;
      case "sendnotif": handleSendNotif(ws, ...args); break;
      case "private": await handlePrivate(ws, ...args); break;
      case "isUserOnline": handleIsUserOnline(ws, ...args); break;
      case "kickUser": await handleKickUser(ws, ...args); break;
      default: safeSend(ws, ["error", "Unknown event"]); break;
    }
  } catch (err) {
    console.error("Error handling message:", err, "raw:", dataStr);
  }
}

// ===== KV watchers for cross-instance sync =====
// seats, chat, points, private messages
(async () => {
  for (const room of roomList) {
    // watch seats for this room
    (async () => {
      const prefix = ["room", room, "seat"];
      try {
        for await (const ev of kv.watch({ prefix })) {
          try {
            const key = ev.key as string[]; // ["room", room, "seat", seatStr]
            const seatStr = key[3];
            const seat = parseInt(seatStr);
            const kvVal = ev.value as SeatInfo | null;
            if (kvVal) {
              // update local mirror and broadcast
              roomSeats.get(room)!.set(seat, kvVal as SeatInfo);
              const { points, ...rest } = kvVal as any;
              broadcastToRoom(room, ["kursiBatchUpdate", room, [[seat, rest]]]);
            } else {
              // seat removed
              const info = roomSeats.get(room)!.get(seat)!;
              resetSeat(info);
              broadcastToRoom(room, ["removeKursi", room, seat]);
            }
            broadcastRoomUserCount(room);
          } catch (inner) {
            console.error("Error processing kv.watch seat event:", inner);
          }
        }
      } catch (err) {
        console.error("kv.watch seats error:", err);
      }
    })();

    // watch chat messages for this room
    (async () => {
      const prefix = ["room", room, "chat"];
      try {
        for await (const ev of kv.watch({ prefix })) {
          try {
            if (ev.value) {
              const msg = ev.value;
              broadcastToRoom(room, msg);
            }
          } catch (inner) {
            console.error("Error processing kv.watch chat event:", inner);
          }
        }
      } catch (err) {
        console.error("kv.watch chat error:", err);
      }
    })();

    // watch points for this room
    (async () => {
      const prefix = ["room", room, "points"];
      try {
        for await (const ev of kv.watch({ prefix })) {
          try {
            const key = ev.key as string[]; // ["room", room, "points", seatStr, id]
            const seatStr = key[3];
            const seat = parseInt(seatStr);
            if (ev.value) {
              const p = ev.value as { x: number; y: number; fast: number; ts?: number };
              const seatInfo = roomSeats.get(room)!.get(seat);
              if (seatInfo) seatInfo.points.push({ x: p.x, y: p.y, fast: p.fast });
              broadcastToRoom(room, ["pointUpdated", room, seat, p.x, p.y, p.fast]);
            }
          } catch (inner) {
            console.error("Error processing kv.watch point event:", inner);
          }
        }
      } catch (err) {
        console.error("kv.watch points error:", err);
      }
    })();
  }

  // watch private messages for any target
  (async () => {
    const prefix = ["private"];
    try {
      for await (const ev of kv.watch({ prefix })) {
        try {
          if (ev.value) {
            const key = ev.key as string[]; // ["private", targetId, uuid]
            const targetId = key[1];
            const val = ev.value as any; // { from, url, msg, ts }
            // deliver to local clients that match targetId
            for (const c of clients) {
              if (c.idtarget === targetId) {
                safeSend(c, ["private", targetId, val.url ?? "", val.msg ?? "", val.ts ?? Date.now(), val.from ?? ""]);
              }
            }
            // Also store into local buffer for clients that connect later briefly (best-effort)
            if (!privateMessageBuffer.has(targetId)) privateMessageBuffer.set(targetId, []);
            privateMessageBuffer.get(targetId)!.push(["private", targetId, val.url ?? "", val.msg ?? "", val.ts ?? Date.now(), val.from ?? ""]);
            // delete the KV key after reading so it's ephemeral
            await kv.delete(ev.key);
          }
        } catch (inner) {
          console.error("Error processing kv.watch private event:", inner);
        }
      }
    } catch (err) {
      console.error("kv.watch private error:", err);
    }
  })();
})();

// ===== Serve WebSocket =====
serve((req) => {
  try {
    const upgrade = req.headers.get("upgrade") || "";
    if (upgrade.toLowerCase() !== "websocket") return new Response("Expected websocket", { status: 400 });

    const { socket, response } = Deno.upgradeWebSocket(req);
    const ws = socket as WebSocketWithRoom;
    clients.add(ws);

    ws.onopen = () => { ws.numkursi = new Set<number>(); console.log("Client connected"); };

    ws.onmessage = (ev) => {
      // allow async message handler
      handleMessage(ws, ev.data).catch(err => console.error("handleMessage error:", err));
    };

    ws.onclose = async () => {
      try {
        console.log("❌ User disconnected:", ws.idtarget ?? "(unknown)");
        if (ws.roomname && ws.numkursi) {
          const seatMap = roomSeats.get(ws.roomname)!;
          for (const seat of ws.numkursi) {
            resetSeat(seatMap.get(seat)!);
            // remove from KV so other instances see removal
            await kvRemoveSeat(ws.roomname, seat).catch(err => console.error("kvRemoveSeat on close err", err));
            broadcastToRoom(ws.roomname, ["removeKursi", ws.roomname, seat]);
          }
          broadcastRoomUserCount(ws.roomname);
        }
        cleanupBuffers(ws);

        if (ws.idtarget) {
          await kvDeleteUserSession(ws).catch(err => console.error("kvDeleteUserSession err", err));
          // also remove private messages for the user (optional)
          await kvDeletePrivateForTarget(ws.idtarget).catch(err => console.error("kvDeletePrivateForTarget err", err));
          // also attempt removal of keys that might bear "__LOCK__<id>" in namauser
          // We scan seats and remove any seat that still has the lock from this id (best-effort)
          for (const r of allRooms) {
            const seatMap = roomSeats.get(r)!;
            for (const [s, info] of seatMap) {
              if (info.namauser === `__LOCK__${ws.idtarget}`) {
                resetSeat(info);
                await kvRemoveSeat(r, s).catch(err => console.error("kvRemoveSeat remove lock err", err));
                broadcastToRoom(r, ["removeKursi", r, s]);
              }
            }
          }
        }
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
