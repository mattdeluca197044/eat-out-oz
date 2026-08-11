// POST /api/delete-menu
// Headers: Authorization: Bearer <token>
// Removes the restaurant's currently-uploaded menu PDF, if any.

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
      return res.status(402).json({ error: "An active subscription is required to manage your menu." });
    }
    if (!restaurant.menu_url) {
      return res.status(400).json({ error: "No menu is currently uploaded." });
    }

    try {
      await del(restaurant.menu_url);
    } catch (cleanupErr) {
      console.error("Failed to delete menu blob:", cleanupErr); // proceed anyway — clearing the DB reference matters more than a leftover blob
    }

    await sql`UPDATE restaurants SET menu_url = NULL WHERE id = ${restaurant.id}`;

    return res.status(200).json({ success: true });
  } catch (err) {
    console.error("delete-menu error:", err); // keep detail server-side only
    return res.status(500).json({ error: "Failed to remove menu" });
  }
}
