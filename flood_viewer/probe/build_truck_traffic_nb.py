"""Builds truck_traffic.ipynb (cell by cell) from the cell sources below.  python3 build_truck_traffic_nb.py"""
import json
from pathlib import Path

cells = []
def md(s): cells.append({"cell_type": "markdown", "metadata": {}, "source": s.strip("\n").splitlines(keepends=True)})
def code(s): cells.append({"cell_type": "code", "metadata": {}, "execution_count": None, "outputs": [], "source": s.strip("\n").splitlines(keepends=True)})

md(r'''
# トラックプローブ → 15 分・道路リンク別の交通量・速度

1 秒毎のトラックプローブ（zip 内の 1 時間毎 CSV）を TomTom 道路ネットワークに経路として割り付け、
15 分ウィンドウ × 道路リンク別の車両数（Hits）と平均速度（AvgSp）を出力します。

処理の流れ
1. **ネットワーク集約**: 形状が完全に一致するリンクを 1 本に統合し、リンクテーブルを作る。端点からノードとグラフを作る
2. **ファイル読み込み**: zip を解凍せずに 1 時間分の CSV を読む
3. **候補抽出**（step 5-1）: 15 分ウィンドウ × 車両の点列を間引き、各点から近い順に最大 5 本の候補リンクを取る
4. **経路推定**（step 5-2, 5-3）: 最初の点の候補リンクにコストを置き、次の点の候補へ「同一リンク = 0、接続リンク = 定数 × 通過本数、
   それ以外 = 対象外」のコストを積み上げ、各候補に最小コストだけを残していく（Viterbi）。最後に最小コストの候補から逆にたどった
   リンク列が走行ルート
5. **割り付け**（step 6）: ルート上の全リンクにその車両を割り付ける。速度は、1 秒毎の各点をルート上のリンクのうち最近傍のものに
   割り当て、リンク × 車両で平均する
6. **集計**: 15 分ウィンドウ × リンクの車両数・平均速度を集計し、ウィンドウ毎の CSV に書く
7. **軌跡**: 15 分毎に、直近 1 時間の各車両の軌跡を GeoJSON に書く（ビューワーのトラックタブで重ねる）

範囲を絞る場合は `AREA_GEOJSON` に区域ポリゴン（例: 新宿区の tokyo.geojson）を与えます。点はポリゴン内だけ、
リンクはその外接矩形（+1 km）内だけを使うので、計算量が大きく減ります。

必要なライブラリ: geopandas, shapely 2.x, pyproj, pandas, numpy。

仕様に無い追加・解釈（すべてパラメータ化。詳細は各節）

| 項目 | 内容 |
|---|---|
| 間引き | 点列は軌跡に沿って `SAMPLE_M`（30 m）進むか `SAMPLE_MAX_S`（60 秒）経つごとに 1 点にする。速度の割り当てには間引く前の全点を使う |
| 候補 | 点から `CAND_R_M`（50 m）以内で近い順に `CAND_MAX`（5）本。候補が無い点で点列を切り、間引き後 `MIN_SEQ_POINTS`（3）点未満の区間は使わない |
| 接続 | ノードを共有する隣接だけでなく、網の距離 `D_MAX_M`（250 m）以内で届くリンクも接続扱い（短いリンクを飛び越えるため）。間のリンクも通過とみなす |
| 停車 | ウィンドウ内の最高速度が `MOVING_KMH`（3 km/h）未満の車両は駐停車とみなし、車両数に数えない |
| 速度 | 1 秒毎の各点を、その区間の経路上のリンクのうち最近傍（`CAND_R_M` 以内）のものに割り当てて、リンク × 車両で平均する。点が割り当たらない通過リンクは車両数だけ数える |
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
PROBE_ZIP   = Path("../data/truck_probe.zip")                   # 1 時間毎 CSV を格納した zip（解凍しない）
MEMBER_RE   = r"\.(csv|txt)(\.gz)?$"                            # zip 内で読む対象ファイル名（正規表現、大文字小文字無視）
OUT_DIR     = Path("./traffic_out")                             # 出力先
OUT_DIR.mkdir(parents=True, exist_ok=True)
AREA_GEOJSON = None                                             # 範囲を絞る GeoJSON（例 "./tokyo.geojson"）。None = 絞らない

# ---- 入力 CSV の列名（サンプルに合わせてある） ---------------------------
COL_ID, COL_TIME, COL_SPEED, COL_LAT, COL_LON = "serial_number", "record_time", "speed", "gps_latitude", "gps_longitude"

# ---- 集計 ---------------------------------------------------------------
WINDOW_MIN = 15               # 集計ウィンドウ [分]
MOVING_KMH = 3.0              # ウィンドウ内の最高速度がこれ未満の車両は停車中（駐車）とみなし、交通として数えない

# ---- step 5-1: 間引きと候補リンク ----------------------------------------
SAMPLE_M = 30.0               # 前に残した点からこれだけ [m] 離れたら次の点を残す
SAMPLE_MAX_S = 60.0           # 動かなくても、これだけ [秒] 経ったら点を残す（停車中の車両も列に残す）
CAND_R_M = 50.0               # 候補リンクは点からこの距離 [m] 以内
CAND_MAX = 5                  # 候補リンクは近い順にこの本数まで
MIN_SEQ_POINTS = 3            # 間引き後の点がこれ未満の点列（区間）は使わない

# ---- step 5-2, 5-3: コスト -----------------------------------------------
SIGMA_M = 15.0                # 観測コスト = (点からリンクまでの距離 / SIGMA_M)^2  … GPS 誤差の想定幅
C_SWITCH = 1.0                # 接続リンクへの乗り換え 1 本あたりのコスト
LAMBDA = 2.0                  # |経路距離 − 直線距離| / 直線距離 に掛ける係数
D_MAX_M = 250.0               # 網の距離でこれ以内のリンクを「接続」とみなす（間引き間隔で動ける距離より大きく）

# ---- step 7: 直近 1 時間の軌跡（15 分毎） ----------------------------------
TRAJ_OUT = True               # traj/traj_YYYYMMDD_HHMM.geojson を書くか（HHMM = 窓の終端。窓は (T-60 分, T]）
TRAJ_WINDOW_MIN = 60          # 軌跡の窓 [分]
TRAJ_GAP_MIN = 5.0            # この分数を超える欠測で軌跡を切る
TRAJ_SIMPLIFY_M = 5.0         # 軌跡の間引き（Douglas-Peucker の許容誤差 [m]）
TRAJ_MIN_LEN_M = 10.0         # これより短い軌跡（駐車中など）は書かない

WRITE_GROUPS = True           # ウィンドウ × 車両 × リンクの割り付け表（groups.csv、車両 ID を含む診断用）も書くか

def log(msg):
    print(f"[{time.strftime('%H:%M:%S')}] {msg}", flush=True)
''')

md(r'''
## 0b. 範囲（任意）

`AREA_GEOJSON` を与えると、その全ポリゴンの和集合を範囲にします。CRS が JGD2011（EPSG:6668）の場合も、経緯度としては
WGS84 と実質同じなのでそのまま使います。以降、点はこの範囲内だけ、リンクは外接矩形（+1 km）内だけになります。
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
    print("範囲の指定なし（全点・全リンク）")
''')

md(r'''
## 1. ネットワーク集約（step 1）

TomTom の shp には、形状が完全に同じリンクが複数のオブジェクトとして入っていることがあります（反対車線は同一オブジェクトですが、
セグメント境界などで重複が生じる）。座標列が同じ（向きが逆でも同じ）ものを 1 本に統合し、代表 `Id`（メンバー中の最小 Id）と
メンバー一覧 `member_ids` を持つリンクテーブルを作ります。属性は `Length` は先頭、`SpeedLimit` は最大、`FRC` は最小、
その他の列（`Segment Id`, `NewSegId`, `StreetName` など）は先頭のメンバーの値を採用します。

距離計算のため、以降はメートル単位の投影座標系（UTM、`estimate_utm_crs`）で扱います。
MultiLineString があれば `line_merge` でつなぎ、つながらないものはそのまま扱います（最近傍検索は Multi でも動きます）。
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
### リンクテーブルの出力

`network_agg.csv`（全属性 + `member_ids`）と `network_agg.shp`（形状付き。shp の文字列列は 254 文字までなので `member_ids` は
含めず `n_members` のみ）を書きます。メンバー間で属性が食い違うグループ数も確認します。
''')
code(r'''
grp = net.groupby("shape_key")
incons = {c: int((grp[c].nunique() > 1).sum()) for c in ["Length", "FRC", "SpeedLimit", "StreetName"] if c in net.columns}
print("メンバー間で属性が異なるグループ数:", incons)

links_out = links.drop(columns=["link_idx"])
links_out.drop(columns="geometry").to_csv(OUT_DIR / "network_agg.csv", index=False)
links_out.drop(columns=["member_ids"]).to_file(OUT_DIR / "network_agg.shp")
print("wrote", OUT_DIR / "network_agg.csv", "and network_agg.shp")

# 候補検索用の空間インデックス（投影座標）と座標変換
GEOM = links_m.geometry.values
LEN = links_m.length.to_numpy()
tree = STRtree(GEOM)
to_m = Transformer.from_crs("EPSG:4326", CRS_M, always_xy=True)
from_m = Transformer.from_crs(CRS_M, "EPSG:4326", always_xy=True)
''')

md(r'''
### グラフ（ノード・隣接・近傍表）

リンクの両端点を 0.1 m で丸めてノードにし、ノード → リンクの隣接表を作ります（TomTom のリンク端点は交差点で一致している前提。
反対車線は同一オブジェクトなので無向グラフ）。

「接続リンク」は、ノードを共有する隣接だけでなく、網の距離 `D_MAX_M` 以内で届くリンクも含めます（短いリンクを点が飛び越えるため）。
リンク L の近傍表 `neighbourhood(L)` は、L の両端から有界ダイクストラで求めた
`{L2: (間のリンク長の合計, L から出る端 0/1, L2 に入る端 0/1, 間のリンク列)}` で、初回に計算してキャッシュします。
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
      {int(links.Id[k]): (round(v[0], 1), len(v[3])) for k, v in list(nb0.items())[:6]})
''')

md(r'''
## 2. ファイル読み込み（step 2）

zip を解凍せず、メンバーを 1 つずつ読みます（`__MACOSX/` や `._` で始まる Finder の付随ファイルは除外）。
時刻は `record_time`、車両 ID は `serial_number`（先頭の 0 を保つため文字列）。
緯度経度・時刻・速度が欠けた行は落とし、同一車両・同一秒の重複は 1 行にします。
`window` 列（`WINDOW_MIN` 分で切り捨てた時刻）と投影座標 `x`, `y` はここで付けておきます。
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

def parse_time(s):
    try:
        return pd.to_datetime(s, format="ISO8601", errors="coerce")   # "YYYY-MM-DD HH:MM:SS"（小数秒や T 区切りも可）
    except (TypeError, ValueError):                                    # 古い pandas
        return pd.to_datetime(s, errors="coerce")

def read_member(name):
    comp = "gzip" if name.lower().endswith(".gz") else None
    with zf.open(name) as f:
        df = pd.read_csv(f, usecols=[COL_ID, COL_TIME, COL_SPEED, COL_LAT, COL_LON], dtype={COL_ID: str}, compression=comp)
    df = df.rename(columns={COL_ID: "vid", COL_TIME: "t", COL_SPEED: "speed", COL_LAT: "lat", COL_LON: "lon"})
    n0 = len(df)
    df["t"] = parse_time(df["t"])
    df["speed"] = pd.to_numeric(df["speed"], errors="coerce")
    df = df.dropna(subset=["t", "lat", "lon", "speed"])
    n1 = len(df)
    if AREA is not None:                                                   # 範囲内の点だけ（外接矩形で粗く → ポリゴンで厳密に）
        x0, y0, x1, y1 = AREA.bounds
        df = df[(df.lon >= x0) & (df.lon <= x1) & (df.lat >= y0) & (df.lat <= y1)]
        df = df[shapely.contains_xy(AREA, df.lon.to_numpy(), df.lat.to_numpy())]
    df = df.drop_duplicates(["vid", "t"]).sort_values(["vid", "t"]).reset_index(drop=True)
    df["window"] = df["t"].dt.floor(f"{WINDOW_MIN}min")
    df["x"], df["y"] = to_m.transform(df["lon"].to_numpy(), df["lat"].to_numpy())
    df.attrs["dropped"] = n0 - len(df); df.attrs["outside"] = n1 - len(df)
    return df

df = read_member(members[0])
print(f"{members[0]}: {len(df):,} rows / vehicles {df.vid.nunique():,} / {df.t.min()} – {df.t.max()} / dropped {df.attrs['dropped']}")
display(df.head())
''')

md(r'''
## 3. 間引きと候補リンク（step 5-1）

ウィンドウ × 車両ごとに点列を間引きます（軌跡に沿って `SAMPLE_M` 進むごと、または `SAMPLE_MAX_S` 経つごとに 1 点）。
1 秒毎の点は情報がほぼ重複しているので、経路の推定には間引いた点で足り、計算量が 1/10 程度になります。

間引いた各点について、`CAND_R_M` 以内のリンクを STRtree で一括検索し、近い順に `CAND_MAX` 本を候補にします。
候補ごとに、点からリンクまでの距離 `dist` と、リンク上の位置 `pos`（始点からの距離。経路距離の計算に使う）を持ちます。
候補が 1 本も無い点（道路から `CAND_R_M` 以上離れた点）は経路の切れ目とし、その前後を別の点列（`seq`）として扱います。
''')
code(r'''
def downsample(df):
    """ウィンドウ × 車両ごとの間引き。残した点だけの DataFrame（連番 index）を返す。"""
    x, y = df.x.to_numpy(), df.y.to_numpy()
    t = df.t.to_numpy().astype("datetime64[s]").astype(np.int64)
    vid, win = df.vid.to_numpy(), df.window.to_numpy()
    new = np.r_[True, (vid[1:] != vid[:-1]) | (win[1:] != win[:-1])]         # 車両 × ウィンドウの先頭
    grp = np.cumsum(new) - 1
    step = np.r_[0.0, np.hypot(np.diff(x), np.diff(y))]; step[new] = 0.0
    cum = np.cumsum(step); cum = cum - cum[new][grp]                        # 軌跡に沿った累積距離（グループ内）
    el = t - t[new][grp]                                                     # 経過秒（グループ内）
    bd, bt = np.floor(cum / SAMPLE_M), np.floor(el / SAMPLE_MAX_S)
    keep = new | np.r_[False, (bd[1:] != bd[:-1]) | (bt[1:] != bt[:-1])]   # 30 m 刻み・60 秒刻みの境界を越えた最初の点
    return df[keep].reset_index(drop=True)

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
    """点列番号 seq（車両 × ウィンドウ。候補の無い点で切る）と、1 つ前の点との直線距離 straight を s に付ける。"""
    has = np.zeros(len(s), dtype=bool); has[cand.row.unique()] = True
    vid, win = s.vid.to_numpy(), s.window.to_numpy()
    start = np.r_[True, (vid[1:] != vid[:-1]) | (win[1:] != win[:-1]) | ~has[:-1]]
    s["seq"] = np.cumsum(start)
    d = np.r_[0.0, np.hypot(np.diff(s.x.to_numpy()), np.diff(s.y.to_numpy()))]
    d[start] = 0.0
    s["straight"] = d
    return s

s = downsample(df)
cand = candidates(s)
s = sequences(s, cand)
print(f"点 {len(df):,} → 間引き後 {len(s):,}（{len(df) / max(len(s), 1):.1f} 分の 1）/ 点列 {s.seq.nunique():,} / "
      f"候補 {len(cand):,}（点あたり平均 {len(cand) / max(len(s), 1):.1f} 本、候補なし {int(len(s) - cand.row.nunique()):,} 点）")
display(cand.head(8))
''')

md(r'''
## 4. 経路推定（step 5-2, 5-3）

点列ごとに、`cost[k][L]` = 「点 0 … k を見たとき、点 k がリンク L 上にあるという前提での最小総コスト」を順に計算します。

- 観測コスト `obs(k, L) = (dist / SIGMA_M)^2`
- 遷移コスト `trans(L', L)`: 同一リンク = 0、接続リンク（近傍表にある）= `C_SWITCH × 乗り換え本数 + LAMBDA × |経路距離 − 直線距離| / 直線距離`、
  それ以外 = 対象外（∞）。経路距離はリンク上の位置 `pos` から計算する
- `cost[k][L] = obs(k, L) + min_{L'} (cost[k-1][L'] + trans(L', L))`、最小を与えた L' と、その間に通過したリンク列を `back[k][L]` に控える
- 点 k の候補がどの L' からも届かないときは、そこで点列を切り、点 k から新しい区間として再開する
- 最後の点で最小の L から `back` を逆にたどった列が走行ルート。間に飛び越えたリンク（近傍表の path）も通過に含める

計算量は 点数 × 候補数² で、候補 5 本なら 1 点あたり 25 回の評価です。
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

def match_sequences(s, cand):
    """全点列に viterbi を適用。区間の一覧 [(vid, window, 点の行番号, 割当リンク, 通過リンク列), ...] と、捨てた短い区間の点数を返す。"""
    c = cand.merge(s[["vid", "window", "seq", "straight"]], left_on="row", right_index=True, how="inner")
    out, n_short = [], 0
    for _, g in c.groupby("seq", sort=False):
        segs, k = viterbi(g)
        n_short += k
        for rows_, asg, via in segs:
            out.append((g.vid.iat[0], g.window.iat[0], rows_, asg, via))
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
segments, n_short = match_sequences(s, cand)
print(f"区間 {len(segments):,}（点列 {s.seq.nunique():,}、短くて捨てた点 {n_short:,}）in {time.perf_counter() - t0:.1f} s")
for vid, w, rows_, asg, via in segments[:3]:
    print(f"  {w:%H:%M} 点 {len(rows_)} → 経路 {[int(links.Id[L]) for L in route_of(asg, via)]}")
''')

md(r'''
## 5. 割り付け（step 6）

区間ごとに、経路上の全リンクにその車両を割り付けます（点が落ちない短いリンクも通過として車両数に数える）。
速度は、1 秒毎の各点を、その点の時刻が属する区間の経路上のリンクのうち最近傍（`CAND_R_M` 以内）のものに割り当て、
リンク × 車両で平均します。点が 1 つも割り当たらないリンク（`via`）は車両数には数えますが、速度の平均には入りません。
ウィンドウ内の最高速度が `MOVING_KMH` 未満の車両（駐停車）は数えません。
''')
code(r'''
def assign_routes(df, s, segments):
    """(window, vid, link) ごとの n_points, v_mean, via（点なしの通過）の表を返す。"""
    by_vw = {}
    for vid, w, srows, asg, via in segments:
        by_vw.setdefault((vid, w), []).append((s.t.iat[srows[0]], route_of(asg, via)))
    rows = []
    for (vid, w), g in df.groupby(["vid", "window"], sort=False):
        segs = by_vw.get((vid, w))
        if not segs or g.speed.max() < MOVING_KMH:
            continue
        segs.sort(key=lambda z: z[0])
        t_start = np.array([z[0] for z in segs], dtype="datetime64[ns]")
        which = np.maximum(np.searchsorted(t_start, g.t.to_numpy(), side="right") - 1, 0)   # 各 1 秒点が属する区間
        pts = shapely.points(g.x.to_numpy(), g.y.to_numpy()); sp = g.speed.to_numpy()
        for si, (_, route) in enumerate(segs):
            m = which == si
            pi, li = STRtree(GEOM[route]).query_nearest(pts[m], max_distance=CAND_R_M, all_matches=False)
            n_pt = np.bincount(li, minlength=len(route))
            v_sum = np.bincount(li, weights=sp[m][pi], minlength=len(route))
            for j, L in enumerate(route):
                rows.append((w, vid, L, int(n_pt[j]), float(v_sum[j] / n_pt[j]) if n_pt[j] else np.nan, bool(n_pt[j] == 0)))
    return pd.DataFrame(rows, columns=["window", "vid", "link", "n_points", "v_mean", "via"])

groups = assign_routes(df, s, segments)
groups["Id"] = links.Id.to_numpy()[groups.link] if len(groups) else []
print(f"割り付け {len(groups):,} 行（通過のみ {int(groups.via.sum()):,}）")
display(groups.head(8))
''')

md(r'''
## 6. 15 分集計（step 6 の続き）

リンク × ウィンドウで **Hits = 車両数、AvgSp = 車両ごとの平均速度の平均（速度のある車両のみ）、MedSp = その中央値、n_points = 点数**
を集計し、ウィンドウ毎に `traffic_YYYYMMDD_HHMM.csv` を書きます（`Id` は集約後の代表 Id。観測の無いリンクは行を持ちません。通過だけで点の無いリンクは AvgSp が空）。
''')
code(r'''
def aggregate_windows(groups):
    stats = (groups.groupby(["window", "Id"])
                   .agg(Hits=("vid", "nunique"), AvgSp=("v_mean", "mean"), MedSp=("v_mean", "median"),
                        n_points=("n_points", "sum"), n_sp=("v_mean", "count"))                  # n_sp = 速度のある車両数
                   .reset_index())
    stats["AvgSp"] = stats.AvgSp.round(2); stats["MedSp"] = stats.MedSp.round(2)
    return stats

def write_windows(stats, out_dir=OUT_DIR):
    written = []
    for w, g in stats.groupby("window"):
        name = f"traffic_{w:%Y%m%d_%H%M}.csv"
        g[["Id", "Hits", "AvgSp", "MedSp", "n_points"]].sort_values("Id").to_csv(out_dir / name, index=False)
        written.append(name)
    return written

stats = aggregate_windows(groups)
print(write_windows(stats))
display(stats.sort_values(["window", "Hits"], ascending=[True, False]).head(12))
''')

md(r'''
## 7. 直近 1 時間の軌跡（15 分毎、step 7）

窓の終端 T（15 分刻み）ごとに、(T−60 分, T] の各車両の点をつないだ線を `traj/traj_YYYYMMDD_HHMM.geojson` に書きます
（HHMM は T。人流の viewer と同じ「直近 1 時間」の定義）。`TRAJ_GAP_MIN` を超える欠測で線を切り、投影座標で
`TRAJ_SIMPLIFY_M` の Douglas-Peucker 間引きをして、`TRAJ_MIN_LEN_M` より短い線（駐車中など）は落とします。
窓が前のファイルにまたがるので、前のファイルの末尾 1 時間分（`tail`）を引き継ぎます（ファイルは時刻順に処理する前提）。
車両 ID は出力しません（properties: time, date, n_points, v_mean, v_max）。
''')
code(r'''
TRAJ_DIR = OUT_DIR / "traj"; TRAJ_DIR.mkdir(exist_ok=True)

def traj_slots(df, tail=None):
    """df: 1 ファイル分の点、tail: 前のファイルの末尾 1 時間分。各スロットの GeoJSON を書き、
    [(ファイル名, 地物数), ...] と次のファイルへ渡す tail を返す。"""
    step, win = pd.Timedelta(minutes=WINDOW_MIN), pd.Timedelta(minutes=TRAJ_WINDOW_MIN)
    cols = ["vid", "t", "speed", "x", "y"]
    both = pd.concat([tail[tail.t < df.t.min()], df[cols]], ignore_index=True) if tail is not None and len(tail) else df[cols]
    t_first = df.t.min().floor(f"{WINDOW_MIN}min") + step
    t_last = df.t.max().ceil(f"{WINDOW_MIN}min")
    written = []
    for T in pd.date_range(t_first, t_last, freq=step):
        w = both[(both.t > T - win) & (both.t <= T)]
        feats = []
        for vid, g in w.groupby("vid", sort=False):
            g = g.sort_values("t")
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
    return written, df[df.t > df.t.max() - win][cols]

if TRAJ_OUT:
    written, tail = traj_slots(df)
    print("\n".join(f"{n}: {c} 本" for n, c in written), "/ tail", len(tail), "点")
''')

md(r'''
## 8. 全ファイルの処理

上の step 2 → 7 を zip 内の全ファイルに対して実行します。メモリに残すのはファイルごとの集計結果（小さい）だけで、
割り付け表（`groups.csv`、`WRITE_GROUPS` のとき）はファイルごとに追記します。読めないファイルは記録して飛ばします。
同じウィンドウが複数ファイルにまたがる場合（ファイル境界が 15 分境界と一致しない場合）は、最後に合算します。
''')
code(r'''
t_all = time.perf_counter()
all_stats, summary, traj_files = [], [], []
tail = None
(OUT_DIR / "groups.csv").unlink(missing_ok=True)
for k, name in enumerate(members, 1):
    t0 = time.perf_counter()
    try:
        df = read_member(name)
        if df.empty:
            log(f"[{k}/{len(members)}] {name}: 0 rows, skip"); continue
        dropped, outside = df.attrs["dropped"], df.attrs.get("outside", 0)
        if TRAJ_OUT:
            tw, tail = traj_slots(df, tail); traj_files += tw
        s = downsample(df)
        cand = candidates(s)
        s = sequences(s, cand)
        segments, n_short = match_sequences(s, cand)
        groups = assign_routes(df, s, segments)
        groups["Id"] = links.Id.to_numpy()[groups.link] if len(groups) else []
        stats = aggregate_windows(groups)
        if WRITE_GROUPS and len(groups):
            groups.assign(file=name).to_csv(OUT_DIR / "groups.csv", mode="a", header=not (OUT_DIR / "groups.csv").exists(), index=False)
        all_stats.append(stats)
        n_vw = df.groupby(["vid", "window"]).ngroups
        summary.append({"file": name, "rows": len(df), "dropped": dropped, "outside_area": outside, "vehicles": df.vid.nunique(),
                        "vehicle_windows": n_vw, "sampled_points": len(s), "no_candidate_points": int(len(s) - cand.row.nunique()),
                        "short_points": n_short, "segments": len(segments), "assigned_rows": len(groups),
                        "via_rows": int(groups.via.sum()) if len(groups) else 0,
                        "windows": stats.window.nunique(), "links_hit": stats.Id.nunique(), "error": ""})
        log(f"[{k}/{len(members)}] {name}: {len(df):,} pts, {df.vid.nunique():,} vehicles, {len(s):,} sampled, "
            f"{len(segments):,} segments, {len(groups):,} link assignments ({time.perf_counter() - t0:.1f} s)")
        del df, s, cand, groups
    except Exception as e:
        log(f"[{k}/{len(members)}] {name}: skipped ({type(e).__name__}: {e})")
        summary.append({"file": name, "error": f"{type(e).__name__}: {e}"})

summary = pd.DataFrame(summary)
summary.to_csv(OUT_DIR / "summary.csv", index=False)
display(summary)
if all_stats and any(len(x) for x in all_stats):
    stats_all = pd.concat(all_stats)
    stats_all["sp_x"] = (stats_all.AvgSp * stats_all.n_sp).fillna(0.0)   # 同じウィンドウ × リンクが複数ファイルに分かれていれば合算
    stats_all = (stats_all.groupby(["window", "Id"])
                          .agg(Hits=("Hits", "sum"), sp_x=("sp_x", "sum"), n_sp=("n_sp", "sum"), MedSp=("MedSp", "median"), n_points=("n_points", "sum"))
                          .reset_index())
    stats_all["AvgSp"] = (stats_all.sp_x / stats_all.n_sp.where(stats_all.n_sp > 0)).round(2)   # 速度のある車両が無ければ NaN
    stats_all = stats_all[["window", "Id", "Hits", "AvgSp", "MedSp", "n_points"]]
    written = write_windows(stats_all)
    stats_all.to_csv(OUT_DIR / "traffic_15min.csv", index=False)
    log(f"done: {len(written)} window files, {len(stats_all):,} window×link rows, {time.perf_counter() - t_all:.1f} s → {OUT_DIR}")
if traj_files:
    with open(TRAJ_DIR / "index.json", "w", encoding="utf-8") as f:
        json.dump({"window_min": TRAJ_WINDOW_MIN, "slot_min": WINDOW_MIN, "files": {n: c for n, c in traj_files}}, f, ensure_ascii=False, indent=1)
    log(f"traj/: {len(traj_files)} slot files, {sum(c for _, c in traj_files):,} trajectories")
''')

md(r'''
## 9. 確認

- ウィンドウ別のリンク数・総 Hits・平均速度
- Hits 上位リンク
- 割り付けの内訳（`summary.csv`）
''')
code(r'''
if all_stats and any(len(x) for x in all_stats):
    print(stats_all.groupby("window").agg(links=("Id", "size"), Hits=("Hits", "sum"), AvgSp=("AvgSp", "mean")).round(1))
    top = stats_all.groupby("Id").Hits.sum().sort_values(ascending=False).head(10)
    display(links.set_index("Id").loc[top.index, [c for c in ["StreetName", "FRC", "SpeedLimit", "Length"] if c in links.columns]].assign(Hits=top.values))
    cols = [c for c in ["vehicle_windows", "sampled_points", "no_candidate_points", "short_points", "segments", "assigned_rows", "via_rows"] if c in summary.columns]
    print("合計:", summary[cols].sum().astype(int).to_dict())
''')

nb = {"cells": cells, "metadata": {"kernelspec": {"display_name": "Python 3", "language": "python", "name": "python3"},
      "language_info": {"name": "python"}}, "nbformat": 4, "nbformat_minor": 5}
out = Path(__file__).parent / "truck_traffic.ipynb"
json.dump(nb, open(out, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
print("wrote", out, len(cells), "cells")
