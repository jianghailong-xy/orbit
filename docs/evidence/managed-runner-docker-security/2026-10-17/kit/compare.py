#!/usr/bin/env python3
"""D5: compare two data reports of evidence/data.jsonl by label: every file listed in the first must have the same
checksum in the second; SQLite integrity, rows, dump digest, the repository's HEAD and the runner identity must match."""
import json, sys
rows = [json.loads(l) for l in open("/mnt/data/tmp/34hJ7S9C3isVnzIDDfSHD/dind/work/evidence/data.jsonl")]
first = next(r for r in rows if r["label"] == sys.argv[1])["report"]
second = next(r for r in reversed(rows) if r["label"] == sys.argv[2])["report"]
def files(report):
    out, on = {}, False
    for line in report:
        if line == "files:": on = True; continue
        if line.endswith(":"): on = False
        if on: digest, name = line.split(None, 1); out[name] = digest
    return out
def section(report, title):
    i = report.index(title); j = next((k for k in range(i + 1, len(report)) if report[k].endswith(":")), len(report))
    return report[i + 1:j]
a, b = files(first), files(second)
changed = sorted(n for n in a if b.get(n) != a[n])
added = sorted(set(b) - set(a))
same = {t: section(first, t) == section(second, t) for t in ("repo:", "sqlite:", "dump:", "identity:")}
print(json.dumps({"from": sys.argv[1], "to": sys.argv[2], "filesBefore": len(a), "changedOrMissing": changed, "addedSince": added,
                  "sqliteAfter": section(second, "sqlite:"), "same": same,
                  "verdict": "same data" if not changed and all(same.values()) else "DIFFERENT"}))
