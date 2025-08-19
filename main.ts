// ====== main.ts ======
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

// ===== Local Cache (fast response) =====
const userToSeat: Map<string, { room: RoomName; seat: number }> = new Map();
const roomSeats: Map<RoomName, Map<number, SeatInfo>> = new Map();

// ===== Initialize Seats =====
function createEmptySeat(): SeatInfo {
  return { noimageUrl: "", namauser: "", color: "", itembawah: 0, itematas: 0, vip: false, viptanda: 0, points: [] };
}
function resetSeat(info: SeatInfo) {
  Object.assign(info, createEmptySeat());
}
for (const room of allRooms) {
  const seatMap = new Map<number, SeatInfo>();
  for (let i = 1; i <= MAX_SEATS; i++) seatMap.set(i, createEmptySeat());
  roomSeats.set(room, seatMap);
}

// ===== Utilities =====
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
function handleGetAllRoomsUserCount(ws: WebSocketWithRoom) {
  const allCounts = getJumlahRoom();
  safeSend(ws, ["allRoomsUserCount", roomList.map(room => [room, allCounts[room]])]);
}

// ===== Buffers =====
const chatMessageBuffer: Map<RoomName, Array<any>> = new Map();
const privateMessageBuffer: Map<string, Array<any>> = new Map();
function flushChatBuffer() {
  for (const [room, messages] of chatMessageBuffer) {
    messages.forEach(msg => broadcastToRoom(room, msg));
    messages.length = 0;
  }
}
function flushPrivateMessageBuffer() {
  for (const [idtarget, messages] of privateMessageBuffer) {
    for (const c of clients) if (c.idtarget === idtarget) messages.forEach(msg => safeSend(c, msg));
    messages.length = 0;
  }
}

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
        kv.delete(["seat", room, seat]);
      }
    }
  }
}

// ===== Seat Utilities =====
function lockSeat(room: RoomName, ws: WebSocketWithRoom): number | null {
  const seatMap = roomSeats.get(room)!;
  if (!ws.idtarget) return null;
  for (let i = 1; i <= MAX_SEATS; i++) {
    const kursi = seatMap.get(i)!;
    if (kursi.namauser === "") {
      kursi.namauser = "__LOCK__" + ws.idtarget;
      kursi.lockTime = Date.now();
      kv.set(["seat", room, i], kursi);
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

// ===== Periodic Flush =====
setInterval(() => {
  try {
    flushChatBuffer();
    flushPrivateMessageBuffer();
    cleanExpiredLocks();
  } catch {}
}, 100);

// ===== Event Handlers =====
function handleSetIdTarget(ws: WebSocketWithRoom, id: string) {
  ws.idtarget = id;
  safeSend(ws, ["setIdTargetAck", ws.idtarget]);
}
function handlePing(ws: WebSocketWithRoom, pingId: string) {
  if (pingId && ws.idtarget === pingId) safeSend(ws, ["pong"]);
}
async function handleJoinRoom(ws: WebSocketWithRoom, newRoom: RoomName) {
  try { assertValidRoom(newRoom); } catch { return safeSend(ws, ["error", `Unknown room: ${newRoom}`]); }
  const foundSeat = lockSeat(newRoom, ws);
  if (foundSeat === null) return safeSend(ws, ["roomFull", newRoom]);

  ws.roomname = newRoom;
  ws.numkursi = new Set([foundSeat]);
  safeSend(ws, ["numberKursiSaya", foundSeat]);
  if (ws.idtarget) userToSeat.set(ws.idtarget, { room: newRoom, seat: foundSeat });

  const allSeats: any = {};
  for (const [seat, info] of roomSeats.get(newRoom)!) {
    if (info.namauser && !info.namauser.startsWith("__LOCK__")) {
      const { points, ...rest } = info;
      allSeats[seat] = rest;
    }
  }
  safeSend(ws, ["allUpdateKursiList", newRoom, allSeats]);
  broadcastRoomUserCount(newRoom);
}
function handleChat(ws: WebSocketWithRoom, roomname: RoomName, noImageURL: string, username: string, message: string, usernameColor: string, chatTextColor: string) {
  try { assertValidRoom(roomname); } catch { return; }
  const msg = ["chat", roomname, noImageURL, username, message, usernameColor, chatTextColor];
  if (!chatMessageBuffer.has(roomname)) chatMessageBuffer.set(roomname, []);
  chatMessageBuffer.get(roomname)!.push(msg);
  kv.set(["chat", roomname, Date.now()], msg);
}
function handleUpdateKursi(ws: WebSocketWithRoom, room: RoomName, seat: number, noimageUrl: string, namauser: string, color: string, itembawah: number, itematas: number, vip: boolean, viptanda: number) {
  try { assertValidRoom(room); } catch { return; }
  const seatInfo: SeatInfo = { noimageUrl, namauser, color, itembawah, itematas, vip, viptanda, points: [] };
  roomSeats.get(room)!.set(seat, seatInfo);
  broadcastRoomUserCount(room);
  kv.set(["seat", room, seat], seatInfo);
}
function handleRemoveKursi(ws: WebSocketWithRoom, room: RoomName, seat: number) {
  try { assertValidRoom(room); } catch { return; }
  resetSeat(roomSeats.get(room)!.get(seat)!);
  broadcastToRoom(room, ["removeKursi", room, seat]);
  broadcastRoomUserCount(room);
  kv.delete(["seat", room, seat]);
}
function handleSendNotif(ws: WebSocketWithRoom, idtarget: string, noimageUrl: string, username: string, deskripsi: string) {
  const notifData = ["notif", noimageUrl, username, deskripsi, Date.now()];
  kv.set(["notif", idtarget, Date.now()], notifData);
}
function handlePrivate(ws: WebSocketWithRoom, idt: string, url: string, msg: string, sender: string) {
  const data = ["private", idt, url, msg, Date.now(), sender];
  kv.set(["private", idt, Date.now()], data);
}
function handleIsUserOnline(ws: WebSocketWithRoom, target: string, tanda?: string) {
  const online = Array.from(clients).some(c => c.idtarget === target);
  safeSend(ws, ["userOnlineStatus", target, online, tanda ?? ""]);
}

// ===== Message Router =====
function handleMessage(ws: WebSocketWithRoom, dataStr: string) {
  try {
    const data = JSON.parse(dataStr);
    const [evt, ...args] = data;
    switch (evt) {
      case "setIdTarget": handleSetIdTarget(ws, ...args); break;
      case "ping": handlePing(ws, ...args); break;
      case "getAllRoomsUserCount": handleGetAllRoomsUserCount(ws); break;
      case "joinRoom": handleJoinRoom(ws, ...args); break;
      case "chat": handleChat(ws, ...args); break;
      case "updateKursi": handleUpdateKursi(ws, ...args); break;
      case "removeKursiAndPoint": handleRemoveKursi(ws, ...args); break;
      case "sendnotif": handleSendNotif(ws, ...args); break;
      case "private": handlePrivate(ws, ...args); break;
      case "isUserOnline": handleIsUserOnline(ws, ...args); break;
      default: safeSend(ws, ["error", "Unknown event"]);
    }
  } catch (err) {
    console.error("❌ Error parsing msg:", dataStr, err);
  }
}

// ===== KV Watch (sync antar server) =====
(async () => {
  for await (const ev of kv.watch([["chat"], ["seat"], ["private"], ["notif"]])) {
    for (const e of ev) {
      if (!e.value) continue;
      const [kind, roomOrId] = e.key as any;
      switch (kind) {
        case "chat": broadcastToRoom(roomOrId, e.value); break;
        case "seat": {
          const [_, room, seat] = e.key as [string, RoomName, number];
          roomSeats.get(room)!.set(seat, e.value);
          broadcastToRoom(room, ["kursiBatchUpdate", room, [[seat, e.value]]]);
          break;
        }
        case "private": {
          const [_, idt] = e.key as [string, string];
          for (const c of clients) if (c.idtarget === idt) safeSend(c, e.value);
          break;
        }
        case "notif": {
          const [_, idt] = e.key as [string, string];
          for (const c of clients) if (c.idtarget === idt) safeSend(c, e.value);
          break;
        }
      }
    }
  }
})();

// ===== Serve =====
serve((req) => {
  if (req.headers.get("upgrade")?.toLowerCase() !== "websocket") return new Response("Expected WebSocket", { status: 400 });
  const { socket, response } = Deno.upgradeWebSocket(req);
  const ws = socket as WebSocketWithRoom;
  clients.add(ws);
  ws.onopen = () => { ws.numkursi = new Set(); console.log("✅ Client connected"); };
  ws.onmessage = (ev) => handleMessage(ws, ev.data);
  ws.onclose = () => {
    try {
      if (ws.roomname && ws.numkursi) {
        for (const seat of ws.numkursi) {
          resetSeat(roomSeats.get(ws.roomname)!.get(seat)!);
          kv.delete(["seat", ws.roomname, seat]);
          broadcastToRoom(ws.roomname, ["removeKursi", ws.roomname, seat]);
        }
        broadcastRoomUserCount(ws.roomname);
      }
      cleanupBuffers(ws);
    } catch {}
    clients.delete(ws);
  };
  return response;
});
