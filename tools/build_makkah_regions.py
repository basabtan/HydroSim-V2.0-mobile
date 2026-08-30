#!/usr/bin/env python3
"""Build the 30 m Makkah and Wadi Ibrahim HydroSim regions.

The authoritative Kingdom-scale rasters remain in Supabase Storage. GDAL reads
only the tiles intersecting the calculation window via HTTP byte ranges. The
script reprojects those tiles to UTM 37N, reconditions the projected DEM,
recomputes D8 direction/accumulation, and reverse-delineates both outlets.

Run from the repository root:
    python tools/build_makkah_regions.py
"""
from __future__ import annotations

import json
import math
import os
import urllib.parse
import urllib.request
from collections import deque
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

os.environ.setdefault("GDAL_DISABLE_READDIR_ON_OPEN", "EMPTY_DIR")
os.environ.setdefault("CPL_VSIL_CURL_ALLOWED_EXTENSIONS", ".tif")
os.environ.setdefault("GDAL_HTTP_MULTIRANGE", "YES")
os.environ.setdefault("VSI_CACHE", "TRUE")

import numpy as np
import pyflwdir
import rasterio
from pyproj import Transformer
from rasterio.features import shapes
from rasterio.transform import array_bounds, from_origin, rowcol, xy
from rasterio.warp import Resampling, reproject, transform_bounds, transform_geom
from shapely.geometry import LineString, mapping, shape
from shapely.ops import unary_union

ROOT = Path(__file__).resolve().parents[1]
REGION_ROOT = ROOT / "data" / "regions"
CACHE = Path(__file__).resolve().parent / ".cache"
CACHE.mkdir(exist_ok=True)

PROJECT_REF = "eyojwcoupcebawhgvoyv"
STORAGE_BASE = (
    f"https://{PROJECT_REF}.supabase.co/storage/v1/object/public/flood-rasters"
)
RASTERS = {
    "dem": f"{STORAGE_BASE}/sinkfilled_dem.tif",
    "dtm": f"{STORAGE_BASE}/dtm.tif",
    "slope": f"{STORAGE_BASE}/slope.tif",
    "twi": f"{STORAGE_BASE}/twi.tif",
}

SRC_CRS = "EPSG:4326"
DST_CRS = "EPSG:32637"
CELL_M = 30.0
D8_XY = {
    64: (0, -1), 128: (1, -1), 1: (1, 0), 2: (1, 1),
    4: (0, 1), 8: (-1, 1), 16: (-1, 0), 32: (-1, -1),
}

# This window encloses the complete coarse-grid versions of both basins plus a
# divide margin. It is only a calculation window; final products are cropped to
# the reverse-D8 basin masks, so its edges are not study boundaries.
CALC_BOUNDS_WGS84 = (39.54, 21.31, 39.99, 21.63)

# Candidate outlets are transferred from the existing parent regional D8 grid.
# They are snapped to the highest-accumulation 30 m cell in a tightly bounded
# local window, then the basin is independently reverse-delineated.
OUTLETS = {
    "wadi_ibrahim": {
        "name": "Wadi Ibrahim watershed",
        "candidate_lonlat": (39.795465, 21.438581),
        "snap_radius_m": 150,
        "validation_area_km2": [111, 115],
        "reason": "Western urban outlet before Wadi Ibrahim joins downstream tributaries",
    },
    "makkah": {
        "name": "Makkah contributing hydrologic unit",
        "candidate_lonlat": (39.539856, 21.429734),
        "snap_radius_m": 0,
        "validation_area_km2": None,
        "reason": "Last Wadi Ibrahim receiving-channel cell before the major Wadi Uranah confluence (accumulation jumps from about 371 to 912 km2)",
    },
}

TO_UTM = Transformer.from_crs(SRC_CRS, DST_CRS, always_xy=True)
TO_WGS84 = Transformer.from_crs(DST_CRS, SRC_CRS, always_xy=True)


def aligned_grid(bounds_wgs84: tuple[float, float, float, float]):
    left, bottom, right, top = transform_bounds(
        SRC_CRS, DST_CRS, *bounds_wgs84, densify_pts=21
    )
    left = math.floor(left / CELL_M) * CELL_M
    bottom = math.floor(bottom / CELL_M) * CELL_M
    right = math.ceil(right / CELL_M) * CELL_M
    top = math.ceil(top / CELL_M) * CELL_M
    width = int(round((right - left) / CELL_M))
    height = int(round((top - bottom) / CELL_M))
    return from_origin(left, top, CELL_M, CELL_M), width, height


def read_projected(url: str, transform, width: int, height: int, resampling):
    cache_path = CACHE / f"{Path(url).stem}_{width}x{height}_epsg32637_30m.npy"
    if cache_path.exists():
        print(f"Reading cached source window: {cache_path.name}", flush=True)
        return np.load(cache_path)
    print(f"Reading source window: {Path(url).name}", flush=True)
    out = np.full((height, width), np.nan, dtype=np.float32)
    with rasterio.open(f"/vsicurl/{url}", sharing=False) as src:
        reproject(
            source=rasterio.band(src, 1),
            destination=out,
            src_transform=src.transform,
            src_crs=src.crs,
            src_nodata=src.nodata,
            dst_transform=transform,
            dst_crs=DST_CRS,
            dst_nodata=np.nan,
            resampling=resampling,
            num_threads=2,
        )
    np.save(cache_path, out)
    return out


def hydrology(dem: np.ndarray, transform):
    """Condition the projected grid and compute D8 direction + accumulation."""
    valid = np.isfinite(dem)
    nodata = -99999.0
    work = np.where(valid, dem, nodata).astype(np.float32)
    print("Conditioning projected DEM and deriving D8 directions", flush=True)
    # Wang & Liu priority-flood implementation. It assigns flats while filling,
    # avoiding residual sinks on quantized valley terraces.
    conditioned, fdir = pyflwdir.dem.fill_depressions(
        work, outlets="edge", nodata=nodata, max_depth=-1.0, connectivity=8
    )
    flw = pyflwdir.from_array(
        fdir, ftype="d8", transform=transform, latlon=False
    )
    print("Computing D8 flow accumulation", flush=True)
    acc = flw.upstream_area(unit="cell")
    conditioned = np.asarray(conditioned, dtype=np.float32)
    fdir = np.asarray(fdir, dtype=np.uint8)
    acc = np.asarray(acc, dtype=np.uint32)
    conditioned[~valid] = np.nan
    fdir[~valid] = 0
    acc[~valid] = 0
    flowxy = np.zeros((*dem.shape, 2), dtype=np.int8)
    for code, (dx, dy) in D8_XY.items():
        hit = fdir == code
        flowxy[hit, 0] = dx
        flowxy[hit, 1] = dy
    return conditioned, flowxy, acc, valid


def snap_outlet(acc, valid, transform, lonlat, radius_m):
    ux, uy = TO_UTM.transform(*lonlat)
    cy, cx = rowcol(transform, ux, uy)
    radius = max(0, int(math.ceil(radius_m / CELL_M)))
    y0, y1 = max(0, cy - radius), min(acc.shape[0], cy + radius + 1)
    x0, x1 = max(0, cx - radius), min(acc.shape[1], cx + radius + 1)
    sub = np.where(valid[y0:y1, x0:x1], acc[y0:y1, x0:x1], 0)
    iy, ix = np.unravel_index(np.argmax(sub), sub.shape)
    return x0 + int(ix), y0 + int(iy)


def delineate(outx: int, outy: int, flowxy: np.ndarray):
    """Reverse-D8 traversal: every cell whose vector eventually reaches outlet."""
    height, width = flowxy.shape[:2]
    mask = np.zeros((height, width), dtype=bool)
    q = deque([(outx, outy)])
    mask[outy, outx] = True
    while q:
        cx, cy = q.popleft()
        for oy in (-1, 0, 1):
            for ox in (-1, 0, 1):
                if ox == 0 and oy == 0:
                    continue
                nx, ny = cx + ox, cy + oy
                if not (0 <= nx < width and 0 <= ny < height) or mask[ny, nx]:
                    continue
                dx, dy = map(int, flowxy[ny, nx])
                if cx == nx + dx and cy == ny + dy:
                    mask[ny, nx] = True
                    q.append((nx, ny))
    return mask


def crop_slices(mask: np.ndarray, pad=2):
    ys, xs = np.where(mask)
    y0 = max(0, int(ys.min()) - pad)
    y1 = min(mask.shape[0], int(ys.max()) + pad + 1)
    x0 = max(0, int(xs.min()) - pad)
    x1 = min(mask.shape[1], int(xs.max()) + pad + 1)
    return slice(y0, y1), slice(x0, x1)


def shifted_transform(transform, ys: slice, xs: slice):
    return rasterio.Affine(
        transform.a, transform.b, transform.c + xs.start * transform.a,
        transform.d, transform.e, transform.f + ys.start * transform.e,
    )


def polygon_from_mask(mask: np.ndarray, transform, simplify_m=45):
    geoms = [shape(g) for g, value in shapes(
        mask.astype(np.uint8), mask=mask, transform=transform
    ) if value == 1]
    geom = unary_union(geoms).buffer(0).simplify(simplify_m, preserve_topology=True)
    return transform_geom(DST_CRS, SRC_CRS, mapping(geom), precision=7)


def percentile_rank(array: np.ndarray, mask: np.ndarray):
    result = np.full(array.shape, np.nan, dtype=np.float32)
    valid = mask & np.isfinite(array)
    vals = array[valid]
    if vals.size == 0:
        return result
    order = np.argsort(vals, kind="mergesort")
    ranks = np.empty(vals.size, dtype=np.float32)
    ranks[order] = np.linspace(0.0, 1.0, vals.size, dtype=np.float32)
    result[valid] = ranks
    return result


def channel_geojson(mask, flowxy, acc, transform, min_area_km2=0.25, major_km2=5.0):
    cell_area_km2 = CELL_M * CELL_M / 1e6
    channel = mask & (acc * cell_area_km2 >= min_area_km2)
    height, width = channel.shape
    indegree = np.zeros(channel.shape, dtype=np.uint8)
    ys, xs = np.where(channel)
    for y, x in zip(ys.tolist(), xs.tolist()):
        dx, dy = map(int, flowxy[y, x])
        nx, ny = x + dx, y + dy
        if (dx or dy) and 0 <= nx < width and 0 <= ny < height and channel[ny, nx]:
            indegree[ny, nx] = min(255, indegree[ny, nx] + 1)
    starts = list(zip(*np.where(channel & (indegree != 1))))
    visited = set()
    features = []

    def trace(y, x):
        coords = []
        max_acc = 0
        while channel[y, x]:
            edge = y * width + x
            if edge in visited:
                break
            visited.add(edge)
            ux, uy = xy(transform, y, x, offset="center")
            coords.append((ux, uy))
            max_acc = max(max_acc, int(acc[y, x]))
            dx, dy = map(int, flowxy[y, x])
            nx, ny = x + dx, y + dy
            if not (dx or dy) or not (0 <= nx < width and 0 <= ny < height) or not channel[ny, nx]:
                break
            x, y = nx, ny
            if indegree[y, x] != 1:
                ux, uy = xy(transform, y, x, offset="center")
                coords.append((ux, uy))
                break
        return coords, max_acc

    for y, x in starts:
        coords, max_acc = trace(int(y), int(x))
        if len(coords) < 2:
            continue
        line = LineString(coords).simplify(CELL_M, preserve_topology=False)
        ll = [TO_WGS84.transform(x, y) for x, y in line.coords]
        area = max_acc * cell_area_km2
        features.append({
            "type": "Feature",
            "properties": {
                "channel_class": "major" if area >= major_km2 else "drainage",
                "upstream_area_km2": round(area, 3),
                "source": "HydroSim D8 flow accumulation",
            },
            "geometry": {"type": "LineString", "coordinates": ll},
        })
    return {
        "type": "FeatureCollection",
        "properties": {
            "source": "Derived from authoritative sink-filled DEM",
            "minimum_upstream_area_km2": min_area_km2,
            "major_channel_threshold_km2": major_km2,
        },
        "features": features,
    }


def admin_boundary_geojson():
    cache = CACHE / "makkah_admin_relation_12429517.json"
    if not cache.exists():
        params = urllib.parse.urlencode({
            "format": "jsonv2", "osm_ids": "R12429517", "polygon_geojson": 1,
        })
        req = urllib.request.Request(
            f"https://nominatim.openstreetmap.org/lookup?{params}",
            headers={"User-Agent": "HydroSim-2.0"},
        )
        cache.write_bytes(urllib.request.urlopen(req, timeout=60).read())
    rows = json.loads(cache.read_text(encoding="utf-8"))
    geom = shape(rows[0]["geojson"]).simplify(0.001, preserve_topology=True)
    return {
        "type": "FeatureCollection",
        "properties": {
            "source": "OpenStreetMap relation 12429517",
            "retrieved_via": "Nominatim",
            "role": "reference overlay only; never used as a hydrologic mask",
        },
        "features": [{
            "type": "Feature",
            "properties": {
                "name": "Makkah Al Mukarramah Governorate",
                "source": "OpenStreetMap relation 12429517",
                "status": "administrative_reference",
            },
            "geometry": mapping(geom),
        }],
    }


def empty_lineaments():
    return {
        "type": "FeatureCollection",
        "properties": {
            "status": "no_reliably_georeferenced_vector_features_available",
            "mapped_sources_reviewed": [
                "GM-107C Makkah, 1:250,000 (Supabase Maps; WEBP/JPEG only)",
                "GM-96C Jibal Ibrahim, 1:250,000 (Supabase Maps; WEBP/JPEG only)",
            ],
            "note": (
                "Stored browse images have no raster transform or companion vector data. "
                "No faults were guessed from screenshots, and no remote-derived or inferred "
                "features are published by this build."
            ),
            "allowed_status_values": ["mapped", "remote_derived", "inferred"],
        },
        "features": [],
    }


def write_json(path: Path, value):
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def write_region(
    key, spec, mask, outlet_xy, transform, conditioned, dtm, slope, twi,
    flowxy, acc, wadi_geom, admin_fc,
):
    ys, xs = crop_slices(mask)
    out_transform = shifted_transform(transform, ys, xs)
    local_mask = mask[ys, xs]
    out = REGION_ROOT / key
    out.mkdir(parents=True, exist_ok=True)

    elev_crop = conditioned[ys, xs]
    dtm_crop = dtm[ys, xs]
    slope_crop = slope[ys, xs]
    twi_crop = percentile_rank(twi[ys, xs], local_mask)
    flow_crop = flowxy[ys, xs].copy()
    acc_crop = acc[ys, xs].copy()

    elev_i16 = np.full(local_mask.shape, -32768, dtype=np.int16)
    dtm_i16 = np.full(local_mask.shape, -32768, dtype=np.int16)
    elev_i16[local_mask] = np.clip(np.rint(elev_crop[local_mask]), -32767, 32767).astype(np.int16)
    dtm_valid = local_mask & np.isfinite(dtm_crop)
    dtm_i16[dtm_valid] = np.clip(np.rint(dtm_crop[dtm_valid]), -32767, 32767).astype(np.int16)
    slope_out = np.zeros(local_mask.shape, dtype=np.float32)
    slope_valid = local_mask & np.isfinite(slope_crop)
    slope_out[slope_valid] = np.clip(slope_crop[slope_valid], 0, 90)
    twi_out = np.zeros(local_mask.shape, dtype=np.float32)
    twi_valid = local_mask & np.isfinite(twi_crop)
    twi_out[twi_valid] = twi_crop[twi_valid]
    flow_crop[~local_mask] = 0
    acc_crop[~local_mask] = 0

    elev_i16.tofile(out / "elevation.bin")
    dtm_i16.tofile(out / "dtm.bin")
    flow_crop.astype(np.int8).tofile(out / "flowdir.bin")
    acc_crop.astype(np.uint32).tofile(out / "flowacc.bin")
    slope_out.tofile(out / "slope.bin")
    twi_out.tofile(out / "twi.bin")

    study_geom = polygon_from_mask(local_mask, out_transform)
    study_fc = {
        "type": "FeatureCollection",
        "properties": {"role": "hydrologic study boundary; derived, not administrative"},
        "features": [{
            "type": "Feature",
            "properties": {
                "name": spec["name"], "boundary_type": "reverse_d8_watershed",
                "source": "HydroSim authoritative sink-filled DEM",
            },
            "geometry": study_geom,
        }],
    }
    write_json(out / "study_boundary.geojson", study_fc)
    write_json(out / "wadi_catchment.geojson", {
        "type": "FeatureCollection",
        "properties": {"role": "Wadi Ibrahim watershed reference"},
        "features": [{
            "type": "Feature",
            "properties": {
                "name": "Wadi Ibrahim watershed", "boundary_type": "reverse_d8_watershed",
                "source": "HydroSim authoritative sink-filled DEM",
            },
            "geometry": wadi_geom,
        }],
    })
    write_json(out / "drainage.geojson", channel_geojson(
        local_mask, flow_crop, acc_crop, out_transform
    ))
    write_json(out / "admin_boundary.geojson", admin_fc)
    write_json(out / "lineaments.geojson", empty_lineaments())
    write_json(out / "dams.geojson", {"type": "FeatureCollection", "features": []})

    height, width = local_mask.shape
    left, bottom, right, top = array_bounds(height, width, out_transform)
    lon_min, lat_min, lon_max, lat_max = transform_bounds(
        DST_CRS, SRC_CRS, left, bottom, right, top, densify_pts=21
    )
    ox, oy = outlet_xy
    local_outlet_x, local_outlet_y = ox - xs.start, oy - ys.start
    out_ux, out_uy = xy(transform, oy, ox, offset="center")
    out_lon, out_lat = TO_WGS84.transform(out_ux, out_uy)
    area_km2 = int(local_mask.sum()) * CELL_M * CELL_M / 1e6
    vals = elev_i16[local_mask]
    dtm_vals = dtm_i16[dtm_valid]
    meta = {
        "width": width, "height": height,
        "src_width": width, "src_height": height,
        "source_raster_resolution_m": 30,
        "processed_grid_resolution_m": 30,
        "src_resolution_m": 30,
        "grid_resolution_m": 30,
        "crs": "EPSG:32637 (UTM 37N)", "utm_epsg": 32637,
        "data_source": "Supabase flood-rasters/sinkfilled_dem.tif (authoritative Kingdom-scale sink-filled DEM)",
        "bounds": {"lon_min": lon_min, "lon_max": lon_max, "lat_min": lat_min, "lat_max": lat_max},
        "elevation": {"min": int(vals.min()), "max": int(vals.max()), "mean": round(float(vals.mean()), 1), "nodata": -32768},
        "area_km": {"width": round(width * CELL_M / 1000, 3), "height": round(height * CELL_M / 1000, 3)},
        "study_area_km2": round(area_km2, 3),
        "study_boundary_method": "Reverse-D8 traversal from locally snapped outlet; administrative boundary is reference only",
        "outlet": {
            "candidate_lon": spec["candidate_lonlat"][0], "candidate_lat": spec["candidate_lonlat"][1],
            "snapped_lon": round(out_lon, 7), "snapped_lat": round(out_lat, 7),
            "px": int(local_outlet_x), "py": int(local_outlet_y),
            "flowacc_cells": int(acc[oy, ox]), "reason": spec["reason"],
        },
        "flowacc": {
            "max": int(acc_crop.max()), "dtype": "uint32",
            "counts_grid_cells_at_resolution_m": 30,
            "channel_threshold_cells": int(math.ceil(0.25e6 / (CELL_M * CELL_M))),
            "major_channel_threshold_cells": int(math.ceil(5e6 / (CELL_M * CELL_M))),
        },
        "twi": {"dtype": "float32", "range": "0..1 percentile-rank flood susceptibility", "source": "Supabase flood-rasters/twi.tif"},
        "slope": {"dtype": "float32", "units": "degrees", "source": "Supabase flood-rasters/slope.tif"},
        "dtm": {
            "dtype": "int16", "units": "meters", "nodata": -32768,
            "min": int(dtm_vals.min()) if dtm_vals.size else None,
            "max": int(dtm_vals.max()) if dtm_vals.size else None,
            "mean": round(float(dtm_vals.mean()), 1) if dtm_vals.size else None,
            "source": "Supabase flood-rasters/dtm.tif",
        },
        "region": spec["name"], "region_key": key, "has_catchments": False,
        "validation_area_km2": spec["validation_area_km2"],
        "lineaments": {
            "mapped": 0, "remote_derived": 0, "inferred": 0,
            "note": "No un-georeferenced map lines were published as faults.",
        },
    }
    write_json(out / "metadata.json", meta)
    print(
        f"{key}: {width}x{height} at {CELL_M:.0f} m, valid area {area_km2:.3f} km2, "
        f"outlet ({out_lon:.6f}, {out_lat:.6f}), acc={int(acc[oy, ox])}",
        flush=True,
    )
    return meta, study_geom


def main():
    transform, width, height = aligned_grid(CALC_BOUNDS_WGS84)
    print(f"Calculation grid: {width}x{height} at {CELL_M:.0f} m ({width*height:,} cells)", flush=True)
    with ThreadPoolExecutor(max_workers=4) as pool:
        jobs = {
            name: pool.submit(
                read_projected, url, transform, width, height, Resampling.bilinear
            )
            for name, url in RASTERS.items()
        }
        dem, dtm, slope, twi = (jobs[name].result() for name in ("dem", "dtm", "slope", "twi"))
    conditioned, flowxy, acc, valid = hydrology(dem, transform)

    slope_sample = np.abs(slope[np.isfinite(slope)])
    if slope_sample.size and np.nanpercentile(slope_sample, 99) <= math.pi + 0.1:
        slope = np.degrees(slope)

    basin = {}
    outlet_cells = {}
    for key, spec in OUTLETS.items():
        ox, oy = snap_outlet(
            acc, valid, transform, spec["candidate_lonlat"], spec["snap_radius_m"]
        )
        outlet_cells[key] = (ox, oy)
        basin[key] = delineate(ox, oy, flowxy) & valid
        print(
            f"Delineated {key}: {basin[key].sum() * CELL_M * CELL_M / 1e6:.3f} km2",
            flush=True,
        )

    wadi_geom = polygon_from_mask(basin["wadi_ibrahim"], transform)
    admin_fc = admin_boundary_geojson()
    results = {}
    for key in ("makkah", "wadi_ibrahim"):
        meta, _ = write_region(
            key, OUTLETS[key], basin[key], outlet_cells[key], transform,
            conditioned, dtm, slope, twi, flowxy, acc, wadi_geom, admin_fc,
        )
        results[key] = meta
    print(json.dumps({k: {
        "grid": [v["width"], v["height"]],
        "area_km2": v["study_area_km2"],
        "outlet": v["outlet"],
    } for k, v in results.items()}, indent=2), flush=True)


if __name__ == "__main__":
    main()
