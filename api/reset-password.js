// POST /api/reset-password
// Body: { token, newPassword }
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

const MIN_PASSWORD_LENGTH = 8;

export default async function handler(req, res) {
  setCors(req, res);
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Use POST" });

  const { token, newPassword } = req.body || {};
  if (!token || typeof token !== "string") {
    return res.status(400).json({ error: "Missing reset token" });
  }
  if (!newPassword || newPassword.length < MIN_PASSWORD_LENGTH) {
    return res.status(400).json({ error: `Password must be at least ${MIN_PASSWORD_LENGTH} characters` });
  }

  const sql = neon(process.env.DATABASE_URL);
  const ip = getClientIp(req);

  const ipAllowed = await checkRateLimit(sql, `reset-pw-ip:${ip}`, 20, 3600);
  if (!ipAllowed) {
    return res.status(429).json({ error: "Too many attempts. Please wait a while and try again." });
  }

  try {
    const rows = await sql`
      SELECT id, restaurant_id, expires_at, used FROM password_resets WHERE token = ${token}
    `;
    const resetRow = rows[0];

    if (!resetRow || resetRow.used || new Date(resetRow.expires_at) < new Date()) {
      return res.status(400).json({ error: "This reset link is invalid or has expired. Please request a new one." });
    }

    const salt = crypto.randomBytes(16).toString("hex");
    const hash = crypto.scryptSync(newPassword, salt, 64).toString("hex");

    await sql`
      UPDATE restaurants SET password_hash = ${hash}, password_salt = ${salt} WHERE id = ${resetRow.restaurant_id}
    `;
    await sql`
      UPDATE password_resets SET used = true WHERE id = ${resetRow.id}
    `;
    // Invalidate all existing sessions for this account — if someone else
    // had access to the old password (which is exactly the scenario a
    // password reset is meant to recover from), this signs them out too.
    await sql`
      DELETE FROM sessions WHERE restaurant_id = ${resetRow.restaurant_id}
    `;

    return res.status(200).json({ success: true });
  } catch (err) {
    console.error("reset-password error:", err); // keep detail server-side only
    return res.status(500).json({ error: "Password reset failed" });
  }
}
