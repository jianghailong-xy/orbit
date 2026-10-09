#!/usr/bin/env python3
"""Usage: fixture-chain.py <out.json> <run-label>...

For each recorded run (/var/tmp/p0d3/runs/<label>): the tree and runner commits, the environment check,
the stats, and for every profile test its status, the captures it reached, the unhandled requests the
fixture check reports, whether GET /api/auth/methods was requested and the page errors, read from the
test's evidence.json (written by harness.mjs in a finally block, so also for a failed test)."""
import json, sys, glob, os
B = '/var/tmp/p0d3/runs'
out = {}
for label in sys.argv[2:]:
    run = f'{B}/{label}'
    meta = json.load(open(f'{run}/meta.json'))
    report = json.load(open(f'{run}/output/report.json'))
    status = {}
    def visit(s):
        for sp in s.get('specs', []):
            for t in sp['tests']:
                status[(t['projectName'], sp['title'])] = t['status']
        for c in s.get('suites', []): visit(c)
    for s in report['suites']: visit(s)
    tests = {}
    for f in sorted(glob.glob(f'{run}/output/pages.browser.mjs-profile-*/evidence.json')):
        e = json.load(open(f))
        reqs = [f"{r['method']} {r['path']}" for r in e['requests']]
        tests[e['project']] = {
            'status': status.get((e['project'], 'profile')),
            'captures': [c['name'] for c in e['captures']],
            'unhandled': e['unhandled'],
            'authMethodsRequests': sum(1 for r in reqs if r == 'GET /api/auth/methods'),
            'requests': len(reqs),
            'pageErrors': e['pageErrors'],
        }
    unhandled_all = sorted({u for f in glob.glob(f'{run}/output/*/evidence.json') for u in json.load(open(f))['unhandled']})
    out[label] = {'commit': meta['commit'], 'runnerCommit': meta['runnerCommit'], 'args': meta['args'], 'exit': meta.get('exit'),
                  'environment': meta.get('environment'), 'stats': meta.get('stats'), 'screenshots': meta.get('screenshots'),
                  'unhandledInAnyTest': unhandled_all, 'profile': tests,
                  'profileSummary': {
                      'tests': len(tests),
                      'passed': sum(1 for t in tests.values() if t['status'] == 'expected'),
                      'requestAuthMethods': sum(1 for t in tests.values() if t['authMethodsRequests']),
                      # main.tsx sets React Query's retry to 1: a 501 answer is asked once more if the test is still
                      # running a second later, so the request appears once or twice; nothing else may be unhandled.
                      'unhandledOnlyAuthMethods': sum(1 for t in tests.values() if t['unhandled'] and set(t['unhandled']) == {'GET /api/auth/methods'}),
                      'reachedBothCaptures': sum(1 for t in tests.values() if t['captures'] == ['profile', 'profile-validation']),
                      'pageErrors': sum(len(t['pageErrors']) for t in tests.values())}}
json.dump(out, open(sys.argv[1], 'w'), indent=1)
for k, v in out.items():
    print(k, v['commit'][:9], 'runner', v['runnerCommit'][:9], 'exit', v['exit'], v['environment'], v['stats'], v['screenshots'], 'unhandled', v['unhandledInAnyTest'], v['profileSummary'])
