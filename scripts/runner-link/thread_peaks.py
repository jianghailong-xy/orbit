# Each apiserver's main thread over a run's steady window, from threads.jsonl (evidence 6's method): the mean, and the
# busiest 10 s and 60 s, in cores. threads.jsonl samples every 5 s, so a 10 s window is 2 intervals, 60 s is 12.
import json, sys
run = sys.argv[1]
summ = json.load(open(f"{run}/summary.json"))
from datetime import datetime
def ms(s): return datetime.fromisoformat(s.replace('Z', '+00:00')[:26] + '+00:00').timestamp() * 1000
t0, t1 = ms(summ['steadyStartedAt']), ms(summ['steadyEndedAt'])
rows = [json.loads(l) for l in open(f"{run}/threads.jsonl") if l.strip()]
rows = [r for r in rows if t0 <= r['t'] <= t1]
svcs = sorted({k for r in rows for k in r if k.startswith('apiserver')})
out = {}
for s in svcs:
    pts = [(r['t'], r[s]['mainTicks'], r[s]['processTicks'], r[s]['pid'], r['clkTck']) for r in rows if s in r]
    def peak(n):
        best = 0.0
        for i in range(len(pts) - n):
            a, b = pts[i], pts[i + n]
            if a[3] != b[3]: continue
            best = max(best, (b[1] - a[1]) / a[4] / ((b[0] - a[0]) / 1000))
        return round(best, 3)
    a, b = pts[0], pts[-1]
    mean = (b[1] - a[1]) / a[4] / ((b[0] - a[0]) / 1000)
    share = (b[1] - a[1]) / max(b[2] - a[2], 1)
    out[s] = {"mean": round(mean, 3), "peak10s": peak(2), "peak60s": peak(12), "shareOfProcess": round(share, 3)}
print(json.dumps({"run": run.rstrip('/').split('/')[-1], "apiservers": out}))
