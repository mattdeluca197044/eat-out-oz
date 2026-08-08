// POST /api/track-event
// Body: { placeId, eventType }
// Public, fire-and-forget endpoint called from the frontend whenever
// someone views a listing page or clicks directions/website/book. Kept
// deliberately simple and fast — this fires on every page load and click,
// so it shouldn't add noticeable latency to the user's action.
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

const PLACE_ID_RE = /^[A-Za-z0-9_-]{10,255}$/;
const ALLOWED_EVENT_TYPES = ["view", "directions", "website", "book_click"];

export default async function handler(req, res) {
  setCors(req, res);
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Use POST" });

  const { placeId, eventType } = req.body || {};
  if (!placeId || !PLACE_ID_RE.test(placeId)) {
    return res.status(400).json({ error: "A valid placeId is required" });
  }
  if (!ALLOWED_EVENT_TYPES.includes(eventType)) {
    return res.status(400).json({ error: "Invalid eventType" });
  }

  const sql = neon(process.env.DATABASE_URL);
  const ip = getClientIp(req);

  // Generous limit — this fires on normal browsing, not something a real
  // visitor would ever hit, but stops naive scripted inflation of a
  // listing's stats.
  const allowed = await checkRateLimit(sql, `track-event:${ip}`, 120, 60);
  if (!allowed) {
    return res.status(429).json({ error: "Too many requests." });
  }

  try {
    await sql`
      INSERT INTO listing_events (place_id, event_type) VALUES (${placeId}, ${eventType})
    `;
    return res.status(204).end();
  } catch (err) {
    console.error("track-event error:", err); // keep detail server-side only
    // Never let a tracking failure look like an error to the visitor —
    // this is a background nice-to-have, not part of their actual task.
    return res.status(204).end();
  }
}
