import { promises as fs } from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { buildSeatsForBuses, initialData } from "@/constants/initialData";

const DATA_DIR = process.env.VERCEL ? "/tmp" : path.join(process.cwd(), "src", "data");
const DATA_FILE = path.join(DATA_DIR, "travel-data.json");

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

// Strip date suffix from date-scoped IDs like "bus-1_2026-04-20" → "bus-1"
function getBaseBusId(busId) {
  return busId.replace(/_\d{4}-\d{2}-\d{2}$/, "");
}

function normalizeStatus(status) {
  if (status === "booked" || status === "reserved") {
    return status;
  }

  return "available";
}

function normalizeStore(data) {
  const fallback = clone(initialData);

  if (!data || typeof data !== "object") {
    return fallback;
  }

  const buses = Array.isArray(data.buses) ? data.buses : [];
  const seats = Array.isArray(data.seats) ? data.seats : fallback.seats;
  const bookings = Array.isArray(data.bookings) ? data.bookings : [];

  const normalizedInputBuses = buses
    .filter((bus) => bus && bus.id)
    .map((bus) => ({
      id: String(bus.id),
      from: String(bus.from || ""),
      to: String(bus.to || ""),
      departure: String(bus.departure || ""),
      arrival: String(bus.arrival || ""),
      duration: String(bus.duration || ""),
      price: Number(bus.price || 0),
      type: bus.type === "Premium" ? "Premium" : "Standard",
    }));

  const busMap = new Map(fallback.buses.map((bus) => [bus.id, bus]));
  normalizedInputBuses.forEach((bus) => {
    busMap.set(bus.id, bus);
  });
  const mergedBuses = Array.from(busMap.values());

  const defaultSeats = buildSeatsForBuses(mergedBuses);
  const seatMap = new Map(
    defaultSeats.map((seat) => [`${seat.busId}:${seat.seatNumber}`, seat])
  );

  seats
    .filter((seat) => seat && seat.busId && seat.seatNumber)
    .forEach((seat) => {
      const normalizedSeat = {
        busId: String(seat.busId),
        seatNumber: String(seat.seatNumber),
        status: normalizeStatus(seat.status),
      };
      seatMap.set(`${normalizedSeat.busId}:${normalizedSeat.seatNumber}`, normalizedSeat);
    });

  const normalizedBookings = bookings
    .filter((booking) => booking && booking.id && booking.busId && Array.isArray(booking.seatNumbers))
    .map((booking) => ({
      id: String(booking.id),
      reference: String(booking.reference || booking.id),
      busId: String(booking.busId),
      seatNumbers: booking.seatNumbers.map(String),
      passenger: booking.passenger && typeof booking.passenger === "object" ? booking.passenger : {},
      route: booking.route && typeof booking.route === "object" ? booking.route : {},
      total: Number(booking.total || 0),
      pricePerSeat: Number(booking.pricePerSeat || 0),
      taxesFees: Number(booking.taxesFees || 0),
      busType: String(booking.busType || "standard"),
      status: String(booking.status || "confirmed"),
      createdAt: String(booking.createdAt || new Date().toISOString()),
    }));

  normalizedBookings.forEach((booking) => {
    booking.seatNumbers.forEach((seatNumber) => {
      const key = `${booking.busId}:${seatNumber}`;
      const existing = seatMap.get(key);
      if (existing) {
        seatMap.set(key, { ...existing, status: "booked" });
        return;
      }

      seatMap.set(key, {
        busId: booking.busId,
        seatNumber,
        status: "booked",
      });
    });
  });

  return {
    buses: mergedBuses,
    seats: Array.from(seatMap.values()),
    bookings: normalizedBookings,
  };
}

async function ensureStoreFile() {
  await fs.mkdir(DATA_DIR, { recursive: true });

  try {
    await fs.access(DATA_FILE);
  } catch {
    await fs.writeFile(DATA_FILE, JSON.stringify(initialData, null, 2), "utf8");
  }
}

export async function readStoreData() {
  await ensureStoreFile();
  const raw = await fs.readFile(DATA_FILE, "utf8");
  const parsed = JSON.parse(raw);
  return normalizeStore(parsed);
}

export async function writeStoreData(data) {
  await ensureStoreFile();
  const normalized = normalizeStore(data);
  await fs.writeFile(DATA_FILE, JSON.stringify(normalized, null, 2), "utf8");
  return normalized;
}

export async function getSeatsByBusId(busId) {
  const data = await readStoreData();
  const bus = data.buses.find((item) => item.id === busId);

  if (!bus) {
    return null;
  }

  return data.seats.filter((seat) => seat.busId === busId);
}

export async function getBookingById(bookingId) {
  const data = await readStoreData();
  return data.bookings.find((booking) => booking.id === bookingId) || null;
}

function buildBookingId() {
  return `booking-${crypto.randomUUID()}`;
}

function buildBookingReference() {
  return `TS-${Date.now().toString(36).toUpperCase()}-${Math.floor(Math.random() * 1000)
    .toString()
    .padStart(3, "0")}`;
}

export async function createBookingInStore(payload) {
  const {
    busId,
    seatNumbers,
    passenger,
    busType = "standard",
    pricePerSeat = 0,
    taxesFees = 0,
  } = payload;

  const uniqueSeatNumbers = [...new Set((seatNumbers || []).map(String))];
  const data = await readStoreData();

  // Support date-scoped busIds like "bus-1_2026-04-20" by looking up the base bus
  const baseBusId = getBaseBusId(busId);
  const bus = data.buses.find((item) => item.id === baseBusId);
  if (!bus) {
    return { ok: false, status: 404, message: "Trip not found.", conflictSeats: [] };
  }

  if (uniqueSeatNumbers.length === 0) {
    return { ok: false, status: 400, message: "Select at least one seat.", conflictSeats: [] };
  }

  const busSeats = data.seats.filter((seat) => seat.busId === busId);
  // If no seat records exist for this busId (future-date trip), all seats are available
  const conflictSeats = uniqueSeatNumbers.filter((seatNumber) => {
    const found = busSeats.find((seat) => seat.seatNumber === seatNumber);
    return found && found.status !== "available";
  });

  if (conflictSeats.length > 0) {
    return {
      ok: false,
      status: 409,
      message: `Seat(s) no longer available: ${conflictSeats.join(", ")}`,
      conflictSeats,
      seats: busSeats,
    };
  }

  // Extract travel date from date-scoped busId if present
  const dateSuffix = busId.match(/_(\d{4}-\d{2}-\d{2})$/);
  const travelDate = dateSuffix ? dateSuffix[1] : null;

  const booking = {
    id: buildBookingId(),
    reference: buildBookingReference(),
    busId,
    seatNumbers: uniqueSeatNumbers,
    passenger: passenger && typeof passenger === "object" ? passenger : {},
    route: {
      from: bus.from,
      to: bus.to,
      departure: bus.departure,
      arrival: bus.arrival,
      duration: bus.duration,
      ...(travelDate ? { travelDate } : {}),
    },
    total: Number(pricePerSeat) * uniqueSeatNumbers.length + Number(taxesFees),
    pricePerSeat: Number(pricePerSeat),
    taxesFees: Number(taxesFees),
    busType,
    status: "confirmed",
    createdAt: new Date().toISOString(),
  };

  // Update existing seat records to booked
  const existingSeatNums = new Set(busSeats.map((s) => s.seatNumber));
  const updatedSeats = data.seats.map((seat) => {
    if (seat.busId === busId && uniqueSeatNumbers.includes(seat.seatNumber)) {
      return { ...seat, status: "booked" };
    }
    return seat;
  });
  // Add new seat records for seats with no prior record (future-date trips)
  const newSeatRecords = uniqueSeatNumbers
    .filter((sn) => !existingSeatNums.has(sn))
    .map((sn) => ({ busId, seatNumber: sn, status: "booked" }));

  const nextSeats = [...updatedSeats, ...newSeatRecords];

  const nextData = { ...data, seats: nextSeats, bookings: [booking, ...data.bookings] };
  await writeStoreData(nextData);

  return {
    ok: true,
    status: 201,
    booking,
    seats: nextSeats.filter((seat) => seat.busId === busId),
  };
}

export async function cancelBookingInStore(bookingId) {
  const data = await readStoreData();
  const booking = data.bookings.find((b) => b.id === bookingId);

  if (!booking) {
    return { ok: false, status: 404, message: "Booking not found." };
  }

  if (booking.status === "cancelled") {
    return { ok: false, status: 400, message: "Booking is already cancelled." };
  }

  const nextSeats = data.seats.map((seat) => {
    if (seat.busId === booking.busId && booking.seatNumbers.includes(seat.seatNumber)) {
      return { ...seat, status: "available" };
    }
    return seat;
  });

  const nextBookings = data.bookings.map((b) =>
    b.id === bookingId ? { ...b, status: "cancelled" } : b
  );

  const nextData = { ...data, seats: nextSeats, bookings: nextBookings };
  await writeStoreData(nextData);

  return {
    ok: true,
    status: 200,
    booking: nextBookings.find((b) => b.id === bookingId),
    seats: nextSeats.filter((seat) => seat.busId === booking.busId),
  };
}

export async function modifyBookingInStore(bookingId, payload) {
  const { seatNumbers: newSeatNumbers, passenger: newPassenger } = payload;
  const data = await readStoreData();
  const booking = data.bookings.find((b) => b.id === bookingId);

  if (!booking) {
    return { ok: false, status: 404, message: "Booking not found.", conflictSeats: [] };
  }

  if (booking.status === "cancelled") {
    return { ok: false, status: 400, message: "Cannot modify a cancelled booking.", conflictSeats: [] };
  }

  const wantsSeatChange = Array.isArray(newSeatNumbers) && newSeatNumbers.length > 0;
  const uniqueNewSeats = wantsSeatChange ? [...new Set(newSeatNumbers.map(String))] : booking.seatNumbers;

  // Check if new seats (excluding currently held seats) are available
  if (wantsSeatChange) {
    const busSeats = data.seats.filter((s) => s.busId === booking.busId);
    const conflictSeats = uniqueNewSeats.filter((sn) => {
      if (booking.seatNumbers.includes(sn)) return false; // already ours
      const found = busSeats.find((s) => s.seatNumber === sn);
      return !found || found.status !== "available";
    });

    if (conflictSeats.length > 0) {
      return {
        ok: false,
        status: 409,
        message: `Seat(s) no longer available: ${conflictSeats.join(", ")}`,
        conflictSeats,
        seats: busSeats,
      };
    }
  }

  // Release old seats that are no longer needed
  const releasedSeats = booking.seatNumbers.filter((sn) => !uniqueNewSeats.includes(sn));
  // Claim new seats that weren't previously held
  const claimedSeats = uniqueNewSeats.filter((sn) => !booking.seatNumbers.includes(sn));

  const nextSeats = data.seats.map((seat) => {
    if (seat.busId !== booking.busId) return seat;
    if (releasedSeats.includes(seat.seatNumber)) return { ...seat, status: "available" };
    if (claimedSeats.includes(seat.seatNumber)) return { ...seat, status: "booked" };
    return seat;
  });

  const updatedPassenger = newPassenger && typeof newPassenger === "object"
    ? { ...booking.passenger, ...newPassenger }
    : booking.passenger;

  const updatedBooking = {
    ...booking,
    seatNumbers: uniqueNewSeats,
    passenger: updatedPassenger,
    total: booking.pricePerSeat * uniqueNewSeats.length + booking.taxesFees,
  };

  const nextBookings = data.bookings.map((b) =>
    b.id === bookingId ? updatedBooking : b
  );

  const nextData = { ...data, seats: nextSeats, bookings: nextBookings };
  await writeStoreData(nextData);

  return {
    ok: true,
    status: 200,
    booking: updatedBooking,
    seats: nextSeats.filter((seat) => seat.busId === booking.busId),
  };
}
