// Server-side proxy for the OpenStreetMap Overpass API. Avoids browser CORS /
// network issues and keeps the request off the client.
export const dynamic = "force-dynamic";

export async function GET(request) {
  const params = new URL(request.url).searchParams;
  const lat = params.get("lat");
  const lng = params.get("lng");
  if (!lat || !lng) return Response.json({ error: "Missing lat/lng" }, { status: 400 });

  const q = `[out:json][timeout:25];(way["building"](around:40,${lat},${lng});relation["building"](around:40,${lat},${lng}););out body geom;`;
  const endpoints = [
    "https://overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
  ];

  let lastErr = "";
  for (const url of endpoints) {
    try {
      const r = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: "data=" + encodeURIComponent(q),
      });
      if (!r.ok) { lastErr = `Overpass ${r.status}`; continue; }
      const j = await r.json();
      return Response.json(j);
    } catch (e) {
      lastErr = e.message || "fetch failed";
    }
  }
  return Response.json({ error: "Overpass request failed: " + lastErr }, { status: 502 });
}
