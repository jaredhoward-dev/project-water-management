"""chcnetcdf.py refuses every file off CHC's byMonth layout, before anything is written.

The reader's docstring lists what it holds to: precip(time, latitude,
longitude) float32, unpacked, latitude south to north in 0.05 deg steps on
CHC's cell centres, covering the region, and whole consecutive days. Each
test writes a small synthetic file that breaks exactly one of those, beside
a positive control that differs only in that one thing. Invented values; no
CHC file is read.

    ingest/.venv/bin/python -m unittest test_chcnetcdf   (from ingest/)
"""

import datetime as dt
import sys
import tempfile
import unittest
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(HERE / "fixtures"))

import chcnetcdf  # noqa: E402
import grid  # noqa: E402
import lambda_handler  # noqa: E402
import make_chc_fixture as chc  # noqa: E402
import zarrstore  # noqa: E402

EPOCH = dt.date(1980, 1, 1)
DAY0 = dt.date(2024, 2, 28)


def write(
    path: Path,
    *,
    times=None,
    units="days since 1980-1-1",
    lat=None,
    lon=None,
    dims=("time", "latitude", "longitude"),
    dtype="f4",
    attrs=None,
) -> Path:
    """A CHC-like file (the region plus chc.MARGIN cells) with one part overridden."""
    import h5netcdf

    if times is None:
        times = [(DAY0 - EPOCH).days, (DAY0 - EPOCH).days + 1]
    if lat is None:
        lat = chc.LAT0 + np.arange(chc.NLAT) * grid.STEP
    if lon is None:
        lon = chc.LON0 + np.arange(chc.NLON) * grid.STEP
    sizes = {"time": len(times), "latitude": len(lat), "longitude": len(lon)}
    full = np.full(tuple(sizes[d] for d in dims), -9999, dtype=np.float32)
    with h5netcdf.File(path, "w") as f:
        f.dimensions = sizes
        t = f.create_variable("time", ("time",), "f4")
        t[:] = np.asarray(times, dtype=np.float32)
        t.attrs["units"] = units
        la = f.create_variable("latitude", ("latitude",), "f4")
        la[:] = np.asarray(lat, dtype=np.float32)
        lo = f.create_variable("longitude", ("longitude",), "f4")
        lo[:] = np.asarray(lon, dtype=np.float32)
        p = f.create_variable("precip", dims, dtype, fillvalue=np.asarray(-9999, dtype=dtype))
        p[:] = full.astype(dtype)
        p.attrs["missing_value"] = np.asarray(-9999, dtype=dtype)
        for k, v in (attrs or {}).items():
            p.attrs[k] = v
    return path


class Refusals(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.dir = Path(self.tmp.name)
        self.n = 0

    def tearDown(self):
        self.tmp.cleanup()

    def file(self, **kw) -> Path:
        self.n += 1
        return write(self.dir / f"f{self.n}.nc", **kw)

    def refuse(self, match: str, **kw) -> None:
        with self.assertRaisesRegex(ValueError, match):
            chcnetcdf.read_region(str(self.file(**kw)))

    def test_positive_control_reads(self):
        r = chcnetcdf.read_region(str(self.file()))
        self.assertEqual(r.first_day, DAY0)
        self.assertEqual(r.values.shape, (2, grid.ROWS, grid.COLS))
        self.assertTrue(np.isnan(r.values).all())  # every cell the -9999 fill
        self.assertEqual(r.days, [DAY0, DAY0 + dt.timedelta(days=1)])
        # A file of exactly the region, no margin, reads too.
        exact = self.file(lat=grid.ORIGIN["lat"] + np.arange(grid.ROWS) * grid.STEP, lon=grid.ORIGIN["lon"] + np.arange(grid.COLS) * grid.STEP)
        self.assertEqual(chcnetcdf.read_region(str(exact)).values.shape, (2, grid.ROWS, grid.COLS))

    def test_other_dimension_order(self):
        self.refuse(r"precip dims are \('time', 'longitude', 'latitude'\)", dims=("time", "longitude", "latitude"))

    def test_float64_precip(self):
        self.refuse("precip is float64, expected float32", dtype="f8")

    def test_packed_values(self):
        self.refuse("carries scale_factor", attrs={"scale_factor": np.float32(0.1)})
        self.refuse("carries add_offset", attrs={"add_offset": np.float32(1.0)})

    def test_north_up_latitude(self):
        lat = chc.LAT0 + np.arange(chc.NLAT) * grid.STEP
        self.refuse("latitude is not ascending in 0.05 deg steps", lat=lat[::-1])

    def test_another_grid_step(self):
        lon = chc.LON0 + np.arange(chc.NLON) * 0.1
        self.refuse("longitude is not ascending in 0.05 deg steps", lon=lon)

    def test_a_file_short_of_the_region(self):
        # Ten rows short in the north: the region doesn't fit.
        lat = grid.ORIGIN["lat"] + np.arange(grid.ROWS - 10) * grid.STEP
        self.refuse(r"latitude \(-35\.475\.\.-8\.525\) does not cover the region", lat=lat)
        # A west edge east of the region's.
        lon = grid.ORIGIN["lon"] + (5 + np.arange(grid.COLS)) * grid.STEP
        self.refuse("longitude .* does not cover the region", lon=lon)

    def test_cell_edges_instead_of_centres(self):
        # Half a step off: the same step, but corners rather than CHC's centres.
        lat = chc.LAT0 - grid.STEP / 2 + np.arange(chc.NLAT) * grid.STEP
        self.refuse("latitude cell centres are off CHC's grid", lat=lat)

    def test_a_single_coordinate(self):
        self.refuse("longitude has fewer than two values", lon=[grid.ORIGIN["lon"]])

    def test_a_missing_day(self):
        # 28 Feb and 1 Mar 2024 with the leap day left out: consecutive dates, but not consecutive days.
        d = (DAY0 - EPOCH).days
        self.refuse("time is not consecutive whole days", times=[d, d + 2])

    def test_days_out_of_order_or_repeated(self):
        d = (DAY0 - EPOCH).days
        self.refuse("time is not consecutive whole days", times=[d + 1, d])
        self.refuse("time is not consecutive whole days", times=[d, d])

    def test_part_days(self):
        d = (DAY0 - EPOCH).days
        self.refuse("time is not consecutive whole days", times=[d + 0.5, d + 1.5])

    def test_no_days(self):
        self.refuse("the file has no days", times=[])

    def test_hourly_time_units(self):
        self.refuse('time units "hours since 1980-1-1" are not', units="hours since 1980-1-1")

    def test_not_a_netcdf_file(self):
        junk = self.dir / "junk.nc"
        junk.write_bytes(b"<html><body>503 Service Unavailable</body></html>\n")
        with self.assertRaisesRegex(OSError, "file signature not found"):
            chcnetcdf.read_region(str(junk))

    def test_a_truncated_file(self):
        whole = self.file()
        cut = self.dir / "cut.nc"
        cut.write_bytes(whole.read_bytes()[: whole.stat().st_size // 2])
        # HDF5 checks the file's stored end against its size, so half a file never reads as a shorter one.
        with self.assertRaisesRegex(OSError, "truncated file"):
            chcnetcdf.read_region(str(cut))

    def test_a_refused_file_writes_nothing(self):
        d = (DAY0 - EPOCH).days
        bad = self.file(times=[d, d + 2])
        root = self.dir / "mirror"
        with self.assertRaisesRegex(ValueError, "not consecutive"):
            lambda_handler.ingest_file(zarrstore.Mirror.from_url(f"file://{root}"), "rnl", "fixture:chc/chirps-v3.0.2024.02.days_p05.nc", bad)
        self.assertFalse(root.exists())


if __name__ == "__main__":
    unittest.main()
