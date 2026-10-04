"""Builds truck_traffic.ipynb (cell by cell) from the cell sources below.  python3 build_truck_traffic_nb.py"""
import json
from pathlib import Path

cells = []
def md(s): cells.append({"cell_type": "markdown", "metadata": {}, "source": s.strip("\n").splitlines(keepends=True)})
def code(s): cells.append({"cell_type": "code", "metadata": {}, "execution_count": None, "outputs": [], "source": s.strip("\n").splitlines(keepends=True)})

md(r'''
# トラックプローブ → 15 分・道路リンク別の交通量・速度

1 秒毎のトラックプローブ（zip 内の CSV。ファイルは時間で分かれていなくてもよい）を TomTom 道路ネットワークに
動的計画法で割り付け、15 分ウィンドウ × 道路リンク別の車両数（Hits）と平均速度（AvgSp）を出力します。

処理の流れ（それぞれ 1 節 = 1 ステップ。前の節の出力ファイルから再開できる）

| 節 | 処理 | 出力 |
|---|---|---|
| 1 | ネットワーク集約: 形状が同じリンクを 1 本にし、ノードと隣接表・近傍表を作る | `network_agg.csv` / `.shp` |
| 2 | **1 回目の読み込み**: 全ファイルを走査し、指定エリアを通過した車両 ID を特定する | `vehicles_in_area.csv` |
| 3 | **2 回目の読み込み**: 通過車両の点だけを抜き出し、1 つの軌跡ファイルにまとめる（車両・時刻順） | `trajectories.*` |
| 4 | 軌跡ファイルを読み、車両ごとに点列を間引いて候補リンクを付ける（step 5-1） | – |
| 5 | 動的計画法（Viterbi）で各点列の走行経路を決める（step 5-2, 5-3） | – |
| 6 | 経路に沿った道のりで各点の位置を決め、1 秒毎の各点に「その時刻にいた道路リンク」を付ける。リンクごとの進入・退出時刻を前後の点から補間する | `matched_points.*`, `link_stays.*` |
| 7 | 15 分ウィンドウ × リンクで車両数・速度を集計する | `traffic_YYYYMMDD_HHMM.csv`, `traffic_15min.csv` |
| 8 | 直近 1 時間の軌跡を 15 分毎の GeoJSON に書く（ビューワー用、任意） | `traj/` |

`*` の拡張子は、pyarrow があれば `.parquet`、無ければ `.csv.gz` です。

書き方の方針: 1 セル 1 ステップ、関数は短く、DataFrame は列の意味がわかる名前で持つ。速度が要る所（Viterbi、近傍表、ID の集計）は
Python の辞書・リストと numpy で書き、pandas は読み込み・結合・集計に使う。

必要なライブラリ: geopandas, shapely 2.x, pyproj, pandas, numpy（pyarrow は任意）。

仕様に無い追加・解釈（すべてパラメータ化）

| 項目 | 内容 |
|---|---|
| 通過判定 | 1 点でもエリアのポリゴン内にあれば通過車両。エリア指定が無ければ全車両 |
| 抽出範囲 | 通過車両の点のうち、リンクの範囲（エリアの外接矩形 +1 km）内のもの |
| 点列の切れ目 | 車両が変わる所、`GAP_S`（120 秒）を超える欠測、候補リンクの無い点 |
| 間引き | 軌跡に沿って `SAMPLE_M`（30 m）進むか `SAMPLE_MAX_S`（60 秒）経つごとに 1 点。速度の付与には間引く前の全点を使う |
| 候補 | 点から `CAND_R_M`（50 m）以内で近い順に `CAND_MAX`（5）本。間引き後 `MIN_SEQ_POINTS`（3）点未満の区間は使わない |
| 接続 | ノードを共有する隣接だけでなく、網の距離 `D_MAX_M`（250 m）以内で届くリンクも接続扱い（短いリンクを飛び越えるため）。間のリンクも経路に入り、進入・退出時刻を補間で持つ |
| 停車 | ウィンドウ内の最高速度が `MOVING_KMH`（3 km/h）未満の車両は駐停車とみなし、そのウィンドウでは車両数に数えない |
| 出力の Id | 集約後の代表 Id（メンバー中の最小 Id）。観測の無いリンクは行を持たない |
''')

md("## 0. パラメータ")
code(r'''
from pathlib import Path
import heapq
import json, re, time, zipfile
import numpy as np
import pandas as pd
import geopandas as gpd
import shapely
from shapely.strtree import STRtree
from pyproj import Transformer

# ---- 入出力 -------------------------------------------------------------
NETWORK_SHP = Path("../data/Flooding_2025/post/network.shp")   # TomTom 道路ネットワーク（既出の shp）
PROBE_ZIP   = Path("../data/truck_probe.zip")                   # プローブ CSV を格納した zip（解凍しない。分割の単位は問わない）
MEMBER_RE   = r"\.(csv|txt)(\.gz)?$"                            # zip 内で読む対象ファイル名（正規表現、大文字小文字無視）
OUT_DIR     = Path("./traffic_out")                             # 出力先
OUT_DIR.mkdir(parents=True, exist_ok=True)
AREA_GEOJSON = None                                             # 通過判定に使う区域 GeoJSON（例 "./tokyo.geojson"）。None = 全車両
CHUNK_ROWS = 2_000_000                                          # CSV を一度に読む行数（メモリに合わせて）

# ---- 入力 CSV の列名（サンプルに合わせてある） ---------------------------
COL_ID, COL_TIME, COL_SPEED, COL_LAT, COL_LON = "serial_number", "record_time", "speed", "gps_latitude", "gps_longitude"

# ---- 集計 ---------------------------------------------------------------
WINDOW_MIN = 15               # 集計ウィンドウ [分]
MOVING_KMH = 3.0              # ウィンドウ内の最高速度がこれ未満の車両は停車中（駐車）とみなし、交通として数えない

# ---- step 5-1: 点列・間引き・候補リンク ----------------------------------
GAP_S = 120.0                 # これを超える欠測 [秒] で点列を切る
SAMPLE_M = 30.0               # 前に残した点からこれだけ [m] 進んだら次の点を残す
SAMPLE_MAX_S = 60.0           # 動かなくても、これだけ [秒] 経ったら点を残す（停車中の車両も列に残す）
CAND_R_M = 50.0               # 候補リンクは点からこの距離 [m] 以内
CAND_MAX = 5                  # 候補リンクは近い順にこの本数まで
MIN_SEQ_POINTS = 3            # 間引き後の点がこれ未満の区間は使わない

# ---- step 5-2, 5-3: コスト -----------------------------------------------
SIGMA_M = 15.0                # 観測コスト = (点からリンクまでの距離 / SIGMA_M)^2  … GPS 誤差の想定幅
C_SWITCH = 1.0                # 接続リンクへの乗り換え 1 本あたりのコスト
LAMBDA = 2.0                  # |経路距離 − 直線距離| / 直線距離 に掛ける係数
D_MAX_M = 250.0               # 網の距離でこれ以内のリンクを「接続」とみなす（間引き間隔で動ける距離より大きく）

# ---- step 8: 直近 1 時間の軌跡（15 分毎、任意） ----------------------------
TRAJ_OUT = True               # traj/traj_YYYYMMDD_HHMM.geojson を書くか（HHMM = 窓の終端。窓は (T-60 分, T]）
TRAJ_WINDOW_MIN = 60          # 軌跡の窓 [分]
TRAJ_GAP_MIN = 5.0            # この分数を超える欠測で軌跡を切る
TRAJ_SIMPLIFY_M = 5.0         # 軌跡の間引き（Douglas-Peucker の許容誤差 [m]）
TRAJ_MIN_LEN_M = 10.0         # これより短い軌跡（駐車中など）は書かない

def log(msg):
    print(f"[{time.strftime('%H:%M:%S')}] {msg}", flush=True)

# 中間ファイルの読み書き（pyarrow があれば parquet、無ければ csv.gz）
try:
    import pyarrow  # noqa: F401
    TABLE_EXT = ".parquet"
except ImportError:
    TABLE_EXT = ".csv.gz"

def write_table(df, stem):
    path = OUT_DIR / f"{stem}{TABLE_EXT}"
    if TABLE_EXT == ".parquet":
        df.to_parquet(path, index=False)
    else:
        df.to_csv(path, index=False)
    log(f"wrote {path} ({len(df):,} rows)")
    return path

def read_table(stem):
    path = OUT_DIR / f"{stem}{TABLE_EXT}"
    df = pd.read_parquet(path) if TABLE_EXT == ".parquet" else pd.read_csv(path, dtype={"serial_number": str})
    if "t" in df.columns:
        df["t"] = pd.to_datetime(df["t"])
    return df
''')

md(r'''
## 0b. 範囲（任意）

`AREA_GEOJSON` を与えると、その全ポリゴンの和集合を「通過判定の区域」にします。CRS が JGD2011（EPSG:6668）の場合も、経緯度としては
WGS84 と実質同じなのでそのまま使います。リンクは区域の外接矩形（+1 km）内だけを使い、軌跡の抽出もその範囲に限ります。
''')
code(r'''
AREA = None
if AREA_GEOJSON:
    a = gpd.read_file(AREA_GEOJSON)
    if a.crs is not None and a.crs.to_epsg() not in (4326, 6668):
        a = a.to_crs("EPSG:4326")
    AREA = a.geometry.union_all() if hasattr(a.geometry, "union_all") else a.geometry.unary_union
    print(f"範囲: {AREA_GEOJSON} ({len(a)} 地物, CRS {a.crs}) → 外接矩形 {tuple(round(v, 5) for v in AREA.bounds)}, "
          f"面積 {AREA.area * 111.0 * 111.0 * np.cos(np.radians(AREA.centroid.y)):.1f} km2")
else:
    print("範囲の指定なし（全車両・全リンク）")
''')

md(r'''
## 1. ネットワーク集約（step 1）

TomTom の shp には、形状が完全に同じリンクが複数のオブジェクトとして入っていることがあります（反対車線は同一オブジェクトですが、
セグメント境界などで重複が生じる）。座標列が同じ（向きが逆でも同じ）ものを 1 本に統合し、代表 `Id`（メンバー中の最小 Id）と
メンバー一覧 `member_ids` を持つリンクテーブルを作ります。属性は `Length` は先頭、`SpeedLimit` は最大、`FRC` は最小、
その他の列（`Segment Id`, `NewSegId`, `StreetName` など）は先頭のメンバーの値を採用します。

距離計算のため、以降はメートル単位の投影座標系（UTM、`estimate_utm_crs`）で扱います。
''')
code(r'''
net = gpd.read_file(NETWORK_SHP)
if net.crs is None:
    net = net.set_crs("EPSG:4326")
print("CRS:", net.crs, "/ links:", len(net), "/", net.geom_type.value_counts().to_dict())
net = net[net.geometry.notna() & ~net.geometry.is_empty].copy()
net["geometry"] = shapely.line_merge(net.geometry.values)      # MultiLineString → つながれば LineString
net["Id"] = net["Id"].astype("int64")

# 形状キー: 座標列を 1e-7 度（約 1 cm）で丸めたバイト列。逆向きは同じキーにする
def shape_key(geom):
    c = np.round(shapely.get_coordinates(geom), 7)
    f = c.tobytes(); r = c[::-1].tobytes()
    return f if f <= r else r
net["shape_key"] = net.geometry.apply(shape_key)

fixed = {"Id": ("Id", "min"), "n_members": ("Id", "size"), "member_ids": ("Id", lambda s: ";".join(map(str, s))),
         "Length": ("Length", "first"), "FRC": ("FRC", "min"), "SpeedLimit": ("SpeedLimit", "max"), "geometry": ("geometry", "first")}
others = {c: (c, "first") for c in net.columns if c not in fixed and c not in ("Id", "shape_key")}
agg = net.sort_values("Id").groupby("shape_key", sort=False).agg(**fixed, **others).reset_index(drop=True)
links = gpd.GeoDataFrame(agg, geometry="geometry", crs=net.crs).sort_values("Id").reset_index(drop=True)
if AREA is not None:                          # 範囲の外接矩形 +1 km に掛かるリンクだけ
    x0, y0, x1, y1 = AREA.bounds; pad = 0.01
    n_all = len(links)
    links = links.cx[x0 - pad:x1 + pad, y0 - pad:y1 + pad].reset_index(drop=True)
    print(f"範囲で絞り込み: {n_all} → {len(links)} リンク")
links["link_idx"] = np.arange(len(links))     # 以降の内部インデックス（0..n-1）

CRS_M = links.estimate_utm_crs()
links_m = links.to_crs(CRS_M)
links["len_geom_m"] = links_m.length          # 形状から計算した長さ（Length 属性の確認用）
print(f"集約: {len(net)} → {len(links)} リンク（重複していたグループ {int((links.n_members > 1).sum())}、"
      f"最大メンバー数 {int(links.n_members.max())}）/ 投影: {CRS_M.to_string()}")
chk = links[links.Length > 0]
print("Length 属性と形状長の比の分布:", (chk.len_geom_m / chk.Length).describe().round(3).to_dict())
display(links.drop(columns="geometry").head())
''')

md(r'''
### リンクテーブルの出力と検索用の準備

`network_agg.csv`（全属性 + `member_ids`）と `network_agg.shp`（形状付き。shp の文字列列は 254 文字までなので `member_ids` は
含めず `n_members` のみ）を書きます。点に付けるリンク属性は `LINK_ATTR` の列です。
''')
code(r'''
grp = net.groupby("shape_key")
incons = {c: int((grp[c].nunique() > 1).sum()) for c in ["Length", "FRC", "SpeedLimit", "StreetName"] if c in net.columns}
print("メンバー間で属性が異なるグループ数:", incons)

links_out = links.drop(columns=["link_idx"])
links_out.drop(columns="geometry").to_csv(OUT_DIR / "network_agg.csv", index=False)
links_out.drop(columns=["member_ids"]).to_file(OUT_DIR / "network_agg.shp")
print("wrote", OUT_DIR / "network_agg.csv", "and network_agg.shp")

# 候補検索用の空間インデックス（投影座標）、座標変換、点に付ける属性
GEOM = links_m.geometry.values
LEN = links_m.length.to_numpy()
tree = STRtree(GEOM)
to_m = Transformer.from_crs("EPSG:4326", CRS_M, always_xy=True)
from_m = Transformer.from_crs(CRS_M, "EPSG:4326", always_xy=True)
LINK_ATTR = links[["Id"] + [c for c in ["StreetName", "FRC", "SpeedLimit", "Length"] if c in links.columns]].copy()
LINK_BOUNDS = links.total_bounds + np.array([-1, -1, 1, 1]) * 0.001   # 軌跡を抽出する範囲 (lon_min, lat_min, lon_max, lat_max) + 約 100 m（CAND_R_M の余裕）
''')

md(r'''
### グラフ（ノード・隣接・近傍表）

リンクの両端点を 0.1 m で丸めてノードにし、ノード → リンクの隣接表を作ります（TomTom のリンク端点は交差点で一致している前提。
反対車線は同一オブジェクトなので無向グラフ）。

「接続リンク」は、ノードを共有する隣接だけでなく、網の距離 `D_MAX_M` 以内で届くリンクも含めます（短いリンクを点が飛び越えるため）。
リンク L の近傍表 `neighbourhood(L)` は、L の両端から有界ダイクストラで求めた
`{L2: (間のリンク長の合計, L から出る端 0/1, L2 に入る端 0/1, 間のリンク列)}` で、初回に計算して辞書にキャッシュします。
''')
code(r'''
n_links = len(links_m)
U = np.empty(n_links, dtype=np.int64); V = np.empty(n_links, dtype=np.int64)     # 各リンクの始点・終点ノード
node_of = {}
for i, g in enumerate(GEOM):
    c = shapely.get_coordinates(g)
    for k, (x, y) in enumerate((c[0], c[-1])):
        key = (round(float(x), 1), round(float(y), 1))
        if key not in node_of:
            node_of[key] = len(node_of)
        (U if k == 0 else V)[i] = node_of[key]
n_nodes = len(node_of)
ADJ = [[] for _ in range(n_nodes)]                                                 # ノード → 接続リンク
for i in range(n_links):
    ADJ[U[i]].append(i)
    if V[i] != U[i]:
        ADJ[V[i]].append(i)
deg = np.array([len(a) for a in ADJ])
print(f"ノード {n_nodes:,}、リンク {n_links:,}、行き止まり（次数 1）{int((deg == 1).sum()):,}、次数の最大 {int(deg.max())}")

_NBR = {}
def neighbourhood(L):
    """L から網の距離 D_MAX_M 以内で届くリンク → (between_len, exit_end, entry_end, path)。
    between_len は L と L2 の間にあるリンクの長さの合計、path はそのリンク列（L, L2 は含まない）。"""
    r = _NBR.get(L)
    if r is not None:
        return r
    res = {}
    heap = [(0.0, int(U[L]), 0, ()), (0.0, int(V[L]), 1, ())]
    seen = {}
    while heap:
        d, n, ex, path = heapq.heappop(heap)
        if seen.get(n, np.inf) <= d:
            continue
        seen[n] = d
        for L2 in ADJ[n]:
            if L2 == L:
                continue
            entry = 0 if U[L2] == n else 1
            if L2 not in res or res[L2][0] > d:
                res[L2] = (d, ex, entry, path)
            nd = d + LEN[L2]
            if nd <= D_MAX_M:
                heapq.heappush(heap, (nd, int(V[L2] if entry == 0 else U[L2]), ex, path + (L2,)))
    _NBR[L] = res
    return res

nb0 = neighbourhood(0)
print(f"例: リンク {int(links.Id[0])} の接続リンク {len(nb0)} 本（D_MAX_M = {D_MAX_M:g} m）:",
      {int(links.Id[k]): (round(float(v[0]), 1), len(v[3])) for k, v in list(nb0.items())[:6]})
''')

md(r'''
## 2. 1 回目の読み込み: エリアを通過した車両 ID（step 2）

zip の全ファイルを `CHUNK_ROWS` 行ずつ読み、緯度経度が区域ポリゴンの中にある点を持つ車両を集めます。
この段階で読むのは ID・緯度・経度の 3 列だけです。結果は `vehicles_in_area.csv`（車両 ID と区域内の点数。ID を含むので共有しない）に書きます。
あわせて、行数と欠損（緯度経度が無い行）をファイルごとに数えます。区域の指定が無ければ、全車両が対象です。
''')
code(r'''
zf = zipfile.ZipFile(PROBE_ZIP)
members = sorted(n for n in zf.namelist()
                 if re.search(MEMBER_RE, n, re.I) and not n.startswith("__MACOSX/") and not Path(n).name.startswith("._"))
print(f"{PROBE_ZIP}: {len(members)} files")
for n in members[:5]:
    print("  ", n, f"{zf.getinfo(n).file_size / 1e6:.1f} MB")
if len(members) > 5:
    print("   …")

def chunks(name, cols):
    """zip 内の 1 ファイルを cols の列だけ CHUNK_ROWS 行ずつ読む（解凍しない）。"""
    comp = "gzip" if name.lower().endswith(".gz") else None
    with zf.open(name) as f:
        for ch in pd.read_csv(f, usecols=cols, dtype={COL_ID: str}, compression=comp, chunksize=CHUNK_ROWS):
            yield ch

def inside_area(lon, lat):
    """各点が区域内か（numpy の bool 配列）。区域が無ければ全部 True。欠損は False。"""
    ok = ~np.isnan(lon) & ~np.isnan(lat)
    if AREA is None:
        return ok
    x0, y0, x1, y1 = AREA.bounds
    ok &= (lon >= x0) & (lon <= x1) & (lat >= y0) & (lat <= y1)      # まず外接矩形で粗く
    idx = np.flatnonzero(ok)
    ok[idx] = shapely.contains_xy(AREA, lon[idx], lat[idx])         # 残りをポリゴンで厳密に
    return ok

t_all = time.perf_counter()
points_in_area = {}            # 車両 ID → 区域内の点数（辞書で足し込む）
scan = []                      # ファイルごとの行数・欠損
for k, name in enumerate(members, 1):
    t0 = time.perf_counter(); rows = n_na = n_in = 0
    try:
        for ch in chunks(name, [COL_ID, COL_LAT, COL_LON]):
            lon = pd.to_numeric(ch[COL_LON], errors="coerce").to_numpy(dtype=float)
            lat = pd.to_numeric(ch[COL_LAT], errors="coerce").to_numpy(dtype=float)
            rows += len(ch); n_na += int((np.isnan(lon) | np.isnan(lat)).sum())
            ok = inside_area(lon, lat)
            n_in += int(ok.sum())
            for vid, c in ch[COL_ID][ok].value_counts().items():                  # この塊の車両別の区域内点数を辞書に足す
                points_in_area[vid] = points_in_area.get(vid, 0) + int(c)
        scan.append({"file": name, "rows": rows, "no_latlon": n_na, "points_in_area": n_in, "error": ""})
        log(f"[{k}/{len(members)}] {name}: {rows:,} rows, 緯度経度なし {n_na:,}, 区域内 {n_in:,} ({time.perf_counter() - t0:.1f} s)")
    except Exception as e:
        scan.append({"file": name, "error": f"{type(e).__name__}: {e}"})
        log(f"[{k}/{len(members)}] {name}: skipped ({type(e).__name__}: {e})")

vehicles = pd.DataFrame(sorted(points_in_area.items()), columns=["serial_number", "n_points_in_area"])
vehicles.to_csv(OUT_DIR / "vehicles_in_area.csv", index=False)
VCODE = {vid: i for i, vid in enumerate(vehicles.serial_number)}      # 車両 ID → 内部番号（以降は番号で持つ）
SERIAL = vehicles.serial_number.to_numpy()                           # 内部番号 → 車両 ID
scan = pd.DataFrame(scan)
log(f"1 回目: {len(members)} ファイル、{int(scan.rows.sum()):,} 行、通過車両 {len(VCODE):,} 台 ({time.perf_counter() - t_all:.0f} s)")
display(scan)
''')

md(r'''
## 3. 2 回目の読み込み: 通過車両の軌跡を 1 ファイルに（step 3）

もう一度全ファイルを読み、通過車両の行だけを残します。時刻の解釈と欠損の除去は、残した行に対してだけ行います
（全行に対して行うより速い）。リンクの範囲 `LINK_BOUNDS` の外の点は、どのリンクにも付かないので落とします。
同一車両・同一秒の重複は 1 行にし、車両・時刻順に並べて `trajectories.*` に書きます。
以降の節はこのファイルだけを入力にするので、ここまで済んでいれば zip を再読込せずに続きから実行できます。
''')
code(r'''
def parse_time(s):
    try:
        return pd.to_datetime(s, format="ISO8601", errors="coerce")   # "YYYY-MM-DD HH:MM:SS"（小数秒や T 区切りも可）
    except (TypeError, ValueError):                                    # 古い pandas
        return pd.to_datetime(s, errors="coerce")

t_all = time.perf_counter()
VSET = set(VCODE)
parts, n_sel, n_bad, n_out = [], 0, 0, 0
x0, y0, x1, y1 = LINK_BOUNDS
for k, name in enumerate(members, 1):
    t0 = time.perf_counter(); n_file = 0
    try:
        for ch in chunks(name, [COL_ID, COL_TIME, COL_SPEED, COL_LAT, COL_LON]):
            ch = ch[ch[COL_ID].isin(VSET)]
            if ch.empty:
                continue
            n_sel += len(ch)
            df = pd.DataFrame({"vcode": ch[COL_ID].map(VCODE).to_numpy(dtype=np.int32),
                               "t": parse_time(ch[COL_TIME]),
                               "lat": pd.to_numeric(ch[COL_LAT], errors="coerce"),
                               "lon": pd.to_numeric(ch[COL_LON], errors="coerce"),
                               "speed": pd.to_numeric(ch[COL_SPEED], errors="coerce")})
            ok = df.t.notna() & df.lat.notna() & df.lon.notna() & df.speed.notna()
            n_bad += int((~ok).sum()); df = df[ok]
            inb = (df.lon >= x0) & (df.lon <= x1) & (df.lat >= y0) & (df.lat <= y1)
            n_out += int((~inb).sum()); df = df[inb]
            parts.append(df); n_file += len(df)
        log(f"[{k}/{len(members)}] {name}: 通過車両の点 {n_file:,} ({time.perf_counter() - t0:.1f} s)")
    except Exception as e:
        log(f"[{k}/{len(members)}] {name}: skipped ({type(e).__name__}: {e})")

traj = pd.concat(parts, ignore_index=True) if parts else pd.DataFrame(columns=["vcode", "t", "lat", "lon", "speed"])
del parts
n0 = len(traj)
traj = traj.drop_duplicates(["vcode", "t"]).sort_values(["vcode", "t"], kind="stable").reset_index(drop=True)
log(f"2 回目: 通過車両の行 {n_sel:,} → 欠損 {n_bad:,}、リンク範囲外 {n_out:,}、重複 {n0 - len(traj):,} を除いて {len(traj):,} 点 "
    f"/ {traj.vcode.nunique():,} 台 / {traj.t.min()} – {traj.t.max()} ({time.perf_counter() - t_all:.0f} s)")
write_table(traj.assign(serial_number=SERIAL[traj.vcode.to_numpy()])[["serial_number", "t", "lat", "lon", "speed"]], "trajectories")
display(traj.head())
''')

md(r'''
## 4. 間引きと候補リンク（step 5-1）

ここからは軌跡ファイルだけを使います（セル 2・3 を飛ばして再開するときは、このセルが `trajectories.*` を読みます）。

車両ごとに点列を作り、`GAP_S` を超える欠測で切ります。点列は軌跡に沿って `SAMPLE_M` 進むごと、または `SAMPLE_MAX_S` 経つごとに
1 点に間引きます（1 秒毎の点は情報がほぼ重複しているので、経路の推定には間引いた点で足ります）。

間引いた各点について `CAND_R_M` 以内のリンクを STRtree で一括検索し、近い順に `CAND_MAX` 本を候補にします。
候補ごとに、点からリンクまでの距離 `dist` と、リンク上の位置 `pos`（始点からの距離。経路距離の計算に使う）を持ちます。
候補が 1 本も無い点（道路から `CAND_R_M` 以上離れた点）は点列の切れ目にします。
''')
code(r'''
if "traj" not in globals():                                      # セル 2・3 を飛ばして再開するとき
    traj = read_table("trajectories")
    vehicles = pd.DataFrame({"serial_number": sorted(traj.serial_number.unique())})
    VCODE = {vid: i for i, vid in enumerate(vehicles.serial_number)}; SERIAL = vehicles.serial_number.to_numpy()
    traj["vcode"] = traj.serial_number.map(VCODE).astype(np.int32)
    traj = traj.drop(columns="serial_number").sort_values(["vcode", "t"], kind="stable").reset_index(drop=True)
traj["x"], traj["y"] = to_m.transform(traj["lon"].to_numpy(), traj["lat"].to_numpy())

def downsample(df):
    """車両ごと（GAP_S を超える欠測で切る）の間引き。残した点だけの DataFrame（連番 index、列 seq0 = 点列番号）を返す。"""
    x, y = df.x.to_numpy(), df.y.to_numpy()
    t = df.t.to_numpy().astype("datetime64[s]").astype(np.int64)
    v = df.vcode.to_numpy()
    new = np.r_[True, (v[1:] != v[:-1]) | (np.diff(t) > GAP_S)]              # 点列の先頭
    grp = np.cumsum(new) - 1
    step = np.r_[0.0, np.hypot(np.diff(x), np.diff(y))]; step[new] = 0.0
    cum = np.cumsum(step); cum = cum - cum[new][grp]                        # 軌跡に沿った累積距離（点列内）
    el = t - t[new][grp]                                                     # 経過秒（点列内）
    bd, bt = np.floor(cum / SAMPLE_M), np.floor(el / SAMPLE_MAX_S)
    keep = new | np.r_[False, (bd[1:] != bd[:-1]) | (bt[1:] != bt[:-1])]   # 30 m 刻み・60 秒刻みの境界を越えた最初の点
    s = df[keep].reset_index(drop=True)
    s["seq0"] = grp[keep]
    return s

def candidates(s):
    """間引き後の各点の候補リンク。列: row（s の行番号）, link, dist, pos。点ごとに近い順、最大 CAND_MAX 本。"""
    pts = shapely.points(s.x.to_numpy(), s.y.to_numpy())
    pi, li = tree.query(pts, predicate="dwithin", distance=CAND_R_M)
    c = pd.DataFrame({"row": pi, "link": li})
    c["dist"] = shapely.distance(pts[pi], GEOM[li])
    c["pos"] = shapely.line_locate_point(GEOM[li], pts[pi])
    c = c.sort_values(["row", "dist"], kind="stable")
    c = c[c.groupby("row").cumcount() < CAND_MAX].reset_index(drop=True)
    return c

def sequences(s, cand):
    """点列番号 seq（seq0 をさらに候補の無い点で切る）と、1 つ前の点との直線距離 straight を s に付ける。"""
    has = np.zeros(len(s), dtype=bool); has[cand.row.unique()] = True
    seq0 = s.seq0.to_numpy()
    start = np.r_[True, (seq0[1:] != seq0[:-1]) | ~has[:-1]]
    s["seq"] = np.cumsum(start)
    d = np.r_[0.0, np.hypot(np.diff(s.x.to_numpy()), np.diff(s.y.to_numpy()))]
    d[start] = 0.0
    s["straight"] = d
    return s

t0 = time.perf_counter()
s = downsample(traj)
cand = candidates(s)
s = sequences(s, cand)
log(f"点 {len(traj):,} → 間引き後 {len(s):,}（{len(traj) / max(len(s), 1):.1f} 分の 1）/ 点列 {s.seq.nunique():,} / "
    f"候補 {len(cand):,}（点あたり平均 {len(cand) / max(len(s), 1):.1f} 本、候補なし {int(len(s) - cand.row.nunique()):,} 点） in {time.perf_counter() - t0:.1f} s")
display(cand.head(8))
''')

md(r'''
## 5. 動的計画法で経路を決める（step 5-2, 5-3）

点列ごとに、`cost[k][L]` = 「点 0 … k を見たとき、点 k がリンク L 上にあるという前提での最小総コスト」を順に計算します。

- 観測コスト `obs(k, L) = (dist / SIGMA_M)^2`
- 遷移コスト `trans(L', L)`: 同一リンク = 0、接続リンク（近傍表にある）= `C_SWITCH × 乗り換え本数 + LAMBDA × |経路距離 − 直線距離| / 直線距離`、
  それ以外 = 対象外（∞）。経路距離はリンク上の位置 `pos` から計算する
- `cost[k][L] = obs(k, L) + min_{L'} (cost[k-1][L'] + trans(L', L))`、最小を与えた L' と、その間に通過したリンク列を `back[k][L]` に控える
- 点 k の候補がどの L' からも届かないときは、そこで点列を切り、点 k から新しい区間として再開する
- 最後の点で最小の L から `back` を逆にたどった列が走行ルート。間に飛び越えたリンク（近傍表の path）も通過に含める

計算量は 点数 × 候補数² で、候補 5 本なら 1 点あたり 25 回の評価です。内側のループは Python の辞書とリストで書いています。
''')
code(r'''
def route_distance(Lp, posp, L, pos):
    """リンク Lp 上の位置 posp からリンク L 上の位置 pos までの網の距離と乗り換え本数、間のリンク列。届かなければ None。"""
    if Lp == L:
        return abs(pos - posp), 0, ()
    nb = neighbourhood(Lp).get(L)
    if nb is None:
        return None
    between, ex, en, path = nb
    d = (LEN[Lp] - posp if ex == 1 else posp) + between + (pos if en == 0 else LEN[L] - pos)
    return d, len(path) + 1, path

def viterbi(seq):
    """seq: 1 点列の候補（row 順に並んだ DataFrame。列 row, link, dist, pos, straight）。
    区間ごとに (点の行番号の並び, 各点の割当リンク, 各遷移で間に通過したリンク列) を返す。
    MIN_SEQ_POINTS 未満で捨てた区間の点数も返す。"""
    rows = seq.row.to_numpy(); links_ = seq.link.to_numpy().tolist(); dist = seq.dist.to_numpy(); pos = seq.pos.to_numpy()
    straight = seq.straight.to_numpy()                                   # 点 k と点 k-1 の直線距離（点の候補行で同じ値）
    starts = np.flatnonzero(np.r_[True, rows[1:] != rows[:-1]]); ends = np.r_[starts[1:], len(rows)]
    segments, n_short = [], 0
    seg_rows, back, cost_prev = [], [], None      # 現在の区間: 点の行番号、各点の候補ごとの (L, 前の候補番号, 通過リンク列)、直前のコスト
    def finish():
        nonlocal seg_rows, back, cost_prev, n_short
        if seg_rows:
            if len(seg_rows) >= MIN_SEQ_POINTS:
                n = len(seg_rows)
                assigned, via = [None] * n, [()] * (n - 1)
                j = int(np.argmin(cost_prev))
                for k in range(n - 1, -1, -1):
                    assigned[k], j, path = back[k][j]
                    if k > 0:
                        via[k - 1] = path                                 # 点 k-1 → k の間に通過したリンク
                segments.append((seg_rows, assigned, via))
            else:
                n_short += len(seg_rows)
        seg_rows, back, cost_prev = [], [], None
    for a, b in zip(starts, ends):
        Ls, ps = links_[a:b], pos[a:b]
        obs = (dist[a:b] / SIGMA_M) ** 2
        if cost_prev is not None:
            prev = [(i, Lp, pp, cp) for i, (Lp, pp, cp) in enumerate(zip(prev_L, prev_pos, cost_prev)) if np.isfinite(cp)]
            cost = np.full(len(Ls), np.inf); bk = [None] * len(Ls)
            st = max(straight[a], SAMPLE_M)
            for j, (L, pj) in enumerate(zip(Ls, ps)):
                best, bj, bpath = np.inf, -1, ()
                for i, Lp, pp, cp in prev:
                    rd = route_distance(Lp, pp, L, pj)
                    if rd is None:
                        continue
                    d, hops, path = rd
                    c = cp + C_SWITCH * hops + LAMBDA * abs(d - straight[a]) / st
                    if c < best:
                        best, bj, bpath = c, i, path
                cost[j] = obs[j] + best
                bk[j] = (L, bj, bpath)
            if not np.isfinite(cost).any():                                # どこからも届かない: ここで切って再開
                finish()
        if cost_prev is None:                                              # 区間の最初の点
            cost = obs.copy(); bk = [(L, -1, ()) for L in Ls]
        seg_rows.append(int(rows[a])); back.append(bk); cost_prev = cost
        prev_L, prev_pos = Ls, ps
    finish()
    return segments, n_short

def match_all(s, cand):
    """全点列に viterbi を適用。区間の一覧 [(点の行番号, 割当リンク, 通過リンク列), ...] と、捨てた短い区間の点数を返す。"""
    c = cand.merge(s[["seq", "straight"]], left_on="row", right_index=True, how="inner")
    out, n_short = [], 0
    for _, g in c.groupby("seq", sort=False):
        segs, k = viterbi(g)
        out.extend(segs); n_short += k
    return out, n_short

def route_of(asg, via):
    """割当リンクと通過リンク列を並べた経路（重複を除く）。"""
    route = []
    for k, L in enumerate(asg):
        route.append(L)
        if k < len(via):
            route.extend(via[k])
    return list(dict.fromkeys(route))

t0 = time.perf_counter()
segments, n_short = match_all(s, cand)
log(f"区間 {len(segments):,}（点列 {s.seq.nunique():,}、短くて捨てた点 {n_short:,}）in {time.perf_counter() - t0:.1f} s "
    f"/ 近傍表を作ったリンク {len(_NBR):,} / {n_links:,} 本（候補に現れたリンクだけ。平均 {np.mean([len(v) for v in _NBR.values()]) if _NBR else 0:.1f} 本に届く）")
for rows_, asg, via in segments[:3]:
    print(f"  {s.t.iat[rows_[0]]:%H:%M} 点 {len(rows_)} → 経路 {[int(links.Id[L]) for L in route_of(asg, via)]}")
''')

md(r'''
## 6. 各点にリンクを付け、リンクごとの進入・退出時刻を出す（step 6）

区間の経路（リンクの列。同じリンクを 2 回通ればそのまま 2 回並ぶ）を 1 本の折れ線とみなし、始点からの道のり（弧長）を持たせます。
リンクの i 番目の出現は弧長の区間 `[off[i], off[i+1])` を占めます。

1. 区間の時間範囲にある 1 秒毎の各点を経路上のリンクに射影し（最近傍、`CAND_R_M` 以内）、弧長 `s` を求める。
   同じリンクが経路に複数回出てくるときは、直前の `s` に最も近い出現を選ぶ。`s` は時間順に単調非減少にする（戻りは直前の値で止める）
2. 点のリンク = `s` を含む出現のリンク。隣のリンクへの乗り換えは一度きりで、GPS のずれで前後に揺れない
3. 各出現の進入時刻 `t_enter` と退出時刻 `t_exit` は、`s` が `off[i]`, `off[i+1]` をまたいだ時刻を前後の点から線形補間して決める。
   点が 1 つも落ちない短いリンクも、こうして進入・退出時刻を持つ（`n_points = 0`）

出力は 2 つの表です（どちらも車両 ID を含むので共有しません）。
- `matched_points.*`: 1 秒毎の点 + その時刻にいたリンク（serial_number, t, lat, lon, speed, Id, リンク属性）
- `link_stays.*`: 車両がリンクにいた時間帯（serial_number, Id, t_enter, t_exit, n_points, v_mean, リンク属性）
''')
code(r'''
def route_sequence(asg, via):
    """割当リンクと通過リンク列を走った順に並べた経路（連続する同じリンクだけまとめる。離れて再び通れば 2 回並ぶ）。"""
    seq = []
    for k, L in enumerate(asg):
        for L2 in (L,) + (via[k] if k < len(via) else ()):
            if not seq or seq[-1] != L2:
                seq.append(L2)
    return seq

def route_offsets(seq):
    """経路の各出現について、始点→終点の向きに走るか（fwd）と、経路上の弧長の始まり off（len = len(seq) + 1）。"""
    n = len(seq); fwd = [True] * n
    for i, L in enumerate(seq):
        if n == 1:
            break
        if i + 1 < n:                                                  # 終点側が次のリンクに接していれば順方向
            nxt = seq[i + 1]; ends = (U[nxt], V[nxt])
            fwd[i] = V[L] in ends or U[L] not in ends
        else:                                                          # 最後のリンクは、始点側が前のリンクに接していれば順方向
            prv = seq[i - 1]; ends = (U[prv], V[prv])
            fwd[i] = U[L] in ends or V[L] not in ends
    return fwd, np.r_[0.0, np.cumsum([LEN[L] for L in seq])]

def place_on_route(seq, fwd, off, pts):
    """各点の経路上の弧長 s と出現番号 occ（単調非減少。経路のリンクから CAND_R_M 以上離れた点は occ = -1）。"""
    uniq = list(dict.fromkeys(seq))
    pi, li = STRtree(GEOM[uniq]).query_nearest(pts, max_distance=CAND_R_M, all_matches=False)
    near = np.full(len(pts), -1); near[pi] = li                       # 点ごとの最近傍リンク（uniq の番号）
    pos = np.full(len(pts), np.nan); pos[pi] = shapely.line_locate_point(GEOM[np.asarray(uniq)[li]], pts[pi])
    occ_of = {}                                                        # リンク → 経路での出現番号の一覧
    for i, L in enumerate(seq):
        occ_of.setdefault(L, []).append(i)
    s = np.full(len(pts), np.nan); occ = np.full(len(pts), -1)
    cur, s_prev = 0, 0.0
    for j in range(len(pts)):
        if near[j] < 0:
            continue
        L = uniq[near[j]]
        best = None                                                    # 直前の s に最も近い、戻らない出現
        for i in occ_of[L]:
            if i < cur:
                continue
            sj = off[i] + (pos[j] if fwd[i] else LEN[L] - pos[j])
            if best is None or abs(sj - s_prev) < abs(best[1] - s_prev):
                best = (i, sj)
        if best is None:                                               # 前の出現にしか近くない点（GPS の揺れ）: 今の出現に留める
            occ[j], s[j] = cur, s_prev
            continue
        cur, s_prev = best[0], max(best[1], s_prev)
        occ[j], s[j] = cur, s_prev
    return s, occ

def assign_segment(vcode, seq, pts, t_ns, speed):
    """1 区間: 点ごとのリンク（内部番号、無ければ -1）と、出現ごとの滞在 (vcode, link, t_enter, t_exit, n_points, v_mean)。"""
    fwd, off = route_offsets(seq)
    s, occ = place_on_route(seq, fwd, off, pts)
    ok = occ >= 0
    link_of = np.where(ok, np.asarray(seq)[np.maximum(occ, 0)], -1)
    stays = []
    if ok.sum() >= 1:
        s_ok, t_ok = s[ok], t_ns[ok].astype("datetime64[ns]").astype(np.int64)      # ns の整数（pandas 3 は us 解像度のことがある）
        s_mono = s_ok + np.arange(len(s_ok)) * 1e-9                    # 補間のために狭義単調にする
        cross = np.interp(off, s_mono, t_ok, left=t_ok[0], right=t_ok[-1])   # 各境界をまたいだ時刻
        cross[0], cross[-1] = t_ok[0], t_ok[-1]
        n_pt = np.bincount(occ[ok], minlength=len(seq)); v_sum = np.bincount(occ[ok], weights=speed[ok], minlength=len(seq))
        for i, L in enumerate(seq):
            if cross[i + 1] > cross[i] or n_pt[i]:                     # 最後まで到達しなかった出現（長さ 0）は出さない
                stays.append((vcode, L, int(cross[i]), int(cross[i + 1]), int(n_pt[i]), v_sum[i] / n_pt[i] if n_pt[i] else np.nan))
    return link_of, stays

def assign_points(traj, s, segments):
    """全区間に assign_segment を適用。点ごとのリンク配列と滞在の表を返す。"""
    link_of = np.full(len(traj), -1, dtype=np.int64)
    stays = []
    by_v = {}                                                          # 車両 → [(開始時刻, 経路), ...]
    s_t, s_v = s.t.to_numpy(), s.vcode.to_numpy()
    for rows_, asg, via in segments:
        by_v.setdefault(int(s_v[rows_[0]]), []).append((s_t[rows_[0]], route_sequence(asg, via)))
    v, t = traj.vcode.to_numpy(), traj.t.to_numpy()
    pts = shapely.points(traj.x.to_numpy(), traj.y.to_numpy()); sp = traj.speed.to_numpy()
    starts = np.flatnonzero(np.r_[True, v[1:] != v[:-1]]); ends = np.r_[starts[1:], len(v)]
    for a, b in zip(starts, ends):                                     # 車両ごと（traj は車両・時刻順）
        segs = by_v.get(int(v[a]))
        if not segs:
            continue
        segs.sort(key=lambda z: z[0])
        which = np.maximum(np.searchsorted(np.array([z[0] for z in segs]), t[a:b], side="right") - 1, 0)   # 各点が属する区間
        for si, (_, seq) in enumerate(segs):
            idx = a + np.flatnonzero(which == si)
            lk, st = assign_segment(int(v[a]), seq, pts[idx], t[idx], sp[idx])
            link_of[idx] = lk; stays.extend(st)
    stays = pd.DataFrame(stays, columns=["vcode", "link", "t_enter", "t_exit", "n_points", "v_mean"])
    stays["t_enter"] = pd.to_datetime(stays.t_enter, unit="ns"); stays["t_exit"] = pd.to_datetime(stays.t_exit, unit="ns")
    return link_of, stays

t0 = time.perf_counter()
link_of, stays = assign_points(traj, s, segments)
matched = traj.loc[link_of >= 0, ["vcode", "t", "lat", "lon", "speed"]].copy()
matched["Id"] = links.Id.to_numpy()[link_of[link_of >= 0]]
stays["Id"] = links.Id.to_numpy()[stays.link.to_numpy()]
log(f"リンクを付けた点 {len(matched):,} / {len(traj):,}（付かなかった点 {int((link_of < 0).sum()):,}）、"
    f"リンク滞在 {len(stays):,} 件（点の無い通過 {int((stays.n_points == 0).sum()):,}）in {time.perf_counter() - t0:.1f} s")
attr_cols = [c for c in LINK_ATTR.columns if c != "Id"]
write_table(matched.assign(serial_number=SERIAL[matched.vcode.to_numpy()]).merge(LINK_ATTR, on="Id", how="left")
                   [["serial_number", "t", "lat", "lon", "speed", "Id"] + attr_cols], "matched_points")
write_table(stays.assign(serial_number=SERIAL[stays.vcode.to_numpy()]).merge(LINK_ATTR, on="Id", how="left")
                 [["serial_number", "Id", "t_enter", "t_exit", "n_points", "v_mean"] + attr_cols], "link_stays")
display(stays.head(8))
''')

md(r'''
## 7. 15 分 × リンクの統計（step 6 の続き）

`link_stays` の滞在時間帯をウィンドウに展開し（進入した窓から退出した窓まで）、ウィンドウ × リンクで
**Hits = その窓にいた車両数、AvgSp = 車両ごとの平均速度（その窓・そのリンク上の点の平均）の平均、MedSp = その中央値、n_points = 点数** にまとめます。
ウィンドウ内の最高速度が `MOVING_KMH` 未満の車両（駐停車）は、そのウィンドウでは数えません。
ウィンドウ毎に `traffic_YYYYMMDD_HHMM.csv`（`Id` は集約後の代表 Id。観測の無いリンクは行を持たない。通過だけで点の無いリンクは AvgSp が空）、
全体を `traffic_15min.csv` に書きます。
''')
code(r'''
def window_stats(matched, stays):
    W = pd.Timedelta(minutes=WINDOW_MIN)
    p = matched[["vcode", "t", "speed", "Id"]].copy(); p["window"] = p.t.dt.floor(W)
    vmax = p.groupby(["vcode", "window"]).speed.max()                              # 車両 × 窓の最高速度（駐停車の判定）
    moving = vmax[vmax >= MOVING_KMH].index
    # 滞在を窓に展開: 進入した窓から退出した窓まで（退出時刻ちょうどの窓境界は含めない）
    w0 = stays.t_enter.dt.floor(W); w1 = (stays.t_exit - pd.Timedelta(1, "ns")).dt.floor(W); w1 = w1.where(w1 >= w0, w0)
    n_w = ((w1 - w0) // W + 1).to_numpy()
    win = pd.DatetimeIndex(w0.repeat(n_w).to_numpy()) + pd.to_timedelta(np.concatenate([np.arange(k) for k in n_w]) * WINDOW_MIN, unit="min")
    ex = pd.DataFrame({"vcode": stays.vcode.to_numpy().repeat(n_w), "Id": stays.Id.to_numpy().repeat(n_w), "window": win}).drop_duplicates()
    ex = ex[pd.MultiIndex.from_arrays([ex.vcode, ex.window]).isin(moving)]
    sp = p.groupby(["window", "Id", "vcode"]).agg(v=("speed", "mean"), n=("speed", "size")).reset_index()   # 窓 × リンク × 車両の速度
    per_vehicle = ex.merge(sp, on=["window", "Id", "vcode"], how="left")
    stats = (per_vehicle.groupby(["window", "Id"])
                        .agg(Hits=("vcode", "size"), AvgSp=("v", "mean"), MedSp=("v", "median"), n_points=("n", "sum"))
                        .reset_index())
    stats["AvgSp"] = stats.AvgSp.round(2); stats["MedSp"] = stats.MedSp.round(2); stats["n_points"] = stats.n_points.fillna(0).astype(int)
    return stats

def write_windows(stats):
    for old in OUT_DIR.glob("traffic_*.csv"):
        old.unlink()
    written = []
    for w, g in stats.groupby("window"):
        name = f"traffic_{w:%Y%m%d_%H%M}.csv"
        g[["Id", "Hits", "AvgSp", "MedSp", "n_points"]].sort_values("Id").to_csv(OUT_DIR / name, index=False)
        written.append(name)
    stats.to_csv(OUT_DIR / "traffic_15min.csv", index=False)
    return written

t0 = time.perf_counter()
stats = window_stats(matched, stays)
written = write_windows(stats)
log(f"{len(written)} ウィンドウ、ウィンドウ × リンク {len(stats):,} 行 in {time.perf_counter() - t0:.1f} s → {OUT_DIR}")
display(stats.sort_values(["window", "Hits"], ascending=[True, False]).head(12))
''')

md(r'''
## 8. 直近 1 時間の軌跡（15 分毎、任意）

窓の終端 T（15 分刻み）ごとに、(T−60 分, T] の各車両の点をつないだ線を `traj/traj_YYYYMMDD_HHMM.geojson` に書きます
（HHMM は T。人流の viewer と同じ「直近 1 時間」の定義）。入力は全車両・全時刻をまとめた `traj`（節 3 の表）なので、
各スロットのファイルは 1 回だけ書かれます。`TRAJ_GAP_MIN` を超える欠測で線を切り、投影座標で `TRAJ_SIMPLIFY_M` の
Douglas-Peucker 間引きをして、`TRAJ_MIN_LEN_M` より短い線（駐車中など）は落とします。車両 ID は出力しません。
''')
code(r'''
def traj_slots(traj):
    """全点から 15 分毎のスロットファイルを書き、[(ファイル名, 地物数), ...] を返す。"""
    TRAJ_DIR = OUT_DIR / "traj"; TRAJ_DIR.mkdir(exist_ok=True)
    for old in TRAJ_DIR.glob("*.geojson"):
        old.unlink()
    step, win = pd.Timedelta(minutes=WINDOW_MIN), pd.Timedelta(minutes=TRAJ_WINDOW_MIN)
    t_first = traj.t.min().floor(f"{WINDOW_MIN}min") + step
    t_last = traj.t.max().ceil(f"{WINDOW_MIN}min")
    written = []
    for T in pd.date_range(t_first, t_last, freq=step):
        w = traj[(traj.t > T - win) & (traj.t <= T)]
        feats = []
        for _, g in w.groupby("vcode", sort=False):
            gap = np.r_[True, np.diff(g.t.to_numpy()).astype("timedelta64[s]").astype(float) > TRAJ_GAP_MIN * 60]
            lines = []
            for _, gg in g.groupby(np.cumsum(gap)):
                if len(gg) < 2:
                    continue
                line = shapely.simplify(shapely.LineString(np.c_[gg.x.to_numpy(), gg.y.to_numpy()]), TRAJ_SIMPLIFY_M)
                if line.length < TRAJ_MIN_LEN_M:
                    continue
                lon2, lat2 = from_m.transform(*line.xy)
                lines.append([[round(float(a), 6), round(float(b), 6)] for a, b in zip(lon2, lat2)])
            if not lines:
                continue
            geom = {"type": "LineString", "coordinates": lines[0]} if len(lines) == 1 else {"type": "MultiLineString", "coordinates": lines}
            feats.append({"type": "Feature",
                          "properties": {"time": T.strftime("%H:%M"), "date": T.strftime("%Y-%m-%d"), "n_points": int(len(g)),
                                         "v_mean": round(float(g.speed.mean()), 1), "v_max": round(float(g.speed.max()), 1)},
                          "geometry": geom})
        name = f"traj_{T:%Y%m%d_%H%M}.geojson"
        with open(TRAJ_DIR / name, "w", encoding="utf-8") as f:
            json.dump({"type": "FeatureCollection", "features": feats}, f, ensure_ascii=False, separators=(",", ":"))
        written.append((name, len(feats)))
    with open(TRAJ_DIR / "index.json", "w", encoding="utf-8") as f:
        json.dump({"window_min": TRAJ_WINDOW_MIN, "slot_min": WINDOW_MIN, "files": dict(written)}, f, ensure_ascii=False, indent=1)
    return written

traj_files = []
if TRAJ_OUT and len(traj):
    t0 = time.perf_counter()
    traj_files = traj_slots(traj)
    log(f"traj/: {len(traj_files)} slot files, {sum(c for _, c in traj_files):,} trajectories in {time.perf_counter() - t0:.1f} s")
    print("\n".join(f"{n}: {c} 本" for n, c in traj_files[:6]), "…" if len(traj_files) > 6 else "")
''')

md(r'''
## 9. 確認

- 処理の内訳を `summary.json` に書く
- ウィンドウ別のリンク数・総 Hits・平均速度、Hits 上位リンク
''')
code(r'''
summary = {"files": len(members), "rows_scanned": int(scan.rows.sum()) if "scan" in globals() and "rows" in scan else None,
           "vehicles_in_area": len(VCODE), "trajectory_points": int(len(traj)), "sampled_points": int(len(s)),
           "no_candidate_points": int(len(s) - cand.row.nunique()), "short_points": int(n_short), "segments": len(segments),
           "matched_points": int((link_of >= 0).sum()), "unmatched_points": int((link_of < 0).sum()),
           "link_stays": int(len(stays)), "stays_without_points": int((stays.n_points == 0).sum()),
           "windows": int(stats.window.nunique()), "links_hit": int(stats.Id.nunique()), "traj_slot_files": len(traj_files)}
json.dump(summary, open(OUT_DIR / "summary.json", "w", encoding="utf-8"), ensure_ascii=False, indent=1)
print(json.dumps(summary, ensure_ascii=False, indent=1))
if len(stats):
    print(stats.groupby("window").agg(links=("Id", "size"), Hits=("Hits", "sum"), AvgSp=("AvgSp", "mean")).round(1))
    top = stats.groupby("Id").Hits.sum().sort_values(ascending=False).head(10)
    display(links.set_index("Id").loc[top.index, [c for c in ["StreetName", "FRC", "SpeedLimit", "Length"] if c in links.columns]].assign(Hits=top.values))
''')

nb = {"cells": cells, "metadata": {"kernelspec": {"display_name": "Python 3", "language": "python", "name": "python3"},
      "language_info": {"name": "python"}}, "nbformat": 4, "nbformat_minor": 5}
out = Path(__file__).parent / "truck_traffic.ipynb"
json.dump(nb, open(out, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
print("wrote", out, len(cells), "cells")
