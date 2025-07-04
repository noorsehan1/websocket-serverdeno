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

const userToSeat: Map<string, { room: RoomName; seat: number }> = new Map();

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
  const cnt = Object.fromEntries(roomList.map(room => [room, 0])) as Record<RoomName, number>;
  for (const room of allRooms) {
    const seatMap = roomSeats.get(room)!;
    for (const info of seatMap.values()) {
      if (info.namauser && !info.namauser.startsWith("__LOCK__")) {
        cnt[room]++;
      }
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
  const result: Array<[RoomName, number]> = roomList.map(room => [room, allCounts[room]]);
  try {
    ws.send(JSON.stringify(["allRoomsUserCount", result]));
  } catch {}
}

const pointUpdateBuffer: Map<RoomName, Map<number, Array<{ x: number; y: number; fast: number }>>> = new Map();
const updateKursiBuffer: Map<RoomName, Map<number, SeatInfo>> = new Map();
const chatMessageBuffer: Map<RoomName, Array<any>> = new Map();
const privateMessageBuffer: Map<string, Array<any>> = new Map();

function flushPrivateMessageBuffer() {
  for (const [idtarget, messages] of privateMessageBuffer) {
    for (const c of clients) {
      if (c.idtarget === idtarget) {
        for (const msg of messages) {
          try {
            c.send(JSON.stringify(msg));
          } catch {}
        }
      }
    }
    messages.length = 0;
  }
}

function flushChatBuffer() {
  for (const [room, messages] of chatMessageBuffer) {
    for (const msg of messages) {
      broadcastToRoom(room, msg);
    }
    messages.length = 0;
  }
}

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

let currentNumber = 1;
const maxNumber = 6;
const intervalMillis = 15 * 60 * 1000;

function getCurrentNumber() {
  return currentNumber;
}

function broadcastNumber(num: number) {
  for (const c of clients) {
    try {
      c.send(JSON.stringify(["currentNumber", num]));
    } catch {}
  }
}

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

setInterval(() => {
  currentNumber = currentNumber < maxNumber ? currentNumber + 1 : 1;
  broadcastNumber(currentNumber);
}, intervalMillis);

setInterval(() => {
  try {
    flushPointUpdates();
    flushKursiUpdates();
    flushChatBuffer();
    flushPrivateMessageBuffer();
    cleanExpiredLocks();
  } catch (err) {
    console.error("Error in periodic flush:", err);
  }
}, 100);

serve((req) => {
  try {
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
              if (c.idtarget === idtarget) {
                try {
                  c.send(JSON.stringify(notifData));
                } catch {}
              }
            }
            break;
          }

          case "private": {
            const [_, idt, url, msg, sender] = data;
            const ts = Date.now();
            const out = ["private", idt, url, msg, ts, sender];
            try {
              ws.send(JSON.stringify(out));
            } catch {}
            if (!privateMessageBuffer.has(idt)) {
              privateMessageBuffer.set(idt, []);
            }
            privateMessageBuffer.get(idt)!.push(out);
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

            // Pastikan user sudah punya kursi di room itu
            if (ws.idtarget && userToSeat.has(ws.idtarget)) {
              const prev = userToSeat.get(ws.idtarget)!;
              if (prev.room === newRoom) {
                const seatInfo = seatMap.get(prev.seat)!;
                if (seatInfo.namauser === "") {
                  foundSeat = prev.seat;
                }
              }
            }

            // Cari kursi kosong dan lock
            if (foundSeat === null && ws.idtarget) {
              for (let i = 1; i <= MAX_SEATS; i++) {
                const kursi = seatMap.get(i)!;
                if (kursi.namauser === "") {
                  // Lock kursi
                  kursi.namauser = "__LOCK__" + ws.idtarget;
                  kursi.lockTime = Date.now();
                  foundSeat = i;
                  break;
                }
              }
            }

            // Kalau tidak dapat kursi
            if (foundSeat === null) {
              ws.send(JSON.stringify(["roomFull", newRoom]));
              break;
            }

            const kursiFinal = seatMap.get(foundSeat)!;
            if (!kursiFinal.namauser.startsWith("__LOCK__")) {
              ws.send(JSON.stringify(["roomFull", newRoom]));
              break;
            }

            // Bersihkan kursi lama
            if (ws.roomname && ws.numkursi) {
              const oldRoom = ws.roomname;
              for (const s of ws.numkursi) {
                resetSeat(roomSeats.get(oldRoom)!.get(s)!);
                broadcastToRoom(oldRoom, ["removeKursi", oldRoom, s]);
              }
              broadcastRoomUserCount(oldRoom);
            }

            ws.roomname = newRoom;
            ws.numkursi = new Set([foundSeat]);
            ws.send(JSON.stringify(["numberKursiSaya", foundSeat]));

            // Simpan user ↔ kursi
            if (ws.idtarget) {
              userToSeat.set(ws.idtarget, { room: newRoom, seat: foundSeat });
            }

            // Kirim kursi dan poin
            const allPoints: any[] = [];
            const meta: Record<number, Omit<SeatInfo, "points">> = {};
            for (const [seat, info] of seatMap) {
              for (const p of info.points) allPoints.push({ seat, ...p });
              if (info.namauser && !info.namauser.startsWith("__LOCK__")) {
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
            if (!chatMessageBuffer.has(roomname)) {
              chatMessageBuffer.set(roomname, []);
            }
            chatMessageBuffer.get(roomname)!.push(["chat", roomname, noImageURL, username, message, usernameColor, chatTextColor]);
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
              vip,
              viptanda,
              points: [],
            };

            if (!updateKursiBuffer.has(room)) {
              updateKursiBuffer.set(room, new Map());
            }
            updateKursiBuffer.get(room)!.set(seat, seatInfo);
            roomSeats.get(room)!.set(seat, seatInfo);

            broadcastRoomUserCount(room);
            break;
          }
        }
      } catch (err) {
        console.error("Error handling message:", err);
      }
    };

    ws.onclose = () => {
      try {
        console.log("❌ User disconnected:", ws.idtarget ?? "(unknown)");
        const room = ws.roomname;
        const kursis = ws.numkursi;

        if (room && kursis && roomSeats.has(room)) {
          const seatMap = roomSeats.get(room)!;

          for (const seat of kursis) {
            if (seatMap.has(seat)) {
              resetSeat(seatMap.get(seat)!);
              broadcastToRoom(room, ["removeKursi", room, seat]);
            }
          }

          if (ws.idtarget && userToSeat.has(ws.idtarget)) {
            const prev = userToSeat.get(ws.idtarget)!;
            if (prev.room === room && kursis.has(prev.seat)) {
              userToSeat.delete(ws.idtarget);
            }
          }

          broadcastRoomUserCount(room);
        }

        clients.delete(ws);
        ws.numkursi?.clear();
        ws.roomname = undefined;
      } catch (err) {
        console.error("❗ Error on close:", err);
      }
    };

    return response;
  } catch (err) {
    console.error("WebSocket upgrade error:", err);
    return new Response("Failed to upgrade websocket", { status: 500 });
  }
});