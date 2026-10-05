"""Synthetic output files mimicking the notebook's outputs, for viewer testing."""
import json, shutil, math, random
import numpy as np, pandas as pd
from pathlib import Path

OUT = Path(__file__).parent / "output"
OUT.mkdir(exist_ok=True)
random.seed(1); np.random.seed(1)

times = [f"{((18 * 60 + 15 * i) // 60) % 24:02d}:{(18 * 60 + 15 * i) % 60:02d}" for i in range(48)]   # 18:00 ... 23:45, 00:00 ... 05:45
T = len(times)

# grid network around Tokyo: 40 x 30 blocks, each edge as a pair of links (id, id+1)
lon0, lat0 = 139.70, 35.65
dlon, dlat = 0.0025, 0.002
features = []
ids = []
pair = {}
lid = 1
def add_pair(c0, c1):
    global lid
    # offset +/- 1 m roughly (1e-5 deg ~ 1 m)
    dx = c1[0]-c0[0]; dy = c1[1]-c0[1]; L = math.hypot(dx, dy) or 1
    nx, ny = -dy/L*1e-5, dx/L*1e-5
    a, b = lid, lid+1
    features.append({"type":"Feature","properties":{"id":str(a),"pair_id":str(b)},
                     "geometry":{"type":"LineString","coordinates":[[c0[0]+nx,c0[1]+ny],[c1[0]+nx,c1[1]+ny]]}})
    features.append({"type":"Feature","properties":{"id":str(b),"pair_id":str(a)},
                     "geometry":{"type":"LineString","coordinates":[[c0[0]-nx,c0[1]-ny],[c1[0]-nx,c1[1]-ny]]}})
    ids.extend([str(a), str(b)])
    lid += 2

for i in range(40):
    for j in range(30):
        p = (lon0 + i*dlon, lat0 + j*dlat)
        if i < 39: add_pair(p, (p[0]+dlon, p[1]))
        if j < 29: add_pair(p, (p[0], p[1]+dlat))
# a few unpaired links
for k in range(20):
    p = (lon0 + random.random()*40*dlon, lat0 + random.random()*30*dlat)
    features.append({"type":"Feature","properties":{"id":str(lid),"pair_id":None},
                     "geometry":{"type":"LineString","coordinates":[[p[0],p[1]],[p[0]+dlon*0.7,p[1]+dlat*0.4]]}})
    ids.append(str(lid)); lid += 1
# a link in network but not in CSV
features.append({"type":"Feature","properties":{"id":"999999","pair_id":None},
                 "geometry":{"type":"LineString","coordinates":[[lon0-0.002,lat0-0.002],[lon0-0.001,lat0-0.001]]}})

with open(OUT/"tokyo_20240821_network.geojson","w") as f:
    json.dump({"type":"FeatureCollection","features":features}, f)

N = len(ids)
diurnal = 1 + 0.4*np.sin(np.linspace(0, math.pi, T))
bs = np.random.uniform(10, 60, N)[:,None] * np.ones((1,T)) * (1 + 0.05*np.random.randn(N,T))
bc = np.random.uniform(0.5, 60, N)[:,None] * diurnal[None,:] * (1 + 0.1*np.random.randn(N,T))
es = bs * (1 + 0.1*np.random.randn(N,T))
ec = bc * (1 + 0.2*np.random.randn(N,T))
# flood event: block of links near center drop from 17:00 (index 20) to 20:00 (index 32)
center = np.array([lon0+20*dlon, lat0+15*dlat])
for r, ft in enumerate(features[:N]):
    c = np.array(ft["geometry"]["coordinates"][0])
    d = np.hypot(*(c-center))
    if d < 0.02:
        es[r, 20:32] *= 0.3; ec[r, 20:32] *= 0.05
# missing data rows
for r in random.sample(range(N), 30):
    bs[r,:] = np.nan; bc[r,:] = np.nan; es[r,:] = np.nan; ec[r,:] = np.nan
ec = np.where(np.isnan(ec), np.nan, np.maximum(ec, 0))

# ---- error.csv with the notebook's multi-level logic (independent reference for the viewer's in-page computation) ----
#   level k (1..3): is_target AND (speed_ratio <= s_k OR count_ratio <= c_k), confirmed when the pair link (same time)
#   or the same link (t±1) also reaches level k. error_level = highest confirmed level. Levels are nested.
MIN_BASE_COUNT, MIN_BASE_SPEED = 2.5, 10.0
LEVELS = [(0.75, 0.75), (0.60, 0.60), (0.50, 0.50)]          # (speed, count) ratio thresholds of level 1, 2, 3
with np.errstate(invalid="ignore", divide="ignore"):
    speed_ratio = np.where(bs > 0, es / bs, np.nan)
    count_ratio = np.where(bc > 0, ec / bc, np.nan)
    is_target = (bc >= MIN_BASE_COUNT) & (bs >= MIN_BASE_SPEED)
    e1 = np.zeros((N, T), dtype=int)
    for k, (s, c) in enumerate(LEVELS, 1):
        e1 = np.where(is_target & ((speed_ratio <= s) | (count_ratio <= c)), k, e1)
row_of = {lid: r for r, lid in enumerate(ids)}
pair_row = np.full(N, -1)
for r, ft in enumerate(features[:N]):
    pid = ft["properties"].get("pair_id")
    if pid is not None and pid in row_of: pair_row[r] = row_of[pid]
pair_lv = np.zeros_like(e1); has_pair = pair_row >= 0; pair_lv[has_pair] = e1[pair_row[has_pair]]
prev_lv = np.zeros_like(e1); prev_lv[:, 1:] = e1[:, :-1]
next_lv = np.zeros_like(e1); next_lv[:, :-1] = e1[:, 1:]
err = np.minimum(e1, np.maximum.reduce([pair_lv, prev_lv, next_lv]))

def save(arr, name, rows=None, integer=False):
    df = pd.DataFrame(arr, index=pd.Index(ids, name="id"), columns=times)
    if rows is not None: df = df[rows]
    if integer: df = df.fillna(0).astype(int)
    df.to_csv(OUT/name)

save(bs, "baseline_speed.csv"); save(es, "event_speed.csv")
save(bc, "baseline_count.csv"); save(ec, "event_count.csv")
# error.csv: only links with an error, values = level 0..3; error_level{k}.csv: links whose highest level is k
link_level = err.max(axis=1)
save(err, "error.csv", rows=link_level >= 1, integer=True)
for k in (1, 2, 3):
    save(err, f"error_level{k}.csv", rows=link_level == k, integer=True)
# ---- truck/: network_agg.shp/.shx/.dbf/.prj (aggregated links) + traffic_YYYYMMDD_HHMM.csv per window (truck_traffic.ipynb output) ----
# baseline 2024-08-14/15, event 2024-08-21/22 (the sample period runs 18:00 -> 05:45 across midnight); Id = the network link id
import struct
TR = OUT / "truck"; TR.mkdir(exist_ok=True)
for old in TR.glob("*"):
    if old.is_dir(): shutil.rmtree(old)
    else: old.unlink()

def write_shapefile(stem, lines, ids, lengths):
    recs, shx = b"", b""; xmin = ymin = 1e9; xmax = ymax = -1e9
    for k, coords in enumerate(lines, 1):
        xs = [c[0] for c in coords]; ys = [c[1] for c in coords]
        box = (min(xs), min(ys), max(xs), max(ys)); xmin, ymin, xmax, ymax = min(xmin, box[0]), min(ymin, box[1]), max(xmax, box[2]), max(ymax, box[3])
        content = struct.pack("<i4d2ii", 3, *box, 1, len(coords), 0) + b"".join(struct.pack("<2d", x, y) for x, y in coords)
        shx += struct.pack(">2i", (100 + len(recs)) // 2, len(content) // 2)
        recs += struct.pack(">2i", k, len(content) // 2) + content
    def header(nbytes): return struct.pack(">6i", 9994, 0, 0, 0, 0, 0) + struct.pack(">i", nbytes // 2) + struct.pack("<2i", 1000, 3) + struct.pack("<8d", xmin, ymin, xmax, ymax, 0, 0, 0, 0)
    open(f"{stem}.shp", "wb").write(header(100 + len(recs)) + recs)
    open(f"{stem}.shx", "wb").write(header(100 + len(shx)) + shx)
    fields = [("Id", "N", 10, 0), ("Length", "N", 10, 2), ("StreetName", "C", 20, 0)]
    hlen = 32 + 32 * len(fields) + 1; rlen = 1 + sum(f[2] for f in fields)
    hdr = struct.pack("<BBBBIHH20x", 3, 24, 9, 24, len(ids), hlen, rlen)
    for name, typ, ln, dec in fields: hdr += name.encode().ljust(11, b"\0") + typ.encode() + b"\0" * 4 + bytes([ln, dec]) + b"\0" * 14
    hdr += b"\r"
    body = b"".join(b" " + str(i).rjust(10).encode() + f"{L:10.2f}".encode() + b"road".ljust(20) for i, L in zip(ids, lengths))
    open(f"{stem}.dbf", "wb").write(hdr + body + b"\x1a")
    open(f"{stem}.prj", "w").write('GEOGCS["GCS_WGS_1984",DATUM["D_WGS_1984",SPHEROID["WGS_1984",6378137.0,298.257223563]],PRIMEM["Greenwich",0.0],UNIT["Degree",0.0174532925199433]]')

rng = np.random.default_rng(7)
truck_links = [r for r in range(N) if r % 3 == 0]
write_shapefile(str(TR / "network_agg"), [features[r]["geometry"]["coordinates"] for r in truck_links], [ids[r] for r in truck_links], [250.0] * len(truck_links))
per_window = {}
n_truck_rows = 0
for r in truck_links:
    base_h = rng.integers(0, 7); base_s = rng.uniform(20, 50)
    c = np.array(features[r]["geometry"]["coordinates"][0]); flooded = np.hypot(*(c - center)) < 0.02
    for ti, tm in enumerate(times):
        day_b, day_e = ("20240814", "20240821") if ti < 24 else ("20240815", "20240822")
        hb = max(0, base_h + rng.integers(-1, 2)); he = max(0, base_h + rng.integers(-1, 2))
        sb = base_s * (1 + 0.05 * rng.standard_normal()); se = base_s * (1 + 0.05 * rng.standard_normal())
        if flooded and 20 <= ti < 32: he = int(he * 0.2); se *= 0.3
        hhmm = tm.replace(":", "")
        if hb > 0: per_window.setdefault(f"traffic_{day_b}_{hhmm}.csv", []).append((ids[r], hb, round(sb, 2), round(sb, 2), hb * 30))
        if he > 0: per_window.setdefault(f"traffic_{day_e}_{hhmm}.csv", []).append((ids[r], he, round(se, 2), round(se, 2), he * 30))
for name, rows_ in per_window.items():
    pd.DataFrame(rows_, columns=["Id", "Hits", "AvgSp", "MedSp", "n_points"]).to_csv(TR / name, index=False); n_truck_rows += len(rows_)
# sns/FA_sample_20240821.csv: SNS posts in the FASTALERT-like layout (UTF-8 with BOM). 45 rows: 6 stacked at the centre
# (23:50 .. 00:28), 34 spread over the grid every 15 min from 18:10 (4 of them fall into the window (23:30, 00:30]),
# 5 without coordinates. Texts carry commas, quotes and the "¥n" line-break marker of the export.
SN = OUT / "sns"; SN.mkdir(exist_ok=True)
sns_rows = []
cats = ["浸水・冠水", "大雨", "雨漏り", "鉄道トラブル", "交通事故", "停電"]
def sns_row(pid, t, cat, lon, lat, text, rng_m="300", media="https://example.invalid/media.jpg"):
    return {"投稿ID": pid, "日時": t.strftime("%Y-%m-%d %H:%M:%S"), "事象No.": 11600000 + pid % 97, "事象区分": cat, "事象名": f"東京都新宿区で{cat}",
            "都道府県": "東京都", "市区町村": "新宿区", "行政区": "", "字・番地": "西新宿2丁目" if lon is not None else "",
            "緯度": "" if lat is None else f"{lat:.6f}", "経度": "" if lon is None else f"{lon:.6f}", "範囲": rng_m if lon is not None else "",
            "投稿文": text, "写真動画": media}
t0 = pd.Timestamp("2024-08-21 18:10")
for k in range(34):
    t = t0 + pd.Timedelta(minutes=15 * k)
    lon = lon0 + ((k * 7) % 40 + 0.5) * dlon; lat = lat0 + ((k * 11) % 30 + 0.5) * dlat
    sns_rows.append(sns_row(340000000 + k, t, cats[k % len(cats)], lon, lat, f"投稿 {k}: 道路が冠水、車が通れない¥n#新宿区, 要注意"))
for k, (hh, mm) in enumerate([(23, 50), (0, 5), (0, 10), (0, 20), (0, 25), (0, 28)]):
    t = pd.Timestamp("2024-08-21") + pd.Timedelta(days=1 if hh == 0 else 0, hours=hh, minutes=mm)
    sns_rows.append(sns_row(340100000 + k, t, "浸水・冠水", float(center[0]), float(center[1]), f'中心地点の投稿 {k + 1}。"膝まで水" と言っている人も、いる', "100"))
for k in range(5):
    sns_rows.append(sns_row(340200000 + k, t0 + pd.Timedelta(hours=k), "大雨", None, None, "座標のない投稿です", "", ""))
pd.DataFrame(sns_rows).to_csv(SN / "FA_sample_20240821.csv", index=False, encoding="utf-8-sig")
print("sns/: FA_sample_20240821.csv", len(sns_rows), "rows (40 with coordinates)")
# flood/S1_YYYYMMDDHHMM.shp: flood-extent polygons (100 m mesh cells) at irregular observation times; dbf in cp932 with
# the fields of the real files (meshcode, JIcode, 浸水深, 水位, 地盤高). Each snapshot grows around the flooded centre.
FL = OUT / "flood"
if FL.exists(): shutil.rmtree(FL)
FL.mkdir()
def write_polygon_shapefile(stem, rings, fields, rows, encoding="cp932"):
    recs, shx = b"", b""; xmin = ymin = 1e9; xmax = ymax = -1e9
    for k, ring in enumerate(rings, 1):
        xs = [c[0] for c in ring]; ys = [c[1] for c in ring]
        box = (min(xs), min(ys), max(xs), max(ys)); xmin, ymin, xmax, ymax = min(xmin, box[0]), min(ymin, box[1]), max(xmax, box[2]), max(ymax, box[3])
        content = struct.pack("<i4d2ii", 5, *box, 1, len(ring), 0) + b"".join(struct.pack("<2d", x, y) for x, y in ring)
        shx += struct.pack(">2i", (100 + len(recs)) // 2, len(content) // 2)
        recs += struct.pack(">2i", k, len(content) // 2) + content
    if not rings: xmin = ymin = xmax = ymax = 0.0
    def header(nbytes): return struct.pack(">6i", 9994, 0, 0, 0, 0, 0) + struct.pack(">i", nbytes // 2) + struct.pack("<2i", 1000, 5) + struct.pack("<8d", xmin, ymin, xmax, ymax, 0, 0, 0, 0)
    open(f"{stem}.shp", "wb").write(header(100 + len(recs)) + recs)
    open(f"{stem}.shx", "wb").write(header(100 + len(shx)) + shx)
    hlen = 32 + 32 * len(fields) + 1; rlen = 1 + sum(f[2] for f in fields)
    hdr = struct.pack("<BBBBIHH", 3, 24, 9, 24, len(rows), hlen, rlen) + b"\0" * 17 + bytes([0x13]) + b"\0\0"   # 0x13 = cp932 language driver
    for name, typ, ln, dec in fields: hdr += name.encode(encoding).ljust(11, b"\0") + typ.encode() + b"\0" * 4 + bytes([ln, dec]) + b"\0" * 14
    hdr += b"\r"
    body = b""
    for row in rows:
        body += b" "
        for (name, typ, ln, dec), v in zip(fields, row):
            body += (str(v).ljust(ln).encode(encoding) if typ == "C" else (f"{v:{ln}.{dec}f}" if dec else str(v).rjust(ln)).encode())[:ln]
    open(f"{stem}.dbf", "wb").write(hdr + body + b"\x1a")
    open(f"{stem}.prj", "w").write('GEOGCS["GCS_WGS_1984",DATUM["D_WGS_1984",SPHEROID["WGS_1984",6378137.0,298.257223563]],PRIMEM["Greenwich",0.0],UNIT["Degree",0.0174532925199433]]')
    open(f"{stem}.cpg", "w").write("cp932")
flood_fields = [("meshcode", "C", 20, 0), ("JIcode", "N", 12, 0), ("浸水深", "N", 19, 3), ("水位", "N", 19, 3), ("地盤高", "N", 19, 3)]
cell = 0.0011   # ~100 m
n_flood_cells = 0
for stamp, radius in [("202408212110", 1), ("202408212240", 2), ("202408212330", 3), ("202408220050", 4)]:
    rings, rows = [], []
    for i in range(-radius, radius + 1):
        for j in range(-radius, radius + 1):
            if i * i + j * j > radius * radius: continue
            x0, y0 = center[0] + i * cell, center[1] + j * cell
            rings.append([(x0, y0), (x0, y0 + cell), (x0 + cell, y0 + cell), (x0 + cell, y0), (x0, y0)])   # clockwise = outer ring
            depth = round(max(0.1, 2.5 * (1 - math.hypot(i, j) / (radius + 0.5))), 3)
            rows.append((f"5339{i + 50:02d}{j + 50:02d}", 13104, depth, round(5.0 + depth, 3), 5.0))
    write_polygon_shapefile(str(FL / f"S1_{stamp}"), rings, flood_fields, rows); n_flood_cells += len(rows)
print("flood/: 4 snapshots,", n_flood_cells, "mesh cells")
print("truck/: network_agg.shp", len(truck_links), "links,", len(per_window), "window files,", n_truck_rows, "rows")

print("links", len(features), "csv rows", N, "error links", int((link_level >= 1).sum()),
      "cells by level", {k: int((err == k).sum()) for k in (1, 2, 3)}, "links by max level", {k: int((link_level == k).sum()) for k in (1, 2, 3)})
