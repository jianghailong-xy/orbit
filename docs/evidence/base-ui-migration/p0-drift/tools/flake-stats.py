#!/usr/bin/env python3
"""Usage: flake-stats.py <out.json> — every execution of the P0 settings/profile scenarios across
all attribution runs (P0.2 locators): how many failed on the getByText strict-mode violation."""
import glob, json, os, sys
B = '/var/tmp/p0drift'
total = failed = 0
per = {}
for rep in sorted(glob.glob(f'{B}/runs/*/output/report.json') + glob.glob(f'{B}/runs/*/fill-*/report.json')):
    label = rep.split('/runs/')[1].split('/')[0]
    r = json.load(open(rep))
    def visit(s):
        global total, failed
        for sp in s.get('specs', []):
            if sp['title'] not in ('settings', 'profile'):
                continue
            for t in sp['tests']:
                for res in t['results']:
                    total += 1
                    msg = ' '.join(e.get('message', '') for e in res.get('errors', []))
                    hit = 'strict mode violation' in msg and ("'Setting saved'" in msg or "'Name saved'" in msg)
                    other = res['status'] not in ('passed',) and not hit
                    failed += hit
                    k = per.setdefault(label, {'executions': 0, 'strictModeFailures': 0, 'otherFailures': 0})
                    k['executions'] += 1; k['strictModeFailures'] += hit; k['otherFailures'] += other
        for c in s.get('suites', []):
            visit(c)
    for s in r['suites']:
        visit(s)
out = {'executions': total, 'strictModeFailures': failed, 'runs': per}
json.dump(out, open(sys.argv[1], 'w'), indent=1)
print(json.dumps({'executions': total, 'strictModeFailures': failed, 'otherFailures': sum(v['otherFailures'] for v in per.values())}))
