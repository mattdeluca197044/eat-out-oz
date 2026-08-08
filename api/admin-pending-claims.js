// GET /api/admin-pending-claims
// Headers: x-admin-secret: <ADMIN_SECRET>
// Lists restaurants that have linked a Google Place ID but haven't been
// manually verified as the legitimate owner yet. Used by admin.html.
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
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, x-admin-secret");
}

export default async function handler(req, res) {
  setCors(req, res);
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "GET") return res.status(405).json({ error: "Use GET" });

  const adminSecret = process.env.ADMIN_SECRET;
  if (!adminSecret) {
    return res.status(500).json({ error: "Server is missing ADMIN_SECRET" });
  }
  const provided = req.headers["x-admin-secret"];
  if (!provided || provided !== adminSecret) {
    return res.status(401).json({ error: "Invalid admin secret" });
  }

  const sql = neon(process.env.DATABASE_URL);
  try {
    const rows = await sql`
      SELECT id, name, owner_email, place_id, subscription_status, created_at
      FROM restaurants
      WHERE verification_status = 'pending' AND place_id IS NOT NULL
      ORDER BY created_at ASC
    `;
    return res.status(200).json({ pending: rows });
  } catch (err) {
    console.error("admin-pending-claims error:", err); // keep detail server-side only
    return res.status(500).json({ error: "Failed to load pending claims" });
  }
}
