"""Synthetic rain slots (xrain_tiles.py output format) and a low-lying-area GeoJSON for the sample viewer data.

rain/rain_20240821_HHMM.tif (GeoTIFF, float32 mm/h, nodata -1) for 12:00-23:45 over the synthetic
grid; a rain cell drifts across the centre and peaks in the flood window (17:00-19:45) used by
make_synthetic.py. Same layout as xrain_to_geotiff.py; the viewer colours the values.
"""
import json, sys
from pathlib import Path
import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "probe"))
from xrain_to_geotiff import write_geotiff, NODATA  # noqa: E402

OUT = Path(__file__).parent / "output"
RAIN = OUT / "rain"; RAIN.mkdir(exist_ok=True)
W, S, E, N = 139.70, 35.65, 139.80, 35.71          # synthetic network extent (make_synthetic.py: 40 x 30 cells)
NX, NY = 160, 96                                    # 250 m-like cells
DATES = ["20240821"] * 24 + ["20240822"] * 24     # the axis crosses midnight after 23:45
times = [f"{((18 * 60 + 15 * i) // 60) % 24:02d}:{(18 * 60 + 15 * i) % 60:02d}" for i in range(48)]   # 18:00 ... 23:45, 00:00 ... 05:45
xs = (np.arange(NX) + 0.5) / NX; ys = (np.arange(NY) + 0.5) / NY
X, Y = np.meshgrid(xs, ys)
index = {"unit": "mm/h (mean over the slot)", "nodata": NODATA, "bounds": [W, S, E, N], "width": NX, "height": NY, "slot_min": 15, "files": []}

# ---- grid/<param>_<HHMM>.tif: flag rasters like probe_trips.py (+1 / -1 / 0, nodata -99) on a coarser 100 m-ish mesh ----
GRID = OUT / "grid"; GRID.mkdir(exist_ok=True)
GX, GY = 80, 60
gdx, gdy = (E - W) / GX, (N - S) / GY
gfiles = []
rng = np.random.default_rng(3)
for ti, tm in enumerate(times):
    for param in ("walkers", "walk_dist_m", "stays", "turns", "modechanges"):
        a = np.full((GY, GX), -99.0, dtype=np.float32)
        yy, xx = np.mgrid[0:GY, 0:GX]
        has = rng.random((GY, GX)) < 0.35
        a[has] = 0.0
        if 20 <= ti < 32:                                    # flood window: increase around the centre, decrease south of it
            cx, cy = GX * 0.5, GY * 0.5; r = np.hypot(xx - cx, (yy - cy) * 1.3)
            a[(r < 10) & has] = 1.0
            a[(r >= 10) & (r < 18) & (yy > cy) & has] = -1.0
        name = f"{param}_{tm.replace(':', '')}.tif"
        write_geotiff(GRID / name, a, W, N, gdx, gdy, nodata=-99.0)
        gfiles.append(name)
json.dump({"cell_m": 100.0, "bounds": [W, S, E, N], "width": GX, "height": GY, "dx": gdx, "dy": gdy, "nodata": -99.0,
           "params": ["walkers", "walk_dist_m", "stays", "turns", "modechanges"], "slots": times, "roles": ["baseline", "event"],
           "flag": {"up": 2.0, "down": 0.5, "min_count": 0}, "files": gfiles}, open(GRID / "index.json", "w"), indent=1)
print(f"grid/: {len(gfiles)} flag rasters")
DATE = None
for i, tm in enumerate(times):
    DATE = DATES[i]
    # cell centre drifts from west to east; intensity peaks around 18:30 (i = 26)
    cx, cy = 0.2 + 0.6 * i / 47, 0.5 + 0.15 * np.sin(i / 6)
    peak = 90 * np.exp(-((i - 26) / 7) ** 2) + 3
    mean = peak * np.exp(-(((X - cx) / 0.18) ** 2 + ((Y - cy) / 0.22) ** 2))
    mean[mean < 0.3] = 0
    arr = mean.astype(np.float32)
    arr[:, :4] = NODATA                              # a no-data stripe on the west edge
    name = f"rain_{DATE}_{tm.replace(':', '')}.tif"
    write_geotiff(RAIN / name, arr, W, N, (E - W) / NX, (N - S) / NY)
    index["files"].append({"file": name, "date": DATE, "time": tm, "minutes": 15, "max": round(float(mean.max()), 1)})
json.dump(index, open(RAIN / "index.json", "w"), indent=1)
print(f"rain/: {len(times)} GeoTIFFs, peak {max(f['max'] for f in index['files'])} mm/h")

# low-lying areas: two polygons near the flood centre
def rect(x0, y0, x1, y1):
    return [[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]]
lowland = {"type": "FeatureCollection", "features": [
    {"type": "Feature", "properties": {"name": "低位地帯 A", "elev_m": 1.2}, "geometry": {"type": "Polygon", "coordinates": [rect(139.745, 35.672, 139.762, 35.684)]}},
    {"type": "Feature", "properties": {"name": "低位地帯 B", "elev_m": 0.8}, "geometry": {"type": "Polygon", "coordinates": [rect(139.728, 35.660, 139.741, 35.669)]}},
]}
json.dump(lowland, open(OUT / "lowland.geojson", "w"), ensure_ascii=False)
print("lowland.geojson: 2 polygons")
