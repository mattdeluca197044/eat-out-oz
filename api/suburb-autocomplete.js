// GET /api/suburb-autocomplete?input=pen
// Public endpoint. Proxies Google's Places Autocomplete API, restricted to
// Australian localities/regions (suburbs, towns, cities) — powers live
// suburb suggestions in the search box, so people aren't limited to typing
// an exact match or relying on a hardcoded list.
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

const KNOWN_STATES = ["NSW", "VIC", "QLD", "WA", "SA", "TAS", "ACT", "NT"];

// Google's autocomplete secondary_text for a locality looks like
// "NSW, Australia" — pull the state abbreviation out of it so the
// frontend can offer to auto-select the matching state dropdown too.
function extractState(secondaryText) {
  if (!secondaryText) return null;
  return KNOWN_STATES.find((s) => secondaryText.includes(s)) || null;
}

export default async function handler(req, res) {
  setCors(req, res);
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "GET") return res.status(405).json({ error: "Use GET" });

  const { input } = req.query;
  if (!input || !input.trim()) {
    return res.status(200).json({ suggestions: [] });
  }
  if (input.length > 100) {
    return res.status(400).json({ error: "Input too long" });
  }

  const key = process.env.GOOGLE_PLACES_API_KEY;
  if (!key) {
    return res.status(500).json({ error: "Server is missing GOOGLE_PLACES_API_KEY" });
  }

  const sql = neon(process.env.DATABASE_URL);
  const ip = getClientIp(req);

  // Generous but real limit — this can fire fairly often as someone types,
  // even with frontend debouncing, so it's rate-limited more permissively
  // than a full search but still capped to prevent runaway API costs.
  const allowed = await checkRateLimit(sql, `suburb-autocomplete:${ip}`, 60, 60);
  if (!allowed) {
    return res.status(429).json({ error: "Too many requests. Please slow down." });
  }

  try {
    const url =
      `https://maps.googleapis.com/maps/api/place/autocomplete/json` +
      `?input=${encodeURIComponent(input.trim())}` +
      `&types=(cities)` +
      `&components=country:au` +
      `&key=${key}`;
    const response = await fetch(url);
    const data = await response.json();

    if (data.status !== "OK" && data.status !== "ZERO_RESULTS") {
      console.error("suburb-autocomplete: Places API error:", data.status, data.error_message);
      return res.status(200).json({ suggestions: [] }); // fail quietly — this is a nice-to-have, not core search
    }

    const suggestions = (data.predictions || []).slice(0, 6).map((p) => ({
      description: p.description,
      mainText: p.structured_formatting?.main_text || p.description,
      secondaryText: p.structured_formatting?.secondary_text || null,
      state: extractState(p.structured_formatting?.secondary_text),
    }));

    res.setHeader("Cache-Control", "s-maxage=3600, stale-while-revalidate=86400"); // suburb names don't change; safe to cache longer
    return res.status(200).json({ suggestions });
  } catch (err) {
    console.error("suburb-autocomplete error:", err); // keep detail server-side only
    return res.status(200).json({ suggestions: [] }); // fail quietly
  }
}
