#!/usr/bin/env python3
"""What restart-drill.sh recorded, restart by restart (series E of task 34paLvEDFObkoBxYLAJSN).

  python3 -I restart-drill-report.py <run dir>

For each SIGTERM: the drain (SIGTERM to the old process's exit), the new process up, and when link_connections came
back to 50, 90, 99 and 100% of the level, from SIGTERM and from the new process's start; how many were back 10 min 45 s
(645 s, the reaper's hold, docs/runner-link-design.md §15.6) after SIGTERM and after the old connections were closed;
the handshakes a second accepted and refused, and the gateway's and the rig's cores, minute by minute while they came
back; the runners' errors by kind and their worst 5 s HeartbeatAck p99 while they came back.
"""
import glob
import json
import os
import sys
from datetime import datetime

HOLD = 645_000


def jsonl(p):
    out = []
    if os.path.exists(p):
        for line in open(p):
            line = line.strip()
            if line.startswith("{"):
                try:
                    out.append(json.loads(line))
                except json.JSONDecodeError:
                    pass
    return out


def hms(ms):
    return datetime.utcfromtimestamp(ms / 1000).strftime("%H:%M:%S")


def main():
    d = sys.argv[1]
    run = json.load(open(os.path.join(d, "run.json")))
    level = run["level"]
    ev = jsonl(os.path.join(d, "events.jsonl"))
    gw = jsonl(os.path.join(d, "gw.jsonl"))
    series = []
    for sd in sorted(glob.glob(os.path.join(d, "levels", str(level), "shard-*"))):
        for l in jsonl(os.path.join(sd, "series.jsonl")):
            series.append((datetime.fromisoformat(l["at"].replace("Z", "+00:00")).timestamp() * 1000, l))
    print(f"run {run['name']}: level {level}, rates {run['rates']}, gateway {run['gateway']}, {run['shards']} shards")
    for e in ev:
        print(f"  {hms(e['t'])} {e['event']} " + ", ".join(f"{k}={v}" for k, v in e.items() if k not in ("t", "event")))
    terms = [e for e in ev if e["event"] == "sigterm"]
    for i, t in enumerate(terms):
        t0 = t["t"]
        nxt = terms[i + 1]["t"] if i + 1 < len(terms) else float("inf")
        exited = next(e for e in ev if e["event"] == "exited" and e["t"] >= t0)
        up = next(e for e in ev if e["event"] == "gateway_up" and e["t"] >= t0)
        backs = [e for e in ev if e["event"] == "back" and t0 <= e["t"] < nxt]
        gave_up = [e for e in ev if e["event"] == "back_gave_up" and t0 <= e["t"] < nxt]
        print(f"\nrestart {i + 1}: new process LINK_HANDSHAKE_RATE={up['rate']}; {t.get('conns')} connections at SIGTERM ({hms(t0)})")
        print(f"  drain (SIGTERM to exit) {(exited['t'] - t0) / 1000:.1f} s; new process up {(up['t'] - t0) / 1000:.1f} s after SIGTERM")
        for b in backs:
            print(f"  {b['pct']}% back: {(b['t'] - t0) / 1000:.1f} s after SIGTERM, {(b['t'] - up['t']) / 1000:.1f} s after the new process was up")
        for g in gave_up:
            print(f"  gave up waiting {(g['t'] - t0) / 1000:.0f} s after SIGTERM with {g.get('conns')} back")
        # The old process's connections: when they fell (the drain's own closes), from its samples.
        dr = [s for s in gw if t0 <= s["t"] <= exited["t"] and s.get("hsDraining") is not None]
        if len(dr) >= 2:
            print(f"  upgrades the draining process refused (503 DRAINING): {dr[-1]['hsDraining'] - dr[0]['hsDraining']:,} "
                  f"(its sampled CPU then: {(dr[-1]['gwCpuUsec'] - dr[0]['gwCpuUsec']) / 1e6 / ((dr[-1]['t'] - dr[0]['t']) / 1000):.2f} cores)")
        old = [s for s in gw if t0 <= s["t"] <= exited["t"] and s.get("conns") is not None]
        if old:
            below = next((s for s in old if s["conns"] <= level * 0.01), None)
            left = "—" if below is None else f"{(below['t'] - t0) / 1000:.1f} s after SIGTERM"
            print(f"  old process: {old[0]['conns']} connections at SIGTERM; under 1% left {left}")
        new = [s for s in gw if s["t"] >= up["t"] and s["t"] < nxt and s.get("conns") is not None]

        def at(ms):
            c = [s for s in new if s["t"] <= ms]
            return c[-1]["conns"] if c else 0
        print(f"  back {HOLD / 1000:.0f} s after SIGTERM: {at(t0 + HOLD):,} of {level:,} ({100 * at(t0 + HOLD) / level:.1f}%)")
        closed = exited["t"]
        print(f"  back {HOLD / 1000:.0f} s after the old process exited (its last connections closed): {at(closed + HOLD):,} ({100 * at(closed + HOLD) / level:.1f}%)")
        # Minute by minute while they came back.
        end = min(nxt, (backs[-1]["t"] if backs and backs[-1]["pct"] == 100 else (gave_up[0]["t"] if gave_up else nxt)) + 60_000)
        rows = [s for s in gw if up["t"] <= s["t"] <= end and s.get("hsOk") is not None]
        print("  | min after new process up | connections | accepted/s | refused (rate limited)/s | gateway cores | gateway GiB | rig cores (loadgen) | stub cores | worst 5 s HB ack p99 ms | runner errors in the minute |")
        print("  |" + " --- |" * 10)
        m = 0
        while rows:
            a = up["t"] + m * 60_000
            b = a + 60_000
            w = [s for s in rows if a <= s["t"] < b]
            if len(w) >= 2:
                x, y = w[0], w[-1]
                sec = (y["t"] - x["t"]) / 1000
                rl = ((y.get("hsRateLimited") or 0) - (x.get("hsRateLimited") or 0)) / sec
                se = [l for tt, l in series if a <= tt < min(b, end)]
                hb = max((l["beatAck"]["p99Ms"] for l in se if l["beatAck"]["count"]), default=None)
                errs = {}
                for l in se:
                    for k, v in (l.get("errors") or {}).items():
                        errs[k] = errs.get(k, 0) + v
                print(f"  | {m}-{m + 1} | {y['conns']:,} | {(y['hsOk'] - x['hsOk']) / sec:,.0f} | {rl:,.0f} "
                      f"| {(y['gwCpuUsec'] - x['gwCpuUsec']) / 1e6 / sec:.2f} | {y['gwMemBytes'] / 2**30:.1f} "
                      f"| {(y['rigCpuUsec'] - x['rigCpuUsec']) / 1e6 / sec:.2f} | {(y['stubCpuUsec'] - x['stubCpuUsec']) / 1e6 / sec:.2f} "
                      f"| {'—' if hb is None else f'{hb:,.0f}'} | {errs or 0} |")
            if b > end:
                break
            m += 1


if __name__ == "__main__":
    main()
