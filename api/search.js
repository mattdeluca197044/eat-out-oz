
}// GET /api/search?suburb=Newtown&category=restaurant
//
// Proxies a text search to the Google Places API. The API key never reaches
// the browser — it's read from an environment variable set in Vercel.

export default async function handler(req, res) {
  // Allow this endpoint to be called from any website's JavaScript
  // (e.g. the Claude artifact preview, or wherever the site ends up hosted).
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    return res.status(204).end();
  }

  const { suburb, category } = req.query;

  if (!suburb || !suburb.trim()) {
    return res.status(400).json({ error: "Missing 'suburb' query parameter" });
  }

  const key = process.env.GOOGLE_PLACES_API_KEY;
  if (!key) {
    return res.status(500).json({ error: "Server is missing GOOGLE_PLACES_API_KEY" });
  }

  const categoryTerm =
    category === "cafe" ? "cafes" :
    category === "takeaway" ? "takeaway food" :
    "restaurants";

  const query = `${categoryTerm} in ${suburb}, Sydney`;
  const baseUrl = `https://maps.googleapis.com/maps/api/place/textsearch/json?query=${encodeURIComponent(query)}&key=${key}`;

  // Google returns up to 20 results per page, up to 3 pages (60 total) via
  // a next_page_token. The token needs a moment to activate, so we wait
  // briefly between pages.
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  try {
    let allResults = [];
    let nextPageToken = null;
    let page = 0;
    const MAX_PAGES = 3;

    do {
      const pageUrl = nextPageToken
        ? `${baseUrl}&pagetoken=${nextPageToken}`
        : baseUrl;

      if (nextPageToken) await sleep(2000); // token activation delay

      const response = await fetch(pageUrl);
      const data = await response.json();

      if (data.status !== "OK" && data.status !== "ZERO_RESULTS") {
        // If we already have results from earlier pages, return those rather
        // than failing the whole request over a later-page error.
        if (allResults.length) break;
        return res.status(502).json({ error: "Places API error", status: data.status, message: data.error_message });
      }

      allResults = allResults.concat(data.results || []);
      nextPageToken = data.next_page_token || null;
      page++;
    } while (nextPageToken && page < MAX_PAGES);

    const results = allResults.map((place) => ({
      name: place.name,
      address: place.formatted_address,
      rating: place.rating ?? null,
      reviews: place.user_ratings_total ?? 0,
      priceLevel: place.price_level ?? null, // 0-4, Google's scale; map to your $ ranges client-side
      placeId: place.place_id,
      lat: place.geometry?.location?.lat ?? null,
      lng: place.geometry?.location?.lng ?? null,
      openNow: place.opening_hours?.open_now ?? null,
      types: place.types || [],
    }));

    // Cache each suburb+category combo at the edge for an hour so repeat
    // searches don't re-bill your Places API quota.
    res.setHeader("Cache-Control", "s-maxage=3600, stale-while-revalidate=86400");
    return res.status(200).json({ query, count: results.length, results });
  } catch (err) {
    return res.status(500).json({ error: "Upstream fetch failed", detail: err.message });
  }
}
