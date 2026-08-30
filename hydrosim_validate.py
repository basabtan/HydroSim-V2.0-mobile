#!/usr/bin/env python3
"""
HydroSim — geodata validation harness
=====================================
Guardrail that verifies dam snapping + catchment delineation stays physically
sensible. Run it after any change to the dam pipeline or the source rasters.

Checks per region (over all dams):
  [SNAP]   snapped cell sits on a real channel (flowacc >= channel threshold,
           scaled down for small check dams) and snap_acc == flowacc[outlet].
  [CONSIST] catchment_cells == snap_acc == outlet_acc  (reverse-D8 fill from the
           snapped outlet must reproduce its accumulation exactly).
  [AREA]   catchment_area_km2 == catchment_cells * display_cell_area  (correct
           cell-area convention; catches the source-vs-display 13x error).
  [RANGE]  catchment area within plausible bounds for the region grid.
  [CAP]    capacity vs catchment plausibility: implied runoff yield per km2 is
           in a sane band (flags impossible dam/catchment pairings).
  [DUP]    near-duplicate dams (same snapped outlet) — review for double counting.
  [RASTER] dam_catchments.bin exists, correct dtype/size, labels match dams;
           reports nested catchments (expected) vs missing labels.

Exit code 0 = all OK, 1 = warnings, 2 = hard failures. Designed for CI.

Usage:
  python3 hydrosim_validate.py                 # all regions
  python3 hydrosim_validate.py riyadh          # one region
  python3 hydrosim_validate.py --strict        # treat warnings as failures
"""
import json, os, sys
import numpy as np
from collections import deque, defaultdict

if hasattr(sys.stdout, 'reconfigure'):
    sys.stdout.reconfigure(encoding='utf-8')

REGIONS = ['makkah_jeddah_taif', 'makkah', 'wadi_ibrahim',
           'eastern_province', 'riyadh', 'asir_abha']
BASE = os.path.join(os.path.dirname(__file__), 'data', 'regions')
NB = [(-1,-1),(0,-1),(1,-1),(-1,0),(1,0),(-1,1),(0,1),(1,1)]

# Tolerances / thresholds
AREA_REL_TOL = 0.02           # catchment_area_km2 vs cells*cell_area
CHANNEL_MIN_ACC = 20          # below this, an "outlet" is hillslope, not a channel
# Plausible specific yield band: a storm dam typically stores a fraction of the
# runoff from its catchment. Implied depth = capacity / area should be sane.
CAP_DEPTH_MIN_MM = 0.5        # capacity_m3 / area_m2 in mm — too low = oversized basin?
CAP_DEPTH_MAX_MM = 2000.0     # too high = catchment too small for the dam


class Report:
    def __init__(self):
        self.fail = []; self.warn = []; self.ok = 0
    def f(self, msg): self.fail.append(msg)
    def w(self, msg): self.warn.append(msg)
    def passed(self): self.ok += 1


def delineate_count(outx, outy, dx, dy, W, H):
    cnt = 0
    seen = np.zeros((H, W), dtype=bool)
    q = deque([(outx, outy)]); seen[outy, outx] = True
    while q:
        cx, cy = q.popleft(); cnt += 1
        for ox, oy in NB:
            nx, ny = cx + ox, cy + oy
            if 0 <= nx < W and 0 <= ny < H and not seen[ny, nx]:
                if cx == nx + dx[ny, nx] and cy == ny + dy[ny, nx]:
                    seen[ny, nx] = True; q.append((nx, ny))
    return cnt


def validate_grids(region, rdir, meta, W, H, rep):
    """Validate alignment, grid/source resolution semantics and study outlets."""
    n = W * H
    specs = {
        'elevation.bin': (np.int16, n), 'dtm.bin': (np.int16, n),
        'flowdir.bin': (np.int8, n * 2), 'flowacc.bin': (np.uint32, n),
        'slope.bin': (np.float32, n), 'twi.bin': (np.float32, n),
    }
    arrays = {}
    for filename, (dtype, expected) in specs.items():
        path = os.path.join(rdir, filename)
        if not os.path.exists(path):
            rep.f(f"FAIL GRID [{region}]: missing {filename}"); continue
        arr = np.fromfile(path, dtype=dtype)
        if arr.size != expected:
            rep.f(f"FAIL GRID [{region}]: {filename} has {arr.size} values, expected {expected}")
        else:
            arrays[filename] = arr
            rep.passed()
    if len(arrays) != len(specs):
        return None

    elev = arrays['elevation.bin'].reshape(H, W)
    dtm = arrays['dtm.bin'].reshape(H, W)
    fd = arrays['flowdir.bin'].reshape(H, W, 2)
    fa = arrays['flowacc.bin'].reshape(H, W)
    slope = arrays['slope.bin'].reshape(H, W)
    twi = arrays['twi.bin'].reshape(H, W)
    valid = elev != -32768
    new_region = region in ('makkah', 'wadi_ibrahim')
    def alignment_issue(message):
        (rep.f if new_region else rep.w)(message)
    cell_w_m = meta['area_km']['width'] * 1000.0 / W
    cell_h_m = meta['area_km']['height'] * 1000.0 / H
    cell_area_km2 = cell_w_m * cell_h_m / 1e6

    if not np.array_equal(valid, dtm != -32768):
        alignment_issue(f"{'FAIL' if new_region else 'WARN'} ALIGN [{region}]: DEM and DTM nodata footprints differ")
    else: rep.passed()
    if not np.isfinite(slope[valid]).all() or np.nanmin(slope[valid]) < 0 or np.nanmax(slope[valid]) > 90.01:
        alignment_issue(f"{'FAIL' if new_region else 'WARN'} ALIGN [{region}]: slope contains non-finite or out-of-range degrees")
    else: rep.passed()
    if not np.isfinite(twi[valid]).all() or np.nanmin(twi[valid]) < -1e-6 or np.nanmax(twi[valid]) > 1.000001:
        alignment_issue(f"{'FAIL' if new_region else 'WARN'} ALIGN [{region}]: TWI is not finite and normalized to 0..1")
    else: rep.passed()
    if not np.isin(fd, [-1, 0, 1]).all():
        rep.f(f"FAIL D8 [{region}]: flowdir contains values outside -1,0,1")
    else: rep.passed()

    source_res = meta.get('source_raster_resolution_m', meta.get('src_resolution_m'))
    grid_res = meta.get('grid_resolution_m', meta.get('processed_grid_resolution_m'))
    if region in ('makkah', 'wadi_ibrahim'):
        if source_res != 30 or grid_res != 30:
            rep.f(f"FAIL RES [{region}]: expected explicit 30 m source and processed grid metadata")
        else: rep.passed()
        expected_area = int(valid.sum()) * cell_area_km2
        stored_area = meta.get('study_area_km2')
        if stored_area is None or abs(stored_area - expected_area) > max(0.01, expected_area * 0.001):
            rep.f(f"FAIL AREA [{region}]: study_area_km2={stored_area} but valid grid gives {expected_area:.3f}")
        else: rep.passed()
        outlet = meta.get('outlet') or {}
        ox, oy = outlet.get('px'), outlet.get('py')
        if ox is None or oy is None or not (0 <= ox < W and 0 <= oy < H):
            rep.f(f"FAIL OUTLET [{region}]: missing or invalid outlet px/py")
        else:
            ox, oy = int(ox), int(oy)
            dx = fd[:, :, 0].astype(np.int32); dy = fd[:, :, 1].astype(np.int32)
            recount = delineate_count(ox, oy, dx, dy, W, H)
            acc = int(fa[oy, ox])
            if recount != acc or recount != int(valid.sum()):
                rep.f(f"FAIL OUTLET [{region}]: reverse-D8={recount}, flowacc={acc}, valid={int(valid.sum())}")
            else: rep.passed()
            if outlet.get('flowacc_cells') != acc:
                rep.f(f"FAIL OUTLET [{region}]: metadata flowacc does not match raster")
            else: rep.passed()
        validation = meta.get('validation_area_km2')
        if validation and not (validation[0] <= stored_area <= validation[1]):
            rep.w(f"WARN SCIENCE [{region}]: delineated {stored_area:.3f} km2 is outside published validation range {validation[0]}-{validation[1]} km2")

        for filename in ('study_boundary.geojson', 'admin_boundary.geojson',
                         'wadi_catchment.geojson', 'drainage.geojson', 'lineaments.geojson'):
            if not os.path.exists(os.path.join(rdir, filename)):
                rep.f(f"FAIL OVERLAY [{region}]: missing {filename}")
            else: rep.passed()
        lineaments = json.load(open(os.path.join(rdir, 'lineaments.geojson'), encoding='utf-8'))
        allowed = {'mapped', 'remote_derived', 'inferred'}
        required = {'id', 'source', 'source_scale', 'source_date', 'status',
                    'feature_type', 'confidence', 'orientation_deg', 'length_m', 'notes'}
        for i, feature in enumerate(lineaments.get('features', [])):
            props = feature.get('properties') or {}
            if props.get('status') not in allowed or not required.issubset(props):
                rep.f(f"FAIL LINEAMENT [{region}#{i}]: invalid provenance or required properties")
            else: rep.passed()
        admin = json.load(open(os.path.join(rdir, 'admin_boundary.geojson'), encoding='utf-8'))
        if 'reference' not in str(admin.get('properties', {}).get('role', '')).lower():
            rep.f(f"FAIL BOUNDARY [{region}]: administrative boundary is not marked reference-only")
        else: rep.passed()
    elif source_res and abs(cell_w_m - float(source_res)) > 5:
        # Existing downsampled regions must not claim their source resolution is
        # also the simulation-cell resolution.
        if not meta.get('resolution_note') and region == 'makkah_jeddah_taif':
            rep.f(f"FAIL RES [{region}]: source and processed resolution are not distinguished")
        else: rep.passed()
    return fa, fd


def validate_region(region, rep, deep=True):
    rdir = os.path.join(BASE, region)
    meta = json.load(open(os.path.join(rdir, 'metadata.json'), encoding='utf-8'))
    W, H = meta['width'], meta['height']
    grid_data = validate_grids(region, rdir, meta, W, H, rep)
    if grid_data is None:
        return
    fa, fd = grid_data
    dx = fd[:, :, 0].astype(np.int32); dy = fd[:, :, 1].astype(np.int32)
    dams = json.load(open(os.path.join(rdir, 'dams.geojson'), encoding='utf-8'))['features']
    cell_w_m = meta['area_km']['width'] * 1000.0 / W
    cell_h_m = meta['area_km']['height'] * 1000.0 / H
    cell_area_km2 = (cell_w_m * cell_h_m) / 1e6
    grid_area_km2 = meta['area_km']['width'] * meta['area_km']['height']

    print(f"\n=== {region}  (W={W} H={H}, display cell = {cell_area_km2*1e6:.0f} m2) ===")
    outlets = defaultdict(list)

    for idx, feat in enumerate(dams):
        p = feat['properties']
        name = p.get('name_en') or p.get('name_ar') or f'dam{idx}'
        px, py = p.get('px'), p.get('py')
        tag = f"  [{region}#{idx} {name[:28]}]"

        if px is None or py is None:
            rep.f(f"FAIL SNAP{tag}: missing px/py"); continue
        px, py = int(px), int(py)
        if not (0 <= px < W and 0 <= py < H):
            rep.f(f"FAIL SNAP{tag}: px/py out of grid"); continue

        acc = int(fa[py, px])
        snap_acc = p.get('snap_acc'); outlet_acc = p.get('outlet_acc')
        cells = p.get('catchment_cells'); area = p.get('catchment_area_km2')
        outlets[(px, py)].append(name)

        # SNAP: snap_acc must equal the flowacc at (px,py)
        if snap_acc != acc:
            rep.f(f"FAIL SNAP{tag}: snap_acc={snap_acc} != flowacc[outlet]={acc}")
        else:
            rep.passed()

        # outlet on a real channel? small check dams allowed lower threshold
        cap_mcm = p.get('capacity_mcm') or 0
        min_acc = CHANNEL_MIN_ACC if cap_mcm < 1 else CHANNEL_MIN_ACC * 2
        if acc < min_acc:
            rep.w(f"WARN SNAP{tag}: outlet flowacc={acc} is low (hillslope, not channel?)")

        # CONSIST: cells == acc == outlet_acc
        if cells != acc:
            rep.f(f"FAIL CONSIST{tag}: catchment_cells={cells} != flowacc={acc}")
        if outlet_acc is not None and outlet_acc != acc:
            rep.w(f"WARN CONSIST{tag}: outlet_acc={outlet_acc} != flowacc={acc}")

        # deep check: reverse-D8 fill reproduces the count (sampled to keep CI fast)
        if deep and cells is not None and cells <= 60000:
            recount = delineate_count(px, py, dx, dy, W, H)
            if recount != cells:
                rep.f(f"FAIL CONSIST{tag}: re-delineated {recount} != stored {cells}")
            else:
                rep.passed()

        # AREA: km2 == cells * display cell area
        if cells is not None and area is not None:
            expect = cells * cell_area_km2
            if expect > 0 and abs(area - expect) / expect > AREA_REL_TOL:
                rep.f(f"FAIL AREA{tag}: area_km2={area} but cells*cell_area={expect:.3f} "
                      f"(cell-area convention wrong?)")
            else:
                rep.passed()

        # RANGE: not absurdly large vs the whole grid
        if area is not None and area > grid_area_km2 * 1.05:
            rep.f(f"FAIL RANGE{tag}: catchment {area} km2 > region grid {grid_area_km2:.0f} km2")

        # CAP: capacity vs catchment plausibility (only when capacity known)
        cap_m3 = p.get('capacity_m3')
        if cap_m3 and area and area > 0:
            depth_mm = cap_m3 / (area * 1e6) * 1000.0  # capacity spread over catchment, mm
            if depth_mm > CAP_DEPTH_MAX_MM:
                rep.w(f"WARN CAP{tag}: capacity implies {depth_mm:.0f} mm over catchment "
                      f"(catchment may be too small for a {cap_mcm} MCM dam)")
            elif depth_mm < CAP_DEPTH_MIN_MM:
                rep.w(f"WARN CAP{tag}: capacity implies only {depth_mm:.2f} mm over catchment "
                      f"(catchment may be too large / wrong basin)")

    # DUP: dams sharing an exact snapped outlet
    for (ox, oy), names in outlets.items():
        if len(names) > 1:
            rep.w(f"WARN DUP [{region}]: {len(names)} dams share outlet ({ox},{oy}): "
                  f"{', '.join(n[:20] for n in names)}")

    # RASTER: dam_catchments.bin integrity
    dc_path = os.path.join(rdir, 'dam_catchments.bin')
    if meta.get('has_catchments'):
        if not os.path.exists(dc_path):
            rep.f(f"FAIL RASTER [{region}]: has_catchments=True but dam_catchments.bin missing")
        else:
            dc = np.fromfile(dc_path, dtype=np.uint16)
            if dc.size != W * H:
                rep.f(f"FAIL RASTER [{region}]: dam_catchments.bin size {dc.size} != {W*H}")
            else:
                rep.passed()
                labs = set(int(x) for x in np.unique(dc) if x > 0)
                expected = set(range(1, len(dams) + 1))
                missing = sorted(expected - labs)
                if missing:
                    # nested catchments legitimately hide upstream labels; report as info/warn
                    rep.w(f"WARN RASTER [{region}]: {len(missing)} dam label(s) not visible in "
                          f"raster (nested inside downstream catchments): {missing[:10]}"
                          + (' ...' if len(missing) > 10 else ''))
                extra = sorted(labs - expected)
                if extra:
                    rep.f(f"FAIL RASTER [{region}]: raster has labels with no dam: {extra[:10]}")


def main():
    args = [a for a in sys.argv[1:] if not a.startswith('--')]
    strict = '--strict' in sys.argv
    targets = args if args else REGIONS
    rep = Report()
    for reg in targets:
        validate_region(reg, rep, deep=True)

    print("\n" + "=" * 60)
    print(f"PASSED checks : {rep.ok}")
    print(f"WARNINGS      : {len(rep.warn)}")
    for m in rep.warn: print("  " + m)
    print(f"FAILURES      : {len(rep.fail)}")
    for m in rep.fail: print("  " + m)
    print("=" * 60)

    if rep.fail:
        print("RESULT: FAIL"); sys.exit(2)
    if rep.warn and strict:
        print("RESULT: FAIL (strict — warnings treated as errors)"); sys.exit(2)
    if rep.warn:
        print("RESULT: PASS WITH WARNINGS"); sys.exit(1)
    print("RESULT: PASS"); sys.exit(0)


if __name__ == '__main__':
    main()
