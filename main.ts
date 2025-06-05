import { serve } from "https://deno.land/std@0.201.0/http/server.ts";

const roomList = [
  "UnityRoom",
  "HarmonyHub",
  "TogetherSpace",
  "OneWorldChat",
  "GlobalCircle",
  "ConnectNation",
  "FusionLounge",
  "PeaceTalks",
  "BridgeRoom",
  "CommonGround",
] as const;

type RoomName = typeof roomList[number];
const allRooms = new Set<RoomName>(roomList);

interface SeatInfo {
  noimageUrl: string;
  namauser: string;
  color: string;
  itembawah: number;
  itematas: number;
  vip: boolean;
  viptanda: number;
  points: Array<{ x: number; y: number; fast: boolean }>;
}

interface WebSocketWithRoom extends WebSocket {
  roomname?: RoomName;
  idtarget?: string;
  numkursi?: Set<number>;
}

const MAX_SEATS = 35;
const clients = new Set<WebSocketWithRoom>();

const roomSeats: Map<RoomName, Map<number, SeatInfo>> = new Map();
for (const room of allRooms) {
  const seatMap = new Map<number, SeatInfo>();
  for (let i = 1; i <= MAX_SEATS; i++) seatMap.set(i, createEmptySeat());
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

const FIFTEEN_MINUTES = 15 * 60 * 1000;
let currentNumber = 1;

setInterval(() => {
  for (const room of allRooms) broadcastToRoom(room, ["bgnumber", currentNumber]);
  currentNumber = currentNumber >= 6 ? 1 : currentNumber + 1;
}, FIFTEEN_MINUTES);

function resetSeat(info: SeatInfo) {
  Object.assign(info, createEmptySeat());
}

function broadcastToRoom(room: RoomName, msg: any[]) {
  for (const c of clients) if (c.roomname === room) c.send(JSON.stringify(msg));
}

function getJumlahRoom(): Record<RoomName, number> {
  const cnt = Object.fromEntries(roomList.map(room => [room, 0])) as Record<RoomName, number>;
  for (const c of clients) if (c.roomname && c.numkursi) cnt[c.roomname] += c.numkursi.size;
  return cnt;
}

function broadcastRoomUserCount(room: RoomName) {
  broadcastToRoom(room, ["roomUserCount", room, getJumlahRoom()[room] ?? 0]);
}

function handleGetAllRoomsUserCount(ws: WebSocketWithRoom) {
  const allCounts = getJumlahRoom();
  const result = roomList.map(room => [room, allCounts[room]]);
  ws.send(JSON.stringify(["allRoomsUserCount", result]));
}

const pointUpdateBuffer = new Map<RoomName, Map<number, Array<{ x: number; y: number; fast: boolean }>>>();
const updateKursiBuffer = new Map<RoomName, Map<number, SeatInfo>>();

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
    const updates = Array.from(seatMap.entries()).map(([seat, info]) => {
      const { points, ...rest } = info;
      return [seat, rest];
    });
    if (updates.length > 0) broadcastToRoom(room, ["kursiBatchUpdate", room, updates]);
    seatMap.clear();
  }
}

setInterval(() => {
  flushPointUpdates();
  flushKursiUpdates();
}, 100);

serve((req) => {
  const upgrade = req.headers.get("upgrade") || "";
  if (upgrade.toLowerCase() !== "websocket") return new Response("Expected websocket", { status: 400 });

  const { socket, response } = Deno.upgradeWebSocket(req);
  const ws = socket as WebSocketWithRoom;
  clients.add(ws);
  ws.numkursi = new Set<number>();

  ws.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data);
      if (!Array.isArray(data)) return;

      const evt = data[0];
      switch (evt) {
        case "setIdTarget": ws.idtarget = data[1]; ws.send(JSON.stringify(["setIdTargetAck", ws.idtarget])); break;
        case "private": {
          const [_, idt, url, msg, sender] = data;
          const ts = Date.now();
          const out = ["private", idt, url, msg, ts, sender];
          let sent = false;
          for (const c of clients) if (c.idtarget === idt) { c.send(JSON.stringify(out)); sent = true; }
          if (!sent && ws.idtarget) ws.send(JSON.stringify(["privateFailed", idt, "User not online"]));
          break;
        }
        case "isUserOnline": {
          const [_, target, tanda = ""] = data;
          const online = Array.from(clients).some(c => c.idtarget === target);
          ws.send(JSON.stringify(["userOnlineStatus", target, online, tanda]));
          break;
        }
        case "getAllRoomsUserCount": handleGetAllRoomsUserCount(ws); break;
        case "joinRoom": {
          const newRoom: RoomName = data[1];
          if (!allRooms.has(newRoom)) return ws.send(JSON.stringify(["error", `Unknown room: ${newRoom}`]));
          const seatMap = roomSeats.get(newRoom)!;
          const foundSeat = [...seatMap.entries()].find(([, v]) => !v.namauser)?.[0];
          if (!foundSeat) return ws.send(JSON.stringify(["roomFull", newRoom]));

          if (ws.roomname && ws.numkursi) {
            const oldRoom = ws.roomname;
            for (const seat of ws.numkursi) {
              resetSeat(roomSeats.get(oldRoom)!.get(seat)!);
              broadcastToRoom(oldRoom, ["removeKursi", oldRoom, seat]);
            }
            broadcastRoomUserCount(oldRoom);
          }

          ws.roomname = newRoom;
          ws.numkursi = new Set([foundSeat]);
          ws.send(JSON.stringify(["numberKursiSaya", foundSeat]));

          const allPoints: any[] = [];
          const meta: Record<number, Omit<SeatInfo, "points">> = {};
          for (const [seat, info] of seatMap) {
            for (const p of info.points) allPoints.push({ seat, ...p });
            if (info.namauser) {
              const { points, ...rest } = info;
              meta[seat] = rest;
            }
          }

          ws.send(JSON.stringify(["allPointsList", newRoom, allPoints]));
          ws.send(JSON.stringify(["allUpdateKursiList", newRoom, meta]));
          broadcastRoomUserCount(newRoom);
          break;
        }
        case "chat": {
          const [_, room, ...args] = data;
          if (!allRooms.has(room)) return ws.send(JSON.stringify(["error", "Invalid room for chat"]));
          broadcastToRoom(room, ["chat", room, ...args]);
          break;
        }
        case "notif": {
          const [_, idt, noimg, desc] = data;
          const ts = Date.now();
          let sent = false;
          for (const c of clients) if (c.idtarget === idt) { c.send(JSON.stringify(["notif", noimg, desc, ts])); sent = true; }
          if (!sent) ws.send(JSON.stringify(["notifFailed", idt, "User not online"]));
          break;
        }
        case "updatePoint": {
          const [_, room, seat, x, y, fast] = data;
          if (!allRooms.has(room)) return;
          const info = roomSeats.get(room)!.get(seat);
          if (!info) return;
          info.points.push({ x, y, fast });
          if (!pointUpdateBuffer.has(room)) pointUpdateBuffer.set(room, new Map());
          const roomBuf = pointUpdateBuffer.get(room)!;
          if (!roomBuf.has(seat)) roomBuf.set(seat, []);
          roomBuf.get(seat)!.push({ x, y, fast });
          break;
        }
        case "removeKursiAndPoint": {
          const [_, room, seat] = data;
          if (!allRooms.has(room)) return;
          resetSeat(roomSeats.get(room)!.get(seat)!);
          for (const c of clients) if (c.roomname === room) c.numkursi?.delete(seat);
          broadcastToRoom(room, ["removeKursi", room, seat]);
          broadcastRoomUserCount(room);
          break;
        }
        case "updateKursi": {
          const [_, room, seat, noimageUrl, namauser, color, itembawah, itematas, vip, viptanda] = data;
          if (!allRooms.has(room)) return;
          const info: SeatInfo = { noimageUrl, namauser, color, itembawah, itematas, vip: Boolean(vip), viptanda, points: [] };
          if (!updateKursiBuffer.has(room)) updateKursiBuffer.set(room, new Map());
          updateKursiBuffer.get(room)!.set(seat, info);
          roomSeats.get(room)!.set(seat, info);
          break;
        }
        case "resetRoom": {
          for (const room of allRooms) {
            const seatMap = roomSeats.get(room)!;
            for (let i = 1; i <= MAX_SEATS; i++) resetSeat(seatMap.get(i)!);
            broadcastToRoom(room, ["resetRoom", room]);
            broadcastRoomUserCount(room);
          }
          break;
        }
        default: ws.send(JSON.stringify(["error", "Unknown event type"]));
      }
    } catch {
      ws.send(JSON.stringify(["error", "Failed to parse message"]));
    }
  };

  ws.onclose = () => {
    if (ws.roomname && ws.numkursi) {
      const room = ws.roomname;
      for (const seat of ws.numkursi) {
        resetSeat(roomSeats.get(room)!.get(seat)!);
        broadcastToRoom(room, ["removeKursi", room, seat]);
      }
      broadcastRoomUserCount(room);
    }
    clients.delete(ws);
  };

  return response;
});
