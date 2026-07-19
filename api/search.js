
// GET /api/search?suburb=Newtown&category=restaurant
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
 
  const { suburb, category, cuisine } = req.query;
 
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
 
  const cuisinePrefix = cuisine && cuisine.trim() ? `${cuisine.trim()} ` : "";
  const query = `${cuisinePrefix}${categoryTerm} in ${suburb}, Sydney`;
  const url = `https://maps.googleapis.com/maps/api/place/textsearch/json?query=${encodeURIComponent(query)}&key=${key}`;
 
  try {
    const response = await fetch(url);
    const data = await response.json();
 
    if (data.status !== "OK" && data.status !== "ZERO_RESULTS") {
      return res.status(502).json({ error: "Places API error", status: data.status, message: data.error_message });
    }
 
    let results = (data.results || []).map((place) => ({
      name: place.name,
      address: place.formatted_address,
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
 
    // Google's text search is fuzzy — asking for "Thai restaurants" can still
    // return an Italian place that just happens to rank nearby. If the venue's
    // own name clearly names a *different* cuisine than the one requested,
    // drop it rather than mislabel it.
    if (cuisine && cuisine.trim()) {
      const requested = cuisine.trim().toLowerCase();
      const KNOWN_CUISINES = [
        "italian","thai","chinese","japanese","indian","mexican","vietnamese",
        "korean","lebanese","greek","seafood","vegan","pizza","burger",
        "french","spanish","turkish","malaysian","indonesian","american",
      ];
      results = results.filter((r) => {
        const text = r.name.toLowerCase();
        if (text.includes(requested)) return true; // explicitly matches what was asked for
        const conflictsWithOther = KNOWN_CUISINES.some(
          (c) => c !== requested && text.includes(c)
        );
        return !conflictsWithOther; // drop only if it names a *different* cuisine
      });
    }
 
    res.setHeader("Cache-Control", "s-maxage=3600, stale-while-revalidate=86400");
    return res.status(200).json({ query, count: results.length, results });
  } catch (err) {
    return res.status(500).json({ error: "Upstream fetch failed", detail: err.message });
  }
}
 
