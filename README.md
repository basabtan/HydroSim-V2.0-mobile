# HydroSim — Saudi Arabia Flood & Terrain Viewer

Updated package: HydroSim has been restyled to match the supplied `layout.zip` reference layout/theme. The full multi-region data and functionality are preserved.

# Saudi Arabia Flood & Terrain Viewer

Rainfall-driven flood prediction system for Saudi Arabia. A Kingdom-wide overview
for navigation plus four full-resolution (~30 m) flood-analysis regions, each with
its own terrain, hydrology, dams and rainfall-runoff flood model.

## Phase 4 — Multi-region scope + live rain controls (new)

The viewer is no longer limited to a single area. You can now choose the **scope**
of analysis from the sidebar:

- **Kingdom overview** — a coarse, downsampled national elevation + wetness view
  (EPSG:4326, ~1.6 km) used for navigation. The four analysis regions are drawn as
  labelled, clickable boxes; click a box (or pick from the dropdown) to zoom into
  that region at full resolution.
- **Four analysis regions**, each processed independently from the Kingdom-wide
  source rasters with its own grid, UTM projection, hydrology and dam inventory:
  - **Makkah – Jeddah – Taif** (UTM 37N, 174 × 126 km)
  - **Riyadh Region** (UTM 38N, 162 × 133 km)
  - **Eastern Province (Dammam – Khobar)** (UTM 39N, coastal lowlands)
  - **Asir / Abha Highlands** (UTM 38N, SW escarpment, up to ~2,990 m)
- **Region dropdown** at the top of the sidebar switches scope on demand; layer
  data is loaded lazily so only the active region's grids are fetched.
- **Procedural basemaps** — elevation colour relief, hillshade, slope and aspect are
  now baked in-browser directly from each region's elevation grid (no pre-rendered
  PNGs), so every region renders consistently from its `.bin` data alone.

**Live rain animation controls** — the rain overlay now has three sliders:

- **Rainfall intensity** (Drizzle → Extreme) — controls drop density.
- **Simulation speed** (0.25× – 3×) — controls how fast drops fall.
- **Soil infiltration** (None → Very high / vegetated) — controls how quickly drops
  soak into the ground rather than pooling.

> **Note on dams in the new regions:** Riyadh, Eastern Province and Asir/Abha dams
> are sourced from OpenStreetMap and shown as informational markers. Fill-then-
> overflow reservoir routing (which needs a precomputed catchment grid) currently
> runs only for the Makkah–Jeddah–Taif region; the other regions show dams as
> non-intercepting markers until their catchment grids are computed.

---

## v2 foundations (Makkah–Jeddah–Taif pilot)

The original viewer used a shaded-relief image as if it were elevation, and the flood tool was a simple bathtub. v2 introduced the real-terrain + rainfall-runoff approach now used across all regions:

- **Real terrain** reprojected to UTM at 30 m per region (Makkah–Jeddah–Taif: 174.4 × 126.4 km, elevations −3 to 2,595 m).
- **Rainfall-runoff flood model** instead of bathtub: you specify storm depth (mm), duration (h), and soil infiltration class. The model computes runoff, routes it through the D8 flow network derived from the real DEM, estimates peak discharge per channel, and maps inundation depth using regime equations.

## Phase 3 — High-precision DEM + Topographic Wetness Index (new)

The terrain and hydrology now come from the project's own authoritative rasters instead of the generic Copernicus DEM:

- **Sink-filled DEM** — a Kingdom-wide, depression-filled ~30 m DEM (EPSG:4326), clipped to the Makkah–Jeddah–Taif AOI and reprojected to UTM 37N. Flow direction and flow accumulation are recomputed from this surface with pysheds, giving a hydrologically conditioned drainage network specific to the project data.
- **Topographic Wetness Index (TWI)** — the project's authoritative TWI raster, rank-normalised to a 0–1 flood-susceptibility index (1 = wettest valley bottoms that pond/flood first). The flood model uses it to amplify modelled water depth in saturated low-lying cells and dampen it on well-drained slopes, without changing total runoff volume.
- **Slope** — the project's authoritative slope raster (converted from radians to degrees).
- **Wetness (TWI) layer** — a new map basemap that paints the 0–1 wetness index directly (dry warm-earth → wet deep-blue), rendered from the `twi.bin` grid rather than a pre-baked PNG. It reveals the saturated valley-bottom drainage network that floods first, and works under the flood overlay and dam markers.
- **Bare-earth DTM** — the project's authoritative bare-earth Digital Terrain Model (buildings and canopy removed), clipped to the AOI and reprojected to UTM 37N (int16 metres, min −5 / max 2,595 / mean 625.5 m). It is added as its own **Bare-earth (DTM)** basemap rendered with the same elevation ramp as the DEM, so the two surfaces can be compared directly. Hovering reads out the bare-earth height.
- **Sink-fill depth layer (DEM − DTM)** — a new diagnostic basemap showing where hydrological sink-filling raised the surface above bare earth. Most terrain reads as a dark base (no fill needed); cyan-to-red speckles mark the closed depressions that were filled (deepest ≈ 26 m), which cluster in valley bottoms and the coastal plain — exactly where water ponds in reality. Hovering reads out the local fill depth.
- **Corrected dam catchments** — recomputing the flow network fixed several dam snaps. Most notably **Wadi Fatimah Dam** now resolves a ~226 km² upstream catchment (it sits on a major wadi) versus a spurious ~1 km² before, so its reservoir fill/overflow behaviour is now realistic.

The big source rasters live in Supabase object storage and are streamed window-by-window (HTTP range requests via GDAL `/vsicurl/`) during processing, so multi-GB files never need to be downloaded whole. Only the small derived `.bin` layers are bundled with the app.

## Phase 2 — Dams & reservoir capacity

The viewer now models the 27 dams in the pilot area as storage reservoirs that intercept runoff before it reaches downstream channels:

- **Dam inventory**: 27 dams compiled from OpenStreetMap and the FAO AQUASTAT Saudi dam inventory, with reservoir capacities (6 verified from authoritative sources, 21 estimated from height class and tagged "est."). Total storage ≈ 111 MCM.
- **Upstream catchments**: each dam is snapped to its nearest channel cell on the D8 network, and its full upstream contributing area is computed (stored as `data/dam_catchments.bin`).
- **Fill-then-overflow routing**: during a storm, runoff generated within a dam's catchment fills its reservoir first. If inflow exceeds capacity, the excess overflows downstream; if the dam contains the storm, it suppresses downstream channel flooding from that catchment.
- **Live Dams panel**: each dam shows name, capacity, inflow, fill %, and a color-coded status (green < 70 %, amber 70–95 %, red ≥ 95 % / overflowing). Markers on the map share the same color. A storm summary reports total runoff captured, which dams overflow, total uncontrolled downstream discharge, and the estimated time of first overflow.

## How to run

**This app does not work if you double-click `index.html` directly** — browsers block local data loading on the `file://` protocol, so the page will hang on "Loading terrain…". You must run a local web server.

### Easiest: one-click launchers

- **Windows**: double-click `start_windows.bat`
- **macOS / Linux**: double-click `start_mac_linux.sh` (or run `./start_mac_linux.sh` in a terminal)

They start a local server and open the viewer in your browser automatically. Requires Python 3 (already installed on Mac/Linux; on Windows, get it from [python.org](https://www.python.org/downloads/) and check "Add Python to PATH").

### Manual

```bash
cd dem_viewer_v2
python3 -m http.server 8765
# then open http://localhost:8765
```

Any static file server works — no backend required.

## Controls

- **Visualization**: Elevation (DEM) / Bare-earth (DTM) / Hillshade / Slope / Aspect / Wetness (TWI) / Sink-fill depth basemaps, optional contour lines, 3D mode
- **Profile tool**: click two points to draw an elevation cross-section
- **Flood model**:
  - Rainfall depth (1–250 mm)
  - Storm duration (0.5–24 h)
  - Soil infiltration class (Low arid / Medium / High / Very high)
  - "Run flood model" → simulates inundation
  - "Clear" → removes overlay and resets dams to neutral
- **Dams & reservoirs**: "Show" toggle to display/hide dam markers and the panel; updates automatically each time the flood model runs

## Calibrated scenarios

| Scenario | Rainfall | Flooded area | Max depth | Peak Q |
|---|---|---|---|---|
| Drizzle | 5 mm / 6 h | 4.7 km² | 0.89 m | 52 m³/s |
| Moderate storm | 15 mm / 3 h | 36.2 km² | 1.59 m | 368 m³/s |
| Heavy storm | 30 mm / 2 h | 100.8 km² | 2.23 m | 1,143 m³/s |
| Jeddah-2009-like | 100 mm / 4 h | 155.9 km² | 2.62 m | 1,950 m³/s |
| Extreme | 150 mm / 4 h | 214.0 km² | 2.96 m | 2,935 m³/s |

## Model details

Pipeline:

1. **DEM**: Copernicus GLO-30 → pit-filled with pysheds
2. **Hydrology**: D8 flow direction + flow accumulation (saved as flowdir.bin, flowacc.bin)
3. **Runoff generation**: SCS-style initial abstraction, then runoff coefficient by soil class, modulated by local slope
4. **Routing**: runoff volume accumulated downstream along D8 network
5. **Channel definition**: only cells with ≥ 50-cell upstream contributing area (≈ 4.5 ha) are treated as channels
6. **Peak discharge**: Q_peak = (V / T) × 2.5 (triangular hydrograph peak factor)
7. **Depth**: Leopold-style regime equations — width w = 2.5·Q^0.5, depth d = 0.27·Q^0.30
8. **Inundation threshold**: cells flagged if depth ≥ 0.30 m (cars float). Sea cells (elev ≤ 1 m) excluded.

## Data files

Data is organised by scope. Each analysis region lives in `data/regions/<key>/`
(`makkah_jeddah_taif`, `riyadh`, `eastern_province`, `asir_abha`), and the Kingdom
overview lives in `data/kingdom/`. Grid dimensions vary per region — the app reads
`width`/`height` from each region's `metadata.json`.

Per-region files:

- `elevation.bin` — Int16 LE sink-filled DEM (region grid)
- `flowdir.bin` — Int8 dx,dy interleaved (D8)
- `flowacc.bin` — Uint32 LE flow accumulation
- `twi.bin` — Float32 LE, 0–1 flood-susceptibility index (rank-normalised TWI)
- `slope.bin` — Float32 LE, slope in degrees
- `dtm.bin` — Int16 LE bare-earth DTM in metres (nodata −32768)
- `dams.geojson` — dams with name (en/ar), and (MJT) capacity, catchment area, `verified` flag
- `dam_catchments.bin` — (MJT only) Uint16 LE label grid (0 = no dam, else dam index + 1)
- `metadata.json` — projection, bounds, grid size, statistics, `has_catchments` flag

Kingdom overview (`data/kingdom/`):

- `elevation.bin`, `twi.bin` — downsampled national grids (EPSG:4326, 1100 × 850)
- `metadata.json` — includes `region_boxes` (the clickable AOIs)

Procedural basemaps (colour relief, hillshade, slope, aspect) are baked in-browser
from `elevation.bin`/`slope.bin`, so no basemap PNGs are bundled.

## Source DEM

Copernicus GLO-30 Digital Surface Model, downloaded from AWS Open Data:
`https://copernicus-dem-30m.s3.amazonaws.com/Copernicus_DSM_COG_10_<TILE>_DEM/<file>.tif`

License: free for any use, including commercial.

## Limitations & next steps

This is a screening tool, not an engineering flood model. Known limitations:

- 30 m DEM smooths narrow wadi channels — local depths may be underestimated in tight gorges
- Reservoir model uses static capacity and a single fill-then-overflow step (no time-stepped routing, spillway curves, or pre-storm fill state)
- Estimated capacities (21 of 27 dams) are height-class defaults and should be replaced with MEWA design figures where available
- Uniform rainfall over AOI (no spatial storm pattern)
- No baseflow, no hydrograph attenuation between cells
- Not validated against observed flood extents

Roadmap for Kingdom-wide expansion:

1. ✅ Add Wadi Naman, Wadi Fatimah, and other dam locations from OSM with reservoir capacity (Phase 2 — done)
2. ✅ Multi-region scope with Kingdom overview + four analysis regions and live rain controls (Phase 4 — done)
3. Compute catchment grids for Riyadh / Eastern Province / Asir so their dams route runoff like MJT
4. Replace estimated dam capacities with authoritative MEWA design figures
5. Hindcast validation against Jeddah 2009 and 2022 floods using Sentinel-1 SAR observations
6. Scale to remaining regions by tiling on HydroBASINS level-7 watersheds

---
Built on Copernicus GLO-30 DEM (© European Space Agency, free license).
