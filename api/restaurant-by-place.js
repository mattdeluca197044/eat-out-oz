// GET /api/restaurant-by-place?placeIds=ChIJ...,ChIJ...

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
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

export default async function handler(req, res) {
  setCors(req, res);
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "GET") return res.status(405).json({ error: "Use GET" });

  const { placeIds } = req.query;
  if (!placeIds) return res.status(400).json({ error: "placeIds query param is required (comma separated)" });

  const ids = placeIds.split(",").map((s) => s.trim()).filter(Boolean).slice(0, 500);
  if (!ids.length) return res.status(200).json({ matches: {} });

  const sql = neon(process.env.DATABASE_URL);

  try {
    const rows = await sql`
      SELECT id, place_id, description, instagram_url, facebook_url, website_url, current_special
      FROM restaurants
      WHERE place_id = ANY(${ids}) AND subscription_status = 'active'
    `;
    const matches = {};
    rows.forEach((r) => {
      matches[r.place_id] = {
        restaurantId: r.id,
        description: r.description,
        instagramUrl: r.instagram_url,
        facebookUrl: r.facebook_url,
        websiteUrl: r.website_url,
        currentSpecial: r.current_special,
      };
    });
    return res.status(200).json({ matches });
  } catch (err) {
    return res.status(500).json({ error: "Lookup failed", detail: err.message });
  }
}
