// deno-lint-ignore-file no-explicit-any
import { serve } from "https://deno.land/std@0.201.0/http/server.ts";

// ======================= KV INIT =======================
// Pastikan tambahkan env var DENO_KV_ACCESS_TOKEN di Deno Deploy
const kv = await Deno.openKv(
  "https://api.deno.com/databases/27ef7a70-74d4-4c69-970c-c5a185e12788/connect"
);

// =================== Constants & Types =================
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

// ================ KV Key Helpers (konsisten) =================
const keySeat        = (room: RoomName, seat: number) => ["room", room, "seat", seat] as const;
const keySeatPoint   = (room: RoomName, seat: number) => ["room", room, "seat", seat, "lastPoint"] as const;
const keyUserToSeat  = (id: string)                  => ["userToSeat", id] as const;        // {room, seat}
const keyChatRoom    = (room: RoomName)              => ["room", room, "chat"] as const;    // pesan terakhir (snapshot)
const keyPrivate     = (id: string)                  => ["private", id] as const;           // pesan private terakhir (snapshot)
const keyNotif       = (id: string)                  => ["notif", id] as const;             // notif terakhir (snapshot)

// ================= Utilities =================
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
      clients.delete(ws);
    }
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
  for (const c of [...clients]) {
    if (c.roomname === room) safeSend(c, msg);
  }
}

// ================== KV Wrappers ==================
async function kvGetSeat(room: RoomName, seat: number): Promise<SeatInfo | null> {
  const r = await kv.get<SeatInfo>(keySeat(room, seat));
  return r.value ?? null;
}

async function kvSetSeat(room: RoomName, seat: number, info: SeatInfo) {
  await kv.set(keySeat(room, seat), info); // overwrite snapshot
}

async function kvDeleteSeat(room: RoomName, seat: number) {
  await kv.delete(keySeat(room, seat));
  await kv.delete(keySeatPoint(room, seat)); // bersihkan snapshot point terakhir
}

async function kvSetUserToSeat(id: string, data: { room: RoomName; seat: number } | null) {
  if (data) await kv.set(keyUserToSeat(id), data);
  else await kv.delete(keyUserToSeat(id));
}

async function kvGetUserToSeat(id: string): Promise<{ room: RoomName; seat: number } | null> {
  const r = await kv.get<{ room: RoomName; seat: number }>(keyUserToSeat(id));
  return r.value ?? null;
}

async function kvSetSeatPoint(room: RoomName, seat: number, p: { x: number; y: number; fast: number }) {
  await kv.set(keySeatPoint(room, seat), p); // overwrite snapshot
}

async function kvGetAllPoints(room: RoomName): Promise<Array<{ seat: number; x: number; y: number; fast: number }>> {
  const out: Array<{ seat: number; x: number; y: number; fast: number }> = [];
  for (let i = 1; i <= MAX_SEATS; i++) {
    const r = await kv.get<{ x: number; y: number; fast: number }>(keySeatPoint(room, i));
    if (r.value) out.push({ seat: i, ...r.value });
  }
  return out;
}

async function kvGetAllActiveSeatsMeta(room: RoomName): Promise<Record<number, Omit<SeatInfo, "points">>> {
  const meta: Record<number, Omit<SeatInfo, "points">> = {};
  for (let i = 1; i <= MAX_SEATS; i++) {
    const info = await kvGetSeat(room, i);
    if (info && info.namauser && !info.namauser.startsWith("__LOCK__")) {
      const { points, ...rest } = info;
      meta[i] = rest;
    }
  }
  return meta;
}

async function getJumlahRoom(): Promise<Record<RoomName, number>> {
  const cnt = Object.fromEntries(roomList.map(r => [r, 0])) as Record<RoomName, number>;
  for (const room of allRooms) {
    let c = 0;
    for (let i = 1; i <= MAX_SEATS; i++) {
      const info = await kvGetSeat(room, i);
      if (info && info.namauser && !info.namauser.startsWith("__LOCK__")) c++;
    }
    cnt[room] = c;
  }
  return cnt;
}

async function broadcastRoomUserCount(room: RoomName) {
  const allCounts = await getJumlahRoom();
  broadcastToRoom(room, ["roomUserCount", room, allCounts[room]]);
}

// ================= Buffers (untuk batching broadcast, state tetap di KV) =================
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

// ================ Current Number ================
let currentNumber = 1;
const maxNumber = 6;
const intervalMillis = 15 * 60 * 1000;

setInterval(() => {
  currentNumber = currentNumber < maxNumber ? currentNumber + 1 : 1;
  for (const c of [...clients]) safeSend(c, ["currentNumber", currentNumber]);
}, intervalMillis);

// ================= Locks & Cleanup =================
async function cleanExpiredLocks() {
  const now = Date.now();
  for (const room of allRooms) {
    for (let seat = 1; seat <= MAX_SEATS; seat++) {
      const info = await kvGetSeat(room, seat);
      if (info && info.namauser.startsWith("__LOCK__") && info.lockTime && now - info.lockTime > 10000) {
        await kvDeleteSeat(room, seat);
        broadcastToRoom(room, ["removeKursi", room, seat]);
        await broadcastRoomUserCount(room); // lock tidak dihitung user aktif
      }
    }
  }
}

async function lockSeat(room: RoomName, ws: WebSocketWithRoom): Promise<number | null> {
  if (!ws.idtarget) return null;

  // Reuse kursi sebelumnya jika masih kosong
  const prev = await kvGetUserToSeat(ws.idtarget);
  if (prev && prev.room === room) {
    const info = await kvGetSeat(room, prev.seat);
    if (!info || info.namauser === "") {
      const lockInfo: SeatInfo = { ...createEmptySeat(), namauser: "__LOCK__" + ws.idtarget, lockTime: Date.now(), points: [] };
      await kvSetSeat(room, prev.seat, lockInfo);
      return prev.seat;
    }
  }

  // Cari kursi kosong
  for (let i = 1; i <= MAX_SEATS; i++) {
    const info = await kvGetSeat(room, i);
    if (!info || info.namauser === "") {
      const lockInfo: SeatInfo = { ...createEmptySeat(), namauser: "__LOCK__" + ws.idtarget, lockTime: Date.now(), points: [] };
      await kvSetSeat(room, i, lockInfo);
      return i;
    }
  }
  return null;
}

function cleanupBuffers(ws: WebSocketWithRoom) {
  if (ws.idtarget) {
    privateMessageBuffer.delete(ws.idtarget);
  }
}

// ================ Periodic Flush ================
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

// =================== Event Handlers ===================
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

  // Jika sebelumnya punya room, bersihkan kursinya
  if (ws.roomname && ws.numkursi) {
    const oldRoom = ws.roomname;
    for (const s of ws.numkursi) {
      await kvDeleteSeat(oldRoom, s);
      broadcastToRoom(oldRoom, ["removeKursi", oldRoom, s]);
    }
    await broadcastRoomUserCount(oldRoom);
  }

  ws.roomname = newRoom;
  ws.numkursi = new Set([foundSeat]);
  safeSend(ws, ["numberKursiSaya", foundSeat]);

  if (ws.idtarget) await kvSetUserToSeat(ws.idtarget, { room: newRoom, seat: foundSeat });

  // Kirim snapshot points & kursi aktif
  const allPoints = await kvGetAllPoints(newRoom);
  safeSend(ws, ["allPointsList", newRoom, allPoints]);

  const meta = await kvGetAllActiveSeatsMeta(newRoom);
  safeSend(ws, ["allUpdateKursiList", newRoom, meta]);

  await broadcastRoomUserCount(newRoom);
}

async function handleChat(ws: WebSocketWithRoom, roomname: RoomName, noImageURL: string, username: string, message: string, usernameColor: string, chatTextColor: string) {
  try { assertValidRoom(roomname); } catch { return safeSend(ws, ["error", "Invalid room for chat"]); }

  const chatSnap = ["chat", roomname, noImageURL, username, message, usernameColor, chatTextColor] as const;
  await kv.set(keyChatRoom(roomname), chatSnap); // snapshot terakhir
  if (!chatMessageBuffer.has(roomname)) chatMessageBuffer.set(roomname, []);
  chatMessageBuffer.get(roomname)!.push(chatSnap);
}

async function handleUpdatePoint(ws: WebSocketWithRoom, room: RoomName, seat: number, x: number, y: number, fast: number) {
  try { assertValidRoom(room); } catch { return safeSend(ws, ["error", `Unknown room: ${room}`]); }
  if (typeof x !== "number" || typeof y !== "number" || typeof fast !== "number") return;

  // Simpan snapshot point terakhir ke KV (overwrite)
  await kvSetSeatPoint(room, seat, { x, y, fast });

  // Buffer broadcast realtime
  if (!pointUpdateBuffer.has(room)) pointUpdateBuffer.set(room, new Map());
  const roomBuffer = pointUpdateBuffer.get(room)!;
  if (!roomBuffer.has(seat)) roomBuffer.set(seat, []);
  roomBuffer.get(seat)!.push({ x, y, fast });
}

async function handleRemoveKursi(ws: WebSocketWithRoom, room: RoomName, seat: number) {
  try { assertValidRoom(room); } catch { return safeSend(ws, ["error", `Unknown room: ${room}`]); }

  await kvDeleteSeat(room, seat);
  for (const c of clients) c.numkursi?.delete(seat);
  broadcastToRoom(room, ["removeKursi", room, seat]);

  await broadcastRoomUserCount(room);
}

async function handleUpdateKursi(ws: WebSocketWithRoom, room: RoomName, seat: number, noimageUrl: string, namauser: string, color: string, itembawah: number, itematas: number, vip: boolean, viptanda: number) {
  try { assertValidRoom(room); } catch { return safeSend(ws, ["error", `Unknown room: ${room}`]); }

  const seatInfo: SeatInfo = { noimageUrl, namauser, color, itembawah, itematas, vip, viptanda, points: [] };
  await kvSetSeat(room, seat, seatInfo); // overwrite snapshot kursi

  // Buffer kursi untuk batch broadcast ringan
  if (!updateKursiBuffer.has(room)) updateKursiBuffer.set(room, new Map());
  updateKursiBuffer.get(room)!.set(seat, seatInfo);

  await broadcastRoomUserCount(room);
}

async function handleSendNotif(ws: WebSocketWithRoom, idtarget: string, noimageUrl: string, username: string, deskripsi: string) {
  const notifData = ["notif", noimageUrl, username, deskripsi, Date.now()];
  await kv.set(keyNotif(idtarget), notifData); // snapshot terakhir
  for (const c of [...clients]) if (c.idtarget === idtarget) safeSend(c, notifData);
}

async function handlePrivate(ws: WebSocketWithRoom, idt: string, url: string, msg: string, sender: string) {
  const ts = Date.now();
  const out = ["private", idt, url, msg, ts, sender];
  await kv.set(keyPrivate(idt), out); // snapshot terakhir
  safeSend(ws, out);
  if (!privateMessageBuffer.has(idt)) privateMessageBuffer.set(idt, []);
  privateMessageBuffer.get(idt)!.push(out);
}

function handleIsUserOnline(ws: WebSocketWithRoom, target: string, tanda?: string) {
  const online = Array.from(clients).some(c => c.idtarget === target);
  safeSend(ws, ["userOnlineStatus", target, online, tanda ?? ""]);
}

async function handleGetAllRoomsUserCount(ws: WebSocketWithRoom) {
  const allCounts = await getJumlahRoom();
  const result: Array<[RoomName, number]> = roomList.map(room => [room, allCounts[room]]);
  safeSend(ws, ["allRoomsUserCount", result]);
}

// ================= Dispatcher =================
async function handleMessage(ws: WebSocketWithRoom, dataStr: string) {
  try {
    const data = JSON.parse(dataStr);
    if (!Array.isArray(data) || data.length === 0) return safeSend(ws, ["error", "Invalid message format"]);
    const [evt, ...args] = data;
    switch (evt) {
      case "setIdTarget": handleSetIdTarget(ws, ...args); break;
      case "ping": handlePing(ws, ...args); break;
      case "getAllRoomsUserCount": await handleGetAllRoomsUserCount(ws); break;
      case "getCurrentNumber": safeSend(ws, ["currentNumber", currentNumber]); break;
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

// ================= Serve WebSocket =================
serve((req) => {
  try {
    const upgrade = req.headers.get("upgrade") || "";
    if (upgrade.toLowerCase() !== "websocket") return new Response("Expected websocket", { status: 400 });

    const { socket, response } = Deno.upgradeWebSocket(req);
    const ws = socket as WebSocketWithRoom;
    clients.add(ws);

    ws.onopen = () => { ws.numkursi = new Set<number>(); console.log("Client connected"); };
    ws.onmessage = (ev) => { handleMessage(ws, ev.data); };
    ws.onclose = async () => {
      try {
        console.log("❌ User disconnected:", ws.idtarget ?? "(unknown)");
        if (ws.roomname && ws.numkursi) {
          const seatMap = ws.numkursi;
          for (const seat of seatMap) {
            const info = await kvGetSeat(ws.roomname, seat);
            if (info) {
              if (info.namauser.startsWith("__LOCK__") || info.namauser) {
                await kvDeleteSeat(ws.roomname, seat);
                broadcastToRoom(ws.roomname, ["removeKursi", ws.roomname, seat]);
              }
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
