#!/usr/bin/env python3
"""Usage: compare-rounds.py <report-1.json> <report-2.json> <out.json> — two runs of the same Playwright
command compared test by test: status, and for failures the first error line and the differing pixel
count Playwright reported. Prints whether the two rounds are identical in those respects."""
import json, re, sys
def tests(path):
    r = json.load(open(path)); out = {}
    def visit(s):
        for sp in s.get('specs', []):
            for t in sp['tests']:
                errs = [re.sub(r'\x1b\[[0-9;]*m', '', e.get('message', '')) for res in t['results'] for e in res.get('errors', [])]
                px = next((int(m.group(1)) for e in errs for m in [re.search(r'(\d+) pixels \(ratio', e)] if m), None)
                shot = next((a['name'].replace('-expected.png', '.png') for res in t['results'] for a in res.get('attachments', []) if a.get('name', '').endswith('-expected.png')), None)
                out[f"{t['projectName']} | {sp['file']} | {sp['title']}"] = {'status': t['status'], 'expectedStatus': t['expectedStatus'],
                    'error': errs[0].split('\n')[0][:200] if errs else None, 'differentPixels': px, 'screenshot': shot}
        for c in s.get('suites', []): visit(c)
    for s in r['suites']: visit(s)
    return r['stats'], out
s1, t1 = tests(sys.argv[1]); s2, t2 = tests(sys.argv[2])
diff = [k for k in sorted(set(t1) | set(t2)) if t1.get(k) != t2.get(k)]
res = {'round1': {'report': sys.argv[1], 'stats': s1}, 'round2': {'report': sys.argv[2], 'stats': s2}, 'tests': len(t1),
       'identical': not diff, 'differences': [{'test': k, 'round1': t1.get(k), 'round2': t2.get(k)} for k in diff],
       'failures': {k: v for k, v in t1.items() if v['status'] == 'unexpected'}}
json.dump(res, open(sys.argv[3], 'w'), indent=1)
print(json.dumps({'tests': len(t1), 'identical': not diff, 'differences': len(diff), 'unexpected': len(res['failures'])}))
