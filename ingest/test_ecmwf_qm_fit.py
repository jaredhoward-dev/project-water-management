"""ecmwf_qm_fit.py: the offline quantile-mapping fit, on synthetic data only
(no archive exists yet; issue #604 R4-C).

    ingest/.venv/bin/python -m unittest test_ecmwf_qm_fit
"""

import datetime as dt
import json
import sys
import tempfile
import unittest
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

import ecmwf_forecast  # noqa: E402
import ecmwf_qm_fit as qm  # noqa: E402
import zarrstore  # noqa: E402


def gamma_rain(rng, n, wet=0.4, shape=0.7, scale=8.0):
    """Synthetic daily rain: dry days, then gamma-distributed totals."""
    return np.where(rng.random(n) < wet, rng.gamma(shape, scale, n), 0.0)


class Pairs(unittest.TestCase):
    def test_maps_a_doubled_forecast_back_to_the_observations(self):
        rng = np.random.default_rng(1)
        obs = gamma_rain(rng, 200_000)
        fc = 2.0 * gamma_rain(rng, 200_000)
        pairs = qm.fit_pairs(fc, obs)
        fs, os_ = [p[0] for p in pairs], [p[1] for p in pairs]
        self.assertTrue(all(b > a for a, b in zip(fs, fs[1:])), "f strictly increasing")
        self.assertTrue(all(b >= a for a, b in zip(os_, os_[1:])), "o non-decreasing")
        self.assertEqual(pairs[0], [0.0, 0.0])  # the dry days collapse into one pair
        for x in (2.0, 10.0, 30.0):
            self.assertAlmostEqual(qm.apply(pairs, x), x / 2, delta=0.06 * x + 0.2)

    def test_identity_when_the_distributions_agree(self):
        rng = np.random.default_rng(2)
        a = gamma_rain(rng, 100_000)
        pairs = qm.fit_pairs(a, a)
        for x in (0.0, 1.0, 5.0, 20.0):
            self.assertAlmostEqual(qm.apply(pairs, x), x, delta=0.01)

    def test_apply_beyond_the_pairs(self):
        pairs = [[0.0, 0.0], [10.0, 6.0], [20.0, 14.0]]
        self.assertAlmostEqual(qm.apply(pairs, 15.0), 10.0)
        self.assertAlmostEqual(qm.apply(pairs, 50.0), 44.0)  # the last offset (-6) carried on
        self.assertAlmostEqual(qm.apply([[2.0, 1.0], [4.0, 3.0]], 1.0), 0.5)  # below the first: scaled towards 0
        self.assertAlmostEqual(qm.apply([[0.0, 0.5], [4.0, 3.0]], 0.0), 0.5)
        self.assertEqual(qm.apply([[0.0, 0.0], [1.0, 0.0]], 0.5), 0.0)
        self.assertEqual(qm.apply([], 7.0), 7.0)  # no pairs: identity
        self.assertEqual(qm.apply([[1.0, 0.0], [2.0, 1.0]], 3.0 - 9.0), 0.0)  # never below 0

    def test_seasons(self):
        self.assertEqual([qm.season_of(m) for m in (12, 1, 3, 6, 9, 11)], ["DJF", "DJF", "MAM", "JJA", "SON", "SON"])


class Fit(unittest.TestCase):
    """A small copy: forecasts archived as their mean, and `sat` finals for the same days, the forecast twice the rain."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        mirror = zarrstore.LocalMirror(self.root)
        rng = np.random.default_rng(3)
        first = dt.date(2026, 1, 5)
        issues = [first + dt.timedelta(days=i) for i in range(3)]
        days = (issues[-1] - first).days + ecmwf_forecast.DAYS
        obs = gamma_rain(rng, days * 550 * 620).reshape(days, 550, 620).astype(np.float32)
        obs[:, 500:, 600:] = np.nan  # sea, as CHIRPS has it
        zarrstore.write_finals(self.root, "sat", first, obs)
        coarse = obs.reshape(days, 275, 2, 310, 2).mean(axis=(2, 4))
        for i, issue in enumerate(issues):
            v = np.zeros((4, ecmwf_forecast.DAYS, ecmwf_forecast.ROWS, ecmwf_forecast.COLS), np.float32)
            v[0] = 2.0 * coarse[i : i + ecmwf_forecast.DAYS]
            ecmwf_forecast.write_issue(mirror, issue, np.nan_to_num(v), 50)
        ecmwf_forecast.write_index(mirror, [issues[-1].isoformat()], [d.isoformat() for d in issues[:-1]])
        self.issues = issues

    def tearDown(self):
        self.tmp.cleanup()

    def test_fits_per_season_with_its_provenance(self):
        doc = qm.fit(self.root, stride=3, min_samples=1000, fitted_at="2026-10-27T10:00:00Z")
        self.assertEqual((doc["v"], doc["product"], doc["stat"], doc["fittedAt"]), (1, "ecmwf", "mean", "2026-10-27T10:00:00Z"))
        self.assertEqual(doc["forecasts"], {"issues": 3, "first": "2026-01-05", "last": "2026-01-07"})
        self.assertEqual([g["id"] for g in doc["groups"]], ["D1-DJF"])  # January only
        g = doc["groups"][0]
        self.assertEqual(sorted(g), ["id", "months", "pairs", "region", "samples"])  # the per-cell group's keys, as before #835
        self.assertEqual(g["months"], [12, 1, 2])
        self.assertGreater(g["samples"], 1000)
        # Twice the rain maps back to the rain (the 2x2 mean of gamma days is smoother, so a loose tolerance).
        for x in (2.0, 8.0):
            self.assertAlmostEqual(qm.apply(g["pairs"], x), x / 2, delta=0.15 * x + 0.2)

    def test_min_samples_leaves_a_thin_group_out_and_main_writes_the_file(self):
        self.assertEqual(qm.fit(self.root, stride=3, min_samples=10**9)["groups"], [])
        self.assertEqual(qm.main(["--copy", str(self.root), "--cell-stride", "3", "--min-samples", str(10**9)]), 1)
        self.assertFalse((self.root / ecmwf_forecast.QM_KEY).exists())
        self.assertEqual(qm.main(["--copy", str(self.root), "--cell-stride", "3", "--min-samples", "1000", "--scale", "1.1"]), 0)
        doc = json.loads((self.root / ecmwf_forecast.QM_KEY).read_text())
        self.assertEqual(doc["observed"], {"product": "sat", "fallback": "prelim", "scale": 1.1})
        self.assertEqual(len(doc["groups"]), 1)

    def test_days_with_no_observation_are_skipped(self):
        # With no observed rain in the copy no forecast day has a pair, so nothing is fitted.
        import shutil

        shutil.rmtree(self.root / "sat")
        doc = qm.fit(self.root, stride=3, min_samples=1)
        self.assertEqual((doc["forecasts"]["issues"], doc["groups"]), (0, []))


class BlockMeans(unittest.TestCase):
    def test_means_over_the_cells_finite_in_both_and_half_full_blocks_only(self):
        f = np.arange(16, dtype=np.float64).reshape(4, 4)
        o = np.ones((4, 4))
        o[0, 0] = np.nan  # one cell of the first block: its mean skips it in both
        o[2:, 2:] = np.nan  # a whole block: left out
        o[2, 0] = o[3, 0] = o[3, 1] = np.nan  # three of four: under half, left out
        fm, om = qm._block_means(f, o, np.arange(4), np.arange(4), 2)
        self.assertEqual(fm.tolist(), [(1 + 4 + 5) / 3, (2 + 3 + 6 + 7) / 4])
        self.assertEqual(om.tolist(), [1.0, 1.0])
        # Block 0: the region whole, one mean; an edge that doesn't fill a block is dropped.
        fm, _ = qm._block_means(f, np.ones((4, 4)), np.arange(4), np.arange(4), 0)
        self.assertEqual(fm.tolist(), [7.5])
        self.assertEqual(qm._block_means(f, o, np.arange(4), np.arange(4), 3)[0].size, 1)
        self.assertEqual(qm._block_means(f, o, np.arange(2), np.arange(4), 3)[0].size, 0)


class AreaFit(unittest.TestCase):
    """Issue #835: a copy where a cell's forecast is noisier than its area mean.

    The observed rain is one value per 0.5 deg block and day (uniform over its
    5 x 5 0.1 deg cells); each cell's forecast is that times independent
    exponential noise (mean 1). A cell's forecast then has more dry-ish and
    more extreme days than the observations, but a block's mean forecast is
    close to the block's rain: the per-cell fit, made to undo the cell noise,
    distorts an area mean, and the area fit leaves it nearly alone."""

    REGION = {"w": 20.01, "s": -25.49, "e": 22.99, "n": -22.51}  # 0.1 deg rows and cols 100..129

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        mirror = zarrstore.LocalMirror(self.root)
        rng = np.random.default_rng(835)
        first = dt.date(2026, 1, 1)
        issues = [first + dt.timedelta(days=i) for i in range(12)]
        days = (issues[-1] - first).days + ecmwf_forecast.DAYS
        blocks = gamma_rain(rng, days * 36, wet=0.5).reshape(days, 6, 6)
        obs = np.full((days, 550, 620), np.nan, np.float32)
        obs[:, 200:260, 200:260] = np.kron(blocks, np.ones((10, 10)))
        zarrstore.write_finals(self.root, "sat", first, obs)
        coarse = np.kron(blocks, np.ones((5, 5)))  # (days, 30, 30) on the 0.1 deg cells
        for i, issue in enumerate(issues):
            v = np.zeros((4, ecmwf_forecast.DAYS, ecmwf_forecast.ROWS, ecmwf_forecast.COLS), np.float32)
            v[0, :, 100:130, 100:130] = coarse[i : i + ecmwf_forecast.DAYS] * rng.exponential(1.0, (ecmwf_forecast.DAYS, 30, 30))
            ecmwf_forecast.write_issue(mirror, issue, v, 50)
        ecmwf_forecast.write_index(mirror, [issues[-1].isoformat()], [d.isoformat() for d in issues[:-1]])
        self.regions = [{"id": "T", "region": dict(self.REGION)}]

    def tearDown(self):
        self.tmp.cleanup()

    def test_both_bases_in_one_file_the_cell_groups_as_before(self):
        doc = qm.fit(self.root, regions=self.regions, stride=1, min_samples=500, basis="both", block=5, fitted_at="2026-11-25T00:00:00Z")
        self.assertEqual([g["id"] for g in doc["groups"]], ["T-DJF", "T-DJF-area"])
        cell, area = doc["groups"]
        self.assertNotIn("basis", cell)
        self.assertEqual((area["basis"], area["block"]), ("area", 5))
        self.assertEqual(cell["samples"], 25 * area["samples"])  # 900 cells, 36 blocks a day
        self.assertIn("area groups", doc["method"])
        # The feed's choice: the area group where there is one, else the per-cell group.
        self.assertIs(qm.group_for(doc, -24.0, 21.5, 1), area)
        self.assertIs(qm.group_for({**doc, "groups": [cell]}, -24.0, 21.5, 1), cell)
        self.assertIsNone(qm.group_for(doc, -24.0, 21.5, 6))
        # Block 0: each region one area, one sample a paired day.
        whole = qm.fit(self.root, regions=self.regions, min_samples=1, basis="area", block=0)
        paired = sum(1 for _ in qm._paired_days(self.root, "sat", 1.0))
        self.assertEqual(whole["groups"][0]["samples"], paired)
        self.assertEqual(whole["method"], qm.METHOD_AREA)

    def test_held_out_days_the_area_fit_maps_area_means_better_than_the_per_cell_fit(self):
        split = dt.date(2026, 1, 12)
        r = qm.holdout(self.root, split, regions=self.regions, stride=1, min_samples=500, block=5)
        self.assertEqual(r["samples"], 114 * 36)  # 114 held-out (issue, day) pairs, 36 blocks each
        mae = r["mae"]
        # The area means are close to the rain already; the per-cell fit pulls them away, the area fit doesn't.
        self.assertLess(mae["area"], mae["cell"] * 0.8, r)
        self.assertLess(mae["area"], mae["raw"] * 1.1, r)
        self.assertLess(abs(r["bias"]["area"]), abs(r["bias"]["cell"]), r)
        # main prints the same comparison and writes nothing.
        self.assertEqual(qm.main(["--copy", str(self.root), "--holdout-from", "2026-01-12", "--cell-stride", "1", "--min-samples", "500", "--regions", str(self._regions_file())]), 0)
        self.assertFalse((self.root / ecmwf_forecast.QM_KEY).exists())

    def test_main_writes_an_area_fit(self):
        self.assertEqual(qm.main(["--copy", str(self.root), "--basis", "area", "--min-samples", "500", "--regions", str(self._regions_file())]), 0)
        doc = json.loads((self.root / ecmwf_forecast.QM_KEY).read_text())
        self.assertEqual([(g["id"], g["basis"], g["block"]) for g in doc["groups"]], [("T-DJF-area", "area", 5)])

    def _regions_file(self) -> Path:
        p = self.root / "regions.json"
        p.write_text(json.dumps(self.regions))
        return p


if __name__ == "__main__":
    unittest.main()
