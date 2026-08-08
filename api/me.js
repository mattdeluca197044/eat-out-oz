// GET /api/me
// Headers: Authorization: Bearer <token>
// Returns the logged-in restaurant's own profile info, including subscription status.
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
    const rows = await sql`
      SELECT r.id, r.name, r.owner_email, r.place_id, r.subscription_status,
             r.description, r.instagram_url, r.facebook_url, r.website_url, r.current_special,
             r.photos
      FROM sessions s JOIN restaurants r ON r.id = s.restaurant_id
      WHERE s.token = ${token} AND s.expires_at > now()
    `;
    const restaurant = rows[0];
    if (!restaurant) return res.status(401).json({ error: "Session expired, please log in again" });
    return res.status(200).json({ restaurant });
  } catch (err) {
    console.error("me error:", err); // keep detail server-side only
    return res.status(500).json({ error: "Failed to load profile" });
  }
}
