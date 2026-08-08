// POST /api/delete-photo
// Headers: Authorization: Bearer <token>
// Body: { photoUrl: "https://....blob.vercel-storage.com/..." }
// Only works for restaurants with an active subscription, and only for a
// photo URL that's actually in that restaurant's own gallery — a
// restaurant can't delete another restaurant's photo by guessing its URL.
import { neon } from "@neondatabase/serverless";
import { del } from "@vercel/blob";

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

export default async function handler(req, res) {
  setCors(req, res);
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Use POST" });

  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res.status(401).json({ error: "Log in required" });
  }
  const token = authHeader.slice(7);

  const { photoUrl } = req.body || {};
  if (!photoUrl || typeof photoUrl !== "string") {
    return res.status(400).json({ error: "No photo specified" });
  }

  const sql = neon(process.env.DATABASE_URL);

  try {
    const sessionRows = await sql`
      SELECT r.id, r.subscription_status, r.photos
      FROM sessions s JOIN restaurants r ON r.id = s.restaurant_id
      WHERE s.token = ${token} AND s.expires_at > now()
    `;
    const restaurant = sessionRows[0];
    if (!restaurant) return res.status(401).json({ error: "Session expired, please log in again" });
    if (restaurant.subscription_status !== "active") {
      return res.status(402).json({ error: "An active subscription is required to manage photos." });
    }

    const currentPhotos = restaurant.photos || [];
    if (!currentPhotos.includes(photoUrl)) {
      return res.status(404).json({ error: "That photo isn't in your gallery." });
    }

    try {
      await del(photoUrl);
    } catch (blobErr) {
      // If it's already gone from Blob storage for some reason, still
      // proceed to remove it from the DB record rather than leaving a
      // dangling reference the owner can't clear.
      console.error("delete-photo blob delete warning:", blobErr);
    }

    const updatedPhotos = currentPhotos.filter((p) => p !== photoUrl);
    await sql`
      UPDATE restaurants SET photos = ${JSON.stringify(updatedPhotos)}::jsonb WHERE id = ${restaurant.id}
    `;

    return res.status(200).json({ success: true, photos: updatedPhotos });
  } catch (err) {
    console.error("delete-photo error:", err); // keep detail server-side only
    return res.status(500).json({ error: "Photo deletion failed" });
  }
}
