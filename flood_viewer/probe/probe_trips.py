#!/usr/bin/env python3
"""Stay/Move segmentation, trip ids and viewer-ready outputs for daily smartphone location logs.

Input : one or more daily CSV files (header: id,recordedat,lon,lat,...,userid,deviceid,...).
Output: per input file, in --out
  <stem>_points.csv          every input row + segment (Stay/Move), stay_id, trip_id, split_reason
  All outputs identify a device only by the first 12 characters of userid (KEEP_USERID=False).
  <stem>_stays.geojson       one Point per stay (centroid) with start/end/duration
  <stem>_trips.geojson       one LineString per trip (Move points; origin/destination stay ids)
  <stem>_events.geojson      one Point per vehicle->walk change and per sharp turn
  and, for flood_viewer trajectory mode, one file per role and 15-min slot:
  viewer/<role>_<HHMM>.geojson   role = baseline (date != --event-date) or event (date == --event-date)
  viewer/index.json              roles, slots and feature counts
  Each feature: properties.kind = "traj" | "dwell" | "modechange" | "turn", properties.id = user id, properties.time = "HH:MM"
  (end of the 1-hour window); geometry = LineString/MultiLineString of Move points in
  [time-60min, time] (traj) or MultiPoint of stay centroids overlapping the window (dwell).
  The viewer loads only the slot shown by the time slider, so the whole area can be exported.
  --merged-viewer additionally writes the old single-file <role>_trajectory/_dwell.geojson.

Rules (parameters in PARAMS, overridable from the command line):
  Stay : a run of consecutive points that can be enclosed by a circle of radius STAY_RADIUS_M
         (minimum enclosing circle; STAY_METHOD=circle) and spans at least STAY_MIN_MIN minutes.
         STAY_METHOD=anchor uses the cheaper rule "all points within R of the run's first point".
         Speed is not used (speed 0 alone is not a stay).
  Move : every other point.
  Dense: a run of consecutive points with gaps <= DENSE_MAX_GAP_MIN and >= DENSE_MIN_POINTS points.
         Only dense Move points are drawn as trajectories (viewer) and trip lines; sparse points
         keep their Stay/Move/trip labels (points.csv column dense = 1/0) but are not drawn, so
         straight lines between distant sparse fixes disappear.
  Stay merge: two consecutive stays whose gap is <= STAY_MERGE_GAP_MIN and whose centroids are
         within 2 x STAY_RADIUS_M become one stay (the short excursion between them included).
  Mode : dense Move points take the OS activity type: walk (on_foot, walking, running),
         vehicle (in_vehicle) or other (still, on_bicycle, unknown, missing). The OS label flickers,
         so a run of one mode shorter than MODE_MIN_MIN becomes "other", and an "other" run between
         two runs of the same mode takes that mode.
  Mode change: a vehicle run followed by a walk run in the same trip: the first walk point is
         flagged (people leaving a car).
  Turn : a Move point where the incoming leg (from the last point >= TURN_LEG_M back) and the
         outgoing leg (to the first point >= TURN_LEG_M ahead) differ by >= TURN_MIN_DEG.
  Viewer trajectories are drawn for walk points only: vehicle movement is already covered by the
         traffic statistics.
  Trip : the Move run plus the Stay run(s) immediately before it. A new trip id is forced when
         the time gap between consecutive points exceeds TIME_GAP_MIN (unless both points belong
         to the same Stay: sparse logging while stationary does not cut a trip), or when the
         implied speed between consecutive points exceeds JUMP_SPEED_KMH over more than
         JUMP_MIN_DIST_M (an unnatural position jump).

Usage:
  python probe_trips.py 20240814.csv.gz 20240821.csv.gz --out ./out --event-date 2024-08-21 \
      --bbox 139.55,35.50,139.95,35.85 --viewer-bbox 139.70,35.60,139.80,35.70 --only-main-date

Scale notes: input is read in chunks with the bbox/date filters applied per chunk, so a 20M-row day
fits in memory once filtered. Per-point outputs use integer stay_no/trip_no (ids are strings only
in the stays/trips GeoJSON). Viewer GeoJSON is generated only for users inside VIEWER_BBOX.
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
    "TIME_GAP_MIN": 5.0,      # a gap longer than this between consecutive points starts a new trip (same as the dense-run gap)
    "JUMP_SPEED_KMH": 150.0,  # implied speed above this ...
    "JUMP_MIN_DIST_M": 500.0, # ... over at least this distance is an unnatural position jump
    "WINDOW_MIN": 60,         # viewer trajectory window [minutes]
    "SLOT_MIN": 15,           # viewer time slots [minutes]
    "MAX_ACCURACY_M": None,   # drop points with accuracy above this (None = keep all)
    "ONLY_MAIN_DATE": False,  # keep only rows of the file's date (from the file name YYYYMMDD, else the most frequent date)
    "BBOX": None,             # "lon_min,lat_min,lon_max,lat_max": keep only points inside (applied while reading)
    "AREA_GEOJSON": None,     # path to a GeoJSON; its extent is used as BBOX when BBOX is not given
    "VIEWER_BBOX": None,      # same format: viewer GeoJSON only for users with a point inside this box (default: BBOX)
    "CHUNK_ROWS": 2_000_000,  # rows per read chunk
    "SAMPLE_USERS": 0,        # > 0: process only the first N users (for a timing trial)
    "NO_VIEWER": False,       # skip the viewer GeoJSON outputs
    "NO_POINTS": False,       # skip the per-point CSV (largest output)
    "MERGED_VIEWER": False,   # also write the single-file baseline_/event_ trajectory+dwell GeoJSON (large)
    "DENSE_MAX_GAP_MIN": 5.0, # dense run: consecutive points at most this many minutes apart ...
    "DENSE_MIN_POINTS": 10,   # ... and at least this many points (0 = no density requirement)
    "DENSE_FOR_STAYS": False, # also require dense runs for Stay detection (default: stays use all points)
    "STAY_MERGE_GAP_MIN": 10.0,  # consecutive stays closer in time than this (and within 2 x STAY_RADIUS_M) are merged; 0 = never
    "MODE_MIN_MIN": 3.0,      # a walk / vehicle run (OS activity type) shorter than this becomes "other" (label flicker)
    "TURN_MIN_DEG": 120.0,    # direction change at or above this is a sharp turn ...
    "TURN_LEG_M": 50.0,       # ... measured over legs of at least this length
    "KEEP_USERID": False,     # True: write the full userid into every output. False: only the 12-character id
}

MODE_NONE, MODE_WALK, MODE_VEHICLE, MODE_OTHER = 0, 1, 2, 3
MODE_NAMES = np.array(["", "walk", "vehicle", "other"], dtype=object)
ACT_MODE = {"in_vehicle": MODE_VEHICLE, "on_foot": MODE_WALK, "walking": MODE_WALK, "running": MODE_WALK}
FLAG_NONE, FLAG_MODECHANGE, FLAG_TURN = 0, 1, 2
FLAG_NAMES = np.array(["", "modechange", "turn"], dtype=object)

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


def merge_stays(sl: np.ndarray, lon: np.ndarray, lat: np.ndarray, t: np.ndarray, gap_min: float, dist_m: float):
    """Merge consecutive stays separated by <= gap_min minutes whose centroids are <= dist_m apart.
    The points between them (a short excursion) join the merged stay. Labels are renumbered 0.."""
    K = int(sl.max()) + 1 if len(sl) else 0
    if K < 2 or not gap_min or not dist_m or gap_min <= 0 or dist_m <= 0:
        return sl
    sl = sl.copy()
    first = np.array([np.flatnonzero(sl == k)[0] for k in range(K)])
    last = np.array([np.flatnonzero(sl == k)[-1] for k in range(K)])
    cur = 0
    for k in range(1, K):
        if t[first[k]] - t[last[cur]] <= gap_min * 60.0:
            a, b = first[cur], last[k] + 1
            m_cur = sl[a:last[cur] + 1] == sl[a]
            clon, clat = lon[a:last[cur] + 1][m_cur].mean(), lat[a:last[cur] + 1][m_cur].mean()
            m_k = sl[first[k]:b] == k
            klon, klat = lon[first[k]:b][m_k].mean(), lat[first[k]:b][m_k].mean()
            if haversine_m(clon, clat, klon, klat) <= dist_m:
                sl[a:b] = sl[a]
                last[cur] = last[k]
                continue
        cur = k
    ids = np.unique(sl[sl >= 0])
    remap = np.full(K, -1, dtype=np.int64); remap[ids] = np.arange(len(ids))
    return np.where(sl >= 0, remap[np.maximum(sl, 0)], -1)


# ----------------------------------------------------------------------------------------------
# 3. Travel mode (walk / vehicle / bike / unknown) on dense Move points, vectorised over the day
# ----------------------------------------------------------------------------------------------
def _runs(mode, group, elig):
    """Run-length encode `mode` within `group` over eligible points. Returns (run id per point,
    start, end (exclusive), mode, group) per run. Non-eligible points form their own runs."""
    n = len(mode)
    brk = np.r_[True, (group[1:] != group[:-1]) | (mode[1:] != mode[:-1]) | (elig[1:] != elig[:-1])]
    start = np.flatnonzero(brk); end = np.r_[start[1:], n]
    run = np.cumsum(brk) - 1
    return run, start, end, mode[start].copy(), group[start]


def _bridge(mode, group, elig, tsec, max_s=None):
    """Runs whose neighbours (same group) share one decided mode take that mode: every "other" run when
    max_s is None, otherwise any run shorter than max_s (label flicker inside a walk or a drive)."""
    run, start, end, rm, rg = _runs(mode, group, elig)
    prev_m = np.r_[MODE_NONE, rm[:-1]]; next_m = np.r_[rm[1:], MODE_NONE]
    prev_g = np.r_[-1, rg[:-1]]; next_g = np.r_[rg[1:], -1]
    fill = (prev_m == next_m) & (rm != prev_m) & np.isin(prev_m, (MODE_WALK, MODE_VEHICLE)) & (prev_g == rg) & (next_g == rg)
    fill &= (rm == MODE_OTHER) if max_s is None else (tsec[end - 1] - tsec[start] < max_s)
    rm[fill] = prev_m[fill]
    return rm[run], bool(fill.any())


def classify_modes(R, P: dict):
    """Return (mode per point int8, implied speed km/h into each point, group id per point).
    Mode comes from the OS activity type; runs shorter than MODE_MIN_MIN are "other" and are bridged."""
    lon, lat, tsec = R["lon"], R["lat"], R["tsec"]
    n = len(lon)
    elig = (R["seg"] == 0) & (R["dense"] == 1)
    group = R["dense_run"].astype(np.int64) * (int(R["trip_no"].max()) + 1 if n else 1) + R["trip_no"]
    v = np.full(n, np.nan)                    # implied speed, reported with mode changes (not used for the mode)
    if n > 1:
        same = (group[1:] == group[:-1]) & elig[1:] & elig[:-1]
        d = haversine_m(lon[:-1], lat[:-1], lon[1:], lat[1:]); dt = tsec[1:] - tsec[:-1]
        ok = same & (dt > 0)
        vv = np.full(n - 1, np.nan); vv[ok] = d[ok] / dt[ok] * 3.6
        v[1:] = vv
    raw = np.full(n, MODE_OTHER, dtype=np.int8)
    df = R["df"]
    if "act" in df.columns:
        acts = df.attrs["acts"]
        act_mode = np.array([ACT_MODE.get(str(a).lower(), MODE_OTHER) for a in acts], dtype=np.int8)
        raw = act_mode[df["act"].to_numpy()]
    mode = raw.copy(); mode[~elig] = MODE_NONE
    min_s = float(P["MODE_MIN_MIN"]) * 60.0
    # 1. short runs of anything inside one mode take that mode (repeat: merging exposes new neighbours)
    for _ in range(8):
        mode, changed = _bridge(mode, group, elig, tsec, min_s)
        if not changed:
            break
    # 2. remaining short walk / vehicle runs are not trusted, 3. "other" between equal modes is bridged
    run, start, end, rm, rg = _runs(mode, group, elig)
    rm[np.isin(rm, (MODE_WALK, MODE_VEHICLE)) & (tsec[end - 1] - tsec[start] < min_s)] = MODE_OTHER
    mode, _ = _bridge(rm[run], group, elig, tsec)
    mode[~elig] = MODE_NONE
    return mode.astype(np.int8), v, group


def detect_mode_changes(R, mode, v, P: dict):
    """Indices of the first walk point after a vehicle run in the same trip, with the vehicle run's
    mean implied speed and the gap in minutes."""
    n = len(mode)
    if n == 0:
        return np.array([], dtype=np.int64), np.array([]), np.array([])
    tsec = R["tsec"]
    elig = mode != MODE_NONE
    trip = R["ucode"].astype(np.int64) * (int(R["trip_no"].max()) + 1) + R["trip_no"]
    run, start, end, rm, rg = _runs(mode, trip, elig)
    nr = len(start)
    decided = np.isin(rm, (MODE_WALK, MODE_VEHICLE))
    last = np.maximum.accumulate(np.where(decided, np.arange(nr), -1))
    prev = np.r_[-1, last[:-1]]
    cand = np.flatnonzero((rm == MODE_WALK) & (prev >= 0))
    pv = prev[cand]
    ok = (rm[pv] == MODE_VEHICLE) & (rg[pv] == rg[cand])
    cand, pv = cand[ok], pv[ok]
    idx = start[cand]
    vmean = np.array([np.nanmean(v[start[r] + 1:end[r]]) if end[r] - start[r] > 1 and np.isfinite(v[start[r] + 1:end[r]]).any() else np.nan for r in pv])
    gap = (tsec[idx] - tsec[end[pv] - 1]) / 60.0
    return idx, vmean, gap


def bearing_deg(lon1, lat1, lon2, lat2):
    lon1, lat1, lon2, lat2 = map(np.radians, (lon1, lat1, lon2, lat2))
    y = np.sin(lon2 - lon1) * np.cos(lat2)
    x = np.cos(lat1) * np.sin(lat2) - np.sin(lat1) * np.cos(lat2) * np.cos(lon2 - lon1)
    return (np.degrees(np.arctan2(y, x)) + 360.0) % 360.0


def detect_turns(R, mode, group, P: dict, max_offset: int = 40):
    """Indices of sharp turns and their angles. For each dense Move point the incoming leg ends at the
    point and starts at the last earlier point >= TURN_LEG_M away (same trip & dense run); the outgoing
    leg ends at the first later point >= TURN_LEG_M away. A turn found at i suppresses further turns
    until the end of its outgoing leg."""
    lon, lat = R["lon"], R["lat"]
    n = len(lon)
    if n < 3:
        return np.array([], dtype=np.int64), np.array([])
    elig = mode != MODE_NONE
    L = float(P["TURN_LEG_M"])
    fwd = np.zeros(n, dtype=np.int32); bwd = np.zeros(n, dtype=np.int32)
    for d in range(1, max_offset + 1):
        if d >= n:
            break
        i = np.arange(n - d); j = i + d
        pair = elig[i] & elig[j] & (group[i] == group[j])
        if not pair.any():
            continue
        ii, jj = i[pair], j[pair]
        dist = haversine_m(lon[ii], lat[ii], lon[jj], lat[jj])
        m = (fwd[ii] == 0) & (dist >= L); fwd[ii[m]] = d
        m = (bwd[jj] == 0) & (dist >= L); bwd[jj[m]] = d
    cand = np.flatnonzero(elig & (fwd > 0) & (bwd > 0))
    if not len(cand):
        return np.array([], dtype=np.int64), np.array([])
    a = cand - bwd[cand]; b = cand + fwd[cand]
    ang = np.abs(((bearing_deg(lon[cand], lat[cand], lon[b], lat[b]) - bearing_deg(lon[a], lat[a], lon[cand], lat[cand]) + 180.0) % 360.0) - 180.0)
    keep = ang >= float(P["TURN_MIN_DEG"])
    cand, ang, b = cand[keep], ang[keep], b[keep]
    out, out_ang = [], []
    block_until, block_grp = -1, -1
    for i, an, bb in zip(cand, ang, b):
        if group[i] == block_grp and i < block_until:
            continue
        out.append(i); out_ang.append(an); block_until = bb; block_grp = group[i]
    return np.array(out, dtype=np.int64), np.array(out_ang)


# ----------------------------------------------------------------------------------------------
# I/O helpers
# ----------------------------------------------------------------------------------------------
import re
import sys
import time

REASON_CODES = {0: "", 1: "start", 2: "stay", 3: "time_gap", 4: "jump"}
REASON_IDX = {v: k for k, v in REASON_CODES.items()}


def geojson_bbox(path):
    """Extent (lon_min, lat_min, lon_max, lat_max) of all coordinates in a GeoJSON file."""
    g = json.load(open(path, encoding="utf-8"))
    xs, ys = [], []
    def visit(c):
        if isinstance(c[0], (int, float)):
            xs.append(c[0]); ys.append(c[1])
        else:
            for cc in c:
                visit(cc)
    feats = g["features"] if g.get("type") == "FeatureCollection" else [g]
    for f in feats:
        geom = f.get("geometry", f)
        if geom and geom.get("coordinates"):
            visit(geom["coordinates"])
    return (min(xs), min(ys), max(xs), max(ys))


def parse_bbox(v):
    if v is None or v == "" or (isinstance(v, float) and math.isnan(v)):
        return None
    if isinstance(v, (tuple, list)):
        return tuple(float(x) for x in v)
    parts = [float(x) for x in str(v).split(",")]
    if len(parts) != 4:
        raise SystemExit(f"bbox must be lon_min,lat_min,lon_max,lat_max, got {v!r}")
    return tuple(parts)


def log(msg):
    print(f"[{time.strftime('%H:%M:%S')}] {msg}", flush=True)


def file_date(path: Path):
    m = re.search(r"(20\d{2})(\d{2})(\d{2})", path.name)
    return pd.Timestamp(f"{m.group(1)}-{m.group(2)}-{m.group(3)}") if m else None


def read_points(path: Path, P: dict):
    """Chunked read with bbox / date / accuracy filters. Returns (df sorted by user & time, dropped rows)."""
    header = pd.read_csv(path, nrows=0).columns
    need = {"recordedat", "lon", "lat", "userid"}
    missing = need - set(header)
    if missing:
        raise SystemExit(f"{path}: missing columns {sorted(missing)}")
    cols = [c for c in ["recordedat", "lon", "lat", "accuracy", "speed", "activitytype", "userid"] if c in header]
    bbox = parse_bbox(P["BBOX"])
    main_date = file_date(path) if P["ONLY_MAIN_DATE"] else None
    parts, n0, n_read = [], 0, 0
    code_of: dict = {}                        # userid -> int code (strings kept once, not per row)
    act_of: dict = {}
    t0 = time.perf_counter()
    for ch in pd.read_csv(path, usecols=cols, dtype={"userid": str, "activitytype": str}, chunksize=int(P["CHUNK_ROWS"])):
        n0 += len(ch)
        ch["recordedat"] = pd.to_datetime(ch["recordedat"], errors="coerce", format="ISO8601")
        ch = ch.dropna(subset=["recordedat", "lon", "lat", "userid"])
        if bbox:
            ch = ch[(ch["lon"] >= bbox[0]) & (ch["lon"] <= bbox[2]) & (ch["lat"] >= bbox[1]) & (ch["lat"] <= bbox[3])]
        if P["MAX_ACCURACY_M"] is not None and "accuracy" in ch.columns:
            ch = ch[~(ch["accuracy"] > P["MAX_ACCURACY_M"])]
        if P["ONLY_MAIN_DATE"]:
            if main_date is None:
                main_date = ch["recordedat"].dt.normalize().mode().iat[0]
            ch = ch[ch["recordedat"].dt.normalize() == main_date]
        slim = pd.DataFrame({"recordedat": ch["recordedat"].to_numpy(), "lon": ch["lon"].to_numpy(float), "lat": ch["lat"].to_numpy(float)})
        for c in ("accuracy", "speed"):
            if c in ch.columns:
                slim[c] = ch[c].to_numpy(np.float32)
        for u in ch["userid"].unique():
            if u not in code_of:
                code_of[u] = len(code_of)
        slim["ucode"] = ch["userid"].map(code_of).to_numpy(np.int32)
        if "activitytype" in ch.columns:
            for a in ch["activitytype"].dropna().unique():
                if a not in act_of:
                    act_of[a] = len(act_of)
            slim["act"] = ch["activitytype"].map(act_of).fillna(-1).to_numpy(np.int16)
        parts.append(slim)
        n_read += len(slim)
        log(f"  read {n0:,} rows, kept {n_read:,}")
    df = pd.concat(parts, ignore_index=True) if parts else pd.DataFrame(columns=["recordedat", "lon", "lat", "ucode"])
    del parts
    uids = np.array(list(code_of.keys()), dtype=object)
    acts = np.array(list(act_of.keys()) + [""], dtype=object)     # index -1 -> ""
    if P["SAMPLE_USERS"] and P["SAMPLE_USERS"] > 0:
        df = df[df["ucode"] < int(P["SAMPLE_USERS"])]
    order = np.lexsort((df["recordedat"].to_numpy(), df["ucode"].to_numpy()))
    df = df.iloc[order].reset_index(drop=True)
    df.attrs["acts"] = acts
    log(f"  filtered {len(df):,} rows, {df['ucode'].nunique():,} users in {time.perf_counter() - t0:.1f} s")
    return df, uids, n0 - len(df)


def process_file(path: Path, P: dict):
    """Segment one daily file. Returns dict with arrays, uids, stays list, trips list, date."""
    log(f"{path.name}: reading")
    df, uids, dropped = read_points(path, P)
    n = len(df)
    date = df["recordedat"].dt.strftime("%Y-%m-%d").mode().iat[0] if n else path.stem
    lon = df["lon"].to_numpy(float); lat = df["lat"].to_numpy(float)
    tsec = (df["recordedat"] - pd.Timestamp("1970-01-01")).dt.total_seconds().to_numpy(float)
    ucode = df["ucode"].to_numpy()
    # dense runs: break where user changes or the gap exceeds DENSE_MAX_GAP_MIN; keep runs with enough points
    dense = np.ones(n, dtype=np.int8)
    dense_run = np.zeros(n, dtype=np.int64)
    if n and P["DENSE_MIN_POINTS"] and P["DENSE_MIN_POINTS"] > 0:
        brk = np.r_[True, (np.diff(ucode) != 0) | (np.diff(tsec) > P["DENSE_MAX_GAP_MIN"] * 60.0)]
        dense_run = np.cumsum(brk) - 1
        sizes = np.bincount(dense_run)
        dense = (sizes[dense_run] >= int(P["DENSE_MIN_POINTS"])).astype(np.int8)
    seg = np.zeros(n, dtype=np.int8)          # 1 = Stay
    stay_no = np.zeros(n, dtype=np.int32)     # per-user stay number (1..), 0 = none
    trip_no = np.zeros(n, dtype=np.int32)     # per-user trip number (1..)
    reason = np.zeros(n, dtype=np.int8)
    stays, trips = [], []                     # tuples, see below
    starts = np.flatnonzero(np.r_[True, np.diff(ucode) != 0]) if n else np.array([], dtype=int)
    ends = np.r_[starts[1:], n] if n else np.array([], dtype=int)
    t0 = time.perf_counter()
    for gi, (a, b) in enumerate(zip(starts, ends)):
        lo, la, tt = lon[a:b], lat[a:b], tsec[a:b]
        sl = detect_stays(lo, la, tt, P["STAY_RADIUS_M"], P["STAY_MIN_MIN"], P["STAY_METHOD"])
        if P["DENSE_FOR_STAYS"]:
            sl = np.where(dense[a:b] == 1, sl, -1)
            # renumber stay runs after removing sparse points
            if (sl >= 0).any():
                ids = np.unique(sl[sl >= 0]); remap = {v: i for i, v in enumerate(ids)}
                sl = np.array([remap.get(v, -1) if v >= 0 else -1 for v in sl])
        sl = merge_stays(sl, lo, la, tt, P["STAY_MERGE_GAP_MIN"], 2.0 * P["STAY_RADIUS_M"])
        tr, rs = assign_trips(sl, lo, la, tt, P["TIME_GAP_MIN"], P["JUMP_SPEED_KMH"], P["JUMP_MIN_DIST_M"])
        seg[a:b] = (sl >= 0)
        stay_no[a:b] = np.where(sl >= 0, sl + 1, 0)
        trip_no[a:b] = tr + 1
        reason[a:b] = [REASON_IDX[r] for r in rs]
        u = int(ucode[a])
        for k in range(sl.max() + 1 if len(sl) else 0):
            idx = np.flatnonzero(sl == k)
            clon, clat = lo[idx].mean(), la[idx].mean()
            rad = float(haversine_m(clon, clat, lo[idx], la[idx]).max())
            stays.append((u, k + 1, int(tr[idx[0]]) + 1, tt[idx[0]], tt[idx[-1]], clon, clat, len(idx), rad))
        for k in range(tr.max() + 1):
            pos = np.flatnonzero(tr == k)
            mv = pos[sl[pos] < 0]
            mv = mv[dense[a + mv] == 1]          # line geometry from dense Move points only
            origin = int(sl[pos[0]]) + 1 if sl[pos[0]] >= 0 else 0
            nxt = pos[-1] + 1
            dest = int(sl[nxt]) + 1 if nxt < len(sl) and sl[nxt] >= 0 and rs[nxt] == "stay" else 0
            length = float(haversine_m(lo[mv][:-1], la[mv][:-1], lo[mv][1:], la[mv][1:]).sum()) if len(mv) > 1 else 0.0
            trips.append((u, k + 1, rs[pos[0]], tt[pos[0]], tt[pos[-1]], len(pos), int((sl[pos] < 0).sum()), len(mv), length, origin, dest, a + mv))
        if (gi + 1) % 20000 == 0:
            log(f"  segmented {gi + 1:,}/{len(starts):,} users")
    log(f"  segmentation done: {len(starts):,} users, {len(stays):,} stays, {len(trips):,} trips in {time.perf_counter() - t0:.1f} s")
    R = {"date": date, "df": df, "uids": uids, "lon": lon, "lat": lat, "tsec": tsec, "ucode": ucode,
         "seg": seg, "stay_no": stay_no, "trip_no": trip_no, "reason": reason, "stays": stays, "trips": trips, "dropped": dropped,
         "dense": dense, "dense_run": dense_run}
    t0 = time.perf_counter()
    mode, v_kmh, group = classify_modes(R, P)
    mc_idx, mc_v, mc_gap = detect_mode_changes(R, mode, v_kmh, P)
    turn_idx, turn_ang = detect_turns(R, mode, group, P)
    flag = np.zeros(n, dtype=np.int8)
    flag[turn_idx] = FLAG_TURN
    flag[mc_idx] = FLAG_MODECHANGE           # a point can be both; the mode change is the rarer, more specific one
    R.update({"mode": mode, "v_kmh": v_kmh, "flag": flag,
              "modechanges": (mc_idx, mc_v, mc_gap), "turns": (turn_idx, turn_ang)})
    counts = {MODE_NAMES[m]: int(c) for m, c in zip(*np.unique(mode, return_counts=True)) if m}
    log(f"  modes {counts}, vehicle->walk changes {len(mc_idx):,}, sharp turns {len(turn_idx):,} in {time.perf_counter() - t0:.1f} s")
    return R


def fmt_ts(sec):
    return pd.Timestamp(sec, unit="s").strftime("%Y-%m-%d %H:%M:%S")


def ushort(uid):
    return str(uid)[:12]


class GeoJSONWriter:
    """Streams features to a FeatureCollection file without holding them all in memory."""
    def __init__(self, path: Path):
        self.f = open(path, "w", encoding="utf-8"); self.n = 0
        self.f.write('{"type":"FeatureCollection","features":[')
    def add(self, feature):
        self.f.write(("," if self.n else "") + json.dumps(feature, ensure_ascii=False, separators=(",", ":")))
        self.n += 1
    def close(self):
        self.f.write("]}"); self.f.close(); return self.n


class SlotWriters:
    """One GeoJSON file per (role, HH:MM) under out/viewer, plus index.json; optional merged files."""
    def __init__(self, out: Path, merged: bool):
        self.dir = out / "viewer"; self.dir.mkdir(parents=True, exist_ok=True)
        self.slot = {}; self.merged = {} if merged else None; self.out = out
    def add(self, role, hhmm, kind, feature):
        feature["properties"]["kind"] = kind
        key = (role, hhmm)
        if key not in self.slot:
            self.slot[key] = GeoJSONWriter(self.dir / f"{role}_{hhmm.replace(':', '')}.geojson")
        self.slot[key].add(feature)
        if self.merged is not None:
            mk = (role, kind)
            if mk not in self.merged:
                self.merged[mk] = GeoJSONWriter(self.out / f"{role}_{'trajectory' if kind == 'traj' else 'dwell'}.geojson")
            self.merged[mk].add(feature)
    def close(self):
        index = {"roles": sorted({r for r, _ in self.slot}), "slots": {}, "files": {}}
        for (role, hhmm), w in sorted(self.slot.items()):
            n = w.close()
            index["slots"].setdefault(role, []).append(hhmm)
            index["files"][f"{role}_{hhmm.replace(':', '')}.geojson"] = n
        with open(self.dir / "index.json", "w", encoding="utf-8") as f:
            json.dump(index, f, ensure_ascii=False, indent=1)
        merged_counts = {f"{r}_{k}": w.close() for (r, k), w in (self.merged or {}).items()}
        return index, merged_counts


def write_points_csv(R, path: Path, P: dict, chunk=1_000_000):
    """Per-point CSV written in slices so the string columns never exist for the whole day at once."""
    df = R["df"]; n = len(df)
    acts = df.attrs.get("acts")
    with open(path, "w", encoding="utf-8", newline="") as f:
        for a in range(0, max(n, 1), chunk):
            b = min(a + chunk, n)
            sl = slice(a, b)
            ids = R["uids"][R["ucode"][sl]]
            out = pd.DataFrame({
                ("userid" if P["KEEP_USERID"] else "id"): ids if P["KEEP_USERID"] else np.array([ushort(u) for u in ids], dtype=object),
                "recordedat": df["recordedat"].iloc[sl].dt.strftime("%Y-%m-%d %H:%M:%S.%f").str[:-3].to_numpy(),
                "lon": R["lon"][sl], "lat": R["lat"][sl],
            })
            for c in ("accuracy", "speed"):
                if c in df.columns:
                    out[c] = df[c].to_numpy()[sl]
            if "act" in df.columns:
                out["activitytype"] = acts[df["act"].to_numpy()[sl]]
            out["segment"] = np.where(R["seg"][sl] == 1, "Stay", "Move")
            out["stay_no"] = R["stay_no"][sl]
            out["trip_no"] = R["trip_no"][sl]
            out["split_reason"] = np.array([REASON_CODES[i] for i in range(5)], dtype=object)[R["reason"][sl]]
            out["dense"] = R["dense"][sl]
            out["mode"] = MODE_NAMES[R["mode"][sl]]
            out["flag"] = FLAG_NAMES[R["flag"][sl]]
            out.to_csv(f, index=False, header=(a == 0))
            if n == 0:
                break
    return n


def _who(uids, u, P):
    """Identity properties of a feature: the 12-character id, plus the full userid only if KEEP_USERID."""
    d = {"id": ushort(uids[u])}
    if P["KEEP_USERID"]:
        d["userid"] = str(uids[u])
    return d


def write_stays_geojson(R, path: Path, P: dict):
    w = GeoJSONWriter(path); uids = R["uids"]
    for (u, k, trip, t_start, t_end, clon, clat, npts, rad) in R["stays"]:
        us = ushort(uids[u])
        w.add({"type": "Feature",
               "properties": {**_who(uids, u, P), "stay_id": f"{us}_S{k:03d}", "trip_id": f"{us}_T{trip:03d}",
                              "start": fmt_ts(t_start), "end": fmt_ts(t_end), "duration_min": round((t_end - t_start) / 60, 1),
                              "n_points": int(npts), "radius_max_m": round(rad, 1)},
               "geometry": {"type": "Point", "coordinates": [round(float(clon), 6), round(float(clat), 6)]}})
    return w.close()


def write_trips_geojson(R, path: Path, P: dict):
    w = GeoJSONWriter(path); uids = R["uids"]; lon, lat = R["lon"], R["lat"]
    for (u, k, rs, t_start, t_end, npts, nmove, ndense, length, origin, dest, mv) in R["trips"]:
        if len(mv) < 2:
            continue
        geom = _split_line(mv, lon, lat, R["dense_run"])
        if geom is None:
            continue
        us = ushort(uids[u])
        md = R["mode"][mv]
        w.add({"type": "Feature",
               "properties": {**_who(uids, u, P), "trip_id": f"{us}_T{k:03d}", "split_reason": rs,
                              "start": fmt_ts(t_start), "end": fmt_ts(t_end), "n_points": int(npts), "n_move": int(nmove),
                              "n_dense": int(ndense), "n_walk": int((md == MODE_WALK).sum()), "n_vehicle": int((md == MODE_VEHICLE).sum()),
                              "length_m": round(length, 1),
                              "origin_stay": f"{us}_S{origin:03d}" if origin else "", "dest_stay": f"{us}_S{dest:03d}" if dest else ""},
               "geometry": geom})
    return w.close()


def write_events_geojson(R, path: Path, P: dict):
    """Vehicle->walk changes and sharp turns as Points."""
    w = GeoJSONWriter(path); uids = R["uids"]; lon, lat, tsec = R["lon"], R["lat"], R["tsec"]
    mc_idx, mc_v, mc_gap = R["modechanges"]; turn_idx, turn_ang = R["turns"]
    for i, vv, g in zip(mc_idx, mc_v, mc_gap):
        us = ushort(uids[R["ucode"][i]])
        w.add({"type": "Feature",
               "properties": {"kind": "modechange", **_who(uids, R["ucode"][i], P), "trip_id": f"{us}_T{R['trip_no'][i]:03d}",
                              "at": fmt_ts(tsec[i]), "v_before_kmh": None if np.isnan(vv) else round(float(vv), 1), "gap_min": round(float(g), 1)},
               "geometry": {"type": "Point", "coordinates": [round(float(lon[i]), 6), round(float(lat[i]), 6)]}})
    for i, an in zip(turn_idx, turn_ang):
        us = ushort(uids[R["ucode"][i]])
        w.add({"type": "Feature",
               "properties": {"kind": "turn", **_who(uids, R["ucode"][i], P), "trip_id": f"{us}_T{R['trip_no'][i]:03d}",
                              "at": fmt_ts(tsec[i]), "mode": MODE_NAMES[R["mode"][i]], "angle_deg": round(float(an), 1)},
               "geometry": {"type": "Point", "coordinates": [round(float(lon[i]), 6), round(float(lat[i]), 6)]}})
    return w.close()


def _split_line(idx, lon, lat, run):
    """LineString over idx, split into a MultiLineString where the dense run id changes (gap > DENSE_MAX_GAP_MIN)
    or where points were skipped (idx not consecutive)."""
    parts, cur = [], [idx[0]]
    for i in range(1, len(idx)):
        if run[idx[i]] != run[idx[i - 1]] or idx[i] != idx[i - 1] + 1:
            parts.append(cur); cur = []
        cur.append(idx[i])
    parts.append(cur)
    parts = [[[round(float(lon[i]), 6), round(float(lat[i]), 6)] for i in pp] for pp in parts if len(pp) >= 2]
    if not parts:
        return None
    return {"type": "LineString", "coordinates": parts[0]} if len(parts) == 1 else {"type": "MultiLineString", "coordinates": parts}


# ----------------------------------------------------------------------------------------------
# 3. Viewer-ready windows (vectorised): per user x 15-min slot, the last hour's Move path and stays
# ----------------------------------------------------------------------------------------------
def write_viewer(R, P: dict, role: str, writers: SlotWriters):
    lon, lat, tsec, ucode = R["lon"], R["lat"], R["tsec"], R["ucode"]
    uids = R["uids"]
    n = len(lon)
    if n == 0:
        return 0, 0
    W, SLOT = float(P["WINDOW_MIN"]), float(P["SLOT_MIN"])
    n_win = int(round(W / SLOT))
    vb = parse_bbox(P["VIEWER_BBOX"]) or parse_bbox(P["BBOX"])
    day0 = float((pd.Timestamp(R["date"]) - pd.Timestamp("1970-01-01")).total_seconds())   # midnight of the file's date (naive local time)
    # users to include: those with any point inside the viewer bbox
    if vb:
        inside = (lon >= vb[0]) & (lon <= vb[2]) & (lat >= vb[1]) & (lat <= vb[3])
        sel_users = np.unique(ucode[inside])
        keep = np.isin(ucode, sel_users)
    else:
        keep = np.ones(n, dtype=bool)
    # ---- trajectories: dense walk points exploded into the n_win windows they belong to ----
    mv = np.flatnonzero(keep & (R["seg"] == 0) & (R["dense"] == 1) & (R["mode"] == MODE_WALK) & (tsec >= day0))   # rows before the file's date are not drawn
    mins = (tsec[mv] - day0) / 60.0
    k0 = np.ceil(mins / SLOT).astype(np.int64)                 # first window end >= point time
    k0 = np.maximum(k0, 1)
    rep = np.repeat(mv, n_win)
    kk = np.repeat(k0, n_win) + np.tile(np.arange(n_win), len(mv))
    ok = kk <= int(1440 / SLOT)
    rep, kk = rep[ok], kk[ok]
    order = np.lexsort((tsec[rep], kk, ucode[rep]))
    rep, kk = rep[order], kk[order]
    key_u, key_k = ucode[rep], kk
    bounds = np.flatnonzero(np.r_[True, (np.diff(key_u) != 0) | (np.diff(key_k) != 0), True])
    trip_no = R["trip_no"]; drun = R["dense_run"]
    n_traj = 0
    for a, b in zip(bounds[:-1], bounds[1:]):
        if b - a < 2:
            continue
        idx = rep[a:b]
        parts, cur = [], [idx[0]]
        for i in range(1, len(idx)):
            if trip_no[idx[i]] != trip_no[idx[i - 1]] or drun[idx[i]] != drun[idx[i - 1]] or idx[i] != idx[i - 1] + 1:
                parts.append(cur); cur = []
            cur.append(idx[i])
        parts.append(cur)
        parts = [[[round(float(lon[i]), 6), round(float(lat[i]), 6)] for i in pp] for pp in parts if len(pp) >= 2]
        if not parts:
            continue
        k = int(key_k[a]); mm = int(k * SLOT)
        hhmm = f"{mm // 60:02d}:{mm % 60:02d}"
        geom = {"type": "LineString", "coordinates": parts[0]} if len(parts) == 1 else {"type": "MultiLineString", "coordinates": parts}
        u = int(key_u[a])
        writers.add(role, hhmm, "traj", {"type": "Feature",
                         "properties": {**_who(uids, u, P), "time": hhmm, "n_points": int(b - a),
                                        "mode": ",".join(sorted(set(MODE_NAMES[R["mode"][idx]]))),
                                        "trips": ",".join(f"{ushort(uids[u])}_T{t:03d}" for t in sorted(set(int(trip_no[i]) for i in idx)))},
                         "geometry": geom})
        n_traj += 1
    # ---- dwell: stay centroids exploded into the windows they overlap ----
    n_dwell = 0
    if R["stays"]:
        st = R["stays"]
        su = np.array([s[0] for s in st]); s0 = np.array([s[3] for s in st]); s1 = np.array([s[4] for s in st])
        slon = np.array([s[5] for s in st]); slat = np.array([s[6] for s in st])
        if vb:
            m = np.isin(su, sel_users)
            su, s0, s1, slon, slat = su[m], s0[m], s1[m], slon[m], slat[m]
        # window k overlaps stay if start <= T_k and end > T_k - W  ->  k in [ceil(start/SLOT), floor((end + W)/SLOT - eps)]
        kmin = np.maximum(np.ceil((s0 - day0) / 60.0 / SLOT).astype(np.int64), 1)
        kmax = np.minimum(np.ceil((s1 - day0) / 60.0 / SLOT + W / SLOT).astype(np.int64) - 1, int(1440 / SLOT))
        cnt = np.maximum(kmax - kmin + 1, 0)
        rep = np.repeat(np.arange(len(su)), cnt)
        kk = np.concatenate([np.arange(a_, b_ + 1) for a_, b_ in zip(kmin, kmax) if b_ >= a_]) if cnt.sum() else np.array([], dtype=np.int64)
        order = np.lexsort((kk, su[rep])); rep, kk = rep[order], kk[order]
        key_u = su[rep]
        bounds = np.flatnonzero(np.r_[True, (np.diff(key_u) != 0) | (np.diff(kk) != 0), True]) if len(rep) else np.array([0])
        for a, b in zip(bounds[:-1], bounds[1:]):
            k = int(kk[a]); mm = int(k * SLOT); u = int(key_u[a])
            pts = [[round(float(slon[i]), 6), round(float(slat[i]), 6)] for i in rep[a:b]]
            writers.add(role, f"{mm // 60:02d}:{mm % 60:02d}", "dwell", {"type": "Feature",
                              "properties": {**_who(uids, u, P), "time": f"{mm // 60:02d}:{mm % 60:02d}", "n_points": len(pts)},
                              "geometry": {"type": "MultiPoint", "coordinates": pts}})
            n_dwell += 1
    # ---- events (vehicle->walk, sharp turns): one Point per event, in every window that contains it ----
    n_ev = 0
    mc_idx, mc_v, mc_gap = R["modechanges"]; turn_idx, turn_ang = R["turns"]
    for kind, idx, attrs in (("modechange", mc_idx, lambda j: {"v_before_kmh": None if np.isnan(mc_v[j]) else round(float(mc_v[j]), 1), "gap_min": round(float(mc_gap[j]), 1)}),
                             ("turn", turn_idx, lambda j: {"mode": MODE_NAMES[R["mode"][turn_idx[j]]], "angle_deg": round(float(turn_ang[j]), 1)})):
        if not len(idx):
            continue
        mins = (tsec[idx] - day0) / 60.0
        sel = keep[idx] & (mins >= 0)
        kmin = np.maximum(np.ceil(mins / SLOT).astype(np.int64), 1)
        kmax = np.minimum(np.ceil((mins + W) / SLOT).astype(np.int64) - 1, int(1440 / SLOT))
        for j in np.flatnonzero(sel):
            i = idx[j]; u = int(ucode[i]); us = ushort(uids[u])
            for k in range(int(kmin[j]), int(kmax[j]) + 1):
                mm = int(k * SLOT); hhmm = f"{mm // 60:02d}:{mm % 60:02d}"
                writers.add(role, hhmm, kind, {"type": "Feature",
                                  "properties": {**_who(uids, u, P), "time": hhmm, "at": fmt_ts(tsec[i])[11:16],
                                                 "trip": f"{us}_T{R['trip_no'][i]:03d}", **attrs(j)},
                                  "geometry": {"type": "Point", "coordinates": [round(float(lon[i]), 6), round(float(lat[i]), 6)]}})
                n_ev += 1
    return n_traj, n_dwell, n_ev


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("inputs", nargs="+", type=Path, help="daily CSV / CSV.GZ files")
    ap.add_argument("--out", type=Path, default=Path("out"))
    ap.add_argument("--event-date", default="2024-08-21", help="files of this date go to event_*.geojson, others to baseline_*")
    for k, v in PARAMS.items():
        flag = f"--{k.lower().replace('_', '-')}"
        if k == "STAY_METHOD":
            ap.add_argument(flag, choices=["circle", "anchor"], default=v)
        elif k in ("ONLY_MAIN_DATE", "NO_VIEWER", "NO_POINTS", "MERGED_VIEWER", "DENSE_FOR_STAYS", "KEEP_USERID"):
            ap.add_argument(flag, action="store_true")
        elif k in ("BBOX", "VIEWER_BBOX"):
            ap.add_argument(flag, default=None, help="lon_min,lat_min,lon_max,lat_max")
        elif k == "AREA_GEOJSON":
            ap.add_argument(flag, default=None, help="GeoJSON whose extent is used as --bbox")
        elif k in ("CHUNK_ROWS", "SAMPLE_USERS", "DENSE_MIN_POINTS"):
            ap.add_argument(flag, type=int, default=v)
        else:
            ap.add_argument(flag, type=float, default=v)
    args = ap.parse_args()
    P = {k: getattr(args, k.lower()) for k in PARAMS}
    run(args.inputs, args.out, args.event_date, **P)


def run(inputs, out, event_date="2024-08-21", **params):
    """Python entry point (usable from a notebook):
    run(["20240814.csv.gz", "20240821.csv.gz"], "probe_out", "2024-08-21", BBOX=(139.66,35.58,139.79,35.73), ONLY_MAIN_DATE=True)
    """
    P = dict(PARAMS); P.update({k.upper(): v for k, v in params.items()})
    if P["MAX_ACCURACY_M"] is not None and isinstance(P["MAX_ACCURACY_M"], float) and math.isnan(P["MAX_ACCURACY_M"]):
        P["MAX_ACCURACY_M"] = None
    if P["BBOX"] is None and P["AREA_GEOJSON"]:
        P["BBOX"] = geojson_bbox(P["AREA_GEOJSON"])
        log(f"bbox from {P['AREA_GEOJSON']}: {tuple(round(v, 6) for v in P['BBOX'])}")
    inputs = [Path(p) for p in (inputs if isinstance(inputs, (list, tuple)) else [inputs])]
    out = Path(out); out.mkdir(parents=True, exist_ok=True)
    log(f"params: {P}")
    args = argparse.Namespace(inputs=inputs, out=out, event_date=event_date)

    writers = None if P["NO_VIEWER"] else SlotWriters(args.out, bool(P["MERGED_VIEWER"]))

    for path in args.inputs:
        R = process_file(path, P)
        stem = path.name.split(".")[0]
        n = len(R["lon"])
        role = "event" if R["date"] == args.event_date else "baseline"
        if not P["NO_POINTS"]:
            log(f"  writing {stem}_points.csv ({n:,} rows)")
            write_points_csv(R, args.out / f"{stem}_points.csv", P)
        ns = write_stays_geojson(R, args.out / f"{stem}_stays.geojson", P)
        nt = write_trips_geojson(R, args.out / f"{stem}_trips.geojson", P)
        ne = write_events_geojson(R, args.out / f"{stem}_events.geojson", P)
        n_traj = n_dwell = n_ev = 0
        if writers is not None:
            n_traj, n_dwell, n_ev = write_viewer(R, P, role, writers)
        reasons = {REASON_CODES[c]: int(v) for c, v in zip(*np.unique(R["reason"], return_counts=True)) if c}
        n_dense = int(R["dense"].sum()); u_dense = len(np.unique(R["ucode"][R["dense"] == 1])) if n else 0
        modes = {MODE_NAMES[m]: int(c) for m, c in zip(*np.unique(R["mode"], return_counts=True)) if m}
        print(f"{path.name}: date {R['date']} ({role}), users {len(np.unique(R['ucode'])):,}, points {n:,} (dropped {R['dropped']:,}), "
              f"dense points {n_dense:,} ({100 * n_dense / max(n, 1):.0f}%, {u_dense:,} users), "
              f"stay points {int((R['seg'] == 1).sum()):,}, stays {ns:,}, trips {nt:,} (with >=2 dense move points), "
              f"viewer windows: trajectories {n_traj:,} (walk), dwell {n_dwell:,}, events {n_ev:,}", flush=True)
        print(f"  trip starts by reason: {reasons}", flush=True)
        print(f"  modes of dense move points: {modes}; vehicle->walk changes {len(R['modechanges'][0]):,}, sharp turns {len(R['turns'][0]):,} (events file {ne:,})", flush=True)
        del R
    if writers is not None:
        index, merged_counts = writers.close()
        for role in index["roles"]:
            files = [f for f in index["files"] if f.startswith(role + "_")]
            tot = sum(index["files"][f] for f in files)
            mx = max(index["files"][f] for f in files) if files else 0
            print(f"viewer/{role}_HHMM.geojson: {len(files)} slot files, {tot:,} features (largest slot {mx:,})")
        for k, v in merged_counts.items():
            print(f"merged {k}: {v:,} features")


if __name__ == "__main__":
    main()
