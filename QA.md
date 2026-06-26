# HydroSim Mobile — QA (M21–M22)

**Fork:** `HydroSim-V2.0-mobile`  
**Run:** `start_windows.bat` → http://localhost:8765  
**DevTools:** toggle device toolbar, width ≤860px, touch emulation on

---

## M21 — Desktop regression (automated / code review)

| Check | Result | Notes |
|-------|--------|-------|
| Original `HydroSim-V2.0/` untouched | ✅ | Work only in `-mobile` fork |
| Desktop grid layout (>860px) | ✅ | Mobile rules scoped to `@media (max-width: 860px)` |
| `mobile-only` elements hidden on desktop | ✅ | Tab bar, layers btn, sheet backdrop |
| `#hydroPanel .mobile-group` on desktop | ✅ | `display: contents` at `min-width: 861px` |
| Rail nav wired | ✅ | `activatePanel()` scrolls to panel |
| Mouse hover readout | ✅ | `mousemove` unchanged |
| 3D / orbit ring on fine pointer | ✅ | Gated by `isCoarsePointer()` |
| Flood run/clear buttons | ✅ | Wrapped in `.flood-actions`, desktop layout unchanged |
| Server serves app | ✅ | `index.html` + `app.js` HTTP 200 |
| Conflicting `body { overflow: auto }` @860px | ✅ | Removed; single `overflow: hidden` model |

**Manual desktop pass still recommended:** hover readout, 3D toggle, flood model, profile tool, region switch.

---

## M22 — Mobile + landscape (automated / code review)

| Check | Result | Notes |
|-------|--------|-------|
| Default tab = Map | ✅ | `activatePanel('terrain')` on boot |
| Tab bar present | ✅ | `#mobileTabBar` 4 buttons |
| Layers sheet | ✅ | `#layersBtn` → `#sidebar` slide-up |
| Touch map readout | ✅ | `touchmove` + `onMove` |
| Drag vs tap (6px) | ✅ | Profile / overview routing |
| `touch-action: none` on canvas | ✅ | |
| 44px tap targets | ✅ | `@media (pointer: coarse)` |
| 3D hidden on coarse | ✅ | |
| Rain pauses off Rain tab | ✅ | `syncRainLoopForPanel` |
| Orientation re-fit | ✅ | `orientationchange` + `visualViewport.resize` |
| Landscape tab bar height | ✅ | 48px + safe-area in landscape block |
| Collapsible panels | ✅ | Mobile-only `panel-toggle` |
| Sticky flood actions | ✅ | Flood tab active |
| Overview +3% hit on coarse | ✅ | Nearest-center tiebreak |

**Requires real device (manual):**

- [ ] Finger-drag map → readout updates, page doesn't scroll
- [ ] Tap Kingdom region → zooms in
- [ ] Profile tool → two taps → chart draws
- [ ] Sliders/buttons easy to hit; no horizontal scroll
- [ ] Rotate phone → map re-fits, tab bar visible
- [ ] Layers sheet opens/closes cleanly
- [ ] Flood Run/Clear reachable (sticky bar)
- [ ] Chrome Android + tablet sizes

---

## Quick test on phone (same Wi‑Fi)

1. On PC: `ipconfig` → note IPv4 (e.g. `192.168.1.x`)
2. Allow firewall for port 8765 if prompted
3. On phone: `http://<PC-IP>:8765`

---

## Known deferred (out of scope)

Pinch zoom, PWA/offline, adaptive grid resolution.
