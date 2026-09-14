#!/usr/bin/env python3
"""Convert XRAIN 250 m-mesh 1-minute CSVs into 15-minute rain images for flood_viewer.

Input : CX<mesh1><YYYYMMDDhhmm>.csv  (e.g. CX5239202608130200.csv)
        mesh1 = 4-digit 1st-order mesh code, time = minute of the observation (JST).
        Each file is a 320 x 320 grid of rain intensity [mm/h] without header:
        320 columns x 320 rows = the 1st mesh (1 deg lon x 2/3 deg lat) cut into 250 m quarter meshes.
        ROW_ORDER says whether the first CSV row is the north edge ("north_to_south", default)
        or the south edge ("south_to_north"); check one file against a known rain map if unsure.
Output: <out>/rain/rain_<YYYYMMDD>_<HHMM>.png + <out>/rain/index.json
        One PNG per 15-minute slot ending at HHMM, covering all input meshes as one mosaic
        (missing meshes / missing minutes are transparent). The PNG carries values, not colours:
        R = high byte, G = low byte of round(mean intensity [mm/h] * 10), A = 255 where data exists.
        The viewer colours it on the fly, shows the value under the cursor, and the same numbers
        give the 15-minute rainfall [mm] as intensity / 4.
        index.json: bounds [W, S, E, N], grid size, cell size, slot list per date, scale.

Usage:
  python3 xrain_tiles.py <csv folder or zip(s)> --out probe_out/chiba [--slot-min 15] [--row-order north_to_south]
  or from a notebook: import xrain_tiles; xrain_tiles.run(["xrain/"], "probe_out/chiba")

Only numpy is required (PNG files are written with zlib).
"""
from __future__ import annotations

import argparse
import io
import json
import re
import struct
import sys
import time
import zipfile
import zlib
from collections import defaultdict
from pathlib import Path

import numpy as np

N_CELL = 320                       # quarter (250 m) meshes per 1st mesh, both axes
MESH_W = 1.0                       # 1st mesh width  [deg lon]
MESH_H = 2.0 / 3.0                 # 1st mesh height [deg lat]
NAME_RE = re.compile(r"CX(\d{4})(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})\.csv$", re.I)


def mesh1_origin(code: str):
    """South-west corner (lon, lat) of a 1st-order mesh code ABCD: lat = AB / 1.5, lon = 100 + CD."""
    ab, cd = int(code[:2]), int(code[2:])
    return 100.0 + cd, ab / 1.5


def parse_name(name: str):
    m = NAME_RE.search(name)
    if not m:
        return None
    mesh, y, mo, d, h, mi = m.groups()
    return mesh, f"{y}{mo}{d}", int(h) * 60 + int(mi)      # mesh, date, minute of day


def read_grid(data: bytes, row_order: str) -> np.ndarray:
    g = np.loadtxt(io.BytesIO(data), delimiter=",", dtype=np.float32, ndmin=2)
    if g.shape[1] == N_CELL + 1 and np.isnan(g[:, -1]).all():   # trailing comma
        g = g[:, :-1]
    if g.shape != (N_CELL, N_CELL):
        raise ValueError(f"grid is {g.shape}, expected {(N_CELL, N_CELL)}")
    if row_order == "south_to_north":
        g = g[::-1]
    return g


def write_png(path: Path, rgba: np.ndarray):
    """Minimal RGBA PNG writer (8 bit per channel)."""
    h, w, _ = rgba.shape
    raw = b"".join(b"\x00" + rgba[y].tobytes() for y in range(h))
    def chunk(tag, body):
        return struct.pack(">I", len(body)) + tag + body + struct.pack(">I", zlib.crc32(tag + body) & 0xFFFFFFFF)
    png = b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 6, 0, 0, 0))
    png += chunk(b"IDAT", zlib.compress(raw, 9)) + chunk(b"IEND", b"")
    path.write_bytes(png)


def encode_values(mean: np.ndarray, count: np.ndarray) -> np.ndarray:
    """mm/h -> RGBA: R,G = round(v*10) big-endian, A = 255 where at least one minute was observed."""
    v10 = np.clip(np.round(np.nan_to_num(mean, nan=0.0) * 10.0), 0, 65535).astype(np.uint16)
    rgba = np.zeros(mean.shape + (4,), dtype=np.uint8)
    rgba[..., 0] = v10 >> 8
    rgba[..., 1] = v10 & 0xFF
    rgba[..., 3] = np.where(count > 0, 255, 0).astype(np.uint8)
    return rgba


def iter_sources(inputs):
    """Yield (name, bytes) for every CX*.csv found in folders (recursively) and zip files."""
    for src in inputs:
        src = Path(src)
        if src.is_dir():
            for p in sorted(src.rglob("*.csv")):
                if NAME_RE.search(p.name):
                    yield p.name, p.read_bytes()
        elif src.suffix.lower() == ".zip":
            with zipfile.ZipFile(src) as z:
                for n in sorted(z.namelist()):
                    if NAME_RE.search(Path(n).name):
                        yield Path(n).name, z.read(n)
        elif NAME_RE.search(src.name):
            yield src.name, src.read_bytes()


def log(msg):
    print(f"[{time.strftime('%H:%M:%S')}] {msg}", flush=True)


def run(inputs, out, slot_min: int = 15, row_order: str = "north_to_south"):
    out = Path(out) / "rain"
    out.mkdir(parents=True, exist_ok=True)
    t0 = time.perf_counter()
    # ---- pass 1: list files, find meshes and slots ----
    entries = []                                     # (date, slot_end_minute, mesh, name, bytes)
    for name, data in iter_sources(inputs):
        mesh, date, minute = parse_name(name)
        # a file at minute m belongs to the slot ending at the next multiple of slot_min (window (T-slot, T])
        slot_end = ((minute - 1) // slot_min + 1) * slot_min
        entries.append((date, slot_end, mesh, name, data))
    if not entries:
        raise SystemExit("no CX*.csv files found")
    meshes = sorted({e[2] for e in entries})
    origins = {m: mesh1_origin(m) for m in meshes}
    lons = sorted({o[0] for o in origins.values()}); lats = sorted({o[1] for o in origins.values()})
    W, S = lons[0], lats[0]
    E, N = lons[-1] + MESH_W, lats[-1] + MESH_H
    ncol = int(round((E - W) / MESH_W)) * N_CELL
    nrow = int(round((N - S) / MESH_H)) * N_CELL
    log(f"{len(entries):,} files, meshes {meshes}, mosaic {ncol} x {nrow} cells, bounds W{W} S{S:.4f} E{E} N{N:.4f}")
    # ---- pass 2: aggregate per slot ----
    by_slot = defaultdict(list)
    for e in entries:
        by_slot[(e[0], e[1])].append(e)
    index = {"bounds": [W, S, E, N], "width": ncol, "height": nrow, "cell_deg": [MESH_W / N_CELL, MESH_H / N_CELL],
             "slot_min": slot_min, "unit": "mm/h (mean over the slot); value = (R*256+G)/10; A=0 no data",
             "row_order_in_csv": row_order, "meshes": meshes, "dates": {}, "files": {}}
    n_png = 0
    for (date, slot_end) in sorted(by_slot):
        if slot_end > 1440:
            continue                                  # a minute-0 file of the next day would map to 24:00 + ...
        acc = np.zeros((nrow, ncol), dtype=np.float64)
        cnt = np.zeros((nrow, ncol), dtype=np.int32)
        for (_, _, mesh, name, data) in by_slot[(date, slot_end)]:
            try:
                g = read_grid(data, row_order)
            except Exception as ex:                   # noqa: BLE001
                log(f"  skip {name}: {ex}")
                continue
            lon0, lat0 = origins[mesh]
            c0 = int(round((lon0 - W) / MESH_W)) * N_CELL
            r0 = int(round((N - (lat0 + MESH_H)) / MESH_H)) * N_CELL      # row 0 = north edge
            ok = np.isfinite(g) & (g >= 0)
            acc[r0:r0 + N_CELL, c0:c0 + N_CELL] += np.where(ok, g, 0.0)
            cnt[r0:r0 + N_CELL, c0:c0 + N_CELL] += ok
        with np.errstate(invalid="ignore", divide="ignore"):
            mean = np.where(cnt > 0, acc / np.maximum(cnt, 1), np.nan)
        hhmm = f"{slot_end // 60:02d}{slot_end % 60:02d}"
        name = f"rain_{date}_{hhmm}.png"
        write_png(out / name, encode_values(mean, cnt))
        index["dates"].setdefault(date, []).append(f"{hhmm[:2]}:{hhmm[2:]}")
        index["files"][name] = {"minutes": int(cnt.max()), "max_mmh": round(float(np.nanmax(mean)) if cnt.any() else 0.0, 1),
                                "wet_cells": int(np.nansum(mean >= 1.0))}
        n_png += 1
        if n_png % 50 == 0:
            log(f"  {n_png} slots written")
    with open(out / "index.json", "w", encoding="utf-8") as f:
        json.dump(index, f, ensure_ascii=False, indent=1)
    log(f"done: {n_png} slot images in {out} ({time.perf_counter() - t0:.1f} s)")
    for date, slots in index["dates"].items():
        mx = max(index["files"][f"rain_{date}_{s.replace(':', '')}.png"]["max_mmh"] for s in slots)
        print(f"  {date}: {len(slots)} slots {slots[0]}-{slots[-1]}, max intensity {mx} mm/h")
    return index


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("inputs", nargs="+", help="folders (searched recursively), zip files or CX*.csv files")
    ap.add_argument("--out", default="out", help="output folder; images go to <out>/rain/")
    ap.add_argument("--slot-min", type=int, default=15)
    ap.add_argument("--row-order", choices=["north_to_south", "south_to_north"], default="north_to_south")
    a = ap.parse_args()
    run(a.inputs, a.out, a.slot_min, a.row_order)


if __name__ == "__main__":
    main()
