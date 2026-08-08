// POST /api/upload-photo
// Headers: Authorization: Bearer <token>
// Body: { imageBase64: "data:image/jpeg;base64,...", filename?: "front-of-shop.jpg" }
// Only works for restaurants with an active subscription. Stores the image
// in Vercel Blob and appends its URL to the restaurant's photo gallery,
// capped at MAX_PHOTOS.
import { neon } from "@neondatabase/serverless";
import { put } from "@vercel/blob";

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

const MAX_PHOTOS = 5;
const MAX_BYTES = 5 * 1024 * 1024; // 5MB per photo
const ALLOWED_MIME_TYPES = ["image/jpeg", "image/jpg", "image/png", "image/webp"];

export default async function handler(req, res) {
  setCors(req, res);
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Use POST" });

  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res.status(401).json({ error: "Log in required" });
  }
  const token = authHeader.slice(7);

  const { imageBase64 } = req.body || {};
  if (!imageBase64 || typeof imageBase64 !== "string") {
    return res.status(400).json({ error: "No image provided" });
  }

  // Expect a data URL like "data:image/jpeg;base64,....". Validates the
  // mime type here rather than trusting a client-supplied filename/type.
  const match = imageBase64.match(/^data:(image\/[a-zA-Z]+);base64,(.+)$/);
  if (!match || !ALLOWED_MIME_TYPES.includes(match[1].toLowerCase())) {
    return res.status(400).json({ error: "Please upload a JPEG, PNG, or WebP image." });
  }
  const mimeType = match[1].toLowerCase();
  const buffer = Buffer.from(match[2], "base64");

  if (buffer.length > MAX_BYTES) {
    return res.status(400).json({ error: "Image is too large (max 5MB)." });
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
      return res.status(402).json({ error: "An active subscription is required to upload photos." });
    }

    const currentPhotos = restaurant.photos || [];
    if (currentPhotos.length >= MAX_PHOTOS) {
      return res.status(400).json({ error: `You've reached the ${MAX_PHOTOS}-photo limit. Delete a photo before adding another.` });
    }

    const ext = mimeType.split("/")[1];
    const blobPath = `restaurant-photos/${restaurant.id}-${Date.now()}.${ext}`;
    const blob = await put(blobPath, buffer, {
      access: "public",
      contentType: mimeType,
    });

    const updatedPhotos = [...currentPhotos, blob.url];
    await sql`
      UPDATE restaurants SET photos = ${JSON.stringify(updatedPhotos)}::jsonb WHERE id = ${restaurant.id}
    `;

    return res.status(200).json({ success: true, photos: updatedPhotos });
  } catch (err) {
    console.error("upload-photo error:", err); // keep detail server-side only
    return res.status(500).json({ error: "Photo upload failed" });
  }
}
