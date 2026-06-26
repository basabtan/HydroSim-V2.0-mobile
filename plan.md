# HydroSim Mobile — Plan (full detail)

**Fork (work here):**  
`C:\Users\bader\OneDrive\00 - 2025 MVP\A sabtan\HydroSim\HydroSim-V2.0-mobile\`

**Original (do not edit):**  
`C:\Users\bader\OneDrive\00 - 2025 MVP\A sabtan\HydroSim\HydroSim-V2.0\`

**Code handoff copy (for AI, no data):**  
`C:\Users\bader\OneDrive\00 - 2025 MVP\A sabtan\HydroSim\HydroSim-V2.0-mobile\handoff\`

**External return (Claude — review only, not merged):**  
`C:\Users\bader\Downloads\files (1)\`

**Run:**  
`C:\Users\bader\OneDrive\00 - 2025 MVP\A sabtan\HydroSim\HydroSim-V2.0-mobile\start_windows.bat`  
→ `http://localhost:8765`

---

## Locked decisions

1. **Tabs, not stack** — on mobile, one panel visible at a time.
2. **Default tab = Terrain (map)** — “map-first” means the map is the default active tab, not a vertical scroll through all panels.
3. **Scroll model (M4 fix):** `body` stays `overflow: hidden` on mobile; only the active panel’s inner content scrolls; fixed bottom tab bar stays pinned; `env(safe-area-inset-bottom)` padding on the **tab bar**, not on `body`.
4. **Sharp UI:** `border-radius: 0` on tab bar and buttons; active tab = top border accent or flat bg fill; 44px min height; vertical divider lines between tabs (no pills, no gaps).
5. **Single navigation API:** desktop rail + mobile tabs both call `activatePanel(id)` — one code path.
6. **Touch coords (M10 — HIGH RISK):** one shared `getCanvasXY(clientX, clientY)` used by mouse and touch; must account for `getBoundingClientRect()`, device pixel ratio, and CSS display scale. Budget 1–2 review rounds; test on a real Android device.
7. **Landscape (M17/M22):** tab bar must not clip in landscape; `fitCanvas()` must run on `orientationchange`, not only `resize`.

---

## Current status

### Done (M1–M20)

| Task | Status |
|------|--------|
| M1–M4 | CSS shell, scroll model |
| M5–M8 | Tab bar, `activatePanel()`, layers sheet, rail wired |
| M9–M17 | Touch input, targets, perf guards |
| M16 | Rain loop pauses off Rain tab (mobile) |
| M18–M20 | Collapsible panels, sticky flood bar, overview hit targets |

### Remaining

M10 (optional `getCanvasXY` refactor). **M21–M22:** static/code QA done — see `QA.md`; real-device checklist still manual.

---

## Task list (order + detail)

Each task = one Composer session, 1–2 files, scoped with `@media (max-width: 860px)` and/or `(pointer: coarse)` so desktop is unchanged.

---

### Phase 0 — Setup

**M0 — Smoke test**  
- Confirm server starts; map loads; flood runs; hover readout works on desktop.  
- Files: none.

---

### Phase 1 — Mobile shell (CSS)

**M1 — CSS foundation** ✅  
- `--mobile-bp: 860px`, `--touch-min`, safe-area vars, `--tab-bar-h`, `--pointer-kind`  
- `.mobile-only`, `.desktop-only`, `.hide-coarse`, `.hide-fine`  
- File: `styles.css`

**M2 — Topbar mobile** ✅  
- Compact header, 48px logo, hide `.top-item`, safe-area top padding  
- File: `styles.css`

**M3 — Workspace tab shell** ⏳ reframe  
- Replace stack-with-all-visible with tab **slots**: map / terrain controls / rain+flood / dams  
- Only one slot visible; map slot default  
- Hide rail on mobile; desktop grid unchanged  
- File: `styles.css` (panel visibility classes, e.g. `.mobile-panel` + `.is-active`)

**M4 fix — Scroll + safe areas** ⏳  
- Revert mobile `body` / `html` `overflow-y: auto`  
- `#app` + `.workspace` = fixed height column; middle area flexes  
- Active panel inner wrapper: `overflow-y: auto; -webkit-overflow-scrolling: touch`  
- Remove `padding-bottom` safe-area from `body`; apply to `#mobileTabBar` when it exists  
- File: `styles.css`

---

### Phase 2 — Tab navigation

**M5 — Tab bar HTML**  
- Add fixed bottom `#mobileTabBar` with 4 buttons: Terrain | Rain | Flood | Dams  
- `class="mobile-only"`  
- `data-panel="terrain"|"rain"|"flood"|"dams"`  
- Map panel = `#viewport`; terrain controls = `#sidebar`; rain section + flood controls grouped per UX; dams = `#hydroPanel` dams section or whole hydro panel split as needed  
- File: `index.html`

**M6 — Tab bar CSS**  
- Fixed bottom, `height: calc(var(--touch-min) + var(--safe-bottom))`  
- `border-radius: 0`; dividers between tabs; active = `border-top: 2px solid var(--accent)`  
- Set `:root { --tab-bar-h: 56px; }` under mobile  
- Pad `.workspace` bottom by `var(--tab-bar-h) + var(--safe-bottom)`  
- File: `styles.css`

**M7 — `activatePanel(id)` + tab switching**  
```js
function activatePanel(id) {
  // id: 'terrain' | 'rain' | 'flood' | 'dams'
  // toggle .is-active on panels + tab buttons
  // on 'terrain': show #viewport, fitCanvas()
}
```
- Default on mobile load: `activatePanel('terrain')`  
- File: `app.js`

**M8 — Wire desktop rail**  
- Rail `.nav` buttons call same `activatePanel()` (desktop: show/hide or scroll-to-panel; mobile: tab swap)  
- File: `app.js`

---

### Phase 3 — Touch input

**M9 — Pointer helpers** (partially in Downloads)  
- `isCoarsePointer()`, `isMobileLayout()` → `matchMedia('(max-width: 860px)')`  
- Merge Downloads `evtPoint` or replace with `getCanvasXY`  
- File: `app.js`

**M10 — Touch readout + canvas coords** ⚠️ HIGH RISK  
- `getCanvasXY(clientX, clientY)` → grid `{px, py}`  
- Refactor `canvasToGrid`, `onMove`, touch handlers to use it  
- `touch-action: none` on `#canvasWrap` (Downloads added on canvases — keep)  
- Files: `app.js`, `styles.css` if needed

**M11 — Cursor indicator on coarse** (partially in Downloads)  
- Disable orbit ring on coarse; hide toggle (Downloads: `app.js` init + `cursor-indicator.js` touch)  
- Files: `app.js`, `cursor-indicator.js`

---

### Phase 4 — Touch targets

**M12 — Buttons / layers** (partially in Downloads)  
- `min-height: var(--touch-min)` on `.layer-btn`, `.tool-btn`, `.nav` under `(pointer: coarse)`  
- File: `styles.css`

**M13 — Slider thumbs** (partially in Downloads)  
- 26px thumbs, sharp corners  
- File: `styles.css`

**M14 — Toggle rows**  
- Larger hit area on `.toggle-row`, `.toggle-inline`  
- File: `styles.css`

---

### Phase 5 — Performance

**M15 — Disable 3D on touch** (partially in Downloads)  
- Hide `#threeToggle` row when `isCoarsePointer()`  
- File: `app.js`

**M16 — Lazy rain**  
- Do not start rain animation loop until user taps Start  
- File: `app.js`

**M17 — Resize + orientation** (partially in Downloads)  
- `orientationchange` → delayed `fitCanvas()` (Downloads has 250ms timeout)  
- Verify tab bar visible in landscape  
- File: `app.js`

---

### Phase 6 — Panel polish

**M18 — Collapsible sections**  
- `<details>` or toggle headers inside sidebar / hydro panels (mobile only)  
- Files: `index.html`, `styles.css`

**M19 — Flood sticky actions**  
- Sticky Run/Clear bar when Flood tab active  
- Files: `styles.css`, small `app.js` hook in `activatePanel`

**M20 — Kingdom overview tap targets**  
- Inflate region box hit areas in `onOverviewClick`  
- File: `app.js`

---

### Phase 7 — QA

**M21 — Desktop regression**  
- Width > 860px: layout, hover, 3D toggle, flood, dams unchanged.

**M22 — Mobile + landscape**  
- Portrait: map default tab, tabs switch panels, touch readout, flood runs  
- Landscape: tab bar not clipped, map resizes  
- Real device pass (not emulator only)

---

## Merge plan for Downloads files

Before M5, merge into fork:

1. Copy `C:\Users\bader\Downloads\files (1)\app.js` → fork `app.js`  
2. Copy `C:\Users\bader\Downloads\files (1)\styles.css` → fork `styles.css` (then apply M4 fix on top)  
3. Copy `C:\Users\bader\Downloads\files (1)\cursor-indicator.js` → fork `cursor-indicator.js`  
4. Re-apply or verify M2/M3 blocks at end of `styles.css` still win where intended  
5. Continue from **M4 fix** → **M5**

---

## Files per task (quick reference)

| Files | Tasks |
|-------|--------|
| `styles.css` only | M1, M2, M3, M4 fix, M6, M12–M14, M18 (css) |
| `index.html` only | M5, M18 (html) |
| `app.js` only | M7, M8, M9–M10, M15–M17, M19–M20 |
| `app.js` + `styles.css` | M10, M19 |
| `cursor-indicator.js` | M11 |

**Paths:**  
- `C:\Users\bader\OneDrive\00 - 2025 MVP\A sabtan\HydroSim\HydroSim-V2.0-mobile\index.html`  
- `C:\Users\bader\OneDrive\00 - 2025 MVP\A sabtan\HydroSim\HydroSim-V2.0-mobile\styles.css`  
- `C:\Users\bader\OneDrive\00 - 2025 MVP\A sabtan\HydroSim\HydroSim-V2.0-mobile\app.js`  
- `C:\Users\bader\OneDrive\00 - 2025 MVP\A sabtan\HydroSim\HydroSim-V2.0-mobile\cursor-indicator.js`  
- `C:\Users\bader\OneDrive\00 - 2025 MVP\A sabtan\HydroSim\HydroSim-V2.0-mobile\cursor-indicator.css`

---

## Time estimates

| Phase | Tasks | Human | AI (Composer) |
|-------|-------|-------|----------------|
| 0 Setup | M0 | 15 min | ~5 min |
| 1 Shell | M1–M4 fix | ~3 hr | ~45 min |
| 2 Tabs | M5–M8 | ~2.5 hr | ~40 min |
| 3 Touch | M9–M11 | ~2 hr | ~30 min |
| 4 Targets | M12–M14 | ~1.5 hr | ~15 min* |
| 5 Perf | M15–M17 | ~1.5 hr | ~20 min* |
| 6 Polish | M18–M20 | ~2 hr | ~30 min |
| 7 QA | M21–M22 | ~1.25 hr | ~20 min |

\*M12–M17 partly done in Downloads — less time if merged first.

**Remaining after Downloads merge:** ~2–3 hr AI / ~8–10 hr human.

---

## Deferred (out of scope)

- Pinch/pan zoom on map  
- PWA + offline `data/` caching  
- Adaptive lower-res `.bin` on small screens  
- Hydrology / model changes (`data/`, flood math)

---

## Next action

1. Merge `C:\Users\bader\Downloads\files (1)\` → fork (3 files)  
2. **M4 fix** → **M5** → **M6** → **M7** → **M8**  
3. Reconcile M10 (`getCanvasXY` vs `evtPoint`)  
4. M21–M22 QA
