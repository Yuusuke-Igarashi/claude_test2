# -*- coding: utf-8 -*-
"""合成データ生成（動作確認用）: 格子状の道路網（GeoPackage: network_edges / all_highway_ways）と、その上を動く端末の生ピング（Factori 形式 parquet）。

使い方: python gen_synth.py --out <フォルダ> [--grid 30] [--ioff 0] [--no-gpkg]
  --grid   格子の節点数（1 辺）。約 1 km 間隔。220 にするとノード 48,400 で、map_match の int32 桁あふれ（修正済み）の再現に使える
  --ioff   端末を置く列のオフセット。ノード番号の大きい側に端末を置きたいときに使う（例 --grid 220 --ioff 190。
           その場合 extract_dense には --bbox 68.95,41.00,72.5,41.55 のように広い範囲を渡す）
  --no-gpkg 道路網の GeoPackage を書かない（同じ格子を既に作ってあるとき）
生成される動き: 自宅 Stay → 車で通勤 → Stay → 徒歩 2 km → Stay。3 台に 1 台は 3 時間の観測の途切れの後に車で帰宅（gap 端点のトリップ）、
  4 台に 1 台は車 → 続けて徒歩のモードチェンジ。ほかに、GPS の跳び 1 点、点数の少ない端末、精度の悪い点、範囲外の点、同じ場所の重複（バースト）を混ぜる。
  軌跡は格子に沿うが一方通行は無視するので、map_match で「迂回超過」として切れるトリップが数本出るのは期待どおり。
出力: <out>/Tashkent_Road_Network.gpkg、<out>/raw/part0.parquet, part1.parquet（maid, latitude, longitude, horizontal_accuracy, timestamp[秒]）
"""
import argparse, json
from pathlib import Path
import numpy as np, pandas as pd
import pyarrow as pa, pyarrow.parquet as pq
import geopandas as gpd
from shapely.geometry import LineString

ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
ap.add_argument("--out", required=True); ap.add_argument("--grid", type=int, default=30); ap.add_argument("--ioff", type=int, default=0); ap.add_argument("--no-gpkg", action="store_true")
a = ap.parse_args()
out = Path(a.out); out.mkdir(parents=True, exist_ok=True)
rng = np.random.default_rng(7)
W, S = 69.10, 41.18
NI = NJ = a.grid
KY = 111_320.0; KX = 111_320.0 * np.cos(np.radians(41.30))
DX, DY = 1000.0 / KX, 1000.0 / KY     # 約 1 km 間隔
def node_id(i, j): return 1_000_000 + i * 1000 + j
def xy(i, j): return (W + i * DX, S + j * DY)

# --- 道路網 ---
edges, ways = [], []
eid = 0; wid = 5_000_000
for i in range(NI):
    for j in range(NJ):
        for (i2, j2) in ((i + 1, j), (i, j + 1)):
            if i2 >= NI or j2 >= NJ: continue
            wid += 1; eid += 1
            hw = "primary" if (j % 5 == 0 and j2 == j) or (i % 5 == 0 and i2 == i) else "residential"
            tags = {"highway": hw, "name": f"Street {wid}"}
            if hw == "residential" and (i + j) % 7 == 0 and i2 == i + 1: tags["oneway"] = "yes"   # 一部を一方通行に
            if (i + j) % 11 == 0 and j2 == j + 1: tags["maxspeed"] = "40"
            line = LineString([xy(i, j), xy(i2, j2)])
            edges.append({"edge_id": f"e{eid}", "osm_way_id": wid, "from_node": node_id(i, j), "to_node": node_id(i2, j2), "highway": hw, "oneway": tags.get("oneway", None), "geometry": line})
            ways.append({"osm_id": wid, "tags_json": json.dumps(tags), "geometry": line})
for k in range(5):                                                      # 歩道（footway）を別ノードで数本（歩行者網だけに入る）
    i = 2 + k * 5; wid += 1; eid += 1
    p, q = (W + i * DX + 0.3 * DX, S + 3 * DY), (W + i * DX + 0.3 * DX, S + 4 * DY)
    edges.append({"edge_id": f"e{eid}", "osm_way_id": wid, "from_node": 9_000_000 + k * 2, "to_node": 9_000_000 + k * 2 + 1, "highway": "footway", "oneway": None, "geometry": LineString([p, q])})
    ways.append({"osm_id": wid, "tags_json": json.dumps({"highway": "footway"}), "geometry": LineString([p, q])})
# 不正データ: 存在しない way、長さ 0（build_tashkent_graphs が skipped_edges.csv に記録して続行することを見る）
edges.append({"edge_id": "bad1", "osm_way_id": 99, "from_node": 1, "to_node": 2, "highway": "residential", "oneway": None, "geometry": LineString([xy(0, 0), xy(0, 1)])})
edges.append({"edge_id": "bad2", "osm_way_id": wid, "from_node": 3, "to_node": 3, "highway": "residential", "oneway": None, "geometry": LineString([xy(0, 0), xy(0, 0)])})
if not a.no_gpkg:
    gpkg = out / "Tashkent_Road_Network.gpkg"
    if gpkg.exists(): gpkg.unlink()
    gpd.GeoDataFrame(edges, geometry="geometry", crs="EPSG:4326").to_file(gpkg, layer="network_edges", driver="GPKG")
    gpd.GeoDataFrame(ways, geometry="geometry", crs="EPSG:4326").to_file(gpkg, layer="all_highway_ways", driver="GPKG")
    print(f"道路網: {len(edges)} 辺, {len(ways)} way → {gpkg}")

# --- 端末の軌跡 ---
T0 = 1_761_955_200   # 2025-11-01 00:00 UTC ごろ
rows = []
def stay(maid, i, j, t, minutes, every=60, acc=20):
    n = int(minutes * 60 / every); lon, lat = xy(i, j)
    for k in range(n): rows.append((maid, lat + rng.normal(0, 8) / KY, lon + rng.normal(0, 8) / KX, acc, t + k * every))
    return t + n * every
def move(maid, i0, j0, i1, j1, t, kmh, every=20, acc=15):
    """格子に沿って (i0,j0) → (i1,j0) → (i1,j1) と動く（一方通行は無視）"""
    pts = [xy(i, j0) for i in range(i0, i1, 1 if i1 > i0 else -1)] + [xy(i1, j0)]
    pts += [xy(i1, j) for j in range(j0, j1, 1 if j1 > j0 else -1)] + [xy(i1, j1)]
    pts = np.array(pts); seg = np.hypot(np.diff(pts[:, 0]) * KX, np.diff(pts[:, 1]) * KY); L = seg.sum()
    v = kmh / 3.6; n = int(L / v / every); cum = np.r_[0, np.cumsum(seg)]
    for k in range(1, n + 1):
        s = min(v * k * every, L); idx = min(np.searchsorted(cum, s, side="right") - 1, len(seg) - 1)
        f = (s - cum[idx]) / seg[idx] if seg[idx] > 0 else 0
        lon = pts[idx, 0] + f * (pts[idx + 1, 0] - pts[idx, 0]); lat = pts[idx, 1] + f * (pts[idx + 1, 1] - pts[idx, 1])
        rows.append((maid, lat + rng.normal(0, 6) / KY, lon + rng.normal(0, 6) / KX, acc, t + k * every))
    return t + n * every + every

for d in range(12):
    maid = f"{d:x}" * 2 + f"-dev-{d:03d}"          # 先頭文字が 16 進になる端末 ID（make_trips の --parts 16 の分割に乗る）
    i, j = int(rng.integers(2, 10)) + a.ioff, int(rng.integers(2, 10))
    t = T0 + d * 600
    t = stay(maid, i, j, t, 60)                                         # 自宅
    i2, j2 = i + 8, j + 6
    t = move(maid, i, j, i2, j2, t, 35)                                 # 車で通勤
    t = stay(maid, i2, j2, t, 40)
    i3, j3 = i2 + 1, j2 + 1
    t = move(maid, i2, j2, i3, j3, t, 4.5, every=30)                    # 徒歩 2 km
    t = stay(maid, i3, j3, t, 25)
    if d % 3 == 0:                                                      # 観測の途切れ（3 時間）→ gap 端点のトリップ
        t += 3 * 3600
        t = move(maid, i3, j3, i, j, t, 30)
        t = stay(maid, i, j, t, 30)
    if d % 4 == 1:                                                      # モードチェンジ: 車 → 続けて徒歩（停留なし）。d=9 は帰宅後なので跳びを含む
        t = move(maid, i3, j3, i3 + 6, j3, t, 40, every=20)
        t = move(maid, i3 + 6, j3, i3 + 7, j3 + 1, t, 4.5, every=30)
        t = stay(maid, i3 + 7, j3 + 1, t, 30)
    if d == 5:                                                          # GPS の跳び 1 点
        rows.append((maid, rows[-1][1] + 0.05, rows[-1][2] + 0.05, 15, rows[-1][4] + 10))
for k in range(5): rows.append(("zz-sparse", 41.30, 69.25, 20, T0 + k * 60))                       # 点数の少ない端末
rows.append(("00-dev-000", 41.30, 69.25, 500, T0 + 5)); rows.append(("00-dev-000", 20.0, 69.25, 20, T0 + 6))   # 精度の悪い点、範囲外の点
rows.append(("11-dev-001", 41.30, 69.25, 20, T0 + 600)); rows.append(("11-dev-001", 41.30, 69.25, 20, T0 + 601))  # バースト
df = pd.DataFrame(rows, columns=["maid", "latitude", "longitude", "horizontal_accuracy", "timestamp"])
df = df.sample(frac=1, random_state=1).reset_index(drop=True)      # 順序をばらす
(out / "raw").mkdir(exist_ok=True)
half = len(df) // 2
pq.write_table(pa.Table.from_pandas(df.iloc[:half], preserve_index=False), out / "raw" / "part0.parquet")
pq.write_table(pa.Table.from_pandas(df.iloc[half:], preserve_index=False), out / "raw" / "part1.parquet")
print(f"生ピング: {len(df):,} 点, {df['maid'].nunique()} 端末 → {out / 'raw'}")
