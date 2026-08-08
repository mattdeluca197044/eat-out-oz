// GET /api/specials
// Public endpoint. Returns every restaurant with an active subscription
// AND a current special set — this is the data source for the homepage
// "Today's Specials" section, and is real exposure for subscribers: it's
// the only way a listing appears on the homepage without a visitor
// searching for it specifically.
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

  const key = process.env.GOOGLE_PLACES_API_KEY;
  const sql = neon(process.env.DATABASE_URL);
  const ip = getClientIp(req);

  const allowed = await checkRateLimit(sql, `specials:${ip}`, 30, 60);
  if (!allowed) {
    return res.status(429).json({ error: "Too many requests. Please slow down and try again shortly." });
  }

  try {
    const rows = await sql`
      SELECT id, name, place_id, current_special, description, photos
      FROM restaurants
      WHERE subscription_status = 'active'
        AND current_special IS NOT NULL
        AND current_special != ''
      ORDER BY id DESC
    `;

    // Enrich each with live rating/address from Google, when a Place ID is
    // linked. Done in parallel; a restaurant is still included even if its
    // Google lookup fails, just without the extra detail.
    const enriched = await Promise.all(
      rows.map(async (r) => {
        let rating = null, reviews = null, address = null, openNow = null;

        if (r.place_id && key) {
          try {
            const detailsUrl =
              `https://maps.googleapis.com/maps/api/place/details/json` +
              `?place_id=${encodeURIComponent(r.place_id)}` +
              `&fields=rating,user_ratings_total,formatted_address,opening_hours` +
              `&key=${key}`;
            const detailsRes = await fetch(detailsUrl);
            const detailsData = await detailsRes.json();
            if (detailsData.status === "OK" && detailsData.result) {
              rating = detailsData.result.rating ?? null;
              reviews = detailsData.result.user_ratings_total ?? null;
              address = detailsData.result.formatted_address ?? null;
              openNow = detailsData.result.opening_hours?.open_now ?? null;
            }
          } catch (err) {
            console.error(`specials: place details lookup failed for restaurant ${r.id}:`, err);
          }
        }

        return {
          id: r.id,
          name: r.name,
          placeId: r.place_id,
          currentSpecial: r.current_special,
          description: r.description,
          photos: r.photos || [],
          rating,
          reviews,
          address,
          openNow,
        };
      })
    );

    res.setHeader("Cache-Control", "s-maxage=120, stale-while-revalidate=600");
    return res.status(200).json({ count: enriched.length, specials: enriched });
  } catch (err) {
    console.error("specials error:", err); // keep detail server-side only
    return res.status(500).json({ error: "Failed to load specials" });
  }
}
