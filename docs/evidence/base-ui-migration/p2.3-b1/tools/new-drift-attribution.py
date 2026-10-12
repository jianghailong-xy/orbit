#!/usr/bin/env python3
"""Usage: new-drift-attribution.py <out.json> <p0-run-report.json>... — every failure of the given full P0
runs on the project tip (+ fix), with the main commit it is attributed to and the same-environment
evidence (attribution runs on the main first-parent commits before/after the merge that brought it)."""
import json, re, sys, pathlib
B = pathlib.Path('/var/tmp/p23b1')
attr = json.load(open(B / 'final/attribution/attribution.json'))
def shots(group, sha):
    return next(r for r in attr[group] if r['commit'].startswith(sha))['screenshots']
RULES = {
    'profile': {'mainCommit': 'd233a6cd0', 'subject': 'feat(auth): add access token management and /pat/self introspection', 'mainMerge': '86c6d2d4d',
                'evidence': 'attribution/runs/attr-profile-85b18b646 (profile.png equal to P0.2, 0 px) -> attribution/runs/attr-profile-86c6d2d4d (the comparator reports the same pixel count as on the tip)',
                'change': 'Profile page gains the "Also revoke all my access tokens" checkbox and its description'},
    'wiki': {'mainCommit': '2f9cc095f', 'subject': 'refactor(wiki): list topic articles on the Wiki home, drop status cards', 'mainMerge': 'be0f8c22a',
             'evidence': 'attribution/runs/attr-wiki-51f0cdfee (wiki scenario passes in 8/8) -> attribution/runs/attr-wiki-be0f8c22a (the same .wk-card locator failure in 8/8); 2f9cc095f adds WikiHomeContent.test.tsx asserting no .wk-card on the home',
             'change': 'Wiki home no longer renders .wk-card status cards, which the P0 wiki scenario waits for before its wiki-home screenshot'},
    'breakpoint-959-wiki.png': {'mainCommit': ['6c4e0ac0e', '2f9cc095f'], 'subject': ["feat(wiki): Activity page, the head's Activity badge, one number waiting, space names and defaults", 'refactor(wiki): list topic articles on the Wiki home, drop status cards'],
                                'mainMerge': ['dcfb5adf6', 'be0f8c22a'],
                                'evidence': 'attribution/runs/attr-breakpoints-*: equal to P0.2 through 0982d8ed8 (WebKit 0 px), changed at dcfb5adf6 (the comparator already fails), unchanged at 51f0cdfee, changed again at be0f8c22a, unchanged through f86211ec3 (= the project tip build, WebKit 0 px)',
                                'change': 'Wiki head gains the Activity button (6c4e0ac0e); the home lists topic articles instead of status cards (2f9cc095f)'},
}
rows = []
for path in sys.argv[2:]:
    r = json.load(open(path))
    def visit(s):
        for sp in s.get('specs', []):
            for t in sp['tests']:
                if t['status'] != 'unexpected': continue
                errs = [re.sub(r'\x1b\[[0-9;]*m', '', e.get('message', '')) for res in t['results'] for e in res.get('errors', [])]
                shot = next((a['name'].replace('-expected.png', '.png') for res in t['results'] for a in res.get('attachments', []) if a.get('name', '').endswith('-expected.png')), None)
                px = next((int(m.group(1)) for e in errs for m in [re.search(r'(\d+) pixels \(ratio', e)] if m), None)
                key = shot if shot == 'breakpoint-959-wiki.png' else sp['title']
                rule = RULES.get(key)
                rows.append({'run': path, 'project': t['projectName'], 'test': sp['title'], 'screenshot': shot,
                             'failure': 'screenshot' if shot else ('locator .wk-card' if '.wk-card' in ''.join(errs) else errs[0].split('\n')[0][:120] if errs else None),
                             'differentPixels': px, **({'attribution': rule} if rule else {'attribution': None})})
        for c in s.get('suites', []): visit(c)
    for s in r['suites']: visit(s)
json.dump(rows, open(sys.argv[1], 'w'), indent=1)
un = [x for x in rows if not x['attribution']]
print(len(rows), 'failures;', len(un), 'without attribution', [(x['project'], x['test'], x['screenshot']) for x in un])
