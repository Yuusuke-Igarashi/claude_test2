"""Compare the vehicle counts of two TomTom notebook outputs with different window lengths (e.g. 15 min and 30 min),
or inspect one output on its own.

    python3 tomtom_count_check.py OUT15 OUT30        # two folders: the 30-min counts are compared with 15-min pairs summed
    python3 tomtom_count_check.py OUT                # one folder: baseline vs event totals per hour

Each folder holds the notebook's baseline_count.csv / event_count.csv (and *_speed.csv): rows = link id, columns = "HH:MM".
What to look at:
  * one folder: in ordinary hours the baseline (4-week day average) and the event day should carry similar totals.
    A baseline/event ratio near 0.25 means the baseline Hits were divided by 4 although they were not a 4-day sum (or the
    date range was one day); near 4 means a 4-day sum was not divided.
  * two folders: a 30-min window should hold about the sum of its two 15-min windows (ratio ~1 after pairing).
    Ratio ~0.5 = the 30-min job counts like a 15-min job; ~0.25 = a factor 4 (the baseline division) on top.
Only links present in both folders are compared, and only cells where the finer data exist.
"""
import sys
from pathlib import Path

import numpy as np
import pandas as pd


def read(folder, name):
    p = Path(folder) / name
    if not p.exists():
        sys.exit(f"missing {p}")
    df = pd.read_csv(p, index_col=0, dtype={0: str})
    df.index = df.index.astype(str)
    return df


def minutes(col):
    h, m = col.split(":")
    return int(h) * 60 + int(m)


def step_min(df):
    cols = [minutes(c) for c in df.columns]
    gaps = sorted({(b - a) % 1440 for a, b in zip(cols, cols[1:])} - {0})
    return gaps[0] if gaps else 15


def hourly(df):
    """sum of the columns per clock hour (NaN = no data -> ignored)"""
    out = {}
    for c in df.columns:
        out.setdefault(c[:2], []).append(df[c])
    return pd.DataFrame({h: pd.concat(cs, axis=1).sum(axis=1, min_count=1) for h, cs in out.items()})


def describe_one(folder):
    bc, ec = read(folder, "baseline_count.csv"), read(folder, "event_count.csv")
    bs = read(folder, "baseline_speed.csv")
    step = step_min(bc)
    print(f"[{folder}] links {len(bc):,}  windows {bc.shape[1]} x {step} min  ({bc.columns[0]} .. {bc.columns[-1]})")
    has_b = bc.notna().any(axis=1).sum()
    print(f"  links with baseline data {has_b:,} ({has_b / len(bc):.1%}), with event data {ec.notna().any(axis=1).sum():,}")
    print(f"  baseline count: total {np.nansum(bc.values):,.0f}  per link-window mean {np.nanmean(bc.values):.3f}  "
          f"zero cells {(bc.values == 0).sum() / bc.notna().values.sum():.1%}  speed>=10 and count>=5: {((bc.values >= 5) & (bs.values >= 10)).sum():,} cells")
    print(f"  event    count: total {np.nansum(ec.values):,.0f}  per link-window mean {np.nanmean(ec.values):.3f}")
    hb, he = hourly(bc).sum(), hourly(ec).sum()
    tab = pd.DataFrame({"baseline": hb, "event": he, "baseline/event": hb / he.replace(0, np.nan)}).round(2)
    print("  totals per clock hour (all links):")
    print(tab.T.to_string())
    return bc, ec, step


def pair_fine(df, coarse_cols, fine_step, coarse_step):
    """sum the fine columns that fall inside each coarse window (clock time); NaN where the fine data are missing"""
    k = coarse_step // fine_step
    out = {}
    for c in coarse_cols:
        m0 = minutes(c)
        parts = [f"{((m0 + i * fine_step) // 60) % 24:02d}:{(m0 + i * fine_step) % 60:02d}" for i in range(k)]
        if all(p in df.columns for p in parts):
            out[c] = df[parts].sum(axis=1, min_count=k)
    return pd.DataFrame(out)


def compare(fine_dir, coarse_dir):
    fb, fe, fstep = describe_one(fine_dir)
    cb, ce, cstep = describe_one(coarse_dir)
    if cstep <= fstep or cstep % fstep:
        sys.exit(f"the second folder must have the longer window ({fstep} vs {cstep} min)")
    links = fb.index.intersection(cb.index)
    print(f"\n[compare] common links {len(links):,} (first {len(fb):,}, second {len(cb):,}); {cstep} min = {cstep // fstep} x {fstep} min")
    for label, fine, coarse in [("baseline", fb, cb), ("event", fe, ce)]:
        fine_sum = pair_fine(fine.loc[links], coarse.columns, fstep, cstep)
        coarse = coarse.loc[links, fine_sum.columns]
        both = fine_sum.notna() & coarse.notna()
        fs, cs = fine_sum.where(both), coarse.where(both)
        ratio = np.nansum(cs.values) / np.nansum(fs.values) if np.nansum(fs.values) else np.nan
        cell = (cs / fs.replace(0, np.nan)).stack()
        print(f"  {label}: total {cstep}-min {np.nansum(cs.values):,.0f} vs summed {fstep}-min {np.nansum(fs.values):,.0f} -> ratio {ratio:.3f}; "
              f"per-cell median {cell.median():.3f} (IQR {cell.quantile(.25):.2f}-{cell.quantile(.75):.2f}, {len(cell):,} cells)")
        hr = pd.DataFrame({"fine_sum": hourly(fs).sum(), "coarse": hourly(cs).sum()})
        hr["ratio"] = (hr["coarse"] / hr["fine_sum"].replace(0, np.nan)).round(3)
        print("  per clock hour:"); print(hr.T.round(0).to_string())
    print("\nreading: ratio ~1 = consistent; ~0.5 = the longer window is counted like the shorter one; ~0.25 = plus a division by 4")


if __name__ == "__main__":
    if len(sys.argv) == 2:
        describe_one(sys.argv[1])
    elif len(sys.argv) == 3:
        compare(sys.argv[1], sys.argv[2])
    else:
        sys.exit(__doc__)
