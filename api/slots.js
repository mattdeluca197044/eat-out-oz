// GET  /api/slots?restaurantId=1                -> public, list upcoming available slots
// POST /api/slots                                -> restaurant owner only, add a new slot
//   Headers: Authorization: Bearer <token>
//   Body: { date: "2026-07-25", time: "19:00", capacity: 4 }

import { neon } from "@neondatabase/serverless";

async function getRestaurantIdFromToken(sql, authHeader) {
  if (!authHeader || !authHeader.startsWith("Bearer ")) return null;
  const token = authHeader.slice(7);
  const rows = await sql`
    SELECT restaurant_id FROM sessions
    WHERE token = ${token} AND expires_at > now()
  `;
  return rows[0]?.restaurant_id || null;
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.status(204).end();

  const sql = neon(process.env.DATABASE_URL);

  if (req.method === "GET") {
    const { restaurantId } = req.query;
    if (!restaurantId) return res.status(400).json({ error: "restaurantId is required" });

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
    const restaurantId = await getRestaurantIdFromToken(sql, req.headers.authorization);
    if (!restaurantId) return res.status(401).json({ error: "Log in required" });

    const { date, time, capacity } = req.body || {};
    if (!date || !time || !capacity) {
      return res.status(400).json({ error: "date, time and capacity are required" });
    }

    try {
      const [slot] = await sql`
        INSERT INTO time_slots (restaurant_id, slot_date, slot_time, capacity)
        VALUES (${restaurantId}, ${date}, ${time}, ${capacity})
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
