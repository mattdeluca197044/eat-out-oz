// POST /api/chat
// Body: { mode: 'diner' | 'owner', message: string, history: [...], context: {...} }
// For mode 'owner', requires Authorization: Bearer <token> — same session
// tokens issued by restaurant-login.js.
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

// Looks up the Bearer token against the sessions table (the same table
// restaurant-login.js writes to) and returns the restaurant_id it belongs
// to, or null if the token is missing, unknown, or expired.
async function getRestaurantIdFromAuth(sql, req) {
  const authHeader = req.headers.authorization || "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;
  if (!token) return null;

  const rows = await sql`
    SELECT restaurant_id FROM sessions
    WHERE token = ${token} AND expires_at > now()
  `;
  return rows[0]?.restaurant_id || null;
}

export default async function handler(req, res) {
  setCors(req, res);
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Use POST" });

  const { mode, message, history = [], context } = req.body || {};

  if (!message || typeof message !== "string" || !message.trim()) {
    return res.status(400).json({ error: "Message is required." });
  }

  const trimmedMessage = message.slice(0, 1000);
  const trimmedHistory = Array.isArray(history)
    ? history.slice(-10).filter(m => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string")
    : [];

  const sql = neon(process.env.DATABASE_URL);
  const ip = getClientIp(req);

  let systemPrompt;

  if (mode === "owner") {
    // Owner mode requires a valid, unexpired session — this is the same
    // check your other authenticated endpoints rely on, and stops anyone
    // from hitting this endpoint (and burning your Anthropic API credits)
    // without actually being logged in.
    const restaurantId = await getRestaurantIdFromAuth(sql, req);
    if (!restaurantId) {
      return res.status(401).json({ error: "Please log in again." });
    }

    // Rate limit per restaurant, not just per IP — several staff on the
    // same connection shouldn't all get throttled by one busy account.
    const allowed = await checkRateLimit(sql, `chat-owner:${restaurantId}`, 30, 300);
    if (!allowed) {
      return res.status(429).json({ error: "Too many messages — please wait a moment and try again." });
    }

    systemPrompt = `You are a helpful assistant inside the outtoeat restaurant partner portal. You help restaurant owners understand their listing, bookings, and stats, and answer questions about how the portal works.

Here is this restaurant's CURRENT data, exactly as it stands right now:
${JSON.stringify(context)}

This data can change between turns (e.g. after they save a profile edit or a booking comes in). It always overrides anything said earlier in this conversation, including your own previous replies — if something conflicts with an earlier turn, trust the data above.

Be concise and specific, using the data above where relevant. If asked about something you don't have data for (e.g. billing details, payment methods), say you're not sure and suggest they contact support rather than guessing.`;
  } else {
    // Diner mode is public (no login required), so rate limit by IP only.
    const allowed = await checkRateLimit(sql, `chat-diner:${ip}`, 20, 300);
    if (!allowed) {
      return res.status(429).json({ error: "Too many messages — please wait a moment and try again." });
    }

    systemPrompt = `You are outtoeat's dining assistant, helping people find a restaurant, café, or takeaway spot in Sydney.

The context below is split into two groups:

"topMatches" — every listing that genuinely matches what they asked for (by name, cuisine, or suburb): ${JSON.stringify(context?.topMatches || [])}

"otherListings" — everything else currently available, for broader browsing or as a fallback if topMatches is empty: ${JSON.stringify(context?.otherListings || [])}

IMPORTANT: The app will separately display the full list of topMatches to the person as its own results list right under your reply — you do NOT need to (and should NOT) name or enumerate them yourself. Your job is just to write a short, warm, conversational lead-in: 1–2 sentences. If topMatches is non-empty, say something like how many good options there are, or note something useful (e.g. several are open right now), then let the results list below do the rest. If topMatches is empty, say plainly that nothing matches exactly, and suggest browsing otherListings instead, naming a couple of those by name since they won't be shown separately.

Never invent a restaurant that isn't in either list above. Keep your reply brief — this is a lead-in, not the full answer.`;
  }

  try {
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": process.env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-6",
        max_tokens: 500,
        temperature: 0.2, // favor consistent, grounded answers over creative variation
        system: systemPrompt,
        messages: [...trimmedHistory, { role: "user", content: trimmedMessage }],
      }),
    });

    const data = await response.json();

    if (!response.ok) {
      console.error("Anthropic API error:", data);
      return res.status(502).json({ error: "The assistant is temporarily unavailable — please try again shortly." });
    }

    const reply = data.content?.find(block => block.type === "text")?.text
      || "Sorry, I didn't quite catch that — could you rephrase?";

    return res.status(200).json({
      reply,
      topMatches: mode === "diner" ? (context?.topMatches || []) : undefined,
    });
  } catch (err) {
    console.error("chat handler error:", err);
    return res.status(500).json({ error: "Something went wrong on our end." });
  }
}
