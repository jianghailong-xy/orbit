#!/usr/bin/env python3
import json, re, sys
# Usage: summarize.py <report.json> [sources.json] -> stats, unexpected/flaky tests with the screenshot and expected layer
r = json.load(open(sys.argv[1]))
src = json.load(open(sys.argv[2])) if len(sys.argv) > 2 else {}
out = {'stats': r['stats'], 'unexpected': [], 'flaky': [], 'expectedFailures': 0, 'skipped': 0, 'passed': 0}
def visit(s):
    for sp in s.get('specs', []):
        for t in sp['tests']:
            st = t['status']
            if st == 'skipped': out['skipped'] += 1
            elif st == 'expected':
                if t.get('expectedStatus') == 'failed': out['expectedFailures'] += 1
                else: out['passed'] += 1
            elif st in ('unexpected', 'flaky'):
                errs = [e.get('message', '') for res in t['results'] for e in res.get('errors', [])]
                shot = None
                for res in t['results']:
                    for a in res.get('attachments', []):
                        if a.get('name', '').endswith('-expected.png'): shot = a['name'].replace('-expected.png', '.png')
                rel = f"{t['projectName']}/{shot}" if shot else None
                out[st].append({'project': t['projectName'], 'test': sp['title'], 'file': sp.get('file'), 'screenshot': shot,
                                'expectedLayer': src.get(rel, {}).get('layer') if rel else None,
                                'error': (errs[0].split('\n')[0] if errs else '')[:160],
                                'differentPixels': next((int(m.group(1)) for e in errs for m in [re.search(r'(\d+) pixels \(ratio', re.sub(r'\x1b\[[0-9;]*m', '', e))] if m), None)})
    for c in s.get('suites', []): visit(c)
for s in r['suites']: visit(s)
print(json.dumps(out, indent=1))
