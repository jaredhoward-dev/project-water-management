"""The offline quantile-mapping fit for the ECMWF forecast (issue #604 D17,
R4-C): "quantile-mapped to our corrected rain".

Run by the operator, not on a schedule, once the copy has archived a few
months of forecasts (ecmwf_forecast.py keeps every issue's ensemble mean). It pairs
each archived forecast day with our rain for the same 0.1 deg cell and day,
and writes the quantile pairs that map one distribution onto the other, per
region and season, to `ecmwf/qm.json` in the copy. The feed applies them
(backend/src/feeds/fromMirrorEcmwf.ts); with no file it applies none and
labels the forecast "not yet calibrated".

    ingest/.venv/bin/python ingest/ecmwf_qm_fit.py --copy <dir> --mirror <url> [options]

  --copy DIR         a local copy holding `ecmwf/` and the observed product
                     (aws s3 sync of the mirror bucket's `ecmwf/` and `sat/`
                     prefixes, docs/deployment.md § ECMWF)
  --mirror URL       where qm.json goes: file:///abs/path or s3://bucket
                     (default: the --copy directory)
  --observed P       the observed product in the copy: `sat` (default; the
                     CHIRPS v3 finals, else `prelim` on days with no final)
  --scale X          multiply the observed rain by X first (the catchment's
                     CHIRPS bias correction, when the fit is for one; default 1)
  --regions FILE     JSON list of {"id", "region": {w, s, e, n}}; default the
                     whole region D1
  --cell-stride N    use every Nth cell each way (default 5: 1/25 of the cells;
                     the per-cell basis only)
  --basis B          `cell` (default: the per-cell fit, as before), `area`
                     (fitted on area means, below) or `both` (one file
                     holding both, the area groups after the cell groups)
  --block N          the area basis's block: N x N 0.1 deg cells (default 5,
                     0.5 deg, about a catchment's size); 0 averages each
                     region whole (one area per feed region: pass the feeds'
                     boxes with --regions)
  --min-samples N    a group with fewer pairs is left out (default 2000)
  --holdout-from D   fit both bases on the forecast days before D and print
                     how each maps the area means of the days from D on
                     (mean absolute error against the observed area means,
                     beside the raw forecast's); writes nothing
  --dry-run          print the file instead of writing it

**Cells or area means.** A feed applies the mapping to its catchment's
area-weighted mean (fromMirrorEcmwf.ts), whose distribution is not a cell's:
averaging gives more small-rain days and fewer extremes, so a per-cell
mapping pushes an area mean's tails too far and leaves its drizzle
under-corrected (issue #835). The area basis fits on what the feed maps: in
each block of the region, the forecast mean and the observed rain averaged
over the same 0.1 deg cells (those finite in both; a block with fewer than
half of its cells so is skipped), one sample per block and day, one fit per
region and season. Its groups carry `"basis": "area"` and `"block": N`; a
group without `basis` is a per-cell one, so an older file reads as before.
The feed applies the area group for its place and month when the file has
one, else the per-cell group.

**The method.** Empirical quantile mapping of daily totals. Within a group
(a region box and a season, DJF/MAM/JJA/SON, by the forecast day's month),
the forecast's and the observations' quantiles at the same probabilities
(0, 0.01, … 1) make the pairs (f, o). Forecast quantiles that tie (dry
days: many zeros) collapse to one pair with the mean of their observed
quantiles, and o is made non-decreasing, so the mapping is monotone. All
lead days are pooled; the forecasts are the ensemble mean. Applying a
monotone mapping to a quantile of the ensemble is exact (the quantile of the
mapped members); applied to the mean it is the usual approximation.

**Applying it** (the same rule in fromMirrorEcmwf.ts `applyQm`): linear
between pairs; past the last pair, the last pair's offset (o - f) carried
on; below the first, scaled towards 0 (or the first o when f starts at 0);
never below 0.
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))

import ecmwf_forecast  # noqa: E402
import zarrstore  # noqa: E402

SEASONS = {"DJF": (12, 1, 2), "MAM": (3, 4, 5), "JJA": (6, 7, 8), "SON": (9, 10, 11)}
PROBABILITIES = np.linspace(0.0, 1.0, 101)
METHOD = "empirical quantile mapping of daily totals: ensemble mean, all lead days pooled, per region and season (ingest/ecmwf_qm_fit.py)"
METHOD_AREA = "empirical quantile mapping of daily totals on area means (blocks of cells, forecast and observed averaged over the same cells): ensemble mean, all lead days pooled, per region and season (ingest/ecmwf_qm_fit.py)"
BASES = ("cell", "area", "both")


def fit_pairs(forecast: np.ndarray, observed: np.ndarray, probabilities: np.ndarray = PROBABILITIES) -> list[list[float]]:
    """The (f, o) pairs mapping `forecast`'s distribution onto `observed`'s:
    f strictly increasing, o non-decreasing, both mm to 3 decimals."""
    f = np.asarray(forecast, dtype=np.float64).ravel()
    o = np.asarray(observed, dtype=np.float64).ravel()
    if f.size == 0 or o.size == 0:
        raise ValueError("no samples to fit")
    qf = np.round(np.quantile(f, probabilities), 3)
    qo = np.quantile(o, probabilities)
    pairs: list[list[float]] = []
    for x in np.unique(qf):
        pairs.append([float(x), float(qo[qf == x].mean())])
    ys = np.maximum.accumulate(np.maximum([p[1] for p in pairs], 0.0))
    return [[p[0], round(float(y), 3)] for p, y in zip(pairs, ys)]


def apply(pairs: list[list[float]], x: float) -> float:
    """The mapped value of `x` (see the module docstring)."""
    if not pairs:
        return x
    fs = [p[0] for p in pairs]
    os_ = [p[1] for p in pairs]
    if x >= fs[-1]:
        y = os_[-1] + (x - fs[-1])
    elif x <= fs[0]:
        y = os_[0] if fs[0] <= 0 else os_[0] * (x / fs[0])
    else:
        y = float(np.interp(x, fs, os_))
    return max(0.0, y)


def season_of(month: int) -> str:
    return next(s for s, months in SEASONS.items() if month in months)


def _coarsen(day: np.ndarray) -> np.ndarray:
    """A 0.05 deg day (550, 620) as the 0.1 deg cells (275, 310): the mean of
    the four 0.05 deg cells each holds (NaN if any is)."""
    return day.reshape(ecmwf_forecast.ROWS, 2, ecmwf_forecast.COLS, 2).mean(axis=(1, 3))


def _observed_day(root: Path, product: str, day: dt.date) -> np.ndarray | None:
    import zarr

    got = zarrstore.read_finals(root, product, day, 1) if (root / product / "zarr.json").exists() else None
    v = None if got is None else got[0]
    if (v is None or np.isnan(v).all()) and (root / "prelim" / "zarr.json").exists():
        arr = zarr.open_array(store=zarr.storage.LocalStore(root), path="prelim", mode="r", zarr_format=3)
        i = (day - dt.date.fromisoformat(arr.attrs["firstDay"])).days
        if 0 <= i < arr.shape[0]:
            v = np.asarray(arr[i])
    if v is None or np.isnan(v).all():
        return None
    return _coarsen(v)


def _mask(region: dict, stride: int) -> tuple[np.ndarray, np.ndarray]:
    """The (row, col) indices of the 0.1 deg cells whose centre lies in `region`, every `stride`th."""
    lats = ecmwf_forecast.ORIGIN["lat"] + np.arange(ecmwf_forecast.ROWS) * ecmwf_forecast.STEP_DEG
    lons = ecmwf_forecast.ORIGIN["lon"] + np.arange(ecmwf_forecast.COLS) * ecmwf_forecast.STEP_DEG
    rows = np.nonzero((lats >= region["s"]) & (lats <= region["n"]))[0][::stride]
    cols = np.nonzero((lons >= region["w"]) & (lons <= region["e"]))[0][::stride]
    return rows, cols


def _block_means(f: np.ndarray, o: np.ndarray, rows: np.ndarray, cols: np.ndarray, block: int) -> tuple[np.ndarray, np.ndarray]:
    """The forecast's and the observations' area means over the blocks of the
    region's cells (`rows` x `cols`, every cell): N x N blocks (the edges that
    don't fill one dropped), or the region whole with `block` 0. Each mean is
    over the cells finite in both; a block with fewer than half so is left out."""
    fv = f[np.ix_(rows, cols)].astype(np.float64)
    ov = o[np.ix_(rows, cols)].astype(np.float64)
    if block <= 0:
        fv, ov = fv[None, :, None, :], ov[None, :, None, :]
    else:
        nr, nc = len(rows) // block, len(cols) // block
        if nr == 0 or nc == 0:
            return np.empty(0), np.empty(0)
        fv = fv[: nr * block, : nc * block].reshape(nr, block, nc, block)
        ov = ov[: nr * block, : nc * block].reshape(nr, block, nc, block)
    ok = np.isfinite(fv) & np.isfinite(ov)
    n = ok.sum(axis=(1, 3))
    size = fv.shape[1] * fv.shape[3]
    with np.errstate(invalid="ignore", divide="ignore"):
        fm = np.where(ok, fv, 0.0).sum(axis=(1, 3)) / n
        om = np.where(ok, ov, 0.0).sum(axis=(1, 3)) / n
    keep = n * 2 >= size
    return fm[keep], om[keep]


def _issues(root: Path) -> list[str]:
    doc = json.loads((root / ecmwf_forecast.INDEX_KEY).read_text()) if (root / ecmwf_forecast.INDEX_KEY).exists() else {"issues": [], "archived": []}
    return sorted(set(doc.get("issues", [])) | set(doc.get("archived", [])))


def _paired_days(root: Path, observed: str, scale: float):
    """Each (issue, forecast day, the issue's mean that day, the observed rain) with an observation."""
    obs_cache: dict[dt.date, np.ndarray | None] = {}
    for iso in _issues(root):
        issue = dt.date.fromisoformat(iso)
        mean = ecmwf_forecast.read_issue(root, iso, "mean")
        for d in range(ecmwf_forecast.DAYS):
            day = issue + dt.timedelta(days=d)
            if day not in obs_cache:
                o = _observed_day(root, observed, day)
                obs_cache[day] = None if o is None else o * scale
            o = obs_cache[day]
            if o is not None:
                yield iso, day, mean[d], o


def _samples(f: np.ndarray, o: np.ndarray, region: dict, basis: str, stride: int, block: int) -> tuple[np.ndarray, np.ndarray]:
    if basis == "area":
        rows, cols = _mask(region, 1)
        return _block_means(f, o, rows, cols, block)
    rows, cols = _mask(region, stride)
    fv = f[np.ix_(rows, cols)].ravel()
    ov = o[np.ix_(rows, cols)].ravel()
    ok = np.isfinite(fv) & np.isfinite(ov)
    return fv[ok], ov[ok]


def fit(
    root: Path,
    observed: str = "sat",
    regions: list[dict] | None = None,
    stride: int = 5,
    min_samples: int = 2000,
    scale: float = 1.0,
    fitted_at: str | None = None,
    basis: str = "cell",
    block: int = 5,
    before: dt.date | None = None,
) -> dict:
    """qm.json's document from a local copy (see the module docstring).
    `before` keeps only the forecast days before it (the held-out comparison)."""
    if basis not in BASES:
        raise ValueError(f"basis must be one of {BASES}")
    regions = regions or [{"id": "D1", "region": dict(ecmwf_forecast.REGION)}]
    bases = ["cell", "area"] if basis == "both" else [basis]
    samples: dict[tuple[str, str, str], tuple[list, list]] = {}
    used: list[str] = []
    for iso, day, f, o in _paired_days(root, observed, scale):
        if before is not None and day >= before:
            continue
        for b in bases:
            for r in regions:
                fv, ov = _samples(f, o, r["region"], b, stride, block)
                if fv.size:
                    if not used or used[-1] != iso:
                        used.append(iso)
                    bucket = samples.setdefault((b, r["id"], season_of(day.month)), ([], []))
                    bucket[0].append(fv)
                    bucket[1].append(ov)
    groups = []
    for b in bases:
        for r in regions:
            for season, months in SEASONS.items():
                got = samples.get((b, r["id"], season))
                if not got:
                    continue
                f, o = np.concatenate(got[0]), np.concatenate(got[1])
                if f.size < min_samples:
                    continue
                pairs = fit_pairs(f, o)
                if len(pairs) < 2:  # a forecast that never varies (all dry) maps nothing
                    continue
                g = {"id": f"{r['id']}-{season}", "region": dict(r["region"]), "months": list(months), "samples": int(f.size), "pairs": pairs}
                if b == "area":
                    g["id"] += "-area"
                    g["basis"] = "area"
                    g["block"] = block
                groups.append(g)
    return {
        "v": 1,
        "product": "ecmwf",
        "stat": "mean",
        "fittedAt": fitted_at or dt.datetime.now(dt.UTC).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "method": METHOD_AREA if basis == "area" else METHOD if basis == "cell" else f"{METHOD}; area groups: {METHOD_AREA}",
        "observed": {"product": observed, "fallback": "prelim", "scale": scale},
        "forecasts": {"issues": len(used), "first": used[0] if used else None, "last": used[-1] if used else None},
        "groups": groups,
    }


def group_for(doc: dict, lat: float, lon: float, month: int, basis: str | None = None) -> dict | None:
    """The group the feed applies at a place and month (fromMirrorEcmwf.ts
    qmGroupFor): an area group first, else a per-cell one; `basis` asks for one kind only."""
    def holds(g):
        r = g["region"]
        return r["s"] <= lat <= r["n"] and r["w"] <= lon <= r["e"] and month in g["months"]

    for kind in (["area", "cell"] if basis is None else [basis]):
        for g in doc["groups"]:
            if g.get("basis", "cell") == kind and holds(g):
                return g
    return None


def holdout(
    root: Path,
    split: dt.date,
    observed: str = "sat",
    regions: list[dict] | None = None,
    stride: int = 5,
    min_samples: int = 2000,
    scale: float = 1.0,
    block: int = 5,
) -> dict:
    """Both fits made on the forecast days before `split`, then the area means
    (`block`) of the days from `split` on mapped through each: the mean
    absolute error and the mean bias against the observed area means, for the
    raw forecast, the per-cell fit and the area fit. What a feed sees is an
    area mean, so the area fit should do better there."""
    regions = regions or [{"id": "D1", "region": dict(ecmwf_forecast.REGION)}]
    doc = fit(root, observed, regions, stride, min_samples, scale, "1970-01-01T00:00:00Z", "both", block, before=split)
    err = {k: [] for k in ("raw", "cell", "area")}
    for _iso, day, f, o in _paired_days(root, observed, scale):
        if day < split:
            continue
        for r in regions:
            reg = r["region"]
            lat, lon = (reg["s"] + reg["n"]) / 2, (reg["w"] + reg["e"]) / 2
            gc = group_for(doc, lat, lon, day.month, "cell")
            ga = group_for(doc, lat, lon, day.month, "area")
            if gc is None or ga is None:
                continue
            fv, ov = _samples(f, o, reg, "area", stride, block)
            err["raw"].append(fv - ov)
            err["cell"].append(np.array([apply(gc["pairs"], x) for x in fv]) - ov)
            err["area"].append(np.array([apply(ga["pairs"], x) for x in fv]) - ov)
    if not err["raw"]:
        return {"samples": 0, "mae": None, "bias": None}
    e = {k: np.concatenate(v) for k, v in err.items()}
    return {
        "split": split.isoformat(),
        "block": block,
        "samples": int(e["raw"].size),
        "mae": {k: round(float(np.abs(v).mean()), 4) for k, v in e.items()},
        "bias": {k: round(float(v.mean()), 4) for k, v in e.items()},
    }


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description="Fit ECMWF forecast quantile mapping to our rain; writes ecmwf/qm.json.")
    p.add_argument("--copy", required=True, type=Path)
    p.add_argument("--mirror")
    p.add_argument("--observed", default="sat", choices=["sat", "rnl", "prelim"])
    p.add_argument("--scale", type=float, default=1.0)
    p.add_argument("--regions", type=Path)
    p.add_argument("--cell-stride", type=int, default=5)
    p.add_argument("--basis", default="cell", choices=list(BASES))
    p.add_argument("--block", type=int, default=5)
    p.add_argument("--min-samples", type=int, default=2000)
    p.add_argument("--holdout-from", type=dt.date.fromisoformat)
    p.add_argument("--dry-run", action="store_true")
    a = p.parse_args(argv)
    if not 0 < a.scale <= 5:
        p.error("--scale must be in (0, 5]")
    if a.block < 0:
        p.error("--block must be 0 or more")
    regions = json.loads(a.regions.read_text()) if a.regions else None
    if a.holdout_from:
        print(json.dumps(holdout(a.copy.resolve(), a.holdout_from, a.observed, regions, a.cell_stride, a.min_samples, a.scale, a.block), indent=2))
        return 0
    doc = fit(a.copy.resolve(), a.observed, regions, a.cell_stride, a.min_samples, a.scale, basis=a.basis, block=a.block)
    if not doc["groups"]:
        print("no group had enough forecast days with observed rain; nothing written", file=sys.stderr)
        return 1
    if a.dry_run:
        print(json.dumps(doc, indent=2))
        return 0
    mirror = zarrstore.Mirror.from_url(a.mirror or a.copy.resolve().as_uri())
    mirror.write_json(ecmwf_forecast.QM_KEY, doc)
    print(f"wrote {ecmwf_forecast.QM_KEY}: {len(doc['groups'])} groups from {doc['forecasts']['issues']} issues", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
