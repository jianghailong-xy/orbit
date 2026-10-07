#!/usr/bin/env python3
"""Usage: stability-summary.py <out.json> <label>=<run dir> ...

Summarizes repeated settings/profile runs (same-commit-originals.sh with --repeat-each): executions, failures
split into the strict-mode duplicate of the save toast (the screen-reader live region) and anything else,
with the failing project/test and its occurrence among the repeats, and the environment hash of the run."""
import hashlib, json, os, re, sys

out = {}
for arg in sys.argv[2:]:
    label, run = arg.split('=', 1)
    report = json.load(open(f'{run}/output/report.json'))
    executions, failures, seen = 0, [], {}
    def visit(suite):
        global executions
        for spec in suite.get('specs', []):
            for test in spec['tests']:
                key = (test['projectName'], spec['title'])
                seen[key] = seen.get(key, 0) + 1
                for result in test['results']:
                    executions += 1
                    if result['status'] in ('passed', 'skipped'):
                        continue
                    message = re.sub(r'\x1b\[[0-9;]*m', '', (result.get('errors') or [{}])[0].get('message', ''))
                    kind = 'strict-mode duplicate (toast + live region)' if 'strict mode violation' in message and ('saved' in message) else 'other'
                    failures.append({'project': test['projectName'], 'test': spec['title'], 'occurrence': seen[key],
                                     'retry': result.get('retry'), 'kind': kind, 'message': next((l.strip() for l in message.split('\n') if 'strict mode violation' in l), message.split('\n')[0])[:200]})
        for child in suite.get('suites', []):
            visit(child)
    for suite in report['suites']:
        visit(suite)
    out[label] = {
        'run': run, 'stats': report['stats'], 'executions': executions, 'failed': len(failures),
        'byKind': {k: sum(1 for f in failures if f['kind'] == k) for k in sorted({f['kind'] for f in failures})},
        'environmentSha256': hashlib.sha256(open(f'{run}/environment.json', 'rb').read()).hexdigest() if os.path.exists(f'{run}/environment.json') else None,
        'failures': failures,
    }
json.dump(out, open(sys.argv[1], 'w'), indent=1)
print(json.dumps({k: {x: v[x] for x in ('executions', 'failed', 'byKind', 'environmentSha256')} for k, v in out.items()}, indent=1))
