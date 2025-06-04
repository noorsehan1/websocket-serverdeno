import { serve } from "https://deno.land/std@0.201.0/http/server.ts";

interface SeatInfo {
  noimageUrl: string;
  namauser: string;
  color: string;
  itembawah: number;
  itematas: number;
  vip: boolean;
  viptanda: number;
  points: Array<{ x: number; y: number; fast: boolean; timestamp: number }>;
}

interface WebSocketWithRoom extends WebSocket {
  roomname?: RoomName;
  idtarget?: string;
  numkursi?: Set<number>;
}

type RoomName = "room1" | "room2" | "room3" | "room4" | "room5";

const allRooms = new Set<RoomName>(["room1", "room2", "room3", "room4", "room5"]);
const MAX_SEATS = 35;
const clients = new Set<WebSocketWithRoom>();

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
    if (c.roomname === room) c.send(JSON.stringify(msg));
  }
}

function getJumlahRoom(): Record<RoomName, number> {
  const cnt = { room1: 0, room2: 0, room3: 0, room4: 0, room5: 0 };
  for (const c of clients) {
    if (c.roomname && c.numkursi) cnt[c.roomname] += c.numkursi.size;
  }
  return cnt;
}

function broadcastRoomUserCount(room: RoomName) {
  const count = getJumlahRoom()[room] || 0;
  broadcastToRoom(room, ["roomUserCount", room, count]);
}

function getAllNumKursiInRoom(room: RoomName): number[] {
  return Array.from(roomSeats.get(room)!.entries())
    .filter(([, info]) => info.namauser !== "")
    .map(([seat]) => seat)
    .sort((a, b) => a - b);
}

function handleGetAllRoomsUserCount(ws: WebSocketWithRoom) {
  ws.send(JSON.stringify(["allRoomsUserCount", getJumlahRoom()]));
}

serve((req) => {
  const upgrade = req.headers.get("upgrade") || "";
  if (upgrade.toLowerCase() !== "websocket") {
    return new Response("Expected websocket", { status: 400 });
  }

  const { socket, response } = Deno.upgradeWebSocket(req);
  const ws = socket as WebSocketWithRoom;
  clients.add(ws);

  ws.onopen = () => {
    ws.numkursi = new Set<number>();
    console.log("Client connected");
  };

  ws.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data);
      if (!Array.isArray(data) || data.length === 0) {
        ws.send(JSON.stringify(["error", "Invalid message format"]));
        return;
      }

      const evt = data[0];

      case "private": {
  const [_, idt, url, msg, sender] = data;
  const ts = Date.now();
  const out = ["private", idt, url, msg, ts, sender];

  let sent = false;
  for (const c of clients) {
    if (c.idtarget === idt) {
      c.send(JSON.stringify(out));
      sent = true;
    }
  }
  if (!sent && ws.idtarget) {
    ws.send(JSON.stringify(["privateFailed", idt, "User not online"]));
  }
  break;
}

        case "isUserOnline": {
          const target = data[1];
          const online = Array.from(clients).some(c => c.idtarget === target);
          ws.send(JSON.stringify(["userOnlineStatus", target, online]));
          break;
        }
        case "joinRoom": {
          const newRoom = data[1];
          if (!allRooms.has(newRoom)) {
            ws.send(JSON.stringify(["error", `Unknown room: ${newRoom}`]));
            break;
          }
          if (ws.roomname && ws.numkursi) {
            for (const s of ws.numkursi) {
              const info = roomSeats.get(ws.roomname)!.get(s)!;
              resetSeat(info);
            }
            broadcastToRoom(ws.roomname, ["userDisconnected", ws.roomname, ...ws.numkursi]);
            broadcastRoomUserCount(ws.roomname);
            broadcastToRoom(ws.roomname, ["numKursiList", ws.roomname, getAllNumKursiInRoom(ws.roomname)]);
          }
          ws.roomname = newRoom;
          ws.numkursi = new Set<number>();
          broadcastRoomUserCount(newRoom);
          ws.send(JSON.stringify(["numKursiList", newRoom, getAllNumKursiInRoom(newRoom)]));
          break;
        }
        case "updateKursi": {
          const [, room, seat, url, user, color, bot, top, vip, vt] = data;
          if (!allRooms.has(room)) {
            ws.send(JSON.stringify(["error", `Unknown room: ${room}`]));
            break;
          }
          ws.roomname = room;
          ws.numkursi!.add(seat);
          const info = roomSeats.get(room)!.get(seat)!;
          Object.assign(info, { noimageUrl: url, namauser: user, color, itembawah: bot, itematas: top, vip, viptanda: vt });
          broadcastToRoom(room, data);
          broadcastRoomUserCount(room);
          broadcastToRoom(room, ["numKursiList", room, getAllNumKursiInRoom(room)]);
          break;
        }
        case "removeKursi": {
          const [, room, seat] = data;
          if (!allRooms.has(room)) {
            ws.send(JSON.stringify(["error", `Unknown room: ${room}`]));
            break;
          }
          ws.numkursi!.delete(seat);
          const info = roomSeats.get(room)!.get(seat)!;
          resetSeat(info);
          broadcastToRoom(room, data);
          broadcastRoomUserCount(room);
          broadcastToRoom(room, ["numKursiList", room, getAllNumKursiInRoom(room)]);
          break;
        }
        case "chat":
        case "pointUpdate": {
          broadcastToRoom(data[1], data);
          break;
        }
        case "getAllRoomsUserCount": {
          handleGetAllRoomsUserCount(ws);
          break;
        }
        case "getAllPoints": {
          const room = data[1];
          const allPoints: any[] = [];
          for (const [seat, info] of roomSeats.get(room)!) {
            for (const p of info.points) {
              allPoints.push({ seat, ...p });
            }
          }
          ws.send(JSON.stringify(["allPointsList", room, allPoints]));
          break;
        }
        case "getAllUpdateKursi": {
          const room = data[1];
          const meta: Record<number, Omit<SeatInfo, "points">> = {};
          for (const [seat, info] of roomSeats.get(room)!) {
            if (info.namauser) {
              const { points, ...rest } = info;
              meta[seat] = rest;
            }
          }
          ws.send(JSON.stringify(["allUpdateKursiList", room, meta]));
          break;
        }
        default:
          ws.send(JSON.stringify(["error", "Unknown event type"]));
      }
    } catch {
      ws.send(JSON.stringify(["error", "Failed to parse message"]));
    }
  };

  ws.onclose = () => {
    if (ws.roomname && ws.numkursi) {
      for (const s of ws.numkursi) {
        const info = roomSeats.get(ws.roomname)!.get(s)!;
        resetSeat(info);
      }
      broadcastToRoom(ws.roomname, ["userDisconnected", ws.roomname, ...ws.numkursi]);
      broadcastRoomUserCount(ws.roomname);
      broadcastToRoom(ws.roomname, ["numKursiList", ws.roomname, getAllNumKursiInRoom(ws.roomname)]);
    }
    clients.delete(ws);
  };

  return response;
});
