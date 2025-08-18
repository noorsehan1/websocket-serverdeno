// main.ts — Deno Deploy WebSocket server lengkap

const roomList = [
  "Chill Zone","Catch Up","Casual Vibes","Lounge Talk","Easy Talk",
  "Friendly Corner","The Hangout","Relax & Chat","Just Chillin","The Chatter Room"
] as const;
type RoomName = typeof roomList[number];
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
const allRooms = new Set<RoomName>(roomList);
const userToSeat: Map<string, { room: RoomName; seat: number }> = new Map();
const roomSeats: Map<RoomName, Map<number, SeatInfo>> = new Map();

for (const room of allRooms) {
  const seatMap = new Map<number, SeatInfo>();
  for (let i = 1; i <= MAX_SEATS; i++) seatMap.set(i, createEmptySeat());
  roomSeats.set(room, seatMap);
}

function createEmptySeat(): SeatInfo {
  return { noimageUrl: "", namauser: "", color: "", itembawah: 0, itematas: 0, vip: false, viptanda: 0, points: [] };
}

function resetSeat(info: SeatInfo) { Object.assign(info, createEmptySeat()); }

function broadcastToRoom(room: RoomName, msg: any[]) {
  for (const c of clients) if (c.roomname === room) try { c.send(JSON.stringify(msg)); } catch {}
}

function getJumlahRoom(): Record<RoomName, number> {
  const cnt = Object.fromEntries(roomList.map(r => [r, 0])) as Record<RoomName, number>;
  for (const room of allRooms) {
    const seatMap = roomSeats.get(room)!;
    for (const info of seatMap.values()) if (info.namauser && !info.namauser.startsWith("__LOCK__")) cnt[room]++;
  }
  return cnt;
}

function broadcastRoomUserCount(room: RoomName) { broadcastToRoom(room, ["roomUserCount", room, getJumlahRoom()[room] || 0]); }

function handleGetAllRoomsUserCount(ws: WebSocketWithRoom) {
  const result: Array<[RoomName, number]> = roomList.map(r => [r, getJumlahRoom()[r]]);
  try { ws.send(JSON.stringify(["allRoomsUserCount", result])); } catch {}
}

const pointUpdateBuffer: Map<RoomName, Map<number, Array<{ x: number; y: number; fast: number }>>> = new Map();
const updateKursiBuffer: Map<RoomName, Map<number, SeatInfo>> = new Map();
const chatMessageBuffer: Map<RoomName, Array<any>> = new Map();
const privateMessageBuffer: Map<string, Array<any>> = new Map();

function flushPrivateMessageBuffer() {
  for (const [idtarget, messages] of privateMessageBuffer) {
    for (const c of clients) if (c.idtarget === idtarget) for (const msg of messages) try { c.send(JSON.stringify(msg)); } catch {}
    messages.length = 0;
  }
}

function flushChatBuffer() { for (const [room, messages] of chatMessageBuffer) { for (const msg of messages) broadcastToRoom(room, msg); messages.length = 0; } }

function flushPointUpdates() { for (const [room, seatMap] of pointUpdateBuffer) for (const [seat, points] of seatMap) { for (const p of points) broadcastToRoom(room, ["pointUpdated", room, seat, p.x, p.y, p.fast]); points.length = 0; } }

function flushKursiUpdates() { for (const [room, seatMap] of updateKursiBuffer) { const updates: Array<[number, Omit<SeatInfo,"points">]> = []; for (const [seat, info] of seatMap) { const { points, ...rest } = info; updates.push([seat, rest]); } if (updates.length) broadcastToRoom(room, ["kursiBatchUpdate", room, updates]); seatMap.clear(); } }

let currentNumber = 1;
const maxNumber = 6;
const intervalMillis = 15*60*1000;

function getCurrentNumber() { return currentNumber; }
function broadcastNumber(num: number) { for (const c of clients) try { c.send(JSON.stringify(["currentNumber", num])); } catch {} }

function cleanExpiredLocks() {
  const now = Date.now();
  for (const room of allRooms) {
    const seatMap = roomSeats.get(room)!;
    for (const [seat, info] of seatMap) if (info.namauser.startsWith("__LOCK__") && info.lockTime && (now - info.lockTime > 10000)) { resetSeat(info); broadcastToRoom(room, ["removeKursi", room, seat]); broadcastRoomUserCount(room); }
  }
}

setInterval(() => { currentNumber = currentNumber < maxNumber ? currentNumber+1:1; broadcastNumber(currentNumber); }, intervalMillis);
setInterval(() => { try { flushPointUpdates(); flushKursiUpdates(); flushChatBuffer(); flushPrivateMessageBuffer(); cleanExpiredLocks(); } catch {} }, 100);

addEventListener("fetch", (event) => {
  const req = event.request;
  const upgrade = req.headers.get("upgrade") || "";
  if (upgrade.toLowerCase()!=="websocket") return event.respondWith(new Response("Expected websocket",{status:400}));

  try {
    const { socket, response } = Deno.upgradeWebSocket(req);
    const ws = socket as WebSocketWithRoom;
    clients.add(ws);
    ws.numkursi = new Set<number>();

    ws.addEventListener("message", (ev) => {
      try {
        const data = JSON.parse(typeof ev.data==="string"?ev.data:String(ev.data));
        if (!Array.isArray(data)||!data.length) return;
        const evt = data[0];
        switch(evt){
          case "setIdTarget": ws.idtarget=data[1]; try{ws.send(JSON.stringify(["setIdTargetAck", ws.idtarget]));}catch{}; break;
          case "ping": { const pingId=data[1]; if(pingId&&ws.idtarget===pingId) try{ws.send(JSON.stringify(["pong"]));}catch{}; break;}
          case "sendnotif": { const [_,idtarget,noimageUrl,username,deskripsi]=data; const notif=["notif",noimageUrl,username,deskripsi,Date.now()]; for(const c of clients) if(c.idtarget===idtarget) try{c.send(JSON.stringify(notif));}catch{}; break;}
          case "private": { const [_,idt,url,msg,sender]=data; const out=["private",idt,url,msg,Date.now(),sender]; try{ws.send(JSON.stringify(out));}catch{}; if(!privateMessageBuffer.has(idt)) privateMessageBuffer.set(idt,[]); privateMessageBuffer.get(idt)!.push(out); break;}
          case "isUserOnline": { const [_,target,tanda]=data; const online=Array.from(clients).some(c=>c.idtarget===target); try{ws.send(JSON.stringify(["userOnlineStatus",target,online,tanda??""]));}catch{}; break;}
          case "getAllRoomsUserCount": { const result: Array<[RoomName, number]> = roomList.map(r => [r, getJumlahRoom()[r]]); try{ws.send(JSON.stringify(["allRoomsUserCount", result]));}catch{}; break; }
          case "getCurrentNumber": try{ws.send(JSON.stringify(["currentNumber",getCurrentNumber()]));}catch{}; break;
          case "joinRoom": {
            const newRoom:RoomName=data[1]; if(!allRooms.has(newRoom)){try{ws.send(JSON.stringify(["error",`Unknown room: ${newRoom}`]));}catch{};break;}
            const seatMap = roomSeats.get(newRoom)!; let foundSeat:number|null=null;
            if(ws.idtarget&&userToSeat.has(ws.idtarget)){ const prev=userToSeat.get(ws.idtarget)!; if(prev.room===newRoom){ const si=seatMap.get(prev.seat)!; if(si.namauser==="") foundSeat=prev.seat; } }
            if(foundSeat===null&&ws.idtarget){ for(let i=1;i<=MAX_SEATS;i++){ const k=seatMap.get(i)!; if(k.namauser===""){ k.namauser="__LOCK__"+ws.idtarget; k.lockTime=Date.now(); foundSeat=i; break; } } }
            if(foundSeat===null){ try{ws.send(JSON.stringify(["roomFull",newRoom]));}catch{}; break;}
            if(ws.roomname&&ws.numkursi){ const oldRoom=ws.roomname; for(const s of ws.numkursi){ resetSeat(roomSeats.get(oldRoom)!.get(s)!); broadcastToRoom(oldRoom,["removeKursi",oldRoom,s]); } ws.numkursi.clear(); broadcastRoomUserCount(oldRoom);}
            ws.roomname=newRoom; ws.numkursi!.add(foundSeat); const seatInfo=seatMap.get(foundSeat)!; if(seatInfo.namauser.startsWith("__LOCK__")){ seatInfo.namauser=ws.idtarget!; seatInfo.lockTime=undefined; userToSeat.set(ws.idtarget!,{room:newRoom,seat:foundSeat}); } updateKursiBuffer.set(newRoom,updateKursiBuffer.get(newRoom)||new Map()); updateKursiBuffer.get(newRoom)!.set(foundSeat,seatInfo); break;}
          case "chat": { const [_,room,msg,namauser]=data; if(!chatMessageBuffer.has(room)) chatMessageBuffer.set(room,[]); chatMessageBuffer.get(room)!.push(["chat",room,msg,namauser,Date.now()]); break;}
          case "point": { const [_,room,seat,x,y,fast]=data; if(!pointUpdateBuffer.has(room)) pointUpdateBuffer.set(room,new Map()); if(!pointUpdateBuffer.get(room)!.has(seat)) pointUpdateBuffer.get(room)!.set(seat,[]); pointUpdateBuffer.get(room)!.get(seat)!.push({x,y,fast}); break;}
        }
      } catch(e) { console.error("Message parse error:",e); }
    });

    ws.addEventListener("close", () => {
      clients.delete(ws);
      if(ws.roomname&&ws.numkursi) { const seatMap=roomSeats.get(ws.roomname)!; for(const s of ws.numkursi){ resetSeat(seatMap.get(s)!); broadcastToRoom(ws.roomname,["removeKursi",ws.roomname,s]); } broadcastRoomUserCount(ws.roomname); }
    });

    event.respondWith(response);
  } catch(e){ event.respondWith(new Response("WS Error",{status:500})); }
});
