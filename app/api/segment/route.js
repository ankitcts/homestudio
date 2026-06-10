// ML roof segmentation. Server-side pipeline:
//   1. Fetch a Google Static Maps satellite tile centered on the home.
//   2. POST it (base64) to a Hugging Face segmentation endpoint (HF_SEGMENT_URL)
//      with the HUGGINGFACE_API_TOKEN and a text prompt ("roof").
//   3. The endpoint returns the roof outline in image-pixel coords:
//        { "polygon": [[x, y], ...] }  (optionally width/height)
//   4. Convert pixels -> lat/lng using meters-per-pixel at this zoom/latitude
//      and return the ring so the client measures it like any footprint.
//
// Deploy a matching endpoint (e.g. a GroundedSAM HF Space) and set
// HF_SEGMENT_URL + HUGGINGFACE_API_TOKEN in your Vercel env. See README.
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const TILE_SIZE = 640; // CSS px requested; scale=2 => 2x actual px
const SCALE = 2;

export async function GET(request) {
  const params = new URL(request.url).searchParams;
  const lat = parseFloat(params.get("lat"));
  const lng = parseFloat(params.get("lng"));
  const zoom = parseInt(params.get("zoom") || "20", 10);
  if (Number.isNaN(lat) || Number.isNaN(lng)) return Response.json({ error: "Missing lat/lng" }, { status: 400 });

  const googleKey = (process.env.GOOGLE_SOLAR_API_KEY || "").trim();
  const hfToken = (process.env.HUGGINGFACE_API_TOKEN || "").trim();
  const endpoint = (process.env.HF_SEGMENT_URL || "").trim();
  if (!googleKey) return Response.json({ error: "GOOGLE_SOLAR_API_KEY not set (needed for the satellite tile)." }, { status: 400 });
  if (!endpoint || !hfToken) {
    return Response.json({ error: "ML segmentation not configured. Set HF_SEGMENT_URL and HUGGINGFACE_API_TOKEN in your Vercel env (deploy the HF Space from the README)." }, { status: 501 });
  }

  try {
    // 1. Satellite tile
    const tileUrl = `https://maps.googleapis.com/maps/api/staticmap?center=${lat},${lng}&zoom=${zoom}&size=${TILE_SIZE}x${TILE_SIZE}&scale=${SCALE}&maptype=satellite&key=${googleKey}`;
    const tileRes = await fetch(tileUrl);
    if (!tileRes.ok) return Response.json({ error: "Static Maps tile failed (" + tileRes.status + "). Enable the Maps Static API." }, { status: 502 });
    const imgBuf = Buffer.from(await tileRes.arrayBuffer());
    const imgB64 = imgBuf.toString("base64");

    // 2. Segmentation endpoint
    const segRes = await fetch(endpoint, {
      method: "POST",
      headers: { "Authorization": "Bearer " + hfToken, "Content-Type": "application/json" },
      body: JSON.stringify({ image_base64: imgB64, prompt: "roof", inputs: imgB64 }),
    });
    if (!segRes.ok) {
      const t = await segRes.text().catch(() => "");
      return Response.json({ error: "Segmentation endpoint " + segRes.status + ": " + t.slice(0, 200) }, { status: 502 });
    }
    const seg = await segRes.json();
    const poly = seg.polygon || seg.mask_polygon || (Array.isArray(seg) ? seg : null);
    if (!poly || poly.length < 3) return Response.json({ error: "No roof polygon returned by the segmentation endpoint." }, { status: 404 });

    const imgW = (seg.width || TILE_SIZE * SCALE);
    const imgH = (seg.height || TILE_SIZE * SCALE);

    // 3. Pixel -> lat/lng. metersPerCssPixel at this zoom/lat; actual px = /SCALE.
    const mpp = (156543.03392 * Math.cos((lat * Math.PI) / 180)) / Math.pow(2, zoom);
    const mPerPx = mpp / SCALE;
    const ring = poly.map(([px, py]) => {
      const east = (px - imgW / 2) * mPerPx;
      const north = (imgH / 2 - py) * mPerPx;
      return [lat + north / 111320, lng + east / (111320 * Math.cos((lat * Math.PI) / 180))];
    });

    return Response.json({ ring, source: "ML roof segmentation" });
  } catch (e) {
    return Response.json({ error: "Segmentation failed: " + (e.message || "unknown") }, { status: 502 });
  }
}
