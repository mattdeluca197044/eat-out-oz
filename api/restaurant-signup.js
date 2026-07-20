// POST /api/restaurant-signup
// Body: { name, email, password, placeId (optional) }

import { neon } from "@neondatabase/serverless";
import crypto from "crypto";

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Use POST" });

  const { name, email, password, placeId } = req.body || {};

  if (!name || !email || !password) {
    return res.status(400).json({ error: "name, email and password are required" });
  }
  if (password.length < 8) {
    return res.status(400).json({ error: "Password must be at least 8 characters" });
  }

  const sql = neon(process.env.DATABASE_URL);

  try {
    const existing = await sql`SELECT id FROM restaurants WHERE owner_email = ${email.toLowerCase()}`;
    if (existing.length) {
      return res.status(409).json({ error: "An account with that email already exists" });
    }

    const salt = crypto.randomBytes(16).toString("hex");
    const hash = crypto.scryptSync(password, salt, 64).toString("hex");

    const [restaurant] = await sql`
      INSERT INTO restaurants (name, place_id, owner_email, password_hash, password_salt)
      VALUES (${name}, ${placeId || null}, ${email.toLowerCase()}, ${hash}, ${salt})
      RETURNING id, name, owner_email
    `;

    return res.status(201).json({ restaurant });
  } catch (err) {
    return res.status(500).json({ error: "Signup failed", detail: err.message });
  }
}
