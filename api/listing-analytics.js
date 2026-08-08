// GET /api/listing-analytics
// Headers: Authorization: Bearer <token>
// Returns event counts for the logged-in restaurant's own linked listing —
// last 30 days and last 7 days, broken down by event type. Available
// regardless of subscription tier once a Place ID is linked; it's the
// value-add that helps justify subscribing in the first place.
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
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
}

const EVENT_TYPES = ["view", "directions", "website", "book_click"];

export default async function handler(req, res) {
  setCors(req, res);
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
      SELECT r.id, r.place_id FROM sessions s
      JOIN restaurants r ON r.id = s.restaurant_id
      WHERE s.token = ${token} AND s.expires_at > now()
    `;
    const restaurant = sessionRows[0];
    if (!restaurant) return res.status(401).json({ error: "Session expired, please log in again" });

    if (!restaurant.place_id) {
      return res.status(200).json({ hasListing: false });
    }

    const rows30 = await sql`
      SELECT event_type, COUNT(*)::int AS count
      FROM listing_events
      WHERE place_id = ${restaurant.place_id} AND created_at > now() - interval '30 days'
      GROUP BY event_type
    `;
    const rows7 = await sql`
      SELECT event_type, COUNT(*)::int AS count
      FROM listing_events
      WHERE place_id = ${restaurant.place_id} AND created_at > now() - interval '7 days'
      GROUP BY event_type
    `;

    const toCounts = (rows) => {
      const counts = Object.fromEntries(EVENT_TYPES.map((t) => [t, 0]));
      rows.forEach((r) => { counts[r.event_type] = r.count; });
      return counts;
    };

    return res.status(200).json({
      hasListing: true,
      last30Days: toCounts(rows30),
      last7Days: toCounts(rows7),
    });
  } catch (err) {
    console.error("listing-analytics error:", err); // keep detail server-side only
    return res.status(500).json({ error: "Failed to load analytics" });
  }
}
