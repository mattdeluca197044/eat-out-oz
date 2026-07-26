// POST /api/logout
// Headers: Authorization: Bearer <token>
// Deletes the session server-side so a stolen/old token stops working immediately,
// instead of just relying on the browser clearing it locally.

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

export default async function handler(req, res) {
  setCors(req, res);
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Use POST" });

  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res.status(200).json({ success: true }); // nothing to do
  }
  const token = authHeader.slice(7);

  const sql = neon(process.env.DATABASE_URL);
  try {
    await sql`DELETE FROM sessions WHERE token = ${token}`;
    return res.status(200).json({ success: true });
  } catch (err) {
    return res.status(500).json({ error: "Logout failed", detail: err.message });
  }
}
