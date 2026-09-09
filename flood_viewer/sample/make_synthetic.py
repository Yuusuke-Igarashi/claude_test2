"""Synthetic output files mimicking the notebook's outputs, for viewer testing."""
import json, math, random
import numpy as np, pandas as pd
from pathlib import Path

OUT = Path(__file__).parent / "output"
OUT.mkdir(exist_ok=True)
random.seed(1); np.random.seed(1)

times = [f"{12 + i // 4:02d}:{(i % 4) * 15:02d}" for i in range(48)]
T = len(times)

# grid network around Tokyo: 40 x 30 blocks, each edge as a pair of links (id, id+1)
lon0, lat0 = 139.70, 35.65
dlon, dlat = 0.0025, 0.002
features = []
ids = []
pair = {}
lid = 1
def add_pair(c0, c1):
    global lid
    # offset +/- 1 m roughly (1e-5 deg ~ 1 m)
    dx = c1[0]-c0[0]; dy = c1[1]-c0[1]; L = math.hypot(dx, dy) or 1
    nx, ny = -dy/L*1e-5, dx/L*1e-5
    a, b = lid, lid+1
    features.append({"type":"Feature","properties":{"id":str(a),"pair_id":str(b)},
                     "geometry":{"type":"LineString","coordinates":[[c0[0]+nx,c0[1]+ny],[c1[0]+nx,c1[1]+ny]]}})
    features.append({"type":"Feature","properties":{"id":str(b),"pair_id":str(a)},
                     "geometry":{"type":"LineString","coordinates":[[c0[0]-nx,c0[1]-ny],[c1[0]-nx,c1[1]-ny]]}})
    ids.extend([str(a), str(b)])
    lid += 2

for i in range(40):
    for j in range(30):
        p = (lon0 + i*dlon, lat0 + j*dlat)
        if i < 39: add_pair(p, (p[0]+dlon, p[1]))
        if j < 29: add_pair(p, (p[0], p[1]+dlat))
# a few unpaired links
for k in range(20):
    p = (lon0 + random.random()*40*dlon, lat0 + random.random()*30*dlat)
    features.append({"type":"Feature","properties":{"id":str(lid),"pair_id":None},
                     "geometry":{"type":"LineString","coordinates":[[p[0],p[1]],[p[0]+dlon*0.7,p[1]+dlat*0.4]]}})
    ids.append(str(lid)); lid += 1
# a link in network but not in CSV
features.append({"type":"Feature","properties":{"id":"999999","pair_id":None},
                 "geometry":{"type":"LineString","coordinates":[[lon0-0.002,lat0-0.002],[lon0-0.001,lat0-0.001]]}})

with open(OUT/"tokyo_20240821_network.geojson","w") as f:
    json.dump({"type":"FeatureCollection","features":features}, f)

N = len(ids)
diurnal = 1 + 0.4*np.sin(np.linspace(0, math.pi, T))
bs = np.random.uniform(10, 60, N)[:,None] * np.ones((1,T)) * (1 + 0.05*np.random.randn(N,T))
bc = np.random.uniform(0.5, 60, N)[:,None] * diurnal[None,:] * (1 + 0.1*np.random.randn(N,T))
es = bs * (1 + 0.1*np.random.randn(N,T))
ec = bc * (1 + 0.2*np.random.randn(N,T))
# flood event: block of links near center drop from 17:00 (index 20) to 20:00 (index 32)
center = np.array([lon0+20*dlon, lat0+15*dlat])
for r, ft in enumerate(features[:N]):
    c = np.array(ft["geometry"]["coordinates"][0])
    d = np.hypot(*(c-center))
    if d < 0.02:
        es[r, 20:32] *= 0.3; ec[r, 20:32] *= 0.05
# missing data rows
for r in random.sample(range(N), 30):
    bs[r,:] = np.nan; bc[r,:] = np.nan; es[r,:] = np.nan; ec[r,:] = np.nan
ec = np.where(np.isnan(ec), np.nan, np.maximum(ec, 0))

# ---- error.csv with the notebook's logic (independent reference for the viewer's in-page computation) ----
MIN_BASE_COUNT, MIN_BASE_SPEED, SPEED_RATIO_LIMIT, COUNT_RATIO_LIMIT, ZERO = 5, 15.0, 0.6, 0.4, 0.01
with np.errstate(invalid="ignore", divide="ignore"):
    speed_ratio = np.where(bs > 0, es / bs, np.nan)
    count_ratio = np.where(bc > 0, ec / bc, np.nan)
is_target = (bc >= MIN_BASE_COUNT) & (bs >= MIN_BASE_SPEED)
error1 = (count_ratio < ZERO) | ((speed_ratio <= SPEED_RATIO_LIMIT) & (count_ratio <= COUNT_RATIO_LIMIT))
valid1 = is_target & error1
row_of = {lid: r for r, lid in enumerate(ids)}
pair_row = np.full(N, -1)
for r, ft in enumerate(features[:N]):
    pid = ft["properties"].get("pair_id")
    if pid is not None and pid in row_of: pair_row[r] = row_of[pid]
error2 = np.zeros_like(valid1)
has_pair = pair_row >= 0
error2[has_pair] = valid1[pair_row[has_pair]]
error3 = np.zeros_like(valid1)
error3[:, 1:] |= valid1[:, :-1]
error3[:, :-1] |= valid1[:, 1:]
err = (valid1 & (error2 | error3)).astype(int)

def save(arr, name, boolean=False):
    df = pd.DataFrame(arr, index=pd.Index(ids, name="id"), columns=times)
    if boolean: df = df.fillna(0).astype(int)
    df.to_csv(OUT/name)

save(bs, "baseline_speed.csv"); save(es, "event_speed.csv")
save(bc, "baseline_count.csv"); save(ec, "event_count.csv")
save(err, "error.csv", boolean=True)
print("links", len(features), "csv rows", N, "error cells", int(err.sum()))
