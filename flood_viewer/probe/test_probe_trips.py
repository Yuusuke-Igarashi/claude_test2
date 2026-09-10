"""Self-test for probe_trips.py with a synthetic track whose expected labels are known.

Run: python3 probe/test_probe_trips.py
"""
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).parent))
from probe_trips import assign_trips, detect_stays, haversine_m  # noqa: E402

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
    add(1500, 2100, 2 * 3600)                 # time gap 2 h
    for i in range(5):
        add(1500, 2100 + 100 * (i + 1), 60)
    add(6500, 2600, 30)                       # jump: 5 km in 30 s
    for i in range(5):
        add(6500 + 100 * (i + 1), 2600, 60)
    add(7010, 2600, 60)                       # sparse stay: two points 3 h apart, 10 m apart
    add(7015, 2605, 3 * 3600)
    for i in range(3):                        # walk on
        add(7000 + 100 * (i + 1), 2600, 60)
    return np.array(lon), np.array(lat), np.array(t)


def main():
    lon, lat, t = track()
    sl = detect_stays(lon, lat, t, 100.0, 20.0)
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


if __name__ == "__main__":
    main()
