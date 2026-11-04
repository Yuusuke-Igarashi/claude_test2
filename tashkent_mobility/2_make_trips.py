# -*- coding: utf-8 -*-
"""点列（extract_dense.py の *_points.parquet：maid, ts, lat, lon, acc[, dur_s, seg_id]）から Stay / Move を判定し、Stay と Stay の間をトリップとして
切り出し、速度と移動距離から移動手段（walk / vehicle / unknown）を付ける。

手順（パラメータは全て引数）:
  1. 端末・時刻順に並べる。ワープ（版 l）: 前の点と後の点が互いに近く（跳んで戻った）、かつ 前後とも速度が WARP_KMH 超、または 前後とも速度が
     その前後の区間の速度（下限 WARP_RATIO_FLOOR）の WARP_RATIO 倍以上に跳ねた 1 点を落とす（U ターンは前後の速度が同程度なので残る）。さらに直前の点からの速度が MAX_SPEED_KMH 超の点を落とす。
     点数が MIN_PTS_ID 未満の端末を落とす
  2. Stay 判定（stay point detection）: どの 2 点も STAY_DIAM_M 以内（直径。版 l）に収まる連続点群の時間幅が STAY_MIN_MIN 分以上なら Stay
     （点数は STAY_MIN_PTS 以上（既定 2）。Irys の滞在行は dur_s を時間幅に含め、1 行だけでも時間幅が足りれば Stay）。
     さらに、前後の観測が GAP_AS_STAY_MIN 分（既定 120。版 l）以上途切れている点も便宜的に Stay とみなす（到着して端末が黙った、出発前に黙っていた、を拾う。kind = gap）。
     ただし gap を端点とするトリップは、その端から GAP_MIN_PTS 点（既定 5）が GAP_PTS_GAP_MIN 分（既定 30）以内の間隔で続いて観測されていることを要求する。それ以外の点は Move
  3. 同じ観測区間（seg_id）の中で、Stay の終わりから次の Stay の始まりまでの Move 点列を 1 トリップにする
  4. Move 点が TRIP_MIN_MOVE_PTS 未満、点の間隔の最大が TRIP_MAX_GAP_MIN 分以上（既定 120。--trip-max-mean-gap-min を正にすれば平均間隔でも絞る）、
     起点と終点の直線距離が TRIP_MIN_STRAIGHT_M 未満のトリップは落とす
  4a. 周遊（版 m）: 経路長 len_m が TOUR_MIN_M（既定 3 km）以上で、直線距離の TOUR_RATIO 倍（既定 2.5）以上なら tour = True（mode_detail = "vehicle+周遊" など）。
     起点と終点がほぼ同じ（直線 300 m 未満）でも len_m ≥ TOUR_MIN_M なら捨てずに往復の周遊として残す
  4b. モードチェンジ（版 l）: Move 点の基準点速度（SPEED_MIN_DT 秒以上）の列で、車の速度（≥ VEH_MIN_KMH）が SWITCH_MIN_PTS 本以上続いた後に徒歩の速度（≤ WALK_MAX_KMH）が
     SWITCH_MIN_PTS 本以上続く（またはその逆）なら、境目の点でトリップを分ける。徒歩側はその間に SWITCH_MIN_MOVE_M 以上動いていること（停車・信号待ちでは割らない）。
     中間の速度（徒歩超・車未満）は続いている側に含める。徒歩側はその速度列がモード判定の規則でも walk（平均 ≤ 8 かつ最大 ≤ 15）であること。
     分けた部分の mode を付け直し、隣り合う部分が同じ mode なら境目を取り消す（vehicle>vehicle は作らない）。部分（part）を <out>_trip_parts.parquet に書き、previous_mode（直前の部分の mode）を付ける。
     <out>_trips.parquet は Stay から Stay までの 1 本（chain）のままで、mode は最も長く動いた部分の mode、modes に部分の mode の並び（例 vehicle>walk）、n_parts を持つ
  5. 市域判定: 起点・終点が CITY_BBOX の中かを o_in_city / d_in_city に入れる（抽出は広い範囲で行い、ここで選べるようにする）
  6. 移動手段（版 m: walk か vehicle の 2 値。unknown は無し）: Move 点列から、基準点より SPEED_MIN_DT 秒以上離れた点ごとに「直線距離 ÷ 経過時間」の速度を取り
     （GPS のふらつきを抑える）、その平均 v_mean・中央値 v_med・85% 点 v_p85・最大 v_max と、同じ基準点をつないだ移動距離 len_m（起点・終点を含む）を求める。
       walk    : v_mean ≤ WALK_MAX_KMH（既定 8）かつ v_max ≤ WALK_MAX_PEAK_KMH（既定 15）（--walk-max-len-m を正にすれば len_m の上限も）
       vehicle : それ以外
       Move 点だけでは速度が 2 本未満のトリップは、両端の Stay の実際の観測点（起点 Stay の最後の点、終点 Stay の最初の点）と Move 点を
         つないだ列から速度を取る（speed_src = boundary。端の区間は待ち時間を含むので低めに出る。--no-boundary-speed で無効）
       それでも速度が取れないトリップは、起終点の直線 ÷ 所要（v_all）が WALK_MAX_KMH 以下なら walk、それ以外は vehicle
出力（3 ファイル）:
  <out>_trips.parquet      トリップ表（trip_id, maid, source, t_start/t_end（UTC 秒・現地時刻）, dur_s, 起点終点の緯度経度, o_in_city/d_in_city, n_move_pts, mean_gap_s,
                           len_m（基準点をつないだ移動距離）, len_raw_m（全点をつないだ距離。ふらつきで長く出る）, straight_m, v_med, v_p85, v_max, v_all, n_speed, mode, …）
  <out>_trip_points.parquet トリップの点（trip_id, maid, ts, lat, lon, kind = origin / move / dest, part = 属する部分の番号, switch = モードチェンジの境目）
  <out>_trip_parts.parquet  モードチェンジで分けた部分（trip_id, part, previous_mode, mode, o_kind/d_kind（switch = 境目）, 距離・速度の列）。境目の無いトリップは含まない
  <out>.gpkg               層 trips（LineString、mode 列付き）, trips_by_device（端末ごとの MultiLineString）, stays（Point）, trip_points（Point）。geopandas が無ければ代わりに <out>_stays.parquet
  任意: --csv でトリップ表の csv、--split-mode で mode 別のトリップ表（<out>_trips_walk.parquet など）

使い方: python make_trips.py <points.parquet> [<points2.parquet> ...] --out trips --source Factori [Irys ...]
  点ファイルを複数渡すと端末ごとに合わせてから処理する（Factori と Irys は同じ端末 ID が多く、同じ移動を両方が観測していることがあるので、
  同じ秒の点は 1 つにし、MERGE_MIN_GAP 秒未満で連続する点も間引く）。--source はファイルと同じ順に名前を並べる（省略時はファイル名）。
  トリップ表の source 列は、そのトリップの点を提供した側（"Factori" / "Irys" / "Factori+Irys"）
  --stay-diam-m 300 --stay-min-min 15 --stay-min-pts 2 --gap-as-stay-min 120 --gap-min-pts 5 --gap-pts-gap-min 30 --trip-min-move-pts 1 --trip-max-gap-min 120 --trip-min-straight-m 300 --city-bbox 69.10,41.18,69.45,41.42
  --warp-kmh 150 --warp-ratio 8 --warp-ratio-floor-kmh 2 --warp-back 0.5 --switch-min-pts 5 --switch-min-move-m 300 [--no-mode-switch]
  --max-speed-kmh 150 --min-pts-id 10 --speed-min-dt 60 --walk-max-kmh 8 --walk-max-peak-kmh 15 --walk-max-len-m 0 --veh-min-kmh 15
  --merge-min-gap 5 --tz Asia/Tashkent --parts 16 [--allow-open-trips] [--csv] [--split-mode]
  メモリ: 点は端末 ID の先頭の文字で 16 分割（--parts。256 で 2 文字）して順に処理するので、数千万点でも載せきらずに済む（分割は端末単位なので結果は同じ）
必要: pip install pandas pyarrow（gpkg を出すなら geopandas shapely）
"""
import argparse, sys, time
from pathlib import Path
import numpy as np
import pandas as pd

KX, KY = None, None     # 度 → m（緯度の中央値で決める）


def dist_m(lat1, lon1, lat2, lon2):
    """平面近似の距離 [m]（市域スケールなら十分）"""
    return np.hypot((lat2 - lat1) * KY, (lon2 - lon1) * KX)


def label_stays(ts, lat, lon, dur, diam, min_sec, min_pts, gap_sec=0):
    """1 端末（1 観測区間）の点列に Stay の番号を付ける（Move は -1）。古典的な stay point detection:
    i から始めて、どの 2 点も diam 以内（直径）に収まる最長の連続点群 i..j を取り、その時間幅（最後の点の終了 − 最初の点の開始）が min_sec 以上なら Stay"""
    n = len(ts); lab = np.full(n, -1); k = 0; i = 0
    while i < n:
        j = i
        while j + 1 < n and np.all(dist_m(lat[i:j + 1], lon[i:j + 1], lat[j + 1], lon[j + 1]) <= diam): j += 1   # 新しい点が点群の全点と diam 以内
        span = (ts[j] + dur[j]) - ts[i]
        if span >= min_sec and (j - i + 1 >= min_pts or dur[i:j + 1].max() >= min_sec):
            lab[i:j + 1] = k; k += 1; i = j + 1
        else:
            i += 1
    if gap_sec > 0:                                                  # 観測が gap_sec 以上途切れる直前・直後の Move 点は 1 点の Stay（kind = gap）
        end = ts + dur
        before = np.r_[end[:-1] + gap_sec <= ts[1:], True]            # 次の点まで途切れる（最後の点も含む）
        after = np.r_[True, ts[1:] - end[:-1] >= gap_sec]             # 前の点から途切れている（最初の点も含む）
        for i in np.flatnonzero((lab < 0) & (before | after)):
            lab[i] = k; k += 1
    return lab


def boundary_speeds(t, lat, lon, min_dt):
    """両端の Stay の実際の観測点（起点 Stay の最後の点、終点 Stay の最初の点）と Move 点をつないだ列から速度 [km/h] を取る。
    Move が 1〜2 点で速度が取れないトリップ用。端の区間は出発前・到着後の待ち時間を含むので速度は低めに出る（おおよその値）"""
    v, i = [], 0
    for j in range(1, len(t)):
        if t[j] - t[i] >= min_dt:
            v.append(float(dist_m(lat[i], lon[i], lat[j], lon[j])) / (t[j] - t[i]) * 3.6); i = j
    return v


def mode_features(t, lat, lon, min_dt):
    """トリップの点列（起点・Move 点・終点）から、速度 [km/h] の列と、基準点をつないだ移動距離 [m] を返す。
    速度は Move 点だけで測る（起点・終点は Stay の重心なので、最初と最後の区間は見かけの速度が跳ね上がる）。
    Move 点を先頭から見て、基準点より min_dt 秒以上離れた点に達したら「直線距離 ÷ 経過時間」を 1 つの速度とし、その点を次の基準点にする"""
    v, length, i = [], 0.0, 1                                       # 添字 0 = 起点、len-1 = 終点
    length += float(dist_m(lat[0], lon[0], lat[1], lon[1]))         # 起点 → 最初の Move 点
    for j in range(2, len(t) - 1):
        if t[j] - t[i] >= min_dt:
            d = float(dist_m(lat[i], lon[i], lat[j], lon[j])); length += d; v.append(d / (t[j] - t[i]) * 3.6); i = j
    length += float(dist_m(lat[i], lon[i], lat[-1], lon[-1]))       # 最後の基準点 → 終点
    return v, length


def ref_speeds(t, lat, lon, lo, hi, min_dt):
    """Move 点の添字 lo..hi（pts 配列上）について、基準点から min_dt 秒以上離れた点ごとの速度 [km/h] と、その区間の (始点添字, 終点添字) を返す"""
    v, seg, i = [], [], lo
    for j in range(lo + 1, hi + 1):
        if t[j] - t[i] >= min_dt:
            v.append(float(dist_m(lat[i], lon[i], lat[j], lon[j])) / (t[j] - t[i]) * 3.6); seg.append((i, j)); i = j
    return v, seg


def trip_record(t, lat, lon, lo, hi, o_kind, d_kind, ob, db, a):
    """pts 配列の lo..hi（lo = 起点、hi = 終点、その間が Move 点）について、距離・速度・mode などの属性 dict を返す。
    ob / db = 境界速度に使う起点側・終点側の実点 (lat, lon)（None なら使わない）"""
    t_, la, lo_ = t[lo:hi + 1], lat[lo:hi + 1], lon[lo:hi + 1]
    n_mv = hi - lo - 1; t_s, t_e = int(t_[0]), int(t_[-1])
    straight = float(dist_m(la[0], lo_[0], la[-1], lo_[-1]))
    len_raw = float(dist_m(la[:-1], lo_[:-1], la[1:], lo_[1:]).sum())
    v, len_rb = mode_features(t_, la, lo_, a.speed_min_dt)
    v_all = straight / max(t_e - t_s, 1) * 3.6; speed_src = "move" if len(v) >= 2 else "none"
    if len(v) < 2 and ob is not None and db is not None and a.boundary_speed:
        vb = boundary_speeds(t_, np.r_[ob[0], la[1:-1], db[0]], np.r_[ob[1], lo_[1:-1], db[1]], a.speed_min_dt)
        if vb: v = vb; speed_src = "boundary"
    if v:                                                                 # 版 m: walk か vehicle の 2 値。平均 ≤ walk_max かつ 最大 ≤ walk_max_peak なら walk、それ以外は vehicle
        v = np.array(v); v_med, v_mean, v_p85, v_max = float(np.median(v)), float(v.mean()), float(np.quantile(v, 0.85)), float(v.max())
        mode = "walk" if (v_mean <= a.walk_max_kmh and v_max <= a.walk_max_peak_kmh and (a.walk_max_len_m <= 0 or len_rb <= a.walk_max_len_m)) else "vehicle"
    else:                                                                 # 速度が 1 本も取れない: 起終点の直線 ÷ 所要（v_all）で判定
        v_med = v_mean = v_p85 = v_max = np.nan
        mode = "walk" if v_all <= a.walk_max_kmh else "vehicle"
    return {"t_start": t_s, "t_end": t_e, "dur_s": t_e - t_s, "o_lat": float(la[0]), "o_lon": float(lo_[0]), "d_lat": float(la[-1]), "d_lon": float(lo_[-1]),
            "n_move_pts": int(n_mv), "mean_gap_s": round(float(np.diff(t_).mean()), 1) if len(t_) > 1 else 0.0,
            "len_m": round(len_rb), "len_raw_m": round(len_raw), "straight_m": round(straight),
            "v_med": round(v_med, 1), "v_mean": round(v_mean, 1), "v_p85": round(v_p85, 1), "v_max": round(v_max, 1), "v_all": round(v_all, 1),
            "n_speed": len(v), "speed_src": speed_src, "mode": mode, "o_kind": o_kind, "d_kind": d_kind}


def switch_points(t, lat, lon, lo, hi, a):
    """モードチェンジの境目（pts 配列の添字）を返す。基準点速度の列を 車（≥ veh_min）/ 徒歩（≤ walk_max）/ 中間 に分け、
    中間は続いている側に含めて「車が K 本以上 → 徒歩が K 本以上（その間の変位 ≥ switch_min_move_m）」またはその逆が起きた境目で分ける"""
    v, seg = ref_speeds(t, lat, lon, lo, hi, a.speed_min_dt)
    if len(v) < 2 * a.switch_min_pts: return []
    cls = ["v" if x >= a.veh_min_kmh else "w" if x <= a.walk_max_kmh else "m" for x in v]
    runs = []                                                   # [種類, 最初の速度の番号, 最後の速度の番号]
    for k, c in enumerate(cls):
        if c == "m":
            if runs: runs[-1][2] = k
            continue
        if runs and runs[-1][0] == c: runs[-1][2] = k
        elif runs and runs[-1][0] == "m": runs[-1] = [c, runs[-1][1], k]
        else: runs.append([c, k, k])
    cuts = []
    for r0, r1 in zip(runs, runs[1:]):
        n0 = sum(1 for k in range(r0[1], r0[2] + 1) if cls[k] == r0[0]); n1 = sum(1 for k in range(r1[1], r1[2] + 1) if cls[k] == r1[0])
        if n0 < a.switch_min_pts or n1 < a.switch_min_pts: continue
        wr = r0 if r0[0] == "w" else r1                            # 徒歩側はその間に動いていること
        i0, j1 = seg[wr[1]][0], seg[wr[2]][1]
        if dist_m(lat[i0], lon[i0], lat[j1], lon[j1]) < a.switch_min_move_m: continue
        vw = np.array(v[wr[1]:wr[2] + 1])                            # 徒歩側の全速度（中間を含む）がモード判定の規則でも walk になること
        if vw.mean() > a.walk_max_kmh or vw.max() > a.walk_max_peak_kmh: continue
        cuts.append(seg[r1[1]][0])                                 # 後の側の最初の区間の始点 = 境目の点
    return cuts


VERSION = "2026-11-04m"


def main():
    print(f"{Path(__file__).name} 版 {VERSION}")
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("points", nargs="+"); ap.add_argument("--out", required=True); ap.add_argument("--source", nargs="*", default=None)
    ap.add_argument("--merge-min-gap", type=float, default=5)
    ap.add_argument("--stay-diam-m", type=float, default=300, help="Stay の直径 [m]（点群のどの 2 点もこの距離以内）"); ap.add_argument("--stay-min-min", type=float, default=15); ap.add_argument("--stay-min-pts", type=int, default=2); ap.add_argument("--gap-as-stay-min", type=float, default=120); ap.add_argument("--gap-min-pts", type=int, default=5)
    ap.add_argument("--trip-min-move-pts", type=int, default=1); ap.add_argument("--trip-max-gap-min", type=float, default=120, help="トリップ内の点の間隔の最大 [分]（これ以上なら落とす）")
    ap.add_argument("--trip-max-mean-gap-min", type=float, default=0, help="平均間隔 [分] でも絞る（0 = 使わない）"); ap.add_argument("--trip-min-straight-m", type=float, default=300)
    ap.add_argument("--gap-pts-gap-min", type=float, default=30, help="gap 端点側の GAP_MIN_PTS 点に要求する間隔 [分]")
    ap.add_argument("--warp-kmh", type=float, default=150, help="ワープ判定: 前後とも速度がこの値を超える 1 点（0 = 判定しない）"); ap.add_argument("--warp-back", type=float, default=0.5, help="ワープ判定: 前の点と後の点の距離が、跳んだ距離のこの割合以下なら戻ったとみなす")
    ap.add_argument("--warp-ratio", type=float, default=8, help="ワープ判定（相対）: その点への速度と次の点への速度が、それぞれ前の区間・後の区間の速度のこの倍以上（0 = 使わない）"); ap.add_argument("--warp-ratio-floor-kmh", type=float, default=2, help="相対判定の基準速度の下限 [km/h]（静止中のふらつきを過剰に拾わないため）")
    ap.add_argument("--tour-min-m", type=float, default=3000, help="周遊の判定: 経路長の下限 [m]（往復はこれ以上動いていれば残す）"); ap.add_argument("--tour-ratio", type=float, default=2.5, help="周遊の判定: 経路長 ÷ 直線距離 の下限")
    ap.add_argument("--switch-min-pts", type=int, default=5, help="モードチェンジ: 車側・徒歩側それぞれに要る基準点速度の本数"); ap.add_argument("--switch-min-move-m", type=float, default=300); ap.add_argument("--no-mode-switch", dest="mode_switch", action="store_false")
    ap.add_argument("--max-speed-kmh", type=float, default=150); ap.add_argument("--min-pts-id", type=int, default=10)
    ap.add_argument("--speed-min-dt", type=float, default=60); ap.add_argument("--walk-max-kmh", type=float, default=8); ap.add_argument("--walk-max-peak-kmh", type=float, default=15)
    ap.add_argument("--walk-max-len-m", type=float, default=0, help="walk の移動距離の上限 [m]（0 = 使わない）"); ap.add_argument("--veh-min-kmh", type=float, default=15, help="モードチェンジ判定で「車の速度」とみなす下限 [km/h]")
    ap.add_argument("--no-boundary-speed", dest="boundary_speed", action="store_false")
    ap.add_argument("--city-bbox", default="69.10,41.18,69.45,41.42")
    ap.add_argument("--parts", type=int, default=16, choices=[1, 16, 256], help="端末 ID の先頭文字で分けて処理する数（メモリ対策。16 = 1 文字、256 = 2 文字、1 = 分けない）")
    ap.add_argument("--tz", default="Asia/Tashkent"); ap.add_argument("--allow-open-trips", action="store_true"); ap.add_argument("--csv", action="store_true"); ap.add_argument("--split-mode", action="store_true")
    a = ap.parse_args()
    global KX, KY
    KX = None
    t0 = time.time()
    names = a.source if a.source else [Path(f).stem.replace("_dense_points", "").replace("_points", "") for f in a.points]
    if len(names) != len(a.points): sys.exit("--source の数が点ファイルの数と合いません")
    import pyarrow as pa, pyarrow.dataset as ds, pyarrow.compute as pc
    HEX = list("0123456789abcdef")
    if a.parts == 1: keys = [None]
    elif a.parts == 16: keys = HEX + ["other"]
    else: keys = [x + y for x in HEX for y in HEX] + ["other"]
    nchar = 1 if a.parts == 16 else 2
    datasets = [ds.dataset(f, format="parquet") for f in a.points]
    for f, nm, d_ in zip(a.points, names, datasets):
        print(f"入力 {f}: {d_.count_rows():,} 点（source = {nm}）", flush=True)

    def read_partition(key):
        parts = []
        for d_, nm in zip(datasets, names):
            if key is None: tbl = d_.to_table()
            else:
                first = pc.utf8_slice_codeunits(pc.utf8_lower(ds.field("maid")), 0, nchar)
                expr = ~pc.is_in(first, value_set=pa.array(keys[:-1])) if key == "other" else (first == key)
                tbl = d_.to_table(filter=expr)
            d = tbl.to_pandas(); d["src"] = nm; parts.append(d)
        df = pd.concat(parts, ignore_index=True)
        if "dur_s" not in df: df["dur_s"] = 0
        df["dur_s"] = df["dur_s"].fillna(0); df["seg_id"] = 0                 # 複数ソースを合わせるので区間は端末全体で 1 つ
        df = df[["maid", "ts", "lat", "lon", "acc", "dur_s", "seg_id", "src"]].sort_values(["maid", "ts"]).reset_index(drop=True)
        if len(datasets) > 1:                                                   # 同じ秒の点は 1 つに、MERGE_MIN_GAP 秒未満で続く点は間引く（同じ移動の二重観測）
            st["n0"] += len(df); st["n_both"] += int(df.groupby("maid")["src"].nunique().gt(1).sum())
            df = df.drop_duplicates(["maid", "ts"]).reset_index(drop=True)
            dprev = df["ts"] - df.groupby("maid")["ts"].shift()
            df = df[dprev.isna() | (dprev >= a.merge_min_gap)].reset_index(drop=True)
        st["merged"] += len(df); st["dev"] += int(df["maid"].nunique())
        return df

    st = {"n0": 0, "n_both": 0, "merged": 0, "dev": 0, "bad": 0, "warp": 0, "kept_pts": 0, "kept_dev": 0, "move": 0, "all_pts": 0, "drop_gap": 0, "drop_maxgap": 0, "drop_straight": 0, "switch": 0, "switch_merged": 0, "tour": 0, "round_kept": 0}
    all_stays, all_trips, all_tp, all_parts = [], [], [], []; trip_id = 0

    def process(df, trip_id):
        """1 つの分割（端末の集合）について Stay 判定 → トリップ → 移動手段。戻り値: stay_rows, trips, tp_rows, 最後の trip_id"""
        # 1) 異常な点（速度）と点数の少ない端末を落とす
        if a.warp_kmh > 0:                                                    # ワープ: 前後とも速度が大きく、前の点と後の点は互いに近い 1 点
            same_p = df["maid"].eq(df["maid"].shift()); same_n = df["maid"].eq(df["maid"].shift(-1))
            d_p = dist_m(df["lat"].shift(), df["lon"].shift(), df["lat"], df["lon"]); dt_p = (df["ts"] - (df["ts"].shift() + df["dur_s"].shift())).clip(lower=1)
            d_n = dist_m(df["lat"], df["lon"], df["lat"].shift(-1), df["lon"].shift(-1)); dt_n = (df["ts"].shift(-1) - (df["ts"] + df["dur_s"])).clip(lower=1)
            d_skip = dist_m(df["lat"].shift(), df["lon"].shift(), df["lat"].shift(-1), df["lon"].shift(-1))
            v_p, v_n = d_p / dt_p * 3.6, d_n / dt_n * 3.6
            back = d_skip <= a.warp_back * np.maximum(d_p, d_n)                   # 前の点と次の点は互いに近い（跳んで戻った）
            fast = (v_p > a.warp_kmh) & (v_n > a.warp_kmh)                        # 絶対: 前後とも warp_kmh 超
            v_pp = v_p.shift() .where(df["maid"].eq(df["maid"].shift(2)))         # その前の区間の速度（i-2 → i-1）と、その後の区間の速度（i+1 → i+2）
            v_nn = v_n.shift(-1).where(df["maid"].eq(df["maid"].shift(-2)))
            jump = (a.warp_ratio > 0) & (v_p >= a.warp_ratio * np.maximum(v_pp, a.warp_ratio_floor_kmh)) & (v_n >= a.warp_ratio * np.maximum(v_nn, a.warp_ratio_floor_kmh))   # 相対: 前後の区間の速度の warp_ratio 倍以上に跳ねた（U ターンは前後の速度が同程度なので残る）
            warp = same_p & same_n & back & (fast | jump)
            warp = warp.fillna(False); st["warp"] += int(warp.sum()); df = df[~warp]
        same = df["maid"].eq(df["maid"].shift())
        d = dist_m(df["lat"].shift(), df["lon"].shift(), df["lat"], df["lon"]); dt = df["ts"] - (df["ts"].shift() + df["dur_s"].shift())
        speed = np.where(same & (dt > 0), d / dt.clip(lower=1) * 3.6, 0)
        bad = pd.Series(speed > a.max_speed_kmh, index=df.index)
        df = df[~bad]
        cnt = df.groupby("maid")["ts"].transform("size"); df = df[cnt >= a.min_pts_id].reset_index(drop=True)
        st["bad"] += int(bad.sum()); st["kept_pts"] += len(df); st["kept_dev"] += int(df["maid"].nunique())

        # 2) Stay 判定 → 3) トリップ → 5) 移動手段（端末 × 観測区間ごと）
        stay_lab = np.full(len(df), -1); stay_rows = []; trips = []; tp_rows = []
        ts_all, lat_all, lon_all, dur_all, src_all = df["ts"].values, df["lat"].values, df["lon"].values, df["dur_s"].values.astype(float), df["src"].values
        for (maid, seg), idx in df.groupby(["maid", "seg_id"], sort=False).indices.items():
            sl = slice(idx[0], idx[-1] + 1)
            ts, lat, lon, dur, src = ts_all[sl], lat_all[sl], lon_all[sl], dur_all[sl], src_all[sl]
            lab = label_stays(ts, lat, lon, dur, a.stay_diam_m, a.stay_min_min * 60, a.stay_min_pts, a.gap_as_stay_min * 60)
            stay_lab[sl] = lab
            stays = {}
            for k in np.unique(lab[lab >= 0]):
                m = lab == k
                stays[k] = {"lat": float(lat[m].mean()), "lon": float(lon[m].mean()), "t_start": int(ts[m][0]), "t_end": int(ts[m][-1] + dur[m][-1]), "n": int(m.sum()),
                            "kind": "stay" if m.sum() >= a.stay_min_pts or dur[m].max() >= a.stay_min_min * 60 else "gap",
                            "first_lat": float(lat[m][0]), "first_lon": float(lon[m][0]), "last_lat": float(lat[m][-1]), "last_lon": float(lon[m][-1])}   # 実際の観測点（境界速度用）
                stay_rows.append({"maid": maid, "seg_id": seg, "stay_no": int(k), **stays[k]})
            bounds = []; pos = 0; prev_stay = None                        # (起点 Stay, 終点 Stay, Move の添字範囲)
            while pos < len(lab):
                if lab[pos] >= 0:
                    k = lab[pos]; end = pos
                    while end + 1 < len(lab) and lab[end + 1] == k: end += 1
                    prev_stay, pos = k, end + 1
                    continue
                mv0 = pos
                while pos < len(lab) and lab[pos] < 0: pos += 1
                mv1 = pos - 1
                next_stay = int(lab[pos]) if pos < len(lab) else None
                bounds.append((prev_stay, next_stay, mv0, mv1))
            for o, dst, mv0, mv1 in bounds:
                if (o is None or dst is None) and not a.allow_open_trips: continue
                n_mv = mv1 - mv0 + 1
                if n_mv < a.trip_min_move_pts: continue
                o_kind = stays[o]["kind"] if o is not None else "open"; d_kind = stays[dst]["kind"] if dst is not None else "open"
                t_s = stays[o]["t_end"] if o is not None else int(ts[mv0]); t_e = stays[dst]["t_start"] if dst is not None else int(ts[mv1] + dur[mv1])
                o_lat, o_lon = (stays[o]["lat"], stays[o]["lon"]) if o is not None else (lat[mv0], lon[mv0])
                d_lat, d_lon = (stays[dst]["lat"], stays[dst]["lon"]) if dst is not None else (lat[mv1], lon[mv1])
                pts_t = np.r_[t_s, ts[mv0:mv1 + 1], t_e]
                gaps = np.diff(pts_t)
                if a.gap_pts_gap_min > 0 and a.gap_min_pts > 0:                 # gap 端点: その端から gap_min_pts 点が gap_pts_gap_min 分以内の間隔で続くこと
                    ok = True
                    if o_kind == "gap": ok = n_mv >= a.gap_min_pts and np.all(gaps[:a.gap_min_pts] <= a.gap_pts_gap_min * 60)
                    if ok and d_kind == "gap": ok = n_mv >= a.gap_min_pts and np.all(gaps[-a.gap_min_pts:] <= a.gap_pts_gap_min * 60)
                    if not ok: st["drop_gap"] += 1; continue
                elif ("gap" in (o_kind, d_kind)) and n_mv < a.gap_min_pts: st["drop_gap"] += 1; continue
                mean_gap = float(gaps.mean())
                if a.trip_max_gap_min > 0 and gaps.max() >= a.trip_max_gap_min * 60: st["drop_maxgap"] += 1; continue
                if a.trip_max_mean_gap_min > 0 and mean_gap > a.trip_max_mean_gap_min * 60: st["drop_maxgap"] += 1; continue
                straight = float(dist_m(o_lat, o_lon, d_lat, d_lon))
                pts_lat = np.r_[o_lat, lat[mv0:mv1 + 1], d_lat]; pts_lon = np.r_[o_lon, lon[mv0:mv1 + 1], d_lon]
                round_trip = False
                if straight < a.trip_min_straight_m:                               # 起点と終点がほぼ同じ場所: Stay が割れただけなら捨て、長く動いていれば往復（周遊）として残す
                    if mode_features(pts_t, pts_lat, pts_lon, a.speed_min_dt)[1] < a.tour_min_m: st["drop_straight"] += 1; continue
                    round_trip = True; st["round_kept"] += 1
                ob = (stays[o]["last_lat"], stays[o]["last_lon"]) if o is not None else None     # 境界速度用の実点
                db = (stays[dst]["first_lat"], stays[dst]["first_lon"]) if dst is not None else None
                src_all_trip = "+".join(sorted(set(src[mv0:mv1 + 1])))
                cuts = switch_points(pts_t, pts_lat, pts_lon, 1, len(pts_t) - 2, a) if a.mode_switch else []
                trip_id += 1
                chain = trip_record(pts_t, pts_lat, pts_lon, 0, len(pts_t) - 1, o_kind, d_kind, ob, db, a)
                chain.update({"trip_id": trip_id, "maid": maid, "source": src_all_trip, "seg_id": seg, "o_stay": o is not None, "d_stay": dst is not None,
                              "n_parts": len(cuts) + 1, "modes": chain["mode"]})
                def make_parts(cuts_):
                    out_, prev = [], ""
                    edges = [0] + list(cuts_) + [len(pts_t) - 1]
                    for pi_, (lo, hi) in enumerate(zip(edges, edges[1:]), 1):
                        okind = o_kind if lo == 0 else "switch"; dkind = d_kind if hi == len(pts_t) - 1 else "switch"
                        pr = trip_record(pts_t, pts_lat, pts_lon, lo, hi, okind, dkind, ob if lo == 0 else (pts_lat[lo], pts_lon[lo]), db if hi == len(pts_t) - 1 else (pts_lat[hi], pts_lon[hi]), a)
                        pr.update({"trip_id": trip_id, "part": pi_, "maid": maid, "previous_mode": prev}); prev = pr["mode"]; out_.append(pr)
                    return out_
                parts = make_parts(cuts) if cuts else []
                while len(parts) > 1:                                           # 隣り合う部分の mode が同じなら境目を消す（vehicle>vehicle のような無意味な分割を残さない）
                    same_i = next((i for i in range(len(parts) - 1) if parts[i]["mode"] == parts[i + 1]["mode"]), None)
                    if same_i is None: break
                    cuts = cuts[:same_i] + cuts[same_i + 1:]; st["switch_merged"] += 1
                    parts = make_parts(cuts) if cuts else []
                if cuts:                                                        # モードチェンジ: chain の mode は最も長く動いた部分のもの
                    st["switch"] += len(cuts)
                    main = max(parts, key=lambda r: r["len_m"])
                    chain["mode"] = main["mode"]; chain["modes"] = ">".join(r["mode"] for r in parts); chain["n_parts"] = len(parts)
                    all_parts.extend(parts)
                chain["tour"] = bool(round_trip or (chain["len_m"] >= a.tour_min_m and chain["len_m"] >= a.tour_ratio * max(chain["straight_m"], 1)))   # 周遊: 往復、または経路長が直線の tour_ratio 倍以上
                chain["mode_detail"] = chain["mode"] + ("+周遊" if chain["tour"] else "")
                if chain["tour"]: st["tour"] += 1
                trips.append(chain)
                part_of = np.ones(len(pts_t), dtype=int)
                for c in cuts: part_of[c + 1:] += 1                            # 境目の点は前の部分の終点（後の部分の起点でもある）
                tp_rows.append(pd.DataFrame({"trip_id": trip_id, "maid": maid, "ts": pts_t, "lat": pts_lat, "lon": pts_lon,
                                             "kind": ["origin"] + ["move"] * n_mv + ["dest"], "part": part_of, "switch": [k in cuts for k in range(len(pts_t))]}))   # switch = モードチェンジの境目の点
        st["move"] += int((stay_lab < 0).sum()); st["all_pts"] += len(df)
        return stay_rows, trips, tp_rows, trip_id

    for pi, key in enumerate(keys, 1):
        df = read_partition(key)
        if not len(df): continue
        if pi == 1 or KX is None:
            lat0 = float(df["lat"].median()); KY = 111_320.0; KX = 111_320.0 * np.cos(np.radians(lat0))
        sr, tr, tp, trip_id = process(df, trip_id)
        all_stays += sr; all_trips += tr; all_tp += tp
        print(f"  分割 {pi}/{len(keys)}（ID の先頭 {key or '全部'}）: {len(df):,} 点 → トリップ 累計 {len(all_trips):,} 本（{time.time() - t0:.0f} 秒）", flush=True)
        del df
    if len(datasets) > 1: print(f"ソース統合: {st['n0']:,} → {st['merged']:,} 点（同一秒・{a.merge_min_gap:g} 秒未満の重複を除去）| 複数ソースに現れる端末 {st['n_both']:,}")
    print(f"合計 {st['merged']:,} 点、{st['dev']:,} 端末 | ワープ {st['warp']:,} 点、速度 {a.max_speed_kmh:g} km/h 超 {st['bad']:,} 点を除外 | 点数 {a.min_pts_id} 未満の端末を除いて {st['kept_pts']:,} 点、{st['kept_dev']:,} 端末")
    print(f"トリップ候補の除外: gap 端点の条件 {st['drop_gap']:,} | 間隔の最大 {a.trip_max_gap_min:g} 分以上 {st['drop_maxgap']:,} | 直線 {a.trip_min_straight_m:g} m 未満 {st['drop_straight']:,}（うち {a.tour_min_m:g} m 以上動いた往復は周遊として残した {st['round_kept']:,}）")
    print(f"モードチェンジ: 分けた境目 {st['switch']:,}（同じ mode が隣り合って取り消した境目 {st['switch_merged']:,}）| 周遊（往復、または経路長が直線の {a.tour_ratio:g} 倍以上かつ {a.tour_min_m:g} m 以上）{st['tour']:,} 本")
    stays_df = pd.DataFrame(all_stays); trips_df = pd.DataFrame(all_trips)
    tp_df = pd.concat(all_tp, ignore_index=True) if all_tp else pd.DataFrame(columns=["trip_id", "maid", "ts", "lat", "lon", "kind"])
    print(f"Stay {len(stays_df):,} 件 | トリップ {len(trips_df):,} 本（{trips_df['maid'].nunique() if len(trips_df) else 0:,} 端末）| Move 点 {st['move']:,} / 全 {st['all_pts']:,} 点（{time.time() - t0:.0f} 秒）")
    if not len(trips_df): sys.exit("トリップが 1 本もありません。パラメータを見直してください")

    # 市域判定（起点・終点）
    CW, CS, CE, CN = map(float, a.city_bbox.split(","))
    trips_df["o_in_city"] = trips_df["o_lat"].between(CS, CN) & trips_df["o_lon"].between(CW, CE)
    trips_df["d_in_city"] = trips_df["d_lat"].between(CS, CN) & trips_df["d_lon"].between(CW, CE)
    # 現地時刻の列
    for d_, c in [(trips_df, "t_start"), (trips_df, "t_end"), (stays_df, "t_start"), (stays_df, "t_end")]:
        d_[c + "_local"] = pd.to_datetime(d_[c], unit="s", utc=True).dt.tz_convert(a.tz).dt.strftime("%Y-%m-%d %H:%M:%S")
    trips_df["date_local"] = trips_df["t_start_local"].str[:10]; trips_df["hour_local"] = trips_df["t_start_local"].str[11:13].astype(int)

    # 出力
    out = Path(a.out)
    trips_df.to_parquet(f"{out}_trips.parquet", index=False); tp_df.to_parquet(f"{out}_trip_points.parquet", index=False)
    written = [f"{out}_trips.parquet", f"{out}_trip_points.parquet"]
    parts_df = pd.DataFrame(all_parts)
    if len(parts_df):
        for c in ("t_start", "t_end"): parts_df[c + "_local"] = pd.to_datetime(parts_df[c], unit="s", utc=True).dt.tz_convert(a.tz).dt.strftime("%Y-%m-%d %H:%M:%S")
        parts_df.to_parquet(f"{out}_trip_parts.parquet", index=False); written.append(f"{out}_trip_parts.parquet（モードチェンジで分けた部分。previous_mode 付き）")
    if a.csv: trips_df.to_csv(f"{out}_trips.csv", index=False, encoding="utf-8-sig"); written.append(f"{out}_trips.csv")
    if a.split_mode:
        for m, g in trips_df.groupby("mode"): g.to_parquet(f"{out}_trips_{m}.parquet", index=False); written.append(f"{out}_trips_{m}.parquet")
    try:
        import geopandas as gpd
        from shapely.geometry import LineString, MultiLineString, Point
        lines = tp_df.groupby("trip_id").apply(lambda g: LineString(list(zip(g["lon"], g["lat"]))), include_groups=False)
        gtrips = gpd.GeoDataFrame(trips_df.set_index("trip_id").join(lines.rename("geometry")).reset_index(), geometry="geometry", crs="EPSG:4326")
        gtrips.to_file(f"{out}.gpkg", layer="trips", driver="GPKG")
        byid = gtrips.groupby("maid").agg(n_trips=("trip_id", "size"), source=("source", lambda s_: "+".join(sorted(set("+".join(s_).split("+"))))), geometry=("geometry", lambda g: MultiLineString(list(g)))).reset_index()
        gpd.GeoDataFrame(byid, geometry="geometry", crs="EPSG:4326").to_file(f"{out}.gpkg", layer="trips_by_device", driver="GPKG")
        gpd.GeoDataFrame(stays_df, geometry=[Point(x, y) for x, y in zip(stays_df["lon"], stays_df["lat"])], crs="EPSG:4326").to_file(f"{out}.gpkg", layer="stays", driver="GPKG")
        gpd.GeoDataFrame(tp_df, geometry=[Point(x, y) for x, y in zip(tp_df["lon"], tp_df["lat"])], crs="EPSG:4326").to_file(f"{out}.gpkg", layer="trip_points", driver="GPKG")
        written.append(f"{out}.gpkg（層 trips / trips_by_device / stays / trip_points）")
    except ImportError:
        stays_df.to_parquet(f"{out}_stays.parquet", index=False); written.append(f"{out}_stays.parquet（geopandas が無いので gpkg の代わり）")
    print("書き出し: " + ", ".join(written))

    # 要約
    q = lambda s, ps=(0.5, 0.9): [round(float(x), 1) for x in s.quantile(ps)]
    print(f"\n=== トリップの要約 ===\n所要時間 [分] 50/90% {q(trips_df['dur_s'] / 60)} | 移動距離 [km] 50/90% {q(trips_df['len_m'] / 1000)} | 直線距離 [km] 50/90% {q(trips_df['straight_m'] / 1000)} | "
          f"Move 点数 50/90% {q(trips_df['n_move_pts'])} | 平均間隔 [秒] 50/90% {q(trips_df['mean_gap_s'])}")
    both, one, none = (trips_df["o_in_city"] & trips_df["d_in_city"]).sum(), (trips_df["o_in_city"] ^ trips_df["d_in_city"]).sum(), (~trips_df["o_in_city"] & ~trips_df["d_in_city"]).sum()
    print(f"市域判定（{a.city_bbox}）: 両端が市内 {both:,} | 片方が市内 {one:,} | 両端とも市外 {none:,}")
    print("端点の種類（起点/終点）: " + ", ".join(f"{k} {n:,}" for k, n in (trips_df["o_kind"] + "/" + trips_df["d_kind"]).value_counts().items()) + "（stay = 点群の Stay、gap = 観測の途切れ、open = 区間の端）")
    print("移動手段: " + ", ".join(f"{m} {n:,}（{n / len(trips_df):.1%}）" for m, n in trips_df["mode"].value_counts().items()))
    if "tour" in trips_df: print("周遊: " + ", ".join(f"{m} {n:,}" for m, n in trips_df.loc[trips_df["tour"], "mode"].value_counts().items()) + f"（計 {int(trips_df['tour'].sum()):,} 本。mode_detail 列に '+周遊'）")
    if (trips_df["n_parts"] > 1).any():
        print("モードチェンジのあるトリップ: " + ", ".join(f"{m} {n:,}" for m, n in trips_df.loc[trips_df["n_parts"] > 1, "modes"].value_counts().head(8).items()) + f"（計 {int((trips_df['n_parts'] > 1).sum()):,} 本）")
    print("速度の取り方: " + ", ".join(f"{m} {n:,}" for m, n in trips_df["speed_src"].value_counts().items()) + "（move = Move 点のみ、boundary = 両端 Stay の実点を含む、none = 速度なし）")
    print("ソース: " + ", ".join(f"{m} {n:,}" for m, n in trips_df["source"].value_counts().items()))
    for m, g in trips_df.groupby("mode"):
        print(f"  {m:8s}: 移動距離 [km] 50/90% {q(g['len_m'] / 1000)} | 所要 [分] 50/90% {q(g['dur_s'] / 60)} | v_p85 50/90% {q(g['v_p85'].dropna())}")
    print("日別トリップ数:", trips_df["date_local"].value_counts().sort_index().to_dict())
    print("出発時間帯別:", trips_df["hour_local"].value_counts().sort_index().to_dict())
    print("端末あたりトリップ数 50/90%:", q(trips_df.groupby("maid").size()))
    # 抽出範囲の縁に掛かるトリップ（端点が点の範囲の縁から 1 km 以内）: 多ければ extract_dense の bbox を広げる目安
    ext = {"W": float(min(trips_df["o_lon"].min(), trips_df["d_lon"].min())), "E": float(max(trips_df["o_lon"].max(), trips_df["d_lon"].max())),
           "S": float(min(trips_df["o_lat"].min(), trips_df["d_lat"].min())), "N": float(max(trips_df["o_lat"].max(), trips_df["d_lat"].max()))}
    ek = 1000.0 / KX; en = 1000.0 / KY
    near = lambda lon, lat: (lon < ext["W"] + ek) | (lon > ext["E"] - ek) | (lat < ext["S"] + en) | (lat > ext["N"] - en)
    edge = near(trips_df["o_lon"], trips_df["o_lat"]) | near(trips_df["d_lon"], trips_df["d_lat"])
    print(f"抽出範囲の縁（点の範囲 {ext['W']:.3f}〜{ext['E']:.3f}, {ext['S']:.3f}〜{ext['N']:.3f} の 1 km 内）に端点があるトリップ: {int(edge.sum()):,} 本（{edge.mean():.1%}。多ければ抽出 bbox を広げる）")


if __name__ == "__main__":
    main()
