// POST /api/restaurant-login
// Body: { email, password }
// Returns: { token, restaurant }

import { neon } from "@neondatabase/serverless";
import crypto from "crypto";

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Use POST" });

  const { email, password } = req.body || {};
  if (!email || !password) {
    return res.status(400).json({ error: "email and password are required" });
  }

  const sql = neon(process.env.DATABASE_URL);

  try {
    const rows = await sql`SELECT * FROM restaurants WHERE owner_email = ${email.toLowerCase()}`;
    const restaurant = rows[0];
    if (!restaurant) {
      return res.status(401).json({ error: "Invalid email or password" });
    }

    const hash = crypto.scryptSync(password, restaurant.password_salt, 64).toString("hex");
    if (hash !== restaurant.password_hash) {
      return res.status(401).json({ error: "Invalid email or password" });
    }

    const token = crypto.randomBytes(32).toString("hex");
    const expiresAt = new Date(Date.now() + 1000 * 60 * 60 * 24 * 30); // 30 days

    await sql`
      INSERT INTO sessions (token, restaurant_id, expires_at)
      VALUES (${token}, ${restaurant.id}, ${expiresAt.toISOString()})
    `;

    return res.status(200).json({
      token,
      restaurant: { id: restaurant.id, name: restaurant.name, owner_email: restaurant.owner_email },
    });
  } catch (err) {
    return res.status(500).json({ error: "Login failed", detail: err.message });
  }
}
