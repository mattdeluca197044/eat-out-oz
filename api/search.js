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

// The frontend's single search box doubles as both a suburb field and a
// free-text field, so whatever's typed there gets sent as "suburb" even
// when it also contains the cuisine (e.g. someone selects "Lebanese" from
// the cuisine dropdown AND types "lebanese north parramatta"). Left as-is,
// that duplicated word ends up baked into the Google query text as
// "in lebanese north parramatta, Australia" — not a real place, so Google
// resolves nothing, the same failure mode as an outright wrong location.
// Stripping the selected cuisine word back out first turns it into the
// real, resolvable suburb "North Parramatta".
function stripCuisineFromSuburb(suburbText, cuisineText) {
  if (!cuisineText || !cuisineText.trim()) return suburbText;
  const escaped = cuisineText.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`\\b${escaped}\\b`, "gi");
  return suburbText.replace(re, "").replace(/\s+/g, " ").trim();
}

export default async function handler(req, res) {
  setCors(req, res);
  if (req.method === "OPTIONS") return res.status(204).end();

  const { suburb, category, cuisine, state } = req.query;

  const suburbTrimmed = (suburb || "").trim();
  const stateTrimmed = (state || "").trim().toUpperCase();

  if (!suburbTrimmed && !stateTrimmed) {
    return res.status(400).json({ error: "Provide a suburb or select a state" });
  }
  if (suburb && suburb.length > 100) {
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

  // Detect which Australian state the visitor is in. The query TEXT itself
  // never includes a hardcoded state name — that was tried previously and
  // broke otherwise-valid searches whenever geo-detection was imprecise or
  // the searched suburb was in a different state (e.g. "Manly, Victoria,
  // Australia" resolves to nothing, since Manly isn't in Victoria).
  //
  // location/radius below is a genuine ranking bias, not text baked into
  // the query, so it doesn't have that failure mode. It matters most when
  // the "suburb" the frontend sends isn't an actual place at all — e.g. a
  // cuisine word typed straight into the search box with no suburb chosen.
  // Google can't resolve "in lebanese, Australia" to anywhere, so without
  // a bias it falls back to a loose nationwide keyword match on business
  // names. With a location bias, that same unresolvable query still
  // anchors near the visitor instead of spanning the whole country.
  const visitor = getVisitorLocation(req);
  const cleanedSuburb = stripCuisineFromSuburb(suburbTrimmed, cuisine);

  // A user-selected state (from the frontend's state dropdown) is safe to
  // bake into the query text — unlike the earlier auto-detected visitor
  // state, this is a deliberate choice, so it can't mismatch the suburb
  // the way "Manly, Victoria" did (an auto-guess that happened to be
  // wrong). If no suburb was typed at all, the state alone still gives
  // Google a real, resolvable location to search within.
  const stateFullName = STATE_INFO[stateTrimmed]?.name || null;
  const locationPart = cleanedSuburb && stateFullName
    ? `${cleanedSuburb}, ${stateFullName}`
    : cleanedSuburb || stateFullName || "";

  // Deliberately NOT using "in {place}, Australia" phrasing — Google's Text
  // Search doesn't require that grammar, and forcing it breaks the query
  // whenever the typed term isn't a resolvable place (a business name like
  // "Al Aseel", a typo'd suburb, etc. — same failure mode as the earlier
  // "Manly, Victoria" bug, just triggered differently). Plain free-text
  // concatenation lets Google's own matching work against names, addresses,
  // and types alike, so it handles a suburb, a cuisine, or a business name
  // typed into the same search box.
  const fullQuery = locationPart
    ? `${cuisinePrefix}${categoryTerm} ${locationPart} Australia`
    : `${cuisinePrefix}${categoryTerm} Australia`;
  // Fallback used only if the full query above comes back completely empty.
  // Google's Text Search can fail to match anything when a query combines
  // too many distinct entities at once — cuisine + business name + suburb
  // together (confirmed in testing: "Lebanese restaurants al aseel
  // parramatta Australia" → zero results, even though dropping either the
  // cuisine word or the suburb individually finds the place fine). Rather
  // than trying to predict when that'll happen, retry once without the
  // cuisine word if the richer query finds nothing.
  const fallbackQuery = locationPart
    ? `${categoryTerm} ${locationPart} Australia`
    : `${categoryTerm} Australia`;

  const LOCATION_BIAS_RADIUS_METERS = 100000; // ~100km — metro-scale bias, not a hard boundary
  function buildUrl(queryText) {
    return (
      `https://maps.googleapis.com/maps/api/place/textsearch/json` +
      `?query=${encodeURIComponent(queryText)}` +
      `&location=${visitor.lat},${visitor.lng}` +
      `&radius=${LOCATION_BIAS_RADIUS_METERS}` +
      `&key=${key}`
    );
  }

  const wantFull = req.query.full === "1";
  const MAX_PAGES = wantFull ? 3 : 2;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // Runs the paginated fetch loop against a given query, returning either
  // the collected results or an upstream-error response to send straight
  // back to the client.
  async function fetchAllPages(queryText) {
    const baseUrl = buildUrl(queryText);
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
        return { allResults: null, errorStatus: data.status, errorMessage: data.error_message };
      }

      const pageResults = data.results || [];
      allResults = allResults.concat(pageResults);
      page++;

      const pageWasFull = pageResults.length === 20;
      nextPageToken = pageWasFull ? (data.next_page_token || null) : null;
      if (!wantFull && page >= 2) break;
    } while (nextPageToken && page < MAX_PAGES);

    return { allResults, errorStatus: null, errorMessage: null };
  }

  try {
    let { allResults, errorStatus, errorMessage } = await fetchAllPages(fullQuery);
    if (errorStatus) {
      return res.status(502).json({ error: "Places API error", status: errorStatus, message: errorMessage });
    }

    // The richer query (with cuisine) found nothing at all — retry once
    // without the cuisine word before giving up. Only kicks in when a
    // cuisine was actually specified and the first attempt was genuinely
    // empty, so it doesn't add latency to the common case.
    if (allResults.length === 0 && cuisinePrefix) {
      const fallback = await fetchAllPages(fallbackQuery);
      if (!fallback.errorStatus) {
        allResults = fallback.allResults;
      }
    }

    function extractSuburbAndState(address) {
      if (!address) return { suburb: null, state: null };
      // Australian addresses from Google typically look like:
      // "294 King St, Newtown NSW 2042, Australia"
      const match = address.match(/,\s*([A-Za-z\s'-]+?)\s+(NSW|VIC|QLD|WA|SA|TAS|ACT|NT)\s+\d{4}/);
      return match ? { suburb: match[1].trim(), state: match[2] } : { suburb: null, state: null };
    }

    // Belt-and-braces filter: drop any result whose formatted_address doesn't
    // end in "Australia" at all. Text Search can occasionally surface an
    // unrelated overseas match for an ambiguous suburb name — this catches
    // anything that slips through.
    let results = allResults
      .filter((place) => (place.formatted_address || "").includes("Australia"))
      .map((place) => {
        const { suburb: extractedSuburb, state } = extractSuburbAndState(place.formatted_address);
        return {
          name: place.name,
          address: place.formatted_address,
          suburb: extractedSuburb,
          state,
          rating: place.rating ?? null,
          reviews: place.user_ratings_total ?? 0,
          priceLevel: place.price_level ?? null,
          placeId: place.place_id,
          lat: place.geometry?.location?.lat ?? null,
          lng: place.geometry?.location?.lng ?? null,
          openNow: place.opening_hours?.open_now ?? null,
          types: place.types || [],
          cuisine: cuisine && cuisine.trim() ? cuisine.trim() : null,
        };
      });

    // Note: previously this filtered multi-state results down to just the
    // visitor's own state, to disambiguate a shared suburb name (Richmond,
    // Brighton, etc. exist in several states). That's now handled better
    // by the frontend's location picker — showing every matching branch
    // and letting the person choose — rather than silently hiding a
    // genuine other-state location (e.g. a national chain's Melbourne
    // branch showing up alongside its Sydney one). Removing the filter
    // here so the frontend actually has all the branches to choose from.

    if (cuisine && cuisine.trim()) {
      const requested = cuisine.trim().toLowerCase();

      // Google's legacy Places Text Search doesn't return a reliable
      // cuisine field, so any name-based filter here is a heuristic with
      // real trade-offs either way:
      //   - Requiring the name to POSITIVELY contain the cuisine word (an
      //     earlier version of this filter) wrongly excluded genuinely
      //     correct results with non-English business names, e.g. an
      //     Arabic-named Lebanese restaurant with no English cuisine word
      //     at all — confirmed happening in practice.
      //   - Doing no filtering at all risks completely unrelated results
      //     slipping through if Google's own text-search relevance is loose
      //     for a given query.
      // This strikes a middle ground: trust Google's relevance (helped by
      // the cuisine already being part of the query text sent to it), and
      // only exclude a result if its name explicitly signals a different,
      // conflicting cuisine — catching obvious mismatches without punishing
      // correctly-matched restaurants whose names just don't happen to
      // mention the cuisine in English.
      const KNOWN_CUISINES = [
        "italian", "thai", "chinese", "japanese", "indian", "mexican", "vietnamese",
        "korean", "lebanese", "greek", "seafood", "vegan", "pizza", "burger",
        "french", "spanish", "turkish", "malaysian", "indonesian", "american",
      ];
      // Pubs and licensed clubs are, almost by definition, general
      // multi-cuisine venues — a pub or club is rarely itself "a Lebanese
      // restaurant" even if Google's loose text relevance includes it for
      // a cuisine-prefixed query (confirmed happening: "Club Parramatta",
      // "LILYMU", "Ruse Bar and Brasserie" all surfaced under pub/club
      // category searches with no cuisine signal in their names at all).
      // That's different from restaurant/cafe/takeaway/hatted, where a
      // themed ethnic restaurant with no English cuisine word in its name
      // (e.g. "Al Aseel") is common and shouldn't be excluded. So: require
      // an explicit cuisine-word match for pub/club results specifically,
      // and keep the lighter conflict-only exclusion everywhere else.
      const requireExplicitMatch = category === "pub" || category === "club";

      // Generic Western multi-purpose dining branding — a themed ethnic
      // restaurant essentially never names itself this way (confirmed:
      // "Willo Restaurant & Bar" and "Ruse Bar and Brasserie" both fit this
      // pattern and are known-wrong for a Lebanese search). Applied
      // regardless of category, since the naming pattern itself is the
      // signal, not which category Google happened to file it under.
      const GENERIC_DINING_PHRASES = [
        "restaurant & bar", "restaurant and bar",
        "bar & grill", "bar and grill",
        "bar & bistro", "bar and bistro",
        "brasserie",
      ];

      results = results.filter((r) => {
        const text = r.name.toLowerCase();
        if (text.includes(requested)) return true;
        if (GENERIC_DINING_PHRASES.some((p) => text.includes(p))) return false;
        if (requireExplicitMatch) return false; // no cuisine word found, and this category needs one
        const conflictsWithOther = KNOWN_CUISINES.some((c) => c !== requested && text.includes(c));
        return !conflictsWithOther;
      });
    }

    // Shortened while actively iterating on search logic — a long cache
    // here was masking fixes behind stale 304 responses (a fixed query
    // would keep returning an old broken response for up to an hour after
    // each deploy, since Vercel's edge cache held onto it). 60 seconds is
    // enough to absorb rapid repeat requests without hiding future changes
    // for long. Worth raising again once the search logic has stabilised.
    res.setHeader("Cache-Control", "s-maxage=60, stale-while-revalidate=300");
    return res.status(200).json({
      query: fullQuery,
      detectedState: visitor.stateCode,
      count: results.length,
      results,
    });
  } catch (err) {
    console.error("search error:", err); // keep detail server-side only
    return res.status(500).json({ error: "Upstream fetch failed" });
  }
}
