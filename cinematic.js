// =============================================================================
//  HydroSim — Cinematic Render Mode
// -----------------------------------------------------------------------------
//  A self-contained presentation skin for the DEM. It reads the live sim state
//  via window.HydroSim (set up in app.js) but never mutates it: the real flood
//  analysis is already done, this module only produces beautiful approximate
//  visuals for reports, figures and clips.
//
//  Everything here is dormant until the "Cinematic mode" toggle is switched on.
//
//  Phases implemented:
//    1. 3D displaced terrain + Bloom + ACES filmic tone mapping (neon glow)
//    2. Emissive glowing river network derived from flow accumulation
//    3. Control panel: vertical exaggeration, glow, channel threshold, layers
//    4. Animated water particles flowing downhill along the D8 flow directions
//    5. City labels (3D sprites) + live compass + reused metrics HUD
//    6. Export: high-res PNG (current frame) and MP4/WebM orbit clip
//
//  Author persona: built to the taste of Prof. Abdullah — restrained, legible,
//  geologically plausible relief, deep night-sky palette, hydrology in cyan.
// =============================================================================

import * as THREE from 'https://esm.sh/three@0.160.0';
import { OrbitControls } from 'https://esm.sh/three@0.160.0/examples/jsm/controls/OrbitControls.js';
import { EffectComposer } from 'https://esm.sh/three@0.160.0/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'https://esm.sh/three@0.160.0/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'https://esm.sh/three@0.160.0/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'https://esm.sh/three@0.160.0/examples/jsm/postprocessing/OutputPass.js';

// World extent of the terrain plane (arbitrary scene units). Matches the
// proportions used by the original 3D view so cameras feel familiar.
const PLANE = 400;

// Default tunables (also the initial slider values).
const DEFAULTS = {
  exaggeration: 1.0,   // visual vertical exaggeration multiplier (NOT real data)
  glow: 0.85,          // bloom strength
  channelPct: 35,      // % of flow-accumulation range that lights up as rivers
  waterSpeed: 1.0,     // particle speed multiplier
  water: true,         // animate flowing water
  labels: true,        // city labels
  autoOrbit: false,    // slow automatic camera rotation
};

let C = null; // active cinematic context (null when off)

// ---------------------------------------------------------------------------
//  Public entry — toggle the whole mode on/off.
// ---------------------------------------------------------------------------
export function setCinematic(on) {
  if (on) start();
  else stop();
}

function H() { return window.HydroSim; }

function start() {
  const api = H();
  if (!api || !api.state || !api.state.elev) {
    console.warn('[cinematic] sim state not ready');
    const t = document.getElementById('cinematicToggle');
    if (t) t.checked = false;
    return;
  }
  if (C) return; // already running

  const host = document.getElementById('cinematicStage');
  host.classList.remove('hidden');
  document.getElementById('cinematicPanel').classList.remove('hidden');
  // Hide the working 2D/3D canvases while cinematic is on.
  document.getElementById('canvasWrap').classList.add('cine-active');

  C = {
    opts: { ...DEFAULTS },
    raf: null,
    clock: new THREE.Clock(),
    recorder: null,
    chunks: [],
  };

  buildScene(host);
  buildFromState();
  bindPanel();
  loop();
}

function stop() {
  document.getElementById('cinematicPanel').classList.add('hidden');
  document.getElementById('cinematicStage').classList.add('hidden');
  document.getElementById('canvasWrap').classList.remove('cine-active');
  if (!C) return;
  if (C.raf) cancelAnimationFrame(C.raf);
  if (C.recorder && C.recorder.state === 'recording') C.recorder.stop();
  try {
    C.renderer.dispose();
    C.composer.dispose && C.composer.dispose();
    C.host.innerHTML = '';
  } catch (e) {}
  C = null;
}

// ---------------------------------------------------------------------------
//  Scene scaffold: renderer, camera, lights, post-processing.
// ---------------------------------------------------------------------------
function buildScene(host) {
  const W = host.clientWidth || 960;
  const Hh = host.clientHeight || 600;

  const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(W, Hh);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 0.95;
  host.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  // Deep night-sky background with a soft vertical gradient via fog.
  scene.background = new THREE.Color(0x05080f);
  scene.fog = new THREE.Fog(0x05080f, PLANE * 0.9, PLANE * 3.0);

  const camera = new THREE.PerspectiveCamera(48, W / Hh, 0.1, 6000);
  camera.position.set(0, 300, 430);

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.maxPolarAngle = Math.PI / 2.06;
  controls.minDistance = 120;
  controls.maxDistance = 1500;
  controls.target.set(0, 0, 0);

  // Lighting: cool key + warm-ish fill keeps relief readable without washing
  // out the emissive rivers.
  const key = new THREE.DirectionalLight(0xcfe0ff, 1.25);
  key.position.set(-260, 230, 120);
  scene.add(key);
  scene.add(new THREE.AmbientLight(0x1c2f47, 0.4));
  scene.add(new THREE.HemisphereLight(0x4a6da0, 0x05080f, 0.35));

  // Post-processing chain: render -> bloom -> output (sRGB + tone map).
  const composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, camera));
  // High threshold => only the bright emissive rivers bloom, terrain stays matte.
  const bloom = new UnrealBloomPass(new THREE.Vector2(W, Hh), DEFAULTS.glow, 0.55, 0.55);
  composer.addPass(bloom);
  composer.addPass(new OutputPass());

  Object.assign(C, { host, renderer, scene, camera, controls, composer, bloom, W, H: Hh });

  // Group that holds everything terrain-related so we can rebuild on region change.
  C.terrainGroup = new THREE.Group();
  scene.add(C.terrainGroup);

  window.addEventListener('resize', onResize);
}

function onResize() {
  if (!C) return;
  const W = C.host.clientWidth, Hh = C.host.clientHeight;
  if (!W || !Hh) return;
  C.W = W; C.H = Hh;
  C.camera.aspect = W / Hh;
  C.camera.updateProjectionMatrix();
  C.renderer.setSize(W, Hh);
  C.composer.setSize(W, Hh);
}

// ---------------------------------------------------------------------------
//  Build terrain mesh + rivers + water particles + labels from the live grid.
//  Called on start and whenever the user switches region while cinematic is on.
// ---------------------------------------------------------------------------
function buildFromState() {
  const api = H();
  const st = api.state;
  // Clear previous terrain.
  while (C.terrainGroup.children.length) {
    const o = C.terrainGroup.children.pop();
    o.geometry && o.geometry.dispose && o.geometry.dispose();
    o.material && o.material.dispose && o.material.dispose();
    C.terrainGroup.remove(o);
  }
  if (C.labelLayer) { C.labelLayer.innerHTML = ''; }

  const W = st.W, Hh = st.H;
  const m = st.meta.elevation;
  const planeH = PLANE * Hh / W;

  // Downsampled mesh grid. Higher than the legacy view for crisper ridgelines,
  // but capped so it stays smooth on tablets.
  const gw = 360;
  const gh = Math.round(gw * Hh / W);

  // Smoothed height field (ignores nodata, fills gaps with min so the footprint
  // sits at "sea level" rather than spiking).
  const heights = new Float32Array(gw * gh);
  const win = 1;
  for (let iy = 0; iy < gh; iy++) {
    for (let ix = 0; ix < gw; ix++) {
      const sx0 = Math.round(ix / (gw - 1) * (W - 1));
      const sy0 = Math.round(iy / (gh - 1) * (Hh - 1));
      let sum = 0, n = 0;
      for (let dy = -win; dy <= win; dy++) for (let dx = -win; dx <= win; dx++) {
        const xx = sx0 + dx, yy = sy0 + dy;
        if (xx < 0 || yy < 0 || xx >= W || yy >= Hh) continue;
        const v = st.elev[yy * W + xx];
        if (v === -32768) continue;
        sum += v; n++;
      }
      heights[iy * gw + ix] = n === 0 ? m.min : sum / n;
    }
  }
  C.heights = heights; C.gw = gw; C.gh = gh; C.planeH = planeH;
  C.elevMin = m.min; C.elevMax = m.max;

  buildTerrainMesh();
  buildRivers();
  buildWater();
  buildLabels();
  frameCamera();
  updateHUD();
}

// Map a grid (col,row in the FULL-RES sim grid) to world XZ coordinates.
function gridToWorld(px, py) {
  const st = H().state;
  const x = (px / (st.W - 1) - 0.5) * PLANE;
  const z = (py / (st.H - 1) - 0.5) * C.planeH;
  return [x, z];
}

// Sample interpolated terrain height (world Y) at a full-grid pixel.
function heightAtGrid(px, py) {
  const st = H().state;
  const fx = px / (st.W - 1) * (C.gw - 1);
  const fy = py / (st.H - 1) * (C.gh - 1);
  const x0 = Math.max(0, Math.min(C.gw - 1, fx | 0));
  const y0 = Math.max(0, Math.min(C.gh - 1, fy | 0));
  const v = C.heights[y0 * C.gw + x0];
  return normHeight(v);
}

function normHeight(v) {
  const t = (v - C.elevMin) / (C.elevMax - C.elevMin || 1);
  // Base relief tuned so mountains read as ranges, not spikes. The 1.0x
  // exaggeration already gives a natural-looking massif; the slider scales it.
  return t * 70 * C.opts.exaggeration; // base relief * exaggeration
}

// ---------------------------------------------------------------------------
//  Phase 1 — terrain mesh (vertex-coloured by the shared elevation ramp).
// ---------------------------------------------------------------------------
function buildTerrainMesh() {
  const api = H();
  const { gw, gh, heights, planeH } = C;
  const geo = new THREE.PlaneGeometry(PLANE, planeH, gw - 1, gh - 1);
  geo.rotateX(-Math.PI / 2);
  const pos = geo.attributes.position;
  const colors = new Float32Array(pos.count * 3);
  for (let i = 0; i < pos.count; i++) {
    const v = heights[i];
    pos.setY(i, normHeight(v));
    const t = (v - C.elevMin) / (C.elevMax - C.elevMin || 1);
    const [r, g, b] = api.elevColorRGB(t);
    // Darken the base hard so it never blooms and the emissive rivers dominate.
    // Bias toward a deep blue-slate so the scene reads as a night relief map.
    const d = 0.28;
    colors[i * 3] = (r / 255) * d * 0.7;
    colors[i * 3 + 1] = (g / 255) * d * 0.85;
    colors[i * 3 + 2] = (b / 255) * d + 0.04;
  }
  geo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  geo.computeVertexNormals();
  const mat = new THREE.MeshStandardMaterial({
    vertexColors: true, roughness: 0.96, metalness: 0.02, flatShading: false,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = 'terrain';
  C.terrainGroup.add(mesh);
  C.terrainMesh = mesh;
}

// Rebuild only vertex Y when exaggeration changes (cheap).
function reExaggerate() {
  if (!C || !C.terrainMesh) return;
  const pos = C.terrainMesh.geometry.attributes.position;
  for (let i = 0; i < pos.count; i++) pos.setY(i, normHeight(C.heights[i]));
  pos.needsUpdate = true;
  C.terrainMesh.geometry.computeVertexNormals();
  // Rivers + labels ride on top of the surface — rebuild them too.
  buildRivers();
  buildLabels();
}

// ---------------------------------------------------------------------------
//  Phase 2 — glowing river network from flow accumulation.
//  We threshold flowacc, then draw bright emissive points slightly above the
//  surface. Bloom turns these into the neon "blue lightning" channels.
// ---------------------------------------------------------------------------
function buildRivers() {
  // remove old river object
  const old = C.terrainGroup.getObjectByName('rivers');
  if (old) { old.geometry.dispose(); old.material.dispose(); C.terrainGroup.remove(old); }

  const st = H().state;
  if (!st.flowacc) { C.riverObj = null; return; }

  const fa = st.flowacc;
  const maxFa = (st.meta.flowacc && st.meta.flowacc.max) ? st.meta.flowacc.max : 1;
  // Log scale: accumulation is extremely skewed. threshold slider picks the
  // percentile of log-range above which a cell counts as channel.
  const logMax = Math.log10(maxFa + 1);
  const thr = Math.pow(10, logMax * (C.opts.channelPct / 100)) - 1;

  const W = st.W, Hh = st.H;
  const stride = Math.max(1, Math.round(W / 700)); // sample density
  const pts = [];
  const cols = [];
  for (let y = 0; y < Hh; y += stride) {
    for (let x = 0; x < W; x += stride) {
      const a = fa[y * W + x];
      if (a < thr) continue;
      if (st.elev[y * W + x] === -32768) continue;
      const [wx, wz] = gridToWorld(x, y);
      const wy = heightAtGrid(x, y) + 0.6;
      pts.push(wx, wy, wz);
      // Blue-dominant so bloom glows cyan (not white). Major channels are a
      // touch brighter but red stays low to avoid washing to white under bloom.
      const tA = Math.min(1, (Math.log10(a + 1)) / logMax);
      const bright = 0.45 + tA * 0.9; // restrained emissive multiplier
      cols.push(0.08 * bright, (0.45 + 0.25 * tA) * bright, 0.95 * bright);
    }
  }
  if (!pts.length) { C.riverObj = null; return; }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(cols, 3));
  const mat = new THREE.PointsMaterial({
    size: 1.5, vertexColors: true, transparent: true, opacity: 0.9,
    blending: THREE.AdditiveBlending, depthWrite: false, sizeAttenuation: true,
  });
  const obj = new THREE.Points(g, mat);
  obj.name = 'rivers';
  C.terrainGroup.add(obj);
  C.riverObj = obj;
}

// ---------------------------------------------------------------------------
//  Phase 4 — animated water particles tracing the D8 flow field downhill.
// ---------------------------------------------------------------------------
function buildWater() {
  const old = C.terrainGroup.getObjectByName('water');
  if (old) { old.geometry.dispose(); old.material.dispose(); C.terrainGroup.remove(old); }
  C.particles = null;

  const st = H().state;
  if (!st.flow || !st.flowacc) return;

  const N = 1400;
  const arr = new Float32Array(N * 3);
  C.pData = new Array(N);
  for (let i = 0; i < N; i++) C.pData[i] = spawnParticle();
  syncParticleBuffer(arr);

  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(arr, 3));
  const mat = new THREE.PointsMaterial({
    size: 2.0, color: 0x6fc8ff, transparent: true, opacity: 0.85,
    blending: THREE.AdditiveBlending, depthWrite: false, sizeAttenuation: true,
  });
  const pts = new THREE.Points(g, mat);
  pts.name = 'water';
  pts.visible = C.opts.water;
  C.terrainGroup.add(pts);
  C.particles = pts;
}

// Spawn a particle on a channel cell (so motion is visible immediately).
function spawnParticle() {
  const st = H().state;
  const fa = st.flowacc;
  const maxFa = (st.meta.flowacc && st.meta.flowacc.max) ? st.meta.flowacc.max : 1;
  const thr = maxFa * 0.0008;
  for (let t = 0; t < 30; t++) {
    const x = (Math.random() * st.W) | 0;
    const y = (Math.random() * st.H) | 0;
    if (st.elev[y * st.W + x] === -32768) continue;
    if (fa[y * st.W + x] < thr) continue;
    return { x, y, life: 30 + Math.random() * 140 };
  }
  return { x: (Math.random() * st.W) | 0, y: (Math.random() * st.H) | 0, life: 60 };
}

function syncParticleBuffer(arr) {
  for (let i = 0; i < C.pData.length; i++) {
    const p = C.pData[i];
    const [wx, wz] = gridToWorld(p.x, p.y);
    arr[i * 3] = wx;
    arr[i * 3 + 1] = heightAtGrid(p.x, p.y) + 0.9;
    arr[i * 3 + 2] = wz;
  }
}

function stepWater(dt) {
  if (!C.particles || !C.opts.water) return;
  const st = H().state;
  const flow = st.flow;
  const steps = Math.max(1, Math.round(C.opts.waterSpeed * 1.5));
  const arr = C.particles.geometry.attributes.position.array;
  for (let s = 0; s < steps; s++) {
    for (let i = 0; i < C.pData.length; i++) {
      const p = C.pData[i];
      const xi = Math.max(0, Math.min(st.W - 1, p.x | 0));
      const yi = Math.max(0, Math.min(st.H - 1, p.y | 0));
      const fi = (yi * st.W + xi) * 2;
      const dx = flow[fi], dy = flow[fi + 1];
      p.life -= 1;
      const off = st.elev[yi * st.W + xi] === -32768;
      if ((dx === 0 && dy === 0) || p.life <= 0 || off) {
        C.pData[i] = spawnParticle();
        continue;
      }
      p.x += dx; p.y += dy;
    }
  }
  syncParticleBuffer(arr);
  C.particles.geometry.attributes.position.needsUpdate = true;
}

// ---------------------------------------------------------------------------
//  Phase 5 — city labels as HTML overlays projected from 3D positions.
// ---------------------------------------------------------------------------
function buildLabels() {
  const api = H();
  const st = api.state;
  if (!C.labelLayer) {
    C.labelLayer = document.createElement('div');
    C.labelLayer.className = 'cine-labels';
    C.host.appendChild(C.labelLayer);
  }
  C.labelLayer.innerHTML = '';
  C.labels = [];
  const b = st.meta.bounds;
  for (const city of api.CITIES) {
    if (city.lon < b.lon_min || city.lon > b.lon_max ||
        city.lat < b.lat_min || city.lat > b.lat_max) continue;
    const px = (city.lon - b.lon_min) / (b.lon_max - b.lon_min) * st.W;
    const py = (b.lat_max - city.lat) / (b.lat_max - b.lat_min) * st.H;
    const [wx, wz] = gridToWorld(px, py);
    const wy = heightAtGrid(px, py) + 6;
    const el = document.createElement('div');
    el.className = 'cine-label';
    el.innerHTML = `<span class="cl-dot"></span><span class="cl-name">${city.name}</span>`;
    C.labelLayer.appendChild(el);
    C.labels.push({ el, pos: new THREE.Vector3(wx, wy, wz) });
  }
}

function updateLabels() {
  if (!C.labels || !C.opts.labels) {
    if (C.labelLayer) C.labelLayer.style.display = C.opts.labels ? '' : 'none';
    return;
  }
  C.labelLayer.style.display = '';
  const v = new THREE.Vector3();
  for (const L of C.labels) {
    v.copy(L.pos).project(C.camera);
    const behind = v.z > 1;
    const sx = (v.x * 0.5 + 0.5) * C.W;
    const sy = (-v.y * 0.5 + 0.5) * C.H;
    L.el.style.display = behind ? 'none' : '';
    L.el.style.transform = `translate(-50%,-100%) translate(${sx}px,${sy}px)`;
  }
}

// Live compass — rotate the needle to match camera azimuth.
function updateCompass() {
  const needle = document.getElementById('cineCompassNeedle');
  if (!needle) return;
  const dir = new THREE.Vector3();
  C.camera.getWorldDirection(dir);
  const az = Math.atan2(dir.x, -dir.z); // 0 = looking north (-Z)
  needle.style.transform = `rotate(${(-az * 180 / Math.PI).toFixed(1)}deg)`;
}

// ---------------------------------------------------------------------------
//  HUD — reuse the live metrics already computed by the sim.
// ---------------------------------------------------------------------------
function updateHUD() {
  const st = H().state;
  const m = st.meta;
  const set = (id, val) => { const e = document.getElementById(id); if (e) e.textContent = val; };
  set('cineRegion', m.region || '—');
  set('cineElevRange', `${m.elevation.min}–${m.elevation.max} m`);
  set('cineCoverage', m.area_km ? `${m.area_km.width} × ${m.area_km.height} km` : '—');
  set('cineRes', m.src_resolution_m ? `${m.src_resolution_m} m` : '—');
  if (m.flowacc) set('cineFlowMax', `${(m.flowacc.max / 1e6).toFixed(2)}M cells`);
}

// ---------------------------------------------------------------------------
//  Camera framing + auto-orbit.
// ---------------------------------------------------------------------------
function frameCamera() {
  // Aerial-oblique hero angle: high enough to see the whole massif, angled
  // enough that ridgelines and glowing wadis catch the light.
  C.controls.target.set(0, normHeight(C.elevMax) * 0.12, 0);
  C.camera.position.set(0, PLANE * 0.85, PLANE * 1.05);
  C.controls.update();
}

// ---------------------------------------------------------------------------
//  Render loop.
// ---------------------------------------------------------------------------
function loop() {
  if (!C) return;
  const dt = C.clock.getDelta();
  if (C.opts.autoOrbit) {
    C.controls.autoRotate = true;
    C.controls.autoRotateSpeed = 0.6;
  } else {
    C.controls.autoRotate = false;
  }
  C.controls.update();
  stepWater(dt);
  updateLabels();
  updateCompass();
  C.composer.render();
  C.raf = requestAnimationFrame(loop);
}

// ---------------------------------------------------------------------------
//  Phase 3 — panel wiring (sliders + toggles + region awareness).
// ---------------------------------------------------------------------------
function bindPanel() {
  const on = (id, ev, fn) => { const e = document.getElementById(id); if (e) e.addEventListener(ev, fn); };

  on('cineExag', 'input', e => {
    C.opts.exaggeration = parseFloat(e.target.value);
    document.getElementById('cineExagVal').textContent = C.opts.exaggeration.toFixed(1) + '×';
    reExaggerate();
  });
  on('cineGlow', 'input', e => {
    C.opts.glow = parseFloat(e.target.value);
    document.getElementById('cineGlowVal').textContent = C.opts.glow.toFixed(2);
    C.bloom.strength = C.opts.glow;
  });
  on('cineThresh', 'input', e => {
    C.opts.channelPct = parseFloat(e.target.value);
    document.getElementById('cineThreshVal').textContent = C.opts.channelPct + '%';
    buildRivers();
  });
  on('cineWaterSpeed', 'input', e => {
    C.opts.waterSpeed = parseFloat(e.target.value);
    document.getElementById('cineWaterSpeedVal').textContent = C.opts.waterSpeed.toFixed(1) + '×';
  });
  on('cineWaterToggle', 'change', e => {
    C.opts.water = e.target.checked;
    if (C.particles) C.particles.visible = e.target.checked;
  });
  on('cineLabelsToggle', 'change', e => { C.opts.labels = e.target.checked; });
  on('cineOrbitToggle', 'change', e => { C.opts.autoOrbit = e.target.checked; });

  on('cinePngBtn', 'click', exportPNG);
  on('cineMp4Btn', 'click', toggleRecording);

  // React to region changes made in the main sim while cinematic is open.
  const sel = document.getElementById('regionSelect');
  if (sel && !sel._cineHooked) {
    sel._cineHooked = true;
    sel.addEventListener('change', () => {
      // Wait for the sim to finish loading the new region, then rebuild.
      if (!C) return;
      setTimeout(() => { if (C) buildFromState(); }, 600);
    });
  }
}

// ---------------------------------------------------------------------------
//  Phase 6 — export.
// ---------------------------------------------------------------------------
function exportPNG() {
  // Render once at higher resolution for a crisp figure.
  const scale = 2;
  const W0 = C.W, H0 = C.H;
  C.renderer.setSize(W0 * scale, H0 * scale, false);
  C.composer.setSize(W0 * scale, H0 * scale);
  C.camera.aspect = W0 / H0; C.camera.updateProjectionMatrix();
  C.composer.render();
  const url = C.renderer.domElement.toDataURL('image/png');
  // restore
  C.renderer.setSize(W0, H0, false);
  C.composer.setSize(W0, H0);
  const a = document.createElement('a');
  const region = (H().state.meta.region_key || 'region');
  a.href = url;
  a.download = `hydrosim_${region}_cinematic.png`;
  a.click();
}

function toggleRecording() {
  const btn = document.getElementById('cineMp4Btn');
  if (C.recorder && C.recorder.state === 'recording') {
    C.recorder.stop();
    return;
  }
  const stream = C.renderer.domElement.captureStream(30);
  const mime = MediaRecorder.isTypeSupported('video/mp4')
    ? 'video/mp4'
    : (MediaRecorder.isTypeSupported('video/webm;codecs=vp9') ? 'video/webm;codecs=vp9' : 'video/webm');
  C.chunks = [];
  C.recorder = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 12_000_000 });
  C.recorder.ondataavailable = e => { if (e.data.size) C.chunks.push(e.data); };
  C.recorder.onstop = () => {
    const blob = new Blob(C.chunks, { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    const ext = mime.includes('mp4') ? 'mp4' : 'webm';
    const region = (H().state.meta.region_key || 'region');
    a.href = url; a.download = `hydrosim_${region}_orbit.${ext}`; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
    btn.classList.remove('recording');
    btn.textContent = '● Record orbit clip';
  };
  // auto-orbit during recording for a clean sweep
  const prevOrbit = C.opts.autoOrbit;
  C.opts.autoOrbit = true;
  document.getElementById('cineOrbitToggle').checked = true;
  C.recorder.start();
  btn.classList.add('recording');
  btn.textContent = '■ Stop & save';
  // Auto-stop after ~12 s so a full slow orbit is captured.
  setTimeout(() => {
    if (C && C.recorder && C.recorder.state === 'recording') C.recorder.stop();
    if (C) { C.opts.autoOrbit = prevOrbit; document.getElementById('cineOrbitToggle').checked = prevOrbit; }
  }, 12000);
}
