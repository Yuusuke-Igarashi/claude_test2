# -*- coding: utf-8 -*-
r"""map_match.py（版 2026-11-04a）— トリップの点列を道路網（自動車 = road、徒歩 = walk）の経路に当てる。最短経路 × 動的計画法

考え方（Lviv / 外部のマップマッチングで脇道を拾った反省から）:
  1. 点を間引く（直前に残した点から THIN_S 秒以上かつ THIN_M m 以上。最初と最後は残す）
  2. 各点に候補を持つ: 半径 R 以内の弧を最大 K 本（点から弧への距離 = 吸着距離。弧上の位置 s も持つ）
  3. 連続する点の候補どうしを「経路探索の重み（自動車は 長さ ÷ 区分の基準速度 → 大きい道路が選ばれやすい。徒歩は長さ）」の最短経路でつなぎ、
     その実長 P と点どうしの直線距離 D から、P ≤ DETOUR × D + BUFFER かつ P ÷ 経過時間 ≤ V_MAX のものだけを許す
     （起点・終点は Stay の重心で、位置と時刻が隣の Move 点とずれるため、起点から・終点への区間には V_MAX を掛けない）
  4. 動的計画法（Viterbi）: コスト = Σ (吸着距離 ÷ SIGMA)² ÷ 2 + Σ |P − D| ÷ BETA が最小の候補列を選び、経路をつなぐ。
     つなげない点が出たら、そこで経路を切る（seg 番号を進める）
  5. 点の時刻を経路長で補間して、通った弧ごとの進入・退出時刻を付ける（弧別の実測の通過数・速度に使える）
計算量の目安: 点 1 つにつき有界ダイクストラ 1 回（候補 K 本を同時に出発点にする。到達範囲は DETOUR × D + BUFFER で打ち切る）と K × K のコスト。
  トリップ 10 万本 × 間引き後 20 点なら 200 万回。--workers で並列。

usage:
  python map_match.py --trips ..\3_output\all_trips_trips.parquet --points ..\3_output\all_trips_trip_points.parquet --graphs graphs --out ..\3_output\mm
     [--modes vehicle,walk] [--thin-s 60 --thin-m 100] [--radius-m 100 --k 5] [--sigma-m 25 --beta-m 100] [--detour 2.5 --buffer-m 300]
     [--vmax-vehicle 150 --vmax-walk 10] [--workers 4] [--chunk 2000] [--limit N] [--no-gpkg]
     [--class-speeds motorway=80,trunk=70,primary=60,secondary=50,tertiary=40,unclassified=30,residential=25,living_street=15,service=15,default=30]
入力: make_trips（版 l 以降）の <out>_trips.parquet（trip_id, mode, modes, n_parts）、<out>_trip_points.parquet（trip_id, ts, lat, lon, kind, part）、
     あれば <out>_trip_parts.parquet（モードチェンジの部分ごとに mode が違うので、部分ごとにそのモードの網で当てる）
出力:
  <out>_mm_trips.parquet  … trip_id, part, mode, n_pts, n_used（間引き後）, n_matched, n_segs（切れた数 + 1）, matched_len_m, straight_m, mean_snap_m, status（ok / partial / fail）
  <out>_mm_paths.parquet  … trip_id, part, seg, k, edge_id, len_m, t_enter, t_exit（通った弧の列。時刻は補間）
  <out>_mm_points.parquet … trip_id, part, ts, lat, lon, used, edge_id, snap_m, m_lat, m_lon（吸着位置）
  <out>_mm.gpkg           … 層 matched（trip_id × part × seg の LineString、属性付き）。--no-gpkg で省略
  <out>_mm_summary.json
必要: pip install pandas numpy scipy shapely pyarrow（gpkg は geopandas）
"""
import argparse, json, sys, time
from pathlib import Path
import numpy as np
import pandas as pd

VERSION = "2026-11-04c"
G = {}   # ワーカー内のグラフ（mode → dict）


def class_speed_table(spec):
    tab = {}
    for tok in spec.split(","):
        if "=" in tok: k, v = tok.split("="); tab[k.strip().lower()] = float(v)
    if "default" not in tab: tab["default"] = 30.0
    return tab


def load_mode_graph(gdir, layer, mode, class_speeds):
    """グラフ csv → {csr（重み）, pair（ノード対 → 弧）, edges（配列）, tree（STRtree）, …}"""
    import shapely
    from scipy.sparse import csr_matrix
    from shapely.strtree import STRtree
    nodes = pd.read_csv(gdir / f"{layer}_nodes.csv", usecols=["node_id", "x", "y"])
    edges = pd.read_csv(gdir / f"{layer}_edges.csv", usecols=["edge_id", "u", "v", "highway", "length_m", "geometry_wkt"])
    nid = pd.Index(nodes["node_id"].to_numpy())
    ui = nid.get_indexer(edges["u"]); vi = nid.get_indexer(edges["v"])
    if (ui < 0).any() or (vi < 0).any(): sys.exit(f"{layer}: 弧の端点がノード表にありません")
    L = edges["length_m"].to_numpy(dtype=float)
    if mode == "vehicle":
        hw = edges["highway"].astype(str).str.lower().str.replace("_link", "", regex=False)
        v = hw.map(class_speeds).fillna(class_speeds["default"]).to_numpy(dtype=float) / 3.6
        W = L / v; wscale = 1.0 / (min(class_speeds.values()) / 3.6)            # 重み [秒]。長さ → 重みの上限係数（最も遅い区分）
    else:
        W = L.copy(); wscale = 1.0
    N = len(nodes)
    order = np.lexsort((W, vi, ui)); key = ui[order] * N + vi[order]
    first = np.r_[True, key[1:] != key[:-1]]; sel = order[first]
    csr = csr_matrix((W[sel], (ui[sel], vi[sel])), shape=(N, N))
    pair_key = ui[sel] * N + vi[sel]; o2 = np.argsort(pair_key)
    geoms = shapely.from_wkt(edges["geometry_wkt"].to_numpy())
    lat0 = float(nodes["y"].median()); ky = 111_320.0; kx = 111_320.0 * np.cos(np.radians(lat0))
    gm = shapely.transform(geoms, lambda c: np.c_[(c[:, 0]) * kx, (c[:, 1]) * ky])   # 平面座標 [m]（局所の等距円筒）
    return {"N": N, "csr": csr, "pair_key": pair_key[o2], "pair_edge": sel[o2], "ui": ui, "vi": vi, "L": L, "wscale": wscale,
            "edge_id": edges["edge_id"].to_numpy(), "geom": geoms, "gm": gm, "glen": shapely.length(gm), "tree": STRtree(gm), "kx": kx, "ky": ky}


def _init(gdir, layers, class_spec):
    global G
    cs = class_speed_table(class_spec)
    for mode, layer in layers.items(): G[mode] = load_mode_graph(Path(gdir), layer, mode, cs)


def candidates(g, px, py, R, K):
    """点 (px, py)[m] の候補: 半径 R 以内の弧（最大 K 本）→ (弧の添字, 弧上の位置 s [m], 吸着距離 d [m])"""
    import shapely
    pt = shapely.points(px, py)
    idx = g["tree"].query(shapely.buffer(pt, R))
    if len(idx) == 0: return []
    d = shapely.distance(g["gm"][idx], pt)
    keep = np.argsort(d)[:K]
    idx, d = idx[keep], d[keep]
    s = np.array([shapely.line_locate_point(g["gm"][i], pt) for i in idx])
    return [(int(i), float(si), float(di)) for i, si, di in zip(idx, s, d) if di <= R]


def path_nodes(pred, s_row, t):
    """ダイクストラの predecessors の行から、t までのノード列（s から）"""
    out = [t]; cur = t
    while True:
        p = s_row[cur]
        if p < 0: break
        out.append(p); cur = p
    return out[::-1]


def edges_of(g, nodes_seq):
    """ノード列 → 弧の添字列（並行弧は重みが最小のもの）。
    scipy の predecessors は int32 なので、ここで int64 に揃えないと ui * N が桁あふれして（N > 46,341 で起きる）別の弧を黙って引いてしまう"""
    if len(nodes_seq) < 2: return []
    u = np.asarray(nodes_seq[:-1], dtype=np.int64); v = np.asarray(nodes_seq[1:], dtype=np.int64)
    k = u * np.int64(g["N"]) + v
    pos = np.minimum(np.searchsorted(g["pair_key"], k), len(g["pair_key"]) - 1)
    if not np.array_equal(g["pair_key"][pos], k):                     # 鍵が一致しない = ノード対に弧が無い（起きたら探索か表の不整合）
        bad = int(np.flatnonzero(g["pair_key"][pos] != k)[0])
        raise RuntimeError(f"ノード対 ({int(u[bad])}, {int(v[bad])}) に対応する弧がありません")
    return [int(x) for x in g["pair_edge"][pos]]


def match_one(g, t, px, py, a, vmax_ms):
    """1 本（1 部分）の点列を当てる。戻り値: (使った点の添字, 各点の候補の選択 (弧, s, d) or None, 弧の列 [(seg, edge_idx, t_enter, t_exit)], 統計)"""
    from scipy.sparse.csgraph import dijkstra
    n = len(t)
    # 1. 間引き
    used = [0]
    for i in range(1, n):
        if t[i] - t[used[-1]] >= a.thin_s and np.hypot(px[i] - px[used[-1]], py[i] - py[used[-1]]) >= a.thin_m: used.append(i)
    if used[-1] != n - 1: used.append(n - 1)
    # 2. 候補
    cands = [candidates(g, px[i], py[i], a.radius_m, a.k) for i in used]
    # 3-4. 動的計画法（候補が無い点は飛ばす）
    INF = float("inf")
    cost_prev, back_prev, prev_i, prev_c = None, None, None, None   # 直前の「候補のある点」の情報
    choice = {}     # 点の添字 → (候補番号, 直前の点の添字, 直前の候補番号, 経路ノード列)
    chains = []     # 連なり（切れたら新しい連なり）: list of (点の添字, 候補番号)
    cur_chain = []
    per_point = {}; why = {"nocand": 0, "unreach": 0, "detour": 0, "speed": 0}   # 切れた理由の数
    for ui_, i in enumerate(used):
        C = cands[ui_]
        if not C: per_point[i] = None; why["nocand"] += 1; continue
        if prev_i is None:                                             # 連なりの先頭
            cost = np.array([(d / a.sigma_m) ** 2 / 2 for _, _, d in C]); back = [(-1, None)] * len(C)
        else:
            D = float(np.hypot(px[i] - px[prev_i], py[i] - py[prev_i])); dt = max(float(t[i] - t[prev_i]), 1.0)
            Pmax_d, Pmax_v = a.detour * D + a.buffer_m, vmax_ms * dt
            endpoint = prev_i == 0 or i == n - 1                              # 起点・終点は Stay の重心（位置は重心、時刻は Stay の端）なので、隣の Move 点との見かけの速度が跳ねる。make_trips と同じく速度の判定から外す
            Pmax = Pmax_d if endpoint else min(Pmax_d, Pmax_v)                 # 許す経路長の上限
            srcs = sorted(set(g["vi"][e] for e, _, _ in prev_c))            # 前の候補の弧の終点ノードから探索
            spos = {s_: k for k, s_ in enumerate(srcs)}
            dist, pred = dijkstra(g["csr"], directed=True, indices=srcs, return_predecessors=True, limit=Pmax * g["wscale"] + 1)
            cost = np.full(len(C), INF); back = [(-1, None)] * len(C); n_unreach = n_far = 0
            for ci, (e2, s2, d2) in enumerate(C):
                emis = (d2 / a.sigma_m) ** 2 / 2
                for pi, (e1, s1, d1) in enumerate(prev_c):
                    if not np.isfinite(cost_prev[pi]): continue
                    if e1 == e2 and s2 >= s1: P = s2 - s1; nodes_seq = None
                    else:
                        src = g["vi"][e1]; tgt = g["ui"][e2]
                        if src == tgt: mid = 0.0; nodes_seq = [src]
                        else:
                            dw = dist[spos[src], tgt]
                            if not np.isfinite(dw): n_unreach += 1; continue
                            nodes_seq = path_nodes(pred, pred[spos[src]], tgt)
                            mid = float(g["L"][edges_of(g, nodes_seq)].sum())
                        P = (g["glen"][e1] - s1) + mid + s2
                    if P > Pmax: n_far += 1; continue
                    c = cost_prev[pi] + emis + abs(P - D) / a.beta_m
                    if c < cost[ci]: cost[ci] = c; back[ci] = (pi, nodes_seq)
            if not np.isfinite(cost).any():                               # どの候補にもつなげない → 切る（理由: 到達不能（打ち切り範囲内に無い）/ 迂回超過 / 速度超過）
                if n_far: why["speed" if (not endpoint and Pmax_v < Pmax_d) else "detour"] += 1
                else: why["unreach"] += 1
                chains.append(cur_chain); cur_chain = []
                cost = np.array([(d / a.sigma_m) ** 2 / 2 for _, _, d in C]); back = [(-1, None)] * len(C)
        per_point[i] = (C, cost, back)
        cur_chain.append(i)
        cost_prev, prev_i, prev_c = cost, i, C
    chains.append(cur_chain)
    # バックトラック（連なりごと）
    sel = {}; path_rows = []; n_matched = 0; snap_sum = 0.0; total_len = 0.0
    for seg, ch in enumerate([c for c in chains if c]):
        last = ch[-1]; C, cost, back = per_point[last]
        ci = int(np.argmin(cost)); nodes_between = {}
        for i in reversed(ch):
            C, cost, back = per_point[i]
            sel[i] = C[ci]; pi, nodes_seq = back[ci]
            if pi >= 0: nodes_between[i] = nodes_seq
            ci = pi
        # 弧の列と時刻の補間
        for a_i, b_i in zip(ch, ch[1:]):
            e1, s1, _ = sel[a_i]; e2, s2, _ = sel[b_i]; nodes_seq = nodes_between[b_i]
            if e1 == e2 and nodes_seq is None: mids = []
            else: mids = edges_of(g, nodes_seq) if nodes_seq is not None and len(nodes_seq) > 1 else []
            seq = [e1] + mids + ([e2] if e2 != e1 or nodes_seq is not None else [])
            lens = [g["glen"][e1] - s1] + [g["L"][m] for m in mids] + ([s2] if len(seq) > 1 else [])
            if len(seq) == 1: lens = [s2 - s1]
            P = float(sum(lens)); t0, t1 = float(t[a_i]), float(t[b_i]); total_len += P
            acc = 0.0
            for e, l in zip(seq, lens):
                te = t0 + (t1 - t0) * (acc / P if P > 0 else 0); acc += l; tx = t0 + (t1 - t0) * (acc / P if P > 0 else 1)
                if path_rows and path_rows[-1][0] == seg and path_rows[-1][1] == e: path_rows[-1] = (seg, e, path_rows[-1][2], tx)   # 同じ弧が続けば 1 行に
                else: path_rows.append((seg, e, te, tx))
        n_matched += len(ch); snap_sum += sum(sel[i][2] for i in ch)
    stats = {"n_pts": n, "n_used": len(used), "n_matched": n_matched, "n_segs": len([c for c in chains if c]), "matched_len_m": round(total_len),
             "mean_snap_m": round(snap_sum / n_matched, 1) if n_matched else None, "n_nocand": why["nocand"], "brk_unreach": why["unreach"], "brk_detour": why["detour"], "brk_speed": why["speed"],
             "status": "ok" if n_matched == len(used) and len([c for c in chains if c]) == 1 else ("fail" if n_matched == 0 else "partial")}
    return used, sel, path_rows, stats


def work(task):
    """task = (mode, [(trip_id, part, t, lat, lon), ...], args) → 結果の行"""
    mode, items, a = task
    g = G[mode]; vmax = (a.vmax_vehicle if mode == "vehicle" else a.vmax_walk) / 3.6
    rows_t, rows_p, rows_pt = [], [], []
    for trip_id, part, t, lat, lon in items:
        px, py = lon * g["kx"], lat * g["ky"]
        used, sel, paths, stt = match_one(g, t, px, py, a, vmax)
        stt.update({"trip_id": trip_id, "part": part, "mode": mode, "straight_m": round(float(np.hypot(px[-1] - px[0], py[-1] - py[0])))})
        rows_t.append(stt)
        for k, (seg, e, te, tx) in enumerate(paths):
            rows_p.append({"trip_id": trip_id, "part": part, "seg": seg, "k": k, "edge_id": g["edge_id"][e], "len_m": round(float(g["L"][e]), 1), "t_enter": round(te, 1), "t_exit": round(tx, 1)})
        for i in range(len(t)):
            c = sel.get(i)
            if c is not None:
                import shapely
                m = shapely.line_interpolate_point(g["gm"][c[0]], c[1])
                rows_pt.append({"trip_id": trip_id, "part": part, "ts": int(t[i]), "lat": float(lat[i]), "lon": float(lon[i]), "used": True, "edge_id": g["edge_id"][c[0]], "snap_m": round(c[2], 1), "m_lat": m.y / g["ky"], "m_lon": m.x / g["kx"]})
            else:
                rows_pt.append({"trip_id": trip_id, "part": part, "ts": int(t[i]), "lat": float(lat[i]), "lon": float(lon[i]), "used": i in used, "edge_id": None, "snap_m": None, "m_lat": None, "m_lon": None})
    return rows_t, rows_p, rows_pt


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--trips", required=True); ap.add_argument("--points", required=True); ap.add_argument("--graphs", required=True); ap.add_argument("--out", required=True)
    ap.add_argument("--parts", help="make_trips の <out>_trip_parts.parquet（省略時は trips と同じ接頭辞から探す）")
    ap.add_argument("--modes", default="vehicle,walk"); ap.add_argument("--thin-s", type=float, default=60); ap.add_argument("--thin-m", type=float, default=100)
    ap.add_argument("--radius-m", type=float, default=100); ap.add_argument("--k", type=int, default=5)
    ap.add_argument("--sigma-m", type=float, default=25, help="吸着距離の尺度 [m]（GPS 誤差）"); ap.add_argument("--beta-m", type=float, default=100, help="経路長と直線の差の尺度 [m]")
    ap.add_argument("--detour", type=float, default=3.0); ap.add_argument("--buffer-m", type=float, default=500, help="許す経路長 = 直線 × detour + buffer（一方通行の迂回を見込む）")
    ap.add_argument("--vmax-vehicle", type=float, default=150); ap.add_argument("--vmax-walk", type=float, default=20, help="徒歩の速度上限 [km/h]（make_trips の walk は最大 15 km/h まで許すので余裕を持たせる）")
    ap.add_argument("--class-speeds", default="motorway=80,trunk=70,primary=60,secondary=50,tertiary=40,unclassified=30,residential=25,living_street=15,service=15,default=30")
    ap.add_argument("--workers", type=int, default=1); ap.add_argument("--chunk", type=int, default=2000); ap.add_argument("--limit", type=int, default=0, help="先頭 N 本だけ（試行用）")
    ap.add_argument("--no-gpkg", action="store_true")
    a = ap.parse_args()
    print(f"{Path(__file__).name} 版 {VERSION}")
    t0 = time.time(); out = Path(a.out); out.parent.mkdir(parents=True, exist_ok=True)
    modes = [m.strip() for m in a.modes.split(",") if m.strip()]; layers = {"vehicle": "road", "walk": "walk"}
    trips = pd.read_parquet(a.trips)
    pts = pd.read_parquet(a.points)
    if "part" not in pts: pts["part"] = 1
    parts_path = Path(a.parts) if a.parts else Path(str(a.trips).replace("_trips.parquet", "_trip_parts.parquet"))
    parts = pd.read_parquet(parts_path, columns=["trip_id", "part", "mode"]) if parts_path.exists() else pd.DataFrame(columns=["trip_id", "part", "mode"])
    if a.limit: trips = trips.head(a.limit)
    # 対象: (trip_id, part, mode)。部分のあるトリップは部分ごと、無ければ chain 全体
    tm = trips[["trip_id", "mode"]].copy(); tm["part"] = 1
    if len(parts):
        has = set(parts["trip_id"]); tm = pd.concat([tm[~tm["trip_id"].isin(has)], parts[parts["trip_id"].isin(set(trips["trip_id"]))][["trip_id", "part", "mode"]]], ignore_index=True)
    tm = tm[tm["mode"].isin(modes)]
    pts = pts[pts["trip_id"].isin(set(tm["trip_id"]))].sort_values(["trip_id", "part", "ts"])
    key = tm.set_index(["trip_id", "part"])["mode"]
    print(f"対象 {len(tm):,} 本（{tm['mode'].value_counts().to_dict()}）、点 {len(pts):,}")
    items = {m: [] for m in modes}
    for (tid, part), g in pts.groupby(["trip_id", "part"], sort=False):
        m = key.get((tid, part))
        if m is None: continue
        items[m].append((int(tid), int(part), g["ts"].to_numpy(dtype=float), g["lat"].to_numpy(dtype=float), g["lon"].to_numpy(dtype=float)))
    tasks = []
    for m in modes:
        for i in range(0, len(items[m]), a.chunk): tasks.append((m, items[m][i:i + a.chunk], a))
    rows_t, rows_p, rows_pt = [], [], []
    gdir = Path(a.graphs); use_layers = {m: layers[m] for m in modes if items[m]}
    if a.workers > 1 and len(tasks) > 1:
        from multiprocessing import Pool
        with Pool(a.workers, initializer=_init, initargs=(str(gdir), use_layers, a.class_speeds)) as pool:
            for k, (rt, rp, rpt) in enumerate(pool.imap_unordered(work, tasks), 1):
                rows_t += rt; rows_p += rp; rows_pt += rpt
                print(f"  {k}/{len(tasks)} 塊（{time.time() - t0:.0f} 秒）", flush=True)
    else:
        _init(str(gdir), use_layers, a.class_speeds)
        for k, task in enumerate(tasks, 1):
            rt, rp, rpt = work(task); rows_t += rt; rows_p += rp; rows_pt += rpt
            print(f"  {k}/{len(tasks)} 塊（{time.time() - t0:.0f} 秒）", flush=True)
    T = pd.DataFrame(rows_t); P = pd.DataFrame(rows_p); PT = pd.DataFrame(rows_pt)
    T.to_parquet(f"{out}_mm_trips.parquet", index=False); P.to_parquet(f"{out}_mm_paths.parquet", index=False); PT.to_parquet(f"{out}_mm_points.parquet", index=False)
    summ = {"version": VERSION, "n": int(len(T)), "status": T["status"].value_counts().to_dict() if len(T) else {},
            "breaks": {c: int(T[c].sum()) for c in ("n_nocand", "brk_unreach", "brk_detour", "brk_speed")} if len(T) else {},
            "snap_m_quantiles": {q: round(float(PT["snap_m"].dropna().quantile(q)), 1) for q in (0.5, 0.9, 0.99)} if len(PT) and PT["snap_m"].notna().any() else {},
            "used_pts_per_trip_median": float(T["n_used"].median()) if len(T) else None,
            "by_mode": {m: {"n": int(len(g)), "ok": int((g["status"] == "ok").sum()), "mean_snap_m": round(float(g["mean_snap_m"].mean()), 1) if g["mean_snap_m"].notna().any() else None,
                            "len_ratio_median": round(float((g["matched_len_m"] / g["straight_m"].clip(lower=1)).median()), 2)} for m, g in T.groupby("mode")} if len(T) else {},
            "args": vars(a), "seconds": round(time.time() - t0)}
    Path(f"{out}_mm_summary.json").write_text(json.dumps(summ, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"切れた理由（点の数）: 候補なし {summ['breaks'].get('n_nocand', 0):,} | 到達不能 {summ['breaks'].get('brk_unreach', 0):,} | 迂回超過 {summ['breaks'].get('brk_detour', 0):,} | 速度超過 {summ['breaks'].get('brk_speed', 0):,} | 吸着距離 50/90/99% {summ['snap_m_quantiles']}")
    print(f"結果: {summ['status']} | " + " / ".join(f"{m}: ok {v['ok']}/{v['n']}、吸着 {v['mean_snap_m']} m、経路長÷直線 中央値 {v['len_ratio_median']}" for m, v in summ["by_mode"].items()))
    if not a.no_gpkg and len(P):
        try:
            import geopandas as gpd, shapely
            from shapely.ops import linemerge
            from shapely.geometry import MultiLineString
            _init(str(gdir), use_layers, a.class_speeds) if not G else None
            eidx = {m: pd.Index(G[m]["edge_id"]) for m in G}
            feats = []
            for (tid, part, seg), g in P.groupby(["trip_id", "part", "seg"], sort=False):
                m = key.get((tid, part)); ge = G[m]["geom"][eidx[m].get_indexer(g["edge_id"])]
                line = linemerge(MultiLineString(list(ge))) if len(ge) > 1 else ge[0]
                feats.append({"trip_id": tid, "part": part, "seg": seg, "mode": m, "n_edges": len(g), "len_m": round(float(g["len_m"].sum())), "t_start": float(g["t_enter"].min()), "t_end": float(g["t_exit"].max()), "geometry": line})
            gpd.GeoDataFrame(feats, geometry="geometry", crs=4326).to_file(f"{out}_mm.gpkg", layer="matched", driver="GPKG")
            print(f"書き出し: {out}_mm.gpkg（層 matched）")
        except ImportError:
            print("geopandas が無いので gpkg は省略")
    print(f"書き出し: {out}_mm_trips.parquet, {out}_mm_paths.parquet, {out}_mm_points.parquet, {out}_mm_summary.json | {time.time() - t0:.0f} 秒")


if __name__ == "__main__":
    main()
