// Server-side proxy for the OpenStreetMap Overpass API. Avoids browser CORS /
// network issues and spreads load across mirrors with a retry pass, since the
// public Overpass endpoints rate-limit aggressively (HTTP 429).
export const dynamic = "force-dynamic";

const ENDPOINTS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
  "https://overpass.private.coffee/api/interpreter",
  "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function GET(request) {
  const params = new URL(request.url).searchParams;
  const lat = params.get("lat");
  const lng = params.get("lng");
  if (!lat || !lng) return Response.json({ error: "Missing lat/lng" }, { status: 400 });

  const q = `[out:json][timeout:25];(way["building"](around:40,${lat},${lng});relation["building"](around:40,${lat},${lng}););out body geom;`;
  const body = "data=" + encodeURIComponent(q);
  const headers = {
    "Content-Type": "application/x-www-form-urlencoded",
    "User-Agent": "homestudio-roof-estimator/1.0 (contact: github.com/ankitcts/homestudio)",
  };

  let rateLimited = false;
  let lastErr = "";

  // Two passes; a short wait before the second so a 429 has a chance to clear.
  for (let pass = 0; pass < 2; pass++) {
    if (pass > 0) await sleep(900);
    for (const url of ENDPOINTS) {
      try {
        const r = await fetch(url, { method: "POST", headers, body });
        if (r.status === 429) { rateLimited = true; lastErr = "rate limited (429)"; continue; }
        if (!r.ok) { lastErr = `HTTP ${r.status}`; continue; }
        const j = await r.json();
        return Response.json(j);
      } catch (e) {
        lastErr = e.message || "fetch failed";
      }
    }
  }

  const status = rateLimited ? 429 : 502;
  const error = rateLimited
    ? "OpenStreetMap is rate-limiting right now. Wait a few seconds and try again, or use 'Draw roof outline' / 'Roof from imagery'."
    : "Overpass request failed: " + lastErr;
  return Response.json({ error }, { status });
}
