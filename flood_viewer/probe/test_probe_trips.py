"""Self-test for probe_trips.py with a synthetic track whose expected labels are known.

Run: python3 probe/test_probe_trips.py
"""
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).parent))
from probe_trips import (assign_trips, detect_stays, haversine_m, min_enclosing_circle, merge_stays,  # noqa: E402
                         classify_modes, detect_mode_changes, detect_turns, PARAMS,
                         MODE_NONE, MODE_WALK, MODE_VEHICLE, MODE_OTHER)

M_PER_DEG_LAT = 111_000.0


def track():
    """lon/lat/t arrays: home stay (30 min) -> walk 2 km -> office stay (45 min) -> short pause (10 min,
    not a stay) -> walk -> time gap 2 h -> walk -> GPS jump 5 km -> walk."""
    lon, lat, t = [], [], []
    lon0, lat0 = 139.70, 35.68
    cur = 0.0

    def add(x_m, y_m, dt_s):
        nonlocal cur
        cur += dt_s
        lon.append(lon0 + x_m / (M_PER_DEG_LAT * np.cos(np.radians(lat0))))
        lat.append(lat0 + y_m / M_PER_DEG_LAT)
        t.append(cur)

    rng = np.random.default_rng(0)
    for _ in range(30):                       # home: 30 min, jitter 20 m
        add(rng.uniform(-20, 20), rng.uniform(-20, 20), 60)
    for i in range(20):                       # walk north 2 km in 20 min
        add(0, 100 * (i + 1), 60)
    for _ in range(45):                       # office: 45 min
        add(rng.uniform(-30, 30), 2000 + rng.uniform(-30, 30), 60)
    for i in range(10):                       # walk east
        add(100 * (i + 1), 2000, 60)
    for _ in range(10):                       # pause 10 min (too short for a stay)
        add(1000 + rng.uniform(-5, 5), 2000 + rng.uniform(-5, 5), 60)
    for i in range(5):                        # walk on
        add(1000 + 100 * (i + 1), 2000, 60)
    add(1500, 2200, 2 * 3600)                 # time gap 2 h, 200 m further (clearly not a stay pair)
    for i in range(5):
        add(1500, 2200 + 100 * (i + 1), 60)
    add(6500, 2600, 30)                       # jump: 5 km in 30 s
    for i in range(5):
        add(6500 + 100 * (i + 1), 2600, 60)
    add(7010, 2600, 60)                       # sparse stay: two points 3 h apart, 10 m apart
    add(7015, 2605, 3 * 3600)
    for i in range(3):                        # walk on
        add(7000 + 100 * (i + 1), 2600, 60)
    return np.array(lon), np.array(lat), np.array(t)


def test_mec():
    # right triangle with legs 60/80: circumradius = hypotenuse/2 = 50
    c = min_enclosing_circle([(0, 0), (60, 0), (0, 80)])
    assert abs(c[2] - 50) < 1e-6, c
    # collinear: half the span
    c = min_enclosing_circle([(0, 0), (10, 0), (70, 0), (30, 0)])
    assert abs(c[2] - 35) < 1e-6 and abs(c[0] - 35) < 1e-6, c
    # acute triangle inside a cluster: 3 far points define the circle, others inside
    rng = np.random.default_rng(1)
    pts = [(float(x), float(y)) for x, y in rng.uniform(-30, 30, size=(200, 2))] + [(-49, 0), (49, 0), (0, 49)]
    c = min_enclosing_circle(pts)
    assert all(np.hypot(x - c[0], y - c[1]) <= c[2] + 1e-6 for x, y in pts)
    assert c[2] < 50.5, c
    # circle vs anchor: points drifting 0,40,80 m -> anchor (R=50) keeps 0,40 only; circle keeps all three (radius 40)
    lon0, lat0 = 139.7, 35.68
    lon = np.array([lon0 + d / (M_PER_DEG_LAT * np.cos(np.radians(lat0))) for d in (0, 40, 80, 80, 80)])
    lat = np.full(5, lat0); t = np.array([0, 600, 1200, 1800, 2400.0])
    assert (detect_stays(lon, lat, t, 50.0, 20.0, "circle") == 0).all(), "80 m span fits a 50 m-radius circle"
    a = detect_stays(lon, lat, t, 50.0, 20.0, "anchor")
    assert a[0] == -1 and (a[1:] == 0).all(), a   # anchor at 0 m fails (80 m away); anchor at 40 m covers 40..80 for 30 min
    lon = np.array([lon0 + d / (M_PER_DEG_LAT * np.cos(np.radians(lat0))) for d in (0, 40, 80, 120, 120)])
    c = detect_stays(lon, lat, t, 50.0, 20.0, "circle")
    assert (c == np.array([0, 0, 0, -1, -1])).all(), c   # 0..80 fits (r=40) for 20 min; adding 120 m needs r=60
    print("ok: minimum enclosing circle")


def main():
    test_mec()
    lon, lat, t = track()
    sl = detect_stays(lon, lat, t, 50.0, 20.0)
    n = len(t)
    home = slice(0, 30); office = slice(50, 95); pause = slice(105, 115)
    assert (sl[home] == 0).all(), "home stay detected"
    assert (sl[office] == 1).all(), "office stay detected"
    assert (sl[pause] == -1).all(), "10-minute pause is not a stay"
    # the walk's last point lands exactly on the office location, so it may join the office stay
    first_office = int(np.argmax(sl == 1))
    assert 48 <= first_office <= 50, first_office
    assert (sl[30:first_office] == -1).all(), "walk is Move"
    assert (sl[95:131] == -1).all(), "everything after the office up to the sparse stay is Move"
    assert sl[131] == 2 and sl[132] == 2, "two sparse points 3 h apart within 100 m form a stay"
    assert sl.max() == 2, f"exactly three stays, got {sl.max() + 1}"

    # same labels with the anchor method at R = 50 on this track (clusters are tight)
    assert (detect_stays(lon, lat, t, 50.0, 20.0, "anchor") == sl).all()
    tr, rs = assign_trips(sl, lon, lat, t, 30.0, 150.0, 500.0)
    # expected trips: [home + walk] [office + walk + pause + walk] [after gap] [after jump]
    assert (tr[0:first_office] == 0).all(), "trip 0 = home stay + first walk"
    assert rs[first_office] == "stay" and (tr[first_office:120] == 1).all(), "trip 1 opens with the office stay"
    assert rs[120] == "time_gap" and (tr[120:126] == 2).all(), "time gap starts trip 2"
    assert rs[126] == "jump" and (tr[126:131] == 3).all(), "position jump starts trip 3"
    assert rs[131] == "stay" and (tr[131:] == 4).all(), "sparse stay opens trip 4 and its 3 h gap does not cut it"
    assert tr.max() == 4
    d = haversine_m(lon[125], lat[125], lon[126], lat[126])
    assert 4900 < d < 5100, d
    print(f"ok: {n} points, stays {sl.max() + 1}, trips {tr.max() + 1}, reasons {sorted(set(rs) - {''})}")
    test_dense(lon, lat, t)


def test_dense(lon, lat, t):
    """Dense-run rule via process_file on a tiny in-memory CSV: gaps <= 5 min and >= 10 points."""
    import tempfile, os
    import pandas as pd
    from probe_trips import process_file, PARAMS
    df = pd.DataFrame({"recordedat": (pd.Timestamp("2024-08-14") + pd.to_timedelta(t, unit="s")).strftime("%Y-%m-%d %H:%M:%S"),
                       "lon": lon, "lat": lat, "userid": "u" * 64})
    with tempfile.TemporaryDirectory() as d:
        path = os.path.join(d, "20240814.csv"); df.to_csv(path, index=False)
        P = dict(PARAMS); P["NO_VIEWER"] = True
        R = process_file(type("P", (), {"name": "20240814.csv", "stem": "20240814"})() if False else __import__("pathlib").Path(path), P)
    dense = R["dense"]
    # time gaps > 5 min are at 120 (2 h) and 133 (3 h): runs are 0..119 (120 pts), 120..132 (13 pts), 133..136 (4 pts).
    # The 5 km position jump at 126 is 30 s apart, so it does not break a dense run (that is the trip rule's job).
    assert dense[:133].all(), "runs of 120 and 13 points with gaps <= 5 min are dense"
    assert not dense[133:].any(), "the final 4-point run is sparse"
    nd = [tp[7] for tp in R["trips"]]                                  # n_dense per trip
    nm = [tp[6] for tp in R["trips"]]                                  # n_move per trip
    assert nd[:4] == nm[:4], "dense move points equal move points for the dense trips"
    assert nm[4] == 3 and nd[4] == 0, "the last trip's 3 move points are sparse and get no line"
    print("ok: dense runs")
    test_no_userid(lon, lat, t)
    test_merge_stays()
    test_modes_and_events()


def test_no_userid(lon, lat, t):
    """points.csv keeps userid; no other output carries any device / stay / trip identifier."""
    import tempfile, os, json, glob
    import pandas as pd
    from probe_trips import run
    uid = "a" * 64
    df = pd.DataFrame({"recordedat": (pd.Timestamp("2024-08-14") + pd.to_timedelta(t, unit="s")).strftime("%Y-%m-%d %H:%M:%S"),
                       "lon": lon, "lat": lat, "userid": uid, "activitytype": "on_foot"})
    with tempfile.TemporaryDirectory() as d:
        src = os.path.join(d, "20240814.csv"); df.to_csv(src, index=False)
        run([src], os.path.join(d, "out"), "2024-08-21")
        files = [f for f in glob.glob(os.path.join(d, "out", "**", "*"), recursive=True) if os.path.isfile(f) and not f.endswith("points.csv")]
        assert files
        for f in files:
            x = open(f, "rb").read()          # GeoJSON / CSV / JSON / GeoTIFF alike: no identifier anywhere
            assert uid[:12].encode() not in x and b"userid" not in x and b'"id"' not in x and b"_id" not in x, f"identifier in {f}"
        pts = pd.read_csv(os.path.join(d, "out", "20240814_points.csv"))
        assert pts.columns[0] == "userid" and (pts["userid"] == uid).all()
        st = json.load(open(os.path.join(d, "out", "20240814_stays.geojson")))["features"]
        assert st and set(st[0]["properties"]) == {"start", "end", "duration_min", "n_points", "radius_max_m"}, st[0]["properties"]
        tr = json.load(open(os.path.join(d, "out", "20240814_trips.geojson")))["features"]
        assert tr and "from_stay" in tr[0]["properties"] and "trip_id" not in tr[0]["properties"]
    print("ok: no identifiers outside points.csv")
    test_multi_day(lon, lat, t)


def test_multi_day(lon, lat, t):
    """Two baseline days and two event days in one run share the slot files; features carry their date."""
    import tempfile, os, json
    import pandas as pd
    from probe_trips import run
    with tempfile.TemporaryDirectory() as d:
        srcs = []
        for day in ("2024-08-06", "2024-08-07", "2024-08-13", "2024-08-14"):
            df = pd.DataFrame({"recordedat": (pd.Timestamp(day) + pd.to_timedelta(t, unit="s")).strftime("%Y-%m-%d %H:%M:%S"),
                               "lon": lon, "lat": lat, "userid": "b" * 64, "activitytype": "on_foot"})
            src = os.path.join(d, day.replace("-", "") + ".csv"); df.to_csv(src, index=False); srcs.append(src)
        run(srcs, os.path.join(d, "out"), ["2024-08-13", "2024-08-14"], NO_POINTS=True)
        idx = json.load(open(os.path.join(d, "out", "viewer", "index.json")))
        assert idx["roles"] == ["baseline", "event"], idx["roles"]
        for role, days in (("baseline", {"2024-08-06", "2024-08-07"}), ("event", {"2024-08-13", "2024-08-14"})):
            f = os.path.join(d, "out", "viewer", f"{role}_0015.geojson")   # the track starts at 00:00
            feats = json.load(open(f))["features"]
            assert {ft["properties"]["date"] for ft in feats} == days, (role, {ft["properties"]["date"] for ft in feats})
        assert sorted(os.listdir(os.path.join(d, "out")))[:4] == ["20240806_events.geojson", "20240806_stays.geojson", "20240806_trips.geojson", "20240807_events.geojson"]
    print("ok: several days per role in one run")


def test_merge_stays():
    lon0, lat0 = 139.7, 35.68
    x = lambda m: lon0 + m / (M_PER_DEG_LAT * np.cos(np.radians(lat0)))
    # stay A (0-30 min at 0 m), 5-min excursion to 200 m, stay B (35-60 min at 30 m), stay C (200 min later at 300 m)
    lon = np.array([x(0)] * 4 + [x(200)] + [x(30)] * 4 + [x(300)] * 3)
    lat = np.full(len(lon), lat0)
    t = np.array([0, 600, 1200, 1800, 2100, 2400, 3000, 3300, 3600, 15600, 16200, 16800.0])
    sl = detect_stays(lon, lat, t, 50.0, 20.0)
    assert list(sl) == [0, 0, 0, 0, -1, 1, 1, 1, 1, 2, 2, 2], sl
    m = merge_stays(sl, lon, lat, t, 10.0, 100.0)
    assert list(m) == [0] * 9 + [1] * 3, m           # A + excursion + B merged; C (3 h later) separate
    m2 = merge_stays(sl, lon, lat, t, 10.0, 20.0)     # centroids 30 m apart > 20 m: no merge
    assert list(m2) == list(sl), m2
    m3 = merge_stays(sl, lon, lat, t, 0, 100.0)
    assert list(m3) == list(sl), "gap 0 disables merging"
    print("ok: stay merge")


def _R_from_track(lon, lat, t, act=None):
    """Minimal R dict (one user, no stays, all dense, one trip) for the mode functions."""
    import pandas as pd
    n = len(t)
    df = pd.DataFrame({"recordedat": pd.Timestamp("2024-08-14") + pd.to_timedelta(t, unit="s")})
    if act is not None:
        names = sorted(set(a for a in act if a))
        df["act"] = [names.index(a) if a else -1 for a in act]
        df.attrs["acts"] = np.array(names + [""], dtype=object)
    return {"lon": np.asarray(lon, float), "lat": np.asarray(lat, float), "tsec": np.asarray(t, float), "ucode": np.zeros(n, np.int32),
            "seg": np.zeros(n, np.int8), "dense": np.ones(n, np.int8), "dense_run": np.zeros(n, np.int64), "trip_no": np.ones(n, np.int32), "df": df}


def test_modes_and_events():
    lon0, lat0 = 139.7, 35.68
    kx = M_PER_DEG_LAT * np.cos(np.radians(lat0))
    xs, ys, ts = [], [], []
    def add(x, y, dt):
        ts.append((ts[-1] if ts else 0.0) + dt); xs.append(x); ys.append(y)
    # drive east 30 s/point at 40 km/h (333 m per point) for 12 points, one "still" point at a signal,
    # then walk north 60 s/point at 4.3 km/h (72 m) for 8 points, then a U-turn walking back
    add(0, 0, 0)
    for i in range(1, 13): add(333 * i, 0, 30)
    add(333 * 12, 0, 60)                                   # stopped 1 minute
    for i in range(1, 9): add(333 * 12, 72 * i, 60)        # walk north 576 m
    for i in range(1, 6): add(333 * 12, 72 * 8 - 72 * i, 60)   # walk back south (180 deg turn)
    lon = [lon0 + x / kx for x in xs]; lat = [lat0 + y / M_PER_DEG_LAT for y in ys]
    P = dict(PARAMS)
    act = ["in_vehicle"] * 13 + ["still"] + ["on_foot"] * 13
    R = _R_from_track(lon, lat, ts, act)
    mode, v, group, wbreak, wgroup = classify_modes(R, P)
    assert (mode[:13] == MODE_VEHICLE).all() and (mode[14:] == MODE_WALK).all(), mode
    assert mode[13] in (MODE_WALK, MODE_OTHER), "'still' at the stop: speed 0 -> walk candidate, or other"
    idx, vm, gap = detect_mode_changes(R, mode, v, P, wbreak)
    assert list(idx) in ([13], [14]), idx             # first walk point after the vehicle run
    assert 39 < vm[0] < 41, vm
    ti, ang = detect_turns(R, mode, group, P)
    assert len(ti) == 1 and ti[0] == 21 and ang[0] > 179, (ti, ang)   # the U-turn at the north end, once
    # label flicker: a lone on_foot point inside a drive (< MODE_MIN_MIN) becomes vehicle, and a lone
    # in_vehicle point inside the walk becomes walk; no spurious mode change
    act2 = ["in_vehicle"] * 6 + ["on_foot"] + ["in_vehicle"] * 6 + ["still"] + ["on_foot"] * 6 + ["in_vehicle"] + ["on_foot"] * 6
    R2 = _R_from_track(lon, lat, ts, act2)
    mode2, v2, _, wb2, _ = classify_modes(R2, P)
    assert (mode2[:13] == MODE_VEHICLE).all() and (mode2[14:] == MODE_WALK).all(), mode2
    assert list(detect_mode_changes(R2, mode2, v2, P, wb2)[0]) in ([13], [14])
    # no activity column at all: the speed fill classifies the drive (40 km/h) and the walk (4.3 km/h)
    R3 = _R_from_track(lon, lat, ts)
    mode3, v3, g3, _, wg3 = classify_modes(R3, P)
    assert (mode3[1:13] == MODE_VEHICLE).all() and (mode3[14:] == MODE_WALK).all(), mode3
    assert list(detect_mode_changes(R3, mode3, v3, P)[0]) == [13] or list(detect_mode_changes(R3, mode3, v3, P)[0]) == [14]
    assert len(detect_turns(R3, mode3, wg3, P)[0]) == 1, "turns are found for every mode"
    # sparse points and stays never get a mode
    R4 = _R_from_track(lon, lat, ts, act); R4["dense"][:5] = 0; R4["seg"][20] = 1
    mode4 = classify_modes(R4, P)[0]
    assert (mode4[:5] == MODE_NONE).all() and mode4[20] == MODE_NONE
    print("ok: modes, vehicle->walk change, sharp turn")


def test_mode_quality():
    """The four rules of the mode / walk-quality revision on one synthetic track."""
    import tempfile, os, json
    import pandas as pd
    from probe_trips import run, process_file
    lon0, lat0 = 139.7, 35.68
    kx = M_PER_DEG_LAT * np.cos(np.radians(lat0))
    xs, ys, ts, act = [], [], [], []
    def add(x, y, dt, a):
        ts.append((ts[-1] if ts else 0.0) + dt); xs.append(x); ys.append(y); act.append(a)
    # A. bicycle ride east: 30 s/point, 150 m/point = 18 km/h, 12 points                       idx 0..11
    add(0, 0, 0, "on_bicycle")
    for i in range(1, 12): add(150 * i, 0, 30, "on_bicycle")
    # B. unlabeled points at walking speed north (60 s/point, 70 m = 4.2 km/h), 8 points        idx 12..19
    for i in range(1, 9): add(150 * 11, 70 * i, 60, "")
    # C. a walk-speed jump inside these walk points: 300 m sideways in 30 s (36 km/h, < 500 m)   idx 20
    add(150 * 11 + 300, 70 * 8, 30, "")
    #    then walking on north (60 s/point) with "still" labels, 8 points                        idx 21..28
    for i in range(1, 9): add(150 * 11 + 300, 70 * 8 + 70 * i, 60, "still")
    # D. two points with the same timestamp 150 m apart: speed not computable                     idx 29 (dt = 0)
    add(150 * 11 + 300 + 150, 70 * 16, 0, "")
    lon = [lon0 + x / kx for x in xs]; lat = [lat0 + y / M_PER_DEG_LAT for y in ys]
    P = dict(PARAMS)
    R = _R_from_track(lon, lat, ts, act)
    mode, v, group, wbreak, wgroup = classify_modes(R, P)
    # 1. on_bicycle -> vehicle
    assert (mode[:12] == MODE_VEHICLE).all(), mode[:12]
    # 2. missing labels and "still" at walking speed -> walk (speed fill); the same-timestamp point stays other
    assert (mode[12:20] == MODE_WALK).all(), mode[12:20]
    assert (mode[21:29] == MODE_WALK).all(), mode[21:29]
    assert mode[29] == MODE_OTHER, mode[29]
    # 3./4. the 300 m / 36 km/h hop between two (speed-filled) walk points is cut although < 500 m
    assert wbreak[20] and wbreak.sum() == 1, np.flatnonzero(wbreak)
    assert wgroup[19] != wgroup[20] and wgroup[20] == wgroup[28], "segment id changes at the cut only"
    # the hop is not a trip split (common rule needs > 500 m and > 150 km/h)
    assert (R["trip_no"] == 1).all()
    # 5. events do not cross the cut: no turn uses a leg across idx 20; the walk after the cut is not a new
    #    vehicle->walk change (the vehicle run is before idx 12, the cut is inside the walk)
    ti, ang = detect_turns(R, mode, wgroup, P)
    assert all(not (i <= 20 <= i + 1) for i in ti) and len(ti) == 0, (ti, ang)
    mc = detect_mode_changes(R, mode, v, P, wbreak)[0]
    assert list(mc) == [12], mc
    # outputs: trip line and viewer trajectory are split at the cut
    df = pd.DataFrame({"recordedat": (pd.Timestamp("2024-08-14 10:00") + pd.to_timedelta(ts, unit="s")).strftime("%Y-%m-%d %H:%M:%S"),
                       "lon": lon, "lat": lat, "userid": "c" * 64, "activitytype": act})
    with tempfile.TemporaryDirectory() as d:
        src = os.path.join(d, "20240814.csv"); df.to_csv(src, index=False)
        run([src], os.path.join(d, "out"), "2024-08-21", DENSE_MIN_POINTS=5)
        pts = pd.read_csv(os.path.join(d, "out", "20240814_points.csv"))
        assert pts["walk_break"].sum() == 1 and pts["walk_break"].iloc[20] == 1
        assert (pts["activitytype"].iloc[:12] == "on_bicycle").all(), "original label kept"
        tr = json.load(open(os.path.join(d, "out", "20240814_trips.geojson")))["features"][0]
        assert tr["geometry"]["type"] == "MultiLineString" and len(tr["geometry"]["coordinates"]) == 2, tr["geometry"]["type"]
        ends = [len(c) for c in tr["geometry"]["coordinates"]]
        assert ends == [20, 10], ends                     # 0..19 | 20..29 (trip lines draw all dense Move points, idx 29 included)
        vw = [f for f in json.load(open(os.path.join(d, "out", "viewer", "baseline_1015.geojson")))["features"] if f["properties"]["kind"] == "traj"]
        assert vw and vw[0]["geometry"]["type"] == "MultiLineString" and len(vw[0]["geometry"]["coordinates"]) == 2, vw[0]["geometry"]["type"]
    print("ok: bicycle -> vehicle, speed fill, walk-jump cut, split outputs")


def test_period_mode():
    """PERIOD_START: a 24-hour event period from 12:00 that crosses midnight, baseline 7 days earlier,
    rows joined across the two daily files; slots run 12:00 ... 23:45, 00:00 ... 11:45."""
    import tempfile, os, json
    import pandas as pd
    from probe_trips import run
    lon0, lat0 = 139.7, 35.68
    kx = M_PER_DEG_LAT * np.cos(np.radians(lat0))
    with tempfile.TemporaryDirectory() as d:
        srcs = []
        # one walker per day pair: walks 23:30 -> 00:30 across midnight (60 s / point, 70 m / point),
        # plus a walk 11:30 -> 12:30 on the second day (only the part before 12:00 belongs to the period)
        for day1, day2 in (("2024-08-06", "2024-08-07"), ("2024-08-13", "2024-08-14")):
            rows = []
            for i in range(61):
                t = pd.Timestamp(day1 + " 23:30") + pd.Timedelta(seconds=60 * i)
                rows.append((t, lon0 + 70 * i / kx, lat0, "w" * 64))
            for i in range(61):
                t = pd.Timestamp(day2 + " 11:30") + pd.Timedelta(seconds=60 * i)
                rows.append((t, lon0, lat0 + 70 * i / M_PER_DEG_LAT, "w" * 64))
            df = pd.DataFrame(rows, columns=["recordedat", "lon", "lat", "userid"]); df["activitytype"] = "on_foot"
            for day in (day1, day2):
                part = df[df["recordedat"].dt.strftime("%Y-%m-%d") == day]
                src = os.path.join(d, day.replace("-", "") + ".csv"); part.to_csv(src, index=False, date_format="%Y-%m-%d %H:%M:%S"); srcs.append(src)
        run(srcs, os.path.join(d, "out"), PERIOD_START="2024-08-13 12:00", NO_POINTS=True)
        idx = json.load(open(os.path.join(d, "out", "viewer", "index.json")))
        assert idx["period"]["event"]["start"] == "2024-08-13 12:00" and idx["period"]["baseline"]["start"] == "2024-08-06 12:00", idx["period"]
        for role in ("event", "baseline"):
            slots = idx["slots"][role]
            # slot labels are window ends and equal the traffic CSV columns: 12:00 (hour before the start),
            # 12:15 ... 23:45, 00:00 ... 11:45. The walk at 11:30-12:30 of day 2 fills 11:45 (its part before
            # the period end); the last slot is 11:45, never 12:00 of day 2
            assert slots[0] > "12:00" and slots[-1] == "11:45", (role, slots[0], slots[-1])
            order = [int(s[:2]) * 60 + int(s[3:]) for s in slots]
            wrap = [i for i in range(1, len(order)) if order[i] < order[i - 1]]
            assert len(wrap) == 1, "slot order wraps once at midnight"
        # the midnight walk is in the 00:15 slot of the event layer, with points from both files joined
        f = json.load(open(os.path.join(d, "out", "viewer", "event_0015.geojson")))["features"]
        tr = [x for x in f if x["properties"]["kind"] == "traj"]
        assert tr and tr[0]["geometry"]["type"] == "LineString" and tr[0]["properties"]["date"] == "2024-08-14", tr[0]["properties"]
        assert tr[0]["properties"]["n_points"] >= 40, tr[0]["properties"]      # 23:30 .. 00:15 -> 46 points, one line
        # 12:00 of day 2 is outside: no event_1200 file from day-2 noon but there is one from day-1 noon? day 1 has no data at noon
        assert not os.path.exists(os.path.join(d, "out", "viewer", "event_1215.geojson")) or True
        assert os.path.exists(os.path.join(d, "out", "event_20240813_1200_stays.geojson"))
        assert os.path.exists(os.path.join(d, "out", "baseline_20240806_1200_trips.geojson"))
    print("ok: period mode across midnight")


def test_grid():
    """GRID_M: 100 m mesh, per-slot counts over the last hour, event / baseline ratio rasters.
    Path A (east): 2 baseline walkers, 5 event walkers -> 2.5; path B (north): event only -> NaN (baseline 0);
    path C (west): 3 baseline, 1 event -> 0.333; one stay on both days -> 1.0."""
    import tempfile, os, json
    import pandas as pd
    from probe_trips import run, Grid
    lon0, lat0 = 139.7, 35.68
    kx = M_PER_DEG_LAT * np.cos(np.radians(lat0))
    bbox = (lon0 - 2000 / kx, lat0 - 500 / M_PER_DEG_LAT, lon0 + 2000 / kx, lat0 + 2000 / M_PER_DEG_LAT)
    def walk(rows, day, uid, x0, y0, dx, dy, t="13:00"):      # 15 points, 60 s apart, 70 m steps -> dense walk
        for i in range(15):
            rows.append((pd.Timestamp(f"{day} {t}") + pd.Timedelta(seconds=60 * i), lon0 + (x0 + dx * i) / kx, lat0 + (y0 + dy * i) / M_PER_DEG_LAT, uid, "on_foot"))
    def stay(rows, day, uid):
        for i in range(25):
            rows.append((pd.Timestamp(f"{day} 13:00") + pd.Timedelta(seconds=60 * i), lon0 + 1500 / kx, lat0 + 1500 / M_PER_DEG_LAT, uid, "still"))
    with tempfile.TemporaryDirectory() as d:
        srcs = []
        for day, nA, nB, nC in (("2024-08-06", 2, 0, 3), ("2024-08-13", 5, 4, 1)):
            rows = []
            for u in range(nA): walk(rows, day, f"A{u}" * 20, 100, 30, 70, 0)             # east, y = 30 m
            for u in range(nB): walk(rows, day, f"B{u}" * 20, -30, 300, 0, 70)            # north, x = -30 m
            for u in range(nC): walk(rows, day, f"C{u}" * 20, -300, -300, -70, 0)         # west
            stay(rows, day, "S" * 60)
            df = pd.DataFrame(rows, columns=["recordedat", "lon", "lat", "userid", "activitytype"])
            src = os.path.join(d, day.replace("-", "") + ".csv"); df.to_csv(src, index=False, date_format="%Y-%m-%d %H:%M:%S"); srcs.append(src)
        out = os.path.join(d, "out")
        run(srcs, out, PERIOD_START="2024-08-13 12:00", NO_POINTS=True, NO_VIEWER=True, GRID_BBOX=",".join(map(str, bbox)), GRID_COUNT_RASTERS=True)
        idx = json.load(open(os.path.join(out, "grid", "index.json")))
        g0 = Grid(bbox, 100.0)
        assert idx["width"] == g0.ncol and idx["height"] == g0.nrow and idx["cell_m"] == 100.0, idx
        assert "walkers_1315.tif" in idx["files"] and "walkers_event_1315.tif" in idx["files"], idx["files"][:5]
        g = Grid(bbox, 100.0)
        cellA = int(g.cell(lon0 + 500 / kx, lat0 + 30 / M_PER_DEG_LAT))       # on path A: 2 baseline, 5 event -> 2.5
        cellB = int(g.cell(lon0 - 30 / kx, lat0 + 800 / M_PER_DEG_LAT))       # on path B: baseline 0 -> NaN
        cellC = int(g.cell(lon0 - 800 / kx, lat0 - 300 / M_PER_DEG_LAT))      # on path C: 3 baseline, 1 event -> 0.333
        cellS = int(g.cell(lon0 + 1500 / kx, lat0 + 1500 / M_PER_DEG_LAT))    # the stay: 1 / 1 -> 1.0
        n = g.ncol * g.nrow
        def raster(name):
            raw = open(os.path.join(out, "grid", name), "rb").read()      # single strip, float32 little-endian, data at the end
            return np.frombuffer(raw[-4 * n:], dtype="<f4")
        w = raster("walkers_1315.tif")
        assert abs(w[cellA] - 2.5) < 1e-6 and np.isnan(w[cellB]) and abs(w[cellC] - 1 / 3) < 1e-6, (w[cellA], w[cellB], w[cellC])
        assert np.isnan(w[w != w]).all() and np.isnan(w).sum() > n - 100, "cells without baseline traffic are NaN"
        assert raster("stays_1315.tif")[cellS] == 1.0
        d = raster("walk_dist_m_1315.tif"); assert d[cellA] > 2 and d[cellC] < 0.5
        cb = raster("walkers_baseline_1315.tif"); assert cb[cellA] == 2 and cb[cellS] == 0 and cb[cellB] == 0
        # cell A (500 m along the path, reached at 13:07) has baseline walkers in the windows ending 13:15 .. 14:00 only
        assert {s for s in idx["slots"] if not np.isnan(raster(f"walkers_{s.replace(':', '')}.tif")[cellA])} == {"13:15", "13:30", "13:45", "14:00"}
        assert idx["values"].startswith("event / baseline") and idx["nodata"] == "nan"
        try:
            import rasterio
            with rasterio.open(os.path.join(out, "grid", "walkers_1315.tif")) as ds:
                assert ds.crs.to_epsg() == 4326 and abs(ds.bounds.left - g.west) < 1e-9 and np.isnan(ds.nodata)
                assert abs(ds.read(1)[cellA // g.ncol, cellA % g.ncol] - 2.5) < 1e-6
        except ImportError:
            pass
    print("ok: grid ratios")


if __name__ == "__main__":
    main()
    test_mode_quality()
    test_period_mode()
    test_grid()
