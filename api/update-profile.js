// POST /api/update-profile
// Headers: Authorization: Bearer <token>
// Body: { description, instagramUrl, facebookUrl, websiteUrl }
// Only works for restaurants with an active subscription.

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

function isValidUrl(u) {
  if (!u) return true; // empty is fine, it's optional
  try {
    const parsed = new URL(u);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
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

  const { description, instagramUrl, facebookUrl, websiteUrl, currentSpecial } = req.body || {};

  if (description && description.length > 1000) {
    return res.status(400).json({ error: "Description is too long (max 1000 characters)" });
  }
  if (currentSpecial && currentSpecial.length > 200) {
    return res.status(400).json({ error: "Special/promotion text is too long (max 200 characters)" });
  }
  for (const [label, url] of [["Instagram", instagramUrl], ["Facebook", facebookUrl], ["Website", websiteUrl]]) {
    if (url && !isValidUrl(url)) {
      return res.status(400).json({ error: `${label} link doesn't look like a valid URL` });
    }
  }

  const sql = neon(process.env.DATABASE_URL);

  try {
    const sessionRows = await sql`
      SELECT r.id, r.subscription_status FROM sessions s
      JOIN restaurants r ON r.id = s.restaurant_id
      WHERE s.token = ${token} AND s.expires_at > now()
    `;
    const restaurant = sessionRows[0];
    if (!restaurant) return res.status(401).json({ error: "Session expired, please log in again" });

    if (restaurant.subscription_status !== "active") {
      return res.status(402).json({ error: "An active subscription is required to edit your profile." });
    }

    await sql`
      UPDATE restaurants
      SET description = ${description || null},
          instagram_url = ${instagramUrl || null},
          facebook_url = ${facebookUrl || null},
          website_url = ${websiteUrl || null},
          current_special = ${currentSpecial || null}
      WHERE id = ${restaurant.id}
    `;

    return res.status(200).json({ success: true });
  } catch (err) {
    return res.status(500).json({ error: "Update failed", detail: err.message });
  }
}
