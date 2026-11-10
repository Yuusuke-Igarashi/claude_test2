"""Synthetic AMeDAS 10-minute rainfall for the sample viewer data (input 7): sample/output/amedas/.

Five stations inside the synthetic network extent, 10-minute precipitation [mm] from 17:00 on the sample's event date to
06:00 the next day (one hour before the time axis starts, so the 1-hour totals of the first slots are complete). A rain band
crosses the area from the west: the central station peaks around 00:00 (the flood window of make_synthetic.py / make_kaden.py).
Written in both layouts the viewer reads (the real files come from the JMA 10-minute tables, timestamps = end of the interval, JST):
  amedas_10min.csv        long: timestamp_jst, interval_start_jst, station_id, station_name_ja, latitude, longitude, precipitation_10min_mm, ...
  amedas_10min_wide.csv   wide: timestamp_jst, <station_id>_mm, ...   (needs amedas_stations.csv for the names and coordinates)
  amedas_stations.csv     station_id, station_name_ja, station_name_en, latitude, longitude, elevation_m
"""
import csv, math
from datetime import datetime, timedelta
from pathlib import Path

OUT = Path(__file__).parent / "output"
AM = OUT / "amedas"; AM.mkdir(exist_ok=True)
times = next(csv.reader(open(OUT / "baseline_count.csv", encoding="utf-8")))[1:]   # "18:00" .. "05:45"
EVENT = "2024-08-21"                                                              # make_synthetic.py's date (network file name)
t0 = datetime.fromisoformat(f"{EVENT}T{times[0]}:00") - timedelta(hours=1)
t_end = datetime.fromisoformat(f"{EVENT}T{times[-1]}:00") + timedelta(minutes=15)
if t_end < t0: t_end += timedelta(days=1)
# id, Japanese name, English name, lat, lon, elevation
STATIONS = [("99001", "中央", "Chuo", 35.6865, 139.7565, 12.0), ("99002", "北西", "Hokusei", 35.703, 139.712, 25.0), ("99003", "北東", "Hokuto", 35.700, 139.790, 18.0),
            ("99004", "南西", "Nansei", 35.657, 139.715, 8.0), ("99005", "南東", "Nanto", 35.660, 139.788, 5.0)]

def rain_mm(st, t):
    """10-minute precipitation of station st at interval end t: a band moving east, centred on 00:00 at the central station."""
    _, _, _, lat, lon, _ = st
    h = (t - datetime.fromisoformat(f"{EVENT}T00:00:00")).total_seconds() / 3600 - 24   # hours from 00:00 of the next day
    band_lon = 139.70 + (h + 3) * 0.02                                                   # the band's longitude: 139.70 at 21:00, 139.80 at 02:00
    dist = (lon - band_lon) / 0.03
    along = 1.0 - abs(lat - 35.68) / 0.08                                                # weaker north and south of the centre
    core = 14.0 * math.exp(-dist * dist) * max(0.3, along)                              # 10-minute peak ~14 mm, 1-hour peak ~75 mm at the centre
    drizzle = 0.5 if -5 <= h <= 4 and (int(h * 6) + int(lon * 1000)) % 3 == 0 else 0.0
    v = core + drizzle
    return round(v * 2) / 2 if v >= 0.25 else 0.0

rows = []
t = t0
while t <= t_end:
    rows.append((t, [rain_mm(s, t) for s in STATIONS]))
    t += timedelta(minutes=10)
iso = lambda d: d.strftime("%Y-%m-%dT%H:%M:%S+09:00")
num = lambda v: str(int(v)) if v == int(v) else str(v)
with open(AM / "amedas_stations.csv", "w", newline="", encoding="utf-8") as f:
    w = csv.writer(f); w.writerow(["station_id", "station_name_ja", "station_name_en", "latitude", "longitude", "elevation_m"])
    for sid, ja, en, lat, lon, el in STATIONS: w.writerow([sid, ja, en, f"{lat:.6f}", f"{lon:.6f}", num(el)])
with open(AM / "amedas_10min_wide.csv", "w", newline="", encoding="utf-8") as f:
    w = csv.writer(f); w.writerow(["timestamp_jst"] + [f"{s[0]}_mm" for s in STATIONS])
    for t, vals in rows: w.writerow([iso(t)] + [num(v) for v in vals])
with open(AM / "amedas_10min.csv", "w", newline="", encoding="utf-8") as f:
    w = csv.writer(f)
    w.writerow(["timestamp_jst", "interval_start_jst", "station_id", "station_name_ja", "latitude", "longitude", "precipitation_10min_mm", "precipitation_raw", "quality_flag", "source_url"])
    for t, vals in rows:
        for (sid, ja, en, lat, lon, el), v in zip(STATIONS, vals):
            w.writerow([iso(t), iso(t - timedelta(minutes=10)), sid, ja, f"{lat:.6f}", f"{lon:.6f}", num(v), "--" if v == 0 else f"{v:.1f}", "no_precipitation" if v == 0 else "normal", ""])
peak = max(((t, s[1], v) for t, vals in rows for s, v in zip(STATIONS, vals)), key=lambda x: x[2])
print(f"wrote {len(STATIONS)} stations x {len(rows)} intervals ({iso(rows[0][0])} .. {iso(rows[-1][0])}) to {AM}; peak {peak[2]} mm/10min at {peak[1]} {peak[0]:%H:%M}")
