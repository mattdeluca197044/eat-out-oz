// POST /api/create-checkout-session
// Headers: Authorization: Bearer <token>
// Creates a Stripe Checkout session for the $29/month restaurant subscription
// and returns the URL to redirect the restaurant owner to.
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
// Server-side price reference — the client never supplies an amount, so
// there's no way to tamper with what gets charged.
const STRIPE_PRICE_ID = "price_1TzpatLJlEBY2b7SRGuKfmy4";
const PORTAL_URL = "https://restaurant-portal-seven.vercel.app";
export default async function handler(req, res) {
  setCors(req, res);
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Use POST" });
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res.status(401).json({ error: "Log in required" });
  }
  const token = authHeader.slice(7);
  const stripeKey = process.env.STRIPE_SECRET_KEY;
  if (!stripeKey) {
    return res.status(500).json({ error: "Server is missing STRIPE_SECRET_KEY" });
  }
  const sql = neon(process.env.DATABASE_URL);
  try {
    const sessionRows = await sql`
      SELECT r.id, r.name, r.owner_email, r.stripe_customer_id
      FROM sessions s JOIN restaurants r ON r.id = s.restaurant_id
      WHERE s.token = ${token} AND s.expires_at > now()
    `;
    const restaurant = sessionRows[0];
    if (!restaurant) return res.status(401).json({ error: "Session expired, please log in again" });
    const params = new URLSearchParams();
    params.append("mode", "subscription");
    params.append("line_items[0][price]", STRIPE_PRICE_ID);
    params.append("line_items[0][quantity]", "1");
    params.append("success_url", `${PORTAL_URL}/?checkout=success`);
    params.append("cancel_url", `${PORTAL_URL}/?checkout=cancelled`);
    params.append("client_reference_id", String(restaurant.id));
    params.append("metadata[restaurant_id]", String(restaurant.id));
    params.append("customer_email", restaurant.owner_email);
    if (restaurant.stripe_customer_id) {
      params.set("customer", restaurant.stripe_customer_id);
      params.delete("customer_email");
    }
    const stripeRes = await fetch("https://api.stripe.com/v1/checkout/sessions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${stripeKey}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: params.toString(),
    });
    const stripeData = await stripeRes.json();
    if (!stripeRes.ok) {
      console.error("Stripe checkout session error:", stripeData.error); // full detail server-side only
      // Stripe's own error message is written for end users (e.g. "your
      // card was declined") so it's fine to pass through, unlike internal
      // exception messages below.
      return res.status(502).json({ error: stripeData.error?.message || "Stripe error" });
    }
    return res.status(200).json({ url: stripeData.url });
  } catch (err) {
    console.error("create-checkout-session error:", err); // keep detail server-side only
    return res.status(500).json({ error: "Checkout session creation failed" });
  }
}
