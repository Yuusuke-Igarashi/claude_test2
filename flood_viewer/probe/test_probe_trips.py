"""Self-test for probe_trips.py with a synthetic track whose expected labels are known.

Run: python3 probe/test_probe_trips.py
"""
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).parent))
from probe_trips import assign_trips, detect_stays, haversine_m, min_enclosing_circle  # noqa: E402

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


if __name__ == "__main__":
    main()
