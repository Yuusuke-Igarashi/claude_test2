"""Synthetic rain slots (xrain_tiles.py output format) and a low-lying-area GeoJSON for the sample viewer data.

rain/rain_20240821_HHMM.png for 12:00-23:45 over the synthetic grid; a rain cell drifts across the
centre and peaks in the flood window (17:00-19:45) used by make_synthetic.py. Values are encoded
like xrain_tiles.py (R,G = mm/h * 10, A = data mask); the viewer colours them.
"""
import json, sys
from pathlib import Path
import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "probe"))
from xrain_tiles import write_png, encode_values  # noqa: E402

OUT = Path(__file__).parent / "output"
RAIN = OUT / "rain"; RAIN.mkdir(exist_ok=True)
W, S, E, N = 139.70, 35.65, 139.80, 35.71          # synthetic network extent (make_synthetic.py: 40 x 30 cells)
NX, NY = 160, 96                                    # 250 m-like cells
DATE = "20240821"
times = [f"{12 + i // 4:02d}:{(i % 4) * 15:02d}" for i in range(48)]
xs = (np.arange(NX) + 0.5) / NX; ys = (np.arange(NY) + 0.5) / NY
X, Y = np.meshgrid(xs, ys)
index = {"bounds": [W, S, E, N], "width": NX, "height": NY, "cell_deg": [(E - W) / NX, (N - S) / NY], "slot_min": 15,
         "unit": "mm/h (mean over the slot); value = (R*256+G)/10; A=0 no data", "row_order_in_csv": "north_to_south",
         "meshes": ["synthetic"], "dates": {DATE: []}, "files": {}}
for i, tm in enumerate(times):
    # cell centre drifts from west to east; intensity peaks around 18:30 (i = 26)
    cx, cy = 0.2 + 0.6 * i / 47, 0.5 + 0.15 * np.sin(i / 6)
    peak = 90 * np.exp(-((i - 26) / 7) ** 2) + 3
    mean = peak * np.exp(-(((X - cx) / 0.18) ** 2 + ((Y - cy) / 0.22) ** 2))
    mean[mean < 0.3] = 0
    cnt = np.full(mean.shape, 15, dtype=np.int32)
    cnt[:, :4] = 0                                   # a no-data stripe on the west edge
    name = f"rain_{DATE}_{tm.replace(':', '')}.png"
    write_png(RAIN / name, encode_values(mean, cnt))
    index["dates"][DATE].append(tm)
    index["files"][name] = {"minutes": 15, "max_mmh": round(float(mean.max()), 1), "wet_cells": int((mean >= 1).sum())}
json.dump(index, open(RAIN / "index.json", "w"), indent=1)
print(f"rain/: {len(times)} slot images, peak {max(f['max_mmh'] for f in index['files'].values())} mm/h")

# low-lying areas: two polygons near the flood centre
def rect(x0, y0, x1, y1):
    return [[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]]
lowland = {"type": "FeatureCollection", "features": [
    {"type": "Feature", "properties": {"name": "低位地帯 A", "elev_m": 1.2}, "geometry": {"type": "Polygon", "coordinates": [rect(139.745, 35.672, 139.762, 35.684)]}},
    {"type": "Feature", "properties": {"name": "低位地帯 B", "elev_m": 0.8}, "geometry": {"type": "Polygon", "coordinates": [rect(139.728, 35.660, 139.741, 35.669)]}},
]}
json.dump(lowland, open(OUT / "lowland.geojson", "w"), ensure_ascii=False)
print("lowland.geojson: 2 polygons")
