// POST /api/update-place-id
// Headers: Authorization: Bearer <token>
// Body: { placeId }
// Links this restaurant account to a Google Place ID. Deliberately does NOT
// require an active subscription — a restaurant should be able to link
// their listing while setting up their account, before deciding to pay.

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

// Google Place IDs are alphanumeric plus "-" and "_", typically 25-30+
// characters. This is a loose sanity check, not a guarantee the ID is a
// real, existing place — Google itself is the source of truth for that.
const PLACE_ID_RE = /^[A-Za-z0-9_-]{10,255}$/;

// Google Place "types" that genuinely indicate a food/dining venue. Same
// check as restaurant-signup.js — this endpoint is the OTHER place a Place
// ID gets linked (an existing account changing/adding one later), so it
// needs the identical check, otherwise someone could just sign up without
// a Place ID and link a non-food business here instead, bypassing signup's
// check entirely.
const FOOD_PLACE_TYPES = ["restaurant", "cafe", "bar", "bakery", "meal_takeaway", "meal_delivery", "food", "night_club"];

async function isFoodVenue(placeId) {
  const key = process.env.GOOGLE_PLACES_API_KEY;
  if (!key) {
    console.error("GOOGLE_PLACES_API_KEY missing — skipping category check");
    return true; // fail open on missing config, same reasoning as restaurant-signup.js
  }
  try {
    const url = `https://maps.googleapis.com/maps/api/place/details/json?place_id=${encodeURIComponent(placeId)}&fields=types,name&key=${key}`;
    const res = await fetch(url);
    const data = await res.json();
    if (data.status !== "OK" || !data.result) return false;
    const types = data.result.types || [];
    return types.some((t) => FOOD_PLACE_TYPES.includes(t));
  } catch (err) {
    console.error("Category check failed:", err.message);
    return true; // fail open on a transient network/API error
  }
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

  const { placeId } = req.body || {};
  if (!placeId || typeof placeId !== "string" || !PLACE_ID_RE.test(placeId.trim())) {
    return res.status(400).json({ error: "Please enter a valid Google Places ID." });
  }
  const cleanPlaceId = placeId.trim();

  const isFood = await isFoodVenue(cleanPlaceId);
  if (!isFood) {
    return res.status(400).json({
      error: "That Google listing doesn't look like a restaurant, café, or similar food venue. Double-check the Place ID.",
    });
  }

  const sql = neon(process.env.DATABASE_URL);
  try {
    const sessionRows = await sql`
      SELECT r.id, r.place_id AS current_place_id FROM sessions s
      JOIN restaurants r ON r.id = s.restaurant_id
      WHERE s.token = ${token} AND s.expires_at > now()
    `;
    const restaurant = sessionRows[0];
    if (!restaurant) return res.status(401).json({ error: "Session expired, please log in again" });

    // Prevent two different accounts from linking the same listing — that
    // would make restaurant-by-place.js's match ambiguous (two rows for one
    // place_id), and could let one account see/edit data meant for another
    // business's claimed listing.
    const existingClaim = await sql`
      SELECT id FROM restaurants WHERE place_id = ${cleanPlaceId} AND id != ${restaurant.id}
    `;
    if (existingClaim.length) {
      return res.status(409).json({ error: "This listing has already been claimed by another account." });
    }

    // If this is actually a change (not just re-saving the same ID), reset
    // verification back to pending — an account previously approved for
    // one listing shouldn't automatically stay "approved" for a completely
    // different one it's never been reviewed against. Without this, a
    // legitimate-looking first listing could get approved, then get swapped
    // out for an unrelated or fraudulent one afterward with no further check.
    const isChange = restaurant.current_place_id !== cleanPlaceId;

    if (isChange) {
      await sql`
        UPDATE restaurants
        SET place_id = ${cleanPlaceId}, verification_status = 'pending'
        WHERE id = ${restaurant.id}
      `;
    } else {
      await sql`
        UPDATE restaurants SET place_id = ${cleanPlaceId} WHERE id = ${restaurant.id}
      `;
    }

    return res.status(200).json({ success: true, placeId: cleanPlaceId });
  } catch (err) {
    console.error("update-place-id error:", err); // keep detail server-side only
    return res.status(500).json({ error: "Update failed" });
  }
}
