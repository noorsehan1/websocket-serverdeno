import { openKv } from "https://deno.land/x/kv/mod.ts";

const kv = await openKv();

// Update kursi (selalu overwrite, tidak hilang)
async function updateSeat(room: string, seat: number, data: any) {
  await kv.set(["room", room, "seat", seat], data); 
}

// Ambil kursi tertentu
async function getSeat(room: string, seat: number) {
  const res = await kv.get(["room", room, "seat", seat]);
  return res.value ?? null;
}

// Ambil semua kursi dalam satu room
async function getAllSeats(room: string, maxSeats: number) {
  const seats: Record<number, any> = {};
  for (let i = 1; i <= maxSeats; i++) {
    const res = await kv.get(["room", room, "seat", i]);
    if (res.value) seats[i] = res.value;
  }
  return seats;
}
