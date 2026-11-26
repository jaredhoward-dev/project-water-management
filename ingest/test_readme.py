"""ingest/README.md renders as written: every code fence closes, so no
section heading or table ends up inside a code block.

A stray unlabelled fence after the event list once opened a block that ran
to the next fence 220 lines on, swallowing the environment table, the CHIRPS
finals job and IMERG Late into one code block.

    ingest/.venv/bin/python -m unittest test_readme
"""

import re
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
_FENCE = re.compile(r"^(`{3,}|~{3,})(.*)$")


def lines_in_code(text: str) -> list[tuple[int, str]]:
    """(line number, line) of every line inside a fenced code block, by
    CommonMark's rule: an opening fence may carry an info string, the closing
    one is the same run of backticks (or longer) and nothing else. Raises
    ValueError when a fence is still open at the end of the file."""
    out: list[tuple[int, str]] = []
    open_fence: str | None = None
    opened_at = 0
    for n, line in enumerate(text.splitlines(), 1):
        m = _FENCE.match(line)
        if open_fence is None:
            if m:
                open_fence, opened_at = m[1], n
            continue
        if m and m[1][0] == open_fence[0] and len(m[1]) >= len(open_fence) and not m[2].strip():
            open_fence = None
            continue
        out.append((n, line))
    if open_fence is not None:
        raise ValueError(f"the code fence opened on line {opened_at} never closes")
    return out


class ReadmeFences(unittest.TestCase):
    def check(self, text: str) -> None:
        inside = lines_in_code(text)
        headings = [f"{n}: {line}" for n, line in inside if line.startswith("#") and not line.startswith("#!") and re.match(r"^#{1,6} [A-Z]", line)]
        tables = [f"{n}: {line}" for n, line in inside if line.startswith("| ")]
        self.assertEqual(headings, [], "section headings inside a code block")
        self.assertEqual(tables, [], "Markdown table rows inside a code block")

    def test_readme_fences_close(self):
        self.check((HERE / "README.md").read_text(encoding="utf-8"))

    def test_catches_a_stray_fence(self):
        text = "```json\n{}\n```\n\nprose\n{}\n```\n\n| a | b |\n| --- | --- |\n\n## Next\n\n```sh\nx\n```\n"
        with self.assertRaises(AssertionError):
            self.check(text)

    def test_unclosed_fence(self):
        with self.assertRaises(ValueError):
            lines_in_code("```\nopen\n")


if __name__ == "__main__":
    unittest.main()
