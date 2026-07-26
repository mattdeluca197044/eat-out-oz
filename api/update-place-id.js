// POST /api/update-place-id  (Authorization: Bearer <token>)  Body: { placeId }

import { neon } from "@neondatabase/serverless";

const ALLOWED_ORIGINS = [
  "https://outtoeat.com.au",
  "https://www.outtoeat.com.au",
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
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
}

export default async function handler(req, res) {
  setCors(req, res);
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Use POST" });

  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res.status(401).json({ error: "Log in required" });
  }
  const token = authHeader.slice(7);

  const { placeId } = req.body || {};
  if (!placeId || !placeId.trim()) {
    return res.status(400).json({ error: "placeId is required" });
  }
  if (placeId.length > 200) {
    return res.status(400).json({ error: "placeId too long" });
  }

  const sql = neon(process.env.DATABASE_URL);

  try {
    const sessionRows = await sql`
      SELECT restaurant_id FROM sessions WHERE token = ${token} AND expires_at > now()
    `;
    const restaurantId = sessionRows[0]?.restaurant_id;
    if (!restaurantId) return res.status(401).json({ error: "Session expired, please log in again" });

    await sql`UPDATE restaurants SET place_id = ${placeId.trim()} WHERE id = ${restaurantId}`;

    return res.status(200).json({ success: true, placeId: placeId.trim() });
  } catch (err) {
    return res.status(500).json({ error: "Update failed", detail: err.message });
  }
}
