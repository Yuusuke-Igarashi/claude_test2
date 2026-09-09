"""Synthetic trajectory / dwell GeoJSON files for the viewer (sample format).

Produces 4 files in ./data:
  baseline_trajectory.geojson, event_trajectory.geojson  (LineString per link id x time)
  baseline_dwell.geojson,      event_dwell.geojson       (MultiPoint per link id x time)

Feature properties:
  id     : link id (string, matches network.geojson / CSV id)
  time   : "HH:MM" end of the 1-hour window (matches CSV header)
  n_probes (trajectory) / n_points (dwell) : sample attributes, shown in the tooltip

Relies on the grid built by make_synthetic.py (same geometry rules).
"""
import json, math, random
from pathlib import Path

OUT = Path(__file__).parent / "output"
random.seed(7)

net = json.load(open(OUT / "tokyo_20240821_network.geojson"))
times = [f"{12 + i // 4:02d}:{(i % 4) * 15:02d}" for i in range(48)]
lon0, lat0, dlon, dlat = 139.70, 35.65, 0.0025, 0.002
center = (lon0 + 20 * dlon, lat0 + 15 * dlat)
FLOOD_T = range(20, 32)          # 17:00 .. 19:45 (event window used by make_synthetic.py)
RADIUS = 0.012                   # links within this distance of the center get trajectories

def node_of(c):
    return (round((c[0] - lon0) / dlon), round((c[1] - lat0) / dlat))
def coord(n):
    return [lon0 + n[0] * dlon, lat0 + n[1] * dlat]
def jitter(c, m=2e-5):
    return [round(c[0] + random.uniform(-m, m), 6), round(c[1] + random.uniform(-m, m), 6)]

def walk(start, prev, steps):
    """random walk on the grid without immediate backtracking"""
    path, cur = [], start
    for _ in range(steps):
        cands = [(cur[0] + 1, cur[1]), (cur[0] - 1, cur[1]), (cur[0], cur[1] + 1), (cur[0], cur[1] - 1)]
        cands = [c for c in cands if 0 <= c[0] <= 39 and 0 <= c[1] <= 29 and c != prev]
        if not cands: break
        prev, cur = cur, random.choice(cands)
        path.append(cur)
    return path

def densify(nodes, step_m=60):
    """interpolate points along node path (~step_m metres), with GPS-like jitter"""
    pts = []
    for a, b in zip(nodes[:-1], nodes[1:]):
        ca, cb = coord(a), coord(b)
        L = math.hypot((cb[0] - ca[0]) * 91000, (cb[1] - ca[1]) * 111000)
        k = max(1, int(L / step_m))
        for i in range(k):
            f = i / k
            pts.append(jitter([ca[0] + (cb[0] - ca[0]) * f, ca[1] + (cb[1] - ca[1]) * f]))
    pts.append(jitter(coord(nodes[-1])))
    return pts

traj = {"b": [], "e": []}
dwell = {"b": [], "e": []}
selected = 0
for ft in net["features"]:
    c = ft["geometry"]["coordinates"]
    if ft["properties"].get("pair_id") is None or len(c) != 2:
        continue
    mid = ((c[0][0] + c[1][0]) / 2, (c[0][1] + c[1][1]) / 2)
    if math.hypot(mid[0] - center[0], mid[1] - center[1]) > RADIUS:
        continue
    A, B = node_of(c[0]), node_of(c[1])
    if A == B: continue
    selected += 1
    lid = ft["properties"]["id"]
    for ti, tm in enumerate(times):
        for kind in ("b", "e"):
            flooded = kind == "e" and ti in FLOOD_T
            # in the flood window vehicles cover much less distance in the hour
            back = random.randint(1, 3) if flooded else random.randint(3, 8)
            fwd = random.randint(0, 2) if flooded else random.randint(3, 8)
            nodes = list(reversed(walk(A, B, back))) + [A, B] + walk(B, A, fwd)
            pts = densify(nodes)
            traj[kind].append({"type": "Feature",
                               "properties": {"id": lid, "time": tm, "n_probes": random.randint(1, 6)},
                               "geometry": {"type": "LineString", "coordinates": pts}})
            # dwell points: many near the link when flooded, occasionally at intersections otherwise
            dp = []
            if flooded:
                for _ in range(random.randint(3, 8)):
                    f = random.random()
                    dp.append(jitter([c[0][0] + (c[1][0] - c[0][0]) * f, c[0][1] + (c[1][1] - c[0][1]) * f], 4e-5))
            elif random.random() < 0.25:
                dp.append(jitter(coord(random.choice([A, B])), 3e-5))
            if dp:
                dwell[kind].append({"type": "Feature",
                                    "properties": {"id": lid, "time": tm, "n_points": len(dp)},
                                    "geometry": {"type": "MultiPoint", "coordinates": dp}})

def save(feats, name):
    with open(OUT / name, "w") as f:
        json.dump({"type": "FeatureCollection", "features": feats}, f, separators=(",", ":"))
    print(f"{name}: {len(feats)} features, {(OUT / name).stat().st_size / 1e6:.1f} MB")

save(traj["b"], "baseline_trajectory.geojson")
save(traj["e"], "event_trajectory.geojson")
save(dwell["b"], "baseline_dwell.geojson")
save(dwell["e"], "event_dwell.geojson")
print("links with trajectories:", selected)
