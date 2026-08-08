// POST /api/update-place-id
// Headers: Authorization: Bearer <token>
// Body: { placeId }
// Links this restaurant account to a Google Place ID. Deliberately does NOT
// require an active subscription — a restaurant should be able to link
// their listing while setting up their account, before deciding to pay.
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

// Google Place IDs are alphanumeric plus "-" and "_", typically 25-30+
// characters. This is a loose sanity check, not a guarantee the ID is a
// real, existing place — Google itself is the source of truth for that.
const PLACE_ID_RE = /^[A-Za-z0-9_-]{10,255}$/;

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
  if (!placeId || typeof placeId !== "string" || !PLACE_ID_RE.test(placeId.trim())) {
    return res.status(400).json({ error: "Please enter a valid Google Places ID." });
  }
  const cleanPlaceId = placeId.trim();

  const sql = neon(process.env.DATABASE_URL);
  try {
    const sessionRows = await sql`
      SELECT r.id FROM sessions s
      JOIN restaurants r ON r.id = s.restaurant_id
      WHERE s.token = ${token} AND s.expires_at > now()
    `;
    const restaurant = sessionRows[0];
    if (!restaurant) return res.status(401).json({ error: "Session expired, please log in again" });

    // Prevent two different accounts from linking the same listing — that
    // would make restaurant-by-place.js's match ambiguous (two rows for one
    // place_id), and could let one account see/edit data meant for another
    // business's claimed listing.
    const existingClaim = await sql`
      SELECT id FROM restaurants WHERE place_id = ${cleanPlaceId} AND id != ${restaurant.id}
    `;
    if (existingClaim.length) {
      return res.status(409).json({ error: "This listing has already been claimed by another account." });
    }

    await sql`
      UPDATE restaurants SET place_id = ${cleanPlaceId} WHERE id = ${restaurant.id}
    `;
    return res.status(200).json({ success: true, placeId: cleanPlaceId });
  } catch (err) {
    console.error("update-place-id error:", err); // keep detail server-side only
    return res.status(500).json({ error: "Update failed" });
  }
}
