"""swot_trial.py (issue #625), offline: synthetic dams and LakeSP rows, a fake archive.

    ingest/.venv/bin/python -m unittest discover -s ingest

The Prior zips are written here with pyshp (requirements-trial.txt) from
fixtures/swot/passes.json, which fixtures/swot/make_swot_fixture.py writes.
"""

import datetime as dt
import io
import json
import math
import sys
import tempfile
import unittest
import urllib.error
import urllib.parse
import zipfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

import polite  # noqa: E402
import swot_trial as st  # noqa: E402

FIX = HERE / "fixtures" / "swot"
START, END = dt.date(2024, 1, 1), dt.date(2024, 12, 31)


def write_prior_zip(path: Path, rows: list[dict]) -> None:
    """One LakeSP-shaped Prior granule: a zipped polygon shapefile with vD's attribute names."""
    import shapefile

    stem = path.stem
    shp, shx, dbf = io.BytesIO(), io.BytesIO(), io.BytesIO()
    with shapefile.Writer(shp=shp, shx=shx, dbf=dbf, shapeType=shapefile.POLYGON) as w:
        w.field("lake_id", "C", 20)
        w.field("time_str", "C", 25)
        for name in ("wse", "area_total"):
            w.field(name, "N", 20, 6)
        for name in st.FLAGS:
            w.field(name, "N", 4, 0)
        for r in rows:
            if r["ring"]:
                ring = [tuple(p) for p in r["ring"]]
                w.poly([list(reversed(ring + ring[:1]))])  # clockwise outer ring, closed
            else:
                w.null()
            w.record(r["lake_id"], r["time_str"], r["wse"], r["area_total"], *(r[n] for n in st.FLAGS))
    with zipfile.ZipFile(path, "w") as z:
        for ext, buf in (("shp", shp), ("shx", shx), ("dbf", dbf)):
            z.writestr(f"{stem}.{ext}", buf.getvalue())


def granules() -> list[dict]:
    return json.loads((FIX / "passes.json").read_text())


def fixture_passes(tmp: Path) -> list[st.Pass]:
    out = []
    for g in granules():
        p = tmp / f"{g['name']}.zip"
        write_prior_zip(p, g["rows"])
        out.extend(st.read_prior_zip(p))
    return out


def dams() -> list[st.Dam]:
    return st.read_dams(FIX / "dams.csv")


class Fixtures(unittest.TestCase):
    def test_the_committed_fixtures_match_their_generator(self):
        sys.path.insert(0, str(FIX))
        try:
            import make_swot_fixture
        finally:
            sys.path.remove(str(FIX))
        with tempfile.TemporaryDirectory() as t:
            make_swot_fixture.main(Path(t))
            for name in ("dams.csv", "passes.json", "observed-areas.csv", "survey.csv"):
                self.assertEqual((Path(t) / name).read_bytes(), (FIX / name).read_bytes(), name)


class Geometry(unittest.TestCase):
    def test_areas_and_bands(self):
        by = {d.key: d for d in dams()}
        self.assertAlmostEqual(by["A"].area_m2, 100_000, delta=50)
        self.assertEqual([by[k].band for k in "ABC"], ["> 6.25 ha", "1–6.25 ha", "< 1 ha"])
        self.assertEqual(st.size_band(1.0), "1–6.25 ha")
        self.assertEqual(st.size_band(6.25), "> 6.25 ha")

    def test_inside_even_odd_with_a_hole(self):
        outer = [(0, 0), (10, 0), (10, 10), (0, 10)]
        hole = [(4, 4), (6, 4), (6, 6), (4, 6)]
        self.assertTrue(st.inside(2, 2, [outer, hole]))
        self.assertFalse(st.inside(5, 5, [outer, hole]))
        self.assertFalse(st.inside(11, 5, [outer, hole]))

    def test_overlap_share(self):
        dam = [(0, 0), (1, 0), (1, 1), (0, 1)]
        self.assertAlmostEqual(st.overlap_share(dam, [[(-1, -1), (2, -1), (2, 2), (-1, 2)]]), 1.0)
        self.assertAlmostEqual(st.overlap_share(dam, [[(0.5, -1), (2, -1), (2, 2), (0.5, 2)]]), 0.5, delta=0.03)
        self.assertEqual(st.overlap_share(dam, [[(5, 5), (6, 5), (6, 6)]]), 0.0)


class Inputs(unittest.TestCase):
    def test_dams_csv(self):
        by = {d.key: d for d in dams()}
        self.assertEqual(by["A"].capacity_m3, 250_000)
        self.assertIsNone(by["C"].capacity_m3)
        self.assertEqual(len(by["A"].ring), 4)

    def test_bad_input_is_refused(self):
        with tempfile.TemporaryDirectory() as t:
            p = Path(t) / "d.csv"
            p.write_text("dam,lat\nA,1\n")
            with self.assertRaisesRegex(st.TrialError, "missing column"):
                st.read_dams(p)
            p.write_text("dam,lat,lon\nA,-40,0\nA,-40,0.001\n")
            with self.assertRaisesRegex(st.TrialError, "fewer than 3"):
                st.read_dams(p)
            p.write_text("dam,lat,lon\nA,-95,0\n")
            with self.assertRaisesRegex(st.TrialError, "out of range"):
                st.read_dams(p)


class Reader(unittest.TestCase):
    def test_a_prior_zip_reads_back(self):
        with tempfile.TemporaryDirectory() as t:
            g = granules()[0]
            p = Path(t) / f"{g['name']}.zip"
            write_prior_zip(p, g["rows"])
            rows = st.read_prior_zip(p)
        by = {r.lake_id: r for r in rows}
        self.assertEqual(set(by), {"L1", "L2", "L3"})
        l1 = by["L1"]
        self.assertEqual(l1.time, dt.datetime(2024, 1, 3, 10, 0, tzinfo=dt.UTC))
        self.assertAlmostEqual(l1.wse, g["rows"][0]["wse"])
        self.assertAlmostEqual(l1.area_m2, g["rows"][0]["area_total"] * 1e6, places=0)
        self.assertEqual(len(l1.rings), 1)
        # L3: in the PLD, not seen: no polygon, no time, the fill read as no height.
        self.assertEqual(by["L3"].rings, [])
        self.assertIsNone(by["L3"].time)
        self.assertIsNone(by["L3"].wse)

    def test_rows_outside_the_box_are_dropped_but_unseen_lakes_kept(self):
        with tempfile.TemporaryDirectory() as t:
            g = granules()[0]
            p = Path(t) / f"{g['name']}.zip"
            write_prior_zip(p, g["rows"])
            rows = st.read_prior_zip(p, within=(10, 10, 11, 11))
        self.assertEqual([r.lake_id for r in rows], ["L3"])


class Matching(unittest.TestCase):
    def test_dams_match_their_lakes_and_the_small_one_none(self):
        with tempfile.TemporaryDirectory() as t:
            passes = fixture_passes(Path(t))
        m = st.match_dams(dams(), st.lake_outlines(passes))
        self.assertEqual(m["A"][0], "L1")
        self.assertEqual(m["B"][0], "L2")
        self.assertIsNone(m["C"])  # no lake; L3 has no polygon to match

    def test_a_neighbour_below_the_overlap_threshold_is_no_match(self):
        dam = st.Dam("x", [(0, 0), (1, 0), (1, 1), (0, 1)])
        near = {"N": [[[(0.9, -1), (2, -1), (2, 2), (0.9, 2)]]]}
        self.assertIsNone(st.match_dams([dam], near)["x"])
        self.assertEqual(st.match_dams([dam], near, min_overlap=0.05)["x"][0], "N")


def mk(t: dt.datetime | None, wse=10.0, area=1000.0, **flags) -> st.Pass:
    f = {n: 0 for n in st.FLAGS}
    f.update(flags)
    return st.Pass("L", t, wse, area, f, [])


T = dt.datetime(2024, 3, 1, tzinfo=dt.UTC)


class Quality(unittest.TestCase):
    def test_each_flag_fails_a_pass(self):
        self.assertTrue(st.is_valid(mk(T)))
        for flag, bad in (("quality_f", 1), ("partial_f", 1), ("ice_clim_f", 1), ("ice_dyn_f", 2), ("xovr_cal_q", 2)):
            self.assertFalse(st.is_valid(mk(T, **{flag: bad})), flag)
        self.assertTrue(st.is_valid(mk(T, xovr_cal_q=1)))  # suspect calibration is kept
        self.assertFalse(st.is_valid(mk(T, quality_f=-1)))  # a missing flag fails
        self.assertFalse(st.is_valid(mk(None)))
        self.assertFalse(st.is_valid(mk(T, wse=None)))

    def test_fill_values_read_as_none(self):
        p = st.pass_from_record({"lake_id": "L", "time_str": "no_data", "wse": -999999999999.0, "area_total": -1e12, **{n: 0 for n in st.FLAGS}}, [])
        self.assertIsNone(p.wse)
        self.assertIsNone(p.area_m2)
        self.assertIsNone(p.time)

    def test_one_pass_in_two_granules_counts_once_oldest_first(self):
        later = T + dt.timedelta(days=3)
        got = st.valid_passes([mk(later), mk(T), mk(T), mk(T, quality_f=2)])
        self.assertEqual([p.time for p in got], [T, later])


class Pairing(unittest.TestCase):
    def test_prefer_observed_within_three_days_else_swot(self):
        ps = [mk(T, area=1170.0), mk(T + dt.timedelta(days=20), area=2340.0)]
        obs = [((T + dt.timedelta(days=3)).date(), 1000.0), ((T + dt.timedelta(days=24)).date(), 9.0)]
        self.assertEqual(st.pair_areas(ps, obs), [(10.0, 1000.0, "observed"), (10.0, 2340.0, "swot")])
        self.assertEqual(st.pair_areas(ps, obs, "observed"), [(10.0, 1000.0, "observed")])
        self.assertEqual(st.pair_areas(ps, obs, "swot"), [(10.0, 1170.0, "swot"), (10.0, 2340.0, "swot")])

    def test_the_nearest_observed_area_wins(self):
        obs = [((T - dt.timedelta(days=2)).date(), 1.0), ((T + dt.timedelta(days=1)).date(), 2.0)]
        self.assertEqual(st.pair_areas([mk(T)], obs)[0][1], 2.0)


class Fit(unittest.TestCase):
    def test_pava_pools_violators(self):
        # h(A) is fitted: the heights at areas 2 and 3 (3 and 2) pool to 2.5, one knot at their mean area.
        self.assertEqual(st.monotone_fit([(1, 1), (2, 3), (3, 2), (4, 4)]), [(1, 1), (2.5, 2.5), (4, 4)])
        self.assertEqual(st.monotone_fit([(1, 5), (2, 1)]), [(1.5, 3)])
        self.assertEqual(st.monotone_fit([(1, 2), (3, 2), (2, 5)]), [(2, 3.5)])  # heights at one area averaged first, then pooled
        self.assertEqual(st.monotone_fit([(9.9, 10), (10.1, 10), (10.9, 20), (11.1, 20)]), [(10.0, 10), (11.0, 20)])  # noise round a level cancels
        knots = st.monotone_fit([(h, math.sin(h)) for h in range(20)])
        self.assertTrue(all(a <= b for (_, a), (_, b) in zip(knots, knots[1:])))

    def test_integral_of_a_linear_area_is_exact(self):
        knots = [(0.0, 0.0), (5.0, 100.0)]  # A = 20 h
        self.assertAlmostEqual(st.integral(knots, 0, 5), 250.0)
        self.assertAlmostEqual(st.integral(knots, 2, 3), 50.0)
        self.assertAlmostEqual(st.integral(knots, 5, 6), 110.0)  # extended past the top: A(6) = 120

    def test_volume_is_anchored_at_capacity_at_full_area(self):
        # A = 20 000 (h − 100), full 100 000 m² at h = 105, V = 10 000 (h − 100)², C = 250 000.
        pairs = [(100 + d, 20_000 * d) for d in (2.0, 3.0, 4.0)]
        c = st.fit_curve(pairs, 100_000, 250_000)
        self.assertAlmostEqual(c.full_level, 105.0)
        self.assertTrue(c.extrapolated)  # the highest pass sat 1 m below full
        self.assertAlmostEqual(c.volume_at(105), 250_000)
        self.assertAlmostEqual(c.volume_at(102), 40_000)
        self.assertAlmostEqual(c.volume_at_area(50_000), 62_500)
        self.assertIsNone(c.volume_at_area(10_000))  # below the lowest pass: no extrapolation down
        table = c.table()
        self.assertEqual(table[-1]["levelM"], 105.0)
        self.assertTrue(all(a["volumeM3"] < b["volumeM3"] for a, b in zip(table, table[1:])))

    def test_too_few_levels_or_no_anchor(self):
        self.assertIsNone(st.fit_curve([(1, 1), (2, 2)], 10, 100))
        c = st.fit_curve([(1, 5), (2, 5), (3, 5)], 10, 100)  # flat: never reaches full
        self.assertIsNone(c.full_level)
        self.assertIsNone(c.volume_at(2))
        self.assertIsNone(st.fit_curve([(1, 1), (2, 2), (3, 3)], 10, None).volume_at(3))

    def test_survey_volume(self):
        pts = st.read_survey(FIX / "survey.csv")["A"]
        self.assertAlmostEqual(st.survey_volume_at(pts, 50_000), 62_500)
        self.assertAlmostEqual(st.survey_volume_at(pts, 100_000), 250_000)
        self.assertIsNone(st.survey_volume_at(pts, 200_000))


class RollOutliers(unittest.TestCase):
    def test_a_height_far_from_its_peers_at_one_area_is_dropped(self):
        pairs = [(10.0, 100.0, "s"), (10.1, 101.0, "s"), (9.9, 99.0, "s"), (12.5, 100.0, "s"), (11.0, 200.0, "s")]
        kept, dropped = st.drop_roll_outliers(pairs)
        self.assertEqual(dropped, 1)
        self.assertNotIn((12.5, 100.0, "s"), kept)
        self.assertIn((11.0, 200.0, "s"), kept)  # alone at its area: nothing to judge it by

    def test_one_peer_is_not_enough(self):
        self.assertEqual(st.drop_roll_outliers([(10.0, 100.0, "s"), (12.5, 100.0, "s")])[1], 0)


class Scatter(unittest.TestCase):
    def test_stable_pairs_and_roll_outliers(self):
        ps = [mk(T, wse=10.0), mk(T + dt.timedelta(days=2), wse=10.2), mk(T + dt.timedelta(days=30), wse=12.0), mk(T + dt.timedelta(days=32), wse=14.0), mk(T + dt.timedelta(days=60), wse=9.0), mk(T + dt.timedelta(days=62), wse=11.0)]
        areas = {p.time: 1000.0 for p in ps}
        areas[ps[5].time] = 2000.0  # the level moved: not a stable pair
        sigma, pairs, outliers = st.stable_scatter(ps, areas)
        self.assertEqual((pairs, outliers), (1, 1))
        self.assertAlmostEqual(sigma, 0.2 / math.sqrt(2))


class Analysis(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.passes = fixture_passes(Path(self.tmp.name))

    def tearDown(self):
        self.tmp.cleanup()

    def results(self, mode="prefer-observed"):
        observed = st.read_observed_areas(FIX / "observed-areas.csv")
        survey = st.read_survey(FIX / "survey.csv")
        return {r["dam"]: r for r in st.analyse(dams(), self.passes, START, END, observed, survey, mode)}

    def test_the_synthetic_dam_is_recovered_from_observed_areas(self):
        a = self.results()["A"]
        self.assertEqual(a["lakeId"], "L1")
        self.assertEqual(a["passes"], 24)
        self.assertEqual(a["validPasses"], 22)  # one partial, one without a height
        self.assertEqual(a["outliers"], 1)  # the roll error
        self.assertEqual(a["droppedFromFit"], 1)  # and it stays out of the fit
        self.assertAlmostEqual(a["sigmaM"], 0.16 / math.sqrt(2), places=6)
        self.assertEqual({p["source"] for p in a["pairs"]}, {"observed"})
        # ±0.08 m of noise; where a flagged pass leaves a level with one
        # side of it, that level's mean is off by up to 0.053 m, and 0.053 m
        # × ~100 000 m² is ~8.5 % of the 62 500 m³ at half area.
        self.assertLess(abs(a["survey"]["50"]["errPct"]), 8.5)
        self.assertAlmostEqual(a["survey"]["100"]["errPct"], 0, places=3)

    def test_swot_areas_run_high_and_the_fit_says_so(self):
        a = self.results("swot")["A"]
        self.assertEqual({p["source"] for p in a["pairs"]}, {"swot"})
        # 17 % high areas put each level's area too high: the fit finds full area too low and the volume at half area too high.
        self.assertGreater(abs(a["survey"]["50"]["errPct"]), abs(self.results()["A"]["survey"]["50"]["errPct"]) + 5)

    def test_flagged_and_unmatched_dams(self):
        r = self.results()
        self.assertEqual(r["B"]["validPasses"], 6)  # only the first three visits are good
        self.assertIsNone(r["C"]["lakeId"])
        self.assertEqual(r["C"]["band"], "< 1 ha")

    def test_summary_has_no_dam_keys_ids_or_coordinates(self):
        rows = st.summarise(list(self.results().values()))
        by = {r["band"]: r for r in rows}
        self.assertEqual((by["< 1 ha"]["dams"], by["< 1 ha"]["inPld"]), (1, 0))
        self.assertEqual(by["< 1 ha"]["verdict"]["pld"], "fail")
        self.assertEqual(by["> 6.25 ha"]["verdict"]["pld"], "pass")
        self.assertEqual(by["> 6.25 ha"]["verdict"]["passes"], "pass")
        self.assertEqual(by["> 6.25 ha"]["verdict"]["volume"], "no data")  # one survey dam, the bar wants 3
        md = st.summary_markdown(rows, START, END, 25, "prefer-observed", accessed=dt.date(2026, 11, 25))
        for leak in ("-40", "0.0018", "-39.99", "SWOT_L2_HR_LakeSP_Prior_0", "| A "):
            self.assertNotIn(leak, md)
        self.assertNotRegex(md, r"\bL[123]\b")  # no lake id
        self.assertIn("SWOT LakeSP vD, NASA/CNES, PO.DAAC", md)
        self.assertIn(
            "Data: SWOT. (2025). SWOT Level 2 Lake Single-Pass Vector Data Product [Data set]. "
            "NASA Physical Oceanography Distributed Active Archive Center. https://doi.org/10.5067/SWOT-LAKESP-D "
            "Date accessed: 2026-11-25.",
            md,
        )


# --- the network ------------------------------------------------------------------


class FakeRes(io.BytesIO):
    def __init__(self, url, body, status=200):
        super().__init__(body)
        self.status = status
        self.url = url
        self.headers = {"Content-Length": str(len(body))}

    def geturl(self):
        return self.url


class FakeArchive:
    """CMR and the SWOT archive: records each request and its headers."""

    def __init__(self, zips: dict[str, bytes], refuse: int | None = None, items: list | None = None):
        self.zips = zips
        self.refuse = refuse
        self.items = items
        self.seen: list[tuple[str, dict]] = []

    def __call__(self, req, timeout=None):
        headers = {k.lower(): v for k, v in req.header_items()}
        self.seen.append((req.full_url, headers))
        u = urllib.parse.urlparse(req.full_url)
        if u.hostname == "cmr.earthdata.nasa.gov":
            items = self.items if self.items is not None else [{"umm": {"GranuleUR": n, "RelatedUrls": [{"Type": "GET DATA", "URL": f"https://{st.ARCHIVE_HOST}/lakesp/{n}.zip"}]}} for n in self.zips]
            return FakeRes(req.full_url, json.dumps({"hits": len(items), "items": items}).encode())
        if self.refuse:
            raise urllib.error.HTTPError(req.full_url, self.refuse, "no", {}, io.BytesIO(b""))
        return FakeRes(req.full_url, self.zips[Path(u.path).stem])


def client_for(fake, **kw) -> polite.PoliteClient:
    clock = [0.0]
    sleeps = []

    def sleep(s):
        sleeps.append(s)
        clock[0] += s

    c = st.make_client("synthetic-token", fake, clock=lambda: clock[0], sleep=sleep, **kw)
    c.sleeps = sleeps
    return c


class Network(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        tmp = Path(self.tmp.name)
        self.zips = {}
        for g in granules()[:3]:
            p = tmp / f"{g['name']}.zip"
            write_prior_zip(p, g["rows"])
            self.zips[g["name"]] = p.read_bytes()
        self.cache = tmp / "cache"
        self.cache.mkdir()

    def tearDown(self):
        self.tmp.cleanup()

    def test_search_asks_for_prior_granules_without_the_token(self):
        fake = FakeArchive(self.zips)
        c = client_for(fake)
        got = st.search(c, (0, -41, 1, -39), START, END)
        self.assertEqual([g.name for g in got], sorted(self.zips))
        url, headers = fake.seen[0]
        q = urllib.parse.parse_qs(urllib.parse.urlparse(url).query)
        self.assertEqual(q["short_name"], [st.SHORT_NAME])
        self.assertEqual(q["readable_granule_name[]"], ["SWOT_L2_HR_LakeSP_Prior_*"])
        self.assertEqual(q["bounding_box"], ["0.0000,-41.0000,1.0000,-39.0000"])
        self.assertNotIn("authorization", headers)
        self.assertIn("water-management-ingest", headers["user-agent"])

    def test_downloads_send_the_token_to_the_archive_only_paced_and_cached(self):
        fake = FakeArchive(self.zips)
        c = client_for(fake)
        gs = st.search(c, (0, -41, 1, -39), START, END)
        for g in gs:
            st.download(c, g, self.cache)
        downloads = fake.seen[1:]
        self.assertEqual(len(downloads), 3)
        self.assertTrue(all(h.get("authorization") == "Bearer synthetic-token" for _, h in downloads))
        self.assertEqual(len(c.sleeps), 3)  # one request a second, none at once
        self.assertTrue(all(s <= 1.0 for s in c.sleeps))
        self.assertEqual(sorted(p.name for p in self.cache.iterdir()), sorted(f"{n}.zip" for n in self.zips))
        st.download(c, gs[0], self.cache)  # cached: no request
        self.assertEqual(len(fake.seen), 4)

    def test_a_403_or_401_stops_the_run_with_no_retry(self):
        for status in (401, 403):
            fake = FakeArchive(self.zips, refuse=status)
            c = client_for(fake)
            g = st.search(c, (0, -41, 1, -39), START, END)[0]
            with self.assertRaises(polite.StopRun):
                st.download(c, g, self.cache)
            self.assertEqual(len(fake.seen), 2, status)
            self.assertFalse(list(self.cache.glob("*.zip")))

    def test_a_download_link_off_the_archive_is_refused(self):
        items = [{"umm": {"GranuleUR": "SWOT_L2_HR_LakeSP_Prior_001_001_AF_x", "RelatedUrls": [{"Type": "GET DATA", "URL": "https://elsewhere.example/x.zip"}]}}]
        with self.assertRaisesRegex(st.TrialError, "no https download"):
            st.search(client_for(FakeArchive({}, items=items)), (0, 0, 1, 1), START, END)

    def test_obs_and_unassigned_granules_are_skipped(self):
        items = [{"umm": {"GranuleUR": "SWOT_L2_HR_LakeSP_Obs_001_001_AF_x", "RelatedUrls": []}}]
        self.assertEqual(st.parse_search(json.dumps({"hits": 1, "items": items}).encode()), (1, []))

    def test_the_token_comes_from_the_environment_and_is_never_echoed(self):
        self.assertEqual(st.read_token({"EARTHDATA_TOKEN": " abc.def.ghi \n"}), "abc.def.ghi")
        for env in ({}, {"EARTHDATA_TOKEN": ""}, {"EARTHDATA_TOKEN": '{"username": "u", "password": "secret-pw"}'}):
            with self.assertRaises(st.TrialError) as cm:
                st.read_token(env)
            self.assertNotIn("secret-pw", str(cm.exception))
        self.assertNotIn("synthetic-token", repr(client_for(FakeArchive({})).opener))


class Command(unittest.TestCase):
    def test_outputs_stay_under_data(self):
        with self.assertRaisesRegex(st.TrialError, "data/"):
            st.under_data(Path(tempfile.gettempdir()) / "swot")
        self.assertTrue(st.under_data(st.DATA_DIR / "swot-trial").is_relative_to(st.DATA_DIR))

    def test_a_run_end_to_end_against_the_fake_archive(self):
        with tempfile.TemporaryDirectory() as t:
            zips = {}
            for g in granules():
                p = Path(t) / f"{g['name']}.zip"
                write_prior_zip(p, g["rows"])
                zips[g["name"]] = p.read_bytes()
            out = st.DATA_DIR / f"swot-trial-test-{Path(t).name}"
            try:
                args = st.parse_args(["--dams", str(FIX / "dams.csv"), "--observed-areas", str(FIX / "observed-areas.csv"), "--survey", str(FIX / "survey.csv"), "--start", "2024-01-01", "--end", "2024-12-31", "--out", str(out)])
                res = st.run(args, client_for(FakeArchive(zips)))
                self.assertEqual(res["granules"], len(zips))
                per_dam = json.loads((out / "dams.json").read_text())
                self.assertEqual({d["dam"] for d in per_dam["dams"]}, {"A", "B", "C"})
                md = (out / "summary.md").read_text()
                self.assertIn("| > 6.25 ha | 1 | 1 (100 %)", md)
                self.assertNotIn("L1", md)
            finally:
                if out.exists():
                    for p in sorted(out.rglob("*"), reverse=True):
                        p.unlink() if p.is_file() else p.rmdir()
                    out.rmdir()


if __name__ == "__main__":
    unittest.main()
