"""Builds truck_traffic.ipynb (cell by cell) from the cell sources below.  python3 build_truck_nb.py"""
import json
from pathlib import Path

cells = []
def md(s): cells.append({"cell_type": "markdown", "metadata": {}, "source": s.strip("\n").splitlines(keepends=True)})
def code(s): cells.append({"cell_type": "code", "metadata": {}, "execution_count": None, "outputs": [], "source": s.strip("\n").splitlines(keepends=True)})

md(r'''
# トラックプローブ → 15 分・道路リンク別の交通量・速度

1 秒毎のトラックプローブ（zip 内の 1 時間毎 CSV）を TomTom 道路ネットワークに最近傍法で割り付け、
15 分ウィンドウ × 道路リンク別の車両数（Hits）と平均速度（AvgSp）を出力します。

処理の流れ
1. **ネットワーク集約**: 形状が完全に一致するリンクを 1 本に統合し、リンクテーブルを作る
2. **ファイル読み込み**: zip を解凍せずに 1 時間分の CSV を読む
3. **最近傍割付**: 各 GPS 点を最も近いリンクに割り付ける（リンク → [(時刻, 速度), …] の対応）
4. **在線判定**: 15 分ウィンドウ × 車両 × リンクごとに平均速度と観測数を評価し、制限速度を著しく超える／
   リンク長 ÷ 速度の秒数を著しく下回る場合は「非割付リスト {リンク: 車両}」に登録
5. **再割付**: 非割付になった点を、そのリンクを除いた最近傍リンクに付け直す。4 → 5 をリストが空になるまで繰り返す。
   同じウィンドウで 4 本以上のリンクから非割付になった車両は割付不可として除外
6. **集計**: 15 分ウィンドウ × リンクの車両数・平均速度を集計し、ウィンドウ毎の CSV に書く
7. **軌跡**: 15 分毎に、直近 1 時間の各車両の軌跡を GeoJSON に書く（ビューワーのトラックタブで重ねる）

範囲を絞る場合は `AREA_GEOJSON` に区域ポリゴン（例: 新宿区の tokyo.geojson）を与えます。点はポリゴン内だけ、
リンクはその外接矩形（+1 km）内だけを使うので、計算量が大きく減ります。

必要なライブラリ: geopandas, shapely 2.x, pyproj, pandas, numpy。

仕様に無い追加・解釈（すべてパラメータ化。詳細は各節）

| 項目 | 内容 |
|---|---|
| ネットワーク外 | 最近傍リンクまで `MATCH_MAX_M`（50 m）より遠い点は割り付けない |
| 停車 | ウィンドウ内の最高速度が `MOVING_KMH`（3 km/h）未満の車両 × リンクは駐停車とみなし、車両数に数えない |
| 「著しく超える」 | 平均速度 > max(制限速度 × 1.3, 制限速度 + 20 km/h) |
| 「著しく下回る」 | 観測数 < max(3, 0.3 × 期待通過秒数)。期待通過秒数はウィンドウの端で切れている分だけ短くする |
| 非割付リスト | (ウィンドウ, 車両, リンク) で管理。「長さ 4 以上」は同じウィンドウで非割付になったリンク数が 4 以上 |
| 出力の Id | 集約後の代表 Id（メンバー中の最小 Id）。観測の無いリンクは行を持たない |
''')

md("## 0. パラメータ")
code(r'''
from pathlib import Path
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

# ---- step 3: 最近傍割付 ---------------------------------------------------
MATCH_MAX_M = 50.0            # 最近傍リンクまでの距離がこれを超える点はネットワーク外として割り付けない [m]

# ---- step 4: 在線判定（ウィンドウ × 車両 × リンクごと） ---------------------
SPEED_OVER_FACTOR = 1.3       # 平均速度 > max(制限速度 × この係数, 制限速度 + SPEED_OVER_MARGIN_KMH) なら「著しく超える」
SPEED_OVER_MARGIN_KMH = 20.0  #   （低い制限速度で係数だけだと厳しすぎるので余裕も持たせる）
MIN_OBS_RATIO = 0.3           # 観測数 < この割合 × 期待通過秒数 なら「著しく下回る」
MIN_OBS_SEC = 3               #   かつ観測数がこれ未満でも「著しく下回る」（かすめただけの点を落とす）
EXPECTED_CAP_S = WINDOW_MIN * 60  # 期待通過秒数の上限（渋滞で極端に遅いときに全車を落とさないため）
MOVING_KMH = 3.0              # ウィンドウ内の最高速度がこれ未満なら停車中（駐車）とみなし、交通として数えない

# ---- step 5: 再割付 --------------------------------------------------------
MAX_REJECT = 4                # 同じウィンドウで非割付になったリンク数がこれ以上の車両は割付不可として除外
MAX_ITER = 10                 # 4 → 5 の繰り返し上限（通常は 2〜5 回で空になる）

WRITE_GROUPS = True           # ウィンドウ × 車両 × リンクの判定表（groups.csv、車両 ID を含む診断用）も書くか

# ---- step 7: 直近 1 時間の軌跡（15 分毎） ----------------------------------
TRAJ_OUT = True               # traj/traj_YYYYMMDD_HHMM.geojson を書くか（HHMM = 窓の終端。窓は (T-60 分, T]）
TRAJ_WINDOW_MIN = 60          # 軌跡の窓 [分]
TRAJ_GAP_MIN = 5.0            # この分数を超える欠測で軌跡を切る
TRAJ_SIMPLIFY_M = 5.0         # 軌跡の間引き（Douglas-Peucker の許容誤差 [m]）
TRAJ_MIN_LEN_M = 10.0         # これより短い軌跡（駐車中など）は書かない

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

# 最近傍検索用の空間インデックス（投影座標）
tree = STRtree(links_m.geometry.values)
to_m = Transformer.from_crs("EPSG:4326", CRS_M, always_xy=True)
''')

md(r'''
## 2. ファイル読み込み（step 2）

zip を解凍せず、メンバーを 1 つずつ読みます（`__MACOSX/` や `._` で始まる Finder の付随ファイルは除外）。
時刻は `record_time`、車両 ID は `serial_number`（先頭の 0 を保つため文字列）。
緯度経度・時刻・速度が欠けた行は落とし、同一車両・同一秒の重複は 1 行にします。
`window` 列（`WINDOW_MIN` 分で切り捨てた時刻）はここで付けておきます。
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
    df.attrs["dropped"] = n0 - len(df); df.attrs["outside"] = n1 - len(df)
    return df

df = read_member(members[0])
print(f"{members[0]}: {len(df):,} rows / vehicles {df.vid.nunique():,} / {df.t.min()} – {df.t.max()} / dropped {df.attrs['dropped']}")
display(df.head())
''')

md(r'''
## 3. 最近傍割付（step 3）

各点を投影座標に変換し、`STRtree.query_nearest` で最も近いリンクを取ります（`MATCH_MAX_M` より遠い点はネットワーク外）。
結果は点ごとの `link`（内部インデックス、-1 = 未割付）と `dist`（m）。「リンク → [(時刻, 速度), …]」の辞書は
`pts.groupby("link")` で得られる形なので、明示的な辞書は作らず DataFrame のまま扱います（同じ意味で、はるかに速い）。
''')
code(r'''
def assign_nearest(df):
    """点ごとの最近傍リンク。返り値は df に x, y, link, dist, status を足したもの（lat, lon は落とす）。"""
    x, y = to_m.transform(df["lon"].to_numpy(), df["lat"].to_numpy())
    pts = shapely.points(x, y)
    idx, dist = tree.query_nearest(pts, max_distance=MATCH_MAX_M, return_distance=True, all_matches=False)
    link = np.full(len(df), -1, dtype=np.int64); d = np.full(len(df), np.nan)
    link[idx[0]] = idx[1]; d[idx[0]] = dist
    out = df.drop(columns=["lat", "lon"])
    out["x"], out["y"], out["link"], out["dist"] = x, y, link, d
    out["status"] = np.where(link >= 0, "ok", "off_network")
    return out

pts = assign_nearest(df)
print(f"割付 {int((pts.link >= 0).sum()):,} / ネットワーク外 {int((pts.link < 0).sum()):,}")
print("最近傍距離 [m] の分位:", pts.dist.quantile([0.5, 0.9, 0.99]).round(1).to_dict())

# 「リンク → [(時刻, 速度), …]」の見え方（先頭 3 リンク）
for link_idx, g in list(pts[pts.link >= 0].groupby("link"))[:3]:
    print(int(links.Id[link_idx]), list(zip(g.t.dt.strftime("%H:%M:%S"), g.speed))[:4], "…", len(g), "点")
''')

md(r'''
## 4. 在線判定（step 4）

判定の単位は **ウィンドウ × 車両 × リンク**（以下「グループ」）。グループごとに観測数 `n`、平均速度 `v_mean`、最高速度 `v_max`、
期待通過秒数 `expected_s = Length ÷ v_mean` を求めます。ウィンドウの端で通過が切れている場合（車両がウィンドウの途中でリンクに入った、
または途中で出た）は、その車両がウィンドウ内でリンク上に居られた最大秒数まで `expected_s` を短くします
（`min(expected_s, ウィンドウ終了 − 最初の観測, 最後の観測 − ウィンドウ開始 + 1, EXPECTED_CAP_S)`）。
1 時間ファイルの境界も 15 分の境界なので、同じ扱いで済みます。

- `stopped`   : `v_max < MOVING_KMH`（駐停車。交通として数えず、再割付もしない）
- `over_speed`: `v_mean > max(SpeedLimit × SPEED_OVER_FACTOR, SpeedLimit + SPEED_OVER_MARGIN_KMH)`（制限速度が無いリンクでは判定しない）
- `too_short` : `n < max(MIN_OBS_SEC, MIN_OBS_RATIO × expected_s)`

`over_speed` と `too_short` が「非割付」で、(ウィンドウ, 車両, リンク) を非割付リストに登録します。
''')
code(r'''
KEY = ["window", "vid", "link"]

def evaluate_groups(pts):
    """割り付いている点を (ウィンドウ, 車両, リンク) にまとめ、status（ok / stopped / over_speed / too_short）を付けて返す。"""
    a = pts[pts.link >= 0]
    g = (a.groupby(KEY, sort=False)
          .agg(n=("t", "size"), v_mean=("speed", "mean"), v_max=("speed", "max"), t0=("t", "min"), t1=("t", "max"), dist_mean=("dist", "mean"))
          .reset_index())
    g = g.join(links[["Id", "Length", "SpeedLimit"]], on="link")
    v = g.v_mean.to_numpy(); lim = g.SpeedLimit.fillna(0).to_numpy(dtype=float)
    with np.errstate(divide="ignore"):
        expected = np.where(v > 0, g.Length.to_numpy() / (v / 3.6), np.inf)
    w0 = g.window; w1 = w0 + pd.Timedelta(minutes=WINDOW_MIN)
    avail = np.minimum((w1 - g.t0).dt.total_seconds().to_numpy(), (g.t1 - w0).dt.total_seconds().to_numpy() + 1)
    expected = np.minimum.reduce([expected, avail, np.full(len(g), float(EXPECTED_CAP_S))])
    stopped = g.v_max.to_numpy() < MOVING_KMH
    over = (lim > 0) & (v > np.maximum(lim * SPEED_OVER_FACTOR, lim + SPEED_OVER_MARGIN_KMH))
    short = g.n.to_numpy() < np.maximum(MIN_OBS_SEC, MIN_OBS_RATIO * expected)
    g["expected_s"] = expected
    g["status"] = np.select([stopped, over, short], ["stopped", "over_speed", "too_short"], default="ok")
    return g

groups = evaluate_groups(pts)
print(groups.status.value_counts().to_dict())
display(groups.sort_values("status").head(10))

# 非割付リスト {リンク Id: [車両, …]}（最初の判定結果。実際には (ウィンドウ, 車両, リンク) の集合で持つ）
rejected = groups[groups.status.isin(["over_speed", "too_short"])]
print("非割付リスト（先頭 5 リンク）:", dict(list(rejected.groupby("Id")["vid"].apply(lambda s: sorted(set(s))).items())[:5]))
''')

md(r'''
## 5. 再割付（step 5）と 4 → 5 の繰り返し

非割付になったグループの点を、非割付リストにある (ウィンドウ, 車両, リンク) を除いた最近傍リンクに付け直します。候補は
`MATCH_MAX_M` 以内の全リンク（`query` + `dwithin`）から距離順に選び、候補が無い点は未割付（`no_candidate`）。
同じウィンドウで `MAX_REJECT` 本以上のリンクから非割付になった車両は割付不可（`unassignable`）として、そのウィンドウの全点を除外します。

繰り返しは、グループ表を作り直して再判定 → 新しい非割付が無くなるまで（`MAX_ITER` 回まで）。
最後にもう一度判定して、各点に最終状態を付けます（`ok` の点だけが集計対象。収束しなかった分は非割付のまま除外されます）。
''')
code(r'''
def reassign(pts, new_rejects, excluded, reject_count):
    """new_rejects: 今回非割付になった (window, vid, link) の集合。excluded: これまでの全非割付。
    reject_count: {(window, vid): 非割付リンク数}。非割付グループの点を候補の中の最近傍へ付け替える（pts を書き換える）。"""
    ex_idx = pd.MultiIndex.from_tuples(sorted(excluded), names=KEY)
    cur = pd.MultiIndex.from_frame(pts[KEY])
    move = cur.isin(pd.MultiIndex.from_tuples(sorted(new_rejects), names=KEY))
    # 割付不可: そのウィンドウで MAX_REJECT 本以上のリンクから非割付になった車両は、ウィンドウ内の全点を除外
    bad = [k for k, c in reject_count.items() if c >= MAX_REJECT]
    if bad:
        bad_mask = pd.MultiIndex.from_frame(pts[["window", "vid"]]).isin(pd.MultiIndex.from_tuples(bad))
        pts.loc[bad_mask, "link"] = -1; pts.loc[bad_mask, "dist"] = np.nan; pts.loc[bad_mask, "status"] = "unassignable"
        move &= ~bad_mask
    mi = np.flatnonzero(move)
    if len(mi) == 0:
        return 0
    p = shapely.points(pts.x.to_numpy()[mi], pts.y.to_numpy()[mi])
    pi, li = tree.query(p, predicate="dwithin", distance=MATCH_MAX_M)
    cand = pd.DataFrame({"row": mi[pi], "link": li})
    cand["window"] = pts.window.to_numpy()[cand.row]; cand["vid"] = pts.vid.to_numpy()[cand.row]
    cand["dist"] = shapely.distance(p[pi], links_m.geometry.values[li])
    cand = cand[~pd.MultiIndex.from_frame(cand[KEY]).isin(ex_idx)].sort_values(["row", "dist"], kind="stable").drop_duplicates("row")
    lab = pts.index[mi]
    pts.loc[lab, "link"] = -1; pts.loc[lab, "dist"] = np.nan; pts.loc[lab, "status"] = "no_candidate"
    lab = pts.index[cand.row.to_numpy()]
    pts.loc[lab, "link"] = cand.link.to_numpy(); pts.loc[lab, "dist"] = cand.dist.to_numpy(); pts.loc[lab, "status"] = "ok"
    return len(mi)

def match_hour(pts, verbose=True):
    """step 3 の結果 pts に step 4 → 5 を繰り返し、(点の最終状態, 最終グループ表, 非割付集合) を返す。"""
    pts = pts.reset_index(drop=True)
    excluded, reject_count = set(), {}
    for it in range(1, MAX_ITER + 1):
        g = evaluate_groups(pts)
        rej = g[g.status.isin(["over_speed", "too_short"])]
        new = set(zip(rej.window, rej.vid, rej.link)) - excluded
        if verbose:
            print(f"  iter {it}: groups {len(g):,} / " + " / ".join(f"{s} {int((g.status == s).sum()):,}" for s in ["ok", "stopped", "over_speed", "too_short"])
                  + f" / new rejects {len(new):,}")
        if not new:
            break
        excluded |= new
        for w, v, _ in new:
            reject_count[(w, v)] = reject_count.get((w, v), 0) + 1
        reassign(pts, new, excluded, reject_count)
    else:
        print(f"  警告: {MAX_ITER} 回で収束しませんでした（残った非割付は除外されます）")
    # 最終判定: 現在の割付から作り直したグループ表で各点に状態を付ける（link < 0 の点は off_network 等をそのまま持つ）
    final = evaluate_groups(pts)
    on = (pts.link >= 0).to_numpy()
    st = pd.Series(final.status.to_numpy(), index=pd.MultiIndex.from_frame(final[KEY]))
    pts.loc[on, "status"] = st.reindex(pd.MultiIndex.from_frame(pts.loc[on, KEY])).to_numpy()
    return pts, final, excluded

pts, groups, excluded = match_hour(pts)
print("点の最終状態:", pts.status.value_counts().to_dict())
print("非割付 (ウィンドウ, 車両, リンク Id):", sorted((f"{w:%H:%M}", v, int(links.Id[l])) for w, v, l in excluded)[:10])
''')

md(r'''
## 6. 15 分集計（step 6）

`status == "ok"` のグループ（ウィンドウ × 車両 × リンク）から、リンク × ウィンドウで
**Hits = 車両数、AvgSp = 車両ごとの平均速度の平均、MedSp = その中央値、n_points = 点数** を集計します。
ウィンドウ毎に `traffic_YYYYMMDD_HHMM.csv` を書きます（`Id` は集約後の代表 Id。観測の無いリンクは行を持ちません）。
''')
code(r'''
def aggregate_windows(groups):
    ok = groups[groups.status == "ok"]
    stats = (ok.groupby(["window", "Id"])
               .agg(Hits=("vid", "size"), AvgSp=("v_mean", "mean"), MedSp=("v_mean", "median"), n_points=("n", "sum"))
               .reset_index())
    stats["AvgSp"] = stats.AvgSp.round(2); stats["MedSp"] = stats.MedSp.round(2)
    return stats

def write_windows(stats, out_dir=OUT_DIR):
    written = []
    for w, g in stats.groupby("window"):
        name = f"traffic_{w:%Y%m%d_%H%M}.csv"
        g.drop(columns="window").sort_values("Id").to_csv(out_dir / name, index=False)
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
from_m = Transformer.from_crs(CRS_M, "EPSG:4326", always_xy=True)

def traj_slots(df, tail=None):
    """df: 1 ファイル分の点、tail: 前のファイルの末尾 1 時間分。各スロットの GeoJSON を書き、
    [(ファイル名, 地物数), ...] と次のファイルへ渡す tail を返す。"""
    step, win = pd.Timedelta(minutes=WINDOW_MIN), pd.Timedelta(minutes=TRAJ_WINDOW_MIN)
    cols = ["vid", "t", "speed", "lat", "lon"]
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
                x, y = to_m.transform(gg.lon.to_numpy(), gg.lat.to_numpy())
                line = shapely.simplify(shapely.LineString(np.c_[x, y]), TRAJ_SIMPLIFY_M)
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
    df = read_member(members[0])
    written, tail = traj_slots(df)
    print("\n".join(f"{n}: {c} 本" for n, c in written), "/ tail", len(tail), "点")
''')

md(r'''
## 8. 全ファイルの処理

上の step 2 → 6 を zip 内の全ファイルに対して実行します。メモリに残すのはファイルごとの集計結果（小さい）だけで、
グループ表（`groups.csv`、`WRITE_GROUPS` のとき）はファイルごとに追記します。読めないファイルは記録して飛ばします。
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
        pts = assign_nearest(df); del df
        pts, groups, excluded = match_hour(pts, verbose=False)
        stats = aggregate_windows(groups)
        if WRITE_GROUPS:
            groups.assign(file=name).to_csv(OUT_DIR / "groups.csv", mode="a", header=not (OUT_DIR / "groups.csv").exists(), index=False)
        all_stats.append(stats)
        st = pts.status.value_counts()
        summary.append({"file": name, "rows": len(pts), "dropped": dropped, "outside_area": outside, "vehicles": pts.vid.nunique(),
                        **{s: int(st.get(s, 0)) for s in ["ok", "stopped", "off_network", "over_speed", "too_short", "no_candidate", "unassignable"]},
                        "rejected_groups": len(excluded), "windows": stats.window.nunique(), "links_hit": stats.Id.nunique(), "error": ""})
        log(f"[{k}/{len(members)}] {name}: {len(pts):,} pts, {pts.vid.nunique():,} vehicles, ok {summary[-1]['ok']:,}, "
            f"rejected groups {len(excluded):,} ({time.perf_counter() - t0:.1f} s)")
        del pts, groups
    except Exception as e:
        log(f"[{k}/{len(members)}] {name}: skipped ({type(e).__name__}: {e})")
        summary.append({"file": name, "error": f"{type(e).__name__}: {e}"})

summary = pd.DataFrame(summary)
summary.to_csv(OUT_DIR / "summary.csv", index=False)
display(summary)
if all_stats:
    stats_all = pd.concat(all_stats)
    stats_all["sp_x_hits"] = stats_all.AvgSp * stats_all.Hits       # 同じウィンドウ × リンクが複数ファイルに分かれていれば合算
    stats_all = (stats_all.groupby(["window", "Id"])
                          .agg(Hits=("Hits", "sum"), sp_x_hits=("sp_x_hits", "sum"), MedSp=("MedSp", "median"), n_points=("n_points", "sum"))
                          .reset_index())
    stats_all["AvgSp"] = (stats_all.sp_x_hits / stats_all.Hits).round(2)
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
- 点の最終状態の合計（`summary.csv`）
''')
code(r'''
if all_stats:
    print(stats_all.groupby("window").agg(links=("Id", "size"), Hits=("Hits", "sum"), AvgSp=("AvgSp", "mean")).round(1))
    top = stats_all.groupby("Id").Hits.sum().sort_values(ascending=False).head(10)
    display(links.set_index("Id").loc[top.index, [c for c in ["StreetName", "FRC", "SpeedLimit", "Length"] if c in links.columns]].assign(Hits=top.values))
    cols = [c for c in ["ok", "stopped", "off_network", "over_speed", "too_short", "no_candidate", "unassignable"] if c in summary.columns]
    print("点の最終状態の合計:", summary[cols].sum().astype(int).to_dict())
''')

nb = {"cells": cells, "metadata": {"kernelspec": {"display_name": "Python 3", "language": "python", "name": "python3"},
      "language_info": {"name": "python"}}, "nbformat": 4, "nbformat_minor": 5}
out = Path(__file__).parent / "truck_traffic.ipynb"
json.dump(nb, open(out, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
print("wrote", out, len(cells), "cells")
