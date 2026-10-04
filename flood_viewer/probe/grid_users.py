#!/usr/bin/env python3
"""Unique user ids per 100 m grid cell and 15-min slot, baseline vs event (the simple count).

The elaborate grid of probe_trips.py counts walkers, stays, turns ... over the last hour. This script
counts one thing: how many distinct user ids had at least one point in the cell during the slot's
window, using every point (no Stay/Move or travel-mode logic). It writes, under <out>/grid_users/,
  users_baseline_<HHMM>.tif   count in the baseline period (float32; mean over days when several days are merged)
  users_event_<HHMM>.tif      count in the event period
  users_<HHMM>.tif            ratio event / baseline (NaN where the baseline is 0)
  index.json                  grid definition, slots, files (read by flood_viewer.html like grid/index.json)

Input and periods are the same as probe_trips.py (daily CSV with recordedat, lon, lat, userid):
  --period-start "YYYY-MM-DD HH:MM"   event period of PERIOD_HOURS from that time (may cross midnight), baseline
                                      BASELINE_DAYS_BEFORE days earlier; slots are labelled by the clock time of
                                      the window end, from the period start (12:00, 12:15, ... 11:45)
  otherwise                           one job per file; files of --event-date are the event layer, the others
                                      the baseline layer; several days of one role are averaged per slot
The window of slot T is (T - WINDOW_MIN, T]; with the default WINDOW_MIN = SLOT_MIN = 15 these are plain
15-minute bins. WINDOW_MIN = 60 gives "the last hour" like probe_trips.py.

Usage:
  python grid_users.py 20240814.csv.gz 20240821.csv.gz --out probe_out --period-start "2024-08-21 12:00" \
      --grid-network probe_out/tokyo_20240821_network.geojson
"""
import argparse
import json
import time
from pathlib import Path

import numpy as np
import pandas as pd

from probe_trips import (PARAMS as BASE_PARAMS, Grid, explode_windows, file_date, geojson_bbox, grid_extent, log,
                         parse_bbox, read_period, read_points, write_geotiff)

PARAMS = {
    "GRID_M": 100.0,            # mesh size [m]
    "GRID_NETWORK": None,       # GeoJSON whose extent is the grid extent (e.g. the road network) ...
    "GRID_BBOX": None,          # ... or "lon_min,lat_min,lon_max,lat_max"; else BBOX / AREA_GEOJSON; else the data extent
    "BBOX": None,               # read only points inside this box (also the default grid extent)
    "AREA_GEOJSON": None,       # its extent is used as BBOX when BBOX is not given
    "SLOT_MIN": 15,             # slot length [min]
    "WINDOW_MIN": 15,           # window of each slot (T - WINDOW_MIN, T]; 15 = plain bins, 60 = last hour
    "PERIOD_START": None,       # "YYYY-MM-DD HH:MM" (see module doc); None = one job per file
    "PERIOD_HOURS": 24,
    "BASELINE_DAYS_BEFORE": 7,
    "CHUNK_ROWS": 2_000_000,    # rows per read chunk
    "MAX_ACCURACY_M": None,     # drop points with accuracy above this
    "ONLY_MAIN_DATE": False,    # per-file mode: keep only rows of the file's date
    "OUT_SUBDIR": "grid_users", # output folder under --out
}
LABEL, UNIT = "ユニーク ID 数", "人"


def slot_axis(P, t_start=None, hours=None, date=None):
    """day0 [s], first and last slot index and a label function, as in probe_trips.slot_frame."""
    SLOT = float(P["SLOT_MIN"])
    if t_start is None:                                              # one-file mode: slots 00:15 ... 24:00 of the file's date
        day0 = pd.Timestamp(date); k_lo, k_hi = 1, int(1440 / SLOT)
    else:                                                            # period mode: slot k ends at start + k * SLOT
        day0 = pd.Timestamp(t_start); k_lo, k_hi = 0, int(round(float(hours) * 60 / SLOT)) - 1
    day0_s = float((day0 - pd.Timestamp("1970-01-01")).total_seconds())
    lab = lambda k: (day0 + pd.Timedelta(minutes=k * SLOT)).strftime("%H:%M")
    return day0_s, k_lo, k_hi, lab


def count_users(df, grid, day0_s, k_lo, k_hi, P):
    """Unique users per (slot k, cell) over the window (T_k - WINDOW_MIN, T_k]. Returns {k: Series(cell -> count)}."""
    SLOT, W = float(P["SLOT_MIN"]), float(P["WINDOW_MIN"])
    n_win = int(round(W / SLOT))
    tsec = (df["recordedat"] - pd.Timestamp("1970-01-01")).dt.total_seconds().to_numpy(float)
    mins = (tsec - day0_s) / 60.0
    rep, kk = explode_windows(mins, k_lo, k_hi, SLOT, W, n_win)     # (point, slot) pairs
    cells = grid.cell(df["lon"].to_numpy(float)[rep], df["lat"].to_numpy(float)[rep])
    users = df["ucode"].to_numpy()[rep]
    m = cells >= 0
    t = pd.DataFrame({"k": kk[m], "cell": cells[m], "u": users[m]}).drop_duplicates()
    return {int(k): g.groupby("cell").size().astype(float) for k, g in t.groupby("k")}


def run(inputs, out, event_date="2024-08-21", **params):
    unknown = sorted(k.upper() for k in params if k.upper() not in PARAMS)
    if unknown:
        raise SystemExit(f"unknown parameter(s): {unknown}; known: {sorted(PARAMS)}")
    P = dict(PARAMS); P.update({k.upper(): v for k, v in params.items()})
    if P["BBOX"] is None and P["AREA_GEOJSON"]:
        P["BBOX"] = geojson_bbox(P["AREA_GEOJSON"])
    RP = dict(BASE_PARAMS); RP.update({k: P[k] for k in P if k in RP})   # parameters for probe_trips' readers
    inputs = [Path(p) for p in (inputs if isinstance(inputs, (list, tuple)) else [inputs])]
    out = Path(out) / P["OUT_SUBDIR"]; out.mkdir(parents=True, exist_ok=True)
    if isinstance(event_date, str):
        event_date = [d.strip() for d in event_date.split(",") if d.strip()]
    event_dates = {str(pd.Timestamp(d).date()) for d in event_date}
    log(f"params: {P}")

    bb = grid_extent(P)
    grid = Grid(bb, float(P["GRID_M"])) if bb else None
    if grid is not None:
        log(f"grid: {grid.ncol} x {grid.nrow} cells of {grid.cell_m:g} m")

    # ---- jobs: (role, loader, t_start, hours) ----
    if P["PERIOD_START"]:
        ev0 = pd.Timestamp(P["PERIOD_START"]); hours = float(P["PERIOD_HOURS"])
        periods = {"event": ev0, "baseline": ev0 - pd.Timedelta(days=float(P["BASELINE_DAYS_BEFORE"]))}
        jobs = [(r, (lambda t=t: read_period(inputs, RP, t, hours)[0]), t, hours) for r, t in periods.items()]
        period_info = {r: {"start": f"{t:%Y-%m-%d %H:%M}", "hours": hours, "slot_min": P["SLOT_MIN"]} for r, t in periods.items()}
    else:
        def one_file(path):
            log(f"{path.name}: reading")
            return read_points(path, RP)[0]
        jobs = [(None, (lambda path=path: one_file(path)), None, None) for path in inputs]
        period_info = None

    # ---- count per role; several days of one role (per-file mode) are averaged ----
    acc = {}                    # (role, label) -> Series(cell -> count summed over days)
    days = {}                   # role -> number of days
    labels_order = []
    for role, loader, t_start, hours in jobs:
        t0 = time.perf_counter()
        df = loader()
        if df.empty:
            log("  no rows, skipped"); continue
        date = df["recordedat"].dt.strftime("%Y-%m-%d").mode().iat[0]
        if role is None:
            role = "event" if date in event_dates else "baseline"
        if grid is None:                                             # no extent given: the first job's data extent
            grid = Grid(grid_extent(P, {"lon": df["lon"].to_numpy(), "lat": df["lat"].to_numpy()}), float(P["GRID_M"]))
            log(f"grid from the data extent: {grid.ncol} x {grid.nrow} cells of {grid.cell_m:g} m")
        day0_s, k_lo, k_hi, lab = slot_axis(P, t_start, hours, date)
        counts = count_users(df, grid, day0_s, k_lo, k_hi, P)
        for k in range(k_lo, k_hi + 1):
            key = (role, lab(k))
            if key[1] not in labels_order:
                labels_order.append(key[1])
            if k in counts:
                acc[key] = counts[k] if key not in acc else acc[key].add(counts[k], fill_value=0.0)
        days[role] = days.get(role, 0) + 1
        log(f"  {role} {date}: {len(df):,} points, {df['ucode'].nunique():,} users, "
            f"{sum(len(v) for v in counts.values()):,} (slot, cell) pairs in {time.perf_counter() - t0:.1f} s")
        del df

    # ---- rasters ----
    def dense(role, label):
        arr = np.zeros(grid.nrow * grid.ncol, dtype=np.float32)
        v = acc.get((role, label))
        if v is not None:
            arr[v.index.to_numpy()] = v.to_numpy(np.float32) / max(days.get(role, 1), 1)
        return arr.reshape(grid.nrow, grid.ncol)
    files = []
    both = {"baseline", "event"} <= set(days)
    for label in labels_order:
        hhmm = label.replace(":", "")
        b = dense("baseline", label); e = dense("event", label)
        for role, arr in (("baseline", b), ("event", e)):
            if role in days:
                name = f"users_{role}_{hhmm}.tif"
                write_geotiff(out / name, arr, grid.west, grid.north, grid.dx, grid.dy, nodata=-99.0); files.append(name)
        if both:
            with np.errstate(divide="ignore", invalid="ignore"):
                ratio = np.where(b > 0, e / b, np.nan).astype(np.float32)
            name = f"users_{hhmm}.tif"
            write_geotiff(out / name, ratio, grid.west, grid.north, grid.dx, grid.dy, nodata=float("nan")); files.append(name)
    index = {"cell_m": grid.cell_m, "bounds": [grid.west, grid.south, grid.east, grid.north], "width": grid.ncol, "height": grid.nrow,
             "dx": grid.dx, "dy": grid.dy, "nodata": "nan", "count_nodata": -99.0, "params": ["users"],
             "labels": {"users": LABEL}, "units": {"users": UNIT}, "window_min": P["WINDOW_MIN"], "slot_min": P["SLOT_MIN"],
             "slots": labels_order, "roles": sorted(days), "days": days, "period": period_info,
             "values": "users_<role>_<HHMM>: distinct user ids with a point in the cell during (T - window, T] (mean over days); "
                       "users_<HHMM>: event / baseline (NaN where the baseline is 0)", "files": files}
    with open(out / "index.json", "w", encoding="utf-8") as f:
        json.dump(index, f, ensure_ascii=False, indent=1)
    log(f"wrote {len(files)} rasters to {out} ({len(labels_order)} slots, roles {sorted(days)}, days {days})")
    return index


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("inputs", nargs="+", type=Path, help="daily CSV / CSV.GZ files")
    ap.add_argument("--out", type=Path, default=Path("out"), help="output folder; rasters go to <out>/grid_users/")
    ap.add_argument("--event-date", default="2024-08-21", help="comma-separated dates of the event files (per-file mode)")
    for k, v in PARAMS.items():
        flag = f"--{k.lower().replace('_', '-')}"
        if k == "ONLY_MAIN_DATE":
            ap.add_argument(flag, action="store_true")
        elif k in ("GRID_NETWORK", "GRID_BBOX", "BBOX", "AREA_GEOJSON", "PERIOD_START", "OUT_SUBDIR"):
            ap.add_argument(flag, default=v)
        elif k in ("SLOT_MIN", "WINDOW_MIN", "PERIOD_HOURS", "BASELINE_DAYS_BEFORE", "CHUNK_ROWS"):
            ap.add_argument(flag, type=int, default=v)
        else:
            ap.add_argument(flag, type=float, default=v)
    args = ap.parse_args()
    run(args.inputs, args.out, args.event_date, **{k: getattr(args, k.lower()) for k in PARAMS})


if __name__ == "__main__":
    main()
