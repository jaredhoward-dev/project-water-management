"""The importer's sheet readers on small hand-built workbooks: named ranges,
[Flow data], an Element sheet, [Shortfalls] and the EWR pivot table.

Each workbook is invented (no client data), written with openpyxl and read
back the way extract_project.py reads a real one (read-only, cached values),
so short rows at the end of a sheet's used range behave as they do there.

    .venv/bin/python -m unittest discover -s scripts/wbt-import
"""

import datetime as dt
import sys
import tempfile
import unittest
from pathlib import Path

import openpyxl
from openpyxl.workbook.defined_name import DefinedName

sys.path.insert(0, str(Path(__file__).resolve().parent))

import extract_project as ep  # noqa: E402


class Built:
    """An openpyxl workbook under construction, saved and reopened read-only as ep.Workbook."""

    def __init__(self, tmp: Path):
        self.tmp = tmp
        self.wb = openpyxl.Workbook()
        self.wb.remove(self.wb.active)

    def sheet(self, title: str):
        return self.wb.create_sheet(title)

    def name(self, name: str, ref: str) -> None:
        self.wb.defined_names[name] = DefinedName(name, attr_text=ref)

    def open(self) -> ep.Workbook:
        path = self.tmp / f"wb{len(list(self.tmp.iterdir()))}.xlsx"
        self.wb.save(path)
        return ep.Workbook(openpyxl.load_workbook(path, read_only=True, data_only=True, keep_vba=False))


class Case(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.b = Built(Path(self._tmp.name))

    def tearDown(self):
        self._tmp.cleanup()


class NamedRanges(Case):
    def test_quoted_sheet_names_cells_and_ranges(self):
        ws = self.b.sheet("O'Neil's data")
        ws["B2"], ws["C3"] = 1, 2
        self.b.name("zOne", "'O''Neil''s data'!$B$2")
        self.b.name("zBlock", "'O''Neil''s data'!$B$2:$D$4")
        self.b.name("zFormula", "SUM('O''Neil''s data'!$B$2:$B$3)")
        wb = self.b.open()
        self.assertEqual(wb.ref("zOne"), ("O'Neil's data", 2, 2, 2, 2))
        self.assertEqual(wb.cell("zOne"), 1)
        self.assertEqual(wb.ref("zBlock"), ("O'Neil's data", 2, 2, 4, 4))
        # Past the used range (C3 is its corner), rows and cells come back as blanks, never short.
        self.assertEqual(wb.named("zBlock"), [[1, None, None], [None, 2, None], [None, None, None]])
        with self.assertRaisesRegex(ValueError, "not a plain cell/range reference"):
            wb.ref("zFormula")
        with self.assertRaisesRegex(KeyError, "no defined name 'zMissing'"):
            wb.ref("zMissing")


# [Flow data] as laid out here: the date header at B5, dates from B7; the
# hydrology block's header C5:I5, so the six raw columns are D..I (Pitman,
# observed, logger, catchment rain, CHIRPS, forecast); the calculated columns J..O.
FLOW_NAMES = {
    "zFlowData_HeaderDate": "'Flow data'!$B$5",
    "zFlowData_HeaderHydrologyData": "'Flow data'!$C$5:$I$5",
    "zFlowData_HeaderResultFlow": "'Flow data'!$J$5",
    "zFlowData_HeaderEWRpragma": "'Flow data'!$K$5",
    "zFlowData_HeaderSimulated": "'Flow data'!$L$5",
    "zFlowData_HeaderUseRain": "'Flow data'!$M$5",
    "zFlowData_HeaderObserved": "'Flow data'!$N$5",
    "zFlowData_HeaderEWRvolumeNotMet": "'Flow data'!$O$5",
    "zFlowData_DateE_DateSeries": "'Flow data'!$B$2",
}


class FlowData(Case):
    def flow(self, days: list[dt.date], end: dt.date | None, rows: dict[int, dict[str, object]] | None = None) -> ep.Workbook:
        ws = self.b.sheet("Flow data")
        for k, v in FLOW_NAMES.items():
            self.b.name(k, v)
        ws["B2"] = end
        ws["B5"] = "Date"
        for col, head in zip("CDEFGHI", ["Hydrology", "Pitman", "Gauge X1H001", "", "Rain gauge", "CHIRPS", ""]):
            ws[f"{col}5"] = head or None
        for i, d in enumerate(days):
            r = 7 + i
            ws[f"B{r}"] = d
            ws[f"D{r}"] = 0.5  # Pitman
            ws[f"E{r}"] = float(i)  # observed
            ws[f"G{r}"] = 2.0 * i  # catchment rain
            ws[f"J{r}"] = 10.0 + i  # natural flow
            for col, v in (rows or {}).get(i, {}).items():
                ws[f"{col}{r}"] = v
        return self.b.open()

    def test_reads_across_a_leap_day_and_stops_at_the_date_series_end(self):
        days = [dt.date(2024, 2, 27) + dt.timedelta(days=i) for i in range(5)]  # 27 Feb .. 2 Mar
        out = ep.read_flow_data(self.flow(days, end=dt.date(2024, 3, 1)))
        self.assertEqual(out["dates"], ["2024-02-27", "2024-02-28", "2024-02-29", "2024-03-01"])
        self.assertEqual(out["pitman_days"], 4)
        # The logger, CHIRPS and forecast columns are empty, so they make no series.
        self.assertEqual([(s["kind"], s["name"], s["startDate"]) for s in out["series"]], [("flow_observed_m3s", "Gauge X1H001", "2024-02-27"), ("rain_catchment_mm", "Rain gauge", "2024-02-27")])
        self.assertEqual(out["series"][0]["values"], [0.0, 1.0, 2.0, 3.0])
        self.assertEqual(out["series"][1]["source"], "Workbook column 'Rain gauge'")
        self.assertEqual(out["calc"]["natural_flow"], [10.0, 11.0, 12.0, 13.0])
        self.assertEqual(out["calc"]["ewr"], [None] * 4)

    def test_stops_at_the_first_row_without_a_date(self):
        days = [dt.date(2023, 12, 30), dt.date(2023, 12, 31), dt.date(2024, 1, 1)]
        wb = self.flow(days, end=None, rows={2: {"B": "Total"}})
        self.assertEqual(ep.read_flow_data(wb)["dates"], ["2023-12-30", "2023-12-31"])

    def test_text_errors_and_booleans_are_missing_values_not_numbers(self):
        days = [dt.date(2024, 1, 1) + dt.timedelta(days=i) for i in range(4)]
        wb = self.flow(days, end=days[-1], rows={1: {"E": "#N/A"}, 2: {"E": True, "J": "-"}, 3: {"E": None}})
        out = ep.read_flow_data(wb)
        self.assertEqual(out["series"][0]["values"], [0.0, None, None, None])
        self.assertEqual(out["calc"]["natural_flow"], [10.0, 11.0, None, 13.0])

    def test_a_missing_day_is_refused(self):
        days = [dt.date(2024, 2, 28), dt.date(2024, 3, 1)]  # 29 February left out
        with self.assertRaisesRegex(ValueError, r"\[Flow data\] dates are not consecutive at 2024-02-28 -> 2024-03-01"):
            ep.read_flow_data(self.flow(days, end=days[-1]))
        b = Built(Path(self._tmp.name))
        self.b = b
        days = [dt.date(2024, 1, 2), dt.date(2024, 1, 1)]  # out of order
        with self.assertRaisesRegex(ValueError, "not consecutive at 2024-01-02 -> 2024-01-01"):
            ep.read_flow_data(self.flow(days, end=days[-1]))

    def test_a_datetime_with_a_time_of_day_is_its_date(self):
        days = [dt.datetime(2024, 1, 1, 0, 0), dt.datetime(2024, 1, 2, 23, 59)]
        out = ep.read_flow_data(self.flow(days, end=dt.datetime(2024, 1, 2)))
        self.assertEqual(out["dates"], ["2024-01-01", "2024-01-02"])


class ElementSheet(Case):
    def sheet(self, first: dt.date, days: int, header_rows: int = 2):
        ws = self.b.sheet("Farm A")
        ws["E20"] = "Date"  # headings before the dates are skipped
        for i in range(days):
            r = 20 + header_rows + i
            ws[f"E{r}"] = first + dt.timedelta(days=i)
            ws[f"F{r}"] = 1.0 + i  # demand
            ws[f"Q{r}"] = 100.0 - i  # dam storage
        ws[f"E{20 + header_rows + days}"] = "Totals"
        return self.b.open()

    def test_starts_at_the_first_date_and_reads_the_asked_days(self):
        wb = self.sheet(dt.date(2024, 2, 28), 5)
        self.assertEqual(ep.element_sheet_start(wb, "Farm A"), "2024-02-28")
        out = ep.read_element_sheet(wb, "Farm A", "farm", 3, "2024-02-28")
        self.assertEqual(out["demand"], [1.0, 2.0, 3.0])
        self.assertEqual(out["dam_storage"], [100.0, 99.0, 98.0])
        self.assertEqual(out["spill"], [None, None, None])
        self.assertEqual(set(out), set(ep.FARM_COLS.values()))

    def test_stops_at_the_end_of_the_dates_when_asked_for_more(self):
        wb = self.sheet(dt.date(2024, 1, 1), 3)
        self.assertEqual(ep.read_element_sheet(wb, "Farm A", "farm", 10, "2024-01-01")["demand"], [1.0, 2.0, 3.0])

    def test_a_sheet_starting_on_another_day_is_refused(self):
        wb = self.sheet(dt.date(2024, 1, 2), 3)
        with self.assertRaisesRegex(ValueError, r"\[Farm A\] starts on 2024-01-02, the other Element sheets on 2024-01-01"):
            ep.read_element_sheet(wb, "Farm A", "farm", 3, "2024-01-01")

    def test_a_sheet_with_no_dates(self):
        self.b.sheet("Farm A")["E20"] = "Date"
        self.assertIsNone(ep.element_sheet_start(self.b.open(), "Farm A"))


class Shortfalls(Case):
    def test_absent_names_mean_no_shortfalls(self):
        self.b.sheet("Shortfalls")
        self.assertIsNone(ep.read_shortfalls(self.b.open()))

    def test_farms_dashes_and_the_totals_row(self):
        ws = self.b.sheet("Shortfalls")
        ws["B2"], ws["B3"] = dt.datetime(2010, 10, 1), dt.datetime(2020, 9, 30)
        self.b.name("zShortfalls_PeriodStart", "Shortfalls!$B$2")
        self.b.name("zShortfalls_Tbl", "Shortfalls!$E$5:$V$9")  # a header row, three rows, then the sentinel
        rows = [
            ("Farm A", 100.0, 80.0, 20.0, 0.8),
            ("|", 1.0, 1.0, 0.0, 1.0),  # a separator row, not a farm
            ("Farm B", 0.0, 0.0, 0.0, "-"),  # no demand: K is "-"
            ("-- do NOT delete this row", None, None, None, None),
        ]
        for i, (name, h, i_, j, k) in enumerate(rows):
            r = 6 + i
            ws[f"G{r}"], ws[f"H{r}"], ws[f"I{r}"], ws[f"J{r}"], ws[f"K{r}"] = name, h, i_, j, k
        ws["R6"] = "-"  # EWR shortfall as a dash: read as 0, like Excel's arithmetic
        ws["H10"], ws["I10"], ws["K10"] = 100.0, 80.0, 0.8  # totals, just below the sentinel
        out = ep.read_shortfalls(self.b.open())
        self.assertEqual((out["periodStart"], out["periodEnd"]), ("2010-10-01", "2020-09-30"))
        self.assertEqual([f["name"] for f in out["farms"]], ["Farm A", "Farm B"])
        a, b = out["farms"]
        self.assertEqual((a["avgDemand"], a["avgSupplied"], a["deficit"], a["fractionSupplied"], a["avgEwrShortfall"]), (100.0, 80.0, 20.0, 0.8, 0.0))
        self.assertIsNone(b["fractionSupplied"])
        self.assertIsNone(a["target"])
        self.assertEqual((out["totals"]["avgDemand"], out["totals"]["fractionSupplied"], out["totals"]["deficit"]), (100.0, 0.8, None))


class EwrPivot(Case):
    def test_rows_without_a_year_or_a_farm_are_skipped(self):
        self.b.sheet("Network")
        self.assertIsNone(ep.read_ewr_pivot(self.b.open()))  # no pivot table: none
        b = Built(Path(self._tmp.name))
        ws = b.sheet("EWR shortfalls Pivot Data")
        rows = [
            ("Year", "Month", "Farm", "Volume", "Count"),
            (2012, 2, "Farm A", -1500.5, 3),
            ("Grand Total", None, None, -1500.5, 3),
            (2012.0, 3, "", -1.0, 1),
            (2012, 3, " Farm\nB ", None, "2"),
        ]
        for i, row in enumerate(rows):
            for j, v in enumerate(row):
                ws.cell(row=1 + i, column=1 + j, value=v)
        b.name("zEWRshortPivotData_DataTbl", "'EWR shortfalls Pivot Data'!$A$1:$E$5")
        self.assertEqual(
            ep.read_ewr_pivot(b.open()),
            [
                {"year": 2012, "month": 2, "farm": "Farm A", "volM3": -1500.5, "daysNotMet": 3},
                {"year": 2012, "month": 3, "farm": "Farm B", "volM3": 0.0, "daysNotMet": 2},
            ],
        )


class ProjectName(unittest.TestCase):
    def test_the_name_before_the_wbt_suffix(self):
        self.assertEqual(ep.project_name(Path("/x/Kleinrivier_WBT_b023_v2.xlsm")), "Kleinrivier")
        self.assertEqual(ep.project_name(Path("Sandspruit.xlsx")), "Sandspruit")
        # A file named only by the suffix keeps its whole stem rather than an empty name.
        self.assertEqual(ep.project_name(Path("_WBT_b023.xlsm")), "_WBT_b023")


if __name__ == "__main__":
    unittest.main()
