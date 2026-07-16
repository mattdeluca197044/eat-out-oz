# Dine Out — search backend

A single serverless function that proxies restaurant searches to the Google
Places API, so the key never sits in browser-visible code.

## Deploy to Vercel

1. **Install the CLI** (or skip this and use the Vercel dashboard + GitHub instead):
   ```
   npm install -g vercel
   ```

2. **From this folder, deploy:**
   ```
   vercel
   ```
   Follow the prompts (log in, confirm project name). Vercel auto-detects
   the `/api` folder and turns `search.js` into a live endpoint.

   Alternative: push this folder to a GitHub repo, then in the Vercel
   dashboard choose "Add New Project" → import that repo. Same result,
   no CLI needed.

3. **Add your API key as an environment variable** — do NOT put it in the code:
   - Vercel dashboard → your project → Settings → Environment Variables
   - Key: `GOOGLE_PLACES_API_KEY`
   - Value: (paste your key here)
   - Save, then redeploy (Deployments tab → ⋯ → Redeploy) so it picks up the variable.

4. **Test it** — once deployed, visit:
   ```
   https://YOUR-PROJECT.vercel.app/api/search?suburb=Manly&category=restaurant
   ```
   You should get back JSON with real Manly restaurants.

## Wiring it into the website/app

Replace the hardcoded `DATA` array lookup with a fetch call, e.g.:

```js
async function searchSuburb(suburb, category) {
  const res = await fetch(`https://YOUR-PROJECT.vercel.app/api/search?suburb=${encodeURIComponent(suburb)}&category=${category}`);
  const data = await res.json();
  return data.results; // same shape used to render cards
}
```

Note the response shape is slightly different from the demo's hardcoded
data (`priceLevel` is Google's 0–4 scale, not a $ range, and there's no
`cuisine` label) — the rendering code will need small tweaks to map these
fields. Happy to do that pass once your endpoint is live and you can share
the deployed URL.

## Cost control

- Set a budget alert in Google Cloud (Billing → Budgets & alerts).
- The function caches each suburb+category search for an hour at Vercel's
  edge, so repeated searches for the same suburb don't re-hit the Places
  API every time.
