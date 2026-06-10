"use client";

import { useEffect, useRef } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { DRACOLoader } from "three/examples/jsm/loaders/DRACOLoader.js";
import { TilesRenderer } from "3d-tiles-renderer";
import {
  GoogleCloudAuthPlugin,
  GLTFExtensionsPlugin,
  TileCompressionPlugin,
  TilesFadePlugin,
  ReorientationPlugin,
} from "3d-tiles-renderer/plugins";

const MARKUP = `
  <div class="topbar">
    <h1>Roof &amp; Siding Estimator</h1>
    <span class="sub">Autofill an address, measure the roof (shingles) &amp; siding, and view the real house in 3D.</span>
    <span class="spacer"></span>
  </div>

  <div class="layout">
    <aside class="sidebar">
      <h3>Projects</h3>
      <div id="proj-list"></div>
      <div class="row" style="margin-top:10px;">
        <input type="text" id="new-proj-name" placeholder="New project name" style="flex:1;" />
      </div>
      <button class="ghost" id="add-proj" style="width:100%;margin-top:8px;">+ Add project</button>

      <h3 style="margin-top:22px;">Estimate settings</h3>
      <label class="hint" style="display:block;margin-bottom:4px;">Wall height (ft)</label>
      <input type="text" id="wall-height" value="20" style="width:100%;" />
      <label class="hint" style="display:block;margin:8px 0 4px;">Waste factor (%)</label>
      <input type="text" id="waste" style="width:100%;" value="10" />
      <label class="hint" style="display:block;margin:8px 0 4px;">Shingle product</label>
      <select id="shingle" style="width:100%;">
        <option value="arch|3">Architectural (3 bundles/sq)</option>
        <option value="3tab|3">3-Tab (3 bundles/sq)</option>
        <option value="designer4|4">Designer (4 bundles/sq)</option>
        <option value="designer5|5">Premium Designer (5 bundles/sq)</option>
      </select>

      <h3 style="margin-top:22px;">Google API key</h3>
      <div class="hint" id="key-status">Checking server key…</div>
    </aside>

    <main class="main">
      <div id="no-project" class="empty">Create or select a project to begin.</div>

      <div id="project-view" style="display:none;">
        <div class="panel">
          <h3>Address</h3>
          <div class="row">
            <input type="text" id="addr-input" placeholder="Start typing an address…" autocomplete="off" style="flex:1;min-width:280px;" />
            <button id="geocode-btn">Locate</button>
            <span class="status" id="geo-status"></span>
          </div>
          <div class="hint">Suggestions appear as you type (Google Places). Pick one to drop the pin automatically.</div>
        </div>

        <div class="tabs" id="mode-tabs">
          <div class="tab active" data-mode="solar">Roof from imagery</div>
          <div class="tab" data-mode="draw">Draw roof outline</div>
          <div class="tab" data-mode="auto">Auto footprint (OSM)</div>
        </div>

        <div id="mode-hint" class="hint"></div>
        <div id="error-box"></div>

        <div id="map" style="margin-top:12px;"></div>
        <div class="row" id="map-controls" style="margin-top:10px;"></div>

        <div class="split">
          <div class="panel">
            <h3>Roof 3D geometry &amp; measurements</h3>
            <canvas id="view3d"></canvas>
            <div class="legend" id="legend"></div>
            <div class="hint">Drag to orbit · scroll to zoom. Roof segments extruded for visualization.</div>
            <div id="report-body" style="margin-top:12px;"><div class="empty">No measurement yet.</div></div>
          </div>
          <div class="panel">
            <h3>Photorealistic 3D · Google Map Tiles</h3>
            <canvas id="tiles3d"></canvas>
            <div class="hint" id="tiles-status">Locate an address to load the real 3D building.</div>
            <div class="hint">Drag to orbit · scroll to zoom. Real textured mesh from Google Map Tiles.</div>
          </div>
        </div>
      </div>
    </main>
  </div>
`;

export default function Page() {
  const booted = useRef(false);

  useEffect(() => {
    if (booted.current) return;
    booted.current = true;

    // -----------------------------------------------------------------------
    // State + persistence
    //
    // Everything is persisted to localStorage today. The `store` object below
    // is the single seam to swap for a MongoDB-backed API (e.g. fetch
    // "/api/projects") later — the rest of the app only talks to `store`.
    // -----------------------------------------------------------------------
    const LS_PROJECTS = "hm.projects";
    const LS_ACTIVE = "hm.active";
    const LS_WALL = "hm.wallft";
    const LS_WASTE = "hm.waste";
    const LS_SHINGLE = "hm.shingle";

    const store = {
      loadProjects() { try { return JSON.parse(localStorage.getItem(LS_PROJECTS)) ?? []; } catch { return []; } },
      saveProjects(list) { localStorage.setItem(LS_PROJECTS, JSON.stringify(list)); },
      getActiveId() { return localStorage.getItem(LS_ACTIVE) || null; },
      setActiveId(id) { localStorage.setItem(LS_ACTIVE, id || ""); },
      getSetting(k, d) { return localStorage.getItem(k) ?? d; },
      setSetting(k, v) { localStorage.setItem(k, v); },
    };

    let projects = store.loadProjects();
    let activeId = store.getActiveId();
    let mode = "solar";
    let mapsKey = ""; // fetched from the server (/api/maps-key)

    function saveProjects() { store.saveProjects(projects); }
    function active() { return projects.find(p => p.id === activeId) || null; }
    function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }

    // -----------------------------------------------------------------------
    // DOM refs
    // -----------------------------------------------------------------------
    const $ = (id) => document.getElementById(id);

    function apiKey() { return mapsKey; }

    // Estimate settings (persisted) -----------------------------------------
    const wallInput = $("wall-height");
    const wasteInput = $("waste");
    const shingleInput = $("shingle");
    wallInput.value = store.getSetting(LS_WALL, "20");
    wasteInput.value = store.getSetting(LS_WASTE, "10");
    shingleInput.value = store.getSetting(LS_SHINGLE, "arch|3");
    function wallHeightFt() { return parseFloat(wallInput.value) || 0; }
    function wasteFactor() { return Math.max(0, parseFloat(wasteInput.value) || 0); }
    function shingle() {
      const [name, bps] = (shingleInput.value || "arch|3").split("|");
      return { name: shingleInput.selectedOptions[0]?.textContent || name, bundlesPerSquare: parseFloat(bps) || 3 };
    }
    const reRender = () => { const p = active(); if (p && p.report) renderReport(p.report); };
    wallInput.addEventListener("input", () => { store.setSetting(LS_WALL, wallInput.value); reRender(); draw3D(active()?.geometry || null); });
    wasteInput.addEventListener("input", () => { store.setSetting(LS_WASTE, wasteInput.value); reRender(); });
    shingleInput.addEventListener("change", () => { store.setSetting(LS_SHINGLE, shingleInput.value); reRender(); });

    // -----------------------------------------------------------------------
    // Projects sidebar
    // -----------------------------------------------------------------------
    function renderProjects() {
      const list = $("proj-list");
      list.innerHTML = "";
      if (!projects.length) { list.innerHTML = '<div class="hint">No projects yet.</div>'; }
      projects.forEach(p => {
        const el = document.createElement("div");
        el.className = "proj" + (p.id === activeId ? " active" : "");
        el.innerHTML = `<span class="del" title="Delete">✕</span>
          <div class="name">${escapeHtml(p.name)}</div>
          <div class="addr">${escapeHtml(p.address || "no address yet")}</div>`;
        el.addEventListener("click", (e) => {
          if (e.target.classList.contains("del")) { deleteProject(p.id); e.stopPropagation(); return; }
          selectProject(p.id);
        });
        list.appendChild(el);
      });
    }

    function addProject() {
      const name = $("new-proj-name").value.trim() || `Project ${projects.length + 1}`;
      const p = { id: uid(), name, address: "", lat: null, lng: null, createdAt: Date.now() };
      projects.push(p); saveProjects();
      $("new-proj-name").value = "";
      selectProject(p.id);
    }

    function deleteProject(id) {
      projects = projects.filter(p => p.id !== id);
      saveProjects();
      if (activeId === id) { activeId = projects[0]?.id || null; store.setActiveId(activeId); }
      renderProjects(); renderProjectView();
    }

    function selectProject(id) {
      activeId = id; store.setActiveId(id);
      renderProjects(); renderProjectView();
    }

    $("add-proj").addEventListener("click", addProject);

    // -----------------------------------------------------------------------
    // Project view
    // -----------------------------------------------------------------------
    function renderProjectView() {
      const p = active();
      $("no-project").style.display = p ? "none" : "block";
      $("project-view").style.display = p ? "block" : "none";
      if (!p) return;
      $("addr-input").value = p.address || "";
      $("geo-status").textContent = p.lat != null ? `📍 ${p.lat.toFixed(6)}, ${p.lng.toFixed(6)}` : "";
      setError("");
      renderReport(p.report || null);
      draw3D(p.geometry || null);
      if (mapsKey) { loadGoogleMaps().then(setupAutocomplete).catch(() => {}); }
      if (p.lat != null) { initMapForMode(); initTiles(p); }
      else {
        mapReady = false;
        $("map").innerHTML = '<div class="empty">Locate an address to load the map.</div>';
        $("map-controls").innerHTML = "";
        disposeTiles();
        $("tiles-status").textContent = "Locate an address to load the real 3D building.";
      }
      updateModeHint();
    }

    // -----------------------------------------------------------------------
    // Address: Google Places autocomplete + manual geocode (server proxy)
    // -----------------------------------------------------------------------
    let autocomplete = null;
    function setupAutocomplete() {
      if (autocomplete || !window.google?.maps?.places) return;
      autocomplete = new google.maps.places.Autocomplete($("addr-input"), {
        fields: ["formatted_address", "geometry"],
        types: ["address"],
      });
      autocomplete.addListener("place_changed", () => {
        const place = autocomplete.getPlace();
        const p = active();
        if (!p || !place.geometry) return;
        p.lat = place.geometry.location.lat();
        p.lng = place.geometry.location.lng();
        p.address = place.formatted_address || $("addr-input").value;
        saveProjects();
        $("addr-input").value = p.address;
        $("geo-status").textContent = `📍 ${p.lat.toFixed(6)}, ${p.lng.toFixed(6)}`;
        renderProjects();
        initMapForMode();
        initTiles(p);
      });
    }

    $("geocode-btn").addEventListener("click", geocode);
    $("addr-input").addEventListener("keydown", (e) => {
      // Let the Places dropdown handle Enter when it's open.
      if (e.key === "Enter" && !document.querySelector(".pac-container:not([style*='display: none'])")) geocode();
    });

    async function geocode() {
      const p = active(); if (!p) return;
      const addr = $("addr-input").value.trim();
      if (!addr) return;
      p.address = addr;
      setError("");
      $("geo-status").textContent = "Locating…";
      try {
        const r = await fetch(`/api/geocode?address=${encodeURIComponent(addr)}`);
        const j = await r.json();
        if (j.error) throw new Error(j.error);
        p.lat = j.lat; p.lng = j.lng;
        if (j.formatted_address) { p.address = j.formatted_address; $("addr-input").value = p.address; }
      } catch (e) { setError("Geocoding failed: " + e.message); $("geo-status").textContent = ""; return; }
      saveProjects();
      $("geo-status").textContent = `📍 ${p.lat.toFixed(6)}, ${p.lng.toFixed(6)}`;
      renderProjects();
      initMapForMode();
      initTiles(p);
    }

    // -----------------------------------------------------------------------
    // Mode tabs
    // -----------------------------------------------------------------------
    $("mode-tabs").addEventListener("click", (e) => {
      const t = e.target.closest(".tab"); if (!t) return;
      [...$("mode-tabs").children].forEach(c => c.classList.toggle("active", c === t));
      mode = t.dataset.mode;
      updateModeHint();
      initMapForMode();
    });

    function updateModeHint() {
      const hints = {
        solar: "Pulls roof segment polygons, pitch and area from aerial imagery + a surface model (Google building dataset). Best source for a roof-replacement estimate.",
        draw: "Trace the roof/footprint outline on the satellite image. Area & perimeter are computed geodesically as you draw.",
        auto: "Fetches the nearest OpenStreetMap building footprint automatically — free, no key required. Good for siding perimeter.",
      };
      $("mode-hint").textContent = hints[mode] || "";
    }

    // -----------------------------------------------------------------------
    // Google Maps loader (geometry, drawing, places)
    // -----------------------------------------------------------------------
    let gmapsPromise = null;
    function loadGoogleMaps() {
      if (window.google?.maps) return Promise.resolve();
      if (gmapsPromise) return gmapsPromise;
      if (!apiKey()) return Promise.reject(new Error("No Google API key set."));
      gmapsPromise = new Promise((resolve, reject) => {
        window.__gmapsCb = () => resolve();
        const s = document.createElement("script");
        s.src = `https://maps.googleapis.com/maps/api/js?key=${apiKey()}&libraries=geometry,drawing,places&callback=__gmapsCb`;
        s.async = true; s.onerror = () => reject(new Error("Failed to load Google Maps JS."));
        document.head.appendChild(s);
      });
      return gmapsPromise;
    }

    let map = null, mapReady = false, drawnPoly = null, drawingManager = null, roofPolys = [];

    async function initMapForMode() {
      const p = active(); if (!p || p.lat == null) return;
      $("map-controls").innerHTML = "";

      if (mode === "auto") {
        if (!apiKey()) { $("map").innerHTML = '<div class="empty" style="padding:60px 0;">Auto footprint uses OpenStreetMap (no map tiles without a key). Click below to fetch.</div>'; }
        const btn = mkBtn("Fetch OSM footprint", fetchOsmFootprint);
        $("map-controls").appendChild(btn);
        if (apiKey()) await ensureMap(p);
        return;
      }

      try { await loadGoogleMaps(); } catch (e) { setError(e.message + " Set GOOGLE_SOLAR_API_KEY in .env (or use Option 3)."); return; }
      await ensureMap(p);

      if (mode === "solar") {
        const btn = mkBtn("Fetch roof segments", fetchSolar);
        $("map-controls").appendChild(btn);
      } else if (mode === "draw") {
        setupDrawing();
        $("map-controls").appendChild(mkBtn("Clear drawing", clearDrawing, true));
      }
    }

    async function ensureMap(p) {
      await loadGoogleMaps();
      const el = $("map");
      if (!map || el.dataset.kind !== "gmap") {
        el.innerHTML = ""; el.dataset.kind = "gmap";
        map = new google.maps.Map(el, {
          center: { lat: p.lat, lng: p.lng }, zoom: 20, mapTypeId: "satellite",
          tilt: 0, disableDefaultUI: false, mapTypeControl: false, streetViewControl: false,
        });
      } else {
        map.setCenter({ lat: p.lat, lng: p.lng });
      }
      mapReady = true;
      clearRoof();
      new google.maps.Marker({ position: { lat: p.lat, lng: p.lng }, map });
    }

    function mkBtn(label, fn, ghost) {
      const b = document.createElement("button");
      b.textContent = label; if (ghost) b.className = "ghost";
      b.addEventListener("click", fn);
      return b;
    }

    // -----------------------------------------------------------------------
    // Roof from imagery (Google building dataset) — server proxy /api/solar
    // -----------------------------------------------------------------------
    function clearRoof() { roofPolys.forEach(x => x.setMap(null)); roofPolys = []; }

    async function fetchSolar() {
      const p = active(); if (!p) return;
      setError(""); $("map-controls").firstChild.disabled = true;
      try {
        const r = await fetch(`/api/solar?lat=${p.lat}&lng=${p.lng}`);
        const j = await r.json();
        if (j.error) throw new Error(j.error.message);
        const sp = j.solarPotential || {};
        const segs = sp.roofSegmentStats || [];
        clearRoof();
        const COLORS = ["#6ea8fe", "#4ade80", "#f59e0b", "#f87171", "#a78bfa", "#22d3ee", "#fb923c", "#34d399"];
        const segReport = [];
        const geomPolys = [];
        let totalArea = 0, pitchSum = 0, pitchW = 0;
        segs.forEach((s, i) => {
          const b = s.boundingBox;
          const area = s.stats?.areaMeters2 ?? 0;
          totalArea += area;
          if (s.pitchDegrees != null) { pitchSum += s.pitchDegrees * (area || 1); pitchW += (area || 1); }
          segReport.push({ i: i + 1, area, pitch: s.pitchDegrees, azimuth: s.azimuthDegrees });
          if (b) {
            const path = [
              { lat: b.sw.latitude, lng: b.sw.longitude },
              { lat: b.sw.latitude, lng: b.ne.longitude },
              { lat: b.ne.latitude, lng: b.ne.longitude },
              { lat: b.ne.latitude, lng: b.sw.longitude },
            ];
            if (mapReady && window.google?.maps) {
              const poly = new google.maps.Polygon({ paths: path, map, strokeColor: COLORS[i % COLORS.length], strokeWeight: 2, fillColor: COLORS[i % COLORS.length], fillOpacity: 0.25 });
              roofPolys.push(poly);
            }
            geomPolys.push({ ring: path.map(pt => [pt.lat, pt.lng]), color: COLORS[i % COLORS.length], pitch: s.pitchDegrees || 0, azimuth: s.azimuthDegrees || 0, area });
          }
        });
        const whole = sp.wholeRoofStats?.areaMeters2 ?? totalArea;
        const footprint = j.buildingStats?.areaMeters2 ?? null;
        const report = {
          source: "Roof from imagery",
          roofArea_m2: whole,
          footprint_m2: footprint,
          perimeter_m: footprint ? 4 * Math.sqrt(footprint) : null, // estimated (square assumption)
          perimeterEstimated: true,
          predominantPitch: pitchW ? pitchSum / pitchW : null,
          segments: segReport,
          imageryDate: j.imageryDate ? `${j.imageryDate.year}-${String(j.imageryDate.month).padStart(2,"0")}-${String(j.imageryDate.day).padStart(2,"0")}` : null,
        };
        p.report = report;
        p.geometry = { polys: geomPolys, center: [p.lat, p.lng] };
        saveProjects();
        renderReport(report);
        draw3D(p.geometry);
      } catch (e) {
        setError("Roof imagery: " + e.message + ". Try drawing the roof, or use OSM footprint.");
      } finally {
        if ($("map-controls").firstChild) $("map-controls").firstChild.disabled = false;
      }
    }

    // -----------------------------------------------------------------------
    // Draw to measure
    // -----------------------------------------------------------------------
    function setupDrawing() {
      clearDrawing();
      drawingManager = new google.maps.drawing.DrawingManager({
        drawingMode: google.maps.drawing.OverlayType.POLYGON,
        drawingControl: true,
        drawingControlOptions: { drawingModes: ["polygon"] },
        polygonOptions: { strokeColor: "#6ea8fe", fillColor: "#6ea8fe", fillOpacity: 0.2, strokeWeight: 2, editable: true },
      });
      drawingManager.setMap(map);
      google.maps.event.addListener(drawingManager, "polygoncomplete", (poly) => {
        if (drawnPoly) drawnPoly.setMap(null);
        drawnPoly = poly;
        drawingManager.setDrawingMode(null);
        const recompute = () => measureDrawn();
        ["set_at", "insert_at", "remove_at"].forEach(ev => google.maps.event.addListener(poly.getPath(), ev, recompute));
        measureDrawn();
      });
    }

    function clearDrawing() {
      if (drawnPoly) { drawnPoly.setMap(null); drawnPoly = null; }
      if (drawingManager) drawingManager.setDrawingMode(google.maps.drawing.OverlayType.POLYGON);
    }

    function measureDrawn() {
      const p = active(); if (!p || !drawnPoly) return;
      const path = drawnPoly.getPath();
      const area = google.maps.geometry.spherical.computeArea(path);
      const perim = google.maps.geometry.spherical.computeLength(path) + google.maps.geometry.spherical.computeDistanceBetween(path.getAt(path.getLength()-1), path.getAt(0));
      const ring = []; path.forEach(pt => ring.push([pt.lat(), pt.lng()]));
      const report = { source: "Manual trace", roofArea_m2: area, footprint_m2: area, perimeter_m: perim, vertices: ring.length };
      p.report = report;
      p.geometry = { polys: [{ ring, color: "#6ea8fe", pitch: 0, area }], center: [p.lat, p.lng] };
      saveProjects();
      renderReport(report);
      draw3D(p.geometry);
    }

    // -----------------------------------------------------------------------
    // Auto footprint from OpenStreetMap (Overpass), no key
    // -----------------------------------------------------------------------
    async function fetchOsmFootprint() {
      const p = active(); if (!p) return;
      setError(""); const btn = $("map-controls").firstChild; btn.disabled = true; btn.textContent = "Fetching…";
      try {
        const r = await fetch(`/api/osm?lat=${p.lat}&lng=${p.lng}`);
        const j = await r.json();
        if (j.error) throw new Error(j.error);
        const ways = (j.elements || []).filter(e => e.type === "way" && e.geometry && e.geometry.length >= 4);
        if (!ways.length) throw new Error("No OSM building found within 40 m of this point.");
        let best = null, bestD = Infinity;
        for (const w of ways) {
          const ring = w.geometry.map(n => [n.lat, n.lon]);
          const c = centroid(ring);
          const d = (c[0]-p.lat)**2 + (c[1]-p.lng)**2;
          if (d < bestD) { bestD = d; best = ring; }
        }
        const area = geodesicArea(best);
        const perim = geodesicPerimeter(best);
        const report = { source: "OpenStreetMap footprint", roofArea_m2: area, footprint_m2: area, perimeter_m: perim, vertices: best.length };
        p.report = report;
        p.geometry = { polys: [{ ring: best, color: "#4ade80", pitch: 0, area }], center: [p.lat, p.lng] };
        saveProjects();
        renderReport(report);
        draw3D(p.geometry);
        if (mapReady && window.google?.maps) {
          clearRoof();
          const poly = new google.maps.Polygon({ paths: best.map(r => ({ lat: r[0], lng: r[1] })), map, strokeColor: "#4ade80", fillColor: "#4ade80", fillOpacity: 0.25, strokeWeight: 2 });
          roofPolys.push(poly);
        }
      } catch (e) {
        setError("OSM footprint: " + e.message);
      } finally {
        btn.disabled = false; btn.textContent = "Fetch OSM footprint";
      }
    }

    // -----------------------------------------------------------------------
    // Geodesic geometry helpers
    // -----------------------------------------------------------------------
    const R_EARTH = 6378137;
    const toRad = (d) => d * Math.PI / 180;
    function geodesicArea(ring) {
      let a = 0; const n = ring.length;
      for (let i = 0; i < n; i++) {
        const [lat1, lon1] = ring[i], [lat2, lon2] = ring[(i + 1) % n];
        a += toRad(lon2 - lon1) * (2 + Math.sin(toRad(lat1)) + Math.sin(toRad(lat2)));
      }
      return Math.abs(a * R_EARTH * R_EARTH / 2);
    }
    function haversine(a, b) {
      const dLat = toRad(b[0]-a[0]), dLon = toRad(b[1]-a[1]);
      const s = Math.sin(dLat/2)**2 + Math.cos(toRad(a[0]))*Math.cos(toRad(b[0]))*Math.sin(dLon/2)**2;
      return 2 * R_EARTH * Math.asin(Math.sqrt(s));
    }
    function geodesicPerimeter(ring) { let s = 0; for (let i = 0; i < ring.length; i++) s += haversine(ring[i], ring[(i+1)%ring.length]); return s; }
    function centroid(ring) { let x=0,y=0; ring.forEach(r => { x+=r[0]; y+=r[1]; }); return [x/ring.length, y/ring.length]; }

    // -----------------------------------------------------------------------
    // Report rendering — roofing (shingles) + siding
    // -----------------------------------------------------------------------
    const M2_TO_FT2 = 10.7639, M_TO_FT = 3.28084;
    function fmt(n, d = 1) { return n == null ? "—" : Number(n).toLocaleString(undefined, { maximumFractionDigits: d, minimumFractionDigits: 0 }); }
    function metric(k, v) { return `<div class="metric"><span class="k">${k}</span><span class="v">${v}</span></div>`; }

    function renderReport(rep) {
      const el = $("report-body");
      if (!rep) { el.innerHTML = '<div class="empty">No measurement yet.</div>'; return; }

      const waste = wasteFactor();
      const wallM = wallHeightFt() / M_TO_FT;

      // Roof (shingles)
      const sh = shingle();
      const roofFt2 = (rep.roofArea_m2 || 0) * M2_TO_FT2;
      const roofSquares = roofFt2 / 100;
      const roofOrder = roofSquares * (1 + waste / 100);
      const bundles = Math.ceil(roofOrder * sh.bundlesPerSquare);

      // Siding
      const perimM = rep.perimeter_m != null ? rep.perimeter_m : (rep.footprint_m2 ? 4 * Math.sqrt(rep.footprint_m2) : null);
      const sidingFt2 = perimM != null ? perimM * wallM * M2_TO_FT2 : null;
      const sidingSquares = sidingFt2 != null ? sidingFt2 / 100 : null;
      const sidingOrder = sidingSquares != null ? sidingSquares * (1 + waste / 100) : null;

      let html = "";
      html += `<div class="metric"><span class="k">Source</span><span class="v">${escapeHtml(rep.source)}</span></div>`;

      html += `<h3 style="margin:14px 0 6px;">Roof (shingles)</h3>`;
      html += metric("Roof area", `${fmt(roofFt2)} ft² · ${fmt(rep.roofArea_m2)} m²`);
      html += metric("Roofing squares", fmt(roofSquares, 1));
      html += metric(`Order w/ ${fmt(waste,0)}% waste`, `${fmt(roofOrder,1)} sq`);
      html += metric(`Shingles needed`, `${fmt(bundles,0)} bundles`);
      html += `<div class="hint">${escapeHtml(sh.name)} · ${fmt(sh.bundlesPerSquare,0)} bundles/square</div>`;
      if (rep.predominantPitch != null) html += metric("Predominant pitch", `${fmt(rep.predominantPitch)}°`);

      html += `<h3 style="margin:14px 0 6px;">Siding</h3>`;
      if (sidingFt2 != null) {
        html += metric(`Wall area (gross, ${fmt(wallHeightFt(),0)} ft walls)`, `${fmt(sidingFt2)} ft² · ${fmt(sidingFt2/M2_TO_FT2)} m²`);
        html += metric("Siding squares", fmt(sidingSquares, 1));
        html += metric(`Order w/ ${fmt(waste,0)}% waste`, `${fmt(sidingOrder,1)} sq`);
        html += metric("Wall perimeter", `${fmt(perimM * M_TO_FT)} ft${rep.perimeterEstimated ? " (est.)" : ""}`);
      } else {
        html += `<div class="hint">Measure a footprint (Draw or OSM) to estimate siding.</div>`;
      }

      html += `<h3 style="margin:14px 0 6px;">Footprint</h3>`;
      if (rep.footprint_m2 != null) html += metric("Building footprint", `${fmt(rep.footprint_m2 * M2_TO_FT2)} ft² · ${fmt(rep.footprint_m2)} m²`);
      if (rep.vertices != null) html += metric("Vertices", fmt(rep.vertices, 0));
      if (rep.imageryDate) html += metric("Imagery date", rep.imageryDate);

      if (rep.segments && rep.segments.length) {
        html += `<table style="margin-top:12px;"><thead><tr><th>Seg</th><th class="num">Area ft²</th><th class="num">Pitch°</th><th class="num">Azimuth°</th></tr></thead><tbody>`;
        rep.segments.forEach(s => {
          html += `<tr><td>${s.i}</td><td class="num">${fmt(s.area * M2_TO_FT2)}</td><td class="num">${fmt(s.pitch)}</td><td class="num">${fmt(s.azimuth)}</td></tr>`;
        });
        html += `</tbody></table>`;
      }
      el.innerHTML = html;
    }

    // -----------------------------------------------------------------------
    // 3D viewer (Three.js) — extruded roof segments
    // -----------------------------------------------------------------------
    let renderer, scene, camera, controls, raf3d;
    function init3D() {
      const canvas = $("view3d");
      const w = canvas.clientWidth || 400, h = 360;
      renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
      renderer.setSize(w, h, false);
      renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
      scene = new THREE.Scene();
      scene.background = new THREE.Color(0x0b0d11);
      camera = new THREE.PerspectiveCamera(45, w / h, 0.1, 5000);
      camera.position.set(40, 50, 60);
      controls = new OrbitControls(camera, canvas);
      controls.enableDamping = true;
      scene.add(new THREE.HemisphereLight(0xffffff, 0x202830, 1.1));
      const dir = new THREE.DirectionalLight(0xffffff, 1.2); dir.position.set(30, 60, 20); scene.add(dir);
      const grid = new THREE.GridHelper(200, 40, 0x2a2f3a, 0x1f232c); scene.add(grid);
      (function loop() { raf3d = requestAnimationFrame(loop); controls.update(); renderer.render(scene, camera); })();
    }

    // Build an 8-vertex box from a top quad and a bottom quad (each 4 Vector3).
    function makeBox(top, bottom) {
      const v = [...top, ...bottom];
      const pos = new Float32Array(v.length * 3);
      v.forEach((p, i) => { pos[i*3] = p.x; pos[i*3+1] = p.y; pos[i*3+2] = p.z; });
      const idx = [
        0,1,2, 0,2,3,      // top
        4,6,5, 4,7,6,      // bottom
      ];
      for (let i = 0; i < 4; i++) {
        const a = i, b = (i + 1) % 4;        // top edge
        idx.push(a, b, b + 4, a, b + 4, a + 4); // side quad
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
      g.setIndex(idx);
      g.computeVertexNormals();
      return g;
    }

    let buildingGroup = null;
    function draw3D(geometry) {
      if (!renderer) init3D();
      if (buildingGroup) { scene.remove(buildingGroup); buildingGroup.traverse(o => { o.geometry?.dispose?.(); o.material?.dispose?.(); }); }
      $("legend").innerHTML = "";
      if (!geometry || !geometry.polys?.length) return;
      buildingGroup = new THREE.Group();

      const [clat, clng] = geometry.center;
      const mPerDegLat = 111320;
      const mPerDegLng = 111320 * Math.cos(toRad(clat));
      // local meters: x = east, z = south (so north is -z), y = up
      const toXZ = ([lat, lng]) => ({ x: (lng - clng) * mPerDegLng, z: -(lat - clat) * mPerDegLat });
      const wallM = Math.max(2, (wallHeightFt() || 0) / M_TO_FT);
      const ROOF_T = 0.3; // roof slab thickness (m)

      const wallMat = new THREE.MeshStandardMaterial({ color: 0x8a8f99, roughness: 0.9, metalness: 0, transparent: true, opacity: 0.85, side: THREE.DoubleSide });

      const legendItems = [];
      geometry.polys.forEach((poly, idx) => {
        const corners = poly.ring.slice(0, 4).map(toXZ);
        if (corners.length < 4) return;
        const pitch = toRad(poly.pitch || 0);
        const az = toRad(poly.azimuth || 0);
        // downslope direction in (x,z): compass azimuth -> east=sin, north=cos (north=-z)
        const d = { x: Math.sin(az), z: -Math.cos(az) };
        const slopes = corners.map(c => -(c.x * d.x + c.z * d.z) * Math.tan(pitch));
        const minS = Math.min(...slopes);
        // Roof top corners sit on the walls (wallM) and tilt up by the slope.
        const top = corners.map((c, i) => new THREE.Vector3(c.x, wallM + (slopes[i] - minS), c.z));
        const bottom = top.map(v => new THREE.Vector3(v.x, v.y - ROOF_T, v.z));

        const color = new THREE.Color(poly.color || "#6ea8fe");
        const roofGeo = makeBox(top, bottom);
        const roof = new THREE.Mesh(roofGeo, new THREE.MeshStandardMaterial({ color, roughness: 0.85, metalness: 0.05, side: THREE.DoubleSide, flatShading: true }));
        buildingGroup.add(roof);
        buildingGroup.add(new THREE.LineSegments(new THREE.EdgesGeometry(roofGeo), new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.3 })));

        // Walls (siding) under the eave, from ground to wall height.
        const wallTop = corners.map(c => new THREE.Vector3(c.x, wallM, c.z));
        const wallBottom = corners.map(c => new THREE.Vector3(c.x, 0, c.z));
        buildingGroup.add(new THREE.Mesh(makeBox(wallTop, wallBottom), wallMat));

        legendItems.push({ color: poly.color || "#6ea8fe", label: geometry.polys.length > 1 ? `Seg ${idx + 1} · ${fmt(poly.area * M2_TO_FT2)} ft²` : `${fmt(poly.area * M2_TO_FT2)} ft²` });
      });

      // Ground plane for context
      const gp = new THREE.Mesh(new THREE.PlaneGeometry(400, 400), new THREE.MeshStandardMaterial({ color: 0x12151c, roughness: 1 }));
      gp.rotation.x = -Math.PI / 2; gp.position.y = -0.02; buildingGroup.add(gp);

      scene.add(buildingGroup);

      const box = new THREE.Box3().setFromObject(buildingGroup);
      const size = box.getSize(new THREE.Vector3());
      const center = box.getCenter(new THREE.Vector3());
      const maxDim = Math.max(size.x, size.z, 10);
      controls.target.copy(center);
      camera.position.set(center.x + maxDim * 1.1, center.y + maxDim * 1.0 + 10, center.z + maxDim * 1.3);
      camera.near = 0.1; camera.far = maxDim * 50; camera.updateProjectionMatrix();

      $("legend").innerHTML = legendItems.map(l => `<span><span class="swatch" style="background:${l.color}"></span>${escapeHtml(l.label)}</span>`).join("");
    }

    // -----------------------------------------------------------------------
    // Photorealistic 3D — Google Map Tiles (3d-tiles-renderer)
    // -----------------------------------------------------------------------
    let tiles = null, tRenderer, tScene, tCamera, tControls, tRaf, tilesKey = null;
    function disposeTiles() {
      if (tRaf) { cancelAnimationFrame(tRaf); tRaf = null; }
      if (tiles) { try { tiles.dispose(); } catch {} tiles = null; }
      if (tRenderer) { try { tRenderer.dispose(); } catch {} }
      tRenderer = tScene = tCamera = tControls = null;
      tilesKey = null;
    }

    function initTiles(p) {
      const status = $("tiles-status");
      if (!mapsKey) { status.textContent = "Add a Google key with the Map Tiles API enabled to see the real 3D building."; return; }
      const key = `${p.lat.toFixed(6)},${p.lng.toFixed(6)}`;
      if (tiles && tilesKey === key) return; // already showing this location
      disposeTiles();
      tilesKey = key;

      try {
        const canvas = $("tiles3d");
        const w = canvas.clientWidth || 400, h = 360;
        tRenderer = new THREE.WebGLRenderer({ canvas, antialias: true });
        tRenderer.setSize(w, h, false);
        tRenderer.setPixelRatio(Math.min(devicePixelRatio, 2));
        tScene = new THREE.Scene();
        tScene.background = new THREE.Color(0x0b0d11);
        tCamera = new THREE.PerspectiveCamera(60, w / h, 1, 6000);
        tCamera.position.set(120, 90, 120);
        tControls = new OrbitControls(tCamera, canvas);
        tControls.enableDamping = true;
        tControls.target.set(0, 0, 0);
        tScene.add(new THREE.HemisphereLight(0xffffff, 0x404050, 2.2));
        const dl = new THREE.DirectionalLight(0xffffff, 2.0); dl.position.set(1, 2, 1); tScene.add(dl);

        const draco = new DRACOLoader();
        draco.setDecoderPath("https://www.gstatic.com/draco/versioned/decoders/1.5.7/");

        tiles = new TilesRenderer();
        tiles.registerPlugin(new GoogleCloudAuthPlugin({ apiToken: mapsKey, autoRefreshToken: true }));
        tiles.registerPlugin(new GLTFExtensionsPlugin({ dracoLoader: draco }));
        tiles.registerPlugin(new TileCompressionPlugin());
        tiles.registerPlugin(new TilesFadePlugin());
        tiles.registerPlugin(new ReorientationPlugin({ lat: toRad(p.lat), lon: toRad(p.lng), recenter: true }));
        tiles.setCamera(tCamera);
        tiles.setResolutionFromRenderer(tCamera, tRenderer);
        tScene.add(tiles.group);

        status.textContent = "Loading 3D tiles…";
        tiles.addEventListener("load-tile-set", () => { status.textContent = ""; });
        tiles.addEventListener("load-error", () => { status.textContent = "Couldn't load Map Tiles. Enable the Map Tiles API on your key and allow this domain."; });

        (function loop() {
          tRaf = requestAnimationFrame(loop);
          if (!tCamera) return;
          tCamera.updateMatrixWorld();
          tiles.update();
          tControls.update();
          tRenderer.render(tScene, tCamera);
        })();
      } catch (e) {
        status.textContent = "3D tiles error: " + e.message;
        disposeTiles();
      }
    }

    // -----------------------------------------------------------------------
    // Utils
    // -----------------------------------------------------------------------
    function setError(msg) { const e = $("error-box"); e.innerHTML = msg ? `<div class="error">${escapeHtml(msg)}</div>` : ""; }
    function escapeHtml(s) { return String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }

    const onResize = () => {
      if (renderer) { const c = $("view3d"); renderer.setSize(c.clientWidth, 360, false); camera.aspect = c.clientWidth / 360; camera.updateProjectionMatrix(); }
      if (tRenderer && tCamera) { const c = $("tiles3d"); tRenderer.setSize(c.clientWidth, 360, false); tCamera.aspect = c.clientWidth / 360; tCamera.updateProjectionMatrix(); }
    };
    window.addEventListener("resize", onResize);

    // -----------------------------------------------------------------------
    // Boot
    // -----------------------------------------------------------------------
    (async () => {
      try {
        const r = await fetch("/api/maps-key");
        const j = await r.json();
        mapsKey = (j.key || "").trim();
      } catch { /* OSM mode still works */ }
      const ks = $("key-status");
      if (ks) ks.textContent = mapsKey
        ? "Server key configured — autocomplete, imagery, Solar & Map Tiles enabled."
        : "No server key set. OSM footprint still works; add GOOGLE_SOLAR_API_KEY to .env for the rest.";
      if (!activeId && projects.length) activeId = projects[0].id;
      renderProjects();
      renderProjectView();
    })();

    return () => {
      window.removeEventListener("resize", onResize);
      if (raf3d) cancelAnimationFrame(raf3d);
      disposeTiles();
    };
  }, []);

  return <div dangerouslySetInnerHTML={{ __html: MARKUP }} />;
}
