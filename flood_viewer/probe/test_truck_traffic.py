"""Self-test for truck_traffic.ipynb: builds a small synthetic network + probe zip, runs the notebook's code
cells in order (no jupyter needed) and checks the results.   python3 test_truck_traffic.py

Synthetic network (EPSG:4326; TomTom-like columns):
  Id 1  main road W->E, 800 m, limit 60; Id 2 = exact duplicate, Id 3 = reversed duplicate  -> one link "1"
  Id 4  side road 30 m north of Id 1, 800 m, limit 40; Id 5 = duplicate  -> one link "4" (its ends touch no other link)
  Id 6  main road continues east 600 m, limit 60
  Id 7  60 m branch north at the join of 1/6, limit 30
  Id 8  far away link (never visited)
  Id 9-12  four 200 m parallel links (limit 30) 100-130 m south of the main road
  Id 13 "Upper": 600 m east from the north end of Id 7, so 1 -> 7 -> 13 is a connected path
Probe (1 Hz, zip with one CSV per hour, same columns as the real sample):
  A  drives 1 then 6 at 50 km/h (12:03), and again at 13:40 (second file)
  B  drives 4 at 30 km/h with a 12 m GPS offset; near its end link 7 is also a candidate but is not connected to 4 -> stays on 4
  C  drives 1 at 70 km/h with a 5 m offset (link 4 is 25 m away -> higher observation cost)
  D  parked 20 min on link 1 at 0 km/h -> stopped, not counted
  E  drives 1 at 55 km/h across the 12:15 boundary -> counted in both windows
  F  drives 6 then 1 westward at 40 km/h; one point nudged to 2 m from link 7 -> one point cannot pay for the switch
  G  drives 500 m south of everything -> no candidate links -> nothing assigned
  H  90 km/h between links 9 and 10 (4 m / 6 m away) -> matched to 9 (there is no speed-limit rule)
  I  drives 1 -> 7 -> 13 at 50 km/h with only every 7th point kept (7 s gaps): no point falls on the 60 m link 7,
     which is still counted as a through link (via) because the route passes it
The probe zip is split into two files by TIME here (12:xx and 13:xx); the notebook no longer assumes that: pass 1 finds the
vehicles that touch the area, pass 2 collects their points from all files into one trajectory table.
The main run uses area.geojson (A-F and I inside; G and H south of it are excluded); the second run has no area.
"""
import io, json, zipfile
from pathlib import Path
import numpy as np, pandas as pd, geopandas as gpd
from shapely.geometry import LineString

HERE = Path(__file__).parent
T = HERE / "testdata"
T.mkdir(exist_ok=True)
LAT0, LON0 = 35.60, 139.70
M_LAT, M_LON = 1 / 111_000.0, 1 / (111_000.0 * np.cos(np.radians(LAT0)))
ll = lambda x, y: (LON0 + x * M_LON, LAT0 + y * M_LAT)
line = lambda pts: LineString([ll(x, y) for x, y in pts])


def make_data():
    L1 = line([(0, 0), (400, 0), (800, 0)])
    rows = [(1, 1001, 1001, 800.0, 2, 60, "Main", L1), (2, 1002, 1001, 800.0, 2, 60, "Main", L1),
            (3, 1003, 1001, 800.0, 2, 60, "Main", LineString(list(L1.coords)[::-1])),
            (4, 1004, 1004, 800.0, 4, 40, "Side", line([(0, 30), (800, 30)])), (5, 1005, 1004, 800.0, 4, 40, "Side", line([(0, 30), (800, 30)])),
            (6, 1006, 1006, 600.0, 2, 60, "Main", line([(800, 0), (1400, 0)])), (7, 1007, 1007, 60.0, 5, 30, "Branch", line([(800, 0), (800, 60)])),
            (8, 1008, 1008, 800.0, 2, 60, "Far", line([(0, -3000), (800, -3000)]))]
    rows += [(9 + i, 1009 + i, 1009 + i, 200.0, 5, 30, f"P{i + 1}", line([(0, -100 - 10 * i), (200, -100 - 10 * i)])) for i in range(4)]
    rows += [(13, 1013, 1013, 600.0, 3, 40, "Upper", line([(800, 60), (1400, 60)]))]
    net = gpd.GeoDataFrame(rows, columns=["Id", "Segment Id", "NewSegId", "Length", "FRC", "SpeedLimit", "StreetName", "geometry"], crs="EPSG:4326")
    net["Id"] = net["Id"].astype(float)
    net.to_file(T / "network.shp")

    def track(vid, t0, pts_m, kmh, y_off=0.0):
        v = kmh / 3.6
        seg = [np.hypot(x2 - x1, y2 - y1) for (x1, y1), (x2, y2) in zip(pts_m[:-1], pts_m[1:])]
        out = []
        for k in range(int(sum(seg) / v) + 1):
            s, acc = k * v, 0.0
            for (x1, y1), (x2, y2), L in zip(pts_m[:-1], pts_m[1:], seg):
                if s <= acc + L or L == seg[-1]:
                    f = min(max((s - acc) / L, 0), 1); x, y = x1 + f * (x2 - x1), y1 + f * (y2 - y1) + y_off; break
                acc += L
            lon, lat = ll(x, y)
            out.append([vid, (t0 + pd.Timedelta(seconds=k)).strftime("%Y-%m-%d %H:%M:%S"), t0.strftime("%Y-%m-%d %H:%M:%S"),
                        int(round(kmh + np.sin(k) * 2)), round(lat, 6), round(lon, 6), 90, ""])
        return out

    D = "2025-09-10 "
    ts = lambda s: pd.Timestamp(D + s)
    h12 = track("A", ts("12:03:00"), [(0, 0), (800, 0), (1400, 0)], 50)
    h12 += track("B", ts("12:05:00"), [(0, 30), (800, 30)], 30, y_off=12)
    h12 += track("C", ts("12:07:00"), [(0, 0), (800, 0)], 70, y_off=5)
    lon, lat = ll(300, 2)
    h12 += [["D", (ts("12:10:00") + pd.Timedelta(seconds=k)).strftime("%Y-%m-%d %H:%M:%S"), D + "12:10:00", 0, round(lat, 6), round(lon, 6), 0, ""] for k in range(1200)]
    h12 += track("E", ts("12:14:30"), [(0, 0), (800, 0)], 55)
    f = track("F", ts("12:20:00"), [(1400, 0), (800, 0), (0, 0)], 40)
    lon, lat = ll(802, 6); f[int(600 / (40 / 3.6))][4:6] = [round(lat, 6), round(lon, 6)]   # blip: 2 m from link 7, 6 m from link 6
    h12 += f
    h12 += track("G", ts("12:30:00"), [(0, -500), (800, -500)], 45)
    h12 += track("H", ts("12:40:00"), [(0, -104), (200, -104)], 90)
    h12 += track("I", ts("12:50:00"), [(0, 0), (800, 0), (800, 60), (1400, 60)], 50)[::7]
    h13 = track("A", ts("13:40:00"), [(0, 0), (800, 0), (1400, 0)], 48)
    # area polygon (like the user's tokyo.geojson: JGD2011 lon/lat): covers A-F and I; excludes G and H (south of y = -50 m)
    ax0, ay0 = ll(-200, -50); ax1, ay1 = ll(1500, 2000)
    json.dump({"type": "FeatureCollection", "name": "area", "crs": {"type": "name", "properties": {"name": "urn:ogc:def:crs:EPSG::6668"}},
               "features": [{"type": "Feature", "properties": {"N03_004": "test"}, "geometry": {"type": "MultiPolygon",
                             "coordinates": [[[[ax0, ay0], [ax1, ay0], [ax1, ay1], [ax0, ay1], [ax0, ay0]]]]}}]}, open(T / "area.geojson", "w"))
    cols = ["serial_number", "record_time", "travel_start_time", "speed", "gps_latitude", "gps_longitude", "gps_direction", "industry_flag"]
    with zipfile.ZipFile(T / "probe.zip", "w", zipfile.ZIP_DEFLATED) as z:
        for name, rows_ in [("probe/2025-09-10_12.csv", h12), ("probe/2025-09-10_13.csv", h13)]:
            df = pd.DataFrame(rows_, columns=cols)
            df.loc[len(df)] = ["A", D + "12:59:59", D + "12:03:00", 0, np.nan, np.nan, np.nan, ""]   # malformed row (no lat/lon)
            z.writestr(name, df.to_csv(index=False))
        z.writestr("__MACOSX/probe/._2025-09-10_12.csv", b"junk")                                   # Finder junk, must be ignored
        z.writestr("probe/README.txt", "notes")                                                     # not a data file: skipped with an error row
    return len(h12), len(h13)


def run_notebook(out_dir, area=None, step=1, traj_out=True):
    nb = json.load(open(HERE / "truck_traffic.ipynb", encoding="utf-8"))
    g = {"display": lambda x: print(x.to_string() if hasattr(x, "to_string") else x)}
    for i, c in enumerate(nb["cells"]):
        if c["cell_type"] != "code":
            continue
        src = "".join(c["source"])
        if i == 2:   # parameter cell -> synthetic data
            src = src.replace('Path("../data/Flooding_2025/post/network.shp")', f'Path("{T / "network.shp"}")') \
                     .replace('Path("../data/truck_probe.zip")', f'Path("{T / "probe.zip"}")') \
                     .replace('Path("./traffic_out")', f'Path("{out_dir}")')
            if area:
                src = src.replace("AREA_GEOJSON = None", f'AREA_GEOJSON = "{area}"')
            src = src.replace("POINT_STEP_S = 10 ", f"POINT_STEP_S = {step} ").replace("TRAJ_OUT = False ", f"TRAJ_OUT = {traj_out} ")
            assert f"POINT_STEP_S = {step} " in src and f"TRAJ_OUT = {traj_out} " in src
        print(f"\n---------------- cell {i} ----------------")
        exec(compile(src, f"cell{i}", "exec"), g)
    return g


def hits(out_dir):
    w = pd.read_csv(Path(out_dir) / "traffic_15min.csv", parse_dates=["window"]).set_index(["window", "Id"])
    return w, {(f"{k[0]:%H:%M}", int(k[1])): int(v) for k, v in w.Hits.items()}


def table(out_dir, stem):
    O = Path(out_dir)
    f = O / f"{stem}.parquet"
    df = pd.read_parquet(f) if f.exists() else pd.read_csv(O / f"{stem}.csv.gz", dtype={"serial_number": str})
    df["t"] = pd.to_datetime(df["t"])
    return df


def check(out_dir):
    """Run with area.geojson."""
    O = Path(out_dir)
    links = pd.read_csv(O / "network_agg.csv").set_index("Id")
    assert len(links) == 9 and 8 not in links.index and links.loc[1, "member_ids"] == "1;2;3" and links.loc[4, "n_members"] == 2, links   # link 8 (3 km south) is outside the bbox + 1 km
    assert "NewSegId" in links.columns and "Segment Id" in links.columns
    # pass 1: vehicles with at least one point inside the polygon (G at y=-500 and H at y=-104 are outside)
    veh = pd.read_csv(O / "vehicles_in_area.csv", dtype={"serial_number": str})
    assert veh.serial_number.tolist() == ["A", "B", "C", "D", "E", "F", "I"], veh
    assert int(veh.set_index("serial_number").loc["D", "n_points_in_area"]) == 1200
    # pass 2: one trajectory table for those vehicles, both files joined, sorted by vehicle and time
    tr = table(O, "trajectories")
    assert list(tr.columns) == ["serial_number", "t", "lat", "lon", "speed"]
    assert set(tr.serial_number) == set("ABCDEFI") and tr.equals(tr.sort_values(["serial_number", "t"], kind="stable").reset_index(drop=True))
    assert (tr.serial_number == "A").sum() == 101 + 106, "A: 12:03 track (file 12) + 13:40 track (file 13)"
    # matching results
    w, got = hits(O)
    expect = {("12:00", 1): 3, ("12:00", 4): 1, ("12:00", 6): 1, ("12:15", 1): 2, ("12:15", 6): 1,
              ("12:45", 1): 1, ("12:45", 7): 1, ("12:45", 13): 1, ("13:30", 1): 1, ("13:30", 6): 1}
    assert got == expect, (got, expect)                      # exactly these window x link rows, with these vehicle counts (D parked, no G/H)
    c = w.loc[(pd.Timestamp("2025-09-10 12:00"), 1)]
    assert abs(c.AvgSp - (50 + 70 + 55) / 3) < 1.5 and c.n_points == 58 + 42 + 30, c.to_dict()   # A 58 s (50 km/h), C 42 s (70 km/h), E 30 s before 12:15
    v = w.loc[(pd.Timestamp("2025-09-10 12:45"), 7)]
    assert v.Hits == 1 and v.n_points == 0 and np.isnan(v.AvgSp), v.to_dict()                    # link 7: passed by I, no point -> no speed
    # matched points: every vehicle x second with the link it was on, plus the link attributes
    pts = table(O, "matched_points")
    assert list(pts.columns) == ["serial_number", "t", "lat", "lon", "speed", "Id", "StreetName", "FRC", "SpeedLimit", "Length"], pts.columns
    assert len(pts) == len(tr), "every point got a link (all inside 50 m of a route link)"
    # link stays: enter / exit time per vehicle and link; the 60 m link 7 has no point but still an interval between I's points at 12:50:56 and 12:51:03
    st = pd.read_parquet(O / "link_stays.parquet") if (O / "link_stays.parquet").exists() else pd.read_csv(O / "link_stays.csv.gz", dtype={"serial_number": str}, parse_dates=["t_enter", "t_exit"])
    assert list(st.columns) == ["serial_number", "Id", "t_enter", "t_exit", "n_points", "v_mean", "StreetName", "FRC", "SpeedLimit", "Length"], st.columns
    i7 = st[(st.serial_number == "I") & (st.Id == 7)]
    assert len(i7) == 1 and i7.iloc[0].n_points == 0 and np.isnan(i7.iloc[0].v_mean) and i7.iloc[0].StreetName == "Branch", i7
    assert pd.Timestamp("2025-09-10 12:50:56") <= i7.iloc[0].t_enter < i7.iloc[0].t_exit <= pd.Timestamp("2025-09-10 12:51:03"), i7
    assert 3.5 <= (i7.iloc[0].t_exit - i7.iloc[0].t_enter).total_seconds() <= 5.0, "60 m at 50 km/h is 4.3 s"
    sI = st[st.serial_number == "I"].sort_values("t_enter")
    assert sI.Id.tolist() == [1, 7, 13] and (sI.t_enter.to_numpy()[1:] == sI.t_exit.to_numpy()[:-1]).all(), "stays are contiguous: exit of one = entry of the next"
    sA = st[st.serial_number == "A"].sort_values("t_enter")
    assert sA.Id.tolist() == [1, 6, 1, 6], "A drives 1 -> 6 twice (12:03 and 13:40)"
    assert abs((sA.iloc[0].t_exit - pd.Timestamp("2025-09-10 12:03:00")).total_seconds() - 800 / (50 / 3.6)) < 1.5, "A leaves link 1 after ~57.6 s"
    assert sA.iloc[0].n_points == 58 and sA.iloc[1].n_points == 43 and abs(sA.iloc[0].v_mean - 50) < 1.5
    assert (st[st.serial_number == "D"].Id == 1).all() and st[st.serial_number == "D"].n_points.sum() == 1200
    assert set(pts[pts.serial_number == "D"].Id) == {1} and set(pts[pts.serial_number == "A"].Id) == {1, 6} and set(pts[pts.serial_number == "I"].Id) == {1, 13}
    assert (pts[pts.serial_number == "C"].Id == 1).all() and (pts[pts.serial_number == "B"].Id == 4).all()
    files = sorted(p.name for p in O.glob("traffic_2025*.csv"))
    assert files == ["traffic_20250910_1200.csv", "traffic_20250910_1215.csv", "traffic_20250910_1245.csv", "traffic_20250910_1330.csv"], files
    one = pd.read_csv(O / files[0]); assert list(one.columns) == ["Id", "Hits", "AvgSp", "MedSp", "n_points"]
    # trajectories: one file per slot from 12:15 to 13:45, written once from the whole table (nothing overwritten)
    tf = sorted(p.name for p in (O / "traj").glob("traj_*.geojson"))
    assert tf == [f"traj_20250910_{h}.geojson" for h in ["1215", "1230", "1245", "1300", "1315", "1330", "1345"]], tf
    f15 = json.load(open(O / "traj" / "traj_20250910_1215.geojson"))["features"]
    assert len(f15) == 4, [f["properties"] for f in f15]          # A, B, C, E (D is parked -> too short; F, I later)
    assert all(set(f["properties"]) == {"time", "date", "n_points", "v_mean", "v_max"} and f["properties"]["time"] == "12:15" for f in f15)
    assert "serial" not in open(O / "traj" / "traj_20250910_1215.geojson").read()
    f1345 = json.load(open(O / "traj" / "traj_20250910_1345.geojson"))["features"]   # window 12:45-13:45: A (13:40, from the second file) and I (12:50)
    assert sorted(f["properties"]["n_points"] for f in f1345) == [16, 106], [f["properties"] for f in f1345]
    a = next(f for f in f1345 if f["properties"]["n_points"] == 106)
    assert a["geometry"]["type"] == "LineString" and len(a["geometry"]["coordinates"]) < 20, "simplified (a straight 1.4 km track needs only a few vertices)"
    idx = json.load(open(O / "traj" / "index.json")); assert idx["window_min"] == 60 and len(idx["files"]) == 7 and idx["files"]["traj_20250910_1215.geojson"] == 4
    sm = json.load(open(O / "summary.json"))
    assert sm["vehicles_in_area"] == 7 and sm["stays_without_points"] == 1 and sm["short_points"] == 0 and sm["unmatched_points"] == 0 and sm["segments"] == 8, sm   # A x2 (gap), B, C, D, E, F, I
    print("\ntest_truck_traffic (area): OK")


def check_step10(out_dir):
    """POINT_STEP_S = 10 (the default): one point per 10 s bucket. Hits are unchanged except for trips shorter than
    MIN_SEQ_POINTS x 10 s (H drives 8 s -> 1 point -> no route). No traj/ by default."""
    O = Path(out_dir)
    tr = table(O, "trajectories")
    assert len(tr) < 220, len(tr)                                   # 1,816 one-second points -> about 190
    assert tr.groupby(["serial_number", tr.t.dt.floor("10s")]).size().max() == 1, "at most one point per vehicle and 10 s bucket"
    w, got = hits(O)
    expect = {("12:00", 1): 3, ("12:00", 4): 1, ("12:00", 6): 1, ("12:15", 1): 2, ("12:15", 6): 1,
              ("12:45", 1): 1, ("12:45", 7): 1, ("12:45", 13): 1, ("13:30", 1): 1, ("13:30", 6): 1}
    assert got == expect, (got, expect)                               # same as the 1 s run minus H (8 s trip)
    c = w.loc[(pd.Timestamp("2025-09-10 12:00"), 1)]
    assert abs(c.AvgSp - (50 + 70 + 55) / 3) < 2.0 and c.n_points == 6 + 5 + 3, c.to_dict()   # A 58 s, C 42 s, E 30 s at one point per 10 s
    assert not (O / "traj").exists() or not list((O / "traj").glob("*.geojson")), "no trajectories by default"
    sm = json.load(open(O / "summary.json"))
    assert sm["short_points"] >= 1 and sm["traj_slot_files"] == 0, sm   # H's single point is a too-short sequence
    print("test_truck_traffic (step 10 s, default): OK")


def check_noarea(out_dir):
    """Without AREA_GEOJSON every vehicle is kept: H is matched to link 9 (no speed-limit rule), G has no candidate links."""
    O = Path(out_dir)
    veh = pd.read_csv(O / "vehicles_in_area.csv", dtype={"serial_number": str})
    assert veh.serial_number.tolist() == list("ABCDEFGHI"), veh
    w, got = hits(O)
    assert got[("12:30", 9)] == 1 and got[("12:00", 1)] == 3 and len(got) == 11, got
    m = table(O, "matched_points")
    assert (m.serial_number == "G").sum() == 0 and set(m[m.serial_number == "H"].Id) == {9}
    sm = json.load(open(O / "summary.json"))
    assert sm["vehicles_in_area"] == 9 and sm["unmatched_points"] == 65, sm      # G's 65 points are more than 50 m from any link
    f45 = json.load(open(O / "traj" / "traj_20250910_1245.geojson"))["features"]
    assert len(f45) == 7, len(f45)                                 # A B C E F G H (window 11:45-12:45; D parked dropped)
    print("test_truck_traffic (no area): OK")


if __name__ == "__main__":
    print("synthetic rows:", make_data())
    out = T / "out"
    run_notebook(out, area=str(T / "area.geojson"))
    check(out)
    out2 = T / "out_noarea"
    run_notebook(out2)
    check_noarea(out2)
    out3 = T / "out_step10"
    run_notebook(out3, step=10, traj_out=False)
    check_step10(out3)
