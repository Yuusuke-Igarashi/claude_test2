"""Writes truck_compare.ipynb (baseline vs event comparison of truck_traffic.ipynb outputs)."""
import json
from pathlib import Path

cells = []
def md(s): cells.append({"cell_type": "markdown", "metadata": {}, "source": s.strip("\n").splitlines(keepends=True)})
def code(s): cells.append({"cell_type": "code", "metadata": {}, "execution_count": None, "outputs": [], "source": s.strip("\n").splitlines(keepends=True)})

md(r'''
# トラックプローブ: 平時と有事の比較 → 異常リンクの GeoJSON

`truck_traffic.ipynb` を平時の日と有事の日でそれぞれ実行した出力フォルダ（`traffic_YYYYMMDD_HHMM.csv`）を比べ、
異常のあった道路リンクだけを 15 分窓ごと・レベルごとの GeoJSON に書きます（例: 2024-08-20 と 08-21、2025-09-10 と 09-11）。
判定は `run2024.ipynb`（車流）と同じ定義です。

| 節 | 処理 | 出力 |
|---|---|---|
| 1 | 平時・有事の窓別 CSV とリンク形状（`network_agg.shp`）を読む | – |
| 2 | 窓 × リンクで比率を出し、レベル別に判定する | `error_15min.csv` |
| 3 | 窓ごと・レベルごとに異常リンクだけの GeoJSON を書く | `error_geojson/error_L{1|2|3}_YYYYMMDD_HHMM.geojson` |

判定の定義

- 比率 = 有事 / 平時。平時フォルダが複数日なら、台数（Hits）は日平均（観測の無い日は 0 台）、速度（AvgSp）は平均。有事に観測の無いリンクは台数 0、速度は欠損
- 判定対象（is_target）= 平時の Hits ≥ `MIN_BASE_COUNT` かつ 平時の AvgSp ≥ `MIN_BASE_SPEED`
- error1 = レベルごとの比率条件。`ERROR_LEVELS` の `op` が "or" なら「速度比 ≤ speed または 台数比 ≤ count」、"and" なら「かつ」
- error3 = 同じリンクが前または後の窓（15 分隣接）でも同じレベルの error1
- 異常 = is_target かつ error1 かつ error3。`error_level` は満たした最も厳しいレベル（0 = 異常なし）
- 対向リンクの条件（run2024 の error2）は使いません。`truck_traffic.ipynb` の節 1 で向きの違う同形状リンクを 1 本に集約しているため、対向が別リンクになりません
- 各 GeoJSON は、その窓で `error_level` がちょうどそのレベルのリンクだけ（累積ではない）。該当が無い窓・レベルも空の FeatureCollection を書くので、ファイル数は常に 有事の窓数 × 3

必要なライブラリ: geopandas, pandas, numpy。
''')

md("## 0. パラメータ")
code(r'''
from pathlib import Path
import json, time
import numpy as np
import pandas as pd
import geopandas as gpd

# ---- 入出力 -------------------------------------------------------------
EVENT_DIR     = Path("./traffic_out_20240821")        # 有事の日の truck_traffic.ipynb の OUT_DIR
BASELINE_DIRS = [Path("./traffic_out_20240820")]      # 平時の日の OUT_DIR（複数なら同時刻の平均）
NETWORK_SHP   = EVENT_DIR / "network_agg.shp"         # リンク形状（集約後。どちらの日の物でも同じ）
OUT_DIR       = Path("./compare_20240821")            # 出力先
OUT_DIR.mkdir(parents=True, exist_ok=True)

# ---- 判定 ---------------------------------------------------------------
WINDOW_MIN = 15               # 窓の長さ [分]（truck_traffic.ipynb と同じ）
MIN_BASE_COUNT = 5.0          # 判定対象: 平時の Hits がこれ以上 [台/15 分] ...
MIN_BASE_SPEED = 10.0         # ... かつ平時の AvgSp がこれ以上 [km/h]
ERROR_LEVELS = {              # 比率 = 有事 / 平時。op = "or": 速度比 <= speed または台数比 <= count、"and": かつ。L3 ⊂ L2 ⊂ L1
    1: {"speed": 0.50, "count": 0.50, "op": "or"},
    2: {"speed": 0.50, "count": 0.50, "op": "and"},
    3: {"speed": 0.25, "count": 0.25, "op": "and"},
}

def log(msg):
    print(f"[{time.strftime('%H:%M:%S')}] {msg}", flush=True)
''')

md(r'''
## 1. 読み込み

各フォルダの `traffic_YYYYMMDD_HHMM.csv`（Id, Hits, AvgSp, …）を 1 つの表にします。窓の時刻はファイル名から取ります。
''')
code(r'''
def read_windows(out_dir):
    """フォルダの traffic_YYYYMMDD_HHMM.csv をまとめて読む → DataFrame(window, Id, Hits, AvgSp)"""
    parts = []
    for f in sorted(Path(out_dir).glob("traffic_????????_????.csv")):
        w = pd.to_datetime(f.stem[len("traffic_"):], format="%Y%m%d_%H%M")
        parts.append(pd.read_csv(f, usecols=["Id", "Hits", "AvgSp"]).assign(window=w))
    if not parts:
        raise FileNotFoundError(f"traffic_YYYYMMDD_HHMM.csv が {out_dir} にありません")
    return pd.concat(parts, ignore_index=True)

event = read_windows(EVENT_DIR)
base = pd.concat([read_windows(d) for d in BASELINE_DIRS], ignore_index=True)
n_base_days = base.window.dt.normalize().nunique()
links = gpd.read_file(NETWORK_SHP)
if links.crs is None:
    links = links.set_crs("EPSG:4326")
log(f"有事 {EVENT_DIR}: {event.window.nunique()} 窓 {len(event):,} 行（{event.window.min()} – {event.window.max()}）")
log(f"平時 {[str(d) for d in BASELINE_DIRS]}: {n_base_days} 日 {base.window.dt.strftime('%H%M').nunique()} 窓 {len(base):,} 行")
log(f"リンク {len(links):,}（{NETWORK_SHP}）")
''')

md(r'''
## 2. 判定

窓 × リンクの表を作り（行は平時に観測のあるリンク。run2024 と同じ）、比率・判定対象・レベル別の error1 / error3 / error を付けます。
''')
code(r'''
def error_table(event, base, n_base_days):
    base = (base.assign(hhmm=base.window.dt.strftime("%H%M"))
                .groupby(["hhmm", "Id"]).agg(hits_sum=("Hits", "sum"), baseline_speed=("AvgSp", "mean")).reset_index())
    base["baseline_count"] = base.hits_sum / n_base_days                      # 日平均（観測の無い日は 0 台）
    ev = event.rename(columns={"Hits": "event_count", "AvgSp": "event_speed"}).assign(hhmm=event.window.dt.strftime("%H%M"))
    frames = []
    for w in sorted(event.window.unique()):                                   # 有事の各窓に、平時の同時刻の窓を付ける
        b = base[base.hhmm == f"{pd.Timestamp(w):%H%M}"]
        e = ev[ev.window == w].drop(columns=["window", "hhmm"])
        frames.append(b.merge(e, on="Id", how="left").assign(window=w))
    tr = pd.concat(frames, ignore_index=True).drop(columns=["hhmm", "hits_sum"])
    tr["event_count"] = tr.event_count.fillna(0)
    with np.errstate(divide="ignore", invalid="ignore"):
        tr["speed_ratio"] = np.where(tr.baseline_speed > 0, tr.event_speed / tr.baseline_speed, np.nan)
        tr["count_ratio"] = np.where(tr.baseline_count > 0, tr.event_count / tr.baseline_count, np.nan)
    tr["is_target"] = (tr.baseline_count >= MIN_BASE_COUNT) & (tr.baseline_speed >= MIN_BASE_SPEED)
    tr = tr.sort_values(["Id", "window"]).reset_index(drop=True)
    g = tr.groupby("Id").window                                               # 前後の窓が 15 分隣接か（error3 用）
    prev_adj = (tr.window - g.shift(1)) == pd.Timedelta(minutes=WINDOW_MIN)
    next_adj = (g.shift(-1) - tr.window) == pd.Timedelta(minutes=WINDOW_MIN)
    levels = sorted(ERROR_LEVELS)
    for lv in levels:
        th = ERROR_LEVELS[lv]
        if th["op"] not in ("and", "or"):
            raise ValueError(f"ERROR_LEVELS[{lv}]['op'] は 'and' か 'or'")
        slow, few = tr.speed_ratio <= th["speed"], tr.count_ratio <= th["count"]
        tr[f"error1_L{lv}"] = (slow & few) if th["op"] == "and" else (slow | few)
        valid = tr.is_target & tr[f"error1_L{lv}"]
        vg = valid.groupby(tr.Id)
        tr[f"error3_L{lv}"] = (vg.shift(1, fill_value=False) & prev_adj) | (vg.shift(-1, fill_value=False) & next_adj)
        tr[f"error_L{lv}"] = valid & tr[f"error3_L{lv}"]
    for lo, hi in zip(levels[:-1], levels[1:]):
        assert not (tr[f"error1_L{hi}"] & ~tr[f"error1_L{lo}"]).any(), f"レベル {hi} の条件がレベル {lo} より緩い"
    def max_level(prefix):
        return np.select([tr[f"{prefix}_L{lv}"] for lv in reversed(levels)], list(reversed(levels)), default=0).astype(int)
    tr["error1_level"], tr["error3_level"], tr["error_level"] = max_level("error1"), max_level("error3"), max_level("error")
    return tr.drop(columns=[c for c in tr.columns if c.startswith(("error1_L", "error3_L", "error_L"))])

err = error_table(event, base, n_base_days)
err.to_csv(OUT_DIR / "error_15min.csv", index=False)
log(f"判定行 {len(err):,}（対象 {int(err.is_target.sum()):,}、異常 {int((err.error_level > 0).sum()):,}）→ {OUT_DIR / 'error_15min.csv'}")
summary = (err.groupby("window").agg(links=("Id", "size"), target=("is_target", "sum"), error=("error_level", lambda s: int((s > 0).sum())))
              .join(pd.crosstab(err.window, err.error_level).drop(columns=0, errors="ignore").add_prefix("level")).fillna(0).astype(int))
display(summary)
''')

md(r'''
## 3. 窓ごと・レベルごとの GeoJSON

`error_geojson/error_L{レベル}_{YYYYMMDD}_{HHMM}.geojson`。属性は判定表の列（Id, timestamp, baseline_count, event_count, count_ratio,
baseline_speed, event_speed, speed_ratio, is_target, error1_level, error3_level, error_level）とリンク属性（StreetName, FRC, SpeedLimit, Length）。
車両 ID は含みません。
''')
code(r'''
ERROR_DIR = OUT_DIR / "error_geojson"; ERROR_DIR.mkdir(exist_ok=True)
for old in ERROR_DIR.glob("error_L?_*.geojson"):
    old.unlink()
attrs = ["Id"] + [c for c in ["StreetName", "FRC", "SpeedLimit", "Length"] if c in links.columns] + ["geometry"]
cols = ["Id", "timestamp", "baseline_count", "event_count", "count_ratio", "baseline_speed", "event_speed", "speed_ratio",
        "is_target", "error1_level", "error3_level", "error_level"]
out = err.assign(timestamp=err.window.dt.strftime("%Y-%m-%dT%H:%M:%S"))
counts = []
for w in sorted(event.window.unique()):
    for lv in sorted(ERROR_LEVELS):
        part = out[(out.window == w) & (out.error_level == lv)][cols].merge(links[attrs], on="Id", how="left")
        part = gpd.GeoDataFrame(part, geometry="geometry", crs=links.crs)
        part.to_file(ERROR_DIR / f"error_L{lv}_{pd.Timestamp(w):%Y%m%d_%H%M}.geojson", driver="GeoJSON")
        counts.append({"window": w, "level": lv, "links": len(part)})
counts = pd.DataFrame(counts)
log(f"wrote {len(counts)} files to {ERROR_DIR}（{counts.links.sum():,} リンク・窓、空ファイル {int((counts.links == 0).sum())}）")
display(counts.pivot(index="window", columns="level", values="links").add_prefix("level"))
''')

nb = {"cells": cells, "metadata": {"kernelspec": {"display_name": "Python 3", "language": "python", "name": "python3"},
      "language_info": {"name": "python"}}, "nbformat": 4, "nbformat_minor": 5}
out = Path(__file__).parent / "truck_compare.ipynb"
json.dump(nb, open(out, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
print("wrote", out, len(cells), "cells")
