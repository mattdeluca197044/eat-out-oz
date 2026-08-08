// GET /api/search?suburb=Newtown&category=restaurant

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
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
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

// State name + a fallback "centre point" (capital city) used only when the
// visitor's own coordinates aren't available (e.g. local dev, or a rare
// request with no geo headers at all).
const STATE_INFO = {
  NSW: { name: "New South Wales", lat: -33.8688, lng: 151.2093 },
  VIC: { name: "Victoria", lat: -37.8136, lng: 144.9631 },
  QLD: { name: "Queensland", lat: -27.4698, lng: 153.0251 },
  WA:  { name: "Western Australia", lat: -31.9505, lng: 115.8605 },
  SA:  { name: "South Australia", lat: -34.9285, lng: 138.6007 },
  TAS: { name: "Tasmania", lat: -42.8821, lng: 147.3272 },
  ACT: { name: "Australian Capital Territory", lat: -35.2809, lng: 149.1300 },
  NT:  { name: "Northern Territory", lat: -12.4634, lng: 130.8456 },
};
const DEFAULT_STATE = "NSW"; // used when we truly have no geo signal at all

// Vercel automatically attaches geolocation headers (derived from the
// visitor's IP) to every request in production — no browser permission
// prompt needed, and no extra API call. These are absent when running
// locally, so we fall back to a sensible default in that case.
function getVisitorLocation(req) {
  const country = req.headers["x-vercel-ip-country"];
  const regionCode = (req.headers["x-vercel-ip-country-region"] || "").toUpperCase();
  const headerLat = parseFloat(req.headers["x-vercel-ip-latitude"]);
  const headerLng = parseFloat(req.headers["x-vercel-ip-longitude"]);

  const stateCode = (country === "AU" && STATE_INFO[regionCode]) ? regionCode : DEFAULT_STATE;
  const state = STATE_INFO[stateCode];

  const hasPreciseCoords = Number.isFinite(headerLat) && Number.isFinite(headerLng);
  return {
    stateCode,
    stateName: state.name,
    lat: hasPreciseCoords ? headerLat : state.lat,
    lng: hasPreciseCoords ? headerLng : state.lng,
  };
}

export default async function handler(req, res) {
  setCors(req, res);
  if (req.method === "OPTIONS") return res.status(204).end();

  const { suburb, category, cuisine } = req.query;

  if (!suburb || !suburb.trim()) {
    return res.status(400).json({ error: "Missing 'suburb' query parameter" });
  }
  if (suburb.length > 100) {
    return res.status(400).json({ error: "Suburb name too long" });
  }

  const key = process.env.GOOGLE_PLACES_API_KEY;
  if (!key) {
    return res.status(500).json({ error: "Server is missing GOOGLE_PLACES_API_KEY" });
  }

  const sql = neon(process.env.DATABASE_URL);
  const ip = getClientIp(req);

  const allowed = await checkRateLimit(sql, `search:${ip}`, 40, 60);
  if (!allowed) {
    return res.status(429).json({ error: "Too many requests. Please slow down and try again shortly." });
  }

  const categoryTerm =
    category === "cafe" ? "cafes" :
    category === "takeaway" ? "takeaway food" :
    category === "pub" ? "pub restaurants" :
    category === "club" ? "licensed club" :
    category === "hatted" ? "award winning fine dining restaurant" :
    "restaurants";

  const cuisinePrefix = cuisine && cuisine.trim() ? `${cuisine.trim().slice(0, 40)} ` : "";

  // Detect which Australian state the visitor is in — currently only
  // returned in the response for potential future use (e.g. client-side
  // sorting), not used to constrain the Google query itself. Earlier
  // attempts to bias the Places API call using location+radius+region
  // caused Google to return zero results for otherwise-valid searches
  // (Text Search doesn't reliably treat these as a pure ranking bias in
  // practice, despite the docs describing them that way) — so the fix for
  // the original wrong-country-results bug is just the plain ", Australia"
  // suffix below, backed up by the address filter further down.
  const visitor = getVisitorLocation(req);
  const query = `${cuisinePrefix}${categoryTerm} in ${suburb}, Australia`;

  const baseUrl =
    `https://maps.googleapis.com/maps/api/place/textsearch/json` +
    `?query=${encodeURIComponent(query)}` +
    `&key=${key}`;

  const wantFull = req.query.full === "1";
  const MAX_PAGES = wantFull ? 3 : 2;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  try {
    let allResults = [];
    let nextPageToken = null;
    let page = 0;

    do {
      const pageUrl = nextPageToken ? `${baseUrl}&pagetoken=${nextPageToken}` : baseUrl;
      if (nextPageToken) await sleep(2000);

      const response = await fetch(pageUrl);
      const data = await response.json();

      if (data.status !== "OK" && data.status !== "ZERO_RESULTS") {
        if (allResults.length) break;
        return res.status(502).json({ error: "Places API error", status: data.status, message: data.error_message });
      }

      const pageResults = data.results || [];
      allResults = allResults.concat(pageResults);
      page++;

      const pageWasFull = pageResults.length === 20;
      nextPageToken = pageWasFull ? (data.next_page_token || null) : null;
      if (!wantFull && page >= 2) break;
    } while (nextPageToken && page < MAX_PAGES);

    function extractSuburb(address) {
      if (!address) return null;
      // Australian addresses from Google typically look like:
      // "294 King St, Newtown NSW 2042, Australia"
      const match = address.match(/,\s*([A-Za-z\s'-]+?)\s+(NSW|VIC|QLD|WA|SA|TAS|ACT|NT)\s+\d{4}/);
      return match ? match[1].trim() : null;
    }

    // Belt-and-braces filter: drop any result whose formatted_address doesn't
    // end in "Australia" at all. location/radius bias makes these rare, but
    // Text Search can still occasionally surface an unrelated overseas match
    // for an ambiguous suburb name — this catches anything that slips through.
    let results = allResults
      .filter((place) => (place.formatted_address || "").includes("Australia"))
      .map((place) => ({
        name: place.name,
        address: place.formatted_address,
        suburb: extractSuburb(place.formatted_address),
        rating: place.rating ?? null,
        reviews: place.user_ratings_total ?? 0,
        priceLevel: place.price_level ?? null,
        placeId: place.place_id,
        lat: place.geometry?.location?.lat ?? null,
        lng: place.geometry?.location?.lng ?? null,
        openNow: place.opening_hours?.open_now ?? null,
        types: place.types || [],
        cuisine: cuisine && cuisine.trim() ? cuisine.trim() : null,
      }));

    if (cuisine && cuisine.trim()) {
      const requested = cuisine.trim().toLowerCase();

      // Google's legacy Places Text Search doesn't return a reliable
      // cuisine field — the only signal available is the business's name
      // text. The previous approach kept a result unless its name
      // mentioned a *different* cuisine, which meant any generically-named
      // place (no cuisine word at all) slipped through unfiltered — that
      // was the cause of unrelated results showing up in, e.g., a
      // "Lebanese" search. This requires a positive match instead: the
      // name has to actually contain the requested cuisine or a synonym.
      // Trade-off: a genuinely-Lebanese restaurant with a name that
      // doesn't mention "Lebanese" (e.g. a proper-noun name) may now be
      // missed — but that's a much better failure mode than showing
      // unrelated restaurants under the wrong cuisine.
      const CUISINE_SYNONYMS = {
        italian: ["italian", "pizzeria", "trattoria", "osteria", "ristorante"],
        thai: ["thai"],
        chinese: ["chinese", "cantonese", "szechuan", "sichuan", "dim sum"],
        japanese: ["japanese", "sushi", "ramen", "izakaya", "yakitori", "teppanyaki"],
        indian: ["indian", "tandoori", "punjabi", "curry"],
        mexican: ["mexican", "taqueria", "cantina"],
        vietnamese: ["vietnamese", "pho", "banh mi"],
        korean: ["korean", "k-bbq", "kbbq"],
        lebanese: ["lebanese", "lebnani", "levantine"],
        greek: ["greek", "souvlaki", "taverna"],
        "modern australian": ["modern australian"],
        seafood: ["seafood", "fish market", "oyster"],
        vegan: ["vegan", "plant based", "plant-based"],
        pizza: ["pizza", "pizzeria"],
        burger: ["burger"],
        french: ["french", "brasserie", "bistro"],
        spanish: ["spanish", "tapas"],
        turkish: ["turkish", "kebab"],
        malaysian: ["malaysian", "malaysia"],
        indonesian: ["indonesian", "indonesia"],
        american: ["american", "diner"],
      };
      const synonyms = CUISINE_SYNONYMS[requested] || [requested];

      results = results.filter((r) => {
        const text = r.name.toLowerCase();
        return synonyms.some((s) => text.includes(s));
      });
    }

    res.setHeader("Cache-Control", "s-maxage=3600, stale-while-revalidate=86400");
    return res.status(200).json({
      query,
      detectedState: visitor.stateCode,
      count: results.length,
      results,
    });
  } catch (err) {
    console.error("search error:", err); // keep detail server-side only
    return res.status(500).json({ error: "Upstream fetch failed" });
  }
}
