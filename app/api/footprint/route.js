// Server-side building-footprint lookup, primary source: Microsoft Building
// Footprints (GlobalMLBuildingFootprints). These are published as gzipped
// quadkey tiles indexed by a dataset-links CSV — there is no point-query API —
// so we: resolve the zoom-9 quadkey for the point, find its tile URL in the
// (cached) index, download + gunzip the tile, and return the polygon that
// contains the point. Falls back to OpenStreetMap Overpass if anything fails.
import zlib from "zlib";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const INDEX_URL = "https://minedbuildings.z5.web.core.windows.net/global-buildings/dataset-links.csv";

// Module-scope caches (persist across warm invocations).
let indexTextPromise = null;          // Promise<string> of the dataset-links CSV
const tileCache = new Map();          // quadkey -> Feature[] (parsed tile)

const gunzip = (buf) => new Promise((res, rej) => zlib.gunzip(buf, (e, r) => (e ? rej(e) : res(r))));

function latLngToQuadkey(lat, lng, zoom = 9) {
  const sinLat = Math.sin((lat * Math.PI) / 180);
  const x = (lng + 180) / 360;
  const y = 0.5 - Math.log((1 + sinLat) / (1 - sinLat)) / (4 * Math.PI);
  const n = 1 << zoom;
  const tileX = Math.min(n - 1, Math.max(0, Math.floor(x * n)));
  const tileY = Math.min(n - 1, Math.max(0, Math.floor(y * n)));
  let qk = "";
  for (let i = zoom; i > 0; i--) {
    let digit = 0;
    const mask = 1 << (i - 1);
    if ((tileX & mask) !== 0) digit += 1;
    if ((tileY & mask) !== 0) digit += 2;
    qk += digit;
  }
  return qk;
}

// Ray-casting point-in-polygon. ring: [[lng,lat], ...]
function pointInRing(lng, lat, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0], yi = ring[i][1], xj = ring[j][0], yj = ring[j][1];
    const intersect = (yi > lat) !== (yj > lat) && lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

async function getIndexText() {
  if (!indexTextPromise) {
    indexTextPromise = fetch(INDEX_URL).then((r) => {
      if (!r.ok) throw new Error("index HTTP " + r.status);
      return r.text();
    }).catch((e) => { indexTextPromise = null; throw e; });
  }
  return indexTextPromise;
}

async function getTileFeatures(quadkey) {
  if (tileCache.has(quadkey)) return tileCache.get(quadkey);
  const text = await getIndexText();
  // CSV columns: Location,QuadKey,Url,... — find the row for this quadkey.
  let url = null;
  for (const line of text.split("\n")) {
    const cols = line.split(",");
    if (cols.length >= 3 && cols[1] === quadkey) { url = cols[2].trim(); break; }
  }
  if (!url) { tileCache.set(quadkey, []); return []; }

  const buf = Buffer.from(await (await fetch(url)).arrayBuffer());
  const raw = url.endsWith(".gz") ? await gunzip(buf) : buf;
  const features = [];
  for (const line of raw.toString("utf8").split("\n")) {
    const s = line.trim();
    if (!s) continue;
    try {
      const f = JSON.parse(s);
      if (f.geometry && f.geometry.type === "Polygon") features.push(f);
    } catch { /* skip bad line */ }
  }
  tileCache.set(quadkey, features);
  return features;
}

function ringToLatLng(coords) {
  // GeoJSON outer ring is coords[0], pairs are [lng,lat].
  return coords[0].map(([lng, lat]) => [lat, lng]);
}

async function fromMicrosoft(lat, lng) {
  const qk = latLngToQuadkey(lat, lng, 9);
  const features = await getTileFeatures(qk);
  if (!features.length) return null;
  // Prefer the polygon that contains the point; else the nearest by centroid.
  let best = null, bestD = Infinity;
  for (const f of features) {
    const outer = f.geometry.coordinates[0];
    if (pointInRing(lng, lat, outer)) return { ring: ringToLatLng(f.geometry.coordinates), source: "Microsoft Building Footprints" };
    let cx = 0, cy = 0;
    for (const [x, y] of outer) { cx += x; cy += y; }
    cx /= outer.length; cy /= outer.length;
    const d = (cx - lng) ** 2 + (cy - lat) ** 2;
    if (d < bestD) { bestD = d; best = f; }
  }
  // Accept the nearest building only if its centroid is within ~60 m.
  if (best && bestD < (60 / 111320) ** 2) return { ring: ringToLatLng(best.geometry.coordinates), source: "Microsoft Building Footprints (nearest)" };
  return null;
}

async function fromOSM(lat, lng) {
  const q = `[out:json][timeout:25];(way["building"](around:40,${lat},${lng});relation["building"](around:40,${lat},${lng}););out body geom;`;
  const body = "data=" + encodeURIComponent(q);
  const endpoints = [
    "https://overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
    "https://overpass.private.coffee/api/interpreter",
  ];
  for (const url of endpoints) {
    try {
      const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", "User-Agent": "homestudio-roof-estimator/1.0" }, body });
      if (!r.ok) continue;
      const j = await r.json();
      const ways = (j.elements || []).filter((e) => e.type === "way" && e.geometry && e.geometry.length >= 4);
      if (!ways.length) continue;
      let best = null, bestD = Infinity;
      for (const w of ways) {
        const ring = w.geometry.map((n) => [n.lat, n.lon]);
        let cx = 0, cy = 0; ring.forEach((p) => { cx += p[0]; cy += p[1]; }); cx /= ring.length; cy /= ring.length;
        const d = (cx - lat) ** 2 + (cy - lng) ** 2;
        if (d < bestD) { bestD = d; best = ring; }
      }
      if (best) return { ring: best, source: "OpenStreetMap footprint" };
    } catch { /* try next */ }
  }
  return null;
}

export async function GET(request) {
  const params = new URL(request.url).searchParams;
  const lat = parseFloat(params.get("lat"));
  const lng = parseFloat(params.get("lng"));
  if (Number.isNaN(lat) || Number.isNaN(lng)) return Response.json({ error: "Missing lat/lng" }, { status: 400 });

  try {
    const ms = await fromMicrosoft(lat, lng);
    if (ms) return Response.json(ms);
  } catch { /* fall through to OSM */ }

  const osm = await fromOSM(lat, lng);
  if (osm) return Response.json(osm);

  return Response.json({ error: "No building footprint found for this location (tried Microsoft Building Footprints and OpenStreetMap)." }, { status: 404 });
}
