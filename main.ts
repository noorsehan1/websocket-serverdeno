// main.ts — hybrid (local cache + Deno KV realtime)
// deno-lint-ignore-file no-explicit-any
import { serve } from "https://deno.land/std@0.201.0/http/server.ts";

////////////////////////////////////////////////////////////////////////////////
// CONFIG
////////////////////////////////////////////////////////////////////////////////
const kv = await Deno.openKv(); // default KV (no token). Replace with dedicated URL if needed.
const INSTANCE_ID = crypto.randomUUID(); // used to avoid double-broadcast

////////////////////////////////////////////////////////////////////////////////
// Types / Constants (keaslian sesuai kode awal)
////////////////////////////////////////////////////////////////////////////////
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

const clients = new Set<WebSocketWithRoom>();

////////////////////////////////////////////////////////////////////////////////
// Utilities / Helpers
////////////////////////////////////////////////////////////////////////////////
function createEmptySeat(): SeatInfo {
  return { noimageUrl: "", namauser: "", color: "", itembawah: 0, itematas: 0, vip: false, viptanda: 0, points: [] };
}
function resetSeat(info: SeatInfo) { Object.assign(info, createEmptySeat()); }

function safeSend(ws: WebSocketWithRoom, msg: any) {
  try {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
    else clients.delete(ws);
  } catch {
    try { ws.close(); } catch {}
    clients.delete(ws);
  }
}

function assertValidRoom(room: any): room is RoomName {
  if (!allRooms.has(room)) throw new Error("Unknown room: " + room);
  return true;
}

function broadcastToRoom(room: RoomName, msg: any) {
  for (const c of [...clients]) if (c.roomname === room) safeSend(c, msg);
}
function broadcastToUser(idtarget: string, msg: any) {
  for (const c of [...clients]) if (c.idtarget === idtarget) safeSend(c, msg);
}

////////////////////////////////////////////////////////////////////////////////
// Local cache (fast response)
////////////////////////////////////////////////////////////////////////////////
const userToSeat: Map<string, { room: RoomName; seat: number }> = new Map();
const roomSeats: Map<RoomName, Map<number, SeatInfo>> = new Map();
for (const r of allRooms) {
  const m = new Map<number, SeatInfo>();
  for (let i = 1; i <= MAX_SEATS; i++) m.set(i, createEmptySeat());
  roomSeats.set(r, m);
}

////////////////////////////////////////////////////////////////////////////////
// Restore seats once at startup (single kv.list over prefix ["room"] to reduce reads)
////////////////////////////////////////////////////////////////////////////////
(async () => {
  try {
    for await (const entry of kv.list({ prefix: ["room"] })) {
      // keys are like ["room", "<RoomName>", "seat", <number>] OR ["room","<RoomName>","seat",<n>,"lastPoint"]
      const key = entry.key as Array<string | number>;
      if (key.length >= 4 && key[2] === "seat" && typeof key[3] === "number") {
        const room = key[1] as RoomName;
        const seat = key[3] as number;
        const v = entry.value;
        // our stored seat wrapper: { origin, seat }
        if (v && typeof v === "object" && "seat" in v) {
          const si = v.seat as SeatInfo;
          roomSeats.get(room)!.set(seat, si);
        } else if (v && typeof v === "object" && "namauser" in v) {
          // fallback: raw SeatInfo
          roomSeats.get(room)!.set(seat, v as SeatInfo);
        }
      }
    }
    console.log("✅ Restored seats from KV to local cache");
  } catch (err) {
    console.error("⚠️ Error restoring seats from KV:", err);
  }
})();

////////////////////////////////////////////////////////////////////////////////
// KV wrappers (we store a small wrapper { origin, payload } so watcher can ignore own writes)
////////////////////////////////////////////////////////////////////////////////
async function kvSetSeat(room: RoomName, seat: number, info: SeatInfo) {
  // store wrapper
  await kv.set(["room", room, "seat", seat], { origin: INSTANCE_ID, seat: info });
}
async function kvDeleteSeat(room: RoomName, seat: number) {
  await kv.delete(["room", room, "seat", seat]);
  await kv.delete(["room", room, "seat", seat, "lastPoint"]);
}
async function kvSetSeatPoint(room: RoomName, seat: number, p: { x: number; y: number; fast: number }) {
  await kv.set(["room", room, "seat", seat, "lastPoint"], { origin: INSTANCE_ID, p });
}
async function kvSetChat(room: RoomName, chatSnap: any) {
  const t = Date.now();
  await kv.set(["room", room, "chat", t, crypto.randomUUID()], { origin: INSTANCE_ID, payload: chatSnap });
}
async function kvSetPrivate(idt: string, privateSnap: any) {
  const t = Date.now();
  await kv.set(["private", idt, t, crypto.randomUUID()], { origin: INSTANCE_ID, payload: privateSnap });
}
async function kvSetNotif(idt: string, notifSnap: any) {
  const t = Date.now();
  await kv.set(["notif", idt, t, crypto.randomUUID()], { origin: INSTANCE_ID, payload: notifSnap });
}
async function kvSetUserToSeat(id: string, data: { room: RoomName; seat: number } | null) {
  if (data) await kv.set(["userToSeat", id], { origin: INSTANCE_ID, mapping: data });
  else await kv.delete(["userToSeat", id]);
}

////////////////////////////////////////////////////////////////////////////////
// Helpers counting users (uses local cache)
////////////////////////////////////////////////////////////////////////////////
function getJumlahRoom(): Record<RoomName, number> {
  const cnt = Object.fromEntries(roomList.map(r => [r, 0])) as Record<RoomName, number>;
  for (const room of allRooms) {
    let c = 0;
    const seatMap = roomSeats.get(room)!;
    for (const info of seatMap.values()) {
      if (info.namauser && !info.namauser.startsWith("__LOCK__")) c++;
    }
    cnt[room] = c;
  }
  return cnt;
}
async function broadcastRoomUserCount(room: RoomName) {
  const allCounts = getJumlahRoom();
  broadcastToRoom(room, ["roomUserCount", room, allCounts[room]]);
  // optionally persist snapshot of last chat/room status if you want
}

////////////////////////////////////////////////////////////////////////////////
// Buffers (batching local broadcasts)
////////////////////////////////////////////////////////////////////////////////
const pointUpdateBuffer: Map<RoomName, Map<number, Array<{ x: number; y: number; fast: number }>>> = new Map();
const updateKursiBuffer: Map<RoomName, Map<number, SeatInfo>> = new Map();
const chatMessageBuffer: Map<RoomName, Array<any>> = new Map();
const privateMessageBuffer: Map<string, Array<any>> = new Map();

function flushPointUpdates() {
  for (const [room, seatMap] of pointUpdateBuffer) {
    for (const [seat, points] of seatMap) {
      for (const p of points) broadcastToRoom(room, ["pointUpdated", room, seat, p.x, p.y, p.fast]);
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
function flushChatBuffer() {
  for (const [room, messages] of chatMessageBuffer) {
    for (const m of messages) broadcastToRoom(room, m);
    messages.length = 0;
  }
}
function flushPrivateBuffer() {
  for (const [idt, messages] of privateMessageBuffer) {
    for (const m of messages) broadcastToUser(idt, m);
    messages.length = 0;
  }
}

setInterval(() => {
  try {
    flushPointUpdates();
    flushKursiUpdates();
    flushChatBuffer();
    flushPrivateBuffer();
  } catch (err) {
    console.error("Error flushing buffers:", err);
  }
}, 100);

////////////////////////////////////////////////////////////////////////////////
// Clean expired locks periodically (local cache + KV)
////////////////////////////////////////////////////////////////////////////////
setInterval(async () => {
  const now = Date.now();
  for (const room of allRooms) {
    const seatMap = roomSeats.get(room)!;
    for (const [seat, info] of seatMap) {
      if (info.namauser?.startsWith("__LOCK__") && info.lockTime && now - info.lockTime > 10000) {
        // clear locally and in KV
        roomSeats.get(room)!.set(seat, createEmptySeat());
        await kvDeleteSeat(room, seat);
        broadcastToRoom(room, ["removeKursi", room, seat]);
        await broadcastRoomUserCount(room);
      }
    }
  }
}, 5000);

////////////////////////////////////////////////////////////////////////////////
// Event Handlers (same cases as original)
////////////////////////////////////////////////////////////////////////////////
function handleSetIdTarget(ws: WebSocketWithRoom, id: string) {
  ws.idtarget = id;
  safeSend(ws, ["setIdTargetAck", ws.idtarget]);
}
function handlePing(ws: WebSocketWithRoom, pingId: string) {
  if (pingId && ws.idtarget === pingId) safeSend(ws, ["pong"]);
}
async function handleGetAllRoomsUserCount(ws: WebSocketWithRoom) {
  const allCounts = getJumlahRoom();
  const result: Array<[RoomName, number]> = roomList.map(room => [room, allCounts[room]]);
  safeSend(ws, ["allRoomsUserCount", result]);
}
function handleGetCurrentNumber(ws: WebSocketWithRoom) {
  safeSend(ws, ["currentNumber", currentNumber]);
}

async function handleJoinRoom(ws: WebSocketWithRoom, newRoom: RoomName) {
  try { assertValidRoom(newRoom); } catch { return safeSend(ws, ["error", `Unknown room: ${newRoom}`]); }

  // try lock seat (local cache)
  if (!ws.idtarget) return safeSend(ws, ["error", "no idtarget"]);
  // attempt to reuse user's previous seat (from kv)
  const prev = await kv.get<{ origin?: string; mapping: { room: RoomName; seat: number } }>(["userToSeat", ws.idtarget]);
  if (prev.value && prev.value.mapping && prev.value.mapping.room === newRoom) {
    const infoPrev = roomSeats.get(newRoom)!.get(prev.value.mapping.seat)!;
    if (!infoPrev || !infoPrev.namauser) {
      // grab previous seat
      const seatNo = prev.value.mapping.seat;
      infoPrev.namauser = "__LOCK__" + ws.idtarget;
      infoPrev.lockTime = Date.now();
      roomSeats.get(newRoom)!.set(seatNo, infoPrev);
      await kvSetSeat(newRoom, seatNo, infoPrev);
      ws.roomname = newRoom;
      ws.numkursi = new Set([seatNo]);
      if (ws.idtarget) userToSeat.set(ws.idtarget, { room: newRoom, seat: seatNo });
      safeSend(ws, ["numberKursiSaya", seatNo]);
      // send snapshot from local cache
      const meta: Record<number, Omit<SeatInfo, "points">> = {};
      for (const [s, si] of roomSeats.get(newRoom)!) {
        if (si.namauser && !si.namauser.startsWith("__LOCK__")) {
          const { points, ...rest } = si;
          meta[s] = rest;
        }
      }
      safeSend(ws, ["allUpdateKursiList", newRoom, meta]);
      await broadcastRoomUserCount(newRoom);
      return;
    }
  }

  // otherwise find first empty seat locally
  const seatMap = roomSeats.get(newRoom)!;
  let foundSeat: number | null = null;
  for (let i = 1; i <= MAX_SEATS; i++) {
    const s = seatMap.get(i)!;
    if (!s.namauser) {
      s.namauser = "__LOCK__" + ws.idtarget;
      s.lockTime = Date.now();
      roomSeats.get(newRoom)!.set(i, s);
      await kvSetSeat(newRoom, i, s);
      foundSeat = i;
      break;
    }
  }
  if (foundSeat === null) return safeSend(ws, ["roomFull", newRoom]);

  // if the ws had previous room seats, clear them
  if (ws.roomname && ws.numkursi) {
    for (const s of ws.numkursi) {
      roomSeats.get(ws.roomname)!.set(s, createEmptySeat());
      await kvDeleteSeat(ws.roomname, s);
      broadcastToRoom(ws.roomname, ["removeKursi", ws.roomname, s]);
    }
    await broadcastRoomUserCount(ws.roomname);
  }

  ws.roomname = newRoom;
  ws.numkursi = new Set([foundSeat]);
  safeSend(ws, ["numberKursiSaya", foundSeat]);

  if (ws.idtarget) {
    userToSeat.set(ws.idtarget, { room: newRoom, seat: foundSeat });
    await kvSetUserToSeat(ws.idtarget, { room: newRoom, seat: foundSeat });
  }

  // send snapshot from local cache (no kv.list here — use cache to avoid extra reads)
  const meta: Record<number, Omit<SeatInfo, "points">> = {};
  for (const [s, si] of roomSeats.get(newRoom)!) {
    if (si.namauser && !si.namauser.startsWith("__LOCK__")) {
      const { points, ...rest } = si;
      meta[s] = rest;
    }
  }
  safeSend(ws, ["allUpdateKursiList", newRoom, meta]);

  // also snapshot last points list from local cache
  const allPoints: Array<{ seat: number; x: number; y: number; fast: number }> = [];
  for (const [s, si] of roomSeats.get(newRoom)!) {
    if (si.points && si.points.length) {
      const last = si.points[si.points.length - 1];
      allPoints.push({ seat: s, x: last.x, y: last.y, fast: last.fast });
    }
  }
  safeSend(ws, ["allPointsList", newRoom, allPoints]);

  await broadcastRoomUserCount(newRoom);
}

async function handleChat(ws: WebSocketWithRoom, roomname: RoomName, noImageURL: string, username: string, message: string, usernameColor: string, chatTextColor: string) {
  try { assertValidRoom(roomname); } catch { return safeSend(ws, ["error", "Invalid room for chat"]); }
  const chatSnap = ["chat", roomname, noImageURL, username, message, usernameColor, chatTextColor] as const;
  // write to KV (wrapped)
  await kvSetChat(roomname, chatSnap);
  // update local buffer + broadcast instantly (fast)
  if (!chatMessageBuffer.has(roomname)) chatMessageBuffer.set(roomname, []);
  chatMessageBuffer.get(roomname)!.push(chatSnap);
  broadcastToRoom(roomname, chatSnap);
}

async function handleUpdatePoint(ws: WebSocketWithRoom, room: RoomName, seat: number, x: number, y: number, fast: number) {
  try { assertValidRoom(room); } catch { return safeSend(ws, ["error", `Unknown room: ${room}`]); }
  if (typeof x !== "number" || typeof y !== "number" || typeof fast !== "number") return;
  // update local cache points
  const si = roomSeats.get(room)!.get(seat);
  if (!si) return;
  si.points.push({ x, y, fast });
  roomSeats.get(room)!.set(seat, si);
  // write last point to KV
  await kvSetSeatPoint(room, seat, { x, y, fast });
  // buffer for efficient broadcast locally
  if (!pointUpdateBuffer.has(room)) pointUpdateBuffer.set(room, new Map());
  const roomBuffer = pointUpdateBuffer.get(room)!;
  if (!roomBuffer.has(seat)) roomBuffer.set(seat, []);
  roomBuffer.get(seat)!.push({ x, y, fast });
}

async function handleRemoveKursi(ws: WebSocketWithRoom, room: RoomName, seat: number) {
  try { assertValidRoom(room); } catch { return safeSend(ws, ["error", `Unknown room: ${room}`]); }
  // local cache
  roomSeats.get(room)!.set(seat, createEmptySeat());
  // remove KV
  await kvDeleteSeat(room, seat);
  // broadcast
  broadcastToRoom(room, ["removeKursi", room, seat]);
  await broadcastRoomUserCount(room);
}

async function handleUpdateKursi(ws: WebSocketWithRoom, room: RoomName, seat: number, noimageUrl: string, namauser: string, color: string, itembawah: number, itematas: number, vip: boolean, viptanda: number) {
  try { assertValidRoom(room); } catch { return safeSend(ws, ["error", `Unknown room: ${room}`]); }
  const seatInfo: SeatInfo = { noimageUrl, namauser, color, itembawah, itematas, vip, viptanda, points: [] };
  // update local cache & KV
  roomSeats.get(room)!.set(seat, seatInfo);
  if (!updateKursiBuffer.has(room)) updateKursiBuffer.set(room, new Map());
  updateKursiBuffer.get(room)!.set(seat, seatInfo);
  await kvSetSeat(room, seat, seatInfo);
  await broadcastRoomUserCount(room);
}

async function handleSendNotif(ws: WebSocketWithRoom, idtarget: string, noimageUrl: string, username: string, deskripsi: string) {
  const notifData = ["notif", noimageUrl, username, deskripsi, Date.now()];
  // persist to KV (so other instances can pick it and deliver)
  await kvSetNotif(idtarget, notifData);
  // quick deliver to local clients that match
  for (const c of [...clients]) if (c.idtarget === idtarget) safeSend(c, notifData);
}

async function handlePrivate(ws: WebSocketWithRoom, idt: string, url: string, msg: string, sender: string) {
  const ts = Date.now();
  const out = ["private", idt, url, msg, ts, sender];
  // persist so other instances also see and deliver
  await kvSetPrivate(idt, out);
  // deliver back to sender instantly and buffer for target
  safeSend(ws, out);
  if (!privateMessageBuffer.has(idt)) privateMessageBuffer.set(idt, []);
  privateMessageBuffer.get(idt)!.push(out);
  // if local instance has target online deliver now
  for (const c of clients) if (c.idtarget === idt) safeSend(c, out);
}

function handleIsUserOnline(ws: WebSocketWithRoom, target: string, tanda?: string) {
  const online = Array.from(clients).some(c => c.idtarget === target);
  safeSend(ws, ["userOnlineStatus", target, online, tanda ?? ""]);
}

////////////////////////////////////////////////////////////////////////////////
// Dispatcher
////////////////////////////////////////////////////////////////////////////////
async function handleMessage(ws: WebSocketWithRoom, dataStr: string) {
  try {
    const data = JSON.parse(dataStr);
    if (!Array.isArray(data) || data.length === 0) return safeSend(ws, ["error", "Invalid message format"]);
    const [evt, ...args] = data;
    switch (evt) {
      case "setIdTarget": handleSetIdTarget(ws, ...args); break;
      case "ping": handlePing(ws, ...args); break;
      case "getAllRoomsUserCount": await handleGetAllRoomsUserCount(ws); break;
      case "getCurrentNumber": handleGetCurrentNumber(ws); break;
      case "joinRoom": await handleJoinRoom(ws, ...args); break;
      case "chat": await handleChat(ws, ...args); break;
      case "updatePoint": await handleUpdatePoint(ws, ...args); break;
      case "removeKursiAndPoint": await handleRemoveKursi(ws, ...args); break;
      case "updateKursi": await handleUpdateKursi(ws, ...args); break;
      case "sendnotif": await handleSendNotif(ws, ...args); break;
      case "private": await handlePrivate(ws, ...args); break;
      case "isUserOnline": handleIsUserOnline(ws, ...args); break;
      default: safeSend(ws, ["error", "Unknown event"]); break;
    }
  } catch (err) {
    console.error("Error handling message:", err, "raw:", dataStr);
  }
}

////////////////////////////////////////////////////////////////////////////////
// KV watcher: listen to changes made by any instance and apply to local cache + broadcast
// We watch "room" (seats, lastPoint, chats), "private", "notif"
////////////////////////////////////////////////////////////////////////////////
(async () => {
  try {
    for await (const events of kv.watch([["room"], ["private"], ["notif"]])) {
      for (const e of events) {
        const key = e.key as Array<string | number>;
        const val = e.value as any;
        // Ignore deletes
        if (!val) {
          // if seat deleted -> broadcast remove if key shape matches
          if (key.length >= 4 && key[0] === "room" && key[2] === "seat" && typeof key[3] === "number") {
            const room = key[1] as RoomName;
            const seat = key[3] as number;
            roomSeats.get(room)!.set(seat, createEmptySeat());
            broadcastToRoom(room, ["removeKursi", room, seat]);
            await broadcastRoomUserCount(room);
          }
          continue;
        }

        // If origin is us, skip to avoid double broadcast
        if (val.origin === INSTANCE_ID) continue;

        // room chat (room, "chat", t, uuid)
        if (key[0] === "room" && key[2] === "chat") {
          const room = key[1] as RoomName;
          const payload = val.payload;
          if (payload) {
            // update local buffer & broadcast
            if (!chatMessageBuffer.has(room)) chatMessageBuffer.set(room, []);
            chatMessageBuffer.get(room)!.push(payload);
            broadcastToRoom(room, payload);
          }
          continue;
        }

        // room seat update (["room", room, "seat", n] -> { origin, seat })
        if (key[0] === "room" && key[2] === "seat" && typeof key[3] === "number") {
          const room = key[1] as RoomName;
          const seat = key[3] as number;
          // val may be wrapper { origin, seat } or raw seat
          const seatInfo: SeatInfo = (val.seat ?? val) as SeatInfo;
          roomSeats.get(room)!.set(seat, seatInfo);
          // batch update to UI
          if (!updateKursiBuffer.has(room)) updateKursiBuffer.set(room, new Map());
          updateKursiBuffer.get(room)!.set(seat, seatInfo);
          await broadcastRoomUserCount(room);
          continue;
        }

        // room seat lastPoint (["room", room, "seat", n, "lastPoint"])
        if (key[0] === "room" && key[2] === "seat" && key[4] === "lastPoint") {
          const room = key[1] as RoomName;
          const seat = key[3] as number;
          const p = val.p as { x: number; y: number; fast: number };
          // update local cache too (append)
          const si = roomSeats.get(room)!.get(seat)!;
          if (si) {
            si.points.push(p);
            roomSeats.get(room)!.set(seat, si);
          }
          broadcastToRoom(room, ["pointUpdated", room, seat, p.x, p.y, p.fast]);
          continue;
        }

        // private messages
        if (key[0] === "private") {
          const idt = key[1] as string;
          const payload = val.payload;
          if (payload) {
            // broadcast to local clients who match
            for (const c of [...clients]) if (c.idtarget === idt) safeSend(c, payload);
          }
          continue;
        }

        // notif
        if (key[0] === "notif") {
          const idt = key[1] as string;
          const payload = val.payload;
          if (payload) {
            for (const c of [...clients]) if (c.idtarget === idt) safeSend(c, payload);
          }
          continue;
        }
      }
    }
  } catch (err) {
    console.error("KV watch errored:", err);
    // optional: re-run watcher after delay
    setTimeout(() => { /* watcher will auto restart with for-await? keep simple */ }, 1000);
  }
})();

////////////////////////////////////////////////////////////////////////////////
// Current Number (like original)
////////////////////////////////////////////////////////////////////////////////
let currentNumber = 1;
const maxNumber = 6;
const intervalMillis = 15 * 60 * 1000;
setInterval(async () => {
  currentNumber = currentNumber < maxNumber ? currentNumber + 1 : 1;
  // broadcast locally
  for (const c of [...clients]) safeSend(c, ["currentNumber", currentNumber]);
  // persist a snapshot if you want (not required)
}, intervalMillis);

////////////////////////////////////////////////////////////////////////////////
// WebSocket Server (serve)
////////////////////////////////////////////////////////////////////////////////
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

    ws.onmessage = (ev) => { handleMessage(ws, ev.data); };

    ws.onclose = async () => {
      try {
        console.log("❌ User disconnected:", ws.idtarget ?? "(unknown)");
        if (ws.roomname && ws.numkursi) {
          const seatMap = ws.numkursi;
          for (const seat of seatMap) {
            const info = roomSeats.get(ws.roomname)!.get(seat);
            if (info) {
              // clear locally and in KV
              roomSeats.get(ws.roomname)!.set(seat, createEmptySeat());
              await kvDeleteSeat(ws.roomname, seat);
              broadcastToRoom(ws.roomname, ["removeKursi", ws.roomname, seat]);
            }
          }
          await broadcastRoomUserCount(ws.roomname);
        }
        if (ws.idtarget) await kvSetUserToSeat(ws.idtarget, null);
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
