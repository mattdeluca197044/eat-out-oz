// POST /api/admin-review-claim
// Headers: x-admin-secret: <ADMIN_SECRET>
// Body: { restaurantId, action: "approve" | "reject" }
// Approves or rejects a pending listing claim. Rejecting clears the linked
// Place ID too, so the listing goes back to unclaimed and the account can
// try again with correct information rather than being stuck permanently
// rejected against a listing they never should have linked.
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
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, x-admin-secret");
}

export default async function handler(req, res) {
  setCors(req, res);
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Use POST" });

  const adminSecret = process.env.ADMIN_SECRET;
  if (!adminSecret) {
    return res.status(500).json({ error: "Server is missing ADMIN_SECRET" });
  }
  const provided = req.headers["x-admin-secret"];
  if (!provided || provided !== adminSecret) {
    return res.status(401).json({ error: "Invalid admin secret" });
  }

  const { restaurantId, action } = req.body || {};
  if (!restaurantId || !["approve", "reject"].includes(action)) {
    return res.status(400).json({ error: "restaurantId and a valid action ('approve' or 'reject') are required" });
  }

  const sql = neon(process.env.DATABASE_URL);
  try {
    if (action === "approve") {
      await sql`
        UPDATE restaurants SET verification_status = 'approved' WHERE id = ${restaurantId}
      `;
    } else {
      await sql`
        UPDATE restaurants
        SET verification_status = 'rejected', place_id = NULL
        WHERE id = ${restaurantId}
      `;
    }
    return res.status(200).json({ success: true });
  } catch (err) {
    console.error("admin-review-claim error:", err); // keep detail server-side only
    return res.status(500).json({ error: "Review action failed" });
  }
}
