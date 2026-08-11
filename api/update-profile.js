// POST /api/update-profile
// Headers: Authorization: Bearer <token>
// Body: { name, address, hours, description, instagramUrl, facebookUrl, websiteUrl, currentSpecial }
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

// Same day-name format already used everywhere else on the site (the
// static sample DATA, and the "Today: {hours}" line on live listings) —
// keeping this consistent means the public site can display custom_hours
// with zero extra parsing logic, just a straight lookup by today's name.
const DAY_NAMES = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
const MAX_HOURS_STRING_LENGTH = 50;

// Validates a submitted hours object without trusting its shape — a
// malformed or malicious payload here would otherwise get stored as-is
// and rendered directly into the public listing page.
function validateHours(hours) {
  if (hours === null || hours === undefined) return { valid: true, value: null };
  if (typeof hours !== "object" || Array.isArray(hours)) {
    return { valid: false, error: "Hours must be an object keyed by day name." };
  }
  const cleaned = {};
  for (const [day, value] of Object.entries(hours)) {
    if (!DAY_NAMES.includes(day)) {
      return { valid: false, error: `"${day}" isn't a valid day name.` };
    }
    if (typeof value !== "string" || value.length > MAX_HOURS_STRING_LENGTH) {
      return { valid: false, error: `Hours for ${day} must be text under ${MAX_HOURS_STRING_LENGTH} characters.` };
    }
    cleaned[day] = value.trim();
  }
  return { valid: true, value: cleaned };
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

  const { name, address, hours, description, instagramUrl, facebookUrl, websiteUrl, currentSpecial } = req.body || {};

  // Unlike the optional social/description fields, a blank name would
  // break the restaurant's own listing entirely, so this one's required
  // rather than silently falling back to null like the others do.
  if (!name || !name.trim()) {
    return res.status(400).json({ error: "Restaurant name is required." });
  }
  if (name.length > 200) {
    return res.status(400).json({ error: "Restaurant name is too long (max 200 characters)" });
  }
  if (address && address.length > 300) {
    return res.status(400).json({ error: "Address is too long (max 300 characters)" });
  }
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
  const hoursCheck = validateHours(hours);
  if (!hoursCheck.valid) {
    return res.status(400).json({ error: hoursCheck.error });
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
      SET name = ${name.trim()},
          custom_address = ${address || null},
          custom_hours = ${hoursCheck.value ? JSON.stringify(hoursCheck.value) : null}::jsonb,
          description = ${description || null},
          instagram_url = ${instagramUrl || null},
          facebook_url = ${facebookUrl || null},
          website_url = ${websiteUrl || null},
          current_special = ${currentSpecial || null}
      WHERE id = ${restaurant.id}
    `;

    return res.status(200).json({ success: true });
  } catch (err) {
    console.error("update-profile error:", err); // keep detail server-side only
    return res.status(500).json({ error: "Update failed" });
  }
}
