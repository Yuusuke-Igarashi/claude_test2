"""Writes kaden_compare.ipynb (Sharp home-appliance connection counts per postal code: baseline vs event)."""
import json
from pathlib import Path

cells = []
def md(s): cells.append({"cell_type": "markdown", "metadata": {}, "source": s.strip("\n").splitlines(keepends=True)})
def code(s): cells.append({"cell_type": "code", "metadata": {}, "execution_count": None, "outputs": [], "source": s.strip("\n").splitlines(keepends=True)})

md(r'''
# 家電データ（シャープ）: 郵便番号別の接続家電数を平時と比べる

15 分ごとの家電データ（`YYYYMMDDHHMM_15M_*.csv`。郵便番号 × 家電種別ごとの接続台数 `count`）を読み、郵便番号を代表点（緯度経度）に変えて、
有事の日と平時の日の同じ時刻の窓を比べます。平時に対して台数が大きく減った（停電・浸水で家電がつながらなくなった）／増えた郵便番号を
窓ごとに GeoJSON（点）に書き、ビューワーのグリッドタブで見られるラスタも書きます。必要なライブラリは numpy と pandas だけです。

| 節 | 処理 | 出力 |
|---|---|---|
| 1 | 郵便番号 → 緯度経度の表を読み、対象範囲の郵便番号に絞る | – |
| 2 | 15 分ファイルを読み、窓 × 郵便番号の台数にまとめる（有事・平時） | – |
| 3 | 同じ時刻の窓で比を出し、減少／増加を判定する | `kaden_15min.csv` |
| 4 | 窓ごとに、異常の郵便番号だけの GeoJSON（点）を書く | `anomaly/kaden_anomaly_YYYYMMDD_HHMM.geojson` |
| 5 | 郵便番号の代表点をセルに集計したラスタと index.json を書く（ビューワーのグリッドタブ用、任意） | `grid_kaden/kaden_{baseline,event}_HHMM.tif`, `kaden_HHMM.tif`, `index.json` |

データの読み方（仕様書が無いので、サンプルからの解釈。違っていればパラメータか節 2 を直す）

- 1 ファイル = 1 つの 15 分窓の全国スナップショット。窓の開始時刻はファイル名の先頭 12 桁（JST）で取り、中の `acquisition_time` は使わない
- 1 行 = 郵便番号 × メーカー × 家電種別（`echonet_object`）。`count` はその 15 分に接続（発報）していた台数
- `echonet_object` は ECHONET Lite のオブジェクトコード（先頭 4 桁がクラス。0130 = エアコン など）。既定では全種別を合計する
- `request_code`、`disaster_judgment` は空なので使わない
- 郵便番号 → 緯度経度は GeoNames 形式のタブ区切り表（郵便番号は 490-1401 の形）。同じ郵便番号の行が複数あれば緯度経度の平均

判定

- 比 = 有事 ÷ 平時（平時が複数日なら、同じ時刻の窓の日平均）。有事にその郵便番号の行が無ければ台数 0
- 比を出すのは平時の台数が `MIN_BASE_COUNT` 以上の郵便番号だけ（それ未満は比 NaN、判定しない）
- 減少 = 比 ≤ `RATIO_LOW`、増加 = 比 ≥ `RATIO_HIGH`。`REQUIRE_ADJACENT` なら、前または後の窓でも同じ判定のときだけ異常とする（単発を除く）
''')

md("## 0. パラメータ")
code(r'''
from pathlib import Path
import json, math, re, struct, time
import numpy as np
import pandas as pd

# ---- 入出力 -------------------------------------------------------------
EVENT_DIRS    = [Path("../data/Sharp_Kaden/20250813")]        # 有事の日のフォルダ（YYYYMMDDHHMM_15M_*.csv）。日をまたぐなら複数
BASELINE_DIRS = [Path("../data/Sharp_Kaden/20250806")]        # 平時の日のフォルダ（複数なら同じ時刻の窓の日平均）
POSTAL_FILE   = Path("../data/postal/JP.txt")                 # 郵便番号 → 緯度経度（GeoNames 形式、タブ区切り、ヘッダ無し）
OUT_DIR       = Path("./kaden_out/20250813")                  # 出力先
OUT_DIR.mkdir(parents=True, exist_ok=True)
FILE_RE  = r"^(\d{12})_15M_.*\.csv$"                          # 読むファイル名と、窓の開始時刻（JST）の取り方
EVENT_FROM = None                                             # 有事の窓をこの時刻以降に絞る（"2025-08-13 12:00" など）。None = フォルダの全ファイル
EVENT_TO   = None                                             # 同じく、この時刻以前に絞る

# ---- 範囲と対象 ----------------------------------------------------------
AREA_GEOJSON = "tokyo.geojson"       # この GeoJSON の外接矩形の中の郵便番号だけを対象にする。None = 全郵便番号
BBOX = None                          # (lon_min, lat_min, lon_max, lat_max)。指定すれば AREA_GEOJSON より優先
ECHONET_OBJECTS = None               # 対象の家電種別（echonet_object の先頭 4 桁。例 ["0130"] = エアコンだけ）。None = 全種別の合計
MAKER_CODES = None                   # 対象のメーカーコード（例 ["000005"]）。None = 全部

# ---- 窓と判定 ------------------------------------------------------------
WINDOW_MIN = 15                      # ファイルの間隔 [分]
MIN_BASE_COUNT = 5.0                 # 比を出すのは平時の台数（日平均）がこれ以上の郵便番号だけ
RATIO_LOW  = 1 / 3                   # 比がこれ以下 → 減少（kind = "low"）
RATIO_HIGH = 3.0                     # 比がこれ以上 → 増加（kind = "high"）
REQUIRE_ADJACENT = True              # True: 前または後の窓でも同じ判定のときだけ異常とする

# ---- ビューワー用ラスタ（節 5） ---------------------------------------------
CELL_M = 250.0                       # 郵便番号の代表点を集計するセルの一辺 [m]。0 = ラスタを書かない
GRID_BBOX = None                     # ラスタの範囲。None = 対象範囲（BBOX / AREA_GEOJSON）、それも無ければ代表点の範囲
PARAM, LABEL, UNIT = "kaden", "接続家電数（郵便番号集計）", "台"
NODATA = -99.0

def log(msg):
    print(f"[{time.strftime('%H:%M:%S')}] {msg}", flush=True)
''')

md(r'''
## 1. 郵便番号 → 緯度経度

GeoNames 形式の表（国, 郵便番号, 地名, 都道府県, …, 緯度, 経度, 精度）を読み、郵便番号をハイフン無し 7 桁にそろえます。
同じ郵便番号の行が複数あれば緯度経度は平均、地名・市区町村名は先頭の行の値です。対象範囲（`BBOX` か `AREA_GEOJSON` の外接矩形）の中の郵便番号だけを残します。
''')
code(r'''
def read_postal(path):
    cols = ["country", "postal", "place", "admin1", "admin1_code", "admin2", "admin2_code", "admin3", "admin3_code", "lat", "lon", "accuracy"]
    df = pd.read_csv(path, sep="\t", header=None, names=cols, dtype=str, keep_default_na=False, quoting=3, encoding="utf-8")
    df["zip"] = df["postal"].str.replace("-", "", regex=False).str.strip().str.zfill(7)
    df["lat"] = pd.to_numeric(df["lat"], errors="coerce"); df["lon"] = pd.to_numeric(df["lon"], errors="coerce")
    df = df.dropna(subset=["lat", "lon"])
    return df.groupby("zip", as_index=False).agg(lat=("lat", "mean"), lon=("lon", "mean"), place=("place", "first"), city=("admin2", "first"))

def geojson_bbox(path):
    """GeoJSON の全座標の外接矩形 (lon_min, lat_min, lon_max, lat_max)"""
    g = json.load(open(path, encoding="utf-8"))
    xs, ys = [], []
    def visit(c):
        if isinstance(c[0], (int, float)):
            xs.append(c[0]); ys.append(c[1])
        else:
            for cc in c:
                visit(cc)
    for f in (g["features"] if g.get("type") == "FeatureCollection" else [g]):
        geom = f.get("geometry", f)
        for gg in (geom.get("geometries") or [geom]):
            if gg.get("coordinates") is not None:
                visit(gg["coordinates"])
    return (min(xs), min(ys), max(xs), max(ys))

bbox = tuple(BBOX) if BBOX else (geojson_bbox(AREA_GEOJSON) if AREA_GEOJSON else None)
postal_all = read_postal(POSTAL_FILE)
postal = postal_all
if bbox:
    postal = postal_all[(postal_all.lon >= bbox[0]) & (postal_all.lon <= bbox[2]) & (postal_all.lat >= bbox[1]) & (postal_all.lat <= bbox[3])]
postal = postal.reset_index(drop=True)
ZIPS, ALL_ZIPS = set(postal.zip), set(postal_all.zip)
log(f"郵便番号 {len(postal_all):,} 件のうち対象範囲 {bbox} の中は {len(postal):,} 件")
display(postal.head())
''')

md(r'''
## 2. 15 分ファイルを読む

フォルダごとに `FILE_RE` に合うファイルを時刻順に読み、メーカー・家電種別で絞ったうえで、窓 × 郵便番号の台数（`count` の合計）にします。
対象範囲の外の郵便番号は捨て、緯度経度の表に無い郵便番号は数だけ報告します。
''')
code(r'''
def read_windows(dirs, role):
    """DataFrame(window, zip, count)。role = "event" のときだけ EVENT_FROM / EVENT_TO で窓を絞る。"""
    parts, unmatched, n_rows, n_files = [], set(), 0, 0
    for d in dirs:
        files = sorted(p for p in Path(d).iterdir() if re.match(FILE_RE, p.name))
        if not files:
            raise FileNotFoundError(f"{d} に {FILE_RE} に合うファイルがありません")
        for f in files:
            w = pd.to_datetime(re.match(FILE_RE, f.name).group(1), format="%Y%m%d%H%M")
            if role == "event" and ((EVENT_FROM and w < pd.Timestamp(EVENT_FROM)) or (EVENT_TO and w > pd.Timestamp(EVENT_TO))):
                continue
            df = pd.read_csv(f, usecols=["zip_code", "maker_code", "echonet_object", "count"],
                             dtype={"zip_code": str, "maker_code": str, "echonet_object": str})
            n_rows += len(df); n_files += 1
            if MAKER_CODES:
                df = df[df["maker_code"].isin([str(m) for m in MAKER_CODES])]
            if ECHONET_OBJECTS:
                df = df[df["echonet_object"].str[:4].str.upper().isin([c.upper() for c in ECHONET_OBJECTS])]
            z = df["zip_code"].str.replace("-", "", regex=False).str.strip().str.zfill(7)
            unmatched.update(z[~z.isin(ALL_ZIPS)].unique())
            keep = z.isin(ZIPS)
            c = pd.to_numeric(df["count"], errors="coerce").fillna(0.0)[keep]
            s = c.groupby(z[keep]).sum()
            parts.append(pd.DataFrame({"window": w, "zip": s.index.to_numpy(), "count": s.to_numpy(float)}))
    out = pd.concat(parts, ignore_index=True) if parts else pd.DataFrame({"window": pd.Series(dtype="datetime64[ns]"), "zip": pd.Series(dtype=str), "count": pd.Series(dtype=float)})
    log(f"{role}: {n_files} ファイル {n_rows:,} 行 → 窓 {out.window.nunique()} × 郵便番号 {out.zip.nunique():,}（{len(out):,} 行、"
        f"緯度経度の無い郵便番号 {len(unmatched):,} 件）")
    return out, unmatched

event, unmatched_event = read_windows(EVENT_DIRS, "event")
base, unmatched_base = read_windows(BASELINE_DIRS, "baseline")
unmatched = unmatched_event | unmatched_base
if unmatched:
    print("緯度経度の表に無い郵便番号（先頭 10 件）:", sorted(unmatched)[:10])
windows = sorted(event.window.unique())
if not windows:
    raise ValueError("有事の窓がありません（EVENT_DIRS / EVENT_FROM / EVENT_TO を確認）")
''')

md(r'''
## 3. 比と判定

有事の各窓に、平時の同じ時刻（HHMM）の窓を付けます。行は平時に台数のある郵便番号（有事に行が無ければ台数 0）。
`kaden_15min.csv` に全窓 × 郵便番号の表を書きます。
''')
code(r'''
def compare(event, base):
    b = base.assign(hhmm=base.window.dt.strftime("%H%M"))
    n_days = b.groupby("hhmm").window.nunique()                                 # 時刻ごとの平時の日数
    b = b.groupby(["hhmm", "zip"], as_index=False)["count"].sum().rename(columns={"count": "baseline"})
    b["baseline"] = b["baseline"] / b["hhmm"].map(n_days).to_numpy()
    ev = event.rename(columns={"count": "event"})
    frames = []
    for w in windows:
        e = ev[ev.window == w].drop(columns="window")
        frames.append(b[b.hhmm == f"{pd.Timestamp(w):%H%M}"].drop(columns="hhmm").merge(e, on="zip", how="left").assign(window=w))
    tr = pd.concat(frames, ignore_index=True)
    tr["event"] = tr["event"].fillna(0.0)
    with np.errstate(divide="ignore", invalid="ignore"):
        tr["ratio"] = np.where(tr.baseline >= MIN_BASE_COUNT, tr.event / tr.baseline, np.nan)
    tr["is_target"] = tr.baseline >= MIN_BASE_COUNT
    tr["low"] = tr.ratio <= RATIO_LOW
    tr["high"] = tr.ratio >= RATIO_HIGH
    tr = tr.sort_values(["zip", "window"]).reset_index(drop=True)
    g = tr.groupby("zip").window
    prev_adj = (tr.window - g.shift(1)) == pd.Timedelta(minutes=WINDOW_MIN)
    next_adj = (g.shift(-1) - tr.window) == pd.Timedelta(minutes=WINDOW_MIN)
    for c in ("low", "high"):
        fg = tr[c].groupby(tr.zip)
        adj = (fg.shift(1, fill_value=False) & prev_adj) | (fg.shift(-1, fill_value=False) & next_adj)
        tr[f"{c}_anomaly"] = tr[c] & adj if REQUIRE_ADJACENT else tr[c]
    tr["kind"] = np.where(tr.low_anomaly, "low", np.where(tr.high_anomaly, "high", ""))
    tr["anomaly"] = tr.kind != ""
    tr = tr.merge(postal[["zip", "lat", "lon", "place", "city"]], on="zip", how="left")
    return tr[["window", "zip", "city", "place", "lat", "lon", "baseline", "event", "ratio", "is_target", "low", "high", "kind", "anomaly"]]

err = compare(event, base)
err.to_csv(OUT_DIR / "kaden_15min.csv", index=False)
log(f"窓 {len(windows)} × 郵便番号 → {len(err):,} 行（対象 {int(err.is_target.sum()):,}、減少 {int((err.kind == 'low').sum()):,}、増加 {int((err.kind == 'high').sum()):,}）→ {OUT_DIR / 'kaden_15min.csv'}")
summary = err.groupby("window").agg(zips=("zip", "size"), target=("is_target", "sum"), low=("kind", lambda s: int((s == "low").sum())),
                                    high=("kind", lambda s: int((s == "high").sum())), baseline=("baseline", "sum"), event=("event", "sum")).round(1)
display(summary)
''')

md(r'''
## 4. 窓ごとの異常 GeoJSON（点）

`anomaly/kaden_anomaly_YYYYMMDD_HHMM.geojson`（YYYYMMDD_HHMM = 窓の開始時刻）。地物は郵便番号の代表点（Point）で、属性は
zip（123-4567 の形）, city, place, timestamp, baseline, event, ratio, kind（"low" / "high"）。該当が無い窓も空の FeatureCollection を書きます。
''')
code(r'''
ANOM_DIR = OUT_DIR / "anomaly"; ANOM_DIR.mkdir(exist_ok=True)
for old in ANOM_DIR.glob(f"{PARAM}_anomaly_*.geojson"):
    old.unlink()
counts = []
for w in windows:
    part = err[(err.window == w) & err.anomaly]
    feats = [{"type": "Feature",
              "properties": {"zip": f"{r.zip[:3]}-{r.zip[3:]}", "city": r.city, "place": r.place, "timestamp": f"{pd.Timestamp(w):%Y-%m-%dT%H:%M:%S}",
                             "baseline": round(float(r.baseline), 2), "event": round(float(r.event), 2), "ratio": round(float(r.ratio), 4), "kind": r.kind},
              "geometry": {"type": "Point", "coordinates": [round(float(r.lon), 6), round(float(r.lat), 6)]}}
             for r in part.itertuples()]
    with open(ANOM_DIR / f"{PARAM}_anomaly_{pd.Timestamp(w):%Y%m%d_%H%M}.geojson", "w", encoding="utf-8") as f:
        json.dump({"type": "FeatureCollection", "name": f"{PARAM}_anomaly_{pd.Timestamp(w):%Y%m%d_%H%M}",
                   "properties": {"timestamp": f"{pd.Timestamp(w):%Y-%m-%dT%H:%M:%S}", "window_min": WINDOW_MIN, "min_base_count": MIN_BASE_COUNT,
                                  "ratio_low": RATIO_LOW, "ratio_high": RATIO_HIGH, "require_adjacent": REQUIRE_ADJACENT},
                   "features": feats}, f, ensure_ascii=False)
    counts.append({"window": w, "low": int((part.kind == "low").sum()), "high": int((part.kind == "high").sum())})
counts = pd.DataFrame(counts).set_index("window")
log(f"wrote {len(counts)} files to {ANOM_DIR}（減少 {int(counts.low.sum()):,}、増加 {int(counts.high.sum()):,} 郵便番号・窓）")
display(counts[(counts.low > 0) | (counts.high > 0)])
''')

md(r'''
## 5. ビューワー用ラスタ（任意）

郵便番号の代表点を `CELL_M` のセルに集計し（同じセルに複数の郵便番号が入れば台数の合計）、
`grid_kaden/kaden_baseline_HHMM.tif` / `kaden_event_HHMM.tif`（台数、nodata −99）と `kaden_HHMM.tif`（有事 ÷ 平時。平時 `MIN_BASE_COUNT` 未満は NaN）、
`index.json` を書きます。ビューワーのグリッドタブで入力 6 にこのフォルダを選ぶと、スライダーの時刻のラスタが表示されます。
ラスタの名前は時刻（HHMM）だけなので、有事の窓は 24 時間以内に収めてください（超えると同じ名前が 2 回出るので止まります）。
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
        col = np.floor((np.asarray(lon, float) - self.west) / self.dx); row = np.floor((self.north - np.asarray(lat, float)) / self.dy)
        ok = (col >= 0) & (col < self.ncol) & (row >= 0) & (row < self.nrow)
        return np.where(ok, row * self.ncol + col, -1).astype(np.int64)

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

if CELL_M and CELL_M > 0:
    labels = [f"{pd.Timestamp(w):%H:%M}" for w in windows]
    if len(set(labels)) < len(labels):
        raise ValueError("有事の窓が 24 時間を超えていて同じ時刻が 2 回出ます。EVENT_FROM / EVENT_TO で 24 時間以内に絞ってください")
    gb = tuple(GRID_BBOX) if GRID_BBOX else (bbox or (postal.lon.min(), postal.lat.min(), postal.lon.max(), postal.lat.max()))
    mesh = Mesh(gb, CELL_M)
    zip_cell = pd.Series(mesh.cell(postal.lon.to_numpy(), postal.lat.to_numpy()), index=postal.zip)
    GRID_DIR = OUT_DIR / f"grid_{PARAM}"; GRID_DIR.mkdir(exist_ok=True)
    for old in GRID_DIR.glob(f"{PARAM}_*.tif"):
        old.unlink()
    files = []
    for w, lab in zip(windows, labels):
        part = err[err.window == w]
        c = part.zip.map(zip_cell).to_numpy(); m = c >= 0
        b = np.zeros(mesh.nrow * mesh.ncol, dtype=np.float64); e = np.zeros_like(b)
        np.add.at(b, c[m], part.baseline.to_numpy()[m]); np.add.at(e, c[m], part.event.to_numpy()[m])
        hhmm = lab.replace(":", "")
        for role, arr in (("baseline", b), ("event", e)):
            name = f"{PARAM}_{role}_{hhmm}.tif"
            write_geotiff(GRID_DIR / name, arr.reshape(mesh.nrow, mesh.ncol).astype(np.float32), mesh.west, mesh.north, mesh.dx, mesh.dy, NODATA); files.append(name)
        with np.errstate(divide="ignore", invalid="ignore"):
            ratio = np.where(b >= MIN_BASE_COUNT, e / b, np.nan).astype(np.float32)
        name = f"{PARAM}_{hhmm}.tif"
        write_geotiff(GRID_DIR / name, ratio.reshape(mesh.nrow, mesh.ncol), mesh.west, mesh.north, mesh.dx, mesh.dy, float("nan")); files.append(name)
    n_base_days = int(base.window.dt.normalize().nunique()); n_event_days = int(pd.DatetimeIndex(windows).normalize().nunique())
    index = {"cell_m": CELL_M, "bounds": [mesh.west, mesh.south, mesh.east, mesh.north], "width": mesh.ncol, "height": mesh.nrow,
             "dx": mesh.dx, "dy": mesh.dy, "nodata": "nan", "count_nodata": NODATA, "params": [PARAM],
             "labels": {PARAM: LABEL}, "units": {PARAM: UNIT}, "window_min": WINDOW_MIN, "slot_min": WINDOW_MIN,
             "slots": labels, "roles": ["baseline", "event"], "days": {"baseline": n_base_days, "event": n_event_days},
             "min_base_count": MIN_BASE_COUNT, "echonet_objects": ECHONET_OBJECTS, "maker_codes": MAKER_CODES,
             "values": f"{PARAM}_<role>_<HHMM>: 郵便番号の代表点をセルに集計した接続家電数（平時は日平均）; {PARAM}_<HHMM>: 有事 / 平時（平時 {MIN_BASE_COUNT:g} 台未満は NaN）",
             "files": files}
    with open(GRID_DIR / "index.json", "w", encoding="utf-8") as f:
        json.dump(index, f, ensure_ascii=False, indent=1)
    log(f"wrote {len(files)} rasters to {GRID_DIR}（{mesh.ncol} x {mesh.nrow} セルの {CELL_M:g} m、{len(labels)} スロット）")
else:
    print("CELL_M = 0 なのでラスタは書きません")
''')

nb = {"cells": cells, "metadata": {"kernelspec": {"display_name": "Python 3", "language": "python", "name": "python3"},
      "language_info": {"name": "python"}}, "nbformat": 4, "nbformat_minor": 5}
out = Path(__file__).parent / "kaden_compare.ipynb"
json.dump(nb, open(out, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
print("wrote", out, len(cells), "cells")
