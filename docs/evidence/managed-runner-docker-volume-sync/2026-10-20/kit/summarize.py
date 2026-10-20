#!/usr/bin/env python3
"""D10: one round's records (d10.py `round`) as numbers, over the round's load window unless said otherwise.

    summarize.py <round dir>...            writes <round dir>/summary.json for each, prints one line per round
    summarize.py --table <round dir>...    the comparison tables (Markdown) of rounds already summarised

Percentiles are nearest-rank. "Idle" is the same round's 15 s before its load (probes only).
"""

import calendar
import gzip
import json
import math
from pathlib import Path
import re
import sys
import time

FAKE_MODEL_LOG = Path("/mnt/data/tmp/34ilx9dqVOKBeYZObuIjI/evidence/fake-model.jsonl")  # the evidence's copy: ../fake-model.jsonl.gz
# /proc/diskstats fields after the device name
READS, SECTORS_READ, WRITES, SECTORS_WRITTEN, MS_WRITING, IO_TICKS, WEIGHTED, FLUSHES, MS_FLUSHING = 0, 2, 4, 6, 7, 9, 10, 15, 16


def pct(values, p):
    values = sorted(values)
    if not values:
        return None
    return values[max(0, min(len(values) - 1, math.ceil(p / 100 * len(values)) - 1))]


def dist(values, unit_round=1):
    values = [v for v in values if v is not None]
    if not values:
        return {"n": 0}
    r = lambda v: round(v, unit_round)  # noqa: E731
    return {"n": len(values), "p50": r(pct(values, 50)), "p90": r(pct(values, 90)), "p99": r(pct(values, 99)),
            "max": r(max(values)), "mean": r(sum(values) / len(values))}


def text(path):
    """A round's file, or its gzipped copy in the evidence (gateway.log as gateway.txt.gz); "" when neither is there."""
    path = Path(path)
    for candidate in (path, path.with_name(path.name + ".gz"), path.with_name(path.stem + ".txt.gz")):
        if candidate.exists():
            return gzip.open(candidate, "rt").read() if candidate.suffix == ".gz" else candidate.read_text()
    return ""


def lines(path):
    return [json.loads(line) for line in text(path).splitlines() if line.strip()]


def rates(samples, start, end):
    """Per-interval rates between consecutive samples inside [start, end] (monotonic seconds)."""
    inside = [s for s in samples if start <= s["mono"] <= end]
    out = []
    for a, b in zip(inside, inside[1:]):
        dt = b["mono"] - a["mono"]
        if dt <= 0:
            continue
        d = {k: b["sdb"][i] - a["sdb"][i] for k, i in (("reads", READS), ("sr", SECTORS_READ), ("writes", WRITES), ("sw", SECTORS_WRITTEN),
                                                      ("msw", MS_WRITING), ("ticks", IO_TICKS), ("weighted", WEIGHTED),
                                                      ("flushes", FLUSHES), ("msflush", MS_FLUSHING))}
        cpu_a, cpu_b = a["cpu"], b["cpu"]
        total = sum(cpu_b[:8]) - sum(cpu_a[:8])
        row = {
            "utilPct": d["ticks"] / (dt * 1000) * 100,
            "writeMBps": d["sw"] * 512 / dt / 1e6,
            "readMBps": d["sr"] * 512 / dt / 1e6,
            "writesPerS": d["writes"] / dt,
            "wAwaitMs": d["msw"] / d["writes"] if d["writes"] else None,
            "queue": d["weighted"] / (dt * 1000),
            "flushesPerS": d["flushes"] / dt,
            "flushMs": d["msflush"] / d["flushes"] if d["flushes"] else None,
            "iowaitPct": (cpu_b[4] - cpu_a[4]) / total * 100 if total else None,
            "hostIoSomePct": (b["ioPressureSome"] - a["ioPressureSome"]) / (dt * 1e6) * 100,
            "hostIoFullPct": (b["ioPressureFull"] - a["ioPressureFull"]) / (dt * 1e6) * 100,
            "dirtyMB": b["dirtyKb"] / 1024,
            "writebackMB": b["writebackKb"] / 1024,
            "memAvailableMB": b["memAvailableKb"] / 1024 if "memAvailableKb" in b else None,
            "jbd2MBps": (b.get("jbd2WriteBytes", 0) - a.get("jbd2WriteBytes", 0)) / dt / 1e6,
        }
        for name in b.get("cgroups", {}):
            ca, cb = a.get("cgroups", {}).get(name), b["cgroups"][name]
            if not ca:
                continue
            row[f"cg:{name}"] = {
                "writeMBps": (cb.get("io", {}).get("wbytes", 0) - ca.get("io", {}).get("wbytes", 0)) / dt / 1e6,
                "readMBps": (cb.get("io", {}).get("rbytes", 0) - ca.get("io", {}).get("rbytes", 0)) / dt / 1e6,
                "ioSomePct": (cb.get("ioPressureSome", 0) - ca.get("ioPressureSome", 0)) / (dt * 1e6) * 100,
                "ioFullPct": (cb.get("ioPressureFull", 0) - ca.get("ioPressureFull", 0)) / (dt * 1e6) * 100,
                "cpuCores": (cb.get("cpu", {}).get("usage_usec", 0) - ca.get("cpu", {}).get("usage_usec", 0)) / (dt * 1e6),
                "throttledMs": (cb.get("cpu", {}).get("throttled_usec", 0) - ca.get("cpu", {}).get("throttled_usec", 0)) / 1000,
                "dirtyMB": cb.get("mem", {}).get("file_dirty", 0) / 2**20,
                "memMB": cb.get("mem", {}).get("current", 0) / 2**20,
                "refaults": cb.get("mem", {}).get("workingset_refault_file", 0) - ca.get("mem", {}).get("workingset_refault_file", 0),
            }
        row["dt"] = dt
        out.append(row)
    return out


def mean(values):
    values = [v for v in values if v is not None]
    return round(sum(values) / len(values), 2) if values else None


def disk_summary(rows):
    if not rows:
        return {}
    seconds = sum(r["dt"] for r in rows)
    keep = lambda key, digits=2: {"mean": mean([r[key] for r in rows]), "p95": round(pct([r[key] for r in rows if r[key] is not None], 95) or 0, digits),  # noqa: E731
                                  "max": round(max([r[key] for r in rows if r[key] is not None], default=0), digits)}
    out = {
        "seconds": round(seconds, 1),
        "sdbUtilPct": keep("utilPct"), "sdbWriteMBps": keep("writeMBps"), "sdbWrittenMB": round(sum(r["writeMBps"] * r["dt"] for r in rows), 1),
        "sdbWritesPerS": keep("writesPerS"), "sdbWAwaitMs": keep("wAwaitMs"), "sdbQueue": keep("queue"),
        "sdbFlushes": round(sum(r["flushesPerS"] * r["dt"] for r in rows)), "sdbFlushesPerS": keep("flushesPerS"), "sdbFlushMs": keep("flushMs"),
        "sdbReadMBps": keep("readMBps"), "cpuIowaitPct": keep("iowaitPct"), "hostIoSomePct": keep("hostIoSomePct"),
        "hostIoFullPct": keep("hostIoFullPct"), "dirtyMB": keep("dirtyMB"), "writebackMB": keep("writebackMB"),
        "jbd2WrittenMB": round(sum(r["jbd2MBps"] * r["dt"] for r in rows), 1),
        "memAvailableMiB": {"min": round(min([r["memAvailableMB"] for r in rows if r.get("memAvailableMB") is not None], default=0))},
    }
    names = sorted({k[3:] for r in rows for k in r if k.startswith("cg:")})
    groups = {}
    for name in names:
        series = [r[f"cg:{name}"] for r in rows if f"cg:{name}" in r]
        groups[name] = {
            "writtenMB": round(sum(s["writeMBps"] for s in series), 1),
            "readMB": round(sum(s["readMBps"] for s in series), 1),
            "ioSomePct": mean([s["ioSomePct"] for s in series]), "ioSomePctP95": round(pct([s["ioSomePct"] for s in series], 95) or 0, 1),
            "ioFullPct": mean([s["ioFullPct"] for s in series]),
            "cpuCores": mean([s["cpuCores"] for s in series]), "throttledMs": round(sum(s["throttledMs"] for s in series)),
            "dirtyMBMax": round(max([s["dirtyMB"] for s in series], default=0), 1), "memMBMax": round(max([s["memMB"] for s in series], default=0)),
            "pageCacheRefaults": sum(s["refaults"] for s in series),
        }
    out["cgroups"] = groups
    return out


def syncfs_summary(events, start, end, cgroups, containers):
    by_cid = {}
    # A container's cgroup is nested in the test host's: its own ID is the last one in the path.
    for name, path in cgroups.items():
        ids = re.findall(r"[0-9a-f]{64}", path)
        if ids:
            by_cid[ids[-1]] = name
    account_of = {container: key for key, container in containers.items()}
    inside = [e for e in events if start <= e["start"] <= end]
    per = {}
    for e in inside:
        ids = re.findall(r"[0-9a-f]{64}", e["cgroup"])
        name = by_cid.get(ids[-1]) if ids else None
        e["who"] = account_of.get(name, name or f"other:{e['comm']}")
        per.setdefault(e["who"], []).append(e["ms"])
    # how much of the window had at least one syncfs running, and the most at once
    points = sorted([(e["start"], 1) for e in inside] + [(e["end"], -1) for e in inside])
    level, most, busy, last = 0, 0, 0.0, None
    for at, step in points:
        if level > 0 and last is not None:
            busy += at - last
        level += step
        most = max(most, level)
        last = at
    seconds = end - start
    runners = {k: v for k, v in per.items() if not k.startswith("other:")}
    return {"calls": len(inside), "callsPerMinute": round(len(inside) / seconds * 60, 1) if seconds else None,
            "ms": dist([e["ms"] for e in inside]), "totalSeconds": round(sum(e["ms"] for e in inside) / 1000, 1),
            "busyPctOfWindow": round(busy / seconds * 100, 1) if seconds else None, "mostAtOnce": most,
            "byRunner": {k: {"calls": len(v), "p50": round(pct(v, 50), 1), "max": round(max(v), 1)} for k, v in sorted(runners.items())},
            "others": {k: len(v) for k, v in per.items() if k.startswith("other:")},
            "failed": sum(1 for e in inside if e.get("ret") not in ("0x0", "0"))}


def api_summary(probes, start, end):
    inside = [p for p in probes if start <= p["mono"] <= end]
    out = {"errors": sum(1 for p in inside if not 200 <= p["status"] < 300)}
    for ep in ("status", "session", "list", "rename"):
        out[ep] = dist([p["ms"] for p in inside if p["ep"] == ep])
    out["reads"] = dist([p["ms"] for p in inside if p["ep"] != "rename"])
    out["all"] = dist([p["ms"] for p in inside])
    return out


GATEWAY = re.compile(r'^(?P<addr>\S+) - \S+ \[(?P<time>[^\]]+)\] "(?P<method>\S+) (?P<path>\S+)[^"]*" (?P<status>\d{3}) \S+ "[^"]*" "(?P<ua>[^"]*)" "[^"]*" '
                     r'(?P<rt>[\d.]+) (?P<urt>[\d.]+|-)')
ID = re.compile(r"/(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9A-Za-z]{20,22})(?=/|$)")


def gateway_summary(text, start_wall, end_wall):
    rows = []
    for line in text.splitlines():
        match = GATEWAY.match(line)
        if not match:
            continue
        at = calendar.timegm(time.strptime(match["time"].split()[0], "%d/%b/%Y:%H:%M:%S"))
        if not start_wall <= at <= end_wall or match["urt"] == "-":
            continue
        path = ID.sub("/:id", match["path"].split("?")[0])
        rows.append({"method": match["method"], "path": path, "status": int(match["status"]), "ms": float(match["urt"]) * 1000,
                     "ua": match["ua"]})
    runner = [r for r in rows if r["path"].startswith("/api/runner/") and r["method"] != "GET"]
    by_path = {}
    for r in runner:
        by_path.setdefault(f"{r['method']} {r['path']}", []).append(r["ms"])
    top = sorted(by_path.items(), key=lambda kv: -len(kv[1]))[:8]
    return {"requests": len(rows), "runnerWrites": dist([r["ms"] for r in runner]),
            "runnerWritesByPath": {k: dist(v) for k, v in top},
            "turnComplete": dist([r["ms"] for r in runner if r["path"].endswith("/turn-complete")]),
            "commitResult": dist([r["ms"] for r in runner if r["path"].endswith("/commit-result")]),
            "users": dist([r["ms"] for r in rows if not r["path"].startswith("/api/runner/") and r["ua"] != "d10-driver"]),
            "errors5xx": sum(1 for r in rows if r["status"] >= 500)}


def pgbench_summary(text, start_wall, end_wall):
    by_script = {0: [], 1: []}
    lags = []
    for line in text.splitlines():
        f = line.split()
        if len(f) < 6:
            continue
        at = int(f[4]) + int(f[5]) / 1e6
        if not start_wall <= at <= end_wall:
            continue
        by_script.setdefault(int(f[3]), []).append(int(f[2]) / 1000)
        if len(f) > 6:
            lags.append(int(f[6]) / 1000)
    return {"insertCommitMs": dist(by_script.get(0, []), 2), "readMs": dist(by_script.get(1, []), 2), "scheduleLagMs": dist(lags, 2)}


def statements_summary(text):
    rows = []
    for line in text.splitlines():
        f = line.split("\t")
        if len(f) == 6:
            rows.append({"calls": int(f[0]), "totalMs": float(f[1]), "meanMs": float(f[2]), "maxMs": float(f[3]), "query": f[5]})
    commit = next((r for r in rows if r["query"].strip().upper() == "COMMIT"), None)
    return {"commit": commit, "top": rows[:6]}


def fake_model_summary(tag):
    commits, builds, calls = [], [], 0
    log = FAKE_MODEL_LOG if FAKE_MODEL_LOG.exists() else Path(__file__).resolve().parent.parent / "fake-model.jsonl.gz"
    if log.exists():
        for line in (gzip.open(log, "rt").read() if log.suffix == ".gz" else log.read_text()).splitlines():
            if f"{tag}t" not in line:
                continue
            entry = json.loads(line)
            loop = entry.get("loop") or {}
            if not re.fullmatch(rf"u\d{tag}t\d+", loop.get("word", "")):
                continue
            if entry.get("kind") == "loop_tool_use":
                calls += 1
            result = entry.get("toolResult") or ""
            commit = re.search(r"D10-COMMIT \S+ \d+ rc=(\d+) us=(\d+)", result)
            build = re.search(r"D10-BUILD \S+ \d+ files=\d+ rc=(\d+) us=(\d+)", result)
            if commit:
                commits.append(int(commit[2]) / 1000)
            if build:
                builds.append(int(build[2]) / 1000)
    return {"toolCalls": calls, "engineCommitMs": dist(commits), "buildMs": dist(builds)}


def summarize(folder):
    folder = Path(folder)
    meta = json.loads((folder / "meta.json").read_text())
    phases = meta["phases"]
    start, end = phases["loadStarted"]["mono"], phases["loadEnded"]["mono"]
    start_wall, end_wall = phases["loadStarted"]["wall"], phases["loadEnded"]["wall"]
    idle = (phases["probesStarted"]["mono"] + 2, start)
    samples = lines(folder / "samples.jsonl")
    turns = lines(folder / "turns.jsonl")
    commits = lines(folder / "commits.jsonl")
    answered = [t for t in turns if t.get("status") == "ANSWERED" and t.get("answeredAt")]
    out = {
        "label": meta["label"], "variant": meta["variant"], "runners": meta["runners"], "loadSeconds": meta["loadSeconds"],
        "workload": {k: meta.get(k, 1) for k in ("cycles", "files", "thinkMs", "commitEvery")}, "quietBefore": meta["quietBefore"],
        "window": {"start": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(start_wall)), "seconds": round(end - start, 1)},
        "disk": disk_summary(rates(samples, start, end)),
        "diskIdle": disk_summary(rates(samples, *idle)),
        "syncfs": syncfs_summary(lines(folder / "syncfs.jsonl"), start, end, meta.get("cgroups", {}), meta.get("containers", {})),
        "api": api_summary(lines(folder / "api-probe.jsonl"), start, end),
        "apiIdle": api_summary(lines(folder / "api-probe.jsonl"), *idle),
        "gateway": gateway_summary(text(folder / "gateway.log"), start_wall, end_wall),
        "postgres": pgbench_summary(text(folder / "pgbench-transactions.txt"), start_wall, end_wall),
        "postgresIdle": pgbench_summary(text(folder / "pgbench-transactions.txt"), phases["probesStarted"]["wall"] + 2, start_wall),
        "statements": statements_summary(text(folder / "pg-stat-statements.tsv")),
        "turns": {"answered": len(answered), "seconds": dist([t["answeredAt"] - t["createdAt"] for t in answered], 2),
                  "notAnswered": [t for t in turns if t.get("status") != "ANSWERED"]},
        "runnerCommits": {"n": len(commits), "ms": dist([c["ms"] for c in commits if c["final"] == "committed"]),
                          "retried": sum(1 for c in commits if len(c["attempts"]) > 1),
                          "notCommitted": [c for c in commits if c["final"] != "committed"][:5]},
        "engine": fake_model_summary(meta["tag"]),
        "workerErrors": meta.get("workerErrors"),
    }
    (folder / "summary.json").write_text(json.dumps(out, indent=2))
    return out


def line_of(s):
    d, a, p, sf = s["disk"], s["api"], s["postgres"], s["syncfs"]
    return (f"{s['label']}: {s['variant']} x{s['runners']} | syncfs {sf['calls']} p50 {sf['ms'].get('p50')} p99 {sf['ms'].get('p99')} ms | "
            f"sdb util {d['sdbUtilPct']['mean']}% wr {d['sdbWriteMBps']['mean']} MB/s flush/s {d['sdbFlushesPerS']['mean']} | "
            f"iowait {d['cpuIowaitPct']['mean']}% | pg io some {d['cgroups'].get('orbit-postgres', {}).get('ioSomePct')}% | "
            f"API p50/p99 {a['all'].get('p50')}/{a['all'].get('p99')} ms (rename p99 {a['rename'].get('p99')}) | "
            f"pg commit p50/p99 {p['insertCommitMs'].get('p50')}/{p['insertCommitMs'].get('p99')} ms | "
            f"turns {s['turns']['answered']} p50 {s['turns']['seconds'].get('p50')} s | runner commit p50 {s['runnerCommits']['ms'].get('p50')} ms | "
            f"engine commit p50/p99 {s['engine']['engineCommitMs'].get('p50')}/{s['engine']['engineCommitMs'].get('p99')} ms")


if __name__ == "__main__":
    args = sys.argv[1:]
    if args and args[0] == "--table":
        for folder in args[1:]:
            print(line_of(json.loads((Path(folder) / "summary.json").read_text())))
    else:
        for folder in args:
            print(line_of(summarize(folder)), flush=True)
