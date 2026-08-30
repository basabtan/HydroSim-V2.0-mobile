# Makkah and Wadi Ibrahim implementation record

## 1. Current HydroSim architecture

HydroSim remains a static, browser-side multi-region application. `REGIONS` in
`app.js` selects one independent directory under `data/regions/<key>/`. A region
loads aligned DEM, DTM, D8 direction, flow accumulation, slope and TWI arrays,
then the existing rainfall/runoff renderer operates on that active grid. Optional
GeoJSON context layers are loaded separately and never alter the simulation mask
or D8 routing.

Region switching now stages all fetches under a generation token and commits
them atomically. DEM/DTM, hydrology, flood result, rain animation, dam data,
context overlays, lineaments, derived canvases, 3D terrain and profile state are
cleared before the new region becomes active. A late response from an older
selection cannot overwrite a newer selection.

## 2–6. Raster source, resolution and CRS

- Supabase project: `asabtan-vault` (`eyojwcoupcebawhgvoyv`).
- Bucket: `flood-rasters`.
- DEM object: `sinkfilled_dem.tif`, 7,306,354,869 bytes.
- DEM source grid: EPSG:4326, 0.0002777778 degrees (approximately 30 m),
  79,201 × 61,201 cells, nodata `-99999`.
- Companion objects: `dtm.tif`, `slope.tif`, and `twi.tif`.
- Processing CRS: EPSG:32637, WGS 84 / UTM zone 37N.
- Makkah simulation grid: exactly 30 m, 1,387 × 723 cells.
- Wadi Ibrahim simulation grid: exactly 30 m, 515 × 440 cells.
- Existing Makkah–Jeddah–Taif source raster: approximately 30 m.
- Existing Makkah–Jeddah–Taif simulation grid: approximately 109.0 ×
  109.7 m, 1,600 × 1,152 cells. It is not a 30 m simulation grid.

The source rasters are read by GDAL through Supabase HTTP byte ranges. No
multi-gigabyte source raster is downloaded into or committed to the repository.

## 7–8. Makkah bounds and hydrologic rationale

The browser product has WGS84 display bounds:

- west/east: 39.5388009°E to 39.9413043°E
- south/north: 21.3375775°N to 21.5353073°N
- rectangular grid coverage: 41.61 × 21.69 km
- valid reverse-D8 study area: 370.832 km²

The valid study boundary is not the rectangle and is not an administrative
crop. It is the complete reverse-D8 contributing area to the last receiving-
channel cell before the first major Wadi Uranah confluence. At the next 30 m
cell, upstream area jumps from approximately 371 km² to 912 km². Closing the
Makkah unit immediately upstream of that confluence includes all contributing
terrain affecting the Makkah/Wadi Ibrahim corridor without importing the much
larger downstream Wadi Uranah watershed.

The administrative boundary is an independent reference overlay. It is never
rasterized into the terrain arrays, never used as nodata, and cannot behave as a
wall.

## 9–11. Wadi Ibrahim watershed

- Delineated area: **118.439 km²**.
- Candidate outlet transferred from the parent grid: 39.795465°E,
  21.438581°N.
- Snapped 30 m outlet: 39.7940645°E, 21.4379371°N.
- Outlet grid cell: x=8, y=355 in the cropped Wadi Ibrahim product.
- Outlet accumulation: 131,599 cells.
- Method: project the authoritative DEM to UTM 37N; fill depressions and assign
  D8 directions with the Wang–Liu priority-flood implementation in
  `pyflwdir`; snap within 150 m to the highest-accumulation channel cell; reverse
  traverse all D8 donors; polygonize the resulting cell mask.

The 118.439 km² result is 3.0% above the top of the 111–115 km² independent
validation range. It was not forced into that range. Investigation found a
continuous downstream route and exact agreement between the outlet accumulation,
reverse-D8 cell count and valid raster footprint. Published DEM comparisons also
show that Wadi Ibrahim topology and outlet placement vary materially by DEM; the
2022 comparison reports 110.8 km² for SRTM, 110.3 km² for ALOS, and two
Copernicus sub-basins of 41 and 79.6 km². The retained difference is therefore
recorded as source/outlet sensitivity rather than silently moving the outlet.

Reference: https://doi.org/10.3390/su142013369

## 12. Administrative boundary

OpenStreetMap relation `12429517`, “Makkah Al Mukarramah Governorate”, retrieved
through Nominatim and simplified only for display. Its GeoJSON metadata explicitly
marks it as a reference overlay only.

## 13–16. Geological maps and lineament provenance

The Supabase `Maps` bucket contains:

- `Geological_Maps/250000_scale/gm-107c_Makkah.webp` and `.min.jpg`
- `Geological_Maps/250000_scale/gm-96c_Jibal_Ibrahim.webp` and `.min.jpg`

These are 1:250,000 browse images. Storage metadata contains image size and MIME
type but no raster transform, world file or companion vector structure data.
Consequently, no screenshot line was guessed, georeferenced by eye or published
as a mapped fault. No remote-derived or inferred lines were generated merely to
populate the layer.

The UI and GeoJSON schema keep the three provenance classes separate:
`mapped`, `remote_derived`, and `inferred`. Empty classified layers are disabled
and carry an explicit explanation. Future non-empty features must provide `id`,
`source`, `source_scale`, `source_date`, `status`, `feature_type`, `confidence`,
`orientation_deg`, `length_m`, geometry and notes.

## 17. Files created

- `tools/build_makkah_regions.py`
- `tools/requirements.txt`
- `tools/.gitignore`
- `MAKKAH-WADI-IBRAHIM-IMPLEMENTATION.md`
- `data/regions/makkah/`:
  `metadata.json`, `elevation.bin`, `dtm.bin`, `flowdir.bin`, `flowacc.bin`,
  `slope.bin`, `twi.bin`, `study_boundary.geojson`,
  `admin_boundary.geojson`, `wadi_catchment.geojson`, `drainage.geojson`,
  `lineaments.geojson`, `dams.geojson`
- `data/regions/wadi_ibrahim/`: the same 13 product files.

## 18. Files modified

- `app.js`
- `cinematic.js`
- `index.html`
- `styles.css`
- `hydrosim_validate.py`
- `README.md`
- `data/kingdom/metadata.json`
- `data/regions/makkah_jeddah_taif/metadata.json`

## 19. Performance impact

- Makkah product: 18,825,650 bytes (17.95 MiB across 13 files).
- Wadi Ibrahim product: 4,358,534 bytes (4.16 MiB across 13 files).
- Only the selected region loads.
- Observed local flood computation: approximately 9 ms for Makkah and 2 ms for
  Wadi Ibrahim at 30 mm over 2 h. Network time depends on host/CDN caching.
- GeoJSON drainage is simplified at one 30 m cell tolerance; minor and major
  channels can be toggled independently.

## 20. Validation results

`python hydrosim_validate.py makkah` passes with 20 checks and no warnings.

`python hydrosim_validate.py wadi_ibrahim` passes with 20 checks and one
scientific warning for the 118.439 km² result versus the 111–115 km² literature
range.

The all-region run completes with no failures. It retains existing warnings for
legacy nodata footprints, low-accumulation dam snaps, duplicate outlets and
nested catchment labels. Real-browser validation covered:

- old default region load;
- Makkah and Wadi Ibrahim loads;
- aligned canvas dimensions and metadata;
- rainfall/runoff execution in both new regions;
- study, administrative, catchment, minor drainage and major-channel overlays;
- empty mapped/remote/inferred lineament controls disabled;
- rapid Wadi Ibrahim → Makkah → Riyadh → Makkah switching;
- clearing the previous flood summary, dams and overlay state;
- no new console errors.

## 21. Scientific limitations

- This remains a screening-scale D8 rainfall/runoff model, not a calibrated
  hydraulic model. It has no 2D momentum solver, surveyed channel cross-sections,
  culvert network, infiltration calibration or observed-event calibration.
- Uniform rainfall, simplified runoff coefficients and regime depth equations
  remain from the existing engine.
- A 30 m DEM cannot resolve every engineered drain, tunnel, culvert or narrow
  urban channel. Urban earthworks can change the apparent Wadi Ibrahim divide.
- The Wadi Ibrahim area difference is unresolved source/outlet sensitivity and
  should be checked against a surveyed drainage outlet and current municipal
  stormwater network.
- The OSM administrative boundary is contextual and may be incomplete or change.
- The 1:250,000 geological browse maps do not support precise fault placement.
- No calibrated groundwater-flow or fracture-flow model exists in HydroSim.

## 22. Recommended fractured-rock groundwater next step

Acquire georeferenced SGS source sheets or authoritative fault/lineament vectors,
then validate structures against field mapping, borehole logs, water levels,
hydraulic tests and spring/Zamzam monitoring. Build a separate conceptual
hydrogeologic model with lithologic units, weathered-zone thickness, recharge,
boundaries and uncertainty. Only after calibration should a MODFLOW 6 model (or
an explicitly documented discrete-fracture/dual-permeability model where data
support it) be coupled loosely to HydroSim recharge outputs. Do not convert the
current lineament context layer into underground pipes.
