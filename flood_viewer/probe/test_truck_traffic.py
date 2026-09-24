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


def run_notebook(out_dir, area=None):
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
        print(f"\n---------------- cell {i} ----------------")
        exec(compile(src, f"cell{i}", "exec"), g)
    return g


def hits(out_dir):
    w = pd.read_csv(Path(out_dir) / "traffic_15min.csv", parse_dates=["window"]).set_index(["window", "Id"])
    return w, {(f"{k[0]:%H:%M}", int(k[1])): int(v) for k, v in w.Hits.items()}


def check(out_dir):
    O = Path(out_dir)
    links = pd.read_csv(O / "network_agg.csv").set_index("Id")
    assert len(links) == 10 and links.loc[1, "member_ids"] == "1;2;3" and links.loc[4, "n_members"] == 2, links
    assert "NewSegId" in links.columns and "Segment Id" in links.columns
    w, got = hits(O)
    expect = {("12:00", 1): 3, ("12:00", 4): 1, ("12:00", 6): 1, ("12:15", 1): 2, ("12:15", 6): 1, ("12:30", 9): 1,
              ("12:45", 1): 1, ("12:45", 7): 1, ("12:45", 13): 1, ("13:30", 1): 1, ("13:30", 6): 1}
    assert got == expect, (got, expect)                      # exactly these window x link rows, with these vehicle counts
    c = w.loc[(pd.Timestamp("2025-09-10 12:00"), 1)]
    assert abs(c.AvgSp - (50 + 70 + 55) / 3) < 1.5 and c.n_points == 58 + 42 + 30, c.to_dict()   # A 58 s (50 km/h), C 42 s (70 km/h), E 30 s before 12:15
    v = w.loc[(pd.Timestamp("2025-09-10 12:45"), 7)]
    assert v.Hits == 1 and v.n_points == 0 and np.isnan(v.AvgSp), v.to_dict()                    # link 7: passed by I, no point -> no speed
    s = pd.read_csv(O / "summary.csv"); r12 = s[s.file.str.endswith("_12.csv")].iloc[0]
    assert r12.dropped == 1 and r12.vehicles == 9 and r12.no_candidate_points > 0 and r12.short_points == 0, r12.to_dict()
    assert r12.segments == 10 and r12.assigned_rows == 12 and r12.via_rows == 1, r12.to_dict()   # A2 B1 C1 E2 F2 H1 I3; D has segments but is parked
    assert s[s.file.str.endswith("README.txt")].error.str.contains("ValueError").all()
    g = pd.read_csv(O / "groups.csv")
    assert "status" not in g.columns and {"window", "vid", "link", "n_points", "v_mean", "via", "Id", "file"} <= set(g.columns), g.columns
    st = {(r.vid, int(r.Id)): bool(r.via) for r in g[g.file.str.endswith("_12.csv")].itertuples()}
    assert st[("C", 1)] is False and ("C", 4) not in st and ("D", 1) not in st and ("G", 9) not in st, st
    assert st[("H", 9)] is False and st[("I", 7)] is True and st[("I", 1)] is False and st[("I", 13)] is False, st
    files = sorted(p.name for p in O.glob("traffic_2025*.csv"))
    assert files == ["traffic_20250910_1200.csv", "traffic_20250910_1215.csv", "traffic_20250910_1230.csv",
                     "traffic_20250910_1245.csv", "traffic_20250910_1330.csv"], files
    one = pd.read_csv(O / files[0]); assert list(one.columns) == ["Id", "Hits", "AvgSp", "MedSp", "n_points"]
    # trajectories: window ends 12:15 .. 13:00 from file 12 (last point 12:51:45), 13:45 from file 13
    tf = sorted(p.name for p in (O / "traj").glob("traj_*.geojson"))
    assert tf == ["traj_20250910_1215.geojson", "traj_20250910_1230.geojson", "traj_20250910_1245.geojson",
                  "traj_20250910_1300.geojson", "traj_20250910_1345.geojson"], tf
    f15 = json.load(open(O / "traj" / "traj_20250910_1215.geojson"))["features"]
    assert len(f15) == 4, [f["properties"] for f in f15]          # A, B, C, E (D is parked -> too short, F/G/H/I later)
    assert all(set(f["properties"]) == {"time", "date", "n_points", "v_mean", "v_max"} and f["properties"]["time"] == "12:15" for f in f15)
    assert "serial" not in open(O / "traj" / "traj_20250910_1215.geojson").read() and not any("A" == k for f in f15 for k in f["properties"].values())
    f45 = json.load(open(O / "traj" / "traj_20250910_1245.geojson"))["features"]
    assert len(f45) == 7, len(f45)                                 # A B C E F G H (window 11:45-12:45; D parked dropped)
    f1300 = json.load(open(O / "traj" / "traj_20250910_1300.geojson"))["features"]
    assert len(f1300) == 8, len(f1300)                             # + I
    f1345 = json.load(open(O / "traj" / "traj_20250910_1345.geojson"))["features"]   # window 12:45-13:45: A (13:40, file 13) and I (12:50, carried over from file 12)
    assert sorted(f["properties"]["n_points"] for f in f1345) == [16, 106], [f["properties"] for f in f1345]
    a = next(f for f in f1345 if f["properties"]["n_points"] == 106)
    assert a["geometry"]["type"] == "LineString" and len(a["geometry"]["coordinates"]) < 20, "simplified (a straight 1.4 km track needs only a few vertices)"
    idx = json.load(open(O / "traj" / "index.json")); assert idx["window_min"] == 60 and len(idx["files"]) == 5
    print("\ntest_truck_traffic: OK")


def check_area(out_dir):
    """AREA_GEOJSON: only points inside the polygon and links near its bbox are used."""
    O = Path(out_dir)
    links = pd.read_csv(O / "network_agg.csv")
    assert 8 not in links.Id.tolist() and 1 in links.Id.tolist(), links.Id.tolist()      # the far link (3 km south) is outside the bbox + 1 km
    s = pd.read_csv(O / "summary.csv"); r12 = s[s.file.str.endswith("_12.csv")].iloc[0]
    assert r12.outside_area > 0 and r12.no_candidate_points == 0 and r12.vehicles == 7, r12.to_dict()   # G and H are outside the area
    w, got = hits(O)
    assert got[("12:00", 1)] == 3 and ("12:30", 9) not in got and got[("12:45", 7)] == 1, got     # A, C, E; no H; I still passes 7
    f15 = json.load(open(O / "traj" / "traj_20250910_1215.geojson"))["features"]
    assert len(f15) == 4, len(f15)                                  # A, B, C, E (D parked; G, H outside the area)
    f45 = json.load(open(O / "traj" / "traj_20250910_1245.geojson"))["features"]
    assert len(f45) == 5, len(f45)                                  # A B C E F (G, H gone)
    tf = sorted(p.name for p in (O / "traj").glob("traj_*.geojson"))
    assert len(tf) == 5 and tf[-1] == "traj_20250910_1345.geojson", tf
    print("test_truck_traffic (area): OK")


if __name__ == "__main__":
    print("synthetic rows:", make_data())
    out = T / "out"
    run_notebook(out)
    check(out)
    out2 = T / "out_area"
    run_notebook(out2, area=str(T / "area.geojson"))
    check_area(out2)
