// GET /api/place-details?placeId=ChIJ...
// Public endpoint. Combines live Google Place Details (rating, address,
// hours, phone) with this listing's claimed data if a subscribed
// restaurant has linked this Place ID (photos, description, socials,
// current special, booking availability). Powers the listing detail page.
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

const PLACE_ID_RE = /^[A-Za-z0-9_-]{10,255}$/;

export default async function handler(req, res) {
  setCors(req, res);
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "GET") return res.status(405).json({ error: "Use GET" });

  const { placeId } = req.query;
  if (!placeId || !PLACE_ID_RE.test(placeId)) {
    return res.status(400).json({ error: "A valid placeId query parameter is required" });
  }

  const key = process.env.GOOGLE_PLACES_API_KEY;
  const sql = neon(process.env.DATABASE_URL);
  const ip = getClientIp(req);

  const allowed = await checkRateLimit(sql, `place-details:${ip}`, 60, 60);
  if (!allowed) {
    return res.status(429).json({ error: "Too many requests. Please slow down and try again shortly." });
  }

  let google = null;
  if (key) {
    try {
      const detailsUrl =
        `https://maps.googleapis.com/maps/api/place/details/json` +
        `?place_id=${encodeURIComponent(placeId)}` +
        `&fields=name,rating,user_ratings_total,formatted_address,formatted_phone_number,` +
        `opening_hours,price_level,types,website` +
        `&key=${key}`;
      const detailsRes = await fetch(detailsUrl);
      const detailsData = await detailsRes.json();
      if (detailsData.status === "OK" && detailsData.result) {
        const r = detailsData.result;
        google = {
          name: r.name ?? null,
          rating: r.rating ?? null,
          reviews: r.user_ratings_total ?? null,
          address: r.formatted_address ?? null,
          phone: r.formatted_phone_number ?? null,
          priceLevel: r.price_level ?? null,
          openNow: r.opening_hours?.open_now ?? null,
          weekdayHours: r.opening_hours?.weekday_text ?? null,
          googleWebsite: r.website ?? null,
          types: r.types || [],
        };
      }
    } catch (err) {
      console.error("place-details: Google lookup failed:", err); // keep detail server-side only
    }
  }

  if (!google) {
    return res.status(404).json({ error: "Couldn't find that listing." });
  }

  let claimed = null;
  try {
    const rows = await sql`
      SELECT id, description, instagram_url, facebook_url, website_url, current_special, photos
      FROM restaurants
      WHERE place_id = ${placeId} AND subscription_status = 'active' AND verification_status = 'approved'
    `;
    if (rows.length) {
      const r = rows[0];
      claimed = {
        restaurantId: r.id,
        description: r.description,
        instagramUrl: r.instagram_url,
        facebookUrl: r.facebook_url,
        websiteUrl: r.website_url,
        currentSpecial: r.current_special,
        photos: r.photos || [],
      };
    }
  } catch (err) {
    console.error("place-details: claimed lookup failed:", err); // keep detail server-side only
    // Don't fail the whole request just because the claimed-data lookup
    // failed — the page can still show Google's public data.
  }

  res.setHeader("Cache-Control", "s-maxage=60, stale-while-revalidate=300");
  return res.status(200).json({ placeId, google, claimed });
}
