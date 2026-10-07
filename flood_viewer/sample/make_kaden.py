"""Synthetic Sharp appliance time series for the viewer (input 7): sample/output/kaden/kaden_event_ts.csv etc.

Postal-code points on a jittered grid inside the sample bbox; baseline counts with a mild diurnal curve. Six points
around the flood centre lose 90 % of their connections 23:00-01:30 (outage), two points triple 20:00-21:00, three
points have a baseline below 5. Time columns follow sample/output/baseline_count.csv (18:00 .. 02:00)."""
import csv, math, random
from pathlib import Path

OUT = Path(__file__).parent / "output"
times = next(csv.reader(open(OUT / "baseline_count.csv", encoding="utf-8")))[1:]
rng = random.Random(7)
pts = []
k = 0
for r in range(5):
    for c in range(8):
        lon = 139.705 + c * 0.0125 + rng.uniform(-0.003, 0.003); lat = 35.655 + r * 0.0125 + rng.uniform(-0.002, 0.002)
        pts.append({"zip": f"150{k:04d}", "city": "Shibuya Ku", "place": f"Sample{k}", "lat": round(lat, 5), "lon": round(lon, 5),
                    "base": rng.choice([3, 4, 8, 15, 25, 40, 60, 90, 120]) if k % 13 else 3})
        k += 1
centre = (139.75, 35.68)
near = sorted(pts, key=lambda p: (p["lon"] - centre[0]) ** 2 + (p["lat"] - centre[1]) ** 2)[:6]
for p in near: p["base"] = max(p["base"], 20)                          # outage points must be above MIN_BASE_COUNT
up = [p for p in pts if p not in near and p["base"] >= 15][:2]
def minutes(t): h, m = map(int, t.split(":")); return h * 60 + m
def diurnal(t):                                                        # 1.0 in the evening, 0.8 after midnight
    m = minutes(t); return 1.0 if m >= 18 * 60 else 0.8
rows_b, rows_e = [], []
for p in pts:
    b, e = [], []
    for t in times:
        base = round(p["base"] * diurnal(t) * rng.uniform(0.95, 1.05), 1)
        ev = base * rng.uniform(0.95, 1.05)
        m = minutes(t)
        if p in near and (m >= 23 * 60 or m < 90): ev = base * 0.1
        if p in up and 20 * 60 <= m < 21 * 60: ev = base * 3.5
        b.append(base); e.append(round(ev, 1))
    head = [p["zip"], p["city"], p["place"], p["lat"], p["lon"]]
    rows_b.append(head + b); rows_e.append(head + e)
(OUT / "kaden").mkdir(exist_ok=True)
hdr = ["zip", "city", "place", "lat", "lon"] + times
for name, rows in (("kaden_baseline_ts.csv", rows_b), ("kaden_event_ts.csv", rows_e)):
    with open(OUT / "kaden" / name, "w", newline="", encoding="utf-8") as f:
        w = csv.writer(f); w.writerow(hdr); w.writerows(rows)
with open(OUT / "kaden" / "kaden_ratio_ts.csv", "w", newline="", encoding="utf-8") as f:
    w = csv.writer(f); w.writerow(hdr)
    for rb, re_ in zip(rows_b, rows_e):
        w.writerow(rb[:5] + [round(e / b, 4) if b >= 5 else "" for b, e in zip(rb[5:], re_[5:])])
print(f"wrote {len(pts)} postal codes x {len(times)} slots to {OUT / 'kaden'} (outage at {[p['zip'] for p in near]}, surge at {[p['zip'] for p in up]})")
