"""Report secret-scan.yml's TruffleHog findings (its Report findings step).

Run as `python3 -I scripts/ci/secret_scan_report.py` (stdlib only) with:

  RESULTS               TruffleHog's --json output (one finding per line)
  REVIEWED              .github/secret-scan-reviewed.txt (optional file)
  GITHUB_STEP_SUMMARY   the job summary to append to

Each finding is printed as a GitHub annotation (never its value) and written
to the job summary. Exit 1 when any finding is verified or unknown, when the
results file is missing, or when the reviewed file has a bad entry or names a
commit that is not in this clone's history (checked unless the clone is
shallow); else 0.

Reviewed findings (see that file's header) are exact (commit, file, line,
detector) keys: a listed unknown or unverified finding is reported as
`reviewed` (a notice); a verified one is live, so it fails whatever the file
says. Tests: secret_scan_report.test.mjs beside this file (pnpm test:guards).
"""

import json
import os
import subprocess
import sys


def read_reviewed(path):
    """The reviewed keys, or an empty set when the file doesn't exist."""
    reviewed = set()
    if not os.path.exists(path):
        return reviewed
    with open(path) as f:
        for entry in f:
            entry = entry.split("#", 1)[0].split()
            if not entry:
                continue
            if len(entry) != 4 or len(entry[0]) != 40 or not entry[2].isdigit():
                raise SystemExit(f"{path}: bad entry {' '.join(entry)!r}")
            reviewed.add(tuple(entry))
    return reviewed


def missing_commits(commits):
    """The listed commits this clone doesn't have, or None when it can't tell
    (a shallow clone, or not a git checkout)."""
    if not commits:
        return []
    try:
        shallow = subprocess.run(
            ["git", "rev-parse", "--is-shallow-repository"],
            capture_output=True, text=True, check=True,
        ).stdout.strip()
    except (OSError, subprocess.CalledProcessError):
        return None
    if shallow != "false":
        return None
    out = subprocess.run(
        ["git", "cat-file", "--batch-check"],
        input="".join(f"{c}^{{commit}}\n" for c in commits),
        capture_output=True, text=True, check=True,
    ).stdout
    return [c for c, line in zip(commits, out.splitlines()) if line.endswith(" missing")]


def main():
    results_path = os.environ["RESULTS"]
    reviewed_path = os.environ["REVIEWED"]
    summary_path = os.environ["GITHUB_STEP_SUMMARY"]

    if not os.path.isfile(results_path):
        with open(summary_path, "a") as s:
            s.write("## secret scan\n")
            s.write("No results file; see the Install and Scan steps.\n")
        return 1

    reviewed = read_reviewed(reviewed_path)
    commits = sorted({key[0] for key in reviewed})
    missing = missing_commits(commits)
    if missing is None and commits:
        print(f"Shallow clone: not checking that {reviewed_path}'s commits exist.")
    elif missing:
        for c in missing:
            print(f"::error file={reviewed_path}::{reviewed_path} lists commit {c}, which is not in this clone's history")
        return 1

    rows, failing = [], 0
    with open(results_path) as f:
        for line in f:
            line = line.strip()
            if not line.startswith("{"):
                continue
            r = json.loads(line)
            git = ((r.get("SourceMetadata") or {}).get("Data") or {}).get("Git") or {}
            if r.get("Verified"):
                status = "verified"
            elif r.get("VerificationError"):
                status = "unknown"
            else:
                status = "unverified"
            key = (git.get("commit") or "", git.get("file") or "", str(git.get("line")),
                   r.get("DetectorName") or "")
            # Verified is live whatever the file says, so it always fails.
            if status != "verified" and key in reviewed:
                status = "reviewed"
            failing += status in ("verified", "unknown")
            rows.append((status, r.get("DetectorName", "?"), git.get("file", "?"),
                         git.get("line", "?"), (git.get("commit") or "")[:12]))

    order = {"verified": 0, "unknown": 1, "unverified": 2, "reviewed": 3}
    rows.sort(key=lambda x: order[x[0]])
    for status, det, path, line, commit in rows:
        level = {"unverified": "warning", "reviewed": "notice"}.get(status, "error")
        print(f"::{level} file={path},line={line}::{status} {det} credential in commit {commit}")
    with open(summary_path, "a") as s:
        s.write("## secret scan (trufflehog)\n\n")
        if not rows:
            s.write("No secrets found.\n")
        else:
            s.write(f"**{failing} verified/unknown** (fail the job), "
                    f"**{sum(r[0] == 'unverified' for r in rows)} unverified** (warning only), "
                    f"**{sum(r[0] == 'reviewed' for r in rows)} reviewed** "
                    f"(listed in `{reviewed_path}`, notice only).\n\n")
            s.write("| Status | Detector | File | Line | Commit |\n| --- | --- | --- | --- | --- |\n")
            for status, det, path, line, commit in rows:
                s.write(f"| {status} | {det} | `{path}` | {line} | `{commit}` |\n")
            s.write("\nVerified: rotate the credential now. Unverified: review; mark a false "
                    "positive with a `trufflehog:ignore` comment on its line.\n")
    return 1 if failing else 0


if __name__ == "__main__":
    sys.exit(main())
