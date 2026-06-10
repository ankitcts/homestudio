"use client";

import { useEffect, useRef } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";

const MARKUP = `
  <div class="topbar">
    <h1>Home Measurement</h1>
    <span class="sub">Geocode an address, measure the roof/footprint, view it in 3D.</span>
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

      <h3 style="margin-top:22px;">Google API key</h3>
      <div class="hint" id="key-status">Checking server key…</div>
    </aside>

    <main class="main">
      <div id="no-project" class="empty">Create or select a project to begin.</div>

      <div id="project-view" style="display:none;">
        <div class="panel">
          <h3>Address</h3>
          <div class="row">
            <input type="text" id="addr-input" placeholder="123 Main St, Dallas, TX" style="flex:1;min-width:280px;" />
            <button id="geocode-btn">Locate</button>
            <span class="status" id="geo-status"></span>
          </div>
        </div>

        <div class="tabs" id="mode-tabs">
          <div class="tab active" data-mode="solar">1 · Solar API (roof)</div>
          <div class="tab" data-mode="draw">2 · Draw to measure</div>
          <div class="tab" data-mode="auto">3 · Auto footprint (OSM)</div>
        </div>

        <div id="mode-hint" class="hint"></div>
        <div id="error-box"></div>

        <div id="map" style="margin-top:12px;"></div>
        <div class="row" id="map-controls" style="margin-top:10px;"></div>

        <div class="split">
          <div class="panel">
            <h3>3D view</h3>
            <canvas id="view3d"></canvas>
            <div class="legend" id="legend"></div>
            <div class="hint">Drag to orbit · scroll to zoom. Footprint extruded for visualization.</div>
          </div>
          <div class="panel report">
            <h3>Measurement report</h3>
            <div id="report-body"><div class="empty">No measurement yet.</div></div>
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
    // -----------------------------------------------------------------------
    const LS_PROJECTS = "hm.projects";
    const LS_ACTIVE = "hm.active";

    let projects = load(LS_PROJECTS, []);
    let activeId = localStorage.getItem(LS_ACTIVE) || null;
    let mode = "solar";
    let mapsKey = ""; // fetched from the server (/api/maps-key)

    function load(k, fallback) { try { return JSON.parse(localStorage.getItem(k)) ?? fallback; } catch { return fallback; } }
    function saveProjects() { localStorage.setItem(LS_PROJECTS, JSON.stringify(projects)); }
    function active() { return projects.find(p => p.id === activeId) || null; }
    function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }

    // -----------------------------------------------------------------------
    // DOM refs
    // -----------------------------------------------------------------------
    const $ = (id) => document.getElementById(id);

    // Maps JS key comes from the server. Solar + Geocoding are proxied server-side.
    function apiKey() { return mapsKey; }

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
      if (activeId === id) { activeId = projects[0]?.id || null; localStorage.setItem(LS_ACTIVE, activeId || ""); }
      renderProjects(); renderProjectView();
    }

    function selectProject(id) {
      activeId = id; localStorage.setItem(LS_ACTIVE, id);
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
      if (p.lat != null) initMapForMode();
      else { mapReady = false; $("map").innerHTML = '<div class="empty">Locate an address to load the map.</div>'; $("map-controls").innerHTML = ""; }
      updateModeHint();
    }

    // -----------------------------------------------------------------------
    // Geocoding (server proxy: /api/geocode)
    // -----------------------------------------------------------------------
    $("geocode-btn").addEventListener("click", geocode);
    $("addr-input").addEventListener("keydown", (e) => { if (e.key === "Enter") geocode(); });

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
        solar: "Google Solar API returns true sloped-roof segment polygons, pitch, azimuth, and area from aerial imagery + DSM. Needs a key with the Solar API enabled.",
        draw: "Trace the building outline on the satellite image. Area & perimeter are computed geodesically as you draw.",
        auto: "Fetches the nearest OpenStreetMap building footprint automatically — free, no key required.",
      };
      $("mode-hint").textContent = hints[mode] || "";
    }

    // -----------------------------------------------------------------------
    // Google Maps loader
    // -----------------------------------------------------------------------
    let gmapsPromise = null;
    function loadGoogleMaps() {
      if (window.google?.maps) return Promise.resolve();
      if (gmapsPromise) return gmapsPromise;
      if (!apiKey()) return Promise.reject(new Error("No Google API key set."));
      gmapsPromise = new Promise((resolve, reject) => {
        window.__gmapsCb = () => resolve();
        const s = document.createElement("script");
        s.src = `https://maps.googleapis.com/maps/api/js?key=${apiKey()}&libraries=geometry,drawing&callback=__gmapsCb`;
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
        // OSM mode does not need Google. Show a lightweight notice + run fetch.
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
    // Option 1 — Google Solar API (server proxy: /api/solar)
    // -----------------------------------------------------------------------
    function clearRoof() { roofPolys.forEach(x => x.setMap(null)); roofPolys = []; }

    async function fetchSolar() {
      const p = active(); if (!p) return;
      setError(""); $("map-controls").firstChild.disabled = true;
      try {
        const url = `/api/solar?lat=${p.lat}&lng=${p.lng}`;
        const r = await fetch(url);
        const j = await r.json();
        if (j.error) throw new Error(j.error.message);
        const sp = j.solarPotential || {};
        const segs = sp.roofSegmentStats || [];
        clearRoof();
        const COLORS = ["#6ea8fe", "#4ade80", "#f59e0b", "#f87171", "#a78bfa", "#22d3ee", "#fb923c", "#34d399"];
        const segReport = [];
        const geomPolys = [];
        let totalArea = 0;
        segs.forEach((s, i) => {
          const b = s.boundingBox; // sw/ne lat-lng box for the segment
          const area = s.stats?.areaMeters2 ?? 0;
          totalArea += area;
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
            geomPolys.push({ ring: path.map(pt => [pt.lat, pt.lng]), color: COLORS[i % COLORS.length], pitch: s.pitchDegrees || 0, area });
          }
        });
        const whole = sp.wholeRoofStats?.areaMeters2 ?? totalArea;
        const report = {
          source: "Google Solar API",
          area_m2: whole,
          footprint_m2: j.buildingStats?.areaMeters2 ?? null,
          segments: segReport,
          maxPanels: sp.maxArrayPanelsCount,
          sunshine: sp.maxSunshineHoursPerYear,
          imageryDate: j.imageryDate ? `${j.imageryDate.year}-${String(j.imageryDate.month).padStart(2,"0")}-${String(j.imageryDate.day).padStart(2,"0")}` : null,
        };
        p.report = report;
        p.geometry = { polys: geomPolys, center: [p.lat, p.lng] };
        saveProjects();
        renderReport(report);
        draw3D(p.geometry);
      } catch (e) {
        setError("Solar API: " + e.message + ". Ensure the Solar API is enabled and the location is covered.");
      } finally {
        if ($("map-controls").firstChild) $("map-controls").firstChild.disabled = false;
      }
    }

    // -----------------------------------------------------------------------
    // Option 2 — Interactive draw to measure
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
      const report = { source: "Manual trace (Google Maps geometry)", area_m2: area, perimeter_m: perim, vertices: ring.length };
      p.report = report;
      p.geometry = { polys: [{ ring, color: "#6ea8fe", pitch: 0, area }], center: [p.lat, p.lng] };
      saveProjects();
      renderReport(report);
      draw3D(p.geometry);
    }

    // -----------------------------------------------------------------------
    // Option 3 — Auto footprint from OpenStreetMap (Overpass), no key
    // -----------------------------------------------------------------------
    async function fetchOsmFootprint() {
      const p = active(); if (!p) return;
      setError(""); const btn = $("map-controls").firstChild; btn.disabled = true; btn.textContent = "Fetching…";
      try {
        const q = `[out:json][timeout:25];(way["building"](around:40,${p.lat},${p.lng});relation["building"](around:40,${p.lat},${p.lng}););out body geom;`;
        const r = await fetch("https://overpass-api.de/api/interpreter", { method: "POST", body: q });
        const j = await r.json();
        const ways = (j.elements || []).filter(e => e.type === "way" && e.geometry && e.geometry.length >= 4);
        if (!ways.length) throw new Error("No OSM building found within 40 m of this point.");
        // pick the building whose centroid is closest to the geocoded point
        let best = null, bestD = Infinity;
        for (const w of ways) {
          const ring = w.geometry.map(n => [n.lat, n.lon]);
          const c = centroid(ring);
          const d = (c[0]-p.lat)**2 + (c[1]-p.lng)**2;
          if (d < bestD) { bestD = d; best = ring; }
        }
        const area = geodesicArea(best);
        const perim = geodesicPerimeter(best);
        const report = { source: "OpenStreetMap building footprint", area_m2: area, perimeter_m: perim, vertices: best.length };
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
    // Report rendering
    // -----------------------------------------------------------------------
    const M2_TO_FT2 = 10.7639, M_TO_FT = 3.28084;
    function fmt(n, d = 1) { return n == null ? "—" : Number(n).toLocaleString(undefined, { maximumFractionDigits: d, minimumFractionDigits: 0 }); }

    function renderReport(rep) {
      const el = $("report-body");
      if (!rep) { el.innerHTML = '<div class="empty">No measurement yet.</div>'; return; }
      let html = `<div class="metric"><span class="k">Source</span><span class="v">${escapeHtml(rep.source)}</span></div>`;
      const areaLabel = rep.source.includes("Solar") ? "Roof area" : "Area";
      html += metric(areaLabel, `${fmt(rep.area_m2)} m² · ${fmt(rep.area_m2 * M2_TO_FT2)} ft²`);
      if (rep.footprint_m2 != null) html += metric("Building footprint", `${fmt(rep.footprint_m2)} m² · ${fmt(rep.footprint_m2 * M2_TO_FT2)} ft²`);
      if (rep.perimeter_m != null) html += metric("Perimeter", `${fmt(rep.perimeter_m)} m · ${fmt(rep.perimeter_m * M_TO_FT)} ft`);
      if (rep.vertices != null) html += metric("Vertices", fmt(rep.vertices, 0));
      if (rep.maxPanels != null) html += metric("Max solar panels", fmt(rep.maxPanels, 0));
      if (rep.sunshine != null) html += metric("Max sunshine", `${fmt(rep.sunshine, 0)} hrs/yr`);
      if (rep.imageryDate) html += metric("Imagery date", rep.imageryDate);

      if (rep.segments && rep.segments.length) {
        html += `<table><thead><tr><th>Seg</th><th class="num">Area m²</th><th class="num">Pitch°</th><th class="num">Azimuth°</th></tr></thead><tbody>`;
        rep.segments.forEach(s => {
          html += `<tr><td>${s.i}</td><td class="num">${fmt(s.area)}</td><td class="num">${fmt(s.pitch)}</td><td class="num">${fmt(s.azimuth)}</td></tr>`;
        });
        html += `</tbody></table>`;
      }
      el.innerHTML = html;
    }
    function metric(k, v) { return `<div class="metric"><span class="k">${k}</span><span class="v">${v}</span></div>`; }

    // -----------------------------------------------------------------------
    // 3D viewer (Three.js) — extruded footprint / roof polygons
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

    let buildingGroup = null;
    function draw3D(geometry) {
      if (!renderer) init3D();
      if (buildingGroup) { scene.remove(buildingGroup); buildingGroup.traverse(o => { o.geometry?.dispose?.(); o.material?.dispose?.(); }); }
      $("legend").innerHTML = "";
      if (!geometry || !geometry.polys?.length) return;
      buildingGroup = new THREE.Group();

      // Project lat/lng to local meters using equirectangular around the center.
      const [clat, clng] = geometry.center;
      const mPerDegLat = 111320;
      const mPerDegLng = 111320 * Math.cos(toRad(clat));
      const project = ([lat, lng]) => new THREE.Vector2((lng - clng) * mPerDegLng, -(lat - clat) * mPerDegLat);

      const legendItems = [];
      geometry.polys.forEach((poly, idx) => {
        const pts2d = poly.ring.map(project);
        const shape = new THREE.Shape(pts2d);
        // Extrude height: scale loosely with footprint so the block reads as a house.
        const baseH = Math.max(3, Math.min(9, Math.sqrt(poly.area || 100) / 3));
        const geo = new THREE.ExtrudeGeometry(shape, { depth: baseH, bevelEnabled: false });
        geo.rotateX(-Math.PI / 2); // lay flat on XZ plane, extrude upward
        const color = new THREE.Color(poly.color || "#6ea8fe");
        const mat = new THREE.MeshStandardMaterial({ color, metalness: 0.1, roughness: 0.7, transparent: true, opacity: 0.92 });
        const mesh = new THREE.Mesh(geo, mat);
        buildingGroup.add(mesh);
        const edges = new THREE.LineSegments(new THREE.EdgesGeometry(geo), new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.25 }));
        buildingGroup.add(edges);
        legendItems.push({ color: poly.color || "#6ea8fe", label: geometry.polys.length > 1 ? `Seg ${idx + 1} · ${fmt(poly.area)} m²` : `${fmt(poly.area)} m²` });
      });

      scene.add(buildingGroup);

      // Fit camera to bounds
      const box = new THREE.Box3().setFromObject(buildingGroup);
      const size = box.getSize(new THREE.Vector3());
      const center = box.getCenter(new THREE.Vector3());
      const maxDim = Math.max(size.x, size.z, 10);
      controls.target.copy(center);
      camera.position.set(center.x + maxDim * 1.2, maxDim * 1.4 + 15, center.z + maxDim * 1.4);
      camera.near = 0.1; camera.far = maxDim * 50; camera.updateProjectionMatrix();

      $("legend").innerHTML = legendItems.map(l => `<span><span class="swatch" style="background:${l.color}"></span>${escapeHtml(l.label)}</span>`).join("");
    }

    // -----------------------------------------------------------------------
    // Utils
    // -----------------------------------------------------------------------
    function setError(msg) { const e = $("error-box"); e.innerHTML = msg ? `<div class="error">${escapeHtml(msg)}</div>` : ""; }
    function escapeHtml(s) { return String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }

    const onResize = () => { if (renderer) { const c = $("view3d"); renderer.setSize(c.clientWidth, 360, false); camera.aspect = c.clientWidth / 360; camera.updateProjectionMatrix(); } };
    window.addEventListener("resize", onResize);

    // -----------------------------------------------------------------------
    // Boot
    // -----------------------------------------------------------------------
    (async () => {
      try {
        const r = await fetch("/api/maps-key");
        const j = await r.json();
        mapsKey = (j.key || "").trim();
      } catch { /* ignore — OSM mode still works */ }
      const ks = $("key-status");
      if (ks) ks.textContent = mapsKey
        ? "Server key configured — Maps, Geocoding & Solar enabled."
        : "No server key set. Option 3 (OSM) works without one; add GOOGLE_SOLAR_API_KEY to .env for the rest.";
      if (!activeId && projects.length) activeId = projects[0].id;
      renderProjects();
      renderProjectView();
    })();

    return () => {
      window.removeEventListener("resize", onResize);
      if (raf3d) cancelAnimationFrame(raf3d);
    };
  }, []);

  return <div dangerouslySetInnerHTML={{ __html: MARKUP }} />;
}
