#!/usr/bin/env python3
"""
HydroSim — dam snap + catchment re-delineation
==============================================
Fixes the catchment-area / snapping bug:

  * Dams were snapping to minor tributaries (low flowacc) instead of the main
    wadi channel, giving absurdly small catchments (e.g. 6 cells / 5.86 km2 for
    a 22 MCM flood-control dam).
  * Catchment area was computed with SOURCE (30 m) cell area against a
    DISPLAY-resolution cell count, undercounting true area by ~13x.

Method (standard D8 watershed delineation):
  1. Snap each dam to the highest-flow-accumulation cell within a bounded window
     around its mapped (px,py) — i.e. the dominant channel it impounds.
  2. Delineate the contributing catchment by reverse-D8 flood fill from the
     snapped outlet: a neighbour belongs to the catchment iff its flow vector
     (dx,dy) points INTO the current cell.
  3. Recompute catchment_cells and catchment_area_km2 using the DISPLAY cell
     area (the grid the routing actually runs on), and rebuild
     dam_catchments.bin (uint16 labels, damIndex+1; 0 = uncontrolled).

flowdir.bin : int8, interleaved (dx,dy) per cell, each in {-1,0,1}
flowacc.bin : uint32, upstream cell count per display cell
grid index  : py * W + px
"""
import json, os, sys
import numpy as np
from collections import deque

REGIONS = ['makkah_jeddah_taif', 'eastern_province', 'riyadh', 'asir_abha']
BASE = os.path.join(os.path.dirname(__file__), 'data', 'regions')

# 8-neighbour offsets
NB = [(-1,-1),(0,-1),(1,-1),(-1,0),(1,0),(-1,1),(0,1),(1,1)]


def load_region(region):
    rdir = os.path.join(BASE, region)
    meta = json.load(open(os.path.join(rdir, 'metadata.json')))
    W, H = meta['width'], meta['height']
    fd = np.fromfile(os.path.join(rdir, 'flowdir.bin'), dtype=np.int8).reshape(H, W, 2)
    dx = fd[:, :, 0].astype(np.int32)
    dy = fd[:, :, 1].astype(np.int32)
    fa = np.fromfile(os.path.join(rdir, 'flowacc.bin'), dtype=np.uint32).reshape(H, W)
    dams = json.load(open(os.path.join(rdir, 'dams.geojson')))
    # True display cell area (km2): region width(km)/W * height(km)/H
    cell_w_m = meta['area_km']['width'] * 1000.0 / W
    cell_h_m = meta['area_km']['height'] * 1000.0 / H
    cell_area_km2 = (cell_w_m * cell_h_m) / 1e6
    return rdir, meta, W, H, dx, dy, fa, dams, cell_area_km2


def px_py_from_feature(p, geom, meta, W, H):
    """Mirror app.js: use baked px/py if present, else derive from lon/lat."""
    b = meta['bounds']
    lon, lat = geom['coordinates'][0], geom['coordinates'][1]
    if p.get('px') is not None:
        px = int(round(p['px']))
    else:
        px = int(round((lon - b['lon_min']) / (b['lon_max'] - b['lon_min']) * W))
    if p.get('py') is not None:
        py = int(round(p['py']))
    else:
        py = int(round((b['lat_max'] - lat) / (b['lat_max'] - b['lat_min']) * H))
    return max(0, min(W - 1, px)), max(0, min(H - 1, py))


def snap_to_channel(px, py, fa, W, H, radius):
    """Move to the max-flowacc cell within a square window of given radius."""
    x0, x1 = max(0, px - radius), min(W, px + radius + 1)
    y0, y1 = max(0, py - radius), min(H, py + radius + 1)
    sub = fa[y0:y1, x0:x1]
    iy, ix = np.unravel_index(np.argmax(sub), sub.shape)
    return x0 + ix, y0 + iy


def delineate(outx, outy, dx, dy, W, H):
    """Reverse-D8 flood fill: all cells draining to (outx,outy)."""
    mask = np.zeros((H, W), dtype=bool)
    q = deque([(outx, outy)])
    mask[outy, outx] = True
    while q:
        cx, cy = q.popleft()
        for ox, oy in NB:
            nx, ny = cx + ox, cy + oy
            if nx < 0 or nx >= W or ny < 0 or ny >= H:
                continue
            if mask[ny, nx]:
                continue
            # neighbour drains INTO current cell?
            if cx == nx + dx[ny, nx] and cy == ny + dy[ny, nx]:
                mask[ny, nx] = True
                q.append((nx, ny))
    return mask


def snap_radius_for(p, W):
    """Bounded window: larger capacity dams sit on larger channels -> wider search.
    Capped so we never cross a wadi divide into a neighbouring basin."""
    mcm = p.get('capacity_mcm') or 0
    if mcm >= 50:   r = 12
    elif mcm >= 10: r = 9
    elif mcm >= 1:  r = 6
    else:           r = 4
    return min(r, max(6, W // 200))  # absolute cap relative to grid size


def process(region, write=True):
    rdir, meta, W, H, dx, dy, fa, dams, cell_area_km2 = load_region(region)
    labels = np.zeros((H, W), dtype=np.uint16)
    rows = []
    for idx, feat in enumerate(dams['features']):
        p = feat['properties']
        px, py = px_py_from_feature(p, feat['geometry'], meta, W, H)
        radius = snap_radius_for(p, W)
        sx, sy = snap_to_channel(px, py, fa, W, H, radius)
        snap_acc = int(fa[sy, sx])
        mask = delineate(sx, sy, dx, dy, W, H)
        cells = int(mask.sum())
        area_km2 = round(cells * cell_area_km2, 3)
        labels[mask] = idx + 1  # damIndex+1; later dams overwrite on overlap

        old_area = p.get('catchment_area_km2')
        p['px'], p['py'] = int(sx), int(sy)
        p['snap_acc'] = snap_acc
        p['outlet_acc'] = snap_acc           # snapped cell IS the outlet now
        p['catchment_cells'] = cells
        p['catchment_cells_display'] = cells
        p['catchment_area_km2'] = area_km2
        rows.append((p.get('name_en', f'dam{idx}'), snap_acc, cells, area_km2, old_area,
                     p.get('capacity_mcm')))

    if write:
        json.dump(dams, open(os.path.join(rdir, 'dams.geojson'), 'w'),
                  ensure_ascii=False, indent=1)
        labels.tofile(os.path.join(rdir, 'dam_catchments.bin'))
        meta['has_catchments'] = True
        # record the corrected display cell area for transparency
        meta.setdefault('catchment', {})
        meta['catchment']['method'] = 'D8 reverse-fill from max-flowacc snap'
        meta['catchment']['cell_area_km2'] = round(cell_area_km2, 6)
        json.dump(meta, open(os.path.join(rdir, 'metadata.json'), 'w'),
                  ensure_ascii=False, indent=1)
    return region, cell_area_km2, rows


if __name__ == '__main__':
    only = sys.argv[1] if len(sys.argv) > 1 else None
    targets = [only] if only else REGIONS
    for reg in targets:
        region, ca, rows = process(reg, write=True)
        print(f'\n=== {region}  (display cell area = {ca*1e6:.0f} m2 = {ca:.5f} km2) ===')
        print(f'{"dam":32s} {"snap_acc":>9s} {"cells":>7s} {"area_km2":>9s} {"old_area":>9s} {"cap_mcm":>8s}')
        for name, sa, cells, area, old, cap in rows:
            flag = '  <-- was tiny' if (old is not None and old < 0.3*area) else ''
            old_s = f'{old:9.2f}' if old is not None else '     None'
            cap_s = f'{cap:8.1f}' if cap is not None else '    None'
            print(f'{name[:32]:32s} {sa:9d} {cells:7d} {area:9.2f} {old_s} {cap_s}{flag}')
