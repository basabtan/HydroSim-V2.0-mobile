import * as THREE from 'https://esm.sh/three@0.160.0';
import { OrbitControls } from 'https://esm.sh/three@0.160.0/examples/jsm/controls/OrbitControls.js';

// ---------------- Region / scope configuration ----------------
// Each scope loads its own .bin grid set on demand. The Kingdom overview is a
// coarse downsampled national view used for navigation; the four regions are
// full-resolution (~30 m source) flood-analysis windows.
const REGIONS = {
  kingdom:            { name: 'Kingdom of Saudi Arabia', short: 'Kingdom', path: './data/kingdom', overview: true },
  makkah_jeddah_taif: { name: 'Makkah – Jeddah – Taif', short: 'Makkah–Jeddah–Taif', path: './data/regions/makkah_jeddah_taif' },
  riyadh:             { name: 'Riyadh Region',           short: 'Riyadh', path: './data/regions/riyadh' },
  eastern_province:   { name: 'Eastern Province (Dammam – Khobar)', short: 'Eastern Province', path: './data/regions/eastern_province' },
  asir_abha:          { name: 'Asir / Abha Highlands',   short: 'Asir / Abha', path: './data/regions/asir_abha' },
};
let DATA = './data/regions/makkah_jeddah_taif';  // active region data path (mutable)
const state = {
  region: 'makkah_jeddah_taif',  // active scope key
  isOverview: false,
  meta: null,
  elev: null,        // Int16Array
  flow: null,        // Int8Array interleaved dx,dy
  flowacc: null,     // Uint32Array (upstream cell count per pixel)
  twi: null,         // Float32Array Topographic Wetness Index (Phase 3)
  slopeDeg: null,    // Float32Array slope in degrees (Phase 3)
  dtm: null,         // Int16Array bare-earth DTM (Phase 3)
  W: 0, H: 0,
  layer: 'color',
  images: {},        // cached HTMLImageElements
  contour: false,
  three: null,
  profile: { active: false, p0: null, p1: null },
  rain: { active: false, drops: [], raf: null, rate: 5,
          intensity: 5,   // 1-10 drop density / rainfall intensity
          speed: 1.0,     // 0.25-3x animation speed multiplier
          infil: 0 },     // 0-3 soil infiltration class (how fast drops soak away)
  flood: {
    validCount: 0,
    rainDepth: 30,   // mm total
    rainDur: 2,      // hours
    infil: 0,        // 0=low, 1=med, 2=high, 3=very-high
    advanced: false, // Advanced mode: derive rain intensity from i = P/T and show Jeddah IDF return period
    lastResult: null // { floodedCells, maxDepth, totalVolumeM3, peakFlowM3s }
  },
  dams: {
    list: [],          // [{name_en, name_ar, px, py, capacity_m3, catchment_area_km2, ...}]
    labels: null,      // Uint16Array (W*H): 0=no dam controls this cell, else damIndex+1
    show: true,
    lastRun: null,     // [{idx, inflowM3, fillPct, overflowM3, overflows, hoursToFull}]
  },
  cursorInd: null,     // orbit-ring cursor coordinate indicator instance
};

const LEGENDS = {
  color: { title: 'Elevation', grad: 'linear-gradient(90deg,#1e468c,#1e8296,#28a06e,#78be46,#e1d250,#e69632,#c85032,#fafafa)', unit: 'm' },
  hillshade: { title: 'Hillshade (relief)', grad: 'linear-gradient(90deg,#000,#fff)', unit: '' },
  slope: { title: 'Slope', grad: 'linear-gradient(90deg,#1e781e,#f0dc28,#eb7814,#c81e1e)', unit: '°' },
  aspect: { title: 'Aspect (facing direction)', grad: 'linear-gradient(90deg,#ff0040,#ffaa00,#aaff00,#00ffaa,#00aaff,#aa00ff,#ff0040)', unit: '' },
  twi: { title: 'Wetness Index (flood susceptibility)', grad: 'linear-gradient(90deg,#3a2a14,#8a6a32,#d9c27a,#7fc8c8,#2f8fd6,#0b3b8c)', unit: '' },
  dtm: { title: 'Bare-earth elevation (DTM)', grad: 'linear-gradient(90deg,#1e468c,#1e8296,#28a06e,#78be46,#e1d250,#e69632,#c85032,#fafafa)', unit: 'm' },
  fill: { title: 'Sink-fill depth (DEM − DTM)', grad: 'linear-gradient(90deg,#0d1117,#0d1117,#3b82f6,#22d3ee,#fde047,#f97316,#ef4444)', unit: 'm' },
};

// Shared elevation colour ramp (matches the 3D view). [t, r,g,b].
const ELEV_RAMP = [
  [0.0, 0x1e, 0x46, 0x8c], [0.18, 0x1e, 0x82, 0x96], [0.32, 0x28, 0xa0, 0x6e],
  [0.5, 0x78, 0xbe, 0x46], [0.66, 0xe1, 0xd2, 0x50], [0.8, 0xe6, 0x96, 0x32],
  [0.9, 0xc8, 0x50, 0x32], [1.0, 0xfa, 0xfa, 0xfa],
];
function elevColorRGB(t) {
  t = Math.max(0, Math.min(1, t));
  for (let i = 1; i < ELEV_RAMP.length; i++) {
    if (t <= ELEV_RAMP[i][0]) {
      const a = ELEV_RAMP[i - 1], b = ELEV_RAMP[i], f = (t - a[0]) / (b[0] - a[0] || 1);
      return [(a[1] + (b[1] - a[1]) * f) | 0, (a[2] + (b[2] - a[2]) * f) | 0, (a[3] + (b[3] - a[3]) * f) | 0];
    }
  }
  const l = ELEV_RAMP[ELEV_RAMP.length - 1];
  return [l[1], l[2], l[3]];
}

// Sink-fill depth ramp: 0 m (background) -> deep (red). Returns [r,g,b].
const FILL_RAMP = [
  [0.0, 0x3b, 0x82, 0xf6], [0.25, 0x22, 0xd3, 0xee], [0.5, 0xfd, 0xe0, 0x47],
  [0.75, 0xf9, 0x73, 0x16], [1.0, 0xef, 0x44, 0x44],
];
function fillColorRGB(t) {
  t = Math.max(0, Math.min(1, t));
  for (let i = 1; i < FILL_RAMP.length; i++) {
    if (t <= FILL_RAMP[i][0]) {
      const a = FILL_RAMP[i - 1], b = FILL_RAMP[i], f = (t - a[0]) / (b[0] - a[0] || 1);
      return [(a[1] + (b[1] - a[1]) * f) | 0, (a[2] + (b[2] - a[2]) * f) | 0, (a[3] + (b[3] - a[3]) * f) | 0];
    }
  }
  const l = FILL_RAMP[FILL_RAMP.length - 1];
  return [l[1], l[2], l[3]];
}

// TWI colour ramp: dry (warm earth) -> wet (deep blue). Each stop is [t, r,g,b].
const TWI_RAMP = [
  [0.00, 0x3a, 0x2a, 0x14], [0.25, 0x8a, 0x6a, 0x32], [0.45, 0xd9, 0xc2, 0x7a],
  [0.60, 0x7f, 0xc8, 0xc8], [0.80, 0x2f, 0x8f, 0xd6], [1.00, 0x0b, 0x3b, 0x8c],
];
function twiColor(t) {
  t = Math.max(0, Math.min(1, t));
  for (let i = 1; i < TWI_RAMP.length; i++) {
    if (t <= TWI_RAMP[i][0]) {
      const a = TWI_RAMP[i - 1], b = TWI_RAMP[i], f = (t - a[0]) / (b[0] - a[0] || 1);
      return [
        (a[1] + (b[1] - a[1]) * f) | 0,
        (a[2] + (b[2] - a[2]) * f) | 0,
        (a[3] + (b[3] - a[3]) * f) | 0,
      ];
    }
  }
  const l = TWI_RAMP[TWI_RAMP.length - 1];
  return [l[1], l[2], l[3]];
}

// ---------------- Boot ----------------
async function boot() {
  bindUI();
  bindPanelNav();           // bind once; region switches only reload data
  bindRegionUI();
  await loadRegion('makkah_jeddah_taif');
  initCursorIndicator();
  document.getElementById('loading').classList.add('hidden');
}

// Orbit-ring cursor indicator: follows the pointer over the map and shows
// N / E / Elevation. Feeds it real values from the active region's projection
// and DEM. Starts enabled (toggle in the Visualization panel).
function initCursorIndicator() {
  if (state.cursorInd || typeof window.createCursorIndicator !== 'function') return;
  const wrap = document.getElementById('canvasWrap');
  if (!wrap) return;
  const m = (state.meta && state.meta.elevation) ? state.meta.elevation : { min: 0, max: 3000 };
  state.cursorInd = window.createCursorIndicator({
    wrap,
    canvas: mapCanvas,
    elevMin: m.min, elevMax: m.max,
    sample(evt) {
      const { px, py } = canvasToGrid(evt);
      const { lat, lon } = gridToLatLon(px, py);
      const elev = state.layer === 'dtm' ? dtmAt(px, py) : elevAt(px, py);
      return { lat, lon, elev };
    },
  });
  const toggle = document.getElementById('cursorIndToggle');
  // The orbit ring follows a hovering cursor and hides the OS cursor — pointless
  // on touch. On coarse pointers leave it off and hide its toggle; the top
  // readout bar (driven by onMove via touch) is the feedback channel instead.
  const coarse = isCoarsePointer();
  wrap.classList.toggle('ind-on', !coarse && (!toggle || toggle.checked));
  if (coarse && toggle) {
    const row = toggle.closest('.toggle-row');
    if (row) row.style.display = 'none';
  }
}

// Reset all per-region derived caches so the next scope renders fresh.
function resetCaches() {
  state._dtmCache = state._twiCache = state._fillCache = null;
  state._colorCache = state._hillCache = state._slopeCache = state._aspectCache = null;
  state._fillMax = null;
  state.images = {};
  state.flood.lastResult = null;
  state.dams.lastRun = null;
  if (state.three) {
    cancelAnimationFrame(state.three.raf);
    try { state.three.renderer.dispose(); state.three.wrap.innerHTML = ''; } catch (e) {}
    state.three = null;
    const t3 = document.getElementById('threeToggle');
    if (t3) t3.checked = false;
    document.getElementById('threeWrap').classList.add('hidden');
    for (const c of [mapCanvas, overlay, floodCv, waterCv, damsCv]) c.classList.remove('hidden');
  }
  if (state.rain.active) toggleRain(false);
  state.profile.p0 = state.profile.p1 = null;
  const pp = document.getElementById('profilePanel');
  if (pp) pp.classList.add('hidden');
}

async function fetchBin(url, Ctor) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url} -> ${r.status}`);
  return new Ctor(await r.arrayBuffer());
}

// Load a scope (region or Kingdom overview) on demand and render it.
async function loadRegion(key) {
  const cfg = REGIONS[key];
  if (!cfg) return;
  const loadEl = document.getElementById('loading');
  if (loadEl) {
    const p = loadEl.querySelector('p'); if (p) p.textContent = `Loading ${cfg.short}…`;
    loadEl.classList.remove('hidden');
  }
  DATA = cfg.path;
  state.region = key;
  state.isOverview = !!cfg.overview;
  resetCaches();

  const meta = await fetch(`${DATA}/metadata.json`).then(r => r.json());
  state.meta = meta;
  state.W = meta.width;
  state.H = meta.height;
  if (state.cursorInd && meta.elevation) state.cursorInd.setRange(meta.elevation.min, meta.elevation.max);

  state.elev = await fetchBin(`${DATA}/elevation.bin`, Int16Array);

  if (state.isOverview) {
    state.flow = null; state.flowacc = null; state.slopeDeg = null; state.dtm = null;
    try { state.twi = await fetchBin(`${DATA}/twi.bin`, Float32Array); } catch (e) { state.twi = null; }
    state.dams.list = []; state.dams.labels = null;
  } else {
    state.flow = await fetchBin(`${DATA}/flowdir.bin`, Int8Array);
    try { state.flowacc = await fetchBin(`${DATA}/flowacc.bin`, Uint32Array); }
    catch (e) { console.warn('flowacc.bin missing'); state.flowacc = null; }
    try { state.twi = await fetchBin(`${DATA}/twi.bin`, Float32Array); }
    catch (e) { state.twi = null; }
    try { state.slopeDeg = await fetchBin(`${DATA}/slope.bin`, Float32Array); }
    catch (e) { state.slopeDeg = null; }
    try { state.dtm = await fetchBin(`${DATA}/dtm.bin`, Int16Array); }
    catch (e) { console.warn('dtm.bin missing'); state.dtm = null; }
    await loadDams();
  }

  let vc = 0;
  for (let i = 0; i < state.elev.length; i++) if (state.elev[i] !== -32768) vc++;
  state.flood.validCount = vc;

  fillMeta();
  applyScopeUI();
  if (state.isOverview && !['color', 'twi'].includes(state.layer)) state.layer = 'color';
  setLayer(state.layer || 'color');
  if (!state.isOverview) { renderDamsPanel(); drawDamMarkers(); }
  const loadEl2 = document.getElementById('loading');
  if (loadEl2) loadEl2.classList.add('hidden');
}

// Show/hide controls depending on whether we're in the coarse overview or a region.
function applyScopeUI() {
  const ov = state.isOverview;
  const sel = document.getElementById('regionSelect');
  if (sel) sel.value = state.region;
  document.querySelectorAll('.layer-btn').forEach(b => {
    const needsFull = !['color', 'twi'].includes(b.dataset.layer);
    b.style.display = (ov && needsFull) ? 'none' : '';
  });
  const damsP = document.getElementById('damsPanel');
  const waterP = document.querySelector('.water-panel');
  if (damsP) damsP.style.display = ov ? 'none' : '';
  if (waterP) waterP.style.display = ov ? 'none' : '';
  const hint = document.getElementById('overviewHint');
  if (hint) hint.style.display = ov ? '' : 'none';
  const threeRow = document.getElementById('threeToggle');
  if (threeRow) { const r = threeRow.closest('.toggle-row'); if (r) r.style.display = ov ? 'none' : ''; }
  const toolsPanel = document.getElementById('profileBtn');
  if (toolsPanel) { const p = toolsPanel.closest('.panel'); if (p) p.style.display = ov ? 'none' : ''; }
}

function fillMeta() {
  const m = state.meta;
  document.getElementById('regionName').textContent = m.region;
  const b = m.bounds;
  const proj = (m.crs || '').includes('4326') ? 'Geographic (WGS84)'
             : (m.crs ? m.crs.replace(/^EPSG:\d+\s*/, '').replace(/[()]/g, '').trim() : 'UTM');
  const rows = state.isOverview ? [
    ['Scope', 'National overview'],
    ['Resolution', `${m.src_resolution_m}`],
    ['Elev. range', `${m.elevation.min}–${m.elevation.max} m`],
    ['Mean elev.', `${m.elevation.mean} m`],
    ['Projection', proj],
    ['Lat', `${b.lat_min.toFixed(1)}–${b.lat_max.toFixed(1)}°N`],
    ['Lon', `${b.lon_min.toFixed(1)}–${b.lon_max.toFixed(1)}°E`],
  ] : [
    ['Resolution', `${m.src_resolution_m} m`],
    ['Grid', `${(m.src_width||state.W).toLocaleString()} × ${(m.src_height||state.H).toLocaleString()}`],
    ['Coverage', `${m.area_km.width} × ${m.area_km.height} km`],
    ['Elev. range', `${m.elevation.min}–${m.elevation.max} m`],
    ['Mean elev.', `${m.elevation.mean} m`],
    ['Projection', proj],
    ['Lat', `${b.lat_min.toFixed(2)}–${b.lat_max.toFixed(2)}°N`],
    ['Lon', `${b.lon_min.toFixed(2)}–${b.lon_max.toFixed(2)}°E`],
  ];
  document.getElementById('metaList').innerHTML =
    rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('');
}

// ---------------- Phase 2: Dams data ----------------
async function loadDams() {
  try {
    const fc = await fetch(`${DATA}/dams.geojson`).then(r => r.json());
    const b = state.meta.bounds;
    state.dams.list = (fc.features || []).map(f => {
      const lon = f.geometry.coordinates[0], lat = f.geometry.coordinates[1];
      const p = f.properties || {};
      // derive grid px/py from lon/lat when not pre-baked (new regions)
      const px = (p.px != null) ? p.px : (lon - b.lon_min) / (b.lon_max - b.lon_min) * state.W;
      const py = (p.py != null) ? p.py : (b.lat_max - lat) / (b.lat_max - b.lat_min) * state.H;
      return { ...p, lon, lat, px, py };
    });
  } catch (e) {
    state.dams.list = [];
  }
  // Catchment routing grid only exists for regions where it was precomputed
  // (flagged in metadata). Other regions render dams as informational markers.
  if (state.meta && state.meta.has_catchments) {
    try {
      const buf = await fetch(`${DATA}/dam_catchments.bin`).then(r => r.arrayBuffer());
      state.dams.labels = new Uint16Array(buf);
    } catch (e) {
      console.warn('dam_catchments.bin not available — reservoir routing disabled');
      state.dams.labels = null;
    }
  } else {
    state.dams.labels = null;
  }
}

// Procedural basemaps (color/hillshade/slope/aspect) are defined in basemaps.js
// section below; no PNG preload needed for multi-region support.

// ---------------- Layer rendering ----------------
const mapCanvas = document.getElementById('mapCanvas');
const mctx = mapCanvas.getContext('2d');
const overlay = document.getElementById('overlayCanvas');
const octx = overlay.getContext('2d');
const floodCv = document.getElementById('floodCanvas');
const fctx = floodCv.getContext('2d');
const waterCv = document.getElementById('waterCanvas');
const wctx = waterCv.getContext('2d');
const damsCv = document.getElementById('damsCanvas');
const dctx = damsCv.getContext('2d');

// ---------------- Procedural basemaps (region-agnostic) ----------------
// Colour relief, hillshade, slope and aspect are baked from the elevation grid
// so every region renders without pre-made PNGs. Cached to offscreen canvases.
function _cellM() {
  return state.meta.area_km ? (state.meta.area_km.width * 1000 / state.W) : 100;
}
function _eget(x, y, fallback) {
  const v = state.elev[y * state.W + x];
  return v === -32768 ? fallback : v;
}

function bakeColor() {
  const m = state.meta.elevation, lo = m.min, span = (m.max - m.min) || 1;
  const img = mctx.createImageData(state.W, state.H);
  const d = img.data, e = state.elev;
  for (let i = 0; i < e.length; i++) {
    const o = i * 4, v = e[i];
    if (v === -32768) { d[o + 3] = 0; continue; }
    const rgb = elevColorRGB((v - lo) / span);
    d[o] = rgb[0]; d[o + 1] = rgb[1]; d[o + 2] = rgb[2]; d[o + 3] = 255;
  }
  return bakeCanvas(img);
}

function bakeHillshade() {
  const W = state.W, H = state.H, e = state.elev, cellM = _cellM();
  const az = 315 * Math.PI / 180, alt = 45 * Math.PI / 180;
  const sinAlt = Math.sin(alt), cosAlt = Math.cos(alt);
  const img = mctx.createImageData(W, H), d = img.data;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x, o = i * 4;
      if (e[i] === -32768) { d[o + 3] = 0; continue; }
      const c = e[i];
      const cx = Math.max(1, Math.min(W - 2, x)), cy = Math.max(1, Math.min(H - 2, y));
      const dzdx = (_eget(cx + 1, cy, c) - _eget(cx - 1, cy, c)) / (2 * cellM);
      const dzdy = (_eget(cx, cy + 1, c) - _eget(cx, cy - 1, c)) / (2 * cellM);
      const slope = Math.atan(Math.sqrt(dzdx * dzdx + dzdy * dzdy));
      const aspect = Math.atan2(dzdy, -dzdx);
      let hs = sinAlt * Math.cos(slope) + cosAlt * Math.sin(slope) * Math.cos(az - aspect);
      hs = Math.max(0, hs);
      const v = (40 + 215 * hs) | 0;
      d[o] = v; d[o + 1] = v; d[o + 2] = v; d[o + 3] = 255;
    }
  }
  return bakeCanvas(img);
}

function slopeColorRGB(deg) {
  const stops = [[0, 0x1e, 0x78, 0x1e], [10, 0xf0, 0xdc, 0x28], [25, 0xeb, 0x78, 0x14], [45, 0xc8, 0x1e, 0x1e]];
  const t = Math.max(0, Math.min(45, deg));
  for (let i = 1; i < stops.length; i++) {
    if (t <= stops[i][0]) {
      const a = stops[i - 1], b = stops[i], f = (t - a[0]) / (b[0] - a[0] || 1);
      return [(a[1] + (b[1] - a[1]) * f) | 0, (a[2] + (b[2] - a[2]) * f) | 0, (a[3] + (b[3] - a[3]) * f) | 0];
    }
  }
  const l = stops[stops.length - 1]; return [l[1], l[2], l[3]];
}

function bakeSlope() {
  const W = state.W, H = state.H, e = state.elev, cellM = _cellM();
  const img = mctx.createImageData(W, H), d = img.data;
  const haveSlope = !!state.slopeDeg;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x, o = i * 4;
      if (e[i] === -32768) { d[o + 3] = 0; continue; }
      let deg;
      if (haveSlope && isFinite(state.slopeDeg[i])) deg = state.slopeDeg[i];
      else {
        const c = e[i];
        const cx = Math.max(1, Math.min(W - 2, x)), cy = Math.max(1, Math.min(H - 2, y));
        const dzdx = (_eget(cx + 1, cy, c) - _eget(cx - 1, cy, c)) / (2 * cellM);
        const dzdy = (_eget(cx, cy + 1, c) - _eget(cx, cy - 1, c)) / (2 * cellM);
        deg = Math.atan(Math.sqrt(dzdx * dzdx + dzdy * dzdy)) * 180 / Math.PI;
      }
      const rgb = slopeColorRGB(deg);
      d[o] = rgb[0]; d[o + 1] = rgb[1]; d[o + 2] = rgb[2]; d[o + 3] = 255;
    }
  }
  return bakeCanvas(img);
}

function aspectColorRGB(rad) {
  let deg = (rad * 180 / Math.PI + 360) % 360;
  const h = deg / 360;
  const i = Math.floor(h * 6), f = h * 6 - i, q = 1 - f, t = f;
  let r, g, b;
  switch (i % 6) {
    case 0: r = 1; g = t; b = 0; break;
    case 1: r = q; g = 1; b = 0; break;
    case 2: r = 0; g = 1; b = t; break;
    case 3: r = 0; g = q; b = 1; break;
    case 4: r = t; g = 0; b = 1; break;
    default: r = 1; g = 0; b = q; break;
  }
  return [(r * 255) | 0, (g * 255) | 0, (b * 255) | 0];
}

function bakeAspect() {
  const W = state.W, H = state.H, e = state.elev, cellM = _cellM();
  const img = mctx.createImageData(W, H), d = img.data;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x, o = i * 4;
      if (e[i] === -32768) { d[o + 3] = 0; continue; }
      const c = e[i];
      const cx = Math.max(1, Math.min(W - 2, x)), cy = Math.max(1, Math.min(H - 2, y));
      const dzdx = (_eget(cx + 1, cy, c) - _eget(cx - 1, cy, c)) / (2 * cellM);
      const dzdy = (_eget(cx, cy + 1, c) - _eget(cx, cy - 1, c)) / (2 * cellM);
      if (Math.abs(dzdx) < 1e-6 && Math.abs(dzdy) < 1e-6) { d[o] = 60; d[o + 1] = 60; d[o + 2] = 60; d[o + 3] = 255; continue; }
      const rgb = aspectColorRGB(Math.atan2(dzdy, -dzdx));
      d[o] = rgb[0]; d[o + 1] = rgb[1]; d[o + 2] = rgb[2]; d[o + 3] = 255;
    }
  }
  return bakeCanvas(img);
}

// Draw a baked procedural basemap layer (color/hillshade/slope/aspect).
function drawProcedural(layer) {
  const key = '_' + layer + 'Cache';
  if (!state[key]) {
    if (layer === 'color') state[key] = bakeColor();
    else if (layer === 'hillshade') state[key] = bakeHillshade();
    else if (layer === 'slope') state[key] = bakeSlope();
    else if (layer === 'aspect') state[key] = bakeAspect();
  }
  if (state[key]) mctx.drawImage(state[key], 0, 0, state.W, state.H);
}


function fitCanvas() {
  const wrap = document.getElementById('canvasWrap');
  const aspect = state.W / state.H;
  const pad = (window.innerWidth <= 860) ? 12 : 32;   // reclaim space on mobile
  let cw = wrap.clientWidth - pad, ch = wrap.clientHeight - pad;
  if (cw / ch > aspect) cw = ch * aspect; else ch = cw / aspect;
  for (const c of [mapCanvas, overlay, floodCv, waterCv, damsCv]) {
    c.style.width = cw + 'px';
    c.style.height = ch + 'px';
    c.width = state.W;
    c.height = state.H;
  }
  // Re-render flood overlay if a result exists
  if (state.flood.lastResult) runFloodModel();
  drawDamMarkers();
}

function setLayer(layer) {
  state.layer = layer;
  document.querySelectorAll('.layer-btn').forEach(b =>
    b.classList.toggle('active', b.dataset.layer === layer));
  fitCanvas();
  drawMap();
  updateLegend();
}

function drawMap() {
  mctx.clearRect(0, 0, state.W, state.H);
  if (state.layer === 'twi') {
    drawTWI();
  } else if (state.layer === 'dtm') {
    drawDTM();
  } else if (state.layer === 'fill') {
    drawFill();
  } else {
    // color / hillshade / slope / aspect rendered procedurally from the grid
    drawProcedural(state.layer);
  }
  // overview: draw clickable region boxes on top
  if (state.isOverview) drawOverviewBoxes();
  if (state.contour && !state.isOverview) drawContours();
}

// Bare-earth DTM rendered with the same elevation ramp as the Elevation layer,
// so they can be compared directly. Drawn from the int16 dtm grid.
function drawDTM() {
  if (!state.dtm) { missingLayerMsg('Bare-earth DTM not available'); return; }
  if (!state._dtmCache) {
    const m = state.meta.elevation;
    const lo = m.min, span = (m.max - m.min) || 1;
    const img = mctx.createImageData(state.W, state.H);
    const d = img.data, dtm = state.dtm;
    for (let i = 0; i < dtm.length; i++) {
      const o = i * 4, v = dtm[i];
      if (v === -32768) { d[o + 3] = 0; continue; }
      const [r, g, b] = elevColorRGB((v - lo) / span);
      d[o] = r; d[o + 1] = g; d[o + 2] = b; d[o + 3] = 255;
    }
    state._dtmCache = bakeCanvas(img);
  }
  mctx.drawImage(state._dtmCache, 0, 0, state.W, state.H);
}

// Sink-fill depth = sink-filled DEM minus bare-earth DTM. Highlights the closed
// depressions that hydrological conditioning raised (where ponding occurs in reality).
function drawFill() {
  if (!state.dtm || !state.elev) { missingLayerMsg('Fill-depth needs both DEM and DTM'); return; }
  if (!state._fillCache) {
    const elev = state.elev, dtm = state.dtm;
    // find max positive fill for scaling (cap to avoid outlier domination)
    let maxFill = 1;
    for (let i = 0; i < elev.length; i++) {
      if (elev[i] === -32768 || dtm[i] === -32768) continue;
      const diff = elev[i] - dtm[i];
      if (diff > maxFill) maxFill = diff;
    }
    state._fillMax = maxFill;
    const img = mctx.createImageData(state.W, state.H);
    const d = img.data;
    for (let i = 0; i < elev.length; i++) {
      const o = i * 4;
      if (elev[i] === -32768 || dtm[i] === -32768) { d[o + 3] = 0; continue; }
      const diff = elev[i] - dtm[i];
      if (diff <= 0.5) {
        // no fill: faint dark base so the footprint reads as context
        d[o] = 22; d[o + 1] = 27; d[o + 2] = 34; d[o + 3] = 130;
      } else {
        const [r, g, b] = fillColorRGB(diff / maxFill);
        d[o] = r; d[o + 1] = g; d[o + 2] = b; d[o + 3] = 235;
      }
    }
    state._fillCache = bakeCanvas(img);
  }
  mctx.drawImage(state._fillCache, 0, 0, state.W, state.H);
}

function bakeCanvas(imageData) {
  const off = document.createElement('canvas');
  off.width = state.W; off.height = state.H;
  off.getContext('2d').putImageData(imageData, 0, 0);
  return off;
}

function missingLayerMsg(text) {
  mctx.fillStyle = 'rgba(13,17,23,0.9)';
  mctx.fillRect(0, 0, state.W, state.H);
  mctx.fillStyle = '#8b97a6';
  mctx.font = '24px General Sans, sans-serif';
  mctx.textAlign = 'center';
  mctx.fillText(text, state.W / 2, state.H / 2);
}

// Render the wetness index directly from the Float32 grid (no PNG basemap).
// Cells outside the DEM footprint stay transparent.
function drawTWI() {
  if (!state.twi) {
    mctx.fillStyle = 'rgba(13,17,23,0.9)';
    mctx.fillRect(0, 0, state.W, state.H);
    mctx.fillStyle = '#8b97a6';
    mctx.font = '24px General Sans, sans-serif';
    mctx.textAlign = 'center';
    mctx.fillText('Wetness index data not available', state.W / 2, state.H / 2);
    return;
  }
  if (!state._twiCache) {
    const img = mctx.createImageData(state.W, state.H);
    const d = img.data;
    const twi = state.twi, elev = state.elev;
    for (let i = 0; i < twi.length; i++) {
      const o = i * 4;
      // transparent outside the DEM footprint / over sea
      if (elev[i] === -32768) { d[o + 3] = 0; continue; }
      const tv = twi[i];
      if (!isFinite(tv)) { d[o + 3] = 0; continue; }
      const [r, g, b] = twiColor(tv);
      d[o] = r; d[o + 1] = g; d[o + 2] = b; d[o + 3] = 255;
    }
    // bake to an offscreen canvas so redraws (zoom/resize) are instant
    const off = document.createElement('canvas');
    off.width = state.W; off.height = state.H;
    off.getContext('2d').putImageData(img, 0, 0);
    state._twiCache = off;
  }
  mctx.drawImage(state._twiCache, 0, 0, state.W, state.H);
}

function updateLegend() {
  const L = LEGENDS[state.layer];
  document.getElementById('legendTitle').textContent = L.title;
  document.getElementById('legendBar').style.background = L.grad;
  const m = state.meta.elevation;
  const lm = document.getElementById('legendMin'), lx = document.getElementById('legendMax');
  if (state.layer === 'color') { lm.textContent = `${m.min} m`; lx.textContent = `${m.max} m`; }
  else if (state.layer === 'slope') { lm.textContent = '0°'; lx.textContent = '45°+'; }
  else if (state.layer === 'aspect') { lm.textContent = 'N→E→S'; lx.textContent = 'W→N'; }
  else if (state.layer === 'twi') { lm.textContent = 'Dry / well-drained'; lx.textContent = 'Wet / flood-prone'; }
  else if (state.layer === 'dtm') { lm.textContent = `${m.min} m`; lx.textContent = `${m.max} m`; }
  else if (state.layer === 'fill') { lm.textContent = '0 m (no fill)'; lx.textContent = `${(state._fillMax || 0)} m (deepest pit)`; }
  else { lm.textContent = 'shadow'; lx.textContent = 'light'; }
}

// ---------------- Contours ----------------
function elevAt(px, py) {
  const x = Math.max(0, Math.min(state.W - 1, px | 0));
  const y = Math.max(0, Math.min(state.H - 1, py | 0));
  const v = state.elev[y * state.W + x];
  return v === -32768 ? null : v;
}

function drawContours() {
  const m = state.meta.elevation;
  const interval = Math.max(10, Math.round((m.max - m.min) / 18 / 10) * 10);
  mctx.save();
  mctx.strokeStyle = 'rgba(255,255,255,0.32)';
  mctx.lineWidth = 0.6;
  const step = 2;
  for (let y = 0; y < state.H - step; y += step) {
    for (let x = 0; x < state.W - step; x += step) {
      const v = elevAt(x, y);
      if (v === null) continue;
      const band = Math.floor(v / interval);
      const vr = elevAt(x + step, y), vd = elevAt(x, y + step);
      if (vr !== null && Math.floor(vr / interval) !== band) { mctx.beginPath(); mctx.moveTo(x + step, y); mctx.lineTo(x + step, y + step); mctx.stroke(); }
      if (vd !== null && Math.floor(vd / interval) !== band) { mctx.beginPath(); mctx.moveTo(x, y + step); mctx.lineTo(x + step, y + step); mctx.stroke(); }
    }
  }
  mctx.restore();
}

// ---------------- Coordinate mapping ----------------
function canvasToGrid(evt) {
  const r = mapCanvas.getBoundingClientRect();
  const px = (evt.clientX - r.left) / r.width * state.W;
  const py = (evt.clientY - r.top) / r.height * state.H;
  return { px, py };
}
function gridToLatLon(px, py) {
  const b = state.meta.bounds;
  const lon = b.lon_min + (px / state.W) * (b.lon_max - b.lon_min);
  const lat = b.lat_max - (py / state.H) * (b.lat_max - b.lat_min);
  return { lat, lon };
}

// ---------------- Interaction: hover readout ----------------
function dtmAt(px, py) {
  if (!state.dtm) return null;
  const x = Math.max(0, Math.min(state.W - 1, px | 0));
  const y = Math.max(0, Math.min(state.H - 1, py | 0));
  const v = state.dtm[y * state.W + x];
  return v === -32768 ? null : v;
}

function onMove(evt) {
  const { px, py } = canvasToGrid(evt);
  const { lat, lon } = gridToLatLon(px, py);
  const labelEl = document.querySelector('#readout .readout-label');
  const valEl = document.getElementById('readoutValue');
  if (state.layer === 'dtm') {
    const v = dtmAt(px, py);
    if (labelEl) labelEl.textContent = 'Bare-earth';
    valEl.textContent = v === null ? '— m' : `${v} m`;
  } else if (state.layer === 'fill') {
    const e = elevAt(px, py), d = dtmAt(px, py);
    if (labelEl) labelEl.textContent = 'Sink-fill';
    valEl.textContent = (e === null || d === null) ? '— m' : `${Math.max(0, e - d)} m`;
  } else {
    const v = elevAt(px, py);
    if (labelEl) labelEl.textContent = 'Elevation';
    valEl.textContent = v === null ? '— m' : `${v} m`;
  }
  document.getElementById('readoutCoord').textContent = `${lat.toFixed(4)}°N  ${lon.toFixed(4)}°E`;
}

// ---------------- Profile tool ----------------
function startProfile() {
  state.profile.active = !state.profile.active;
  document.getElementById('profileBtn').classList.toggle('active', state.profile.active);
  mapCanvas.classList.toggle('crosshair', state.profile.active);
  if (state.cursorInd) state.cursorInd.setProfiling(state.profile.active);
  state.profile.p0 = state.profile.p1 = null;
  octx.clearRect(0, 0, state.W, state.H);
  document.getElementById('toolHint').textContent = state.profile.active
    ? 'Click the START point, then the END point on the map.'
    : 'Click and drag two points on the map to draw a cross-section.';
}

function onProfileClick(evt) {
  if (!state.profile.active) return;
  const { px, py } = canvasToGrid(evt);
  if (!state.profile.p0) {
    state.profile.p0 = { px, py };
    drawProfileMarkers();
  } else {
    state.profile.p1 = { px, py };
    drawProfileMarkers();
    computeProfile();
    state.profile.active = false;
    document.getElementById('profileBtn').classList.remove('active');
    mapCanvas.classList.remove('crosshair');
    if (state.cursorInd) state.cursorInd.setProfiling(false);
    document.getElementById('toolHint').textContent = 'Profile drawn. Click “Draw elevation profile” to make another.';
  }
}

function drawProfileMarkers() {
  octx.clearRect(0, 0, state.W, state.H);
  const { p0, p1 } = state.profile;
  octx.lineWidth = 2; octx.strokeStyle = '#2dd4bf'; octx.fillStyle = '#2dd4bf';
  const dot = (p) => { octx.beginPath(); octx.arc(p.px, p.py, 5, 0, 7); octx.fill(); };
  if (p0) dot(p0);
  if (p0 && p1) {
    octx.beginPath(); octx.moveTo(p0.px, p0.py); octx.lineTo(p1.px, p1.py); octx.stroke();
    dot(p1);
  }
}

function computeProfile() {
  const { p0, p1 } = state.profile;
  const n = 220;
  const pts = [], elevs = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const px = p0.px + (p1.px - p0.px) * t;
    const py = p0.py + (p1.py - p0.py) * t;
    pts.push(t);
    elevs.push(elevAt(px, py));
  }
  // horizontal distance in km
  const a = gridToLatLon(p0.px, p0.py), b = gridToLatLon(p1.px, p1.py);
  const distKm = haversine(a.lat, a.lon, b.lat, b.lon);
  // Show panel BEFORE drawing so the canvas has a measurable width
  document.getElementById('profilePanel').classList.remove('hidden');
  requestAnimationFrame(() => drawProfileChart(elevs, distKm));
}

function haversine(la1, lo1, la2, lo2) {
  const R = 6371, dLa = (la2 - la1) * Math.PI / 180, dLo = (lo2 - lo1) * Math.PI / 180;
  const x = Math.sin(dLa / 2) ** 2 + Math.cos(la1 * Math.PI / 180) * Math.cos(la2 * Math.PI / 180) * Math.sin(dLo / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x));
}

function drawProfileChart(elevs, distKm) {
  const cv = document.getElementById('profileChart');
  const dpr = window.devicePixelRatio || 1;
  const w = cv.clientWidth, h = 160;
  cv.width = w * dpr; cv.height = h * dpr;
  const c = cv.getContext('2d'); c.scale(dpr, dpr);
  c.clearRect(0, 0, w, h);
  const valid = elevs.filter(v => v !== null);
  const lo = Math.min(...valid), hi = Math.max(...valid);
  const padL = 44, padB = 22, padT = 10, padR = 10;
  const plotW = w - padL - padR, plotH = h - padT - padB;
  const xOf = i => padL + (i / (elevs.length - 1)) * plotW;
  const yOf = v => padT + plotH - ((v - lo) / (hi - lo || 1)) * plotH;

  // grid + y labels
  c.strokeStyle = 'rgba(255,255,255,0.08)'; c.fillStyle = '#8b97a6';
  c.font = '10px JetBrains Mono, monospace'; c.textAlign = 'right';
  for (let g = 0; g <= 4; g++) {
    const val = lo + (hi - lo) * g / 4;
    const y = yOf(val);
    c.beginPath(); c.moveTo(padL, y); c.lineTo(w - padR, y); c.stroke();
    c.fillText(Math.round(val) + 'm', padL - 6, y + 3);
  }
  // x labels
  c.textAlign = 'center';
  for (let g = 0; g <= 4; g++) {
    const x = padL + plotW * g / 4;
    c.fillText((distKm * g / 4).toFixed(1) + 'km', x, h - 6);
  }
  // area fill + line
  c.beginPath();
  elevs.forEach((v, i) => { if (v === null) return; const x = xOf(i), y = yOf(v); i === 0 ? c.moveTo(x, y) : c.lineTo(x, y); });
  const grad = c.createLinearGradient(0, padT, 0, padT + plotH);
  grad.addColorStop(0, 'rgba(45,212,191,0.35)'); grad.addColorStop(1, 'rgba(45,212,191,0.02)');
  c.lineTo(xOf(elevs.length - 1), padT + plotH); c.lineTo(xOf(0), padT + plotH); c.closePath();
  c.fillStyle = grad; c.fill();
  c.beginPath();
  elevs.forEach((v, i) => { if (v === null) return; const x = xOf(i), y = yOf(v); i === 0 ? c.moveTo(x, y) : c.lineTo(x, y); });
  c.strokeStyle = '#2dd4bf'; c.lineWidth = 1.8; c.stroke();

  // stats
  const gain = elevs.reduce((s, v, i) => (i && v !== null && elevs[i - 1] !== null && v > elevs[i - 1]) ? s + (v - elevs[i - 1]) : s, 0);
  document.getElementById('profileStats').innerHTML = `
    <span>Distance <b>${distKm.toFixed(2)} km</b></span>
    <span>Min <b>${Math.round(lo)} m</b></span>
    <span>Max <b>${Math.round(hi)} m</b></span>
    <span>Relief <b>${Math.round(hi - lo)} m</b></span>
    <span>Total ascent <b>${Math.round(gain)} m</b></span>`;
}

// ---------------- 3D terrain ----------------
function init3D() {
  const wrap = document.getElementById('threeWrap');
  const W = wrap.clientWidth, H = wrap.clientHeight;
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(W, H);
  wrap.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x0d1117);
  scene.fog = new THREE.Fog(0x0d1117, 400, 1400);

  const camera = new THREE.PerspectiveCamera(50, W / H, 0.1, 5000);
  camera.position.set(0, 320, 420);

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true; controls.dampingFactor = 0.08;
  controls.maxPolarAngle = Math.PI / 2.05;

  // downsample grid for mesh
  const gw = 300, gh = Math.round(gw * state.H / state.W);
  const geo = new THREE.PlaneGeometry(400, 400 * state.H / state.W, gw - 1, gh - 1);
  geo.rotateX(-Math.PI / 2);
  const m = state.meta.elevation;
  const zExag = 0.42; // vertical exaggeration on normalized scale (toned down)
  const pos = geo.attributes.position;
  const colors = [];

  // Pre-sample a smoothed height field (averaging a small window, ignoring nodata)
  const heights = new Float32Array(gw * gh);
  const win = 2;
  for (let iy = 0; iy < gh; iy++) {
    for (let ix = 0; ix < gw; ix++) {
      const sx0 = Math.round(ix / (gw - 1) * (state.W - 1));
      const sy0 = Math.round(iy / (gh - 1) * (state.H - 1));
      let sum = 0, n = 0;
      for (let dy = -win; dy <= win; dy++) for (let dx = -win; dx <= win; dx++) {
        const xx = sx0 + dx, yy = sy0 + dy;
        if (xx < 0 || yy < 0 || xx >= state.W || yy >= state.H) continue;
        const v = state.elev[yy * state.W + xx];
        if (v === -32768) continue;
        sum += v; n++;
      }
      // nodata (outside footprint) -> sea level (min); else smoothed average
      heights[iy * gw + ix] = n === 0 ? m.min : sum / n;
    }
  }
  const ramp = [
    [0.0, 0x1e, 0x46, 0x8c], [0.32, 0x28, 0xa0, 0x6e], [0.5, 0x78, 0xbe, 0x46],
    [0.66, 0xe1, 0xd2, 0x50], [0.8, 0xe6, 0x96, 0x32], [1.0, 0xfa, 0xfa, 0xfa],
  ];
  function colorFor(t) {
    for (let i = 1; i < ramp.length; i++) {
      if (t <= ramp[i][0]) {
        const a = ramp[i - 1], b = ramp[i], f = (t - a[0]) / (b[0] - a[0]);
        return [(a[1] + (b[1] - a[1]) * f) / 255, (a[2] + (b[2] - a[2]) * f) / 255, (a[3] + (b[3] - a[3]) * f) / 255];
      }
    }
    return [1, 1, 1];
  }
  for (let i = 0; i < pos.count; i++) {
    const v = heights[i];
    const t = (v - m.min) / (m.max - m.min);
    pos.setY(i, t * 110 * zExag);
    const [r, g, b] = colorFor(t);
    colors.push(r, g, b);
  }
  geo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  geo.computeVertexNormals();

  const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95, metalness: 0.0, flatShading: false });
  const mesh = new THREE.Mesh(geo, mat);
  scene.add(mesh);

  const sun = new THREE.DirectionalLight(0xffffff, 2.1);
  sun.position.set(-200, 240, 180); scene.add(sun);
  scene.add(new THREE.AmbientLight(0x6688aa, 0.55));
  scene.add(new THREE.HemisphereLight(0xbfd4ff, 0x1a1410, 0.4));

  state.three = { renderer, scene, camera, controls, mesh, wrap };
  function loop() {
    if (!state.three) return;
    controls.update();
    renderer.render(scene, camera);
    state.three.raf = requestAnimationFrame(loop);
  }
  loop();
}

function toggle3D(on) {
  document.getElementById('threeWrap').classList.toggle('hidden', !on);
  mapCanvas.classList.toggle('hidden', on);
  overlay.classList.toggle('hidden', on);
  floodCv.classList.toggle('hidden', on);
  waterCv.classList.toggle('hidden', on);
  damsCv.classList.toggle('hidden', on);
  // water overlays are 2D-only; pause rain while in 3D
  if (on && state.rain.active) { cancelAnimationFrame(state.rain.raf); }
  else if (!on && state.rain.active) { stepRain(); }
  if (on) document.getElementById('waterBanner').classList.add('hidden');
  else if (state.rain.active) document.getElementById('waterBanner').classList.remove('hidden');
  document.getElementById('readout').style.opacity = on ? '0.4' : '1';
  if (on && !state.three) init3D();
}

// ---------------- Rainfall animation ----------------
function flowAt(px, py) {
  const x = Math.max(0, Math.min(state.W - 1, px | 0));
  const y = Math.max(0, Math.min(state.H - 1, py | 0));
  const i = (y * state.W + x) * 2;
  return { dx: state.flow[i], dy: state.flow[i + 1] };
}

// Infiltration presets for the live animation: how quickly pooled water soaks
// into the ground (pooledMax frames) and how long a drop lives before recycling.
const RAIN_INFIL = [
  { name: 'Low (arid bedrock)', pooledMax: 120, lifeBase: 200 },  // water lingers, slow soak
  { name: 'Medium (sand/gravel)', pooledMax: 70, lifeBase: 160 },
  { name: 'High (sandy soil)',    pooledMax: 35, lifeBase: 120 },
  { name: 'Very high (vegetated)',pooledMax: 18, lifeBase: 90 },   // soaks away fast
];

function spawnDrop() {
  const life = RAIN_INFIL[state.rain.infil].lifeBase;
  // spawn on a random valid cell
  for (let tries = 0; tries < 20; tries++) {
    const x = Math.random() * state.W;
    const y = Math.random() * state.H;
    if (elevAt(x, y) !== null) {
      return { x, y, age: 0, life: life + Math.random() * life * 0.6, vx: 0, vy: 0, pooled: 0 };
    }
  }
  return null;
}

// One physics + draw pass. Called multiple times per frame for higher sim speed.
function rainSubstep(drops, infilCfg) {
  wctx.globalCompositeOperation = 'lighter';
  for (let k = drops.length - 1; k >= 0; k--) {
    const d = drops[k];
    const f = flowAt(d.x, d.y);
    if (f.dx === 0 && f.dy === 0) {
      d.pooled++;
    } else {
      // momentum-smoothed downhill motion, scaled by intensity (heavier rain = faster runoff)
      const speed = 0.9 + 0.04 * state.rain.intensity;
      d.vx = d.vx * 0.5 + f.dx * speed * 0.5;
      d.vy = d.vy * 0.5 + f.dy * speed * 0.5;
      d.x += d.vx;
      d.y += d.vy;
      d.pooled = 0;
    }
    d.age++;
    const out = elevAt(d.x, d.y) === null;
    const t = Math.min(1, d.age / d.life);
    const alpha = (1 - t) * 0.9;
    const r = d.pooled > 0 ? 2.2 : 1.4;
    wctx.beginPath();
    wctx.fillStyle = d.pooled > 3
      ? `rgba(56,189,248,${alpha})`        // pooled -> brighter blue
      : `rgba(125,211,252,${alpha})`;      // flowing -> light cyan
    wctx.arc(d.x, d.y, r, 0, 7);
    wctx.fill();
    // recycle when expired, off-map, or fully soaked into the ground (infiltration)
    if (d.age > d.life || out || d.pooled > infilCfg.pooledMax) {
      const nd = spawnDrop();
      if (nd) drops[k] = nd; else drops.splice(k, 1);
    }
  }
}

function stepRain() {
  if (!state.rain.active) return;
  const drops = state.rain.drops;
  const infilCfg = RAIN_INFIL[state.rain.infil];
  // population scales with intensity (1-10): light drizzle -> heavy downpour
  const target = 80 + state.rain.intensity * 180;
  while (drops.length < target) {
    const d = spawnDrop();
    if (d) drops.push(d); else break;
  }
  while (drops.length > target * 1.1) drops.pop();  // shrink quickly if intensity lowered

  // trail fade — faster soak fade when infiltration is high, so pooled water clears.
  const fade = 0.10 + state.rain.infil * 0.05;
  wctx.globalCompositeOperation = 'destination-out';
  wctx.fillStyle = `rgba(0,0,0,${fade})`;
  wctx.fillRect(0, 0, state.W, state.H);

  // sim speed: run 1-3 physics substeps per animation frame
  const substeps = Math.max(1, Math.round(state.rain.speed * 1.2));
  for (let s = 0; s < substeps; s++) rainSubstep(drops, infilCfg);

  state.rain.raf = requestAnimationFrame(stepRain);
}

function toggleRain(on) {
  state.rain.active = on;
  document.getElementById('rainBtn').classList.toggle('active', on);
  document.getElementById('rainBtn').innerHTML = on
    ? '<span class="wb-ico">■</span> Stop rainfall'
    : '<span class="wb-ico">☂</span> Start rainfall';
  const banner = document.getElementById('waterBanner');
  banner.classList.toggle('hidden', !on);
  if (on) {
    document.getElementById('waterBannerText').textContent = 'Rainfall active — water flows downhill into channels';
    state.rain.drops = [];
    wctx.clearRect(0, 0, state.W, state.H);
    stepRain();
  } else {
    cancelAnimationFrame(state.rain.raf);
    wctx.clearRect(0, 0, state.W, state.H);
  }
}

// ---------------- Rainfall-Runoff Flood Model ----------------
// Physically-motivated, real-time browser model.
//
// Inputs:
//   P  = rainfall depth (mm)
//   T  = storm duration (h)
//   I  = infiltration class (0..3)
//
// For each cell we compute:
//   runoff_coef C  = f(slope, infiltration)
//   effective rain Pe = P * C (mm)
//   upstream cells A_up (from flow accumulation)
//   contributing area A = (A_up + 1) * cellArea_m2
//   water volume V = Pe / 1000 * A  (m^3)
//   peak discharge Q = V / (T*3600) * peakFactor  (m^3/s)
//   stream width w = a * Q^b  (regime equation, Leopold & Maddock)
//   water depth d = c * Q^f
// Cell is flagged “flooded” if d exceeds visualization threshold.
//
// All constants are calibrated for arid wadi catchments (Saudi Arabia).

const INFIL_PRESETS = [
  { name: 'Low (arid bedrock)', baseRunoff: 0.70, infilMM: 5 },
  { name: 'Medium (sand/gravel)', baseRunoff: 0.45, infilMM: 15 },
  { name: 'High (sandy soil)',    baseRunoff: 0.25, infilMM: 30 },
  { name: 'Very high (vegetated)',baseRunoff: 0.12, infilMM: 50 },
];

// ---------------- Jeddah IDF design storms (Advanced mode) ----------------
// Regional frequency analysis depths (mm) anchored to Awadallah regional IDF
// curves and the Jeddah/Madinah frequency studies. The 50-yr (~94 mm) and
// 100-yr (~106 mm) depths bracket the catastrophic Nov-2009 (~90 mm / 4 h) and
// Jan-2011 (~111 mm / ~4.7 h) flash floods used here as calibration events.
// Sources: Awadallah regional IDF (J. Flood Risk Mgmt 2014); Hadadin et al.
// (Arab J Sci Eng 2013); Azeez & Elfeki (Nat Hazards 2019); UTM MJCE 2016.
const JEDDAH_IDF = [   // ascending depth; pick nearest-at-or-below for the label
  { years: 2,   depth: 18,  note: '' },
  { years: 5,   depth: 29,  note: '' },
  { years: 10,  depth: 44,  note: '' },
  { years: 25,  depth: 69,  note: '' },
  { years: 50,  depth: 94,  note: 'comparable to the Nov 2009 flood' },
  { years: 100, depth: 106, note: 'comparable to the Jan 2011 flood' },
];

// Storm intensity i = P / T (mm/h). Jeddah "heavy rain" threshold = 25 mm/h.
function stormIntensity(P, T) { return T > 0 ? P / T : 0; }
function intensityBand(i) {
  if (i < 2)  return 'Light';
  if (i < 10) return 'Moderate';
  if (i < 25) return 'Heavy';
  if (i < 50) return 'Torrential';
  return 'Extreme';
}
// Map computed intensity (mm/h) onto the 1-10 animation drop-density scale.
function intensityToAnim(i) {
  return Math.max(1, Math.min(10, Math.round(1 + i / 5)));
}
// Classify a rainfall depth against the Jeddah IDF table -> return-period label.
function returnPeriodLabel(P) {
  let band = null;
  for (const r of JEDDAH_IDF) { if (P >= r.depth) band = r; }
  if (!band) return `< 2-yr storm (${P} mm)`;
  const top = JEDDAH_IDF[JEDDAH_IDF.length - 1];
  const ge = (band === top && P > top.depth) ? '≥' : '≈';
  let s = `${ge}${band.years}-yr storm`;
  if (band.note) s += ` — ${band.note}`;
  return s;
}
// Live storm summary shown under the depth slider in Advanced mode.
function updateStormReadout() {
  const el = document.getElementById('stormReadout');
  if (!el) return;
  if (!state.flood.advanced) { el.style.display = 'none'; return; }
  const P = state.flood.rainDepth, T = state.flood.rainDur;
  const i = stormIntensity(P, T);
  el.style.display = 'block';
  el.innerHTML =
    `Intensity <b>${i.toFixed(1)} mm/h</b> (${intensityBand(i)}) ` +
    `· ${returnPeriodLabel(P)}`;
}

function computeSlopeFromFlow(i) {
  // Approximate slope magnitude from flow direction dx,dy and neighbour elev.
  const fi = i * 2;
  const dx = state.flow[fi], dy = state.flow[fi + 1];
  if (dx === 0 && dy === 0) return 0;
  const W = state.W;
  const x = i % W, y = (i / W) | 0;
  const nx = x + dx, ny = y + dy;
  if (nx < 0 || nx >= W || ny < 0 || ny >= state.H) return 0;
  const v = state.elev[i];
  const nv = state.elev[ny * W + nx];
  if (v === -32768 || nv === -32768) return 0;
  const dist = (dx !== 0 && dy !== 0) ? 42.43 : 30; // cell ~30m, diag = 30*sqrt(2)
  return Math.max(0, (v - nv) / dist); // rise/run
}

// ---------------- Phase 2: Reservoir routing ----------------
// For each dam, estimate how much runoff volume its upstream catchment delivers
// during the storm, fill the reservoir to capacity, and compute overflow.
// Returns a per-dam result array and a Set of dam indices that are CONTAINING
// (not overflowing) — channels controlled by those dams get suppressed flooding.
function computeReservoirs(Pe, baseRunoff, T) {
  const dams = state.dams.list;
  const results = dams.map((d, idx) => {
    // Catchment-average runoff coefficient: use base runoff with a mild slope
    // uplift typical of arid uplands. Inflow volume = area * effective_rain * C.
    const C = Math.min(0.95, baseRunoff + 0.12);
    const areaM2 = (d.catchment_area_km2 || 0) * 1e6;
    const inflowM3 = (Pe / 1000) * areaM2 * C;     // total storm runoff into reservoir
    const cap = d.capacity_m3 || 0;
    const fillPct = cap > 0 ? Math.min(100, 100 * inflowM3 / cap) : 100;
    const overflowM3 = Math.max(0, inflowM3 - cap);
    const overflows = overflowM3 > 0;
    // crude time-to-full: storm delivers inflow linearly over T hours
    const hoursToFull = (overflows && inflowM3 > 0)
      ? +(T * cap / inflowM3).toFixed(1) : null;
    return { idx, name: d.name_en, inflowM3, cap, fillPct, overflowM3, overflows, hoursToFull };
  });
  // dams that fully contain their storm runoff -> attenuate downstream channels
  const containing = new Set(results.filter(r => !r.overflows && r.cap > 0).map(r => r.idx));
  return { results, containing };
}

function runFloodModel() {
  if (!state.flowacc) {
    document.getElementById('floodStat').innerHTML =
      '<b>Flow accumulation data missing.</b> Cannot run physically-based model.';
    return;
  }
  const t0 = performance.now();
  const P = state.flood.rainDepth;      // mm
  const T = state.flood.rainDur;        // hours
  const preset = INFIL_PRESETS[state.flood.infil];
  const baseRunoff = preset.baseRunoff;
  const infilMM = preset.infilMM;

  // Effective rainfall after subtracting initial abstraction (SCS-style)
  // Pe = max(0, P - 0.2 * S)  where S ≈ infilMM here
  const Pe = Math.max(0, P - 0.2 * infilMM);

  // Phase 2 — reservoir routing: which dams hold back their catchment runoff?
  const labels = state.dams.labels;
  const reservoir = state.dams.list.length
    ? computeReservoirs(Pe, baseRunoff, T) : { results: [], containing: new Set() };
  const containing = reservoir.containing;
  const useDamRouting = labels && state.dams.list.length > 0;

  // Source DEM resolution (m) - need to use the source 30m not the display pixel
  // because flowacc was computed at source resolution.  Each display pixel
  // corresponds to multiple source cells; we approximate with display pixel area.
  const m = state.meta;
  const pixelM = (m.area_km.width * 1000) / state.W;  // ~110m at display res
  const pixelArea = pixelM * pixelM;                  // m² per display pixel

  // Each flowacc value counts cells at SOURCE resolution (30m).
  // So contributing area for a display pixel ≈ acc * 30 * 30 m²
  const srcCellArea = m.src_resolution_m * m.src_resolution_m;  // 900 m²

  const img = fctx.createImageData(state.W, state.H);
  const data = img.data;

  let floodedCells = 0;
  let maxDepth = 0;
  let totalVolume = 0;
  let peakQ = 0;

  // Channel threshold: only cells with substantial upstream area are stream channels.
  // 50 source cells = 50 * 900 m² = 4.5 hectares of upstream drainage = minimum wadi.
  // Below this, water is sheet flow / hillslope runoff (not "flooding").
  const CHANNEL_THRESHOLD = 50;

  // Phase 3 — TWI-based flood susceptibility.
  // state.twi is a 0..1 percentile-rank wetness/susceptibility index derived from
  // the user's authoritative TWI raster (1 = wettest valley bottoms that pond and
  // flood first, 0 = driest well-drained cells). We map it to a depth multiplier
  // so saturated low-lying cells get deeper modelled water and well-drained cells
  // get slightly less — without changing total runoff volume.
  const twi = state.twi;
  const TWI_PIVOT = 0.5;                 // median susceptibility -> no change
  const TWI_MIN_MULT = 0.8, TWI_MAX_MULT = 1.6;
  let pondingCells = 0;   // high-susceptibility off-channel cells flagged as ponding-prone

  const N = state.elev.length;
  let floodedAreaM2 = 0;

  for (let i = 0; i < N; i++) {
    const ev = state.elev[i];
    const o = i * 4;
    if (ev === -32768) { data[o+3] = 0; continue; }

    // Exclude sea (elevation ≤ 0): these are ocean, not land floods.
    if (ev <= 1) { data[o+3] = 0; continue; }

    const acc = state.flowacc[i];

    // Only channel cells can flood. Hillslopes shed water - don't count them.
    if (acc < CHANNEL_THRESHOLD) { data[o+3] = 0; continue; }

    // Phase 2: if this channel cell drains into a dam that fully CONTAINS its
    // storm runoff, the reservoir holds the water back — no downstream flood here.
    if (useDamRouting) {
      const dl = labels[i];
      if (dl > 0 && containing.has(dl - 1)) { data[o+3] = 0; continue; }
    }

    // Local slope influences runoff coefficient of upstream area
    const s = computeSlopeFromFlow(i);
    const slopeBoost = Math.min(1, s * 3);
    const C = Math.min(0.95, baseRunoff + 0.25 * slopeBoost);

    // Upstream contributing area in m²
    const Aup = (acc + 1) * srcCellArea;

    // Total runoff volume that passes through this channel cell (m³)
    const V = (Pe / 1000) * Aup * C;

    // Peak discharge - simplified peaking factor for arid flashy catchments
    // Q_peak ≈ V / (T*3600) * 2.5
    const Q = V / (T * 3600) * 2.5;

    // Regime equations for arid channels (Leopold-style)
    let depth = 0;
    if (Q > 0.05) {
      depth = 0.27 * Math.pow(Q, 0.30);
    }

    // Phase 3: amplify/dampen depth by local wetness susceptibility (0..1).
    if (twi) {
      const tv = twi[i];
      if (isFinite(tv)) {
        const f = (tv - TWI_PIVOT) / 0.5;                    // -1..+1
        const mult = Math.max(TWI_MIN_MULT,
                     Math.min(TWI_MAX_MULT, 1 + 0.4 * f));
        depth *= mult;
      }
    }

    // Flood threshold: water depth > 0.3 m in a channel = significant flooding
    // (cars float at ~0.3 m, pedestrians swept at ~0.5 m)
    if (depth > 0.30) {
      floodedCells++;
      // Channel-width-aware area accounting:
      // Regime equation: width w ≈ 2.5 * Q^0.5 (m).
      // Flooded area in this pixel ≈ min(pixelM, w) * pixelM (channel length × width)
      const channelWidth = 2.5 * Math.sqrt(Q);
      const effectiveWidth = Math.min(pixelM, channelWidth);
      floodedAreaM2 += effectiveWidth * pixelM;

      if (depth > maxDepth) maxDepth = depth;
      if (Q > peakQ) { peakQ = Q; totalVolume = V; }

      // Color by depth: light cyan (shallow) -> deep navy (deep)
      const dNorm = Math.min(1, Math.log10(depth * 20 + 1) / 2.0);
      data[o]     = (140 - 110 * dNorm) | 0;
      data[o + 1] = (210 -  90 * dNorm) | 0;
      data[o + 2] = (255 -  35 * dNorm) | 0;
      data[o + 3] = (140 + 110 * dNorm) | 0;
    } else {
      data[o + 3] = 0;
    }
  }

  fctx.putImageData(img, 0, 0);

  state.flood.lastResult = {
    floodedCells, maxDepth, totalVolume, peakQ,
    P, T, Pe, infilName: preset.name, runtime: (performance.now() - t0)|0
  };

  // Phase 2: store reservoir results and refresh the Dams panel + markers
  state.dams.lastRun = reservoir.results;
  renderDamsPanel();
  drawDamMarkers();

  // Update readout - use channel-width-aware area, not pixel count
  const pct = (100 * floodedCells / state.flood.validCount).toFixed(2);
  const areaKm2 = floodedAreaM2 / 1e6;
  document.getElementById('floodStat').innerHTML = `
    <div class="flood-readout">
      <div><b>${pct}%</b> of area flooded (${areaKm2.toFixed(1)} km²)</div>
      <div>Max depth: <b>${maxDepth.toFixed(2)} m</b></div>
      <div>Peak discharge: <b>${(peakQ).toLocaleString(undefined,{maximumFractionDigits:1})} m³/s</b></div>
      <div>Runoff volume: <b>${(totalVolume/1e6).toFixed(2)} M m³</b></div>
      ${state.flood.advanced ? `<div>Intensity: <b>${stormIntensity(P,T).toFixed(1)} mm/h</b> (${intensityBand(stormIntensity(P,T))}) · <b>${returnPeriodLabel(P)}</b></div>` : ''}
      <div class="hint-sub">Storm: ${P} mm over ${T} h → effective ${Pe.toFixed(1)} mm · ${preset.name}</div>
      <div class="hint-sub">Compute: ${state.flood.lastResult.runtime} ms</div>
    </div>`;
}

function clearFlood() {
  fctx.clearRect(0, 0, state.W, state.H);
  state.flood.lastResult = null;
  // Phase 2: reset reservoir state + panel
  state.dams.lastRun = null;
  const s = document.getElementById('damsSummary');
  if (s) s.remove();
  document.getElementById('damsHint').textContent =
    'Run the flood model to see how each reservoir fills and which ones overflow.';
  renderDamsPanel();
  drawDamMarkers();
  document.getElementById('floodStat').innerHTML =
    'Set rainfall, then run the model to predict flooded wadis and depths.';
}

// ---------------- Phase 2: Dam markers + panel ----------------
function damColor(fillPct, overflows) {
  if (overflows || fillPct >= 95) return '#ef4444';   // red
  if (fillPct >= 70) return '#f59e0b';                // amber
  return '#22c55e';                                   // green
}

function drawDamMarkers() {
  if (!dctx) return;
  dctx.clearRect(0, 0, state.W, state.H);
  if (!state.dams.show || !state.dams.list.length) return;
  const runById = {};
  if (state.dams.lastRun) for (const r of state.dams.lastRun) runById[r.idx] = r;
  state.dams.list.forEach((d, idx) => {
    const x = d.px, y = d.py;
    if (x == null || y == null) return;
    const r = runById[idx];
    const color = r ? damColor(r.fillPct, r.overflows) : '#7dd3fc';
    // base marker: triangle (dam symbol)
    const s = 9;
    dctx.save();
    dctx.translate(x, y);
    // outer ring for visibility
    dctx.beginPath(); dctx.arc(0, 0, s + 3, 0, 7);
    dctx.fillStyle = 'rgba(13,17,23,0.78)'; dctx.fill();
    // dam triangle
    dctx.beginPath();
    dctx.moveTo(0, -s); dctx.lineTo(s, s * 0.8); dctx.lineTo(-s, s * 0.8); dctx.closePath();
    dctx.fillStyle = color; dctx.fill();
    dctx.lineWidth = 1.6; dctx.strokeStyle = 'rgba(255,255,255,0.85)'; dctx.stroke();
    // overflow pulse ring
    if (r && r.overflows) {
      dctx.beginPath(); dctx.arc(0, 0, s + 7, 0, 7);
      dctx.lineWidth = 2; dctx.strokeStyle = 'rgba(239,68,68,0.7)'; dctx.stroke();
    }
    dctx.restore();
  });
}

function fmtVol(m3) {
  const mcm = m3 / 1e6;
  if (mcm >= 1) return `${mcm.toFixed(1)} MCM`;
  if (m3 >= 1000) return `${(m3 / 1000).toFixed(0)}k m³`;
  return `${Math.round(m3)} m³`;
}

function renderDamsPanel() {
  const listEl = document.getElementById('damsList');
  const hintEl = document.getElementById('damsHint');
  if (!listEl) return;
  const dams = state.dams.list;
  if (!dams.length) {
    hintEl.textContent = 'No dam data available for this region.';
    listEl.innerHTML = '';
    return;
  }
  const run = state.dams.lastRun;
  const runById = {};
  if (run) for (const r of run) runById[r.idx] = r;

  // sort: overflowing first, then by fill desc, then capacity desc
  const order = dams.map((d, idx) => idx).sort((a, b) => {
    const ra = runById[a], rb = runById[b];
    if (ra && rb) {
      if (ra.overflows !== rb.overflows) return ra.overflows ? -1 : 1;
      if (Math.abs(rb.fillPct - ra.fillPct) > 0.01) return rb.fillPct - ra.fillPct;
    }
    return (dams[b].capacity_m3 || 0) - (dams[a].capacity_m3 || 0);
  });

  listEl.innerHTML = order.map(idx => {
    const d = dams[idx];
    const r = runById[idx];
    const fill = r ? r.fillPct : 0;
    const color = r ? damColor(r.fillPct, r.overflows) : '#3a4250';
    const capTxt = d.capacity_m3 ? fmtVol(d.capacity_m3) : '—';
    const estTag = d.verified ? '' : '<span class="dam-est">est.</span>';
    const sub = r
      ? `<div class="dam-sub">
           <span>Inflow <b>${fmtVol(r.inflowM3)}</b></span>
           <span>${r.overflows
             ? `<b style="color:#f87171">Overflow ${fmtVol(r.overflowM3)}</b>`
             : `Fill <b>${fill.toFixed(0)}%</b>`}</span>
         </div>`
      : `<div class="dam-sub"><span>Catchment <b>${(d.catchment_area_km2||0).toFixed(1)} km²</b></span><span>${estTag}</span></div>`;
    return `<div class="dam-row${r && r.overflows ? ' overflow' : ''}">
      <div class="dam-row-top">
        <span class="dam-name"><span class="dam-dot" style="background:${color}"></span>${d.name_en}</span>
        <span class="dam-cap">${capTxt} ${d.verified ? '' : estTag}</span>
      </div>
      <div class="dam-bar"><div class="dam-bar-fill" style="width:${Math.min(100,fill)}%;background:${color}"></div></div>
      ${sub}
    </div>`;
  }).join('');

  // summary
  if (run) {
    const overflowing = run.filter(r => r.overflows);
    const totalCap = dams.reduce((s, d) => s + (d.capacity_m3 || 0), 0);
    const totalIn = run.reduce((s, r) => s + r.inflowM3, 0);
    const totalOver = run.reduce((s, r) => s + r.overflowM3, 0);
    let html = `<b>${dams.length}</b> dams · total capacity <b>${fmtVol(totalCap)}</b><br>`;
    html += `Storm runoff into reservoirs: <b>${fmtVol(totalIn)}</b><br>`;
    if (overflowing.length) {
      const names = overflowing.slice(0, 4).map(r => r.name).join(', ')
        + (overflowing.length > 4 ? `, +${overflowing.length - 4} more` : '');
      const soonest = overflowing
        .filter(r => r.hoursToFull != null)
        .sort((a, b) => a.hoursToFull - b.hoursToFull)[0];
      html += `<span class="ov"><b>${overflowing.length} overflowing</b></span>: ${names}<br>`;
      html += `Uncontrolled discharge downstream: <b class="ov">${fmtVol(totalOver)}</b>`;
      if (soonest) html += `<br>First overflow ≈ <b>${soonest.hoursToFull} h</b> after storm start (${soonest.name})`;
    } else {
      html += `<b style="color:#22c55e">All reservoirs contain this storm</b> — no dam overflow.`;
    }
    hintEl.innerHTML = '';
    let s = document.getElementById('damsSummary');
    if (!s) { s = document.createElement('div'); s.id = 'damsSummary'; s.className = 'dams-summary'; listEl.after(s); }
    s.innerHTML = html;
  }
}

function toggleDams(on) {
  state.dams.show = on;
  drawDamMarkers();
}

// Legacy compat: keep renderFlood as a no-op since old bathtub slider is removed.
function renderFlood() { /* deprecated */ }

// ---------------- UI binding ----------------

// ---------------- Region picker + Kingdom overview navigation ----------------
function bindRegionUI() {
  const sel = document.getElementById('regionSelect');
  if (sel) {
    sel.innerHTML = Object.entries(REGIONS)
      .map(([k, v]) => `<option value="${k}">${v.overview ? '\u2014 ' + v.name + ' \u2014' : v.name}</option>`)
      .join('');
    sel.value = state.region;
    sel.addEventListener('change', e => loadRegion(e.target.value));
  }
  const kbtn = document.getElementById('kingdomBtn');
  if (kbtn) kbtn.addEventListener('click', () => loadRegion('kingdom'));
  // click on the overview map jumps into the region whose box was clicked
  mapCanvas.addEventListener('click', onOverviewClick);
}

// lon/lat -> grid pixel on the current (overview) map
function lonLatToPx(lon, lat) {
  const b = state.meta.bounds;
  const px = (lon - b.lon_min) / (b.lon_max - b.lon_min) * state.W;
  const py = (b.lat_max - lat) / (b.lat_max - b.lat_min) * state.H;
  return { px, py };
}

// Draw the four region AOIs as labelled, clickable rectangles on the overview.
function drawOverviewBoxes() {
  const boxes = state.meta.region_boxes;
  if (!boxes) return;
  octx.clearRect(0, 0, state.W, state.H);
  octx.save();
  octx.lineWidth = 3;
  octx.font = 'bold 22px General Sans, sans-serif';
  octx.textBaseline = 'top';
  for (const [key, bb] of Object.entries(boxes)) {
    const cfg = REGIONS[key]; if (!cfg) continue;
    const tl = lonLatToPx(bb[0], bb[3]);   // lon_min, lat_max
    const br = lonLatToPx(bb[2], bb[1]);   // lon_max, lat_min
    const x = tl.px, y = tl.py, w = br.px - tl.px, h = br.py - tl.py;
    octx.strokeStyle = 'rgba(45,212,191,0.95)';
    octx.fillStyle = 'rgba(45,212,191,0.14)';
    octx.fillRect(x, y, w, h);
    octx.strokeRect(x, y, w, h);
    // label chip
    const label = cfg.short;
    const tw = octx.measureText(label).width;
    octx.fillStyle = 'rgba(13,17,23,0.82)';
    octx.fillRect(x, y - 30, tw + 16, 28);
    octx.fillStyle = '#e6f5f2';
    octx.fillText(label, x + 8, y - 28);
  }
  octx.restore();
}

function onOverviewClick(evt) {
  if (!state.isOverview) return;
  const boxes = state.meta.region_boxes;
  if (!boxes) return;
  const { px, py } = canvasToGrid(evt);
  const pad = isCoarsePointer() ? 0.03 : 0;
  let best = null;
  let bestDist = Infinity;
  for (const [key, bb] of Object.entries(boxes)) {
    const tl = lonLatToPx(bb[0], bb[3]);
    const br = lonLatToPx(bb[2], bb[1]);
    const w = br.px - tl.px;
    const h = br.py - tl.py;
    const padX = w * pad;
    const padY = h * pad;
    if (px >= tl.px - padX && px <= br.px + padX && py >= tl.py - padY && py <= br.py + padY) {
      const cx = (tl.px + br.px) / 2;
      const cy = (tl.py + br.py) / 2;
      const dist = Math.hypot(px - cx, py - cy);
      if (dist < bestDist) {
        bestDist = dist;
        best = key;
      }
    }
  }
  if (best) loadRegion(best);
}


// ---------------- Touch / pointer helpers (HydroSim mobile) ----------------
// Coarse pointer = finger/stylus. Used to gate hover-only features (orbit ring,
// heavy 3D) and to enable touch input on the map.
function isCoarsePointer() {
  return !!(window.matchMedia && window.matchMedia('(pointer: coarse)').matches);
}
// Normalize a mouse OR touch event to a {clientX, clientY} that canvasToGrid()
// and every existing handler already understands — no duplicate coord math.
function evtPoint(evt) {
  const t = (evt.touches && evt.touches[0]) || (evt.changedTouches && evt.changedTouches[0]);
  return t ? { clientX: t.clientX, clientY: t.clientY } : evt;
}

// ---------------- Mobile navigation (M5–M8) ----------------
function isMobileLayout() {
  return !!(window.matchMedia && window.matchMedia('(max-width: 860px)').matches);
}

function openLayersSheet() {
  if (!isMobileLayout()) return;
  const app = document.getElementById('app');
  const backdrop = document.getElementById('sidebarBackdrop');
  if (app) app.classList.add('sidebar-open');
  if (backdrop) backdrop.classList.add('is-visible');
}

function closeLayersSheet() {
  const app = document.getElementById('app');
  const backdrop = document.getElementById('sidebarBackdrop');
  if (app) app.classList.remove('sidebar-open');
  if (backdrop) backdrop.classList.remove('is-visible');
}

function syncRainLoopForPanel(id) {
  if (!isMobileLayout() || !state.rain.active) return;
  if (id === 'rain') stepRain();
  else cancelAnimationFrame(state.rain.raf);
}

function activatePanel(id) {
  const valid = ['terrain', 'rain', 'flood', 'dams'];
  if (!valid.includes(id)) return;

  document.querySelectorAll('#mobileTabBar .tab-btn[data-panel]').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.panel === id);
  });

  if (isMobileLayout()) {
    closeLayersSheet();
    const viewport = document.getElementById('viewport');
    const hydro = document.getElementById('hydroPanel');
    const isTerrain = id === 'terrain';
    const isHydro = id === 'rain' || id === 'flood' || id === 'dams';
    if (viewport) viewport.classList.toggle('is-active', isTerrain);
    if (hydro) {
      hydro.classList.toggle('is-active', isHydro);
      if (isHydro) hydro.dataset.activeGroup = id;
      else delete hydro.dataset.activeGroup;
    }
    if (isTerrain) fitCanvas();
    syncRainLoopForPanel(id);
    return;
  }

  const targets = {
    terrain: document.getElementById('sidebar'),
    rain: document.querySelector('[data-group="rain"]'),
    flood: document.querySelector('[data-group="flood"]'),
    dams: document.getElementById('damsPanel'),
  };
  const el = targets[id];
  if (el) el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function bindMobilePanelCollapse() {
  if (!isMobileLayout()) return;
  document.querySelectorAll('#sidebar .panel, #hydroPanel .panel').forEach(panel => {
    const h2 = panel.querySelector(':scope > h2, .dams-head > h2');
    if (!h2 || h2.dataset.collapseBound) return;
    h2.dataset.collapseBound = '1';
    h2.classList.add('panel-toggle');
    h2.setAttribute('role', 'button');
    h2.setAttribute('tabindex', '0');
    h2.setAttribute('aria-expanded', 'true');
    if (!h2.querySelector('.panel-caret')) {
      const caret = document.createElement('span');
      caret.className = 'panel-caret';
      caret.setAttribute('aria-hidden', 'true');
      caret.textContent = '▾';
      h2.appendChild(caret);
    }
    const toggle = () => {
      const collapsed = panel.classList.toggle('is-collapsed');
      h2.setAttribute('aria-expanded', String(!collapsed));
    };
    h2.addEventListener('click', toggle);
    h2.addEventListener('keydown', e => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); }
    });
  });
}

function bindPanelNav() {
  document.querySelectorAll('#mobileTabBar .tab-btn[data-panel]').forEach(btn => {
    btn.addEventListener('click', () => activatePanel(btn.dataset.panel));
  });
  document.getElementById('layersBtn')?.addEventListener('click', openLayersSheet);
  document.getElementById('sidebarClose')?.addEventListener('click', closeLayersSheet);
  document.getElementById('sidebarBackdrop')?.addEventListener('click', closeLayersSheet);
  if (isMobileLayout()) activatePanel('terrain');
  bindMobilePanelCollapse();
}

function bindUI() {
  document.querySelectorAll('.layer-btn').forEach(b =>
    b.addEventListener('click', () => setLayer(b.dataset.layer)));
  mapCanvas.addEventListener('mousemove', onMove);
  mapCanvas.addEventListener('click', onProfileClick);

  // ----- Touch input on the map: reuse the same coord math + handlers -----
  // Resolves the dual mapCanvas tap conflict explicitly: a tap routes to EITHER
  // the profile tool OR overview navigation by current mode, never both. A drag
  // just updates the live readout. preventDefault suppresses the synthetic
  // mouse-click so the desktop click handlers don't double-fire on touch.
  let _touchMoved = false, _touchStart = null;
  mapCanvas.addEventListener('touchstart', e => {
    _touchMoved = false;
    const p = evtPoint(e);
    _touchStart = { x: p.clientX, y: p.clientY };
  }, { passive: true });
  mapCanvas.addEventListener('touchmove', e => {
    e.preventDefault();                       // read the map instead of scrolling the page
    const p = evtPoint(e);
    if (_touchStart && Math.hypot(p.clientX - _touchStart.x, p.clientY - _touchStart.y) > 6) _touchMoved = true;
    onMove(p);
  }, { passive: false });
  mapCanvas.addEventListener('touchend', e => {
    const p = evtPoint(e);
    onMove(p);
    if (!_touchMoved) {                        // a tap, not a drag
      if (state.profile.active) onProfileClick(p);
      else if (state.isOverview) onOverviewClick(p);
    }
    e.preventDefault();                        // suppress the trailing synthetic click
    _touchStart = null;
  }, { passive: false });
  document.getElementById('profileBtn').addEventListener('click', startProfile);
  document.getElementById('closeProfile').addEventListener('click', () => {
    document.getElementById('profilePanel').classList.add('hidden');
    octx.clearRect(0, 0, state.W, state.H);
    state.profile.p0 = state.profile.p1 = null;
  });
  document.getElementById('contourToggle').addEventListener('change', e => {
    state.contour = e.target.checked; drawMap();
  });
  document.getElementById('threeToggle').addEventListener('change', e => toggle3D(e.target.checked));

  // 3D terrain (OrbitControls + GPU mesh) is heavy and orbit-by-touch is awkward
  // on phones/tablets — hide the toggle on coarse pointers and never init it.
  if (isCoarsePointer()) {
    const t3 = document.getElementById('threeToggle');
    const row = t3 && t3.closest('.toggle-row');
    if (row) row.style.display = 'none';
  }

  // Cursor indicator on/off — when off, the normal mouse cursor returns over the map.
  const cursorIndToggle = document.getElementById('cursorIndToggle');
  if (cursorIndToggle) cursorIndToggle.addEventListener('change', e => {
    const wrap = document.getElementById('canvasWrap');
    if (wrap) wrap.classList.toggle('ind-on', e.target.checked);
  });

  // Rain animation + its live controls (intensity / speed / infiltration)
  document.getElementById('rainBtn').addEventListener('click', () => toggleRain(!state.rain.active));
  const INT_LABELS = ['', 'Drizzle', 'Light', 'Light', 'Moderate', 'Moderate', 'Heavy', 'Heavy', 'Torrential', 'Torrential', 'Extreme'];
  const rainIntensity = document.getElementById('rainIntensity');
  const rainSpeed = document.getElementById('rainSpeed');
  const rainInfilEl = document.getElementById('rainInfil');
  if (rainIntensity) rainIntensity.addEventListener('input', e => {
    state.rain.intensity = +e.target.value;
    document.getElementById('rainIntVal').textContent = INT_LABELS[state.rain.intensity] || `${state.rain.intensity}`;
  });
  if (rainSpeed) rainSpeed.addEventListener('input', e => {
    state.rain.speed = +e.target.value;
    document.getElementById('rainSpeedVal').textContent = `${state.rain.speed.toFixed(2).replace(/0$/,'')}×`;
  });
  if (rainInfilEl) rainInfilEl.addEventListener('input', e => {
    state.rain.infil = +e.target.value;
    document.getElementById('rainInfilVal').textContent = RAIN_INFIL[state.rain.infil].name;
  });

  // Flood model controls
  const rainDepth = document.getElementById('rainDepth');
  const rainDur   = document.getElementById('rainDur');
  const infil     = document.getElementById('infil');
  const rainDepthVal = document.getElementById('rainDepthVal');
  const rainDurVal   = document.getElementById('rainDurVal');
  const infilVal     = document.getElementById('infilVal');

  // In Advanced mode the visual rain animation is DERIVED from the physical
  // storm: intensity i = P / T drives drop density, so the animation can never
  // contradict the flood model. Also keeps the standalone intensity slider in sync.
  function syncRainFromStorm() {
    if (!state.flood.advanced) return;
    const i = stormIntensity(state.flood.rainDepth, state.flood.rainDur);
    state.rain.intensity = intensityToAnim(i);
    const ri = document.getElementById('rainIntensity');
    const riVal = document.getElementById('rainIntVal');
    if (ri) ri.value = state.rain.intensity;
    if (riVal) riVal.textContent = intensityBand(i);
  }

  // In Advanced mode, live re-run the flood model on depth/duration change
  // (only if results already exist, so we refresh rather than compute from scratch).
  function liveRecomputeIfAdvanced() {
    if (state.flood.advanced && state.flood.lastResult) runFloodModel();
  }

  rainDepth.addEventListener('input', e => {
    state.flood.rainDepth = +e.target.value;
    rainDepthVal.textContent = `${state.flood.rainDepth} mm`;
    syncRainFromStorm();
    updateStormReadout();
    liveRecomputeIfAdvanced();
  });
  rainDur.addEventListener('input', e => {
    state.flood.rainDur = +e.target.value;
    rainDurVal.textContent = `${state.flood.rainDur} h`;
    syncRainFromStorm();
    updateStormReadout();
    liveRecomputeIfAdvanced();
  });

  // Advanced mode toggle: link visual intensity to i = P/T and show IDF readout.
  const advToggle = document.getElementById('advModeToggle');
  if (advToggle) advToggle.addEventListener('change', e => {
    state.flood.advanced = e.target.checked;
    const ri = document.getElementById('rainIntensity');
    if (ri) ri.disabled = state.flood.advanced;  // derived, not manually set, in Advanced mode
    if (state.flood.advanced) syncRainFromStorm();
    updateStormReadout();
    liveRecomputeIfAdvanced();  // entering Advanced mode refreshes existing results
  });
  infil.addEventListener('input', e => {
    state.flood.infil = +e.target.value;
    infilVal.textContent = INFIL_PRESETS[state.flood.infil].name;
  });
  document.getElementById('floodRunBtn').addEventListener('click', runFloodModel);
  document.getElementById('floodClearBtn').addEventListener('click', clearFlood);

  // Phase 2: dams visibility toggle
  const damsToggle = document.getElementById('damsToggle');
  if (damsToggle) damsToggle.addEventListener('change', e => toggleDams(e.target.checked));
  window.addEventListener('resize', () => {
    if (isMobileLayout()) {
      const active = document.querySelector('#mobileTabBar .tab-btn.active')?.dataset.panel || 'terrain';
      activatePanel(active);
      bindMobilePanelCollapse();
    } else {
      closeLayersSheet();
      document.getElementById('viewport')?.classList.add('is-active');
      const hydro = document.getElementById('hydroPanel');
      if (hydro) {
        hydro.classList.remove('is-active');
        delete hydro.dataset.activeGroup;
      }
    }
    fitCanvas(); drawMap(); drawProfileMarkers();
    if (state.three) {
      const w = state.three.wrap.clientWidth, h = state.three.wrap.clientHeight;
      state.three.camera.aspect = w / h; state.three.camera.updateProjectionMatrix();
      state.three.renderer.setSize(w, h);
    }
  });
  // Some mobile browsers report the new viewport late on rotation — re-fit after settle.
  window.addEventListener('orientationchange', () => {
    closeLayersSheet();
    setTimeout(() => { fitCanvas(); drawMap(); drawProfileMarkers(); }, 250);
  });
  if (window.visualViewport) {
    window.visualViewport.addEventListener('resize', () => {
      if (!isMobileLayout()) return;
      fitCanvas(); drawMap(); drawProfileMarkers();
    });
  }
}

boot();
