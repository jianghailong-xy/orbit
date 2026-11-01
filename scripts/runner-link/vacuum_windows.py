# The database's 10 s CPU peaks of a run's steady window, inside and outside the vacuums that ran in it (task C2b
# rerun, the coordinator's rule of 2026-10-31: the criterion is the whole hour's 10 s peak, vacuums included; the split
# is reported beside it, with when each vacuum ran and for how long).
#
#   python3 -I vacuum_windows.py <run dir> <vacuum-sampler jsonl> [--db-cpus 8]
#
# A vacuum (or analyze) is one backend pid working one table: from the first 2 s tick it was seen to the last. A 10 s
# CPU window (two 5 s samples of samples.jsonl) is "inside" when it overlaps any vacuum of the window.
import json, sys
from datetime import datetime, timezone

args = sys.argv[1:]
run, vac = args[0], args[1]
cpus = float(args[args.index('--db-cpus') + 1]) if '--db-cpus' in args else 8.0
summ = json.load(open(f'{run}/summary.json'))
ms = lambda s: datetime.fromisoformat(s.replace('Z', '+00:00')[:26] + '+00:00').timestamp() * 1000
t0, t1 = ms(summ['steadyStartedAt']), ms(summ['steadyEndedAt'])
fmt = lambda t: datetime.fromtimestamp(t / 1000, timezone.utc).strftime('%H:%M:%S')

ticks = []
for line in open(vac):
    try: ticks.append(json.loads(line))
    except ValueError: pass
spans = {}
for tk in ticks:
    for kind in ('vacuum', 'analyze'):
        for v in tk.get(kind) or []:
            key = (kind, v['pid'], v['rel'])
            s = spans.setdefault(key, {'kind': kind, 'rel': v['rel'], 'pid': v['pid'], 'first': tk['t'], 'last': tk['t'],
                                        'xactStart': v.get('xactStart'), 'heapTotal': v.get('heapTotal'), 'phases': []})
            s['last'] = tk['t']
            if v.get('phase') and (not s['phases'] or s['phases'][-1] != v['phase']): s['phases'].append(v['phase'])
spans = sorted(spans.values(), key=lambda s: s['first'])
in_window = [s for s in spans if s['last'] >= t0 and s['first'] <= t1]

smp = [json.loads(l) for l in open(f'{run}/samples.jsonl') if l.strip()]
smp = [x for x in smp if t0 <= x['t'] <= t1 and 'postgres' in x]
wins = []
for a, b in zip(smp, smp[2:]):
    cores = (b['postgres']['cpuUsec'] - a['postgres']['cpuUsec']) / 1e6 / ((b['t'] - a['t']) / 1000)
    inside = [s for s in in_window if s['kind'] == 'vacuum' and s['first'] <= b['t'] and s['last'] >= a['t']]
    wins.append({'from': a['t'], 'to': b['t'], 'cores': cores, 'vacuums': sorted({s['rel'] for s in inside})})

def peak(ws):
    if not ws: return None
    w = max(ws, key=lambda w: w['cores'])
    return {'cores': round(w['cores'], 2), 'pctOfAllocation': round(100 * w['cores'] / cpus, 1), 'endingAt': fmt(w['to']), 'vacuums': w['vacuums']}

inside = [w for w in wins if w['vacuums']]
outside = [w for w in wins if not w['vacuums']]
over = [w for w in wins if w['cores'] > 0.6 * cpus]
res = {
    'steadyWindow': [fmt(t0), fmt(t1)], 'dbCpus': cpus, 'windows10s': len(wins),
    'peakWholeHour': peak(wins), 'peakInsideVacuum': peak(inside), 'peakOutsideVacuum': peak(outside),
    'windowsInsideVacuum': len(inside), 'windowsOver60pct': len(over),
    'windowsOver60pctInsideVacuum': sum(1 for w in over if w['vacuums']),
    'vacuums': [{'kind': s['kind'], 'table': s['rel'], 'start': fmt(s['first']), 'end': fmt(s['last']),
                 'seconds': round((s['last'] - s['first']) / 1000), 'heapBlocks': s['heapTotal'], 'phases': s['phases']}
                for s in in_window if s['kind'] == 'vacuum'],
    'analyzes': [{'table': s['rel'], 'start': fmt(s['first']), 'end': fmt(s['last']), 'seconds': round((s['last'] - s['first']) / 1000)}
                 for s in in_window if s['kind'] == 'analyze'],
}
print(json.dumps(res, indent=1))
