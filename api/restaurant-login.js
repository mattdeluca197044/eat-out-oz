// POST /api/restaurant-login
// Body: { email, password }
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

// A fixed dummy salt used only when no account exists for the given email.
// This makes the scrypt hashing step run either way, so a non-existent
// email doesn't return measurably faster than a wrong password for a real
// account — closing off email-enumeration-by-timing.
const DUMMY_SALT = "dummy_salt_for_timing_consistency_only";

// Compares two hex-encoded hashes in constant time. A plain !== comparison
// can exit early on the first mismatched byte, which is a (minor) timing
// side-channel; timingSafeEqual avoids that.
function hashesMatch(hashHex, storedHashHex) {
  if (!storedHashHex) return false;
  const a = Buffer.from(hashHex, "hex");
  const b = Buffer.from(storedHashHex, "hex");
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

export default async function handler(req, res) {
  setCors(req, res);
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Use POST" });
  const { email, password } = req.body || {};
  if (!email || !password) {
    return res.status(400).json({ error: "email and password are required" });
  }
  const sql = neon(process.env.DATABASE_URL);
  const ip = getClientIp(req);
  // Limit by IP (stop brute force sweeps) AND by email (stop targeted attacks on one account)
  const ipAllowed = await checkRateLimit(sql, `login-ip:${ip}`, 15, 300);
  const emailAllowed = await checkRateLimit(sql, `login-email:${email.toLowerCase()}`, 8, 300);
  if (!ipAllowed || !emailAllowed) {
    return res.status(429).json({ error: "Too many login attempts. Please wait a few minutes and try again." });
  }
  try {
    const rows = await sql`SELECT * FROM restaurants WHERE owner_email = ${email.toLowerCase()}`;
    const restaurant = rows[0];

    // Always hash, even if no account exists, using a dummy salt in that
    // case — keeps the response time consistent so an attacker can't infer
    // which emails are registered from how fast the response comes back.
    const saltToUse = restaurant?.password_salt || DUMMY_SALT;
    const hash = crypto.scryptSync(password, saltToUse, 64).toString("hex");

    if (!restaurant || !hashesMatch(hash, restaurant.password_hash)) {
      return res.status(401).json({ error: "Invalid email or password" });
    }

    const token = crypto.randomBytes(32).toString("hex");
    const expiresAt = new Date(Date.now() + 1000 * 60 * 60 * 24 * 7); // 7 days
    await sql`
      INSERT INTO sessions (token, restaurant_id, expires_at)
      VALUES (${token}, ${restaurant.id}, ${expiresAt.toISOString()})
    `;
    return res.status(200).json({
      token,
      restaurant: { id: restaurant.id, name: restaurant.name, owner_email: restaurant.owner_email },
    });
  } catch (err) {
    console.error("restaurant-login error:", err); // keep detail server-side only
    return res.status(500).json({ error: "Login failed" });
  }
}
