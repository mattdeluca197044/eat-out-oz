// GET  /api/slots?restaurantId=1
// POST /api/slots  (Authorization: Bearer <token>)  Body: { date, time, capacity }

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
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
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

async function getRestaurantIdFromToken(sql, authHeader) {
  if (!authHeader || !authHeader.startsWith("Bearer ")) return null;
  const token = authHeader.slice(7);
  const rows = await sql`
    SELECT restaurant_id FROM sessions WHERE token = ${token} AND expires_at > now()
  `;
  return rows[0]?.restaurant_id || null;
}

export default async function handler(req, res) {
  setCors(req, res);
  if (req.method === "OPTIONS") return res.status(204).end();

  const sql = neon(process.env.DATABASE_URL);
  const ip = getClientIp(req);

  if (req.method === "GET") {
    const { restaurantId } = req.query;
    if (!restaurantId || !/^\d+$/.test(restaurantId)) {
      return res.status(400).json({ error: "Valid restaurantId is required" });
    }

    const allowed = await checkRateLimit(sql, `slots-get:${ip}`, 60, 60);
    if (!allowed) return res.status(429).json({ error: "Too many requests, please slow down." });

    try {
      const slots = await sql`
        SELECT id, slot_date, slot_time, capacity, booked_count
        FROM time_slots
        WHERE restaurant_id = ${restaurantId}
          AND slot_date >= CURRENT_DATE
          AND booked_count < capacity
        ORDER BY slot_date, slot_time
      `;
      return res.status(200).json({ slots });
    } catch (err) {
      return res.status(500).json({ error: "Failed to load slots", detail: err.message });
    }
  }

  if (req.method === "POST") {
    const allowed = await checkRateLimit(sql, `slots-post:${ip}`, 30, 300);
    if (!allowed) return res.status(429).json({ error: "Too many requests, please slow down." });

    const restaurantId = await getRestaurantIdFromToken(sql, req.headers.authorization);
    if (!restaurantId) return res.status(401).json({ error: "Log in required" });

    const { date, time, capacity } = req.body || {};
    if (!date || !time || !capacity) {
      return res.status(400).json({ error: "date, time and capacity are required" });
    }
    const cap = parseInt(capacity, 10);
    if (!Number.isInteger(cap) || cap < 1 || cap > 500) {
      return res.status(400).json({ error: "Capacity must be a number between 1 and 500" });
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return res.status(400).json({ error: "Invalid date format" });
    }

    try {
      const [slot] = await sql`
        INSERT INTO time_slots (restaurant_id, slot_date, slot_time, capacity)
        VALUES (${restaurantId}, ${date}, ${time}, ${cap})
        ON CONFLICT (restaurant_id, slot_date, slot_time)
        DO UPDATE SET capacity = EXCLUDED.capacity
        RETURNING id, slot_date, slot_time, capacity, booked_count
      `;
      return res.status(201).json({ slot });
    } catch (err) {
      return res.status(500).json({ error: "Failed to add slot", detail: err.message });
    }
  }

  return res.status(405).json({ error: "Use GET or POST" });
}
