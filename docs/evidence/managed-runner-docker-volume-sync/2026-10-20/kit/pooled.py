#!/usr/bin/env python3
"""D10: every variant's rounds at one runner count pooled, against the bound in the design record.

    pooled.py <rounds dir> [--undisturbed] [--json OUT]

--undisturbed leaves out the rounds in which the test host read more than 100 MB from the disk in its window: its
load reads next to nothing when its page cache holds (the images, the repositories), so such reads mean that memory
pressure from outside it (other sessions on the HPC host) had evicted that cache, and the reads competed with the
writes being measured.

A round's p99 rests on a few requests (the API probe makes 960 in a round, pgbench about 600 commits), so the
comparison takes all the samples of a variant's rounds at a runner count and workload together, over the rounds' load
windows. Rounds are pooled by their pattern too: "lockstep" (plans 1 and 2: every runner starts at once and every turn
is alike) or "staggered" (plan 4: random starts within 25 s and think times of 1 to 3 s). The bound compares each
variant with `before` (the build without volume syncs) at the same count and pattern ("-turns-only": rounds without the
runner's commits, plan 5):
  - the API probe's p99 (its three reads and its write together) at most 25% over, or 10 ms, whichever is more;
  - Postgres's one-row commit p99 at most 50% over, or 10 ms;
  - the Postgres container's IO pressure ("some", the mean of the rounds) at most 5 points over;
  - the runner's commit, asked to committed, p50 at most 1 s over.
"""

import importlib.util
import json
import math
from pathlib import Path
import sys

spec = importlib.util.spec_from_file_location("summarize", Path(__file__).resolve().parent / "summarize.py")
summarize = importlib.util.module_from_spec(spec)
spec.loader.exec_module(summarize)
text = summarize.text


def pct(values, p):
    values = sorted(values)
    return values[max(0, min(len(values) - 1, math.ceil(p / 100 * len(values)) - 1))] if values else None


def load_window(folder):
    meta = json.loads((folder / "meta.json").read_text())
    p = meta["phases"]
    return meta, (p["loadStarted"]["mono"], p["loadEnded"]["mono"]), (p["loadStarted"]["wall"], p["loadEnded"]["wall"])


def samples(folder):
    meta, (m0, m1), (w0, w1) = load_window(folder)
    api = [json.loads(l) for l in text(folder / "api-probe.jsonl").splitlines() if l.strip()]
    api = [a for a in api if m0 <= a["mono"] <= m1]
    offset = meta["phases"]["loadStarted"]["wall"] - meta["phases"]["loadStarted"]["mono"]
    events = [json.loads(l) for l in text(folder / "syncfs.jsonl").splitlines() if l.strip()]
    spans = [(e["start"] + offset, e["end"] + offset) for e in events]
    commits, reads, slow, slow_in_sync = [], [], 0, 0
    for line in text(folder / "pgbench-transactions.txt").splitlines():
        f = line.split()
        if len(f) >= 6 and w0 <= int(f[4]) + int(f[5]) / 1e6 <= w1:
            ms = int(f[2]) / 1000
            (commits if f[3] == "0" else reads).append(ms)
            if f[3] == "0" and ms > 100:  # a commit over 100 ms, and whether a syncfs ran at some moment of it
                end = int(f[4]) + int(f[5]) / 1e6
                slow += 1
                slow_in_sync += any(a < end and b > end - ms / 1000 for a, b in spans)
    syncs = [e["ms"] for e in events if m0 <= e["start"] <= m1]
    runner = [json.loads(l)["ms"] for l in text(folder / "commits.jsonl").splitlines() if l.strip() and json.loads(l)["final"] == "committed"]
    summary = json.loads((folder / "summary.json").read_text())
    return meta, {"api": [a["ms"] for a in api], "apiWrite": [a["ms"] for a in api if a["ep"] == "rename"],
                  "apiErrors": sum(1 for a in api if not 200 <= a["status"] < 300), "pgCommit": commits, "pgRead": reads, "syncfs": syncs,
                  "runnerCommit": runner, "pgIoSome": summary["disk"]["cgroups"].get("orbit-postgres", {}).get("ioSomePct"),
                  "sdbUtil": summary["disk"]["sdbUtilPct"]["mean"], "hostIoSome": summary["disk"]["hostIoSomePct"]["mean"],
                  "iowait": summary["disk"]["cpuIowaitPct"]["mean"], "engineCommits": summary["engine"]["engineCommitMs"],
                  "turns": summary["turns"]["answered"], "seconds": m1 - m0, "slowCommits": slow, "slowCommitsInASync": slow_in_sync,
                  "refaults": summary["disk"]["cgroups"].get("dind", {}).get("pageCacheRefaults"),
                  "testHostReadMB": summary["disk"]["cgroups"].get("dind", {}).get("readMB")}


def stats(values):
    return {"n": len(values), "p50": pct(values, 50), "p95": pct(values, 95), "p99": pct(values, 99), "max": max(values) if values else None}


def main():
    root = Path(sys.argv[1])
    pooled = {}
    undisturbed = "--undisturbed" in sys.argv
    for folder in sorted(root.iterdir()):
        if folder.name.startswith("smoke") or not (folder / "summary.json").exists():
            continue
        meta, s = samples(folder)
        if undisturbed and (s["testHostReadMB"] or 0) > 100:
            continue
        pattern = ("staggered" if meta.get("staggerSeconds") else "lockstep") + ("" if meta.get("commitEvery", 1) else "-turns-only")
        cell = pooled.setdefault((meta["variant"], meta["runners"], pattern), {"rounds": [], "api": [], "apiWrite": [], "pgCommit": [], "pgRead": [],
                                                                        "syncfs": [], "runnerCommit": [], "pgIoSome": [], "sdbUtil": [],
                                                                        "hostIoSome": [], "iowait": [], "apiErrors": 0, "seconds": 0,
                                                                        "slowCommits": 0, "slowCommitsInASync": 0, "testHostReadMB": []})
        cell["rounds"].append(folder.name)
        for key in ("api", "apiWrite", "pgCommit", "pgRead", "syncfs", "runnerCommit"):
            cell[key] += s[key]
        for key in ("pgIoSome", "sdbUtil", "hostIoSome", "iowait"):
            cell[key].append(s[key])
        cell["apiErrors"] += s["apiErrors"]
        cell["seconds"] += s["seconds"]
        cell["slowCommits"] += s["slowCommits"]
        cell["slowCommitsInASync"] += s["slowCommitsInASync"]
        cell["testHostReadMB"].append(s["testHostReadMB"])
    out = {}
    for (variant, runners, pattern), cell in sorted(pooled.items(), key=lambda kv: (kv[0][2], kv[0][1], kv[0][0])):
        mean = lambda xs: round(sum(x for x in xs if x is not None) / len([x for x in xs if x is not None]), 2)  # noqa: E731
        out[f"{variant}/{runners}/{pattern}"] = {
            "rounds": cell["rounds"], "api": stats(cell["api"]), "apiWrite": stats(cell["apiWrite"]), "apiErrors": cell["apiErrors"],
            "pgCommit": stats(cell["pgCommit"]), "pgRead": stats(cell["pgRead"]), "syncfs": stats(cell["syncfs"]),
            "syncfsPerMinute": round(len(cell["syncfs"]) / cell["seconds"] * 60, 1), "runnerCommit": stats(cell["runnerCommit"]),
            "pgIoSome": mean(cell["pgIoSome"]), "sdbUtil": mean(cell["sdbUtil"]), "hostIoSome": mean(cell["hostIoSome"]),
            "iowait": mean(cell["iowait"]), "slowCommitsPerMinute": round(cell["slowCommits"] / cell["seconds"] * 60, 1),
            "slowCommitsInASync": cell["slowCommitsInASync"], "slowCommits": cell["slowCommits"], "testHostReadMB": cell["testHostReadMB"]}
    verdicts = {}
    for key, cell in out.items():
        variant, runners, pattern = key.split("/")
        base = out.get(f"before/{runners}/{pattern}")
        if variant == "before" or not base:
            continue
        api_limit = max(base["api"]["p99"] * 1.25, base["api"]["p99"] + 10)
        pg_limit = max(base["pgCommit"]["p99"] * 1.5, base["pgCommit"]["p99"] + 10)
        verdicts[key] = {
            "apiP99": {"value": cell["api"]["p99"], "control": base["api"]["p99"], "limit": round(api_limit, 1), "within": cell["api"]["p99"] <= api_limit},
            "pgCommitP99": {"value": cell["pgCommit"]["p99"], "control": base["pgCommit"]["p99"], "limit": round(pg_limit, 1),
                            "within": cell["pgCommit"]["p99"] <= pg_limit},
            "pgIoSome": {"value": cell["pgIoSome"], "control": base["pgIoSome"], "limit": round(base["pgIoSome"] + 5, 2),
                         "within": cell["pgIoSome"] <= base["pgIoSome"] + 5},
        }
        if cell["runnerCommit"]["p50"] is not None and base["runnerCommit"]["p50"] is not None:  # none in the turns-only rounds
            verdicts[key]["runnerCommitP50"] = {"value": cell["runnerCommit"]["p50"], "control": base["runnerCommit"]["p50"],
                                                "limit": base["runnerCommit"]["p50"] + 1000,
                                                "within": cell["runnerCommit"]["p50"] <= base["runnerCommit"]["p50"] + 1000}
        verdicts[key]["withinAll"] = all(v["within"] for v in verdicts[key].values())
    result = {"pooled": out, "bound": verdicts}
    if "--json" in sys.argv:
        Path(sys.argv[sys.argv.index("--json") + 1]).write_text(json.dumps(result, indent=1))
    for key, cell in out.items():
        print(f"{key:18} rounds {','.join(cell['rounds'])}: syncfs/min {cell['syncfsPerMinute']} | API p50/p95/p99 {cell['api']['p50']}/{cell['api']['p95']}/{cell['api']['p99']} "
              f"(write p99 {cell['apiWrite']['p99']}) | pg commit p50/p95/p99 {cell['pgCommit']['p50']}/{cell['pgCommit']['p95']}/{cell['pgCommit']['p99']} | "
              f"pg io {cell['pgIoSome']}% | sdb {cell['sdbUtil']}% | runner commit p50 {cell['runnerCommit']['p50']} | "
              f"commits >100 ms/min {cell['slowCommitsPerMinute']} ({cell['slowCommitsInASync']} of {cell['slowCommits']} in a syncfs) | "
              f"test host read MB {cell['testHostReadMB']}")
    for key, v in verdicts.items():
        print(f"bound {key}: " + ", ".join(f"{name} {x['value']} vs {x['control']} (limit {x['limit']}) {'ok' if x['within'] else 'OVER'}"
                                         for name, x in v.items() if isinstance(x, dict)) + f" => {'within' if v['withinAll'] else 'OVER'}")


if __name__ == "__main__":
    main()
