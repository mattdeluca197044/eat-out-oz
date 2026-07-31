// POST /api/book
// Body: { slotId, name, email, phone, partySize }

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
const FROM_ADDRESS = "outtoeat <bookings@outtoeat.com.au>";

function formatDate(raw) {
  const d = new Date(raw);
  return d.toLocaleDateString("en-AU", { weekday: "long", day: "numeric", month: "long", year: "numeric" });
}
function formatTime(raw) {
  const [h, m] = raw.split(":").map(Number);
  const period = h >= 12 ? "PM" : "AM";
  const hour12 = h % 12 === 0 ? 12 : h % 12;
  return `${hour12}:${String(m).padStart(2, "0")} ${period}`;
}

async function sendEmail({ to, subject, html }) {
  const key = process.env.RESEND_API_KEY;
  if (!key) {
    console.error("RESEND_API_KEY missing — skipping email send");
    return;
  }
  try {
    await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ from: FROM_ADDRESS, to, subject, html }),
    });
  } catch (err) {
    // Email failures should never break the booking itself — the booking is
    // already safely saved in the database at this point.
    console.error("Email send failed:", err.message);
  }
}

export default async function handler(req, res) {
  setCors(req, res);
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Use POST" });

  const { slotId, name, email, phone, partySize } = req.body || {};
  if (!slotId || !name || !email || !partySize) {
    return res.status(400).json({ error: "slotId, name, email and partySize are required" });
  }
  if (!EMAIL_RE.test(email)) {
    return res.status(400).json({ error: "Enter a valid email address" });
  }
  if (name.length > 200) return res.status(400).json({ error: "Name too long" });
  const party = parseInt(partySize, 10);
  if (!Number.isInteger(party) || party < 1 || party > 50) {
    return res.status(400).json({ error: "Party size must be between 1 and 50" });
  }

  const sql = neon(process.env.DATABASE_URL);
  const ip = getClientIp(req);

  const ipAllowed = await checkRateLimit(sql, `book-ip:${ip}`, 10, 300);
  const emailAllowed = await checkRateLimit(sql, `book-email:${email.toLowerCase()}`, 10, 3600);
  if (!ipAllowed || !emailAllowed) {
    return res.status(429).json({ error: "Too many booking attempts. Please wait a bit and try again." });
  }

  try {
    const [updatedSlot] = await sql`
      UPDATE time_slots
      SET booked_count = booked_count + 1
      WHERE id = ${slotId} AND booked_count < capacity
      RETURNING id, restaurant_id, slot_date, slot_time
    `;

    if (!updatedSlot) {
      return res.status(409).json({ error: "That time slot is no longer available. Please pick another." });
    }

    const [booking] = await sql`
      INSERT INTO bookings (slot_id, restaurant_id, customer_name, customer_email, customer_phone, party_size)
      VALUES (${updatedSlot.id}, ${updatedSlot.restaurant_id}, ${name.trim()}, ${email.toLowerCase()}, ${phone ? phone.trim().slice(0, 40) : null}, ${party})
      RETURNING id, status, created_at
    `;

    const [restaurant] = await sql`
      SELECT name, owner_email FROM restaurants WHERE id = ${updatedSlot.restaurant_id}
    `;

    const dateStr = formatDate(updatedSlot.slot_date);
    const timeStr = formatTime(updatedSlot.slot_time);

    // Fire both emails and wait for them — a serverless function can be
    // terminated right after the response is sent, so unwaited async work
    // (like these emails) could get cut off if we don't await it here.
    if (restaurant) {
      await Promise.all([
        sendEmail({
          to: email,
          subject: `Booking confirmed at ${restaurant.name}`,
          html: `
            <div style="font-family:sans-serif;max-width:480px;margin:0 auto;">
              <h2 style="color:#DE3937;">Booking confirmed</h2>
              <p>Hi ${name.trim()},</p>
              <p>Your table at <strong>${restaurant.name}</strong> is confirmed:</p>
              <table style="width:100%;border-collapse:collapse;margin:16px 0;">
                <tr><td style="padding:6px 0;color:#666;">Date</td><td style="padding:6px 0;font-weight:600;">${dateStr}</td></tr>
                <tr><td style="padding:6px 0;color:#666;">Time</td><td style="padding:6px 0;font-weight:600;">${timeStr}</td></tr>
                <tr><td style="padding:6px 0;color:#666;">Party size</td><td style="padding:6px 0;font-weight:600;">${party} guests</td></tr>
              </table>
              <p style="color:#666;font-size:13px;">Booked via outtoeat.com.au</p>
            </div>
          `,
        }),
        sendEmail({
          to: restaurant.owner_email,
          subject: `New booking: ${name.trim()} — ${dateStr} at ${timeStr}`,
          html: `
            <div style="font-family:sans-serif;max-width:480px;margin:0 auto;">
              <h2 style="color:#DE3937;">New booking</h2>
              <table style="width:100%;border-collapse:collapse;margin:16px 0;">
                <tr><td style="padding:6px 0;color:#666;">Name</td><td style="padding:6px 0;font-weight:600;">${name.trim()}</td></tr>
                <tr><td style="padding:6px 0;color:#666;">Date</td><td style="padding:6px 0;font-weight:600;">${dateStr}</td></tr>
                <tr><td style="padding:6px 0;color:#666;">Time</td><td style="padding:6px 0;font-weight:600;">${timeStr}</td></tr>
                <tr><td style="padding:6px 0;color:#666;">Party size</td><td style="padding:6px 0;font-weight:600;">${party} guests</td></tr>
                <tr><td style="padding:6px 0;color:#666;">Email</td><td style="padding:6px 0;font-weight:600;">${email}</td></tr>
                <tr><td style="padding:6px 0;color:#666;">Phone</td><td style="padding:6px 0;font-weight:600;">${phone || "—"}</td></tr>
              </table>
              <p style="color:#666;font-size:13px;">Manage this booking in your outtoeat partner portal.</p>
            </div>
          `,
        }),
      ]);
    }

    return res.status(201).json({
      booking,
      slot: { date: updatedSlot.slot_date, time: updatedSlot.slot_time },
    });
  } catch (err) {
    return res.status(500).json({ error: "Booking failed", detail: err.message });
  }
}
  
