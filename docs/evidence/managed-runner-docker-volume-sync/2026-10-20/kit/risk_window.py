#!/usr/bin/env python3
"""D10: how long what a tool wrote stayed off the disk, per round (d10.py `round`).

    risk_window.py <round dir>...      writes <round dir>/risk-window.json for each, prints one line per round

For every tool result an engine reported in the round's sessions (run_event's created_at: the time the runner stamped
on it as it buffered the event, by its clock, which is the HPC host's), the window is the time until the end of the
first syncfs on the test host's filesystem that STARTED after the tool's work was done: a syncfs writes back everything
dirty when it starts, whichever runner calls it. The runner nudges its background sync a moment before it stamps the
event, and the tool had finished before the engine reported it, so a syncfs that started up to TOLERANCE before the
stamp counts. Without one, the
work waits for the kernel's own writeback (dirty_expire_centisecs 3000: about 30 s, plus the flusher's 5 s period and
ext4's 5 s journal commit), which the trace cannot see: such results are counted as "none in the round".
"""

import importlib.util
import json
import math
from pathlib import Path
import subprocess
import sys

spec = importlib.util.spec_from_file_location("summarize", Path(__file__).resolve().parent / "summarize.py")
summarize = importlib.util.module_from_spec(spec)
spec.loader.exec_module(summarize)

TOLERANCE = 0.02  # seconds


def pct(values, p):
    values = sorted(values)
    return values[max(0, min(len(values) - 1, math.ceil(p / 100 * len(values)) - 1))] if values else None


def psql(sql):
    out = subprocess.run(["docker", "exec", "d10-dind", "docker", "exec", "orbit-postgres", "psql", "-U", "orbit", "-d", "orbit", "-AtqX",
                          "-F", "\t", "-c", sql], capture_output=True, text=True, check=True).stdout
    return [line.split("\t") for line in out.splitlines()]


def window(folder):
    folder = Path(folder)
    meta = json.loads((folder / "meta.json").read_text())
    started = meta["phases"]["loadStarted"]
    offset = started["wall"] - started["mono"]  # wall = mono + offset, both read at one instant
    sessions = [json.loads(line)["uuid"] for line in (folder / "sessions.jsonl").read_text().splitlines() if line.strip()]
    if not sessions:
        return None
    kept = folder / "risk-window.json"
    if kept.exists() and "toolResultsAt" in json.loads(kept.read_text()):  # read before: the deployment may be gone
        results = json.loads(kept.read_text())["toolResultsAt"]
    else:
        ids = ",".join(f"'{s}'" for s in sessions)
        results = [float(r[0]) for r in psql(f"select extract(epoch from created_at) from run_event where session_id in ({ids}) "
                                             f"and type = 'tool_result' order by created_at")]
    syncs = []
    for line in summarize.text(folder / "syncfs.jsonl").splitlines():  # no trace: no syncfs in the round
        if line.strip():
            e = json.loads(line)
            syncs.append((e["start"] + offset, e["end"] + offset))
    syncs.sort()
    windows, uncovered = [], 0
    for at in results:
        ends = [end for start, end in syncs if start >= at - TOLERANCE]
        if ends:
            windows.append(min(ends) - at)
        else:
            uncovered += 1
    out = {"label": meta["label"], "variant": meta["variant"], "runners": meta["runners"], "toolResults": len(results),
           "covered": len(windows), "noneInTheRound": uncovered,
           "seconds": {"p50": round(pct(windows, 50), 3), "p90": round(pct(windows, 90), 3), "p99": round(pct(windows, 99), 3),
                       "max": round(max(windows), 3)} if windows else None,
           "over5s": sum(1 for w in windows if w > 5), "over30s": sum(1 for w in windows if w > 30), "toolResultsAt": results}
    (folder / "risk-window.json").write_text(json.dumps(out, indent=2))
    return out


if __name__ == "__main__":
    for folder in sys.argv[1:]:
        result = window(folder)
        print(json.dumps({k: v for k, v in (result or {}).items() if k != "toolResultsAt"}), flush=True)
