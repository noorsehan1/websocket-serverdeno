import { serve } from "https://deno.land/std@0.201.0/http/server.ts";

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

// Mapping user ↔ seat
const userToSeat: Map<string, { room: RoomName; seat: number }> = new Map();

// Mapping room ↔ seat info
const roomSeats: Map<RoomName, Map<number, SeatInfo>> = new Map();
for (const room of allRooms) {
  const seatMap = new Map<number, SeatInfo>();
  for (let i = 1; i <= MAX_SEATS; i++) {
    seatMap.set(i, createEmptySeat());
  }
  roomSeats.set(room, seatMap);
}

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

function resetSeat(info: SeatInfo) {
  Object.assign(info, createEmptySeat());
}

function broadcastToRoom(room: RoomName, msg: any[]) {
  for (const c of clients) {
    if (c.roomname === room) {
      try {
        c.send(JSON.stringify(msg));
      } catch {}
    }
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
  const result: Array<[RoomName, number]> = roomList.map(r => [r, allCounts[r]]);
  try { ws.send(JSON.stringify(["allRoomsUserCount", result])); } catch {}
}

// Buffers
const pointUpdateBuffer = new Map<RoomName, Map<number, Array<{ x: number; y: number; fast: number }>>>();
const updateKursiBuffer = new Map<RoomName, Map<number, SeatInfo>>();
const chatMessageBuffer = new Map<RoomName, Array<any>>();
const privateMessageBuffer = new Map<string, Array<any>>();

function flushPrivateMessageBuffer() {
  for (const [idtarget, messages] of privateMessageBuffer) {
    for (const c of clients) {
      if (c.idtarget === idtarget) {
        for (const msg of messages) {
          try { c.send(JSON.stringify(msg)); } catch {}
        }
      }
    }
    messages.length = 0;
  }
}

function flushChatBuffer() {
  for (const [room, messages] of chatMessageBuffer) {
    for (const msg of messages) broadcastToRoom(room, msg);
    messages.length = 0;
  }
}

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
    if (updates.length) broadcastToRoom(room, ["kursiBatchUpdate", room, updates]);
    seatMap.clear();
  }
}

// Number broadcast
let currentNumber = 1;
const maxNumber = 6;
const intervalMillis = 15 * 60 * 1000;

setInterval(() => {
  currentNumber = currentNumber < maxNumber ? currentNumber + 1 : 1;
  for (const c of clients) {
    try { c.send(JSON.stringify(["currentNumber", currentNumber])); } catch {}
  }
}, intervalMillis);

// Periodic flush
setInterval(() => {
  try {
    flushPointUpdates();
    flushKursiUpdates();
    flushChatBuffer();
    flushPrivateMessageBuffer();
    cleanExpiredLocks();
  } catch (err) { console.error("Error in periodic flush:", err); }
}, 100);

function cleanExpiredLocks() {
  const now = Date.now();
  for (const room of allRooms) {
    const seatMap = roomSeats.get(room)!;
    for (const [seat, info] of seatMap) {
      if (info.namauser.startsWith("__LOCK__") && info.lockTime && (now - info.lockTime > 10000)) {
        console.log("⏱ Kursi lock expired:", room, seat);
        resetSeat(info);
        broadcastToRoom(room, ["removeKursi", room, seat]);
        broadcastRoomUserCount(room);
      }
    }
  }
}

// Main WebSocket server
serve((req) => {
  const upgrade = req.headers.get("upgrade") || "";
  if (upgrade.toLowerCase() !== "websocket") return new Response("Expected websocket", { status: 400 });

  const { socket, response } = Deno.upgradeWebSocket(req);
  const ws = socket as WebSocketWithRoom;
  clients.add(ws);

  ws.onopen = () => { ws.numkursi = new Set(); console.log("Client connected"); };

  ws.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data);
      if (!Array.isArray(data) || data.length === 0) return ws.send(JSON.stringify(["error", "Invalid message format"]));
      const evt = data[0];

      switch(evt) {
        case "setIdTarget": ws.idtarget = data[1]; ws.send(JSON.stringify(["setIdTargetAck", ws.idtarget])); break;
        case "ping": if (data[1] && ws.idtarget === data[1]) ws.send(JSON.stringify(["pong"])); break;
        case "sendnotif": {
          const [_, idtarget, noimageUrl, username, deskripsi] = data;
          for (const c of clients) if (c.idtarget === idtarget) try { c.send(JSON.stringify(["notif", noimageUrl, username, deskripsi, Date.now()])); } catch {}
          break;
        }
        case "private": {
          const [_, idt, url, msg, sender] = data;
          const ts = Date.now();
          const out = ["private", idt, url, msg, ts, sender];
          try { ws.send(JSON.stringify(out)); } catch {}
          if (!privateMessageBuffer.has(idt)) privateMessageBuffer.set(idt, []);
          privateMessageBuffer.get(idt)!.push(out);
          break;
        }
        case "isUserOnline": {
          const target = data[1]; const tanda = data[2] ?? "";
          const online = Array.from(clients).some(c => c.idtarget === target);
          ws.send(JSON.stringify(["userOnlineStatus", target, online, tanda]));
          break;
        }
        case "getAllRoomsUserCount": handleGetAllRoomsUserCount(ws); break;
        case "getCurrentNumber": ws.send(JSON.stringify(["currentNumber", currentNumber])); break;
        case "joinRoom": joinRoomHandler(ws, data[1]); break;
        case "chat": chatHandler(ws, data); break;
        case "updatePoint": updatePointHandler(data); break;
        case "removeKursiAndPoint": removeKursiHandler(data); break;
        case "updateKursi": updateKursiHandler(data); break;
      }
    } catch (err) { console.error("Error handling message:", err); }
  };

  ws.onclose = () => {
    try {
      console.log("❌ User disconnected:", ws.idtarget ?? "(unknown)");
      const room = ws.roomname; const kursis = ws.numkursi;
      if (room && kursis && roomSeats.has(room)) {
        const seatMap = roomSeats.get(room)!;
        for (const seat of kursis) { resetSeat(seatMap.get(seat)!); broadcastToRoom(room, ["removeKursi", room, seat]); }
        if (ws.idtarget && userToSeat.has(ws.idtarget)) userToSeat.delete(ws.idtarget);
        broadcastRoomUserCount(room);
      }
      clients.delete(ws);
      ws.numkursi?.clear();
      ws.roomname = undefined;
    } catch (err) { console.error("❗ Error on close:", err); }
  };

  return response;
});

// --- Handlers ---
function joinRoomHandler(ws: WebSocketWithRoom, newRoom: RoomName) {
  if (!allRooms.has(newRoom)) return ws.send(JSON.stringify(["error", `Unknown room: ${newRoom}`]));
  const seatMap = roomSeats.get(newRoom)!;
  let foundSeat: number | null = null;

  if (ws.idtarget && userToSeat.has(ws.idtarget)) {
    const prev = userToSeat.get(ws.idtarget)!;
    if (prev.room === newRoom) {
      const seatInfo = seatMap.get(prev.seat)!;
      if (seatInfo.namauser === "") foundSeat = prev.seat;
    }
  }

  if (foundSeat === null && ws.idtarget) {
    for (let i = 1; i <= MAX_SEATS; i++) {
      const kursi = seatMap.get(i)!;
      if (kursi.namauser === "") { kursi.namauser = "__LOCK__" + ws.idtarget; kursi.lockTime = Date.now(); foundSeat = i; break; }
    }
  }

  if (foundSeat === null) return ws.send(JSON.stringify(["roomFull", newRoom]));

  const kursiFinal = seatMap.get(foundSeat)!;
  if (!kursiFinal.namauser.startsWith("__LOCK__")) return ws.send(JSON.stringify(["roomFull", newRoom]));

  if (ws.roomname && ws.numkursi) {
    for (const seat of ws.numkursi) resetSeat(roomSeats.get(ws.roomname)!.get(seat)!);
    ws.numkursi.clear();
  }

  ws.roomname = newRoom;
  ws.numkursi = new Set([foundSeat]);
  if (ws.idtarget) userToSeat.set(ws.idtarget, { room: newRoom, seat: foundSeat });

  kursiFinal.namauser = ws.idtarget ?? "Guest";
  broadcastToRoom(newRoom, ["addKursi", newRoom, foundSeat, { ...kursiFinal }]);
  broadcastRoomUserCount(newRoom);
}

function chatHandler(ws: WebSocketWithRoom, data: any[]) {
  if (!ws.roomname) return;
  const msg = data[1]; const url = data[2]; const username = data[3]; const ts = Date.now();
  const out = ["chat", ws.roomname, msg, url, username, ts];
  if (!chatMessageBuffer.has(ws.roomname)) chatMessageBuffer.set(ws.roomname, []);
  chatMessageBuffer.get(ws.roomname)!.push(out);
}

function updatePointHandler(data: any[]) {
  const [_, room, seat, x, y, fast] = data;
  if (!pointUpdateBuffer.has(room)) pointUpdateBuffer.set(room, new Map());
  const seatMap = pointUpdateBuffer.get(room)!;
  if (!seatMap.has(seat)) seatMap.set(seat, []);
  seatMap.get(seat)!.push({ x, y, fast });
}

function removeKursiHandler(data: any[]) {
  const [_, room, seat] = data;
  const seatMap = roomSeats.get(room)!;
  resetSeat(seatMap.get(seat)!);
  broadcastToRoom(room, ["removeKursi", room, seat]);
  broadcastRoomUserCount(room);
}

function updateKursiHandler(data: any[]) {
  const [_, room, seat, info] = data;
  const seatMap = roomSeats.get(room)!;
  const targetSeat = seatMap.get(seat)!;
  Object.assign(targetSeat, info);
  if (!updateKursiBuffer.has(room)) updateKursiBuffer.set(room, new Map());
  updateKursiBuffer.get(room)!.set(seat, targetSeat);
}
