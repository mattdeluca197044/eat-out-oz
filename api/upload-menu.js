// POST /api/upload-menu
// Headers: Authorization: Bearer <token>
// Body: { pdfBase64: "data:application/pdf;base64,..." }
// Only works for restaurants with an active subscription. Stores the PDF
// in Vercel Blob and sets it as the restaurant's single menu file,
// replacing (and deleting) any previous one.

import { neon } from "@neondatabase/serverless";
import { put, del } from "@vercel/blob";

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

// Menus are typically a few pages of scanned/designed content, so this
// allows a larger file than a single photo (5MB) — 10MB comfortably
// covers a multi-page PDF without inviting genuinely oversized uploads.
const MAX_BYTES = 10 * 1024 * 1024;

export default async function handler(req, res) {
  setCors(req, res);
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Use POST" });

  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res.status(401).json({ error: "Log in required" });
  }
  const token = authHeader.slice(7);

  const { pdfBase64 } = req.body || {};
  if (!pdfBase64 || typeof pdfBase64 !== "string") {
    return res.status(400).json({ error: "No file provided" });
  }

  // Validates the mime type from the data URL itself rather than trusting
  // a client-supplied filename/extension — same approach as upload-photo.js.
  const match = pdfBase64.match(/^data:(application\/pdf);base64,(.+)$/);
  if (!match) {
    return res.status(400).json({ error: "Please upload a PDF file." });
  }
  const buffer = Buffer.from(match[2], "base64");
  if (buffer.length > MAX_BYTES) {
    return res.status(400).json({ error: "File is too large (max 10MB)." });
  }

  const sql = neon(process.env.DATABASE_URL);
  try {
    const sessionRows = await sql`
      SELECT r.id, r.subscription_status, r.menu_url
      FROM sessions s JOIN restaurants r ON r.id = s.restaurant_id
      WHERE s.token = ${token} AND s.expires_at > now()
    `;
    const restaurant = sessionRows[0];
    if (!restaurant) return res.status(401).json({ error: "Session expired, please log in again" });
    if (restaurant.subscription_status !== "active") {
      return res.status(402).json({ error: "An active subscription is required to upload a menu." });
    }

    const blobPath = `restaurant-menus/${restaurant.id}-${Date.now()}.pdf`;
    const blob = await put(blobPath, buffer, {
      access: "public",
      contentType: "application/pdf",
    });

    // Clean up the old file so storage doesn't quietly accumulate an
    // orphaned PDF every time a restaurant replaces their menu. Best-effort
    // — if the old blob is already gone for any reason, that's fine, the
    // new one still gets saved.
    if (restaurant.menu_url) {
      try {
        await del(restaurant.menu_url);
      } catch (cleanupErr) {
        console.error("Failed to delete old menu blob:", cleanupErr);
      }
    }

    await sql`UPDATE restaurants SET menu_url = ${blob.url} WHERE id = ${restaurant.id}`;

    return res.status(200).json({ success: true, menuUrl: blob.url });
  } catch (err) {
    console.error("upload-menu error:", err); // keep detail server-side only
    return res.status(500).json({ error: "Menu upload failed" });
  }
}
