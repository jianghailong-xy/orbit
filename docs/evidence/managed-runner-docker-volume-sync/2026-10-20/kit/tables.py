#!/usr/bin/env python3
"""D10: the README's tables from the rounds' summary.json and risk-window.json (summarize.py, risk_window.py).

    tables.py <rounds dir> lockstep|staggered|staggered-turns-only <variant>[=<heading>]...
    tables.py <rounds dir> rounds            one line per round: what else the HPC host did, and the round's main numbers

One table per runner count, a column per variant, each cell the variant's rounds at that count in the order they ran
("first / second").
"""

import json
from pathlib import Path
import sys

ROWS = [
    ("syncfs calls in the 120 s", lambda s, r: s["syncfs"]["calls"]),
    ("syncfs p50 / p99, ms", lambda s, r: pair(s["syncfs"]["ms"].get("p50"), s["syncfs"]["ms"].get("p99"))),
    ("sdb utilisation, mean %", lambda s, r: s["disk"]["sdbUtilPct"]["mean"]),
    ("sdb written, MB/s", lambda s, r: s["disk"]["sdbWriteMBps"]["mean"]),
    ("sdb cache flushes, per s", lambda s, r: s["disk"]["sdbFlushesPerS"]["mean"]),
    ("host CPU iowait, mean %", lambda s, r: s["disk"]["cpuIowaitPct"]["mean"]),
    ("host IO pressure (some), mean %", lambda s, r: s["disk"]["hostIoSomePct"]["mean"]),
    ("Postgres container IO pressure (some), mean %", lambda s, r: s["disk"]["cgroups"].get("orbit-postgres", {}).get("ioSomePct")),
    ("API probe p50 / p99, ms", lambda s, r: pair(s["api"]["all"].get("p50"), s["api"]["all"].get("p99"))),
    ("API probe's write (rename) p99, ms", lambda s, r: s["api"]["rename"].get("p99")),
    ("runners' writes at the gateway p50 / p99, ms", lambda s, r: pair(s["gateway"]["runnerWrites"].get("p50"), s["gateway"]["runnerWrites"].get("p99"))),
    ("Postgres one-row commit p50 / p99, ms", lambda s, r: pair(s["postgres"]["insertCommitMs"].get("p50"), s["postgres"]["insertCommitMs"].get("p99"))),
    ("Postgres read p99, ms", lambda s, r: s["postgres"]["readMs"].get("p99")),
    ("runner's commit, asked to committed, p50 / max, ms", lambda s, r: pair(s["runnerCommits"]["ms"].get("p50"), s["runnerCommits"]["ms"].get("max"))),
    ("engine's `git commit` in the runner p50 / p99, ms", lambda s, r: pair(s["engine"]["engineCommitMs"].get("p50"), s["engine"]["engineCommitMs"].get("p99"))),
    ("build of 400 files in the runner p50, ms", lambda s, r: s["engine"]["buildMs"].get("p50")),
    ("turns answered; p50 message to answer, s", lambda s, r: f"{s['turns']['answered']}; {s['turns']['seconds'].get('p50')}"),
    ("a tool's work on the disk after its result p50 / p99, s", lambda s, r: window(r)),
]


def pair(a, b):
    return f"{fmt(a)} / {fmt(b)}"


def fmt(v):
    if v is None:
        return "-"
    if isinstance(v, float):
        return f"{v:.1f}" if v >= 10 else f"{v:.2f}".rstrip("0").rstrip(".") if v < 1 else f"{v:.1f}"
    return str(v)


def window(r):
    if not r:
        return "-"
    if not r.get("seconds"):
        return f"no syncfs ({r['noneInTheRound']} results)"
    return pair(r["seconds"]["p50"], r["seconds"]["p99"])


def rounds_list(root):
    print("| Round | Build | Runners | Pattern | Window (UTC) | HPC load | Others on sdb before, MB/s | Test host re-read, MB "
          "| syncfs | API p99, ms | Postgres commit p99, ms |")
    print("| --- |" + " --- |" * 10)
    done = [f for f in root.iterdir() if not f.name.startswith("smoke") and (f / "summary.json").exists()]
    for folder in sorted(done, key=lambda f: json.loads((f / "summary.json").read_text())["window"]["start"]):
        s, meta = json.loads((folder / "summary.json").read_text()), json.loads((folder / "meta.json").read_text())
        q = s["quietBefore"]
        pattern = ("staggered" if meta.get("staggerSeconds") else "in step") + ("" if meta.get("commitEvery", 1) else ", turns only")
        print(f"| {s['label']} | {s['variant']} | {s['runners']} | {pattern} | {s['window']['start'][11:19]} | {q['load'][0]} "
              f"| {q.get('othersWriteMBps', '-')} w, {q.get('othersReadMBps', '-')} r | {s['disk']['cgroups'].get('dind', {}).get('readMB', '-')} "
              f"| {s['syncfs']['calls']} | {fmt(s['api']['all'].get('p99'))} | {fmt(s['postgres']['insertCommitMs'].get('p99'))} |")


def main():
    if sys.argv[2] == "rounds":
        return rounds_list(Path(sys.argv[1]))
    root, pattern, variants = Path(sys.argv[1]), sys.argv[2], sys.argv[3:]
    headings = dict(v.split("=", 1) if "=" in v else (v, v) for v in variants)
    rounds = []
    for folder in sorted(root.iterdir()):
        summary = folder / "summary.json"
        if summary.exists() and not folder.name.startswith("smoke"):
            s = json.loads(summary.read_text())
            meta = json.loads((folder / "meta.json").read_text())
            kind = ("staggered" if meta.get("staggerSeconds") else "lockstep") + ("" if meta.get("commitEvery", 1) else "-turns-only")
            if kind != pattern:
                continue
            r = json.loads((folder / "risk-window.json").read_text()) if (folder / "risk-window.json").exists() else None
            rounds.append((folder.name, s, r))
    for runners in sorted({s["runners"] for _, s, _ in rounds}):
        print(f"\n**{runners} runner{'s' if runners > 1 else ''}** (rounds: " + "; ".join(
            f"{headings[v]} " + ", ".join(name for name, s, _ in rounds if s["runners"] == runners and s["variant"] == v) for v in headings) + ")\n")
        print("| | " + " | ".join(headings.values()) + " |")
        print("| --- |" + " --- |" * len(headings))
        for label, get in ROWS:
            cells = []
            for v in headings:
                values = [get(s, r) for _, s, r in rounds if s["runners"] == runners and s["variant"] == v]
                cells.append(" / ".join(fmt(x) for x in values) if not any(isinstance(x, str) and " / " in x for x in values)
                             else "<br>".join(str(x) for x in values))
            print(f"| {label} | " + " | ".join(cells) + " |")


if __name__ == "__main__":
    main()
