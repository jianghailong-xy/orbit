#!/usr/bin/env python3
"""Usage: summarize-report.py <report.json> [sources.json] > summary.json

Stats of a P0 run and every unexpected/flaky test: the screenshot it stopped at, the layer that
screenshot's expectation came from, the first error line, Playwright's different-pixel count, and,
for a locator failure, the locator it waited for. Based on p0-drift/tools/summarize-report.py."""
import json, re, sys
r = json.load(open(sys.argv[1]))
src = json.load(open(sys.argv[2])) if len(sys.argv) > 2 else {}
plain = lambda s: re.sub(r'\x1b\[[0-9;]*m', '', s or '')
out = {'stats': r['stats'], 'passed': 0, 'expectedFailures': 0, 'skipped': 0, 'unexpected': [], 'flaky': [], 'tests': []}
def visit(s):
    for sp in s.get('specs', []):
        for t in sp['tests']:
            st = t['status']
            out['tests'].append({'project': t['projectName'], 'file': sp.get('file'), 'test': sp['title'], 'status': st,
                                 'expectedStatus': t.get('expectedStatus')})
            if st == 'skipped': out['skipped'] += 1
            elif st == 'expected':
                if t.get('expectedStatus') == 'failed': out['expectedFailures'] += 1
                else: out['passed'] += 1
            elif st in ('unexpected', 'flaky'):
                errs = [plain(e.get('message', '')) for res in t['results'] for e in res.get('errors', [])]
                shot = None
                for res in t['results']:
                    for a in res.get('attachments', []):
                        if a.get('name', '').endswith('-expected.png'): shot = a['name'].replace('-expected.png', '.png')
                rel = f"{t['projectName']}/{shot}" if shot else None
                locator = next((m.group(1) for e in errs for m in [re.search(r'Locator: (.+)', e)] if m), None)
                out[st].append({'project': t['projectName'], 'test': sp['title'], 'file': sp.get('file'), 'screenshot': shot,
                                'expectedLayer': src.get(rel, {}).get('layer') if rel else None,
                                'error': (errs[0].split('\n')[0] if errs else '')[:160], 'locator': locator,
                                'differentPixels': next((int(m.group(1)) for e in errs for m in [re.search(r'(\d+) pixels \(ratio', e)] if m), None)})
    for c in s.get('suites', []): visit(c)
for s in r['suites']: visit(s)
print(json.dumps(out, indent=1))
