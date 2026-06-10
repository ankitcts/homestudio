// Returns the Google Maps JS key for the browser. The Maps JavaScript SDK
// must load with the key in the page, so this is unavoidably client-visible —
// restrict the key by HTTP referrer in the Google Cloud console. The Solar and
// Geocoding calls are proxied server-side (see ../solar and ../geocode) so
// those never expose the key.
export const dynamic = "force-dynamic";

export async function GET() {
  const key = (process.env.GOOGLE_SOLAR_API_KEY || "").trim();
  // Optional Map ID — enables Advanced Markers (otherwise the classic Marker is used).
  const mapId = (process.env.GOOGLE_MAP_ID || "").trim();
  return Response.json({ key, mapId });
}
