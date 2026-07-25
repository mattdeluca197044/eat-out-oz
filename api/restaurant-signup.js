// POST /api/restaurant-signup
// Body: { name, email, password, placeId (optional) }

import { neon } from "@neondatabase/serverless";
import crypto from "crypto";

const ALLOWED_ORIGINS = [
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
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

function getClientIp(req) {
  const fwd = req.headers["x-forwarded-for"];
  return (fwd ? fwd.split(",")[0].trim() : req.socket?.remoteAddress) || "unknown";
}

async function checkRateLimit(sql, key, maxRequests, windowSeconds) {
  const now = new Date();
  const rows = await sql`SELECT window_start, count FROM rate_limits WHERE id = ${key}`;
  if (!rows.length) {
    await sql`INSERT INTO rate_limits (id, window_start, count) VALUES (${key}, ${now.toISOString()}, 1)
      ON CONFLICT (id) DO UPDATE SET window_start = ${now.toISOString()}, count = 1`;
    return true;
  }
  const elapsed = (now - new Date(rows[0].window_start)) / 1000;
  if (elapsed > windowSeconds) {
    await sql`UPDATE rate_limits SET window_start = ${now.toISOString()}, count = 1 WHERE id = ${key}`;
    return true;
  }
  if (rows[0].count >= maxRequests) return false;
  await sql`UPDATE rate_limits SET count = count + 1 WHERE id = ${key}`;
  return true;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export default async function handler(req, res) {
  setCors(req, res);
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Use POST" });

  const { name, email, password, placeId } = req.body || {};

  if (!name || !email || !password) {
    return res.status(400).json({ error: "name, email and password are required" });
  }
  if (name.length > 200) return res.status(400).json({ error: "Restaurant name too long" });
  if (!EMAIL_RE.test(email)) return res.status(400).json({ error: "Enter a valid email address" });
  if (password.length < 8 || password.length > 200) {
    return res.status(400).json({ error: "Password must be between 8 and 200 characters" });
  }

  const sql = neon(process.env.DATABASE_URL);
  const ip = getClientIp(req);

  const allowed = await checkRateLimit(sql, `signup:${ip}`, 5, 3600); // 5 signups per hour per IP
  if (!allowed) {
    return res.status(429).json({ error: "Too many signup attempts. Please try again later." });
  }

  try {
    const existing = await sql`SELECT id FROM restaurants WHERE owner_email = ${email.toLowerCase()}`;
    if (existing.length) {
      return res.status(409).json({ error: "An account with that email already exists" });
    }

    const salt = crypto.randomBytes(16).toString("hex");
    const hash = crypto.scryptSync(password, salt, 64).toString("hex");

    const [restaurant] = await sql`
      INSERT INTO restaurants (name, place_id, owner_email, password_hash, password_salt)
      VALUES (${name.trim()}, ${placeId ? placeId.trim().slice(0, 200) : null}, ${email.toLowerCase()}, ${hash}, ${salt})
      RETURNING id, name, owner_email
    `;

    return res.status(201).json({ restaurant });
  } catch (err) {
    return res.status(500).json({ error: "Signup failed", detail: err.message });
  }
}
