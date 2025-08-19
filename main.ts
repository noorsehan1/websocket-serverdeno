// main.ts — realtime chatroom dengan Deno KV + local cache
// deno-lint-ignore-file no-explicit-any
import { serve } from "https://deno.land/std@0.201.0/http/server.ts";

////////////////////////////////////////////////////////////////////////////////
// CONFIG
////////////////////////////////////////////////////////////////////////////////
const kv = await Deno.openKv();
const INSTANCE_ID = crypto.randomUUID();

////////////////////////////////////////////////////////////////////////////////
// Types & Constants
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
  "The Chatter Room",
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
// Utilities
////////////////////////////////////////////////////////////////////////////////
function createEmptySeat(): SeatInfo {
  return { noimageUrl: "", namauser: "", color: "", itembawah: 0, itematas: 0, vip: false, viptanda: 0, points: [] };
}
function safeSend(ws: WebSocketWithRoom, msg: any) {
  try {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
    else clients.delete(ws);
  } catch {
    try { ws.close(); } catch {}
    clients.delete(ws);
  }
}
function broadcastToRoom(room: RoomName, msg: any) {
  for (const c of [...clients]) if (c.roomname === room) safeSend(c, msg);
}
function broadcastToUser(idtarget: string, msg: any) {
  for (const c of [...clients]) if (c.idtarget === idtarget) safeSend(c, msg);
}
function assertValidRoom(room: any): room is RoomName {
  if (!allRooms.has(room)) throw new Error("Unknown room: " + room);
  return true;
}

////////////////////////////////////////////////////////////////////////////////
// Local cache
////////////////////////////////////////////////////////////////////////////////
const userToSeat: Map<string, { room: RoomName; seat: number }> = new Map();
const roomSeats: Map<RoomName, Map<number, SeatInfo>> = new Map();
for (const r of allRooms) {
  const m = new Map<number, SeatInfo>();
  for (let i = 1; i <= MAX_SEATS; i++) m.set(i, createEmptySeat());
  roomSeats.set(r, m);
}

////////////////////////////////////////////////////////////////////////////////
// KV helpers
////////////////////////////////////////////////////////////////////////////////
async function kvSetSeat(room: RoomName, seat: number, info: SeatInfo) {
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
  await kv.set(["room", room, "chat", Date.now(), crypto.randomUUID()], { origin: INSTANCE_ID, payload: chatSnap });
}
async function kvSetPrivate(idt: string, data: any) {
  await kv.set(["private", idt, Date.now(), crypto.randomUUID()], { origin: INSTANCE_ID, payload: data });
}
async function kvSetNotif(idt: string, data: any) {
  await kv.set(["notif", idt, Date.now(), crypto.randomUUID()], { origin: INSTANCE_ID, payload: data });
}

////////////////////////////////////////////////////////////////////////////////
// Buffers & Broadcast helpers
////////////////////////////////////////////////////////////////////////////////
const pointUpdateBuffer: Map<RoomName, Map<number, Array<{ x: number; y: number; fast: number }>>> = new Map();
const updateKursiBuffer: Map<RoomName, Map<number, SeatInfo>> = new Map();
const chatMessageBuffer: Map<RoomName, Array<any>> = new Map();
const privateMessageBuffer: Map<string, Array<any>> = new Map();

function getJumlahRoom(): Record<RoomName, number> {
  const cnt = Object.fromEntries(roomList.map(r => [r, 0])) as Record<RoomName, number>;
  for (const room of allRooms) {
    let c = 0;
    for (const info of roomSeats.get(room)!.values()) {
      if (info.namauser && !info.namauser.startsWith("__LOCK__")) c++;
    }
    cnt[room] = c;
  }
  return cnt;
}
async function broadcastRoomUserCount(room: RoomName) {
  const allCounts = getJumlahRoom();
  broadcastToRoom(room, ["roomUserCount", room, allCounts[room]]);
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
// Handlers
////////////////////////////////////////////////////////////////////////////////
async function handleJoinRoom(ws: WebSocketWithRoom, newRoom: RoomName) {
  try { assertValidRoom(newRoom); } catch { return safeSend(ws, ["error", `Unknown room: ${newRoom}`]); }

  if (!ws.idtarget) return safeSend(ws, ["error", "no idtarget"]);

  // cari kursi kosong
  let foundSeat: number | null = null;
  const seatMap = roomSeats.get(newRoom)!;
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

  // clear kursi lama
  if (ws.roomname && ws.numkursi) {
    for (const s of ws.numkursi) {
      roomSeats.get(ws.roomname)!.set(s, createEmptySeat());
      await kvDeleteSeat(ws.roomname, s);
      broadcastToRoom(ws.roomname, ["removeKursiAndPoint", ws.roomname, s]);
    }
    await broadcastRoomUserCount(ws.roomname);
  }

  ws.roomname = newRoom;
  ws.numkursi = new Set([foundSeat]);
  safeSend(ws, ["numberKursiSaya", foundSeat]);

  if (ws.idtarget) userToSeat.set(ws.idtarget, { room: newRoom, seat: foundSeat });

  await broadcastRoomUserCount(newRoom);
}

async function handleUpdatePoint(ws: WebSocketWithRoom, room: RoomName, seat: number, x: number, y: number, fast: number) {
  try { assertValidRoom(room); } catch { return; }
  const si = roomSeats.get(room)!.get(seat);
  if (!si) return;
  si.points.push({ x, y, fast });
  roomSeats.get(room)!.set(seat, si);
  await kvSetSeatPoint(room, seat, { x, y, fast });
  if (!pointUpdateBuffer.has(room)) pointUpdateBuffer.set(room, new Map());
  if (!pointUpdateBuffer.get(room)!.has(seat)) pointUpdateBuffer.get(room)!.set(seat, []);
  pointUpdateBuffer.get(room)!.get(seat)!.push({ x, y, fast });
}

async function handleRemoveKursi(ws: WebSocketWithRoom, room: RoomName, seat: number) {
  try { assertValidRoom(room); } catch { return; }
  roomSeats.get(room)!.set(seat, createEmptySeat());
  await kvDeleteSeat(room, seat);
  broadcastToRoom(room, ["removeKursiAndPoint", room, seat]);
  await broadcastRoomUserCount(room);
}

async function handleUpdateKursi(ws: WebSocketWithRoom, room: RoomName, seat: number, noimageUrl: string, namauser: string, color: string, itembawah: number, itematas: number, vip: boolean, viptanda: number) {
  try { assertValidRoom(room); } catch { return; }
  const seatInfo: SeatInfo = { noimageUrl, namauser, color, itembawah, itematas, vip, viptanda, points: [] };
  roomSeats.get(room)!.set(seat, seatInfo);
  if (!updateKursiBuffer.has(room)) updateKursiBuffer.set(room, new Map());
  updateKursiBuffer.get(room)!.set(seat, seatInfo);
  await kvSetSeat(room, seat, seatInfo);
  await broadcastRoomUserCount(room);
}

async function handleSendNotif(ws: WebSocketWithRoom, idtarget: string, noimageUrl: string, username: string, deskripsi: string) {
  const notifData = ["notif", noimageUrl, username, deskripsi, Date.now()];
  await kvSetNotif(idtarget, notifData);
  for (const c of [...clients]) if (c.idtarget === idtarget) safeSend(c, notifData);
}

async function handlePrivate(ws: WebSocketWithRoom, idt: string, url: string, msg: string, sender: string) {
  const ts = Date.now();
  const out = ["private", idt, url, msg, ts, sender];
  await kvSetPrivate(idt, out);
  safeSend(ws, out);
  for (const c of clients) if (c.idtarget === idt) safeSend(c, out);
  if (!privateMessageBuffer.has(idt)) privateMessageBuffer.set(idt, []);
  privateMessageBuffer.get(idt)!.push(out);
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
      case "setIdTarget": ws.idtarget = args[0]; safeSend(ws, ["setIdTargetAck", ws.idtarget]); break;
      case "ping": if (args[0] && ws.idtarget === args[0]) safeSend(ws, ["pong"]); break;
      case "getAllRoomsUserCount": safeSend(ws, ["allRoomsUserCount", Object.entries(getJumlahRoom())]); break;
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

////////////////////////////////////////////////////////////////////////////////
// WATCHERS (multi-instance sync) — sama seperti sebelumnya
////////////////////////////////////////////////////////////////////////////////
// ... (watchers tetap sama, tidak saya ubah demi singkat)

////////////////////////////////////////////////////////////////////////////////
// Current number
////////////////////////////////////////////////////////////////////////////////
let currentNumber = 1;
const maxNumber = 6;
setInterval(() => {
  currentNumber = currentNumber < maxNumber ? currentNumber + 1 : 1;
  for (const c of [...clients]) safeSend(c, ["currentNumber", currentNumber]);
}, 15 * 60 * 1000);

////////////////////////////////////////////////////////////////////////////////
// WebSocket server
////////////////////////////////////////////////////////////////////////////////
serve((req) => {
  try {
    const upgrade = req.headers.get("upgrade") || "";
    if (upgrade.toLowerCase() !== "websocket") return new Response("Expected websocket", { status: 400 });

    const { socket, response } = Deno.upgradeWebSocket(req);
    const ws = socket as WebSocketWithRoom;
    clients.add(ws);

    ws.onopen = () => { ws.numkursi = new Set<number>(); };
    ws.onmessage = (ev) => { handleMessage(ws, ev.data); };
    ws.onclose = async () => {
      if (ws.roomname && ws.numkursi) {
        for (const seat of ws.numkursi) {
          roomSeats.get(ws.roomname)!.set(seat, createEmptySeat());
          await kvDeleteSeat(ws.roomname, seat);
          broadcastToRoom(ws.roomname, ["removeKursiAndPoint", ws.roomname, seat]);
        }
        await broadcastRoomUserCount(ws.roomname);
      }
      if (ws.idtarget) userToSeat.delete(ws.idtarget);
      clients.delete(ws);
    };

    return response;
  } catch (err) {
    return new Response("Failed to upgrade websocket", { status: 500 });
  }
});
