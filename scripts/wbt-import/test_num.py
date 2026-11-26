"""Number cells holding the text "nan" or "inf": Python's float() reads them as NaN and infinity,
which json.dumps writes as the bare tokens NaN and Infinity, so project.json stopped being JSON
(the browser importer wrote null). num() and calibration's _num() treat them as text that isn't a
number, as the browser importer's num() does (frontend/src/lib/spreadsheet/import/cells.test.ts).

    .venv/bin/python -m unittest discover -s scripts/wbt-import
"""

import json
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from calibration import _num  # noqa: E402
from extract_project import num  # noqa: E402

NON_FINITE = ["nan", "NaN", " inf ", "-Infinity", "+inf"]


class NumTest(unittest.TestCase):
    def test_non_finite_text_reads_as_the_fallback(self):
        for text in NON_FINITE:
            with self.subTest(text=text):
                self.assertEqual(num(text), 0.0)
                self.assertEqual(num(text, 0.65), 0.65)

    def test_the_output_stays_json(self):
        json.dumps([num(t) for t in NON_FINITE], allow_nan=False)

    def test_finite_text_still_reads(self):
        self.assertEqual(num(" 4320 "), 4320.0)
        self.assertEqual(num("1_000.5"), 1000.5)
        self.assertEqual(num("1e3"), 1000.0)

    def test_calibration_refuses_non_finite_text(self):
        for text in NON_FINITE:
            with self.subTest(text=text), self.assertRaises(ValueError):
                _num(text)
        self.assertEqual(_num("12.5"), 12.5)


if __name__ == "__main__":
    unittest.main()
