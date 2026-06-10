# Home Studio

A Next.js app for measuring building roofs and footprints with a 3D view.
Three measurement methods are supported:

1. **Google Solar API** — true sloped-roof segment polygons, pitch, azimuth, and area.
2. **Manual drawing** — trace the building outline on satellite imagery.
3. **OpenStreetMap** — automatic building footprints, no API key required.

## Architecture

- `app/page.js` — the client UI (Google Maps + Three.js 3D view).
- `app/api/maps-key/route.js` — serves the Maps JS key to the browser (the Maps
  JavaScript SDK must load with a key in the page).
- `app/api/geocode/route.js` — server-side geocoding proxy (Google, with an OSM
  Nominatim fallback when no key is set).
- `app/api/solar/route.js` — server-side proxy for the Google Solar API.

The **Solar** and **Geocoding** calls run server-side, so the key isn't exposed
to the browser for those. The Maps JS SDK still needs the key in the page —
**restrict the key by HTTP referrer** in the Google Cloud console.

## Configuration

The API key is read from the `GOOGLE_SOLAR_API_KEY` environment variable.
Next.js loads it automatically from `.env` (committed) or from your deployment's
env settings. Enable the **Maps JavaScript**, **Geocoding**, and **Solar** APIs.

```
GOOGLE_SOLAR_API_KEY=your-key-here
```

## Develop

```bash
npm install
npm run dev      # http://localhost:3000
```

## Production

```bash
npm run build
npm start
```
