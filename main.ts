// main.ts — realtime only (no old data replay)
// deno-lint-ignore-file no-explicit-any
import { serve } from "https://deno.land/std@0.201.0/http/server.ts";

////////////////////////////////////////////////////////////////////////////////
// CONFIG
////////////////////////////////////////////////////////////////////////////////
const kv = await Deno.openKv(); // default KV
const INSTANCE_ID = crypto.randomUUID(); // to avoid double-broadcast from our own writes
const START_TIME = Date.now(); // filter old KV events

////////////////////////////////////////////////////////////////////////////////
// Types & Constants
////////////////////////////////////////////////////////////////////////////////
const roomList = [
  "Chill Zone","Catch Up","Casual Vibes","Lounge Talk","Easy Talk",
  "Friendly Corner","The Hangout","Relax & Chat","Just Chillin","The Chatter Room",
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
// Local cache (fast)
////////////////////////////////////////////////////////////////////////////////
const userToSeat: Map<string, { room: RoomName; seat: number }> = new Map();
const roomSeats: Map<RoomName, Map<number, SeatInfo>> = new Map();
for (const r of allRooms) {
  const m = new Map<number, SeatInfo>();
  for (let i = 1; i <= MAX_SEATS; i++) m.set(i, createEmptySeat());
  roomSeats.set(r, m);
}

////////////////////////////////////////////////////////////////////////////////
// KV wrapper helpers
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
// User count helpers
////////////////////////////////////////////////////////////////////////////////
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

////////////////////////////////////////////////////////////////////////////////
// Event Handlers (realtime only)
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
  if (!ws.idtarget) return safeSend(ws, ["error", "no idtarget"]);

  // find empty seat only, no restore from old
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

  // clear previous seats
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

  await broadcastRoomUserCount(newRoom);
}

async function handleChat(ws: WebSocketWithRoom, roomname: RoomName, noImageURL: string, username: string, message: string, usernameColor: string, chatTextColor: string) {
  try { assertValidRoom(roomname); } catch { return safeSend(ws, ["error", "Invalid room for chat"]); }
  const chatSnap = ["chat", roomname, noImageURL, username, message, usernameColor, chatTextColor] as const;
  await kvSetChat(roomname, chatSnap);
  broadcastToRoom(roomname, chatSnap); // langsung realtime
}

async function handleUpdatePoint(ws: WebSocketWithRoom, room: RoomName, seat: number, x: number, y: number, fast: number) {
  try { assertValidRoom(room); } catch { return safeSend(ws, ["error", `Unknown room: ${room}`]); }
  if (typeof x !== "number" || typeof y !== "number" || typeof fast !== "number") return;
  const si = roomSeats.get(room)!.get(seat);
  if (!si) return;
  si.points.push({ x, y, fast });
  roomSeats.get(room)!.set(seat, si);
  await kvSetSeatPoint(room, seat, { x, y, fast });
  broadcastToRoom(room, ["pointUpdated", room, seat, x, y, fast]);
}

async function handleRemoveKursi(ws: WebSocketWithRoom, room: RoomName, seat: number) {
  try { assertValidRoom(room); } catch { return safeSend(ws, ["error", `Unknown room: ${room}`]); }
  roomSeats.get(room)!.set(seat, createEmptySeat());
  await kvDeleteSeat(room, seat);
  broadcastToRoom(room, ["removeKursi", room, seat]);
  await broadcastRoomUserCount(room);
}

async function handleUpdateKursi(ws: WebSocketWithRoom, room: RoomName, seat: number, noimageUrl: string, namauser: string, color: string, itembawah: number, itematas: number, vip: boolean, viptanda: number) {
  try { assertValidRoom(room); } catch { return safeSend(ws, ["error", `Unknown room: ${room}`]); }
  const seatInfo: SeatInfo = { noimageUrl, namauser, color, itembawah, itematas, vip, viptanda, points: [] };
  roomSeats.get(room)!.set(seat, seatInfo);
  await kvSetSeat(room, seat, seatInfo);
  await broadcastRoomUserCount(room);
}

async function handleSendNotif(ws: WebSocketWithRoom, idtarget: string, noimageUrl: string, username: string, deskripsi: string) {
  const notifData = ["notif", noimageUrl, username, deskripsi, Date.now()];
  await kvSetNotif(idtarget, notifData);
  broadcastToUser(idtarget, notifData);
}

async function handlePrivate(ws: WebSocketWithRoom, idt: string, url: string, msg: string, sender: string) {
  const ts = Date.now();
  const out = ["private", idt, url, msg, ts, sender];
  await kvSetPrivate(idt, out);
  safeSend(ws, out);
  broadcastToUser(idt, out);
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
// KV Watcher (only new events)
////////////////////////////////////////////////////////////////////////////////
;(async () => {
  try {
    for await (const events of kv.watch([["room"], ["private"], ["notif"]])) {
      for (const e of events) {
        if (e.versionstamp && parseInt(e.versionstamp.substring(0, 10), 16) < START_TIME) continue;
        const key = e.key as Array<string | number>;
        const val = e.value as any;
        if (!val || val.origin === INSTANCE_ID) continue;

        if (key[0] === "room" && key[2] === "chat") {
          broadcastToRoom(key[1] as RoomName, val.payload);
        }
        if (key[0] === "room" && key[2] === "seat" && typeof key[3] === "number") {
          roomSeats.get(key[1] as RoomName)!.set(key[3] as number, (val.seat ?? val) as SeatInfo);
          await broadcastRoomUserCount(key[1] as RoomName);
        }
        if (key[0] === "room" && key[2] === "seat" && key[4] === "lastPoint") {
          const p = val.p;
          broadcastToRoom(key[1] as RoomName, ["pointUpdated", key[1], key[3], p.x, p.y, p.fast]);
        }
        if (key[0] === "private") broadcastToUser(key[1] as string, val.payload);
        if (key[0] === "notif") broadcastToUser(key[1] as string, val.payload);
      }
    }
  } catch (err) {
    console.error("KV.watch error:", err);
  }
})();

////////////////////////////////////////////////////////////////////////////////
// Current number interval
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
  const upgrade = req.headers.get("upgrade") || "";
  if (upgrade.toLowerCase() !== "websocket") return new Response("Expected websocket", { status: 400 });
  const { socket, response } = Deno.upgradeWebSocket(req);
  const ws = socket as WebSocketWithRoom;
  clients.add(ws);

  ws.onopen = () => { ws.numkursi = new Set<number>(); console.log("Client connected"); };
  ws.onmessage = (ev) => { handleMessage(ws, ev.data); };
  ws.onclose = async () => {
    try {
      if (ws.roomname && ws.numkursi) {
        for (const seat of ws.numkursi) {
          roomSeats.get(ws.roomname)!.set(seat, createEmptySeat());
          await kvDeleteSeat(ws.roomname, seat);
          broadcastToRoom(ws.roomname, ["removeKursi", ws.roomname, seat]);
        }
        await broadcastRoomUserCount(ws.roomname);
      }
      if (ws.idtarget) await kvSetUserToSeat(ws.idtarget, null);
    } catch (err) {
      console.error("Error on close:", err);
    } finally {
      clients.delete(ws);
      ws.numkursi?.clear();
      ws.roomname = undefined;
    }
  };
  return response;
});
