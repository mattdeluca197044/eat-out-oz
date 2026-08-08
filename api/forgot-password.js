// POST /api/forgot-password
// Body: { email }
// Always returns the same generic success response, whether or not that
// email actually matches an account — this prevents someone from using
// this endpoint to check which restaurant emails are registered.
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
const FROM_ADDRESS = "outtoeat <bookings@outtoeat.com.au>"; // reusing the address already verified in Resend
const PORTAL_URL = "https://restaurant-portal-seven.vercel.app";
const RESET_TOKEN_TTL_MS = 1000 * 60 * 60; // 1 hour

async function sendEmail({ to, subject, html }) {
  const key = process.env.RESEND_API_KEY;
  if (!key) {
    console.error("RESEND_API_KEY missing — skipping email send");
    return;
  }
  try {
    await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from: FROM_ADDRESS, to, subject, html }),
    });
  } catch (err) {
    console.error("Email send failed:", err.message);
  }
}

export default async function handler(req, res) {
  setCors(req, res);
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Use POST" });

  const { email } = req.body || {};
  if (!email || !EMAIL_RE.test(email)) {
    return res.status(400).json({ error: "Enter a valid email address" });
  }

  const sql = neon(process.env.DATABASE_URL);
  const ip = getClientIp(req);

  const ipAllowed = await checkRateLimit(sql, `forgot-pw-ip:${ip}`, 10, 3600);
  const emailAllowed = await checkRateLimit(sql, `forgot-pw-email:${email.toLowerCase()}`, 5, 3600);
  if (!ipAllowed || !emailAllowed) {
    return res.status(429).json({ error: "Too many requests. Please wait a while and try again." });
  }

  // Same response either way — see note at top of file.
  const genericResponse = { message: "If an account exists with that email, a reset link has been sent." };

  try {
    const rows = await sql`SELECT id, name FROM restaurants WHERE owner_email = ${email.toLowerCase()}`;
    const restaurant = rows[0];

    if (restaurant) {
      const token = crypto.randomBytes(32).toString("hex");
      const expiresAt = new Date(Date.now() + RESET_TOKEN_TTL_MS);
      await sql`
        INSERT INTO password_resets (restaurant_id, token, expires_at)
        VALUES (${restaurant.id}, ${token}, ${expiresAt.toISOString()})
      `;

      const resetUrl = `${PORTAL_URL}/?reset=1&token=${token}`;
      await sendEmail({
        to: email,
        subject: "Reset your outtoeat partner portal password",
        html: `
          <div style="font-family:sans-serif;max-width:480px;margin:0 auto;">
            <h2 style="color:#DE3937;">Reset your password</h2>
            <p>We received a request to reset the password for <strong>${restaurant.name}</strong>'s outtoeat account.</p>
            <p><a href="${resetUrl}" style="display:inline-block;background:#DE3937;color:#fff;padding:12px 20px;border-radius:4px;text-decoration:none;font-weight:600;">Set a new password</a></p>
            <p style="color:#666;font-size:13px;">This link expires in 1 hour. If you didn't request this, you can safely ignore this email — your password won't change.</p>
          </div>
        `,
      });
    }
    // If no restaurant matched, we do nothing further but still return
    // the same generic response below.

    return res.status(200).json(genericResponse);
  } catch (err) {
    console.error("forgot-password error:", err); // keep detail server-side only
    // Still return the generic response even on an internal error, rather
    // than leaking that something went wrong specifically for this email.
    return res.status(200).json(genericResponse);
  }
}
