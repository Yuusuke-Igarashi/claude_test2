#!/usr/bin/env python3
"""Stay/Move segmentation, trip ids and viewer-ready outputs for daily smartphone location logs.

Input : one or more daily CSV files (header: id,recordedat,lon,lat,...,userid,deviceid,...).
Output: per input file, in --out
  <stem>_points.csv          every input row + segment (Stay/Move), stay_id, trip_id, split_reason
  <stem>_stays.geojson       one Point per stay (centroid) with start/end/duration
  <stem>_trips.geojson       one LineString per trip (Move points; origin/destination stay ids)
  and, merged over all inputs (for flood_viewer trajectory mode):
  baseline_trajectory.geojson / baseline_dwell.geojson   (files whose date != --event-date)
  event_trajectory.geojson    / event_dwell.geojson      (file whose date == --event-date)
  Each feature: properties.id = user id, properties.time = "HH:MM" (end of a 1-hour window),
  geometry = LineString/MultiLineString of Move points in [time-60min, time] (trajectory) or
  MultiPoint of stay centroids overlapping the window (dwell).

Rules (parameters in PARAMS, overridable from the command line):
  Stay : a run of consecutive points that can be enclosed by a circle of radius STAY_RADIUS_M
         (minimum enclosing circle; STAY_METHOD=circle) and spans at least STAY_MIN_MIN minutes.
         STAY_METHOD=anchor uses the cheaper rule "all points within R of the run's first point".
         Speed is not used (speed 0 alone is not a stay).
  Move : every other point.
  Trip : the Move run plus the Stay run(s) immediately before it. A new trip id is forced when
         the time gap between consecutive points exceeds TIME_GAP_MIN (unless both points belong
         to the same Stay: sparse logging while stationary does not cut a trip), or when the
         implied speed between consecutive points exceeds JUMP_SPEED_KMH over more than
         JUMP_MIN_DIST_M (an unnatural position jump).

Usage:
  python probe_trips.py Sample.txt [more_days.csv ...] --out ./out --event-date 2024-08-21
"""
from __future__ import annotations

import argparse
import json
import math
from dataclasses import dataclass
from pathlib import Path

import numpy as np
import pandas as pd

PARAMS = {
    "STAY_RADIUS_M": 50.0,    # a stay's points all fit in a circle of this radius (minimum enclosing circle)
    "STAY_MIN_MIN": 20.0,     # minimum stay duration [minutes]
    "STAY_METHOD": "circle",  # "circle": minimum enclosing circle radius <= R; "anchor": all within R of the first point
    "TIME_GAP_MIN": 30.0,     # a gap longer than this between consecutive points starts a new trip
    "JUMP_SPEED_KMH": 150.0,  # implied speed above this ...
    "JUMP_MIN_DIST_M": 500.0, # ... over at least this distance is an unnatural position jump
    "WINDOW_MIN": 60,         # viewer trajectory window [minutes]
    "SLOT_MIN": 15,           # viewer time slots [minutes]
    "MAX_ACCURACY_M": None,   # drop points with accuracy above this (None = keep all)
    "ONLY_MAIN_DATE": False,  # keep only rows of the file's main (most frequent) date
}

EARTH_R = 6371008.8


def haversine_m(lon1, lat1, lon2, lat2):
    """Vectorised great-circle distance in metres."""
    lon1, lat1, lon2, lat2 = map(np.radians, (lon1, lat1, lon2, lat2))
    dlon, dlat = lon2 - lon1, lat2 - lat1
    a = np.sin(dlat / 2) ** 2 + np.cos(lat1) * np.cos(lat2) * np.sin(dlon / 2) ** 2
    return 2 * EARTH_R * np.arcsin(np.sqrt(a))


# ----------------------------------------------------------------------------------------------
# 1. Stay / Move segmentation
# ----------------------------------------------------------------------------------------------
def _circle2(a, b):
    cx, cy = (a[0] + b[0]) / 2, (a[1] + b[1]) / 2
    return cx, cy, math.hypot(a[0] - cx, a[1] - cy)


def _circle3(a, b, c):
    ax, ay = a; bx, by = b; cx, cy = c
    d = 2 * (ax * (by - cy) + bx * (cy - ay) + cx * (ay - by))
    if abs(d) < 1e-12:                       # collinear: the circle on the farthest pair
        cands = [_circle2(a, b), _circle2(a, c), _circle2(b, c)]
        return max(cands, key=lambda k: k[2])
    ux = ((ax * ax + ay * ay) * (by - cy) + (bx * bx + by * by) * (cy - ay) + (cx * cx + cy * cy) * (ay - by)) / d
    uy = ((ax * ax + ay * ay) * (cx - bx) + (bx * bx + by * by) * (ax - cx) + (cx * cx + cy * cy) * (bx - ax)) / d
    return ux, uy, math.hypot(ax - ux, ay - uy)


def _inside(c, p, eps=1e-6):
    return math.hypot(p[0] - c[0], p[1] - c[1]) <= c[2] + eps


def min_enclosing_circle(pts):
    """Smallest circle (cx, cy, r) containing all 2-D points (Welzl, iterative, expected O(n))."""
    if not pts:
        return (0.0, 0.0, 0.0)
    c = (pts[0][0], pts[0][1], 0.0)
    for i in range(1, len(pts)):
        p = pts[i]
        if _inside(c, p):
            continue
        c = (p[0], p[1], 0.0)
        for j in range(i):
            q = pts[j]
            if _inside(c, q):
                continue
            c = _circle2(p, q)
            for k in range(j):
                r = pts[k]
                if not _inside(c, r):
                    c = _circle3(p, q, r)
    return c


M_PER_DEG = EARTH_R * math.pi / 180.0   # metres per degree of latitude (same sphere as haversine_m)


def _local_xy(lon, lat, lon0, lat0):
    """Equirectangular metres relative to (lon0, lat0); exact enough for stay-sized extents."""
    k = math.cos(math.radians(lat0))
    return (lon - lon0) * M_PER_DEG * k, (lat - lat0) * M_PER_DEG


def detect_stays_circle(lon: np.ndarray, lat: np.ndarray, t: np.ndarray, radius_m: float, min_minutes: float):
    """Stay = maximal run i..j-1 whose minimum enclosing circle has radius <= radius_m, lasting
    >= min_minutes. The circle is only recomputed when a new point falls outside the current one."""
    n = len(lon)
    label = np.full(n, -1, dtype=np.int64)
    min_s = min_minutes * 60.0
    k = 0
    i = 0
    while i < n:
        x, y = _local_xy(lon[i:], lat[i:], lon[i], lat[i])
        pts = []
        c = (0.0, 0.0, 0.0)
        j = i
        while j < n:
            p = (float(x[j - i]), float(y[j - i]))
            if pts and _inside(c, p):
                pts.append(p); j += 1; continue
            pts.append(p)
            c2 = min_enclosing_circle(pts)
            if c2[2] > radius_m:
                pts.pop(); break
            c = c2; j += 1
        # run is i..j-1
        if t[j - 1] - t[i] >= min_s:          # a single point has zero duration and is never a stay
            label[i:j] = k; k += 1; i = j
        else:
            i += 1
    return label


def detect_stays_anchor(lon: np.ndarray, lat: np.ndarray, t: np.ndarray, radius_m: float, min_minutes: float):
    """Stay = run i..j-1 with all points within radius_m of point i (cheaper approximation)."""
    n = len(lon)
    label = np.full(n, -1, dtype=np.int64)
    if n == 0:
        return label
    min_s = min_minutes * 60.0
    lat_r = np.radians(lat)
    lon_r = np.radians(lon)
    cos_lat = np.cos(lat_r)
    k = 0
    i = 0
    while i < n:
        # distances from anchor i to all later points (vectorised, cheap for daily per-user tracks)
        dlon = lon_r[i:] - lon_r[i]
        dlat = lat_r[i:] - lat_r[i]
        a = np.sin(dlat / 2) ** 2 + cos_lat[i] * cos_lat[i:] * np.sin(dlon / 2) ** 2
        d = 2 * EARTH_R * np.arcsin(np.sqrt(a))
        outside = np.nonzero(d > radius_m)[0]
        j = i + (outside[0] if len(outside) else (n - i))   # first point outside the radius
        if t[j - 1] - t[i] >= min_s:
            label[i:j] = k
            k += 1
            i = j
        else:
            i += 1
    return label


# ----------------------------------------------------------------------------------------------
# 2. Trip ids
# ----------------------------------------------------------------------------------------------
def detect_stays(lon, lat, t, radius_m, min_minutes, method="circle"):
    if method == "anchor":
        return detect_stays_anchor(lon, lat, t, radius_m, min_minutes)
    if method == "circle":
        return detect_stays_circle(lon, lat, t, radius_m, min_minutes)
    raise ValueError(f"unknown STAY_METHOD {method!r}")


def assign_trips(stay_label: np.ndarray, lon: np.ndarray, lat: np.ndarray, t: np.ndarray,
                 time_gap_min: float, jump_speed_kmh: float, jump_min_dist_m: float):
    """Return (trip index per point, split reason per point).

    A trip = the Stay run(s) immediately preceding a Move run + that Move run. Trips are also
    cut at time gaps and unnatural jumps between consecutive points.
    """
    n = len(t)
    trip = np.zeros(n, dtype=np.int64)
    reason = np.array([""] * n, dtype=object)
    if n == 0:
        return trip, reason
    d = np.zeros(n)
    dt = np.zeros(n)
    d[1:] = haversine_m(lon[:-1], lat[:-1], lon[1:], lat[1:])
    dt[1:] = t[1:] - t[:-1]
    with np.errstate(divide="ignore", invalid="ignore"):
        v_kmh = np.where(dt > 0, d / dt * 3.6, np.inf)
    is_stay = stay_label >= 0
    cur = 0
    reason[0] = "start"
    for i in range(1, n):
        new_reason = None
        same_stay = is_stay[i] and is_stay[i - 1] and stay_label[i] == stay_label[i - 1]
        if dt[i] > time_gap_min * 60.0 and not same_stay:
            # a long gap while moving (lost signal) cuts the trip; a gap inside one stay is just
            # sparse logging while stationary and keeps the stay (and its trip) intact
            new_reason = "time_gap"
        elif d[i] > jump_min_dist_m and v_kmh[i] > jump_speed_kmh:
            new_reason = "jump"
        elif is_stay[i] and not is_stay[i - 1]:
            # Move -> Stay: the previous trip ends; this stay opens the next trip
            new_reason = "stay"
        elif is_stay[i] and is_stay[i - 1] and stay_label[i] != stay_label[i - 1]:
            # two different stays back to back (drifted > radius without a Move point):
            # they merge into the same origin, no new trip
            new_reason = None
        if new_reason:
            cur += 1
            reason[i] = new_reason
        trip[i] = cur
    return trip, reason


# ----------------------------------------------------------------------------------------------
# I/O helpers
# ----------------------------------------------------------------------------------------------
def read_points(path: Path, max_accuracy_m, only_main_date=False):
    df = pd.read_csv(path, dtype={"userid": str, "deviceid": str, "id": str})
    need = {"recordedat", "lon", "lat", "userid"}
    missing = need - set(df.columns)
    if missing:
        raise SystemExit(f"{path}: missing columns {sorted(missing)}")
    # timestamps mix "YYYY-MM-DD HH:MM:SS" and "...SS.fff"; ISO8601 parsing accepts both
    df["recordedat"] = pd.to_datetime(df["recordedat"], errors="coerce", format="ISO8601")
    n0 = len(df)
    df = df.dropna(subset=["recordedat", "lon", "lat", "userid"])
    if max_accuracy_m is not None and "accuracy" in df.columns:
        df = df[~(df["accuracy"] > max_accuracy_m)]
    if only_main_date and len(df):
        main = df["recordedat"].dt.normalize().mode().iat[0]
        df = df[df["recordedat"].dt.normalize() == main]
    df = df.sort_values(["userid", "recordedat"], kind="mergesort").reset_index(drop=True)
    return df, n0 - len(df)


@dataclass
class Stay:
    userid: str
    stay_id: str
    trip_id: str
    start: pd.Timestamp
    end: pd.Timestamp
    lon: float
    lat: float
    n: int
    radius_max_m: float


def process_file(path: Path, P: dict):
    df, dropped = read_points(path, P["MAX_ACCURACY_M"], P["ONLY_MAIN_DATE"])
    date = df["recordedat"].dt.strftime("%Y-%m-%d").mode().iat[0] if len(df) else path.stem
    df["segment"] = "Move"
    df["stay_id"] = ""
    df["trip_id"] = ""
    df["split_reason"] = ""
    stays: list[Stay] = []
    trips = []  # dicts
    for uid, g in df.groupby("userid", sort=False):
        idx = g.index.to_numpy()
        lon = g["lon"].to_numpy(float); lat = g["lat"].to_numpy(float)
        t = (g["recordedat"] - pd.Timestamp("1970-01-01")).dt.total_seconds().to_numpy(float)
        sl = detect_stays(lon, lat, t, P["STAY_RADIUS_M"], P["STAY_MIN_MIN"], P["STAY_METHOD"])
        tr, rs = assign_trips(sl, lon, lat, t, P["TIME_GAP_MIN"], P["JUMP_SPEED_KMH"], P["JUMP_MIN_DIST_M"])
        ushort = uid[:12]
        stay_ids = np.where(sl >= 0, [f"{ushort}_S{k+1:03d}" for k in np.maximum(sl, 0)], "")
        trip_ids = np.array([f"{ushort}_T{k+1:03d}" for k in tr], dtype=object)
        df.loc[idx, "segment"] = np.where(sl >= 0, "Stay", "Move")
        df.loc[idx, "stay_id"] = stay_ids
        df.loc[idx, "trip_id"] = trip_ids
        df.loc[idx, "split_reason"] = rs
        # stays
        for k in range(sl.max() + 1 if len(sl) else 0):
            m = sl == k
            clon, clat = lon[m].mean(), lat[m].mean()
            rad = float(haversine_m(clon, clat, lon[m], lat[m]).max())
            stays.append(Stay(uid, f"{ushort}_S{k+1:03d}", trip_ids[m][0], g["recordedat"].iloc[np.nonzero(m)[0][0]],
                              g["recordedat"].iloc[np.nonzero(m)[0][-1]], clon, clat, int(m.sum()), rad))
        # trips
        for k in range(tr.max() + 1):
            m = tr == k
            mm = m & (sl < 0)
            pos = np.nonzero(m)[0]
            origin = stay_ids[m][0] if sl[pos[0]] >= 0 else ""
            nxt = pos[-1] + 1
            dest = stay_ids[nxt] if nxt < len(sl) and sl[nxt] >= 0 and tr[nxt] == k + 1 and rs[nxt] == "stay" else ""
            length = float(haversine_m(lon[mm][:-1], lat[mm][:-1], lon[mm][1:], lat[mm][1:]).sum()) if mm.sum() > 1 else 0.0
            trips.append({
                "userid": uid, "trip_id": f"{ushort}_T{k+1:03d}", "split_reason": rs[pos[0]],
                "start": g["recordedat"].iloc[pos[0]], "end": g["recordedat"].iloc[pos[-1]],
                "n_points": int(m.sum()), "n_move": int(mm.sum()), "length_m": round(length, 1),
                "origin_stay": origin, "dest_stay": dest,
                "coords": [[round(float(x), 6), round(float(y), 6)] for x, y in zip(lon[mm], lat[mm])],
            })
    return date, df, stays, trips, dropped


def fmt_ts(ts):
    return pd.Timestamp(ts).strftime("%Y-%m-%d %H:%M:%S")


def write_geojson(path: Path, features):
    with open(path, "w", encoding="utf-8") as f:
        json.dump({"type": "FeatureCollection", "features": features}, f, ensure_ascii=False, separators=(",", ":"))


def stays_geojson(stays):
    return [{"type": "Feature",
             "properties": {"userid": s.userid, "stay_id": s.stay_id, "trip_id": s.trip_id, "start": fmt_ts(s.start), "end": fmt_ts(s.end),
                            "duration_min": round((s.end - s.start).total_seconds() / 60, 1), "n_points": s.n, "radius_max_m": round(s.radius_max_m, 1)},
             "geometry": {"type": "Point", "coordinates": [round(s.lon, 6), round(s.lat, 6)]}} for s in stays]


def trips_geojson(trips):
    out = []
    for tp in trips:
        if len(tp["coords"]) < 2:
            continue
        props = {k: (fmt_ts(v) if k in ("start", "end") else v) for k, v in tp.items() if k != "coords"}
        out.append({"type": "Feature", "properties": props, "geometry": {"type": "LineString", "coordinates": tp["coords"]}})
    return out


# ----------------------------------------------------------------------------------------------
# 3. Viewer-ready windows: per user x 15-min slot, the last hour's Move path and stays
# ----------------------------------------------------------------------------------------------
def viewer_features(df: pd.DataFrame, stays: list[Stay], P: dict):
    traj, dwell = [], []
    win = pd.Timedelta(minutes=P["WINDOW_MIN"])
    slot = pd.Timedelta(minutes=P["SLOT_MIN"])
    if not len(df):
        return traj, dwell
    day = df["recordedat"].dt.normalize().iloc[0]
    slots = pd.date_range(day, day + pd.Timedelta(days=1), freq=slot, inclusive="right")
    stays_by_user: dict[str, list[Stay]] = {}
    for s in stays:
        stays_by_user.setdefault(s.userid, []).append(s)
    for uid, g in df.groupby("userid", sort=False):
        ushort = uid[:12]
        times = g["recordedat"].to_numpy()
        for T in slots:
            t0 = T - win
            m = (times > t0.to_datetime64()) & (times <= T.to_datetime64())
            if not m.any():
                continue
            gw = g[m]
            mv = gw[gw["segment"] == "Move"]
            hhmm = T.strftime("%H:%M") if T.normalize() == day else "24:00"
            if len(mv) >= 2:
                # split the path at trip boundaries so jumps are not drawn as lines
                parts = []
                for _, part in mv.groupby("trip_id", sort=False):
                    if len(part) >= 2:
                        parts.append([[round(float(x), 6), round(float(y), 6)] for x, y in zip(part["lon"], part["lat"])])
                if parts:
                    geom = {"type": "LineString", "coordinates": parts[0]} if len(parts) == 1 else {"type": "MultiLineString", "coordinates": parts}
                    traj.append({"type": "Feature",
                                 "properties": {"id": ushort, "time": hhmm, "userid": uid, "n_points": int(len(mv)),
                                                "trips": ",".join(sorted(set(mv["trip_id"])))},
                                 "geometry": geom})
            pts = [[round(s.lon, 6), round(s.lat, 6)] for s in stays_by_user.get(uid, []) if s.start <= T and s.end > t0]
            if pts:
                dwell.append({"type": "Feature",
                              "properties": {"id": ushort, "time": hhmm, "userid": uid, "n_points": len(pts)},
                              "geometry": {"type": "MultiPoint", "coordinates": pts}})
    return traj, dwell


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("inputs", nargs="+", type=Path, help="daily CSV files")
    ap.add_argument("--out", type=Path, default=Path("out"))
    ap.add_argument("--event-date", default="2024-08-21", help="files of this date go to event_*.geojson, others to baseline_*")
    for k, v in PARAMS.items():
        if k == "STAY_METHOD":
            ap.add_argument("--stay-method", choices=["circle", "anchor"], default=v)
        elif k == "ONLY_MAIN_DATE":
            ap.add_argument("--only-main-date", action="store_true", help="drop rows whose date differs from the file's main date")
        else:
            ap.add_argument(f"--{k.lower().replace('_', '-')}", type=float, default=v)
    args = ap.parse_args()
    P = {k: getattr(args, k.lower()) for k in PARAMS}
    P["ONLY_MAIN_DATE"] = bool(P["ONLY_MAIN_DATE"])
    if P["MAX_ACCURACY_M"] is not None and math.isnan(P["MAX_ACCURACY_M"]):
        P["MAX_ACCURACY_M"] = None
    args.out.mkdir(parents=True, exist_ok=True)

    merged = {"baseline": ([], []), "event": ([], [])}
    for path in args.inputs:
        date, df, stays, trips, dropped = process_file(path, P)
        stem = path.name.split(".")[0]          # "20240814.csv.gz" -> "20240814"
        out_df = df.copy()
        out_df["recordedat"] = out_df["recordedat"].dt.strftime("%Y-%m-%d %H:%M:%S.%f").str[:-3]
        out_df.to_csv(args.out / f"{stem}_points.csv", index=False)
        write_geojson(args.out / f"{stem}_stays.geojson", stays_geojson(stays))
        write_geojson(args.out / f"{stem}_trips.geojson", trips_geojson(trips))
        traj, dwell = viewer_features(df, stays, P)
        role = "event" if date == args.event_date else "baseline"
        merged[role][0].extend(traj); merged[role][1].extend(dwell)
        n_users = df["userid"].nunique()
        n_stay_pts = int((df["segment"] == "Stay").sum())
        print(f"{path.name}: date {date} ({role}), users {n_users}, points {len(df)} (dropped {dropped}), "
              f"stay points {n_stay_pts}, stays {len(stays)}, trips {len(trips)}, "
              f"viewer windows: trajectories {len(traj)}, dwell {len(dwell)}")
        reasons = df.loc[df["split_reason"] != "", "split_reason"].value_counts().to_dict()
        print(f"  trip starts by reason: {reasons}")
    for role, (traj, dwell) in merged.items():
        if traj or dwell:
            write_geojson(args.out / f"{role}_trajectory.geojson", traj)
            write_geojson(args.out / f"{role}_dwell.geojson", dwell)
            print(f"{role}_trajectory.geojson: {len(traj)} features / {role}_dwell.geojson: {len(dwell)} features")
    print("params:", P)


if __name__ == "__main__":
    main()
