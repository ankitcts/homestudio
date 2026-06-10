// Server-side geocoding proxy. Uses the Google Geocoding API when a key is
// configured, otherwise falls back to the free OpenStreetMap Nominatim service.
// The API key never reaches the browser here.
export const dynamic = "force-dynamic";

export async function GET(request) {
  const address = (new URL(request.url).searchParams.get("address") || "").trim();
  if (!address) return Response.json({ error: "Missing address" }, { status: 400 });

  const key = (process.env.GOOGLE_SOLAR_API_KEY || "").trim();

  try {
    if (key) {
      const url = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(address)}&key=${key}`;
      const j = await (await fetch(url)).json();
      if (j.status !== "OK") {
        return Response.json({ error: j.error_message || j.status }, { status: 400 });
      }
      const loc = j.results[0].geometry.location;
      return Response.json({
        lat: loc.lat,
        lng: loc.lng,
        formatted_address: j.results[0].formatted_address,
      });
    }

    // No key — fall back to Nominatim (OSM).
    const url = `https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${encodeURIComponent(address)}`;
    const j = await (await fetch(url, { headers: { "Accept-Language": "en", "User-Agent": "homestudio/1.0" } })).json();
    if (!j.length) return Response.json({ error: "Address not found" }, { status: 404 });
    return Response.json({ lat: parseFloat(j[0].lat), lng: parseFloat(j[0].lon), formatted_address: address });
  } catch (e) {
    return Response.json({ error: e.message || "Geocoding failed" }, { status: 502 });
  }
}
