"""Self-test for xrain_to_geotiff: slot naming across midnight and the minute count per slot."""
import json
import sys
import tempfile
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).parent))
import xrain_to_geotiff as X  # noqa: E402


def _write(d, date, hhmm, val, mesh="5239"):
    a = np.full((X.N_CELL, X.N_CELL), val, dtype=np.float32)
    np.savetxt(d / f"CX{mesh}{date}{hhmm}.csv", a, fmt="%.1f", delimiter=",")


def test_midnight_slot():
    with tempfile.TemporaryDirectory() as t:
        d = Path(t) / "in"; d.mkdir()
        for m in range(50, 60):                     # 23:50-23:59 of 08-13
            _write(d, "20260813", f"23{m:02d}", 10.0)
        _write(d, "20260814", "0000", 25.0)         # 00:00 of 08-14 closes the same slot
        for m in range(1, 6):                       # 00:01-00:05 -> slot 00:15
            _write(d, "20260814", f"00{m:02d}", 4.0)
        out = Path(t) / "out"
        X.run([d], out)
        idx = json.load(open(out / "rain" / "index.json"))
        names = [w["file"] for w in idx["files"]]
        assert names == ["rain_20260814_0000.tif", "rain_20260814_0015.tif"], names
        assert not any("2400" in n for n in names)
        w0, w1 = idx["files"]
        assert w0["date"] == "20260814" and w0["time"] == "00:00" and w0["minutes"] == 11, w0
        assert abs(w0["max"] - (10 * 10 + 25) / 11) < 0.1, w0["max"]        # mean of 11 minute values
        assert w1["minutes"] == 5 and abs(w1["max"] - 4.0) < 1e-6, w1
        print("test_midnight_slot ok")


if __name__ == "__main__":
    test_midnight_slot()
