import { serve } from "https://deno.land/std@0.201.0/http/server.ts";

/**
 * Detail kursi termasuk metadata dan history points
 */
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
  roomname?: string;
  idtarget?: string;
  numkursi?: Set<number>;
}

const clients = new Set<WebSocketWithRoom>();

// Daftar room statis
type RoomName = "room1" | "room2" | "room3" | "room4" | "room5";
const allRooms = new Set<RoomName>([
  "room1",
  "room2",
  "room3",
  "room4",
  "room5",
]);

// Maksimal kursi per room
const MAX_SEATS = 35;

// Inisialisasi state: setiap room punya map seat→SeatInfo
const roomSeats: Map<RoomName, Map<number, SeatInfo>> = new Map();
for (const room of allRooms) {
  const seatMap = new Map<number, SeatInfo>();
  for (let i = 1; i <= MAX_SEATS; i++) {
    seatMap.set(i, {
      noimageUrl: "",
      namauser: "",
      color: "",
      itembawah: 0,
      itematas: 0,
      vip: false,
      viptanda: 0,
      points: [],
    });
  }
  roomSeats.set(room, seatMap);
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
      const data = JSON.parse(event.data) as any[];
      if (!Array.isArray(data) || data.length === 0) {
        ws.send(JSON.stringify(["error", "Invalid message format"]));
        return;
      }
      const evt = data[0] as string;

      switch (evt) {
        // ---- Private chat setup ----
        case "setIdTarget": {
          const id = data[1] as string;
          ws.idtarget = id;
          ws.send(JSON.stringify(["setIdTargetAck", id]));
          break;
        }
        case "private": {
          const idt = data[1] as string;
          const url = data[2];
          const msg = data[3];
          const sender = data[4] as boolean;
          const ts = Date.now();
          const out = ["private", url, msg, ts, sender];
          let sent = false;
          for (const c of clients) {
            if (c.idtarget === idt) {
              c.send(JSON.stringify(out));
              sent = true;
              break;
            }
          }
          if (!sent && ws.idtarget) {
            ws.send(JSON.stringify(["privateFailed", idt, "User not online"]));
          }
          break;
        }

        // ---- Online status check ----
        case "isUserOnline": {
          const target = data[1] as string;
          const online = Array.from(clients).some(c => c.idtarget === target);
          ws.send(JSON.stringify(["userOnlineStatus", target, online]));
          break;
        }

        // ---- Room joining / leaving ----
        case "joinRoom": {
          const newRoom = data[1] as RoomName;
          if (!allRooms.has(newRoom)) {
            ws.send(JSON.stringify(["error", `Unknown room: ${newRoom}`]));
            break;
          }
          if (ws.roomname && ws.numkursi) {
            // reset semua kursi yang dipegang client ini
            for (const s of ws.numkursi) {
              const info = roomSeats.get(ws.roomname)!.get(s)!;
              Object.assign(info, {
                noimageUrl: "",
                namauser: "",
                color: "",
                itembawah: 0,
                itematas: 0,
                vip: false,
                viptanda: 0,
                points: [],
              });
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

        // ---- Update / remove kursi ----
        case "updateKursi": {
          const [, room, seat, url, user, color, bot, top, vip, vt] = data;
          if (!allRooms.has(room)) {
            ws.send(JSON.stringify(["error", `Unknown room: ${room}`]));
            break;
          }
          ws.roomname = room;
          ws.numkursi!.add(seat as number);
          const info = roomSeats.get(room)!.get(seat as number)!;
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
          ws.numkursi!.delete(seat as number);
          const info = roomSeats.get(room)!.get(seat as number)!;
          Object.assign(info, { noimageUrl: "", namauser: "", color: "", itembawah: 0, itematas: 0, vip: false, viptanda: 0, points: [] });
          broadcastToRoom(room, data);
          broadcastRoomUserCount(room);
          broadcastToRoom(room, ["numKursiList", room, getAllNumKursiInRoom(room)]);
          break;
        }

        // ---- Chat & pointer ----
        case "chat":
        case "pointUpdate": {
          broadcastToRoom(data[1] as string, data);
          break;
        }

        // ---- Queries ----
        case "getAllRoomsUserCount": {
          handleGetAllRoomsUserCount(ws);
          break;
        }
        case "getAllPoints": {
          const room = data[1] as RoomName;
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
          const room = data[1] as RoomName;
          const meta: Record<number, Omit<SeatInfo, "points">> = {};
          for (const [seat, info] of roomSeats.get(room)!) {
            if (info.namauser) {
              const { points, ...m } = info;
              meta[seat] = m;
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
        const info = roomSeats.get(ws.roomname!)!.get(s)!;
        Object.assign(info, { noimageUrl: "", namauser: "", color: "", itembawah: 0, itematas: 0, vip: false, viptanda: 0, points: [] });
      }
      broadcastToRoom(ws.roomname, ["userDisconnected", ws.roomname, ...ws.numkursi]);
      broadcastRoomUserCount(ws.roomname);
      broadcastToRoom(ws.roomname, ["numKursiList", ws.roomname, getAllNumKursiInRoom(ws.roomname)]);
    }
    clients.delete(ws);
  };

  return response;
});

function broadcastToRoom(room: string, msg: any[]) {
  for (const c of clients) {
    if (c.roomname === room) c.send(JSON.stringify(msg));
  }
}

function getJumlahRoom(): Record<string, number> {
  const cnt: Record<string, number> = {};
  for (const r of allRooms) cnt[r] = 0;
  for (const c of clients) {
    if (c.roomname && c.numkursi) cnt[c.roomname] += c.numkursi.size;
  }
  return cnt;
}

function broadcastRoomUserCount(room: string) {
  const count = getJumlahRoom()[room] || 0;
  const msg = ["roomUserCount", room, count];
  broadcastToRoom(room, msg);
}

function getAllNumKursiInRoom(room: string): number[] {
  return Array
    .from(roomSeats.get(room)!.keys())
    .filter(s => roomSeats.get(room)!.get(s)!.namauser !== "")
    .sort((a, b) => a - b);
}

function handleGetAllRoomsUserCount(ws: WebSocketWithRoom) {
  ws.send(JSON.stringify(["allRoomsUserCount", getJumlahRoom()]));
}
