#!/usr/bin/env python3
"""XRAIN 250 m-mesh 1-minute CSVs -> one GeoTIFF per 15-minute slot (for flood_viewer).

Input : CX<mesh1><YYYYMMDDhhmm>.csv, e.g. CX5239202608130200.csv
        mesh1 = 1st-order mesh code (1 deg lon x 2/3 deg lat), time = the minute (JST).
        320 x 320 values [mm/h], no header, first row = north edge (ROW_ORDER to flip).
Output: <out>/rain/rain_<YYYYMMDD>_<HHMM>.tif   float32, EPSG:4326, nodata -1,
                                                mean intensity [mm/h] over the 15 minutes
                                                ending at HHMM (window (T-15, T]);
                                                --unit mm gives the 15-minute rainfall instead
        <out>/rain/index.json                   the file list (the viewer over http needs it)

Steps (run()):
  1. grid definition   : all 1st meshes named in the input -> one lon/lat grid, 1/320 deg x 1/480 deg cells
  2. read one slot     : the files of 15 consecutive minutes (all meshes)
  3. aggregate + write : mean of the minutes per cell (cells never observed = nodata) -> GeoTIFF
  4. reset the grid and continue with the next slot

Only numpy is needed; the GeoTIFF is written directly (uncompressed, one strip per row).
Usage: python3 xrain_to_geotiff.py <folder or zip> --out probe_out/chiba
"""
from __future__ import annotations

import argparse
import datetime as dt
import io
import json
import re
import struct
import time
import zipfile
from pathlib import Path

import numpy as np

N_CELL = 320                                   # 250 m cells per 1st mesh, both axes
MESH_W, MESH_H = 1.0, 2.0 / 3.0                # 1st mesh size [deg]
NODATA = -1.0
NAME_RE = re.compile(r"CX(\d{4})(\d{8})(\d{2})(\d{2})\.csv$", re.I)


# ---------------------------------------------------------------------------------------------
# 1. grid definition
# ---------------------------------------------------------------------------------------------
def mesh_origin(code: str):
    """South-west corner (lon, lat) of 1st mesh ABCD: lat = AB / 1.5, lon = 100 + CD."""
    return 100.0 + int(code[2:]), int(code[:2]) / 1.5


class Grid:
    """One lon/lat raster covering every 1st mesh in `meshes`; row 0 is the north edge."""
    def __init__(self, meshes):
        origins = {m: mesh_origin(m) for m in meshes}
        self.west = min(o[0] for o in origins.values())
        self.south = min(o[1] for o in origins.values())
        self.east = max(o[0] for o in origins.values()) + MESH_W
        self.north = max(o[1] for o in origins.values()) + MESH_H
        self.ncol = int(round((self.east - self.west) / MESH_W)) * N_CELL
        self.nrow = int(round((self.north - self.south) / MESH_H)) * N_CELL
        self.dx, self.dy = MESH_W / N_CELL, MESH_H / N_CELL
        # (row0, col0) of each mesh inside the raster
        self.pos = {m: (int(round((self.north - (o[1] + MESH_H)) / MESH_H)) * N_CELL,
                        int(round((o[0] - self.west) / MESH_W)) * N_CELL) for m, o in origins.items()}
        self.reset()

    def reset(self):                          # 4. a fresh accumulator for the next slot
        self.sum = np.zeros((self.nrow, self.ncol), dtype=np.float64)
        self.cnt = np.zeros((self.nrow, self.ncol), dtype=np.int32)

    def add(self, mesh: str, values: np.ndarray):
        r, c = self.pos[mesh]
        ok = np.isfinite(values) & (values >= 0)
        self.sum[r:r + N_CELL, c:c + N_CELL] += np.where(ok, values, 0.0)
        self.cnt[r:r + N_CELL, c:c + N_CELL] += ok

    def result(self, unit: str) -> np.ndarray:
        with np.errstate(invalid="ignore", divide="ignore"):
            mean = self.sum / self.cnt                       # mean mm/h over the observed minutes
        if unit == "mm":                                     # rainfall of the slot: sum of (mm/h / 60) per minute
            mean = self.sum / 60.0
        return np.where(self.cnt > 0, mean, NODATA).astype(np.float32)


# ---------------------------------------------------------------------------------------------
# 2. reading
# ---------------------------------------------------------------------------------------------
def list_files(inputs):
    """{(date, minute_of_day, mesh): loader} for every CX*.csv in folders (recursive) or zips."""
    files = {}
    for src in map(Path, inputs):
        if src.is_dir():
            for p in src.rglob("*.csv"):
                m = NAME_RE.search(p.name)
                if m:
                    files[(m.group(2), int(m.group(3)) * 60 + int(m.group(4)), m.group(1))] = p.read_bytes
        elif src.suffix.lower() == ".zip":
            z = zipfile.ZipFile(src)
            for n in z.namelist():
                m = NAME_RE.search(Path(n).name)
                if m:
                    files[(m.group(2), int(m.group(3)) * 60 + int(m.group(4)), m.group(1))] = (lambda z=z, n=n: z.read(n))
        else:
            m = NAME_RE.search(src.name)
            if m:
                files[(m.group(2), int(m.group(3)) * 60 + int(m.group(4)), m.group(1))] = src.read_bytes
    return files


def abs_minute(date: str, minute: int) -> int:
    """Minutes on one continuous axis across days, so a slot may end at 00:00 of the next day."""
    return dt.date(int(date[:4]), int(date[4:6]), int(date[6:8])).toordinal() * 1440 + minute


def slot_label(abs_min: int) -> tuple[str, int]:
    """(YYYYMMDD, minute of that day) of an absolute minute; 24:00 becomes 00:00 of the next day."""
    return dt.date.fromordinal(abs_min // 1440).strftime("%Y%m%d"), abs_min % 1440


def read_csv(data: bytes, row_order: str) -> np.ndarray:
    g = np.loadtxt(io.BytesIO(data), delimiter=",", dtype=np.float32, ndmin=2)
    if g.shape[1] == N_CELL + 1 and np.isnan(g[:, -1]).all():        # trailing comma
        g = g[:, :-1]
    if g.shape != (N_CELL, N_CELL):
        raise ValueError(f"grid is {g.shape}, expected {(N_CELL, N_CELL)}")
    return g[::-1] if row_order == "south_to_north" else g


# ---------------------------------------------------------------------------------------------
# 3. GeoTIFF writer (float32, single band, EPSG:4326, uncompressed, little endian)
# ---------------------------------------------------------------------------------------------
def write_geotiff(path: Path, arr: np.ndarray, west: float, north: float, dx: float, dy: float, nodata=NODATA):
    h, w = arr.shape
    data = arr.astype("<f4").tobytes()
    ascii_nodata = (str(int(nodata)) if float(nodata).is_integer() else str(nodata)).encode() + b"\x00"
    # GeoKeys: geographic model, pixel-is-area, geographic CS = WGS84 (4326)
    geokeys = struct.pack("<16H", 1, 1, 0, 3, 1024, 0, 1, 2, 1025, 0, 1, 1, 2048, 0, 1, 4326)
    pixel_scale = struct.pack("<3d", dx, dy, 0.0)
    tiepoint = struct.pack("<6d", 0.0, 0.0, 0.0, west, north, 0.0)
    # layout: header(8) | IFD | extra values | pixel data
    tags = []                                       # (tag, type, count, value-or-bytes)
    def add(tag, typ, count, value):
        tags.append((tag, typ, count, value))
    add(256, 4, 1, w); add(257, 4, 1, h); add(258, 3, 1, 32); add(259, 3, 1, 1); add(262, 3, 1, 1)
    add(273, 4, 1, None)                            # StripOffsets, filled later
    add(277, 3, 1, 1); add(278, 4, 1, h); add(279, 4, 1, len(data)); add(284, 3, 1, 1); add(339, 3, 1, 3)
    add(33550, 12, 3, pixel_scale); add(33922, 12, 6, tiepoint); add(34735, 3, 16, geokeys); add(42113, 2, len(ascii_nodata), ascii_nodata)
    tags.sort()
    ifd_size = 2 + 12 * len(tags) + 4
    extra_off = 8 + ifd_size
    extra = b""
    entries = b""
    data_off = None
    # first pass to know where the pixel data starts
    extra_len = sum(len(v) for _, _, _, v in tags if isinstance(v, bytes) and len(v) > 4)
    data_off = extra_off + extra_len
    for tag, typ, count, value in tags:
        if tag == 273:
            value = data_off
        if isinstance(value, bytes):
            if len(value) > 4:
                entries += struct.pack("<HHII", tag, typ, count, extra_off + len(extra)); extra += value
            else:
                entries += struct.pack("<HHI", tag, typ, count) + value.ljust(4, b"\x00")
        elif typ == 3:
            entries += struct.pack("<HHIHH", tag, typ, count, value, 0)
        else:
            entries += struct.pack("<HHII", tag, typ, count, value)
    with open(path, "wb") as f:
        f.write(b"II*\x00" + struct.pack("<I", 8))
        f.write(struct.pack("<H", len(tags)) + entries + struct.pack("<I", 0))
        f.write(extra)
        f.write(data)


def log(msg):
    print(f"[{time.strftime('%H:%M:%S')}] {msg}", flush=True)


# ---------------------------------------------------------------------------------------------
# main loop: slot by slot
# ---------------------------------------------------------------------------------------------
def run(inputs, out, slot_min: int = 15, unit: str = "mmh", row_order: str = "north_to_south"):
    out = Path(out) / "rain"
    out.mkdir(parents=True, exist_ok=True)
    t0 = time.perf_counter()
    files = list_files(inputs)
    if not files:
        raise SystemExit("no CX*.csv files found")
    # 1. grid
    meshes = sorted({k[2] for k in files})
    grid = Grid(meshes)
    log(f"{len(files):,} files, meshes {meshes}, grid {grid.ncol} x {grid.nrow}, "
        f"W{grid.west} S{grid.south:.4f} E{grid.east} N{grid.north:.4f}")
    # slots: a minute m belongs to the slot ending at the next multiple of slot_min, window (T-slot, T].
    # Minutes are counted across days, so 23:46-00:00 form one slot named 00:00 of the next day.
    by_abs = {(abs_minute(d, m), mesh): loader for (d, m, mesh), loader in files.items()}
    slots = sorted({((a - 1) // slot_min + 1) * slot_min for a, _ in by_abs})
    written = []
    for n, end in enumerate(slots, 1):
        # 2. read the files of this slot
        for a in range(end - slot_min + 1, end + 1):
            for mesh in meshes:
                loader = by_abs.get((a, mesh))
                if loader is None:
                    continue
                try:
                    grid.add(mesh, read_csv(loader(), row_order))
                except Exception as ex:                                  # noqa: BLE001
                    d_, m_ = slot_label(a)
                    log(f"  skip {d_} {m_ // 60:02d}:{m_ % 60:02d} {mesh}: {ex}")
        # 3. aggregate and write
        date, end_min = slot_label(end)
        name = f"rain_{date}_{end_min // 60:02d}{end_min % 60:02d}.tif"
        arr = grid.result(unit)
        write_geotiff(out / name, arr, grid.west, grid.north, grid.dx, grid.dy)
        written.append({"file": name, "date": date, "time": f"{end_min // 60:02d}:{end_min % 60:02d}", "minutes": int(grid.cnt.max()),
                        "max": round(float(arr.max()), 1)})
        # 4. reset
        grid.reset()
        if n % 50 == 0:
            log(f"  {n}/{len(slots)} slots")
    index = {"unit": "mm/h (mean over the slot)" if unit == "mmh" else "mm (rainfall of the slot)", "nodata": NODATA,
             "bounds": [grid.west, grid.south, grid.east, grid.north], "width": grid.ncol, "height": grid.nrow,
             "slot_min": slot_min, "files": written}
    with open(out / "index.json", "w", encoding="utf-8") as f:
        json.dump(index, f, ensure_ascii=False, indent=1)
    log(f"done: {len(written)} GeoTIFFs in {out} ({time.perf_counter() - t0:.1f} s)")
    for date in sorted({w["date"] for w in written}):
        ws = [w for w in written if w["date"] == date]
        print(f"  {date}: {len(ws)} slots {ws[0]['time']}-{ws[-1]['time']}, max {max(w['max'] for w in ws)} {index['unit'].split()[0]}")
    return index


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("inputs", nargs="+", help="folders (searched recursively), zip files or CX*.csv files")
    ap.add_argument("--out", default="out", help="output folder; GeoTIFFs go to <out>/rain/")
    ap.add_argument("--slot-min", type=int, default=15)
    ap.add_argument("--unit", choices=["mmh", "mm"], default="mmh", help="mmh: mean intensity; mm: rainfall of the slot")
    ap.add_argument("--row-order", choices=["north_to_south", "south_to_north"], default="north_to_south")
    a = ap.parse_args()
    run(a.inputs, a.out, a.slot_min, a.unit, a.row_order)


if __name__ == "__main__":
    main()
