import { serve } from "https://deno.land/std@0.201.0/http/server.ts";

/**
 * ===== Deno KV (Global, Realtime, Ephemeral via TTL) =====
 */
const kv = await Deno.openKv();

/** TTL defaults (ms) untuk data sementara */
const KV_TTL = {
  seat: 30_000,        // kursi aktif 30 detik (akan diperbarui setiap update)
  lock: 10_000,        // lock kursi 10 detik
  chat: 10_000,        // chat tampil dan lalu kadaluarsa
  private: 30_000,     // private message bertahan sebentar
  point: 5_000,        // point (gerak) sangat singkat
  metaRoomCount: 5_000 // cache jumlah user per room
} as const;

/** Helper KV */
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
 * Atomic set-if-not-exists (untuk global lock kursi)
 * return true jika berhasil set; false jika kunci sudah ada
 */
async function kvSetIfAbsent(key: Deno.KvKey, value: unknown, ttlMs: number): Promise<boolean> {
  const tx = kv.atomic().check({ key, version: null }).set(key, value, { expireIn: ttlMs });
  const res = await tx.commit();
  return res.ok;
}

/**
 * ===== Constants & Types =====
 */
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

/**
 * ===== In-memory (tetap dipakai untuk kecepatan lokal) =====
 */
const userToSeat: Map<string, { room: RoomName; seat: number }> = new Map();
const roomSeats: Map<RoomName, Map<number, SeatInfo>> = new Map();

/**
 * ===== Initialize Seats (in-memory) =====
 */
for (const room of allRooms) {
  const seatMap = new Map<number, SeatInfo>();
  for (let i = 1; i <= MAX_SEATS; i++) {
    seatMap.set(i, createEmptySeat());
  }
  roomSeats.set(room, seatMap);
}

/**
 * ===== Utilities =====
 */
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
  for (const c of [...clients]) {
    if (c.roomname === room) safeSend(c, msg);
  }
}

/** Hitung jumlah user aktif per room (abaikan kursi __LOCK__) */
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

/** Kirim seluruh count sekali jalan (mis. untuk dashboard) */
function handleGetAllRoomsUserCount(ws: WebSocketWithRoom) {
  const allCounts = getJumlahRoom();
  const result: Array<[RoomName, number]> = roomList.map(room => [room, allCounts[room]]);
  safeSend(ws, ["allRoomsUserCount", result]);
}

/**
 * ===== Buffers (tetap ada untuk batching lokal) =====
 */
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

/**
 * ===== Current Number (contoh ticker) =====
 */
let currentNumber = 1;
const maxNumber = 6;
const intervalMillis = 15 * 60 * 1000;

setInterval(() => {
  currentNumber = currentNumber < maxNumber ? currentNumber + 1 : 1;
  for (const c of [...clients]) safeSend(c, ["currentNumber", currentNumber]);
}, intervalMillis);

/**
 * ===== Locks (pembersihan lokal) =====
 */
function cleanExpiredLocks() {
  const now = Date.now();
  for (const room of allRooms) {
    const seatMap = roomSeats.get(room)!;
    for (const [seat, info] of seatMap) {
      if (info.namauser.startsWith("__LOCK__") && info.lockTime && now - info.lockTime > KV_TTL.lock) {
        resetSeat(info);
        broadcastToRoom(room, ["removeKursi", room, seat]);
        broadcastRoomUserCount(room);
      }
    }
  }
}

/**
 * ===== Seat & Buffer Utilities =====
 * Lock lokal lama tetap ada, tapi kita tambahkan lock global via KV supaya sinkron antar region.
 */

/** Lock kursi lokal (fallback jika KV gagal) */
function lockSeat(room: RoomName, ws: WebSocketWithRoom): number | null {
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

/** Lock kursi global via KV (mengurangi bentrok kursi lintas region) */
async function lockSeatKV(room: RoomName, ws: WebSocketWithRoom): Promise<number | null> {
  if (!ws.idtarget) return null;
  // jika user sudah punya seat tercatat global?
  const existing = await kvGet<{ room: RoomName; seat: number }>(["userSeat", ws.idtarget]);
  if (existing && existing.room === room) {
    // pastikan kursi masih tersedia di KV, jika tidak lanjut cari baru
    const seatInfo = await kvGet<SeatInfo>(["seat", room, existing.seat]);
    if (!seatInfo || !seatInfo.namauser || seatInfo.namauser.startsWith("__LOCK__")) {
      // re-lock kursi ini
      const ok = await kvSetIfAbsent(["lock", room, existing.seat], { id: ws.idtarget, t: Date.now() }, KV_TTL.lock);
      if (ok) {
        await kvSetTemp(["seat", room, existing.seat], { ...createEmptySeat(), namauser: "__LOCK__" + ws.idtarget, lockTime: Date.now() }, KV_TTL.seat);
        return existing.seat;
      }
    }
  }

  // cari seat kosong secara global
  for (let i = 1; i <= MAX_SEATS; i++) {
    // coba pasang lock jika belum ada
    const ok = await kvSetIfAbsent(["lock", room, i], { id: ws.idtarget, t: Date.now() }, KV_TTL.lock);
    if (!ok) continue; // sudah dilock orang lain atau region lain
    // pasang seat "__LOCK__"
    await kvSetTemp(["seat", room, i], { ...createEmptySeat(), namauser: "__LOCK__" + ws.idtarget, lockTime: Date.now() }, KV_TTL.seat);
    // simpan mapping user -> seat (ephemeral)
    await kvSetTemp(["userSeat", ws.idtarget], { room, seat: i }, KV_TTL.seat);
    return i;
  }
  return null;
}

function cleanupBuffers(ws: WebSocketWithRoom) {
  if (ws.idtarget) {
    privateMessageBuffer.delete(ws.idtarget);
    userToSeat.delete(ws.idtarget);
  }
}

/**
 * ===== Periodic Flush (lokal) =====
 */
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

/**
 * ===== Event Handlers =====
 * Beberapa handler dibuat async agar bisa berinteraksi dengan KV.
 */
function handleSetIdTarget(ws: WebSocketWithRoom, id: string) {
  ws.idtarget = id;
  safeSend(ws, ["setIdTargetAck", ws.idtarget]);
}

function handlePing(ws: WebSocketWithRoom, pingId: string) {
  if (pingId && ws.idtarget === pingId) safeSend(ws, ["pong"]);
}

/** Join room: gunakan lock global KV, sinkron snapshot kursi via KV */
async function handleJoinRoom(ws: WebSocketWithRoom, newRoom: RoomName) {
  try { assertValidRoom(newRoom); } catch { return safeSend(ws, ["error", `Unknown room: ${newRoom}`]); }

  // Coba lock kursi secara global
  let foundSeat = await lockSeatKV(newRoom, ws);
  if (foundSeat === null) {
    // fallback lokal (very rare)
    foundSeat = lockSeat(newRoom, ws);
  }
  if (foundSeat === null) return safeSend(ws, ["roomFull", newRoom]);

  // Bersihkan room lama kalau ada
  if (ws.roomname && ws.numkursi) {
    const oldRoom = ws.roomname;
    for (const s of ws.numkursi) {
      resetSeat(roomSeats.get(oldRoom)!.get(s)!);
      broadcastToRoom(oldRoom, ["removeKursi", oldRoom, s]);
    }
    broadcastRoomUserCount(oldRoom);
  }

  ws.roomname = newRoom;
  ws.numkursi = new Set([foundSeat]);
  safeSend(ws, ["numberKursiSaya", foundSeat]);
  if (ws.idtarget) userToSeat.set(ws.idtarget, { room: newRoom, seat: foundSeat });

  // Sinkron kursi room dari KV (snapshot singkat)
  const iter = kv.list<SeatInfo>({ prefix: ["seat", newRoom] });
  const meta: Record<number, Omit<SeatInfo, "points">> = {};
  for await (const entry of iter) {
    const seat = entry.key[2] as number;
    const info = entry.value;
    if (!info) continue;
    // update in-memory
    roomSeats.get(newRoom)!.set(seat, info);
    if (info.namauser && !info.namauser.startsWith("__LOCK__")) {
      const { points, ...rest } = info;
      meta[seat] = rest;
    }
  }

  // Kumpulkan points yang sudah ada (lokal)
  const allPoints: any[] = [];
  const seatMap = roomSeats.get(newRoom)!;
  for (const [seat, info] of seatMap) {
    for (const p of info.points) allPoints.push({ seat, ...p });
  }

  safeSend(ws, ["allPointsList", newRoom, allPoints]);
  safeSend(ws, ["allUpdateKursiList", newRoom, meta]);
  broadcastRoomUserCount(newRoom);
}

/** Chat: simpan ke buffer lokal + KV (TTL), agar region lain ikut broadcast */
async function handleChat(ws: WebSocketWithRoom, roomname: RoomName, noImageURL: string, username: string, message: string, usernameColor: string, chatTextColor: string) {
  try { assertValidRoom(roomname); } catch { return safeSend(ws, ["error", "Invalid room for chat"]); }

  if (!chatMessageBuffer.has(roomname)) chatMessageBuffer.set(roomname, []);
  const payload = ["chat", roomname, noImageURL, username, message, usernameColor, chatTextColor];

  chatMessageBuffer.get(roomname)!.push(payload);

  // KV publish (ephemeral). Key unik per timestamp untuk memicu watch()
  const ts = Date.now();
  await kvSetTemp(["chat", roomname, ts, crypto.randomUUID?.() ?? Math.random()], payload, KV_TTL.chat);
}

/** Points: simpan lokal untuk batch + KV kecil agar region lain render realtime */
async function handleUpdatePoint(ws: WebSocketWithRoom, room: RoomName, seat: number, x: number, y: number, fast: number) {
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

  // Publish ke KV dengan TTL sangat pendek
  const ts = Date.now();
  await kvSetTemp(["point", room, seat, ts], { x, y, fast }, KV_TTL.point);
}

/** Remove kursi: hapus lokal + hapus KV agar region lain tahu */
async function handleRemoveKursi(ws: WebSocketWithRoom, room: RoomName, seat: number) {
  try { assertValidRoom(room); } catch { return safeSend(ws, ["error", `Unknown room: ${room}`]); }

  resetSeat(roomSeats.get(room)!.get(seat)!);
  for (const c of clients) c.numkursi?.delete(seat);
  broadcastToRoom(room, ["removeKursi", room, seat]);
  broadcastRoomUserCount(room);

  await kvDelete(["seat", room, seat]);
  await kvDelete(["lock", room, seat]);
}

/** Update kursi: simpan lokal + KV (TTL) */
async function handleUpdateKursi(ws: WebSocketWithRoom, room: RoomName, seat: number, noimageUrl: string, namauser: string, color: string, itembawah: number, itematas: number, vip: boolean, viptanda: number) {
  try { assertValidRoom(room); } catch { return safeSend(ws, ["error", `Unknown room: ${room}`]); }

  const seatInfo: SeatInfo = { noimageUrl, namauser, color, itembawah, itematas, vip, viptanda, points: [] };
  if (!updateKursiBuffer.has(room)) updateKursiBuffer.set(room, new Map());
  updateKursiBuffer.get(room)!.set(seat, seatInfo);
  roomSeats.get(room)!.set(seat, seatInfo);

  await kvSetTemp(["seat", room, seat], seatInfo, KV_TTL.seat);

  broadcastRoomUserCount(room);
}

/** Notif langsung (tidak perlu KV) */
function handleSendNotif(ws: WebSocketWithRoom, idtarget: string, noimageUrl: string, username: string, deskripsi: string) {
  const notifData = ["notif", noimageUrl, username, deskripsi, Date.now()];
  for (const c of [...clients]) if (c.idtarget === idtarget) safeSend(c, notifData);
}

/** Private message: kirim balik ke pengirim, push ke buffer lokal, simpan KV TTL untuk crossing region */
async function handlePrivate(ws: WebSocketWithRoom, idt: string, url: string, msg: string, sender: string) {
  const ts = Date.now();
  const out = ["private", idt, url, msg, ts, sender];
  safeSend(ws, out);
  if (!privateMessageBuffer.has(idt)) privateMessageBuffer.set(idt, []);
  privateMessageBuffer.get(idt)!.push(out);

  await kvSetTemp(["private", idt, ts, crypto.randomUUID?.() ?? Math.random()], out, KV_TTL.private);
}

/** Cek online status (lokal saja sudah cukup cepat) */
function handleIsUserOnline(ws: WebSocketWithRoom, target: string, tanda?: string) {
  const online = Array.from(clients).some(c => c.idtarget === target);
  safeSend(ws, ["userOnlineStatus", target, online, tanda ?? ""]);
}

/** Dispatcher utama (async untuk bisa await KV) */
async function handleMessage(ws: WebSocketWithRoom, dataStr: string) {
  try {
    const data = JSON.parse(dataStr);
    if (!Array.isArray(data) || data.length === 0) return safeSend(ws, ["error", "Invalid message format"]);
    const [evt, ...args] = data;
    switch (evt) {
      case "setIdTarget": handleSetIdTarget(ws, ...args); break;
      case "ping": handlePing(ws, ...args); break;
      case "getAllRoomsUserCount": handleGetAllRoomsUserCount(ws); break;
      case "getCurrentNumber": safeSend(ws, ["currentNumber", currentNumber]); break;
      case "joinRoom": await handleJoinRoom(ws, ...args); break;
      case "chat": await handleChat(ws, ...args); break;
      case "updatePoint": await handleUpdatePoint(ws, ...args); break;
      case "removeKursiAndPoint": await handleRemoveKursi(ws, ...args); break;
      case "updateKursi": await handleUpdateKursi(ws, ...args); break;
      case "sendnotif": handleSendNotif(ws, ...args); break;
      case "private": await handlePrivate(ws, ...args); break;
      case "isUserOnline": handleIsUserOnline(ws, ...args); break;
      default: safeSend(ws, ["error", "Unknown event"]); break;
    }
  } catch (err) {
    console.error("Error handling message:", err, "raw:", dataStr);
  }
}

/**
 * ===== WebSocket Server =====
 */
serve((req) => {
  try {
    const upgrade = req.headers.get("upgrade") || "";
    if (upgrade.toLowerCase() !== "websocket") return new Response("Expected websocket", { status: 400 });

    const { socket, response } = Deno.upgradeWebSocket(req);
    const ws = socket as WebSocketWithRoom;
    clients.add(ws);

    ws.onopen = () => { ws.numkursi = new Set<number>(); console.log("Client connected"); };
    ws.onmessage = (ev) => { void handleMessage(ws, ev.data); };
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

/**
 * ===== KV Watchers (Realtime lintas region) =====
 * - seat: sinkron kursi
 * - point: sinkron gerakan
 * - chat: sinkron pesan publik
 * - private: sinkron pesan privat per user
 *
 * Watcher berjalan terus di background (event loop), mem-broadcast ke client lokal
 * saat ada perubahan dari region mana pun.
 */

/** Watch kursi */
(async () => {
  for await (const ev of kv.watch([["seat"]])) {
    for (const entry of ev) {
      const key = entry.key;
      if (key[0] !== "seat") continue;
      const room = key[1] as RoomName;
      const seat = key[2] as number;
      const info = entry.value as SeatInfo | null;
      if (!room || typeof seat !== "number") continue;

      // Update in-memory agar getJumlahRoom konsisten
      if (info) {
        roomSeats.get(room)!.set(seat, info);
        const { points, ...rest } = info;
        broadcastToRoom(room, ["kursiBatchUpdate", room, [[seat, rest]]]);
      } else {
        // deleted (remove kursi)
        resetSeat(roomSeats.get(room)!.get(seat)!);
        broadcastToRoom(room, ["removeKursi", room, seat]);
      }
      broadcastRoomUserCount(room);
    }
  }
})();

/** Watch point */
(async () => {
  for await (const ev of kv.watch([["point"]])) {
    for (const entry of ev) {
      const key = entry.key;
      if (key[0] !== "point") continue;
      const room = key[1] as RoomName;
      const seat = key[2] as number;
      const payload = entry.value as { x: number; y: number; fast: number } | null;
      if (!room || typeof seat !== "number" || !payload) continue;
      broadcastToRoom(room, ["pointUpdated", room, seat, payload.x, payload.y, payload.fast]);
    }
  }
})();

/** Watch chat publik */
(async () => {
  for await (const ev of kv.watch([["chat"]])) {
    for (const entry of ev) {
      const key = entry.key;
      if (key[0] !== "chat") continue;
      const room = key[1] as RoomName;
      const msg = entry.value as any;
      if (!room || !msg) continue;
      broadcastToRoom(room, msg);
    }
  }
})();

/** Watch private message: kirim ke user yang dituju bila tersambung di server lokal */
(async () => {
  for await (const ev of kv.watch([["private"]])) {
    for (const entry of ev) {
      const key = entry.key;
      if (key[0] !== "private") continue;
      const idt = key[1] as string;
      const payload = entry.value as any;
      if (!idt || !payload) continue;
      for (const c of [...clients]) if (c.idtarget === idt) safeSend(c, payload);
    }
  }
})();
