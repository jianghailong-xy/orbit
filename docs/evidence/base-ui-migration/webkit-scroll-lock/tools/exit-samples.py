#!/usr/bin/env python3
"""Usage: exit-samples.py <report.json>... — for every run of "exit keeps its own native progress" in the given
toasts reports: project, motion, status, how many rAF samples saw the exiting toast still connected (the test
needs more than 3), and the median frame interval of the run."""
import base64, json, statistics, sys
for path in sys.argv[1:]:
    r = json.load(open(path))
    rows = []
    def walk(s):
        for x in s.get('suites', []): yield from walk(x)
        for sp in s.get('specs', []):
            for t in sp['tests']: yield sp['title'], t
    for suite in r['suites']:
        for title, t in walk(suite):
            if 'exit keeps its own native progress' not in title: continue
            for res in t['results']:
                for a in res.get('attachments', []):
                    if a['name'] == 'native-exit' and a.get('body'):
                        d = json.loads(base64.b64decode(a['body']))
                        s = d['samples']
                        conn = [x for x in s if x['connected']]
                        gaps = [b['t'] - a2['t'] for a2, b in zip(s, s[1:])]
                        rows.append((t['projectName'], d['motion'], res['status'], len(conn), round(statistics.median(gaps), 1) if gaps else None, len(s)))
    n = len(rows); fails = sum(1 for x in rows if x[2] != 'passed')
    conn = [x[3] for x in rows]; med = [x[4] for x in rows if x[4] is not None]
    print(path.split('/')[-3], 'runs', n, 'failed', fails, '| connected samples: min', min(conn), 'median', statistics.median(conn),
          '| median frame interval ms: median', statistics.median(med), 'max', max(med))
