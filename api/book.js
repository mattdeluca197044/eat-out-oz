// POST /api/book
// Body: { slotId, name, email, phone, partySize }

import { neon } from "@neondatabase/serverless";

const ALLOWED_ORIGINS = [
  "https://outtoeat.au",
  "https://www.outtoeat.au",
  "https://dine-out-website.vercel.app",
  "https://dine-out-app.vercel.app",
  "https://restaurant-portal-seven.vercel.app",
];

function setCors(req, res) {
  const origin = req.headers.origin;
  if (origin && ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
  }
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

function getClientIp(req) {
  const fwd = req.headers["x-forwarded-for"];
  return (fwd ? fwd.split(",")[0].trim() : req.socket?.remoteAddress) || "unknown";
}

async function checkRateLimit(sql, key, maxRequests, windowSeconds) {
  const now = new Date();
  const rows = await sql`SELECT window_start, count FROM rate_limits WHERE id = ${key}`;
  if (!rows.length) {
    await sql`INSERT INTO rate_limits (id, window_start, count) VALUES (${key}, ${now.toISOString()}, 1)
      ON CONFLICT (id) DO UPDATE SET window_start = ${now.toISOString()}, count = 1`;
    return true;
  }
  const elapsed = (now - new Date(rows[0].window_start)) / 1000;
  if (elapsed > windowSeconds) {
    await sql`UPDATE rate_limits SET window_start = ${now.toISOString()}, count = 1 WHERE id = ${key}`;
    return true;
  }
  if (rows[0].count >= maxRequests) return false;
  await sql`UPDATE rate_limits SET count = count + 1 WHERE id = ${key}`;
  return true;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export default async function handler(req, res) {
  setCors(req, res);
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Use POST" });

  const { slotId, name, email, phone, partySize } = req.body || {};
  if (!slotId || !name || !email || !partySize) {
    return res.status(400).json({ error: "slotId, name, email and partySize are required" });
  }
  if (!EMAIL_RE.test(email)) {
    return res.status(400).json({ error: "Enter a valid email address" });
  }
  if (name.length > 200) return res.status(400).json({ error: "Name too long" });
  const party = parseInt(partySize, 10);
  if (!Number.isInteger(party) || party < 1 || party > 50) {
    return res.status(400).json({ error: "Party size must be between 1 and 50" });
  }

  const sql = neon(process.env.DATABASE_URL);
  const ip = getClientIp(req);

  const ipAllowed = await checkRateLimit(sql, `book-ip:${ip}`, 10, 300); // 10 bookings per 5 min per IP
  const emailAllowed = await checkRateLimit(sql, `book-email:${email.toLowerCase()}`, 10, 3600); // 10/hr per email
  if (!ipAllowed || !emailAllowed) {
    return res.status(429).json({ error: "Too many booking attempts. Please wait a bit and try again." });
  }

  try {
    const [updatedSlot] = await sql`
      UPDATE time_slots
      SET booked_count = booked_count + 1
      WHERE id = ${slotId} AND booked_count < capacity
      RETURNING id, restaurant_id, slot_date, slot_time
    `;

    if (!updatedSlot) {
      return res.status(409).json({ error: "That time slot is no longer available. Please pick another." });
    }

    const [booking] = await sql`
      INSERT INTO bookings (slot_id, restaurant_id, customer_name, customer_email, customer_phone, party_size)
      VALUES (${updatedSlot.id}, ${updatedSlot.restaurant_id}, ${name.trim()}, ${email.toLowerCase()}, ${phone ? phone.trim().slice(0, 40) : null}, ${party})
      RETURNING id, status, created_at
    `;

    return res.status(201).json({
      booking,
      slot: { date: updatedSlot.slot_date, time: updatedSlot.slot_time },
    });
  } catch (err) {
    return res.status(500).json({ error: "Booking failed", detail: err.message });
  }
}
