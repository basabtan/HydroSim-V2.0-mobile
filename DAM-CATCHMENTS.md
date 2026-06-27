# Dam snapping & catchment delineation

This documents the catchment-area fix and the validation harness.

## The bug (before)

Dam catchments were wrong in two compounding ways:

1. **Mis-snapping.** Dams snapped to minor tributaries (low flow-accumulation)
   instead of the main wadi channel. In Makkah–Jeddah–Taif, 17 of 27 dams had a
   snapped accumulation < half the nearby true outlet. Example: Wadi Naman Dam
   (22 MCM flood-control) was assigned a 6-cell / 5.86 km² catchment.
2. **Wrong cell-area convention.** `catchment_area_km2` multiplied a
   *display-resolution* cell count by the *source* 30 m cell area (900 m²),
   undercounting true area by ~13×.

Eastern Province, Riyadh, and Asir–Abha had **no** catchment fields at all —
reservoir routing could not run there.

## The fix

`delineate_dams.py` performs standard D8 watershed delineation:

1. **Snap** each dam to the maximum-flow-accumulation cell within a bounded
   window (window scales with dam capacity; capped so it can't cross a wadi
   divide into a neighbouring basin).
2. **Delineate** the contributing catchment by reverse-D8 flood fill from the
   snapped outlet (a neighbour belongs to the catchment iff its flow vector
   points into the current cell).
3. **Recompute** `catchment_cells`, `catchment_area_km2` (using the **display**
   cell area — the grid the routing actually runs on), and rebuild
   `dam_catchments.bin` (uint16, label = damIndex+1, 0 = uncontrolled).

Raster formats: `flowdir.bin` int8 interleaved (dx,dy) ∈ {-1,0,1};
`flowacc.bin` uint32; index = `py*W + px`.

Result: 27 (MJT) + 24 (Eastern) + 49 (Riyadh) + 52 (Asir) dams delineated;
every dam now satisfies `snap_acc == catchment_cells == outlet_acc`.

## Validation harness

`hydrosim_validate.py` is a CI guardrail. Run after any pipeline/raster change:

```
python3 hydrosim_validate.py            # all regions
python3 hydrosim_validate.py riyadh     # one region
python3 hydrosim_validate.py --strict   # warnings -> failures
```

Checks: SNAP (snap_acc == flowacc[outlet], outlet on a channel),
CONSIST (cells == acc, re-delineation reproduces the count),
AREA (km² == cells × display-cell-area), RANGE, CAP (capacity vs catchment
plausibility), DUP (dams sharing an outlet), RASTER (bin size/labels; reports
nested catchments). Exit 0 = pass, 1 = warnings, 2 = failures.

Current status: **450 checks pass, 0 failures.** Remaining warnings are
data-quality flags for human review, not errors:
- Low-flow outlets on genuinely small check dams (Eastern Province sabkha).
- Near-duplicate dams from OSM sharing one outlet.
- Nested catchments where an upstream dam's basin lies inside a downstream
  dam's basin (its label is hidden in the single-label raster; its area in
  `dams.geojson` is still individually correct).
