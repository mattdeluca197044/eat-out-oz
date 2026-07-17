// GET /api/search?suburb=Newtown&category=restaurant
//
// Proxies a text search to the Google Places API. The API key never reaches
// the browser — it's read from an environment variable set in Vercel.

export default async function handler(req, res) {
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
  const url = `https://maps.googleapis.com/maps/api/place/textsearch/json?query=${encodeURIComponent(query)}&key=${key}`;

  try {
    const response = await fetch(url);
    const data = await response.json();

    if (data.status !== "OK" && data.status !== "ZERO_RESULTS") {
      return res.status(502).json({ error: "Places API error", status: data.status, message: data.error_message });
    }

    const results = (data.results || []).map((place) => ({
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
