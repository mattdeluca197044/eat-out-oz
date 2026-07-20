// GET /api/my-bookings
// Headers: Authorization: Bearer <token>

import { neon } from "@neondatabase/serverless";

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "GET") return res.status(405).json({ error: "Use GET" });

  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res.status(401).json({ error: "Log in required" });
  }
  const token = authHeader.slice(7);

  const sql = neon(process.env.DATABASE_URL);

  try {
    const sessionRows = await sql`
      SELECT restaurant_id FROM sessions WHERE token = ${token} AND expires_at > now()
    `;
    const restaurantId = sessionRows[0]?.restaurant_id;
    if (!restaurantId) return res.status(401).json({ error: "Session expired, please log in again" });

    const bookings = await sql`
      SELECT b.id, b.customer_name, b.customer_email, b.customer_phone, b.party_size, b.status,
             s.slot_date, s.slot_time
      FROM bookings b
      JOIN time_slots s ON s.id = b.slot_id
      WHERE b.restaurant_id = ${restaurantId} AND s.slot_date >= CURRENT_DATE
      ORDER BY s.slot_date, s.slot_time
    `;

    return res.status(200).json({ bookings });
  } catch (err) {
    return res.status(500).json({ error: "Failed to load bookings", detail: err.message });
  }
}
