"""Writes walk_mesh.ipynb (unique walkers per 25 m cell over the last hour, from probe_trips.py's *_points.csv)."""
import json
from pathlib import Path

cells = []
def md(s): cells.append({"cell_type": "markdown", "metadata": {}, "source": s.strip("\n").splitlines(keepends=True)})
def code(s): cells.append({"cell_type": "code", "metadata": {}, "execution_count": None, "outputs": [], "source": s.strip("\n").splitlines(keepends=True)})

md(r'''
# 人流: 直近 1 時間の徒歩ユニーク人数を 25 m メッシュで数える

`probe_trips.py` が書いた `*_points.csv`（全点 + Stay/Move・モードの判定列。利用者 ID を含む唯一の出力）を読み、
15 分スロットごとに「直近 1 時間（(T−60 分, T]）にそのセルに徒歩の点を 1 つでも持つ利用者 ID の数」を 25 m メッシュで数えます。
平時・有事それぞれの件数と、その比（有事 / 平時）を GeoTIFF に書き、ビューワーのグリッドタブ（入力 6）でそのまま読めます。
このノートブックは probe_trips.py を import しません（必要なのは numpy と pandas だけ）。

| 節 | 処理 | 出力 |
|---|---|---|
| 1 | 入力ファイルの役割（平時／有事）とスロット軸を決める | – |
| 2 | 点を少しずつ読み、徒歩の点だけを残す | – |
| 3 | メッシュを決め、スロット × セルの利用者 ID 数を数える | – |
| 4 | GeoTIFF と index.json を書く | `walk25_{baseline,event}_HHMM.tif`, `walk25_HHMM.tif`, `index.json` |

数え方

- 徒歩の点 = `segment == "Move"` かつ `dense == 1` かつ `mode == "walk"`（ビューワーの軌跡タブに描かれる点と同じ）。`WALK_ONLY = False` で全点
- 窓は (T − `WINDOW_MIN`, T]、T は `SLOT_MIN` 刻み。同じ利用者がその窓・そのセルに何点あっても 1 と数える
- 平時が複数日あれば日平均。比は平時 0 のセルを NaN にする
- 入力の役割: ファイル名が `baseline_…` / `event_…`（probe_trips の期間モードの出力）ならその通り、`YYYYMMDD_points.csv`（日別モード）なら `EVENT_DATE` の日が有事、他が平時
- スロットの並び: 期間モードの出力は期間の開始時刻から 15 分刻み（12:00, 12:15, …, 11:45）、日別モードは 00:15 … 24:00（窓の終端の時刻）
- メッシュの範囲: `GRID_BBOX`、無ければ `GRID_INDEX`（probe_trips の `grid/index.json` の bounds と同じ範囲）、どちらも無ければ徒歩の点の範囲

25 m セルは 100 m の 16 倍の数になります。範囲 10 km × 10 km で 16 万セル（1 枚 0.6 MB）、96 スロット × 3 枚で約 200 MB。
東京都全域のような広い範囲は `GRID_BBOX` で対象を絞ってください。
''')

md("## 0. パラメータ")
code(r'''
from pathlib import Path
import json, math, re, struct, time
import numpy as np
import pandas as pd

# ---- 入出力 -------------------------------------------------------------
POINTS_FILES = sorted(Path("./probe_out/2024").glob("*_points.csv"))   # probe_trips.py の *_points.csv（平時・有事の両方）
EVENT_DATE   = "2024-08-21"                 # 日別モードの出力（YYYYMMDD_points.csv）のとき、この日が有事、他が平時
OUT_DIR      = Path("./probe_out/2024/grid_walk25")   # 出力先（ビューワーの入力 6、または人流フォルダの中の grid*/ として読まれる）
OUT_DIR.mkdir(parents=True, exist_ok=True)

# ---- メッシュと窓 ---------------------------------------------------------
CELL_M     = 25.0                           # セルの一辺 [m]
GRID_BBOX  = None                           # (lon_min, lat_min, lon_max, lat_max)。None なら GRID_INDEX、それも無ければ点の範囲
GRID_INDEX = Path("./probe_out/2024/grid/index.json")   # 範囲を揃えたい既存の index.json（無ければ無視）
SLOT_MIN   = 15                             # スロット [分]
WINDOW_MIN = 60                             # 窓 [分]（直近 1 時間）
PERIOD_HOURS = 24                           # 期間モードの出力のとき、期間の長さ [時間]（probe_trips の PERIOD_HOURS）

# ---- 点の選び方 ----------------------------------------------------------
WALK_ONLY  = True                           # True: Move かつ dense かつ walk の点だけ。False: 全点
CHUNK_ROWS = 1_000_000                      # CSV を一度に読む行数

PARAM, LABEL, UNIT = "walk25", "徒歩ユニーク人数（25 m）", "人"   # ビューワーの層の名前・表示
NODATA = -99.0                              # 件数ラスタの nodata（比は NaN）

def log(msg):
    print(f"[{time.strftime('%H:%M:%S')}] {msg}", flush=True)
''')

md(r'''
## 1. 入力ファイルの役割とスロット軸

ファイル名から役割（baseline / event）と、期間モードなら期間の開始時刻を取ります。
スロット k の終端 T_k = day0 + k × SLOT_MIN。day0 は期間の開始時刻（期間モード）か、その日の 0 時（日別モード）です。
''')
code(r'''
def describe(path):
    """(role, day0, k_lo, k_hi) をファイル名から決める。"""
    m = re.match(r"(baseline|event)_(\d{8})_(\d{4})_points\.csv$", path.name)
    if m:                                                          # 期間モード: 期間の開始から 15 分刻み
        day0 = pd.Timestamp(f"{m.group(2)} {m.group(3)[:2]}:{m.group(3)[2:]}")
        return m.group(1), day0, 0, int(round(PERIOD_HOURS * 60 / SLOT_MIN)) - 1
    m = re.match(r"(\d{8})_points\.csv$", path.name)
    if not m:
        raise ValueError(f"ファイル名から日付を読めません: {path.name}")
    day0 = pd.Timestamp(m.group(1))                                # 日別モード: 00:15 … 24:00
    role = "event" if day0.date() == pd.Timestamp(EVENT_DATE).date() else "baseline"
    return role, day0, 1, int(1440 / SLOT_MIN)

jobs = [(p, *describe(p)) for p in POINTS_FILES]
if not jobs:
    raise FileNotFoundError("POINTS_FILES が空です")
for p, role, day0, k_lo, k_hi in jobs:
    print(f"{p.name}: {role}, day0 {day0}, slots {k_lo}..{k_hi}")
label_of = lambda day0, k: (day0 + pd.Timedelta(minutes=k * SLOT_MIN)).strftime("%H:%M")
N_WIN = int(round(WINDOW_MIN / SLOT_MIN))                          # 1 点が属する窓の数
''')

md(r'''
## 2. 点を読む

`CHUNK_ROWS` 行ずつ読み、徒歩の点だけを残して (利用者コード, 時刻, lon, lat) にします。利用者 ID はファイル内で整数コードに置き換え、出力には出しません。
''')
code(r'''
def read_walk_points(path):
    """徒歩の点を (ucode, tsec, lon, lat) の numpy 配列で返す。ucode はこのファイル内の通し番号。"""
    cols = ["userid", "recordedat", "lon", "lat"] + (["segment", "dense", "mode"] if WALK_ONLY else [])
    uids, parts = {}, []
    for ch in pd.read_csv(path, usecols=cols, chunksize=CHUNK_ROWS, dtype={"userid": str}):
        if WALK_ONLY:
            ch = ch[(ch["segment"] == "Move") & (ch["dense"] == 1) & (ch["mode"] == "walk")]
        if ch.empty:
            continue
        codes = np.fromiter((uids.setdefault(u, len(uids)) for u in ch["userid"]), dtype=np.int64, count=len(ch))
        t = pd.to_datetime(ch["recordedat"]).to_numpy()
        parts.append((codes, t, ch["lon"].to_numpy(float), ch["lat"].to_numpy(float)))
    if not parts:
        return np.zeros(0, np.int64), np.zeros(0, "datetime64[ns]"), np.zeros(0), np.zeros(0)
    ucode, t, lon, lat = (np.concatenate(x) for x in zip(*parts))
    log(f"  {path.name}: 徒歩の点 {len(ucode):,}、利用者 {len(uids):,}")
    return ucode, t, lon, lat

points = {}
for p, role, day0, k_lo, k_hi in jobs:
    t0 = time.perf_counter()
    points[p] = read_walk_points(p)
    log(f"  read in {time.perf_counter() - t0:.1f} s")
''')

md(r'''
## 3. メッシュとスロット × セルの利用者数

セルは経緯度の格子（中心緯度で一辺 `CELL_M` m）。行 0 が北端、セル番号 = 行 × 列数 + 列（GeoTIFF の並び）。
各点を、それを含む `N_WIN` 個の窓（終端 T_k が点の時刻以上、T_k − WINDOW_MIN が点の時刻未満）に複製し、(窓, セル, 利用者) の重複を消してから数えます。
''')
code(r'''
M_PER_DEG = 6371008.8 * math.pi / 180.0

class Mesh:
    def __init__(self, bbox, cell_m):
        west, south, east, north = (float(v) for v in bbox)
        self.dy = cell_m / M_PER_DEG
        self.dx = cell_m / (M_PER_DEG * math.cos(math.radians((south + north) / 2)))
        self.ncol = max(1, int(math.ceil((east - west) / self.dx)))
        self.nrow = max(1, int(math.ceil((north - south) / self.dy)))
        self.west, self.north, self.cell_m = west, north, cell_m
        self.east, self.south = west + self.ncol * self.dx, north - self.nrow * self.dy
    def cell(self, lon, lat):
        col = np.floor((lon - self.west) / self.dx); row = np.floor((self.north - lat) / self.dy)
        ok = (col >= 0) & (col < self.ncol) & (row >= 0) & (row < self.nrow)
        return np.where(ok, row * self.ncol + col, -1).astype(np.int64)

def mesh_bbox():
    if GRID_BBOX:
        return tuple(GRID_BBOX), "GRID_BBOX"
    if GRID_INDEX and Path(GRID_INDEX).exists():
        return tuple(json.load(open(GRID_INDEX, encoding="utf-8"))["bounds"]), str(GRID_INDEX)
    lons = np.concatenate([v[2] for v in points.values()]); lats = np.concatenate([v[3] for v in points.values()])
    if not len(lons):
        raise ValueError("徒歩の点がありません")
    return (lons.min(), lats.min(), lons.max(), lats.max()), "点の範囲"

bbox, src = mesh_bbox()
mesh = Mesh(bbox, CELL_M)
log(f"メッシュ: {mesh.ncol} x {mesh.nrow} セル（{CELL_M:g} m、範囲は {src}）")

def count_users(ucode, t, lon, lat, day0, k_lo, k_hi):
    """{k: Series(cell -> 利用者数)}: 窓 (T_k - WINDOW_MIN, T_k] にセル内の点を持つ利用者の数。"""
    mins = (t - day0.to_datetime64()) / np.timedelta64(1, "m")
    k0 = np.maximum(np.ceil(mins / SLOT_MIN).astype(np.int64), k_lo)           # 点の時刻以上の最初の窓終端
    rep = np.repeat(np.arange(len(mins)), N_WIN)
    kk = np.repeat(k0, N_WIN) + np.tile(np.arange(N_WIN), len(mins))
    ok = (kk <= k_hi) & (kk * SLOT_MIN - WINDOW_MIN < np.repeat(mins, N_WIN))  # 窓が点を含む
    rep, kk = rep[ok], kk[ok]
    cells = mesh.cell(lon[rep], lat[rep]); m = cells >= 0
    key = pd.DataFrame({"k": kk[m], "cell": cells[m], "u": ucode[rep][m]}).drop_duplicates()
    return {int(k): g.groupby("cell").size().astype(np.float32) for k, g in key.groupby("k")}

acc, days, labels = {}, {}, []                                     # (role, label) -> Series(cell -> 日合計), role -> 日数, ラベルの並び
for p, role, day0, k_lo, k_hi in jobs:
    t0 = time.perf_counter()
    counts = count_users(*points[p], day0, k_lo, k_hi)
    for k in range(k_lo, k_hi + 1):
        lab = label_of(day0, k)
        if lab not in labels:
            labels.append(lab)
        if k in counts:
            acc[(role, lab)] = counts[k] if (role, lab) not in acc else acc[(role, lab)].add(counts[k], fill_value=0.0)
    days[role] = days.get(role, 0) + 1
    log(f"  {role} {p.name}: {sum(len(v) for v in counts.values()):,} (窓, セル) 組 in {time.perf_counter() - t0:.1f} s")
print("役割と日数:", days, "/ スロット", len(labels), "個:", labels[:4], "…", labels[-2:])
''')

md(r'''
## 4. GeoTIFF と index.json

`walk25_baseline_HHMM.tif` / `walk25_event_HHMM.tif`（float32 の人数、nodata −99）と、両方あるとき `walk25_HHMM.tif`（有事 / 平時。平時 0 は NaN）。
`index.json` はビューワーが層の名前・単位・窓の長さを読むためのものです（probe_trips の `grid/index.json` と同じ形式）。
''')
code(r'''
def write_geotiff(path, arr, west, north, dx, dy, nodata):
    """非圧縮 float32 GeoTIFF、EPSG:4326、行 0 が北（probe_trips.py と同じ書き方）。"""
    h, w = arr.shape
    data = arr.astype("<f4").tobytes()
    ascii_nodata = (str(int(nodata)) if float(nodata).is_integer() else str(nodata)).encode() + b"\x00"
    geokeys = struct.pack("<16H", 1, 1, 0, 3, 1024, 0, 1, 2, 1025, 0, 1, 1, 2048, 0, 1, 4326)
    pixel_scale = struct.pack("<3d", dx, dy, 0.0)
    tiepoint = struct.pack("<6d", 0.0, 0.0, 0.0, west, north, 0.0)
    tags = [(256, 4, 1, w), (257, 4, 1, h), (258, 3, 1, 32), (259, 3, 1, 1), (262, 3, 1, 1), (273, 4, 1, None),
            (277, 3, 1, 1), (278, 4, 1, h), (279, 4, 1, len(data)), (284, 3, 1, 1), (339, 3, 1, 3),
            (33550, 12, 3, pixel_scale), (33922, 12, 6, tiepoint), (34735, 3, 16, geokeys), (42113, 2, len(ascii_nodata), ascii_nodata)]
    tags.sort()
    extra_off = 8 + 2 + 12 * len(tags) + 4
    data_off = extra_off + sum(len(v) for _, _, _, v in tags if isinstance(v, bytes) and len(v) > 4)
    extra, entries = b"", b""
    for tag, typ, count, value in tags:
        if tag == 273:
            value = data_off
        if isinstance(value, bytes):
            if len(value) > 4:
                entries += struct.pack("<HHII", tag, typ, count, extra_off + len(extra)); extra += value
            else:
                entries += struct.pack("<HHI", tag, typ, count) + value.ljust(4, b"\x00")
        elif typ == 3:
            entries += struct.pack("<HHIHH", tag, typ, count, value, 0)
        else:
            entries += struct.pack("<HHII", tag, typ, count, value)
    with open(path, "wb") as f:
        f.write(b"II*\x00" + struct.pack("<I", 8))
        f.write(struct.pack("<H", len(tags)) + entries + struct.pack("<I", 0))
        f.write(extra)
        f.write(data)

def dense(role, lab):
    arr = np.zeros(mesh.nrow * mesh.ncol, dtype=np.float32)
    v = acc.get((role, lab))
    if v is not None:
        arr[v.index.to_numpy()] = v.to_numpy(np.float32) / days[role]     # 日平均
    return arr.reshape(mesh.nrow, mesh.ncol)

for old in OUT_DIR.glob(f"{PARAM}_*.tif"):
    old.unlink()
files = []
both = {"baseline", "event"} <= set(days)
for lab in labels:
    hhmm = lab.replace(":", "")
    b, e = dense("baseline", lab), dense("event", lab)
    for role, arr in (("baseline", b), ("event", e)):
        if role in days:
            name = f"{PARAM}_{role}_{hhmm}.tif"
            write_geotiff(OUT_DIR / name, arr, mesh.west, mesh.north, mesh.dx, mesh.dy, NODATA); files.append(name)
    if both:
        with np.errstate(divide="ignore", invalid="ignore"):
            ratio = np.where(b > 0, e / b, np.nan).astype(np.float32)
        name = f"{PARAM}_{hhmm}.tif"
        write_geotiff(OUT_DIR / name, ratio, mesh.west, mesh.north, mesh.dx, mesh.dy, float("nan")); files.append(name)

index = {"cell_m": CELL_M, "bounds": [mesh.west, mesh.south, mesh.east, mesh.north], "width": mesh.ncol, "height": mesh.nrow,
         "dx": mesh.dx, "dy": mesh.dy, "nodata": "nan", "count_nodata": NODATA, "params": [PARAM],
         "labels": {PARAM: LABEL}, "units": {PARAM: UNIT}, "window_min": WINDOW_MIN, "slot_min": SLOT_MIN,
         "slots": labels, "roles": sorted(days), "days": days, "walk_only": WALK_ONLY,
         "values": f"{PARAM}_<role>_<HHMM>: 窓 (T - {WINDOW_MIN} 分, T] にセル内の徒歩の点を持つ利用者 ID の数（日平均）; "
                   f"{PARAM}_<HHMM>: 有事 / 平時（平時 0 は NaN）", "files": files}
with open(OUT_DIR / "index.json", "w", encoding="utf-8") as f:
    json.dump(index, f, ensure_ascii=False, indent=1)
log(f"wrote {len(files)} rasters to {OUT_DIR}（{len(labels)} スロット、{mesh.ncol * mesh.nrow:,} セル、役割 {sorted(days)}）")
''')

nb = {"cells": cells, "metadata": {"kernelspec": {"display_name": "Python 3", "language": "python", "name": "python3"},
      "language_info": {"name": "python"}}, "nbformat": 4, "nbformat_minor": 5}
out = Path(__file__).parent / "walk_mesh.ipynb"
json.dump(nb, open(out, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
print("wrote", out, len(cells), "cells")
