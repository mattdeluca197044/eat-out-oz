// GET /api/place-website?placeId=...
// Looks up the real website URL for a Google Place, on demand — only
// called when someone actually clicks "Find website" on a listing, not
// for every result on a page (which would mean an extra paid Google API
// call per listing, for links most people never click).
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

export default async function handler(req, res) {
  setCors(req, res);
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "GET") return res.status(405).json({ error: "Use GET" });

  const { placeId } = req.query || {};
  if (!placeId || typeof placeId !== "string") {
    return res.status(400).json({ error: "placeId is required" });
  }

  const sql = neon(process.env.DATABASE_URL);
  const ip = getClientIp(req);

  // A per-IP limit is enough here — this is a lightweight, public,
  // read-only lookup, but still worth guarding since each call costs a
  // real (small) Google API fee.
  const allowed = await checkRateLimit(sql, `place-website:${ip}`, 60, 300);
  if (!allowed) {
    return res.status(429).json({ error: "Too many requests — please slow down." });
  }

  // NOTE: this assumes the same Google Maps/Places API key your search
  // endpoint already uses is available as GOOGLE_PLACES_API_KEY. If your
  // existing search.js uses a different env var name, change this line to
  // match it exactly — otherwise this lookup will silently fail.
  const apiKey = process.env.GOOGLE_PLACES_API_KEY;
  if (!apiKey) {
    console.error("place-website: GOOGLE_PLACES_API_KEY is not set");
    return res.status(500).json({ error: "Website lookup is not configured." });
  }

  try {
    const url = `https://maps.googleapis.com/maps/api/place/details/json?place_id=${encodeURIComponent(placeId)}&fields=website&key=${apiKey}`;
    const response = await fetch(url);
    const data = await response.json();

    if (data.status !== "OK" || !data.result?.website) {
      // Not an error — plenty of real businesses genuinely have no
      // website on file with Google. The frontend falls back to a
      // regular search in that case.
      return res.status(200).json({ website: null });
    }

    return res.status(200).json({ website: data.result.website });
  } catch (err) {
    console.error("place-website error:", err);
    return res.status(500).json({ error: "Website lookup failed." });
  }
}
