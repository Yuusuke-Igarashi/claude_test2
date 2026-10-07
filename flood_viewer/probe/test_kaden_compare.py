"""Synthetic end-to-end test of kaden_compare.ipynb (Sharp appliance counts per postal code).

Postal codes around (139.70, 35.68); 15-min files for 12:00 .. 12:45 on the event day 2025-08-13 and two baseline
days (08-06, 07-30). Expectations: B drops to 5 of 30 in two adjacent windows -> "low" anomaly; C drops in one window
only -> flagged but not an anomaly while REQUIRE_ADJACENT; D (baseline 2) is below MIN_BASE_COUNT; E lies outside the
bbox; F has no event rows at all -> 0 -> anomaly in every window; G is not in the postal table; H quadruples -> "high".
"""
import json, os, re, sys, tempfile
from pathlib import Path
import numpy as np
import pandas as pd

HERE = Path(__file__).parent
LON0, LAT0 = 139.70, 35.68
BBOX = (139.65, 35.65, 139.75, 35.71)
ZIP = {"A": "1000001", "B": "1000002", "C": "1000003", "D": "1000004", "E": "1000005", "F": "1000006", "G": "9999999", "H": "1000007"}
POS = {"A": (LON0, LAT0), "B": (LON0 + 0.01, LAT0), "C": (LON0 + 0.02, LAT0), "D": (LON0 + 0.03, LAT0), "E": (LON0 + 1.0, LAT0),
       "F": (LON0, LAT0 + 0.01), "H": (LON0 + 0.01, LAT0 + 0.01)}
WINDOWS = ["1200", "1215", "1230", "1245"]


def postal_rows():
    rows = []
    for k, (lon, lat) in POS.items():
        z = ZIP[k]; rows.append(["JP", f"{z[:3]}-{z[3:]}", f"Place{k}", "Tokyo To", "13", f"City{k}", "13101", "", "", f"{lat}", f"{lon}", "6"])
    rows.append(["JP", "100-0001", "PlaceA2", "Tokyo To", "13", "CityA", "13101", "", "", f"{LAT0}", f"{LON0}", "6"])   # duplicate code, same coords
    rows.append(["JP", "100-0008", "NoCoords", "Tokyo To", "13", "CityX", "13101", "", "", "", "", ""])                 # no coordinates -> dropped
    return rows


def counts(day, hhmm):
    """rows (zip, echonet_object, count) of one file."""
    ev = day in ("20250813", "20250814")
    rows = [("A", "013001", 12), ("A", "03B701", 8), ("D", "013001", 2), ("G", "013001", 9), ("E", "013001", 50)]
    rows.append(("B", "013001", 5 if ev and hhmm in ("1215", "1230") else 30))
    if not (ev and hhmm == "1215"):
        rows.append(("C", "013001", 30))
    if not ev:
        rows.append(("F", "013001", 10 if day == "20250806" else 14))                     # baseline mean 12, no event rows
    rows.append(("H", "013001", 40 if ev else 10))
    return rows


def make_data(root):
    for day in ("20250813", "20250814", "20250806", "20250730"):
        d = root / day; d.mkdir()
        (d / "README.txt").write_text("not a data file")
        for hhmm in WINDOWS:
            lines = ["acquisition_time,zip_code,city_code,maker_code,echonet_object,count,request_code,disaster_judgment"]
            for k, obj, c in counts(day, hhmm):
                lines.append(f"{day[:4]}-{day[4:6]}-{day[6:]} {hhmm[:2]}:{hhmm[2:]}:07.268000+09:00,{ZIP[k]},13101,000005,{obj},{c},,")
            (d / f"{day}{hhmm}_15M_MX_99999_ZENKOKU.csv").write_text("\n".join(lines) + "\n")
    with open(root / "JP.txt", "w", encoding="utf-8") as f:
        for r in postal_rows():
            f.write("\t".join(r) + "\n")


def run_nb(root, out, require_adjacent=True, echonet=None, two_days=False):
    nb = json.load(open(HERE / "kaden_compare.ipynb", encoding="utf-8"))
    g = {"display": lambda x: print(x.to_string() if hasattr(x, "to_string") else x)}
    for i, c in enumerate(cc for cc in nb["cells"] if cc["cell_type"] == "code"):
        src = "".join(c["source"])
        if i == 0:
            src = (src.replace('[Path("../data/Sharp_Kaden/20250813"), Path("../data/Sharp_Kaden/20250814")]', f'[Path("{root / "20250813"}")' + (f', Path("{root / "20250814"}")]' if two_days else ']'))
                      .replace('[Path("../data/Sharp_Kaden/20250812")]', f'[Path("{root / "20250806"}"), Path("{root / "20250730"}")]')
                      .replace('Path("../data/postal/JP.txt")', f'Path("{root / "JP.txt"}")')
                      .replace('Path("./kaden_out/20250813")', f'Path("{out}")')
                      .replace('AREA_GEOJSON = "tokyo.geojson"', 'AREA_GEOJSON = None')
                      .replace("BBOX = None ", f"BBOX = {BBOX} ")
                      .replace("REQUIRE_ADJACENT = True ", f"REQUIRE_ADJACENT = {require_adjacent} ")
                      .replace("ECHONET_OBJECTS = None ", f"ECHONET_OBJECTS = {echonet} "))
            assert src.count(str(root)) == (6 if two_days else 5) and f"BBOX = {BBOX} " in src and f"REQUIRE_ADJACENT = {require_adjacent} " in src and f"ECHONET_OBJECTS = {echonet} " in src
        exec(compile(src, f"kaden{i}", "exec"), g)
    return g


def test_kaden():
    with tempfile.TemporaryDirectory() as d:
        root = Path(d); make_data(root)
        out = root / "out"
        g = run_nb(root, out)
        postal, err = g["postal"], g["err"]
        assert sorted(postal.zip) == sorted(ZIP[k] for k in "ABCDFH"), postal.zip.tolist()          # E outside, 100-0008 without coords
        assert postal.set_index("zip").loc[ZIP["A"], "place"] == "PlaceA" and g["unmatched"] == {ZIP["G"]}
        assert len(err) == 4 * 6 and set(err.columns) >= {"window", "zip", "city", "lat", "lon", "baseline", "event", "ratio", "is_target", "kind", "anomaly"}
        e = err.set_index(["zip", err.window.dt.strftime("%H%M")])
        b = e.loc[ZIP["B"]]
        assert b.loc["1215", "baseline"] == 30 and b.loc["1215", "event"] == 5 and abs(b.loc["1215", "ratio"] - 1 / 6) < 1e-9
        assert b.loc["1215", "kind"] == "low" and b.loc["1230", "anomaly"] and not b.loc["1200", "anomaly"] and b.loc["1200", "ratio"] == 1.0
        c = e.loc[ZIP["C"]]
        assert c.loc["1215", "event"] == 0 and c.loc["1215", "low"] and not c.loc["1215", "anomaly"], "single window: flagged, not an anomaly"
        dd = e.loc[ZIP["D"]]; assert (~dd.is_target).all() and dd.ratio.isna().all()
        f = e.loc[ZIP["F"]]; assert (f.baseline == 12).all() and (f.event == 0).all() and (f.kind == "low").all() and f.anomaly.all()   # (10 + 14) / 2
        h = e.loc[ZIP["H"]]; assert (h.ratio == 4.0).all() and (h.kind == "high").all() and h.anomaly.all()
        a = e.loc[ZIP["A"]]; assert (a.baseline == 20).all() and (a.event == 20).all() and (a.ratio == 1.0).all() and a.city.iloc[0] == "CityA"
        # time series tables (row = zip, column = window) and the per-zip summary
        tse = pd.read_csv(out / "kaden_event_ts.csv", dtype={"zip": str}).set_index("zip")
        tsb = pd.read_csv(out / "kaden_baseline_ts.csv", dtype={"zip": str}).set_index("zip")
        tsr = pd.read_csv(out / "kaden_ratio_ts.csv", dtype={"zip": str}).set_index("zip")
        assert list(tse.columns) == ["city", "place", "lat", "lon", "12:00", "12:15", "12:30", "12:45"] and len(tse) == 6, tse.columns
        assert tse.loc[ZIP["B"], ["12:00", "12:15", "12:30", "12:45"]].tolist() == [30, 5, 5, 30] and (tsb.loc[ZIP["B"], ["12:00", "12:15"]] == 30).all()
        assert abs(tsr.loc[ZIP["B"], "12:15"] - 1 / 6) < 1e-3 and tsr.loc[ZIP["D"]].iloc[4:].isna().all() and tse.loc[ZIP["F"]].iloc[4:].eq(0).all()
        zs = pd.read_csv(out / "kaden_zips.csv", dtype={"zip": str}).set_index("zip")
        assert zs.loc[ZIP["F"], "n_low"] == 4 and zs.loc[ZIP["F"], "first_low"] == "2025-08-13T12:00:00" and zs.loc[ZIP["F"], "last_low"] == "2025-08-13T12:45:00"
        assert zs.loc[ZIP["B"], "n_low"] == 2 and abs(zs.loc[ZIP["B"], "ratio_min"] - 1 / 6) < 1e-3 and zs.loc[ZIP["H"], "n_high"] == 4 and zs.loc[ZIP["D"], "n_target"] == 0
        zg = json.load(open(out / "kaden_zips.geojson", encoding="utf-8"))
        assert len(zg["features"]) == 6 and next(f for f in zg["features"] if f["properties"]["zip"] == "100-0006")["properties"]["n_low"] == 4
        # anomaly GeoJSON per window
        files = sorted(os.listdir(out / "anomaly"))
        assert files == [f"kaden_anomaly_20250813_{w}.geojson" for w in WINDOWS], files
        gj = json.load(open(out / "anomaly" / "kaden_anomaly_20250813_1215.geojson", encoding="utf-8"))
        zips = {ft["properties"]["zip"]: ft for ft in gj["features"]}
        assert set(zips) == {"100-0002", "100-0006", "100-0007"}, set(zips)
        fb = zips["100-0002"]
        assert fb["properties"]["kind"] == "low" and fb["properties"]["city"] == "CityB" and fb["properties"]["timestamp"] == "2025-08-13T12:15:00"
        assert fb["geometry"] == {"type": "Point", "coordinates": [round(LON0 + 0.01, 6), LAT0]} and gj["properties"]["require_adjacent"] is True
        gj0 = json.load(open(out / "anomaly" / "kaden_anomaly_20250813_1200.geojson", encoding="utf-8"))
        assert {ft["properties"]["zip"] for ft in gj0["features"]} == {"100-0006", "100-0007"}
        assert (out / "kaden_15min.csv").exists() and len(pd.read_csv(out / "kaden_15min.csv", dtype={"zip": str})) == 24
        # rasters
        G = out / "grid_kaden"
        idx = json.load(open(G / "index.json", encoding="utf-8"))
        assert idx["slots"] == ["12:00", "12:15", "12:30", "12:45"] and idx["params"] == ["kaden"] and len(idx["files"]) == 12 and idx["cell_m"] == 250.0
        assert idx["days"] == {"baseline": 2, "event": 1} and idx["bounds"][0] == BBOX[0] and idx["bounds"][3] == BBOX[3]
        mesh = g["mesh"]; n = idx["width"] * idx["height"]
        def raster(name):
            return np.frombuffer(open(G / name, "rb").read()[-4 * n:], dtype="<f4")
        cB, cA, cD = (int(mesh.cell(*POS[k])) for k in "BAD")
        assert raster("kaden_event_1215.tif")[cB] == 5 and raster("kaden_baseline_1215.tif")[cB] == 30 and abs(raster("kaden_1215.tif")[cB] - 1 / 6) < 1e-6
        assert raster("kaden_event_1215.tif")[cA] == 20 and raster("kaden_1215.tif")[cA] == 1.0, "A's two appliance classes are summed"
        assert raster("kaden_baseline_1215.tif")[cD] == 2 and np.isnan(raster("kaden_1215.tif")[cD]), "below MIN_BASE_COUNT: no ratio"
        assert open(G / "kaden_event_1215.tif", "rb").read(4) == b"II*\x00"
        # without the adjacency rule C's single window counts; air conditioners only: A keeps 12 of 20
        g2 = run_nb(root, root / "out2", require_adjacent=False)
        e2 = g2["err"].set_index(["zip", g2["err"].window.dt.strftime("%H%M")])
        assert e2.loc[(ZIP["C"], "1215"), "anomaly"] and e2.loc[(ZIP["C"], "1215"), "kind"] == "low"
        g3 = run_nb(root, root / "out3", echonet=["0130"])
        e3 = g3["err"].set_index(["zip", g3["err"].window.dt.strftime("%H%M")])
        assert e3.loc[(ZIP["A"], "1200"), "baseline"] == 12 and e3.loc[(ZIP["A"], "1200"), "event"] == 12
        # two event days in one run: one time series, anomaly files for both days, one grid folder per day
        g4 = run_nb(root, root / "out4", two_days=True)
        o4 = root / "out4"
        tse = pd.read_csv(o4 / "kaden_event_ts.csv", dtype={"zip": str}).set_index("zip")
        assert list(tse.columns)[4:] == [f"08-{d} {w[:2]}:{w[2:]}" for d in ("13", "14") for w in WINDOWS], tse.columns
        assert tse.loc[ZIP["B"]].iloc[4:].tolist() == [30, 5, 5, 30, 30, 5, 5, 30]
        assert sorted(os.listdir(o4 / "anomaly")) == [f"kaden_anomaly_202508{d}_{w}.geojson" for d in ("13", "14") for w in WINDOWS]
        assert len(g4["err"]) == 8 * 6 and not (o4 / "grid_kaden").exists()
        for d in ("13", "14"):
            idx = json.load(open(o4 / f"grid_kaden_202508{d}" / "index.json", encoding="utf-8"))
            assert idx["params"] == [f"kaden08{d}"] and idx["slots"] == ["12:00", "12:15", "12:30", "12:45"] and idx["event_date"] == f"2025-08-{d}", idx["params"]
            assert f"kaden08{d}_event_1215.tif" in idx["files"] and (o4 / f"grid_kaden_202508{d}" / f"kaden08{d}_1215.tif").exists()
    print("ok: kaden_compare.ipynb")


if __name__ == "__main__":
    test_kaden()
