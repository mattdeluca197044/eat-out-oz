// POST /api/generate-description
// Headers: Authorization: Bearer <token>
// Body: { cuisine, currentSpecial, keywords }
// Uses the restaurant's own saved name. Requires an active subscription
// (same gate as update-profile.js).

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

export default async function handler(req, res) {
  setCors(req, res);
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Use POST" });

  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res.status(401).json({ error: "Log in required" });
  }
  const token = authHeader.slice(7);

  const { cuisine, currentSpecial, keywords } = req.body || {};
  if (cuisine && cuisine.length > 100) {
    return res.status(400).json({ error: "Cuisine text too long (max 100 characters)" });
  }
  if (currentSpecial && currentSpecial.length > 200) {
    return res.status(400).json({ error: "Special/promotion text too long (max 200 characters)" });
  }
  if (keywords && keywords.length > 300) {
    return res.status(400).json({ error: "Keywords too long (max 300 characters)" });
  }

  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  if (!anthropicKey) {
    return res.status(500).json({ error: "Server is missing ANTHROPIC_API_KEY" });
  }

  const sql = neon(process.env.DATABASE_URL);

  try {
    const sessionRows = await sql`
      SELECT r.id, r.name, r.subscription_status FROM sessions s
      JOIN restaurants r ON r.id = s.restaurant_id
      WHERE s.token = ${token} AND s.expires_at > now()
    `;
    const restaurant = sessionRows[0];
    if (!restaurant) return res.status(401).json({ error: "Session expired, please log in again" });
    if (restaurant.subscription_status !== "active") {
      return res.status(402).json({ error: "An active subscription is required to use this feature." });
    }

    const allowed = await checkRateLimit(sql, `gen-desc:${restaurant.id}`, 10, 3600);
    if (!allowed) {
      return res.status(429).json({ error: "You've generated a few descriptions recently — please wait a bit and try again." });
    }

    const promptParts = [
      `Write a warm, appetizing restaurant description for a listing on a dining discovery website.`,
      `Restaurant name: ${restaurant.name}.`,
      cuisine && cuisine.trim() ? `Cuisine: ${cuisine.trim()}.` : null,
      currentSpecial && currentSpecial.trim() ? `Current special/promotion: ${currentSpecial.trim()}.` : null,
      keywords && keywords.trim() ? `The owner wants these points mentioned or reflected: ${keywords.trim()}.` : null,
      `Write 2-3 sentences, around 40-60 words. Plain text only, no markdown, no emojis, no hashtags. Do not claim any award, rating, or "award-winning" status. Do not invent specific menu items, prices, or facts not given above. Write it in third person, ready to paste directly onto the listing.`,
    ].filter(Boolean);

    const anthropicRes = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": anthropicKey,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 200,
        messages: [{ role: "user", content: promptParts.join("\n") }],
      }),
    });

    if (!anthropicRes.ok) {
      const errBody = await anthropicRes.text();
      console.error("generate-description Anthropic error:", anthropicRes.status, errBody);
      return res.status(502).json({ error: "Description generation failed, please try again." });
    }

    const anthropicData = await anthropicRes.json();
    const textBlock = (anthropicData.content || []).find((b) => b.type === "text");
    const description = (textBlock?.text || "").trim();

    if (!description) {
      return res.status(502).json({ error: "Description generation failed, please try again." });
    }

    return res.status(200).json({ description });
  } catch (err) {
    console.error("generate-description error:", err); // keep detail server-side only
    return res.status(500).json({ error: "Description generation failed" });
  }
}
