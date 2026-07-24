// GET /api/restaurant-by-place?placeIds=ChIJ...,ChIJ...
// Returns which of the given Google place_ids have a registered restaurant account,
// so the site knows which cards should show a "Book a table" button.

import { neon } from "@neondatabase/serverless";

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "GET") return res.status(405).json({ error: "Use GET" });

  const { placeIds } = req.query;
  if (!placeIds) return res.status(400).json({ error: "placeIds query param is required (comma separated)" });

  const ids = placeIds.split(",").map((s) => s.trim()).filter(Boolean);
  if (!ids.length) return res.status(200).json({ matches: {} });

  const sql = neon(process.env.DATABASE_URL);

  try {
    const rows = await sql`
      SELECT id, place_id FROM restaurants WHERE place_id = ANY(${ids})
    `;
    const matches = {};
    rows.forEach((r) => { matches[r.place_id] = r.id; });
    return res.status(200).json({ matches });
  } catch (err) {
    return res.status(500).json({ error: "Lookup failed", detail: err.message });
  }
}
