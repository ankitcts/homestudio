// Server-side proxy for the Google Solar API (buildingInsights:findClosest).
// Keeps the API key on the server; the browser only sees the resulting JSON.
export const dynamic = "force-dynamic";

export async function GET(request) {
  const params = new URL(request.url).searchParams;
  const lat = params.get("lat");
  const lng = params.get("lng");
  if (!lat || !lng) return Response.json({ error: "Missing lat/lng" }, { status: 400 });

  const key = (process.env.GOOGLE_SOLAR_API_KEY || "").trim();
  if (!key) {
    return Response.json(
      { error: { message: "No server API key configured (set GOOGLE_SOLAR_API_KEY)." } },
      { status: 400 }
    );
  }

  try {
    const url = `https://solar.googleapis.com/v1/buildingInsights:findClosest?location.latitude=${lat}&location.longitude=${lng}&requiredQuality=LOW&key=${key}`;
    const r = await fetch(url);
    const j = await r.json();
    return Response.json(j, { status: r.ok ? 200 : r.status });
  } catch (e) {
    return Response.json({ error: { message: e.message || "Solar API request failed" } }, { status: 502 });
  }
}
