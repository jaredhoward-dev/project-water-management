"""Writes the SWOT trial's synthetic fixtures (test_swot_trial.py reads them).

    python3 ingest/fixtures/swot/make_swot_fixture.py

Commit what it writes; test_swot_trial.py fails if the files drift from it.

Invented dams in the open South Atlantic (40°S 0°E, where no dam is), with a
made-up bathymetry: dam A's area rises linearly with level over 5 m from
zero to its full 10 ha (A = A_full (h − h0) / 5, so V = A_full (h − h0)² / 10
and the capacity is 250 000 m³). Its passes read that truth exactly, but
SWOT's `area_total` runs 17 % high (as LakeSP does on small lakes), and the
observed areas are the truth. Dam B (3 ha) has a lake with mostly flagged
passes, dam C (0.5 ha) no lake, and lake L3 is in the PLD but never seen.
Stdlib only: the zip itself is written by the test (pyshp) from passes.json.
"""

import csv
import datetime as dt
import json
import math
import random
from pathlib import Path

HERE = Path(__file__).resolve().parent
LAT0, LON0 = -40.0, 0.0
M_LAT = math.pi / 180 * 6371008.8
M_LON = M_LAT * math.cos(math.radians(LAT0))
H0 = 100.0  # dam A's bed level, m
DEPTH = 5.0
A_FULL = 100_000.0


def square(cx_m: float, cy_m: float, side_m: float) -> list[tuple[float, float]]:
    h = side_m / 2
    pts = [(-h, -h), (h, -h), (h, h), (-h, h)]
    return [(round(LON0 + (cx_m + x) / M_LON, 7), round(LAT0 + (cy_m + y) / M_LAT, 7)) for x, y in pts]


DAMS = {
    "A": (square(0, 0, math.sqrt(A_FULL)), 250_000.0),
    "B": (square(2000, 0, math.sqrt(30_000)), 60_000.0),
    "C": (square(4000, 0, math.sqrt(5_000)), None),
}
LAKES = {"L1": square(0, 0, math.sqrt(A_FULL) + 20), "L2": square(2000, 0, math.sqrt(30_000) + 20)}
GOOD = {"quality_f": 0, "partial_f": 0, "ice_clim_f": 0, "ice_dyn_f": 0, "xovr_cal_q": 0}


def area(h: float) -> float:
    return A_FULL * (h - H0) / DEPTH


def main(out: Path = HERE) -> None:
    rng = random.Random(625)
    with open(out / "dams.csv", "w", newline="") as f:
        w = csv.writer(f)
        w.writerow(["dam", "lat", "lon", "capacity_m3"])
        for key, (ring, cap) in DAMS.items():
            for i, (lon, lat) in enumerate(ring):
                w.writerow([key, lat, lon, cap if (cap and i == 0) else ""])
    granules, observed = [], []
    t0 = dt.datetime(2024, 1, 3, 10, 0, tzinfo=dt.UTC)
    for k in range(12):  # 12 visits, each two passes 2 days apart at one level
        level = H0 + 2.0 + 3.0 * (k % 6) / 5  # 2–5 m above the bed
        for j in range(2):
            t = t0 + dt.timedelta(days=30 * k + 2 * j)
            wse = level + (0.08 if j else -0.08)
            if k == 7 and j == 1:
                wse = level + 2.5  # a roll error
            rows = [
                {"lake_id": "L1", "time_str": t.strftime("%Y-%m-%dT%H:%M:%SZ"), "wse": round(wse, 3), "area_total": round(area(level) * 1.17 / 1e6, 6), **GOOD, "ring": LAKES["L1"]},
                {"lake_id": "L2", "time_str": t.strftime("%Y-%m-%dT%H:%M:%SZ"), "wse": round(50 + rng.uniform(-0.2, 0.2), 3), "area_total": 0.03, **GOOD, "quality_f": 0 if k < 3 else 2, "ring": LAKES["L2"]},
                {"lake_id": "L3", "time_str": "no_data", "wse": -999999999999.0, "area_total": -999999999999.0, "quality_f": 3, "partial_f": 0, "ice_clim_f": 0, "ice_dyn_f": 0, "xovr_cal_q": 2, "ring": None},
            ]
            if k == 4 and j == 0:
                rows[0]["partial_f"] = 1  # flagged: partly in the swath
            if k == 5 and j == 0:
                rows[0]["wse"] = -999999999999.0  # no height
            granules.append({"name": f"SWOT_L2_HR_LakeSP_Prior_{10 + k:03d}_{100 + j:03d}_AF_{t:%Y%m%dT%H%M%S}_{t:%Y%m%dT%H%M%S}_PID0_01", "rows": rows})
            if j == 0:
                observed.append(["A", (t + dt.timedelta(days=1)).date().isoformat(), round(area(level), 1)])
    granules.append({**granules[0], "name": granules[0]["name"][: -len("_01")] + "_02"})  # the same pass again
    (out / "passes.json").write_text(json.dumps(granules, indent=1) + "\n")
    with open(out / "observed-areas.csv", "w", newline="") as f:
        w = csv.writer(f)
        w.writerow(["dam", "date", "area_m2"])
        w.writerows(observed)
    with open(out / "survey.csv", "w", newline="") as f:
        w = csv.writer(f)
        w.writerow(["dam", "area_m2", "volume_m3"])
        for i in range(11):
            h = H0 + DEPTH * i / 10
            w.writerow(["A", round(area(h), 3), round(A_FULL * (h - H0) ** 2 / (2 * DEPTH), 3)])


if __name__ == "__main__":
    main()
