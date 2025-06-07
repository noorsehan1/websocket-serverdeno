import { serve } from "https://deno.land/std@0.201.0/http/server.ts";

// Daftar room
const roomList = ["room1", "room2", "room3", "room4", "room5"] as const;
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
  points: Array<{ x: number; y: number; fast: boolean }>;
}

interface WebSocketWithRoom extends WebSocket {
  roomname?: RoomName;
  idtarget?: string;
  numkursi?: Set<number>;
}

// Initialize seat maps per room
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
  const cnt = Object.fromEntries(roomList.map(room => [room, 0])) as Record<RoomName, number>;
  for (const c of clients) {
    if (c.roomname && c.numkursi) cnt[c.roomname] += c.numkursi.size;
  }
  return cnt;
}

function broadcastRoomUserCount(room: RoomName) {
  const count = getJumlahRoom()[room] || 0;
  broadcastToRoom(room, ["roomUserCount", room, count]);
}

function handleGetAllRoomsUserCount(ws: WebSocketWithRoom) {
  const allCounts = getJumlahRoom();
  const result: Array<[RoomName, number]> = roomList.map(room => [room, allCounts[room]]);
  ws.send(JSON.stringify(["allRoomsUserCount", result]));
}

// Buffer untuk update points dan kursi
const pointUpdateBuffer: Map<RoomName, Map<number, Array<{ x: number; y: number; fast: boolean }>>> = new Map();
const updateKursiBuffer: Map<RoomName, Map<number, SeatInfo>> = new Map();

// Queue tambahan untuk update kursi dan chat
const kursiUpdateQueue: Array<{ room: RoomName; seat: number; info: SeatInfo }> = [];
const chatMessageQueue: Array<{ room: RoomName; message: any[] }> = [];

// Function flush point updates
function flushPointUpdates() {
  for (const [room, seatMap] of pointUpdateBuffer) {
    for (const [seat, points] of seatMap) {
      for (const p of points) {
        broadcastToRoom(room, ["pointUpdated", room, seat, p.x, p.y, p.fast]);
      }
      points.length = 0;
    }
  }
}

// Function flush kursi updates
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

// Timer 15 menit untuk update nomor
let currentNumber = 1;
const maxNumber = 6;
const intervalMillis = 15 * 60 * 1000;

function getCurrentNumber() {
  return currentNumber;
}

function broadcastNumber(num: number) {
  for (const c of clients) {
    c.send(JSON.stringify(["currentNumber", num]));
  }
}

setInterval(() => {
  currentNumber = currentNumber < maxNumber ? currentNumber + 1 : 1;
  broadcastNumber(currentNumber);
}, intervalMillis);

// Timer 100 ms untuk proses queue
setInterval(() => {
  // Proses update kursi dari queue
  for (const { room, seat, info } of kursiUpdateQueue) {
    // Update map utama
    roomSeats.get(room)!.set(seat, info);
    // Update buffer broadcast
    if (!updateKursiBuffer.has(room)) {
      updateKursiBuffer.set(room, new Map());
    }
    updateKursiBuffer.get(room)!.set(seat, info);
  }
  kursiUpdateQueue.length = 0;

  // Proses chat dari queue
  for (const { room, message } of chatMessageQueue) {
    broadcastToRoom(room, message);
  }
  chatMessageQueue.length = 0;

  // Flush buffer lainnya
  flushPointUpdates();
  flushKursiUpdates();
}, 100);

// Server WebSocket
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
        case "setIdTarget":
          ws.idtarget = data[1];
          ws.send(JSON.stringify(["setIdTargetAck", ws.idtarget]));
          break;

        case "ping": {
          const pingId = data[1];
          if (pingId && ws.idtarget === pingId) {
            ws.send(JSON.stringify(["pong"]));
          }
          break;
        }

        case "sendnotif": {
          const [_, idtarget, noimageUrl, username, deskripsi] = data;
          const notifData = ["notif", noimageUrl, username, deskripsi, Date.now()];
          for (const c of clients) {
            if (c.idtarget === idtarget) c.send(JSON.stringify(notifData));
          }
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
          const tanda = data[2] ?? "";
          const online = Array.from(clients).some(c => c.idtarget === target);
          ws.send(JSON.stringify(["userOnlineStatus", target, online, tanda]));
          break;
        }

        case "getAllRoomsUserCount":
          handleGetAllRoomsUserCount(ws);
          break;

        case "getCurrentNumber":
          ws.send(JSON.stringify(["currentNumber", getCurrentNumber()]));
          break;

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
              broadcastToRoom(oldRoom, ["removeKursi", oldRoom, s]);
            }
            broadcastRoomUserCount(ws.roomname);
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
          const [_, roomname, noImageURL, username, message, usernameColor, chatTextColor] = data;
          if (!roomname || !allRooms.has(roomname)) {
            ws.send(JSON.stringify(["error", "Invalid room for chat"]));
            break;
          }
          // Enqueue chat message
          chatMessageQueue.push({ room: roomname, message: data });
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

        case "removeKursiAndPoint": {
          const [_, room, seat] = data;
          if (!allRooms.has(room)) {
            ws.send(JSON.stringify(["error", `Unknown room: ${room}`]));
            break;
          }

          resetSeat(roomSeats.get(room)!.get(seat)!);
          for (const client of clients) {
            client.numkursi?.delete(seat);
          }

          broadcastToRoom(room, ["removeKursi", room, seat]);
          broadcastRoomUserCount(room);
          break;
        }

        case "updateKursi": {
          const [_, room, seat, noimageUrl, namauser, color, itembawah, itematas, vip, viptanda] = data;
          if (!allRooms.has(room)) {
            ws.send(JSON.stringify(["error", `Unknown room: ${room}`]));
            break;
          }

          const seatInfo: SeatInfo = {
            noimageUrl,
            namauser,
            color,
            itembawah,
            itematas,
            vip: Boolean(vip),
            viptanda,
            points: [],
          };

          // Enqueue update kursi
          kursiUpdateQueue.push({ room, seat, info: seatInfo });
          break;
        }

        case "resetRoom": {
          for (const room of allRooms) {
            const seatMap = roomSeats.get(room)!;
            for (let i = 1; i <= MAX_SEATS; i++) {
              resetSeat(seatMap.get(i)!);
            }
            broadcastToRoom(room, ["resetRoom", room]);
            broadcastRoomUserCount(room);
          }
          break;
        }
      }
    } catch {
      ws.send(JSON.stringify(["error", "Failed to parse message"]));
    }
  };

  ws.onclose = () => {
    if (ws.roomname && ws.numkursi) {
      for (const s of ws.numkursi) {
        resetSeat(roomSeats.get(ws.roomname)!.get(s)!);
        broadcastToRoom(ws.roomname, ["removeKursi", ws.roomname, s]);
      }
      broadcastRoomUserCount(ws.roomname);
    }
    clients.delete(ws);
  };

  return response;
});