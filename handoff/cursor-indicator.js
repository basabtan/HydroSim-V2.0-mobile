/* =====================================================================
   Abdul-S cursor coordinate indicator — LOGIC (self-contained module)
   ---------------------------------------------------------------------
   An orbit-ring readout that follows the mouse over a map canvas and
   shows N (lat), E (lon) and Elevation. The value arc fills clockwise
   from just below the E label toward N, and recolors with an elevation
   ramp (matching a typical map colour scale).

   USAGE (see demo/index.html for a full working example):

     const ind = createCursorIndicator({
       wrap: document.getElementById('canvasWrap'),  // positioned container
       canvas: document.getElementById('mapCanvas'), // listens for hover here
       // Map a pointer event to real-world values. Return null elev if unknown.
       sample(evt) {
         // ...your projection / DEM lookup here...
         return { lat: 21.5, lon: 39.2, elev: 800 };
       },
       elevMin: -3, elevMax: 2595,   // active region's real elevation range
     });

     // optional: hide indicator + show crosshair while a profile tool runs
     ind.setProfiling(true);
   ===================================================================== */

// Elevation colour ramp — blue → teal → green → yellow → orange → red → white.
// Swap these stops to match your own map's colour scale. Returns [r,g,b].
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

// Arc geometry. r=45 → circumference C≈282.74. SVG is rotated -90° so
// s=0 sits at the top (N) and the arc grows clockwise.
const RG = {
  C: 282.74,        // 2π·45
  ARC_START: 82.47, // arc begins just below the E label (right side)
  ARC_END: 274.89,  // arc ends just before N (top)
};

function createCursorIndicator(opts) {
  const wrap   = opts.wrap;
  const canvas = opts.canvas || wrap;
  const sample = opts.sample;            // (evt) => {lat, lon, elev|null}
  let elevMin  = opts.elevMin ?? 0;
  let elevMax  = opts.elevMax ?? 3000;

  const rg  = wrap.querySelector('#rgReadout') || document.getElementById('rgReadout');
  const dot = wrap.querySelector('#cursorDot') || document.getElementById('cursorDot');
  const elN = document.getElementById('rgN');
  const elE = document.getElementById('rgE');
  const elZ = document.getElementById('rgZ');
  const fill = document.getElementById('rgFill');
  const s0 = document.getElementById('rgFillStop0');
  const s1 = document.getElementById('rgFillStop1');

  function update(evt) {
    if (!wrap || !rg || !sample) return;
    const s = sample(evt);
    if (!s) return;
    const { lat, lon, elev } = s;

    // position the ring + dot exactly under the pointer
    const r = wrap.getBoundingClientRect();
    const x = evt.clientX - r.left, y = evt.clientY - r.top;
    rg.style.left = x + 'px'; rg.style.top = y + 'px';
    if (dot) { dot.style.left = x + 'px'; dot.style.top = y + 'px'; }

    // labels (whole degrees + rounded metres)
    if (elN) elN.textContent = Math.round(lat);
    if (elE) elE.textContent = Math.round(lon);
    if (elZ) elZ.textContent = (elev == null) ? '—' : Math.round(elev);

    // elevation fraction across the active range
    const span = (elevMax - elevMin) || 1;
    const frac = (elev == null) ? 0 : Math.max(0, Math.min(1, (elev - elevMin) / span));

    // value arc grows clockwise from below-E toward N
    if (fill) {
      const len = (RG.ARC_END - RG.ARC_START) * frac;
      const start = RG.ARC_START;
      fill.setAttribute('stroke-dasharray',
        '0 ' + start.toFixed(2) + ' ' + len.toFixed(2) + ' ' + (RG.C - start - len).toFixed(2));
    }
    // recolor whole bar with the elevation ramp (lighter at the E start)
    if (s0 && s1) {
      const c0 = elevColorRGB(Math.max(0, frac - 0.12)), c1 = elevColorRGB(frac);
      s0.setAttribute('stop-color', `rgb(${c0[0]},${c0[1]},${c0[2]})`);
      s1.setAttribute('stop-color', `rgb(${c1[0]},${c1[1]},${c1[2]})`);
    }
    // elevation number grows slightly with elevation
    if (elZ) elZ.style.fontSize = (12 + frac * 7).toFixed(1) + 'px';
  }

  // wire hover events
  const onEnter = () => wrap.classList.add('rg-hover');
  const onLeave = () => wrap.classList.remove('rg-hover');
  canvas.addEventListener('mouseenter', onEnter);
  canvas.addEventListener('mouseleave', onLeave);
  canvas.addEventListener('mousemove', update);

  // touch parity (only active if the host enables the ring on a touch device)
  const onTouch = (e) => { const t = e.touches && e.touches[0]; if (t) update({ clientX: t.clientX, clientY: t.clientY }); };
  canvas.addEventListener('touchstart', onEnter, { passive: true });
  canvas.addEventListener('touchmove', onTouch, { passive: true });
  canvas.addEventListener('touchend', onLeave, { passive: true });

  return {
    update,                                   // call manually if you drive it yourself
    setRange(min, max) { elevMin = min; elevMax = max; },
    setProfiling(on) { wrap.classList.toggle('profiling', !!on); },
    destroy() {
      canvas.removeEventListener('mouseenter', onEnter);
      canvas.removeEventListener('mouseleave', onLeave);
      canvas.removeEventListener('mousemove', update);
      canvas.removeEventListener('touchstart', onEnter);
      canvas.removeEventListener('touchmove', onTouch);
      canvas.removeEventListener('touchend', onLeave);
    },
  };
}

// Export for module bundlers; also exposed on window for plain <script> use.
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { createCursorIndicator, elevColorRGB, RG };
}
if (typeof window !== 'undefined') {
  window.createCursorIndicator = createCursorIndicator;
}
