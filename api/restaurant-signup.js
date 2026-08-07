// POST /api/restaurant-signup
// Body: { name, email, password, placeId }
// Creates a new restaurant account with a random per-user salt and scrypt
// password hash, then logs the restaurant in immediately (same as
// restaurant-login.js) by issuing a session token.
import { neon } from "@neondatabase/serverless";
import crypto from "crypto";
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
const MIN_PASSWORD_LENGTH = 8;

export default async function handler(req, res) {
  setCors(req, res);
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Use POST" });

  const { name, email, password, placeId } = req.body || {};

  if (!name || !email || !password) {
    return res.status(400).json({ error: "name, email and password are required" });
  }
  if (!EMAIL_RE.test(email)) {
    return res.status(400).json({ error: "Please enter a valid email address" });
  }
  if (password.length < MIN_PASSWORD_LENGTH) {
    return res.status(400).json({ error: `Password must be at least ${MIN_PASSWORD_LENGTH} characters` });
  }
  if (name.length > 200) {
    return res.status(400).json({ error: "Restaurant name is too long" });
  }

  const sql = neon(process.env.DATABASE_URL);
  const ip = getClientIp(req);

  // Rate limit signups by IP to slow down mass fake-account creation.
  // (No per-email limit here, unlike login — an attacker can't "guess"
  // their way into owning an email via signup, since it's a one-shot
  // create, not a repeated auth check.)
  const ipAllowed = await checkRateLimit(sql, `signup-ip:${ip}`, 10, 3600);
  if (!ipAllowed) {
    return res.status(429).json({ error: "Too many signup attempts. Please wait a while and try again." });
  }

  try {
    const existing = await sql`SELECT id FROM restaurants WHERE owner_email = ${email.toLowerCase()}`;
    if (existing.length) {
      // Deliberately vague — don't confirm/deny which emails already have
      // accounts to a caller who isn't authenticated as that account.
      return res.status(409).json({ error: "An account with that email already exists. Try logging in instead." });
    }

    const salt = crypto.randomBytes(16).toString("hex");
    const hash = crypto.scryptSync(password, salt, 64).toString("hex");

    const rows = await sql`
      INSERT INTO restaurants (name, owner_email, password_hash, password_salt, place_id, subscription_status)
      VALUES (${name}, ${email.toLowerCase()}, ${hash}, ${salt}, ${placeId || null}, 'inactive')
      RETURNING id, name, owner_email
    `;
    const restaurant = rows[0];

    const token = crypto.randomBytes(32).toString("hex");
    const expiresAt = new Date(Date.now() + 1000 * 60 * 60 * 24 * 7); // 7 days
    await sql`
      INSERT INTO sessions (token, restaurant_id, expires_at)
      VALUES (${token}, ${restaurant.id}, ${expiresAt.toISOString()})
    `;

    return res.status(201).json({
      token,
      restaurant: { id: restaurant.id, name: restaurant.name, owner_email: restaurant.owner_email },
    });
  } catch (err) {
    console.error("restaurant-signup error:", err); // keep detail server-side only
    // Neon/Postgres unique-constraint violation, in case two signups race
    // each other for the same email between our existence check and insert.
    if (err.message && err.message.includes("duplicate key")) {
      return res.status(409).json({ error: "An account with that email already exists. Try logging in instead." });
    }
    return res.status(500).json({ error: "Signup failed" });
  }
}
