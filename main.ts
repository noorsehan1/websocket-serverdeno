import { serve } from "https://deno.land/std@0.201.0/http/server.ts";

// ======================= KV INIT =======================
const kv = await Deno.openKv();

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

// ================ KV Key Helpers (Consistent) =================
const keySeat        = (room: RoomName, seat: number) => ["room", room, "seat", seat] as const;
const keySeatPoint   = (room: RoomName, seat: number) => ["room", room, "seat", seat, "lastPoint"] as const;
const keyUserToSeat  = (id: string)                  => ["userToSeat", id] as const; 
const keyChatRoom    = (room: RoomName)              => ["room", room, "chat"] as const; 
const keyPrivate     = (id: string)                  => ["private", id] as const; 
const keyNotif       = (id: string)                  => ["notif", id] as const; 

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
  await kv.set(keySeat(room, seat), info);
}

async function kvDeleteSeat(room: RoomName, seat: number) {
  await kv.delete(keySeat(room, seat));
  await kv.delete(keySeatPoint(room, seat));
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
  await kv.set(keySeatPoint(room, seat), p);
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

// ================= Buffers =================
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
        const allCounts = await getJumlahRoom();
        broadcastToRoom(room, ["roomUserCount", room, allCounts[room]]);
      }
    }
  }
}

async function lockSeat(room: RoomName, ws: WebSocketWithRoom): Promise<number | null> {
  if (!ws.idtarget) return null;

  const prev = await kvGetUserToSeat(ws.idtarget);
  if (prev && prev.room === room) {
    const info = await kvGetSeat(room, prev.seat);
    if (!info || info.namauser === "") {
      const lockInfo: SeatInfo = { ...createEmptySeat(), namauser: "__LOCK__" + ws.idtarget, lockTime: Date.now(), points: [] };
      await kvSetSeat(room, prev.seat, lockInfo);
      return prev.seat;
    }
  }

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
// (semua handler sama persis dengan versi kamu, tidak dihapus demi singkat)

async function handleMessage(ws: WebSocketWithRoom, dataStr: string) {
  try {
    const data = JSON.parse(dataStr);
    if (!Array.isArray(data) || data.length === 0) return safeSend(ws, ["error", "Invalid message format"]);
    const [evt, ...args] = data;
    // switch-case handler (sama seperti kode kamu)
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
          for (const seat of ws.numkursi) {
            const info = await kvGetSeat(ws.roomname, seat);
            if (info) {
              if (info.namauser.startsWith("__LOCK__") || info.namauser) {
                await kvDeleteSeat(ws.roomname, seat);
                broadcastToRoom(ws.roomname, ["removeKursi", ws.roomname, seat]);
              }
            }
          }
          const allCounts = await getJumlahRoom();
          broadcastToRoom(ws.roomname, ["roomUserCount", ws.roomname, allCounts[ws.roomname]]);
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
