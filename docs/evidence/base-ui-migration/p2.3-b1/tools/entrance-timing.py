#!/usr/bin/env python3
"""Usage: entrance-timing.py <ab-run-dir> <out.json> — from an A/B run (tip-N / fixab-N reports), every
execution of 'entrance progress survives a modal transfer before its first 180ms completes': the time of
the first sampled frame with the notification inside the dialog, its opacity, and the test status;
medians per project and side."""
import base64, json, pathlib, statistics, sys, collections
root, out = pathlib.Path(sys.argv[1]), pathlib.Path(sys.argv[2])
rows = collections.defaultdict(list)
for d in sorted(p for p in root.iterdir() if p.is_dir()):
    side = d.name.rsplit('-', 1)[0]
    report = d / 'results/report.json'
    if not report.exists(): continue
    r = json.loads(report.read_text())
    def visit(s):
        for sp in s.get('specs', []):
            if 'entrance progress' not in sp['title']: continue
            for t in sp['tests']:
                for result in t['results']:
                    for a in result.get('attachments', []):
                        if a['name'] == 'native-entrance-transfer' and a.get('body'):
                            f = json.loads(base64.b64decode(a['body'])); owned = [x for x in f if x['owner']]
                            rows[(t['projectName'], side)].append({'run': d.name, 'firstOwnedMs': round(owned[0]['t']) if owned else None,
                                                                   'opacity': round(owned[0]['opacity'], 3) if owned else None, 'status': result['status']})
        for c in s.get('suites', []): visit(c)
    for s in r['suites']: visit(s)
summary = {}
for (project, side), v in sorted(rows.items()):
    ts = [x['firstOwnedMs'] for x in v if x['firstOwnedMs'] is not None]
    summary.setdefault(project, {})[side] = {'n': len(v), 'medianFirstOwnedMs': statistics.median(ts) if ts else None,
                                             'failed': sum(x['status'] != 'passed' for x in v), 'executions': v}
out.write_text(json.dumps(summary, indent=1) + '\n')
for project, sides in summary.items():
    print(f"{project:24} " + '  '.join(f"{side}: n={s['n']} median={s['medianFirstOwnedMs']} failed={s['failed']}" for side, s in sides.items()))
