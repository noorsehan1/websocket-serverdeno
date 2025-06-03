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
  // history point updates per seat
  points: Array<{ x: number; y: number; fast: boolean; timestamp: number }>;
}

interface WebSocketWithRoom extends WebSocket {
  roomname?: string;
  idtarget?: string;
  numkursi?: Set<number>;
}

const clients = new Set<WebSocketWithRoom>();

// Daftar room statis, bisa ganti sesuai kebutuhan
type RoomName = "room1" | "room2" | "room3" | "room4" | "room5";
const allRooms = new Set<string>([
  "room1",
  "room2",
  "room3",
  "room4",
  "room5",
]);

// Konfigurasi jumlah maksimal kursi per room
const MAX_SEATS = 35;

// State kursi per room: setiap room memiliki Map<seatNumber, SeatInfo>
const roomSeats: Map<string, Map<number, SeatInfo>> = new Map();
for (const room of allRooms) {
  const seatMap = new Map<number, SeatInfo>();
  for (let num = 1; num <= MAX_SEATS; num++) {
    seatMap.set(num, {
      noimageUrl: "",
      namauser: "",
      color: "",
      itembawah: 0,
      itematas: 0,
      vip: false,
      viptanda: 0,
      points: []
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
      const eventType = data[0] as string;

      switch (eventType) {
        case "setIdTarget": {
          const userid = data[1] as string;
          ws.idtarget = userid;
          ws.send(JSON.stringify(["setIdTargetAck", userid]));
          break;
        }

        case "joinRoom": {
          const newRoom = data[1] as string;
          if (!allRooms.has(newRoom)) {
            ws.send(JSON.stringify(["error", `Unknown room: ${newRoom}`]));
            break;
          }
          if (ws.roomname && ws.numkursi) {
            for (const k of ws.numkursi) {
              const info = roomSeats.get(ws.roomname)!.get(k)!;
              // reset to default
              info.noimageUrl = "";
              info.namauser   = "";
              info.color      = "";
              info.itembawah  = 0;
              info.itematas   = 0;
              info.vip        = false;
              info.viptanda   = 0;
              info.points     = [];
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
          const [_, roomname, kursi, noimageUrl, namauser, color, itembawah, itematas, vip, viptanda] = data;
          if (!allRooms.has(roomname)) {
            ws.send(JSON.stringify(["error", `Unknown room: ${roomname}`]));
            break;
          }
          ws.roomname = roomname;
          ws.numkursi!.add(kursi);
          const info = roomSeats.get(roomname)!.get(kursi)!;
          info.noimageUrl = noimageUrl;
          info.namauser   = namauser;
          info.color      = color;
          info.itembawah  = itembawah;
          info.itematas   = itematas;
          info.vip        = vip;
          info.viptanda   = viptanda;

          broadcastToRoom(roomname, data);
          broadcastRoomUserCount(roomname);
          broadcastToRoom(roomname, ["numKursiList", roomname, getAllNumKursiInRoom(roomname)]);
          break;
        }

        case "removeKursi": {
          const [_, roomname, kursi] = data;
          if (!allRooms.has(roomname)) {
            ws.send(JSON.stringify(["error", `Unknown room: ${roomname}`]));
            break;
          }
          if (ws.roomname === roomname) ws.numkursi!.delete(kursi);
          const info = roomSeats.get(roomname)!.get(kursi)!;
          info.noimageUrl = "";
          info.namauser   = "";
          info.color      = "";
          info.itembawah  = 0;
          info.itematas   = 0;
          info.vip        = false;
          info.viptanda   = 0;
          info.points     = [];

          broadcastToRoom(roomname, data);
          broadcastRoomUserCount(roomname);
          broadcastToRoom(roomname, ["numKursiList", roomname, getAllNumKursiInRoom(roomname)]);
          break;
        }

        case "pointUpdate": {
          const [_, roomname, kursi, x, y, fast] = data;
          const info = roomSeats.get(roomname)!.get(kursi)!;
          info.points.push({ x, y, fast, timestamp: Date.now() });
          broadcastToRoom(roomname, data);
          break;
        }

        case "getAllRoomsUserCount": {
          handleGetAllRoomsUserCount(ws);
          break;
        }

        case "getAllPoints": {
          const roomname = data[1] as string;
          const allPoints: Array<any> = [];
          for (const [seat, info] of roomSeats.get(roomname)!) {
            for (const p of info.points) {
              allPoints.push({ seat, ...p });
            }
          }
          ws.send(JSON.stringify(["allPointsList", roomname, allPoints]));
          break;
        }

        case "getAllUpdateKursi": {
          const roomname = data[1] as string;
          const metaObj: Record<string, any> = {};
          for (const [seat, info] of roomSeats.get(roomname)!) {
            const { points, ...meta } = info;
            metaObj[seat] = meta;
          }
          ws.send(JSON.stringify(["allUpdateKursiList", roomname, metaObj]));
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
      for (const k of ws.numkursi) {
        const info = roomSeats.get(ws.roomname)!.get(k)!;
        info.noimageUrl = "";
        info.namauser   = "";
        info.color      = "";
        info.itembawah  = 0;
        info.itematas   = 0;
        info.vip        = false;
        info.viptanda   = 0;
        info.points     = [];
      }
      broadcastToRoom(ws.roomname, ["userDisconnected", ws.roomname, ...ws.numkursi]);
      broadcastRoomUserCount(ws.roomname);
      broadcastToRoom(ws.roomname, ["numKursiList", ws.roomname, getAllNumKursiInRoom(ws.roomname)]);
    }
    clients.delete(ws);
  };

  return response;
});

function broadcastToRoom(roomname: string, message: any[]) {
  for (const client of clients) {
    if (client.roomname === roomname) {
      client.send(JSON.stringify(message));
    }
  }
}

function getJumlahRoom(): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const room of allRooms) counts[room] = 0;
  for (const client of clients) {
    if (client.roomname && client.numkursi) {
      counts[client.roomname] += client.numkursi.size;
    }
  }
  return counts;
}

function broadcastRoomUserCount(roomname: string) {
  const count = getJumlahRoom()[roomname] || 0;
  const msg = ["roomUserCount", roomname, count];
  for (const client of clients) {
    if (client.roomname === roomname) {
      client.send(JSON.stringify(msg));
    }
  }
}

function getAllNumKursiInRoom(roomname: string): number[] {
  return Array.from(roomSeats.get(roomname)!.keys())
    .filter(seat => {
      const info = roomSeats.get(roomname)!.get(seat)!;
      return info.namauser !== "";
    })
    .sort((a, b) => a - b);
}

function handleGetAllRoomsUserCount(ws: WebSocketWithRoom) {
  const counts = getJumlahRoom();
  ws.send(JSON.stringify(["allRoomsUserCount", counts]));
}
