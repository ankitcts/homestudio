# Home Studio

A single-page web app for measuring building roofs and footprints with a 3D view.
Three methods are supported:

1. **Google Solar API** — true sloped-roof segment polygons, pitch, azimuth, and area.
2. **Manual drawing** — trace the building outline on satellite imagery.
3. **OpenStreetMap** — automatic building footprints, no API key required.

The whole app is `index.html` (no framework, no bundler).

## Google API key

The Solar API and Maps/Geocoding methods need a Google Cloud API key with
**Maps JavaScript**, **Geocoding**, and **Solar** APIs enabled.

The key is resolved at build time and injected into a generated `config.js`
(`window.APP_CONFIG.GOOGLE_API_KEY`). Resolution order:

1. `GOOGLE_SOLAR_API_KEY` environment variable (e.g. a Vercel project env var).
2. `GOOGLE_SOLAR_API_KEY` in a local `.env` file.

If no key is found, the app falls back to the in-app key field (stored in
`localStorage`), so it still runs locally.

> The key ships to the browser. **Restrict it by HTTP referrer** in the Google
> Cloud console.

## Build / run

```bash
# generate config.js from .env or the GOOGLE_SOLAR_API_KEY env var
npm run build

# then serve the directory with any static server, e.g.
npx serve .
```

`config.js` is generated and git-ignored. On Vercel the build command
(`node build.js`, see `vercel.json`) runs automatically.
