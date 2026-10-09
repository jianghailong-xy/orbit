#!/usr/bin/env python3
"""Usage: exit-transfer.py <label>=<report.json>... — per tree, over every run of "exit keeps its own native progress":
when the exiting toast changed owner (first sample in the nested dialog's layer, ms after Dismiss), how long it stayed
connected, and how often it never changed owner within its exit."""
import base64, json, statistics, sys
def runs(path):
    r = json.load(open(path))
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
                        yield t['projectName'], json.loads(base64.b64decode(a['body']))
by = {}
for arg in sys.argv[1:]:
    label, path = arg.split('=', 1)
    for project, d in runs(path):
        conn = [s for s in d['samples'] if s['connected']]
        owners = [s['owner'] for s in conn]
        switch = next((s['t'] for s in conn if s['owner'] != owners[0]), None)
        by.setdefault(label, []).append((switch, conn[-1]['t'] if conn else None))
for label, rows in by.items():
    sw = [s for s, _ in rows if s is not None]
    end = [e for _, e in rows if e is not None]
    q = lambda xs, p: sorted(xs)[min(len(xs) - 1, int(p * len(xs)))]
    print(f"{label}: runs {len(rows)}, no switch {sum(1 for s, _ in rows if s is None)}, switch ms median {statistics.median(sw):.1f} p90 {q(sw, .9):.1f}, last connected ms median {statistics.median(end):.1f} p90 {q(end, .9):.1f}")
