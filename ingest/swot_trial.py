"""The SWOT lake height trial (issue #625, step 2): does SWOT measure our dams?

Run once, by the operator, never by the app or the Lambda image
(ingest/README.md § The SWOT lake height trial):

    EARTHDATA_TOKEN=… INGEST_CONTACT=… ingest/dev.sh swot --dams data/swot-trial/dams.csv \
        [--observed-areas data/swot-trial/areas.csv] [--survey data/swot-trial/survey.csv]

1. **Search.** CMR (cmr.earthdata.nasa.gov, no sign-in) for the
   `SWOT_L2_HR_LakeSP_D` **Prior** granules over the dams' bounding box from
   2023-07 on (one zipped shapefile a pass and continent, ~2 MB).
2. **Download** each over HTTPS from `archive.swot.podaac.earthdata.nasa.gov`
   with the operator's Earthdata Login bearer token, read from the
   `EARTHDATA_TOKEN` environment variable: sent to that host only, never on
   a redirect (imerg.EarthdataOpener), never logged. Everything goes through
   polite.PoliteClient: the ingest User-Agent with `INGEST_CONTACT`, one
   request a second, one at a time; a 401 or 403 stops the run with no retry
   (docs/data-sources.md § swot-lakesp). Zips are cached under the output
   directory, so a rerun asks only for new passes.
3. **Match** each dam outline to a Prior Lake Database lake by overlap (the
   share of the dam's area inside the lake's observed polygon). Dams with no
   lake are recorded with their size band. A PLD lake SWOT never observed
   over the period has no polygon in a Prior granule, so it counts as
   unmatched too (the trial measures what SWOT gives us, not the PLD).
4. **Filter** each matched lake's passes on the quality flags (FLAGS).
5. **Pair** each height with an area: an observed area (WOfS/S2, the
   optional `--observed-areas` CSV) within ±3 days when there is one, else
   SWOT's own `area_total` (`--area` picks).
6. **Fit** a monotone A(h) (pool-adjacent-violators on h(A), since the
   height carries the error; a height more than 1 m
   from the others at the same area is dropped as a roll error first) and **integrate** it to
   V(h), anchored at the capacity at the full area (the dam outline's).
7. **Score** what the acceptance criteria ask, by size band (< 1, 1–6.25,
   > 6.25 ha): share in the PLD, valid passes a year, WSE scatter on
   stable-level pass pairs (σ) and the roll-error outliers, and fitted vs
   surveyed volume at 50 % and 100 % of the full area (`--survey`).

Outputs: per-dam results (`dams.json`) under the gitignored `data/` only (the
script refuses anywhere else), and `summary.md`, aggregates by band with no
dam key, name, coordinate or lake id, which is what goes into
`docs/spikes/604-swot-trial.md` (step 3).

Input CSVs carry opaque dam keys and lat/lon only:

- dams: `dam,lat,lon[,capacity_m3]`, one row per outline vertex, in ring
  order; `capacity_m3` on any of a dam's rows (the first non-empty wins).
- observed areas: `dam,date,area_m2` (date YYYY-MM-DD).
- survey: `dam,area_m2,volume_m3`, one row per point of a survey curve.

Pure Python but for pyshp (`requirements-trial.txt`, imported only to read a
zip), so matching, filtering, the fit and the scores test without it.
"""

from __future__ import annotations

import argparse
import csv
import dataclasses
import datetime as dt
import json
import logging
import math
import os
import statistics
import sys
import urllib.parse
from pathlib import Path
from typing import Iterable

import earthdata
import imerg
import polite

log = logging.getLogger("ingest")

HERE = Path(__file__).resolve().parent
REPO = HERE.parent
DATA_DIR = REPO / "data"
DEFAULT_OUT = DATA_DIR / "swot-trial"

SHORT_NAME = "SWOT_L2_HR_LakeSP_D"
# The short credit and the dataset's own citation, verbatim from its DOI landing page's
# APA style (docs/data-sources.md § swot-lakesp, read 2026-11-25); the summary adds the access date.
CREDIT = "SWOT LakeSP vD, NASA/CNES, PO.DAAC"
CITATION = (
    "SWOT. (2025). SWOT Level 2 Lake Single-Pass Vector Data Product [Data set]. "
    "NASA Physical Oceanography Distributed Active Archive Center. https://doi.org/10.5067/SWOT-LAKESP-D"
)
PRIOR_PATTERN = "SWOT_L2_HR_LakeSP_Prior_*"
CMR_SEARCH = imerg.CMR_SEARCH
ARCHIVE_HOST = "archive.swot.podaac.earthdata.nasa.gov"
TOKEN_ENV = "EARTHDATA_TOKEN"
PAGE_SIZE = 2000
#: The science orbit's first full month (the fast-sampling phase before it is left out).
DEFAULT_START = dt.date(2023, 7, 1)

#: LakeSP's float fill value; anything at or below it is no data.
FILL = -999999999999.0
#: The quality flags a pass must clear (LakeSP vD's attribute names). `quality_f`:
#: 0 good, 1 suspect, 2 degraded, 3 bad; `partial_f`: 1 when the lake is only
#: partly in the swath; the ice flags: 0 no ice; `xovr_cal_q`: crossover
#: calibration quality, 0 good, 1 suspect, 2 bad.
FLAGS = {"quality_f": 0, "partial_f": 0, "ice_clim_f": 0, "ice_dyn_f": 0, "xovr_cal_q": 1}
#: Pairs an observed area within this many days of the pass.
PAIR_DAYS = 3
#: Two valid passes this close in time, with areas within STABLE_AREA of each
#: other, sit on a stable level: their height difference is measurement scatter.
STABLE_DAYS = 5
STABLE_AREA = 0.05
#: A stable-pair height difference beyond this is a roll error, not scatter.
OUTLIER_M = 1.0
#: The share of a dam's outline that must lie inside a lake to match it.
MIN_OVERLAP = 0.3

#: (label, lower ha inclusive, upper ha exclusive)
BANDS = (("< 1 ha", 0.0, 1.0), ("1–6.25 ha", 1.0, 6.25), ("> 6.25 ha", 6.25, math.inf))
#: The graduation bar, per band (issue #625 § Acceptance criteria).
BAR = {"pld_share": 0.70, "passes_per_year": 8.0, "sigma_m": 0.30, "volume_err_pct": 15.0, "survey_dams": 3}

EARTH_R = 6371008.8


class TrialError(RuntimeError):
    """Bad input, a refused path or an unexpected answer: stop with this message."""


# --- geometry (local equirectangular metres; dams are a few hundred metres across) ---

Ring = list[tuple[float, float]]  # (lon, lat)


def _xy(ring: Ring, lat0: float) -> list[tuple[float, float]]:
    k = math.pi / 180 * EARTH_R
    c = math.cos(math.radians(lat0))
    return [(lon * k * c, lat * k) for lon, lat in ring]


def ring_area_m2(ring: Ring) -> float:
    """The area of one ring in m² (shoelace in a local projection)."""
    if len(ring) < 3:
        return 0.0
    lat0 = sum(p[1] for p in ring) / len(ring)
    pts = _xy(ring, lat0)
    s = 0.0
    for (x1, y1), (x2, y2) in zip(pts, pts[1:] + pts[:1]):
        s += x1 * y2 - x2 * y1
    return abs(s) / 2


def inside(lon: float, lat: float, rings: list[Ring]) -> bool:
    """Even-odd over every ring, so holes and multipart lakes come out right."""
    hit = False
    for ring in rings:
        n = len(ring)
        for i in range(n):
            x1, y1 = ring[i]
            x2, y2 = ring[(i + 1) % n]
            if (y1 > lat) != (y2 > lat) and lon < x1 + (lat - y1) * (x2 - x1) / (y2 - y1):
                hit = not hit
    return hit


def bbox(rings: Iterable[Ring]) -> tuple[float, float, float, float]:
    pts = [p for r in rings for p in r]
    return (min(p[0] for p in pts), min(p[1] for p in pts), max(p[0] for p in pts), max(p[1] for p in pts))


def _boxes_meet(a, b) -> bool:
    return a[0] <= b[2] and b[0] <= a[2] and a[1] <= b[3] and b[1] <= a[3]


def overlap_share(dam: Ring, lake: list[Ring], samples: int = 40) -> float:
    """The share of the dam's area inside the lake: a samples × samples grid
    over the dam's box, counting the points inside the dam that are also
    inside the lake. Coarse, but enough to tell a match from a neighbour."""
    if not _boxes_meet(bbox([dam]), bbox(lake)):
        return 0.0
    w, s, e, n = bbox([dam])
    total = hit = 0
    for i in range(samples):
        lat = s + (i + 0.5) * (n - s) / samples
        for j in range(samples):
            lon = w + (j + 0.5) * (e - w) / samples
            if inside(lon, lat, [dam]):
                total += 1
                if inside(lon, lat, lake):
                    hit += 1
    return hit / total if total else 0.0


def size_band(area_ha: float) -> str:
    for label, lo, hi in BANDS:
        if lo <= area_ha < hi:
            return label
    raise ValueError(f"no band for {area_ha} ha")


# --- inputs ---------------------------------------------------------------------


@dataclasses.dataclass
class Dam:
    key: str
    ring: Ring
    capacity_m3: float | None = None

    @property
    def area_m2(self) -> float:
        return ring_area_m2(self.ring)

    @property
    def band(self) -> str:
        return size_band(self.area_m2 / 10_000)


def _float(value: str, what: str) -> float:
    try:
        x = float(value)
    except (TypeError, ValueError):
        raise TrialError(f"{what}: {value!r} is not a number") from None
    if not math.isfinite(x):
        raise TrialError(f"{what}: {value!r} is not finite")
    return x


def _rows(path: Path, need: set[str]) -> list[dict]:
    with open(path, newline="", encoding="utf-8") as f:
        reader = csv.DictReader(f)
        missing = need - set(reader.fieldnames or [])
        if missing:
            raise TrialError(f"{path.name}: missing column(s) {sorted(missing)}")
        return list(reader)


def read_dams(path: Path) -> list[Dam]:
    dams: dict[str, Dam] = {}
    for i, row in enumerate(_rows(path, {"dam", "lat", "lon"}), start=2):
        key = (row["dam"] or "").strip()
        if not key:
            raise TrialError(f"{path.name} line {i}: empty dam key")
        lat, lon = _float(row["lat"], f"{path.name} line {i} lat"), _float(row["lon"], f"{path.name} line {i} lon")
        if not (-90 <= lat <= 90 and -180 <= lon <= 180):
            raise TrialError(f"{path.name} line {i}: lat/lon out of range")
        d = dams.setdefault(key, Dam(key, []))
        d.ring.append((lon, lat))
        cap = (row.get("capacity_m3") or "").strip()
        if cap and d.capacity_m3 is None:
            d.capacity_m3 = _float(cap, f"{path.name} line {i} capacity_m3")
            if d.capacity_m3 <= 0:
                raise TrialError(f"{path.name} line {i}: capacity_m3 must be positive")
    for d in dams.values():
        if len(d.ring) > 1 and d.ring[0] == d.ring[-1]:
            d.ring.pop()
        if len(d.ring) < 3 or d.area_m2 <= 0:
            raise TrialError(f"{path.name}: a dam's outline has fewer than 3 distinct vertices")
    if not dams:
        raise TrialError(f"{path.name}: no dams")
    return list(dams.values())


def read_observed_areas(path: Path) -> dict[str, list[tuple[dt.date, float]]]:
    out: dict[str, list[tuple[dt.date, float]]] = {}
    for i, row in enumerate(_rows(path, {"dam", "date", "area_m2"}), start=2):
        try:
            day = dt.date.fromisoformat(row["date"].strip())
        except ValueError:
            raise TrialError(f"{path.name} line {i}: date must be YYYY-MM-DD") from None
        area = _float(row["area_m2"], f"{path.name} line {i} area_m2")
        if area < 0:
            raise TrialError(f"{path.name} line {i}: negative area")
        out.setdefault(row["dam"].strip(), []).append((day, area))
    return out


def read_survey(path: Path) -> dict[str, list[tuple[float, float]]]:
    out: dict[str, list[tuple[float, float]]] = {}
    for i, row in enumerate(_rows(path, {"dam", "area_m2", "volume_m3"}), start=2):
        a = _float(row["area_m2"], f"{path.name} line {i} area_m2")
        v = _float(row["volume_m3"], f"{path.name} line {i} volume_m3")
        out.setdefault(row["dam"].strip(), []).append((a, v))
    for pts in out.values():
        pts.sort()
    return out


# --- LakeSP records ---------------------------------------------------------------


@dataclasses.dataclass
class Pass:
    """One Prior-lake row of one granule."""

    lake_id: str
    time: dt.datetime | None
    wse: float | None
    area_m2: float | None  # area_total, km² in the file
    flags: dict[str, int]
    rings: list[Ring]
    granule: str = ""


def _num(value) -> float | None:
    try:
        x = float(value)
    except (TypeError, ValueError):
        return None
    return None if not math.isfinite(x) or x <= FILL else x


def _time(value) -> dt.datetime | None:
    text = str(value or "").strip()
    if not text or text.lower() == "no_data":
        return None
    try:
        t = dt.datetime.fromisoformat(text.replace("Z", "+00:00"))
    except ValueError:
        return None
    return t if t.tzinfo else t.replace(tzinfo=dt.UTC)


def pass_from_record(attrs: dict, rings: list[Ring], granule: str = "") -> Pass:
    """A Pass from one shapefile record's attributes (LakeSP vD names) and rings."""
    flags = {}
    for name in FLAGS:
        v = _num(attrs.get(name))
        flags[name] = int(v) if v is not None else -1
    area_km2 = _num(attrs.get("area_total"))
    return Pass(
        lake_id=str(attrs.get("lake_id", "")).strip(),
        time=_time(attrs.get("time_str")),
        wse=_num(attrs.get("wse")),
        area_m2=None if area_km2 is None else area_km2 * 1e6,
        flags=flags,
        rings=rings,
        granule=granule,
    )


def read_prior_zip(path: Path, within: tuple[float, float, float, float] | None = None) -> list[Pass]:
    """The rows of one Prior granule (a zipped shapefile), keeping those whose
    shape meets `within` (lon/lat box) and, without geometry, all of them
    (a lake not observed on this pass: no polygon, no height)."""
    import shapefile  # pyshp, requirements-trial.txt

    out = []
    with shapefile.Reader(str(path)) as r:
        names = [f[0] for f in r.fields[1:]]
        for sr in r.iterShapeRecords():
            attrs = dict(zip(names, sr.record))
            shape = sr.shape
            rings: list[Ring] = []
            if shape.shapeType != shapefile.NULL and shape.points:
                if within is not None and not _boxes_meet(tuple(shape.bbox), within):
                    continue
                parts = list(shape.parts) + [len(shape.points)]
                rings = [[(float(x), float(y)) for x, y in shape.points[a:b]] for a, b in zip(parts, parts[1:])]
            out.append(pass_from_record(attrs, rings, path.name))
    return out


# --- 1. matching ------------------------------------------------------------------


def lake_outlines(passes: Iterable[Pass]) -> dict[str, list[list[Ring]]]:
    """Every observed polygon of each lake, by lake_id."""
    out: dict[str, list[list[Ring]]] = {}
    for p in passes:
        if p.lake_id and p.rings:
            out.setdefault(p.lake_id, []).append(p.rings)
    return out


def match_dams(dams: list[Dam], outlines: dict[str, list[list[Ring]]], min_overlap: float = MIN_OVERLAP) -> dict[str, tuple[str, float] | None]:
    """dam key → (lake_id, overlap share) of the lake covering most of it, or None."""
    out: dict[str, tuple[str, float] | None] = {}
    for d in dams:
        best: tuple[str, float] | None = None
        for lake_id, polys in outlines.items():
            share = max(overlap_share(d.ring, rings) for rings in polys)
            if share >= min_overlap and (best is None or share > best[1]):
                best = (lake_id, share)
        out[d.key] = best
    return out


# --- 2. quality ----------------------------------------------------------------------


def is_valid(p: Pass, flags: dict[str, int] = FLAGS) -> bool:
    """Has a time and a height, and clears every flag (each at or below its limit; a missing flag fails)."""
    if p.time is None or p.wse is None:
        return False
    return all(0 <= p.flags.get(name, -1) <= limit for name, limit in flags.items())


def valid_passes(passes: Iterable[Pass], flags: dict[str, int] = FLAGS) -> list[Pass]:
    """The valid ones, one per observation time (a pass seen in two granules counts once), oldest first."""
    seen: dict[dt.datetime, Pass] = {}
    for p in passes:
        if is_valid(p, flags):
            seen.setdefault(p.time, p)
    return [seen[t] for t in sorted(seen)]


# --- 3. pairing ----------------------------------------------------------------------


def pair_areas(passes: list[Pass], observed: list[tuple[dt.date, float]] | None, mode: str = "prefer-observed", days: int = PAIR_DAYS) -> list[tuple[float, float, str]]:
    """(wse, area m², source) per pass. `mode`: prefer-observed (the nearest
    observed area within ±days, else SWOT's area_total), observed, or swot."""
    if mode not in ("prefer-observed", "observed", "swot"):
        raise ValueError(mode)
    out = []
    for p in passes:
        obs = None
        if mode != "swot" and observed:
            day = p.time.date()
            near = [(abs((d - day).days), a) for d, a in observed if abs((d - day).days) <= days]
            if near:
                obs = min(near)[1]
        if obs is not None:
            out.append((p.wse, obs, "observed"))
        elif mode != "observed" and p.area_m2 is not None:
            out.append((p.wse, p.area_m2, "swot"))
    return out


# --- 4. the fit and the integral ------------------------------------------------------


def monotone_fit(pairs: Iterable[tuple[float, float]]) -> list[tuple[float, float]]:
    """A monotone A(h) as (h, A) knots, h strictly increasing, A non-decreasing.

    The height carries SWOT's error and the area is the better-known value,
    so it fits h(A) non-decreasing by pool-adjacent-violators (least squares,
    equal weights, heights at one area pooled to their mean) and inverts it;
    knots that end at one height merge to their mean area. Fitting A on h
    instead turns each pair of noisy heights at one level into a flat step,
    which biases the integral by the noise times the area."""
    by_a: dict[float, list[float]] = {}
    for h, a in pairs:
        by_a.setdefault(a, []).append(h)
    stack: list[list] = []  # [mean h, weight, areas]
    for a, hs in sorted(by_a.items()):
        stack.append([sum(hs) / len(hs), len(hs), [a]])
        while len(stack) > 1 and stack[-2][0] > stack[-1][0]:
            m2, w2, a2 = stack.pop()
            m1, w1, a1 = stack.pop()
            stack.append([(m1 * w1 + m2 * w2) / (w1 + w2), w1 + w2, a1 + a2])
    merged: list[tuple[float, list[float]]] = []
    for h, _, areas in stack:
        if merged and merged[-1][0] == h:
            merged[-1][1].extend(areas)
        else:
            merged.append((h, list(areas)))
    return [(h, sum(areas) / len(areas)) for h, areas in merged]


def area_at(knots: list[tuple[float, float]], h: float) -> float:
    """A(h), linear between knots and extended linearly past the top (never below 0)."""
    if h <= knots[0][0]:
        return knots[0][1]
    for (h1, a1), (h2, a2) in zip(knots, knots[1:]):
        if h <= h2:
            return a1 + (a2 - a1) * (h - h1) / (h2 - h1)
    if len(knots) > 1:
        (h1, a1), (h2, a2) = knots[-2], knots[-1]
        return max(0.0, a2 + (a2 - a1) * (h - h2) / (h2 - h1))
    return knots[-1][1]


def level_at(knots: list[tuple[float, float]], area: float) -> tuple[float, bool] | None:
    """The lowest h with A(h) = area, and whether it was extrapolated past the
    top knot. None below the lowest fitted area or when A stops rising."""
    if area < knots[0][1]:
        return None
    for (h1, a1), (h2, a2) in zip(knots, knots[1:]):
        if a1 <= area <= a2 and a2 > a1:
            return h1 + (h2 - h1) * (area - a1) / (a2 - a1), False
        if area == a1:
            return h1, False
    if area == knots[-1][1]:
        return knots[-1][0], False
    for (h1, a1), (h2, a2) in reversed(list(zip(knots, knots[1:]))):
        if a2 > a1:
            slope = (a2 - a1) / (h2 - h1)
            return knots[-1][0] + (area - knots[-1][1]) / slope, True
    return None


def integral(knots: list[tuple[float, float]], lo: float, hi: float) -> float:
    """∫ A(h) dh from lo to hi (lo ≤ hi), exact for the piecewise-linear A."""
    if hi <= lo:
        return 0.0
    cuts = sorted({lo, hi, *(h for h, _ in knots if lo < h < hi)})
    return sum((b - a) * (area_at(knots, a) + area_at(knots, b)) / 2 for a, b in zip(cuts, cuts[1:]))


@dataclasses.dataclass
class Curve:
    knots: list[tuple[float, float]]  # (h, A) fitted
    full_level: float | None  # h where A reaches the full area
    extrapolated: bool  # full_level lies above the highest pass
    capacity_m3: float | None

    def volume_at(self, h: float) -> float | None:
        """V(h) = capacity − ∫_h^full A: the volume anchored at the capacity at full area."""
        if self.full_level is None or self.capacity_m3 is None:
            return None
        if h >= self.full_level:
            return self.capacity_m3 + integral(self.knots, self.full_level, h)
        return self.capacity_m3 - integral(self.knots, h, self.full_level)

    def volume_at_area(self, area: float) -> float | None:
        hit = level_at(self.knots, area)
        return None if hit is None else self.volume_at(hit[0])

    def table(self) -> list[dict]:
        hs = [h for h, _ in self.knots if self.full_level is None or h <= self.full_level]
        if self.full_level is not None and self.full_level not in hs:
            hs.append(self.full_level)
        return [{"levelM": h, "areaM2": area_at(self.knots, h), "volumeM3": self.volume_at(h)} for h in sorted(hs)]


def fit_curve(pairs: list[tuple[float, float]], full_area_m2: float, capacity_m3: float | None, min_pairs: int = 3) -> Curve | None:
    if len({h for h, _ in pairs}) < min_pairs:
        return None
    knots = monotone_fit(pairs)
    hit = level_at(knots, full_area_m2)
    if hit is None and full_area_m2 < knots[0][1]:
        hit = (knots[0][0], False)  # every pass at least as wide as the outline: full at the lowest
    return Curve(knots, hit[0] if hit else None, hit[1] if hit else False, capacity_m3)


def survey_volume_at(points: list[tuple[float, float]], area: float) -> float | None:
    """The survey curve's volume at `area`, linear between its points; None outside them."""
    for (a1, v1), (a2, v2) in zip(points, points[1:]):
        if a1 <= area <= a2:
            return v1 if a2 == a1 else v1 + (v2 - v1) * (area - a1) / (a2 - a1)
    if points and math.isclose(area, points[-1][0], rel_tol=0.01):  # the outline vs the survey's full area
        return points[-1][1]
    return None


# --- 5. scatter on a stable level ------------------------------------------------------


def stable_scatter(passes: list[Pass], areas: dict[dt.datetime, float], days: int = STABLE_DAYS, area_tol: float = STABLE_AREA, outlier_m: float = OUTLIER_M) -> tuple[float | None, int, int]:
    """(σ, stable pairs, roll-error outliers). Consecutive valid passes within
    `days` whose paired areas differ by under `area_tol` sit on one level, so
    their height difference d is scatter: σ = √(mean d² / 2) over the pairs
    with |d| ≤ outlier_m; the rest are counted as roll-error outliers."""
    diffs = []
    for a, b in zip(passes, passes[1:]):
        if (b.time - a.time) > dt.timedelta(days=days):
            continue
        aa, ab = areas.get(a.time), areas.get(b.time)
        if aa is None or ab is None or max(aa, ab) <= 0 or abs(aa - ab) / max(aa, ab) >= area_tol:
            continue
        diffs.append(b.wse - a.wse)
    kept = [d for d in diffs if abs(d) <= outlier_m]
    sigma = math.sqrt(sum(d * d for d in kept) / (2 * len(kept))) if kept else None
    return sigma, len(kept), len(diffs) - len(kept)


def drop_roll_outliers(pairs: list[tuple[float, float, str]], area_tol: float = STABLE_AREA, outlier_m: float = OUTLIER_M) -> tuple[list[tuple[float, float, str]], int]:
    """The pairs the fit keeps, and how many it dropped: a height more than
    `outlier_m` from the median of at least two other passes at the same area
    (within `area_tol`) is a roll error, which would bend A(h) for every level."""
    kept, dropped = [], 0
    for i, (h, a, src) in enumerate(pairs):
        peers = [h2 for j, (h2, a2, _) in enumerate(pairs) if j != i and max(a, a2) > 0 and abs(a - a2) / max(a, a2) < area_tol]
        if len(peers) >= 2 and abs(h - statistics.median(peers)) > outlier_m:
            dropped += 1
        else:
            kept.append((h, a, src))
    return kept, dropped


# --- the whole analysis ----------------------------------------------------------------


def analyse(dams: list[Dam], passes: list[Pass], start: dt.date, end: dt.date, observed: dict | None = None, survey: dict | None = None, area_mode: str = "prefer-observed", min_overlap: float = MIN_OVERLAP) -> list[dict]:
    """Per-dam results (dicts, for dams.json and summarise)."""
    observed, survey = observed or {}, survey or {}
    years = max((end - start).days + 1, 1) / 365.25
    matches = match_dams(dams, lake_outlines(passes), min_overlap)
    by_lake: dict[str, list[Pass]] = {}
    for p in passes:
        by_lake.setdefault(p.lake_id, []).append(p)
    out = []
    for d in dams:
        r: dict = {"dam": d.key, "areaHa": d.area_m2 / 10_000, "band": d.band, "lakeId": None, "overlap": None, "passes": 0, "validPasses": 0, "validPerYear": 0.0, "sigmaM": None, "stablePairs": 0, "outliers": 0, "droppedFromFit": 0, "pairs": [], "curve": None, "fullLevelExtrapolated": None, "survey": None}
        m = matches[d.key]
        if m is None:
            out.append(r)
            continue
        lake_passes = by_lake.get(m[0], [])
        valid = valid_passes(lake_passes)
        r.update(lakeId=m[0], overlap=round(m[1], 3), passes=len({p.time for p in lake_passes if p.time}), validPasses=len(valid), validPerYear=len(valid) / years)
        areas: dict[dt.datetime, float] = {}
        paired = []
        for p in valid:
            one = pair_areas([p], observed.get(d.key), area_mode)
            if one:
                paired.append(one[0])
                areas[p.time] = one[0][1]
        r["pairs"] = [{"wseM": h, "areaM2": a, "source": s} for h, a, s in paired]
        r["sigmaM"], r["stablePairs"], r["outliers"] = stable_scatter(valid, areas)
        fit_pairs, r["droppedFromFit"] = drop_roll_outliers(paired)
        curve = fit_curve([(h, a) for h, a, _ in fit_pairs], d.area_m2, d.capacity_m3)
        if curve is not None:
            r["curve"] = curve.table()
            r["fullLevelExtrapolated"] = curve.extrapolated
            pts = survey.get(d.key)
            if pts:
                cmp = {}
                for frac in (0.5, 1.0):
                    a = frac * d.area_m2
                    fitted, surveyed = curve.volume_at_area(a), survey_volume_at(pts, a)
                    err = None if fitted is None or not surveyed else (fitted - surveyed) / surveyed * 100
                    cmp[f"{int(frac * 100)}"] = {"fittedM3": fitted, "surveyM3": surveyed, "errPct": err}
                r["survey"] = cmp
        out.append(r)
    return out


def _median(xs: list[float]) -> float | None:
    return statistics.median(xs) if xs else None


def summarise(results: list[dict]) -> list[dict]:
    """Aggregates per size band, with the graduation bar's verdicts. No dam keys."""
    rows = []
    for label, _, _ in BANDS:
        rs = [r for r in results if r["band"] == label]
        matched = [r for r in rs if r["lakeId"] is not None]
        sigmas = [r["sigmaM"] for r in matched if r["sigmaM"] is not None]
        e50 = [abs(r["survey"]["50"]["errPct"]) for r in matched if r["survey"] and r["survey"]["50"]["errPct"] is not None]
        e100 = [abs(r["survey"]["100"]["errPct"]) for r in matched if r["survey"] and r["survey"]["100"]["errPct"] is not None]
        row = {
            "band": label,
            "dams": len(rs),
            "inPld": len(matched),
            "pldShare": len(matched) / len(rs) if rs else None,
            "medianValidPerYear": _median([r["validPerYear"] for r in matched]),
            "medianSigmaM": _median(sigmas),
            "damsWithSigma": len(sigmas),
            "outliers": sum(r["outliers"] for r in matched),
            "stablePairs": sum(r["stablePairs"] for r in matched),
            "fitted": sum(1 for r in matched if r["curve"]),
            "surveyDams": len(e50),
            "medianErr50Pct": _median(e50),
            "medianErr100Pct": _median(e100),
        }
        row["verdict"] = verdict(row)
        rows.append(row)
    return rows


def verdict(row: dict) -> dict[str, str]:
    """pass / fail / no data per criterion of the bar."""

    def check(value, ok) -> str:
        return "no data" if value is None else ("pass" if ok(value) else "fail")

    errs = [x for x in (row["medianErr50Pct"], row["medianErr100Pct"]) if x is not None]
    # Too few survey dams is "no data", not a pass or a fail.
    worst = max(errs) if errs and row["surveyDams"] >= BAR["survey_dams"] else None
    return {
        "pld": check(row["pldShare"], lambda v: v >= BAR["pld_share"]),
        "passes": check(row["medianValidPerYear"], lambda v: v >= BAR["passes_per_year"]),
        "sigma": check(row["medianSigmaM"], lambda v: v <= BAR["sigma_m"]),
        "volume": check(worst, lambda v: v <= BAR["volume_err_pct"]),
    }


def _fmt(x, spec: str = ".2f", pct: bool = False) -> str:
    if x is None:
        return "–"
    return f"{x * 100:.0f} %" if pct else format(x, spec)


def summary_markdown(
    rows: list[dict], start: dt.date, end: dt.date, granules: int, area_mode: str, accessed: dt.date | None = None
) -> str:
    """The aggregate-only report: no dam key, name, coordinate or lake id."""
    accessed = accessed or dt.date.today()
    lines = [
        "# SWOT lake height trial: summary",
        "",
        f"{CREDIT} (`{SHORT_NAME}`, Prior granules), {start.isoformat()} to {end.isoformat()}: {granules} granules read. "
        f"Areas paired: {area_mode}. Aggregates by the dam outline's size band only (issue #625).",
        "",
        "| Band | Dams | In PLD | Valid passes / yr (median) | σ stable level, m (median; dams) | Roll outliers / stable pairs | Fitted | Survey dams | Volume err at 50 % / 100 % area (median abs) |",
        "|---|---|---|---|---|---|---|---|---|",
    ]
    for r in rows:
        lines.append(
            f"| {r['band']} | {r['dams']} | {r['inPld']} ({_fmt(r['pldShare'], pct=True)}) | {_fmt(r['medianValidPerYear'], '.1f')} | "
            f"{_fmt(r['medianSigmaM'])} ({r['damsWithSigma']}) | {r['outliers']} / {r['stablePairs']} | {r['fitted']} | {r['surveyDams']} | "
            f"{_fmt(r['medianErr50Pct'], '.1f')} % / {_fmt(r['medianErr100Pct'], '.1f')} % |"
        )
    lines += [
        "",
        f"Graduation bar per band: ≥ {BAR['pld_share'] * 100:.0f} % in the PLD, ≥ {BAR['passes_per_year']:.0f} valid passes a year, σ ≤ {BAR['sigma_m']} m, "
        f"and fitted volume within {BAR['volume_err_pct']:.0f} % of the survey on at least {BAR['survey_dams']} dams.",
        "",
        "| Band | PLD | Passes | σ | Volume |",
        "|---|---|---|---|---|",
    ]
    for r in rows:
        v = r["verdict"]
        lines.append(f"| {r['band']} | {v['pld']} | {v['passes']} | {v['sigma']} | {v['volume']} |")
    lines += ["", f"Data: {CITATION} Date accessed: {accessed.isoformat()}.", ""]
    return "\n".join(lines)


# --- the network -----------------------------------------------------------------------


@dataclasses.dataclass(frozen=True)
class Granule:
    name: str
    url: str


def search_url(box: tuple[float, float, float, float], start: dt.date, end: dt.date, page: int = 1) -> str:
    w, s, e, n = box
    q = [
        ("short_name", SHORT_NAME),
        ("bounding_box", f"{w:.4f},{s:.4f},{e:.4f},{n:.4f}"),
        ("temporal", f"{start.isoformat()}T00:00:00Z,{end.isoformat()}T23:59:59Z"),
        ("readable_granule_name[]", PRIOR_PATTERN),
        ("options[readable_granule_name][pattern]", "true"),
        ("page_size", str(PAGE_SIZE)),
        ("page_num", str(page)),
        ("sort_key", "start_date"),
    ]
    return f"{CMR_SEARCH}?{urllib.parse.urlencode(q)}"


def parse_search(body: bytes) -> tuple[int, list[Granule]]:
    """(hits, the Prior granules on this page). A Prior granule whose download
    link is not on the SWOT archive over HTTPS is refused: the token goes nowhere else."""
    try:
        doc = json.loads(body)
        hits = int(doc["hits"])
        items = doc["items"]
    except (ValueError, KeyError, TypeError):
        raise TrialError("CMR answered something that isn't a umm_json granule search") from None
    out = []
    for it in items:
        umm = it.get("umm", {}) if isinstance(it, dict) else {}
        name = str(umm.get("GranuleUR", ""))
        if "_LakeSP_Prior_" not in name:
            continue
        urls = [u.get("URL", "") for u in umm.get("RelatedUrls", []) if u.get("Type") == "GET DATA" and str(u.get("URL", "")).endswith(".zip")]
        good = [u for u in urls if urllib.parse.urlparse(u).scheme == "https" and urllib.parse.urlparse(u).hostname == ARCHIVE_HOST]
        if not good:
            raise TrialError(f"granule {name} has no https download on {ARCHIVE_HOST}")
        out.append(Granule(name, good[0]))
    return hits, out


def search(client: polite.PoliteClient, box, start: dt.date, end: dt.date) -> list[Granule]:
    granules: dict[str, Granule] = {}
    page, seen = 1, 0
    while True:
        hits, got = parse_search(_get(client, search_url(box, start, end, page)).body)
        for g in got:
            granules.setdefault(g.name, g)
        seen += PAGE_SIZE
        if seen >= hits:
            break
        page += 1
    return [granules[k] for k in sorted(granules)]


def _get(client: polite.PoliteClient, url: str, **kw) -> polite.Response:
    """imerg's: a 403, or a 401 (the token refused), stops the run with no retry."""
    return imerg._get(client, url, **kw)


def download(client: polite.PoliteClient, g: Granule, cache: Path) -> Path:
    """The granule's zip in `cache`, fetched only when not there yet (written
    to a .part and renamed, so a broken run never leaves a half file)."""
    dest = cache / f"{g.name}.zip" if not g.name.endswith(".zip") else cache / g.name
    if dest.exists():
        return dest
    part = dest.with_suffix(".zip.part")
    _get(client, g.url, dest=str(part))
    part.replace(dest)
    return dest


def read_token(environ=os.environ) -> str:
    """The operator's bare Earthdata Login token from EARTHDATA_TOKEN. Never logged or echoed."""
    try:
        value = earthdata.parse_secret(environ.get(TOKEN_ENV))
    except earthdata.SecretFormatError:
        raise TrialError(f"set {TOKEN_ENV} to an Earthdata Login user token (ingest/README.md § The SWOT lake height trial)") from None
    if isinstance(value, earthdata.Login):
        raise TrialError(f"{TOKEN_ENV} must be a bare Earthdata Login user token, not a username and password")
    return value


def make_client(token: str, base_opener=None, **kw) -> polite.PoliteClient:
    opener = imerg.EarthdataOpener(token, base_opener, hosts=frozenset({ARCHIVE_HOST}))
    return polite.PoliteClient(contact=os.environ.get("INGEST_CONTACT"), opener=opener, **kw)


# --- the command -------------------------------------------------------------------------


def under_data(path: Path) -> Path:
    """`path` resolved, refused unless it lies under the repo's gitignored data/."""
    p = path.resolve()
    if not p.is_relative_to(DATA_DIR.resolve()):
        raise TrialError(f"per-dam results stay under the gitignored data/ ({DATA_DIR}); refusing {path}")
    return p


def run(args, client: polite.PoliteClient | None = None) -> dict:
    out_dir = under_data(Path(args.out))
    cache = out_dir / "granules"
    cache.mkdir(parents=True, exist_ok=True)
    dams = read_dams(Path(args.dams))
    observed = read_observed_areas(Path(args.observed_areas)) if args.observed_areas else {}
    survey = read_survey(Path(args.survey)) if args.survey else {}
    w, s, e, n = bbox(d.ring for d in dams)
    pad = args.pad
    box = (w - pad, s - pad, e + pad, n + pad)
    client = client or make_client(read_token())
    granules = search(client, box, args.start, args.end)
    log.info("CMR: %d Prior granules over the dams", len(granules))
    passes: list[Pass] = []
    for i, g in enumerate(granules, 1):
        path = download(client, g, cache)
        passes.extend(read_prior_zip(path, box))
        if i % 25 == 0:
            log.info("read %d of %d granules", i, len(granules))
    results = analyse(dams, passes, args.start, args.end, observed, survey, args.area, args.min_overlap)
    rows = summarise(results)
    (out_dir / "dams.json").write_text(json.dumps({"start": args.start.isoformat(), "end": args.end.isoformat(), "granules": len(granules), "area": args.area, "dams": results}, indent=2, default=str))
    (out_dir / "summary.md").write_text(summary_markdown(rows, args.start, args.end, len(granules), args.area))
    return {"granules": len(granules), "requests": client.requests, "dams": len(dams), "out": str(out_dir)}


def parse_args(argv: list[str] | None = None):
    ap = argparse.ArgumentParser(description="The SWOT lake height trial (issue #625): run once by the operator.")
    ap.add_argument("--dams", required=True, help="CSV dam,lat,lon[,capacity_m3], one row per outline vertex")
    ap.add_argument("--observed-areas", help="CSV dam,date,area_m2 (WOfS/S2), paired within ±3 days")
    ap.add_argument("--survey", help="CSV dam,area_m2,volume_m3 survey curves to compare the fit with")
    ap.add_argument("--start", type=dt.date.fromisoformat, default=DEFAULT_START)
    ap.add_argument("--end", type=dt.date.fromisoformat, default=dt.date.today())
    ap.add_argument("--area", choices=("prefer-observed", "observed", "swot"), default="prefer-observed")
    ap.add_argument("--min-overlap", type=float, default=MIN_OVERLAP)
    ap.add_argument("--pad", type=float, default=0.01, help="degrees added round the dams' box for the search")
    ap.add_argument("--out", default=str(DEFAULT_OUT), help="output directory under data/ (default data/swot-trial)")
    args = ap.parse_args(argv)
    if args.end < args.start:
        ap.error("--end is before --start")
    return args


def main(argv: list[str] | None = None) -> int:
    logging.basicConfig(level=logging.INFO, format="%(message)s")
    try:
        print(json.dumps(run(parse_args(argv)), indent=2))
    except (TrialError, polite.StopRun) as e:
        print(f"swot_trial: {e}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
