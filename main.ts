import { serve } from "https://deno.land/std@0.201.0/http/server.ts";

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
  const allCounts = getJumlahRoom();
  for (const room in allCounts) {
    ws.send(JSON.stringify(["allRoomsUserCount", room, allCounts[room as RoomName]]));
  }
}

// ========== BAGIAN BARU UNTUK BATCHING updatePoint ==========
// Buffer untuk batch updatePoint: Map<room, Map<seat, Array<Point>>>
const pointUpdateBuffer: Map<
  RoomName,
  Map<
    number, // seat
    Array<{ x: number; y: number; fast: boolean }>
  >
> = new Map();

function flushPointUpdates() {
  for (const [room, seatMap] of pointUpdateBuffer) {
    for (const [seat, points] of seatMap) {
      if (points.length > 0) {
        // Kirim setiap point sebagai event terpisah (bisa dikembangkan jadi bulk jika perlu)
        for (const p of points) {
          broadcastToRoom(room, [
            "pointUpdated",
            room,
            seat,
            p.x,
            p.y,
            p.fast,
          ]);
        }
        points.length = 0; // reset buffer
      }
    }
  }
}

// Interval flush tiap 100ms
setInterval(flushPointUpdates, 100);
// ==============================================================

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
      switch (evt) {
        case "setIdTarget": {
          ws.idtarget = data[1];
          ws.send(JSON.stringify(["setIdTargetAck", ws.idtarget]));
          break;
        }

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

        case "getAllRoomsUserCount": {
          handleGetAllRoomsUserCount(ws);
          break;
        }

        case "joinRoom": {
          const newRoom: RoomName = data[1];
          if (!allRooms.has(newRoom)) {
            ws.send(JSON.stringify(["error", `Unknown room: ${newRoom}`]));
            break;
          }

          const seatMap = roomSeats.get(newRoom)!;
          let foundSeat: number | null = null;
          for (let i = 1; i <= MAX_SEATS; i++) {
            if (seatMap.get(i)!.namauser === "") {
              foundSeat = i;
              break;
            }
          }

          if (foundSeat === null) {
            ws.send(JSON.stringify(["roomFull", newRoom]));
            break;
          }

          if (ws.roomname && ws.numkursi) {
            for (const s of ws.numkursi) {
              const oldRoom = ws.roomname!;
              resetSeat(roomSeats.get(oldRoom)!.get(s)!);
              broadcastToRoom(oldRoom, ["removePoint", oldRoom, s]);
              broadcastToRoom(oldRoom, ["removeKursi", oldRoom, s]);
            }
            broadcastRoomUserCount(ws.roomname);
            broadcastToRoom(ws.roomname, ["numKursiList", ws.roomname, getAllNumKursiInRoom(ws.roomname)]);
          }

          ws.roomname = newRoom;
          ws.numkursi = new Set([foundSeat]);
          seatMap.set(foundSeat, { noimageUrl: "", namauser: "tempuser", color: "", itembawah: 0, itematas: 0, vip: false, viptanda: 0, points: [] });

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
          broadcastToRoom(newRoom, ["numKursiList", newRoom, getAllNumKursiInRoom(newRoom)]);
          break;
        }

        case "chat": {
          const [_, roomname, noImageURL, username, message, usernameColor, chatTextColor] = data;

          if (!roomname || !allRooms.has(roomname)) {
            ws.send(JSON.stringify(["error", "Invalid room for chat"]));
            break;
          }

          const out = ["chat", roomname, noImageURL, username, message, usernameColor, chatTextColor];
          broadcastToRoom(roomname, out);
          break;
        }

        case "updatePoint": {
          const [_, room, seat, x, y, fast] = data;
          if (!allRooms.has(room)) {
            ws.send(JSON.stringify(["error", `Unknown room: ${room}`]));
            break;
          }
          const seatMap = roomSeats.get(room)!;
          const seatInfo = seatMap.get(seat);
          if (!seatInfo) break;

          seatInfo.points.push({ x, y, fast });

          // Tambahkan ke batch buffer, jangan langsung broadcast
          if (!pointUpdateBuffer.has(room)) {
            pointUpdateBuffer.set(room, new Map());
          }
          const roomBuffer = pointUpdateBuffer.get(room)!;
          if (!roomBuffer.has(seat)) {
            roomBuffer.set(seat, []);
          }
          roomBuffer.get(seat)!.push({ x, y, fast });

          break;
        }

        case "updateKursi": {
          const [_, room, seat, noimageUrl, namauser, color, itembawah, itematas, vip, viptanda] = data;
          if (!allRooms.has(room)) {
            ws.send(JSON.stringify(["error", `Unknown room: ${room}`]));
            break;
          }
          const seatMap = roomSeats.get(room)!;
          const seatInfo = seatMap.get(seat);
          if (!seatInfo) break;

          seatInfo.noimageUrl = noimageUrl;
          seatInfo.namauser = namauser;
          seatInfo.color = color;
          seatInfo.itembawah = itembawah;
          seatInfo.itematas = itematas;
          seatInfo.vip = vip;
          seatInfo.viptanda = viptanda;

          broadcastToRoom(room, ["kursiUpdated", room, seat, noimageUrl, namauser, color, itembawah, itematas, vip, viptanda]);
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
        const room = ws.roomname!;
        resetSeat(roomSeats.get(room)!.get(s)!);
        broadcastToRoom(room, ["removePoint", room, s]);
        broadcastToRoom(room, ["removeKursi", room, s]);
      }
      broadcastRoomUserCount(ws.roomname);
      broadcastToRoom(ws.roomname, ["numKursiList", ws.roomname, getAllNumKursiInRoom(ws.roomname)]);
    }
    clients.delete(ws);
  };

  return response;
});
